import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Attributes, Meter, MetricOptions } from '@opentelemetry/api'
import type { logs } from '@opentelemetry/api-logs'
import type { LoggerProvider } from '@opentelemetry/sdk-logs'
import type { MeterProvider } from '@opentelemetry/sdk-metrics'
import type { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { realpathSync } from 'fs'
import sumBy from 'lodash-es/sumBy.js'
import { cwd } from 'process'
import type { HookEvent, ModelUsage } from 'src/entrypoints/agentSdkTypes.js'
import type { AgentColorName } from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js'
import type { HookCallbackMatcher } from 'src/types/hooks.js'
// 为 browser-sdk 构建提供间接引用（package.json 的 "browser" 字段会将
// crypto.ts 替换为 crypto.browser.ts）。这里纯粹是对 node:crypto 的叶子
// 重新导出——完全没有循环依赖风险。使用路径别名导入是为了绕过
// bootstrap 隔离规则（该规则只检查 ./ 和 / 前缀）；显式禁用该规则
// 是为了记录此意图。
// eslint-disable-next-line custom-rules/bootstrap-isolation
import { randomUUID } from 'src/utils/crypto.js'
import type { ModelSetting } from 'src/utils/model/model.js'
import type { ModelStrings } from 'src/utils/model/modelStrings.js'
import type { SettingSource } from 'src/utils/settings/constants.js'
import { resetSettingsCache } from 'src/utils/settings/settingsCache.js'
import type { PluginHookMatcher } from 'src/utils/settings/types.js'
import { createSignal } from 'src/utils/signal.js'

// 已注册钩子的联合类型——可以是 SDK 回调或原生插件钩子
type RegisteredHookMatcher = HookCallbackMatcher | PluginHookMatcher

import type { SessionId } from 'src/types/ids.js'

// 不要在此处添加更多状态——对待全局状态要谨慎

// dev: 对通过 --dangerously-load-development-channels 加载的条目设为 true。
// 允许列表检查会针对每个条目独立判断（而不是会话级别的
// hasDevChannels 标志），这样即使同时传入两个标志，开发对话框的
// 接受也不会让 --channels 的条目绕过允许列表检查。
export type ChannelEntry =
  | { kind: 'plugin'; name: string; marketplace: string; dev?: boolean }
  | { kind: 'server'; name: string; dev?: boolean }

export type AttributedCounter = {
  add(value: number, additionalAttributes?: Attributes): void
}

type State = {
  originalCwd: string
  // 稳定的项目根目录——启动时设置一次（包括通过 --worktree 标志），
  // 不会被会话中途的 EnterWorktreeTool 更新。
  // 用于项目标识（历史、技能、会话），而非文件操作。
  projectRoot: string
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  turnHookDurationMs: number
  turnToolDurationMs: number
  turnClassifierDurationMs: number
  turnToolCount: number
  turnHookCount: number
  turnClassifierCount: number
  startTime: number
  lastInteractionTime: number
  totalLinesAdded: number
  totalLinesRemoved: number
  hasUnknownModelCost: boolean
  cwd: string
  modelUsage: { [modelName: string]: ModelUsage }
  mainLoopModelOverride: ModelSetting | undefined
  initialMainLoopModel: ModelSetting
  modelStrings: ModelStrings | null
  isInteractive: boolean
  kairosActive: boolean
  // 当为 true 时，ensureToolResultPairing 在遇到不匹配时会抛出错误，
  // 而不是用合成的占位符进行修复。HFI 在启动时选择启用此选项，
  // 这样轨迹会快速失败，而不是基于虚假的 tool_results 进行模型训练。
  strictToolResultPairing: boolean
  sdkAgentProgressSummariesEnabled: boolean
  userMsgOptIn: boolean
  clientType: string
  sessionSource: string | undefined
  questionPreviewFormat: 'markdown' | 'html' | undefined
  flagSettingsPath: string | undefined
  flagSettingsInline: Record<string, unknown> | null
  allowedSettingSources: SettingSource[]
  sessionIngressToken: string | null | undefined
  oauthTokenFromFd: string | null | undefined
  apiKeyFromFd: string | null | undefined
  // 遥测状态
  meter: Meter | null
  sessionCounter: AttributedCounter | null
  locCounter: AttributedCounter | null
  prCounter: AttributedCounter | null
  commitCounter: AttributedCounter | null
  costCounter: AttributedCounter | null
  tokenCounter: AttributedCounter | null
  codeEditToolDecisionCounter: AttributedCounter | null
  activeTimeCounter: AttributedCounter | null
  statsStore: { observe(name: string, value: number): void } | null
  sessionId: SessionId
  // 用于跟踪会话谱系的父会话 ID（例如，计划模式 -> 实现）
  parentSessionId: SessionId | undefined
  // 日志记录器状态
  loggerProvider: LoggerProvider | null
  eventLogger: ReturnType<typeof logs.getLogger> | null
  // 指标提供器状态
  meterProvider: MeterProvider | null
  // 追踪器提供器状态
  tracerProvider: BasicTracerProvider | null
  // Agent 颜色状态
  agentColorMap: Map<string, AgentColorName>
  agentColorIndex: number
  // 最后一次 API 请求，用于错误报告
  lastAPIRequest: Omit<BetaMessageStreamParams, 'messages'> | null
  // 最后一次 API 请求的消息（仅限 ant——引用，非克隆）。
  // 捕获发送给 API 的精确压缩后、CLAUDE.md 注入的消息集合，
  // 以便 /share 的 serialized_conversation.json 反映真实情况。
  lastAPIRequestMessages: BetaMessageStreamParams['messages'] | null
  // 最后一次自动模式分类器请求，用于 /share 转录
  lastClassifierRequests: unknown[] | null
  // context.ts 为自动模式分类器缓存的 CLAUDE.md 内容。
  // 打破 yoloClassifier → claudemd → filesystem → permissions 的循环。
  cachedClaudeMdContent: string | null
  // 近期错误的内存日志
  inMemoryErrorLog: Array<{ error: string; timestamp: string }>
  // 来自 --plugin-dir 标志的仅限会话的插件
  inlinePlugins: Array<string>
  // 显式的 --chrome / --no-chrome 标志值（undefined 表示未在 CLI 中设置）
  chromeFlagOverride: boolean | undefined
  // 使用 cowork_plugins 目录而非 plugins（通过 --cowork 标志或环境变量）
  useCoworkPlugins: boolean
  // 仅限会话的绕过权限模式标志（不持久化）
  sessionBypassPermissionsMode: boolean
  // 控制 .claude/scheduled_tasks.json 观察器的仅限会话标志
  // （useScheduledTasks）。当 JSON 有条目时由 cronScheduler.start() 设置，
  // 或由 CronCreateTool 设置。不持久化。
  scheduledTasksEnabled: boolean
  // 通过 CronCreate 以 durable: false 创建的仅限会话的 cron 任务。
  // 按计划触发，类似于文件持久化的任务，但永远不会写入
  // .claude/scheduled_tasks.json——随进程终止而消失。通过下方的
  // SessionCronTask 类型定义（不导入 cronTasks.ts 以保持
  // bootstrap 位于导入 DAG 的叶子节点）。
  sessionCronTasks: SessionCronTask[]
  // 本会话通过 TeamCreate 创建的任务团队。cleanupSessionTeams()
  // 在 gracefulShutdown 时移除这些，这样子代理创建的任务团队
  // 就不会永久残留在磁盘上（gh-32730）。TeamDelete 会移除条目
  // 以避免重复清理。放在这里（而非 teamHelpers.ts）是为了让
  // resetStateForTests() 在测试之间清除它。
  sessionCreatedTeams: Set<string>
  // 主目录的仅限会话的信任标志（不持久化到磁盘）
  // 当从主目录运行时，信任对话框会显示但不会保存到磁盘。
  // 此标志允许需要信任的功能在会话期间正常工作。
  sessionTrustAccepted: boolean
  // 禁用会话持久化到磁盘的仅限会话标志
  sessionPersistenceDisabled: boolean
  // 跟踪用户是否在本会话中退出过计划模式（用于重新进入引导）
  hasExitedPlanMode: boolean
  // 跟踪是否需要显示计划模式退出附件（一次性通知）
  needsPlanModeExitAttachment: boolean
  // 跟踪是否需要显示自动模式退出附件（一次性通知）
  needsAutoModeExitAttachment: boolean
  // 跟踪本会话是否已显示过 LSP 插件推荐（只显示一次）
  lspRecommendationShownThisSession: boolean
  // SDK 初始化事件状态——用于结构化输出的 jsonSchema
  initJsonSchema: Record<string, unknown> | null
  // 已注册的钩子——SDK 回调和插件原生钩子
  registeredHooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>> | null
  // 计划 slug 缓存：sessionId -> wordSlug
  planSlugCache: Map<string, string>
  // 跟踪传送会话以进行可靠性日志记录
  teleportedSessionInfo: {
    isTeleported: boolean
    hasLoggedFirstMessage: boolean
    sessionId: string | null
  } | null
  // 跟踪已调用的技能以便跨压缩保留
  // 键为复合形式：`${agentId ?? ''}:${skillName}`，以防止跨代理覆盖
  invokedSkills: Map<
    string,
    {
      skillName: string
      skillPath: string
      content: string
      invokedAt: number
      agentId: string | null
    }
  >
  // 跟踪慢速操作以在开发者工具栏显示（仅限 ant）
  slowOperations: Array<{
    operation: string
    durationMs: number
    timestamp: number
  }>
  // SDK 提供的 beta 功能（例如，context-1m-2025-08-07）
  sdkBetas: string[] | undefined
  // 主线程代理类型（来自 --agent 标志或设置）
  mainThreadAgentType: string | undefined
  // 远程模式（--remote 标志）
  isRemoteMode: boolean
  // 直连服务器 URL（用于在标题栏显示）
  directConnectServerUrl: string | undefined
  // 系统提示区块缓存状态
  systemPromptSectionCache: Map<string, string | null>
  // 最后发送给模型的日期（用于检测午夜日期变化）
  lastEmittedDate: string | null
  // 来自 --add-dir 标志的额外目录（用于加载 CLAUDE.md）
  additionalDirectoriesForClaudeMd: string[]
  // 来自 --channels 标志的频道服务器允许列表（其中的频道
  // 通知应注册此会话）。在 main.tsx 中解析一次——
  // 标签决定信任模型：'plugin' → 市场验证 + 允许列表，
  // 'server' → 允许列表始终失败（schema 仅支持 plugin）。
  // 两种类型都需要 entry.dev 来绕过允许列表。
  allowedChannels: ChannelEntry[]
  // 如果 allowedChannels 中有任何条目来自
  // --dangerously-load-development-channels（这样 ChannelsNotice
  // 可以在策略阻止的消息中指明正确的标志）
  hasDevChannels: boolean
  // 包含会话 `.jsonl` 的目录；null = 从 originalCwd 派生。
  sessionProjectDir: string | null
  // 来自 GrowthBook 的缓存提示缓存 1 小时 TTL 允许列表（会话稳定）
  promptCache1hAllowlist: string[] | null
  // 缓存的 1 小时 TTL 用户资格（会话稳定）。首次评估时锁定，
  // 这样会话中期的超额波动就不会改变 cache_control TTL，
  // 否则会破坏服务端的提示缓存。
  promptCache1hEligible: boolean | null
  // AFK_MODE_BETA_HEADER 的锁定开关。一旦自动模式首次激活，
  // 在会话其余时间持续发送该 header，这样 Shift+Tab 切换
  // 就不会破坏约 50-70K token 的提示缓存。
  afkModeHeaderLatched: boolean | null
  // FAST_MODE_BETA_HEADER 的锁定开关。一旦快速模式首次启用，
  // 持续发送该 header，这样冷却进入/退出就不会双重破坏
  // 提示缓存。`speed` body 参数保持动态。
  fastModeHeaderLatched: boolean | null
  // 缓存编辑 beta header 的锁定开关。一旦缓存微压缩首次启用，
  // 持续发送该 header，这样会话中期的 GrowthBook/设置切换
  // 就不会破坏提示缓存。
  cacheEditingHeaderLatched: boolean | null
  // 当前提示 ID（UUID），用于将用户提示与后续 OTel 事件关联
  promptId: string | null
  // 主会话链（非子代理）的最后一次 API requestId。
  // 在每次主会话查询成功响应后更新。
  // 在关闭时读取以向推理服务发送缓存逐出提示。
  lastMainRequestId: string | undefined
  // 最后一次成功 API 调用完成的时间戳（Date.now()）。
  // 用于在 tengu_api_success 中计算 timeSinceLastApiCallMs，
  // 将缓存未命中与空闲时间关联（缓存 TTL 约为 5 分钟）。
  lastApiCompletionTimestamp: number | null
  // 压缩后（自动或手动 /compact）设为 true。由 logAPISuccess 消费，
  // 用于标记压缩后的第一次 API 调用，以便区分压缩引起的
  // 缓存未命中和 TTL 过期。
  pendingPostCompaction: boolean
}

// 也要在这里注意——修改前请三思
function getInitialState(): State {
  // 解析 cwd 中的符号链接以匹配 shell.ts 中 setCwd 的行为
  // 这确保了与会话存储路径清理方式的一致性
  let resolvedCwd = ''
  if (
    typeof process !== 'undefined' &&
    typeof process.cwd === 'function' &&
    typeof realpathSync === 'function'
  ) {
    const rawCwd = cwd()
    try {
      resolvedCwd = realpathSync(rawCwd).normalize('NFC')
    } catch {
      // 文件提供器在 CloudStorage 挂载点上返回 EPERM（对每个路径组件执行 lstat）。
      resolvedCwd = rawCwd.normalize('NFC')
    }
  }
  const state: State = {
    originalCwd: resolvedCwd,
    projectRoot: resolvedCwd,
    totalCostUSD: 0,
    totalAPIDuration: 0,
    totalAPIDurationWithoutRetries: 0,
    totalToolDuration: 0,
    turnHookDurationMs: 0,
    turnToolDurationMs: 0,
    turnClassifierDurationMs: 0,
    turnToolCount: 0,
    turnHookCount: 0,
    turnClassifierCount: 0,
    startTime: Date.now(),
    lastInteractionTime: Date.now(),
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    hasUnknownModelCost: false,
    cwd: resolvedCwd,
    modelUsage: {},
    mainLoopModelOverride: undefined,
    initialMainLoopModel: null,
    modelStrings: null,
    isInteractive: false,
    kairosActive: false,
    strictToolResultPairing: false,
    sdkAgentProgressSummariesEnabled: false,
    userMsgOptIn: false,
    clientType: 'cli',
    sessionSource: undefined,
    questionPreviewFormat: undefined,
    sessionIngressToken: undefined,
    oauthTokenFromFd: undefined,
    apiKeyFromFd: undefined,
    flagSettingsPath: undefined,
    flagSettingsInline: null,
    allowedSettingSources: [
      'userSettings',
      'projectSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ],
    // 遥测状态
    meter: null,
    sessionCounter: null,
    locCounter: null,
    prCounter: null,
    commitCounter: null,
    costCounter: null,
    tokenCounter: null,
    codeEditToolDecisionCounter: null,
    activeTimeCounter: null,
    statsStore: null,
    sessionId: randomUUID() as SessionId,
    parentSessionId: undefined,
    // 日志记录器状态
    loggerProvider: null,
    eventLogger: null,
    // 指标提供器状态
    meterProvider: null,
    tracerProvider: null,
    // Agent 颜色状态
    agentColorMap: new Map(),
    agentColorIndex: 0,
    // 最后一次 API 请求，用于错误报告
    lastAPIRequest: null,
    lastAPIRequestMessages: null,
    // 最后一次自动模式分类器请求，用于 /share 转录
    lastClassifierRequests: null,
    cachedClaudeMdContent: null,
    // 近期错误的内存日志
    inMemoryErrorLog: [],
    // 来自 --plugin-dir 标志的仅限会话的插件
    inlinePlugins: [],
    // 显式的 --chrome / --no-chrome 标志值（undefined 表示未在 CLI 中设置）
    chromeFlagOverride: undefined,
    // 使用 cowork_plugins 目录而非 plugins
    useCoworkPlugins: false,
    // 仅限会话的绕过权限模式标志（不持久化）
    sessionBypassPermissionsMode: false,
    // 定时任务在标志或对话框启用前保持禁用
    scheduledTasksEnabled: false,
    sessionCronTasks: [],
    sessionCreatedTeams: new Set(),
    // 仅限会话的信任标志（不持久化到磁盘）
    sessionTrustAccepted: false,
    // 禁用会话持久化到磁盘的仅限会话标志
    sessionPersistenceDisabled: false,
    // 跟踪用户是否在本会话中退出过计划模式
    hasExitedPlanMode: false,
    // 跟踪是否需要显示计划模式退出附件
    needsPlanModeExitAttachment: false,
    // 跟踪是否需要显示自动模式退出附件
    needsAutoModeExitAttachment: false,
    // 跟踪本会话是否已显示过 LSP 插件推荐
    lspRecommendationShownThisSession: false,
    // SDK 初始化事件状态
    initJsonSchema: null,
    registeredHooks: null,
    // 计划 slug 缓存
    planSlugCache: new Map(),
    // 跟踪传送会话以进行可靠性日志记录
    teleportedSessionInfo: null,
    // 跟踪已调用的技能以便跨压缩保留
    invokedSkills: new Map(),
    // 跟踪慢速操作以在开发者工具栏显示
    slowOperations: [],
    // SDK 提供的 beta 功能
    sdkBetas: undefined,
    // 主线程代理类型
    mainThreadAgentType: undefined,
    // 远程模式
    isRemoteMode: false,
    ...(process.env.USER_TYPE === 'ant'
      ? {
          replBridgeActive: false,
        }
      : {}),
    // 直连服务器 URL
    directConnectServerUrl: undefined,
    // 系统提示区块缓存状态
    systemPromptSectionCache: new Map(),
    // 最后发送给模型的日期
    lastEmittedDate: null,
    // 来自 --add-dir 标志的额外目录（用于加载 CLAUDE.md）
    additionalDirectoriesForClaudeMd: [],
    // 来自 --channels 标志的频道服务器允许列表
    allowedChannels: [],
    hasDevChannels: false,
    // 会话项目目录（null = 从 originalCwd 派生）
    sessionProjectDir: null,
    // 提示缓存 1 小时允许列表（null = 尚未从 GrowthBook 获取）
    promptCache1hAllowlist: null,
    // 提示缓存 1 小时资格（null = 尚未评估）
    promptCache1hEligible: null,
    // Beta header 锁定（null = 尚未触发）
    afkModeHeaderLatched: null,
    fastModeHeaderLatched: null,
    cacheEditingHeaderLatched: null,
    // 当前提示 ID
    promptId: null,
    lastMainRequestId: undefined,
    lastApiCompletionTimestamp: null,
    pendingPostCompaction: false,
  }

  return state
}

// 尤其是在这里——更要三思
const STATE: State = getInitialState()
// biome-ignore lint/suspicious/noConsole: 启动诊断日志
console.debug(
  `[Hapii] bootstrap/state 初始化完成 sessionId=${STATE.sessionId}`,
  {
    originalCwd: STATE.originalCwd,
    projectRoot: STATE.projectRoot,
    cwd: STATE.cwd,
    startTime: new Date(STATE.startTime).toISOString(),
    initialMainLoopModel: STATE.initialMainLoopModel,
    clientType: STATE.clientType,
    isInteractive: STATE.isInteractive,
    isRemoteMode: STATE.isRemoteMode,
    allowedSettingSources: STATE.allowedSettingSources,
    inlinePlugins: STATE.inlinePlugins,
    useCoworkPlugins: STATE.useCoworkPlugins,
    chromeFlagOverride: STATE.chromeFlagOverride,
    sessionBypassPermissionsMode: STATE.sessionBypassPermissionsMode,
    scheduledTasksEnabled: STATE.scheduledTasksEnabled,
    sessionTrustAccepted: STATE.sessionTrustAccepted,
    sessionPersistenceDisabled: STATE.sessionPersistenceDisabled,
    mainThreadAgentType: STATE.mainThreadAgentType,
    directConnectServerUrl: STATE.directConnectServerUrl,
    kairosActive: STATE.kairosActive,
    strictToolResultPairing: STATE.strictToolResultPairing,
    sdkAgentProgressSummariesEnabled: STATE.sdkAgentProgressSummariesEnabled,
    userMsgOptIn: STATE.userMsgOptIn,
    sessionSource: STATE.sessionSource,
    sessionIngressToken: STATE.sessionIngressToken ? '[set]' : null,
    oauthTokenFromFd: STATE.oauthTokenFromFd ? '[set]' : null,
    apiKeyFromFd: STATE.apiKeyFromFd ? '[set]' : null,
    flagSettingsPath: STATE.flagSettingsPath,
    hasDevChannels: STATE.hasDevChannels,
    additionalDirectoriesForClaudeMd: STATE.additionalDirectoriesForClaudeMd,
    sessionProjectDir: STATE.sessionProjectDir,
    parentSessionId: STATE.parentSessionId,
  },
)

export function getSessionId(): SessionId {
  return STATE.sessionId
}

export function regenerateSessionId(
  options: { setCurrentAsParent?: boolean } = {},
): SessionId {
  const oldId = STATE.sessionId
  if (options.setCurrentAsParent) {
    STATE.parentSessionId = STATE.sessionId
  }
  // 移除即将退出会话的计划 slug 条目，以免 Map 中
  // 积累过期键。需要跨调用保留 slug 的调用方
  // （REPL.tsx 的 clearContext）会在调用 clearConversation 之前读取它。
  STATE.planSlugCache.delete(STATE.sessionId)
  // 重新生成的会话位于当前项目中：将 projectDir 重置为
  // null，这样 getTranscriptPath() 会从 originalCwd 派生。
  STATE.sessionId = randomUUID() as SessionId
  STATE.sessionProjectDir = null
  console.debug(
    `[Hapii] bootstrap/state: regenerateSessionId old=${oldId} new=${STATE.sessionId}`,
  )
  return STATE.sessionId
}

export function getParentSessionId(): SessionId | undefined {
  return STATE.parentSessionId
}

/**
 * 原子性地切换活跃会话。`sessionId` 和 `sessionProjectDir`
 * 总是同步变化——没有单独的 setter，因此它们不会不同步（CC-34）。
 *
 * @param projectDir — 包含 `<sessionId>.jsonl` 的目录。对于当前项目中的
 *   会话，省略（或传 `null`）——路径会在读取时从 originalCwd 派生。
 *   当会话位于不同项目目录时（git worktree、跨项目恢复），
 *   传 `dirname(transcriptPath)`。每次调用都会重置项目目录；
 *   它永远不会从上一个会话继承。
 */
export function switchSession(
  sessionId: SessionId,
  projectDir: string | null = null,
): void {
  const oldId = STATE.sessionId
  // 移除即将退出会话的计划 slug 条目，以保持 Map 在重复
  // /resume 调用间的大小有限。只有当前会话的 slug 会被读取
  // （plans.ts 的 getPlanSlug 默认使用 getSessionId()）。
  STATE.planSlugCache.delete(STATE.sessionId)
  STATE.sessionId = sessionId
  STATE.sessionProjectDir = projectDir
  console.debug(
    `[Hapii] bootstrap/state: switchSession old=${oldId} new=${sessionId} projectDir=${projectDir}`,
  )
  sessionSwitched.emit(sessionId)
}

const sessionSwitched = createSignal<[id: SessionId]>()

/**
 * 注册一个回调，当 switchSession 改变活跃 sessionId 时触发。
 * bootstrap 不能直接导入监听器（DAG 叶子节点约束），所以由调用方
 * 自行注册。concurrentSessions.ts 使用此机制来保持 PID 文件中的
 * sessionId 与 --resume 同步。
 */
export const onSessionSwitch = sessionSwitched.subscribe

/**
 * 当前会话转录文件所在的项目目录，如果会话是在当前项目中创建的
 * 则返回 `null`（常见情况——从 originalCwd 派生）。参见 `switchSession()`。
 */
export function getSessionProjectDir(): string | null {
  return STATE.sessionProjectDir
}

export function getOriginalCwd(): string {
  return STATE.originalCwd
}

/**
 * 获取稳定的项目根目录。
 * 与 getOriginalCwd() 不同，此值不会被会话中途的 EnterWorktreeTool 更新
 * （所以当进入一次性 worktree 时，技能/历史保持稳定）。
 * 但它在启动时会由 --worktree 设置，因为该 worktree 就是会话的项目。
 * 用于项目标识（历史、技能、会话），而非文件操作。
 */
export function getProjectRoot(): string {
  return STATE.projectRoot
}

export function setOriginalCwd(cwd: string): void {
  STATE.originalCwd = cwd.normalize('NFC')
}

/**
 * 仅用于 --worktree 启动标志。会话中途的 EnterWorktreeTool 绝不能
 * 调用此函数——技能/历史应保持锚定在会话开始的位置。
 */
export function setProjectRoot(cwd: string): void {
  STATE.projectRoot = cwd.normalize('NFC')
}

export function getCwdState(): string {
  return STATE.cwd
}

export function setCwdState(cwd: string): void {
  STATE.cwd = cwd.normalize('NFC')
}

export function getDirectConnectServerUrl(): string | undefined {
  return STATE.directConnectServerUrl
}

export function setDirectConnectServerUrl(url: string): void {
  STATE.directConnectServerUrl = url
}

export function addToTotalDurationState(
  duration: number,
  durationWithoutRetries: number,
): void {
  STATE.totalAPIDuration += duration
  STATE.totalAPIDurationWithoutRetries += durationWithoutRetries
}

export function resetTotalDurationStateAndCost_FOR_TESTS_ONLY(): void {
  STATE.totalAPIDuration = 0
  STATE.totalAPIDurationWithoutRetries = 0
  STATE.totalCostUSD = 0
}

export function addToTotalCostState(
  cost: number,
  modelUsage: ModelUsage,
  model: string,
): void {
  STATE.modelUsage[model] = modelUsage
  STATE.totalCostUSD += cost
}

export function getTotalCostUSD(): number {
  return STATE.totalCostUSD
}

export function getTotalAPIDuration(): number {
  return STATE.totalAPIDuration
}

export function getTotalDuration(): number {
  return Date.now() - STATE.startTime
}

export function getTotalAPIDurationWithoutRetries(): number {
  return STATE.totalAPIDurationWithoutRetries
}

export function getTotalToolDuration(): number {
  return STATE.totalToolDuration
}

export function addToToolDuration(duration: number): void {
  STATE.totalToolDuration += duration
  STATE.turnToolDurationMs += duration
  STATE.turnToolCount++
}

export function getTurnHookDurationMs(): number {
  return STATE.turnHookDurationMs
}

export function addToTurnHookDuration(duration: number): void {
  STATE.turnHookDurationMs += duration
  STATE.turnHookCount++
}

export function resetTurnHookDuration(): void {
  STATE.turnHookDurationMs = 0
  STATE.turnHookCount = 0
}

export function getTurnHookCount(): number {
  return STATE.turnHookCount
}

export function getTurnToolDurationMs(): number {
  return STATE.turnToolDurationMs
}

export function resetTurnToolDuration(): void {
  STATE.turnToolDurationMs = 0
  STATE.turnToolCount = 0
}

export function getTurnToolCount(): number {
  return STATE.turnToolCount
}

export function getTurnClassifierDurationMs(): number {
  return STATE.turnClassifierDurationMs
}

export function addToTurnClassifierDuration(duration: number): void {
  STATE.turnClassifierDurationMs += duration
  STATE.turnClassifierCount++
}

export function resetTurnClassifierDuration(): void {
  STATE.turnClassifierDurationMs = 0
  STATE.turnClassifierCount = 0
}

export function getTurnClassifierCount(): number {
  return STATE.turnClassifierCount
}

export function getStatsStore(): {
  observe(name: string, value: number): void
} | null {
  return STATE.statsStore
}

export function setStatsStore(
  store: { observe(name: string, value: number): void } | null,
): void {
  STATE.statsStore = store
}

/**
 * 标记发生了一次交互。
 *
 * 默认情况下，实际的 Date.now() 调用会延迟到下一次 Ink 渲染帧
 * （通过 flushInteractionTime()），以避免在每次按键时都调用 Date.now()。
 *
 * 从 React useEffect 回调或其他在 Ink 渲染周期已刷新后运行的代码中
 * 调用时，传 `immediate = true`。否则时间戳会保持陈旧直到下一次渲染，
 * 而如果用户处于空闲状态（例如权限对话框等待输入），下一次渲染可能
 * 永远不会到来。
 */
let interactionTimeDirty = false

export function updateLastInteractionTime(immediate?: boolean): void {
  if (immediate) {
    flushInteractionTime_inner()
  } else {
    interactionTimeDirty = true
  }
}

/**
 * 如果自上次刷新以来有交互记录，则立即更新时间戳。
 * 由 Ink 在每次渲染周期前调用，这样可以将多次按键合并
 * 为单次 Date.now() 调用。
 */
export function flushInteractionTime(): void {
  if (interactionTimeDirty) {
    flushInteractionTime_inner()
  }
}

function flushInteractionTime_inner(): void {
  STATE.lastInteractionTime = Date.now()
  interactionTimeDirty = false
}

export function addToTotalLinesChanged(added: number, removed: number): void {
  STATE.totalLinesAdded += added
  STATE.totalLinesRemoved += removed
}

export function getTotalLinesAdded(): number {
  return STATE.totalLinesAdded
}

export function getTotalLinesRemoved(): number {
  return STATE.totalLinesRemoved
}

export function getTotalInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'inputTokens')
}

