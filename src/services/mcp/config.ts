import { feature } from 'bun:bundle'
import { chmod, open, rename, stat, unlink } from 'fs/promises'
import mapValues from 'lodash-es/mapValues.js'
import memoize from 'lodash-es/memoize.js'
import { dirname, join, parse } from 'path'
import { getPlatform } from 'src/utils/platform.js'
import type { PluginError } from '../../types/plugin.js'
import { getPluginErrorMessage } from '../../types/plugin.js'
import { isClaudeInChromeMCPServer } from '../../utils/claudeInChrome/common.js'
import {
  getCurrentProjectConfig,
  getGlobalConfig,
  saveCurrentProjectConfig,
  saveGlobalConfig,
} from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { getErrnoCode } from '../../utils/errors.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { safeParseJSON } from '../../utils/json.js'
import { logError } from '../../utils/log.js'
import { getPluginMcpServers } from '../../utils/plugins/mcpPluginIntegration.js'
import { loadAllPluginsCacheOnly } from '../../utils/plugins/pluginLoader.js'
import { isSettingSourceEnabled } from '../../utils/settings/constants.js'
import { getManagedFilePath } from '../../utils/settings/managedPath.js'
import { isRestrictedToPluginOnly } from '../../utils/settings/pluginOnlyPolicy.js'
import {
  getInitialSettings,
  getSettingsForSource,
} from '../../utils/settings/settings.js'
import {
  isMcpServerCommandEntry,
  isMcpServerNameEntry,
  isMcpServerUrlEntry,
  type SettingsJson,
} from '../../utils/settings/types.js'
import type { ValidationError } from '../../utils/settings/validation.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { fetchClaudeAIMcpConfigsIfEligible } from './claudeai.js'
import { expandEnvVarsInString } from './envExpansion.js'
import {
  type ConfigScope,
  type McpHTTPServerConfig,
  type McpJsonConfig,
  McpJsonConfigSchema,
  type McpServerConfig,
  McpServerConfigSchema,
  type McpSSEServerConfig,
  type McpStdioServerConfig,
  type McpWebSocketServerConfig,
  type ScopedMcpServerConfig,
} from './types.js'
import { getProjectMcpServerStatus } from './utils.js'

/**
 * 获取托管 MCP 配置文件的路径
 */
export function getEnterpriseMcpFilePath(): string {
  logForDebugging(`[Hapii] -------- getEnterpriseMcpFilePath 开始 --------`, {
    level: 'info',
  })
  const result = join(getManagedFilePath(), 'managed-mcp.json')
  logForDebugging(`[Hapii] getEnterpriseMcpFilePath result=${result}`, {
    level: 'info',
  })
  logForDebugging(`[Hapii] -------- getEnterpriseMcpFilePath 结束 --------`, {
    level: 'info',
  })
  return result
}

/**
 * 内部工具：为服务器配置添加作用域
 */
function addScopeToServers(
  servers: Record<string, McpServerConfig> | undefined,
  scope: ConfigScope,
): Record<string, ScopedMcpServerConfig> {
  logForDebugging(
    `[Hapii] -------- addScopeToServers 开始 --------
  scope=${scope}
  serverCount=${servers ? Object.keys(servers).length : 0}
  serverNames=${servers ? Object.keys(servers).join(', ') : 'none'}`,
    { level: 'info' },
  )
  if (!servers) {
    logForDebugging(
      `[Hapii] addScopeToServers: servers is undefined, returning {}`,
      { level: 'info' },
    )
    logForDebugging(`[Hapii] -------- addScopeToServers 结束 --------`, {
      level: 'info',
    })
    return {}
  }
  const scopedServers: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries(servers)) {
    scopedServers[name] = { ...config, scope }
  }
  logForDebugging(
    `[Hapii] addScopeToServers: scoped ${Object.keys(scopedServers).length} servers`,
    { level: 'info' },
  )
  logForDebugging(`[Hapii] -------- addScopeToServers 结束 --------`, {
    level: 'info',
  })
  return scopedServers
}

/**
 * 内部工具：将 MCP 配置写入 .mcp.json 文件。
 * 保留文件权限，在重命名前刷新到磁盘。
 * 使用原始路径进行重命名（不跟随符号链接）。
 */
async function writeMcpjsonFile(config: McpJsonConfig): Promise<void> {
  logForDebugging(
    `[Hapii] -------- writeMcpjsonFile 开始 --------
  serverCount=${config.mcpServers ? Object.keys(config.mcpServers).length : 0}
  serverNames=${config.mcpServers ? Object.keys(config.mcpServers).join(', ') : 'none'}`,
    { level: 'info' },
  )
  const mcpJsonPath = join(getCwd(), '.mcp.json')
  logForDebugging(`[Hapii] writeMcpjsonFile: mcpJsonPath=${mcpJsonPath}`, {
    level: 'info',
  })

  // 读取现有文件权限以保留
  let existingMode: number | undefined
  try {
    const stats = await stat(mcpJsonPath)
    existingMode = stats.mode
    logForDebugging(
      `[Hapii] writeMcpjsonFile: existing file mode=${existingMode?.toString(8)}`,
      { level: 'info' },
    )
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      logForDebugging(`[Hapii] writeMcpjsonFile: stat error=${e}`, {
        level: 'error',
      })
      throw e
    }
    logForDebugging(
      `[Hapii] writeMcpjsonFile: file does not exist, using default mode`,
      { level: 'info' },
    )
    // 文件尚不存在——没有需要保留的权限
  }

  // 写入临时文件，刷新到磁盘，然后原子重命名
  const tempPath = `${mcpJsonPath}.tmp.${process.pid}.${Date.now()}`
  logForDebugging(`[Hapii] writeMcpjsonFile: writing to tempPath=${tempPath}`, {
    level: 'info',
  })
  const handle = await open(tempPath, 'w', existingMode ?? 0o644)
  try {
    await handle.writeFile(jsonStringify(config, null, 2), {
      encoding: 'utf8',
    })
    await handle.datasync()
    logForDebugging(`[Hapii] writeMcpjsonFile: wrote and synced temp file`, {
      level: 'info',
    })
  } finally {
    await handle.close()
  }

  try {
    // 在重命名前恢复临时文件的原始权限
    if (existingMode !== undefined) {
      await chmod(tempPath, existingMode)
      logForDebugging(
        `[Hapii] writeMcpjsonFile: restored permissions to temp file`,
        { level: 'info' },
      )
    }
    await rename(tempPath, mcpJsonPath)
    logForDebugging(
      `[Hapii] writeMcpjsonFile: renamed temp -> ${mcpJsonPath}`,
      { level: 'info' },
    )
  } catch (e: unknown) {
    logForDebugging(
      `[Hapii] writeMcpjsonFile: rename error=${e}, cleaning up temp file`,
      { level: 'error' },
    )
    // 失败时清理临时文件
    try {
      await unlink(tempPath)
    } catch {
      // 尽力清理
    }
    throw e
  }
  logForDebugging(`[Hapii] -------- writeMcpjsonFile 结束 --------`, {
    level: 'info',
  })
}

/**
 * 从服务器配置中提取命令数组（仅限 stdio 服务器）
 * 非 stdio 服务器返回 null
 */
function getServerCommandArray(config: McpServerConfig): string[] | null {
  logForDebugging(`[Hapii] -------- getServerCommandArray 开始 --------`, {
    level: 'info',
  })
  // 非 stdio 服务器没有命令
  if (config.type !== undefined && config.type !== 'stdio') {
    logForDebugging(
      `[Hapii] getServerCommandArray: non-stdio type=${config.type}, returning null`,
      { level: 'info' },
    )
    logForDebugging(`[Hapii] -------- getServerCommandArray 结束 --------`, {
      level: 'info',
    })
    return null
  }
  const stdioConfig = config as McpStdioServerConfig
  const result = [stdioConfig.command, ...(stdioConfig.args ?? [])]
  logForDebugging(
    `[Hapii] getServerCommandArray: command=${stdioConfig.command}, args=${JSON.stringify(stdioConfig.args ?? [])}`,
    { level: 'info' },
  )
  logForDebugging(`[Hapii] -------- getServerCommandArray 结束 --------`, {
    level: 'info',
  })
  return result
}

/**
 * 检查两个命令数组是否完全匹配
 */
function commandArraysMatch(a: string[], b: string[]): boolean {
  logForDebugging(`[Hapii] -------- commandArraysMatch 开始 --------`, {
    level: 'info',
  })
  logForDebugging(
    `[Hapii] commandArraysMatch: a=${JSON.stringify(a)}, b=${JSON.stringify(b)}`,
    { level: 'info' },
  )
  if (a.length !== b.length) {
    logForDebugging(
      `[Hapii] commandArraysMatch: length mismatch ${a.length} vs ${b.length}`,
      { level: 'info' },
    )
    logForDebugging(`[Hapii] -------- commandArraysMatch 结束 --------`, {
      level: 'info',
    })
    return false
  }
  const result = a.every((val, idx) => val === b[idx])
  logForDebugging(`[Hapii] commandArraysMatch: result=${result}`, {
    level: 'info',
  })
  logForDebugging(`[Hapii] -------- commandArraysMatch 结束 --------`, {
    level: 'info',
  })
  return result
}

/**
 * 从服务器配置中提取 URL（仅限远程服务器）
 * stdio/sdk 服务器返回 null
 */
function getServerUrl(config: McpServerConfig): string | null {
  logForDebugging(`[Hapii] -------- getServerUrl 开始 --------`, {
    level: 'info',
  })
  const result = 'url' in config ? config.url : null
  logForDebugging(`[Hapii] getServerUrl: result=${result}`, { level: 'info' })
  logForDebugging(`[Hapii] -------- getServerUrl 结束 --------`, {
    level: 'info',
  })
  return result
}

/**
 * CCR 代理 URL 路径标记。在远程会话中，claude.ai 连接器通过
 * --mcp-config 传入，其 URL 被重写为通过 CCR/session-ingress
 * SHTTP 代理路由。原始供应商 URL 保留在 mcp_url 查询参数中，
 * 以便代理知道转发目标。参见 api-go/ccr/internal/ccrshared/
 * mcp_url_rewriter.go 和 api-go/ccr/internal/mcpproxy/proxy.go。
 */
const CCR_PROXY_PATH_MARKERS = [
  '/v2/session_ingress/shttp/mcp/',
  '/v2/ccr-sessions/',
]

/**
 * 如果 URL 是 CCR 代理 URL，从 mcp_url 查询参数中提取原始供应商 URL。
 * 否则原样返回 URL。这使得基于签名的去重能够在插件的原始供应商 URL
 * 与连接器的重写代理 URL 之间匹配（当两者指向同一个 MCP 服务器时）。
 */
export function unwrapCcrProxyUrl(url: string): string {
  logForDebugging(`[Hapii] -------- unwrapCcrProxyUrl 开始 --------`, {
    level: 'info',
  })
  logForDebugging(`[Hapii] unwrapCcrProxyUrl: input url=${url}`, {
    level: 'info',
  })
  if (!CCR_PROXY_PATH_MARKERS.some(m => url.includes(m))) {
    logForDebugging(
      `[Hapii] unwrapCcrProxyUrl: no CCR proxy marker found, returning original url`,
      { level: 'info' },
    )
    logForDebugging(`[Hapii] -------- unwrapCcrProxyUrl 结束 --------`, {
      level: 'info',
    })
    return url
  }
  try {
    const parsed = new URL(url)
    const original = parsed.searchParams.get('mcp_url')
    logForDebugging(
      `[Hapii] unwrapCcrProxyUrl: CCR proxy detected, original=${original}`,
      { level: 'info' },
    )
    logForDebugging(`[Hapii] -------- unwrapCcrProxyUrl 结束 --------`, {
      level: 'info',
    })
    return original || url
  } catch {
    logForDebugging(
      `[Hapii] unwrapCcrProxyUrl: URL parse error, returning original url`,
      { level: 'error' },
    )
    logForDebugging(`[Hapii] -------- unwrapCcrProxyUrl 结束 --------`, {
      level: 'info',
    })
    return url
  }
}

