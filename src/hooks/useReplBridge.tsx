import { feature } from 'bun:bundle';
import { type FSWatcher, watch } from 'fs';
import React, { useCallback, useEffect, useRef } from 'react';
import { setMainLoopModelOverride } from '../bootstrap/state.js';
import {
  type BridgePermissionCallbacks,
  type BridgePermissionResponse,
  parseBridgePermissionResponse,
} from '../bridge/bridgePermissionCallbacks.js';
import { handleRemoteInterrupt } from '../bridge/remoteInterruptHandling.js';
import { isTranscriptResetResultReady, shouldDeferBridgeResult } from '../bridge/bridgeResultScheduling.js';
import { buildBridgeConnectUrl } from '../bridge/bridgeStatusUtil.js';
import { extractInboundMessageFields } from '../bridge/inboundMessages.js';
import type { BridgeState, ReplBridgeHandle } from '../bridge/replBridge.js';
import { setReplBridgeHandle } from '../bridge/replBridgeHandle.js';
import type { Command } from '../commands.js';
import { getSlashCommandToolSkills, isBridgeSafeCommand } from '../commands.js';
import { getRemoteSessionUrl } from '../constants/product.js';
import { useNotifications } from '../context/notifications.js';
import type { PermissionMode, SDKMessage } from '../entrypoints/agentSdkTypes.js';
import type { SDKControlResponse } from '../entrypoints/sdk/controlTypes.js';
import { Text } from '@anthropic/ink';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js';
import { useAppState, useAppStateStore, useSetAppState } from '../state/AppState.js';
import type { Message } from '../types/message.js';
import { getCwd } from '../utils/cwd.js';
import { logForDebugging } from '../utils/debug.js';
import { errorMessage } from '../utils/errors.js';
import { enqueue } from '../utils/messageQueueManager.js';
import { buildSystemInitMessage } from '../utils/messages/systemInit.js';
import { createBridgeStatusMessage, createSystemMessage } from '../utils/messages.js';
import { buildTaskStateMessage, getTaskStateSnapshotKey } from '../utils/taskStateMessage.js';
import {
  getAutoModeUnavailableNotification,
  getAutoModeUnavailableReason,
  isAutoModeGateEnabled,
  isBypassPermissionsModeDisabled,
  transitionPermissionMode,
} from '../utils/permissions/permissionSetup.js';
import { getLeaderToolUseConfirmQueue } from '../utils/swarm/leaderPermissionBridge.js';
import { getTaskListId, getTasksDir, listTasks, onTasksUpdated } from '../utils/tasks.js';
import { ContentBlockParam } from '@anthropic-ai/sdk/resources';

const TASK_STATE_DEBOUNCE_MS = 50;
const TASK_STATE_POLL_MS = 5000;

/** 故障后多久自动清除 replBridgeEnabled（停止重试）。 */
export const BRIDGE_FAILURE_DISMISS_MS = 10_000;

/**
 * 连续 initReplBridge 失败多少次后，hook 在会话生命周期内停止重试。
 * 防止在底层 OAuth 不可恢复时将 replBridgeEnabled 重新打开的路径
 *（设置同步、/remote-control、配置工具）— 每次重试都是另一次
 * 对 POST /v1/environments/bridge 的保证 401。Datadog 2026-03-08：
 * 最严重的卡住客户端仅在此路由上产生了 2,879 × 401/天（占该路由
 * 所有 401 的 17%）。
 */
const MAX_CONSECUTIVE_INIT_FAILURES = 3;

/**
 * 在后台初始化始终保持的桥接连接并将新的 user/assistant 消息
 * 写入桥接会话的 Hook。
 *
 * 如果桥接未启用或用户未进行 OAuth 认证则静默跳过。
 *
 * 监听 AppState.replBridgeEnabled — 当切换为关闭时（通过 /config 或页脚），
 * 桥接被拆除。当重新切换为开启时，重新初始化。
 *
 * 来自 claude.ai 的入站消息通过 queuedCommands 注入 REPL。
 */