export function getTotalOutputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'outputTokens')
}

export function getTotalCacheReadInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'cacheReadInputTokens')
}

export function getTotalCacheCreationInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'cacheCreationInputTokens')
}

export function getTotalWebSearchRequests(): number {
  return sumBy(Object.values(STATE.modelUsage), 'webSearchRequests')
}

let outputTokensAtTurnStart = 0
let currentTurnTokenBudget: number | null = null
export function getTurnOutputTokens(): number {
  return getTotalOutputTokens() - outputTokensAtTurnStart
}
export function getCurrentTurnTokenBudget(): number | null {
  return currentTurnTokenBudget
}
let budgetContinuationCount = 0
export function snapshotOutputTokensForTurn(budget: number | null): void {
  outputTokensAtTurnStart = getTotalOutputTokens()
  currentTurnTokenBudget = budget
  budgetContinuationCount = 0
}
export function getBudgetContinuationCount(): number {
  return budgetContinuationCount
}
export function incrementBudgetContinuationCount(): void {
  budgetContinuationCount++
}

export function setHasUnknownModelCost(): void {
  STATE.hasUnknownModelCost = true
}

export function hasUnknownModelCost(): boolean {
  return STATE.hasUnknownModelCost
}

export function getLastMainRequestId(): string | undefined {
  return STATE.lastMainRequestId
}

