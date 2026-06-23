// biome-ignore-all assist/source/organizeImports: ANT-ONLY 的 import 标记不可被重排序
import addDir from './commands/add-dir/index.js'
import autofixPr from './commands/autofix-pr/index.js'
import backfillSessions from './commands/backfill-sessions/index.js'
import btw from './commands/btw/index.js'
import goodClaude from './commands/good-claude/index.js'
import issue from './commands/issue/index.js'
import feedback from './commands/feedback/index.js'
import clear from './commands/clear/index.js'
import color from './commands/color/index.js'
import commit from './commands/commit.js'
import copy from './commands/copy/index.js'
import desktop from './commands/desktop/index.js'
import commitPushPr from './commands/commit-push-pr.js'
import compact from './commands/compact/index.js'
import config from './commands/config/index.js'
import { context, contextNonInteractive } from './commands/context/index.js'
// cost/index.ts 转导出 usage —— /cost 现在是 /usage 的别名
import diff from './commands/diff/index.js'
import doctor from './commands/doctor/index.js'
import memory from './commands/memory/index.js'
import mode from './commands/mode/index.js'
import help from './commands/help/index.js'
import ide from './commands/ide/index.js'
import init from './commands/init.js'
import initVerifiers from './commands/init-verifiers.js'
import keybindings from './commands/keybindings/index.js'
import lang from './commands/lang/index.js'
import login from './commands/login/index.js'
import logout from './commands/logout/index.js'
import installGitHubApp from './commands/install-github-app/index.js'
import installSlackApp from './commands/install-slack-app/index.js'
import breakCache, {
  breakCacheNonInteractive,
} from './commands/break-cache/index.js'
import mcp from './commands/mcp/index.js'
import mobile from './commands/mobile/index.js'
import onboarding from './commands/onboarding/index.js'
import pr_comments from './commands/pr_comments/index.js'
import releaseNotes from './commands/release-notes/index.js'
import rename from './commands/rename/index.js'
import resume from './commands/resume/index.js'
import review, { ultrareview } from './commands/review.js'
import session from './commands/session/index.js'
import share from './commands/share/index.js'
import skills from './commands/skills/index.js'
import status from './commands/status/index.js'
import tasks from './commands/tasks/index.js'
import teleport from './commands/teleport/index.js'
import agentsPlatform from './commands/agents-platform/index.js'
import scheduleCommand from './commands/schedule/index.js'
import memoryStoresCommand from './commands/memory-stores/index.js'
import skillStoreCommand from './commands/skill-store/index.js'
import vaultCommand from './commands/vault/index.js'
import localVaultCommand from './commands/local-vault/index.js'
import localMemoryCommand from './commands/local-memory/index.js'
import securityReview from './commands/security-review.js'
import bughunter from './commands/bughunter/index.js'
import terminalSetup from './commands/terminalSetup/index.js'
import usage from './commands/usage/index.js'
import theme from './commands/theme/index.js'
import vim from './commands/vim/index.js'
import webTools from './commands/web-tools/index.js'
import { feature } from 'bun:bundle'
// 死代码消除：条件 import
/* eslint-disable @typescript-eslint/no-require-imports */
const proactive =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('./commands/proactive.js').default
    : null
const briefCommand =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? require('./commands/brief.js').default
    : null
const assistantCommand = feature('KAIROS')
  ? require('./commands/assistant/index.js').default
  : null
const bridge = feature('BRIDGE_MODE')
  ? require('./commands/bridge/index.js').default
  : null
const remoteControlServerCommand = feature('BRIDGE_MODE')
  ? require('./commands/remoteControlServer/index.js').default
  : null
const voiceCommand = feature('VOICE_MODE')
  ? require('./commands/voice/index.js').default
  : null
const monitorCmd = feature('MONITOR_TOOL')
  ? require('./commands/monitor.js').default
  : null
const coordinatorCmd = feature('COORDINATOR_MODE')
  ? require('./commands/coordinator.js').default
  : null
const forceSnip = feature('HISTORY_SNIP')
  ? require('./commands/force-snip.js').default
  : null
const workflowsCmd = feature('WORKFLOW_SCRIPTS')
  ? (
      require('./commands/workflows/index.js') as typeof import('./commands/workflows/index.js')
    ).default
  : null
