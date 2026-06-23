import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import { dirname } from 'path'
import {
  getMainLoopModelOverride,
  getSessionId,
  setMainLoopModelOverride,
  setMainThreadAgentType,
  setOriginalCwd,
  switchSession,
} from '../bootstrap/state.js'
import { clearSystemPromptSections } from '../constants/systemPromptSections.js'
import { restoreCostStateForSession } from '../cost-tracker.js'
import type { AppState } from '../state/AppState.js'
import type { AgentColorName } from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js'
import {
  type AgentDefinition,
  type AgentDefinitionsResult,
  getActiveAgentsFromList,
  getAgentDefinitionsWithOverrides,
} from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { TODO_WRITE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/TodoWriteTool/constants.js'
import { asSessionId } from '../types/ids.js'
import type {
  AttributionSnapshotMessage,
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
  PersistedWorktreeSession,
} from '../types/logs.js'
import type { Message } from '../types/message.js'
import { renameRecordingForSession } from './asciicast.js'
import { clearMemoryFileCaches } from './claudemd.js'
import {
  type AttributionState,
  attributionRestoreStateFromLog,
  restoreAttributionStateFromSnapshots,
} from './commitAttribution.js'
import { updateSessionName } from './concurrentSessions.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import type { FileHistorySnapshot } from './fileHistory.js'
import { fileHistoryRestoreStateFromLog } from './fileHistory.js'
import { createSystemMessage } from './messages.js'
import { parseUserSpecifiedModel } from './model/model.js'
import { getPlansDirectory } from './plans.js'
import { setCwd } from './Shell.js'
import {
  adoptResumedSessionFile,
  recordContentReplacement,
  resetSessionFilePointer,
  restoreSessionMetadata,
  saveMode,
  saveWorktreeState,
} from './sessionStorage.js'
import { isTodoV2Enabled } from './tasks.js'
import type { TodoList } from './todo/types.js'
import { TodoListSchema } from './todo/types.js'
import type { ContentReplacementRecord } from './toolResultStorage.js'
import {
  getCurrentWorktreeSession,
  restoreWorktreeSession,
} from './worktree.js'

type ResumeResult = {
  messages?: Message[]
  fileHistorySnapshots?: FileHistorySnapshot[]
  attributionSnapshots?: AttributionSnapshotMessage[]
  contextCollapseCommits?: ContextCollapseCommitEntry[]
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry
}

/**
 * 扫描对话记录，找到最后一个 TodoWrite tool_use 块并返回其 todos。
 * 用于在 SDK --resume 时填充 AppState.todos，使模型的 todo 列表
 * 在会话重启后无需文件持久化即可保留。
 */
function extractTodosFromTranscript(messages: Message[]): TodoList {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.type !== 'assistant') continue
    const toolUse = (msg.message!.content as any[]).find(
      block => block.type === 'tool_use' && block.name === TODO_WRITE_TOOL_NAME,
    )
    if (!toolUse || toolUse.type !== 'tool_use') continue
    const input = toolUse.input
    if (input === null || typeof input !== 'object') return []
    const parsed = TodoListSchema().safeParse(
      (input as Record<string, unknown>).todos,
    )
    return parsed.success ? parsed.data : []
  }
  return []
}

/**
 * 在恢复时从日志中恢复会话状态（文件历史、归因、todos）。
 * 同时用于 SDK（print.ts）和交互式（REPL.tsx, main.tsx）恢复路径。
 */