export function setLastMainRequestId(requestId: string): void {
  STATE.lastMainRequestId = requestId
}

export function getLastApiCompletionTimestamp(): number | null {
  return STATE.lastApiCompletionTimestamp
}

export function setLastApiCompletionTimestamp(timestamp: number): void {
  STATE.lastApiCompletionTimestamp = timestamp
}

/** 标记压缩刚刚发生。下一次 API 成功事件会包含
 *  isPostCompaction=true，然后该标志自动重置。 */
export function markPostCompaction(): void {
  STATE.pendingPostCompaction = true
}

/** 消费压缩后标志。压缩后返回一次 true，
 *  然后返回 false 直到下一次压缩。 */
export function consumePostCompaction(): boolean {
  const was = STATE.pendingPostCompaction
  STATE.pendingPostCompaction = false
  return was
}

export function getLastInteractionTime(): number {
  return STATE.lastInteractionTime
}

// 滚动排空暂停——后台间隔在执行工作前会检查此标志，
// 以免与滚动帧竞争事件循环。由 ScrollBox 的 scrollBy/scrollTo 设置，
// 在最后一次滚动事件后 SCROLL_DRAIN_IDLE_MS 毫秒时清除。
// 模块作用域（不在 STATE 中）——临时热路径标志，不需要测试重置，
// 因为防抖计时器会自行清除。
let scrollDraining = false
let scrollDrainTimer: ReturnType<typeof setTimeout> | undefined
const SCROLL_DRAIN_IDLE_MS = 150