/**
 * 为 MCP 服务器配置计算去重签名。
 * 具有相同签名的两个配置在插件去重中被视为"同一服务器"。
 * 忽略 env（插件始终注入 CLAUDE_PLUGIN_ROOT）和 headers
 * （相同 URL = 相同服务器，无论认证方式）。
 * 仅对既没有 command 也没有 url 的配置（sdk 类型）返回 null。
 */
export function getMcpServerSignature(config: McpServerConfig): string | null {
  logForDebugging(`[Hapii] -------- getMcpServerSignature 开始 --------`, {
    level: 'info',
  })
  const cmd = getServerCommandArray(config)
  if (cmd) {
    const sig = `stdio:${jsonStringify(cmd)}`
    logForDebugging(`[Hapii] getMcpServerSignature: stdio signature=${sig}`, {
      level: 'info',
    })
    logForDebugging(`[Hapii] -------- getMcpServerSignature 结束 --------`, {
      level: 'info',
    })
    return sig
  }
  const url = getServerUrl(config)
  if (url) {
    const sig = `url:${unwrapCcrProxyUrl(url)}`
    logForDebugging(`[Hapii] getMcpServerSignature: url signature=${sig}`, {
      level: 'info',
    })
    logForDebugging(`[Hapii] -------- getMcpServerSignature 结束 --------`, {
      level: 'info',
    })
    return sig
  }
  logForDebugging(
    `[Hapii] getMcpServerSignature: no command or url, returning null`,
    { level: 'info' },
  )
  logForDebugging(`[Hapii] -------- getMcpServerSignature 结束 --------`, {
    level: 'info',
  })
  return null
}

/**
 * 过滤插件 MCP 服务器，丢弃签名与手动配置服务器或更早加载的插件服务器匹配的条目。
 * 手动配置优先于插件；插件之间先加载者优先。
 *
 * 插件服务器使用 `plugin:name:server` 命名空间，因此在合并时不会与手动服务器
 * 发生键冲突——此基于内容的检查捕获了两者实际启动相同底层进程/连接的情况。
 */
export function dedupPluginMcpServers(
  pluginServers: Record<string, ScopedMcpServerConfig>,
  manualServers: Record<string, ScopedMcpServerConfig>,
): {
  servers: Record<string, ScopedMcpServerConfig>
  suppressed: Array<{ name: string; duplicateOf: string }>
} {
  logForDebugging(
    `[Hapii] -------- dedupPluginMcpServers 开始 --------
  pluginServerCount=${Object.keys(pluginServers).length}
  manualServerCount=${Object.keys(manualServers).length}
  pluginServerNames=${Object.keys(pluginServers).join(', ')}
  manualServerNames=${Object.keys(manualServers).join(', ')}`,
    { level: 'info' },
  )
  // 映射签名 -> 服务器名称，以便报告重复匹配的是哪个服务器
  const manualSigs = new Map<string, string>()
  for (const [name, config] of Object.entries(manualServers)) {
    const sig = getMcpServerSignature(config)
    if (sig && !manualSigs.has(sig)) manualSigs.set(sig, name)
  }
  logForDebugging(
    `[Hapii] dedupPluginMcpServers: manualSigs count=${manualSigs.size}`,
    { level: 'info' },
  )

  const servers: Record<string, ScopedMcpServerConfig> = {}
  const suppressed: Array<{ name: string; duplicateOf: string }> = []
  const seenPluginSigs = new Map<string, string>()
  for (const [name, config] of Object.entries(pluginServers)) {
    const sig = getMcpServerSignature(config)
    if (sig === null) {
      logForDebugging(
        `[Hapii] dedupPluginMcpServers: plugin "${name}" has no signature, keeping`,
        { level: 'info' },
      )
      servers[name] = config
      continue
    }
    const manualDup = manualSigs.get(sig)
    if (manualDup !== undefined) {
      logForDebugging(
        `[Hapii] dedupPluginMcpServers: Suppressing plugin "${name}": duplicates manually-configured "${manualDup}"`,
        { level: 'info' },
      )
      suppressed.push({ name, duplicateOf: manualDup })
      continue
    }
    const pluginDup = seenPluginSigs.get(sig)
    if (pluginDup !== undefined) {
      logForDebugging(
        `[Hapii] dedupPluginMcpServers: Suppressing plugin "${name}": duplicates earlier plugin server "${pluginDup}"`,
        { level: 'info' },
      )
      suppressed.push({ name, duplicateOf: pluginDup })
      continue
    }
    seenPluginSigs.set(sig, name)
    servers[name] = config
  }
  logForDebugging(
    `[Hapii] dedupPluginMcpServers: kept ${Object.keys(servers).length} servers, suppressed ${suppressed.length}`,
    { level: 'info' },
  )
  logForDebugging(`[Hapii] -------- dedupPluginMcpServers 结束 --------`, {
    level: 'info',
  })
  return { servers, suppressed }
}

/**
 * 过滤 claude.ai 连接器，丢弃签名与已启用的手动配置服务器匹配的条目。
 * 手动配置优先：编写了 .mcp.json 或运行 `claude mcp add` 的用户表达的意图
 * 高于在 Web UI 中切换的连接器。
 *
 * 连接器键为 `claude.ai <DisplayName>`，因此在合并时不会与手动服务器发生
 * 键冲突——此基于内容的检查捕获了两者指向相同底层 URL 的情况（例如
 * `mcp__slack__*` 和 `mcp__claude_ai_Slack__*` 都访问 mcp.slack.com，
 * 每轮浪费约 600 个字符）。
 *
 * 仅已启用的手动服务器计为去重目标——已禁用的手动服务器不应抑制其连接器副本，
 * 否则两者都不会运行。
 */
export function dedupClaudeAiMcpServers(
  claudeAiServers: Record<string, ScopedMcpServerConfig>,
  manualServers: Record<string, ScopedMcpServerConfig>,
): {
  servers: Record<string, ScopedMcpServerConfig>
  suppressed: Array<{ name: string; duplicateOf: string }>
} {
  logForDebugging(
    `[Hapii] -------- dedupClaudeAiMcpServers 开始 --------
  claudeAiServerCount=${Object.keys(claudeAiServers).length}
  manualServerCount=${Object.keys(manualServers).length}
  claudeAiServerNames=${Object.keys(claudeAiServers).join(', ')}
  manualServerNames=${Object.keys(manualServers).join(', ')}`,
    { level: 'info' },
  )
  const manualSigs = new Map<string, string>()
  for (const [name, config] of Object.entries(manualServers)) {
    if (isMcpServerDisabled(name)) {
      logForDebugging(
        `[Hapii] dedupClaudeAiMcpServers: manual server "${name}" is disabled, skipping`,
        { level: 'info' },
      )
      continue
    }
    const sig = getMcpServerSignature(config)
    if (sig && !manualSigs.has(sig)) manualSigs.set(sig, name)
  }
  logForDebugging(
    `[Hapii] dedupClaudeAiMcpServers: enabled manual sigs count=${manualSigs.size}`,
    { level: 'info' },
  )

  const servers: Record<string, ScopedMcpServerConfig> = {}
  const suppressed: Array<{ name: string; duplicateOf: string }> = []
  for (const [name, config] of Object.entries(claudeAiServers)) {
    const sig = getMcpServerSignature(config)
    const manualDup = sig !== null ? manualSigs.get(sig) : undefined
    if (manualDup !== undefined) {
      logForDebugging(
        `[Hapii] dedupClaudeAiMcpServers: Suppressing claude.ai connector "${name}": duplicates manually-configured "${manualDup}"`,
        { level: 'info' },
      )
      suppressed.push({ name, duplicateOf: manualDup })
      continue
    }
    logForDebugging(
      `[Hapii] dedupClaudeAiMcpServers: keeping claude.ai connector "${name}"`,
      { level: 'info' },
    )
    servers[name] = config
  }
  logForDebugging(
    `[Hapii] dedupClaudeAiMcpServers: kept ${Object.keys(servers).length} servers, suppressed ${suppressed.length}`,
    { level: 'info' },
  )
  logForDebugging(`[Hapii] -------- dedupClaudeAiMcpServers 结束 --------`, {
    level: 'info',
  })
  return { servers, suppressed }
}

/**
 * 将带通配符的 URL 模式转换为正则表达式
 * 支持 * 作为通配符匹配任意字符
 * 示例：
 *   "https://example.com/*" 匹配 "https://example.com/api/v1"
 *   "https://*.example.com/*" 匹配 "https://api.example.com/path"
 *   "https://example.com:*\/*" 匹配任意端口
 */
function urlPatternToRegex(pattern: string): RegExp {
  // 转义正则特殊字符，* 除外
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  // 将 * 替换为正则等价形式（匹配任意字符）
  const regexStr = escaped.replace(/\*/g, '.*')
  return new RegExp(`^${regexStr}$`)
}

/**
 * 检查 URL 是否匹配带通配符支持的模式
 */
function urlMatchesPattern(url: string, pattern: string): boolean {
  const regex = urlPatternToRegex(pattern)
  return regex.test(url)
}

/**
 * 获取用于 MCP 服务器允许列表策略的设置。
 * 当 policySettings 中设置了 allowManagedMcpServersOnly 时，仅由托管设置
 * 控制允许哪些服务器。否则返回合并后的设置。
 */
function getMcpAllowlistSettings(): SettingsJson {
  if (shouldAllowManagedMcpServersOnly()) {
    return getSettingsForSource('policySettings') ?? {}
  }
  return getInitialSettings()
}

/**
 * 获取用于 MCP 服务器拒绝列表策略的设置。
 * 拒绝列表始终从所有来源合并——即使设置了 allowManagedMcpServersOnly，
 * 用户也可以为自己拒绝服务器。
 */
function getMcpDenylistSettings(): SettingsJson {
  return getInitialSettings()
}

/**
 * 检查 MCP 服务器是否被企业策略拒绝
 * 检查基于名称、命令和 URL 的限制
 * @param serverName 要检查的服务器名称
 * @param config 可选的服务器配置，用于命令/URL 匹配
 * @returns 如果被拒绝返回 true，如果不在拒绝列表中返回 false
 */
