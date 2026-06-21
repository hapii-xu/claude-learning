import type { UUID } from 'crypto'
import type { FileHistorySnapshot } from 'src/utils/fileHistory.js'
import type { ContentReplacementRecord } from 'src/utils/toolResultStorage.js'
import type { AgentId } from './ids.js'
import type { Message } from './message.js'
import type { QueueOperationMessage } from './messageQueueTypes.js'

export type SerializedMessage = Message & {
  cwd: string
  userType: string
  entrypoint?: string // CLAUDE_CODE_ENTRYPOINT —— 区分 cli/sdk-ts/sdk-py 等
  sessionId: string
  timestamp: string
  version: string
  gitBranch?: string
  slug?: string // 用于文件（如 plans）的 session slug（用于 resume）
}

export type LogOption = {
  date: string
  messages: SerializedMessage[]
  fullPath?: string
  value: number
  created: Date
  modified: Date
  firstPrompt: string
  messageCount: number
  fileSize?: number // 文件大小（字节，用于展示）
  isSidechain: boolean
  isLite?: boolean // 为 true 表示 lite log（未加载 messages）
  sessionId?: string // lite log 的 session ID
  teamName?: string // 如果是由 swarm teammate 创建的 session，则为 team 名
  agentName?: string // agent 的自定义名（来自 /rename 或 swarm）
  agentColor?: string // agent 的颜色（来自 /rename 或 swarm）
  agentSetting?: string // 所用的 agent 定义（来自 --agent 标志或 settings.agent）
  isTeammate?: boolean // 该 session 是否由 swarm teammate 创建
  leafUuid?: UUID // 若给出，则该 uuid 必须出现在 DB 中
  summary?: string // 可选的对话摘要
  customTitle?: string // 可选的用户自定义标题
  tag?: string // session 的可选 tag（可在 /resume 中搜索）
  fileHistorySnapshots?: FileHistorySnapshot[] // 可选的文件历史快照
  attributionSnapshots?: AttributionSnapshotMessage[] // 可选的归属快照
  contextCollapseCommits?: ContextCollapseCommitEntry[] // 有序 —— commit B 可能引用 commit A 的摘要
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry // last-wins —— 暂存队列 + spawn 状态
  gitBranch?: string // session 结束时的 Git 分支
  projectPath?: string // 原始项目目录路径
  prNumber?: number // 关联到该 session 的 GitHub PR 编号
  prUrl?: string // 关联 PR 的完整 URL
  prRepository?: string // 仓库，格式为 "owner/repo"
  mode?: 'coordinator' | 'normal' // 用于检测 coordinator/normal 的 session 模式
  worktreeSession?: PersistedWorktreeSession | null // session 结束时的 worktree 状态（null = 已退出，undefined = 从未进入）
  contentReplacements?: ContentReplacementRecord[] // 用于 resume 重建的替换决策
  goal?: GoalState // session 结束时的活动 goal 状态（用于 resume）
}

export type SummaryMessage = {
  type: 'summary'
  leafUuid: UUID
  summary: string
}

export type CustomTitleMessage = {
  type: 'custom-title'
  sessionId: UUID
  customTitle: string
}

/**
 * AI 生成的 session 标题。与 CustomTitleMessage 区分开，原因：
 * - 在读取优先级上，用户重命名（custom-title）总是优先于 AI 标题
 * - reAppendSessionMetadata 永远不会重新追加 AI 标题（它们是临时的、
 *   可重新生成的；重新追加会在 resume 时覆盖用户的重命名）
 * - VS Code 的 onlyIfNoCustomTitle CAS 检查只匹配用户标题，
 *   允许 AI 覆盖自己之前的 AI 标题，但不能覆盖用户标题
 */
export type AiTitleMessage = {
  type: 'ai-title'
  sessionId: UUID
  aiTitle: string
}

export type LastPromptMessage = {
  type: 'last-prompt'
  sessionId: UUID
  lastPrompt: string
}

/**
 * 周期性 fork 生成的摘要，描述 agent 当前正在做什么。
 * 在回合中途通过 fork 主线程写入，频率为 min(5 步, 2 分钟)，这样
 * `claude ps` 可以展示比最后一条用户 prompt（通常是 "ok go" 或
 * "fix it"）更有用的信息。
 */
export type TaskSummaryMessage = {
  type: 'task-summary'
  sessionId: UUID
  summary: string
  timestamp: string
}

export type TagMessage = {
  type: 'tag'
  sessionId: UUID
  tag: string
}

export type AgentNameMessage = {
  type: 'agent-name'
  sessionId: UUID
  agentName: string
}

export type AgentColorMessage = {
  type: 'agent-color'
  sessionId: UUID
  agentColor: string
}

export type AgentSettingMessage = {
  type: 'agent-setting'
  sessionId: UUID
  agentSetting: string
}

/**
 * 存储在 session transcript 中的 PR 链接消息。
 * 将 session 关联到 GitHub pull request，用于跟踪和导航。
 */
