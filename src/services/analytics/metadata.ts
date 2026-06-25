// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * analytics 系统共享的事件 metadata enrichment
 *
 * 本模块为所有 analytics 系统（Datadog、1P）收集和格式化
 * 事件 metadata 提供唯一的真相来源（single source of truth）。
 */

import { extname } from 'path'
import memoize from 'lodash-es/memoize.js'
import { env, getHostPlatformForAnalytics } from '../../utils/env.js'
import { envDynamic } from '../../utils/envDynamic.js'
import { getModelBetas } from '../../utils/betas.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import {
  getSessionId,
  getIsInteractive,
  getKairosActive,
  getClientType,
  getParentSessionId as getParentSessionIdFromState,
} from '../../bootstrap/state.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isOfficialMcpUrl } from '../mcp/officialRegistry.js'
import { isClaudeAISubscriber, getSubscriptionType } from '../../utils/auth.js'
import { getRepoRemoteHash } from '../../utils/git.js'
import {
  getWslVersion,
  getLinuxDistroInfo,
  detectVcs,
} from '../../utils/platform.js'
import type { CoreUserData } from 'src/utils/user.js'
import { getAgentContext } from '../../utils/agentContext.js'
import type { EnvironmentMetadata } from '../../types/generated/events_mono/claude_code/v1/claude_code_internal_event.js'
import type { PublicApiAuth } from '../../types/generated/events_mono/common/v1/auth.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getAgentId,
  getParentSessionId as getTeammateParentSessionId,
  getTeamName,
  isTeammate,
} from '../../utils/teammate.js'
import { feature } from 'bun:bundle'

/**
 * 标记类型，用于校验 analytics metadata 不含敏感数据
 *
 * 此类型强制开发者显式确认：被记录的字符串值
 * 不包含代码片段、文件路径或其他敏感信息。
 *
 * metadata 应是 JSON 可序列化的。
 *
 * 用法：`myString as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`
 *
 * 该类型为 `never`，意味着它永远无法真正持有一个值——这是
 * 有意为之，仅用于类型转换以记录开发者的意图。
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never

/**
 * 为 analytics 日志对 tool 名做脱敏，以避免 PII 泄露。
 *
 * MCP tool 名遵循 `mcp__<server>__<tool>` 格式，可能暴露
 * 用户特定的 server 配置，被视为 PII-medium。
 * 本函数会遮盖 MCP tool 名，同时保留内置 tool 名
 *（Bash、Read、Write 等），后者可以安全记录。
 *
 * @param toolName - 需脱敏的 tool 名
 * @returns 内置 tool 返回原名，MCP tool 返回 'mcp_tool'
 */
export function sanitizeToolNameForAnalytics(
  toolName: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  if (toolName.startsWith('mcp__')) {
    return 'mcp_tool' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  }
  return toolName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * 检查是否为 OTLP 事件启用了详细 tool 名日志。
 * 启用时会记录 MCP server/tool 名和 Skill 名。
 * 默认禁用以保护 PII（用户特定的 server 配置）。
 *
 * 通过 OTEL_LOG_TOOL_DETAILS=1 启用
 */
export function isToolDetailsLoggingEnabled(): boolean {
  return isEnvTruthy(process.env.OTEL_LOG_TOOL_DETAILS)
}

/**
 * 检查是否为 analytics 事件启用了详细 tool 名日志
 *（MCP server/tool 名）。
 *
 * 按 go/taxonomy，MCP 名属于 medium PII。我们在以下情况记录它们：
 * - Cowork（entrypoint=local-agent）——无 ZDR 概念，记录所有 MCP
 * - claude.ai 代理的 connector——始终是 official（来自 claude.ai 的列表）
 * - URL 匹配 official MCP registry 的 server——通过 `claude mcp add` 添加的
 *   目录 connector，而非客户特定配置
 *
 * 自定义/用户配置的 MCP 保持脱敏（toolName='mcp_tool'）。
 */
export function isAnalyticsToolDetailsLoggingEnabled(
  mcpServerType: string | undefined,
  mcpServerBaseUrl: string | undefined,
): boolean {
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'local-agent') {
    return true
  }
  if (mcpServerType === 'claudeai-proxy') {
    return true
  }
  if (mcpServerBaseUrl && isOfficialMcpUrl(mcpServerBaseUrl)) {
    return true
  }
  return false
}

