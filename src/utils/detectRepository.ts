import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { getRemoteUrl } from './git.js'

export type ParsedRepository = {
  host: string
  owner: string
  name: string
}

const repositoryWithHostCache = new Map<string, ParsedRepository | null>()

export function clearRepositoryCaches(): void {
  repositoryWithHostCache.clear()
}

export async function detectCurrentRepository(): Promise<string | null> {
  const result = await detectCurrentRepositoryWithHost()
  if (!result) return null
  // 仅返回 github.com 的结果，避免破坏下游消费者
  // 他们假设结果是 github.com 仓库。
  // 需要 GHE 支持请使用 detectCurrentRepositoryWithHost()。
  if (result.host !== 'github.com') return null
  return `${result.owner}/${result.name}`
}

/**
 * 与 detectCurrentRepository 相同，但还会返回主机名（如 "github.com"
 * 或 GHE 主机名）。需要针对特定 GitHub 主机构造 URL 的调用方
 * 应使用此变体。
 */
export async function detectCurrentRepositoryWithHost(): Promise<ParsedRepository | null> {
  const cwd = getCwd()

  if (repositoryWithHostCache.has(cwd)) {
    return repositoryWithHostCache.get(cwd) ?? null
  }

  try {
    const remoteUrl = await getRemoteUrl()
    logForDebugging(`Git remote URL: ${remoteUrl}`)
    if (!remoteUrl) {
      logForDebugging('No git remote URL found')
      repositoryWithHostCache.set(cwd, null)
      return null
    }

    const parsed = parseGitRemote(remoteUrl)
    logForDebugging(
      `Parsed repository: ${parsed ? `${parsed.host}/${parsed.owner}/${parsed.name}` : null} from URL: ${remoteUrl}`,
    )
    repositoryWithHostCache.set(cwd, parsed)
    return parsed
  } catch (error) {
    logForDebugging(`Error detecting repository: ${error}`)
    repositoryWithHostCache.set(cwd, null)
    return null
  }
}

/**
 * 同步返回当前 cwd 已缓存的 github.com 仓库，格式为 "owner/name"，
 * 若尚未解析或主机不是 github.com 则返回 null。
 * 请先调用 detectCurrentRepository() 以填充缓存。
 *
 * 调用方构造 github.com URL，因此此处过滤掉 GHE 主机。
 */
export function getCachedRepository(): string | null {
  const parsed = repositoryWithHostCache.get(getCwd())
  if (!parsed || parsed.host !== 'github.com') return null
  return `${parsed.owner}/${parsed.name}`
}

/**
 * 将 git 远程 URL 解析为主机、所有者和名称组件。
 * 接受任何主机（github.com、GHE 实例等）。
 *
 * 支持：
 *   https://host/owner/repo.git
 *   git@host:owner/repo.git
 *   ssh://git@host/owner/repo.git
 *   git://host/owner/repo.git
 *   https://host/owner/repo（无 .git）
 *
 * 注意：仓库名可以包含点（如 cc.kurs.web）
 */
export function parseGitRemote(input: string): ParsedRepository | null {
  const trimmed = input.trim()

  // SSH 格式：git@host:owner/repo.git
  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (sshMatch?.[1] && sshMatch[2] && sshMatch[3]) {
    if (!looksLikeRealHostname(sshMatch[1])) return null
    return {
      host: sshMatch[1],
      owner: sshMatch[2],
      name: sshMatch[3],
    }
  }

  // URL 格式：https://host/owner/repo.git、ssh://git@host/owner/repo、git://host/owner/repo
  const urlMatch = trimmed.match(
    /^(https?|ssh|git):\/\/(?:[^@]+@)?([^/:]+(?::\d+)?)\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  )
  if (urlMatch?.[1] && urlMatch[2] && urlMatch[3] && urlMatch[4]) {
    const protocol = urlMatch[1]
    const hostWithPort = urlMatch[2]
    const hostWithoutPort = hostWithPort.split(':')[0] ?? ''
    if (!looksLikeRealHostname(hostWithoutPort)) return null
    // 仅对 HTTPS 保留端口 —— SSH/git 端口无法用于构造
    // Web URL（如 ssh://git@ghe.corp.com:2222 → 端口 2222 是 SSH 而非 HTTPS）。
    const host =
      protocol === 'https' || protocol === 'http'
        ? hostWithPort
        : hostWithoutPort
    return {
      host,
      owner: urlMatch[3],
      name: urlMatch[4],
    }
  }

  return null
}

/**
 * 解析 git 远程 URL 或 "owner/repo" 字符串并返回 "owner/repo"。
 * 仅返回 github.com 主机的结果 —— GHE URL 返回 null。
 * 需要 GHE 支持请使用 parseGitRemote()。
 * 为向后兼容也接受纯 "owner/repo" 字符串。
 */
export function parseGitHubRepository(input: string): string | null {
  const trimmed = input.trim()

  // 先尝试作为完整远程 URL 解析。
  // 仅返回 github.com 主机的结果 —— 现有调用方（VS Code 扩展、
  // bridge）假设此函数仅适用于 GitHub.com。需要 GHE 支持
  // 请直接使用 parseGitRemote()。
  const parsed = parseGitRemote(trimmed)
  if (parsed) {
    if (parsed.host !== 'github.com') return null
    return `${parsed.owner}/${parsed.name}`
  }

  // 若无 URL 模式匹配，检查是否已是 owner/repo 格式
  if (
    !trimmed.includes('://') &&
    !trimmed.includes('@') &&
    trimmed.includes('/')
  ) {
    const parts = trimmed.split('/')
    if (parts.length === 2 && parts[0] && parts[1]) {
      // 移除 .git 扩展（若存在）
      const repo = parts[1].replace(/\.git$/, '')
      return `${parts[0]}/${repo}`
    }
  }

  logForDebugging(`Could not parse repository from: ${trimmed}`)
  return null
}

/**
 * 检查主机名是否看起来像真实的域名而非 SSH 配置别名。
 * 简单的点检查不够，因为像 "github.com-work" 这样的别名也包含点。
 * 我们还要求最后一段（TLD）纯为字母 —— 真实 TLD（com、org、io、net）
 * 从不包含连字符或数字。
 */
function looksLikeRealHostname(host: string): boolean {
  if (!host.includes('.')) return false
  const lastSegment = host.split('.').pop()
  if (!lastSegment) return false
  // 真实 TLD 纯为字母（如 "com"、"org"、"io"）。
  // SSH 别名如 "github.com-work" 的最后一段 "com-work" 包含连字符。
  return /^[a-zA-Z]+$/.test(lastSegment)
}
