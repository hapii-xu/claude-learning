import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import { relative } from 'path'
import { getCwd } from 'src/utils/cwd.js'
import { addInvokedSkill } from '../bootstrap/state.js'
import { asSessionId } from '../types/ids.js'
import type {
  AttributionSnapshotMessage,
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
  LogOption,
  PersistedWorktreeSession,
  SerializedMessage,
} from '../types/logs.js'
import type {
  Message,
  NormalizedMessage,
  NormalizedUserMessage,
} from '../types/message.js'
import { PERMISSION_MODES } from '../types/permissions.js'
import {
  suppressNextSkillDiscovery,
  suppressNextSkillListing,
} from './attachments.js'
import {
  copyFileHistoryForResume,
  type FileHistorySnapshot,
} from './fileHistory.js'
import { logError } from './log.js'
import {
  createAssistantMessage,
  createUserMessage,
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
  isToolUseResultMessage,
  NO_RESPONSE_REQUESTED,
  normalizeMessages,
} from './messages.js'
import { copyPlanForResume } from './plans.js'
import { processSessionStartHooks } from './sessionStart.js'
import {
  buildConversationChain,
  checkResumeConsistency,
  getLastSessionLog,
  getSessionIdFromLog,
  isLiteLog,
  loadFullLog,
  loadMessageLogs,
  loadTranscriptFile,
  removeExtraFields,
} from './sessionStorage.js'
import type { ContentReplacementRecord } from './toolResultStorage.js'

// 死代码消除：ant-only 工具名称被条件 require，以便其字符串
// 不会泄漏到外部构建中。静态导入始终打包。
/* eslint-disable @typescript-eslint/no-require-imports */
const BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('@claude-code-best/builtin-tools/tools/BriefTool/prompt.js') as typeof import('@claude-code-best/builtin-tools/tools/BriefTool/prompt.js')
      ).BRIEF_TOOL_NAME
    : null
const LEGACY_BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('@claude-code-best/builtin-tools/tools/BriefTool/prompt.js') as typeof import('@claude-code-best/builtin-tools/tools/BriefTool/prompt.js')
      ).LEGACY_BRIEF_TOOL_NAME
    : null
const SEND_USER_FILE_TOOL_NAME: string | null = feature('KAIROS')
  ? (
      require('@claude-code-best/builtin-tools/tools/SendUserFileTool/prompt.js') as typeof import('@claude-code-best/builtin-tools/tools/SendUserFileTool/prompt.js')
    ).SEND_USER_FILE_TOOL_NAME
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 将旧版附件类型转换为当前类型以保持向后兼容
 */
function migrateLegacyAttachmentTypes(message: Message): Message {
  if (message.type !== 'attachment') {
    return message
  }

  const attachment = message.attachment as {
    type: string
    [key: string]: unknown
  } // 处理不在当前类型系统中的旧版类型

  // 转换旧版附件类型
  if (attachment.type === 'new_file') {
    return {
      ...message,
      attachment: {
        ...attachment,
        type: 'file',
        displayPath: relative(getCwd(), attachment.filename as string),
      },
    } as unknown as SerializedMessage // 断言整个消息，因为我们知道结构正确
  }

  if (attachment.type === 'new_directory') {
    return {
      ...message,
      attachment: {
        ...attachment,
        type: 'directory',
        displayPath: relative(getCwd(), attachment.path as string),
      },
    } as unknown as SerializedMessage // 断言整个消息，因为我们知道结构正确
  }

  // 为旧会话的附件补充 displayPath
  if (!('displayPath' in attachment)) {
    const path =
      'filename' in attachment
        ? (attachment.filename as string)
        : 'path' in attachment
          ? (attachment.path as string)
          : 'skillDir' in attachment
            ? (attachment.skillDir as string)
            : undefined
    if (path) {
      return {
        ...message,
        attachment: {
          ...attachment,
          displayPath: relative(getCwd(), path),
        },
      } as unknown as Message
    }
  }

  return message
}

export type TeleportRemoteResponse = {
  log: Message[]
  branch?: string
}

export type TurnInterruptionState =
  | { kind: 'none' }
  | { kind: 'interrupted_prompt'; message: NormalizedUserMessage }

export type DeserializeResult = {
  messages: Message[]
  turnInterruptionState: TurnInterruptionState
}