function isMcpServerDenied(
  serverName: string,
  config?: McpServerConfig,
): boolean {
  logForDebugging(
    `[Hapii] -------- isMcpServerDenied 开始 --------
  serverName=${serverName}
  hasConfig=${!!config}`,
    { level: 'info' },
  )
  const settings = getMcpDenylistSettings()
  if (!settings.deniedMcpServers) {
    logForDebugging(
      `[Hapii] isMcpServerDenied: no deniedMcpServers in settings, returning false`,
      { level: 'info' },
    )
    logForDebugging(`[Hapii] -------- isMcpServerDenied 结束 --------`, {
      level: 'info',
    })
    return false // 无限制
  }
  logForDebugging(
    `[Hapii] isMcpServerDenied: deniedMcpServers count=${settings.deniedMcpServers.length}`,
    { level: 'info' },
  )

  // 检查基于名称的拒绝
  for (const entry of settings.deniedMcpServers) {
    if (isMcpServerNameEntry(entry) && entry.serverName === serverName) {
      logForDebugging(
        `[Hapii] isMcpServerDenied: server "${serverName}" denied by name match`,
        { level: 'info' },
      )
      logForDebugging(`[Hapii] -------- isMcpServerDenied 结束 --------`, {
        level: 'info',
      })
      return true
    }
  }

  // 检查基于命令的拒绝（仅限 stdio 服务器）和基于 URL 的拒绝（仅限远程服务器）
  if (config) {
    const serverCommand = getServerCommandArray(config)
    if (serverCommand) {
      logForDebugging(
        `[Hapii] isMcpServerDenied: checking command-based deny for stdio server`,
        { level: 'info' },
      )
      for (const entry of settings.deniedMcpServers) {
        if (
          isMcpServerCommandEntry(entry) &&
          commandArraysMatch(entry.serverCommand, serverCommand)
        ) {
          logForDebugging(
            `[Hapii] isMcpServerDenied: server "${serverName}" denied by command match`,
            { level: 'info' },
          )
          logForDebugging(`[Hapii] -------- isMcpServerDenied 结束 --------`, {
            level: 'info',
          })
          return true
        }
      }
    }

    const serverUrl = getServerUrl(config)
    if (serverUrl) {
      logForDebugging(
        `[Hapii] isMcpServerDenied: checking URL-based deny for remote server, url=${serverUrl}`,
        { level: 'info' },
      )
      for (const entry of settings.deniedMcpServers) {
        if (
          isMcpServerUrlEntry(entry) &&
          urlMatchesPattern(serverUrl, entry.serverUrl)
        ) {
          logForDebugging(
            `[Hapii] isMcpServerDenied: server "${serverName}" denied by URL match`,
            { level: 'info' },
          )
          logForDebugging(`[Hapii] -------- isMcpServerDenied 结束 --------`, {
            level: 'info',
          })
          return true
        }
      }
    }
  }

  logForDebugging(
    `[Hapii] isMcpServerDenied: server "${serverName}" is NOT denied`,
    { level: 'info' },
  )
  logForDebugging(`[Hapii] -------- isMcpServerDenied 结束 --------`, {
    level: 'info',
  })
  return false
}

/**
 * 检查 MCP 服务器是否被企业策略允许
 * 检查基于名称、命令和 URL 的限制
 * @param serverName 要检查的服务器名称
 * @param config 可选的服务器配置，用于命令/URL 匹配
 * @returns 如果允许返回 true，如果被策略阻止返回 false
 */
function isMcpServerAllowedByPolicy(
  serverName: string,
  config?: McpServerConfig,
): boolean {
  logForDebugging(
    `[Hapii] -------- isMcpServerAllowedByPolicy 开始 --------
  serverName=${serverName}
  hasConfig=${!!config}`,
    { level: 'info' },
  )
  // 拒绝列表具有绝对优先权
  if (isMcpServerDenied(serverName, config)) {
    logForDebugging(
      `[Hapii] isMcpServerAllowedByPolicy: server "${serverName}" is denied, returning false`,
      { level: 'info' },
    )
    logForDebugging(
      `[Hapii] -------- isMcpServerAllowedByPolicy 结束 --------`,
      { level: 'info' },
    )
    return false
  }

  const settings = getMcpAllowlistSettings()
  if (!settings.allowedMcpServers) {
    logForDebugging(
      `[Hapii] isMcpServerAllowedByPolicy: no allowedMcpServers in settings, returning true`,
      { level: 'info' },
    )
    logForDebugging(
      `[Hapii] -------- isMcpServerAllowedByPolicy 结束 --------`,
      { level: 'info' },
    )
    return true // 无允许列表限制（未定义）
  }

  // 空允许列表意味着阻止所有服务器
  if (settings.allowedMcpServers.length === 0) {
    logForDebugging(
      `[Hapii] isMcpServerAllowedByPolicy: empty allowedMcpServers list, returning false`,
      { level: 'info' },
    )
    logForDebugging(
      `[Hapii] -------- isMcpServerAllowedByPolicy 结束 --------`,
      { level: 'info' },
    )
    return false
  }

  logForDebugging(
    `[Hapii] isMcpServerAllowedByPolicy: allowedMcpServers count=${settings.allowedMcpServers.length}`,
    { level: 'info' },
  )

  // 检查允许列表是否包含任何基于命令或基于 URL 的条目
  const hasCommandEntries = settings.allowedMcpServers.some(
    isMcpServerCommandEntry,
  )
  const hasUrlEntries = settings.allowedMcpServers.some(isMcpServerUrlEntry)
  logForDebugging(
    `[Hapii] isMcpServerAllowedByPolicy: hasCommandEntries=${hasCommandEntries}, hasUrlEntries=${hasUrlEntries}`,
    { level: 'info' },
  )

  if (config) {
    const serverCommand = getServerCommandArray(config)
    const serverUrl = getServerUrl(config)

    if (serverCommand) {
      // 这是一个 stdio 服务器
      if (hasCommandEntries) {
        logForDebugging(
          `[Hapii] isMcpServerAllowedByPolicy: stdio server, checking command entries`,
          { level: 'info' },
        )
        // 如果存在任何 serverCommand 条目，stdio 服务器必须匹配其中之一
        for (const entry of settings.allowedMcpServers) {
          if (
            isMcpServerCommandEntry(entry) &&
            commandArraysMatch(entry.serverCommand, serverCommand)
          ) {
            logForDebugging(
              `[Hapii] isMcpServerAllowedByPolicy: stdio server "${serverName}" allowed by command match`,
              { level: 'info' },
            )
            logForDebugging(
              `[Hapii] -------- isMcpServerAllowedByPolicy 结束 --------`,
              { level: 'info' },
            )
            return true
          }
        }
        logForDebugging(
          `[Hapii] isMcpServerAllowedByPolicy: stdio server "${serverName}" not allowed by any command entry`,
          { level: 'info' },
        )
        logForDebugging(
          `[Hapii] -------- isMcpServerAllowedByPolicy 结束 --------`,
          { level: 'info' },
        )
        return false // stdio 服务器不匹配任何命令条目
      } else {
        logForDebugging(
          `[Hapii] isMcpServerAllowedByPolicy: stdio server, checking name entries`,
          { level: 'info' },
        )
        // 无命令条目，检查基于名称的允许
        for (const entry of settings.allowedMcpServers) {
          if (isMcpServerNameEntry(entry) && entry.serverName === serverName) {
            logForDebugging(
              `[Hapii] isMcpServerAllowedByPolicy: stdio server "${serverName}" allowed by name match`,
              { level: 'info' },
            )
            logForDebugging(
              `[Hapii] -------- isMcpServerAllowedByPolicy 结束 --------`,
              { level: 'info' },
            )
            return true
          }
        }
        logForDebugging(
          `[Hapii] isMcpServerAllowedByPolicy: stdio server "${serverName}" not allowed by name`,
          { level: 'info' },
        )
        logForDebugging(
          `[Hapii] -------- isMcpServerAllowedByPolicy 结束 --------`,
          { level: 'info' },
        )
        return false
      }
    } else if (serverUrl) {
      // 这是一个远程服务器（sse、http、ws 等）
      if (hasUrlEntries) {
        logForDebugging(
          `[Hapii] isMcpServerAllowedByPolicy: remote server, checking URL entries`,
          { level: 'info' },
        )
        // 如果存在任何 serverUrl 条目，远程服务器必须匹配其中之一
        for (const entry of settings.allowedMcpServers) {
          if (
            isMcpServerUrlEntry(entry) &&
            urlMatchesPattern(serverUrl, entry.serverUrl)
          ) {
            logForDebugging(
              `[Hapii] isMcpServerAllowedByPolicy: remote server "${serverName}" allowed by URL match`,
              { level: 'info' },
            )
            logForDebugging(
              `[Hapii] -------- isMcpServerAllowedByPolicy 结束 --------`,
              { level: 'info' },
            )
            return true
          }
        }
        logForDebugging(
          `[Hapii] isMcpServerAllowedByPolicy: remote server "${serverName}" not allowed by any URL entry`,
          { level: 'info' },
        )
        logForDebugging(
          `[Hapii] -------- isMcpServerAllowedByPolicy 结束 --------`,
          { level: 'info' },
        )
        return false // 远程服务器不匹配任何 URL 条目
      } else {
        logForDebugging(
          `[Hapii] isMcpServerAllowedByPolicy: remote server, checking name entries`,
          { level: 'info' },
        )
        // 无 URL 条目，检查基于名称的允许
        for (const entry of settings.allowedMcpServers) {
          if (isMcpServerNameEntry(entry) && entry.serverName === serverName) {
            logForDebugging(
              `[Hapii] isMcpServerAllowedByPolicy: remote server "${serverName}" allowed by name match`,
              { level: 'info' },
            )
            logForDebugging(
              `[Hapii] -------- isMcpServerAllowedByPolicy 结束 --------`,
              { level: 'info' },
            )
            return true
          }
        }
        logForDebugging(
          `[Hapii] isMcpServerAllowedByPolicy: remote server "${serverName}" not allowed by name`,
          { level: 'info' },
        )
        logForDebugging(
          `[Hapii] -------- isMcpServerAllowedByPolicy 结束 --------`,
          { level: 'info' },
        )
        return false
      }
    } else {
      logForDebugging(
        `[Hapii] isMcpServerAllowedByPolicy: unknown server type, checking name entries only`,
        { level: 'info' },
      )
      // 未知服务器类型——仅检查基于名称的允许
      for (const entry of settings.allowedMcpServers) {
        if (isMcpServerNameEntry(entry) && entry.serverName === serverName) {
          logForDebugging(
            `[Hapii] isMcpServerAllowedByPolicy: server "${serverName}" allowed by name match`,
            { level: 'info' },
          )
          logForDebugging(
            `[Hapii] -------- isMcpServerAllowedByPolicy 结束 --------`,
            { level: 'info' },
          )
          return true
        }
      }
      logForDebugging(
        `[Hapii] isMcpServerAllowedByPolicy: server "${serverName}" not allowed`,
        { level: 'info' },
      )
      logForDebugging(
        `[Hapii] -------- isMcpServerAllowedByPolicy 结束 --------`,
        { level: 'info' },
      )
      return false
    }
  }

  // 未提供配置——仅检查基于名称的允许
  logForDebugging(
    `[Hapii] isMcpServerAllowedByPolicy: no config provided, checking name entries only`,
    { level: 'info' },
  )
  for (const entry of settings.allowedMcpServers) {
    if (isMcpServerNameEntry(entry) && entry.serverName === serverName) {
      logForDebugging(
        `[Hapii] isMcpServerAllowedByPolicy: server "${serverName}" allowed by name match`,
        { level: 'info' },
      )
      logForDebugging(
        `[Hapii] -------- isMcpServerAllowedByPolicy 结束 --------`,
        { level: 'info' },
      )
      return true
    }
  }
  logForDebugging(
    `[Hapii] isMcpServerAllowedByPolicy: server "${serverName}" not allowed`,
    { level: 'info' },
  )
  logForDebugging(`[Hapii] -------- isMcpServerAllowedByPolicy 结束 --------`, {
    level: 'info',
  })
  return false
}

