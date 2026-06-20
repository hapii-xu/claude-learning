/**
 * 会话缓存清理工具。
 * 此模块在启动时由 main.tsx 导入，因此请保持 import 最小化。
 */
import { feature } from 'bun:bundle'
import {
  clearInvokedSkills,
  setLastEmittedDate,
} from '../../bootstrap/state.js'
import { clearCommandsCache } from '../../commands.js'
import { getSessionStartDate } from '../../constants/common.js'
import {
  getGitStatus,
  getSystemContext,
  getUserContext,
  setSystemPromptInjection,
} from '../../context.js'
import { clearFileSuggestionCaches } from '../../hooks/fileSuggestions.js'
import { clearAllPendingCallbacks } from '../../hooks/useSwarmPermissionPoller.js'
import { clearAllDumpState } from '../../services/api/dumpPrompts.js'
import { resetPromptCacheBreakDetection } from '../../services/api/promptCacheBreakDetection.js'
import { clearAllSessions } from '../../services/api/sessionIngress.js'
import { runPostCompactCleanup } from '../../services/compact/postCompactCleanup.js'
import { resetAllLSPDiagnosticState } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { clearTrackedMagicDocs } from '../../services/MagicDocs/magicDocs.js'
import { clearDynamicSkills } from '../../skills/loadSkillsDir.js'
import { resetSentSkillNames } from '../../utils/attachments.js'
import { clearCommandPrefixCaches } from '../../utils/bash/commands.js'
import { resetGetMemoryFilesCache } from '../../utils/claudemd.js'
import { clearRepositoryCaches } from '../../utils/detectRepository.js'
import { clearResolveGitDirCache } from '../../utils/git/gitFilesystem.js'
import { clearStoredImagePaths } from '../../utils/imageStore.js'
import { clearSessionEnvVars } from '../../utils/sessionEnvVars.js'

/**
 * 清理所有与会话相关的缓存。
 * 在恢复会话时调用以确保重新发现文件/skill。
 * 这是 clearConversation 所做工作的一个子集 —— 仅清理缓存，
 * 不影响消息、会话 ID，也不会触发 hooks。
 *
 * @param preservedAgentIds - 其 per-agent 状态应在清理后保留的 agent ID
 *  （例如跨 /clear 保留的后台任务）。当非空时，
 *   以 agentId 为 key 的状态（已调用的 skills）会被选择性清理，而以 requestId 为 key 的
 *   状态（待处理的权限回调、dump 状态、cache-break 跟踪）会被完整保留，
 *   因为它无法安全地限定到主会话。
 */
export function clearSessionCaches(
  preservedAgentIds: ReadonlySet<string> = new Set(),
): void {
  const hasPreserved = preservedAgentIds.size > 0
  // 清理 context 缓存
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
  getGitStatus.cache.clear?.()
  getSessionStartDate.cache.clear?.()
  // 清理文件建议缓存（用于 @ 提及）
  clearFileSuggestionCaches()

  // 清理 commands/skills 缓存
  clearCommandsCache()

  // 清理 prompt cache break 检测状态
  if (!hasPreserved) resetPromptCacheBreakDetection()

  // 清理 system prompt 注入（cache breaker）
  setSystemPromptInjection(null)

  // 清理 last emitted date，以便下一轮重新检测
  setLastEmittedDate(null)

  // 执行 post-compaction 清理（清理 system prompt 各段、microcompact 跟踪、
  // classifier 审批、speculative 检查，以及 —— 对于主线程 compact —— 以
  // load_reason 'compact' 清理 memory 文件缓存）。
  runPostCompactCleanup()
  // 重置已发送的 skill 名称，以便 /clear 后重新发送 skill 列表。
  // runPostCompactCleanup 有意不重置此项（post-compact 重新注入约消耗
  // 4K tokens），但 /clear 会彻底清除消息，因此模型需要完整的列表。
  resetSentSkillNames()
  // 用 'session_start' 覆盖 memory 缓存重置：clearSessionCaches 会从
  // /clear 和 --resume/--continue 调用，它们不是 compaction 事件。如果不这样做，
  // InstructionsLoaded hook 在下一次 getMemoryFiles() 调用时会以
  // load_reason 'compact' 而非 'session_start' 触发。
  resetGetMemoryFilesCache('session_start')

  // 清理已存储的图片路径缓存
  clearStoredImagePaths()

  // 清理所有 session ingress 缓存（lastUuidMap、sequentialAppendBySession）
  clearAllSessions()
  // 清理 swarm 权限待处理回调
  if (!hasPreserved) clearAllPendingCallbacks()

  // 清理 tungsten 会话用量跟踪
  if (process.env.USER_TYPE === 'ant') {
    void import(
      '@claude-code-best/builtin-tools/tools/TungstenTool/TungstenTool.js'
    ).then(({ clearSessionsWithTungstenUsage, resetInitializationState }) => {
      clearSessionsWithTungstenUsage()
      resetInitializationState()
    })
  }
  // 清理 attribution 缓存（文件内容缓存、待处理 bash 状态）
  // 动态 import 以保留 COMMIT_ATTRIBUTION feature flag 的死代码消除
  if (feature('COMMIT_ATTRIBUTION')) {
    void import('../../utils/attributionHooks.js').then(
      ({ clearAttributionCaches }) => clearAttributionCaches(),
    )
  }
  // 清理仓库检测缓存
  clearRepositoryCaches()
  // 清理 bash 命令前缀缓存（Haiku 提取的前缀）
  clearCommandPrefixCaches()
  // 清理 dump prompts 状态
  if (!hasPreserved) clearAllDumpState()
  // 清理已调用的 skills 缓存（每个条目保存完整的 skill 文件内容）
  clearInvokedSkills(preservedAgentIds)
  // 清理 git 目录解析缓存
  clearResolveGitDirCache()
  // 清理动态 skills（从 skill 目录加载）
  clearDynamicSkills()
  // 清理 LSP 诊断跟踪状态
  resetAllLSPDiagnosticState()
  // 清理已跟踪的 magic docs
  clearTrackedMagicDocs()
  // 清理会话环境变量
  clearSessionEnvVars()
  // 清理 WebFetch URL 缓存（最多 50MB 的缓存页面内容）
  void import(
    '@claude-code-best/builtin-tools/tools/WebFetchTool/utils.js'
  ).then(({ clearWebFetchCache }) => clearWebFetchCache())
  // 清理 SearchExtraTools 描述缓存（完整工具 prompts，50 个 MCP 工具约 500KB）
  void import(
    '@claude-code-best/builtin-tools/tools/SearchExtraToolsTool/SearchExtraToolsTool.js'
  ).then(({ clearSearchExtraToolsDescriptionCache }) =>
    clearSearchExtraToolsDescriptionCache(),
  )
  // 清理 agent 定义缓存（通过 EnterWorktreeTool 按 cwd 累积）
  void import(
    '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
  ).then(({ clearAgentDefinitionsCache }) => clearAgentDefinitionsCache())
  // 清理 SkillTool prompt 缓存（按项目根目录累积）
  void import('@claude-code-best/builtin-tools/tools/SkillTool/prompt.js').then(
    ({ clearPromptCache }) => clearPromptCache(),
  )
}