const webCmd = feature('CCR_REMOTE_SETUP')
  ? (
      require('./commands/remote-setup/index.js') as typeof import('./commands/remote-setup/index.js')
    ).default
  : null
const clearSkillIndexCache = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (
      require('./services/skillSearch/localSearch.js') as typeof import('./services/skillSearch/localSearch.js')
    ).clearSkillIndexCache
  : null
const subscribePr = feature('KAIROS_GITHUB_WEBHOOKS')
  ? require('./commands/subscribe-pr.js').default
  : null
const ultraplan = feature('ULTRAPLAN')
  ? require('./commands/ultraplan.js').default
  : null
const torch = feature('TORCH') ? require('./commands/torch.js').default : null
const daemonCmd =
  feature('DAEMON') || feature('BG_SESSIONS')
    ? require('./commands/daemon/index.js').default
    : null
const jobCmd = feature('TEMPLATES')
  ? require('./commands/job/index.js').default
  : null
const peersCmd = feature('UDS_INBOX')
  ? (
      require('./commands/peers/index.js') as typeof import('./commands/peers/index.js')
    ).default
  : null
const attachCmd = feature('UDS_INBOX')
  ? require('./commands/attach/index.js').default
  : null
const detachCmd = feature('UDS_INBOX')
  ? require('./commands/detach/index.js').default
  : null
const sendCmd = feature('UDS_INBOX')
  ? require('./commands/send/index.js').default
  : null
const pipesCmd = feature('UDS_INBOX')
  ? require('./commands/pipes/index.js').default
  : null
const pipeStatusCmd = feature('UDS_INBOX')
  ? require('./commands/pipe-status/index.js').default
  : null
const historyCmd = feature('UDS_INBOX')
  ? require('./commands/history/index.js').default
  : null
const claimMainCmd = feature('UDS_INBOX')
  ? require('./commands/claim-main/index.js').default
  : null
const forkCmd = feature('FORK_SUBAGENT')
  ? (
      require('./commands/fork/index.js') as typeof import('./commands/fork/index.js')
    ).default
  : null
const buddy = feature('BUDDY')
  ? (
      require('./commands/buddy/index.js') as typeof import('./commands/buddy/index.js')
    ).default
  : null
const poor = feature('POOR')
  ? (
      require('./commands/poor/index.js') as typeof import('./commands/poor/index.js')
    ).default
  : null
