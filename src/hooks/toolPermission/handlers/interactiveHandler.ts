import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomUUID } from 'crypto'
import { CHANNEL_TAG } from 'src/constants/xml.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getAllowedChannels } from '../../../bootstrap/state.js'
import type { BridgePermissionCallbacks } from '../../../bridge/bridgePermissionCallbacks.js'
import type { ToolUseConfirm } from '../../../components/permissions/PermissionRequest.js'
import { getTerminalFocused } from '@anthropic/ink'
import {
  CHANNEL_PERMISSION_REQUEST_METHOD,
  type ChannelPermissionRequestParams,
  findChannelEntry,
} from '../../../services/mcp/channelNotification.js'
import type { ChannelPermissionCallbacks } from '../../../services/mcp/channelPermissions.js'
import {
  filterPermissionRelayClients,
  shortRequestId,
  truncateForPreview,
} from '../../../services/mcp/channelPermissions.js'
import { executeAsyncClassifierCheck } from '@claude-code-best/builtin-tools/tools/BashTool/bashPermissions.js'
import { BASH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BashTool/toolName.js'
import {
  clearClassifierChecking,
  setClassifierApproval,
  setClassifierChecking,
  setYoloClassifierApproval,
} from '../../../utils/classifierApprovals.js'
import { errorMessage } from '../../../utils/errors.js'
import {
  forgetPipePermissionRequest,
  notifyPipePermissionCancel,
  tryRelayPipePermissionRequest,
} from '../../../utils/pipePermissionRelay.js'
import type { PermissionDecision } from '../../../utils/permissions/PermissionResult.js'
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js'
import { hasPermissionsToUseTool } from '../../../utils/permissions/permissions.js'
import type { PermissionContext } from '../PermissionContext.js'
import { createResolveOnce } from '../PermissionContext.js'

type InteractivePermissionParams = {
  ctx: PermissionContext
  description: string
  result: PermissionDecision & { behavior: 'ask' }
  awaitAutomatedChecksBeforeDialog: boolean | undefined
  bridgeCallbacks?: BridgePermissionCallbacks
  channelCallbacks?: ChannelPermissionCallbacks
}

type ChannelContextHint = {
  sourceServer?: string
  chatId?: string
}

function getTextBlocksText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map(block => block.text)
    .join('\n')
}

function parseChannelContextHintFromText(
  text: string,
): ChannelContextHint | null {
  const tagMatch = text.match(new RegExp(`<${CHANNEL_TAG}\\b([^>]*)>`))
  if (!tagMatch?.[1]) {
    return null
  }

  const attrs = tagMatch[1]
  const sourceServer = attrs.match(/\bsource="([^"]+)"/)?.[1]
  const chatId = attrs.match(/\bchat_id="([^"]+)"/)?.[1]

  if (!sourceServer && !chatId) {
    return null
  }

  return { sourceServer, chatId }
}

export function getLatestChannelContextHint(
  messages: readonly unknown[],
): ChannelContextHint | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as {
      type?: unknown
      origin?: { kind?: unknown; server?: unknown }
      message?: { content?: unknown }
    }

    if (message?.type !== 'user' || message?.origin?.kind !== 'channel') {
      continue
    }

    const text = getTextBlocksText(message.message?.content)
    const parsed = parseChannelContextHintFromText(text)
    if (parsed) {
      return {
        sourceServer:
          parsed.sourceServer ||
          (typeof message.origin.server === 'string'
            ? message.origin.server
            : undefined),
        chatId: parsed.chatId,
      }
    }
  }

  return null
}

/**
 * 处理交互式（主 agent）权限流程。
 *
 * 将一个 ToolUseConfirm 条目推送到确认队列中，带回调：
 * onAbort、onAllow、onReject、recheckPermission、onUserInteraction。
 *
 * 在后台异步运行权限 hooks 和 bash 分类器检查，
 * 与用户交互竞争。使用 resolve-once 守卫和 `userInteracted`
 * 标志以防止多次解决。
 *
 * 此函数不返回 Promise —— 它设置回调，
 * 最终调用 `resolve()` 来解决调用方拥有的外部 promise。
 */
