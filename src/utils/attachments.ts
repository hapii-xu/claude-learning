// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import type { ToolDiscoveryResult } from '../services/searchExtraTools/prefetch.js'
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import {
  toolMatchesName,
  type Tools,
  type ToolUseContext,
  type ToolPermissionContext,
} from '../Tool.js'
import {
  FileReadTool,
  MaxFileReadTokenExceededError,
  type Output as FileReadToolOutput,
  readImageWithTokenBudget,
} from '@claude-code-best/builtin-tools/tools/FileReadTool/FileReadTool.js'
import { FileTooLargeError, readFileInRange } from './readFileInRange.js'
import { expandPath } from './path.js'
import { countCharInString } from './stringUtils.js'
import { uniq } from './array.js'
import { getFsImplementation } from './fsOperations.js'
import { readdir, stat } from 'fs/promises'
import type { IDESelection } from '../hooks/useIdeSelection.js'
import { TODO_WRITE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TodoWriteTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TaskCreateTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TaskUpdateTool/constants.js'
import { BASH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BashTool/toolName.js'
import { SKILL_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/SkillTool/constants.js'
import type { TodoList } from './todo/types.js'
import {
  type Task,
  listTasks,
  getTaskListId,
  isTodoV2Enabled,
} from './tasks.js'
import { getPlanFilePath, getPlan } from './plans.js'
import { getConnectedIdeName } from './ide.js'
import {
  getManagedAndUserConditionalRules,
  getMemoryFilesForNestedDirectory,
  getConditionalRulesForCwdLevelDirectory,
  type MemoryFileInfo,
} from './claudemd.js'
import { dirname, parse, relative, resolve } from 'path'
import { getCwd } from 'src/utils/cwd.js'
import { getViewedTeammateTask } from '../state/selectors.js'
import { logError } from './log.js'
import { logAntError } from './debug.js'
import { isENOENT, toError } from './errors.js'
import type { DiagnosticFile } from '../services/diagnosticTracking.js'
import { diagnosticTracker } from '../services/diagnosticTracking.js'
import type {
  AttachmentMessage,
  Message,
  MessageOrigin,
} from 'src/types/message.js'
import {
  type QueuedCommand,
  getImagePasteIds,
  isValidImagePaste,
} from 'src/types/textInputTypes.js'
import { randomUUID, type UUID } from 'crypto'
import { getSnippetForTwoFileDiff } from '@claude-code-best/builtin-tools/tools/FileEditTool/utils.js'
import type {
  ContentBlockParam,
  ImageBlockParam,
  Base64ImageSource,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import { maybeResizeAndDownsampleImageBlock } from './imageResizer.js'
import type { PastedContent } from './config.js'
import { getSettings_DEPRECATED } from './settings/settings.js'
import {
  getDefaultSonnetModel,
  getDefaultHaikuModel,
  getDefaultOpusModel,
} from './model/model.js'
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js'
import { getSkillToolCommands, getMcpSkillCommands } from '../commands.js'
import type { Command } from '../types/command.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { getProjectRoot } from '../bootstrap/state.js'
import { formatCommandsWithinBudget } from '@claude-code-best/builtin-tools/tools/SkillTool/prompt.js'
import { getContextWindowForModel } from './context.js'
import type { DiscoverySignal } from '../services/skillSearch/signals.js'
// 为 DCE 的条件性 require。所有 skill-search 的字符串字面量都
// 存在于这些模块中，以避免泄漏到外部构建中。本文件中仅有的
// 使用点是：maybe() 调用（通过下方的展开运算符门控）和
// skill_listing 抑制检查（使用相同的 skillSearchModules null
// 检查）。上方仅类型的 DiscoverySignal import 在编译时被擦除。
/* eslint-disable @typescript-eslint/no-require-imports */
const skillSearchModules = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? {
      featureCheck:
        require('../services/skillSearch/featureCheck.js') as typeof import('../services/skillSearch/featureCheck.js'),
      prefetch:
        require('../services/skillSearch/prefetch.js') as typeof import('../services/skillSearch/prefetch.js'),
    }
  : null
const searchExtraToolsModules = feature('EXPERIMENTAL_SEARCH_EXTRA_TOOLS')
  ? {
      prefetch:
        require('../services/searchExtraTools/prefetch.js') as typeof import('../services/searchExtraTools/prefetch.js'),
    }
  : null
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('./permissions/autoModeState.js') as typeof import('./permissions/autoModeState.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  MAX_LINES_TO_READ,
  FILE_READ_TOOL_NAME,
} from '@claude-code-best/builtin-tools/tools/FileReadTool/prompt.js'
import { getDefaultFileReadingLimits } from '@claude-code-best/builtin-tools/tools/FileReadTool/limits.js'
import { cacheKeys, type FileStateCache } from './fileStateCache.js'
import {
  createAbortController,
  createChildAbortController,
} from './abortController.js'
import { isAbortError } from './errors.js'
import {
  getFileModificationTimeAsync,
  isFileWithinReadSizeLimit,
} from './file.js'
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { filterAgentsByMcpRequirements } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { AGENT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/AgentTool/constants.js'
import {
  formatAgentLine,
  shouldInjectAgentListInMessages,
} from '@claude-code-best/builtin-tools/tools/AgentTool/prompt.js'
import { filterDeniedAgents } from './permissions/permissions.js'
import { getSubscriptionType } from './auth.js'
import { mcpInfoFromString } from '../services/mcp/mcpStringUtils.js'
import {
  matchingRuleForInput,
  pathInAllowedWorkingPath,
} from './permissions/filesystem.js'
import {
  generateTaskAttachments,
  applyTaskOffsetsAndEvictions,
} from './task/framework.js'
import { getTaskOutputPath } from './task/diskOutput.js'
import { drainPendingMessages } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { TaskType, TaskStatus } from '../Task.js'
import {
  getOriginalCwd,
  getSessionId,
  getSdkBetas,
  getTotalCostUSD,
  getTotalOutputTokens,
  getCurrentTurnTokenBudget,
  getTurnOutputTokens,
  hasExitedPlanModeInSession,
  setHasExitedPlanMode,
  needsPlanModeExitAttachment,
  setNeedsPlanModeExitAttachment,
  needsAutoModeExitAttachment,
  setNeedsAutoModeExitAttachment,
  getLastEmittedDate,
  setLastEmittedDate,
  getKairosActive,
} from '../bootstrap/state.js'
import type { QuerySource } from '../constants/querySource.js'
import {
  getDeferredToolsDelta,
  isDeferredToolsDeltaEnabled,
  isSearchExtraToolsEnabledOptimistic,
  isSearchExtraToolsToolAvailable,
  type DeferredToolsDeltaScanContext,
} from './searchExtraTools.js'
import {
  getMcpInstructionsDelta,
  isMcpInstructionsDeltaEnabled,
  type ClientSideInstruction,
} from './mcpInstructionsDelta.js'
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME } from './claudeInChrome/common.js'
import { CHROME_SEARCH_EXTRA_TOOLS_INSTRUCTIONS } from './claudeInChrome/prompt.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import type {
  HookEvent,
  SyncHookJSONOutput,
} from 'src/entrypoints/agentSdkTypes.js'
import {
  checkForAsyncHookResponses,
  removeDeliveredAsyncHooks,
} from './hooks/AsyncHookRegistry.js'
import {
  checkForLSPDiagnostics,
  clearAllLSPDiagnostics,
} from '../services/lsp/LSPDiagnosticRegistry.js'
import { logForDebugging } from './debug.js'
import {
  extractTextContent,
  getUserMessageText,
  isThinkingMessage,
} from './messages.js'
import { isHumanTurn } from './messagePredicates.js'
import { isEnvTruthy, getClaudeConfigHomeDir } from './envUtils.js'
import { feature } from 'bun:bundle'
/* eslint-disable @typescript-eslint/no-require-imports */
const BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('@claude-code-best/builtin-tools/tools/BriefTool/prompt.js') as typeof import('@claude-code-best/builtin-tools/tools/BriefTool/prompt.js')
      ).BRIEF_TOOL_NAME
    : null
const sessionTranscriptModule = feature('KAIROS')
  ? (require('../services/sessionTranscript/sessionTranscript.js') as typeof import('../services/sessionTranscript/sessionTranscript.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import { hasUltrathinkKeyword, isUltrathinkEnabled } from './thinking.js'
import {
  tokenCountFromLastAPIResponse,
  tokenCountWithEstimation,
} from './tokens.js'
import {
  getEffectiveContextWindowSize,
  isAutoCompactEnabled,
} from '../services/compact/autoCompact.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  hasInstructionsLoadedHook,
  executeInstructionsLoadedHooks,
  type HookBlockingError,
  type InstructionsMemoryType,
} from './hooks.js'
import { jsonStringify } from './slowOperations.js'
import { isPDFExtension } from './pdfUtils.js'
import { getLocalISODate } from '../constants/common.js'
import { getPDFPageCount } from './pdf.js'
import { PDF_AT_MENTION_INLINE_THRESHOLD } from '../constants/apiLimits.js'
import { isAgentSwarmsEnabled } from './agentSwarmsEnabled.js'
import { findRelevantMemories } from '../memdir/findRelevantMemories.js'
import { memoryAge, memoryFreshnessText } from '../memdir/memoryAge.js'
import { getAutoMemPath, isAutoMemoryEnabled } from '../memdir/paths.js'
import { getAgentMemoryDir } from '@claude-code-best/builtin-tools/tools/AgentTool/agentMemory.js'
import {
  readUnreadMessages,
  markMessagesAsReadByPredicate,
  isShutdownApproved,
  isStructuredProtocolMessage,
  isIdleNotification,
} from './teammateMailbox.js'
import {
  getAgentName,
  getAgentId,
  getTeamName,
  isTeamLead,
} from './teammate.js'
import { isInProcessTeammate } from './teammateContext.js'
import { removeTeammateFromTeamFile } from './swarm/teamHelpers.js'
import { unassignTeammateTasks } from './tasks.js'
import { getCompanionIntroAttachment } from '../buddy/prompt.js'

export const TODO_REMINDER_CONFIG = {
  TURNS_SINCE_WRITE: 10,
  TURNS_BETWEEN_REMINDERS: 10,
} as const

export const PLAN_MODE_ATTACHMENT_CONFIG = {
  TURNS_BETWEEN_ATTACHMENTS: 5,
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
} as const

export const AUTO_MODE_ATTACHMENT_CONFIG = {
  TURNS_BETWEEN_ATTACHMENTS: 5,
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
} as const

const MAX_MEMORY_LINES = 200
// 仅限制行数无法控制大小（200 × 500 字符行 = 100KB）。
// surfacer 每轮通过 <system-reminder> 注入最多 5 个文件，绕过
// 单条消息的工具结果预算，因此紧凑的每文件字节上限能确保
// 总注入量受限（5 × 4KB = 20KB/轮）。通过
// readFileInRange 的 truncateOnByteLimit 选项强制执行。截断意味着
// 最相关的记忆仍会浮现：frontmatter + 开头的上下文
// 通常是最重要的部分。
const MAX_MEMORY_BYTES = 4096

export const RELEVANT_MEMORIES_CONFIG = {
  // 每轮上限（5 × 4KB = 20KB）仅约束单次注入，但在
  // 长会话中选择器会持续浮现不同的文件 — 生产环境中观察到
  // 约 26K tokens/会话。限制累计字节数：达到上限后完全
  // 停止预取。预算约为 3 次完整注入；之后最相关的
  // 记忆已进入上下文。扫描消息
  // （而非在 toolUseContext 中跟踪）意味着 compact 会自然
  // 重置计数器 — 旧的附件已从上下文中移除，因此
  // 重新浮现是有效的。
  MAX_SESSION_BYTES: 60 * 1024,
} as const

export const VERIFY_PLAN_REMINDER_CONFIG = {
  TURNS_BETWEEN_REMINDERS: 10,
} as const

export type FileAttachment = {
  type: 'file'
  filename: string
  content: FileReadToolOutput
  /**
   * Whether the file was truncated due to size limits
   */
  truncated?: boolean
  /** 创建时相对于 CWD 的路径，用于稳定显示 */
  displayPath: string
}

export type CompactFileReferenceAttachment = {
  type: 'compact_file_reference'
  filename: string
  /** 创建时相对于 CWD 的路径，用于稳定显示 */
  displayPath: string
}

export type PDFReferenceAttachment = {
  type: 'pdf_reference'
  filename: string
  pageCount: number
  fileSize: number
  /** 创建时相对于 CWD 的路径，用于稳定显示 */
  displayPath: string
}

export type AlreadyReadFileAttachment = {
  type: 'already_read_file'
  filename: string
  content: FileReadToolOutput
  /**
   * Whether the file was truncated due to size limits
   */
  truncated?: boolean
  /** 创建时相对于 CWD 的路径，用于稳定显示 */
  displayPath: string
}

export type AgentMentionAttachment = {
  type: 'agent_mention'
  agentType: string
}

export type AsyncHookResponseAttachment = {
  type: 'async_hook_response'
  processId: string
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  toolName?: string
  response: SyncHookJSONOutput
  stdout: string
  stderr: string
  exitCode?: number
}

export type HookAttachment =
  | HookCancelledAttachment
  | {
      type: 'hook_blocking_error'
      blockingError: HookBlockingError
      hookName: string
      toolUseID: string
      hookEvent: HookEvent
    }
  | HookNonBlockingErrorAttachment
  | HookErrorDuringExecutionAttachment
  | {
      type: 'hook_stopped_continuation'
      message: string
      hookName: string
      toolUseID: string
      hookEvent: HookEvent
    }
  | HookSuccessAttachment
  | {
      type: 'hook_additional_context'
      content: string[]
      hookName: string
      toolUseID: string
      hookEvent: HookEvent
    }
  | HookSystemMessageAttachment
  | HookPermissionDecisionAttachment

export type HookPermissionDecisionAttachment = {
  type: 'hook_permission_decision'
  decision: 'allow' | 'deny'
  toolUseID: string
  hookEvent: HookEvent
}

export type HookSystemMessageAttachment = {
  type: 'hook_system_message'
  content: string
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
}

export type HookCancelledAttachment = {
  type: 'hook_cancelled'
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  command?: string
  durationMs?: number
}

export type HookErrorDuringExecutionAttachment = {
  type: 'hook_error_during_execution'
  content: string
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  command?: string
  durationMs?: number
}

export type HookSuccessAttachment = {
  type: 'hook_success'
  content: string
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  stdout?: string
  stderr?: string
  exitCode?: number
  command?: string
  durationMs?: number
}

export type HookNonBlockingErrorAttachment = {
  type: 'hook_non_blocking_error'
  hookName: string
  stderr: string
  stdout: string
  exitCode: number
  toolUseID: string
  hookEvent: HookEvent
  command?: string
  durationMs?: number
}

export type Attachment =
  /**
   * User at-mentioned the file
   */
  | FileAttachment
  | CompactFileReferenceAttachment
  | PDFReferenceAttachment
  | AlreadyReadFileAttachment
  /**
   * An at-mentioned file was edited
   */
  | {
      type: 'edited_text_file'
      filename: string
      snippet: string
    }
  | {
      type: 'edited_image_file'
      filename: string
      content: FileReadToolOutput
    }
  | {
      type: 'directory'
      path: string
      content: string
      /** 创建时相对于 CWD 的路径，用于稳定显示 */
      displayPath: string
    }
  | {
      type: 'selected_lines_in_ide'
      ideName: string
      lineStart: number
      lineEnd: number
      filename: string
      content: string
      /** 创建时相对于 CWD 的路径，用于稳定显示 */
      displayPath: string
    }
  | {
      type: 'opened_file_in_ide'
      filename: string
    }
  | {
      type: 'todo_reminder'
      content: TodoList
      itemCount: number
    }
  | {
      type: 'task_reminder'
      content: Task[]
      itemCount: number
    }
  | {
      type: 'nested_memory'
      path: string
      content: MemoryFileInfo
      /** 创建时相对于 CWD 的路径，用于稳定显示 */
      displayPath: string
    }
  | {
      type: 'relevant_memories'
      memories: {
        path: string
        content: string
        mtimeMs: number
        /**
         * Pre-computed header string (age + path prefix).  Computed once
         * at attachment-creation time so the rendered bytes are stable
         * across turns — recomputing memoryAge(mtimeMs) at render time
         * calls Date.now(), so "saved 3 days ago" becomes "saved 4 days
         * ago" across turns → different bytes → prompt cache bust.
         * Optional for backward compat with resumed sessions; render
         * path falls back to recomputing if missing.
         */
        header?: string
        /**
         * lineCount when the file was truncated by readMemoriesForSurfacing,
         * else undefined. Threaded to the readFileState write so
         * getChangedFiles skips truncated memories (partial content would
         * yield a misleading diff).
         */
        limit?: number
      }[]
    }
  | {
      type: 'dynamic_skill'
      skillDir: string
      skillNames: string[]
      /** 创建时相对于 CWD 的路径，用于稳定显示 */
      displayPath: string
    }
  | {
      type: 'skill_listing'
      content: string
      skillCount: number
      isInitial: boolean
    }
  | {
      type: 'skill_discovery'
      skills: {
        name: string
        description: string
        shortId?: string
        score?: number
        autoLoaded?: boolean
        content?: string
        path?: string
      }[]
      signal: DiscoverySignal
      source: 'native' | 'aki' | 'both'
      gap?: {
        key: string
        status: 'pending' | 'draft' | 'active'
        draftName?: string
        draftPath?: string
        activeName?: string
        activePath?: string
      }
    }
  | {
      type: 'tool_discovery'
      tools: ToolDiscoveryResult[]
      trigger: 'assistant_turn' | 'user_input'
      queryText: string
      durationMs: number
      indexSize: number
    }
  | {
      type: 'queued_command'
      prompt: string | Array<ContentBlockParam>
      source_uuid?: UUID
      imagePasteIds?: number[]
      /** 原始队列模式 —— 用户消息为 'prompt'，系统事件为 'task-notification' */
      commandMode?: string
      /** 从 QueuedCommand 携带的来源，使中途 drain 保留它 */
      origin?: MessageOrigin
      /** 从 QueuedCommand.isMeta 携带 —— 区分人工输入和系统注入 */
      isMeta?: boolean
    }
  | {
      type: 'output_style'
      style: string
    }
  | {
      type: 'diagnostics'
      files: DiagnosticFile[]
      isNew: boolean
    }
  | {
      type: 'plan_mode'
      reminderType: 'full' | 'sparse'
      isSubAgent?: boolean
      planFilePath: string
      planExists: boolean
    }
  | {
      type: 'plan_mode_reentry'
      planFilePath: string
    }
  | {
      type: 'plan_mode_exit'
      planFilePath: string
      planExists: boolean
    }
  | {
      type: 'auto_mode'
      reminderType: 'full' | 'sparse'
    }
  | {
      type: 'auto_mode_exit'
    }
  | {
      type: 'critical_system_reminder'
      content: string
    }
  | {
      type: 'plan_file_reference'
      planFilePath: string
      planContent: string
    }
  | {
      type: 'mcp_resource'
      server: string
      uri: string
      name: string
      description?: string
      content: ReadResourceResult
    }
  | {
      type: 'command_permissions'
      allowedTools: string[]
      model?: string
    }
  | AgentMentionAttachment
  | {
      type: 'task_status'
      taskId: string
      taskType: TaskType
      status: TaskStatus
      description: string
      deltaSummary: string | null
      outputFilePath?: string
    }
  | AsyncHookResponseAttachment
  | {
      type: 'token_usage'
      used: number
      total: number
      remaining: number
    }
  | {
      type: 'budget_usd'
      used: number
      total: number
      remaining: number
    }
  | {
      type: 'output_token_usage'
      turn: number
      session: number
      budget: number | null
    }
  | {
      type: 'structured_output'
      data: unknown
    }
  | TeammateMailboxAttachment
  | TeamContextAttachment
  | HookAttachment
  | {
      type: 'invoked_skills'
      skills: Array<{
        name: string
        path: string
        content: string
      }>
    }
  | {
      type: 'verify_plan_reminder'
    }
  | {
      type: 'max_turns_reached'
      maxTurns: number
      turnCount: number
    }
  | {
      type: 'current_session_memory'
      content: string
      path: string
      tokenCount: number
    }
  | {
      type: 'teammate_shutdown_batch'
      count: number
    }
  | {
      type: 'compaction_reminder'
    }
  | {
      type: 'context_efficiency'
    }
  | {
      type: 'date_change'
      newDate: string
    }
  | {
      type: 'ultrathink_effort'
      level: 'high'
    }
  | {
      type: 'deferred_tools_delta'
      addedNames: string[]
      addedLines: string[]
      removedNames: string[]
    }
  | {
      type: 'agent_listing_delta'
      addedTypes: string[]
      addedLines: string[]
      removedTypes: string[]
      /** 当本次为会话中的首次公告时为 true */
      isInitial: boolean
      /** 是否包含"并发启动多个 agent"提示（非 pro 订阅） */
      showConcurrencyNote: boolean
    }
  | {
      type: 'mcp_instructions_delta'
      addedNames: string[]
      addedBlocks: string[]
      removedNames: string[]
    }
  | {
      type: 'companion_intro'
      name: string
      species: string
    }
  | {
      type: 'bagel_console'
      errorCount: number
      warningCount: number
      sample: string
    }

export type TeammateMailboxAttachment = {
  type: 'teammate_mailbox'
  messages: Array<{
    from: string
    text: string
    timestamp: string
    color?: string
    summary?: string
  }>
}

export type TeamContextAttachment = {
  type: 'team_context'
  agentId: string
  agentName: string
  teamName: string
  teamConfigPath: string
  taskListPath: string
}

/**
 * 这里实现比较粗糙
 * TODO: 在创建消息时生成 attachments
 */
export async function getAttachments(
  input: string | null,
  toolUseContext: ToolUseContext,
  ideSelection: IDESelection | null,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { skipSkillDiscovery?: boolean },
): Promise<Attachment[]> {
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS) ||
    isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)
  ) {
    // query.ts:removeFromQueue 会在 getAttachmentMessages 运行后
    // 无条件将这些出队 — 在这里返回 [] 会静默丢弃它们。
    // Coworker 以 --bare 模式运行，依赖 task-notification 接收
    // 来自 Local*Task/Remote*Task 的工具调用中期通知。
    return getQueuedCommandAttachments(queuedCommands)
  }

  // 这会降低提交速度
  // TODO: 在用户输入时计算 attachments，而不是在这里（虽然我们
  // 也用此函数处理 slash 命令提示）
  const abortController = createAbortController()
  const timeoutId = setTimeout(ac => ac.abort(), 1000, abortController)
  const context = { ...toolUseContext, abortController }

  const isMainThread = !toolUseContext.agentId

  // 响应用户输入而添加的 attachments
  const userInputAttachments = input
    ? [
        maybe('at_mentioned_files', () =>
          processAtMentionedFiles(input, context),
        ),
        maybe('mcp_resources', () =>
          processMcpResourceAttachments(input, context),
        ),
        maybe('agent_mentions', () =>
          Promise.resolve(
            processAgentMentions(
              input,
              toolUseContext.options.agentDefinitions.activeAgents,
            ),
          ),
        ),
        // 第 0 轮的 skill 发现（以用户输入为信号）。轮间
        // 发现通过 query.ts 中的 startSkillDiscoveryPrefetch 运行，
        // 受写入-转折检测门控 — 参见 skillSearch/prefetch.ts。
        // 这里的 feature() 让 DCE 能从外部构建中移除 'skill_discovery' 字符串
        // （及其调用的函数）。
        //
        // skipSkillDiscovery 门控拦截 SKILL.md-expansion 路径
        // （getMessagesForPromptSlashCommand）。当调用 skill 时，其
        // SKILL.md 内容作为 `input` 传入此处以提取 @-mentions —
        // 但该内容并非用户意图，不应触发发现。
        // 若无此门控，110KB 的 SKILL.md 会在每次 skill 调用时
        // 触发约 3.3s 的分块 AKI 查询（会话 13a9afae）。
        ...(feature('EXPERIMENTAL_SKILL_SEARCH') &&
        skillSearchModules &&
        !options?.skipSkillDiscovery
          ? [
              maybe('skill_discovery', async () => {
                if (suppressNextDiscovery) {
                  suppressNextDiscovery = false
                  return []
                }
                const result =
                  await skillSearchModules.prefetch.getTurnZeroSkillDiscovery(
                    input,
                    messages ?? [],
                    context,
                  )
                return result ? [result] : []
              }),
            ]
          : []),
        // 第 0 轮的工具发现。轮间发现通过
        // query.ts 中的 startSearchExtraToolsPrefetch 运行。
        ...(feature('EXPERIMENTAL_SEARCH_EXTRA_TOOLS') &&
        searchExtraToolsModules &&
        !options?.skipSkillDiscovery
          ? [
              maybe('tool_discovery', async () => {
                if (suppressNextDiscovery) {
                  return []
                }
                const result =
                  await searchExtraToolsModules.prefetch.getTurnZeroSearchExtraToolsPrefetch(
                    input,
                    context.options.tools ?? [],
                  )
                return result ? [result] : []
              }),
            ]
          : []),
      ]
    : []

  // 先处理用户输入的 attachments（包括 @提及的文件）
  // 这确保文件在 nested_memory 处理它们之前已被加入 nestedMemoryAttachmentTriggers
  const userAttachmentResults = await Promise.all(userInputAttachments)

  // 子 agent 中可用的线程安全 attachments
  // 注意：这些必须在 userInputAttachments 完成后创建，以确保
  // 在 getNestedMemoryAttachments 运行前 nestedMemoryAttachmentTriggers 已填充
  const allThreadAttachments = [
    // queuedCommands 已由 query.ts 中的 drain gate 按 agent 作用域划分 —
    // 主线程获得 agentId===undefined，子 agent 获得各自的 agentId。
    // 必须对所有线程运行，否则子 agent 通知会消失到虚空
    // （被 removeFromQueue 移出队列但从未附加）。
    maybe('queued_commands', () => getQueuedCommandAttachments(queuedCommands)),
    maybe('date_change', () =>
      Promise.resolve(getDateChangeAttachments(messages)),
    ),
    maybe('ultrathink_effort', () =>
      Promise.resolve(getUltrathinkEffortAttachment(input)),
    ),
    maybe('deferred_tools_delta', () =>
      Promise.resolve(
        getDeferredToolsDeltaAttachment(
          toolUseContext.options.tools,
          toolUseContext.options.mainLoopModel,
          messages,
          {
            callSite: isMainThread
              ? 'attachments_main'
              : 'attachments_subagent',
            querySource,
          },
        ),
      ),
    ),
    maybe('agent_listing_delta', () =>
      Promise.resolve(getAgentListingDeltaAttachment(toolUseContext, messages)),
    ),
    maybe('mcp_instructions_delta', () =>
      Promise.resolve(
        getMcpInstructionsDeltaAttachment(
          toolUseContext.options.mcpClients,
          toolUseContext.options.tools,
          toolUseContext.options.mainLoopModel,
          messages,
        ),
      ),
    ),
    ...(feature('BUDDY')
      ? [
          maybe('companion_intro', () =>
            Promise.resolve(getCompanionIntroAttachment(messages)),
          ),
        ]
      : []),
    maybe('changed_files', () => getChangedFiles(context)),
    maybe('nested_memory', () => getNestedMemoryAttachments(context)),
    // relevant_memories 已迁移到异步预取（startRelevantMemoryPrefetch）
    maybe('dynamic_skill', () => getDynamicSkillAttachments(context)),
    maybe('skill_listing', () => getSkillListingAttachments(context)),
    // 轮间 skill 发现现在通过 startSkillDiscoveryPrefetch 运行
    // （query.ts，与主轮并发）。此前位于此处的阻塞调用是
    // assistant_turn 信号 — 生产环境中 97% 的 Haiku 调用
    // 什么都没找到。预取 + 收集时 await
    // 替代了它；参见 src/services/skillSearch/prefetch.ts。
    maybe('plan_mode', () => getPlanModeAttachments(messages, toolUseContext)),
    maybe('plan_mode_exit', () => getPlanModeExitAttachment(toolUseContext)),
    ...(feature('TRANSCRIPT_CLASSIFIER')
      ? [
          maybe('auto_mode', () =>
            getAutoModeAttachments(messages, toolUseContext),
          ),
          maybe('auto_mode_exit', () =>
            getAutoModeExitAttachment(toolUseContext),
          ),
        ]
      : []),
    maybe('todo_reminders', () =>
      isTodoV2Enabled()
        ? getTaskReminderAttachments(messages, toolUseContext)
        : getTodoReminderAttachments(messages, toolUseContext),
    ),
    ...(isAgentSwarmsEnabled()
      ? [
          // 对 session_memory 分叉的 agent 跳过 teammate mailbox。
          // 它与 leader 共享 AppState.teamContext，因此 isTeamLead 解析为
          // true，并将 leader 的 DM 作为临时附件读取并标记为已读，
          // 静默窃取了本应作为永久轮次投递的消息。
          ...(querySource === 'session_memory'
            ? []
            : [
                maybe('teammate_mailbox', async () =>
                  getTeammateMailboxAttachments(toolUseContext),
                ),
              ]),
          maybe('team_context', async () =>
            getTeamContextAttachment(messages ?? []),
          ),
        ]
      : []),
    maybe('agent_pending_messages', async () =>
      getAgentPendingMessageAttachments(toolUseContext),
    ),
    maybe('critical_system_reminder', () =>
      Promise.resolve(getCriticalSystemReminderAttachment(toolUseContext)),
    ),
    ...(feature('COMPACTION_REMINDERS')
      ? [
          maybe('compaction_reminder', () =>
            Promise.resolve(
              getCompactionReminderAttachment(
                messages ?? [],
                toolUseContext.options.mainLoopModel,
              ),
            ),
          ),
        ]
      : []),
    ...(feature('HISTORY_SNIP')
      ? [
          maybe('context_efficiency', () =>
            Promise.resolve(getContextEfficiencyAttachment(messages ?? [])),
          ),
        ]
      : []),
  ]

  // 语义上仅用于主会话或没有并发安全实现的 attachments
  const mainThreadAttachments = isMainThread
    ? [
        maybe('ide_selection', async () =>
          getSelectedLinesFromIDE(ideSelection, toolUseContext),
        ),
        maybe('ide_opened_file', async () =>
          getOpenedFileFromIDE(ideSelection, toolUseContext),
        ),
        maybe('output_style', async () =>
          Promise.resolve(getOutputStyleAttachment()),
        ),
        maybe('diagnostics', async () =>
          getDiagnosticAttachments(toolUseContext),
        ),
        maybe('lsp_diagnostics', async () =>
          getLSPDiagnosticAttachments(toolUseContext),
        ),
        maybe('unified_tasks', async () =>
          getUnifiedTaskAttachments(toolUseContext),
        ),
        maybe('async_hook_responses', async () =>
          getAsyncHookResponseAttachments(),
        ),
        maybe('token_usage', async () =>
          Promise.resolve(
            getTokenUsageAttachment(
              messages ?? [],
              toolUseContext.options.mainLoopModel,
            ),
          ),
        ),
        maybe('budget_usd', async () =>
          Promise.resolve(
            getMaxBudgetUsdAttachment(toolUseContext.options.maxBudgetUsd),
          ),
        ),
        maybe('output_token_usage', async () =>
          Promise.resolve(getOutputTokenUsageAttachment()),
        ),
        maybe('verify_plan_reminder', async () =>
          getVerifyPlanReminderAttachment(messages, toolUseContext),
        ),
      ]
    : []

  // 并行处理线程和主线程 attachments（它们之间无依赖关系）
  const [threadAttachmentResults, mainThreadAttachmentResults] =
    await Promise.all([
      Promise.all(allThreadAttachments),
      Promise.all(mainThreadAttachments),
    ])

  clearTimeout(timeoutId)
  // 防御性编程：若 getter 泄漏了 [undefined]，会导致下方的 .map(a => a.type) 崩溃。
  return (
    [
      ...userAttachmentResults.flat(),
      ...threadAttachmentResults.flat(),
      ...mainThreadAttachmentResults.flat(),
    ] as Attachment[]
  ).filter(a => a !== undefined && a !== null)
}