/**
 * 将日志文件中的消息反序列化为 REPL 期望的格式。
 * 过滤未解决的工具调用、孤立的思考消息，并在最后一条
 * 消息来自用户时附加合成的助手哨兵消息。
 * @internal 导出用于测试 - 请使用 loadConversationForResume
 */
export function deserializeMessages(serializedMessages: Message[]): Message[] {
  return deserializeMessagesWithInterruptDetection(serializedMessages).messages
}

/**
 * 与 deserializeMessages 类似，但还检测会话是否在轮次中途
 * 被中断。由 SDK resume 路径使用，以在网关触发的重启后
 * 自动继续被中断的轮次。
 * @internal 导出用于测试
 */
export function deserializeMessagesWithInterruptDetection(
  serializedMessages: Message[],
): DeserializeResult {
  try {
    // 在处理前转换旧版附件类型
    const migratedMessages = serializedMessages.map(
      migrateLegacyAttachmentTypes,
    )

    // 从反序列化的用户消息中剥离无效的 permissionMode 值。
    // 该字段是磁盘上未验证的 JSON，可能包含来自不同构建的模式。
    const validModes = new Set<string>(PERMISSION_MODES)
    for (const msg of migratedMessages) {
      if (
        msg.type === 'user' &&
        msg.permissionMode !== undefined &&
        !validModes.has(msg.permissionMode as string)
      ) {
        msg.permissionMode = undefined
      }
    }

    // 过滤未解决的工具调用及其后的任何合成消息
    const filteredToolUses = filterUnresolvedToolUses(
      migratedMessages,
    ) as NormalizedMessage[]

    // 过滤仅包含思考的孤立助手消息，这些消息会在 resume 期间
    // 导致 API 错误。当流式处理为每个内容块生成单独消息且
    // 交错的用消息阻止通过 message.id 正确合并时会发生这种情况。
    const filteredThinking = filterOrphanedThinkingOnlyMessages(
      filteredToolUses,
    ) as NormalizedMessage[]

    // 过滤仅包含空白文本内容的助手消息。
    // 当模型在思考前输出 "\n\n" 且用户取消流式传输时可能发生。
    const filteredMessages = filterWhitespaceOnlyAssistantMessages(
      filteredThinking,
    ) as NormalizedMessage[]

    const internalState = detectTurnInterruption(filteredMessages)

    // 通过附加合成继续消息将轮次中途断转换为 interrupted_prompt。
    // 这统一了两种中断类型，使消费者只需处理 interrupted_prompt。
    let turnInterruptionState: TurnInterruptionState
    if (internalState.kind === 'interrupted_turn') {
      const [continuationMessage] = normalizeMessages([
        createUserMessage({
          content: 'Continue from where you left off.',
          isMeta: true,
        }),
      ])
      filteredMessages.push(continuationMessage!)
      turnInterruptionState = {
        kind: 'interrupted_prompt',
        message: continuationMessage!,
      }
    } else {
      turnInterruptionState = internalState
    }

    // 在最后一条用户消息后附加合成的助手哨兵，以便在不执行
    // resume 操作时会话对 API 有效。跳过尾部的系统/进度消息，
    // 在用户消息之后插入，以便 removeInterruptedMessage 的
    // splice(idx, 2) 移除正确的配对。
    const lastRelevantIdx = filteredMessages.findLastIndex(
      m => m.type !== 'system' && m.type !== 'progress',
    )
    if (
      lastRelevantIdx !== -1 &&
      filteredMessages[lastRelevantIdx]!.type === 'user'
    ) {
      filteredMessages.splice(
        lastRelevantIdx + 1,
        0,
        createAssistantMessage({
          content: NO_RESPONSE_REQUESTED,
        }) as NormalizedMessage,
      )
    }

    return { messages: filteredMessages, turnInterruptionState }
  } catch (error) {
    logError(error as Error)
    throw error
  }
}

/**
 * 来自检测的内部三向结果，在将 interrupted_turn 转换为带有
 * 合成继续消息的 interrupted_prompt 之前。
 */
type InternalInterruptionState =
  | TurnInterruptionState
  | { kind: 'interrupted_turn' }

/**
 * 根据过滤后的最后一条消息判断会话是否在轮次中途被中断。
 * 助手作为最后消息（在过滤未解决的 tool_use 之后）被视为
 * 已完成的轮次，因为在流式路径中持久化消息上的 stop_reason
 * 始终为 null。
 *
 * 查找最后一条轮次相关消息时跳过系统和进度消息 ——
 * 它们是簿记工件，不应掩盖真正的中断。附件被视为
 * 轮次的一部分。
 */