export type PRLinkMessage = {
  type: 'pr-link'
  sessionId: UUID
  prNumber: number
  prUrl: string
  prRepository: string // 例如 "owner/repo"
  timestamp: string // 关联时的 ISO 时间戳
}

export type ModeEntry = {
  type: 'mode'
  sessionId: UUID
  mode: 'coordinator' | 'normal'
}

/**
 * 持久化线程 goal 的生命周期状态。
 * - active：agent 应自动朝着目标继续
 * - paused：用户暂时中止了进度
 * - blocked：模型在 >=3 个连续回合中报告了同一个阻塞原因
 * - budget_limited：tokensUsed >= tokenBudget（自动转换）
 * - usage_limited：provider 触发速率/用量限制（自动转换）
 * - max_turns：自动延续到达 MAX_GOAL_TURNS 安全上限
 * - complete：模型审计确认目标已达成
 */
export type GoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'budget_limited'
  | 'usage_limited'
  | 'max_turns'
  | 'complete'

/**
 * 每个 session 的 goal 状态。每次变更时作为 `goal`
 * 条目持久化到 JSONL transcript；读取时 last-wins。
 *
 * 时间字段能正确处理暂停：`getActiveElapsedMs(state)`
 * = accumulatedActiveMs + (若处于活动状态则为 now - startTime，否则为 0)。
 *
 * `turnsExecuted` 是自动延续循环的防御性上限，
 * 防止失控的 goal 无限旋转。
 *
 * `blockedAttempts` + `lastBlockReason` 实现了 CODEX 的"只在连续 3 次
 * 同一原因后才标记为 blocked"的审计规则。
 */
export type GoalState = {
  objective: string
  status: GoalStatus
  tokenBudget: number | null
  tokensUsed: number
  startTime: number
  pausedAt: number | null
  accumulatedActiveMs: number
  blockedAttempts: number
  lastBlockReason: string | null
  createdAt: number
  updatedAt: number
  turnsExecuted: number
}

/**
 * 表示 goal 状态检查点的 JSONL 条目。在每次变更
 *（set / pause / resume / complete / token update）时写入。读取方
 * 以每个 sessionId 的最新条目作为权威状态。
 */
export type GoalMetadataEntry = {
  type: 'goal'
  sessionId: UUID
  state: GoalState
  timestamp: string
}

/**
 * 表示用户显式清除了 goal 的 JSONL 条目。
 * 与 `complete`（保留达成记录）不同。读取方
 * 在 `goal` 条目之后遇到该条目时，应将 goal 视为
 * 不存在。
 */
export type GoalClearedEntry = {
  type: 'goal-cleared'
  sessionId: UUID
  timestamp: string
}

/**
 * 持久化到 transcript 以便 resume 的 worktree session 状态。
 * 是 utils/worktree.ts 中 WorktreeSession 的子集 —— 不包含那些只用于
 * 首次运行分析的临时字段（creationDurationMs、usedSparsePaths）。
 */
export type PersistedWorktreeSession = {
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch?: string
  originalBranch?: string
  originalHeadCommit?: string
  sessionId: string
  tmuxSessionName?: string
  hookBased?: boolean
}

/**
 * 记录 session 当前是否处于由 EnterWorktree 或
 * --worktree 创建的 worktree 中。last-wins：进入写入 session，
 * 退出写入 null。在 --resume 时，只有当 worktreePath 在磁盘上仍然
 * 存在时才恢复（/exit 对话框可能已经删除了它）。
 */
export type WorktreeStateEntry = {
  type: 'worktree-state'
  sessionId: UUID
  worktreeSession: PersistedWorktreeSession | null
}

/**
 * 记录其上下文表示已被替换为更小
 * 占位的内容块（完整内容被持久化在其他地方）。在 resume 时
 * 为了 prompt cache 稳定性而回放。在每次至少替换一个 block 的
 * 强制执行 pass 中写入一次。当 agentId 被设置时，记录属于 subagent
 * sidechain（AgentTool resume 读取这些）；未设置时属于主线程
 *（/resume 读取这些）。
 */
export type ContentReplacementEntry = {
  type: 'content-replacement'
  sessionId: UUID
  agentId?: AgentId
  replacements: ContentReplacementRecord[]
}

export type FileHistorySnapshotMessage = {
  type: 'file-history-snapshot'
  messageId: UUID
  snapshot: FileHistorySnapshot
  isSnapshotUpdate: boolean
}

/**
 * 每个文件的归属状态，跟踪 Claude 的字符贡献量。
 */
export type FileAttributionState = {
  contentHash: string // 文件内容的 SHA-256 hash
  claudeContribution: number // Claude 写入的字符数
  mtime: number // 文件修改时间
}

/**
 * 存储在 session transcript 中的归属快照消息。
 * 用于 commit 归属，跟踪 Claude 在字符级别的贡献。
 */