async function maybe<A>(label: string, f: () => Promise<A[]>): Promise<A[]> {
  const startTime = Date.now()
  try {
    const result = await f()
    const duration = Date.now() - startTime
    // 仅记录 5% 的事件以减少数据量
    if (Math.random() < 0.05) {
      // jsonStringify(undefined) 返回 undefined，因此 .length 会抛出异常
      const attachmentSizeBytes = result
        .filter(a => a !== undefined && a !== null)
        .reduce((total, attachment) => {
          return total + jsonStringify(attachment).length
        }, 0)
      logEvent('tengu_attachment_compute_duration', {
        label,
        duration_ms: duration,
        attachment_size_bytes: attachmentSizeBytes,
        attachment_count: result.length,
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    }
    return result
  } catch (e) {
    const duration = Date.now() - startTime
    // 仅记录 5% 的事件以减少数据量
    if (Math.random() < 0.05) {
      logEvent('tengu_attachment_compute_duration', {
        label,
        duration_ms: duration,
        error: true,
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    }
    logError(e)
    // 对 Ant 用户，记录完整错误以帮助调试
    logAntError(`Attachment error in ${label}`, e)

    return []
  }
}

const INLINE_NOTIFICATION_MODES = new Set(['prompt', 'task-notification'])

export async function getQueuedCommandAttachments(
  queuedCommands: QueuedCommand[],
): Promise<Attachment[]> {
  if (!queuedCommands) {
    return []
  }
  // 将 'prompt' 和 'task-notification' 命令都作为 attachments 包含进来。
  // 在主动式 agentic 循环期间，task-notification 命令否则会
  // 永久停留在队列中（query 激活时 useQueueProcessor 无法运行），
  // 导致 hasPendingNotifications() 返回 true，使 Sleep
  // 以 0ms 时长立即唤醒，形成无限循环。
  const filtered = queuedCommands.filter(_ =>
    INLINE_NOTIFICATION_MODES.has(_.mode),
  )
  return Promise.all(
    filtered.map(async _ => {
      const imageBlocks = await buildImageContentBlocks(_.pastedContents)
      let prompt: string | Array<ContentBlockParam> = _.value
      if (imageBlocks.length > 0) {
        // 构建包含文本 + 图片的内容块数组，让模型能看到它们
        const textValue =
          typeof _.value === 'string'
            ? _.value
            : extractTextContent(_.value, '\n')
        prompt = [{ type: 'text' as const, text: textValue }, ...imageBlocks]
      }
      return {
        type: 'queued_command' as const,
        prompt,
        source_uuid: _.uuid,
        imagePasteIds: getImagePasteIds(_.pastedContents),
        commandMode: _.mode,
        origin: _.origin,
        isMeta: _.isMeta,
      }
    }),
  )
}

export function getAgentPendingMessageAttachments(
  toolUseContext: ToolUseContext,
): Attachment[] {
  const agentId = toolUseContext.agentId
  if (!agentId) return []
  const drained = drainPendingMessages(
    agentId,
    toolUseContext.getAppState,
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState,
  )
  return drained.map(msg => ({
    type: 'queued_command' as const,
    prompt: msg,
    origin: { kind: 'coordinator' as const } as unknown as MessageOrigin,
    isMeta: true,
  }))
}

async function buildImageContentBlocks(
  pastedContents: Record<number, PastedContent> | undefined,
): Promise<ImageBlockParam[]> {
  if (!pastedContents) {
    return []
  }
  const imageContents = Object.values(pastedContents).filter(isValidImagePaste)
  if (imageContents.length === 0) {
    return []
  }
  const results = await Promise.all(
    imageContents.map(async img => {
      const imageBlock: ImageBlockParam = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: (img.mediaType ||
            'image/png') as Base64ImageSource['media_type'],
          data: img.content,
        },
      }
      const resized = await maybeResizeAndDownsampleImageBlock(imageBlock)
      return resized.block
    }),
  )
  return results
}

function getPlanModeAttachmentTurnCount(messages: Message[]): {
  turnCount: number
  foundPlanModeAttachment: boolean
} {
  let turnsSinceLastAttachment = 0
  let foundPlanModeAttachment = false

  // 向后迭代以找到最近的 plan_mode attachment。
  // 计数 HUMAN 轮次（非 meta、非工具结果的 user 消息），而不是 assistant
  // 消息 — query.ts 中的工具循环在每轮
  // 工具调用时都会调用 getAttachmentMessages，因此若计数 assistant 消息会每
  // 5 次工具调用触发一次提醒，而不是每 5 个人类轮次。
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (
      message?.type === 'user' &&
      !message.isMeta &&
      !hasToolResultContent(message.message!.content)
    ) {
      turnsSinceLastAttachment++
    } else if (
      message?.type === 'attachment' &&
      (message.attachment!.type === 'plan_mode' ||
        message.attachment!.type === 'plan_mode_reentry')
    ) {
      foundPlanModeAttachment = true
      break
    }
  }

  return { turnCount: turnsSinceLastAttachment, foundPlanModeAttachment }
}

/**
 * 计数自上次 plan_mode_exit 以来的 plan_mode attachments 数量（若无 exit 则从开头计）。
 * 这确保了重新进入 plan 模式时 full/sparse 循环会重置。
 */
function countPlanModeAttachmentsSinceLastExit(messages: Message[]): number {
  let count = 0
  // 向后迭代 - 若遇到 plan_mode_exit 则停止计数
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'attachment') {
      if (message.attachment!.type === 'plan_mode_exit') {
        break // 在最后一次 exit 时停止计数
      }
      if (message.attachment!.type === 'plan_mode') {
        count++
      }
    }
  }
  return count
}

