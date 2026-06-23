import { feature } from 'bun:bundle'
import { randomBytes } from 'crypto'
import { unwatchFile, watchFile } from 'fs'
import memoize from 'lodash-es/memoize.js'
import pickBy from 'lodash-es/pickBy.js'
import { basename, dirname, join, resolve } from 'path'
import { getOriginalCwd, getSessionTrustAccepted } from '../bootstrap/state.js'
import { getAutoMemEntrypoint } from '../memdir/paths.js'
import { logEvent } from '../services/analytics/index.js'
import type { McpServerConfig } from '../services/mcp/types.js'
import type {
  BillingType,
  ReferralEligibilityResponse,
} from '../services/oauth/types.js'
import { getCwd } from '../utils/cwd.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { getGlobalClaudeFile } from './env.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { ConfigParseError, getErrnoCode } from './errors.js'
import { writeFileSyncAndFlush_DEPRECATED } from './file.js'
import { getFsImplementation } from './fsOperations.js'
import { findCanonicalGitRoot } from './git.js'
import { safeParseJSON } from './json.js'
import { stripBOM } from './jsonRead.js'
import * as lockfile from './lockfile.js'
import { logError } from './log.js'
import type { MemoryType } from './memory/types.js'
import { normalizePathForConfigKey } from './path.js'
import { getEssentialTrafficOnlyReason } from './privacyLevel.js'
import { getManagedFilePath } from './settings/managedPath.js'
import type { ThemeSetting } from './theme.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('../memdir/teamMemPaths.js') as typeof import('../memdir/teamMemPaths.js'))
  : null
const ccrAutoConnect = feature('CCR_AUTO_CONNECT')
  ? (require('../bridge/bridgeEnabled.js') as typeof import('../bridge/bridgeEnabled.js'))
  : null

/* eslint-enable @typescript-eslint/no-require-imports */
import type { ImageDimensions } from './imageResizer.js'
import type { ModelOption } from './model/modelOptions.js'
import { jsonParse, jsonStringify } from './slowOperations.js'

// 重入保护：防止 getConfig → logEvent → getGlobalConfig → getConfig
// 在配置文件损坏时出现无限递归。logEvent 的采样检查会从全局 config 读取
// GrowthBook feature，这会再次调用 getConfig。
let insideGetConfig = false

// 用于坐标映射的图片尺寸信息（仅在图片被缩放时设置）
export type PastedContent = {
  id: number // 顺序数字 ID
  type: 'text' | 'image'
  content: string
  mediaType?: string // 例如 'image/png'、'image/jpeg'
  filename?: string // 图片在附件槽中的显示名
  dimensions?: ImageDimensions
  sourcePath?: string // 拖入终端的图片的原始文件路径
}

export interface SerializedStructuredHistoryEntry {
  display: string
  pastedContents?: Record<number, PastedContent>
  pastedText?: string
}
export interface HistoryEntry {
  display: string
  pastedContents: Record<number, PastedContent>
}

export type ReleaseChannel = 'stable' | 'latest'

export type ProjectConfig = {
  allowedTools: string[]
  mcpContextUris: string[]
  mcpServers?: Record<string, McpServerConfig>
  lastAPIDuration?: number
  lastAPIDurationWithoutRetries?: number
  lastToolDuration?: number
  lastCost?: number
  lastDuration?: number
  lastLinesAdded?: number
  lastLinesRemoved?: number
  lastTotalInputTokens?: number
  lastTotalOutputTokens?: number
  lastTotalCacheCreationInputTokens?: number
  lastTotalCacheReadInputTokens?: number
  lastTotalWebSearchRequests?: number
  lastFpsAverage?: number
  lastFpsLow1Pct?: number
  lastSessionId?: string
  lastModelUsage?: Record<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
      webSearchRequests: number
      costUSD: number
    }
  >
  lastSessionMetrics?: Record<string, number>
  exampleFiles?: string[]
  exampleFilesGeneratedAt?: number

  // Trust dialog 设置
  hasTrustDialogAccepted?: boolean

  hasCompletedProjectOnboarding?: boolean
  projectOnboardingSeenCount: number
  hasClaudeMdExternalIncludesApproved?: boolean
  hasClaudeMdExternalIncludesWarningShown?: boolean
  // MCP 服务器审批字段 —— 已迁移到 settings，仅为向后兼容保留
  enabledMcpjsonServers?: string[]
  disabledMcpjsonServers?: string[]
  enableAllProjectMcpServers?: boolean
  // 被禁用的 MCP 服务器列表（所有 scope） —— 用于启用/禁用切换
  disabledMcpServers?: string[]
  // 默认禁用的内置 MCP 服务器的 opt-in 列表
  enabledMcpServers?: string[]
  // Worktree 会话管理
  activeWorktreeSession?: {
    originalCwd: string
    worktreePath: string
    worktreeName: string
    originalBranch?: string
    sessionId: string
    hookBased?: boolean
  }
  /** `claude remote-control` 多会话的派生模式。由首次运行对话框或 `w` 切换设置。 */
  remoteControlSpawnMode?: 'same-dir' | 'worktree'
}

const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  projectOnboardingSeenCount: 0,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
}

export type InstallMethod = 'local' | 'native' | 'global' | 'unknown'

export {
  EDITOR_MODES,
  NOTIFICATION_CHANNELS,
} from './configConstants.js'

import type { EDITOR_MODES, NOTIFICATION_CHANNELS } from './configConstants.js'
import { CLAUDE_DIR_NAME } from 'src/constants/claudeDirName.js'

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

export type AccountInfo = {
  accountUuid: string
  emailAddress: string
  organizationUuid?: string
  organizationName?: string | null // added 4/23/2025, not populated for existing users
  organizationRole?: string | null
  workspaceRole?: string | null
  // 由 /api/oauth/profile 填充
  displayName?: string
  hasExtraUsageEnabled?: boolean
  billingType?: BillingType | null
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
}

// TODO：'emacs' 仅为向后兼容保留 —— 几个版本后移除
export type EditorMode = 'emacs' | (typeof EDITOR_MODES)[number]

export type DiffTool = 'terminal' | 'auto'

export type OutputStyle = string