export function restoreSessionStateFromLog(
  result: ResumeResult,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  // 恢复文件历史状态
  if (result.fileHistorySnapshots && result.fileHistorySnapshots.length > 0) {
    fileHistoryRestoreStateFromLog(result.fileHistorySnapshots, newState => {
      setAppState(prev => ({ ...prev, fileHistory: newState }))
    })
  }

  // 恢复归因状态（仅限 ant 功能）
  if (
    feature('COMMIT_ATTRIBUTION') &&
    result.attributionSnapshots &&
    result.attributionSnapshots.length > 0
  ) {
    attributionRestoreStateFromLog(result.attributionSnapshots, newState => {
      setAppState(prev => ({ ...prev, attribution: newState }))
    })
  }

  // 恢复上下文折叠提交日志 + 暂存快照。必须在首次 query() 之前运行，
  // 这样 projectView() 才能从恢复的 Message[] 中重建折叠视图。
  // 无条件调用（即使 entries 为 undefined/empty），因为 restoreFromEntries
  // 会先重置 store —— 若不这样做，会话内 /resume 到一个没有提交记录的
  // 会话时，会留下上一个会话的陈旧提交日志。
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    ;(
      require('../services/contextCollapse/persist.js') as typeof import('../services/contextCollapse/persist.js')
    ).restoreFromEntries(
      result.contextCollapseCommits ?? [],
      result.contextCollapseSnapshot,
    )
    /* eslint-enable @typescript-eslint/no-require-imports */
  }

  // 从对话记录中恢复 TodoWrite 状态（仅限 SDK/非交互式）。
  // 交互式模式使用文件支持的 v2 任务，因此 AppState.todos 在那里不使用。
  if (!isTodoV2Enabled() && result.messages && result.messages.length > 0) {
    const todos = extractTodosFromTranscript(result.messages)
    if (todos.length > 0) {
      const agentId = getSessionId()
      setAppState(prev => ({
        ...prev,
        todos: { ...prev.todos, [agentId]: todos },
      }))
    }
  }
}

/**
 * 从日志快照计算恢复的归因状态。
 * 用于在渲染前计算初始状态（例如 main.tsx --continue）。
 * 如果归因功能被禁用或不存在快照则返回 undefined。
 */
export function computeRestoredAttributionState(
  result: ResumeResult,
): AttributionState | undefined {
  if (
    feature('COMMIT_ATTRIBUTION') &&
    result.attributionSnapshots &&
    result.attributionSnapshots.length > 0
  ) {
    return restoreAttributionStateFromSnapshots(result.attributionSnapshots)
  }
  return undefined
}

/**
 * 计算用于会话恢复的独立 agent 上下文（名称/颜色）。
 * 用于在渲染前计算初始状态（遵循 CLAUDE.md 指南）。
 * 如果会话未设置名称/颜色则返回 undefined。
 */
export function computeStandaloneAgentContext(
  agentName: string | undefined,
  agentColor: string | undefined,
): AppState['standaloneAgentContext'] | undefined {
  if (!agentName && !agentColor) {
    return undefined
  }
  return {
    name: agentName ?? '',
    color: (agentColor === 'default' ? undefined : agentColor) as
      | AgentColorName
      | undefined,
  }
}

/**
 * 从已恢复的会话中还原 agent 设置。
 *
 * 恢复使用了自定义 agent 的对话时，重新应用 agent 类型和模型覆盖
 * （除非用户在 CLI 中指定了 --agent）。
 * 通过 setMainThreadAgentType / setMainLoopModelOverride 修改 bootstrap 状态。
 *
 * 返回已恢复的 agent 定义及其 agentType 字符串，若未恢复任何 agent 则返回 undefined。
 */
export function restoreAgentFromSession(
  agentSetting: string | undefined,
  currentAgentDefinition: AgentDefinition | undefined,
  agentDefinitions: AgentDefinitionsResult,
): {
  agentDefinition: AgentDefinition | undefined
  agentType: string | undefined
} {
  // 如果用户已在 CLI 中指定 --agent，保留该定义
  if (currentAgentDefinition) {
    return { agentDefinition: currentAgentDefinition, agentType: undefined }
  }

  // 如果会话没有 agent，清除任何陈旧的 bootstrap 状态
  if (!agentSetting) {
    setMainThreadAgentType(undefined)
    return { agentDefinition: undefined, agentType: undefined }
  }

  const resumedAgent = agentDefinitions.activeAgents.find(
    agent => agent.agentType === agentSetting,
  )
  if (!resumedAgent) {
    logForDebugging(
      `Resumed session had agent "${agentSetting}" but it is no longer available. Using default behavior.`,
    )
    setMainThreadAgentType(undefined)
    return { agentDefinition: undefined, agentType: undefined }
  }

  setMainThreadAgentType(resumedAgent.agentType)

  // 如果用户未指定模型，应用 agent 的模型
  if (
    !getMainLoopModelOverride() &&
    resumedAgent.model &&
    resumedAgent.model !== 'inherit'
  ) {
    setMainLoopModelOverride(parseUserSpecifiedModel(resumedAgent.model))
  }

  return { agentDefinition: resumedAgent, agentType: resumedAgent.agentType }
}