function detectTurnInterruption(
  messages: NormalizedMessage[],
): InternalInterruptionState {
  if (messages.length === 0) {
    return { kind: 'none' }
  }

  // 查找最后一条轮次相关消息，跳过系统/进度消息和
  // 合成的 API 错误助手。错误助手已在 API 发送前过滤
  //（normalizeMessagesForAPI）—— 在此跳过它们让自动 resume
  // 在重试耗尽后触发，而非将错误读取为已完成的轮次。
  const lastMessageIdx = messages.findLastIndex(
    m =>
      m.type !== 'system' &&
      m.type !== 'progress' &&
      !(m.type === 'assistant' && m.isApiErrorMessage),
  )
  const lastMessage =
    lastMessageIdx !== -1 ? messages[lastMessageIdx] : undefined

  if (!lastMessage) {
    return { kind: 'none' }
  }

  if (lastMessage.type === 'assistant') {
    // 在流式路径中，stop_reason 在持久化消息上始终为 null，
    // 因为消息在 content_block_stop 时记录，在 message_delta
    // 传递 stop_reason 之前。在 filterUnresolvedToolUses 移除
    // 带有未匹配 tool_use 的助手消息后，助手作为最后消息
    // 意味着轮次很可能正常完成。
    return { kind: 'none' }
  }

  if (lastMessage.type === 'user') {
    if (lastMessage.isMeta || lastMessage.isCompactSummary) {
      return { kind: 'none' }
    }
    if (isToolUseResultMessage(lastMessage)) {
      // Brief 模式（#20467）丢弃尾部助手文本块，因此已完成的
      // brief 模式轮次合理地以 SendUserMessage 的 tool_result
      // 结束。没有此检查，resume 会将每个 brief 模式会话
      // 误分类为轮次中途被中断，并在用户的真实下一个提示
      // 之前注入幽灵 "Continue from where you left off."。
      // 向前查找一步以找到原始 tool_use。
      if (isTerminalToolResult(lastMessage, messages, lastMessageIdx)) {
        return { kind: 'none' }
      }
      return { kind: 'interrupted_turn' }
    }
    // 纯文本用户提示 —— CC 尚未开始响应
    return {
      kind: 'interrupted_prompt',
      message: lastMessage as NormalizedUserMessage,
    }
  }

  if (lastMessage.type === 'attachment') {
    // 附件是用户轮次的一部分 —— 用户提供了上下文但助手
    // 从未响应。
    return { kind: 'interrupted_turn' }
  }

  return { kind: 'none' }
}

/**
 * 此 tool_result 是否为合法终止轮次的工具输出？SendUserMessage
 * 是典型情况：在 brief 模式中，调用它是轮次的最后一步 ——
 * 没有后续助手文本（#20467 移除了它）。会话记录在此结束
 * 意味着轮次已完成，而非在工具执行中途被终止。
 *
 * 向前查找以找到此结果所属的助手 tool_use 并检查其名称。
 * 匹配的 tool_use 通常是紧邻的前一条相关消息
 *（filterUnresolvedToolUses 已丢弃未配对的），但我们在
 * 万一系统/进度噪音交错时仍然遍历。
 */
function isTerminalToolResult(
  result: NormalizedUserMessage,
  messages: NormalizedMessage[],
  resultIdx: number,
): boolean {
  const content = result.message.content
  if (!Array.isArray(content)) return false
  const block = content[0]
  if (block?.type !== 'tool_result') return false
  const toolUseId = block.tool_use_id

  for (let i = resultIdx - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type !== 'assistant') continue
    const msgContent = msg.message!.content
    if (!Array.isArray(msgContent)) continue
    for (const b of msgContent) {
      if (
        typeof b !== 'string' &&
        'type' in b &&
        b.type === 'tool_use' &&
        'id' in b &&
        b.id === toolUseId
      ) {
        return (
          ('name' in b ? b.name : undefined) === BRIEF_TOOL_NAME ||
          ('name' in b ? b.name : undefined) === LEGACY_BRIEF_TOOL_NAME ||
          ('name' in b ? b.name : undefined) === SEND_USER_FILE_TOOL_NAME
        )
      }
    }
  }
  return false
}

