import isEqual from 'lodash-es/isEqual.js'
import { toError } from '../errors.js'
import { logError } from '../log.js'
import { getSettingsForSource } from '../settings/settings.js'
import { plural } from '../stringUtils.js'
import { checkGitAvailable } from './gitAvailability.js'
import { getMarketplace } from './marketplaceManager.js'
import type { KnownMarketplace, MarketplaceSource } from './schemas.js'

/**
 * 格式化插件失败详情以供用户显示
 * @param failures - 包含名称和原因的失败数组
 * @param includeReasons - 是否包含失败原因（true 表示完整错误，false 表示摘要）
 * @returns 格式化字符串，如 "plugin-a (reason); plugin-b (reason)" 或 "plugin-a, plugin-b"
 */
export function formatFailureDetails(
  failures: Array<{ name: string; reason?: string; error?: string }>,
  includeReasons: boolean,
): string {
  const maxShow = 2
  const details = failures
    .slice(0, maxShow)
    .map(f => {
      const reason = f.reason || f.error || 'unknown error'
      return includeReasons ? `${f.name} (${reason})` : f.name
    })
    .join(includeReasons ? '; ' : ', ')

  const remaining = failures.length - maxShow
  const moreText = remaining > 0 ? ` and ${remaining} more` : ''

  return `${details}${moreText}`
}

/**
 * 从市场配置中提取来源显示字符串
 */
export function getMarketplaceSourceDisplay(source: MarketplaceSource): string {
  switch (source.source) {
    case 'github':
      return source.repo
    case 'url':
      return source.url
    case 'git':
      return source.url
    case 'directory':
      return source.path
    case 'file':
      return source.path
    case 'settings':
      return `settings:${source.name}`
    default:
      return 'Unknown source'
  }
}

/**
 * 通过插件名称和市场名称创建插件 ID
 */
export function createPluginId(
  pluginName: string,
  marketplaceName: string,
): string {
  return `${pluginName}@${marketplaceName}`
}

/**
 * 加载市场，对单个失败进行优雅降级。
 * 被（企业策略）屏蔽的市场将从结果中排除。
 */
export async function loadMarketplacesWithGracefulDegradation(
  config: Record<string, KnownMarketplace>,
): Promise<{
  marketplaces: Array<{
    name: string
    config: KnownMarketplace
    data: Awaited<ReturnType<typeof getMarketplace>> | null
  }>
  failures: Array<{ name: string; error: string }>
}> {
  const marketplaces: Array<{
    name: string
    config: KnownMarketplace
    data: Awaited<ReturnType<typeof getMarketplace>> | null
  }> = []
  const failures: Array<{ name: string; error: string }> = []

  for (const [name, marketplaceConfig] of Object.entries(config)) {
    // 跳过被企业策略屏蔽的市场
    if (!isSourceAllowedByPolicy(marketplaceConfig.source)) {
      continue
    }

    let data = null
    try {
      data = await getMarketplace(name)
    } catch (err) {
      // 跟踪单个市场失败，但继续加载其他市场
      const errorMessage = err instanceof Error ? err.message : String(err)
      failures.push({ name, error: errorMessage })

      // 记录日志以供监控
      logError(toError(err))
    }

    marketplaces.push({
      name,
      config: marketplaceConfig,
      data,
    })
  }

  return { marketplaces, failures }
}

/**
 * 将市场加载失败格式化为适当的用户消息
 */
export function formatMarketplaceLoadingErrors(
  failures: Array<{ name: string; error: string }>,
  successCount: number,
): { type: 'warning' | 'error'; message: string } | null {
  if (failures.length === 0) {
    return null
  }

  // 如果部分市场成功，显示警告
  if (successCount > 0) {
    const message =
      failures.length === 1
        ? `Warning: Failed to load marketplace '${failures[0]!.name}': ${failures[0]!.error}`
        : `Warning: Failed to load ${failures.length} marketplaces: ${formatFailureNames(failures)}`
    return { type: 'warning', message }
  }

  // 所有市场均失败——这是一个严重错误
  return {
    type: 'error',
    message: `Failed to load all marketplaces. Errors: ${formatFailureErrors(failures)}`,
  }
}

function formatFailureNames(
  failures: Array<{ name: string; error: string }>,
): string {
  return failures.map(f => f.name).join(', ')
}

function formatFailureErrors(
  failures: Array<{ name: string; error: string }>,
): string {
  return failures.map(f => `${f.name}: ${f.error}`).join('; ')
}

/**
 * 从策略设置中获取严格的市场来源允许列表。
 * 如果没有限制则返回 null，否则返回允许的来源数组。
 */
