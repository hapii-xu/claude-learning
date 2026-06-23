import { isRemoteManagedSettingsEligible } from '../services/remoteManagedSettings/syncCache.js'
import { clearCACertsCache } from './caCerts.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './envUtils.js'
import {
  isProviderManagedEnvVar,
  SAFE_ENV_VARS,
} from './managedEnvConstants.js'
import { clearMTLSCache } from './mtls.js'
import { clearProxyCache, configureGlobalAgents } from './proxy.js'
import { isSettingSourceEnabled } from './settings/constants.js'
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
} from './settings/settings.js'

/**
 * `claude ssh` 远程模式：ANTHROPIC_UNIX_SOCKET 通过 -R 转发的 socket 将认证路由到本地代理，
 * 启动器设置了一些占位认证环境变量，远程的 ~/.claude settings.env 不得覆盖它们（参见
 * isAnthropicAuthEnabled）。从所有来自 settings 的 env 对象中剥离这些变量。
 */
function withoutSSHTunnelVars(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env || !process.env.ANTHROPIC_UNIX_SOCKET) return env || {}
  const {
    ANTHROPIC_UNIX_SOCKET: _1,
    ANTHROPIC_BASE_URL: _2,
    ANTHROPIC_API_KEY: _3,
    ANTHROPIC_AUTH_TOKEN: _4,
    CLAUDE_CODE_OAUTH_TOKEN: _5,
    ...rest
  } = env
  return rest
}

/**
 * 当宿主机拥有推理路由控制权时（在 spawn env 中设置了
 * CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST），从 settings 来源的 env 中剥离
 * provider 选择 / 模型默认值变量，防止用户的 ~/.claude/settings.json 将请求
 * 重定向到非宿主机配置的 provider。
 */
function withoutHostManagedProviderVars(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env) return {}
  if (!isEnvTruthy(process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)) {
    return env
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!isProviderManagedEnvVar(key)) {
      out[key] = value
    }
  }
  return out
}

/**
 * 在任何 settings.env 被应用之前的 env key 快照——对于 CCD 而言，
 * 这些是桌面宿主机为编排子进程而设置的 key。
 * Settings 不得覆盖它们（OTEL_LOGS_EXPORTER=console 会破坏 stdio JSON-RPC 传输）。
 * 用户/项目 settings 后续添加的 key 不在此集合中，因此会话中途修改 settings.json 仍然生效。
 * 在首次调用 applySafeConfigEnvironmentVariables() 时懒加载捕获。
 */
let ccdSpawnEnvKeys: Set<string> | null | undefined

function withoutCcdSpawnEnvKeys(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env || !ccdSpawnEnvKeys) return env || {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!ccdSpawnEnvKeys.has(key)) out[key] = value
  }
  return out
}

/**
 * 组合应用于所有 settings 来源 env 对象的剥离过滤器。
 */
function filterSettingsEnv(
  env: Record<string, string> | undefined,
): Record<string, string> {
  return withoutCcdSpawnEnvKeys(
    withoutHostManagedProviderVars(withoutSSHTunnelVars(env)),
  )
}

/**
 * 可在信任对话框之前应用 env 变量的受信任 setting 来源。
 *
 * - userSettings (~/.claude/settings.json)：由用户控制，非项目专属
 * - flagSettings (--settings CLI 参数或 SDK 内联 settings)：由用户显式传入
 * - policySettings（来自企业 API 或本地 managed-settings.json 的托管 settings）：
 *   由 IT/管理员控制（最高优先级，不可被覆盖）
 *
 * 项目级来源（projectSettings、localSettings）被排除，因为它们存在于项目目录内，
 * 恶意提交者可能借此将流量重定向（如 ANTHROPIC_BASE_URL）到攻击者控制的服务器。
 */
const TRUSTED_SETTING_SOURCES = [
  'userSettings',
  'flagSettings',
  'policySettings',
] as const