/** 标记刚刚发生了滚动事件。后台间隔会通过 getIsScrollDraining() 判断
 *  并在防抖清除前跳过其工作。 */
export function markScrollActivity(): void {
  scrollDraining = true
  if (scrollDrainTimer) clearTimeout(scrollDrainTimer)
  scrollDrainTimer = setTimeout(() => {
    scrollDraining = false
    scrollDrainTimer = undefined
  }, SCROLL_DRAIN_IDLE_MS)
  scrollDrainTimer.unref?.()
}

/** 当滚动正在排空时返回 true（在最后一次事件后 150ms 内）。
 *  间隔应在此值被设置时提前返回——工作会在滚动稳定后的
 *  下一个 tick 恢复。 */
export function getIsScrollDraining(): boolean {
  return scrollDraining
}

/** 在执行可能与滚动重叠的一次性工作（网络、子进程）前等待此函数。
 *  如果未在滚动则立即 resolve；否则以空闲间隔轮询直到标志清除。 */
export async function waitForScrollIdle(): Promise<void> {
  while (scrollDraining) {
    // bootstrap-isolation 禁止从 src/utils/ 导入 sleep()
    // eslint-disable-next-line no-restricted-syntax
    await new Promise(r => setTimeout(r, SCROLL_DRAIN_IDLE_MS).unref?.())
  }
}