export function getStrictKnownMarketplaces(): MarketplaceSource[] | null {
  const policySettings = getSettingsForSource('policySettings')
  if (!policySettings?.strictKnownMarketplaces) {
    return null // 没有限制
  }
  return policySettings.strictKnownMarketplaces
}

/**
 * 从策略设置中获取市场来源黑名单。
 * 如果没有黑名单则返回 null，否则返回被屏蔽的来源数组。
 */
export function getBlockedMarketplaces(): MarketplaceSource[] | null {
  const policySettings = getSettingsForSource('policySettings')
  if (!policySettings?.blockedMarketplaces) {
    return null // 没有黑名单
  }
  return policySettings.blockedMarketplaces
}

/**
 * 从策略设置中获取自定义插件信任消息。
 * 如果未配置则返回 undefined。
 */
export function getPluginTrustMessage(): string | undefined {
  return getSettingsForSource('policySettings')?.pluginTrustMessage
}

/**
 * 比较两个 MarketplaceSource 对象是否相等。
 * 如果两者类型相同且所有相关字段匹配，则认为来源相等。
 */
function areSourcesEqual(a: MarketplaceSource, b: MarketplaceSource): boolean {
  if (a.source !== b.source) return false

  switch (a.source) {
    case 'url':
      return a.url === (b as typeof a).url
    case 'github':
      return (
        a.repo === (b as typeof a).repo &&
        (a.ref || undefined) === ((b as typeof a).ref || undefined) &&
        (a.path || undefined) === ((b as typeof a).path || undefined)
      )
    case 'git':
      return (
        a.url === (b as typeof a).url &&
        (a.ref || undefined) === ((b as typeof a).ref || undefined) &&
        (a.path || undefined) === ((b as typeof a).path || undefined)
      )
    case 'npm':
      return a.package === (b as typeof a).package
    case 'file':
      return a.path === (b as typeof a).path
    case 'directory':
      return a.path === (b as typeof a).path
    case 'settings':
      return (
        a.name === (b as typeof a).name &&
        isEqual(a.plugins, (b as typeof a).plugins)
      )
    default:
      return false
  }
}

/**
 * 从市场来源中提取主机/域名。
 * 用于 strictKnownMarketplaces 中的 hostPattern 匹配。
 *
 * 目前仅支持 github、git 和 url 来源。
 * npm、file 和 directory 来源不支持 hostPattern 匹配。
 *
 * @param source - 要提取主机的市场来源
 * @returns 主机名字符串，如果提取失败或来源类型不支持则返回 null
 */
export function extractHostFromSource(
  source: MarketplaceSource,
): string | null {
  switch (source.source) {
    case 'github':
      // GitHub 简写始终表示 github.com
      return 'github.com'

    case 'git': {
      // SSH 格式：user@HOST:path（例如 git@github.com:owner/repo.git）
      const sshMatch = source.url.match(/^[^@]+@([^:]+):/)
      if (sshMatch?.[1]) {
        return sshMatch[1]
      }
      // HTTPS 格式：从 URL 中提取主机名
      try {
        return new URL(source.url).hostname
      } catch {
        return null
      }
    }

    case 'url':
      try {
        return new URL(source.url).hostname
      } catch {
        return null
      }

    // npm、file、directory、hostPattern、pathPattern 来源不支持 hostPattern 匹配
    default:
      return null
  }
}

/**
 * 检查来源是否匹配 hostPattern 条目。
 * 从来源中提取主机，并与正则模式进行测试。
 *
 * @param source - 要检查的市场来源
 * @param pattern - 来自 strictKnownMarketplaces 的 hostPattern 条目
 * @returns 如果来源的主机匹配模式则返回 true
 */
function doesSourceMatchHostPattern(
  source: MarketplaceSource,
  pattern: MarketplaceSource & { source: 'hostPattern' },
): boolean {
  const host = extractHostFromSource(source)
  if (!host) {
    return false
  }

  try {
    const regex = new RegExp(pattern.hostPattern)
    return regex.test(host)
  } catch {
    // 无效的正则表达式——记录日志并返回 false
    logError(new Error(`Invalid hostPattern regex: ${pattern.hostPattern}`))
    return false
  }
}

/**
 * 检查来源是否匹配 pathPattern 条目。
 * 将来源的 .path（仅限 file 和 directory 来源）与正则模式进行测试。
 *
 * @param source - 要检查的市场来源
 * @param pattern - 来自 strictKnownMarketplaces 的 pathPattern 条目
 * @returns 如果来源的路径匹配模式则返回 true
 */
