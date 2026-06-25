import { feature } from 'bun:bundle';
import * as React from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { useAppState, useSetAppState } from 'src/state/AppState.js';
import type { PermissionMode } from 'src/utils/permissions/PermissionMode.js';
import {
  getIsRemoteMode,
  getKairosActive,
  getMainThreadAgentType,
  getOriginalCwd,
  getSdkBetas,
  getSessionId,
} from '../bootstrap/state.js';
import { DEFAULT_OUTPUT_STYLE_NAME } from '../constants/outputStyles.js';
import { useNotifications } from '../context/notifications.js';
import {
  getTotalAPIDuration,
  getTotalCost,
  getTotalDuration,
  getTotalInputTokens,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalOutputTokens,
} from '../cost-tracker.js';
import { useMainLoopModel } from '../hooks/useMainLoopModel.js';
import { type ReadonlySettings, useSettings } from '../hooks/useSettings.js';
import { Ansi, Box, Text } from '@anthropic/ink';
import { getRawUtilization } from '../services/claudeAiLimits.js';
import type { Message } from '../types/message.js';
import type { StatusLineCommandInput } from '../types/statusLine.js';
import type { VimMode } from '../types/textInputTypes.js';
import { checkHasTrustDialogAccepted } from '../utils/config.js';
import { calculateContextPercentages, getContextWindowForModel } from '../utils/context.js';
import { getCwd } from '../utils/cwd.js';
import { logForDebugging } from '../utils/debug.js';
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js';
import { createBaseHookInput, executeStatusLineCommand } from '../utils/hooks.js';
import { getLastAssistantMessage } from '../utils/messages.js';
import { getRuntimeMainLoopModel, type ModelName, renderModelName } from '../utils/model/model.js';
import { getCurrentSessionTitle } from '../utils/sessionStorage.js';
import { doesMostRecentAssistantMessageExceed200k, getCurrentUsage } from '../utils/tokens.js';
import { getCurrentWorktreeSession } from '../utils/worktree.js';
import { isVimModeEnabled } from './PromptInput/utils.js';
import { computeHitRate, tokenSignature } from '../utils/cacheStats.js';
import { onResponse as cacheOnResponse, getCacheStatsState, initCacheStatsState } from '../utils/cacheStatsState.js';
import { BuiltinStatusLine } from './BuiltinStatusLine.js';
import { formatTokens } from 'src/utils/format.js';

// ---------------------------------------------------------------------------
// CachePill —— cache 命中率 + 1 小时 TTL 倒计时胶囊
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60 * 60 * 1000; // 60 分钟

function padTwo(n: number): string {
  return String(Math.floor(n)).padStart(2, '0');
}

function formatCountdown(remainingMs: number): string {
  if (remainingMs <= 0) return 'exp';
  const mins = Math.floor(remainingMs / 60_000);
  const secs = Math.floor((remainingMs % 60_000) / 1000);
  return `${padTwo(mins)}:${padTwo(secs)}`;
}

type CachePillProps = {
  messages: Message[];
};