export function getModelUsage(): { [modelName: string]: ModelUsage } {
  return STATE.modelUsage
}

export function getUsageForModel(model: string): ModelUsage | undefined {
  return STATE.modelUsage[model]
}

/**
 * 获取来自 --model CLI 标志或用户更新其配置模型后的模型覆盖设置。
 */
export function getMainLoopModelOverride(): ModelSetting | undefined {
  return STATE.mainLoopModelOverride
}

export function getInitialMainLoopModel(): ModelSetting {
  return STATE.initialMainLoopModel
}

export function setMainLoopModelOverride(
  model: ModelSetting | undefined,
): void {
  STATE.mainLoopModelOverride = model
}

export function setInitialMainLoopModel(model: ModelSetting): void {
  STATE.initialMainLoopModel = model
}

export function getSdkBetas(): string[] | undefined {
  return STATE.sdkBetas
}

export function setSdkBetas(betas: string[] | undefined): void {
  STATE.sdkBetas = betas
}

export function resetCostState(): void {
  STATE.totalCostUSD = 0
  STATE.totalAPIDuration = 0
  STATE.totalAPIDurationWithoutRetries = 0
  STATE.totalToolDuration = 0
  STATE.startTime = Date.now()
  STATE.totalLinesAdded = 0
  STATE.totalLinesRemoved = 0
  STATE.hasUnknownModelCost = false
  STATE.modelUsage = {}
  STATE.promptId = null
}

/**
 * 为会话恢复设置成本状态值。
 * 由 cost-tracker.ts 中的 restoreCostStateForSession 调用。
 */
export function setCostStateForRestore({
  totalCostUSD,
  totalAPIDuration,
  totalAPIDurationWithoutRetries,
  totalToolDuration,
  totalLinesAdded,
  totalLinesRemoved,
  lastDuration,
  modelUsage,
}: {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
}): void {
  STATE.totalCostUSD = totalCostUSD
  STATE.totalAPIDuration = totalAPIDuration
  STATE.totalAPIDurationWithoutRetries = totalAPIDurationWithoutRetries
  STATE.totalToolDuration = totalToolDuration
  STATE.totalLinesAdded = totalLinesAdded
  STATE.totalLinesRemoved = totalLinesRemoved

  // 恢复按模型分类的使用明细
  if (modelUsage) {
    STATE.modelUsage = modelUsage
  }

  // 调整 startTime 以使墙上时钟时长累加
  if (lastDuration) {
    STATE.startTime = Date.now() - lastDuration
  }
}

// 仅在测试中使用
export function resetStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetStateForTests can only be called in tests')
  }
  Object.entries(getInitialState()).forEach(([key, value]) => {
    STATE[key as keyof State] = value as never
  })
  outputTokensAtTurnStart = 0
  currentTurnTokenBudget = null
  budgetContinuationCount = 0
  sessionSwitched.clear()
}

// 你不应该直接使用此函数。参见 src/utils/model/modelStrings.ts::getModelStrings()
export function getModelStrings(): ModelStrings | null {
  return STATE.modelStrings
}

// 你不应该直接使用此函数。参见 src/utils/model/modelStrings.ts
export function setModelStrings(modelStrings: ModelStrings): void {
  STATE.modelStrings = modelStrings
}

// 用于重置模型字符串以进行重新初始化的测试工具函数。
// 与 setModelStrings 分离，因为我们只希望在测试中接受 'null'。
export function resetModelStringsForTestingOnly() {
  STATE.modelStrings = null
}

export function setMeter(
  meter: Meter,
  createCounter: (name: string, options: MetricOptions) => AttributedCounter,
): void {
  STATE.meter = meter

  // 使用提供的工厂初始化所有计数器
  STATE.sessionCounter = createCounter('claude_code.session.count', {
    description: 'Count of CLI sessions started',
  })
  STATE.locCounter = createCounter('claude_code.lines_of_code.count', {
    description:
      "Count of lines of code modified, with the 'type' attribute indicating whether lines were added or removed",
  })
  STATE.prCounter = createCounter('claude_code.pull_request.count', {
    description: 'Number of pull requests created',
  })
  STATE.commitCounter = createCounter('claude_code.commit.count', {
    description: 'Number of git commits created',
  })
  STATE.costCounter = createCounter('claude_code.cost.usage', {
    description: 'Cost of the Claude Code session',
    unit: 'USD',
  })
  STATE.tokenCounter = createCounter('claude_code.token.usage', {
    description: 'Number of tokens used',
    unit: 'tokens',
  })
  STATE.codeEditToolDecisionCounter = createCounter(
    'claude_code.code_edit_tool.decision',
    {
      description:
        'Count of code editing tool permission decisions (accept/reject) for Edit, Write, and NotebookEdit tools',
    },
  )
  STATE.activeTimeCounter = createCounter('claude_code.active_time.total', {
    description: 'Total active time in seconds',
    unit: 's',
  })
}