/**
 * 从消息中的 invoked_skills 附件恢复 skill 状态。
 * 这确保在压缩后 resume 时 skill 被保留。
 * 如果没有此操作，如果 resume 后再次发生压缩，skill 会丢失，
 * 因为 STATE.invokedSkills 将为空。
 * @internal 导出用于测试 - 请使用 loadConversationForResume
 */
export function restoreSkillStateFromMessages(messages: Message[]): void {
  for (const message of messages) {
    if (message.type !== 'attachment') {
      continue
    }
    if (message.attachment!.type === 'invoked_skills') {
      const skills = message.attachment!.skills as Array<{
        name?: string
        path?: string
        content?: string
      }>
      for (const skill of skills) {
        if (skill.name && skill.path && skill.content) {
          // Resume 仅在主会话中发生，因此 agentId 为 null
          addInvokedSkill(skill.name, skill.path, skill.content, null)
        }
      }
    }
    // 先前的进程已注入 skills-available 提醒 —— 它在模型
    // 即将看到的会话记录中。sentSkillNames 是进程本地的，
    // 因此没有此操作，每次 resume 都会重新宣布相同的
    // ~600 tokens。触发一次锁存；在第一次附件遍历时消费。
    if (message.attachment!.type === 'skill_listing') {
      suppressNextSkillListing()
    }
  }

  // 在 resume 时无条件抑制 skill_listing 和 skill_discovery。
  // 附件不会持久化到非 ant 用户的会话记录中
  //（isLoggableMessage 过滤掉它们），因此上方的每类型检查
  // 可能永远找不到它们，即使先前的进程已通过
  // <system-reminder> 块将内容注入到会话中。没有此操作，
  // 每次 resume 都重新注入 ~1K tokens 的重复内容并破坏
  // Anthropic 提示缓存前缀（需要 100% 字节相同的段）。
  suppressNextSkillListing()
  suppressNextSkillDiscovery()
}

/**
 * 按路径遍历会话记录 jsonl 的链。与 loadFullLog 内部运行的
 * 序列相同 —— loadTranscriptFile → 查找最新的非 sidechain
 * 叶子 → buildConversationChain → removeExtraFields ——
 * 只是从任意路径而非 sid 派生的路径开始。
 *
 * leafUuids 由 loadTranscriptFile 填充为"没有其他消息的
 * parentUuid 指向的 uuid"—— 链的尖端。可能有多个
 *（sidechain、孤立消息）；最新的非 sidechain 是主会话的末尾。
 */
export async function loadMessagesFromJsonlPath(path: string): Promise<{
  messages: SerializedMessage[]
  sessionId: UUID | undefined
}> {
  const { messages: byUuid, leafUuids } = await loadTranscriptFile(path)
  let tip: (typeof byUuid extends Map<UUID, infer T> ? T : never) | null = null
  let tipTs = 0
  for (const m of byUuid.values()) {
    if (m.isSidechain || !leafUuids.has(m.uuid)) continue
    const ts = new Date(m.timestamp).getTime()
    if (ts > tipTs) {
      tipTs = ts
      tip = m
    }
  }
  if (!tip) return { messages: [], sessionId: undefined }
  const chain = buildConversationChain(byUuid, tip)
  return {
    messages: removeExtraFields(chain),
    // 叶子的 sessionId —— 分叉会话从源会话记录复制 chain[0]，
    // 因此根保留源会话的 ID。与 loadFullLog 的
    // mostRecentLeaf.sessionId 匹配。
    sessionId: tip.sessionId as UUID | undefined,
  }
}

/**
 * 从各种来源加载会话以进行 resume。
 * 这是加载和反序列化会话的集中函数。
 *
 * @param source - 要加载的来源：
 *   - undefined：加载最近的会话
 *   - string：要加载的会话 ID
 *   - LogOption：已加载的会话
 * @param sourceJsonlFile - 备选：会话记录 jsonl 的路径。
 *   当 --resume 接收 .jsonl 路径时使用（cli/print.ts 按后缀
 *   路由），通常用于跨目录 resume，其中会话记录位于
 *   当前项目目录之外。
 * @returns 包含反序列化消息和原始日志的对象，若未找到则返回 null
 */