/**
 * 在协调器/普通模式切换后刷新 agent 定义。
 *
 * 恢复处于不同模式（协调器 vs 普通）的会话时，
 * 需要重新推导内置 agents 以匹配新模式。CLI 提供的
 * agents（来自 --agents 标志）会被合并回来。
 */
export async function refreshAgentDefinitionsForModeSwitch(
  modeWasSwitched: boolean,
  currentCwd: string,
  cliAgents: AgentDefinition[],
  currentAgentDefinitions: AgentDefinitionsResult,
): Promise<AgentDefinitionsResult> {
  if (!feature('COORDINATOR_MODE') || !modeWasSwitched) {
    return currentAgentDefinitions
  }

  // 模式切换后重新推导 agent 定义，使内置 agents
  // 反映新的协调器/普通模式
  getAgentDefinitionsWithOverrides.cache.clear?.()
  const freshAgentDefs = await getAgentDefinitionsWithOverrides(currentCwd)
  const freshAllAgents = [...freshAgentDefs.allAgents, ...cliAgents]
  return {
    ...freshAgentDefs,
    allAgents: freshAllAgents,
    activeAgents: getActiveAgentsFromList(freshAllAgents),
  }
}

/**
 * 处理已恢复/已继续对话以供渲染的结果。
 */
export type ProcessedResume = {
  messages: Message[]
  fileHistorySnapshots?: FileHistorySnapshot[]
  contentReplacements?: ContentReplacementRecord[]
  agentName: string | undefined
  agentColor: AgentColorName | undefined
  restoredAgentDef: AgentDefinition | undefined
  initialState: AppState
}

/**
 * 会话恢复所需的协调器模式模块 API 子集。
 */
type CoordinatorModeApi = {
  matchSessionMode(mode?: string): string | undefined
  isCoordinatorMode(): boolean
}

/**
 * 已加载的对话数据（loadConversationForResume 的返回类型）。
 */
type ResumeLoadResult = {
  messages: Message[]
  fileHistorySnapshots?: FileHistorySnapshot[]
  attributionSnapshots?: AttributionSnapshotMessage[]
  contentReplacements?: ContentReplacementRecord[]
  contextCollapseCommits?: ContextCollapseCommitEntry[]
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry
  sessionId: UUID | undefined
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
  goal?: import('../types/logs.js').GoalState
}

/**
 * 在恢复时还原 worktree 工作目录。对话记录保存了最后一次 worktree
 * 进入/退出的记录；如果会话在 worktree 内崩溃（最后条目为 session 对象
 * 而非 null），则切换回该目录。
 *
 * process.chdir 是安全的存在性检查 —— 如果 /exit 对话框删除了目录，
 * 或用户在两次会话之间手动删除了目录，它会抛出 ENOENT。
 *
 * 当 --worktree 已经创建了新的 worktree 时，其优先级高于恢复会话的状态。
 * restoreSessionMetadata 刚刚用陈旧的对话记录值覆盖了
 * project.currentSessionWorktree，因此在 adoptResumedSessionFile
 * 写回磁盘之前，在此处重新断言新的 worktree。
 */
export function restoreWorktreeForResume(
  worktreeSession: PersistedWorktreeSession | null | undefined,
): void {
  const fresh = getCurrentWorktreeSession()
  if (fresh) {
    saveWorktreeState(fresh)
    return
  }
  if (!worktreeSession) return

  try {
    process.chdir(worktreeSession.worktreePath)
  } catch {
    // 目录已消失。覆盖陈旧的缓存，使下一次
    // reAppendSessionMetadata 记录"已退出"，而不是重新持久化
    // 一个不再存在的路径。
    saveWorktreeState(null)
    return
  }

  setCwd(worktreeSession.worktreePath)
  setOriginalCwd(getCwd())
  // 此处有意不设置 projectRoot。对话记录未记录 worktree 是通过
  // --worktree（会设置 projectRoot）还是 EnterWorktreeTool（不设置）进入的。
  // 保持 projectRoot 稳定与 EnterWorktreeTool 的行为一致 ——
  // skills/history 保持锚定到原始项目。
  restoreWorktreeSession(worktreeSession)
  // /resume 斜杠命令在会话中途调用此函数，此时缓存已针对旧的 cwd 填充。
  // 对于 CLI 标志路径来说是廉价的空操作（那里缓存尚未填充）。
  clearMemoryFileCaches()
  clearSystemPromptSections()
  getPlansDirectory.cache.clear?.()
}

