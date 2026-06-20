import { useCallback, useEffect, useMemo, useRef } from 'react'
import { BoundedUUIDSet } from '../bridge/bridgeMessaging.js'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import type { SpinnerMode } from '../components/Spinner/types.js'
import {
  type RemotePermissionResponse,
  type RemoteSessionConfig,
  RemoteSessionManager,
} from '../remote/RemoteSessionManager.js'
import {
  createSyntheticAssistantMessage,
  createToolStub,
} from '../remote/remotePermissionBridge.js'
import {
  convertSDKMessage,
  isSessionEndMessage,
} from '../remote/sdkMessageAdapter.js'
import { useSetAppState } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Tool } from '../Tool.js'
import { findToolByName } from '../Tool.js'
import type { Message as MessageType } from '../types/message.js'
import type {
  PermissionAskDecision,
  PermissionUpdate,
} from '../types/permissions.js'
import { logForDebugging } from '../utils/debug.js'
import { truncateToWidth } from '../utils/format.js'
import {
  createSystemMessage,
  extractTextContent,
  handleMessageFromStream,
  type StreamingToolUse,
} from '../utils/messages.js'
import { generateSessionTitle } from '../utils/sessionTitle.js'
import type { RemoteMessageContent } from '../utils/teleport/api.js'
import { updateSessionTitle } from '../utils/teleport/api.js'

// 等待响应多久后显示警告
const RESPONSE_TIMEOUT_MS = 60000 // 60 秒
// 压缩期间的延长超时 — 压缩 API 调用耗时 5-30 秒并
// 阻塞其他 SDK 消息，因此当压缩本身接近边界时
// 通常的 60 秒超时不够。
const COMPACTION_TIMEOUT_MS = 180000 // 3 分钟

type UseRemoteSessionProps = {
  config: RemoteSessionConfig | undefined
  setMessages: React.Dispatch<React.SetStateAction<MessageType[]>>
  setIsLoading: (loading: boolean) => void
  onInit?: (slashCommands: string[]) => void
  setToolUseConfirmQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>
  tools: Tool[]
  setStreamingToolUses?: React.Dispatch<
    React.SetStateAction<StreamingToolUse[]>
  >
  setStreamMode?: React.Dispatch<React.SetStateAction<SpinnerMode>>
  setInProgressToolUseIDs?: (f: (prev: Set<string>) => Set<string>) => void
}

type UseRemoteSessionResult = {
  isRemoteMode: boolean
  sendMessage: (
    content: RemoteMessageContent,
    opts?: { uuid?: string },
  ) => Promise<boolean>
  cancelRequest: () => void
  disconnect: () => void
}

/**
 * 用于在 REPL 中管理远程 CCR 会话的 Hook。
 *
 * 处理：
 * - 与 CCR 的 WebSocket 连接
 * - 将 SDK 消息转换为 REPL 消息
 * - 通过 HTTP POST 将用户输入发送到 CCR
 * - 通过现有 ToolUseConfirm 队列的权限请求/响应流程
 */