export async function loadConversationForResume(
  source: string | LogOption | undefined,
  sourceJsonlFile: string | undefined,
): Promise<{
  messages: Message[]
  turnInterruptionState: TurnInterruptionState
  fileHistorySnapshots?: FileHistorySnapshot[]
  attributionSnapshots?: AttributionSnapshotMessage[]
  contentReplacements?: ContentReplacementRecord[]
  contextCollapseCommits?: ContextCollapseCommitEntry[]
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry
  sessionId: UUID | undefined
  // 用于恢复代理上下文的会话元数据
  agentName?: string
  agentColor?: string
  agentSetting?: string
  customTitle?: string
  tag?: string
  mode?: 'coordinator' | 'normal'
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
  // 会话文件的完整路径（用于跨目录 resume）
  fullPath?: string
  // resume 时用于水合的目标状态
  goal?: import('../types/logs.js').GoalState
} | null> {
  try {
    let log: LogOption | null = null
    let messages: Message[] | null = null
    let sessionId: UUID | undefined

    if (source === undefined) {
      // --continue：最近的会话，跳过正在写入自身会话记录的
      // 活跃 --bg/daemon 会话。
      const logsPromise = loadMessageLogs()
      let skip = new Set<string>()
      if (feature('BG_SESSIONS')) {
        try {
          const { listAllLiveSessions } = await import('./udsClient.js')
          const live = await listAllLiveSessions()
          skip = new Set(
            live.flatMap(s =>
              s.kind && s.kind !== 'interactive' && s.sessionId
                ? [s.sessionId]
                : [],
            ),
          )
        } catch {
          // UDS 不可用 —— 将所有会话视为可继续
        }
      }
      const logs = await logsPromise
      log =
        logs.find(l => {
          const id = getSessionIdFromLog(l)
          return !id || !skip.has(id)
        }) ?? null
    } else if (sourceJsonlFile) {
      // --resume 带有 .jsonl 路径（cli/print.ts 按后缀路由）。
      // 与下方 sid 分支相同的链遍历 —— 仅起始路径不同。
      const loaded = await loadMessagesFromJsonlPath(sourceJsonlFile)
      messages = loaded.messages
      sessionId = loaded.sessionId
    } else if (typeof source === 'string') {
      // 按 ID 加载特定会话
      log = await getLastSessionLog(source as UUID)
      sessionId = source as UUID
    } else {
      // 已有 LogOption
      log = source
    }

    if (!log && !messages) {
      return null
    }

    if (log) {
      // 为 lite 日志加载完整消息
      if (isLiteLog(log)) {
        log = await loadFullLog(log)
      }

      // 首先确定 sessionId，以便传递给复制函数
      if (!sessionId) {
        sessionId = getSessionIdFromLog(log) as UUID
      }
      // 传递原始会话 ID 以确保计划 slug 与 resume 的会话
      // 关联，而非 resume 前的临时会话 ID
      if (sessionId) {
        await copyPlanForResume(log, asSessionId(sessionId))
      }

      // 复制 resume 的文件历史
      void copyFileHistoryForResume(log)

      messages = log.messages
      checkResumeConsistency(messages)
    }

    // 在反序列化之前从 invoked_skills 附件恢复 skill 状态。
    // 这确保 skill 在 resume 后的多次压缩周期中存活。
    restoreSkillStateFromMessages(messages!)

    // 反序列化消息以处理未解决的工具调用并确保正确格式
    const deserialized = deserializeMessagesWithInterruptDetection(messages!)
    messages = deserialized.messages

    // 处理 resume 的会话启动 hooks
    const hookMessages = await processSessionStartHooks('resume', { sessionId })

    // 将 hook 消息追加到会话
    messages.push(...hookMessages)

    return {
      messages,
      turnInterruptionState: deserialized.turnInterruptionState,
      fileHistorySnapshots: log?.fileHistorySnapshots,
      attributionSnapshots: log?.attributionSnapshots,
      contentReplacements: log?.contentReplacements,
      contextCollapseCommits: log?.contextCollapseCommits,
      contextCollapseSnapshot: log?.contextCollapseSnapshot,
      sessionId,
      // 包含会话元数据以在 resume 时恢复代理上下文
      agentName: log?.agentName,
      agentColor: log?.agentColor,
      agentSetting: log?.agentSetting,
      customTitle: log?.customTitle,
      tag: log?.tag,
      mode: log?.mode,
      worktreeSession: log?.worktreeSession,
      prNumber: log?.prNumber,
      prUrl: log?.prUrl,
      prRepository: log?.prRepository,
      // 包含完整路径以用于跨目录 resume
      fullPath: log?.fullPath,
      // resume 时用于水合的目标状态
      goal: log?.goal,
    }
  } catch (error) {
    logError(error as Error)
    throw error
  }
}
