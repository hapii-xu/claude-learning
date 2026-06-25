/**
 * 从当前 session transcript 中提取持久化 memory，
 * 并写入 auto-memory 目录（~/.hclaude/projects/<path>/memory/）。
 *
 * 在每次完整 query loop 结束时（模型产生无 tool call 的最终响应时）
 * 通过 stopHooks.ts 中的 handleStopHooks 调用一次。
 *
 * 使用 forked agent 模式（runForkedAgent）——主对话的完美 fork，
 * 共享父进程的 prompt cache。
 *
 * 状态以 closure 形式封装在 initExtractMemories() 内部而非模块级别，
 * 遵循与 confidenceRating.ts 相同的模式。测试在 beforeEach 中调用
 * initExtractMemories() 以获得新鲜的 closure。
 */

import { feature } from 'bun:bundle'
import { basename } from 'path'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { ENTRYPOINT_NAME } from '../../memdir/memdir.js'
import {
  formatMemoryManifest,
  scanMemoryFiles,
} from '../../memdir/memoryScan.js'
import {
  getAutoMemPath,
  isAutoMemoryEnabled,
  isAutoMemPath,
} from '../../memdir/paths.js'
import type { Tool } from '../../Tool.js'
import { BASH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GrepTool/prompt.js'
import { REPL_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/REPLTool/constants.js'
import type {
  AssistantMessage,
  Message,
  SystemMessage,
} from '../../types/message.js'
import { createAbortController } from '../../utils/abortController.js'
import { count, uniq } from '../../utils/array.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  createCacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import {
  createMemorySavedMessage,
  createUserMessage,
} from '../../utils/messages.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { logEvent } from '../analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../analytics/metadata.js'
import {
  buildExtractAutoOnlyPrompt,
  buildExtractCombinedPrompt,
} from './prompts.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('../../memdir/teamMemPaths.js') as typeof import('../../memdir/teamMemPaths.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 如果消息对模型可见（即会被发送到 API 调用中）则返回 true。
 * 排除 progress、system 和 attachment 消息。
 */
function isModelVisibleMessage(message: Message): boolean {
  return message.type === 'user' || message.type === 'assistant'
}

function countModelVisibleMessagesSince(
  messages: Message[],
  sinceUuid: string | undefined,
): number {
  if (sinceUuid === null || sinceUuid === undefined) {
    return count(messages, isModelVisibleMessage)
  }

  let foundStart = false
  let n = 0
  for (const message of messages) {
    if (!foundStart) {
      if (message.uuid === sinceUuid) {
        foundStart = true
      }
      continue
    }
    if (isModelVisibleMessage(message)) {
      n++
    }
  }
  // 如果未找到 sinceUuid（例如被 context compaction 移除），
  // 则回退为统计所有模型可见消息，而非返回 0——
  // 返回 0 会在 session 剩余时间内永久禁用提取。
  if (!foundStart) {
    return count(messages, isModelVisibleMessage)
  }
  return n
}

/**
 * 如果游标 UUID 之后有任何 assistant 消息包含指向 auto-memory 路径的
 * Write/Edit tool_use 块，则返回 true。
 *
 * 主 agent 的 prompt 包含完整的保存指令——当主 agent 自行写入 memory 时，
 * forked 提取是多余的。runExtraction 会跳过 agent 并将游标推进到此范围之后，
 * 使主 agent 和后台 agent 在每个 turn 上互斥。
 */
function hasMemoryWritesSince(
  messages: Message[],
  sinceUuid: string | undefined,
): boolean {
  let foundStart = sinceUuid === undefined
  for (const message of messages) {
    if (!foundStart) {
      if (message.uuid === sinceUuid) {
        foundStart = true
      }
      continue
    }
    if (message.type !== 'assistant') {
      continue
    }
    const content = (message as AssistantMessage).message.content
    if (!Array.isArray(content)) {
      continue
    }
    for (const block of content) {
      const filePath = getWrittenFilePath(block)
      if (filePath !== undefined && isAutoMemPath(filePath)) {
        return true
      }
    }
  }
  return false
}

// ============================================================================
// Tool 权限
// ============================================================================

function denyAutoMemTool(tool: Tool, reason: string) {
  logForDebugging(`[autoMem] denied ${tool.name}: ${reason}`)
  logEvent('tengu_auto_mem_tool_denied', {
    tool_name: sanitizeToolNameForAnalytics(tool.name),
  })
  return {
    behavior: 'deny' as const,
    message: reason,
    decisionReason: { type: 'other' as const, reason },
  }
}

/**
 * 创建一个 canUseTool 函数，允许 Read/Grep/Glob（无限制）、
 * 只读 Bash 命令，以及仅限 auto-memory 目录内路径的 Edit/Write。
 * 由 extractMemories 和 autoDream 共用。
 */
export function createAutoMemCanUseTool(memoryDir: string): CanUseToolFn {
  return async (tool: Tool, input: Record<string, unknown>) => {
    // 允许 REPL——当 REPL 模式启用时（ant 默认），原始 tool 会从 tool 列表中隐藏，
    // 因此 forked agent 会调用 REPL。REPL 的 VM context 会为每个内部原始操作
    // 重新调用此 canUseTool（toolWrappers.ts createToolWrapper），
    // 因此下方的 Read/Bash/Edit/Write 检查仍会把守实际的文件和 shell 操作。
    // 为 fork 提供不同的 tool 列表会破坏 prompt cache 共享
    //（tools 是 cache key 的一部分——见 forkedAgent.ts 的 CacheSafeParams）。
    if (tool.name === REPL_TOOL_NAME) {
      return { behavior: 'allow' as const, updatedInput: input }
    }

    // 允许 Read/Grep/Glob 不受限制——它们本质上都是只读的
    if (
      tool.name === FILE_READ_TOOL_NAME ||
      tool.name === GREP_TOOL_NAME ||
      tool.name === GLOB_TOOL_NAME
    ) {
      return { behavior: 'allow' as const, updatedInput: input }
    }

    // 仅允许通过 BashTool.isReadOnly 检查的 Bash 命令。
    // 此处的 `tool` 就是 BashTool——无需静态 import。
    if (tool.name === BASH_TOOL_NAME) {
      const parsed = tool.inputSchema.safeParse(input)
      if (parsed.success && tool.isReadOnly(parsed.data)) {
        return { behavior: 'allow' as const, updatedInput: input }
      }
      return denyAutoMemTool(
        tool,
        '此上下文中只允许只读 shell 命令（ls、find、grep、cat、stat、wc、head、tail 等）',
      )
    }

    if (
      (tool.name === FILE_EDIT_TOOL_NAME ||
        tool.name === FILE_WRITE_TOOL_NAME) &&
      'file_path' in input
    ) {
      const filePath = input.file_path
      if (typeof filePath === 'string' && isAutoMemPath(filePath)) {
        return { behavior: 'allow' as const, updatedInput: input }
      }
    }

    return denyAutoMemTool(
      tool,
      `only ${FILE_READ_TOOL_NAME}, ${GREP_TOOL_NAME}, ${GLOB_TOOL_NAME}, read-only ${BASH_TOOL_NAME}, and ${FILE_EDIT_TOOL_NAME}/${FILE_WRITE_TOOL_NAME} within ${memoryDir} are allowed`,
    )
  }
}

// ============================================================================
// 从 agent 输出中提取文件路径
// ============================================================================

/**
 * 如果存在，从 tool_use 块的 input 中提取 file_path。
 * 当该块不是 Edit/Write tool_use 或没有 file_path 时返回 undefined。
 */
function getWrittenFilePath(block: {
  type: string
  name?: string
  input?: unknown
}): string | undefined {
  if (
    block.type !== 'tool_use' ||
    (block.name !== FILE_EDIT_TOOL_NAME && block.name !== FILE_WRITE_TOOL_NAME)
  ) {
    return undefined
  }
  const input = block.input
  if (typeof input === 'object' && input !== null && 'file_path' in input) {
    const fp = (input as { file_path: unknown }).file_path
    return typeof fp === 'string' ? fp : undefined
  }
  return undefined
}

function extractWrittenPaths(agentMessages: Message[]): string[] {
  const paths: string[] = []
  for (const message of agentMessages) {
    if (message.type !== 'assistant') {
      continue
    }
    const content = (message as AssistantMessage).message.content
    if (!Array.isArray(content)) {
      continue
    }
    for (const block of content) {
      const filePath = getWrittenFilePath(block)
      if (filePath !== undefined) {
        paths.push(filePath)
      }
    }
  }
  return uniq(paths)
}

// ============================================================================
// 初始化与 closure 范围内的状态
// ============================================================================

type AppendSystemMessageFn = (msg: SystemMessage) => void

/** 活跃的提取器函数，由 initExtractMemories() 设置。 */
let extractor:
  | ((
      context: REPLHookContext,
      appendSystemMessage?: AppendSystemMessageFn,
    ) => Promise<void>)
  | null = null

/** 活跃的 drain 函数，由 initExtractMemories() 设置。初始化前为 no-op。 */
let drainer: (timeoutMs?: number) => Promise<void> = async () => {}

/**
 * 初始化 memory 提取系统。
 * 创建一个新鲜的 closure，捕获所有可变状态（游标位置、重叠守卫、待处理 context）。
 * 在启动时与 initConfidenceRating/initPromptCoaching 一同调用一次，
 * 或在每个测试的 beforeEach 中调用。
 */
export function initExtractMemories(): void {
  // --- closure 范围内的可变状态 ---

  /** 提取器派发出去但尚未 settled 的所有 promise。
   *  合并调用（stash-and-return）会添加快速 resolve 的 promise（无害）；
   *  真正启动工作的调用会通过 runExtraction 的递归 finally 添加一个
   *  覆盖完整 trailing-run 链的 promise。 */
  const inFlightExtractions = new Set<Promise<void>>()

  /** 最后处理的消息的 UUID——游标，使每次运行只考虑上次提取后新增的消息。 */
  let lastMemoryMessageUuid: string | undefined

  /** 一次性标志：一旦记录了 gate 被禁用，就不再重复记录。 */
  let hasLoggedGateFailure = false

  /** runExtraction 执行期间为 true——防止重叠运行。 */
  let inProgress = false

  /** 自上次提取运行以来合格 turn 的计数。每次运行后重置为 0。 */
  let turnsSinceLastExtraction = 0

  /** 当调用在运行中到达时，我们在此存入 context，
   *  并在当前运行结束后执行一次 trailing 提取。 */
  let pendingContext:
    | {
        context: REPLHookContext
        appendSystemMessage?: AppendSystemMessageFn
      }
    | undefined

  // --- Inner extraction logic ---

  async function runExtraction({
    context,
    appendSystemMessage,
    isTrailingRun,
  }: {
    context: REPLHookContext
    appendSystemMessage?: AppendSystemMessageFn
    isTrailingRun?: boolean
  }): Promise<void> {
    const { messages } = context
    const memoryDir = getAutoMemPath()
    const newMessageCount = countModelVisibleMessagesSince(
      messages,
      lastMemoryMessageUuid,
    )

    // 互斥：当主 agent 已写入 memory 时，跳过 forked agent，
    // 并将游标推进到此范围之后，使下一次提取只考虑主 agent 写入之后的消息。
    if (hasMemoryWritesSince(messages, lastMemoryMessageUuid)) {
      logForDebugging(
        '[extractMemories] skipping — conversation already wrote to memory files',
      )
      const lastMessage = messages.at(-1)
      if (lastMessage?.uuid) {
        lastMemoryMessageUuid = lastMessage.uuid
      }
      logEvent('tengu_extract_memories_skipped_direct_write', {
        message_count: newMessageCount,
      })
      return
    }

    const teamMemoryEnabled = feature('TEAMMEM')
      ? teamMemPaths!.isTeamMemoryEnabled()
      : false

    const skipIndex = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_moth_copse',
      false,
    )

    const canUseTool = createAutoMemCanUseTool(memoryDir)
    const cacheSafeParams = createCacheSafeParams(context)

    // 每 N 个合格 turn 才运行一次提取（tengu_bramble_lintel，默认 1）。
    // Trailing 提取（来自 stashed context）跳过此检查，
    // 因为它们处理的是已提交的工作，不应被节流。
    if (!isTrailingRun) {
      turnsSinceLastExtraction++
      if (
        turnsSinceLastExtraction <
        (getFeatureValue_CACHED_MAY_BE_STALE('tengu_bramble_lintel', null) ?? 1)
      ) {
        return
      }
    }
    turnsSinceLastExtraction = 0

    inProgress = true
    const startTime = Date.now()
    try {
      logForDebugging(
        `[extractMemories] starting — ${newMessageCount} new messages, memoryDir=${memoryDir}`,
      )

      // 预注入 memory 目录清单，以免 agent 花费一个 turn 执行 `ls`。
      // 复用 findRelevantMemories 的 frontmatter 扫描。
      // 放在节流 gate 之后，确保跳过的 turn 不支付扫描成本。
      const existingMemories = formatMemoryManifest(
        await scanMemoryFiles(memoryDir, createAbortController().signal),
      )

      const userPrompt =
        feature('TEAMMEM') && teamMemoryEnabled
          ? buildExtractCombinedPrompt(
              newMessageCount,
              existingMemories,
              skipIndex,
            )
          : buildExtractAutoOnlyPrompt(
              newMessageCount,
              existingMemories,
              skipIndex,
            )

      const result = await runForkedAgent({
        promptMessages: [createUserMessage({ content: userPrompt })],
        cacheSafeParams,
        canUseTool,
        querySource: 'extract_memories',
        forkLabel: 'extract_memories',
        // extractMemories subagent 不需要记录到 transcript。
        // 这样做会与主线程产生竞态条件。
        skipTranscript: true,
        // 正常提取在 2-4 个 turn 内完成（read → write）。
        // 硬性上限防止验证陷入兔子洞而浪费 turn。
        maxTurns: 5,
      })

      // 仅在成功运行后推进游标。如果 agent 出错（在下方捕获），
      // 游标保持原位，这些消息将在下次提取时重新考虑。
      const lastMessage = messages.at(-1)
      if (lastMessage?.uuid) {
        lastMemoryMessageUuid = lastMessage.uuid
      }

      const writtenPaths = extractWrittenPaths(result.messages)
      const turnCount = count(result.messages, m => m.type === 'assistant')

      const totalInput =
        result.totalUsage.input_tokens +
        result.totalUsage.cache_creation_input_tokens +
        result.totalUsage.cache_read_input_tokens
      const hitPct =
        totalInput > 0
          ? (
              (result.totalUsage.cache_read_input_tokens / totalInput) *
              100
            ).toFixed(1)
          : '0.0'
      logForDebugging(
        `[extractMemories] finished — ${writtenPaths.length} files written, cache: read=${result.totalUsage.cache_read_input_tokens} create=${result.totalUsage.cache_creation_input_tokens} input=${result.totalUsage.input_tokens} (${hitPct}% hit)`,
      )

      if (writtenPaths.length > 0) {
        logForDebugging(
          `[extractMemories] memories saved: ${writtenPaths.join(', ')}`,
        )
      } else {
        logForDebugging('[extractMemories] no memories saved this run')
      }

      // 索引文件更新是机械性的——agent 只是在 MEMORY.md 中添加主题链接，
      // 但用户可见的"memory"是主题文件本身。
      const memoryPaths = writtenPaths.filter(
        p => basename(p) !== ENTRYPOINT_NAME,
      )
      const teamCount = feature('TEAMMEM')
        ? count(memoryPaths, teamMemPaths!.isTeamMemPath)
        : 0

      // 记录提取事件及 forked agent 的 token 用量
      logEvent('tengu_extract_memories_extraction', {
        input_tokens: result.totalUsage.input_tokens,
        output_tokens: result.totalUsage.output_tokens,
        cache_read_input_tokens: result.totalUsage.cache_read_input_tokens,
        cache_creation_input_tokens:
          result.totalUsage.cache_creation_input_tokens,
        message_count: newMessageCount,
        turn_count: turnCount,
        files_written: writtenPaths.length,
        memories_saved: memoryPaths.length,
        team_memories_saved: teamCount,
        duration_ms: Date.now() - startTime,
      })

      logForDebugging(
        `[extractMemories] writtenPaths=${writtenPaths.length} memoryPaths=${memoryPaths.length} appendSystemMessage defined=${appendSystemMessage != null}`,
      )
      if (memoryPaths.length > 0) {
        const msg = createMemorySavedMessage(memoryPaths)
        if (feature('TEAMMEM')) {
          msg.teamCount = teamCount
        }
        appendSystemMessage?.(msg)
      }
    } catch (error) {
      // 提取是尽力而为——记录错误但不通知
      logForDebugging(`[extractMemories] error: ${error}`)
      logEvent('tengu_extract_memories_error', {
        duration_ms: Date.now() - startTime,
      })
    } finally {
      inProgress = false

      // 如果在运行期间有调用到达，则使用最新的 stashed context 执行 trailing 提取。
      // trailing run 会相对于我们刚推进的游标计算 newMessageCount——
      // 因此只会获取两次调用之间新增的消息，而非完整历史。
      const trailing = pendingContext
      pendingContext = undefined
      if (trailing) {
        logForDebugging(
          '[extractMemories] running trailing extraction for stashed context',
        )
        await runExtraction({
          context: trailing.context,
          appendSystemMessage: trailing.appendSystemMessage,
          isTrailingRun: true,
        })
      }
    }
  }

  // --- 公共入口点（由 extractor 捕获）---

  async function executeExtractMemoriesImpl(
    context: REPLHookContext,
    appendSystemMessage?: AppendSystemMessageFn,
  ): Promise<void> {
    // 仅对主 agent 运行，不对 subagent 运行
    if (context.toolUseContext.agentId) {
      return
    }

    if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_passport_quail', false)) {
      if (process.env.USER_TYPE === 'ant' && !hasLoggedGateFailure) {
        hasLoggedGateFailure = true
        logEvent('tengu_extract_memories_gate_disabled', {})
      }
      return
    }

    // 检查 auto-memory 是否已启用
    if (!isAutoMemoryEnabled()) {
      return
    }

    // 远程模式下跳过
    if (getIsRemoteMode()) {
      return
    }

    // 如果提取已在进行中，将此 context stash 用于 trailing run
    //（覆盖任何之前 stashed 的 context——只有最新的才重要，因为它包含最多消息）。
    if (inProgress) {
      logForDebugging(
        '[extractMemories] extraction in progress — stashing for trailing run',
      )
      logEvent('tengu_extract_memories_coalesced', {})
      pendingContext = { context, appendSystemMessage }
      return
    }

    await runExtraction({ context, appendSystemMessage })
  }

  extractor = async (context, appendSystemMessage) => {
    const p = executeExtractMemoriesImpl(context, appendSystemMessage)
    inFlightExtractions.add(p)
    try {
      await p
    } finally {
      inFlightExtractions.delete(p)
    }
  }

  drainer = async (timeoutMs = 60_000) => {
    if (inFlightExtractions.size === 0) return
    await Promise.race([
      Promise.all(inFlightExtractions).catch(() => {}),
      // eslint-disable-next-line no-restricted-syntax -- sleep() 没有 .unref()；timer 不能阻塞进程退出
      new Promise<void>(r => setTimeout(r, timeoutMs).unref()),
    ])
  }
}

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 在 query loop 结束时运行 memory 提取。
 * 从 handleStopHooks 以 fire-and-forget 方式调用，与 prompt suggestion/coaching 并行。
 * 在 initExtractMemories() 被调用之前为 no-op。
 */
export async function executeExtractMemories(
  context: REPLHookContext,
  appendSystemMessage?: AppendSystemMessageFn,
): Promise<void> {
  await extractor?.(context, appendSystemMessage)
}

/**
 * 等待所有进行中的提取（包括 trailing stashed runs）完成，带软性超时。
 * 由 print.ts 在响应 flush 之后、gracefulShutdownSync 之前调用，
 * 确保 forked agent 在 5s 关闭 failsafe 终止它之前完成。
 * 在 initExtractMemories() 被调用之前为 no-op。
 */
export async function drainPendingExtraction(
  timeoutMs?: number,
): Promise<void> {
  await drainer(timeoutMs)
}