function doesSourceMatchPathPattern(
  source: MarketplaceSource,
  pattern: MarketplaceSource & { source: 'pathPattern' },
): boolean {
  // 只有 file 和 directory 来源才有 .path 可供匹配
  if (source.source !== 'file' && source.source !== 'directory') {
    return false
  }

  try {
    const regex = new RegExp(pattern.pathPattern)
    return regex.test(source.path)
  } catch {
    logError(new Error(`Invalid pathPattern regex: ${pattern.pathPattern}`))
    return false
  }
}

/**
 * 从允许列表中的 hostPattern 条目获取主机。
 * 用于提供有用的错误消息。
 */
export function getHostPatternsFromAllowlist(): string[] {
  const allowlist = getStrictKnownMarketplaces()
  if (!allowlist) return []

  return allowlist
    .filter(
      (entry): entry is MarketplaceSource & { source: 'hostPattern' } =>
        entry.source === 'hostPattern',
    )
    .map(entry => entry.hostPattern)
}

/**
 * 如果 git URL 是 GitHub URL，则从中提取 GitHub 的 owner/repo。
 * 如果不是 GitHub URL 则返回 null。
 *
 * 支持以下格式：
 * - git@github.com:owner/repo.git
 * - https://github.com/owner/repo.git
 * - https://github.com/owner/repo
 */
function extractGitHubRepoFromGitUrl(url: string): string | null {
  // SSH 格式：git@github.com:owner/repo.git
  const sshMatch = url.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/)
  if (sshMatch && sshMatch[1]) {
    return sshMatch[1]
  }

  // HTTPS 格式：https://github.com/owner/repo.git 或 https://github.com/owner/repo
  const httpsMatch = url.match(
    /^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/,
  )
  if (httpsMatch && httpsMatch[1]) {
    return httpsMatch[1]
  }

  return null
}

/**
 * 检查黑名单中的 ref/path 约束是否匹配来源。
 * 如果黑名单条目没有 ref/path，则匹配所有 ref/path（通配符）。
 * 如果黑名单条目有特定的 ref/path，则只匹配该精确值。
 */
function blockedConstraintMatches(
  blockedValue: string | undefined,
  sourceValue: string | undefined,
): boolean {
  // 如果黑名单没有指定约束，则为通配符——匹配任何内容
  if (!blockedValue) {
    return true
  }
  // 如果黑名单指定了约束，来源必须精确匹配
  return (blockedValue || undefined) === (sourceValue || undefined)
}

/**
 * 检查两个来源是否指向同一个 GitHub 仓库，即使使用
 * 不同的来源类型（github 与带 GitHub URL 的 git）。
 *
 * 黑名单匹配是非对称的：
 * - 如果黑名单条目没有 ref/path，则屏蔽所有 ref/path（通配符）
 * - 如果黑名单条目有特定的 ref/path，则只屏蔽该精确值
 */
function areSourcesEquivalentForBlocklist(
  source: MarketplaceSource,
  blocked: MarketplaceSource,
): boolean {
  // 检查完全相同的来源类型
  if (source.source === blocked.source) {
    switch (source.source) {
      case 'github': {
        const b = blocked as typeof source
        if (source.repo !== b.repo) return false
        return (
          blockedConstraintMatches(b.ref, source.ref) &&
          blockedConstraintMatches(b.path, source.path)
        )
      }
      case 'git': {
        const b = blocked as typeof source
        if (source.url !== b.url) return false
        return (
          blockedConstraintMatches(b.ref, source.ref) &&
          blockedConstraintMatches(b.path, source.path)
        )
      }
      case 'url':
        return source.url === (blocked as typeof source).url
      case 'npm':
        return source.package === (blocked as typeof source).package
      case 'file':
        return source.path === (blocked as typeof source).path
      case 'directory':
        return source.path === (blocked as typeof source).path
      case 'settings':
        return source.name === (blocked as typeof source).name
      default:
        return false
    }
  }

  // 检查 git 来源是否匹配 github 黑名单条目
  if (source.source === 'git' && blocked.source === 'github') {
    const extractedRepo = extractGitHubRepoFromGitUrl(source.url)
    if (extractedRepo === blocked.repo) {
      return (
        blockedConstraintMatches(blocked.ref, source.ref) &&
        blockedConstraintMatches(blocked.path, source.path)
      )
    }
  }

  // 检查 github 来源是否匹配 git 黑名单条目（GitHub URL）
  if (source.source === 'github' && blocked.source === 'git') {
    const extractedRepo = extractGitHubRepoFromGitUrl(blocked.url)
    if (extractedRepo === source.repo) {
      return (
        blockedConstraintMatches(blocked.ref, source.ref) &&
        blockedConstraintMatches(blocked.path, source.path)
      )
    }
  }

  return false
}