/**
 * 内置的第一方 MCP server，其名称是固定的保留字符串，非用户配置——
 * 因此记录它们不算 PII。在 isAnalyticsToolDetailsLoggingEnabled 的
 * transport/URL 闸门之外额外检查此项，否则 stdio 内置 server 会无法通过。
 *
 * 受 feature gate 控制：feature 关闭时该集合为空。名称保留
 *（main.tsx、config.ts addMcpServer）本身也是 feature-gated 的，
 * 因此在没有该 feature 的构建中，用户可以配置 'computer-use'。
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const BUILTIN_MCP_SERVER_NAMES: ReadonlySet<string> = new Set(
  feature('CHICAGO_MCP')
    ? [
        (
          require('../../utils/computerUse/common.js') as typeof import('../../utils/computerUse/common.js')
        ).COMPUTER_USE_MCP_SERVER_NAME,
      ]
    : [],
)
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 用于 logEvent payload 的可展开 helper——闸门通过时返回
 * {mcpServerName, mcpToolName}，否则返回空对象。
 * 合并了每个 tengu_tool_use_* 调用点处相同的 IIFE 模式。
 */
export function mcpToolDetailsForAnalytics(
  toolName: string,
  mcpServerType: string | undefined,
  mcpServerBaseUrl: string | undefined,
): {
  mcpServerName?: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  mcpToolName?: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
} {
  const details = extractMcpToolDetails(toolName)
  if (!details) {
    return {}
  }
  if (
    !BUILTIN_MCP_SERVER_NAMES.has(details.serverName) &&
    !isAnalyticsToolDetailsLoggingEnabled(mcpServerType, mcpServerBaseUrl)
  ) {
    return {}
  }
  return {
    mcpServerName: details.serverName,
    mcpToolName: details.mcpToolName,
  }
}

/**
 * 从完整的 MCP tool 名中提取 server 名和 tool 名。
 * MCP tool 名遵循格式：mcp__<server>__<tool>
 *
 * @param toolName - 完整的 tool 名（如 'mcp__slack__read_channel'）
 * @returns 包含 serverName 和 toolName 的对象；若非 MCP tool 则返回 undefined
 */
export function extractMcpToolDetails(toolName: string):
  | {
      serverName: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      mcpToolName: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    }
  | undefined {
  if (!toolName.startsWith('mcp__')) {
    return undefined
  }

  // 格式：mcp__<server>__<tool>
  const parts = toolName.split('__')
  if (parts.length < 3) {
    return undefined
  }

  const serverName = parts[1]
  // tool 名可能包含 __，因此重新拼接剩余部分
  const mcpToolName = parts.slice(2).join('__')

  if (!serverName || !mcpToolName) {
    return undefined
  }

  return {
    serverName:
      serverName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    mcpToolName:
      mcpToolName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  }
}

/**
 * 从 Skill tool 的 input 中提取 skill 名。
 *
 * @param toolName - tool 名（应为 'Skill'）
 * @param input - 包含 skill 名的 tool input
 * @returns 若为 Skill tool 调用则返回 skill 名，否则返回 undefined
 */
export function extractSkillName(
  toolName: string,
  input: unknown,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS | undefined {
  if (toolName !== 'Skill') {
    return undefined
  }

  if (
    typeof input === 'object' &&
    input !== null &&
    'skill' in input &&
    typeof (input as { skill: unknown }).skill === 'string'
  ) {
    return (input as { skill: string })
      .skill as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  }

  return undefined
}

const TOOL_INPUT_STRING_TRUNCATE_AT = 512
const TOOL_INPUT_STRING_TRUNCATE_TO = 128
const TOOL_INPUT_MAX_JSON_CHARS = 4 * 1024
const TOOL_INPUT_MAX_COLLECTION_ITEMS = 20
const TOOL_INPUT_MAX_DEPTH = 2

function truncateToolInputValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    if (value.length > TOOL_INPUT_STRING_TRUNCATE_AT) {
      return `${value.slice(0, TOOL_INPUT_STRING_TRUNCATE_TO)}…[${value.length} chars]`
    }
    return value
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null ||
    value === undefined
  ) {
    return value
  }
  if (depth >= TOOL_INPUT_MAX_DEPTH) {
    return '<nested>'
  }
  if (Array.isArray(value)) {
    const mapped = value
      .slice(0, TOOL_INPUT_MAX_COLLECTION_ITEMS)
      .map(v => truncateToolInputValue(v, depth + 1))
    if (value.length > TOOL_INPUT_MAX_COLLECTION_ITEMS) {
      mapped.push(`…[${value.length} items]`)
    }
    return mapped
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // 跳过内部标记 key（如 SedEditPermissionRequest 重新引入的
      // _simulatedSedEdit），以免泄露到 telemetry 中。
      .filter(([k]) => !k.startsWith('_'))
    const mapped = entries
      .slice(0, TOOL_INPUT_MAX_COLLECTION_ITEMS)
      .map(([k, v]) => [k, truncateToolInputValue(v, depth + 1)])
    if (entries.length > TOOL_INPUT_MAX_COLLECTION_ITEMS) {
      mapped.push(['…', `${entries.length} keys`])
    }
    return Object.fromEntries(mapped)
  }
  return String(value)
}