export type AttributionSnapshotMessage = {
  type: 'attribution-snapshot'
  messageId: UUID
  surface: string // 客户端 surface（cli、ide、web、api）
  fileStates: Record<string, FileAttributionState>
  promptCount?: number // session 中的 prompt 总数
  promptCountAtLastCommit?: number // 上次 commit 时的 prompt 数
  permissionPromptCount?: number // 展示的权限提示总数
  permissionPromptCountAtLastCommit?: number // 上次 commit 时的权限提示数
  escapeCount?: number // ESC 按键总数（取消的权限提示）
  escapeCountAtLastCommit?: number // 上次 commit 时的 ESC 按键数
}

export type TranscriptMessage = SerializedMessage & {
  parentUuid: UUID | null
  logicalParentUuid?: UUID | null // 当 parentUuid 因为 session 断开被置为 null 时，保留逻辑父级
  isSidechain: boolean
  gitBranch?: string
  agentId?: string // sidechain transcript 的 agent ID，用于恢复 agent
  teamName?: string // 如果是由 swarm teammate 创建的 session，则为 team 名
  agentName?: string // agent 的自定义名（来自 /rename 或 swarm）
  agentColor?: string // agent 的颜色（来自 /rename 或 swarm）
  promptId?: string // 与 OTel prompt.id 关联，用于 user prompt 消息
}

export type SpeculationAcceptMessage = {
  type: 'speculation-accept'
  timestamp: string
  timeSavedMs: number
}

/**
 * 持久化的 context-collapse commit。被归档的消息本身并不会被持久化 ——
 * 它们已经作为普通的 user/assistant 消息存在于 transcript 中。我们只持久化
 * 足够的信息来重建 splice 指令（边界 uuid）和
 * 摘要占位符（它不会出现在 transcript 中，因为它从未被 yield 给 REPL）。
 *
 * 在恢复时，store 用 archived=[] 重建 CommittedCollapse；
 * projectView 在首次发现该 span 时懒加载填充 archive。
 *
 * 判别字段被混淆，以匹配 gate 名。sessionStorage.ts
 * 不受 feature-gated（它是被每个 entry 类型使用的通用 transcript 管道），所以
 * 这里如果用描述性字符串，即便外部构建中没有任何地方写入或读取该 entry，
 * 也会通过 appendEntry 分发 / loadTranscriptFile 解析器泄漏到外部构建中。
 */
export type ContextCollapseCommitEntry = {
  type: 'marble-origami-commit'
  sessionId: UUID
  /** 16 位 collapse ID。所有条目中的最大值会重新播种 ID 计数器。 */
  collapseId: string
  /** 摘要占位符的 uuid —— registerSummary() 需要它。 */
  summaryUuid: string
  /** 完整的 <collapsed id="...">text</collapsed> 占位符字符串。 */
  summaryContent: string
  /** 用于 ctx_inspect 的纯摘要文本。 */
  summary: string
  /** span 边界 —— projectView 在恢复的 Message[] 中据此查找。 */
  firstArchivedUuid: string
  lastArchivedUuid: string
}

/**
 * 暂存队列和 spawn 触发器状态的快照。与 commit
 *（只追加、全部回放）不同，快照是 last-wins —— 恢复时只应用最近一次
 * 快照条目。每次 ctx-agent spawn 解析后写入
 *（此时暂存内容可能已发生变化）。
 *
 * 暂存的边界是 UUID（session 稳定），而不是 collapse ID（后者会
 * 随 uuidToId bimap 重置）。恢复暂存 span 会在下一次 decorate/display 时
 * 为这些消息发放新的 collapse ID，但
 * span 本身的解析仍然正确。
 */
export type ContextCollapseSnapshotEntry = {
  type: 'marble-origami-snapshot'
  sessionId: UUID
  staged: Array<{
    startUuid: string
    endUuid: string
    summary: string
    risk: number
    stagedAt: number
  }>
  /** Spawn 触发器状态 —— 让 +interval 时钟从上次中断处继续。 */
  armed: boolean
  lastSpawnTokens: number
}

export type Entry =
  | TranscriptMessage
  | SummaryMessage
  | CustomTitleMessage
  | AiTitleMessage
  | LastPromptMessage
  | TaskSummaryMessage
  | TagMessage
  | AgentNameMessage
  | AgentColorMessage
  | AgentSettingMessage
  | PRLinkMessage
  | FileHistorySnapshotMessage
  | AttributionSnapshotMessage
  | QueueOperationMessage
  | SpeculationAcceptMessage
  | ModeEntry
  | WorktreeStateEntry
  | ContentReplacementEntry
  | ContextCollapseCommitEntry
  | ContextCollapseSnapshotEntry
  | GoalMetadataEntry
  | GoalClearedEntry

export function sortLogs(logs: LogOption[]): LogOption[] {
  return logs.sort((a, b) => {
    // 按修改日期排序（最新在前）
    const modifiedDiff = b.modified.getTime() - a.modified.getTime()
    if (modifiedDiff !== 0) {
      return modifiedDiff
    }

    // 如果修改日期相同，按创建日期排序（最新在前）
    return b.created.getTime() - a.created.getTime()
  })
}