/**
 * 检查市场来源是否明确在黑名单中。
 * 用于区分错误消息。
 *
 * 这也能捕获通过使用 git URL（例如 git@github.com:owner/repo.git 或
 * https://github.com/owner/repo.git）来绕过 github 黑名单条目的尝试。
 */
export function isSourceInBlocklist(source: MarketplaceSource): boolean {
  const blocklist = getBlockedMarketplaces()
  if (blocklist === null) {
    return false
  }
  return blocklist.some(blocked =>
    areSourcesEquivalentForBlocklist(source, blocked),
  )
}

/**
 * 检查市场来源是否被企业策略允许。
 * 如果允许（或没有策略）则返回 true，如果被屏蔽则返回 false。
 * 此检查在下载之前进行，因此被屏蔽的来源永远不会接触文件系统。
 *
 * 策略优先级：
 * 1. blockedMarketplaces（黑名单）——如果来源匹配，则被屏蔽
 * 2. strictKnownMarketplaces（允许列表）——如果已设置，来源必须在列表中
 */
export function isSourceAllowedByPolicy(source: MarketplaceSource): boolean {
  // 首先检查黑名单（优先级更高）
  if (isSourceInBlocklist(source)) {
    return false
  }

  // 然后检查允许列表
  const allowlist = getStrictKnownMarketplaces()
  if (allowlist === null) {
    return true // 没有限制
  }

  // 检查允许列表中的每个条目
  return allowlist.some(allowed => {
    // 处理 hostPattern 条目——通过提取的主机进行匹配
    if (allowed.source === 'hostPattern') {
      return doesSourceMatchHostPattern(source, allowed)
    }
    // 处理 pathPattern 条目——通过正则表达式匹配 file/directory 的 .path
    if (allowed.source === 'pathPattern') {
      return doesSourceMatchPathPattern(source, allowed)
    }
    // 处理常规来源条目——精确匹配
    return areSourcesEqual(source, allowed)
  })
}

/**
 * 格式化 MarketplaceSource 以在错误消息中显示
 */
export function formatSourceForDisplay(source: MarketplaceSource): string {
  switch (source.source) {
    case 'github':
      return `github:${source.repo}${source.ref ? `@${source.ref}` : ''}`
    case 'url':
      return source.url
    case 'git':
      return `git:${source.url}${source.ref ? `@${source.ref}` : ''}`
    case 'npm':
      return `npm:${source.package}`
    case 'file':
      return `file:${source.path}`
    case 'directory':
      return `dir:${source.path}`
    case 'hostPattern':
      return `hostPattern:${source.hostPattern}`
    case 'pathPattern':
      return `pathPattern:${source.pathPattern}`
    case 'settings':
      return `settings:${source.name} (${source.plugins.length} ${plural(source.plugins.length, 'plugin')})`
    default:
      return 'unknown source'
  }
}

/**
 * Discover 页面中无市场可用的原因
 */
export type EmptyMarketplaceReason =
  | 'git-not-installed'
  | 'all-blocked-by-policy'
  | 'policy-restricts-sources'
  | 'all-marketplaces-failed'
  | 'no-marketplaces-configured'
  | 'all-plugins-installed'

/**
 * 检测无市场可用的原因。
 * 按优先级顺序检查：git 可用性 → 策略限制 → 配置状态 → 失败
 */
export async function detectEmptyMarketplaceReason({
  configuredMarketplaceCount,
  failedMarketplaceCount,
}: {
  configuredMarketplaceCount: number
  failedMarketplaceCount: number
}): Promise<EmptyMarketplaceReason> {
  // 检查是否安装了 git（大多数市场来源都需要）
  const gitAvailable = await checkGitAvailable()
  if (!gitAvailable) {
    return 'git-not-installed'
  }

  // 检查策略限制
  const allowlist = getStrictKnownMarketplaces()
  if (allowlist !== null) {
    if (allowlist.length === 0) {
      // 策略明确屏蔽所有市场
      return 'all-blocked-by-policy'
    }
    // 策略限制了可用的来源
    if (configuredMarketplaceCount === 0) {
      return 'policy-restricts-sources'
    }
  }

  // 检查是否配置了任何市场
  if (configuredMarketplaceCount === 0) {
    return 'no-marketplaces-configured'
  }

  // 检查所有已配置的市场是否均加载失败
  if (
    failedMarketplaceCount > 0 &&
    failedMarketplaceCount === configuredMarketplaceCount
  ) {
    return 'all-marketplaces-failed'
  }

  // 市场已配置并加载，但没有可用插件
  // 这通常意味着所有插件都已安装
  return 'all-plugins-installed'
}