async function getPlanModeAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState()
  const permissionContext = appState.toolPermissionContext
  if (permissionContext.mode !== 'plan') {
    return []
  }

  // 检查是否应根据轮次计数附加（首轮除外）
  if (messages && messages.length > 0) {
    const { turnCount, foundPlanModeAttachment } =
      getPlanModeAttachmentTurnCount(messages)
    // 仅在之前已发送过 plan_mode attachment 时进行节流
    // plan 模式首轮始终附加
    if (
      foundPlanModeAttachment &&
      turnCount < PLAN_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS
    ) {
      return []
    }
  }

  const planFilePath = getPlanFilePath(toolUseContext.agentId)
  const existingPlan = getPlan(toolUseContext.agentId)

  const attachments: Attachment[] = []

  // 检查是否为重新进入：标志已设置且计划文件存在
  if (hasExitedPlanModeInSession() && existingPlan !== null) {
    attachments.push({ type: 'plan_mode_reentry', planFilePath })
    setHasExitedPlanMode(false) // 清除标志 - 一次性指引
  }

  // 判断应该是 full 还是 sparse 提醒
  // full 提醒出现在第 1、6、11 次...（每 N 次 attachment）
  const attachmentCount =
    countPlanModeAttachmentsSinceLastExit(messages ?? []) + 1
  const reminderType: 'full' | 'sparse' =
    attachmentCount %
      PLAN_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS ===
    1
      ? 'full'
      : 'sparse'

  // 始终添加主 plan_mode attachment
  attachments.push({
    type: 'plan_mode',
    reminderType,
    isSubAgent: !!toolUseContext.agentId,
    planFilePath,
    planExists: existingPlan !== null,
  })

  return attachments
}

/**
 * 若刚刚退出 plan 模式则返回 plan_mode_exit attachment。
 * 这是一次性通知，告知模型已不再处于 plan 模式。
 */
async function getPlanModeExitAttachment(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // 仅在标志已设置时触发（即刚刚退出 plan 模式）
  if (!needsPlanModeExitAttachment()) {
    return []
  }

  const appState = toolUseContext.getAppState()
  if (appState.toolPermissionContext.mode === 'plan') {
    setNeedsPlanModeExitAttachment(false)
    return []
  }

  // 清除标志 - 这是一次性通知
  setNeedsPlanModeExitAttachment(false)

  const planFilePath = getPlanFilePath(toolUseContext.agentId)
  const planExists = getPlan(toolUseContext.agentId) !== null

  // 注意：skill discovery 不会在 plan 退出时触发。当计划被
  // 写入时已经太晚了 — 模型应该在规划期间就拥有相关 skills。
  // user_message 信号已在触发规划的请求上
  // （"plan how to deploy this"）时就已触发，那才是正确的时机。
  return [{ type: 'plan_mode_exit', planFilePath, planExists }]
}

function getAutoModeAttachmentTurnCount(messages: Message[]): {
  turnCount: number
  foundAutoModeAttachment: boolean
} {
  let turnsSinceLastAttachment = 0
  let foundAutoModeAttachment = false

  // 向后迭代以找到最近的 auto_mode attachment。
  // 计数 HUMAN 轮次（非 meta、非工具结果的 user 消息），而不是 assistant
  // 消息 — query.ts 中的工具循环在每轮
  // 工具调用时都会调用 getAttachmentMessages，因此如果计数 assistant 消息，
  // 一个包含 100 次工具调用的人类轮次会触发约 20 次
  // 提醒。auto 模式的目标使用场景是
  // 长时 agentic 会话，此前每个会话累计触发 60-105 次。
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (
      message?.type === 'user' &&
      !message.isMeta &&
      !hasToolResultContent(message.message!.content)
    ) {
      turnsSinceLastAttachment++
    } else if (
      message?.type === 'attachment' &&
      message.attachment!.type === 'auto_mode'
    ) {
      foundAutoModeAttachment = true
      break
    } else if (
      message?.type === 'attachment' &&
      message.attachment!.type === 'auto_mode_exit'
    ) {
      // Exit 会重置节流 — 视为之前不存在 attachment
      break
    }
  }

  return { turnCount: turnsSinceLastAttachment, foundAutoModeAttachment }
}

/**
 * 计数自上次 auto_mode_exit 以来的 auto_mode attachments 数量（若无 exit 则从开头计）。
 * 这确保了重新进入 auto 模式时 full/sparse 循环会重置。
 */
function countAutoModeAttachmentsSinceLastExit(messages: Message[]): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'attachment') {
      if (message.attachment!.type === 'auto_mode_exit') {
        break
      }
      if (message.attachment!.type === 'auto_mode') {
        count++
      }
    }
  }
  return count
}

async function getAutoModeAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState()
  const permissionContext = appState.toolPermissionContext
  const inAuto = permissionContext.mode === 'auto'
  const inPlanWithAuto =
    permissionContext.mode === 'plan' &&
    (autoModeStateModule?.isAutoModeActive() ?? false)
  if (!inAuto && !inPlanWithAuto) {
    return []
  }

  // 根据轮次数检查是否应该附加（第一轮除外）
  if (messages && messages.length > 0) {
    const { turnCount, foundAutoModeAttachment } =
      getAutoModeAttachmentTurnCount(messages)
    // 仅在已发送过 auto_mode 附件后才进行节流
    // 在 auto 模式的第一轮，始终附加
    if (
      foundAutoModeAttachment &&
      turnCount < AUTO_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS
    ) {
      return []
    }
  }

  // 确定这应该是完整提醒还是稀疏提醒
  const attachmentCount =
    countAutoModeAttachmentsSinceLastExit(messages ?? []) + 1
  const reminderType: 'full' | 'sparse' =
    attachmentCount %
      AUTO_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS ===
    1
      ? 'full'
      : 'sparse'

  return [{ type: 'auto_mode', reminderType }]
}

/**
 * 如果刚退出 auto 模式则返回 auto_mode_exit 附件。
 * 这是一次性通知，告知模型它不再处于 auto 模式。
 */
async function getAutoModeExitAttachment(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!needsAutoModeExitAttachment()) {
    return []
  }

  const appState = toolUseContext.getAppState()
  // 当 auto 仍然活跃时抑制 —— 涵盖 mode==='auto' 和
  // plan-with-auto-active（其中 mode==='plan' 但分类器运行）。
  if (
    appState.toolPermissionContext.mode === 'auto' ||
    (autoModeStateModule?.isAutoModeActive() ?? false)
  ) {
    setNeedsAutoModeExitAttachment(false)
    return []
  }

  setNeedsAutoModeExitAttachment(false)
  return [{ type: 'auto_mode_exit' }]
}

/**
 * 检测本地日期是否在上次轮次后发生了变化（用户编程超过午夜），
 * 并发出附件通知模型。
 *
 * date_change 附件追加在对话末尾，
 * 使模型在不改变缓存前缀的情况下得知新日期。
 * messages[0]（来自 getUserContext → prependUserContext）有意保留旧日期
 * —— 清除该缓存会重新生成前缀，并在下一轮使整个对话变为
 * cache_creation（每次跨午夜约 920K 有效 tokens）。
 *
 * 导出用于测试 —— 缓存清除移除的回归保护。
 */
export function getDateChangeAttachments(
  messages: Message[] | undefined,
): Attachment[] {
  const currentDate = getLocalISODate()
  const lastDate = getLastEmittedDate()

  if (lastDate === null) {
    // 第一轮 —— 只记录，不需要附件
    setLastEmittedDate(currentDate)
    return []
  }

  if (currentDate === lastDate) {
    return []
  }

  setLastEmittedDate(currentDate)

  // 助手模式：将昨天的转录刷新到每日文件中，
  // 使 /dream 技能（本地时间 1-5am）即使今天没有压缩触发也能找到它。
  // Fire-and-forget；writeSessionTranscriptSegment 按消息时间戳分桶，
  // 使多日间隔能正确刷新每一天。
  if (feature('KAIROS')) {
    if (getKairosActive() && messages !== undefined) {
      sessionTranscriptModule?.flushOnDateChange(messages, currentDate)
    }
  }

  return [{ type: 'date_change', newDate: currentDate }]
}

function getUltrathinkEffortAttachment(input: string | null): Attachment[] {
  if (!isUltrathinkEnabled() || !input || !hasUltrathinkKeyword(input)) {
    return []
  }
  logEvent('tengu_ultrathink', {})
  return [{ type: 'ultrathink_effort', level: 'high' }]
}

// 导出给 compact.ts —— 两个调用点的门控必须相同。
export function getDeferredToolsDeltaAttachment(
  tools: Tools,
  model: string,
  messages: Message[] | undefined,
  scanContext?: DeferredToolsDeltaScanContext,
): Attachment[] {
  if (!isDeferredToolsDeltaEnabled()) return []
  // 这三个检查镜像了 isSearchExtraToolsEnabled 的同步部分 ——
  // 附件文本说"通过 SearchExtraTools 可用"，因此 SearchExtraTools
  // 必须实际存在于请求中。异步自动阈值检查未被复制
  //（会导致 tengu_search_extra_tools_mode_decision 触发两次）；
  // 在 tst-auto 低于阈值时，附件可能触发而 SearchExtraTools 被过滤掉，
  // 但这是极少数情况，且宣布的工具无论如何都可以直接调用。
  if (!isSearchExtraToolsEnabledOptimistic()) return []
  if (!isSearchExtraToolsToolAvailable(tools)) return []
  const delta = getDeferredToolsDelta(tools, messages ?? [], scanContext)
  if (!delta) return []
  return [{ type: 'deferred_tools_delta', ...delta }]
}