export function useReplBridge(
  messages: Message[],
  setMessages: (action: React.SetStateAction<Message[]>) => void,
  abortControllerRef: React.RefObject<AbortController | null>,
  commands: readonly Command[],
  mainLoopModel: string,
): { sendBridgeResult: () => void } {
  const handleRef = useRef<ReplBridgeHandle | null>(null);
  const teardownPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const lastWrittenIndexRef = useRef(0);
  const pendingResultAfterFlushRef = useRef(false);
  const transcriptResetPendingRef = useRef(false);
  // 跟踪已作为初始消息刷新过的 UUID。跨桥接重连保留，
  // 这样 Bridge #2+ 只发送新消息 — 发送重复 UUID 会导致服务器
  // 关闭 WebSocket。
  const flushedUUIDsRef = useRef(new Set<string>());
  const failureTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 跨 effect 重新运行保留（不像 effect 的局部状态）。仅在成功 init 时重置。
  // 达到 MAX_CONSECUTIVE_INIT_FAILURES → 会话期间熔断，无论 replBridgeEnabled
  // 是否重新切换。
  const consecutiveFailuresRef = useRef(0);
  const setAppState = useSetAppState();
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const mainLoopModelRef = useRef(mainLoopModel);
  mainLoopModelRef.current = mainLoopModel;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const store = useAppStateStore();
  const { addNotification } = useNotifications();
  const replBridgeEnabledRaw = useAppState(s => s.replBridgeEnabled);
  const replBridgeEnabled = feature('BRIDGE_MODE') ? replBridgeEnabledRaw : false;
  const replBridgeConnectedRaw = useAppState(s => s.replBridgeConnected);
  const replBridgeConnected = feature('BRIDGE_MODE') ? replBridgeConnectedRaw : false;
  const replBridgeSessionActiveRaw = useAppState(s => s.replBridgeSessionActive);
  const replBridgeSessionActive = feature('BRIDGE_MODE') ? replBridgeSessionActiveRaw : false;
  const replBridgeOutboundOnlyRaw = useAppState(s => s.replBridgeOutboundOnly);
  const replBridgeOutboundOnly = feature('BRIDGE_MODE') ? replBridgeOutboundOnlyRaw : false;
  const replBridgeInitialNameRaw = useAppState(s => s.replBridgeInitialName);
  const replBridgeInitialName = feature('BRIDGE_MODE') ? replBridgeInitialNameRaw : undefined;

  // 当启用状态变化时初始化/拆除桥接。
  // 将当前消息作为 initialMessages 传入，这样远程会话
  // 以现有对话上下文开始（例如来自 /bridge）。
  useEffect(() => {
    // feature() 检查必须使用正向模式以便死代码消除 —
    // 负向模式（if (!feature(...)) return）不会消除下方的动态导入。
    if (feature('BRIDGE_MODE')) {
      if (!replBridgeEnabled) return;

      const outboundOnly = replBridgeOutboundOnly;
      function notifyBridgeFailed(detail?: string): void {
        if (outboundOnly) return;
        addNotification({
          key: 'bridge-failed',
          jsx: (
            <>
              <Text color="error">Remote Control failed</Text>
              {detail && <Text dimColor> · {detail}</Text>}
            </>
          ),
          priority: 'immediate',
        });
      }

      if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_INIT_FAILURES) {
        logForDebugging(
          `[bridge:repl] Hook: ${consecutiveFailuresRef.current} consecutive init failures, not retrying this session`,
        );
        // 清除 replBridgeEnabled，这样 /remote-control 不会为从未连接的桥接
        // 错误显示 BridgeDisconnectDialog。
        const fuseHint = 'disabled after repeated failures · restart to retry';
        notifyBridgeFailed(fuseHint);
        setAppState(prev => {
          if (prev.replBridgeError === fuseHint && !prev.replBridgeEnabled) return prev;
          return {
            ...prev,
            replBridgeError: fuseHint,
            replBridgeEnabled: false,
          };
        });
        return;
      }

      let cancelled = false;
      // 现在就捕获 messages.length，这样桥接连接后
      // writeMessages 不会重新发送初始消息。
      const initialMessageCount = messages.length;

      void (async () => {
        try {
          // 在注册新环境之前等待任何进行中的拆除完成。
          // 没有此逻辑，上一次拆除的 deregister HTTP 调用
          // 会与新的 register 调用竞争，服务器可能会拆除
          // 刚创建的环境。
          if (teardownPromiseRef.current) {
            logForDebugging('[bridge:repl] Hook: waiting for previous teardown to complete before re-init');
            await teardownPromiseRef.current;
            teardownPromiseRef.current = undefined;
            logForDebugging('[bridge:repl] Hook: previous teardown complete, proceeding with re-init');
          }
          if (cancelled) return;

          // 动态导入以便在外部构建树摇掉该模块
          const { initReplBridge } = await import('../bridge/initReplBridge.js');
          const { shouldShowAppUpgradeMessage } = await import('../bridge/envLessBridgeConfig.js');

          // 助手模式：永久桥接会话 — claude.ai 显示一个跨 CLI 重启的
          // 连续对话，而不是每次调用一个新会话。initBridgeCore 读取
          // bridge-pointer.json（#20735 添加的崩溃恢复文件）并通过
          // reuseEnvironmentId + api.reconnectSession() 重用其
          // {environmentId, sessionId}。拆除跳过归档/注销/指针清除，
          // 这样会话在干净退出时也能存活，而不仅仅是崩溃。
          // 非助手桥接在拆除时清除指针（仅崩溃恢复）。
          let perpetual = false;
          if (feature('KAIROS')) {
            const { isAssistantMode } = await import('../assistant/index.js');
            perpetual = isAssistantMode();
          }

          // 当来自 claude.ai 的用户消息到达时，将其注入 REPL。
          // 保留原始 UUID，这样当消息转发回 CCR 时，
          // 它与原始消息匹配 — 避免重复消息。
          //
          // 异步是因为 file_attachments（如果存在）需要网络获取 +
          // 磁盘写入，然后才能用 @path 前缀入队。调用方不等待 —
          // 带附件的消息只是稍晚入队，这没问题（web 消息不是快速的）。
          async function handleInboundMessage(msg: SDKMessage): Promise<void> {
            try {
              const fields = extractInboundMessageFields(msg);
              if (!fields) return;

              const { uuid } = fields;

              // 动态导入将桥接代码排除在非 BRIDGE_MODE 构建之外
              const { resolveAndPrepend } = await import('../bridge/inboundAttachments.js');
              const rawContent = fields.content;
              let sanitized: string | Array<{ type: string; [key: string]: unknown }> =
                typeof rawContent === 'string'
                  ? rawContent
                  : (rawContent as unknown as Array<{ type: string; [key: string]: unknown }>);
              if (feature('KAIROS_GITHUB_WEBHOOKS')) {
                /* eslint-disable @typescript-eslint/no-require-imports */
                const { sanitizeInboundWebhookContent } =
                  require('../bridge/webhookSanitizer.js') as typeof import('../bridge/webhookSanitizer.js');
                /* eslint-enable @typescript-eslint/no-require-imports */
                if (typeof sanitized === 'string') {
                  sanitized = sanitizeInboundWebhookContent(sanitized);
                }
              }
              const content = await resolveAndPrepend(msg, sanitized as string | ContentBlockParam[]);

              const preview = typeof content === 'string' ? content.slice(0, 80) : `[${content.length} content blocks]`;
              logForDebugging(`[bridge:repl] Injecting inbound user message: ${preview}${uuid ? ` uuid=${uuid}` : ''}`);
              enqueue({
                value: content,
                mode: 'prompt' as const,
                uuid,
                // skipSlashCommands 保持为 true 作为纵深防御 —
                // processUserInputBase 在 bridgeOrigin 已设置且
                // 解析的命令通过 isBridgeSafeCommand 时内部覆盖它。
                // 这保持了退出词抑制和直接命令块对于任何
                // 直接检查 skipSlashCommands 的代码路径完好。
                skipSlashCommands: true,
                bridgeOrigin: true,
              });
            } catch (e) {
              logForDebugging(`[bridge:repl] handleInboundMessage failed: ${e}`, { level: 'error' });
            }
          }

          // 状态变化回调 — 将桥接生命周期事件映射到 AppState。
          function handleStateChange(state: BridgeState, detail?: string): void {
            if (cancelled) return;
            if (outboundOnly) {
              logForDebugging(`[bridge:repl] Mirror state=${state}${detail ? ` detail=${detail}` : ''}`);
              // 同步 replBridgeConnected，以便转发 effect 在传输启动或
              // 停止时开始/停止写入。
              if (state === 'failed') {
                setAppState(prev => {
                  if (!prev.replBridgeConnected) return prev;
                  return { ...prev, replBridgeConnected: false };
                });
              } else if (state === 'ready' || state === 'connected') {
                setAppState(prev => {
                  if (prev.replBridgeConnected) return prev;
                  return { ...prev, replBridgeConnected: true };
                });
              }
              return;
            }
            const handle = handleRef.current;
            switch (state) {
              case 'ready':
                setAppState(prev => {
                  const connectUrl =
                    handle && handle.environmentId !== ''
                      ? buildBridgeConnectUrl(handle.environmentId, handle.sessionIngressUrl)
                      : prev.replBridgeConnectUrl;
                  const sessionUrl = handle
                    ? getRemoteSessionUrl(handle.bridgeSessionId, handle.sessionIngressUrl)
                    : prev.replBridgeSessionUrl;
                  const envId = handle?.environmentId;
                  const sessionId = handle?.bridgeSessionId;
                  if (
                    prev.replBridgeConnected &&
                    !prev.replBridgeSessionActive &&
                    !prev.replBridgeReconnecting &&
                    prev.replBridgeConnectUrl === connectUrl &&
                    prev.replBridgeSessionUrl === sessionUrl &&
                    prev.replBridgeEnvironmentId === envId &&
                    prev.replBridgeSessionId === sessionId
                  ) {
                    return prev;
                  }
                  return {
                    ...prev,
                    replBridgeConnected: true,
                    replBridgeSessionActive: false,
                    replBridgeReconnecting: false,
                    replBridgeConnectUrl: connectUrl,
                    replBridgeSessionUrl: sessionUrl,
                    replBridgeEnvironmentId: envId,
                    replBridgeSessionId: sessionId,
                    replBridgeError: undefined,
                  };
                });
                break;
              case 'connected': {
                const wasSessionActive = store.getState().replBridgeSessionActive;
                setAppState(prev => {
                  if (prev.replBridgeSessionActive) return prev;
                  return {
                    ...prev,
                    replBridgeConnected: true,
                    replBridgeSessionActive: true,
                    replBridgeReconnecting: false,
                    replBridgeError: undefined,
                  };
                });
                // 通知模型新可用的 bridge 相关工具
                if (!wasSessionActive) {
                  setMessages(prev => [
                    ...prev,
                    createSystemMessage(
                      'Remote Control 已连接。现在可以使用 PushNotification、SendUserFile、Brief 工具，请使用 SearchExtraTools 搜索发现。',
                      'info',
                    ),
                  ]);
                }
                // 发送 system/init 以便远程客户端（web/iOS/Android）获取
                // 会话元数据。REPL 直接使用 query() — 永远不经过
                // QueryEngine 的 SDKMessage 层 — 因此这是将 system/init
                // 放到 REPL-bridge 线路上的唯一路径。Skills 加载是异步的
                //（记忆化，REPL 启动后开销小）；fire-and-forget 这样
                // connected 状态转换不会被阻塞。
                if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_bridge_system_init', false)) {
                  void (async () => {
                    try {
                      const skills = await getSlashCommandToolSkills(getCwd());
                      if (cancelled) return;
                      const state = store.getState();
                      handleRef.current?.writeSdkMessages([
                        buildSystemInitMessage({
                          // REPL-bridge 省略 tools/mcpClients/plugins：
                          // MCP 前缀的工具名和服务器名会泄露用户连接了
                          // 哪些集成；插件路径泄露原始文件系统路径
                          //（用户名、项目结构）。CCR v2 将 SDK 消息持久化
                          // 到 Spanner — 点击"从手机连接"的用户可能不期望
                          // 这些内容出现在 Anthropic 的服务器上。
                          // QueryEngine（SDK）仍发出完整列表 — SDK 消费者
                          // 期望完整遥测。
                          tools: [],
                          mcpClients: [],
                          model: mainLoopModelRef.current,
                          permissionMode: state.toolPermissionContext.mode as PermissionMode, // TODO: avoid the cast
                          // 远程客户端只能调用桥接安全命令 —
                          // 宣传不安全的命令（local-jsx、未允许的本地）
                          // 会让移动/web 端尝试并遇到错误。
                          commands: commandsRef.current.filter(isBridgeSafeCommand),
                          agents: state.agentDefinitions.activeAgents,
                          skills,
                          plugins: [],
                          fastMode: state.fastMode,
                        }),
                      ]);
                    } catch (err) {
                      logForDebugging(`[bridge:repl] Failed to send system/init: ${errorMessage(err)}`, {
                        level: 'error',
                      });
                    }
                  })();
                }
                break;
              }
              case 'reconnecting':
                setAppState(prev => {
                  if (prev.replBridgeReconnecting) return prev;
                  return {
                    ...prev,
                    replBridgeReconnecting: true,
                    replBridgeSessionActive: false,
                  };
                });
                break;
              case 'failed':
                // 清除之前的失败 dismiss 计时器
                clearTimeout(failureTimeoutRef.current);
                notifyBridgeFailed(detail);
                setAppState(prev => ({
                  ...prev,
                  replBridgeError: detail,
                  replBridgeReconnecting: false,
                  replBridgeSessionActive: false,
                  replBridgeConnected: false,
                }));
                // 超时后自动禁用，使 hook 停止重试。
                failureTimeoutRef.current = setTimeout(() => {
                  if (cancelled) return;
                  failureTimeoutRef.current = undefined;
                  setAppState(prev => {
                    if (!prev.replBridgeError) return prev;
                    return {
                      ...prev,
                      replBridgeEnabled: false,
                      replBridgeError: undefined,
                    };
                  });
                }, BRIDGE_FAILURE_DISMISS_MS);
                break;
            }
          }

          // 待处理的桥接权限响应处理器映射，以 request_id 为键。
          // 每个条目是一个等待 CCR 回复的 onResponse 处理器。
          const pendingPermissionHandlers = new Map<string, (response: BridgePermissionResponse) => void>();

          // 将传入的 control_response 消息分派给注册的处理器
          function handlePermissionResponse(msg: SDKControlResponse): void {
            const requestId = msg.response?.request_id;
            if (!requestId) return;
            const handler = pendingPermissionHandlers.get(requestId);
            if (!handler) {
              logForDebugging(`[bridge:repl] No handler for control_response request_id=${requestId}`);
              return;
            }
            const parsed = parseBridgePermissionResponse(msg);
            if (!parsed) {
              logForDebugging(`[bridge:repl] Ignoring unrecognized control_response request_id=${requestId}`);
              return;
            }
            pendingPermissionHandlers.delete(requestId);
            handler(parsed);
          }

          const rawHandle = await initReplBridge({
            outboundOnly,
            tags: outboundOnly ? ['ccr-mirror'] : undefined,
            onInboundMessage: handleInboundMessage,
            onPermissionResponse: handlePermissionResponse,
            onInterrupt() {
              handleRemoteInterrupt(abortControllerRef.current);
            },
            onSetModel(model) {
              const resolved = model === 'default' ? null : (model ?? null);
              setMainLoopModelOverride(resolved);
              setAppState(prev => {
                if (prev.mainLoopModelForSession === resolved) return prev;
                return { ...prev, mainLoopModelForSession: resolved };
              });
            },
            onSetMaxThinkingTokens(maxTokens) {
              const enabled = maxTokens !== null;
              setAppState(prev => {
                if (prev.thinkingEnabled === enabled) return prev;
                return { ...prev, thinkingEnabled: enabled };
              });
            },
            onSetPermissionMode(mode) {
              // 策略守卫必须在 transitionPermissionMode 之前触发 —
              // 其内部 auto-gate 检查是防御性抛出（在抛出前有
              // setAutoModeActive(true) 副作用）而非优雅拒绝。
              // 让该抛出逃逸会：(1) 在模式未变时留下
              // STATE.autoModeActive=true（三方不变量违反，见 src/CLAUDE.md）
              // (2) 无法发送 control_response → 服务器关闭 WS
              // 这些镜像 print.ts handleSetPermissionMode；桥接不能
              // 直接导入检查（bootstrap-isolation），因此依赖此裁决
              // 发出错误响应。
              if (mode === 'bypassPermissions') {
                if (isBypassPermissionsModeDisabled()) {
                  return {
                    ok: false,
                    error:
                      'Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration',
                  };
                }
                if (!store.getState().toolPermissionContext.isBypassPermissionsModeAvailable) {
                  return {
                    ok: false,
                    error:
                      'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions',
                  };
                }
              }
              if (feature('TRANSCRIPT_CLASSIFIER') && mode === 'auto' && !isAutoModeGateEnabled()) {
                const reason = getAutoModeUnavailableReason();
                return {
                  ok: false,
                  error: reason
                    ? `Cannot set permission mode to auto: ${getAutoModeUnavailableNotification(reason)}`
                    : 'Cannot set permission mode to auto',
                };
              }
              // 守卫通过 — 通过集中转换应用，这样 prePlanMode
              // 暂存和 auto-mode 状态同步都会触发。
              setAppState(prev => {
                const current = prev.toolPermissionContext.mode;
                if (current === mode) return prev;
                const next = transitionPermissionMode(current, mode, prev.toolPermissionContext);
                return {
                  ...prev,
                  toolPermissionContext: { ...next, mode },
                };
              });
              // 模式变化后重新检查排队的权限提示。
              setImmediate(() => {
                getLeaderToolUseConfirmQueue()?.(currentQueue => {
                  currentQueue.forEach(item => {
                    void item.recheckPermission();
                  });
                  return currentQueue;
                });
              });
              return { ok: true };
            },
            onStateChange: handleStateChange,
            initialMessages: messages.length > 0 ? messages : undefined,
            getMessages: () => messagesRef.current,
            previouslyFlushedUUIDs: flushedUUIDsRef.current,
            initialName: replBridgeInitialName,
            perpetual,
          });
          const handle = rawHandle
            ? {
                ...rawHandle,
                markTranscriptReset() {
                  transcriptResetPendingRef.current = true;
                  pendingResultAfterFlushRef.current = false;
                  lastWrittenIndexRef.current = 0;
                },
              }
            : null;
          if (cancelled) {
            // initReplBridge 进行中时 effect 被取消。
            // 拆除 handle 以避免泄露资源（轮询循环、
            // WebSocket、已注册环境、清理回调）。
            logForDebugging(
              `[bridge:repl] Hook: init cancelled during flight, tearing down${handle ? ` env=${handle.environmentId}` : ''}`,
            );
            if (handle) {
              void handle.teardown();
            }
            return;
          }
          if (!handle) {
            // initReplBridge 返回 null — 前提条件失败。对于大多数情况
            //（no_oauth, policy_denied 等）onStateChange('failed') 已经
            // 以特定提示触发。GrowthBook-gate-off 情况有意保持静默 —
            // 不是失败，只是未推出。
            consecutiveFailuresRef.current++;
            logForDebugging(
              `[bridge:repl] Init returned null (precondition or session creation failed); consecutive failures: ${consecutiveFailuresRef.current}`,
            );
            clearTimeout(failureTimeoutRef.current);
            setAppState(prev => ({
              ...prev,
              replBridgeError: prev.replBridgeError ?? 'check debug logs for details',
            }));
            failureTimeoutRef.current = setTimeout(() => {
              if (cancelled) return;
              failureTimeoutRef.current = undefined;
              setAppState(prev => {
                if (!prev.replBridgeError) return prev;
                return {
                  ...prev,
                  replBridgeEnabled: false,
                  replBridgeError: undefined,
                };
              });
            }, BRIDGE_FAILURE_DISMISS_MS);
            return;
          }
          handleRef.current = handle;
          setReplBridgeHandle(handle);
          consecutiveFailuresRef.current = 0;
          // 在转发 effect 中跳过初始消息 — 它们已在创建期间
          // 作为会话事件加载。
          lastWrittenIndexRef.current = initialMessageCount;

          if (outboundOnly) {
            setAppState(prev => {
              if (prev.replBridgeConnected && prev.replBridgeSessionId === handle.bridgeSessionId) return prev;
              return {
                ...prev,
                replBridgeConnected: true,
                replBridgeSessionId: handle.bridgeSessionId,
                replBridgeSessionUrl: undefined,
                replBridgeConnectUrl: undefined,
                replBridgeError: undefined,
              };
            });
            logForDebugging(`[bridge:repl] Mirror initialized, session=${handle.bridgeSessionId}`);
          } else {
            // 构建桥接权限回调，以便交互式权限处理器可以
            // 将桥接响应与本地用户交互竞速。
            const permissionCallbacks: BridgePermissionCallbacks = {
              sendRequest(requestId, toolName, input, toolUseId, description, permissionSuggestions, blockedPath) {
                handle.sendControlRequest({
                  type: 'control_request',
                  request_id: requestId,
                  request: {
                    subtype: 'can_use_tool',
                    tool_name: toolName,
                    input,
                    tool_use_id: toolUseId,
                    description,
                    ...(permissionSuggestions ? { permission_suggestions: permissionSuggestions } : {}),
                    ...(blockedPath ? { blocked_path: blockedPath } : {}),
                  },
                });
              },
              sendResponse(requestId, response) {
                const payload: Record<string, unknown> = { ...response };
                handle.sendControlResponse({
                  type: 'control_response',
                  response: {
                    subtype: 'success',
                    request_id: requestId,
                    response: payload,
                  },
                });
              },
              cancelRequest(requestId) {
                handle.sendControlCancelRequest(requestId);
              },
              onResponse(requestId, handler) {
                pendingPermissionHandlers.set(requestId, handler);
                return () => {
                  pendingPermissionHandlers.delete(requestId);
                };
              },
            };
            setAppState(prev => ({
              ...prev,
              replBridgePermissionCallbacks: permissionCallbacks,
            }));
            const url = getRemoteSessionUrl(handle.bridgeSessionId, handle.sessionIngressUrl);
            // environmentId === '' 表示 v2 无环境路径。buildBridgeConnectUrl
            // 构建特定环境的连接 URL，没有环境时不存在。
            const hasEnv = handle.environmentId !== '';
            const connectUrl = hasEnv
              ? buildBridgeConnectUrl(handle.environmentId, handle.sessionIngressUrl)
              : undefined;
            setAppState(prev => {
              if (prev.replBridgeConnected && prev.replBridgeSessionUrl === url) {
                return prev;
              }
              return {
                ...prev,
                replBridgeConnected: true,
                replBridgeSessionUrl: url,
                replBridgeConnectUrl: connectUrl ?? prev.replBridgeConnectUrl,
                replBridgeEnvironmentId: handle.environmentId,
                replBridgeSessionId: handle.bridgeSessionId,
                replBridgeError: undefined,
              };
            });

            // 在 transcript 中显示带 URL 的桥接状态。perpetual
            //（KAIROS 助手模式）在 initReplBridge.ts 回退到 v1 —
            // 为它们跳过 v2 专属的升级提示。独立的 try/catch 这样
            // 装饰性的 GrowthBook 故障不会触及外部 init 失败处理器。
            const upgradeNudge = !perpetual ? await shouldShowAppUpgradeMessage().catch(() => false) : false;
            if (cancelled) return;
            setMessages(prev => [
              ...prev,
              createBridgeStatusMessage(
                url,
                upgradeNudge
                  ? 'Please upgrade to the latest version of the Claude mobile app to see your Remote Control sessions.'
                  : undefined,
              ),
            ]);

            logForDebugging(`[bridge:repl] Hook initialized, session=${handle.bridgeSessionId}`);
          }
        } catch (err) {
          // 绝不让 REPL 崩溃 — 在 UI 中显示错误。
          // 先检查 cancelled（与 ~386 行 !handle 路径对称）：
          // 如果 initReplBridge 在快速切换关闭时抛出（进行中的
          // 网络错误），不要将其计入熔断器或向 UI 发送过时错误。
          // 还修复了取消抛出时预先存在的虚假 setAppState/setMessages。
          if (cancelled) return;
          consecutiveFailuresRef.current++;
          const errMsg = errorMessage(err);
          logForDebugging(
            `[bridge:repl] Init failed: ${errMsg}; consecutive failures: ${consecutiveFailuresRef.current}`,
          );
          clearTimeout(failureTimeoutRef.current);
          notifyBridgeFailed(errMsg);
          setAppState(prev => ({
            ...prev,
            replBridgeError: errMsg,
          }));
          failureTimeoutRef.current = setTimeout(() => {
            if (cancelled) return;
            failureTimeoutRef.current = undefined;
            setAppState(prev => {
              if (!prev.replBridgeError) return prev;
              return {
                ...prev,
                replBridgeEnabled: false,
                replBridgeError: undefined,
              };
            });
          }, BRIDGE_FAILURE_DISMISS_MS);
          if (!outboundOnly) {
            setMessages(prev => [
              ...prev,
              createSystemMessage(`Remote Control failed to connect: ${errMsg}`, 'warning'),
            ]);
          }
        }
      })();

      return () => {
        cancelled = true;
        clearTimeout(failureTimeoutRef.current);
        failureTimeoutRef.current = undefined;
        if (handleRef.current) {
          logForDebugging(
            `[bridge:repl] Hook cleanup: starting teardown for env=${handleRef.current.environmentId} session=${handleRef.current.bridgeSessionId}`,
          );
          teardownPromiseRef.current = handleRef.current.teardown();
          handleRef.current = null;
          setReplBridgeHandle(null);
        }
        setAppState(prev => {
          if (!prev.replBridgeConnected && !prev.replBridgeSessionActive && !prev.replBridgeError) {
            return prev;
          }
          return {
            ...prev,
            replBridgeConnected: false,
            replBridgeSessionActive: false,
            replBridgeReconnecting: false,
            replBridgeConnectUrl: undefined,
            replBridgeSessionUrl: undefined,
            replBridgeEnvironmentId: undefined,
            replBridgeSessionId: undefined,
            replBridgeError: undefined,
            replBridgePermissionCallbacks: undefined,
          };
        });
        lastWrittenIndexRef.current = 0;
        pendingResultAfterFlushRef.current = false;
        transcriptResetPendingRef.current = false;
      };
    }
  }, [replBridgeEnabled, replBridgeOutboundOnly, setAppState, setMessages, addNotification]);

  // 在新消息出现时写入。
  // 也在 replBridgeConnected 变化时重新运行（桥接完成初始化），
  // 这样在桥接准备好之前到达的消息也会被写入。
  useEffect(() => {
    // 正向 feature() 守卫 — 见第一个 useEffect 注释
    if (feature('BRIDGE_MODE')) {
      if (!replBridgeConnected) return;

      const handle = handleRef.current;
      if (!handle) return;

      // 在消息被压缩（数组缩短）时钳制索引。
      // 压缩后 ref 可能超过 messages.length，没有钳制就没有新消息会被转发。
      if (lastWrittenIndexRef.current > messages.length) {
        logForDebugging(
          `[bridge:repl] Compaction detected: lastWrittenIndex=${lastWrittenIndexRef.current} > messages.length=${messages.length}, clamping`,
        );
      }
      const startIndex = Math.min(lastWrittenIndexRef.current, messages.length);

      // 收集自上次写入以来的新消息
      const newMessages: Message[] = [];
      for (let i = startIndex; i < messages.length; i++) {
        const msg = messages[i];
        if (
          msg &&
          (msg.type === 'user' ||
            msg.type === 'assistant' ||
            (msg.type === 'system' && msg.subtype === 'local_command'))
        ) {
          newMessages.push(msg);
        }
      }
      lastWrittenIndexRef.current = messages.length;

      if (newMessages.length > 0) {
        handle.writeMessages(newMessages);
        transcriptResetPendingRef.current = false;
      }

      if (
        pendingResultAfterFlushRef.current &&
        isTranscriptResetResultReady(transcriptResetPendingRef.current, messages.length)
      ) {
        transcriptResetPendingRef.current = false;
        pendingResultAfterFlushRef.current = false;
        handle.sendResult();
        return;
      }

      if (pendingResultAfterFlushRef.current && !transcriptResetPendingRef.current) {
        pendingResultAfterFlushRef.current = false;
        handle.sendResult();
      }
    }
  }, [messages, replBridgeConnected]);

  useEffect(() => {
    if (feature('BRIDGE_MODE')) {
      if (!replBridgeSessionActive || replBridgeOutboundOnly) return;

      let cancelled = false;
      let debounceTimer: ReturnType<typeof setTimeout> | undefined;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      let watcher: FSWatcher | null = null;
      let watchedDir: string | null = null;
      let lastPublishedSnapshotKey: string | null = null;
      let lastPublishedHandle: ReplBridgeHandle | null = null;

      const rewatch = (dir: string): void => {
        if (dir === watchedDir && watcher !== null) return;
        watcher?.close();
        watcher = null;
        watchedDir = dir;
        try {
          watcher = watch(dir, schedulePublish);
          watcher.unref();
        } catch {
          // writer 确保目录存在；如果还不存在，轮询定时器和进程内
          // 任务信号仍会汇聚快照。
        }
      };

      const publishTaskState = async (): Promise<void> => {
        const handle = handleRef.current;
        if (!handle) return;

        const taskListId = getTaskListId();
        rewatch(getTasksDir(taskListId));

        try {
          const tasks = await listTasks(taskListId);
          if (cancelled || handleRef.current !== handle) return;
          const snapshotKey = getTaskStateSnapshotKey(taskListId, tasks);
          if (snapshotKey === lastPublishedSnapshotKey && handle === lastPublishedHandle) {
            return;
          }
          handle.writeSdkMessages([buildTaskStateMessage(taskListId, tasks)]);
          lastPublishedSnapshotKey = snapshotKey;
          lastPublishedHandle = handle;
        } catch (err) {
          logForDebugging(`[bridge:repl] Failed to publish task_state: ${errorMessage(err)}`, { level: 'error' });
        }
      };

      const schedulePublish = (): void => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = undefined;
          void publishTaskState();
        }, TASK_STATE_DEBOUNCE_MS);
        debounceTimer.unref?.();
      };

      void publishTaskState();
      const unsubscribe = onTasksUpdated(schedulePublish);
      pollTimer = setInterval(() => {
        void publishTaskState();
      }, TASK_STATE_POLL_MS);
      pollTimer.unref?.();

      return () => {
        cancelled = true;
        unsubscribe();
        if (debounceTimer) clearTimeout(debounceTimer);
        if (pollTimer) clearInterval(pollTimer);
        watcher?.close();
      };
    }
  }, [replBridgeSessionActive, replBridgeOutboundOnly]);

  const sendBridgeResult = useCallback(() => {
    if (feature('BRIDGE_MODE')) {
      const handle = handleRef.current;
      if (!handle) {
        pendingResultAfterFlushRef.current = true;
        return;
      }

      if (isTranscriptResetResultReady(transcriptResetPendingRef.current, messagesRef.current.length)) {
        transcriptResetPendingRef.current = false;
        pendingResultAfterFlushRef.current = false;
        handle.sendResult();
        return;
      }

      // 消息镜像在单独的 effect 中进行。当回合在该 effect 刷新
      // 最新 transcript 行之前完成时，保留结果，这样远程状态
      // 在最终镜像消息之后转换，而不是在 /clear 等本地斜杠命令上
      // 弹回"running"。
      if (
        transcriptResetPendingRef.current ||
        shouldDeferBridgeResult({
          hasHandle: true,
          isConnected: replBridgeConnected,
          lastWrittenIndex: lastWrittenIndexRef.current,
          messageCount: messagesRef.current.length,
        })
      ) {
        pendingResultAfterFlushRef.current = true;
        return;
      }

      handle.sendResult();
    }
  }, [replBridgeConnected]);

  return { sendBridgeResult };
}