/**
 * 将受信任来源的环境变量应用到 process.env。
 * 在信任对话框之前调用，使 ANTHROPIC_BASE_URL 等用户/企业 env 变量在首次运行/引导阶段生效。
 *
 * 对于受信任来源（用户 settings、托管 settings、CLI 参数），应用全部 env 变量——
 * 包括从项目级 settings 传入会有危险的 ANTHROPIC_BASE_URL 等。
 *
 * 对于项目级来源（projectSettings、localSettings），仅应用 SAFE_ENV_VARS 白名单中的安全 env 变量。
 * 这些变量在信任完全建立后通过 applyConfigEnvironmentVariables() 应用。
 */
export function applySafeConfigEnvironmentVariables(): void {
  // 在任何 settings.env 被应用之前捕获 CCD spawn-env key（仅一次）。
  if (ccdSpawnEnvKeys === undefined) {
    ccdSpawnEnvKeys =
      process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop'
        ? new Set(Object.keys(process.env))
        : null
  }

  // 全局配置（~/.claude.json）由用户控制。在 CCD 模式下，
  // filterSettingsEnv 会剥离 spawn env 快照中存在的 key，
  // 防止覆盖桌面宿主机的运营变量（OTEL 等）。
  Object.assign(process.env, filterSettingsEnv(getGlobalConfig().env))

  // 从受信任 setting 来源应用全部 env 变量，policySettings 最后应用。
  // 通过 isSettingSourceEnabled 把关，防止 SDK settingSources: []（隔离模式）
  // 被 ~/.claude/settings.json env 覆盖（gh#217）。policy/flag 来源始终启用，
  // 因此此处实际只过滤 userSettings。
  for (const source of TRUSTED_SETTING_SOURCES) {
    if (source === 'policySettings') continue
    if (!isSettingSourceEnabled(source)) continue
    Object.assign(
      process.env,
      filterSettingsEnv(getSettingsForSource(source)?.env),
    )
  }

  // 在 userSettings 和 flagSettings env 已应用后，计算远程托管 settings 资格。
  // 资格判定读取 CLAUDE_CODE_USE_BEDROCK、ANTHROPIC_BASE_URL——两者均可通过 settings.env 设置。
  // 下方 getSettingsForSource('policySettings') 会查询远程缓存，而缓存依赖此处的资格判定。
  // 两阶段结构使顺序依赖可见：非 policy env → 资格判定 → policy env。
  isRemoteManagedSettingsEligible()

  Object.assign(
    process.env,
    filterSettingsEnv(getSettingsForSource('policySettings')?.env),
  )

  // 从完整合并后的 settings（含项目级来源）中仅应用安全 env 变量。
  // 对于同时存在于受信任来源的安全变量，合并值（可能来自更高优先级的项目来源）
  // 会覆盖受信任值——这是可接受的，因为这些变量在安全白名单内。
  // 只有 policySettings 的值保证不被修改（在两个循环中均具有最高合并优先级）——
  // 但 provider 路由变量除外，当 CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST 被设置时，
  // filterSettingsEnv 会从每个来源中剥离它们。
  const settingsEnv = filterSettingsEnv(getSettings_DEPRECATED()?.env)
  for (const [key, value] of Object.entries(settingsEnv)) {
    if (SAFE_ENV_VARS.has(key.toUpperCase())) {
      process.env[key] = value
    }
  }
}

/**
 * 将 settings 中的环境变量应用到 process.env。
 * 应用全部 env 变量（当 CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST 被设置时，
 * provider 路由变量除外——参见 filterSettingsEnv），
 * 仅应在信任建立后调用。此函数会应用潜在危险的环境变量，如 LD_PRELOAD、PATH 等。
 */
export function applyConfigEnvironmentVariables(): void {
  Object.assign(process.env, filterSettingsEnv(getGlobalConfig().env))

  Object.assign(process.env, filterSettingsEnv(getSettings_DEPRECATED()?.env))

  // 清除缓存，使 agent 以新的 env 变量重建
  clearCACertsCache()
  clearMTLSCache()
  clearProxyCache()

  // 重新配置代理/mTLS agent，以读取 settings 中的代理 env 变量
  configureGlobalAgents()
}