export type GlobalConfig = {
  /**
   * @deprecated Use settings.apiKeyHelper instead.
   */
  apiKeyHelper?: string
  projects?: Record<string, ProjectConfig>
  numStartups: number
  installMethod?: InstallMethod
  autoUpdates?: boolean
  // 用于区分"因保护被禁"与"用户偏好禁"的标记
  autoUpdatesProtectedForNative?: boolean
  // Doctor 上次显示时的会话数
  doctorShownAtSession?: number
  userID?: string
  theme: ThemeSetting
  hasCompletedOnboarding?: boolean
  // 记录上一次重置 onboarding 的版本，与 MIN_VERSION_REQUIRING_ONBOARDING_RESET 配合使用
  lastOnboardingVersion?: string
  // 记录用户已看过其 release notes 的最近版本，用于管理 release notes
  lastReleaseNotesSeen?: string
  // changelog 最近一次抓取的时间戳（内容存放在 ~/.hclaude/cache/changelog.md）
  changelogLastFetched?: number
  // @deprecated —— 已迁移到 ~/.hclaude/cache/changelog.md。仅为迁移支持保留。
  cachedChangelog?: string
  mcpServers?: Record<string, McpServerConfig>
  // 至少成功连接过一次的 claude.ai MCP connector。
  // 用于在启动时筛选"connector 不可用 / 需要认证"的提醒：
  // 用户真正使用过的 connector 坏掉时值得提示，但如果某个 org 配置的
  // connector 从第一天起就 needs-auth，用户显然已忽略它，便不应再反复提醒。
  claudeAiMcpEverConnected?: string[]
  preferredNotifChannel: NotificationChannel
  /**
   * @deprecated。请改用 Notification hook（docs/hooks.md）。
   */
  customNotifyCommand?: string
  verbose: boolean
  customApiKeyResponses?: {
    approved?: string[]
    rejected?: string[]
  }
  primaryApiKey?: string // 当没有环境变量时用户使用的首选 API key，通过 oauth 设置（TODO：重命名）
  /**
   * 通过 /login UI 保存的 workspace API key（sk-ant-api03-*）。
   * 以明文存储 —— 文件应被 gitignore 并设置 chmod 600。
   * 当两者同时存在时，以 ANTHROPIC_API_KEY 环境变量优先。
   */
  workspaceApiKey?: string
  hasAcknowledgedCostThreshold?: boolean
  hasSeenUndercoverAutoNotice?: boolean // 仅 ant：是否已展示一次性的 auto-undercover 说明
  hasSeenUltraplanTerms?: boolean // 仅 ant：是否已在 ultraplan 启动对话框中展示一次性 CCR 条款提示
  hasResetAutoModeOptInForDefaultOffer?: boolean // 仅 ant：一次性迁移保护，对曾流失的 auto-mode 用户重新提示
  oauthAccount?: AccountInfo
  iterm2KeyBindingInstalled?: boolean // 遗留 —— 为向后兼容保留
  editorMode?: EditorMode
  bypassPermissionsModeAccepted?: boolean
  hasUsedBackslashReturn?: boolean
  autoCompactEnabled: boolean // 控制 auto-compact 是否启用
  showTurnDuration: boolean // 控制是否显示轮次耗时消息（例如 "Cooked for 1m 6s"）
  /**
   * @deprecated 请改用 settings.env。
   */
  env: { [key: string]: string } // 为 CLI 设置的环境变量
  hasSeenTasksHint?: boolean // 用户是否已看过 tasks 提示
  hasUsedStash?: boolean // 用户是否使用过 stash 功能（Ctrl+S）
  hasUsedBackgroundTask?: boolean // 用户是否将任务转入后台过（Ctrl+B）
  queuedCommandUpHintCount?: number // 用户已看到"queued command up"提示的次数计数
  diffTool?: DiffTool // 显示 diff 时使用的工具（terminal 或 vscode）

  // 终端配置状态追踪
  iterm2SetupInProgress?: boolean
  iterm2BackupPath?: string // iTerm2 偏好设置备份文件路径
  appleTerminalBackupPath?: string // Terminal.app 偏好设置备份文件路径
  appleTerminalSetupInProgress?: boolean // Terminal.app 配置是否正在进行

  // 按键绑定配置追踪
  shiftEnterKeyBindingInstalled?: boolean // 是否已安装 Shift+Enter 按键绑定（iTerm2 或 VSCode）
  optionAsMetaKeyInstalled?: boolean // 是否已安装 Option as Meta key（Terminal.app）

  // IDE 配置
  autoConnectIde?: boolean // 若启动时恰好有一个可用 IDE，是否自动连接
  autoInstallIdeExtension?: boolean // 从 IDE 内运行时是否自动安装 IDE 扩展

  // IDE 对话框
  hasIdeOnboardingBeenShown?: Record<string, boolean> // 终端名 → 是否已展示 IDE onboarding 的映射
  ideHintShownCount?: number // /ide 命令提示已展示的次数
  hasIdeAutoConnectDialogBeenShown?: boolean // 是否已展示 auto-connect IDE 对话框

  tipsHistory: {
    [tipId: string]: number // key 为 tipId，value 为该 tip 上次展示时的 numStartups
  }

  // /buddy 伙伴灵魂 —— 读取时从 userId 重新生成。见 src/buddy/。
  companion?: import('../buddy/types.js').StoredCompanion
  companionMuted?: boolean

  // 反馈问卷追踪
  feedbackSurveyState?: {
    lastShownTime?: number
  }

  // 对话分享提示追踪（"不再询问"）
  transcriptShareDismissed?: boolean

  // 内存使用追踪
  memoryUsageCount: number // 用户添加到 memory 的次数

  // Sonnet-1M 配置
  hasShownS1MWelcomeV2?: Record<string, boolean> // 是否已按 org 展示 Sonnet-1M v2 欢迎消息
  // 每个 org 的 Sonnet-1M 订阅者访问缓存 —— key 为 org ID
  // hasAccess 表示 "hasAccessAsDefault"，但为了向后兼容保留旧名。
  s1mAccessCache?: Record<
    string,
    { hasAccess: boolean; hasAccessNotAsDefault?: boolean; timestamp: number }
  >
  // 每个 org 的 Sonnet-1M PayG 访问缓存 —— key 为 org ID
  // hasAccess 表示 "hasAccessAsDefault"，但为了向后兼容保留旧名。
  s1mNonSubscriberAccessCache?: Record<
    string,
    { hasAccess: boolean; hasAccessNotAsDefault?: boolean; timestamp: number }
  >

  // 每个 org 的 guest pass 资格缓存 —— key 为 org ID
  passesEligibilityCache?: Record<
    string,
    ReferralEligibilityResponse & { timestamp: number }
  >

  // 每个 account 的 Grove 配置缓存 —— key 为 account UUID
  groveConfigCache?: Record<
    string,
    { grove_enabled: boolean; timestamp: number }
  >

  // Guest pass 向上销售追踪
  passesUpsellSeenCount?: number // guest pass 向上销售已展示次数
  hasVisitedPasses?: boolean // 用户是否访问过 /passes 命令
  passesLastSeenRemaining?: number // 上次看到的 remaining_passes 数量 —— 当它增加时重置销售

  // Overage credit grant 向上销售追踪（按 org UUID 索引 —— 多 org 用户）。
  // 采用内联结构（而非 import()）因为 config.ts 处于 SDK build surface 中，
  // SDK bundler 无法解析 CLI service 模块。
  overageCreditGrantCache?: Record<
    string,
    {
      info: {
        available: boolean
        eligible: boolean
        granted: boolean
        amount_minor_units: number | null
        currency: string | null
      }
      timestamp: number
    }
  >
  overageCreditUpsellSeenCount?: number // overage credit 向上销售已展示次数
  hasVisitedExtraUsage?: boolean // 用户是否访问过 /extra-usage —— 隐藏 credit 向上销售

  // 显示语言偏好
  preferredLanguage?: 'auto' | 'en' | 'zh' // auto = 跟随系统语言，en = 英文，zh = 中文

  // 语音模式提示追踪
  voiceNoticeSeenCount?: number // 语音模式可用提示已展示次数
  voiceLangHintShownCount?: number // /voice dictation-language 提示已展示次数
  voiceLangHintLastLanguage?: string // 提示上次展示时解析到的 STT 语言代码 —— 切换语言时重置计数
  voiceFooterHintSeenCount?: number // "长按 X 说话" 页脚提示已展示的会话数

  // Opus 1M 合并通知追踪
  opus1mMergeNoticeSeenCount?: number // opus-1m-merge 通知已展示次数

  // 实验入组通知追踪（按 experiment id 索引）
  experimentNoticesSeenCount?: Record<string, number>

  // OpusPlan 实验配置
  hasShownOpusPlanWelcome?: Record<string, boolean> // 是否已按 org 展示 OpusPlan 欢迎消息

  // 队列使用追踪
  promptQueueUseCount: number // 用户使用 prompt 队列的次数

  // /btw 使用追踪
  btwUseCount: number // 用户使用 /btw 的次数

  // Plan 模式使用追踪
  lastPlanModeUse?: number // 上次使用 plan 模式的时间戳

  // 订阅通知追踪
  subscriptionNoticeCount?: number // 订阅通知已展示次数
  hasAvailableSubscription?: boolean // 用户是否有可用订阅的缓存结果
  subscriptionUpsellShownCount?: number // 订阅向上销售展示次数（已废弃）
  recommendedSubscription?: string // 来自 Statsig 的缓存配置值（已废弃）

  // Todo feature 配置
  todoFeatureEnabled: boolean // 是否启用 todo 功能
  showExpandedTodos?: boolean // 即使为空是否也展开显示 todos
  showSpinnerTree?: boolean // 是否展示 teammate spinner 树而非 pill

  // 首次启动时间追踪
  firstStartTime?: string // 本机首次启动 Claude Code 的 ISO 时间戳

  messageIdleNotifThresholdMs: number // 用户空闲多久后才发送"Claude 已生成完毕"通知

  githubActionSetupCount?: number // 用户配置 GitHub Action 的次数
  slackAppInstallCount?: number // 用户点击安装 Slack app 的次数

  // 文件 checkpointing 配置
  fileCheckpointingEnabled: boolean

  // 终端进度条配置（OSC 9;4）
  terminalProgressBarEnabled: boolean

  // 终端 tab 状态指示器（OSC 21337）。开启时会向 tab 侧边栏输出彩色
  // 圆点 + 状态文字，并从标题中去掉 spinner 前缀（圆点已经够用）。
  showStatusInTerminalTab?: boolean

  // 推送通知开关（通过 /config 设置）。默认关闭 —— 需显式 opt-in。
  taskCompleteNotifEnabled?: boolean
  inputNeededNotifEnabled?: boolean
  agentPushNotifEnabled?: boolean

  // Claude Code 使用情况追踪
  claudeCodeFirstTokenDate?: string // 用户首个 Claude Code OAuth token 的 ISO 时间戳

  // 模型切换提示追踪（仅 ant）
  modelSwitchCalloutDismissed?: boolean // 用户是否选择了"不再提示"
  modelSwitchCalloutLastShown?: number // 上次展示时间戳（24h 内不再展示）
  modelSwitchCalloutVersion?: string

  // Effort 提示追踪 —— 为 Opus 4.6 用户展示一次
  effortCalloutDismissed?: boolean // v1 —— 遗留字段，读取以抑制 v2（针对已看过 v1 的 Pro 用户）
  effortCalloutV2Dismissed?: boolean

  // Remote 提示追踪 —— 首次启用 bridge 前展示一次
  remoteDialogSeen?: boolean

  // 跨进程退避：用于 initReplBridge 的 oauth_expired_unrefreshable 跳过。
  // `expiresAt` 是去重 key —— 内容寻址，当 /login 替换 token 时自动清除。
  // `failCount` 限制误报：瞬态刷新失败（auth server 5xx、锁错误）在退避
  // 生效前有 3 次重试，与 useReplBridge 的 MAX_CONSECUTIVE_INIT_FAILURES 对齐。
  // 死 token 账户最多 3 次配置写入；健康 + 瞬态小故障约 210s 自愈。
  bridgeOauthDeadExpiresAt?: number
  bridgeOauthDeadFailCount?: number

  // Desktop 向上销售启动对话框追踪
  desktopUpsellSeenCount?: number // 总展示次数（最多 3 次）
  desktopUpsellDismissed?: boolean // 用户选择了"不再询问"

  // 空闲返回对话框追踪
  idleReturnDismissed?: boolean // 用户选择了"不再询问"

  // Opus 4.5 Pro 迁移追踪
  opusProMigrationComplete?: boolean
  opusProMigrationTimestamp?: number

  // Sonnet 4.5 1m 迁移追踪
  sonnet1m45MigrationComplete?: boolean

  // Opus 4.0/4.1 → 当前 Opus 迁移（展示一次性通知）
  legacyOpusMigrationTimestamp?: number

  // Sonnet 4.5 → 4.6 迁移（pro/max/team premium）
  sonnet45To46MigrationTimestamp?: number

  // 缓存的 statsig gate 值
  cachedStatsigGates: {
    [gateName: string]: boolean
  }

  // 缓存的 statsig 动态配置
  cachedDynamicConfigs?: { [configName: string]: unknown }

  // 缓存的 GrowthBook feature 值
  cachedGrowthBookFeatures?: { [featureName: string]: unknown }

  // 本地 GrowthBook 覆盖（仅 ant，通过 /config Gates 标签页设置）。
  // 在 env-var 覆盖之后、真实解析值之前检查。
  growthBookOverrides?: { [featureName: string]: unknown }

  // 紧急提示追踪 —— 存储上次展示的 tip 以防重复展示
  lastShownEmergencyTip?: string

  // File picker gitignore 行为
  respectGitignore: boolean // file picker 是否应遵循 .gitignore 文件（默认：true）。注意：.ignore 文件始终会被遵循

  // 复制命令行为
  copyFullResponse: boolean // /copy 是否总是复制完整回复，而不是显示选择器

  // 全屏应用内文本选择行为
  copyOnSelect?: boolean // 鼠标松开时自动复制到剪贴板（undefined → true；让 cmd+c 通过 no-op "生效"）

  // 用于 teleport 目录切换的 GitHub 仓库路径映射
  // key："owner/repo"（小写），value：仓库被 clone 的绝对路径数组
  githubRepoPaths?: Record<string, string[]>

  // 启动 claude-cli:// deep link 时拉起的终端模拟器。从交互式会话中的
  // TERM_PROGRAM 读取，因为 deep link handler 以 headless 方式运行
  //（LaunchServices/xdg），没有 TERM_PROGRAM。
  deepLinkTerminal?: string

  // iTerm2 it2 CLI 配置
  iterm2It2SetupComplete?: boolean // it2 配置是否已验证
  preferTmuxOverIterm2?: boolean // 用户偏好：总是使用 tmux 而非 iTerm2 分屏

  // 用于自动补全排序的 skill 使用追踪
  skillUsage?: Record<string, { usageCount: number; lastUsedAt: number }>
  // 官方 marketplace 自动安装追踪
  officialMarketplaceAutoInstallAttempted?: boolean // 是否已尝试自动安装
  officialMarketplaceAutoInstalled?: boolean // 自动安装是否成功
  officialMarketplaceAutoInstallFailReason?:
    | 'policy_blocked'
    | 'git_unavailable'
    | 'gcs_unavailable'
    | 'unknown' // 失败原因（若适用）
  officialMarketplaceAutoInstallRetryCount?: number // 重试次数
  officialMarketplaceAutoInstallLastAttemptTime?: number // 上次尝试的时间戳
  officialMarketplaceAutoInstallNextRetryTime?: number // 下次可重试的最早时间

  // Claude in Chrome 设置
  hasCompletedClaudeInChromeOnboarding?: boolean // 是否已展示 Claude in Chrome onboarding
  claudeInChromeDefaultEnabled?: boolean // Claude in Chrome 是否默认启用（undefined 表示平台默认）
  cachedChromeExtensionInstalled?: boolean // Chrome 扩展是否已安装的缓存结果

  // Chrome 扩展配对状态（跨会话持久化）
  chromeExtension?: {
    pairedDeviceId?: string
    pairedDeviceName?: string
  }

  // LSP 插件推荐偏好
  lspRecommendationDisabled?: boolean // 禁用所有 LSP 插件推荐
  lspRecommendationNeverPlugins?: string[] // 永不推荐的 plugin ID 列表
  lspRecommendationIgnoredCount?: number // 追踪被忽略的推荐次数（5 次后停止）

  // Claude Code hint 协议状态（来自 CLI/SDK 的 <claude-code-hint /> 标签）。
  // 按 hint 类型嵌套，方便未来新增类型（docs、mcp 等）时无需新增顶层 key。
  claudeCodeHints?: {
    // 已提示过用户的 plugin ID。一次一问语义：
    // 无论 yes/no 响应都会记录，永不再问。上限 100 条以约束 config 增长 ——
    // 超过后完全停止 hint。
    plugin?: string[]
    // 用户从对话框选择了"不再显示 plugin 安装提示"
    disabled?: boolean
  }

  // 权限解释器配置
  permissionExplainerEnabled?: boolean // 启用由 Haiku 生成的权限请求解释（默认：true）

  // Teammate 派生模式：'auto' | 'tmux' | 'windows-terminal' | 'in-process'
  teammateMode?: 'auto' | 'tmux' | 'windows-terminal' | 'in-process' // 如何派生 teammate（默认：'auto'）
  // 当工具调用未传 model 时新 teammate 使用的模型。
  // undefined = 硬编码 Opus（向后兼容）；null = leader 的模型；string = model alias/ID。
  teammateDefaultModel?: string | null

  // PR 状态页脚配置（通过 GrowthBook 的 feature flag）
  prStatusFooterEnabled?: boolean // 是否在页脚显示 PR review 状态（默认：true）

  // Tmux 实时面板可见性（仅 ant，在 tmux pill 上按 Enter 切换）
  tungstenPanelVisible?: boolean

  // 来自 API 的 org 级 fast mode 状态缓存。
  // 用于检测跨会话变化并通知用户。
  penguinModeOrgEnabled?: boolean

  // 后台刷新上次运行的 epoch ms（fast mode、配额、passes、client data）。
  // 配合 tengu_cicada_nap_ms 节流 API 调用
  startupPrefetchedAt?: number

  // 启动时运行 Remote Control（需 BRIDGE_MODE）
  // undefined = 使用默认（优先级见 getRemoteControlAtStartup()）
  remoteControlAtStartup?: boolean

  // 来自上次 API 响应的 extra usage 禁用原因缓存
  // undefined = 无缓存，null = extra usage 已启用，string = 禁用原因。
  cachedExtraUsageDisabledReason?: string | null

  // 自动权限通知追踪（仅 ant）
  autoPermissionsNotificationCount?: number // 自动权限通知已展示次数

  // Speculation 配置（仅 ant）
  speculationEnabled?: boolean // 是否启用 speculation（默认：true）

  // 用于服务端实验的 client data（bootstrap 期间抓取）。
  clientDataCache?: Record<string, unknown> | null

  // model picker 的额外 model 选项（bootstrap 期间抓取）。
  additionalModelOptionsCache?: ModelOption[]

  // /api/claude_code/organizations/metrics_enabled 的磁盘缓存。
  // org 级设置很少变化；跨进程持久化可避免每次 `claude -p` 调用都发起冷启动 API。
  metricsStatusCache?: {
    enabled: boolean
    timestamp: number
  }

  // 上一次应用的 migration 集合版本。当其等于
  // CURRENT_MIGRATION_VERSION 时，runMigrations() 跳过所有同步 migration
  //（避免每次启动都执行 11× saveGlobalConfig 的 lock + re-read）。
  migrationVersion?: number
}