/**
 * 按托管策略（allowedMcpServers / deniedMcpServers）过滤 MCP 服务器配置记录。
 * 被策略阻止的服务器将被丢弃，其名称返回给调用方以便警告用户。
 *
 * 适用于绕过 getClaudeCodeMcpConfigs() 中策略过滤器的用户控制配置入口：
 * --mcp-config（main.tsx）和 mcp_set_servers 控制消息（print.ts，SDK V2 Query.setMcpServers()）。
 *
 * SDK 类型服务器豁免——它们是 SDK 管理的传输占位符，而非 CLI 管理的连接。
 * CLI 从不为其生成进程或打开网络连接；工具调用通过 mcp_tool_call 路由回 SDK。
 * URL/命令基于的允许列表条目对它们无意义（无 url、无 command），按名称过滤会在
 * installPluginsAndApplyMcpInBackground 的 sdkMcpConfigs 延续时静默丢弃它们。
 *
 * 泛型无类型约束，因为两个调用点使用不同的配置类型族：main.tsx 使用
 * ScopedMcpServerConfig（服务类型，args: string[] 必需），print.ts 使用
 * McpServerConfigForProcessTransport（SDK 线路类型，args?: string[] 可选）。
 * 两者在结构上与 isMcpServerAllowedByPolicy 实际读取的字段（type/url/command/args）
 * 兼容——策略检查只读取，不要求任何字段必须存在。`as McpServerConfig` 的拓宽
 * 因此是安全的；下游检查容忍缺失/未定义字段：`config` 是可选的，
 * `getServerCommandArray` 通过 `?? []` 将 `args` 默认为 `[]`。
 */
export function filterMcpServersByPolicy<T>(configs: Record<string, T>): {
  allowed: Record<string, T>
  blocked: string[]
} {
  logForDebugging(
    `[Hapii] -------- filterMcpServersByPolicy 开始 --------
  inputCount=${Object.keys(configs).length}
  inputNames=${Object.keys(configs).join(', ')}`,
    { level: 'info' },
  )
  const allowed: Record<string, T> = {}
  const blocked: string[] = []
  for (const [name, config] of Object.entries(configs)) {
    const c = config as McpServerConfig
    if (c.type === 'sdk' || isMcpServerAllowedByPolicy(name, c)) {
      logForDebugging(
        `[Hapii] filterMcpServersByPolicy: "${name}" allowed (type=${c.type})`,
        { level: 'info' },
      )
      allowed[name] = config
    } else {
      logForDebugging(
        `[Hapii] filterMcpServersByPolicy: "${name}" blocked by policy`,
        { level: 'info' },
      )
      blocked.push(name)
    }
  }
  logForDebugging(
    `[Hapii] filterMcpServersByPolicy: allowed=${Object.keys(allowed).length}, blocked=${blocked.length}`,
    { level: 'info' },
  )
  logForDebugging(`[Hapii] -------- filterMcpServersByPolicy 结束 --------`, {
    level: 'info',
  })
  return { allowed, blocked }
}

/**
 * 内部工具：展开 MCP 服务器配置中的环境变量
 */
function expandEnvVars(config: McpServerConfig): {
  expanded: McpServerConfig
  missingVars: string[]
} {
  const missingVars: string[] = []

  function expandString(str: string): string {
    const { expanded, missingVars: vars } = expandEnvVarsInString(str)
    missingVars.push(...vars)
    return expanded
  }

  let expanded: McpServerConfig

  switch (config.type) {
    case undefined:
    case 'stdio': {
      const stdioConfig = config as McpStdioServerConfig
      expanded = {
        ...stdioConfig,
        command: expandString(stdioConfig.command),
        args: stdioConfig.args.map(expandString),
        env: stdioConfig.env
          ? mapValues(stdioConfig.env, expandString)
          : undefined,
      }
      break
    }
    case 'sse':
    case 'http':
    case 'ws': {
      const remoteConfig = config as
        | McpSSEServerConfig
        | McpHTTPServerConfig
        | McpWebSocketServerConfig
      expanded = {
        ...remoteConfig,
        url: expandString(remoteConfig.url),
        headers: remoteConfig.headers
          ? mapValues(remoteConfig.headers, expandString)
          : undefined,
      }
      break
    }
    case 'sse-ide':
    case 'ws-ide':
      expanded = config
      break
    case 'sdk':
      expanded = config
      break
    case 'claudeai-proxy':
      expanded = config
      break
  }

  return {
    expanded,
    missingVars: [...new Set(missingVars)],
  }
}

/**
 * 添加新的 MCP 服务器配置
 * @param name 服务器名称
 * @param config 服务器配置
 * @param scope 配置作用域
 * @throws Error 如果名称无效或服务器已存在，或配置无效
 */
export async function addMcpConfig(
  name: string,
  config: unknown,
  scope: ConfigScope,
): Promise<void> {
  logForDebugging(
    `[Hapii] -------- addMcpConfig 开始 --------
  name=${name}
  scope=${scope}
  config=${JSON.stringify(config)}`,
    { level: 'info' },
  )
  if (name.match(/[^a-zA-Z0-9_-]/)) {
    logForDebugging(`[Hapii] addMcpConfig: invalid name "${name}"`, {
      level: 'error',
    })
    throw new Error(
      `Invalid name ${name}. Names can only contain letters, numbers, hyphens, and underscores.`,
    )
  }

  // 阻止保留的服务器名称 "claude-in-chrome"
  if (isClaudeInChromeMCPServer(name)) {
    logForDebugging(`[Hapii] addMcpConfig: reserved name "${name}"`, {
      level: 'error',
    })
    throw new Error(`Cannot add MCP server "${name}": this name is reserved.`)
  }

  if (feature('CHICAGO_MCP')) {
    const { isComputerUseMCPServer } = await import(
      '../../utils/computerUse/common.js'
    )
    if (isComputerUseMCPServer(name)) {
      logForDebugging(
        `[Hapii] addMcpConfig: reserved computer use name "${name}"`,
        { level: 'error' },
      )
      throw new Error(`Cannot add MCP server "${name}": this name is reserved.`)
    }
  }

  // 当企业 MCP 配置存在时阻止添加服务器（它具有独占控制权）
  if (doesEnterpriseMcpConfigExist()) {
    logForDebugging(
      `[Hapii] addMcpConfig: enterprise MCP config exists, blocking add`,
      { level: 'error' },
    )
    throw new Error(
      `Cannot add MCP server: enterprise MCP configuration is active and has exclusive control over MCP servers`,
    )
  }

  // 首先验证配置（基于命令的策略检查所需）
  const result = McpServerConfigSchema().safeParse(config)
  if (!result.success) {
    const formattedErrors = result.error.issues
      .map(err => `${err.path.join('.')}: ${err.message}`)
      .join(', ')
    logForDebugging(
      `[Hapii] addMcpConfig: invalid configuration: ${formattedErrors}`,
      { level: 'error' },
    )
    throw new Error(`Invalid configuration: ${formattedErrors}`)
  }
  const validatedConfig = result.data
  logForDebugging(
    `[Hapii] addMcpConfig: configuration validated successfully`,
    { level: 'info' },
  )

  // 检查拒绝列表（使用配置进行基于命令的检查）
  if (isMcpServerDenied(name, validatedConfig)) {
    logForDebugging(
      `[Hapii] addMcpConfig: server "${name}" is denied by policy`,
      { level: 'error' },
    )
    throw new Error(
      `Cannot add MCP server "${name}": server is explicitly blocked by enterprise policy`,
    )
  }

  // 检查允许列表（使用配置进行基于命令的检查）
  if (!isMcpServerAllowedByPolicy(name, validatedConfig)) {
    logForDebugging(
      `[Hapii] addMcpConfig: server "${name}" is not allowed by policy`,
      { level: 'error' },
    )
    throw new Error(
      `Cannot add MCP server "${name}": not allowed by enterprise policy`,
    )
  }

  // 检查服务器是否已存在于目标作用域中
  switch (scope) {
    case 'project': {
      const { servers } = getProjectMcpConfigsFromCwd()
      if (servers[name]) {
        logForDebugging(
          `[Hapii] addMcpConfig: server "${name}" already exists in project scope`,
          { level: 'error' },
        )
        throw new Error(`MCP server ${name} already exists in .mcp.json`)
      }
      break
    }
    case 'user': {
      const globalConfig = getGlobalConfig()
      if (globalConfig.mcpServers?.[name]) {
        logForDebugging(
          `[Hapii] addMcpConfig: server "${name}" already exists in user scope`,
          { level: 'error' },
        )
        throw new Error(`MCP server ${name} already exists in user config`)
      }
      break
    }
    case 'local': {
      const projectConfig = getCurrentProjectConfig()
      if (projectConfig.mcpServers?.[name]) {
        logForDebugging(
          `[Hapii] addMcpConfig: server "${name}" already exists in local scope`,
          { level: 'error' },
        )
        throw new Error(`MCP server ${name} already exists in local config`)
      }
      break
    }
    case 'dynamic':
      logForDebugging(`[Hapii] addMcpConfig: cannot add to dynamic scope`, {
        level: 'error',
      })
      throw new Error('Cannot add MCP server to scope: dynamic')
    case 'enterprise':
      logForDebugging(`[Hapii] addMcpConfig: cannot add to enterprise scope`, {
        level: 'error',
      })
      throw new Error('Cannot add MCP server to scope: enterprise')
    case 'claudeai':
      logForDebugging(`[Hapii] addMcpConfig: cannot add to claudeai scope`, {
        level: 'error',
      })
      throw new Error('Cannot add MCP server to scope: claudeai')
  }

  // 根据作用域添加
  switch (scope) {
    case 'project': {
      const { servers: existingServers } = getProjectMcpConfigsFromCwd()

      const mcpServers: Record<string, McpServerConfig> = {}
      for (const [serverName, serverConfig] of Object.entries(
        existingServers,
      )) {
        const { scope: _, ...configWithoutScope } = serverConfig
        mcpServers[serverName] = configWithoutScope
      }
      mcpServers[name] = validatedConfig
      const mcpConfig = { mcpServers }

      // 写回 .mcp.json
      try {
        await writeMcpjsonFile(mcpConfig)
        logForDebugging(
          `[Hapii] addMcpConfig: added "${name}" to project scope`,
          { level: 'info' },
        )
      } catch (error) {
        logForDebugging(
          `[Hapii] addMcpConfig: failed to write .mcp.json: ${error}`,
          { level: 'error' },
        )
        throw new Error(`Failed to write to .mcp.json: ${error}`)
      }
      break
    }

    case 'user': {
      saveGlobalConfig(current => ({
        ...current,
        mcpServers: {
          ...current.mcpServers,
          [name]: validatedConfig,
        },
      }))
      logForDebugging(`[Hapii] addMcpConfig: added "${name}" to user scope`, {
        level: 'info',
      })
      break
    }

    case 'local': {
      saveCurrentProjectConfig(current => ({
        ...current,
        mcpServers: {
          ...current.mcpServers,
          [name]: validatedConfig,
        },
      }))
      logForDebugging(`[Hapii] addMcpConfig: added "${name}" to local scope`, {
        level: 'info',
      })
      break
    }

    default:
      logForDebugging(`[Hapii] addMcpConfig: invalid scope "${scope}"`, {
        level: 'error',
      })
      throw new Error(`Cannot add MCP server to scope: ${scope}`)
  }
  logForDebugging(`[Hapii] -------- addMcpConfig 结束 --------`, {
    level: 'info',
  })
}

/**
 * 移除 MCP 服务器配置
 * @param name 要移除的服务器名称
 * @param scope 配置作用域
 * @throws Error 如果在指定作用域中找不到服务器
 */