export function getMeter(): Meter | null {
  return STATE.meter
}

export function getSessionCounter(): AttributedCounter | null {
  return STATE.sessionCounter
}

export function getLocCounter(): AttributedCounter | null {
  return STATE.locCounter
}

export function getPrCounter(): AttributedCounter | null {
  return STATE.prCounter
}

export function getCommitCounter(): AttributedCounter | null {
  return STATE.commitCounter
}

export function getCostCounter(): AttributedCounter | null {
  return STATE.costCounter
}

export function getTokenCounter(): AttributedCounter | null {
  return STATE.tokenCounter
}

export function getCodeEditToolDecisionCounter(): AttributedCounter | null {
  return STATE.codeEditToolDecisionCounter
}

export function getActiveTimeCounter(): AttributedCounter | null {
  return STATE.activeTimeCounter
}

export function getLoggerProvider(): LoggerProvider | null {
  return STATE.loggerProvider
}

export function setLoggerProvider(provider: LoggerProvider | null): void {
  STATE.loggerProvider = provider
}

export function getEventLogger(): ReturnType<typeof logs.getLogger> | null {
  return STATE.eventLogger
}

export function setEventLogger(
  logger: ReturnType<typeof logs.getLogger> | null,
): void {
  STATE.eventLogger = logger
}

export function getMeterProvider(): MeterProvider | null {
  return STATE.meterProvider
}

export function setMeterProvider(provider: MeterProvider | null): void {
  STATE.meterProvider = provider
}
export function getTracerProvider(): BasicTracerProvider | null {
  return STATE.tracerProvider
}
export function setTracerProvider(provider: BasicTracerProvider | null): void {
  STATE.tracerProvider = provider
}

export function getIsNonInteractiveSession(): boolean {
  return !STATE.isInteractive
}

export function getIsInteractive(): boolean {
  return STATE.isInteractive
}

export function setIsInteractive(value: boolean): void {
  STATE.isInteractive = value
}

export function getClientType(): string {
  return STATE.clientType
}

export function setClientType(type: string): void {
  STATE.clientType = type
}

export function getSdkAgentProgressSummariesEnabled(): boolean {
  return STATE.sdkAgentProgressSummariesEnabled
}

export function setSdkAgentProgressSummariesEnabled(value: boolean): void {
  STATE.sdkAgentProgressSummariesEnabled = value
}

export function getKairosActive(): boolean {
  return STATE.kairosActive
}

export function setKairosActive(value: boolean): void {
  STATE.kairosActive = value
}

export function getStrictToolResultPairing(): boolean {
  return STATE.strictToolResultPairing
}

export function setStrictToolResultPairing(value: boolean): void {
  STATE.strictToolResultPairing = value
}

// 字段名 'userMsgOptIn' 避免了被排除的字符串子串（'BriefTool'、
// 'SendUserMessage'——不区分大小写）。所有调用方都在 feature() 守卫
// 内部，所以这些访问器不需要自己的守卫（与 getKairosActive 一致）。
export function getUserMsgOptIn(): boolean {
  return STATE.userMsgOptIn
}

export function setUserMsgOptIn(value: boolean): void {
  STATE.userMsgOptIn = value
}

export function getSessionSource(): string | undefined {
  return STATE.sessionSource
}

export function setSessionSource(source: string): void {
  STATE.sessionSource = source
}

export function getQuestionPreviewFormat(): 'markdown' | 'html' | undefined {
  return STATE.questionPreviewFormat
}

export function setQuestionPreviewFormat(format: 'markdown' | 'html'): void {
  STATE.questionPreviewFormat = format
}

export function getAgentColorMap(): Map<string, AgentColorName> {
  return STATE.agentColorMap
}

export function getFlagSettingsPath(): string | undefined {
  return STATE.flagSettingsPath
}

export function setFlagSettingsPath(path: string | undefined): void {
  STATE.flagSettingsPath = path
}

export function getFlagSettingsInline(): Record<string, unknown> | null {
  return STATE.flagSettingsInline
}

export function setFlagSettingsInline(
  settings: Record<string, unknown> | null,
): void {
  STATE.flagSettingsInline = settings
}

export function getSessionIngressToken(): string | null | undefined {
  return STATE.sessionIngressToken
}

export function setSessionIngressToken(token: string | null): void {
  STATE.sessionIngressToken = token
}

export function getOauthTokenFromFd(): string | null | undefined {
  return STATE.oauthTokenFromFd
}

export function setOauthTokenFromFd(token: string | null): void {
  STATE.oauthTokenFromFd = token
}

export function getApiKeyFromFd(): string | null | undefined {
  return STATE.apiKeyFromFd
}

export function setApiKeyFromFd(key: string | null): void {
  STATE.apiKeyFromFd = key
}

export function setLastAPIRequest(
  params: Omit<BetaMessageStreamParams, 'messages'> | null,
): void {
  STATE.lastAPIRequest = params
}

export function getLastAPIRequest(): Omit<
  BetaMessageStreamParams,
  'messages'
> | null {
  return STATE.lastAPIRequest
}

export function setLastAPIRequestMessages(
  messages: BetaMessageStreamParams['messages'] | null,
): void {
  STATE.lastAPIRequestMessages = messages
}

export function getLastAPIRequestMessages():
  | BetaMessageStreamParams['messages']
  | null {
  return STATE.lastAPIRequestMessages
}

export function setLastClassifierRequests(requests: unknown[] | null): void {
  STATE.lastClassifierRequests = requests
}

export function getLastClassifierRequests(): unknown[] | null {
  return STATE.lastClassifierRequests
}

export function setCachedClaudeMdContent(content: string | null): void {
  STATE.cachedClaudeMdContent = content
}

export function getCachedClaudeMdContent(): string | null {
  return STATE.cachedClaudeMdContent
}

export function addToInMemoryErrorLog(errorInfo: {
  error: string
  timestamp: string
}): void {
  const MAX_IN_MEMORY_ERRORS = 100
  if (STATE.inMemoryErrorLog.length >= MAX_IN_MEMORY_ERRORS) {
    STATE.inMemoryErrorLog.shift() // 移除最旧的错误
  }
  STATE.inMemoryErrorLog.push(errorInfo)
}

export function getAllowedSettingSources(): SettingSource[] {
  return STATE.allowedSettingSources
}

export function setAllowedSettingSources(sources: SettingSource[]): void {
  STATE.allowedSettingSources = sources
}

export function preferThirdPartyAuthentication(): boolean {
  // IDE 扩展应该出于认证原因表现为第一方。
  return getIsNonInteractiveSession() && STATE.clientType !== 'claude-vscode'
}

export function setInlinePlugins(plugins: Array<string>): void {
  STATE.inlinePlugins = plugins
}

export function getInlinePlugins(): Array<string> {
  return STATE.inlinePlugins
}

export function setChromeFlagOverride(value: boolean | undefined): void {
  STATE.chromeFlagOverride = value
}

export function getChromeFlagOverride(): boolean | undefined {
  return STATE.chromeFlagOverride
}

export function setUseCoworkPlugins(value: boolean): void {
  STATE.useCoworkPlugins = value
  resetSettingsCache()
}