/**
 * 创建一个全新默认 GlobalConfig 的工厂函数。用它而非深拷贝共享常量 ——
 * 嵌套容器（数组、record）都是空的，因此工厂函数以零拷贝成本提供全新引用。
 */
function createDefaultGlobalConfig(): GlobalConfig {
  return {
    numStartups: 0,
    installMethod: undefined,
    autoUpdates: undefined,
    theme: 'dark',
    preferredNotifChannel: 'auto',
    verbose: false,
    editorMode: 'normal',
    autoCompactEnabled: true,
    showTurnDuration: true,
    hasSeenTasksHint: false,
    hasUsedStash: false,
    hasUsedBackgroundTask: false,
    queuedCommandUpHintCount: 0,
    diffTool: 'auto',
    customApiKeyResponses: {
      approved: [],
      rejected: [],
    },
    env: {},
    tipsHistory: {},
    memoryUsageCount: 0,
    promptQueueUseCount: 0,
    btwUseCount: 0,
    todoFeatureEnabled: true,
    showExpandedTodos: false,
    messageIdleNotifThresholdMs: 60000,
    autoConnectIde: false,
    autoInstallIdeExtension: true,
    fileCheckpointingEnabled: true,
    terminalProgressBarEnabled: true,
    cachedStatsigGates: {},
    cachedDynamicConfigs: {},
    cachedGrowthBookFeatures: {},
    respectGitignore: true,
    copyFullResponse: false,
  }
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = createDefaultGlobalConfig()

export const GLOBAL_CONFIG_KEYS = [
  'apiKeyHelper',
  'installMethod',
  'autoUpdates',
  'autoUpdatesProtectedForNative',
  'theme',
  'verbose',
  'preferredNotifChannel',
  'shiftEnterKeyBindingInstalled',
  'editorMode',
  'hasUsedBackslashReturn',
  'autoCompactEnabled',
  'showTurnDuration',
  'diffTool',
  'env',
  'tipsHistory',
  'todoFeatureEnabled',
  'showExpandedTodos',
  'messageIdleNotifThresholdMs',
  'autoConnectIde',
  'autoInstallIdeExtension',
  'fileCheckpointingEnabled',
  'terminalProgressBarEnabled',
  'showStatusInTerminalTab',
  'taskCompleteNotifEnabled',
  'inputNeededNotifEnabled',
  'agentPushNotifEnabled',
  'respectGitignore',
  'claudeInChromeDefaultEnabled',
  'hasCompletedClaudeInChromeOnboarding',
  'lspRecommendationDisabled',
  'lspRecommendationNeverPlugins',
  'lspRecommendationIgnoredCount',
  'copyFullResponse',
  'copyOnSelect',
  'permissionExplainerEnabled',
  'prStatusFooterEnabled',
  'remoteControlAtStartup',
  'remoteDialogSeen',
] as const

export type GlobalConfigKey = (typeof GLOBAL_CONFIG_KEYS)[number]

export function isGlobalConfigKey(key: string): key is GlobalConfigKey {
  return GLOBAL_CONFIG_KEYS.includes(key as GlobalConfigKey)
}

export const PROJECT_CONFIG_KEYS = [
  'allowedTools',
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
] as const

export type ProjectConfigKey = (typeof PROJECT_CONFIG_KEYS)[number]

/**
 * 检查用户是否已对当前 cwd 接受 trust dialog。
 *
 * 本函数会向上遍历父目录，检查是否有某个父目录已被批准。接受某个目录的 trust
 * 意味着对其子目录也信任。
 *
 * @returns trust dialog 是否已被接受（即"不应再展示"）
 */
let _trustAccepted = false

export function resetTrustDialogAcceptedCacheForTesting(): void {
  _trustAccepted = false
}

export function checkHasTrustDialogAccepted(): boolean {
  // trust 在会话中只会从 false→true 转变（绝不会反向），
  // 因此一旦为 true 就可以锁存。false 不缓存 —— 每次调用都重新检查，
  // 以便会话中途接受的 trust dialog 能被感知。
  //（lodash memoize 在这里不合适，因为它会同时缓存 false。）
  return (_trustAccepted ||= computeTrustDialogAccepted())
}

function computeTrustDialogAccepted(): boolean {
  // 检查会话级别的 trust（对应 home 目录场景 —— trust 不持久化）
  // 从 home 目录运行时，trust dialog 会显示，但接受状态仅存于内存。
  // 这样 hooks 等功能在会话内仍可工作。
  if (getSessionTrustAccepted()) {
    return true
  }

  const config = getGlobalConfig()

  // 总是检查 trust 将被保存到的位置（git root 或原始 cwd）
  // 这是 saveCurrentProjectConfig 持久化 trust 的主要位置
  const projectPath = getProjectPathForConfig()
  const projectConfig = config.projects?.[projectPath]
  if (projectConfig?.hasTrustDialogAccepted) {
    return true
  }

  // 现在从当前工作目录及其父目录开始检查
  // 规范化路径以保证一致的 JSON key 查询
  let currentPath = normalizePathForConfigKey(getCwd())

  // 遍历所有父目录
  while (true) {
    const pathConfig = config.projects?.[currentPath]
    if (pathConfig?.hasTrustDialogAccepted) {
      return true
    }

    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    // 到达根目录（父目录等于当前目录）时停止
    if (parentPath === currentPath) {
      break
    }
    currentPath = parentPath
  }

  return false
}

/**
 * 检查任意目录（非会话 cwd）的 trust 状态。
 * 从 `dir` 向上遍历，任一祖先目录已持久化 trust 则返回 true。
 * 与 checkHasTrustDialogAccepted 不同，此函数不会查询会话 trust 或
 * 记忆化的工程路径 —— 适用于目标目录不同于 cwd 的场景
 *（例如 /assistant 安装到用户输入的路径）。
 */
export function isPathTrusted(dir: string): boolean {
  const config = getGlobalConfig()
  let currentPath = normalizePathForConfigKey(resolve(dir))
  while (true) {
    if (config.projects?.[currentPath]?.hasTrustDialogAccepted) return true
    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    if (parentPath === currentPath) return false
    currentPath = parentPath
  }
}

// 必须把这段测试代码放在这里，因为 Jest 不支持 mock ES 模块 :O
const TEST_GLOBAL_CONFIG_FOR_TESTING: GlobalConfig = {
  ...DEFAULT_GLOBAL_CONFIG,
  autoUpdates: false,
}
const TEST_PROJECT_CONFIG_FOR_TESTING: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
}