function CachePill({ messages }: CachePillProps): React.ReactNode {
  const [now, setNow] = useState(() => Date.now());
  const [isFlashOn, setIsFlashOn] = useState(true);

  const usage = getCurrentUsage(messages);

  // 将新的 response 喂给内存中的 singleton
  const prevSigRef = useRef<string | null>(null);
  if (usage !== null) {
    const sig = tokenSignature(usage);
    if (sig !== prevSigRef.current) {
      prevSigRef.current = sig;
      cacheOnResponse(usage);
    }
  }

  const cacheState = getCacheStatsState();
  const { lastResetAt, lastHitRate } = cacheState;

  // 派生的时间
  const elapsed = lastResetAt !== null ? now - lastResetAt : null;
  const remaining = elapsed !== null ? CACHE_TTL_MS - elapsed : null;
  const elapsedMin = elapsed !== null ? elapsed / 60_000 : null;
  const isExpired = remaining !== null && remaining <= 0;

  // 1 秒倒计时 ticker
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // 最后 5 分钟以 500ms 闪烁
  const inFlashZone = elapsedMin !== null && elapsedMin >= 55 && !isExpired;
  useEffect(() => {
    if (!inFlashZone) {
      setIsFlashOn(true);
      return;
    }
    const id = setInterval(() => setIsFlashOn(v => !v), 500);
    return () => clearInterval(id);
  }, [inFlashZone]);

  // 挂载时一次性加载持久化的回退值
  const initDoneRef = useRef(false);
  useEffect(() => {
    if (initDoneRef.current) return;
    initDoneRef.current = true;
    const sid = getSessionId();
    void initCacheStatsState(sid);
  }, []);

  const displayHitRate = usage !== null ? computeHitRate(usage) : lastHitRate;

  // 暂无数据 —— 显示占位符
  if (displayHitRate === null && lastResetAt === null) {
    return <Text dimColor>{' Cache --% --:--'}</Text>;
  }

  const countdownText = remaining !== null ? formatCountdown(remaining) : '--:--';
  const hitRateText = displayHitRate !== null ? `${displayHitRate}%` : '--%';

  // 根据已过时间分桶决定 timer 颜色 —— 使用 theme key
  type TimerThemeKey = 'success' | 'warning' | 'error' | 'inactive';
  let timerColor: TimerThemeKey;
  if (isExpired || elapsedMin === null) {
    timerColor = 'inactive';
  } else if (elapsedMin < 20) {
    timerColor = 'success';
  } else if (elapsedMin < 40) {
    timerColor = 'warning';
  } else {
    timerColor = 'error';
  }

  // 命中率颜色 —— 使用 theme key
  const hitRateColor: 'success' | 'inactive' = displayHitRate !== null && displayHitRate >= 50 ? 'success' : 'inactive';

  return (
    <Text>
      <Text dimColor>{' Cache '}</Text>
      <Text color={hitRateColor}>{hitRateText}</Text>
      <Text color={timerColor} dimColor={inFlashZone && !isFlashOn}>
        {' '}
        {countdownText}
      </Text>
    </Text>
  );
}

function GoalPill(): React.ReactNode {
  if (!feature('GOAL')) return null;
  const { getGoal, formatGoalStatusLabel } =
    require('../services/goal/goalState.js') as typeof import('../services/goal/goalState.js');
  const goal = getGoal();
  if (!goal) return null;

  const truncatedObj = goal.objective.length > 30 ? `${goal.objective.slice(0, 27)}…` : goal.objective;
  const budget =
    goal.tokenBudget !== null
      ? `${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)}`
      : formatTokens(goal.tokensUsed);
  const statusLabel = formatGoalStatusLabel(goal.status);

  let statusNode: React.ReactNode;
  switch (goal.status) {
    case 'active':
      statusNode = <Text color="ansi:green">{statusLabel}</Text>;
      break;
    case 'paused':
    case 'budget_limited':
    case 'usage_limited':
      statusNode = <Text color="ansi:yellow">{statusLabel}</Text>;
      break;
    case 'blocked':
      statusNode = <Text color="ansi:red">{statusLabel}</Text>;
      break;
    case 'complete':
      statusNode = <Text color="ansi:cyan">{statusLabel}</Text>;
      break;
    default:
      statusNode = <Text>{statusLabel}</Text>;
  }

  return (
    <Text>
      {statusNode}
      <Text dimColor>{' · '}</Text>
      <Text dimColor>{truncatedObj}</Text>
      <Text dimColor>{' · '}</Text>
      <Text>{budget}</Text>
    </Text>
  );
}

export function statusLineShouldDisplay(settings: ReadonlySettings): boolean {
  // Assistant 模式：statusline 字段（model、permission mode、cwd）反映的是
  // REPL/daemon 进程，而不是 agent 子进程实际运行的状态。因此隐藏。
  if (feature('KAIROS') && getKairosActive()) return false;
  // 当显式启用时，或配置了 statusLine 命令时显示 status line
  // （为那些设置了 statusLine.command 但没切换 statusLineEnabled 的用户提供向后兼容）。
  // 仅在显式禁用时才隐藏。
  if (settings?.statusLineEnabled === false) return false;
  return settings?.statusLineEnabled === true || !!settings?.statusLine?.command;
}