/**
 * 为 OTel tool_result 事件序列化某个 tool 的 input 参数。
 * 截断长字符串和深层嵌套，使输出有界，同时保留具有取证价值的字段
 *（如文件路径、URL、MCP args）。
 * 当未启用 OTEL_LOG_TOOL_DETAILS 时返回 undefined。
 */
export function extractToolInputForTelemetry(
  input: unknown,
): string | undefined {
  if (!isToolDetailsLoggingEnabled()) {
    return undefined
  }
  const truncated = truncateToolInputValue(input)
  let json = jsonStringify(truncated)
  if (json.length > TOOL_INPUT_MAX_JSON_CHARS) {
    json = json.slice(0, TOOL_INPUT_MAX_JSON_CHARS) + '…[truncated]'
  }
  return json
}

/**
 * 允许记录的文件扩展名最大长度。
 * 超过此长度的扩展名被视为可能敏感
 *（如基于哈希的文件名 "key-hash-abcd-123-456"），
 * 将被替换为 'other'。
 */
const MAX_FILE_EXTENSION_LENGTH = 10

/**
 * 为 analytics 日志提取并脱敏文件扩展名。
 *
 * 使用 Node 的 path.extname 实现可靠的跨平台扩展名提取。
 * 超过 MAX_FILE_EXTENSION_LENGTH 的扩展名返回 'other'，以避免记录
 * 可能敏感的数据（如基于哈希的文件名）。
 *
 * @param filePath - 用于提取扩展名的文件路径
 * @returns 脱敏后的扩展名；过长则返回 'other'；无扩展名则返回 undefined
 */