export function isProjectConfigKey(key: string): key is ProjectConfigKey {
  return PROJECT_CONFIG_KEYS.includes(key as ProjectConfigKey)
}

/**
 * 检测写入 `fresh` 是否会丢失内存缓存中仍持有的 auth/onboarding 状态。
 * 当 `getConfig` 命中正在被另一进程写入或非原子 fallback 所导致的损坏/截断
 * 文件，并返回 DEFAULT_GLOBAL_CONFIG 时，就会发生这种情况。把这样的默认
 * 配置写回会永久抹除 auth。参见 GH #3117。
 */
function wouldLoseAuthState(fresh: {
  oauthAccount?: unknown
  hasCompletedOnboarding?: boolean
}): boolean {
  const cached = globalConfigCache.config
  if (!cached) return false
  const lostOauth =
    cached.oauthAccount !== undefined && fresh.oauthAccount === undefined
  const lostOnboarding =
    cached.hasCompletedOnboarding === true &&
    fresh.hasCompletedOnboarding !== true
  return lostOauth || lostOnboarding
}

export function saveGlobalConfig(
  updater: (currentConfig: GlobalConfig) => GlobalConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    const config = updater(TEST_GLOBAL_CONFIG_FOR_TESTING)
    // 若无变化（返回相同引用）则跳过
    if (config === TEST_GLOBAL_CONFIG_FOR_TESTING) {
      return
    }
    Object.assign(TEST_GLOBAL_CONFIG_FOR_TESTING, config)
    return
  }

  let written: GlobalConfig | null = null
  try {
    const didWrite = saveConfigWithLock(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
      current => {
        const config = updater(current)
        // 若无变化（返回相同引用）则跳过
        if (config === current) {
          return current
        }
        written = {
          ...config,
          projects: removeProjectHistory(current.projects),
        }
        return written
      },
    )
    // 仅在确实写入后才做 write-through。若 auth-loss 保护被触发
    //（或 updater 未做任何改动），文件未被触碰，缓存仍有效 —— 再去动它
    // 反而会破坏保护机制。
    if (didWrite && written) {
      writeThroughGlobalConfigCache(written)
    }
  } catch (error) {
    logForDebugging(`加锁保存配置失败：${error}`, {
      level: 'error',
    })
    // 出错时 fallback 到无锁版本。该 fallback 存在竞态窗口：若另一进程
    // 正在写入（或文件被截断），getConfig 会返回默认值。拒绝将默认值
    // 覆盖到完好的缓存配置上，以防抹除 auth。参见 GH #3117。
    const currentConfig = getConfig(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
    )
    if (wouldLoseAuthState(currentConfig)) {
      logForDebugging(
        'saveGlobalConfig fallback：重新读取的配置缺失了缓存中的 auth；拒绝写入。参见 GH #3117。',
        { level: 'error' },
      )
      logEvent('tengu_config_auth_loss_prevented', {})
      return
    }
    const config = updater(currentConfig)
    // 若无变化（返回相同引用）则跳过
    if (config === currentConfig) {
      return
    }
    written = {
      ...config,
      projects: removeProjectHistory(currentConfig.projects),
    }
    saveConfig(getGlobalClaudeFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
  }
}