function buildStatusLineCommandInput(
  permissionMode: PermissionMode,
  exceeds200kTokens: boolean,
  settings: ReadonlySettings,
  messages: Message[],
  addedDirs: string[],
  mainLoopModel: ModelName,
  vimMode?: VimMode,
): StatusLineCommandInput {
  const agentType = getMainThreadAgentType();
  const worktreeSession = getCurrentWorktreeSession();
  const runtimeModel = getRuntimeMainLoopModel({
    permissionMode,
    mainLoopModel,
    exceeds200kTokens,
  });
  const outputStyleName = settings?.outputStyle || DEFAULT_OUTPUT_STYLE_NAME;

  const currentUsage = getCurrentUsage(messages);
  const contextWindowSize = getContextWindowForModel(runtimeModel, getSdkBetas());
  const contextPercentages = calculateContextPercentages(currentUsage, contextWindowSize);

  const sessionId = getSessionId();
  const sessionName = getCurrentSessionTitle(sessionId);
  const rawUtil = getRawUtilization();
  const rateLimits: NonNullable<StatusLineCommandInput['rate_limits']> = {
    ...(rawUtil.five_hour && {
      five_hour: {
        used_percentage: rawUtil.five_hour.utilization * 100,
        resets_at: rawUtil.five_hour.resets_at,
      },
    }),
    ...(rawUtil.seven_day && {
      seven_day: {
        used_percentage: rawUtil.seven_day.utilization * 100,
        resets_at: rawUtil.seven_day.resets_at,
      },
    }),
  };
  return {
    ...createBaseHookInput(),
    ...(sessionName && { session_name: sessionName }),
    model: {
      id: runtimeModel,
      display_name: renderModelName(runtimeModel),
    },
    workspace: {
      current_dir: getCwd(),
      project_dir: getOriginalCwd(),
      added_dirs: addedDirs,
    },
    version: MACRO.VERSION,
    output_style: {
      name: outputStyleName,
    },
    cost: {
      total_cost_usd: getTotalCost(),
      total_duration_ms: getTotalDuration(),
      total_api_duration_ms: getTotalAPIDuration(),
      total_lines_added: getTotalLinesAdded(),
      total_lines_removed: getTotalLinesRemoved(),
    },
    context_window: {
      total_input_tokens: getTotalInputTokens(),
      total_output_tokens: getTotalOutputTokens(),
      context_window_size: contextWindowSize,
      current_usage: currentUsage,
      used_percentage: contextPercentages.used,
      remaining_percentage: contextPercentages.remaining,
    },
    exceeds_200k_tokens: exceeds200kTokens,
    ...((rateLimits.five_hour || rateLimits.seven_day) && {
      rate_limits: rateLimits,
    }),
    ...(isVimModeEnabled() && {
      vim: {
        mode: vimMode ?? 'INSERT',
      },
    }),
    ...(agentType && {
      agent: {
        name: agentType,
      },
    }),
    ...(getIsRemoteMode() && {
      remote: {
        session_id: getSessionId(),
      },
    }),
    ...(worktreeSession && {
      worktree: {
        name: worktreeSession.worktreeName,
        path: worktreeSession.worktreePath,
        branch: worktreeSession.worktreeBranch,
        original_cwd: worktreeSession.originalCwd,
        original_branch: worktreeSession.originalBranch,
      },
    }),
  };
}

type Props = {
  // messages 放在 ref 中（只在 debounced 回调中读取）；
  // lastAssistantMessageId 才是真正触发重新渲染的依据。
  messagesRef: React.RefObject<Message[]>;
  lastAssistantMessageId: string | null;
  vimMode?: VimMode;
};

export function getLastAssistantMessageId(messages: Message[]): string | null {
  return getLastAssistantMessage(messages)?.uuid ?? null;
}