const goalCmd = feature('GOAL')
  ? (
      require('./commands/goal/index.js') as typeof import('./commands/goal/index.js')
    ).default
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import thinkback from './commands/thinkback/index.js'
import thinkbackPlay from './commands/thinkback-play/index.js'
import permissions from './commands/permissions/index.js'
import plan from './commands/plan/index.js'
import fast from './commands/fast/index.js'
import passes from './commands/passes/index.js'
import privacySettings from './commands/privacy-settings/index.js'
import hooks from './commands/hooks/index.js'
import files from './commands/files/index.js'
import branch from './commands/branch/index.js'
import agents from './commands/agents/index.js'
import plugin from './commands/plugin/index.js'
import reloadPlugins from './commands/reload-plugins/index.js'
import rewind from './commands/rewind/index.js'
import heapDump from './commands/heapdump/index.js'
import mockLimits from './commands/mock-limits/index.js'
import bridgeKick from './commands/bridge-kick.js'
import version from './commands/version.js'
import summary from './commands/summary/index.js'
import recap from './commands/recap/index.js'
import skillLearning from './commands/skill-learning/index.js'
import skillSearch from './commands/skill-search/index.js'
import {
  resetLimits,
  resetLimitsNonInteractive,
} from './commands/reset-limits/index.js'
import antTrace from './commands/ant-trace/index.js'
import perfIssue from './commands/perf-issue/index.js'
import sandboxToggle from './commands/sandbox-toggle/index.js'
import tui, { tuiNonInteractive } from './commands/tui/index.js'
import chrome from './commands/chrome/index.js'
import stickers from './commands/stickers/index.js'
import advisor from './commands/advisor.js'
import autonomy from './commands/autonomy.js'
import provider from './commands/provider.js'
import { logError } from './utils/log.js'
import { toError } from './utils/errors.js'
import { logForDebugging } from './utils/debug.js'
import {
  getSkillDirCommands,
  clearSkillCaches,
  getDynamicSkills,
} from './skills/loadSkillsDir.js'
import { getBundledSkills } from './skills/bundledSkills.js'
import { getBuiltinPluginSkillCommands } from './plugins/builtinPlugins.js'
import {
  getPluginCommands,
  clearPluginCommandCache,
  getPluginSkills,
  clearPluginSkillsCache,
} from './utils/plugins/loadPluginCommands.js'
import memoize from 'lodash-es/memoize.js'
import { isUsing3PServices, isClaudeAISubscriber } from './utils/auth.js'
import { isFirstPartyAnthropicBaseUrl } from './utils/model/providers.js'
import env from './commands/env/index.js'
import exit from './commands/exit/index.js'
import exportCommand from './commands/export/index.js'
import model from './commands/model/index.js'
import tag from './commands/tag/index.js'
import outputStyle from './commands/output-style/index.js'
import remoteEnv from './commands/remote-env/index.js'
import upgrade from './commands/upgrade/index.js'
import {
  extraUsage,
  extraUsageNonInteractive,
} from './commands/extra-usage/index.js'
import rateLimitOptions from './commands/rate-limit-options/index.js'
import statusline from './commands/statusline.js'
import effort from './commands/effort/index.js'
// stats/index.ts 转导出 usage —— /stats 现在是 /usage 的别名
// insights.ts 有 113KB（3200 行，含 diffLines/html 渲染）。此处的懒加载
// shim 将这个重型模块推迟到 /insights 真正被调用时才加载。
const usageReport: Command = {
  type: 'prompt',
  name: 'insights',
  description: 'Generate a report analyzing your Claude Code sessions',
  contentLength: 0,
  progressMessage: 'analyzing your sessions',
  source: 'builtin',
  async getPromptForCommand(args, context) {
    const real = (await import('./commands/insights.js')).default
    if (real.type !== 'prompt') throw new Error('unreachable')
    return real.getPromptForCommand(args, context)
  },
}
import oauthRefresh from './commands/oauth-refresh/index.js'
import debugToolCall from './commands/debug-tool-call/index.js'
import { getSettingSourceName } from './utils/settings/constants.js'
import {
  type Command,
  getCommandName,
  isCommandEnabled,
} from './types/command.js'

// 从集中位置转导出类型
export type {
  Command,
  CommandBase,
  CommandResultDisplay,
  LocalCommandResult,
  LocalJSXCommandContext,
  PromptCommand,
  ResumeEntrypoint,
} from './types/command.js'
export { getCommandName, isCommandEnabled } from './types/command.js'

// 在外部构建中被消除的命令
// 曾经被锁定但现已公开的命令已移到下方主 COMMANDS 数组中：
//   commit, commitPushPr, bridgeKick, initVerifiers, autofixPr, onboarding
// 这里剩下的项目是真正的 Anthropic 内部命令（admin/diagnostics 端点，
// 没有 fork 后端），因此它们只在 USER_TYPE=ant 下出现。
export const INTERNAL_ONLY_COMMANDS = [
  backfillSessions,
  bughunter,
  goodClaude,
  mockLimits,
  resetLimits,
  resetLimitsNonInteractive,
  antTrace,
  oauthRefresh,
].filter(Boolean)