// 全局配置缓存
let globalConfigCache: { config: GlobalConfig | null; mtime: number } = {
  config: null,
  mtime: 0,
}

// 配置文件操作的追踪（遥测）
let lastReadFileStats: { mtime: number; size: number } | null = null
let configCacheHits = 0
let configCacheMisses = 0
// 会话内向全局配置文件实际发起磁盘写入的总次数。
// 仅供 ant 内部开发诊断使用（见 inc-4552），让异常写入速率在破坏
// ~/.hclaude.json 之前就能在 UI 上暴露。
let globalConfigWriteCount = 0

export function getGlobalConfigWriteCount(): number {
  return globalConfigWriteCount
}

export const CONFIG_WRITE_DISPLAY_THRESHOLD = 20

function reportConfigCacheStats(): void {
  const total = configCacheHits + configCacheMisses
  if (total > 0) {
    logEvent('tengu_config_cache_stats', {
      cache_hits: configCacheHits,
      cache_misses: configCacheMisses,
      hit_rate: configCacheHits / total,
    })
  }
  configCacheHits = 0
  configCacheMisses = 0
}

// 注册清理回调，在会话结束时上报缓存统计
// eslint-disable-next-line custom-rules/no-top-level-side-effects
registerCleanup(async () => {
  reportConfigCacheStats()
})

/**
 * 将旧的 autoUpdaterStatus 迁移到新的 installMethod 与 autoUpdates 字段
 * @internal
 */
function migrateConfigFields(config: GlobalConfig): GlobalConfig {
  // 已迁移过
  if (config.installMethod !== undefined) {
    return config
  }

  // autoUpdaterStatus 已从类型中移除，但可能仍存在于旧配置中
  const legacy = config as GlobalConfig & {
    autoUpdaterStatus?:
      | 'migrated'
      | 'installed'
      | 'disabled'
      | 'enabled'
      | 'no_permissions'
      | 'not_configured'
  }

  // 根据旧字段推断安装方式与自动更新偏好
  let installMethod: InstallMethod = 'unknown'
  let autoUpdates = config.autoUpdates ?? true // 默认启用，除非显式禁用

  switch (legacy.autoUpdaterStatus) {
    case 'migrated':
      installMethod = 'local'
      break
    case 'installed':
      installMethod = 'native'
      break
    case 'disabled':
      // 被禁用时无法得知安装方式
      autoUpdates = false
      break
    case 'enabled':
    case 'no_permissions':
    case 'not_configured':
      // 这些都意味着是全局安装
      installMethod = 'global'
      break
    case undefined:
      // 无旧状态，保留默认值
      break
  }

  return {
    ...config,
    installMethod,
    autoUpdates,
  }
}

/**
 * 移除 projects 中的 history 字段（已迁移到 history.jsonl）
 * @internal
 */
function removeProjectHistory(
  projects: Record<string, ProjectConfig> | undefined,
): Record<string, ProjectConfig> | undefined {
  if (!projects) {
    return projects
  }

  const cleanedProjects: Record<string, ProjectConfig> = {}
  let needsCleaning = false

  for (const [path, projectConfig] of Object.entries(projects)) {
    // history 已从类型中移除，但可能仍存在于旧配置中
    const legacy = projectConfig as ProjectConfig & { history?: unknown }
    if (legacy.history !== undefined) {
      needsCleaning = true
      const { history, ...cleanedConfig } = legacy
      cleanedProjects[path] = cleanedConfig
    } else {
      cleanedProjects[path] = projectConfig
    }
  }

  return needsCleaning ? cleanedProjects : projects
}

// 用于检测其他实例写入的 fs.watchFile 轮询间隔（毫秒）
const CONFIG_FRESHNESS_POLL_MS = 1000
let freshnessWatcherStarted = false

// fs.watchFile 在 libuv 线程池上轮询 stat，仅当 mtime 变化时才回调 ——
// 卡住的 stat 永远不会阻塞主线程。
function startGlobalConfigFreshnessWatcher(): void {
  if (freshnessWatcherStarted || process.env.NODE_ENV === 'test') return
  freshnessWatcherStarted = true
  const file = getGlobalClaudeFile()
  watchFile(
    file,
    { interval: CONFIG_FRESHNESS_POLL_MS, persistent: false },
    curr => {
      // 我们自己的写入也会触发该回调 —— write-through 的 Date.now()
      // 会超出文件 mtime，使 cache.mtime > 文件 mtime，因此跳过重新读取。
      // Bun/Node 在文件不存在时（初始回调或被删除）也会以 curr.mtimeMs=0 触发
      // —— <= 也能处理这种情况。
      if (curr.mtimeMs <= globalConfigCache.mtime) return
      void getFsImplementation()
        .readFile(file, { encoding: 'utf-8' })
        .then(content => {
          // 读取期间某个 write-through 可能已经推进了缓存；
          // 不要退回到 watchFile 统计的过期快照。
          if (curr.mtimeMs <= globalConfigCache.mtime) return
          const parsed = safeParseJSON(stripBOM(content))
          if (parsed === null || typeof parsed !== 'object') return
          globalConfigCache = {
            config: migrateConfigFields({
              ...createDefaultGlobalConfig(),
              ...(parsed as Partial<GlobalConfig>),
            }),
            mtime: curr.mtimeMs,
          }
          lastReadFileStats = { mtime: curr.mtimeMs, size: curr.size }
        })
        .catch(() => {})
    },
  )
  registerCleanup(async () => {
    unwatchFile(file)
    freshnessWatcherStarted = false
  })
}