/**
 * 将当前经过过滤的 agent 池与此对话中已宣布的内容进行对比
 *（从先前的 agent_listing_delta 附件重建）。
 * 如果没有变化或门控关闭，则返回 []。
 *
 * agent 列表曾嵌入在 AgentTool 的描述中，导致约 10.2% 的
 * fleet cache_creation：MCP 异步连接、/reload-plugins 或
 * 权限模式变更 → 描述变化 → 完整 tool-schema 缓存失效。
 * 将列表移到这里使工具描述保持静态。
 *
 * 导出给 compact.ts —— 在压缩消耗先前 delta 后重新宣布完整集合。
 */
export function getAgentListingDeltaAttachment(
  toolUseContext: ToolUseContext,
  messages: Message[] | undefined,
): Attachment[] {
  if (!shouldInjectAgentListInMessages()) return []

  // 如果 AgentTool 不在工具池中则跳过 —— 列表将无法操作。
  if (
    !toolUseContext.options.tools.some(t => toolMatchesName(t, AGENT_TOOL_NAME))
  ) {
    return []
  }

  const { activeAgents, allowedAgentTypes } =
    toolUseContext.options.agentDefinitions

  // 镜像 AgentTool.prompt() 的过滤：MCP 要求 → 拒绝规则 →
  // allowedAgentTypes 限制。保持与 AgentTool.tsx 的同步。
  const mcpServers = new Set<string>()
  for (const tool of toolUseContext.options.tools) {
    const info = mcpInfoFromString(tool.name)
    if (info) mcpServers.add(info.serverName)
  }
  const permissionContext = toolUseContext.getAppState().toolPermissionContext
  let filtered = filterDeniedAgents(
    filterAgentsByMcpRequirements(activeAgents, [...mcpServers]),
    permissionContext,
    AGENT_TOOL_NAME,
  )
  if (allowedAgentTypes) {
    filtered = filtered.filter(a => allowedAgentTypes.includes(a.agentType))
  }

  // 从转录中先前的 delta 重建已宣布的集合。
  const announced = new Set<string>()
  for (const msg of messages ?? []) {
    if (msg.type !== 'attachment') continue
    if (msg.attachment!.type !== 'agent_listing_delta') continue
    for (const t of msg.attachment!.addedTypes as string[]) announced.add(t)
    for (const t of msg.attachment!.removedTypes as string[])
      announced.delete(t)
  }

  const currentTypes = new Set(filtered.map(a => a.agentType))
  const added = filtered.filter(a => !announced.has(a.agentType))
  const removed: string[] = []
  for (const t of announced) {
    if (!currentTypes.has(t)) removed.push(t)
  }

  if (added.length === 0 && removed.length === 0) return []

  // 排序以确保确定性输出 —— agent 加载顺序是不确定的
  //（插件加载竞争、MCP 异步连接）。
  added.sort((a, b) => a.agentType.localeCompare(b.agentType))
  removed.sort()

  return [
    {
      type: 'agent_listing_delta',
      addedTypes: added.map(a => a.agentType),
      addedLines: added.map(formatAgentLine),
      removedTypes: removed,
      isInitial: announced.size === 0,
      showConcurrencyNote: getSubscriptionType() !== 'pro',
    },
  ]
}

// 导出给 compact.ts / reactiveCompact.ts —— 门控的单一真相来源。
export function getMcpInstructionsDeltaAttachment(
  mcpClients: MCPServerConnection[],
  tools: Tools,
  model: string,
  messages: Message[] | undefined,
): Attachment[] {
  if (!isMcpInstructionsDeltaEnabled()) return []

  // chrome SearchExtraTools 提示由客户端创建且依赖 SearchExtraTools；
  // 实际服务器 `instructions` 则是无条件的。在这里决定 chrome 部分，
  // 作为合成条目传入纯 diff。
  const clientSide: ClientSideInstruction[] = []
  if (
    isSearchExtraToolsEnabledOptimistic() &&
    isSearchExtraToolsToolAvailable(tools)
  ) {
    clientSide.push({
      serverName: CLAUDE_IN_CHROME_MCP_SERVER_NAME,
      block: CHROME_SEARCH_EXTRA_TOOLS_INSTRUCTIONS,
    })
  }

  const delta = getMcpInstructionsDelta(mcpClients, messages ?? [], clientSide)
  if (!delta) return []
  return [{ type: 'mcp_instructions_delta', ...delta }]
}

function getCriticalSystemReminderAttachment(
  toolUseContext: ToolUseContext,
): Attachment[] {
  const reminder = toolUseContext.criticalSystemReminder_EXPERIMENTAL
  if (!reminder) {
    return []
  }
  return [{ type: 'critical_system_reminder', content: reminder }]
}

function getOutputStyleAttachment(): Attachment[] {
  const settings = getSettings_DEPRECATED()
  const outputStyle = settings?.outputStyle || 'default'

  // 仅对非默认样式显示
  if (outputStyle === 'default') {
    return []
  }

  return [
    {
      type: 'output_style',
      style: outputStyle,
    },
  ]
}

async function getSelectedLinesFromIDE(
  ideSelection: IDESelection | null,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const ideName = getConnectedIdeName(toolUseContext.options.mcpClients)
  if (
    !ideName ||
    ideSelection?.lineStart === undefined ||
    !ideSelection.text ||
    !ideSelection.filePath
  ) {
    return []
  }

  const appState = toolUseContext.getAppState()
  if (isFileReadDenied(ideSelection.filePath, appState.toolPermissionContext)) {
    return []
  }

  return [
    {
      type: 'selected_lines_in_ide',
      ideName,
      lineStart: ideSelection.lineStart,
      lineEnd: ideSelection.lineStart + ideSelection.lineCount - 1,
      filename: ideSelection.filePath,
      content: ideSelection.text,
      displayPath: relative(getCwd(), ideSelection.filePath),
    },
  ]
}

/**
 * 计算嵌套内存文件加载需要处理的目录。
 * 返回两个列表：
 * - nestedDirs：CWD 与 targetPath 之间的目录（处理 CLAUDE.md + 所有规则）
 * - cwdLevelDirs：从根目录到 CWD 的目录（仅处理条件规则）
 *
 * @param targetPath 目标文件路径
 * @param originalCwd 原始当前工作目录
 * @returns 包含 nestedDirs 和 cwdLevelDirs 数组的对象，均按从父到子排序
 */
export function getDirectoriesToProcess(
  targetPath: string,
  originalCwd: string,
): { nestedDirs: string[]; cwdLevelDirs: string[] } {
  // 构建从原始 CWD 到 targetPath 目录的目录列表
  const targetDir = dirname(resolve(targetPath))
  const nestedDirs: string[] = []
  let currentDir = targetDir

  // 从目标目录向上遍历到原始 CWD
  while (currentDir !== originalCwd && currentDir !== parse(currentDir).root) {
    if (currentDir.startsWith(originalCwd)) {
      nestedDirs.push(currentDir)
    }
    currentDir = dirname(currentDir)
  }

  // 反转以获得从 CWD 到目标的顺序
  nestedDirs.reverse()

  // 构建从根目录到 CWD 的目录列表（仅条件规则）
  const cwdLevelDirs: string[] = []
  currentDir = originalCwd

  while (currentDir !== parse(currentDir).root) {
    cwdLevelDirs.push(currentDir)
    currentDir = dirname(currentDir)
  }

  // 反转以获得从根目录到 CWD 的顺序
  cwdLevelDirs.reverse()

  return { nestedDirs, cwdLevelDirs }
}

/**
 * 将内存文件转换为附件，过滤掉已加载的文件。
 *
 * @param memoryFiles 要转换的内存文件
 * @param toolUseContext 工具使用上下文（用于跟踪已加载文件）
 * @returns 嵌套内存附件数组
 */
function isInstructionsMemoryType(
  type: MemoryFileInfo['type'],
): type is InstructionsMemoryType {
  return (
    type === 'User' ||
    type === 'Project' ||
    type === 'Local' ||
    type === 'Managed'
  )
}

/** 导出用于测试 —— LRU 淘汰重注入的回归保护。 */
export function memoryFilesToAttachments(
  memoryFiles: MemoryFileInfo[],
  toolUseContext: ToolUseContext,
  triggerFilePath?: string,
): Attachment[] {
  const attachments: Attachment[] = []
  const shouldFireHook = hasInstructionsLoadedHook()

  for (const memoryFile of memoryFiles) {
    // 去重：loadedNestedMemoryPaths 是非淘汰的 Set；readFileState
    // 是 100 条目的 LRU，在繁忙会话中会丢弃条目，单独依赖它
    // 会在每次淘汰周期重注入相同的 CLAUDE.md。
    if (toolUseContext.loadedNestedMemoryPaths?.has(memoryFile.path)) {
      continue
    }
    if (!toolUseContext.readFileState.has(memoryFile.path)) {
      attachments.push({
        type: 'nested_memory',
        path: memoryFile.path,
        content: memoryFile,
        displayPath: relative(getCwd(), memoryFile.path),
      })
      toolUseContext.loadedNestedMemoryPaths?.add(memoryFile.path)

      // 在 readFileState 中标记为已加载 —— 这通过上方的 .has() 检查
      // 提供跨函数和跨轮次的去重。
      //
      // 当注入内容与磁盘不匹配时（剥离的 HTML 注释、
      // 剥离的前置内容、截断的 MEMORY.md），使用 `isPartialView: true`
      // 缓存原始磁盘字节。Edit/Write 看到该标志时需要先进行真实 Read；
      // getChangedFiles 看到真实内容 + undefined offset/limit，
      // 使会话中途的变更检测仍然有效。
      toolUseContext.readFileState.set(memoryFile.path, {
        content: memoryFile.contentDiffersFromDisk
          ? (memoryFile.rawContent ?? memoryFile.content)
          : memoryFile.content,
        timestamp: Date.now(),
        offset: undefined,
        limit: undefined,
        isPartialView: memoryFile.contentDiffersFromDisk,
      })

      // 触发 InstructionsLoaded 钩子用于审计/可观测性（fire-and-forget）
      if (shouldFireHook && isInstructionsMemoryType(memoryFile.type)) {
        const loadReason = memoryFile.globs
          ? 'path_glob_match'
          : memoryFile.parent
            ? 'include'
            : 'nested_traversal'
        void executeInstructionsLoadedHooks(
          memoryFile.path,
          memoryFile.type,
          loadReason,
          {
            globs: memoryFile.globs,
            triggerFilePath,
            parentFilePath: memoryFile.parent,
          },
        )
      }
    }
  }

  return attachments
}

/**
 * 为给定文件路径加载嵌套内存文件并作为附件返回。
 * 此函数执行目录遍历以查找适用于目标文件路径的 CLAUDE.md 文件和条件规则。
 *
 * 处理顺序（必须保留）：
 * 1. 匹配 targetPath 的 Managed/User 条件规则
 * 2. 嵌套目录（CWD → 目标）：CLAUDE.md + 无条件规则 + 条件规则
 * 3. CWD 级目录（根目录 → CWD）：仅条件规则
 *
 * @param filePath 要获取嵌套内存文件的文件路径
 * @param toolUseContext 工具使用上下文
 * @param appState 包含工具权限上下文的应用状态
 * @returns 嵌套内存附件数组
 */
async function getNestedMemoryAttachmentsForFile(
  filePath: string,
  toolUseContext: ToolUseContext,
  appState: { toolPermissionContext: ToolPermissionContext },
): Promise<Attachment[]> {
  const attachments: Attachment[] = []

  try {
    // 如果路径不在允许的工作路径中则提前返回
    if (!pathInAllowedWorkingPath(filePath, appState.toolPermissionContext)) {
      return attachments
    }

    const processedPaths = new Set<string>()
    const originalCwd = getOriginalCwd()

    // 阶段 1：处理 Managed 和 User 条件规则
    const managedUserRules = await getManagedAndUserConditionalRules(
      filePath,
      processedPaths,
    )
    attachments.push(
      ...memoryFilesToAttachments(managedUserRules, toolUseContext, filePath),
    )

    // 阶段 2：获取需要处理的目录
    const { nestedDirs, cwdLevelDirs } = getDirectoriesToProcess(
      filePath,
      originalCwd,
    )

    const skipProjectLevel = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_paper_halyard',
      false,
    )

    // 阶段 3：处理嵌套目录（CWD → 目标）
    // 每个目录处理：CLAUDE.md + 无条件规则 + 条件规则
    for (const dir of nestedDirs) {
      const memoryFiles = (
        await getMemoryFilesForNestedDirectory(dir, filePath, processedPaths)
      ).filter(
        f => !skipProjectLevel || (f.type !== 'Project' && f.type !== 'Local'),
      )
      attachments.push(
        ...memoryFilesToAttachments(memoryFiles, toolUseContext, filePath),
      )
    }

    // 阶段 4：处理 CWD 级目录（根目录 → CWD）
    // 仅处理条件规则（无条件规则已被预先加载）
    for (const dir of cwdLevelDirs) {
      const conditionalRules = (
        await getConditionalRulesForCwdLevelDirectory(
          dir,
          filePath,
          processedPaths,
        )
      ).filter(
        f => !skipProjectLevel || (f.type !== 'Project' && f.type !== 'Local'),
      )
      attachments.push(
        ...memoryFilesToAttachments(conditionalRules, toolUseContext, filePath),
      )
    }
  } catch (error) {
    logError(error)
  }

  return attachments
}

async function getOpenedFileFromIDE(
  ideSelection: IDESelection | null,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!ideSelection?.filePath || ideSelection.text) {
    return []
  }

  const appState = toolUseContext.getAppState()
  if (isFileReadDenied(ideSelection.filePath, appState.toolPermissionContext)) {
    return []
  }

  // 获取嵌套内存文件
  const nestedMemoryAttachments = await getNestedMemoryAttachmentsForFile(
    ideSelection.filePath,
    toolUseContext,
    appState,
  )

  // 返回嵌套内存附件，然后是打开的文件附件
  return [
    ...nestedMemoryAttachments,
    {
      type: 'opened_file_in_ide',
      filename: ideSelection.filePath,
    },
  ]
}

async function processAtMentionedFiles(
  input: string,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const files = extractAtMentionedFiles(input)
  if (files.length === 0) return []

  const appState = toolUseContext.getAppState()
  const results = await Promise.all(
    files.map(async file => {
      try {
        const { filename, lineStart, lineEnd } = parseAtMentionedFileLines(file)
        const absoluteFilename = expandPath(filename)

        if (
          isFileReadDenied(absoluteFilename, appState.toolPermissionContext)
        ) {
          return null
        }

        // 检查是否为目录
        try {
          const stats = await stat(absoluteFilename)
          if (stats.isDirectory()) {
            try {
              const entries = await readdir(absoluteFilename, {
                withFileTypes: true,
              })
              const MAX_DIR_ENTRIES = 1000
              const truncated = entries.length > MAX_DIR_ENTRIES
              const names = entries.slice(0, MAX_DIR_ENTRIES).map(e => e.name)
              if (truncated) {
                names.push(
                  `\u2026 and ${entries.length - MAX_DIR_ENTRIES} more entries`,
                )
              }
              const stdout = names.join('\n')
              logEvent('tengu_at_mention_extracting_directory_success', {})

              return {
                type: 'directory' as const,
                path: absoluteFilename,
                content: stdout,
                displayPath: relative(getCwd(), absoluteFilename),
              }
            } catch {
              return null
            }
          }
        } catch {
          // 如果 stat 失败，继续文件逻辑
        }

        return await generateFileAttachment(
          absoluteFilename,
          toolUseContext,
          'tengu_at_mention_extracting_filename_success',
          'tengu_at_mention_extracting_filename_error',
          'at-mention',
          {
            offset: lineStart,
            limit: lineEnd && lineStart ? lineEnd - lineStart + 1 : undefined,
          },
        )
      } catch {
        logEvent('tengu_at_mention_extracting_filename_error', {})
      }
    }),
  )
  return results.filter(Boolean) as Attachment[]
}