function StatusLineInner({ messagesRef, lastAssistantMessageId, vimMode }: Props): React.ReactNode {
  const abortControllerRef = useRef<AbortController | undefined>(undefined);
  const permissionMode = useAppState(s => s.toolPermissionContext.mode);
  const additionalWorkingDirectories = useAppState(s => s.toolPermissionContext.additionalWorkingDirectories);
  const statusLineText = useAppState(s => s.statusLineText);
  const setAppState = useSetAppState();
  const settings = useSettings();
  const { addNotification } = useNotifications();
  // 来自 AppState 的 model —— 与 API 请求来源相同。getMainLoopModel()
  // 每次调用都会重新读取 settings.json，所以另一个会话的 /model 写入
  // 会泄露到本会话的 statusline（anthropics/claude-code#37596）。
  const mainLoopModel = useMainLoopModel();

  // 把最新值保留在 ref 中，以便在稳定的回调中访问
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const vimModeRef = useRef(vimMode);
  vimModeRef.current = vimMode;
  const permissionModeRef = useRef(permissionMode);
  permissionModeRef.current = permissionMode;
  const addedDirsRef = useRef(additionalWorkingDirectories);
  addedDirsRef.current = additionalWorkingDirectories;
  const mainLoopModelRef = useRef(mainLoopModel);
  mainLoopModelRef.current = mainLoopModel;

  // 跟踪上一次的状态以检测变化，并缓存昂贵的计算
  const previousStateRef = useRef<{
    messageId: string | null;
    exceeds200kTokens: boolean;
    permissionMode: PermissionMode;
    vimMode: VimMode | undefined;
    mainLoopModel: ModelName;
  }>({
    messageId: null,
    exceeds200kTokens: false,
    permissionMode,
    vimMode,
    mainLoopModel,
  });

  // Debounce timer ref
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 为 true 时表示下一次调用应该记录其结果（首次运行或 settings 重新加载后）
  const logNextResultRef = useRef(true);

  // 稳定的更新函数 —— 从 ref 读取最新值
  const doUpdate = useCallback(async () => {
    // 取消任何进行中的请求
    abortControllerRef.current?.abort();

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const msgs = messagesRef.current;

    const logResult = logNextResultRef.current;
    logNextResultRef.current = false;

    // 未配置命令时完全跳过 shell 命令路径。
    // 顶行（BuiltinStatusLine + CachePill）是无条件渲染的，所以
    // 当 settings.statusLine 缺失时这里没有任何需要更新的内容。
    if (!settingsRef.current?.statusLine?.command) {
      return;
    }

    try {
      let exceeds200kTokens = previousStateRef.current.exceeds200kTokens;

      // 仅在 messages 变化时才重新计算 200k 检查
      const currentMessageId = getLastAssistantMessageId(msgs);
      if (currentMessageId !== previousStateRef.current.messageId) {
        exceeds200kTokens = doesMostRecentAssistantMessageExceed200k(msgs);
        previousStateRef.current.messageId = currentMessageId;
        previousStateRef.current.exceeds200kTokens = exceeds200kTokens;
      }

      const statusInput = buildStatusLineCommandInput(
        permissionModeRef.current,
        exceeds200kTokens,
        settingsRef.current,
        msgs,
        Array.from(addedDirsRef.current.keys()),
        mainLoopModelRef.current,
        vimModeRef.current,
      );

      const text = await executeStatusLineCommand(statusInput, controller.signal, undefined, logResult);
      if (!controller.signal.aborted) {
        setAppState(prev => {
          if (prev.statusLineText === text) return prev;
          return { ...prev, statusLineText: text };
        });
      }
    } catch {
      // 静默忽略 status line 更新中的错误
    }
  }, [messagesRef, setAppState]);

  // 稳定的 debounced 调度函数 —— 无依赖，使用 ref
  const scheduleUpdate = useCallback(() => {
    if (debounceTimerRef.current !== undefined) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(
      (ref, doUpdate) => {
        ref.current = undefined;
        void doUpdate();
      },
      300,
      debounceTimerRef,
      doUpdate,
    );
  }, [doUpdate]);

  // 仅当 assistant 消息、permission mode、vim mode 或 model 真正变化时才触发更新
  useEffect(() => {
    if (
      lastAssistantMessageId !== previousStateRef.current.messageId ||
      permissionMode !== previousStateRef.current.permissionMode ||
      vimMode !== previousStateRef.current.vimMode ||
      mainLoopModel !== previousStateRef.current.mainLoopModel
    ) {
      // 不要在这里更新 messageId —— 让 doUpdate 处理，以便
      // exceeds200kTokens 基于最新的 messages 重新计算
      previousStateRef.current.permissionMode = permissionMode;
      previousStateRef.current.vimMode = vimMode;
      previousStateRef.current.mainLoopModel = mainLoopModel;
      scheduleUpdate();
    }
  }, [lastAssistantMessageId, permissionMode, vimMode, mainLoopModel, scheduleUpdate]);

  // 当 statusLine 命令变化时（热重载），记录下一次的结果
  const statusLineCommand = settings?.statusLine?.command;
  const isFirstSettingsRender = useRef(true);
  useEffect(() => {
    if (isFirstSettingsRender.current) {
      isFirstSettingsRender.current = false;
      return;
    }
    logNextResultRef.current = true;
    void doUpdate();
  }, [statusLineCommand, doUpdate]);

  // 在挂载时记录的独立 effect
  useEffect(() => {
    const statusLine = settings?.statusLine;
    if (statusLine) {
      logEvent('tengu_status_line_mount', {
        command_length: statusLine.command.length,
        padding: statusLine.padding,
      });
      // 记录 status line 已配置但被 disableAllHooks 禁用的情况
      if (settings.disableAllHooks === true) {
        logForDebugging('Status line is configured but disableAllHooks is true', { level: 'warn' });
      }
      // executeStatusLineCommand（hooks.ts）在 trust 被阻止时返回 undefined ——
      // statusLineText 会一直为 undefined，用户什么都看不到，
      // 而上面的 tengu_status_line_mount 依然会触发，所以 telemetry 看起来正常。
      if (!checkHasTrustDialogAccepted()) {
        addNotification({
          key: 'statusline-trust-blocked',
          text: 'statusline 已跳过 · 重启以修复',
          color: 'warning',
          priority: 'low',
        });
        logForDebugging('Status line command skipped: workspace trust not accepted', { level: 'warn' });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 仅在挂载时运行一次 —— settings 在初始日志记录时是稳定的

  // 挂载时进行初始更新 + 卸载时清理
  useEffect(() => {
    void doUpdate();

    return () => {
      abortControllerRef.current?.abort();
      if (debounceTimerRef.current !== undefined) {
        clearTimeout(debounceTimerRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 仅在挂载时运行一次，不随 doUpdate 变化

  // 从 settings 获取 padding，默认为 0
  const paddingX = settings?.statusLine?.padding ?? 0;

  // ---- Top row data: feed BuiltinStatusLine (model + ctx + 5h + 7d + cost) ---
  const builtinRuntimeModel = getRuntimeMainLoopModel({
    permissionMode,
    mainLoopModel,
    exceeds200kTokens: previousStateRef.current.exceeds200kTokens,
  });
  const builtinContextWindowSize = getContextWindowForModel(builtinRuntimeModel, getSdkBetas());
  const builtinCurrentUsage = getCurrentUsage(messagesRef.current);
  const builtinUsedTokens = builtinCurrentUsage
    ? builtinCurrentUsage.input_tokens +
      builtinCurrentUsage.cache_creation_input_tokens +
      builtinCurrentUsage.cache_read_input_tokens
    : 0;
  const builtinContextPct = builtinCurrentUsage
    ? Math.round(calculateContextPercentages(builtinCurrentUsage, builtinContextWindowSize).used ?? 0)
    : 0;
  const builtinRawUtil = getRawUtilization();
  const builtinRateLimits = {
    ...(builtinRawUtil.five_hour && {
      five_hour: {
        utilization: builtinRawUtil.five_hour.utilization,
        resets_at: builtinRawUtil.five_hour.resets_at,
      },
    }),
    ...(builtinRawUtil.seven_day && {
      seven_day: {
        utilization: builtinRawUtil.seven_day.utilization,
        resets_at: builtinRawUtil.seven_day.resets_at,
      },
    }),
  };

  // BuiltinStatusLine + CachePill：仅当 statusLineEnabled 显式为 true 时显示。
  // Shell 命令输出：仅当配置了 statusLine.command 时显示。
  // 两者相互独立 —— 用户可以只有其中一个、两者都有，或都没有。
  const showBuiltin = settings?.statusLineEnabled === true;
  const hasShellCommand = !!settings?.statusLine?.command;

  return (
    <Box flexDirection="column" paddingX={paddingX}>
      {/* 顶部：内置 fork 状态（model | ctx | 5h | 7d | cost）+ Cache 胶囊 */}
      {showBuiltin && (
        <Box gap={2}>
          <BuiltinStatusLine
            modelName={renderModelName(builtinRuntimeModel)}
            contextUsedPct={builtinContextPct}
            usedTokens={builtinUsedTokens}
            contextWindowSize={builtinContextWindowSize}
            totalCostUsd={getTotalCost()}
            rateLimits={builtinRateLimits}
          />
          <GoalPill />
          <CachePill messages={messagesRef.current} />
        </Box>
      )}
      {/* 底部：用户配置的 /statusline shell 输出（在全屏模式下保留该行） */}
      {statusLineText ? (
        <Text dimColor wrap="truncate">
          <Ansi>{statusLineText}</Ansi>
        </Text>
      ) : hasShellCommand && isFullscreenEnvEnabled() ? (
        <Text> </Text>
      ) : null}
    </Box>
  );
}

// 父组件（PromptInputFooter）在每次 setMessages 时都会重新渲染，但 StatusLine
// 自身的 props 现在仅在 lastAssistantMessageId 变化时才改变 —— memo 避免它
// 被牵连重新渲染（此前每个会话约有 18 次 props 无变化的渲染）。
export const StatusLine = memo(StatusLineInner);