// Write-through：我们刚刚写入的内容就是新的 config。cache.mtime 会超出
// 文件真实 mtime（Date.now() 在写入之后才记录），因此 freshness watcher
// 下一轮会跳过对我们自己写入的重复读取。
function writeThroughGlobalConfigCache(config: GlobalConfig): void {
  globalConfigCache = { config, mtime: Date.now() }
  lastReadFileStats = null
}

export function getGlobalConfig(): GlobalConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_GLOBAL_CONFIG_FOR_TESTING
  }

  // 快速路径：纯内存读取。启动后总是命中 —— 我们自己的写入走
  // write-through，其他实例的写入由后台 freshness watcher 接管
  //（永远不会阻塞这条路径）。
  if (globalConfigCache.config) {
    configCacheHits++
    return globalConfigCache.config
  }

  // 慢速路径：启动加载。这里的同步 I/O 可以接受，因为它只运行一次，
  // 且早于任何 UI 渲染。读取前先 stat，这样任何竞态都能自我修正
  //（旧 mtime + 新内容 → watcher 下一轮重新读取）。
  configCacheMisses++
  try {
    let stats: { mtimeMs: number; size: number } | null = null
    try {
      stats = getFsImplementation().statSync(getGlobalClaudeFile())
    } catch {
      // 文件不存在
    }
    const config = migrateConfigFields(
      getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig),
    )
    globalConfigCache = {
      config,
      mtime: stats?.mtimeMs ?? Date.now(),
    }
    lastReadFileStats = stats
      ? { mtime: stats.mtimeMs, size: stats.size }
      : null
    startGlobalConfigFreshnessWatcher()
    return config
  } catch {
    // 任何异常都 fallback 到无缓存行为
    return migrateConfigFields(
      getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig),
    )
  }
}

/**
 * 返回 remoteControlAtStartup 的有效值。优先级：
 *   1. 用户显式设置的 config 值（总是胜出 —— 尊重 opt-out）
 *   2. CCR auto-connect 默认值（仅 ant 构建，由 GrowthBook 门控）
 *   3. false（Remote Control 必须显式 opt-in）
 */
export function getRemoteControlAtStartup(): boolean {
  const explicit = getGlobalConfig().remoteControlAtStartup
  if (explicit !== undefined) return explicit
  if (feature('CCR_AUTO_CONNECT')) {
    if (ccrAutoConnect?.getCcrAutoConnectDefault()) return true
  }
  return false
}

export function getCustomApiKeyStatus(
  truncatedApiKey: string,
): 'approved' | 'rejected' | 'new' {
  const config = getGlobalConfig()
  if (config.customApiKeyResponses?.approved?.includes(truncatedApiKey)) {
    return 'approved'
  }
  if (config.customApiKeyResponses?.rejected?.includes(truncatedApiKey)) {
    return 'rejected'
  }
  return 'new'
}

function saveConfig<A extends object>(
  file: string,
  config: A,
  defaultConfig: A,
): void {
  // 写入配置文件前确保目录存在
  const dir = dirname(file)
  const fs = getFsImplementation()
  // mkdirSync 在 FsOperations 实现中已是递归的
  fs.mkdirSync(dir)

  // 过滤掉与默认值相同的字段
  const filteredConfig = pickBy(
    config,
    (value, key) =>
      jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
  )
  // 以安全权限写入配置文件 —— mode 仅对新文件生效
  writeFileSyncAndFlush_DEPRECATED(
    file,
    jsonStringify(filteredConfig, null, 2),
    {
      encoding: 'utf-8',
      mode: 0o600,
    },
  )
  if (file === getGlobalClaudeFile()) {
    globalConfigWriteCount++
  }
}

/**
 * 执行了写入返回 true；跳过写入（无改动或 auth-loss 保护被触发）返回 false。
 * 调用方据此判断是否需要失效缓存 —— 跳过的写入之后再失效缓存会破坏
 * auth-loss 保护所依赖的完好缓存状态。
 */
function saveConfigWithLock<A extends object>(
  file: string,
  createDefault: () => A,
  mergeFn: (current: A) => A,
): boolean {
  const defaultConfig = createDefault()
  const dir = dirname(file)
  const fs = getFsImplementation()

  // 确保目录存在（mkdirSync 在 FsOperations 中已是递归的）
  fs.mkdirSync(dir)

  let release
  try {
    const lockFilePath = `${file}.lock`
    const startTime = Date.now()
    release = lockfile.lockSync(file, {
      lockfilePath: lockFilePath,
      onCompromised: err => {
        // 默认 onCompromised 在 setTimeout 回调中抛错，会变成未处理异常。
        // 这里改为仅打日志 —— 锁被偷走（例如 event-loop 卡顿 10s 后）是可以恢复的。
        logForDebugging(`配置锁被破坏：${err}`, { level: 'error' })
      },
    })
    const lockTime = Date.now() - startTime
    if (lockTime > 100) {
      logForDebugging('获取锁耗时超过预期 —— 可能有另一个 Claude 实例正在运行')
      logEvent('tengu_config_lock_contention', {
        lock_time_ms: lockTime,
      })
    }

    // 检测 stale 写入 —— 文件自上次读取后已被改动
    // 仅对全局配置文件检查，因为 lastReadFileStats 只跟踪该文件
    if (lastReadFileStats && file === getGlobalClaudeFile()) {
      try {
        const currentStats = fs.statSync(file)
        if (
          currentStats.mtimeMs !== lastReadFileStats.mtime ||
          currentStats.size !== lastReadFileStats.size
        ) {
          logEvent('tengu_config_stale_write', {
            read_mtime: lastReadFileStats.mtime,
            write_mtime: currentStats.mtimeMs,
            read_size: lastReadFileStats.size,
            write_size: currentStats.size,
          })
        }
      } catch (e) {
        const code = getErrnoCode(e)
        if (code !== 'ENOENT') {
          throw e
        }
        // 文件尚不存在，无需做 stale 检测
      }
    }

    // 重新读取当前配置以拿到最新状态。若文件瞬时损坏（并发写入、写入时被 kill），
    // 这里会返回默认值 —— 我们绝不能把默认值覆盖回完好的配置上。
    const currentConfig = getConfig(file, createDefault)
    if (file === getGlobalClaudeFile() && wouldLoseAuthState(currentConfig)) {
      logForDebugging(
        'saveConfigWithLock：重新读取的配置缺失了缓存中的 auth；为避免抹除 ~/.hclaude.json 拒绝写入。参见 GH #3117。',
        { level: 'error' },
      )
      logEvent('tengu_config_auth_loss_prevented', {})
      return false
    }

    // 应用 merge 函数得到更新后的配置
    const mergedConfig = mergeFn(currentConfig)

    // 无变化（返回相同引用）则跳过写入
    if (mergedConfig === currentConfig) {
      return false
    }

    // 过滤掉与默认值相同的字段
    const filteredConfig = pickBy(
      mergedConfig,
      (value, key) =>
        jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
    )

    // 写入前为现有配置创建带时间戳的备份
    // 保留多份备份，以防 reset/损坏的配置覆盖掉完好的备份。
    // 备份存放在 ~/.hclaude/backups/ 下，保持 home 目录整洁。
    try {
      const fileBase = basename(file)
      const backupDir = getConfigBackupDir()

      // 确保备份目录存在
      try {
        fs.mkdirSync(backupDir)
      } catch (mkdirErr) {
        const mkdirCode = getErrnoCode(mkdirErr)
        if (mkdirCode !== 'EEXIST') {
          throw mkdirErr
        }
      }

      // 先检查已有备份 —— 若最近已有一份备份则跳过新建。
      // 启动期间许多 saveGlobalConfig 调用会在毫秒级间隔内连续触发；
      // 不加该检查，每次调用都会新建一个备份文件，堆积在磁盘上。
      const MIN_BACKUP_INTERVAL_MS = 60_000
      const existingBackups = fs
        .readdirStringSync(backupDir)
        .filter(f => f.startsWith(`${fileBase}.backup.`))
        .sort()
        .reverse() // 最近在前（时间戳按字典序排序）

      const mostRecentBackup = existingBackups[0]
      const mostRecentTimestamp = mostRecentBackup
        ? Number(mostRecentBackup.split('.backup.').pop())
        : 0
      const shouldCreateBackup =
        Number.isNaN(mostRecentTimestamp) ||
        Date.now() - mostRecentTimestamp >= MIN_BACKUP_INTERVAL_MS

      if (shouldCreateBackup) {
        const backupPath = join(backupDir, `${fileBase}.backup.${Date.now()}`)
        fs.copyFileSync(file, backupPath)
      }

      // 清理旧备份，只保留最近 5 份
      const MAX_BACKUPS = 5
      // 若刚创建了一份新备份就重新读取；否则复用已有列表
      const backupsForCleanup = shouldCreateBackup
        ? fs
            .readdirStringSync(backupDir)
            .filter(f => f.startsWith(`${fileBase}.backup.`))
            .sort()
            .reverse()
        : existingBackups

      for (const oldBackup of backupsForCleanup.slice(MAX_BACKUPS)) {
        try {
          fs.unlinkSync(join(backupDir, oldBackup))
        } catch {
          // 忽略清理错误
        }
      }
    } catch (e) {
      const code = getErrnoCode(e)
      if (code !== 'ENOENT') {
        logForDebugging(`备份配置失败：${e}`, {
          level: 'error',
        })
      }
      // 无文件可备份或备份失败，继续写入
    }

    // 以安全权限写入配置文件 —— mode 仅对新文件生效
    writeFileSyncAndFlush_DEPRECATED(
      file,
      jsonStringify(filteredConfig, null, 2),
      {
        encoding: 'utf-8',
        mode: 0o600,
      },
    )
    if (file === getGlobalClaudeFile()) {
      globalConfigWriteCount++
    }
    return true
  } finally {
    if (release) {
      release()
    }
  }
}