export function useRemoteSession({
  config,
  setMessages,
  setIsLoading,
  onInit,
  setToolUseConfirmQueue,
  tools,
  setStreamingToolUses,
  setStreamMode,
  setInProgressToolUseIDs,
}: UseRemoteSessionProps): UseRemoteSessionResult {
  const isRemoteMode = !!config

  const setAppState = useSetAppState()
  const setConnStatus = useCallback(
    (s: AppState['remoteConnectionStatus']) =>
      setAppState(prev =>
        prev.remoteConnectionStatus === s
          ? prev
          : { ...prev, remoteConnectionStatus: s },
      ),
    [setAppState],
  )

  // 事件源计数：远程守护子进程中运行的子代理数量。
  // 观察者自身的 AppState.tasks 为空 — 任务在另一个进程中。
  // task_started/task_notification 通过 bridge WS 传达到我们。
  const runningTaskIdsRef = useRef(new Set<string>())
  const writeTaskCount = useCallback(() => {
    const n = runningTaskIdsRef.current.size
    setAppState(prev =>
      prev.remoteBackgroundTaskCount === n
        ? prev
        : { ...prev, remoteBackgroundTaskCount: n },
    )
  }, [setAppState])

  // 用于检测卡住会话的计时器
  const responseTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // 跟踪远程会话是否正在压缩。压缩期间 CLI worker
  // 忙于 API 调用，一段时间内不会发出消息；
  // 使用更长的超时并抑制虚假的"无响应"警告。
  const isCompactingRef = useRef(false)

  const managerRef = useRef<RemoteSessionManager | null>(null)

  // 跟踪是否已更新会话标题（针对无初始提示的会话）
  const hasUpdatedTitleRef = useRef(false)

  // 我们在本地 POST 的用户消息的 UUID — WS 会将它们回显回来，
  // 当 convertUserTextMessages 开启时必须过滤掉，否则观察者
  // 会看到每条输入消息两次（一次来自本地 createUserMessage，一次来自回显）。
  // 单个 POST 可能以相同 uuid 回显多次：服务器可能直接将 POST 广播到
  // /subscribe，并且 worker（cowork desktop / CLI daemon）在其写入路径上再次回显。
  // 首次匹配删除的 Set 会让第二次回显通过 — 使用有界环代替。
  // 上限很宽松：用户不会在回显到达之前输入 50 条消息。
  // 注意：这不会在 attach 时去重 history-vs-live 重叠（没有
  // 从 history UUID 种子填充 set；只有 sendMessage 填充它）。
  const sentUUIDsRef = useRef(new BoundedUUIDSet(50))

  // 保持 tools 的 ref 以便 WebSocket 回调不会过时
  const toolsRef = useRef(tools)
  useEffect(() => {
    toolsRef.current = tools
  }, [tools])

  // 初始化并连接远程会话
  useEffect(() => {
    // 非远程模式则跳过
    if (!config) {
      return
    }

    logForDebugging(
      `[useRemoteSession] Initializing for session ${config.sessionId}`,
    )

    const manager = new RemoteSessionManager(config, {
      onMessage: sdkMessage => {
        const parts = [`type=${sdkMessage.type}`]
        if ('subtype' in sdkMessage)
          parts.push(`subtype=${sdkMessage.subtype as string}`)
        if (sdkMessage.type === 'user') {
          const c = (sdkMessage.message as { content?: unknown } | undefined)
            ?.content
          parts.push(
            `content=${Array.isArray(c) ? c.map(b => b.type).join(',') : typeof c}`,
          )
        }
        logForDebugging(`[useRemoteSession] Received ${parts.join(' ')}`)

        // 收到任何消息时清除响应超时 — 包括我们自己 POST 的 WS
        // 回显，它充当心跳。这必须在回显过滤器之前运行，否则
        // 慢速响应代理（压缩、冷启动）会虚假触发 60 秒无响应警告+重连。
        if (responseTimeoutRef.current) {
          clearTimeout(responseTimeoutRef.current)
          responseTimeoutRef.current = null
        }

        // 回显过滤器：丢弃我们在 POST 之前已在本地添加的用户消息。
        // 服务器和/或 worker 往返会将我们自己的发送以相同 uuid
        // 在 WS 上回显。不要在匹配时删除 — 同一个 uuid 可能回显
        // 多次（服务器广播 + worker 回显），而 BoundedUUIDSet 已通过
        // 其环限制了增长。
        if (
          sdkMessage.type === 'user' &&
          sdkMessage.uuid &&
          sentUUIDsRef.current.has(sdkMessage.uuid as string)
        ) {
          logForDebugging(
            `[useRemoteSession] Dropping echoed user message ${sdkMessage.uuid as string}`,
          )
          return
        }
        // 处理 init 消息 - 提取可用的斜杠命令
        if (
          sdkMessage.type === 'system' &&
          sdkMessage.subtype === 'init' &&
          onInit
        ) {
          const slashCommands = sdkMessage.slash_commands as string[]
          logForDebugging(
            `[useRemoteSession] Init received with ${slashCommands.length} slash commands`,
          )
          onInit(slashCommands)
        }

        // 跟踪远程子代理生命周期，用于"N in background"计数器。
        // 所有任务类型（Agent/teammate/workflow/bash）都通过
        // registerTask() → task_started，并通过 task_notification 完成。
        // 提前返回 — 这些是状态信号，不是可渲染消息。
        if (sdkMessage.type === 'system') {
          if (sdkMessage.subtype === 'task_started') {
            runningTaskIdsRef.current.add(sdkMessage.task_id as string)
            writeTaskCount()
            return
          }
          if (sdkMessage.subtype === 'task_notification') {
            runningTaskIdsRef.current.delete(sdkMessage.task_id as string)
            writeTaskCount()
            return
          }
          if (sdkMessage.subtype === 'task_progress') {
            return
          }
          // 跟踪压缩状态。CLI 在开始时发出 status='compacting'，
          // 完成时 status=null；compact_boundary 也表示完成。
          // 重复的 'compacting' 状态消息（心跳）更新 ref 但不追加到消息。
          if (sdkMessage.subtype === 'status') {
            const wasCompacting = isCompactingRef.current
            isCompactingRef.current = sdkMessage.status === 'compacting'
            if (wasCompacting && isCompactingRef.current) {
              return
            }
          }
          if (sdkMessage.subtype === 'compact_boundary') {
            isCompactingRef.current = false
          }
        }

        // 检查会话是否已结束
        if (isSessionEndMessage(sdkMessage)) {
          isCompactingRef.current = false
          setIsLoading(false)
        }

        // 当 tool_result 到达时清除进行中的 tool_use ID。
        // 必须读取原始 sdkMessage：在非 viewerOnly 模式下，
        // convertSDKMessage 对用户消息返回 {type:'ignored'}，因此转换后
        // 删除永远不会触发。反映下方和 inProcessRunner.ts 的添加位置；
        // 没有此逻辑，该集合在会话生命周期内会无限增长
        //（BQ: CCR 队列显示 RSS 斜率高 5.2 倍）。
        if (setInProgressToolUseIDs && sdkMessage.type === 'user') {
          const content = (
            sdkMessage.message as { content?: unknown } | undefined
          )?.content
          if (Array.isArray(content)) {
            const resultIds: string[] = []
            for (const block of content) {
              if (block.type === 'tool_result') {
                resultIds.push(block.tool_use_id)
              }
            }
            if (resultIds.length > 0) {
              setInProgressToolUseIDs(prev => {
                const next = new Set(prev)
                for (const id of resultIds) next.delete(id)
                return next.size === prev.size ? prev : next
              })
            }
          }
        }

        // 将 SDK 消息转换为 REPL 消息。在 viewerOnly 模式下，
        // 远程代理运行 BriefTool（SendUserMessage）— 其 tool_use 块
        // 渲染为空（userFacingName() === ''），实际内容在 tool_result 中。
        // 因此我们必须转换 tool_results 才能渲染它们。
        const converted = convertSDKMessage(
          sdkMessage,
          config.viewerOnly
            ? { convertToolResults: true, convertUserTextMessages: true }
            : undefined,
        )

        if (converted.type === 'message') {
          // 收到完整消息时，清除流式工具使用
          // 因为完整消息替换了部分流式状态
          setStreamingToolUses?.(prev => (prev.length > 0 ? [] : prev))

          // 将 tool_use 块标记为进行中，这样 UI 显示正确的
          // spinner 状态而不是"Waiting…"（排队）。在本地会话中，
          // toolOrchestration.ts 处理此逻辑，但远程会话接收预构建的
          // 助手消息而不运行本地工具执行。
          if (
            setInProgressToolUseIDs &&
            converted.message.type === 'assistant'
          ) {
            const contentArr = Array.isArray(converted.message.message?.content)
              ? converted.message.message.content
              : []
            const toolUseIds = contentArr
              .filter(block => block.type === 'tool_use')
              .map(block => (block as { id: string }).id)
            if (toolUseIds.length > 0) {
              setInProgressToolUseIDs(prev => {
                const next = new Set(prev)
                for (const id of toolUseIds) {
                  next.add(id)
                }
                return next
              })
            }
          }

          setMessages(prev => [...prev, converted.message])
          // 注意：收到助手消息时不要停止加载 - 代理可能仍在工作
          //（工具使用循环）。加载仅在会话结束或权限请求时停止。
        } else if (converted.type === 'stream_event') {
          // 处理流事件以实时更新 UI
          if (setStreamingToolUses && setStreamMode) {
            handleMessageFromStream(
              converted.event,
              message => setMessages(prev => [...prev, message]),
              () => {
                // 响应长度为空操作 - 远程会话不跟踪此项
              },
              setStreamMode,
              setStreamingToolUses,
            )
          } else {
            logForDebugging(
              `[useRemoteSession] Stream event received but streaming callbacks not provided`,
            )
          }
        }
        // 'ignored' 消息被静默丢弃
      },
      onPermissionRequest: (request, requestId) => {
        logForDebugging(
          `[useRemoteSession] Permission request for tool: ${request.tool_name}`,
        )

        // 按名称查找 Tool 对象，或为未知工具创建 stub
        const tool =
          findToolByName(toolsRef.current, request.tool_name) ??
          createToolStub(request.tool_name)

        const syntheticMessage = createSyntheticAssistantMessage(
          request,
          requestId,
        )

        const permissionResult: PermissionAskDecision = {
          behavior: 'ask',
          message:
            request.description ?? `${request.tool_name} requires permission`,
          suggestions: request.permission_suggestions as PermissionUpdate[],
          blockedPath: request.blocked_path,
        }

        const toolUseConfirm: ToolUseConfirm = {
          assistantMessage: syntheticMessage,
          tool,
          description:
            request.description ?? `${request.tool_name} requires permission`,
          input: request.input,
          toolUseContext: {} as ToolUseConfirm['toolUseContext'],
          toolUseID: request.tool_use_id,
          permissionResult,
          permissionPromptStartTimeMs: Date.now(),
          onUserInteraction() {
            // 远程无操作 — 分类器在容器上运行
          },
          onAbort() {
            const response: RemotePermissionResponse = {
              behavior: 'deny',
              message: 'User aborted',
            }
            manager.respondToPermissionRequest(requestId, response)
            setToolUseConfirmQueue(queue =>
              queue.filter(item => item.toolUseID !== request.tool_use_id),
            )
          },
          onAllow(updatedInput, _permissionUpdates, _feedback) {
            const response: RemotePermissionResponse = {
              behavior: 'allow',
              updatedInput,
            }
            manager.respondToPermissionRequest(requestId, response)
            setToolUseConfirmQueue(queue =>
              queue.filter(item => item.toolUseID !== request.tool_use_id),
            )
            // 批准后恢复加载指示器
            setIsLoading(true)
          },
          onReject(feedback?: string) {
            const response: RemotePermissionResponse = {
              behavior: 'deny',
              message: feedback ?? 'User denied permission',
            }
            manager.respondToPermissionRequest(requestId, response)
            setToolUseConfirmQueue(queue =>
              queue.filter(item => item.toolUseID !== request.tool_use_id),
            )
          },
          async recheckPermission() {
            // 远程无操作 — 权限状态在容器上
          },
        }

        setToolUseConfirmQueue(queue => [...queue, toolUseConfirm])
        // 等待权限时暂停加载指示器
        setIsLoading(false)
      },
      onPermissionCancelled: (requestId, toolUseId) => {
        logForDebugging(
          `[useRemoteSession] Permission request cancelled: ${requestId}`,
        )
        const idToRemove = toolUseId ?? requestId
        setToolUseConfirmQueue(queue =>
          queue.filter(item => item.toolUseID !== idToRemove),
        )
        setIsLoading(true)
      },
      onConnected: () => {
        logForDebugging('[useRemoteSession] Connected')
        setConnStatus('connected')
      },
      onReconnecting: () => {
        logForDebugging('[useRemoteSession] Reconnecting')
        setConnStatus('reconnecting')
        // WS 间隙 = 可能错过 task_notification 事件。清空而不是永远偏高。
        // 少计跨越间隙的任务；可接受。
        runningTaskIdsRef.current.clear()
        writeTaskCount()
        // tool_use ID 同理：间隙期间错过的 tool_result 会
        // 让过时的 spinner 状态永远保留。
        setInProgressToolUseIDs?.(prev => (prev.size > 0 ? new Set() : prev))
      },
      onDisconnected: () => {
        logForDebugging('[useRemoteSession] Disconnected')
        setConnStatus('disconnected')
        setIsLoading(false)
        runningTaskIdsRef.current.clear()
        writeTaskCount()
        setInProgressToolUseIDs?.(prev => (prev.size > 0 ? new Set() : prev))
      },
      onError: error => {
        logForDebugging(`[useRemoteSession] Error: ${error.message}`)
      },
    })

    managerRef.current = manager
    manager.connect()

    return () => {
      logForDebugging('[useRemoteSession] Cleanup - disconnecting')
      // 清除任何待处理的超时
      if (responseTimeoutRef.current) {
        clearTimeout(responseTimeoutRef.current)
        responseTimeoutRef.current = null
      }
      manager.disconnect()
      managerRef.current = null
    }
  }, [
    config,
    setMessages,
    setIsLoading,
    onInit,
    setToolUseConfirmQueue,
    setStreamingToolUses,
    setStreamMode,
    setInProgressToolUseIDs,
    setConnStatus,
    writeTaskCount,
  ])

  // 向远程会话发送用户消息
  const sendMessage = useCallback(
    async (
      content: RemoteMessageContent,
      opts?: { uuid?: string },
    ): Promise<boolean> => {
      const manager = managerRef.current
      if (!manager) {
        logForDebugging('[useRemoteSession] Cannot send - no manager')
        return false
      }

      // 清除任何现有超时
      if (responseTimeoutRef.current) {
        clearTimeout(responseTimeoutRef.current)
      }

      setIsLoading(true)

      // 跟踪本地添加的消息 UUID，以便过滤 WS 回显。
      // 必须在 POST 之前记录，以关闭回显在 POST promise
      // 解析之前到达的竞态。
      if (opts?.uuid) sentUUIDsRef.current.add(opts.uuid)

      const success = await manager.sendMessage(content, opts)

      if (!success) {
        // 无需撤销 POST 前的添加 — BoundedUUIDSet 的环会逐出它。
        setIsLoading(false)
        return false
      }

      // 当未提供初始提示时，在第一条消息后更新会话标题。
      // 这为 claude.ai 上的会话提供有意义的标题，而不是"Background task"。
      // 在 viewerOnly 模式下跳过 — 远程代理拥有会话标题。
      if (
        !hasUpdatedTitleRef.current &&
        config &&
        !config.hasInitialPrompt &&
        !config.viewerOnly
      ) {
        hasUpdatedTitleRef.current = true
        const sessionId = config.sessionId
        // 从内容中提取纯文本（可能是字符串或内容块数组）
        const description =
          typeof content === 'string'
            ? content
            : extractTextContent(content, ' ')
        if (description) {
          // generateSessionTitle 永远不会 reject（用 try/catch 包装 body，
          // 失败时返回 null），因此此链无需 .catch。
          void generateSessionTitle(
            description,
            new AbortController().signal,
          ).then(title => {
            void updateSessionTitle(
              sessionId,
              title ?? truncateToWidth(description, 75),
            )
          })
        }
      }

      // 启动超时以检测卡住的会话。在 viewerOnly 模式下跳过 —
      // 远程代理可能已空闲关闭，需要 >60 秒才能重新唤醒。
      // 当远程会话压缩时使用更长的超时，因为
      // CLI worker 忙于 API 调用，不会发出消息。
      if (!config?.viewerOnly) {
        const timeoutMs = isCompactingRef.current
          ? COMPACTION_TIMEOUT_MS
          : RESPONSE_TIMEOUT_MS
        responseTimeoutRef.current = setTimeout(
          (setMessages, manager) => {
            logForDebugging(
              '[useRemoteSession] Response timeout - attempting reconnect',
            )
            // 向对话添加警告消息
            const warningMessage = createSystemMessage(
              'Remote session may be unresponsive. Attempting to reconnect…',
              'warning',
            )
            setMessages(prev => [...prev, warningMessage])

            // 尝试重新连接 WebSocket - 订阅可能已变得过时
            manager.reconnect()
          },
          timeoutMs,
          setMessages,
          manager,
        )
      }

      return success
    },
    [config, setIsLoading, setMessages],
  )

  // 取消远程会话上的当前请求
  const cancelRequest = useCallback(() => {
    // 清除任何待处理的超时
    if (responseTimeoutRef.current) {
      clearTimeout(responseTimeoutRef.current)
      responseTimeoutRef.current = null
    }

    // 向 CCR 发送中断信号。在 viewerOnly 模式下跳过 —
    // Ctrl+C 绝不应中断远程代理。
    if (!config?.viewerOnly) {
      managerRef.current?.cancelSession()
    }

    setIsLoading(false)
  }, [config, setIsLoading])

  // 从会话断开连接
  const disconnect = useCallback(() => {
    // 清除任何待处理的超时
    if (responseTimeoutRef.current) {
      clearTimeout(responseTimeoutRef.current)
      responseTimeoutRef.current = null
    }
    managerRef.current?.disconnect()
    managerRef.current = null
  }, [])

  // 所有四个字段都已稳定（布尔值由会话期间不变的 prop 派生，
  // 三个 useCallback 具有稳定依赖）。结果对象被 REPL 的
  // onSubmit useCallback 依赖使用 — 没有 useMemo，
  // 每次 REPL 渲染时新的字面量都会使 onSubmit 失效，
  // 进而扰动 PromptInput 的 props 和下游记忆化。
  return useMemo(
    () => ({ isRemoteMode, sendMessage, cancelRequest, disconnect }),
    [isRemoteMode, sendMessage, cancelRequest, disconnect],
  )
}