// 以函数形式声明，这样直到 getCommands 被调用时才会执行，
// 因为底层函数会读取 config，而 config 在模块初始化时还不能读取
const COMMANDS = memoize((): Command[] => [
  addDir,
  advisor,
  agentsPlatform,
  scheduleCommand,
  memoryStoresCommand,
  skillStoreCommand,
  vaultCommand,
  localVaultCommand,
  localMemoryCommand,
  autonomy,
  provider,
  agents,
  branch,
  btw,
  chrome,
  clear,
  color,
  compact,
  config,
  copy,
  desktop,
  context,
  contextNonInteractive,
  diff,
  doctor,
  effort,
  exit,
  fast,
  files,
  heapDump,
  help,
  ide,
  init,
  keybindings,
  lang,
  installGitHubApp,
  installSlackApp,
  mcp,
  memory,
  mobile,
  mode,
  model,
  outputStyle,
  remoteEnv,
  plugin,
  pr_comments,
  releaseNotes,
  reloadPlugins,
  rename,
  resume,
  session,
  skills,
  status,
  statusline,
  stickers,
  tag,
  theme,
  feedback,
  review,
  ultrareview,
  rewind,
  securityReview,
  terminalSetup,
  upgrade,
  extraUsage,
  extraUsageNonInteractive,
  rateLimitOptions,
  usage,
  usageReport,
  vim,
  webTools,
  ...(webCmd ? [webCmd] : []),
  ...(forkCmd ? [forkCmd] : []),
  ...(buddy ? [buddy] : []),
  ...(poor ? [poor] : []),
  ...(goalCmd ? [goalCmd] : []),
  ...(proactive ? [proactive] : []),
  ...(monitorCmd ? [monitorCmd] : []),
  ...(coordinatorCmd ? [coordinatorCmd] : []),
  ...(briefCommand ? [briefCommand] : []),
  ...(assistantCommand ? [assistantCommand] : []),
  ...(bridge ? [bridge] : []),
  ...(remoteControlServerCommand ? [remoteControlServerCommand] : []),
  ...(voiceCommand ? [voiceCommand] : []),
  thinkback,
  thinkbackPlay,
  permissions,
  plan,
  privacySettings,
  hooks,
  exportCommand,
  sandboxToggle,
  ...(!isUsing3PServices() ? [logout, login()] : []),
  passes,
  ...(peersCmd ? [peersCmd] : []),
  ...(attachCmd ? [attachCmd] : []),
  ...(detachCmd ? [detachCmd] : []),
  ...(sendCmd ? [sendCmd] : []),
  ...(pipesCmd ? [pipesCmd] : []),
  ...(pipeStatusCmd ? [pipeStatusCmd] : []),
  ...(historyCmd ? [historyCmd] : []),
  ...(claimMainCmd ? [claimMainCmd] : []),
  tasks,
  ...(workflowsCmd ? [workflowsCmd] : []),
  ...(ultraplan ? [ultraplan] : []),
  ...(torch ? [torch] : []),
  ...(daemonCmd ? [daemonCmd] : []),
  ...(jobCmd ? [jobCmd] : []),
  ...(forceSnip ? [forceSnip] : []),
  summary,
  recap,
  skillLearning,
  skillSearch,
  autofixPr,
  commit,
  commitPushPr,
  bridgeKick,
  version,
  ...(subscribePr ? [subscribePr] : []),
  initVerifiers,
  env,
  debugToolCall,
  perfIssue,
  breakCache,
  breakCacheNonInteractive,
  issue,
  share,
  teleport,
  tui,
  tuiNonInteractive,
  onboarding,
  ...(process.env.USER_TYPE === 'ant' && !process.env.IS_DEMO
    ? INTERNAL_ONLY_COMMANDS
    : []),
])

export const builtInCommandNames = memoize(
  (): Set<string> =>
    new Set(COMMANDS().flatMap(_ => [_.name, ...(_.aliases ?? [])])),
)

async function getSkills(cwd: string): Promise<{
  skillDirCommands: Command[]
  pluginSkills: Command[]
  bundledSkills: Command[]
  builtinPluginSkills: Command[]
}> {
  logForDebugging(`[Hapii] getSkills 开始 cwd=${cwd}`, { level: 'info' })
  try {
    const [skillDirCommands, pluginSkills] = await Promise.all([
      getSkillDirCommands(cwd).catch(err => {
        logError(toError(err))
        logForDebugging('[Hapii] getSkillDirCommands 失败，降级为空数组', {
          level: 'warn',
        })
        return []
      }),
      getPluginSkills().catch(err => {
        logError(toError(err))
        logForDebugging('[Hapii] getPluginSkills 失败，降级为空数组', {
          level: 'warn',
        })
        return []
      }),
    ])
    // 打包的 skills 在启动时已同步注册
    const bundledSkills = getBundledSkills()
    // 内置插件 skills 来自已启用的内置插件
    const builtinPluginSkills = getBuiltinPluginSkillCommands()
    logForDebugging(
      `[Hapii] getSkills 完成 skillDir=${skillDirCommands.length} plugin=${pluginSkills.length} bundled=${bundledSkills.length} builtinPlugin=${builtinPluginSkills.length}`,
      { level: 'info' },
    )
    return {
      skillDirCommands,
      pluginSkills,
      bundledSkills,
      builtinPluginSkills,
    }
  } catch (err) {
    // 由于已在 Promise 层捕获，理论上永远不应走到这里，但保留防御性处理
    logError(toError(err))
    logForDebugging('[Hapii] getSkills 意外异常，返回全空结果', {
      level: 'error',
    })
    return {
      skillDirCommands: [],
      pluginSkills: [],
      bundledSkills: [],
      builtinPluginSkills: [],
    }
  }
}