export function getFileExtensionForAnalytics(
  filePath: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS | undefined {
  const ext = extname(filePath).toLowerCase()
  if (!ext || ext === '.') {
    return undefined
  }

  const extension = ext.slice(1) // remove leading dot
  if (extension.length > MAX_FILE_EXTENSION_LENGTH) {
    return 'other' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  }

  return extension as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/** 允许从中提取文件扩展名的 command 白名单。 */
const FILE_COMMANDS = new Set([
  'rm',
  'mv',
  'cp',
  'touch',
  'mkdir',
  'chmod',
  'chown',
  'cat',
  'head',
  'tail',
  'sort',
  'stat',
  'diff',
  'wc',
  'grep',
  'rg',
  'sed',
])

/** 在复合操作符（&&、||、;、|）处拆分 bash command 的正则。 */
const COMPOUND_OPERATOR_REGEX = /\s*(?:&&|\|\||[;|])\s*/

/** 在空白字符处拆分的正则。 */
const WHITESPACE_REGEX = /\s+/

/**
 * 从 bash command 中为 analytics 提取文件扩展名。
 * 尽力而为：在操作符和空白字符处拆分，从允许的 command 的非 flag 参数中
 * 提取扩展名。无需复杂的 shell 解析，因为 grep 模式和 sed 脚本很少形似文件扩展名。
 */
export function getFileExtensionsFromBashCommand(
  command: string,
  simulatedSedEditFilePath?: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS | undefined {
  if (!command.includes('.') && !simulatedSedEditFilePath) return undefined

  let result: string | undefined
  const seen = new Set<string>()

  if (simulatedSedEditFilePath) {
    const ext = getFileExtensionForAnalytics(simulatedSedEditFilePath)
    if (ext) {
      seen.add(ext)
      result = ext
    }
  }

  for (const subcmd of command.split(COMPOUND_OPERATOR_REGEX)) {
    if (!subcmd) continue
    const tokens = subcmd.split(WHITESPACE_REGEX)
    if (tokens.length < 2) continue

    const firstToken = tokens[0]!
    const slashIdx = firstToken.lastIndexOf('/')
    const baseCmd = slashIdx >= 0 ? firstToken.slice(slashIdx + 1) : firstToken
    if (!FILE_COMMANDS.has(baseCmd)) continue

    for (let i = 1; i < tokens.length; i++) {
      const arg = tokens[i]!
      if (arg.charCodeAt(0) === 45 /* - */) continue
      const ext = getFileExtensionForAnalytics(arg)
      if (ext && !seen.has(ext)) {
        seen.add(ext)
        result = result ? result + ',' + ext : ext
      }
    }
  }

  if (!result) return undefined
  return result as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * 环境上下文 metadata
 */
export type EnvContext = {
  platform: string
  platformRaw: string
  arch: string
  nodeVersion: string
  terminal: string | null
  packageManagers: string
  runtimes: string
  isRunningWithBun: boolean
  isCi: boolean
  isClaubbit: boolean
  isClaudeCodeRemote: boolean
  isLocalAgentMode: boolean
  isConductor: boolean
  remoteEnvironmentType?: string
  coworkerType?: string
  claudeCodeContainerId?: string
  claudeCodeRemoteSessionId?: string
  tags?: string
  isGithubAction: boolean
  isClaudeCodeAction: boolean
  isClaudeAiAuth: boolean
  version: string
  versionBase?: string
  buildTime: string
  deploymentEnvironment: string
  githubEventName?: string
  githubActionsRunnerEnvironment?: string
  githubActionsRunnerOs?: string
  githubActionRef?: string
  wslVersion?: string
  linuxDistroId?: string
  linuxDistroVersion?: string
  linuxKernel?: string
  vcs?: string
}

/**
 * 随所有 analytics 事件附带的进程指标。
 */
export type ProcessMetrics = {
  uptime: number
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
  arrayBuffers: number
  constrainedMemory: number | undefined
  cpuUsage: NodeJS.CpuUsage
  cpuPercent: number | undefined
}

/**
 * 所有 analytics 系统共享的核心事件 metadata
 */
export type EventMetadata = {
  model: string
  sessionId: string
  userType: string
  betas?: string
  envContext: EnvContext
  entrypoint?: string
  agentSdkVersion?: string
  isInteractive: string
  clientType: string
  processMetrics?: ProcessMetrics
  sweBenchRunId: string
  sweBenchInstanceId: string
  sweBenchTaskId: string
  // 用于 analytics 归因的 Swarm/team agent 标识
  agentId?: string // CLAUDE_CODE_AGENT_ID（格式：agentName@teamName）或 subagent UUID
  parentSessionId?: string // CLAUDE_CODE_PARENT_SESSION_ID（team lead 的 session）
  agentType?: 'teammate' | 'subagent' | 'standalone' // 区分 swarm teammate、Agent tool subagent 和 standalone agent
  teamName?: string // swarm agent 的 team 名（来自 env var 或 AsyncLocalStorage）
  subscriptionType?: string // OAuth 订阅档位（max、pro、enterprise、team）
  rh?: string // 哈希后的 repo remote URL（SHA256 前 16 字符），用于与服务端数据 join
  kairosActive?: true // KAIROS assistant 模式启用（仅 ant；在 main.tsx 通过 gate 检查后设置）
  skillMode?: 'discovery' | 'coach' | 'discovery_and_coach' // 受 gate 控制的 skill 呈现机制（仅 ant；用于 BQ session 分段）
  observerMode?: 'backseat' | 'skillcoach' | 'both' // 受 gate 控制的 observer 分类器（仅 ant；用于 tengu_backseat_* 事件的 BQ 分组）
}

/**
 * enrich 事件 metadata 的选项
 */
export type EnrichMetadataOptions = {
  // 使用的 model；未提供时回退到 getMainLoopModel()
  model?: unknown
  // 显式的 betas 字符串（已拼接）
  betas?: unknown
  // 要包含的额外 metadata（可选）
  additionalMetadata?: Record<string, unknown>
}

/**
 * 获取用于 analytics 的 agent 标识。
 * 优先级：AsyncLocalStorage 上下文（subagent）> env var（swarm teammate）
 */
function getAgentIdentification(): {
  agentId?: string
  parentSessionId?: string
  agentType?: 'teammate' | 'subagent' | 'standalone'
  teamName?: string
} {
  // 先检查 AsyncLocalStorage（针对同一进程内运行的 subagent）
  const agentContext = getAgentContext()
  if (agentContext) {
    const result: ReturnType<typeof getAgentIdentification> = {
      agentId: agentContext.agentId,
      parentSessionId: agentContext.parentSessionId,
      agentType: agentContext.agentType,
    }
    if (agentContext.agentType === 'teammate') {
      result.teamName = agentContext.teamName
    }
    return result
  }

  // 回退到 swarm helper（针对 swarm agent）
  const agentId = getAgentId()
  const parentSessionId = getTeammateParentSessionId()
  const teamName = getTeamName()
  const isSwarmAgent = isTeammate()
  // 对 standalone agent（有 agent ID 但不是 teammate），将 agentType 设为 'standalone'
  const agentType = isSwarmAgent
    ? ('teammate' as const)
    : agentId
      ? ('standalone' as const)
      : undefined
  if (agentId || agentType || parentSessionId || teamName) {
    return {
      ...(agentId ? { agentId } : {}),
      ...(agentType ? { agentType } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(teamName ? { teamName } : {}),
    }
  }

  // 检查 bootstrap state 中的 parent session ID（如 plan 模式 -> 实现）
  const stateParentSessionId = getParentSessionIdFromState()
  if (stateParentSessionId) {
    return { parentSessionId: stateParentSessionId }
  }

  return {}
}

/**
 * 从完整版本字符串中提取 base 版本。"2.0.36-dev.20251107.t174150.sha2709699" → "2.0.36-dev"
 */
const getVersionBase = memoize((): string | undefined => {
  const match = MACRO.VERSION.match(/^\d+\.\d+\.\d+(?:-[a-z]+)?/)
  return match ? match[0] : undefined
})

/**
 * 构建环境上下文对象
 */
const buildEnvContext = memoize(async (): Promise<EnvContext> => {
  const [packageManagers, runtimes, linuxDistroInfo, vcs] = await Promise.all([
    env.getPackageManagers(),
    env.getRuntimes(),
    getLinuxDistroInfo(),
    detectVcs(),
  ])

  return {
    platform: getHostPlatformForAnalytics(),
    // 原始的 process.platform，使 freebsd/openbsd/aix/sunos 在 BQ 中可见。
    // getHostPlatformForAnalytics() 会将它们归入 'linux'；这里我们要真实值。
    // CLAUDE_CODE_HOST_PLATFORM 仍会为 container/remote 覆盖此值。
    platformRaw: process.env.CLAUDE_CODE_HOST_PLATFORM || process.platform,
    arch: env.arch,
    nodeVersion: env.nodeVersion,
    terminal: envDynamic.terminal,
    packageManagers: packageManagers.join(','),
    runtimes: runtimes.join(','),
    isRunningWithBun: env.isRunningWithBun(),
    isCi: isEnvTruthy(process.env.CI),
    isClaubbit: isEnvTruthy(process.env.CLAUBBIT),
    isClaudeCodeRemote: isEnvTruthy(process.env.CLAUDE_CODE_REMOTE),
    isLocalAgentMode: process.env.CLAUDE_CODE_ENTRYPOINT === 'local-agent',
    isConductor: env.isConductor(),
    ...(process.env.CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE && {
      remoteEnvironmentType: process.env.CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE,
    }),
    // 受 feature gate 控制，以防止在外部构建中泄露 "coworkerType" 字符串
    ...(feature('COWORKER_TYPE_TELEMETRY')
      ? process.env.CLAUDE_CODE_COWORKER_TYPE
        ? { coworkerType: process.env.CLAUDE_CODE_COWORKER_TYPE }
        : {}
      : {}),
    ...(process.env.CLAUDE_CODE_CONTAINER_ID && {
      claudeCodeContainerId: process.env.CLAUDE_CODE_CONTAINER_ID,
    }),
    ...(process.env.CLAUDE_CODE_REMOTE_SESSION_ID && {
      claudeCodeRemoteSessionId: process.env.CLAUDE_CODE_REMOTE_SESSION_ID,
    }),
    ...(process.env.CLAUDE_CODE_TAGS && {
      tags: process.env.CLAUDE_CODE_TAGS,
    }),
    isGithubAction: isEnvTruthy(process.env.GITHUB_ACTIONS),
    isClaudeCodeAction: isEnvTruthy(process.env.CLAUDE_CODE_ACTION),
    isClaudeAiAuth: isClaudeAISubscriber(),
    version: MACRO.VERSION,
    versionBase: getVersionBase(),
    buildTime: MACRO.BUILD_TIME,
    deploymentEnvironment: env.detectDeploymentEnvironment(),
    ...(isEnvTruthy(process.env.GITHUB_ACTIONS) && {
      githubEventName: process.env.GITHUB_EVENT_NAME,
      githubActionsRunnerEnvironment: process.env.RUNNER_ENVIRONMENT,
      githubActionsRunnerOs: process.env.RUNNER_OS,
      githubActionRef: process.env.GITHUB_ACTION_PATH?.includes(
        'claude-code-action/',
      )
        ? process.env.GITHUB_ACTION_PATH.split('claude-code-action/')[1]
        : undefined,
    }),
    ...(getWslVersion() && { wslVersion: getWslVersion() }),
    ...(linuxDistroInfo ?? {}),
    ...(vcs.length > 0 ? { vcs: vcs.join(',') } : {}),
  }
})

// --
// CPU% delta 追踪——本质上是进程全局的，与 datadog.ts 中 logBatch/flushTimer 模式相同
let prevCpuUsage: NodeJS.CpuUsage | null = null
let prevWallTimeMs: number | null = null

/**
 * 为所有用户构建进程指标对象。
 */
function buildProcessMetrics(): ProcessMetrics | undefined {
  try {
    const mem = process.memoryUsage()
    const cpu = process.cpuUsage()
    const now = Date.now()

    let cpuPercent: number | undefined
    if (prevCpuUsage && prevWallTimeMs) {
      const wallDeltaMs = now - prevWallTimeMs
      if (wallDeltaMs > 0) {
        const userDeltaUs = cpu.user - prevCpuUsage.user
        const systemDeltaUs = cpu.system - prevCpuUsage.system
        cpuPercent =
          ((userDeltaUs + systemDeltaUs) / (wallDeltaMs * 1000)) * 100
      }
    }
    prevCpuUsage = cpu
    prevWallTimeMs = now

    return {
      uptime: process.uptime(),
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      constrainedMemory: process.constrainedMemory(),
      cpuUsage: cpu,
      cpuPercent,
    }
  } catch {
    return undefined
  }
}

/**
 * 获取所有 analytics 系统共享的核心事件 metadata。
 *
 * 本函数收集应随所有 analytics 事件附带的环境、运行时和上下文信息。
 *
 * @param options - 配置选项
 * @returns 解析为 enrich 后的 metadata 对象的 Promise
 */
export async function getEventMetadata(
  options: EnrichMetadataOptions = {},
): Promise<EventMetadata> {
  const model = options.model ? String(options.model) : getMainLoopModel()
  const betas =
    typeof options.betas === 'string'
      ? options.betas
      : getModelBetas(model).join(',')
  const [envContext, repoRemoteHash] = await Promise.all([
    buildEnvContext(),
    getRepoRemoteHash(),
  ])
  const processMetrics = buildProcessMetrics()

  const metadata: EventMetadata = {
    model,
    sessionId: getSessionId(),
    userType: process.env.USER_TYPE || '',
    ...(betas.length > 0 ? { betas: betas } : {}),
    envContext,
    ...(process.env.CLAUDE_CODE_ENTRYPOINT && {
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
    }),
    ...(process.env.CLAUDE_AGENT_SDK_VERSION && {
      agentSdkVersion: process.env.CLAUDE_AGENT_SDK_VERSION,
    }),
    isInteractive: String(getIsInteractive()),
    clientType: getClientType(),
    ...(processMetrics && { processMetrics }),
    sweBenchRunId: process.env.SWE_BENCH_RUN_ID || '',
    sweBenchInstanceId: process.env.SWE_BENCH_INSTANCE_ID || '',
    sweBenchTaskId: process.env.SWE_BENCH_TASK_ID || '',
    // Swarm/team agent 标识
    // 优先级：AsyncLocalStorage 上下文（subagent）> env var（swarm teammate）
    ...getAgentIdentification(),
    // 订阅档位，用于按档位统计 DAU 的 analytics
    ...(getSubscriptionType() && {
      subscriptionType: getSubscriptionType()!,
    }),
    // Assistant 模式标签——位于 memoized 的 buildEnvContext() 之外，因为
    // setKairosActive() 在 main.tsx:~1648 执行，可能在首个事件已触发并
    // memoize 了 env 之后。因此改为每个事件重新读取。
    ...(feature('KAIROS') && getKairosActive()
      ? { kairosActive: true as const }
      : {}),
    // repo remote 哈希，用于与服务端 repo bundle 数据 join
    ...(repoRemoteHash && { rh: repoRemoteHash }),
  }

  return metadata
}

/**
 * 用于 1P event logging 的核心事件 metadata（snake_case 格式）。
 */
export type FirstPartyEventLoggingCoreMetadata = {
  session_id: string
  model: string
  user_type: string
  betas?: string
  entrypoint?: string
  agent_sdk_version?: string
  is_interactive: boolean
  client_type: string
  swe_bench_run_id?: string
  swe_bench_instance_id?: string
  swe_bench_task_id?: string
  // Swarm/team agent 标识
  agent_id?: string
  parent_session_id?: string
  agent_type?: 'teammate' | 'subagent' | 'standalone'
  team_name?: string
}

/**
 * 1P 事件的完整 event logging metadata 格式。
 */
export type FirstPartyEventLoggingMetadata = {
  env: EnvironmentMetadata
  process?: string
  // auth 是 ClaudeCodeInternalEvent 的顶层字段（proto PublicApiAuth）。
  // 故意省略 account_id——客户端只填充 UUID 字段。
  auth?: PublicApiAuth
  // core 字段对应 ClaudeCodeInternalEvent 的顶层。
  // 它们会被直接导出到 BigQuery 表中各自的列。
  core: FirstPartyEventLoggingCoreMetadata
  // additional 字段填入 ClaudeCodeInternalEvent proto 的 additional_metadata 字段。
  // 包括但不限于随事件类型而异的信息。
  additional: Record<string, unknown>
}

/**
 * 将 metadata 转换为 1P event logging 格式（snake_case 字段）。
 *
 * /api/event_logging/batch endpoint 期望环境与核心 metadata
 * 使用 snake_case 字段名。
 *
 * @param metadata - 核心事件 metadata
 * @param additionalMetadata - 要包含的额外 metadata
 * @returns 已格式化为 1P event logging 的 metadata
 */
export function to1PEventFormat(
  metadata: EventMetadata,
  userMetadata: CoreUserData,
  additionalMetadata: Record<string, unknown> = {},
): FirstPartyEventLoggingMetadata {
  const {
    envContext,
    processMetrics,
    rh,
    kairosActive,
    skillMode,
    observerMode,
    ...coreFields
  } = metadata

  // 将 envContext 转换为 snake_case。
  // 重要：env 的类型为 proto 生成的 EnvironmentMetadata，这样在此处添加一个
  // proto 未定义的字段会触发编译错误。生成的 toJSON() 序列化器会静默丢弃未知 key——
  // 此前手写的平行类型曾让 #11318、#13924、#19448 和 coworker_type 这些
  // 字段都发布了却从未到达 BQ。
  // 要添加字段？先更新 monorepo proto（go/cc-logging）：
  //   event_schemas/.../claude_code/v1/claude_code_internal_event.proto
  // 然后在这里运行 `bun run generate:proto`。
  const env: EnvironmentMetadata = {
    platform: envContext.platform,
    platform_raw: envContext.platformRaw,
    arch: envContext.arch,
    node_version: envContext.nodeVersion,
    terminal: envContext.terminal || 'unknown',
    package_managers: envContext.packageManagers,
    runtimes: envContext.runtimes,
    is_running_with_bun: envContext.isRunningWithBun,
    is_ci: envContext.isCi,
    is_claubbit: envContext.isClaubbit,
    is_claude_code_remote: envContext.isClaudeCodeRemote,
    is_local_agent_mode: envContext.isLocalAgentMode,
    is_conductor: envContext.isConductor,
    is_github_action: envContext.isGithubAction,
    is_claude_code_action: envContext.isClaudeCodeAction,
    is_claude_ai_auth: envContext.isClaudeAiAuth,
    version: envContext.version,
    build_time: envContext.buildTime,
    deployment_environment: envContext.deploymentEnvironment,
  }

  // 添加可选的 env 字段
  if (envContext.remoteEnvironmentType) {
    env.remote_environment_type = envContext.remoteEnvironmentType
  }
  if (feature('COWORKER_TYPE_TELEMETRY') && envContext.coworkerType) {
    env.coworker_type = envContext.coworkerType
  }
  if (envContext.claudeCodeContainerId) {
    env.claude_code_container_id = envContext.claudeCodeContainerId
  }
  if (envContext.claudeCodeRemoteSessionId) {
    env.claude_code_remote_session_id = envContext.claudeCodeRemoteSessionId
  }
  if (envContext.tags) {
    env.tags = envContext.tags
      .split(',')
      .map(t => t.trim())
      .filter(Boolean)
  }
  if (envContext.githubEventName) {
    env.github_event_name = envContext.githubEventName
  }
  if (envContext.githubActionsRunnerEnvironment) {
    env.github_actions_runner_environment =
      envContext.githubActionsRunnerEnvironment
  }
  if (envContext.githubActionsRunnerOs) {
    env.github_actions_runner_os = envContext.githubActionsRunnerOs
  }
  if (envContext.githubActionRef) {
    env.github_action_ref = envContext.githubActionRef
  }
  if (envContext.wslVersion) {
    env.wsl_version = envContext.wslVersion
  }
  if (envContext.linuxDistroId) {
    env.linux_distro_id = envContext.linuxDistroId
  }
  if (envContext.linuxDistroVersion) {
    env.linux_distro_version = envContext.linuxDistroVersion
  }
  if (envContext.linuxKernel) {
    env.linux_kernel = envContext.linuxKernel
  }
  if (envContext.vcs) {
    env.vcs = envContext.vcs
  }
  if (envContext.versionBase) {
    env.version_base = envContext.versionBase
  }

  // 将 core 字段转换为 snake_case
  const core: FirstPartyEventLoggingCoreMetadata = {
    session_id: coreFields.sessionId,
    model: coreFields.model,
    user_type: coreFields.userType,
    is_interactive: coreFields.isInteractive === 'true',
    client_type: coreFields.clientType,
  }

  // 添加其他 core 字段
  if (coreFields.betas) {
    core.betas = coreFields.betas
  }
  if (coreFields.entrypoint) {
    core.entrypoint = coreFields.entrypoint
  }
  if (coreFields.agentSdkVersion) {
    core.agent_sdk_version = coreFields.agentSdkVersion
  }
  if (coreFields.sweBenchRunId) {
    core.swe_bench_run_id = coreFields.sweBenchRunId
  }
  if (coreFields.sweBenchInstanceId) {
    core.swe_bench_instance_id = coreFields.sweBenchInstanceId
  }
  if (coreFields.sweBenchTaskId) {
    core.swe_bench_task_id = coreFields.sweBenchTaskId
  }
  // Swarm/team agent identification
  if (coreFields.agentId) {
    core.agent_id = coreFields.agentId
  }
  if (coreFields.parentSessionId) {
    core.parent_session_id = coreFields.parentSessionId
  }
  if (coreFields.agentType) {
    core.agent_type = coreFields.agentType
  }
  if (coreFields.teamName) {
    core.team_name = coreFields.teamName
  }

  // 将 userMetadata 映射到输出字段。
  // 基于 src/utils/user.ts 的 getUser()，但去重了 ClaudeCodeInternalEvent
  // 其他部分已存在的字段。
  // 将 camelCase 的 GitHubActionsMetadata 转换为 snake_case 以适配 1P API
  // 注意：github_actions_metadata 放在 env（EnvironmentMetadata）内部，
  // 而非 ClaudeCodeInternalEvent 的顶层
  if (userMetadata.githubActionsMetadata) {
    const ghMeta = userMetadata.githubActionsMetadata
    env.github_actions_metadata = {
      actor_id: ghMeta.actorId,
      repository_id: ghMeta.repositoryId,
      repository_owner_id: ghMeta.repositoryOwnerId,
    }
  }

  let auth: PublicApiAuth | undefined
  if (userMetadata.accountUuid || userMetadata.organizationUuid) {
    auth = {
      account_uuid: userMetadata.accountUuid,
      organization_uuid: userMetadata.organizationUuid,
    }
  }

  return {
    env,
    ...(processMetrics && {
      process: Buffer.from(jsonStringify(processMetrics)).toString('base64'),
    }),
    ...(auth && { auth }),
    core,
    additional: {
      ...(rh && { rh }),
      ...(kairosActive && { is_assistant_mode: true }),
      ...(skillMode && { skill_mode: skillMode }),
      ...(observerMode && { observer_mode: observerMode }),
      ...additionalMetadata,
    },
  }
}