function processAgentMentions(
  input: string,
  agents: AgentDefinition[],
): Attachment[] {
  const agentMentions = extractAgentMentions(input)
  if (agentMentions.length === 0) return []

  const results = agentMentions.map(mention => {
    const agentType = mention.replace('agent-', '')
    const agentDef = agents.find(def => def.agentType === agentType)

    if (!agentDef) {
      logEvent('tengu_at_mention_agent_not_found', {})
      return null
    }

    logEvent('tengu_at_mention_agent_success', {})

    return {
      type: 'agent_mention' as const,
      agentType: agentDef.agentType,
    }
  })

  return results.filter(
    (result): result is NonNullable<typeof result> => result !== null,
  )
}

async function processMcpResourceAttachments(
  input: string,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const resourceMentions = extractMcpResourceMentions(input)
  if (resourceMentions.length === 0) return []

  const mcpClients = toolUseContext.options.mcpClients || []

  const results = await Promise.all(
    resourceMentions.map(async mention => {
      try {
        const [serverName, ...uriParts] = mention.split(':')
        const uri = uriParts.join(':') // Rejoin in case URI contains colons

        if (!serverName || !uri) {
          logEvent('tengu_at_mention_mcp_resource_error', {})
          return null
        }

        // 查找 MCP 客户端
        const client = mcpClients.find(c => c.name === serverName)
        if (!client || client.type !== 'connected') {
          logEvent('tengu_at_mention_mcp_resource_error', {})
          return null
        }

        // 在可用资源中查找该资源以获取其元数据
        const serverResources =
          toolUseContext.options.mcpResources?.[serverName] || []
        const resourceInfo = serverResources.find(r => r.uri === uri)
        if (!resourceInfo) {
          logEvent('tengu_at_mention_mcp_resource_error', {})
          return null
        }

        try {
          const result = await client.client.readResource({
            uri,
          })

          logEvent('tengu_at_mention_mcp_resource_success', {})

          return {
            type: 'mcp_resource' as const,
            server: serverName,
            uri,
            name: resourceInfo.name || uri,
            description: resourceInfo.description,
            content: result,
          }
        } catch (error) {
          logEvent('tengu_at_mention_mcp_resource_error', {})
          logError(error)
          return null
        }
      } catch {
        logEvent('tengu_at_mention_mcp_resource_error', {})
        return null
      }
    }),
  )

  return results.filter(
    (result): result is NonNullable<typeof result> => result !== null,
  ) as Attachment[]
}

export async function getChangedFiles(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const filePaths = cacheKeys(toolUseContext.readFileState)
  if (filePaths.length === 0) return []

  const appState = toolUseContext.getAppState()
  const results = await Promise.all(
    filePaths.map(async filePath => {
      const fileState = toolUseContext.readFileState.get(filePath)
      if (!fileState) return null

      // TODO: 为变更文件实现 offset/limit 支持
      if (fileState.offset !== undefined || fileState.limit !== undefined) {
        return null
      }

      const normalizedPath = expandPath(filePath)

      // 检查文件是否配置了拒绝规则
      if (isFileReadDenied(normalizedPath, appState.toolPermissionContext)) {
        return null
      }

      try {
        const mtime = await getFileModificationTimeAsync(normalizedPath)
        if (mtime <= fileState.timestamp) {
          return null
        }

        const fileInput = { file_path: normalizedPath }

        // 验证文件路径是否有效
        const isValid = await FileReadTool.validateInput(
          fileInput,
          toolUseContext,
        )
        if (!isValid.result) {
          return null
        }

        const result = await FileReadTool.call(fileInput, toolUseContext)
        // 仅提取变更部分
        if (result.data.type === 'text') {
          const snippet = getSnippetForTwoFileDiff(
            fileState.content,
            result.data.file.content,
          )

          // 文件被触碰但未修改
          if (snippet === '') {
            return null
          }

          return {
            type: 'edited_text_file' as const,
            filename: normalizedPath,
            snippet,
          }
        }

        // 对于非文本文件（图片），应用与 FileReadTool 相同的 token 限制逻辑
        if (result.data.type === 'image') {
          try {
            const data = await readImageWithTokenBudget(normalizedPath)
            return {
              type: 'edited_image_file' as const,
              filename: normalizedPath,
              content: data,
            }
          } catch (compressionError) {
            logError(compressionError)
            logEvent('tengu_watched_file_compression_failed', {
              file: normalizedPath,
            } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
            return null
          }
        }

        // notebook / pdf / parts —— 没有 diff 表示；显式返回
        // null 使 map 回调没有隐式 undefined 路径。
        return null
      } catch (err) {
        // 仅在 ENOENT（文件已真正删除）时淘汰。瞬态 stat
        // 失败 —— 原子保存竞争（编辑器写入 tmp→rename，
        // stat 命中间隙）、EACCES 抖动、网络 FS 问题 —— 绝对
        // 不能淘汰，否则下一次 Edit 会以 code-6 失败，即使
        // 文件仍然存在且模型刚刚读取了它。VS Code
        // 自动保存/格式化保存尤其频繁触发此竞争。
        // 参见 PR #18525 的回归分析。
        if (isENOENT(err)) {
          toolUseContext.readFileState.delete(filePath)
        }
        return null
      }
    }),
  )
  return results.filter(result => result != null) as Attachment[]
}

/**
 * 处理需要嵌套内存附件的路径，检查嵌套的 CLAUDE.md 文件。
 * 使用 ToolUseContext 中的 nestedMemoryAttachmentTriggers 字段。
 */
async function getNestedMemoryAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // 首先检查触发器 —— getAppState() 等待 React 渲染周期，
  // 而常见情况是触发器集合为空。
  if (
    !toolUseContext.nestedMemoryAttachmentTriggers ||
    toolUseContext.nestedMemoryAttachmentTriggers.size === 0
  ) {
    return []
  }

  const appState = toolUseContext.getAppState()
  const attachments: Attachment[] = []

  for (const filePath of toolUseContext.nestedMemoryAttachmentTriggers) {
    const nestedAttachments = await getNestedMemoryAttachmentsForFile(
      filePath,
      toolUseContext,
      appState,
    )
    attachments.push(...nestedAttachments)
  }

  toolUseContext.nestedMemoryAttachmentTriggers.clear()

  return attachments
}

async function getRelevantMemoryAttachments(
  input: string,
  agents: AgentDefinition[],
  readFileState: FileStateCache,
  recentTools: readonly string[],
  signal: AbortSignal,
  alreadySurfaced: ReadonlySet<string>,
  parentSpan?: unknown,
): Promise<Attachment[]> {
  // 如果 @-提及了 agent，仅搜索其内存目录（隔离）。
  // 否则搜索自动内存目录。
  const memoryDirs = extractAgentMentions(input).flatMap(mention => {
    const agentType = mention.replace('agent-', '')
    const agentDef = agents.find(def => def.agentType === agentType)
    return agentDef?.memory
      ? [getAgentMemoryDir(agentType, agentDef.memory)]
      : []
  })
  const dirs = memoryDirs.length > 0 ? memoryDirs : [getAutoMemPath()]

  const allResults = await Promise.all(
    dirs.map(dir =>
      findRelevantMemories(
        input,
        dir,
        signal,
        recentTools,
        alreadySurfaced,
        parentSpan as Parameters<typeof findRelevantMemories>[5],
      ).catch(() => []),
    ),
  )
  // alreadySurfaced 在选择器内部过滤，使 Sonnet 将其 5 个槽位预算
  // 用于新候选；readFileState 捕获模型通过 FileReadTool 读取的文件。
  // 这里的冗余 alreadySurfaced 检查是双重保险
  //（多目录结果可能在不同目录中重新引入选择器过滤的路径）。
  const selected = allResults
    .flat()
    .filter(m => !readFileState.has(m.path) && !alreadySurfaced.has(m.path))
    .slice(0, 5)

  const memories = await readMemoriesForSurfacing(selected, signal)

  if (memories.length === 0) {
    return []
  }
  return [{ type: 'relevant_memories' as const, memories }]
}

/**
 * 扫描消息以查找过去的 relevant_memories 附件。返回已浮现路径的集合
 *（用于选择器去重）和累计字节数（用于会话总限速）。
 * 扫描消息而不是在 toolUseContext 中跟踪意味着压缩自然重置两者 ——
 * 旧附件已从压缩后的转录中消失，因此重新浮现再次有效。
 */
export function collectSurfacedMemories(messages: ReadonlyArray<Message>): {
  paths: Set<string>
  totalBytes: number
} {
  const paths = new Set<string>()
  let totalBytes = 0
  for (const m of messages) {
    if (m.type === 'attachment' && m.attachment!.type === 'relevant_memories') {
      for (const mem of m.attachment!.memories as {
        path: string
        content: string
        mtimeMs: number
      }[]) {
        paths.add(mem.path)
        totalBytes += mem.content.length
      }
    }
  }
  return { paths, totalBytes }
}

/**
 * 读取一组按相关性排序的内存文件，作为 <system-reminder> 附件注入。
 * 通过 readFileInRange 的 truncateOnByteLimit 选项同时强制执行
 * MAX_MEMORY_LINES 和 MAX_MEMORY_BYTES 限制。
 * 截断会显示带注释的部分内容而不是丢弃文件 ——
 * findRelevantMemories 已将其选为最相关，因此即使后续行被截断，
 * 前置内容 + 开头上下文也值得显示。
 *
 * 导出用于直接测试，无需模拟排名器 + GB 门控。
 */
export async function readMemoriesForSurfacing(
  selected: ReadonlyArray<{ path: string; mtimeMs: number }>,
  signal?: AbortSignal,
): Promise<
  Array<{
    path: string
    content: string
    mtimeMs: number
    header: string
    limit?: number
  }>
> {
  const results = await Promise.all(
    selected.map(async ({ path: filePath, mtimeMs }) => {
      try {
        const result = await readFileInRange(
          filePath,
          0,
          MAX_MEMORY_LINES,
          MAX_MEMORY_BYTES,
          signal,
          { truncateOnByteLimit: true },
        )
        const truncated =
          result.totalLines > MAX_MEMORY_LINES || result.truncatedByBytes
        const content = truncated
          ? result.content +
            `\n\n> This memory file was truncated (${result.truncatedByBytes ? `${MAX_MEMORY_BYTES} byte limit` : `first ${MAX_MEMORY_LINES} lines`}). Use the ${FILE_READ_TOOL_NAME} tool to view the complete file at: ${filePath}`
          : result.content
        return {
          path: filePath,
          content,
          mtimeMs,
          header: memoryHeader(filePath, mtimeMs),
          limit: truncated ? result.lineCount : undefined,
        }
      } catch {
        return null
      }
    }),
  )
  return results.filter(r => r !== null)
}

/**
 * 相关内存块的标题字符串。导出以便 messages.ts
 * 在恢复会话中存储的标题丢失时可以回退使用。
 */
export function memoryHeader(path: string, mtimeMs: number): string {
  const staleness = memoryFreshnessText(mtimeMs)
  return staleness
    ? `${staleness}\n\nMemory: ${path}:`
    : `Memory (saved ${memoryAge(mtimeMs)}): ${path}:`
}

/**
 * 内存相关性选择器的预取句柄。Promise 每个用户轮次启动一次，
 * 在主模型流式传输和工具执行期间运行。
 * 在收集点（工具执行后），调用者读取 settledAt 以决定
 * 消费（若已就绪）或跳过并在下次迭代重试 —— 预取永不阻塞轮次。
 *
 * Disposable：query.ts 通过 `using` 绑定，因此 [Symbol.dispose] 在所有
 * 生成器退出路径（return、throw、.return() 关闭）触发 ——
 * 中止进行中的请求并发出终端遥测，无需对 while 循环内约 13 个
 * 返回站点各自进行仪表化。
 */
export type MemoryPrefetch = {
  promise: Promise<Attachment[]>
  /** 由 promise.finally() 设置。在 promise 完成前为 null。 */
  settledAt: number | null
  /** 由 query.ts 中的收集点设置。在消费前为 -1。 */
  consumedOnIteration: number
  [Symbol.dispose](): void
}

/**
 * 将相关内存搜索作为异步预取启动。
 * 从消息中提取最后一个真实用户提示（跳过 isMeta 系统注入），
 * 并启动非阻塞搜索。返回带有完成状态跟踪的 Disposable 句柄。
 * 在 query.ts 中通过 `using` 绑定。
 */
export function startRelevantMemoryPrefetch(
  messages: ReadonlyArray<Message>,
  toolUseContext: ToolUseContext,
): MemoryPrefetch | undefined {
  if (
    !isAutoMemoryEnabled() ||
    !getFeatureValue_CACHED_MAY_BE_STALE('tengu_moth_copse', false)
  ) {
    return undefined
  }

  // Poor mode: skip the side-query to save tokens
  const { isPoorModeActive } =
    require('../commands/poor/poorMode.js') as typeof import('../commands/poor/poorMode.js')
  if (isPoorModeActive()) {
    return undefined
  }

  const lastUserMessage = messages.findLast(m => m.type === 'user' && !m.isMeta)
  if (!lastUserMessage) {
    return undefined
  }

  const input = getUserMessageText(lastUserMessage)
  // 单词提示缺乏足够上下文进行有意义的词项提取
  if (!input || !/\s/.test(input.trim())) {
    return undefined
  }

  const surfaced = collectSurfacedMemories(messages)
  if (surfaced.totalBytes >= RELEVANT_MEMORIES_CONFIG.MAX_SESSION_BYTES) {
    return undefined
  }

  // 链接到轮次级别的中止，使用户按 Escape 立即取消 sideQuery，
  // 而不仅仅是在 queryLoop 退出时 [Symbol.dispose] 触发。
  const controller = createChildAbortController(toolUseContext.abortController)
  const firedAt = Date.now()
  const promise = getRelevantMemoryAttachments(
    input,
    toolUseContext.options.agentDefinitions.activeAgents,
    toolUseContext.readFileState,
    collectRecentSuccessfulTools(messages, lastUserMessage),
    controller.signal,
    surfaced.paths,
    toolUseContext.langfuseTrace,
  ).catch(e => {
    if (!isAbortError(e)) {
      logError(e)
    }
    return []
  })

  const handle: MemoryPrefetch = {
    promise,
    settledAt: null,
    consumedOnIteration: -1,
    [Symbol.dispose]() {
      controller.abort()
      logEvent('tengu_memdir_prefetch_collected', {
        hidden_by_first_iteration:
          handle.settledAt !== null && handle.consumedOnIteration === 0,
        consumed_on_iteration: handle.consumedOnIteration,
        latency_ms: (handle.settledAt ?? Date.now()) - firedAt,
      })
    },
  }
  void promise.finally(() => {
    handle.settledAt = Date.now()
  })
  return handle
}

type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  is_error?: boolean
}

function isToolResultBlock(b: unknown): b is ToolResultBlock {
  return (
    typeof b === 'object' &&
    b !== null &&
    (b as ToolResultBlock).type === 'tool_result' &&
    typeof (b as ToolResultBlock).tool_use_id === 'string'
  )
}

/**
 * 检查用户消息的内容是否包含 tool_result 块。
 * 这比检查 `toolUseResult === undefined` 更可靠，因为
 * 当 `preserveToolUseResults` 为 false 时（Explore agent 的默认值），
 * 子 agent 工具结果消息会显式将 `toolUseResult` 设置为 `undefined`。
 */
function hasToolResultContent(content: unknown): boolean {
  return Array.isArray(content) && content.some(isToolResultBlock)
}