/* eslint-disable @typescript-eslint/no-require-imports */
const getWorkflowCommands = feature('WORKFLOW_SCRIPTS')
  ? (
      require('./workflow/namedWorkflowCommands.js') as typeof import('./workflow/namedWorkflowCommands.js')
    ).getWorkflowCommands
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 根据命令声明的 `availability`（鉴权/provider 要求）进行过滤。
 * 没有 `availability` 字段的命令视为通用命令。
 * 此过滤在 `isEnabled()` 之前执行，以便 provider 受限的命令无论
 * feature flag 状态如何都会被隐藏。
 *
 * 不做 memoize —— 鉴权状态可能在会话过程中变化（例如 /login 之后），
 * 因此每次 getCommands() 调用都必须重新求值。
 */
export function meetsAvailabilityRequirement(cmd: Command): boolean {
  if (!cmd.availability || cmd.availability.length === 0) return true
  for (const a of cmd.availability) {
    switch (a) {
      case 'claude-ai':
        if (isClaudeAISubscriber()) return true
        break
      case 'console':
        // Console API key 用户 = 直接的 1P API 客户（非 3P，也非 claude.ai）。
        // 排除 3P（Bedrock/Vertex/Foundry）—— 他们未设置 ANTHROPIC_BASE_URL，
        // 以及通过自定义 base URL 走代理的 gateway 用户。
        if (
          !isClaudeAISubscriber() &&
          !isUsing3PServices() &&
          isFirstPartyAnthropicBaseUrl()
        )
          return true
        break
      default: {
        const _exhaustive: never = a
        void _exhaustive
        break
      }
    }
  }
  logForDebugging(
    `[Hapii] meetsAvailabilityRequirement cmd=/${cmd.name} availability=[${cmd.availability.join(',')}] → false(过滤掉)`,
  )
  return false
}

/**
 * 加载所有命令来源（skills、plugins、workflows）。按 cwd 做 memoize，
 * 因为加载开销较大（磁盘 I/O、动态 import）。
 */
const loadAllCommands = memoize(async (cwd: string): Promise<Command[]> => {
  logForDebugging(`[Hapii] loadAllCommands 开始 cwd=${cwd}`, { level: 'info' })
  const [
    { skillDirCommands, pluginSkills, bundledSkills, builtinPluginSkills },
    pluginCommands,
    workflowCommands,
  ] = await Promise.all([
    getSkills(cwd),
    getPluginCommands(),
    getWorkflowCommands ? getWorkflowCommands(cwd) : Promise.resolve([]),
  ])

  const result = [
    ...bundledSkills,
    ...builtinPluginSkills,
    ...skillDirCommands,
    ...(workflowCommands as Command[]),
    ...(pluginCommands as Command[]),
    ...pluginSkills,
    ...COMMANDS(),
  ]
  logForDebugging(
    `[Hapii] loadAllCommands 完成 total=${result.length} ` +
      `(bundled=${bundledSkills.length} builtinPlugin=${builtinPluginSkills.length} ` +
      `skillDir=${skillDirCommands.length} workflow=${(workflowCommands as Command[]).length} ` +
      `pluginCmd=${(pluginCommands as Command[]).length} pluginSkill=${pluginSkills.length} ` +
      `builtinCmd=${COMMANDS().length})`,
    { level: 'info' },
  )
  return result
})

/**
 * 返回当前用户可用的命令。昂贵的加载过程被 memoize，
 * 但 availability 和 isEnabled 检查每次都重新执行，
 * 以便鉴权变化（例如 /login）能立即生效。
 */