// 标记：是否允许读取配置
let configReadingAllowed = false

export function enableConfigs(): void {
  if (configReadingAllowed) {
    // 保持幂等
    logForDebugging('[Hapii] enableConfigs: 已允许（幂等跳过）', {
      level: 'info',
    })
    return
  }

  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'enable_configs_started')

  // 在该 flag 被设置前对配置的任何读取都会在控制台报警，
  // 防止我们在模块初始化期间加入配置读取
  configReadingAllowed = true
  logForDebugging(
    '[Hapii] enableConfigs: configReadingAllowed=true，正在校验全局配置',
    { level: 'info' },
  )
  // 仅检查全局配置，因为目前所有配置共用一个文件
  getConfig(
    getGlobalClaudeFile(),
    createDefaultGlobalConfig,
    true /* 无效时抛错 */,
  )

  logForDiagnosticsNoPII('info', 'enable_configs_completed', {
    duration_ms: Date.now() - startTime,
  })
}

/**
 * 返回配置备份文件的存放目录。
 * 使用 ~/.hclaude/backups/，保持 home 目录整洁。
 */
function getConfigBackupDir(): string {
  return join(getClaudeConfigHomeDir(), 'backups')
}

/**
 * 为给定配置文件查找最近的备份。
 * 先检查 ~/.hclaude/backups/，若不存在则 fallback 到遗留位置
 *（配置文件旁边）以保持向后兼容。
 * 返回最近备份的完整路径，若不存在则返回 null。
 */
function findMostRecentBackup(file: string): string | null {
  const fs = getFsImplementation()
  const fileBase = basename(file)
  const backupDir = getConfigBackupDir()

  // 先检查新的备份目录
  try {
    const backups = fs
      .readdirStringSync(backupDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()

    const mostRecent = backups.at(-1) // 时间戳按字典序排序
    if (mostRecent) {
      return join(backupDir, mostRecent)
    }
  } catch {
    // 备份目录尚不存在
  }

  // Fallback 到遗留位置（配置文件旁边）
  const fileDir = dirname(file)

  try {
    const backups = fs
      .readdirStringSync(fileDir)
      .filter(f => f.startsWith(`${fileBase}.backup.`))
      .sort()

    const mostRecent = backups.at(-1) // 时间戳按字典序排序
    if (mostRecent) {
      return join(fileDir, mostRecent)
    }

    // 检查遗留备份文件（无时间戳）
    const legacyBackup = `${file}.backup`
    try {
      fs.statSync(legacyBackup)
      return legacyBackup
    } catch {
      // 遗留备份不存在
    }
  } catch {
    // 忽略读取目录的错误
  }

  return null
}

function getConfig<A>(
  file: string,
  createDefault: () => A,
  throwOnInvalid?: boolean,
): A {
  // 配置在允许访问前被读取时打一条警告
  if (!configReadingAllowed && process.env.NODE_ENV !== 'test') {
    throw new Error('Config accessed before allowed.')
  }

  const fs = getFsImplementation()

  try {
    const fileContent = fs.readFileSync(file, {
      encoding: 'utf-8',
    })
    try {
      // 解析前去掉 BOM —— PowerShell 5.x 会为 UTF-8 文件加 BOM
      const parsedConfig = jsonParse(stripBOM(fileContent))
      return {
        ...createDefault(),
        ...parsedConfig,
      }
    } catch (error) {
      // 抛出 ConfigParseError，携带文件路径与默认配置
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      throw new ConfigParseError(errorMessage, file, createDefault())
    }
  } catch (error) {
    // 处理文件不存在 —— 检查备份并返回默认值
    const errCode = getErrnoCode(error)
    if (errCode === 'ENOENT') {
      const backupPath = findMostRecentBackup(file)
      if (backupPath) {
        process.stderr.write(
          `\n未找到 Claude 配置文件：${file}\n` +
            `在以下路径存在备份：${backupPath}\n` +
            `可手动恢复：cp "${backupPath}" "${file}"\n\n`,
        )
      }
      return createDefault()
    }

    // 若 throwOnInvalid 为 true，则重新抛出 ConfigParseError
    if (error instanceof ConfigParseError && throwOnInvalid) {
      throw error
    }

    // 记录配置解析错误日志，让用户知道发生了什么
    if (error instanceof ConfigParseError) {
      logForDebugging(`配置文件已损坏，重置为默认值：${error.message}`, {
        level: 'error',
      })

      // 保护：logEvent → shouldSampleEvent → getGlobalConfig → getConfig
      // 在配置文件损坏时会无限递归，因为采样检查会从全局 config 读取
      // GrowthBook feature。仅在最外层调用记录 analytics。
      if (!insideGetConfig) {
        insideGetConfig = true
        try {
          // 记录错误用于监控
          logError(error)

          // 为配置损坏上报 analytics 事件
          let hasBackup = false
          try {
            fs.statSync(`${file}.backup`)
            hasBackup = true
          } catch {
            // 无备份
          }
          logEvent('tengu_config_parse_error', {
            has_backup: hasBackup,
          })
        } finally {
          insideGetConfig = false
        }
      }

      process.stderr.write(
        `\n位于 ${file} 的 Claude 配置文件已损坏：${error.message}\n`,
      )

      // 尝试备份损坏的配置文件（仅在尚未备份的情况下）
      const fileBase = basename(file)
      const corruptedBackupDir = getConfigBackupDir()

      // 确保备份目录存在
      try {
        fs.mkdirSync(corruptedBackupDir)
      } catch (mkdirErr) {
        const mkdirCode = getErrnoCode(mkdirErr)
        if (mkdirCode !== 'EEXIST') {
          throw mkdirErr
        }
      }

      const existingCorruptedBackups = fs
        .readdirStringSync(corruptedBackupDir)
        .filter(f => f.startsWith(`${fileBase}.corrupted.`))

      let corruptedBackupPath: string | undefined
      let alreadyBackedUp = false

      // 检查当前损坏内容是否已与某份现存备份一致
      const currentContent = fs.readFileSync(file, { encoding: 'utf-8' })
      for (const backup of existingCorruptedBackups) {
        try {
          const backupContent = fs.readFileSync(
            join(corruptedBackupDir, backup),
            { encoding: 'utf-8' },
          )
          if (currentContent === backupContent) {
            alreadyBackedUp = true
            break
          }
        } catch {
          // 忽略备份读取错误
        }
      }

      if (!alreadyBackedUp) {
        corruptedBackupPath = join(
          corruptedBackupDir,
          `${fileBase}.corrupted.${Date.now()}`,
        )
        try {
          fs.copyFileSync(file, corruptedBackupPath)
          logForDebugging(`损坏的配置已备份至：${corruptedBackupPath}`, {
            level: 'error',
          })
        } catch {
          // 忽略备份错误
        }
      }

      // 通知用户配置已损坏以及可用的备份
      const backupPath = findMostRecentBackup(file)
      if (corruptedBackupPath) {
        process.stderr.write(`损坏的文件已备份至：${corruptedBackupPath}\n`)
      } else if (alreadyBackedUp) {
        process.stderr.write(`该损坏文件此前已备份。\n`)
      }

      if (backupPath) {
        process.stderr.write(
          `在以下路径存在备份：${backupPath}\n` +
            `可手动恢复：cp "${backupPath}" "${file}"\n\n`,
        )
      } else {
        process.stderr.write(`\n`)
      }
    }

    return createDefault()
  }
}

// 记忆化：获取用于配置查询的工程路径
export const getProjectPathForConfig = memoize((): string => {
  const originalCwd = getOriginalCwd()
  const gitRoot = findCanonicalGitRoot(originalCwd)

  if (gitRoot) {
    // 规范化以保证一致的 JSON key（所有平台都用正斜杠）
    // 让 C:\Users\... 与 C:/Users/... 映射到同一个 key
    return normalizePathForConfigKey(gitRoot)
  }

  // 不在 git 仓库中
  return normalizePathForConfigKey(resolve(originalCwd))
})

export function getCurrentProjectConfig(): ProjectConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_PROJECT_CONFIG_FOR_TESTING
  }

  const absolutePath = getProjectPathForConfig()
  const config = getGlobalConfig()

  if (!config.projects) {
    return DEFAULT_PROJECT_CONFIG
  }

  const projectConfig = config.projects[absolutePath] ?? DEFAULT_PROJECT_CONFIG
  // 不清楚它怎么变成 string 的
  // TODO：在上游修复
  if (typeof projectConfig.allowedTools === 'string') {
    projectConfig.allowedTools =
      (safeParseJSON(projectConfig.allowedTools) as string[]) ?? []
  }

  return projectConfig
}

