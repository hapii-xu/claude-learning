import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { UUID } from 'crypto'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { CompactionResult } from '../services/compact/compact.js'
import type { ScopedMcpServerConfig } from '../services/mcp/types.js'
import type { ToolUseContext } from '../Tool.js'
import type { EffortValue } from '../utils/effort.js'
import type { IDEExtensionInstallationStatus, IdeType } from '../utils/ide.js'
import type { SettingSource } from '../utils/settings/constants.js'
import type { HooksSettings } from '../utils/settings/types.js'
import type { ThemeName } from '../utils/theme.js'
import type { LogOption } from './logs.js'
import type { Message } from './message.js'
import type { PluginManifest } from './plugin.js'

export type LocalCommandResult =
  | { type: 'text'; value: string }
  | {
      type: 'compact'
      compactionResult: CompactionResult
      displayText?: string
    }
  | { type: 'skip' } // 跳过消息

export type PromptCommand = {
  type: 'prompt'
  progressMessage: string
  contentLength: number // 命令内容的字符长度（用于 token 估算）
  argNames?: string[]
  allowedTools?: string[]
  model?: string
  source: SettingSource | 'builtin' | 'mcp' | 'plugin' | 'bundled'
  pluginInfo?: {
    pluginManifest: PluginManifest
    repository: string
  }
  disableNonInteractive?: boolean
  // 该 skill 被调用时要注册的 hooks
  hooks?: HooksSettings
  // skill 资源的基目录（用于为 skill hook 设置 CLAUDE_PLUGIN_ROOT 环境变量）
  skillRoot?: string
  // 执行上下文：'inline'（默认）或 'fork'（作为 sub-agent 运行）
  // 'inline' = skill 内容展开到当前对话
  // 'fork' = skill 在 sub-agent 中运行，拥有独立的上下文和 token 预算
  context?: 'inline' | 'fork'
  // fork 时使用的 agent 类型（例如 'Bash'、'general-purpose'）
  // 仅在 context 为 'fork' 时适用
  agent?: string
  effort?: EffortValue
  // 该 skill 所适用的文件路径 glob 模式
  // 设置后，只有模型触碰过匹配文件时该 skill 才可见
  paths?: string[]
  getPromptForCommand(
    args: string,
    context: ToolUseContext,
  ): Promise<ContentBlockParam[]>
}

/**
 * 本地命令实现的调用签名。
 */
export type LocalCommandCall = (
  args: string,
  context: LocalJSXCommandContext,
) => Promise<LocalCommandResult>

/**
 * 懒加载本地命令的 load() 返回的模块形态。
 */
export type LocalCommandModule = {
  call: LocalCommandCall
}

type LocalCommand = {
  type: 'local'
  supportsNonInteractive: boolean
  load: () => Promise<LocalCommandModule>
}

export type LocalJSXCommandContext = ToolUseContext & {
  canUseTool?: CanUseToolFn
  setMessages: (updater: (prev: Message[]) => Message[]) => void
  options: {
    dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>
    ideInstallationStatus: IDEExtensionInstallationStatus | null
    theme: ThemeName
  }
  onChangeAPIKey: () => void
  onChangeDynamicMcpConfig?: (
    config: Record<string, ScopedMcpServerConfig>,
  ) => void
  onInstallIDEExtension?: (ide: IdeType) => void
  resume?: (
    sessionId: UUID,
    log: LogOption,
    entrypoint: ResumeEntrypoint,
  ) => Promise<void>
}

export type ResumeEntrypoint =
  | 'cli_flag'
  | 'slash_command_picker'
  | 'slash_command_session_id'
  | 'slash_command_title'
  | 'fork'

export type CommandResultDisplay = 'skip' | 'system' | 'user'

/**
 * 命令完成时的回调。
 * @param result - 可选的用户可见消息
 * @param options - 命令完成的可选配置
 * @param options.display - 结果的展示方式：'skip' | 'system' | 'user'（默认）
 * @param options.shouldQuery - 为 true 时，命令完成后向模型发送消息
 * @param options.metaMessages - 作为 isMeta 插入的额外消息（模型可见但隐藏）
 */
export type LocalJSXCommandOnDone = (
  result?: string,
  options?: {
    display?: CommandResultDisplay
    shouldQuery?: boolean
    metaMessages?: string[]
    nextInput?: string
    submitNextInput?: boolean
    /** 覆盖命令面包屑中展示的 args（例如截断版）。完整 args 仍会进入 metaMessages。 */
    displayArgs?: string
  },
) => void