export function getUseCoworkPlugins(): boolean {
  return STATE.useCoworkPlugins
}

export function setSessionBypassPermissionsMode(enabled: boolean): void {
  STATE.sessionBypassPermissionsMode = enabled
}

export function getSessionBypassPermissionsMode(): boolean {
  return STATE.sessionBypassPermissionsMode
}

export function setScheduledTasksEnabled(enabled: boolean): void {
  STATE.scheduledTasksEnabled = enabled
}

export function getScheduledTasksEnabled(): boolean {
  return STATE.scheduledTasksEnabled
}

export type SessionCronTask = {
  id: string
  cron: string
  prompt: string
  createdAt: number
  recurring?: boolean
  /**
   * 设置后，表示该任务是由进程内的队友（而非团队负责人）创建的。
   * 调度器会将触发路由到该队友的 pendingUserMessages 队列，
   * 而不是主 REPL 命令队列。仅限会话——永远不会写入磁盘。
   */
  agentId?: string
}

export function getSessionCronTasks(): SessionCronTask[] {
  return STATE.sessionCronTasks
}

export function addSessionCronTask(task: SessionCronTask): void {
  STATE.sessionCronTasks.push(task)
}

/**
 * 返回实际移除的任务数量。调用方使用此值来跳过下游工作
 * （例如 removeCronTasks 中的磁盘读取），当所有 id 都在这里
 * 被处理完毕时。
 */
export function removeSessionCronTasks(ids: readonly string[]): number {
  if (ids.length === 0) return 0
  const idSet = new Set(ids)
  const remaining = STATE.sessionCronTasks.filter(t => !idSet.has(t.id))
  const removed = STATE.sessionCronTasks.length - remaining.length
  if (removed === 0) return 0
  STATE.sessionCronTasks = remaining
  return removed
}

export function setSessionTrustAccepted(accepted: boolean): void {
  STATE.sessionTrustAccepted = accepted
}

export function getSessionTrustAccepted(): boolean {
  return STATE.sessionTrustAccepted
}

export function setSessionPersistenceDisabled(disabled: boolean): void {
  STATE.sessionPersistenceDisabled = disabled
}

export function isSessionPersistenceDisabled(): boolean {
  return STATE.sessionPersistenceDisabled
}

export function hasExitedPlanModeInSession(): boolean {
  return STATE.hasExitedPlanMode
}

export function setHasExitedPlanMode(value: boolean): void {
  STATE.hasExitedPlanMode = value
}

export function needsPlanModeExitAttachment(): boolean {
  return STATE.needsPlanModeExitAttachment
}

export function setNeedsPlanModeExitAttachment(value: boolean): void {
  STATE.needsPlanModeExitAttachment = value
}

export function handlePlanModeTransition(
  fromMode: string,
  toMode: string,
): void {
  // 如果切换到计划模式，清除任何待处理的退出附件
  // 这可以防止用户快速切换时同时发送 plan_mode 和 plan_mode_exit
  if (toMode === 'plan' && fromMode !== 'plan') {
    STATE.needsPlanModeExitAttachment = false
  }

  // 如果切换出计划模式，触发 plan_mode_exit 附件
  if (fromMode === 'plan' && toMode !== 'plan') {
    STATE.needsPlanModeExitAttachment = true
  }
}

export function needsAutoModeExitAttachment(): boolean {
  return STATE.needsAutoModeExitAttachment
}

export function setNeedsAutoModeExitAttachment(value: boolean): void {
  STATE.needsAutoModeExitAttachment = value
}

export function handleAutoModeTransition(
  fromMode: string,
  toMode: string,
): void {
  // Auto↔plan 转换由 prepareContextForPlanMode 处理（如果选择加入，
  // auto 可能在 plan 期间保持活跃）和 ExitPlanMode（恢复模式）。
  // 跳过两个方向，这样此函数只处理直接的 auto 转换。
  if (
    (fromMode === 'auto' && toMode === 'plan') ||
    (fromMode === 'plan' && toMode === 'auto')
  ) {
    return
  }
  const fromIsAuto = fromMode === 'auto'
  const toIsAuto = toMode === 'auto'

  // 如果切换到自动模式，清除任何待处理的退出附件
  // 这可以防止用户快速切换时同时发送 auto_mode 和 auto_mode_exit
  if (toIsAuto && !fromIsAuto) {
    STATE.needsAutoModeExitAttachment = false
  }

  // 如果切换出自动模式，触发 auto_mode_exit 附件
  if (fromIsAuto && !toIsAuto) {
    STATE.needsAutoModeExitAttachment = true
  }
}

// LSP 插件推荐的会话跟踪
export function hasShownLspRecommendationThisSession(): boolean {
  return STATE.lspRecommendationShownThisSession
}

export function setLspRecommendationShownThisSession(value: boolean): void {
  STATE.lspRecommendationShownThisSession = value
}

// SDK 初始化事件状态
export function setInitJsonSchema(schema: Record<string, unknown>): void {
  STATE.initJsonSchema = schema
}

export function getInitJsonSchema(): Record<string, unknown> | null {
  return STATE.initJsonSchema
}

export function registerHookCallbacks(
  hooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>>,
): void {
  if (!STATE.registeredHooks) {
    STATE.registeredHooks = {}
  }

  // `registerHookCallbacks` 可能被多次调用，所以我们需要合并（而非覆盖）
  for (const [event, matchers] of Object.entries(hooks)) {
    const eventKey = event as HookEvent
    if (!STATE.registeredHooks[eventKey]) {
      STATE.registeredHooks[eventKey] = []
    }
    STATE.registeredHooks[eventKey]!.push(...(matchers ?? []))
  }
}

export function getRegisteredHooks(): Partial<
  Record<HookEvent, RegisteredHookMatcher[]>
> | null {
  return STATE.registeredHooks
}

export function clearRegisteredHooks(): void {
  STATE.registeredHooks = null
}

export function clearRegisteredPluginHooks(): void {
  if (!STATE.registeredHooks) {
    return
  }

  const filtered: Partial<Record<HookEvent, RegisteredHookMatcher[]>> = {}
  for (const [event, matchers] of Object.entries(STATE.registeredHooks)) {
    // 仅保留回调钩子（那些没有 pluginRoot 的）
    const callbackHooks = (matchers ?? []).filter(m => !('pluginRoot' in m))
    if (callbackHooks.length > 0) {
      filtered[event as HookEvent] = callbackHooks
    }
  }

  STATE.registeredHooks = Object.keys(filtered).length > 0 ? filtered : null
}

export function resetSdkInitState(): void {
  STATE.initJsonSchema = null
  STATE.registeredHooks = null
}

export function getPlanSlugCache(): Map<string, string> {
  return STATE.planSlugCache
}

export function setPlanSlugCacheEntry(sessionId: string, slug: string): void {
  if (STATE.planSlugCache.size >= 50) {
    const firstKey = STATE.planSlugCache.keys().next().value
    if (firstKey !== undefined) {
      STATE.planSlugCache.delete(firstKey)
    }
  }
  STATE.planSlugCache.set(sessionId, slug)
}

export function getSessionCreatedTeams(): Set<string> {
  return STATE.sessionCreatedTeams
}

// 传送会话跟踪以进行可靠性日志记录
export function setTeleportedSessionInfo(info: {
  sessionId: string | null
}): void {
  STATE.teleportedSessionInfo = {
    isTeleported: true,
    hasLoggedFirstMessage: false,
    sessionId: info.sessionId,
  }
}

export function getTeleportedSessionInfo(): {
  isTeleported: boolean
  hasLoggedFirstMessage: boolean
  sessionId: string | null
} | null {
  return STATE.teleportedSessionInfo
}