export async function removeMcpConfig(
  name: string,
  scope: ConfigScope,
): Promise<void> {
  logForDebugging(
    `[Hapii] -------- removeMcpConfig 开始 --------
  name=${name}
  scope=${scope}`,
    { level: 'info' },
  )
  switch (scope) {
    case 'project': {
      const { servers: existingServers } = getProjectMcpConfigsFromCwd()

      if (!existingServers[name]) {
        logForDebugging(
          `[Hapii] removeMcpConfig: server "${name}" not found in .mcp.json`,
          { level: 'error' },
        )
        throw new Error(`No MCP server found with name: ${name} in .mcp.json`)
      }

      // 写回 .mcp.json 时去除作用域信息
      const mcpServers: Record<string, McpServerConfig> = {}
      for (const [serverName, serverConfig] of Object.entries(
        existingServers,
      )) {
        if (serverName !== name) {
          const { scope: _, ...configWithoutScope } = serverConfig
          mcpServers[serverName] = configWithoutScope
        }
      }
      const mcpConfig = { mcpServers }
      try {
        await writeMcpjsonFile(mcpConfig)
        logForDebugging(
          `[Hapii] removeMcpConfig: removed "${name}" from project scope`,
          { level: 'info' },
        )
      } catch (error) {
        logForDebugging(
          `[Hapii] removeMcpConfig: failed to write .mcp.json: ${error}`,
          { level: 'error' },
        )
        throw new Error(`Failed to remove from .mcp.json: ${error}`)
      }
      break
    }

    case 'user': {
      const config = getGlobalConfig()
      if (!config.mcpServers?.[name]) {
        logForDebugging(
          `[Hapii] removeMcpConfig: server "${name}" not found in user config`,
          { level: 'error' },
        )
        throw new Error(`No user-scoped MCP server found with name: ${name}`)
      }
      saveGlobalConfig(current => {
        const { [name]: _, ...restMcpServers } = current.mcpServers ?? {}
        return {
          ...current,
          mcpServers: restMcpServers,
        }
      })
      logForDebugging(
        `[Hapii] removeMcpConfig: removed "${name}" from user scope`,
        { level: 'info' },
      )
      break
    }

    case 'local': {
      // 更新前检查服务器是否存在
      const config = getCurrentProjectConfig()
      if (!config.mcpServers?.[name]) {
        logForDebugging(
          `[Hapii] removeMcpConfig: server "${name}" not found in local config`,
          { level: 'error' },
        )
        throw new Error(`No project-local MCP server found with name: ${name}`)
      }
      saveCurrentProjectConfig(current => {
        const { [name]: _, ...restMcpServers } = current.mcpServers ?? {}
        return {
          ...current,
          mcpServers: restMcpServers,
        }
      })
      logForDebugging(
        `[Hapii] removeMcpConfig: removed "${name}" from local scope`,
        { level: 'info' },
      )
      break
    }

    default:
      logForDebugging(`[Hapii] removeMcpConfig: invalid scope "${scope}"`, {
        level: 'error',
      })
      throw new Error(`Cannot remove MCP server from scope: ${scope}`)
  }
  logForDebugging(`[Hapii] -------- removeMcpConfig 结束 --------`, {
    level: 'info',
  })
}

/**
 * 仅从当前目录获取 MCP 配置（不向上遍历父目录）。
 * 由 addMcpConfig 和 removeMcpConfig 使用，用于修改本地 .mcp.json 文件。
 * 出于测试目的导出。
 *
 * @returns 当前目录 .mcp.json 中的服务器（带作用域信息）及任何验证错误
 */
export function getProjectMcpConfigsFromCwd(): {
  servers: Record<string, ScopedMcpServerConfig>
  errors: ValidationError[]
} {
  logForDebugging(
    `[Hapii] -------- getProjectMcpConfigsFromCwd 开始 --------`,
    { level: 'info' },
  )
  // 检查 project 源是否已启用
  if (!isSettingSourceEnabled('projectSettings')) {
    logForDebugging(
      `[Hapii] getProjectMcpConfigsFromCwd: projectSettings not enabled, returning empty`,
      { level: 'info' },
    )
    logForDebugging(
      `[Hapii] -------- getProjectMcpConfigsFromCwd 结束 --------`,
      { level: 'info' },
    )
    return { servers: {}, errors: [] }
  }

  const mcpJsonPath = join(getCwd(), '.mcp.json')
  logForDebugging(
    `[Hapii] getProjectMcpConfigsFromCwd: mcpJsonPath=${mcpJsonPath}`,
    { level: 'info' },
  )

  const { config, errors } = parseMcpConfigFromFilePath({
    filePath: mcpJsonPath,
    expandVars: true,
    scope: 'project',
  })

  // 缺少 .mcp.json 是预期情况，但格式错误的文件应报告错误
  if (!config) {
    const nonMissingErrors = errors.filter(
      e => !e.message.startsWith('MCP config file not found'),
    )
    if (nonMissingErrors.length > 0) {
      logForDebugging(
        `[Hapii] getProjectMcpConfigsFromCwd: config errors for ${mcpJsonPath}: ${jsonStringify(nonMissingErrors.map(e => e.message))}`,
        { level: 'error' },
      )
      logForDebugging(
        `[Hapii] -------- getProjectMcpConfigsFromCwd 结束 --------`,
        { level: 'info' },
      )
      return { servers: {}, errors: nonMissingErrors }
    }
    logForDebugging(
      `[Hapii] getProjectMcpConfigsFromCwd: no config found (file may not exist), returning empty`,
      { level: 'info' },
    )
    logForDebugging(
      `[Hapii] -------- getProjectMcpConfigsFromCwd 结束 --------`,
      { level: 'info' },
    )
    return { servers: {}, errors: [] }
  }

  const result = config.mcpServers
    ? addScopeToServers(config.mcpServers, 'project')
    : {}
  logForDebugging(
    `[Hapii] getProjectMcpConfigsFromCwd: found ${Object.keys(result).length} servers: ${Object.keys(result).join(', ')}`,
    { level: 'info' },
  )
  logForDebugging(
    `[Hapii] -------- getProjectMcpConfigsFromCwd 结束 --------`,
    { level: 'info' },
  )
  return {
    servers: result,
    errors: errors || [],
  }
}

/**
 * 从特定作用域获取所有 MCP 配置
 * @param scope 配置作用域
 * @returns 带作用域信息的服务器及任何验证错误
 */
export function getMcpConfigsByScope(
  scope: 'project' | 'user' | 'local' | 'enterprise',
): {
  servers: Record<string, ScopedMcpServerConfig>
  errors: ValidationError[]
} {
  logForDebugging(
    `[Hapii] -------- getMcpConfigsByScope 开始 -------- scope=${scope}`,
    { level: 'info' },
  )
  // 检查此源是否已启用
  const sourceMap: Record<
    string,
    'projectSettings' | 'userSettings' | 'localSettings'
  > = {
    project: 'projectSettings',
    user: 'userSettings',
    local: 'localSettings',
  }

  if (scope in sourceMap && !isSettingSourceEnabled(sourceMap[scope]!)) {
    logForDebugging(
      `[Hapii] getMcpConfigsByScope: source ${sourceMap[scope]} not enabled, returning empty`,
      { level: 'info' },
    )
    logForDebugging(`[Hapii] -------- getMcpConfigsByScope 结束 --------`, {
      level: 'info',
    })
    return { servers: {}, errors: [] }
  }

  switch (scope) {
    case 'project': {
      logForDebugging(
        `[Hapii] getMcpConfigsByScope: processing project scope`,
        { level: 'info' },
      )
      const allServers: Record<string, ScopedMcpServerConfig> = {}
      const allErrors: ValidationError[] = []

      // 构建要检查的目录列表
      const dirs: string[] = []
      let currentDir = getCwd()

      while (currentDir !== parse(currentDir).root) {
        dirs.push(currentDir)
        currentDir = dirname(currentDir)
      }
      logForDebugging(
        `[Hapii] getMcpConfigsByScope: checking ${dirs.length} directories from CWD to root`,
        { level: 'info' },
      )

      // 从根目录向下处理到 CWD（这样更近的文件具有更高优先级）
      for (const dir of dirs.reverse()) {
        const mcpJsonPath = join(dir, '.mcp.json')
        logForDebugging(
          `[Hapii] getMcpConfigsByScope: checking ${mcpJsonPath}`,
          { level: 'info' },
        )

        const { config, errors } = parseMcpConfigFromFilePath({
          filePath: mcpJsonPath,
          expandVars: true,
          scope: 'project',
        })

        // 父目录中缺少 .mcp.json 是预期情况，但格式错误的文件应报告错误
        if (!config) {
          const nonMissingErrors = errors.filter(
            e => !e.message.startsWith('MCP config file not found'),
          )
          if (nonMissingErrors.length > 0) {
            logForDebugging(
              `[Hapii] getMcpConfigsByScope: config errors for ${mcpJsonPath}: ${jsonStringify(nonMissingErrors.map(e => e.message))}`,
              { level: 'error' },
            )
            allErrors.push(...nonMissingErrors)
          }
          continue
        }

        if (config.mcpServers) {
          const serverCount = Object.keys(config.mcpServers).length
          logForDebugging(
            `[Hapii] getMcpConfigsByScope: found ${serverCount} servers in ${mcpJsonPath}`,
            { level: 'info' },
          )
          // 合并服务器，更靠近 CWD 的文件覆盖父配置
          Object.assign(allServers, addScopeToServers(config.mcpServers, scope))
        }

        if (errors.length > 0) {
          allErrors.push(...errors)
        }
      }

      logForDebugging(
        `[Hapii] getMcpConfigsByScope: project scope total ${Object.keys(allServers).length} servers`,
        { level: 'info' },
      )
      logForDebugging(`[Hapii] -------- getMcpConfigsByScope 结束 --------`, {
        level: 'info',
      })
      return {
        servers: allServers,
        errors: allErrors,
      }
    }
    case 'user': {
      logForDebugging(`[Hapii] getMcpConfigsByScope: processing user scope`, {
        level: 'info',
      })
      const mcpServers = getGlobalConfig().mcpServers
      if (!mcpServers) {
        logForDebugging(
          `[Hapii] getMcpConfigsByScope: no user mcpServers in global config`,
          { level: 'info' },
        )
        logForDebugging(`[Hapii] -------- getMcpConfigsByScope 结束 --------`, {
          level: 'info',
        })
        return { servers: {}, errors: [] }
      }
      logForDebugging(
        `[Hapii] getMcpConfigsByScope: user scope has ${Object.keys(mcpServers).length} servers`,
        { level: 'info' },
      )

      const { config, errors } = parseMcpConfig({
        configObject: { mcpServers },
        expandVars: true,
        scope: 'user',
      })

      const result = addScopeToServers(config?.mcpServers, scope)
      logForDebugging(
        `[Hapii] getMcpConfigsByScope: user scope parsed ${Object.keys(result).length} servers`,
        { level: 'info' },
      )
      logForDebugging(`[Hapii] -------- getMcpConfigsByScope 结束 --------`, {
        level: 'info',
      })
      return {
        servers: result,
        errors,
      }
    }
    case 'local': {
      logForDebugging(`[Hapii] getMcpConfigsByScope: processing local scope`, {
        level: 'info',
      })
      const mcpServers = getCurrentProjectConfig().mcpServers
      if (!mcpServers) {
        logForDebugging(
          `[Hapii] getMcpConfigsByScope: no local mcpServers in project config`,
          { level: 'info' },
        )
        logForDebugging(`[Hapii] -------- getMcpConfigsByScope 结束 --------`, {
          level: 'info',
        })
        return { servers: {}, errors: [] }
      }
      logForDebugging(
        `[Hapii] getMcpConfigsByScope: local scope has ${Object.keys(mcpServers).length} servers`,
        { level: 'info' },
      )

      const { config, errors } = parseMcpConfig({
        configObject: { mcpServers },
        expandVars: true,
        scope: 'local',
      })

      const result = addScopeToServers(config?.mcpServers, scope)
      logForDebugging(
        `[Hapii] getMcpConfigsByScope: local scope parsed ${Object.keys(result).length} servers`,
        { level: 'info' },
      )
      logForDebugging(`[Hapii] -------- getMcpConfigsByScope 结束 --------`, {
        level: 'info',
      })
      return {
        servers: result,
        errors,
      }
    }
    case 'enterprise': {
      logForDebugging(
        `[Hapii] getMcpConfigsByScope: processing enterprise scope`,
        { level: 'info' },
      )
      const enterpriseMcpPath = getEnterpriseMcpFilePath()
      logForDebugging(
        `[Hapii] getMcpConfigsByScope: enterpriseMcpPath=${enterpriseMcpPath}`,
        { level: 'info' },
      )

      const { config, errors } = parseMcpConfigFromFilePath({
        filePath: enterpriseMcpPath,
        expandVars: true,
        scope: 'enterprise',
      })

      // 缺少企业配置文件是预期情况，但格式错误的文件应报告错误
      if (!config) {
        const nonMissingErrors = errors.filter(
          e => !e.message.startsWith('MCP config file not found'),
        )
        if (nonMissingErrors.length > 0) {
          logForDebugging(
            `[Hapii] getMcpConfigsByScope: enterprise config errors for ${enterpriseMcpPath}: ${jsonStringify(nonMissingErrors.map(e => e.message))}`,
            { level: 'error' },
          )
          logForDebugging(
            `[Hapii] -------- getMcpConfigsByScope 结束 --------`,
            { level: 'info' },
          )
          return { servers: {}, errors: nonMissingErrors }
        }
        logForDebugging(
          `[Hapii] getMcpConfigsByScope: no enterprise config found (file may not exist)`,
          { level: 'info' },
        )
        logForDebugging(`[Hapii] -------- getMcpConfigsByScope 结束 --------`, {
          level: 'info',
        })
        return { servers: {}, errors: [] }
      }

      const result = addScopeToServers(config.mcpServers, scope)
      logForDebugging(
        `[Hapii] getMcpConfigsByScope: enterprise scope has ${Object.keys(result).length} servers`,
        { level: 'info' },
      )
      logForDebugging(`[Hapii] -------- getMcpConfigsByScope 结束 --------`, {
        level: 'info',
      })
      return {
        servers: result,
        errors,
      }
    }
  }
}