/**
 * 自上一个真实轮次边界以来成功（且从未出错）的工具。
 * 内存选择器用此抑制关于正常工作的工具的文档 ——
 * 为模型已在成功调用的工具展示参考材料是噪音。
 *
 * 任何错误 → 工具被排除（模型正在挣扎，文档保持可用）。
 * 尚无结果 → 也被排除（结果未知）。
 *
 * tool_use 存在于助手内容中；tool_result 在用户内容中
 *（toolUseResult 已设置，isMeta 为 undefined）。两者都在扫描窗口内。
 * 向后扫描先看到结果再看到使用，因此按 id 收集两者并在之后解析。
 */
export function collectRecentSuccessfulTools(
  messages: ReadonlyArray<Message>,
  lastUserMessage: Message,
): readonly string[] {
  const useIdToName = new Map<string, string>()
  const resultByUseId = new Map<string, boolean>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    if (isHumanTurn(m) && m !== lastUserMessage) break
    if (m.type === 'assistant' && typeof m.message!.content !== 'string') {
      for (const block of m.message!.content as Array<{
        type: string
        id: string
        name: string
      }>) {
        if (block.type === 'tool_use') useIdToName.set(block.id, block.name)
      }
    } else if (
      m.type === 'user' &&
      'message' in m &&
      Array.isArray(m.message!.content)
    ) {
      for (const block of m.message!.content as Array<{ type: string }>) {
        if (isToolResultBlock(block)) {
          resultByUseId.set(block.tool_use_id, block.is_error === true)
        }
      }
    }
  }
  const failed = new Set<string>()
  const succeeded = new Set<string>()
  for (const [id, name] of useIdToName) {
    const errored = resultByUseId.get(id)
    if (errored === undefined) continue
    if (errored) {
      failed.add(name)
    } else {
      succeeded.add(name)
    }
  }
  return [...succeeded].filter(t => !failed.has(t))
}

/**
 * Filters prefetched memory attachments to exclude memories the model already
 * has in context via FileRead/Write/Edit tool calls (any iteration this turn)
 * or a previous turn's memory surfacing — both tracked in the cumulative
 * readFileState. Survivors are then marked in readFileState so subsequent
 * turns won't re-surface them.
 *
 * The mark-after-filter ordering is load-bearing: readMemoriesForSurfacing
 * used to write to readFileState during the prefetch, which meant the filter
 * saw every prefetch-selected path as "already in context" and dropped them
 * all (self-referential filter). Deferring the write to here, after the
 * filter runs, breaks that cycle while still deduping against tool calls
 * from any iteration.
 */
export function filterDuplicateMemoryAttachments(
  attachments: Attachment[],
  readFileState: FileStateCache,
): Attachment[] {
  return attachments
    .map(attachment => {
      if (attachment.type !== 'relevant_memories') return attachment
      const filtered = attachment.memories.filter(
        m => !readFileState.has(m.path),
      )
      for (const m of filtered) {
        readFileState.set(m.path, {
          content: m.content,
          timestamp: m.mtimeMs,
          offset: undefined,
          limit: m.limit,
        })
      }
      return filtered.length > 0 ? { ...attachment, memories: filtered } : null
    })
    .filter((a): a is Attachment => a !== null)
}

/**
 * Processes skill directories that were discovered during file operations.
 * Uses dynamicSkillDirTriggers field from ToolUseContext
 */
async function getDynamicSkillAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const attachments: Attachment[] = []

  if (
    toolUseContext.dynamicSkillDirTriggers &&
    toolUseContext.dynamicSkillDirTriggers.size > 0
  ) {
    // Parallelize: readdir all skill dirs concurrently
    const perDirResults = await Promise.all(
      Array.from(toolUseContext.dynamicSkillDirTriggers).map(async skillDir => {
        try {
          const entries = await readdir(skillDir, { withFileTypes: true })
          const candidates = entries
            .filter(e => e.isDirectory() || e.isSymbolicLink())
            .map(e => e.name)
          // Parallelize: stat all SKILL.md candidates concurrently
          const checked = await Promise.all(
            candidates.map(async name => {
              try {
                await stat(resolve(skillDir, name, 'SKILL.md'))
                return name
              } catch {
                return null // SKILL.md doesn't exist, skip this entry
              }
            }),
          )
          return {
            skillDir,
            skillNames: checked.filter((n): n is string => n !== null),
          }
        } catch {
          // Ignore errors reading skill directories (e.g., directory doesn't exist)
          return { skillDir, skillNames: [] }
        }
      }),
    )

    for (const { skillDir, skillNames } of perDirResults) {
      if (skillNames.length > 0) {
        attachments.push({
          type: 'dynamic_skill',
          skillDir,
          skillNames,
          displayPath: relative(getCwd(), skillDir),
        })
      }
    }

    toolUseContext.dynamicSkillDirTriggers.clear()
  }

  return attachments
}

// Track which skills have been sent to avoid re-sending. Keyed by agentId
// (empty string = main thread) so subagents get their own turn-0 listing —
// without per-agent scoping, the main thread populating this Set would cause
// every subagent's filterToBundledAndMcp result to dedup to empty.
const sentSkillNames = new Map<string, Set<string>>()

// Called when the skill set genuinely changes (plugin reload, skill file
// change on disk) so new skills get announced. NOT called on compact —
// post-compact re-injection costs ~4K tokens/event for marginal benefit.
export function resetSentSkillNames(): void {
  sentSkillNames.clear()
  suppressNext = false
  suppressNextDiscovery = false
}

/**
 * Suppress the next skill-listing injection. Called by conversationRecovery
 * on --resume when a skill_listing attachment already exists in the
 * transcript.
 *
 * `sentSkillNames` is module-scope — process-local. Each `claude -p` spawn
 * starts with an empty Map, so without this every resume re-injects the
 * full ~600-token listing even though it's already in the conversation from
 * the prior process. Shows up on every --resume; particularly loud for
 * daemons that respawn frequently.
 *
 * Trade-off: skills added between sessions won't be announced until the
 * next non-resume session. Acceptable — skill_listing was never meant to
 * cover cross-process deltas, and the agent can still call them (they're
 * in the Skill tool's runtime registry regardless).
 */
export function suppressNextSkillListing(): void {
  suppressNext = true
}
let suppressNext = false

/**
 * Suppress the next skill-discovery injection on resume. Same rationale as
 * suppressNextSkillListing: skill_discovery attachments are not persisted to
 * transcript for non-ant users, so the prior process's discovery result is
 * already in the conversation history the model sees. Re-generating it would
 * inject duplicate content and bust the prompt cache prefix.
 */
export function suppressNextSkillDiscovery(): void {
  suppressNextDiscovery = true
}
let suppressNextDiscovery = false

// When skill-search is enabled and the filtered (bundled + MCP) listing exceeds
// this count, fall back to bundled-only. Protects MCP-heavy users (100+ servers)
// from truncation while keeping the turn-0 guarantee for typical setups.
const FILTERED_LISTING_MAX = 30

/**
 * Filter skills to bundled (Anthropic-curated) + MCP (user-connected) only.
 * Used when skill-search is enabled to resolve the turn-0 gap for subagents:
 * these sources are small, intent-signaled, and won't hit the truncation budget.
 * User/project/plugin skills (the long tail — 200+) go through discovery instead.
 *
 * Falls back to bundled-only if bundled+mcp exceeds FILTERED_LISTING_MAX.
 */
export function filterToBundledAndMcp(commands: Command[]): Command[] {
  const filtered = commands.filter(
    cmd => cmd.loadedFrom === 'bundled' || cmd.loadedFrom === 'mcp',
  )
  if (filtered.length > FILTERED_LISTING_MAX) {
    return filtered.filter(cmd => cmd.loadedFrom === 'bundled')
  }
  return filtered
}

async function getSkillListingAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (process.env.NODE_ENV === 'test') {
    return []
  }

  // Skip skill listing for agents that don't have the Skill tool — they can't use skills directly.
  if (
    !toolUseContext.options.tools.some(t => toolMatchesName(t, SKILL_TOOL_NAME))
  ) {
    return []
  }

  const cwd = getProjectRoot()
  const localCommands = await getSkillToolCommands(cwd)
  const mcpSkills = getMcpSkillCommands(
    toolUseContext.getAppState().mcp.commands,
  )
  let allCommands =
    mcpSkills.length > 0
      ? uniqBy([...localCommands, ...mcpSkills], 'name')
      : localCommands

  // When skill search is active, filter to bundled + MCP instead of full
  // suppression. Resolves the turn-0 gap: main thread gets turn-0 discovery
  // via getTurnZeroSkillDiscovery (blocking), but subagents use the async
  // subagent_spawn signal (collected post-tools, visible turn 1). Bundled +
  // MCP are small and intent-signaled; user/project/plugin skills go through
  // discovery. feature() first for DCE — the property-access string leaks
  // otherwise even with ?. on null.
  if (
    feature('EXPERIMENTAL_SKILL_SEARCH') &&
    skillSearchModules?.featureCheck.isSkillSearchEnabled()
  ) {
    allCommands = filterToBundledAndMcp(allCommands)
  }

  const agentKey = toolUseContext.agentId ?? ''
  let sent = sentSkillNames.get(agentKey)
  if (!sent) {
    sent = new Set()
    sentSkillNames.set(agentKey, sent)
  }

  // Resume path: prior process already injected a listing; it's in the
  // transcript. Mark everything current as sent so only post-resume deltas
  // (skills loaded later via /reload-plugins etc) get announced.
  if (suppressNext) {
    suppressNext = false
    for (const cmd of allCommands) {
      sent.add(cmd.name)
    }
    return []
  }

  // Find skills we haven't sent yet
  const newSkills = allCommands.filter(cmd => !sent.has(cmd.name))

  if (newSkills.length === 0) {
    return []
  }

  // If no skills have been sent yet, this is the initial batch
  const isInitial = sent.size === 0

  // Mark as sent
  for (const cmd of newSkills) {
    sent.add(cmd.name)
  }

  logForDebugging(
    `Sending ${newSkills.length} skills via attachment (${isInitial ? 'initial' : 'dynamic'}, ${sent.size} total sent)`,
  )

  // Format within budget using existing logic
  const contextWindowTokens = getContextWindowForModel(
    toolUseContext.options.mainLoopModel,
    getSdkBetas(),
  )
  const content = formatCommandsWithinBudget(newSkills, contextWindowTokens)

  return [
    {
      type: 'skill_listing',
      content,
      skillCount: newSkills.length,
      isInitial,
    },
  ]
}

// getSkillDiscoveryAttachment 已移至 skillSearch/prefetch.ts，
// 名称改为 getTurnZeroSkillDiscovery —— 将 'skill_discovery' 字符串字面量
// 保留在功能门控模块内，以防其泄漏到外部构建中。

export function extractAtMentionedFiles(content: string): string[] {
  // 提取用 @ 符号提及的文件名，包括行范围语法：@file.txt#L10-20
  // 也支持带空格的文件路径：@"my/file with spaces.txt"
  // 示例："foo bar @baz moo" 会提取 "baz"
  // 示例：'check @"my file.txt" please' 会提取 "my file.txt"

  // 两种模式：带引号路径和常规路径
  const quotedAtMentionRegex = /(^|\s)@"([^"]+)"/g
  const regularAtMentionRegex = /(^|\s)@([^\s]+)\b/g

  const quotedMatches: string[] = []
  const regularMatches: string[] = []

  // 首先提取带引号的提及（跳过 agent 提及，如 @"code-reviewer (agent)"）
  let match
  while ((match = quotedAtMentionRegex.exec(content)) !== null) {
    if (match[2] && !match[2].endsWith(' (agent)')) {
      quotedMatches.push(match[2]) // 引号内的内容
    }
  }

  // 提取常规提及
  const regularMatchArray: string[] = content.match(regularAtMentionRegex) ?? []
  regularMatchArray.forEach(match => {
    const filename = match.slice(match.indexOf('@') + 1)
    // 如果以引号开头则不包含（已作为带引号路径处理）
    if (!filename.startsWith('"')) {
      regularMatches.push(filename)
    }
  })

  // 合并并去重
  return uniq([...quotedMatches, ...regularMatches])
}

export function extractMcpResourceMentions(content: string): string[] {
  // 提取用 @ 符号提及的 MCP 资源，格式为 @server:uri
  // 示例："@server1:resource/path" 会提取 "server1:resource/path"
  const atMentionRegex = /(^|\s)@([^\s]+:[^\s]+)\b/g
  const matches = content.match(atMentionRegex) || []

  // 移除每个匹配中的前缀（@ 之前的所有内容）
  return uniq(matches.map(match => match.slice(match.indexOf('@') + 1)))
}

export function extractAgentMentions(content: string): string[] {
  // 以两种格式提取 agent 提及：
  // 1. @agent-<agent-type>（旧版/手动输入）
  //    示例："@agent-code-elegance-refiner" → "agent-code-elegance-refiner"
  // 2. @"<agent-type> (agent)"（来自自动补全选择）
  //    示例：'@"code-reviewer (agent)"' → "code-reviewer"
  // 支持冒号、点和 @ 符号，用于插件范围的 agent，如 "@agent-asana:project-status-updater"
  const results: string[] = []

  // 匹配带引号格式：@"<type> (agent)"
  const quotedAgentRegex = /(^|\s)@"([\w:.@-]+) \(agent\)"/g
  let match
  while ((match = quotedAgentRegex.exec(content)) !== null) {
    if (match[2]) {
      results.push(match[2])
    }
  }

  // 匹配不带引号格式：@agent-<type>
  const unquotedAgentRegex = /(^|\s)@(agent-[\w:.@-]+)/g
  const unquotedMatches = content.match(unquotedAgentRegex) || []
  for (const m of unquotedMatches) {
    results.push(m.slice(m.indexOf('@') + 1))
  }

  return uniq(results)
}

interface AtMentionedFileLines {
  filename: string
  lineStart?: number
  lineEnd?: number
}