export async function getCommands(cwd: string): Promise<Command[]> {
  logForDebugging(`[Hapii] getCommands 开始 cwd=${cwd}`, { level: 'info' })
  const allCommands = await loadAllCommands(cwd)

  // 获取文件操作过程中动态发现的 skills
  const dynamicSkills = getDynamicSkills()
  logForDebugging(
    `[Hapii] getCommands allCommands=${allCommands.length} dynamicSkills=${dynamicSkills.length}`,
  )

  // 在不包含动态 skills 的情况下构建基础命令
  const baseCommands = allCommands.filter(
    _ => meetsAvailabilityRequirement(_) && isCommandEnabled(_),
  )
  logForDebugging(
    `[Hapii] getCommands baseCommands(after filter)=${baseCommands.length}`,
  )

  if (dynamicSkills.length === 0) {
    logForDebugging(
      `[Hapii] getCommands 返回(无动态 skills) total=${baseCommands.length}`,
      { level: 'info' },
    )
    return baseCommands
  }

  // 动态 skills 去重 —— 仅当尚未存在时才添加
  const baseCommandNames = new Set(baseCommands.map(c => c.name))
  const uniqueDynamicSkills = dynamicSkills.filter(
    s =>
      !baseCommandNames.has(s.name) &&
      meetsAvailabilityRequirement(s) &&
      isCommandEnabled(s),
  )

  if (uniqueDynamicSkills.length === 0) {
    logForDebugging(
      `[Hapii] getCommands 动态 skills 全部重复，跳过 total=${baseCommands.length}`,
    )
    return baseCommands
  }

  // 将动态 skills 插入到 plugin skills 之后、内置命令之前
  const builtInNames = new Set(COMMANDS().map(c => c.name))
  const insertIndex = baseCommands.findIndex(c => builtInNames.has(c.name))

  const result =
    insertIndex === -1
      ? [...baseCommands, ...uniqueDynamicSkills]
      : [
          ...baseCommands.slice(0, insertIndex),
          ...uniqueDynamicSkills,
          ...baseCommands.slice(insertIndex),
        ]
  logForDebugging(
    `[Hapii] getCommands 返回(含动态 skills) total=${result.length} ` +
      `uniqueDynamic=${uniqueDynamicSkills.length} insertIndex=${insertIndex}`,
    { level: 'info' },
  )
  return result
}

/**
 * 仅清除命令相关的 memoize 缓存，不清除 skill 缓存。
 * 当动态新增 skill 时用此函数作废已缓存的命令列表。
 */
export function clearCommandMemoizationCaches(): void {
  logForDebugging('[Hapii] clearCommandMemoizationCaches 清除命令缓存')
  loadAllCommands.cache?.clear?.()
  getSkillToolCommands.cache?.clear?.()
  getSlashCommandToolSkills.cache?.clear?.()
  // skillSearch/localSearch.ts 中的 getSkillIndex 是构建在
  // getSkillToolCommands/getCommands 之上的独立 memoize 层。只清除内层缓存
  // 对外层是无效的 —— lodash memoize 会直接返回外层缓存结果，
  // 根本不会走到被清除的内层。必须显式清除它。
  clearSkillIndexCache?.()
}

export function clearCommandsCache(): void {
  clearCommandMemoizationCaches()
  clearPluginCommandCache()
  clearPluginSkillsCache()
  clearSkillCaches()
}

/**
 * 从 AppState.mcp.commands 中过滤出由 MCP 提供的 skills
 *（prompt 类型、可被模型调用、从 MCP 加载）。它们游离于 getCommands() 之外，
 * 以便需要把 MCP skills 纳入 skill 索引的调用方可以单独传入。
 */
export function getMcpSkillCommands(
  mcpCommands: readonly Command[],
): readonly Command[] {
  if (feature('MCP_SKILLS')) {
    return mcpCommands.filter(
      cmd =>
        cmd.type === 'prompt' &&
        cmd.loadedFrom === 'mcp' &&
        !cmd.disableModelInvocation,
    )
  }
  return []
}