/**
 * 按名称获取 MCP 服务器配置
 * @param name 服务器名称
 * @returns 带作用域的服务器配置，如果未找到则返回 undefined
 */
export function getMcpConfigByName(name: string): ScopedMcpServerConfig | null {
  logForDebugging(
    `[Hapii] -------- getMcpConfigByName 开始 -------- name=${name}`,
    { level: 'info' },
  )
  const { servers: enterpriseServers } = getMcpConfigsByScope('enterprise')
  logForDebugging(
    `[Hapii] getMcpConfigByName: enterpriseServers count=${Object.keys(enterpriseServers).length}`,
    { level: 'info' },
  )

  // 当 MCP 被限制为仅限插件时，只有企业服务器可以通过
  // 名称访问。用户/项目/本地服务器被阻止——与 getClaudeCodeMcpConfigs() 相同。
  if (isRestrictedToPluginOnly('mcp')) {
    logForDebugging(
      `[Hapii] getMcpConfigByName: restricted to plugin-only, checking enterprise only`,
      { level: 'info' },
    )
    const result = enterpriseServers[name] ?? null
    logForDebugging(
      `[Hapii] getMcpConfigByName: result=${result ? 'found' : 'not found'}`,
      { level: 'info' },
    )
    logForDebugging(`[Hapii] -------- getMcpConfigByName 结束 --------`, {
      level: 'info',
    })
    return result
  }

  const { servers: userServers } = getMcpConfigsByScope('user')
  const { servers: projectServers } = getMcpConfigsByScope('project')
  const { servers: localServers } = getMcpConfigsByScope('local')
  logForDebugging(
    `[Hapii] getMcpConfigByName: user=${Object.keys(userServers).length}, project=${Object.keys(projectServers).length}, local=${Object.keys(localServers).length}`,
    { level: 'info' },
  )

  if (enterpriseServers[name]) {
    logForDebugging(`[Hapii] getMcpConfigByName: found in enterprise scope`, {
      level: 'info',
    })
    logForDebugging(`[Hapii] -------- getMcpConfigByName 结束 --------`, {
      level: 'info',
    })
    return enterpriseServers[name]
  }
  if (localServers[name]) {
    logForDebugging(`[Hapii] getMcpConfigByName: found in local scope`, {
      level: 'info',
    })
    logForDebugging(`[Hapii] -------- getMcpConfigByName 结束 --------`, {
      level: 'info',
    })
    return localServers[name]
  }
  if (projectServers[name]) {
    logForDebugging(`[Hapii] getMcpConfigByName: found in project scope`, {
      level: 'info',
    })
    logForDebugging(`[Hapii] -------- getMcpConfigByName 结束 --------`, {
      level: 'info',
    })
    return projectServers[name]
  }
  if (userServers[name]) {
    logForDebugging(`[Hapii] getMcpConfigByName: found in user scope`, {
      level: 'info',
    })
    logForDebugging(`[Hapii] -------- getMcpConfigByName 结束 --------`, {
      level: 'info',
    })
    return userServers[name]
  }

  logForDebugging(
    `[Hapii] getMcpConfigByName: "${name}" not found in any scope`,
    { level: 'info' },
  )
  logForDebugging(`[Hapii] -------- getMcpConfigByName 结束 --------`, {
    level: 'info',
  })
  return null
}

/**
 * 获取 Claude Code MCP 配置（不包含 claude.ai 服务器——它们
 * 单独获取并由调用方合并）。
 * 这很快：仅本地文件读取；关键路径上无等待的网络调用。
 * 可选的 extraDedupTargets promise（例如正在进行的 claude.ai 连接器获取）
 * 仅在 loadAllPluginsCacheOnly() 完成后才等待，因此两者是重叠而非串行执行。
 * @returns 带适当作用域的 Claude Code 服务器配置
 */