export function parseAtMentionedFileLines(
  mention: string,
): AtMentionedFileLines {
  // 解析如 "file.txt#L10-20"、"file.txt#heading" 或仅 "file.txt" 的提及
  // 支持行范围（#L10、#L10-20）并去除非行范围片段（#heading）
  const match = mention.match(/^([^#]+)(?:#L(\d+)(?:-(\d+))?)?(?:#[^#]*)?$/)

  if (!match) {
    return { filename: mention }
  }

  const [, filename, lineStartStr, lineEndStr] = match
  const lineStart = lineStartStr ? parseInt(lineStartStr, 10) : undefined
  const lineEnd = lineEndStr ? parseInt(lineEndStr, 10) : lineStart

  return { filename: filename ?? mention, lineStart, lineEnd }
}

async function getDiagnosticAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // 诊断信息仅在 agent 有 Bash 工具可以处理时才有用
  if (
    !toolUseContext.options.tools.some(t => toolMatchesName(t, BASH_TOOL_NAME))
  ) {
    return []
  }

  // 从跟踪器获取新诊断（通过 MCP 的 IDE 诊断）
  const newDiagnostics = await diagnosticTracker.getNewDiagnostics()
  if (newDiagnostics.length === 0) {
    return []
  }

  return [
    {
      type: 'diagnostics',
      files: newDiagnostics,
      isNew: true,
    },
  ]
}

/**
 * 从被动 LSP 服务器获取 LSP 诊断附件。
 * 遵循 AsyncHookRegistry 模式以实现一致的异步附件交付。
 */
async function getLSPDiagnosticAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // LSP 诊断仅在 agent 有 Bash 工具可以处理时才有用
  if (
    !toolUseContext.options.tools.some(t => toolMatchesName(t, BASH_TOOL_NAME))
  ) {
    return []
  }

  logForDebugging('LSP Diagnostics: getLSPDiagnosticAttachments called')

  try {
    const diagnosticSets = checkForLSPDiagnostics()

    if (diagnosticSets.length === 0) {
      return []
    }

    logForDebugging(
      `LSP Diagnostics: Found ${diagnosticSets.length} pending diagnostic set(s)`,
    )

    // 将每个诊断集转换为附件
    const attachments: Attachment[] = diagnosticSets.map(({ files }) => ({
      type: 'diagnostics' as const,
      files,
      isNew: true,
    }))

    // 从注册表中清除已交付的诊断以防止内存泄漏
    // 遵循与 removeDeliveredAsyncHooks 相同的模式
    if (diagnosticSets.length > 0) {
      clearAllLSPDiagnostics()
      logForDebugging(
        `LSP Diagnostics: Cleared ${diagnosticSets.length} delivered diagnostic(s) from registry`,
      )
    }

    logForDebugging(
      `LSP Diagnostics: Returning ${attachments.length} diagnostic attachment(s)`,
    )

    return attachments
  } catch (error) {
    const err = toError(error)
    logError(
      new Error(`Failed to get LSP diagnostic attachments: ${err.message}`),
    )
    // 返回空数组以允许其他附件继续处理
    return []
  }
}

export async function* getAttachmentMessages(
  input: string | null,
  toolUseContext: ToolUseContext,
  ideSelection: IDESelection | null,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { skipSkillDiscovery?: boolean },
): AsyncGenerator<AttachmentMessage, void> {
  // TODO: 在上游计算此值
  const attachments = await getAttachments(
    input,
    toolUseContext,
    ideSelection,
    queuedCommands,
    messages,
    querySource,
    options,
  )

  if (attachments.length === 0) {
    return
  }

  logEvent('tengu_attachments', {
    attachment_types: attachments.map(
      _ => _.type,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  for (const attachment of attachments) {
    yield createAttachmentMessage(attachment)
  }
}

/**
 * 通过读取文件并进行适当的验证和截断来生成文件附件。
 * 这是 @-提及文件和压缩后恢复之间共享的核心文件读取逻辑。
 *
 * @param filename 要读取的文件的绝对路径
 * @param toolUseContext 用于调用 FileReadTool 的工具使用上下文
 * @param options 文件读取的可选配置
 * @returns new_file 附件，或在文件无法读取时返回 null
 */
/**
 * 检查 PDF 文件是否应该以轻量级引用而不是内联方式表示。
 * 对于大型 PDF（超过 PDF_AT_MENTION_INLINE_THRESHOLD 页），
 * 返回 PDFReferenceAttachment，否则返回 null。
 */
export async function tryGetPDFReference(
  filename: string,
): Promise<PDFReferenceAttachment | null> {
  const ext = parse(filename).ext.toLowerCase()
  if (!isPDFExtension(ext)) {
    return null
  }
  try {
    const [stats, pageCount] = await Promise.all([
      getFsImplementation().stat(filename),
      getPDFPageCount(filename),
    ])
    // 如果页数可用则使用页数，否则回退到大小启发式（约每页 100KB）
    const effectivePageCount = pageCount ?? Math.ceil(stats.size / (100 * 1024))
    if (effectivePageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
      logEvent('tengu_pdf_reference_attachment', {
        pageCount: effectivePageCount,
        fileSize: stats.size,
        hadPdfinfo: pageCount !== null,
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      return {
        type: 'pdf_reference',
        filename,
        pageCount: effectivePageCount,
        fileSize: stats.size,
        displayPath: relative(getCwd(), filename),
      }
    }
  } catch {
    // 如果无法 stat 文件，返回 null 以继续正常读取
  }
  return null
}

export async function generateFileAttachment(
  filename: string,
  toolUseContext: ToolUseContext,
  successEventName: string,
  errorEventName: string,
  mode: 'compact' | 'at-mention',
  options?: {
    offset?: number
    limit?: number
  },
): Promise<
  | FileAttachment
  | CompactFileReferenceAttachment
  | PDFReferenceAttachment
  | AlreadyReadFileAttachment
  | null
> {
  const { offset, limit } = options ?? {}

  // 检查文件是否配置了拒绝规则
  const appState = toolUseContext.getAppState()
  if (isFileReadDenied(filename, appState.toolPermissionContext)) {
    return null
  }

  // 尝试读取前检查文件大小（跳过 PDF —— 它们有自己的大小/页面处理逻辑）
  if (
    mode === 'at-mention' &&
    !isFileWithinReadSizeLimit(
      filename,
      getDefaultFileReadingLimits().maxSizeBytes,
    )
  ) {
    const ext = parse(filename).ext.toLowerCase()
    if (!isPDFExtension(ext)) {
      try {
        const stats = await getFsImplementation().stat(filename)
        logEvent('tengu_attachment_file_too_large', {
          size_bytes: stats.size,
          mode,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
        return null
      } catch {
        // 如果无法 stat 文件，继续正常读取（如果文件不存在稍后会失败）
      }
    }
  }

  // 对于 @ 提及的大型 PDF，返回轻量级引用而不是内联
  if (mode === 'at-mention') {
    const pdfRef = await tryGetPDFReference(filename)
    if (pdfRef) {
      return pdfRef
    }
  }

  // 检查文件是否已在上下文中且为最新版本
  const existingFileState = toolUseContext.readFileState.get(filename)
  if (existingFileState && mode === 'at-mention') {
    try {
      // 检查文件是否自上次读取后已被修改
      const mtimeMs = await getFileModificationTimeAsync(filename)

      // 处理时间戳格式不一致：
      // - FileReadTool 存储 Date.now()（读取时的当前时间）
      // - FileEdit/WriteTools 存储 mtimeMs（文件修改时间）
      //
      // 如果 timestamp > mtimeMs，则由 FileReadTool 使用 Date.now() 存储。
      // 在这种情况下，不应使用优化，因为无法可靠地比较修改时间。
      // 仅当 timestamp <= mtimeMs 时使用优化，
      // 表明由 FileEdit/WriteTool 使用实际 mtimeMs 存储。

      if (
        existingFileState.timestamp <= mtimeMs &&
        mtimeMs === existingFileState.timestamp
      ) {
        // 文件未被修改，返回 already_read_file 附件
        // 这告知系统文件已在上下文中，无需发送到 API
        logEvent(successEventName, {})
        return {
          type: 'already_read_file',
          filename,
          displayPath: relative(getCwd(), filename),
          content: {
            type: 'text',
            file: {
              filePath: filename,
              content: existingFileState.content,
              numLines: countCharInString(existingFileState.content, '\n') + 1,
              startLine: offset ?? 1,
              totalLines:
                countCharInString(existingFileState.content, '\n') + 1,
            },
          },
        }
      }
    } catch {
      // 如果无法 stat 文件，继续正常读取
    }
  }

  try {
    const fileInput = {
      file_path: filename,
      offset,
      limit,
    }

    async function readTruncatedFile(): Promise<
      | FileAttachment
      | CompactFileReferenceAttachment
      | AlreadyReadFileAttachment
      | null
    > {
      if (mode === 'compact') {
        return {
          type: 'compact_file_reference',
          filename,
          displayPath: relative(getCwd(), filename),
        }
      }

      // 在读取截断文件前检查拒绝规则
      const appState = toolUseContext.getAppState()
      if (isFileReadDenied(filename, appState.toolPermissionContext)) {
        return null
      }

      try {
        // 仅读取过大文件的前 MAX_LINES_TO_READ 行
        const truncatedInput = {
          file_path: filename,
          offset: offset ?? 1,
          limit: MAX_LINES_TO_READ,
        }
        const result = await FileReadTool.call(truncatedInput, toolUseContext)
        logEvent(successEventName, {})

        return {
          type: 'file' as const,
          filename,
          content: result.data,
          truncated: true,
          displayPath: relative(getCwd(), filename),
        }
      } catch {
        logEvent(errorEventName, {})
        return null
      }
    }

    // Validate file path is valid
    const isValid = await FileReadTool.validateInput(fileInput, toolUseContext)
    if (!isValid.result) {
      return null
    }

    try {
      const result = await FileReadTool.call(fileInput, toolUseContext)
      logEvent(successEventName, {})
      return {
        type: 'file',
        filename,
        content: result.data,
        displayPath: relative(getCwd(), filename),
      }
    } catch (error) {
      if (
        error instanceof MaxFileReadTokenExceededError ||
        error instanceof FileTooLargeError
      ) {
        return await readTruncatedFile()
      }
      throw error
    }
  } catch {
    logEvent(errorEventName, {})
    return null
  }
}

export function createAttachmentMessage(
  attachment: Attachment,
): AttachmentMessage<Attachment> {
  return {
    attachment,
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  } as unknown as AttachmentMessage<Attachment>
}

function getTodoReminderTurnCounts(messages: Message[]): {
  turnsSinceLastTodoWrite: number
  turnsSinceLastReminder: number
} {
  let lastTodoWriteIndex = -1
  let lastReminderIndex = -1
  let assistantTurnsSinceWrite = 0
  let assistantTurnsSinceReminder = 0

  // Iterate backwards to find most recent events
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (message?.type === 'assistant') {
      if (isThinkingMessage(message)) {
        // Skip thinking messages
        continue
      }

      // Check for TodoWrite usage BEFORE incrementing counter
      // (we don't want to count the TodoWrite message itself as "1 turn since write")
      if (
        lastTodoWriteIndex === -1 &&
        'message' in message &&
        Array.isArray(message.message?.content) &&
        message.message.content.some(
          block => block.type === 'tool_use' && block.name === 'TodoWrite',
        )
      ) {
        lastTodoWriteIndex = i
      }

      // Count assistant turns before finding events
      if (lastTodoWriteIndex === -1) assistantTurnsSinceWrite++
      if (lastReminderIndex === -1) assistantTurnsSinceReminder++
    } else if (
      lastReminderIndex === -1 &&
      message?.type === 'attachment' &&
      message.attachment!.type === 'todo_reminder'
    ) {
      lastReminderIndex = i
    }

    if (lastTodoWriteIndex !== -1 && lastReminderIndex !== -1) {
      break
    }
  }

  return {
    turnsSinceLastTodoWrite: assistantTurnsSinceWrite,
    turnsSinceLastReminder: assistantTurnsSinceReminder,
  }
}

async function getTodoReminderAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // Skip if TodoWrite tool is not available
  if (
    !toolUseContext.options.tools.some(t =>
      toolMatchesName(t, TODO_WRITE_TOOL_NAME),
    )
  ) {
    return []
  }

  // When SendUserMessage is in the toolkit, it's the primary communication
  // channel and the model is always told to use it (#20467). TodoWrite
  // becomes a side channel — nudging the model about it conflicts with the
  // brief workflow. The tool itself stays available; this only gates the
  // "you haven't used it in a while" nag.
  if (
    BRIEF_TOOL_NAME &&
    toolUseContext.options.tools.some(t => toolMatchesName(t, BRIEF_TOOL_NAME))
  ) {
    return []
  }

  // Skip if no messages provided
  if (!messages || messages.length === 0) {
    return []
  }

  const { turnsSinceLastTodoWrite, turnsSinceLastReminder } =
    getTodoReminderTurnCounts(messages)

  // Check if we should show a reminder
  if (
    turnsSinceLastTodoWrite >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE &&
    turnsSinceLastReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
  ) {
    const todoKey = toolUseContext.agentId ?? getSessionId()
    const appState = toolUseContext.getAppState()
    const todos = appState.todos[todoKey] ?? []
    return [
      {
        type: 'todo_reminder',
        content: todos,
        itemCount: todos.length,
      },
    ]
  }

  return []
}

function getTaskReminderTurnCounts(messages: Message[]): {
  turnsSinceLastTaskManagement: number
  turnsSinceLastReminder: number
} {
  let lastTaskManagementIndex = -1
  let lastReminderIndex = -1
  let assistantTurnsSinceTaskManagement = 0
  let assistantTurnsSinceReminder = 0

  // Iterate backwards to find most recent events
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (message?.type === 'assistant') {
      if (isThinkingMessage(message)) {
        // Skip thinking messages
        continue
      }

      // Check for TaskCreate or TaskUpdate usage BEFORE incrementing counter
      if (
        lastTaskManagementIndex === -1 &&
        'message' in message &&
        Array.isArray(message.message?.content) &&
        message.message.content.some(
          block =>
            block.type === 'tool_use' &&
            (block.name === TASK_CREATE_TOOL_NAME ||
              block.name === TASK_UPDATE_TOOL_NAME),
        )
      ) {
        lastTaskManagementIndex = i
      }

      // Count assistant turns before finding events
      if (lastTaskManagementIndex === -1) assistantTurnsSinceTaskManagement++
      if (lastReminderIndex === -1) assistantTurnsSinceReminder++
    } else if (
      lastReminderIndex === -1 &&
      message?.type === 'attachment' &&
      message.attachment!.type === 'task_reminder'
    ) {
      lastReminderIndex = i
    }

    if (lastTaskManagementIndex !== -1 && lastReminderIndex !== -1) {
      break
    }
  }

  return {
    turnsSinceLastTaskManagement: assistantTurnsSinceTaskManagement,
    turnsSinceLastReminder: assistantTurnsSinceReminder,
  }
}

async function getTaskReminderAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!isTodoV2Enabled()) {
    return []
  }

  // Skip for ant users
  if (process.env.USER_TYPE === 'ant') {
    return []
  }

  // When SendUserMessage is in the toolkit, it's the primary communication
  // channel and the model is always told to use it (#20467). TaskUpdate
  // becomes a side channel — nudging the model about it conflicts with the
  // brief workflow. The tool itself stays available; this only gates the nag.
  if (
    BRIEF_TOOL_NAME &&
    toolUseContext.options.tools.some(t => toolMatchesName(t, BRIEF_TOOL_NAME))
  ) {
    return []
  }

  // Skip if TaskUpdate tool is not available
  if (
    !toolUseContext.options.tools.some(t =>
      toolMatchesName(t, TASK_UPDATE_TOOL_NAME),
    )
  ) {
    return []
  }

  // Skip if no messages provided
  if (!messages || messages.length === 0) {
    return []
  }

  const { turnsSinceLastTaskManagement, turnsSinceLastReminder } =
    getTaskReminderTurnCounts(messages)

  // Check if we should show a reminder
  if (
    turnsSinceLastTaskManagement >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE &&
    turnsSinceLastReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
  ) {
    const tasks = await listTasks(getTaskListId())
    return [
      {
        type: 'task_reminder',
        content: tasks,
        itemCount: tasks.length,
      },
    ]
  }

  return []
}

/**
 * Get attachments for all unified tasks using the Task framework.
 * Replaces the old getBackgroundShellAttachments, getBackgroundRemoteSessionAttachments,
 * and getAsyncAgentAttachments functions.
 */
async function getUnifiedTaskAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState()
  const { attachments, updatedTaskOffsets, evictedTaskIds } =
    await generateTaskAttachments(appState)

  applyTaskOffsetsAndEvictions(
    toolUseContext.setAppState,
    updatedTaskOffsets,
    evictedTaskIds,
  )

  // Convert TaskAttachment to Attachment format
  return attachments.map(taskAttachment => ({
    type: 'task_status' as const,
    taskId: taskAttachment.taskId,
    taskType: taskAttachment.taskType,
    status: taskAttachment.status,
    description: taskAttachment.description,
    deltaSummary: taskAttachment.deltaSummary,
    outputFilePath: getTaskOutputPath(taskAttachment.taskId),
  }))
}

async function getAsyncHookResponseAttachments(): Promise<Attachment[]> {
  const responses = await checkForAsyncHookResponses()

  if (responses.length === 0) {
    return []
  }

  logForDebugging(
    `Hooks: getAsyncHookResponseAttachments found ${responses.length} responses`,
  )

  const attachments = responses.map(
    ({
      processId,
      response,
      hookName,
      hookEvent,
      toolName,
      pluginId: _pluginId,
      stdout,
      stderr,
      exitCode,
    }) => {
      logForDebugging(
        `Hooks: Creating attachment for ${processId} (${hookName}): ${jsonStringify(response)}`,
      )
      return {
        type: 'async_hook_response' as const,
        processId,
        hookName,
        hookEvent,
        toolName,
        response,
        stdout,
        stderr,
        exitCode,
      }
    },
  )

  // Remove delivered hooks from registry to prevent re-processing
  if (responses.length > 0) {
    const processIds = responses.map(r => r.processId)
    removeDeliveredAsyncHooks(processIds)
    logForDebugging(
      `Hooks: Removed ${processIds.length} delivered hooks from registry`,
    )
  }

  logForDebugging(
    `Hooks: getAsyncHookResponseAttachments found ${attachments.length} attachments`,
  )

  return attachments
}

/**
 * Get teammate mailbox attachments for agent swarm communication
 * Teammates are independent Claude Code sessions running in parallel (swarms),
 * not parent-child subagent relationships.
 *
 * This function checks two sources for messages:
 * 1. File-based mailbox (for messages that arrived between polls)
 * 2. AppState.inbox (for messages queued mid-turn by useInboxPoller)
 *
 * Messages from AppState.inbox are delivered mid-turn as attachments,
 * allowing teammates to receive messages without waiting for the turn to end.
 */
async function getTeammateMailboxAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!isAgentSwarmsEnabled()) {
    return []
  }
  if (process.env.USER_TYPE !== 'ant') {
    return []
  }

  // Get AppState early to check for team lead status
  const appState = toolUseContext.getAppState()

  // Use agent name from helper (checks AsyncLocalStorage, then dynamicTeamContext)
  const envAgentName = getAgentName()

  // Get team name (checks AsyncLocalStorage, dynamicTeamContext, then AppState)
  const teamName = getTeamName(appState.teamContext)

  // Check if we're the team lead (uses shared logic from swarm utils)
  const teamLeadStatus = isTeamLead(appState.teamContext)

  // Check if viewing a teammate's transcript (for in-process teammates)
  const viewedTeammate = getViewedTeammateTask(appState)

  // Resolve agent name based on who we're VIEWING:
  // - If viewing a teammate, use THEIR name (to read from their mailbox)
  // - Otherwise use env var if set, or leader's name if we're the team lead
  let agentName = viewedTeammate?.identity.agentName ?? envAgentName
  if (!agentName && teamLeadStatus && appState.teamContext) {
    const leadAgentId = appState.teamContext.leadAgentId
    // Look up the lead's name from agents map (not the UUID)
    agentName = appState.teamContext.teammates[leadAgentId]?.name || 'team-lead'
  }

  logForDebugging(
    `[SwarmMailbox] getTeammateMailboxAttachments called: envAgentName=${envAgentName}, isTeamLead=${teamLeadStatus}, resolved agentName=${agentName}, teamName=${teamName}`,
  )

  // Only check inbox if running as an agent in a swarm or team lead
  if (!agentName) {
    logForDebugging(
      `[SwarmMailbox] Not checking inbox - not in a swarm or team lead`,
    )
    return []
  }

  logForDebugging(
    `[SwarmMailbox] Checking inbox for agent="${agentName}" team="${teamName || 'default'}"`,
  )

  // Check mailbox for unread messages (routes to in-process or file-based)
  // Filter out structured protocol messages (permission requests/responses, shutdown
  // messages, etc.) — these must be left unread for useInboxPoller to route to their
  // proper handlers (workerPermissions queue, sandbox queue, etc.). Without filtering,
  // attachment generation races with InboxPoller: whichever reads first marks all
  // messages as read, and if attachments wins, protocol messages get bundled as raw
  // LLM context text instead of being routed to their UI handlers.
  const allUnreadMessages = await readUnreadMessages(agentName, teamName)
  const unreadMessages = allUnreadMessages.filter(
    m => !isStructuredProtocolMessage(m.text),
  )
  logForDebugging(
    `[MailboxBridge] Found ${allUnreadMessages.length} unread message(s) for "${agentName}" (${allUnreadMessages.length - unreadMessages.length} structured protocol messages filtered out)`,
  )

  // Also check AppState.inbox for pending messages (queued mid-turn by useInboxPoller)
  // IMPORTANT: appState.inbox contains messages FROM teammates TO the leader.
  // Only show these when viewing the leader's transcript (not a teammate's).
  // When viewing a teammate, their messages come from the file-based mailbox above.
  // In-process teammates share AppState with the leader — appState.inbox contains
  // the LEADER's queued messages, not the teammate's. Skip it to prevent leakage
  // (including self-echo from broadcasts). Teammates receive messages exclusively
  // through their file-based mailbox + waitForNextPromptOrShutdown.
  // Note: viewedTeammate was already computed above for agentName resolution
  const pendingInboxMessages =
    viewedTeammate || isInProcessTeammate()
      ? [] // Viewing teammate or running as in-process teammate - don't show leader's inbox
      : appState.inbox.messages.filter(m => m.status === 'pending')
  logForDebugging(
    `[SwarmMailbox] Found ${pendingInboxMessages.length} pending message(s) in AppState.inbox`,
  )

  // Combine both sources of messages WITH DEDUPLICATION
  // The same message could exist in both file mailbox and AppState.inbox due to race conditions:
  // 1. getTeammateMailboxAttachments reads file -> finds message M
  // 2. InboxPoller reads same file -> queues M in AppState.inbox
  // 3. getTeammateMailboxAttachments reads AppState -> finds M again
  // We deduplicate using from+timestamp+text prefix as the key
  const seen = new Set<string>()
  let allMessages: Array<{
    from: string
    text: string
    timestamp: string
    color?: string
    summary?: string
  }> = []

  for (const m of [...unreadMessages, ...pendingInboxMessages]) {
    const key = `${m.from}|${m.timestamp}|${m.text.slice(0, 100)}`
    if (!seen.has(key)) {
      seen.add(key)
      allMessages.push({
        from: m.from,
        text: m.text,
        timestamp: m.timestamp,
        color: m.color,
        summary: m.summary,
      })
    }
  }

  // Collapse multiple idle notifications per agent — keep only the latest.
  // Single pass to parse, then filter without re-parsing.
  const idleAgentByIndex = new Map<number, string>()
  const latestIdleByAgent = new Map<string, number>()
  for (let i = 0; i < allMessages.length; i++) {
    const idle = isIdleNotification(allMessages[i]!.text)
    if (idle) {
      idleAgentByIndex.set(i, idle.from)
      latestIdleByAgent.set(idle.from, i)
    }
  }
  if (idleAgentByIndex.size > latestIdleByAgent.size) {
    const beforeCount = allMessages.length
    allMessages = allMessages.filter((_m, i) => {
      const agent = idleAgentByIndex.get(i)
      if (agent === undefined) return true
      return latestIdleByAgent.get(agent) === i
    })
    logForDebugging(
      `[SwarmMailbox] Collapsed ${beforeCount - allMessages.length} duplicate idle notification(s)`,
    )
  }

  if (allMessages.length === 0) {
    logForDebugging(`[SwarmMailbox] No messages to deliver, returning empty`)
    return []
  }

  logForDebugging(
    `[SwarmMailbox] Returning ${allMessages.length} message(s) as attachment for "${agentName}" (${unreadMessages.length} from file, ${pendingInboxMessages.length} from AppState, after dedup)`,
  )

  // Build the attachment BEFORE marking messages as processed
  // This prevents message loss if any operation below fails
  const attachment: Attachment[] = [
    {
      type: 'teammate_mailbox',
      messages: allMessages,
    },
  ]

  // Mark only non-structured mailbox messages as read after attachment is built.
  // Structured protocol messages stay unread for useInboxPoller to handle.
  if (unreadMessages.length > 0) {
    await markMessagesAsReadByPredicate(
      agentName,
      m => !isStructuredProtocolMessage(m.text),
      teamName,
    )
    logForDebugging(
      `[MailboxBridge] marked ${unreadMessages.length} non-structured message(s) as read for agent="${agentName}" team="${teamName || 'default'}"`,
    )
  }

  // Process shutdown_approved messages - remove teammates from team file
  // This mirrors what useInboxPoller does in interactive mode (lines 546-606)
  // In -p mode, useInboxPoller doesn't run, so we must handle this here
  if (teamLeadStatus && teamName) {
    for (const m of allMessages) {
      const shutdownApproval = isShutdownApproved(m.text)
      if (shutdownApproval) {
        const teammateToRemove = shutdownApproval.from
        logForDebugging(
          `[SwarmMailbox] Processing shutdown_approved from ${teammateToRemove}`,
        )

        // Find the teammate ID by name
        const teammateId = appState.teamContext?.teammates
          ? Object.entries(appState.teamContext.teammates).find(
              ([, t]) => t.name === teammateToRemove,
            )?.[0]
          : undefined

        if (teammateId) {
          // Remove from team file
          removeTeammateFromTeamFile(teamName, {
            agentId: teammateId,
            name: teammateToRemove,
          })
          logForDebugging(
            `[SwarmMailbox] Removed ${teammateToRemove} from team file`,
          )

          // Unassign tasks owned by this teammate
          await unassignTeammateTasks(
            teamName,
            teammateId,
            teammateToRemove,
            'shutdown',
          )

          // Remove from teamContext in AppState
          toolUseContext.setAppState(prev => {
            if (!prev.teamContext?.teammates) return prev
            if (!(teammateId in prev.teamContext.teammates)) return prev
            const { [teammateId]: _, ...remainingTeammates } =
              prev.teamContext.teammates
            return {
              ...prev,
              teamContext: {
                ...prev.teamContext,
                teammates: remainingTeammates,
              },
            }
          })
        }
      }
    }
  }

  // Mark AppState inbox messages as processed LAST, after attachment is built
  // This ensures messages aren't lost if earlier operations fail
  if (pendingInboxMessages.length > 0) {
    const pendingIds = new Set(pendingInboxMessages.map(m => m.id))
    toolUseContext.setAppState(prev => ({
      ...prev,
      inbox: {
        messages: prev.inbox.messages.map(m =>
          pendingIds.has(m.id) ? { ...m, status: 'processed' as const } : m,
        ),
      },
    }))
  }

  return attachment
}