/**
 * 在会话中途 /resume 切换到另一个会话之前，撤销 restoreWorktreeForResume 的操作。
 * 若不如此，从 worktree 会话 /resume 到非 worktree 会话会使用户停留在旧的
 * worktree 目录中，且 currentWorktreeSession 仍指向上一个会话。/resume 到
 * 另一个 worktree 则会完全失败 —— 上方的 getCurrentWorktreeSession() 守卫
 * 会阻止切换。
 *
 * CLI --resume/--continue 不需要此函数：那些在启动时运行一次，
 * 此时 getCurrentWorktreeSession() 仅在使用了 --worktree 时为真
 *（应优先处理的新 worktree，由上方的重新断言处理）。
 */
export function exitRestoredWorktree(): void {
  const current = getCurrentWorktreeSession()
  if (!current) return

  restoreWorktreeSession(null)
  // worktree 状态已变化，因此无论下方的 chdir 是否成功，
  // 引用它的缓存提示词片段都已过时。
  clearMemoryFileCaches()
  clearSystemPromptSections()
  getPlansDirectory.cache.clear?.()

  try {
    process.chdir(current.originalCwd)
  } catch {
    // 原始目录已消失（罕见）。原地不动 —— 如果有目标 worktree，
    // restoreWorktreeForResume 下次会切换进去。
    return
  }
  setCwd(current.originalCwd)
  setOriginalCwd(getCwd())
}

/**
 * 处理已加载的对话以供恢复/继续。
 *
 * 处理协调器模式匹配、会话 ID 设置、agent 恢复、
 * 模式持久化和初始状态计算。由 main.tsx 中的
 * --continue 和 --resume 路径调用。
 */