export async function getClaudeCodeMcpConfigs(
  dynamicServers: Record<string, ScopedMcpServerConfig> = {},
  extraDedupTargets: Promise<
    Record<string, ScopedMcpServerConfig>
  > = Promise.resolve({}),
): Promise<{
  servers: Record<string, ScopedMcpServerConfig>
  errors: PluginError[]
}> {
  logForDebugging(
    `[Hapii] -------- getClaudeCodeMcpConfigs 开始 --------
  dynamicServerCount=${Object.keys(dynamicServers).length}
  hasExtraDedupTargets=${extraDedupTargets !== undefined}`,
    { level: 'info' },
  )
  const { servers: enterpriseServers } = getMcpConfigsByScope('enterprise')
  logForDebugging(
    `[Hapii] getClaudeCodeMcpConfigs: enterpriseServers count=${Object.keys(enterpriseServers).length}`,
    { level: 'info' },
  )

  // 如果存在企业 mcp 配置，则不使用其他配置；这拥有对所有 MCP 服务器的独占控制权
  //（企业客户通常不希望其用户能够添加自己的 MCP 服务器）。
  if (doesEnterpriseMcpConfigExist()) {
    logForDebugging(
      `[Hapii] getClaudeCodeMcpConfigs: enterprise MCP config exists, using enterprise only`,
      { level: 'info' },
    )
    // 对企业服务器应用策略过滤
    const filtered: Record<string, ScopedMcpServerConfig> = {}

    for (const [name, serverConfig] of Object.entries(enterpriseServers)) {
      if (!isMcpServerAllowedByPolicy(name, serverConfig)) {
        logForDebugging(
          `[Hapii] getClaudeCodeMcpConfigs: enterprise server "${name}" blocked by policy`,
          { level: 'info' },
        )
        continue
      }
      filtered[name] = serverConfig
    }

    logForDebugging(
      `[Hapii] getClaudeCodeMcpConfigs: returning ${Object.keys(filtered).length} enterprise servers`,
      { level: 'info' },
    )
    logForDebugging(`[Hapii] -------- getClaudeCodeMcpConfigs 结束 --------`, {
      level: 'info',
    })
    return { servers: filtered, errors: [] }
  }

  // 加载其他作用域——除非托管策略将 MCP 锁定为仅限插件。
  // 与上面的企业独占块不同，这保留了插件服务器。
  const mcpLocked = isRestrictedToPluginOnly('mcp')
  logForDebugging(`[Hapii] getClaudeCodeMcpConfigs: mcpLocked=${mcpLocked}`, {
    level: 'info',
  })
  const noServers: { servers: Record<string, ScopedMcpServerConfig> } = {
    servers: {},
  }
  const { servers: userServers } = mcpLocked
    ? noServers
    : getMcpConfigsByScope('user')
  const { servers: projectServers } = mcpLocked
    ? noServers
    : getMcpConfigsByScope('project')
  const { servers: localServers } = mcpLocked
    ? noServers
    : getMcpConfigsByScope('local')
  logForDebugging(
    `[Hapii] getClaudeCodeMcpConfigs: user=${Object.keys(userServers).length}, project=${Object.keys(projectServers).length}, local=${Object.keys(localServers).length}`,
    { level: 'info' },
  )

  // 加载插件 MCP 服务器
  const pluginMcpServers: Record<string, ScopedMcpServerConfig> = {}

  logForDebugging(`[Hapii] getClaudeCodeMcpConfigs: loading plugins...`, {
    level: 'info',
  })
  const pluginResult = await loadAllPluginsCacheOnly()
  logForDebugging(
    `[Hapii] getClaudeCodeMcpConfigs: plugins loaded, enabled=${pluginResult.enabled.length}, errors=${pluginResult.errors.length}`,
    { level: 'info' },
  )

  // 收集服务器加载过程中的 MCP 相关错误
  const mcpErrors: PluginError[] = []

  // 记录任何插件加载错误——生产环境中绝不静默失败
  if (pluginResult.errors.length > 0) {
    for (const error of pluginResult.errors) {
      // 仅当实际与 MCP 相关时才记录为 MCP 错误
      // 否则仅记录为调试信息，因为插件可能没有 MCP 服务器
      if (
        error.type === 'mcp-config-invalid' ||
        error.type === 'mcpb-download-failed' ||
        error.type === 'mcpb-extract-failed' ||
        error.type === 'mcpb-invalid-manifest'
      ) {
        const errorMessage = `Plugin MCP loading error - ${error.type}: ${getPluginErrorMessage(error)}`
        logForDebugging(`[Hapii] getClaudeCodeMcpConfigs: ${errorMessage}`, {
          level: 'error',
        })
        logError(new Error(errorMessage))
      } else {
        // 插件不存在或不可用——这很常见，不一定是错误
        // 如果可能，插件系统将负责安装它
        const errorType = error.type
        logForDebugging(
          `[Hapii] getClaudeCodeMcpConfigs: plugin not available: ${error.source} - error type: ${errorType}`,
          { level: 'info' },
        )
      }
    }
  }

  // 并行处理已启用插件的 MCP 服务器
  logForDebugging(
    `[Hapii] getClaudeCodeMcpConfigs: getting MCP servers from ${pluginResult.enabled.length} enabled plugins...`,
    { level: 'info' },
  )
  const pluginServerResults = await Promise.all(
    pluginResult.enabled.map(plugin => getPluginMcpServers(plugin, mcpErrors)),
  )
  for (const servers of pluginServerResults) {
    if (servers) {
      Object.assign(pluginMcpServers, servers)
    }
  }
  logForDebugging(
    `[Hapii] getClaudeCodeMcpConfigs: plugin servers loaded: ${Object.keys(pluginMcpServers).length}`,
    { level: 'info' },
  )

  // 将服务器加载过程中的 MCP 相关错误添加到插件错误中
  if (mcpErrors.length > 0) {
    for (const error of mcpErrors) {
      const errorMessage = `Plugin MCP server error - ${error.type}: ${getPluginErrorMessage(error)}`
      logForDebugging(`[Hapii] getClaudeCodeMcpConfigs: ${errorMessage}`, {
        level: 'error',
      })
      logError(new Error(errorMessage))
    }
  }

  // 过滤项目服务器，仅包含已批准的
  const approvedProjectServers: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries(projectServers)) {
    if (getProjectMcpServerStatus(name) === 'approved') {
      logForDebugging(
        `[Hapii] getClaudeCodeMcpConfigs: project server "${name}" is approved`,
        { level: 'info' },
      )
      approvedProjectServers[name] = config
    } else {
      logForDebugging(
        `[Hapii] getClaudeCodeMcpConfigs: project server "${name}" is NOT approved, skipping`,
        { level: 'info' },
      )
    }
  }

  // 针对手动配置的插件服务器（以及彼此之间）去重插件服务器。
  // 插件服务器键是带命名空间的 `plugin:x:y`，因此它们永远不会与
  // 下面合并中的手动键冲突——这种基于内容的检查捕获了两者将启动
  // 相同底层进程/连接的情况。
  // 只有实际会连接的服务器才是有效的去重目标——禁用的手动服务器
  // 不能抑制插件服务器，否则两者都不会运行
  //（手动服务器在连接时按名称跳过；插件服务器在此处被移除）。
  const extraTargets = await extraDedupTargets
  const enabledManualServers: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries({
    ...userServers,
    ...approvedProjectServers,
    ...localServers,
    ...dynamicServers,
    ...extraTargets,
  })) {
    if (
      !isMcpServerDisabled(name) &&
      isMcpServerAllowedByPolicy(name, config)
    ) {
      enabledManualServers[name] = config
    }
  }
  // 分离已禁用/被策略阻止的插件服务器，这样它们就不会在
  // 先到的插件获胜的竞争中对已启用的副本胜出——与上面相同的不变量。
  // 它们在去重后被合并回来，因此仍然出现在 /mcp 中
  //（此函数末尾的策略过滤会丢弃被阻止的）。
  const enabledPluginServers: Record<string, ScopedMcpServerConfig> = {}
  const disabledPluginServers: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries(pluginMcpServers)) {
    if (
      isMcpServerDisabled(name) ||
      !isMcpServerAllowedByPolicy(name, config)
    ) {
      logForDebugging(
        `[Hapii] getClaudeCodeMcpConfigs: plugin server "${name}" is disabled or blocked by policy`,
        { level: 'info' },
      )
      disabledPluginServers[name] = config
    } else {
      enabledPluginServers[name] = config
    }
  }
  logForDebugging(
    `[Hapii] getClaudeCodeMcpConfigs: enabledPluginServers=${Object.keys(enabledPluginServers).length}, disabledPluginServers=${Object.keys(disabledPluginServers).length}`,
    { level: 'info' },
  )
  const { servers: dedupedPluginServers, suppressed } = dedupPluginMcpServers(
    enabledPluginServers,
    enabledManualServers,
  )
  Object.assign(dedupedPluginServers, disabledPluginServers)
  // 在 /plugin UI 中显示被抑制的项。在上面的 logError 循环之后推送
  // 这样这些不会进入错误日志——它们是信息性的，不是错误。
  for (const { name, duplicateOf } of suppressed) {
    // name 来自 addPluginScopeToServers 的 "plugin:${pluginName}:${serverName}"
    const parts = name.split(':')
    if (parts[0] !== 'plugin' || parts.length < 3) continue
    mcpErrors.push({
      type: 'mcp-server-suppressed-duplicate',
      source: name,
      plugin: parts[1]!,
      serverName: parts.slice(2).join(':'),
      duplicateOf,
    })
  }

  // 按优先级顺序合并：plugin < user < project < local
  logForDebugging(
    `[Hapii] getClaudeCodeMcpConfigs: merging servers by priority (plugin < user < project < local)`,
    { level: 'info' },
  )
  const configs = Object.assign(
    {},
    dedupedPluginServers,
    userServers,
    approvedProjectServers,
    localServers,
  )
  logForDebugging(
    `[Hapii] getClaudeCodeMcpConfigs: merged total ${Object.keys(configs).length} servers`,
    { level: 'info' },
  )

  // 对合并后的配置应用策略过滤
  const filtered: Record<string, ScopedMcpServerConfig> = {}

  for (const [name, serverConfig] of Object.entries(configs)) {
    if (!isMcpServerAllowedByPolicy(name, serverConfig as McpServerConfig)) {
      logForDebugging(
        `[Hapii] getClaudeCodeMcpConfigs: server "${name}" blocked by policy`,
        { level: 'info' },
      )
      continue
    }
    filtered[name] = serverConfig as ScopedMcpServerConfig
  }

  logForDebugging(
    `[Hapii] getClaudeCodeMcpConfigs: final filtered ${Object.keys(filtered).length} servers, errors=${mcpErrors.length}`,
    { level: 'info' },
  )
  logForDebugging(`[Hapii] -------- getClaudeCodeMcpConfigs 结束 --------`, {
    level: 'info',
  })
  return { servers: filtered, errors: mcpErrors }
}

/**
 * 获取所有作用域的所有 MCP 配置，包括 claude.ai 服务器。
 * 由于网络调用可能较慢——快速启动请使用 getClaudeCodeMcpConfigs()。
 * @returns 带适当作用域的所有服务器配置
 */
export async function getAllMcpConfigs(): Promise<{
  servers: Record<string, ScopedMcpServerConfig>
  errors: PluginError[]
}> {
  logForDebugging(`[Hapii] -------- getAllMcpConfigs 开始 --------`, {
    level: 'info',
  })
  // 在企业模式下，不加载 claude.ai 服务器（企业拥有独占控制权）
  if (doesEnterpriseMcpConfigExist()) {
    logForDebugging(
      `[Hapii] getAllMcpConfigs: enterprise mode, returning only claude code configs`,
      { level: 'info' },
    )
    const result = await getClaudeCodeMcpConfigs()
    logForDebugging(
      `[Hapii] getAllMcpConfigs: returning ${Object.keys(result.servers).length} enterprise servers`,
      { level: 'info' },
    )
    logForDebugging(`[Hapii] -------- getAllMcpConfigs 结束 --------`, {
      level: 'info',
    })
    return result
  }

  // 在 getClaudeCodeMcpConfigs 之前启动 claude.ai 获取，以便与其中的
  // loadAllPluginsCacheOnly() 重叠。已记忆化——下面等待的调用是缓存命中。
  logForDebugging(
    `[Hapii] getAllMcpConfigs: fetching claude.ai configs in parallel`,
    { level: 'info' },
  )
  const claudeaiPromise = fetchClaudeAIMcpConfigsIfEligible()
  const { servers: claudeCodeServers, errors } = await getClaudeCodeMcpConfigs(
    {},
    claudeaiPromise,
  )
  logForDebugging(
    `[Hapii] getAllMcpConfigs: claudeCodeServers=${Object.keys(claudeCodeServers).length}`,
    { level: 'info' },
  )
  const { allowed: claudeaiMcpServers } = filterMcpServersByPolicy(
    await claudeaiPromise,
  )
  logForDebugging(
    `[Hapii] getAllMcpConfigs: claudeaiMcpServers (after policy filter)=${Object.keys(claudeaiMcpServers).length}`,
    { level: 'info' },
  )

  // 抑制与已启用的手动服务器重复的 claude.ai 连接器。
  // 键永远不会冲突（`slack` 对 `claude.ai Slack`），因此下面的合并
  // 无法捕获这种情况——需要按 URL 签名进行基于内容的去重。
  const { servers: dedupedClaudeAi } = dedupClaudeAiMcpServers(
    claudeaiMcpServers as Record<string, ScopedMcpServerConfig>,
    claudeCodeServers,
  )
  logForDebugging(
    `[Hapii] getAllMcpConfigs: dedupedClaudeAi=${Object.keys(dedupedClaudeAi).length}`,
    { level: 'info' },
  )

  // 合并，claude.ai 优先级最低
  const servers = Object.assign({}, dedupedClaudeAi, claudeCodeServers)
  logForDebugging(
    `[Hapii] getAllMcpConfigs: total servers=${Object.keys(servers).length}, errors=${errors.length}`,
    { level: 'info' },
  )
  logForDebugging(`[Hapii] -------- getAllMcpConfigs 结束 --------`, {
    level: 'info',
  })

  return { servers, errors }
}

/**
 * 解析并验证 MCP 配置对象
 * @param params 解析参数
 * @returns 验证后的配置及任何错误
 */
export function parseMcpConfig(params: {
  configObject: unknown
  expandVars: boolean
  scope: ConfigScope
  filePath?: string
}): {
  config: McpJsonConfig | null
  errors: ValidationError[]
} {
  logForDebugging(
    `[Hapii] -------- parseMcpConfig 开始 --------
  scope=${params.scope}
  expandVars=${params.expandVars}
  filePath=${params.filePath ?? 'none'}`,
    { level: 'info' },
  )
  const { configObject, expandVars, scope, filePath } = params
  const schemaResult = McpJsonConfigSchema().safeParse(configObject)
  if (!schemaResult.success) {
    logForDebugging(
      `[Hapii] parseMcpConfig: schema validation failed, issues=${schemaResult.error.issues.length}`,
      { level: 'error' },
    )
    logForDebugging(`[Hapii] -------- parseMcpConfig 结束 --------`, {
      level: 'info',
    })
    return {
      config: null,
      errors: schemaResult.error.issues.map(issue => ({
        ...(filePath && { file: filePath }),
        path: issue.path.join('.'),
        message: 'Does not adhere to MCP server configuration schema',
        mcpErrorMetadata: {
          scope,
          severity: 'fatal',
        },
      })),
    }
  }

  logForDebugging(
    `[Hapii] parseMcpConfig: schema validation passed, serverCount=${Object.keys(schemaResult.data.mcpServers).length}`,
    { level: 'info' },
  )

  // 验证每个服务器并在请求时展开变量
  const errors: ValidationError[] = []
  const validatedServers: Record<string, McpServerConfig> = {}

  for (const [name, config] of Object.entries(schemaResult.data.mcpServers)) {
    logForDebugging(`[Hapii] parseMcpConfig: validating server "${name}"`, {
      level: 'info',
    })
    let configToCheck = config

    if (expandVars) {
      const { expanded, missingVars } = expandEnvVars(config)

      if (missingVars.length > 0) {
        logForDebugging(
          `[Hapii] parseMcpConfig: server "${name}" has missing env vars: ${missingVars.join(', ')}`,
          { level: 'error' },
        )
        errors.push({
          ...(filePath && { file: filePath }),
          path: `mcpServers.${name}`,
          message: `Missing environment variables: ${missingVars.join(', ')}`,
          suggestion: `Set the following environment variables: ${missingVars.join(', ')}`,
          mcpErrorMetadata: {
            scope,
            serverName: name,
            severity: 'warning',
          },
        })
      }

      configToCheck = expanded
    }

    // 检查 Windows 上特定的 npx 使用而没有 cmd 包装器
    if (
      getPlatform() === 'windows' &&
      (!configToCheck.type || configToCheck.type === 'stdio') &&
      'command' in configToCheck &&
      (configToCheck.command === 'npx' ||
        configToCheck.command.endsWith('\\npx') ||
        configToCheck.command.endsWith('/npx'))
    ) {
      logForDebugging(
        `[Hapii] parseMcpConfig: server "${name}" uses npx without cmd wrapper on Windows`,
        { level: 'error' },
      )
      errors.push({
        ...(filePath && { file: filePath }),
        path: `mcpServers.${name}`,
        message: `Windows requires 'cmd /c' wrapper to execute npx`,
        suggestion: `Change command to "cmd" with args ["/c", "npx", ...]. See: https://code.claude.com/docs/en/mcp#configure-mcp-servers`,
        mcpErrorMetadata: {
          scope,
          serverName: name,
          severity: 'warning',
        },
      })
    }

    validatedServers[name] = configToCheck
  }
  logForDebugging(
    `[Hapii] parseMcpConfig: validated ${Object.keys(validatedServers).length} servers, errors=${errors.length}`,
    { level: 'info' },
  )
  logForDebugging(`[Hapii] -------- parseMcpConfig 结束 --------`, {
    level: 'info',
  })
  return {
    config: { mcpServers: validatedServers },
    errors,
  }
}