/**
 * Get team context attachment for teammates in a swarm.
 * Only injected on the first turn to provide team coordination instructions.
 */
function getTeamContextAttachment(messages: Message[]): Attachment[] {
  const teamName = getTeamName()
  const agentId = getAgentId()
  const agentName = getAgentName()

  // Only inject for teammates (not team lead or non-team sessions)
  if (!teamName || !agentId) {
    return []
  }

  // Only inject on first turn - check if there are no assistant messages yet
  const hasAssistantMessage = messages.some(m => m.type === 'assistant')
  if (hasAssistantMessage) {
    return []
  }

  const configDir = getClaudeConfigHomeDir()
  const teamConfigPath = `${configDir}/teams/${teamName}/config.json`
  const taskListPath = `${configDir}/tasks/${teamName}/`

  return [
    {
      type: 'team_context',
      agentId,
      agentName: agentName || agentId,
      teamName,
      teamConfigPath,
      taskListPath,
    },
  ]
}

function getTokenUsageAttachment(
  messages: Message[],
  model: string,
): Attachment[] {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT)) {
    return []
  }

  const contextWindow = getEffectiveContextWindowSize(model)
  const usedTokens = tokenCountFromLastAPIResponse(messages)

  return [
    {
      type: 'token_usage',
      used: usedTokens,
      total: contextWindow,
      remaining: contextWindow - usedTokens,
    },
  ]
}

function getOutputTokenUsageAttachment(): Attachment[] {
  if (feature('TOKEN_BUDGET')) {
    const budget = getCurrentTurnTokenBudget()
    if (budget === null || budget <= 0) {
      return []
    }
    return [
      {
        type: 'output_token_usage',
        turn: getTurnOutputTokens(),
        session: getTotalOutputTokens(),
        budget,
      },
    ]
  }
  return []
}

function getMaxBudgetUsdAttachment(maxBudgetUsd?: number): Attachment[] {
  if (maxBudgetUsd === undefined) {
    return []
  }

  const usedCost = getTotalCostUSD()
  const remainingBudget = maxBudgetUsd - usedCost

  return [
    {
      type: 'budget_usd',
      used: usedCost,
      total: maxBudgetUsd,
      remaining: remainingBudget,
    },
  ]
}

/**
 * Count human turns since plan mode exit (plan_mode_exit attachment).
 * Returns 0 if no plan_mode_exit attachment found.
 *
 * tool_result messages are type:'user' without isMeta, so filter by
 * toolUseResult to avoid counting them — otherwise the 10-turn reminder
 * interval fires every ~10 tool calls instead of ~10 human turns.
 */
export function getVerifyPlanReminderTurnCount(messages: Message[]): number {
  let turnCount = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && isHumanTurn(message)) {
      turnCount++
    }
    // Stop counting at plan_mode_exit attachment (marks when implementation started)
    if (
      message?.type === 'attachment' &&
      message.attachment!.type === 'plan_mode_exit'
    ) {
      return turnCount
    }
  }
  // No plan_mode_exit found
  return 0
}

/**
 * Get verify plan reminder attachment if the model hasn't called VerifyPlanExecution yet.
 */
async function getVerifyPlanReminderAttachment(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (
    process.env.USER_TYPE !== 'ant' ||
    !isEnvTruthy(process.env.CLAUDE_CODE_VERIFY_PLAN)
  ) {
    return []
  }

  const appState = toolUseContext.getAppState()
  const pending = appState.pendingPlanVerification

  // Only remind if plan exists and verification not started or completed
  if (
    !pending ||
    pending.verificationStarted ||
    pending.verificationCompleted
  ) {
    return []
  }

  // Only remind every N turns
  if (messages && messages.length > 0) {
    const turnCount = getVerifyPlanReminderTurnCount(messages)
    if (
      turnCount === 0 ||
      turnCount % VERIFY_PLAN_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS !== 0
    ) {
      return []
    }
  }

  return [{ type: 'verify_plan_reminder' }]
}

export function getCompactionReminderAttachment(
  messages: Message[],
  model: string,
): Attachment[] {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_marble_fox', false)) {
    return []
  }

  if (!isAutoCompactEnabled()) {
    return []
  }

  const contextWindow = getContextWindowForModel(model, getSdkBetas())
  if (contextWindow < 1_000_000) {
    return []
  }

  const effectiveWindow = getEffectiveContextWindowSize(model)
  const usedTokens = tokenCountWithEstimation(messages)
  if (usedTokens < effectiveWindow * 0.25) {
    return []
  }

  return [{ type: 'compaction_reminder' }]
}

/**
 * Context-efficiency nudge. Injected after every N tokens of growth without
 * a snip. Pacing is handled entirely by shouldNudgeForSnips — the 10k
 * interval resets on prior nudges, snip markers, snip boundaries, and
 * compact boundaries.
 */
export function getContextEfficiencyAttachment(
  messages: Message[],
): Attachment[] {
  if (!feature('HISTORY_SNIP')) {
    return []
  }
  // Gate must match SnipTool.isEnabled() — don't nudge toward a tool that
  // isn't in the tool list. Lazy require keeps this file snip-string-free.
  const { isSnipRuntimeEnabled, shouldNudgeForSnips } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../services/compact/snipCompact.js') as typeof import('../services/compact/snipCompact.js')
  if (!isSnipRuntimeEnabled()) {
    return []
  }

  if (!shouldNudgeForSnips(messages)) {
    return []
  }

  return [{ type: 'context_efficiency' }]
}

function isFileReadDenied(
  filePath: string,
  toolPermissionContext: ToolPermissionContext,
): boolean {
  const denyRule = matchingRuleForInput(
    filePath,
    toolPermissionContext,
    'read',
    'deny',
  )
  return denyRule !== null
}