// SkillTool 展示模型可调用的所有 prompt 类型命令
// 既包括 skills（来自 /skills/）也包括 commands（来自 /commands/）
export const getSkillToolCommands = memoize(
  async (cwd: string): Promise<Command[]> => {
    logForDebugging(`[Hapii] getSkillToolCommands 开始 cwd=${cwd}`)
    const allCommands = await getCommands(cwd)
    const filtered = allCommands.filter(
      cmd =>
        cmd.type === 'prompt' &&
        !cmd.disableModelInvocation &&
        cmd.source !== 'builtin' &&
        // 始终包含来自 /skills/ 目录、bundled skills 以及遗留的 /commands/ 条目
        //（若 frontmatter 缺失，会从首行自动派生描述）。
        // Plugin/MCP 命令仍需显式提供 description 才会出现在列表中。
        (cmd.loadedFrom === 'bundled' ||
          cmd.loadedFrom === 'skills' ||
          cmd.loadedFrom === 'commands_DEPRECATED' ||
          cmd.hasUserSpecifiedDescription ||
          cmd.whenToUse),
    )
    logForDebugging(
      `[Hapii] getSkillToolCommands 完成 allCommands=${allCommands.length} → filtered=${filtered.length} ` +
        `(type=prompt && !disableModel && !builtin && 有描述/whenToUse)`,
      { level: 'info' },
    )
    return filtered
  },
)

// 过滤命令只保留 skills。Skills 是为模型提供专用能力的命令，
// 判定依据是 loadedFrom 为 'skills'、'plugin' 或 'bundled'，
// 或设置了 disableModelInvocation。
export const getSlashCommandToolSkills = memoize(
  async (cwd: string): Promise<Command[]> => {
    logForDebugging(`[Hapii] getSlashCommandToolSkills 开始 cwd=${cwd}`)
    try {
      const allCommands = await getCommands(cwd)
      const filtered = allCommands.filter(
        cmd =>
          cmd.type === 'prompt' &&
          cmd.source !== 'builtin' &&
          (cmd.hasUserSpecifiedDescription || cmd.whenToUse) &&
          (cmd.loadedFrom === 'skills' ||
            cmd.loadedFrom === 'plugin' ||
            cmd.loadedFrom === 'bundled' ||
            cmd.disableModelInvocation),
      )
      logForDebugging(
        `[Hapii] getSlashCommandToolSkills 完成 allCommands=${allCommands.length} → skills=${filtered.length}`,
        { level: 'info' },
      )
      return filtered
    } catch (error) {
      logError(toError(error))
      // 返回空数组而不是抛错 —— skills 不是关键路径
      // 这样可避免 skill 加载失败拖垮整个系统
      logForDebugging('[Hapii] getSlashCommandToolSkills 异常，返回空数组', {
        level: 'error',
      })
      return []
    }
  },
)

/**
 * 在 remote 模式（--remote）下可安全使用的命令。
 * 这些命令仅影响本地 TUI 状态，不依赖本地文件系统、
 * git、shell、IDE、MCP 或其他本地执行环境。
 *
 * 在两处使用：
 * 1. main.tsx 中 REPL 渲染前预过滤命令（防止与 CCR 初始化产生竞态）
 * 2. REPL 的 handleRemoteInit 中，在 CCR 过滤后保留这些 local-only 命令
 */
export const REMOTE_SAFE_COMMANDS: Set<Command> = new Set([
  session, // 显示 remote 会话的二维码 / URL
  exit, // 退出 TUI
  clear, // 清屏
  help, // 显示帮助
  theme, // 切换终端主题
  color, // 切换 agent 颜色
  vim, // 切换 vim 模式
  usage, // 显示会话成本、plan 使用量和活动统计（/cost 和 /stats 为别名）
  copy, // 复制最近一条消息
  btw, // 快速备注
  feedback, // 发送反馈
  plan, // 切换 plan 模式
  proactive, // 切换 proactive 模式
  keybindings, // 快捷键管理
  statusline, // 切换状态栏
  stickers, // 贴纸
  mobile, // 手机端二维码
])

/**
 * 类型为 'local' 且可以通过 Remote Control bridge 安全执行的内建命令。
 * 它们产生文本输出，会流式回传到 mobile/web 客户端，且没有终端专属副作用。
 *
 * 'local-jsx' 命令按类型被屏蔽（它们渲染 Ink UI），
 * 'prompt' 命令按类型被允许（它们展开为发给模型的文本）——
 * 此集合只对 'local' 命令进行 gate。
 *
 * 新增需要支持手机端调用的 'local' 命令时，请将其加入此处。默认是屏蔽。
 */