function handleInteractivePermission(
  params: InteractivePermissionParams,
  resolve: (decision: PermissionDecision) => void,
): void {
  const {
    ctx,
    description,
    result,
    awaitAutomatedChecksBeforeDialog,
    bridgeCallbacks,
    channelCallbacks,
  } = params

  const { resolve: resolveOnce, isResolved, claim } = createResolveOnce(resolve)
  let userInteracted = false
  let checkmarkTransitionTimer: ReturnType<typeof setTimeout> | undefined
  // 提前声明以便 onDismissCheckmark（checkmark 窗口期间按 Esc）也能
  // 移除 abort 监听器 —— 而不只是定时器回调。
  let checkmarkAbortHandler: (() => void) | undefined
  const bridgeRequestId = bridgeCallbacks ? randomUUID() : undefined
  // 提前声明以便 local/hook/classifier 获胜时可以移除待处理的 channel
  // 条目。没有"通知远端取消"的等价物 —— 文本就在你的
  // 手机上，local-resolve 之后过期的"yes abc123"会穿过
  // tryConsumeReply（条目已删除）并被作为普通聊天入队。
  let channelUnsubscribe: (() => void) | undefined

  const permissionPromptStartTimeMs = Date.now()
  const displayInput = result.updatedInput ?? ctx.input
  let pipePermissionRequestId: string | null = null

  function forgetPipePermission(reason?: string): void {
    notifyPipePermissionCancel(pipePermissionRequestId, reason)
    forgetPipePermissionRequest(pipePermissionRequestId)
    pipePermissionRequestId = null
  }

  function forgetPipePermissionSilently(): void {
    forgetPipePermissionRequest(pipePermissionRequestId)
    pipePermissionRequestId = null
  }

  function clearClassifierIndicator(): void {
    if (feature('BASH_CLASSIFIER')) {
      ctx.updateQueueItem({ classifierCheckInProgress: false })
    }
  }

  const toolUseConfirm: ToolUseConfirm = {
    assistantMessage: ctx.assistantMessage,
    tool: ctx.tool,
    description,
    input: displayInput,
    toolUseContext: ctx.toolUseContext,
    toolUseID: ctx.toolUseID,
    permissionResult: result,
    permissionPromptStartTimeMs,
    ...(feature('BASH_CLASSIFIER')
      ? {
          classifierCheckInProgress:
            !!result.pendingClassifierCheck &&
            !awaitAutomatedChecksBeforeDialog,
        }
      : {}),
    onUserInteraction() {
      // 当用户开始与权限对话框交互时被调用
      // （例如方向键、Tab、输入反馈）
      // 隐藏分类器指示器，因为自动批准已不可能
      //
      // 宽限期：忽略前 200ms 内的交互以防止
      // 意外按键过早取消分类器
      const GRACE_PERIOD_MS = 200
      if (Date.now() - permissionPromptStartTimeMs < GRACE_PERIOD_MS) {
        return
      }
      userInteracted = true
      clearClassifierChecking(ctx.toolUseID)
      clearClassifierIndicator()
    },
    onDismissCheckmark() {
      if (checkmarkTransitionTimer) {
        clearTimeout(checkmarkTransitionTimer)
        checkmarkTransitionTimer = undefined
        if (checkmarkAbortHandler) {
          ctx.toolUseContext.abortController.signal.removeEventListener(
            'abort',
            checkmarkAbortHandler,
          )
          checkmarkAbortHandler = undefined
        }
        ctx.removeFromQueue()
      }
    },
    onAbort() {
      if (!claim()) return
      forgetPipePermission('Permission request was aborted locally in sub.')
      if (bridgeCallbacks && bridgeRequestId) {
        bridgeCallbacks.sendResponse(bridgeRequestId, {
          behavior: 'deny',
          message: 'User aborted',
        })
        bridgeCallbacks.cancelRequest(bridgeRequestId)
      }
      channelUnsubscribe?.()
      ctx.logCancelled()
      ctx.logDecision(
        { decision: 'reject', source: { type: 'user_abort' } },
        { permissionPromptStartTimeMs },
      )
      resolveOnce(ctx.cancelAndAbort(undefined, true))
    },
    async onAllow(
      updatedInput,
      permissionUpdates: PermissionUpdate[],
      feedback?: string,
      contentBlocks?: ContentBlockParam[],
    ) {
      if (!claim()) return // atomic check-and-mark before await
      forgetPipePermission('Permission request was approved locally in sub.')

      if (bridgeCallbacks && bridgeRequestId) {
        bridgeCallbacks.sendResponse(bridgeRequestId, {
          behavior: 'allow',
          updatedInput,
          updatedPermissions: permissionUpdates,
        })
        bridgeCallbacks.cancelRequest(bridgeRequestId)
      }
      channelUnsubscribe?.()

      resolveOnce(
        await ctx.handleUserAllow(
          updatedInput,
          permissionUpdates,
          feedback,
          permissionPromptStartTimeMs,
          contentBlocks,
          result.decisionReason,
        ),
      )
    },
    onReject(feedback?: string, contentBlocks?: ContentBlockParam[]) {
      if (!claim()) return
      forgetPipePermission('Permission request was rejected locally in sub.')

      if (bridgeCallbacks && bridgeRequestId) {
        bridgeCallbacks.sendResponse(bridgeRequestId, {
          behavior: 'deny',
          message: feedback ?? 'User denied permission',
        })
        bridgeCallbacks.cancelRequest(bridgeRequestId)
      }
      channelUnsubscribe?.()

      ctx.logDecision(
        {
          decision: 'reject',
          source: { type: 'user_reject', hasFeedback: !!feedback },
        },
        { permissionPromptStartTimeMs },
      )
      resolveOnce(ctx.cancelAndAbort(feedback, undefined, contentBlocks))
    },
    async recheckPermission() {
      if (isResolved()) return
      const freshResult = await hasPermissionsToUseTool(
        ctx.tool,
        ctx.input,
        ctx.toolUseContext,
        ctx.assistantMessage,
        ctx.toolUseID,
      )
      if (freshResult.behavior === 'allow') {
        // claim()（原子检查并标记），不是 isResolved() —— 上方的异步
        // hasPermissionsToUseTool 调用打开了一个窗口，其中 CCR
        // 可能已经在飞行中响应。匹配 onAllow/onReject/hook
        // 路径。cancelRequest 通知 CCR 关闭其提示 —— 没有
        // 它，web UI 会为已经执行的工具显示陈旧的提示
        // （在 recheck 由 CCR 发起的模式切换触发时尤其明显，
        // 这正是 useReplBridge 开始调用它后此回调存在的
        // 场景）。
        if (!claim()) return
        forgetPipePermission('Permission request was resolved locally in sub.')
        if (bridgeCallbacks && bridgeRequestId) {
          bridgeCallbacks.cancelRequest(bridgeRequestId)
        }
        channelUnsubscribe?.()
        ctx.removeFromQueue()
        ctx.logDecision({ decision: 'accept', source: 'config' })
        resolveOnce(ctx.buildAllow(freshResult.updatedInput ?? ctx.input))
      }
    },
  }

  ctx.pushToQueue(toolUseConfirm)
  pipePermissionRequestId = tryRelayPipePermissionRequest(
    toolUseConfirm,
    response => {
      if (!claim()) return
      forgetPipePermissionSilently()
      clearClassifierChecking(ctx.toolUseID)
      clearClassifierIndicator()
      ctx.removeFromQueue()
      channelUnsubscribe?.()
      if (bridgeCallbacks && bridgeRequestId) {
        bridgeCallbacks.cancelRequest(bridgeRequestId)
      }

      if (response.behavior === 'allow') {
        void (async () => {
          if (response.permissionUpdates?.length) {
            void ctx.persistPermissions(response.permissionUpdates)
          }
          ctx.logDecision(
            {
              decision: 'accept',
              source: {
                type: 'user',
                permanent: !!response.permissionUpdates?.length,
              },
            },
            { permissionPromptStartTimeMs },
          )
          resolveOnce(
            ctx.buildAllow(response.updatedInput ?? displayInput, {
              acceptFeedback: response.feedback,
              contentBlocks: response.contentBlocks,
            }),
          )
        })()
      } else {
        ctx.logDecision(
          {
            decision: 'reject',
            source: {
              type: 'user_reject',
              hasFeedback: !!response.feedback,
            },
          },
          { permissionPromptStartTimeMs },
        )
        resolveOnce(
          ctx.cancelAndAbort(
            response.feedback,
            undefined,
            response.contentBlocks,
          ),
        )
      }
    },
  )

  // Race 4：来自 CCR（claude.ai）的 bridge 权限响应
  // 当 bridge 已连接时，发送权限请求到 CCR 并
  // 订阅响应。哪一方（CLI 或 CCR）先响应
  // 就通过 claim() 获胜。
  //
  // 所有工具都被转发 —— CCR 的通用允许/拒绝弹窗处理任何
  // 工具，并且可以返回 `updatedInput`（当它有专用渲染器时，
  // 例如 plan edit）。本地对话框注入字段（ReviewArtifact
  // `selected`、AskUserQuestion `answers`）的工具容忍字段缺失，
  // 以便通用远端批准优雅降级而不是抛出异常。
  if (bridgeCallbacks && bridgeRequestId) {
    bridgeCallbacks.sendRequest(
      bridgeRequestId,
      ctx.tool.name,
      displayInput,
      ctx.toolUseID,
      description,
      result.suggestions,
      result.blockedPath,
    )

    const signal = ctx.toolUseContext.abortController.signal
    const unsubscribe = bridgeCallbacks.onResponse(
      bridgeRequestId,
      response => {
        if (!claim()) return // Local user/hook/classifier already responded
        forgetPipePermission(
          'Permission request was resolved by bridge before pipe response.',
        )
        signal.removeEventListener('abort', unsubscribe)
        clearClassifierChecking(ctx.toolUseID)
        clearClassifierIndicator()
        ctx.removeFromQueue()
        channelUnsubscribe?.()

        if (response.behavior === 'allow') {
          if (response.updatedPermissions?.length) {
            void ctx.persistPermissions(response.updatedPermissions)
          }
          ctx.logDecision(
            {
              decision: 'accept',
              source: {
                type: 'user',
                permanent: !!response.updatedPermissions?.length,
              },
            },
            { permissionPromptStartTimeMs },
          )
          resolveOnce(ctx.buildAllow(response.updatedInput ?? displayInput))
        } else {
          ctx.logDecision(
            {
              decision: 'reject',
              source: {
                type: 'user_reject',
                hasFeedback: !!response.message,
              },
            },
            { permissionPromptStartTimeMs },
          )
          resolveOnce(ctx.cancelAndAbort(response.message))
        }
      },
    )

    signal.addEventListener('abort', unsubscribe, { once: true })
  }

  // Channel 权限中继 —— 与上方的 bridge 块并行竞争。通过每个
  // 活跃 channel（Telegram、iMessage 等）的 MCP send_message 工具
  // 发送权限提示，然后将回复与 local/bridge/hook/classifier 竞争。
  // 入站的"yes abc123"在通知处理程序（useManageMCPConnections.ts）
  // 中在入队之前被拦截，所以它永远不会作为对话轮次
  // 到达 Claude。
  //
  // 与 bridge 块不同，这仍然守卫 `requiresUserInteraction` ——
  // channel 回复是纯 yes/no，没有 `updatedInput` 路径。实际上
  // 今天这个守卫是死代码：所有三个 `requiresUserInteraction` 工具
  //（ExitPlanMode、AskUserQuestion、ReviewArtifact）在配置了
  // channel 时返回 `isEnabled()===false`，所以它们永远到达不了此处理程序。
  //
  // 即发即弃发送：如果 callTool 失败（channel 宕机、工具缺失），
  // 订阅永远不会触发，另一个竞争者获胜。优雅降级
  // —— 本地对话框始终作为底线存在。
  if (
    (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
    channelCallbacks &&
    !ctx.tool.requiresUserInteraction?.()
  ) {
    const channelRequestId = shortRequestId(ctx.toolUseID)
    const allowedChannels = getAllowedChannels()
    const channelClients = filterPermissionRelayClients(
      ctx.toolUseContext.getAppState().mcp.clients,
      name => findChannelEntry(name, allowedChannels) !== undefined,
    )

    if (channelClients.length > 0) {
      // 出站也是结构化的（Kenneth 的对称性要求）—— 服务器拥有
      // 其平台的消息格式化（Telegram markdown、iMessage
      // 富文本、Discord embed）。CC 发送 RAW 部分；服务器组合。
      // 旧的 callTool('send_message', {text,content,message}) 三键
      // hack 已消失 —— 不再需要猜测每个插件接受哪个参数名。
      const params: ChannelPermissionRequestParams = {
        request_id: channelRequestId,
        tool_name: ctx.tool.name,
        description,
        input_preview: truncateForPreview(displayInput),
      }
      const channelContext = getLatestChannelContextHint(
        ctx.toolUseContext.messages,
      )
      if (channelContext?.sourceServer || channelContext?.chatId) {
        params.channel_context = {
          ...(channelContext.sourceServer && {
            source_server: channelContext.sourceServer,
          }),
          ...(channelContext.chatId && { chat_id: channelContext.chatId }),
        }
      }

      for (const client of channelClients) {
        if (client.type !== 'connected') continue // refine for TS
        void client.client
          .notification({
            method: CHANNEL_PERMISSION_REQUEST_METHOD,
            params,
          })
          .catch(e => {
            logForDebugging(
              `Channel permission_request failed for ${client.name}: ${errorMessage(e)}`,
              { level: 'error' },
            )
          })
      }

      const channelSignal = ctx.toolUseContext.abortController.signal
      // 包装以便 map 删除和 abort 监听器拆除都在
      // 每个调用点发生。local/hook/classifier 获胜后的 6 个
      // channelUnsubscribe?.() 调用点之前只删除了 map 条目 ——
      // 死闭包仍然注册在 session 范围的 abort 信号上，
      // 直到会话结束。这不是功能性 bug（Map.delete 是
      // 幂等的），但它让闭包保持存活。
      const mapUnsub = channelCallbacks.onResponse(
        channelRequestId,
        response => {
          if (!claim()) return // 另一个竞争者获胜
          forgetPipePermission(
            'Permission request was resolved by channel before pipe response.',
          )
          channelUnsubscribe?.() // 两者都做：map 删除 + 监听器移除
          clearClassifierChecking(ctx.toolUseID)
          clearClassifierIndicator()
          ctx.removeFromQueue()
          // Bridge 是另一个远端 —— 通知它我们已完成。
          if (bridgeCallbacks && bridgeRequestId) {
            bridgeCallbacks.cancelRequest(bridgeRequestId)
          }

          if (response.behavior === 'allow') {
            ctx.logDecision(
              {
                decision: 'accept',
                source: { type: 'user', permanent: false },
              },
              { permissionPromptStartTimeMs },
            )
            resolveOnce(ctx.buildAllow(displayInput))
          } else {
            ctx.logDecision(
              {
                decision: 'reject',
                source: { type: 'user_reject', hasFeedback: false },
              },
              { permissionPromptStartTimeMs },
            )
            resolveOnce(
              ctx.cancelAndAbort(`Denied via channel ${response.fromServer}`),
            )
          }
        },
      )
      channelUnsubscribe = () => {
        mapUnsub()
        channelSignal.removeEventListener('abort', channelUnsubscribe!)
      }

      channelSignal.addEventListener('abort', channelUnsubscribe, {
        once: true,
      })
    }
  }

  // 如果 hooks 已在上方的协调器分支中等待完成则跳过
  if (!awaitAutomatedChecksBeforeDialog) {
    // 异步执行 PermissionRequest hooks
    // 如果 hook 在用户响应前返回决定，则应用它
    void (async () => {
      if (isResolved()) return
      const currentAppState = ctx.toolUseContext.getAppState()
      const hookDecision = await ctx.runHooks(
        currentAppState.toolPermissionContext.mode,
        result.suggestions,
        result.updatedInput,
        permissionPromptStartTimeMs,
      )
      if (!hookDecision || !claim()) return
      forgetPipePermission(
        'Permission request was resolved by hook before pipe response.',
      )
      if (bridgeCallbacks && bridgeRequestId) {
        bridgeCallbacks.cancelRequest(bridgeRequestId)
      }
      channelUnsubscribe?.()
      ctx.removeFromQueue()
      resolveOnce(hookDecision)
    })()
  }

  // 异步执行 bash 分类器检查（如果适用）
  if (
    feature('BASH_CLASSIFIER') &&
    result.pendingClassifierCheck &&
    ctx.tool.name === BASH_TOOL_NAME &&
    !awaitAutomatedChecksBeforeDialog
  ) {
    // "分类器运行中"的 UI 指示器 —— 在此处设置（而不是在
    // toolExecution.ts 中），以便通过前缀规则自动允许的命令
    // 不会在 allow 返回前闪现指示器一瞬间。
    setClassifierChecking(ctx.toolUseID)
    void executeAsyncClassifierCheck(
      result.pendingClassifierCheck,
      ctx.toolUseContext.abortController.signal,
      ctx.toolUseContext.options.isNonInteractiveSession,
      {
        shouldContinue: () => !isResolved() && !userInteracted,
        onComplete: () => {
          clearClassifierChecking(ctx.toolUseID)
          clearClassifierIndicator()
        },
        onAllow: decisionReason => {
          if (!claim()) return
          forgetPipePermission(
            'Permission request was auto-approved before pipe response.',
          )
          if (bridgeCallbacks && bridgeRequestId) {
            bridgeCallbacks.cancelRequest(bridgeRequestId)
          }
          channelUnsubscribe?.()
          clearClassifierChecking(ctx.toolUseID)

          const matchedRule =
            decisionReason.type === 'classifier'
              ? (decisionReason.reason.match(
                  /^Allowed by prompt rule: "(.+)"$/,
                )?.[1] ?? decisionReason.reason)
              : undefined

          // 显示自动批准的过渡效果（选项变暗）
          if (feature('TRANSCRIPT_CLASSIFIER')) {
            ctx.updateQueueItem({
              classifierCheckInProgress: false,
              classifierAutoApproved: true,
              classifierMatchedRule: matchedRule,
            })
          }

          if (
            feature('TRANSCRIPT_CLASSIFIER') &&
            decisionReason.type === 'classifier'
          ) {
            if (decisionReason.classifier === 'auto-mode') {
              setYoloClassifierApproval(ctx.toolUseID, decisionReason.reason)
            } else if (matchedRule) {
              setClassifierApproval(ctx.toolUseID, matchedRule)
            }
          }

          ctx.logDecision(
            { decision: 'accept', source: { type: 'classifier' } },
            { permissionPromptStartTimeMs },
          )
          resolveOnce(ctx.buildAllow(ctx.input, { decisionReason }))

          // 保持 checkmark 可见，然后移除对话框。
          // 如果终端获得焦点为 3s（用户可以看到），否则为 1s。
          // 用户可以通过 onDismissCheckmark 提前按 Esc 关闭。
          const signal = ctx.toolUseContext.abortController.signal
          checkmarkAbortHandler = () => {
            if (checkmarkTransitionTimer) {
              clearTimeout(checkmarkTransitionTimer)
              checkmarkTransitionTimer = undefined
              // 兄弟 Bash 错误可以触发这个（StreamingToolExecutor
              // 通过 siblingAbortController 级联）—— 必须丢弃
              // 装饰性的 ✓ 对话框，否则它会阻塞下一个排队项。
              ctx.removeFromQueue()
            }
          }
          const checkmarkMs = getTerminalFocused() ? 3000 : 1000
          checkmarkTransitionTimer = setTimeout(() => {
            checkmarkTransitionTimer = undefined
            if (checkmarkAbortHandler) {
              signal.removeEventListener('abort', checkmarkAbortHandler)
              checkmarkAbortHandler = undefined
            }
            ctx.removeFromQueue()
          }, checkmarkMs)
          signal.addEventListener('abort', checkmarkAbortHandler, {
            once: true,
          })
        },
      },
    ).catch(error => {
      // 记录分类器 API 错误以便调试，但不要将它们作为中断传播
      // 这些错误可能是网络故障、速率限制或模型问题 —— 不是用户取消
      logForDebugging(`Async classifier check failed: ${errorMessage(error)}`, {
        level: 'error',
      })
    })
  }
}

// --

export { handleInteractivePermission }
export type { InteractivePermissionParams }