export function markFirstTeleportMessageLogged(): void {
  if (STATE.teleportedSessionInfo) {
    STATE.teleportedSessionInfo.hasLoggedFirstMessage = true
  }
}

// 已调用技能的跟踪以便跨压缩保留
export type InvokedSkillInfo = {
  skillName: string
  skillPath: string
  content: string
  invokedAt: number
  agentId: string | null
}

export function addInvokedSkill(
  skillName: string,
  skillPath: string,
  content: string,
  agentId: string | null = null,
): void {
  const key = `${agentId ?? ''}:${skillName}`
  STATE.invokedSkills.set(key, {
    skillName,
    skillPath,
    content,
    invokedAt: Date.now(),
    agentId,
  })
}

export function getInvokedSkills(): Map<string, InvokedSkillInfo> {
  return STATE.invokedSkills
}

export function getInvokedSkillsForAgent(
  agentId: string | undefined | null,
): Map<string, InvokedSkillInfo> {
  const normalizedId = agentId ?? null
  const filtered = new Map<string, InvokedSkillInfo>()
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === normalizedId) {
      filtered.set(key, skill)
    }
  }
  return filtered
}

export function clearInvokedSkills(
  preservedAgentIds?: ReadonlySet<string>,
): void {
  if (!preservedAgentIds || preservedAgentIds.size === 0) {
    STATE.invokedSkills.clear()
    return
  }
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === null || !preservedAgentIds.has(skill.agentId)) {
      STATE.invokedSkills.delete(key)
    }
  }
}

export function clearInvokedSkillsForAgent(agentId: string): void {
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === agentId) {
      STATE.invokedSkills.delete(key)
    }
  }
}

// 开发者工具栏的慢速操作跟踪
const MAX_SLOW_OPERATIONS = 10
const SLOW_OPERATION_TTL_MS = 10000

export function addSlowOperation(operation: string, durationMs: number): void {
  if (process.env.USER_TYPE !== 'ant') return
  // 跳过编辑器会话的跟踪（用户在 $EDITOR 中编辑提示文件）
  // 这些故意较慢，因为用户正在起草文本
  if (operation.includes('exec') && operation.includes('claude-prompt-')) {
    return
  }
  const now = Date.now()
  // 移除过期的操作
  STATE.slowOperations = STATE.slowOperations.filter(
    op => now - op.timestamp < SLOW_OPERATION_TTL_MS,
  )
  // 添加新操作
  STATE.slowOperations.push({ operation, durationMs, timestamp: now })
  // 只保留最近的操作
  if (STATE.slowOperations.length > MAX_SLOW_OPERATIONS) {
    STATE.slowOperations = STATE.slowOperations.slice(-MAX_SLOW_OPERATIONS)
  }
}

const EMPTY_SLOW_OPERATIONS: ReadonlyArray<{
  operation: string
  durationMs: number
  timestamp: number
}> = []

export function getSlowOperations(): ReadonlyArray<{
  operation: string
  durationMs: number
  timestamp: number
}> {
  // 最常见的情况：没有跟踪到任何内容。返回一个稳定的引用，
  // 这样调用方的 setState() 可以通过 Object.is 跳过更新，
  // 而不是以 2fps 的频率重新渲染。
  if (STATE.slowOperations.length === 0) {
    return EMPTY_SLOW_OPERATIONS
  }
  const now = Date.now()
  // 只有当有操作实际过期时才分配新数组；否则在操作仍然新鲜时
  // 保持引用稳定跨轮询。
  if (
    STATE.slowOperations.some(op => now - op.timestamp >= SLOW_OPERATION_TTL_MS)
  ) {
    STATE.slowOperations = STATE.slowOperations.filter(
      op => now - op.timestamp < SLOW_OPERATION_TTL_MS,
    )
    if (STATE.slowOperations.length === 0) {
      return EMPTY_SLOW_OPERATIONS
    }
  }
  // 可以直接返回：addSlowOperation() 在 push 之前会重新赋值
  // STATE.slowOperations，所以 React state 中持有的数组永远不会被修改。
  return STATE.slowOperations
}

export function getMainThreadAgentType(): string | undefined {
  return STATE.mainThreadAgentType
}

export function setMainThreadAgentType(agentType: string | undefined): void {
  STATE.mainThreadAgentType = agentType
}

export function getIsRemoteMode(): boolean {
  return STATE.isRemoteMode
}

export function setIsRemoteMode(value: boolean): void {
  STATE.isRemoteMode = value
}

// 系统提示区块访问器

export function getSystemPromptSectionCache(): Map<string, string | null> {
  return STATE.systemPromptSectionCache
}

export function setSystemPromptSectionCacheEntry(
  name: string,
  value: string | null,
): void {
  if (STATE.systemPromptSectionCache.size >= 100) {
    const firstKey = STATE.systemPromptSectionCache.keys().next().value
    if (firstKey !== undefined) {
      STATE.systemPromptSectionCache.delete(firstKey)
    }
  }
  STATE.systemPromptSectionCache.set(name, value)
}

export function clearSystemPromptSectionState(): void {
  STATE.systemPromptSectionCache.clear()
}

// 最后发送的日期访问器（用于检测午夜日期变化）

export function getLastEmittedDate(): string | null {
  return STATE.lastEmittedDate
}

export function setLastEmittedDate(date: string | null): void {
  STATE.lastEmittedDate = date
}

export function getAdditionalDirectoriesForClaudeMd(): string[] {
  return STATE.additionalDirectoriesForClaudeMd
}

export function setAdditionalDirectoriesForClaudeMd(
  directories: string[],
): void {
  STATE.additionalDirectoriesForClaudeMd = directories
}

export function getAllowedChannels(): ChannelEntry[] {
  return STATE.allowedChannels
}

export function setAllowedChannels(entries: ChannelEntry[]): void {
  STATE.allowedChannels = entries
}

export function getHasDevChannels(): boolean {
  return STATE.hasDevChannels
}

export function setHasDevChannels(value: boolean): void {
  STATE.hasDevChannels = value
}

export function getPromptCache1hAllowlist(): string[] | null {
  return STATE.promptCache1hAllowlist
}

export function setPromptCache1hAllowlist(allowlist: string[] | null): void {
  STATE.promptCache1hAllowlist = allowlist
}

export function getPromptCache1hEligible(): boolean | null {
  return STATE.promptCache1hEligible
}

export function setPromptCache1hEligible(eligible: boolean | null): void {
  STATE.promptCache1hEligible = eligible
}

export function getAfkModeHeaderLatched(): boolean | null {
  return STATE.afkModeHeaderLatched
}

export function setAfkModeHeaderLatched(v: boolean): void {
  STATE.afkModeHeaderLatched = v
}

export function getFastModeHeaderLatched(): boolean | null {
  return STATE.fastModeHeaderLatched
}

export function setFastModeHeaderLatched(v: boolean): void {
  STATE.fastModeHeaderLatched = v
}

export function getCacheEditingHeaderLatched(): boolean | null {
  return STATE.cacheEditingHeaderLatched
}

export function setCacheEditingHeaderLatched(v: boolean): void {
  STATE.cacheEditingHeaderLatched = v
}

/**
 * 重置 beta header 锁定状态为 null。在 /clear 和 /compact 时调用，
 * 这样新的对话会重新评估 header。
 */
export function clearBetaHeaderLatches(): void {
  STATE.afkModeHeaderLatched = null
  STATE.fastModeHeaderLatched = null
  STATE.cacheEditingHeaderLatched = null
}

export function getPromptId(): string | null {
  return STATE.promptId
}

export function setPromptId(id: string | null): void {
  STATE.promptId = id
}
export function isReplBridgeActive(): boolean {
  return false
}