/**
 * 从文件路径解析并验证 MCP 配置
 * @param params 解析参数
 * @returns 验证后的配置及任何错误
 */
export function parseMcpConfigFromFilePath(params: {
  filePath: string
  expandVars: boolean
  scope: ConfigScope
}): {
  config: McpJsonConfig | null
  errors: ValidationError[]
} {
  logForDebugging(
    `[Hapii] -------- parseMcpConfigFromFilePath 开始 --------
  filePath=${params.filePath}
  scope=${params.scope}
  expandVars=${params.expandVars}`,
    { level: 'info' },
  )
  const { filePath, expandVars, scope } = params
  const fs = getFsImplementation()

  let configContent: string
  try {
    configContent = fs.readFileSync(filePath, { encoding: 'utf8' })
    logForDebugging(
      `[Hapii] parseMcpConfigFromFilePath: read ${configContent.length} bytes from ${filePath}`,
      { level: 'info' },
    )
  } catch (error: unknown) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') {
      logForDebugging(
        `[Hapii] parseMcpConfigFromFilePath: file not found: ${filePath}`,
        { level: 'info' },
      )
      logForDebugging(
        `[Hapii] -------- parseMcpConfigFromFilePath 结束 --------`,
        { level: 'info' },
      )
      return {
        config: null,
        errors: [
          {
            file: filePath,
            path: '',
            message: `MCP config file not found: ${filePath}`,
            suggestion: 'Check that the file path is correct',
            mcpErrorMetadata: {
              scope,
              severity: 'fatal',
            },
          },
        ],
      }
    }
    logForDebugging(
      `[Hapii] parseMcpConfigFromFilePath: read error for ${filePath} (scope=${scope}): ${error}`,
      { level: 'error' },
    )
    logForDebugging(
      `[Hapii] -------- parseMcpConfigFromFilePath 结束 --------`,
      { level: 'info' },
    )
    return {
      config: null,
      errors: [
        {
          file: filePath,
          path: '',
          message: `Failed to read file: ${error}`,
          suggestion: 'Check file permissions and ensure the file exists',
          mcpErrorMetadata: {
            scope,
            severity: 'fatal',
          },
        },
      ],
    }
  }

  const parsedJson = safeParseJSON(configContent)

  if (!parsedJson) {
    logForDebugging(
      `[Hapii] parseMcpConfigFromFilePath: invalid JSON in ${filePath} (scope=${scope}, length=${configContent.length}, first100=${jsonStringify(configContent.slice(0, 100))})`,
      { level: 'error' },
    )
    logForDebugging(
      `[Hapii] -------- parseMcpConfigFromFilePath 结束 --------`,
      { level: 'info' },
    )
    return {
      config: null,
      errors: [
        {
          file: filePath,
          path: '',
          message: `MCP config is not a valid JSON`,
          suggestion: 'Fix the JSON syntax errors in the file',
          mcpErrorMetadata: {
            scope,
            severity: 'fatal',
          },
        },
      ],
    }
  }

  logForDebugging(
    `[Hapii] parseMcpConfigFromFilePath: JSON parsed successfully, calling parseMcpConfig`,
    { level: 'info' },
  )
  const result = parseMcpConfig({
    configObject: parsedJson,
    expandVars,
    scope,
    filePath,
  })
  logForDebugging(
    `[Hapii] parseMcpConfigFromFilePath: parseMcpConfig returned, servers=${result.config ? Object.keys(result.config.mcpServers).length : 0}, errors=${result.errors.length}`,
    { level: 'info' },
  )
  logForDebugging(`[Hapii] -------- parseMcpConfigFromFilePath 结束 --------`, {
    level: 'info',
  })
  return result
}

export const doesEnterpriseMcpConfigExist = memoize((): boolean => {
  logForDebugging(
    `[Hapii] -------- doesEnterpriseMcpConfigExist 开始 --------`,
    { level: 'info' },
  )
  const { config } = parseMcpConfigFromFilePath({
    filePath: getEnterpriseMcpFilePath(),
    expandVars: true,
    scope: 'enterprise',
  })
  const result = config !== null
  logForDebugging(`[Hapii] doesEnterpriseMcpConfigExist: result=${result}`, {
    level: 'info',
  })
  logForDebugging(
    `[Hapii] -------- doesEnterpriseMcpConfigExist 结束 --------`,
    { level: 'info' },
  )
  return result
})

/**
 * 检查 MCP 允许列表策略是否应仅来自托管设置。
 * 当 policySettings 中设置了 allowManagedMcpServersOnly: true 时为真。
 * 启用后，allowedMcpServers 仅从托管设置中读取。
 * 用户仍可以添加自己的 MCP 服务器并通过 deniedMcpServers 拒绝服务器。
 */
export function shouldAllowManagedMcpServersOnly(): boolean {
  return (
    getSettingsForSource('policySettings')?.allowManagedMcpServersOnly === true
  )
}

/**
 * 检查配置中的所有 MCP 服务器是否都被企业 MCP 配置允许。
 */
export function areMcpConfigsAllowedWithEnterpriseMcpConfig(
  configs: Record<string, ScopedMcpServerConfig>,
): boolean {
  // 注意：虽然所有 SDK MCP 服务器从安全角度来看应该是安全的，但我们仍在讨论
  // 执行此操作的最佳方式。同时，我们暂时将其限制为 claude-vscode，以
  // 修复某些启用了企业 MCP 配置的企业客户的 VSCode 扩展。
  // https://anthropic.slack.com/archives/C093UA0KLD7/p1764975463670109
  return Object.values(configs).every(
    c => c.type === 'sdk' && c.name === 'claude-vscode',
  )
}

/**
 * 默认禁用的内置 MCP 服务器。与用户配置的服务器
 *（通过 disabledMcpServers 选择退出）不同，这些需要通过
 * enabledMcpServers 明确选择加入。它们在 /mcp 中显示为已禁用，直到用户启用它们。
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const DEFAULT_DISABLED_BUILTINS: Set<string> = new Set([
  'mcp-chrome',
  ...(feature('CHICAGO_MCP')
    ? [
        (
          require('../../utils/computerUse/common.js') as typeof import('../../utils/computerUse/common.js')
        ).COMPUTER_USE_MCP_SERVER_NAME,
      ]
    : []),
])
/* eslint-enable @typescript-eslint/no-require-imports */

function isDefaultDisabledBuiltin(name: string): boolean {
  return DEFAULT_DISABLED_BUILTINS.has(name)
}

/**
 * 检查 MCP 服务器是否已禁用
 * @param name 服务器名称
 * @returns 如果服务器已禁用则返回 true
 */
export function isMcpServerDisabled(name: string): boolean {
  logForDebugging(
    `[Hapii] -------- isMcpServerDisabled 开始 -------- name=${name}`,
    { level: 'info' },
  )
  const projectConfig = getCurrentProjectConfig()
  if (isDefaultDisabledBuiltin(name)) {
    const enabledServers = projectConfig.enabledMcpServers || []
    const result = !enabledServers.includes(name)
    logForDebugging(
      `[Hapii] isMcpServerDisabled: "${name}" is default-disabled builtin, enabledServers=${enabledServers.join(',')}, result=${result}`,
      { level: 'info' },
    )
    logForDebugging(`[Hapii] -------- isMcpServerDisabled 结束 --------`, {
      level: 'info',
    })
    return result
  }
  const disabledServers = projectConfig.disabledMcpServers || []
  const result = disabledServers.includes(name)
  logForDebugging(
    `[Hapii] isMcpServerDisabled: "${name}" disabledServers=${disabledServers.join(',')}, result=${result}`,
    { level: 'info' },
  )
  logForDebugging(`[Hapii] -------- isMcpServerDisabled 结束 --------`, {
    level: 'info',
  })
  return result
}

function toggleMembership(
  list: string[],
  name: string,
  shouldContain: boolean,
): string[] {
  const contains = list.includes(name)
  if (contains === shouldContain) return list
  return shouldContain ? [...list, name] : list.filter(s => s !== name)
}

/**
 * 启用或禁用 MCP 服务器
 * @param name 服务器名称
 * @param enabled 服务器是否应该启用
 */
export function setMcpServerEnabled(name: string, enabled: boolean): void {
  logForDebugging(
    `[Hapii] -------- setMcpServerEnabled 开始 --------
  name=${name}
  enabled=${enabled}`,
    { level: 'info' },
  )
  const isBuiltinStateChange =
    isDefaultDisabledBuiltin(name) && isMcpServerDisabled(name) === enabled
  logForDebugging(
    `[Hapii] setMcpServerEnabled: isBuiltinStateChange=${isBuiltinStateChange}`,
    { level: 'info' },
  )

  saveCurrentProjectConfig(current => {
    if (isDefaultDisabledBuiltin(name)) {
      const prev = current.enabledMcpServers || []
      const next = toggleMembership(prev, name, enabled)
      if (next === prev) return current
      logForDebugging(
        `[Hapii] setMcpServerEnabled: updated enabledMcpServers for "${name}", prev=${prev.join(',')}, next=${next.join(',')}`,
        { level: 'info' },
      )
      return { ...current, enabledMcpServers: next }
    }

    const prev = current.disabledMcpServers || []
    const next = toggleMembership(prev, name, !enabled)
    if (next === prev) return current
    logForDebugging(
      `[Hapii] setMcpServerEnabled: updated disabledMcpServers for "${name}", prev=${prev.join(',')}, next=${next.join(',')}`,
      { level: 'info' },
    )
    return { ...current, disabledMcpServers: next }
  })

  if (isBuiltinStateChange) {
    logForDebugging(
      `[Hapii] setMcpServerEnabled: logging analytics event for builtin toggle`,
      { level: 'info' },
    )
    logEvent('tengu_builtin_mcp_toggle', {
      serverName:
        name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      enabled,
    })
  }
  logForDebugging(`[Hapii] -------- setMcpServerEnabled 结束 --------`, {
    level: 'info',
  })
}