export function saveCurrentProjectConfig(
  updater: (currentConfig: ProjectConfig) => ProjectConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    const config = updater(TEST_PROJECT_CONFIG_FOR_TESTING)
    // 若无变化（返回相同引用）则跳过
    if (config === TEST_PROJECT_CONFIG_FOR_TESTING) {
      return
    }
    Object.assign(TEST_PROJECT_CONFIG_FOR_TESTING, config)
    return
  }
  const absolutePath = getProjectPathForConfig()

  let written: GlobalConfig | null = null
  try {
    const didWrite = saveConfigWithLock(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
      current => {
        const currentProjectConfig =
          current.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
        const newProjectConfig = updater(currentProjectConfig)
        // 若无变化（返回相同引用）则跳过
        if (newProjectConfig === currentProjectConfig) {
          return current
        }
        written = {
          ...current,
          projects: {
            ...current.projects,
            [absolutePath]: newProjectConfig,
          },
        }
        return written
      },
    )
    if (didWrite && written) {
      writeThroughGlobalConfigCache(written)
    }
  } catch (error) {
    logForDebugging(`加锁保存配置失败：${error}`, {
      level: 'error',
    })

    // 与 saveGlobalConfig 的 fallback 同样的竞态窗口 —— 拒绝把默认值
    // 覆盖到完好的缓存配置上。参见 GH #3117。
    const config = getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig)
    if (wouldLoseAuthState(config)) {
      logForDebugging(
        'saveCurrentProjectConfig fallback：重新读取的配置缺失了缓存中的 auth；拒绝写入。参见 GH #3117。',
        { level: 'error' },
      )
      logEvent('tengu_config_auth_loss_prevented', {})
      return
    }
    const currentProjectConfig =
      config.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
    const newProjectConfig = updater(currentProjectConfig)
    // 若无变化（返回相同引用）则跳过
    if (newProjectConfig === currentProjectConfig) {
      return
    }
    written = {
      ...config,
      projects: {
        ...config.projects,
        [absolutePath]: newProjectConfig,
      },
    }
    saveConfig(getGlobalClaudeFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
  }
}

export function isAutoUpdaterDisabled(): boolean {
  return getAutoUpdaterDisabledReason() !== null
}

/**
 * 返回 true 表示应跳过 plugin 自动更新。
 * 检查 auto-updater 是否被禁用，且 FORCE_AUTOUPDATE_PLUGINS 环境变量
 * 未设为 'true'。该环境变量允许在 auto-updater 被禁用的情况下强制更新插件。
 */
export function shouldSkipPluginAutoupdate(): boolean {
  return (
    isAutoUpdaterDisabled() &&
    !isEnvTruthy(process.env.FORCE_AUTOUPDATE_PLUGINS)
  )
}

export type AutoUpdaterDisabledReason =
  | { type: 'development' }
  | { type: 'env'; envVar: string }
  | { type: 'config' }

export function formatAutoUpdaterDisabledReason(
  reason: AutoUpdaterDisabledReason,
): string {
  switch (reason.type) {
    case 'development':
      return 'development 构建'
    case 'env':
      return `${reason.envVar} 已设置`
    case 'config':
      return '配置'
  }
}

export function getAutoUpdaterDisabledReason(): AutoUpdaterDisabledReason | null {
  if (process.env.NODE_ENV === 'development') {
    return { type: 'development' }
  }
  // 本项目默认关闭自动更新；通过 ENABLE_AUTOUPDATER=1 显式开启
  if (!isEnvTruthy(process.env.ENABLE_AUTOUPDATER)) {
    return { type: 'config' }
  }
  if (isEnvTruthy(process.env.DISABLE_AUTOUPDATER)) {
    return { type: 'env', envVar: 'DISABLE_AUTOUPDATER' }
  }
  const essentialTrafficEnvVar = getEssentialTrafficOnlyReason()
  if (essentialTrafficEnvVar) {
    return { type: 'env', envVar: essentialTrafficEnvVar }
  }
  const config = getGlobalConfig()
  if (
    config.autoUpdates === false &&
    (config.installMethod !== 'native' ||
      config.autoUpdatesProtectedForNative !== true)
  ) {
    return { type: 'config' }
  }
  return null
}

export function getOrCreateUserID(): string {
  const config = getGlobalConfig()
  if (config.userID) {
    return config.userID
  }

  const userID = randomBytes(32).toString('hex')
  saveGlobalConfig(current => ({ ...current, userID }))
  return userID
}

export function recordFirstStartTime(): void {
  const config = getGlobalConfig()
  if (!config.firstStartTime) {
    const firstStartTime = new Date().toISOString()
    saveGlobalConfig(current => ({
      ...current,
      firstStartTime: current.firstStartTime ?? firstStartTime,
    }))
  }
}

export function getMemoryPath(memoryType: MemoryType): string {
  const cwd = getOriginalCwd()

  switch (memoryType) {
    case 'User':
      return join(getClaudeConfigHomeDir(), 'CLAUDE.md')
    case 'Local':
      return join(cwd, 'CLAUDE.local.md')
    case 'Project':
      return join(cwd, 'CLAUDE.md')
    case 'Managed':
      return join(getManagedFilePath(), 'CLAUDE.md')
    case 'AutoMem':
      return getAutoMemEntrypoint()
  }
  // TeamMem 仅在 feature('TEAMMEM') 为 true 时才是合法的 MemoryType
  if (feature('TEAMMEM')) {
    return teamMemPaths!.getTeamMemEntrypoint()
  }
  return '' // 在 TeamMem 不在 MemoryType 中的外部构建中不可达
}

export function getManagedClaudeRulesDir(): string {
  return join(getManagedFilePath(), CLAUDE_DIR_NAME, 'rules')
}

export function getUserClaudeRulesDir(): string {
  return join(getClaudeConfigHomeDir(), 'rules')
}

// 仅为测试导出
export const _getConfigForTesting = getConfig
export const _wouldLoseAuthStateForTesting = wouldLoseAuthState
export function _setGlobalConfigCacheForTesting(
  config: GlobalConfig | null,
): void {
  globalConfigCache.config = config
  globalConfigCache.mtime = config ? Date.now() : 0
}