/**
 * 本地 JSX 命令实现的调用签名。
 */
export type LocalJSXCommandCall = (
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
) => Promise<React.ReactNode>

/**
 * 懒加载命令的 load() 返回的模块形态。
 */
export type LocalJSXCommandModule = {
  call: LocalJSXCommandCall
}

type LocalJSXCommand = {
  type: 'local-jsx'
  /**
   * 懒加载命令实现。
   * 返回一个带 call() 函数的模块。
   * 这样把重依赖的加载推迟到命令被调用时。
   */
  load: () => Promise<LocalJSXCommandModule>
}

/**
 * 声明命令在哪些 auth/provider 环境下可用。
 *
 * 与 `isEnabled()` 是分开的概念：
 *   - `availability` = 谁可以使用（auth/provider 要求，静态）
 *   - `isEnabled()`  = 当前是否开启（GrowthBook、平台、env 变量）
 *
 * 没有声明 `availability` 的命令在任何地方都可用。
 * 声明了 `availability` 的命令仅在用户匹配所列 auth 类型中
 * 至少一项时才展示。参见 commands.ts 中的 meetsAvailabilityRequirement()。
 *
 * 例如：`availability: ['claude-ai', 'console']` 将命令展示给
 * claude.ai 订阅者以及直接 Console API key 用户（api.anthropic.com），
 * 但对 Bedrock/Vertex/Foundry 用户和自定义 base URL 用户隐藏。
 */
export type CommandAvailability =
  // claude.ai OAuth 订阅者（通过 claude.ai 的 Pro/Max/Team/Enterprise）
  | 'claude-ai'
  // Console API key 用户（直接 api.anthropic.com，而非通过 claude.ai OAuth）
  | 'console'

export type CommandBase = {
  availability?: CommandAvailability[]
  /**
   * 允许本地/local-jsx 命令在通过
   * Remote Control bridge 到达时执行。仅用于那些不需要本地
   * 交互式 Ink UI、并且能 headless 安全完成的命令。
   */
  bridgeSafe?: boolean
  /**
   * 可选的、按次调用对 bridge 投递的 slash command 进行校验。
   * 当特定参数不安全、不能通过 Remote Control headless 运行时，
   * 返回面向用户的拒绝原因。
   */
  getBridgeInvocationError?: (args: string) => string | undefined
  description: string
  hasUserSpecifiedDescription?: boolean
  /** 默认为 true。仅在命令具有条件启用（feature flag、env 检查等）时才设置。 */
  isEnabled?: () => boolean
  /** 默认为 false。仅在命令需要从 typeahead/help 中隐藏时设置。 */
  isHidden?: boolean
  name: string
  aliases?: string[]
  isMcp?: boolean
  argumentHint?: string // 命令参数的提示文本（命令之后以灰色显示）
  whenToUse?: string // 来自 "Skill" 规范。关于何时使用该命令的详细场景
  version?: string // 命令/skill 的版本
  disableModelInvocation?: boolean // 是否禁止模型调用该命令
  userInvocable?: boolean // 用户是否可以通过输入 /skill-name 来调用该 skill
  loadedFrom?:
    | 'commands_DEPRECATED'
    | 'skills'
    | 'plugin'
    | 'managed'
    | 'bundled'
    | 'mcp' // 命令的加载来源
  kind?: 'workflow' // 区分 workflow 支持的命令（在自动补全中加徽标）
  immediate?: boolean // 为 true 时，命令立即执行，不等待 stop point（绕过队列）
  isSensitive?: boolean // 为 true 时，参数会从对话历史中脱敏
  /** 默认为 `name`。仅在展示名不同（例如 plugin 前缀剥离）时才覆盖。 */
  userFacingName?: () => string
}

export type Command = CommandBase &
  (PromptCommand | LocalCommand | LocalJSXCommand)

/** 解析用户可见名，未覆盖时回退到 `cmd.name`。 */
export function getCommandName(cmd: CommandBase): string {
  const name = cmd.userFacingName?.() ?? cmd.name
  return name || ''
}

/** 解析命令是否启用，默认为 true。 */
export function isCommandEnabled(cmd: CommandBase): boolean {
  return cmd.isEnabled?.() ?? true
}