export async function processResumedConversation(
  result: ResumeLoadResult,
  opts: {
    forkSession: boolean
    sessionIdOverride?: string
    transcriptPath?: string
    includeAttribution?: boolean
  },
  context: {
    modeApi: CoordinatorModeApi | null
    mainThreadAgentDefinition: AgentDefinition | undefined
    agentDefinitions: AgentDefinitionsResult
    currentCwd: string
    cliAgents: AgentDefinition[]
    initialState: AppState
  },
): Promise<ProcessedResume> {
  // 将协调器/普通模式匹配到恢复的会话
  let modeWarning: string | undefined
  if (feature('COORDINATOR_MODE')) {
    modeWarning = context.modeApi?.matchSessionMode(result.mode)
    if (modeWarning) {
      result.messages.push(createSystemMessage(modeWarning, 'warning'))
    }
  }

  // 复用恢复会话的 ID，除非指定了 --fork-session
  if (!opts.forkSession) {
    const sid = opts.sessionIdOverride ?? result.sessionId
    if (sid) {
      // 从不同项目目录（git worktrees、跨项目）恢复时，
      // transcriptPath 指向实际文件；其 dirname 是项目目录。
      // 否则会话存在于当前项目中。
      switchSession(
        asSessionId(sid),
        opts.transcriptPath ? dirname(opts.transcriptPath) : null,
      )
      // 将 asciicast 录制重命名以匹配恢复的会话 ID，
      // 使 getSessionRecordingPaths() 在 /share 时能够发现它
      await renameRecordingForSession()
      await resetSessionFilePointer()
      restoreCostStateForSession(sid)
    }
  } else if (result.contentReplacements?.length) {
    // --fork-session 保留新启动的会话 ID。useLogMessages 会
    // 通过 recordTranscript 将源消息复制到新的 JSONL 中，但
    // content-replacement 条目是一种独立的条目类型，只由
    // recordContentReplacement 写入（query.ts 为 newlyReplaced 调用，
    // 从不处理预加载的记录）。若不预填充，`claude -r {newSessionId}`
    // 在消息中找到源 tool_use_ids 但没有匹配的替换记录
    // → 它们被分类为 FROZEN → 发送完整内容（缓存未命中，永久超量）。
    // insertContentReplacement 用 sessionId = getSessionId() = 新 ID
    // 标记，因此 loadTranscriptFile 的键值查找将匹配。
    await recordContentReplacement(result.contentReplacements)
  }

  // 恢复会话元数据，使 /status 显示保存的名称，并在
  // 会话退出时重新追加元数据。Fork 不接管
  // 原始会话的 worktree —— 对 fork 退出对话框执行"移除"
  // 会删除原始会话仍在引用的 worktree —— 因此
  // 从 fork 路径中剥离 worktreeSession，使缓存保持未设置状态。
  restoreSessionMetadata(
    opts.forkSession ? { ...result, worktreeSession: undefined } : result,
  )

  if (feature('GOAL') && result.goal) {
    const { hydrateGoalFromTranscript } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../services/goal/goalStorage.js') as typeof import('../services/goal/goalStorage.js')
    const goalsMap = new Map<UUID, import('../types/logs.js').GoalState>()
    const sid = (opts.sessionIdOverride ??
      result.sessionId ??
      getSessionId()) as UUID
    goalsMap.set(sid, result.goal)
    hydrateGoalFromTranscript(goalsMap, sid)
  }

  if (!opts.forkSession) {
    // 切换回会话最后退出时所在的 worktree。
    // 在 restoreSessionMetadata 之后执行（该函数从对话记录中
    // 缓存了 worktree 状态），这样如果目录已消失，
    // 我们可以在 adoptResumedSessionFile 写入前覆盖缓存。
    restoreWorktreeForResume(result.worktreeSession)

    // 将 sessionFile 指向恢复的对话记录并立即重新追加元数据。
    // 上方的 resetSessionFilePointer 将其置为 null（以防旧的新建会话
    // 路径泄漏），但这会阻止 reAppendSessionMetadata —— 它在 null 时
    // 退出 —— 在退出清理处理程序中运行。对于 fork，
    // useLogMessages 在 REPL 挂载时通过 recordTranscript 填充一个*新*文件；
    // 那里的正常懒物化路径是正确的。
    adoptResumedSessionFile()
  }

  // 恢复上下文折叠提交日志 + 暂存快照。交互式
  // /resume 路径通过 restoreSessionStateFromLog（REPL.tsx）处理；
  // CLI --continue/--resume 则经过此处。无条件调用
  // —— 原因见上方 restoreSessionStateFromLog 调用处的注释。
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    ;(
      require('../services/contextCollapse/persist.js') as typeof import('../services/contextCollapse/persist.js')
    ).restoreFromEntries(
      result.contextCollapseCommits ?? [],
      result.contextCollapseSnapshot,
    )
    /* eslint-enable @typescript-eslint/no-require-imports */
  }

  // 从恢复的会话中还原 agent 设置
  const { agentDefinition: restoredAgent, agentType: resumedAgentType } =
    restoreAgentFromSession(
      result.agentSetting,
      context.mainThreadAgentDefinition,
      context.agentDefinitions,
    )

  // 持久化当前模式，使未来的恢复知道此会话处于何种模式
  if (feature('COORDINATOR_MODE')) {
    saveMode(context.modeApi?.isCoordinatorMode() ? 'coordinator' : 'normal')
  }

  // 在渲染前计算初始状态（遵循 CLAUDE.md 指南）
  const restoredAttribution = opts.includeAttribution
    ? computeRestoredAttributionState(result)
    : undefined
  const standaloneAgentContext = computeStandaloneAgentContext(
    result.agentName,
    result.agentColor,
  )
  void updateSessionName(result.agentName)
  const refreshedAgentDefs = await refreshAgentDefinitionsForModeSwitch(
    !!modeWarning,
    context.currentCwd,
    context.cliAgents,
    context.agentDefinitions,
  )

  return {
    messages: result.messages,
    fileHistorySnapshots: result.fileHistorySnapshots,
    contentReplacements: result.contentReplacements,
    agentName: result.agentName,
    agentColor: (result.agentColor === 'default'
      ? undefined
      : result.agentColor) as AgentColorName | undefined,
    restoredAgentDef: restoredAgent,
    initialState: {
      ...context.initialState,
      ...(resumedAgentType && { agent: resumedAgentType }),
      ...(restoredAttribution && { attribution: restoredAttribution }),
      ...(standaloneAgentContext && { standaloneAgentContext }),
      agentDefinitions: refreshedAgentDefs,
    },
  }
}