export const BRIDGE_SAFE_COMMANDS: Set<Command> = new Set(
  [
    compact, // 压缩上下文 —— 从手机端会话中途触发很有用
    clear, // 清空对话记录
    usage, // 显示会话成本（/cost 的别名）
    summary, // 总结对话
    releaseNotes, // 显示更新日志
    files, // 列出已跟踪文件
  ].filter((c): c is Command => c !== null),
)

/**
 * 判断一条 slash command 的输入是经 Remote Control bridge（mobile/web 客户端）
 * 抵达时，是否可以安全执行。
 *
 * PR #19134 曾一刀切屏蔽所有来自 bridge 入站的 slash command，因为
 * iOS 端的 `/model` 会弹出本地 Ink picker。此谓词以显式白名单方式放宽：
 * 'prompt' 命令（skills）展开为文本，天然安全；'local' 命令需要通过
 * BRIDGE_SAFE_COMMANDS 显式 opt-in；'local-jsx' 命令会渲染 Ink UI，保持屏蔽。
 */
export function isBridgeSafeCommand(cmd: Command): boolean {
  if (cmd.type === 'local-jsx') return cmd.bridgeSafe === true
  if (cmd.type === 'prompt') return true
  return cmd.bridgeSafe === true || BRIDGE_SAFE_COMMANDS.has(cmd)
}

export function getBridgeCommandSafety(
  cmd: Command,
  args: string,
): { ok: true } | { ok: false; reason?: string } {
  if (!isBridgeSafeCommand(cmd)) return { ok: false }
  const reason = cmd.getBridgeInvocationError?.(args)
  return reason ? { ok: false, reason } : { ok: true }
}

/**
 * 过滤命令，仅保留对 remote 模式安全的命令。
 * 用于在 --remote 模式下渲染 REPL 时预过滤命令，
 * 防止 local-only 命令在 CCR 初始化消息抵达前短暂可见。
 */
export function filterCommandsForRemoteMode(commands: Command[]): Command[] {
  return commands.filter(cmd => REMOTE_SAFE_COMMANDS.has(cmd))
}

export function findCommand(
  commandName: string,
  commands: Command[],
): Command | undefined {
  return commands.find(
    _ =>
      _.name === commandName ||
      getCommandName(_) === commandName ||
      _.aliases?.includes(commandName),
  )
}

export function hasCommand(commandName: string, commands: Command[]): boolean {
  return findCommand(commandName, commands) !== undefined
}

export function getCommand(commandName: string, commands: Command[]): Command {
  const command = findCommand(commandName, commands)
  if (!command) {
    throw ReferenceError(
      `Command ${commandName} not found. Available commands: ${commands
        .map(_ => {
          const name = getCommandName(_)
          return _.aliases ? `${name} (aliases: ${_.aliases.join(', ')})` : name
        })
        .sort((a, b) => a.localeCompare(b))
        .join(', ')}`,
    )
  }

  return command
}

/**
 * 为命令的 description 拼接来源标注，供面向用户的 UI 使用。
 * 在 typeahead、help 页面以及其他需要让用户看到命令来源的场景使用。
 *
 * 对于面向模型的 prompt（如 SkillTool），请直接使用 cmd.description。
 */
export function formatDescriptionWithSource(cmd: Command): string {
  if (cmd.type !== 'prompt') {
    return cmd.description
  }

  if (cmd.kind === 'workflow') {
    return `${cmd.description} (workflow)`
  }

  if (cmd.source === 'plugin') {
    const pluginName = cmd.pluginInfo?.pluginManifest.name
    if (pluginName) {
      return `(${pluginName}) ${cmd.description}`
    }
    return `${cmd.description} (plugin)`
  }

  if (cmd.source === 'builtin' || cmd.source === 'mcp') {
    return cmd.description
  }

  if (cmd.source === 'bundled') {
    return `${cmd.description} (bundled)`
  }

  return `${cmd.description} (${getSettingSourceName(cmd.source)})`
}
