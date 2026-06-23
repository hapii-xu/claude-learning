import { homedir } from 'os'
import { resolve } from 'path'
import { getErrnoCode } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import type { MarketplaceSource } from './schemas.js'

/**
 * 解析 marketplace 输入字符串并返回相应的 marketplace 源类型。
 * 处理各种输入格式：
 * - Git SSH URL（user@host:path 或 user@host:path.git）
 *   - 标准：git@github.com:owner/repo.git
 *   - GitHub Enterprise SSH 证书：org-123456@github.com:owner/repo.git
 *   - 自定义用户名：deploy@gitlab.com:group/project.git
 *   - 自托管：user@192.168.10.123:path/to/repo
 * - HTTP/HTTPS URL
 * - GitHub 简写（owner/repo）
 * - 本地文件路径（.json 文件）
 * - 本地目录路径
 *
 * @param input marketplace 源输入字符串
 * @returns MarketplaceSource 对象、错误对象，或格式无法识别时返回 null
 */
export async function parseMarketplaceInput(
  input: string,
): Promise<MarketplaceSource | { error: string } | null> {
  const trimmed = input.trim()
  const fs = getFsImplementation()

  // 处理任意有效用户名的 git SSH URL（不仅限于 'git'）
  // 支持：user@host:path、user@host:path.git，以及带 #ref 后缀
  // 用户名可包含：字母数字、点、下划线、连字符
  const sshMatch = trimmed.match(
    /^([a-zA-Z0-9._-]+@[^:]+:.+?(?:\.git)?)(#(.+))?$/,
  )
  if (sshMatch?.[1]) {
    const url = sshMatch[1]
    const ref = sshMatch[3]
    return ref ? { source: 'git', url, ref } : { source: 'git', url }
  }

  // 处理 URL
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    // 若存在则从 URL 中提取片段（ref）
    const fragmentMatch = trimmed.match(/^([^#]+)(#(.+))?$/)
    const urlWithoutFragment = fragmentMatch?.[1] || trimmed
    const ref = fragmentMatch?.[3]

    // 当用户显式提供看起来像 git 仓库的 HTTPS/HTTP URL 时，
    // 使用 git 源类型以克隆而非按 JSON 获取。
    // .git 后缀是 GitHub/GitLab/Bitbucket 的约定。Azure DevOps
    // 在路径中使用 /_git/，没有后缀（追加 .git 会破坏 ADO：
    // TF401019 "repo does not exist"）。若没有此检查，ADO URL 会
    // 落到下方的 source:'url'，尝试将其作为原始 marketplace.json 获取
    // —— HTML 响应解析为 "expected object, received string"。（gh-31256 / CC-299）
    if (
      urlWithoutFragment.endsWith('.git') ||
      urlWithoutFragment.includes('/_git/')
    ) {
      return ref
        ? { source: 'git', url: urlWithoutFragment, ref }
        : { source: 'git', url: urlWithoutFragment }
    }
    // 解析 URL 以检查主机名
    let url: URL
    try {
      url = new URL(urlWithoutFragment)
    } catch (_err) {
      // 不是有效的 URL 无法解析，当作通用 URL 处理
      // new URL() 对无效 URL 抛出 TypeError
      return { source: 'url', url: urlWithoutFragment }
    }

    if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
      const match = url.pathname.match(/^\/([^/]+\/[^/]+?)(\/|\.git|$)/)
      if (match?.[1]) {
        // 用户显式提供了 HTTPS URL —— 通过 'git' 类型保持为 HTTPS
        // 若不存在则添加 .git 后缀以便正确 git clone
        const gitUrl = urlWithoutFragment.endsWith('.git')
          ? urlWithoutFragment
          : `${urlWithoutFragment}.git`
        return ref
          ? { source: 'git', url: gitUrl, ref }
          : { source: 'git', url: gitUrl }
      }
    }
    return { source: 'url', url: urlWithoutFragment }
  }

  // 处理本地路径
  // 在 Windows 上，还识别反斜杠相对路径（.\, ..\)和驱动器号路径（C:\）
  // 这些仅在 Windows 上有效，因为反斜杠在 Unix 上是合法的文件名字符
  const isWindows = process.platform === 'win32'
  const isWindowsPath =
    isWindows &&
    (trimmed.startsWith('.\\') ||
      trimmed.startsWith('..\\') ||
      /^[a-zA-Z]:[/\\]/.test(trimmed))
  if (
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('~') ||
    isWindowsPath
  ) {
    const resolvedPath = resolve(
      trimmed.startsWith('~') ? trimmed.replace(/^~/, homedir()) : trimmed,
    )

    // 对路径执行 stat 以判断是文件还是目录。吞掉所有 stat
    // 错误（ENOENT、EACCES、EPERM 等）并返回错误结果而非
    // 抛出 —— 与旧的从不抛出的 existsSync 行为一致。
    let stats
    try {
      stats = await fs.stat(resolvedPath)
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      return {
        error:
          code === 'ENOENT'
            ? `Path does not exist: ${resolvedPath}`
            : `Cannot access path: ${resolvedPath} (${code ?? e})`,
      }
    }

    if (stats.isFile()) {
      if (resolvedPath.endsWith('.json')) {
        return { source: 'file', path: resolvedPath }
      } else {
        return {
          error: `File path must point to a .json file (marketplace.json), but got: ${resolvedPath}`,
        }
      }
    } else if (stats.isDirectory()) {
      return { source: 'directory', path: resolvedPath }
    } else {
      return {
        error: `Path is neither a file nor a directory: ${resolvedPath}`,
      }
    }
  }

  // 处理 GitHub 简写（owner/repo、owner/repo#ref 或 owner/repo@ref）
  // 同时接受 # 和 @ 作为 ref 分隔符 —— 显示格式化器使用 @，因此用户在
  // 从错误信息或托管设置中复制时自然地输入 @。
  if (trimmed.includes('/') && !trimmed.startsWith('@')) {
    if (trimmed.includes(':')) {
      return null
    }
    // 提取 ref（若存在，可以是 #ref 或 @ref）
    const fragmentMatch = trimmed.match(/^([^#@]+)(?:[#@](.+))?$/)
    const repo = fragmentMatch?.[1] || trimmed
    const ref = fragmentMatch?.[2]
    // 假定为 GitHub 仓库
    return ref ? { source: 'github', repo, ref } : { source: 'github', repo }
  }

  // NPM 包尚未实现
  // 对无法识别的输入返回 null

  return null
}
