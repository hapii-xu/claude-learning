import { readdir } from 'fs/promises'
import { join } from 'path'
import { coerce as semverCoerce } from 'semver'
import { getSessionId } from '../bootstrap/state.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { pathExists } from './file.js'
import { gte as semverGte } from './semver.js'

const MIN_DESKTOP_VERSION = '1.1.2396'

function isDevMode(): boolean {
  if ((process.env.NODE_ENV as string) === 'development') {
    return true
  }

  // 从 build 目录本地构建即使 NODE_ENV=production 也视为开发模式
  const pathsToCheck = [process.argv[1] || '', process.execPath || '']
  const buildDirs = [
    '/build-ant/',
    '/build-ant-native/',
    '/build-external/',
    '/build-external-native/',
  ]

  return pathsToCheck.some(p => buildDirs.some(dir => p.includes(dir)))
}

/**
 * 构建 Claude Desktop 用于恢复 CLI 会话的深度链接 URL。
 * 格式：claude://resume?session={sessionId}&cwd={cwd}
 * 开发模式：claude-dev://resume?session={sessionId}&cwd={cwd}
 */
function buildDesktopDeepLink(sessionId: string): string {
  const protocol = isDevMode() ? 'claude-dev' : 'claude'
  const url = new URL(`${protocol}://resume`)
  url.searchParams.set('session', sessionId)
  url.searchParams.set('cwd', getCwd())
  return url.toString()
}

/**
 * 检查 Claude Desktop 应用是否已安装。
 * macOS 上检查 /Applications/Claude.app。
 * Linux 上检查 xdg-open 是否能处理 claude:// 协议。
 * Windows 上检查协议处理器是否存在。
 * 开发模式下始终返回 true（假设开发版 Desktop 正在运行）。
 */
async function isDesktopInstalled(): Promise<boolean> {
  // 开发模式下假设开发版 Desktop 应用正在运行
  if (isDevMode()) {
    return true
  }

  const platform = process.platform

  if (platform === 'darwin') {
    // 在 /Applications 中检查 Claude.app
    return pathExists('/Applications/Claude.app')
  } else if (platform === 'linux') {
    // 检查 xdg-mime 是否能找到 claude:// 的处理器
    // 注意：xdg-mime 即使没有处理器也返回退出码 0，因此同时检查 stdout
    const { code, stdout } = await execFileNoThrow('xdg-mime', [
      'query',
      'default',
      'x-scheme-handler/claude',
    ])
    return code === 0 && stdout.trim().length > 0
  } else if (platform === 'win32') {
    // Windows 上尝试查询注册表以获取协议处理器
    const { code } = await execFileNoThrow('reg', [
      'query',
      'HKEY_CLASSES_ROOT\\claude',
      '/ve',
    ])
    return code === 0
  }

  return false
}

/**
 * 检测已安装的 Claude Desktop 版本。
 * macOS 上从应用 plist 读取 CFBundleShortVersionString。
 * Windows 上在 Squirrel 安装目录中找到最高的 app-X.Y.Z 目录。
 * 若无法确定版本则返回 null。
 */
async function getDesktopVersion(): Promise<string | null> {
  const platform = process.platform

  if (platform === 'darwin') {
    const { code, stdout } = await execFileNoThrow('defaults', [
      'read',
      '/Applications/Claude.app/Contents/Info.plist',
      'CFBundleShortVersionString',
    ])
    if (code !== 0) {
      return null
    }
    const version = stdout.trim()
    return version.length > 0 ? version : null
  } else if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (!localAppData) {
      return null
    }
    const installDir = join(localAppData, 'AnthropicClaude')
    try {
      const entries = await readdir(installDir)
      const versions = entries
        .filter(e => e.startsWith('app-'))
        .map(e => e.slice(4))
        .filter(v => semverCoerce(v) !== null)
        .sort((a, b) => {
          const ca = semverCoerce(a)!
          const cb = semverCoerce(b)!
          return ca.compare(cb)
        })
      return versions.length > 0 ? versions[versions.length - 1]! : null
    } catch {
      return null
    }
  }

  return null
}

export type DesktopInstallStatus =
  | { status: 'not-installed' }
  | { status: 'version-too-old'; version: string }
  | { status: 'ready'; version: string }

/**
 * 检查 Desktop 安装状态，包括版本兼容性。
 */
export async function getDesktopInstallStatus(): Promise<DesktopInstallStatus> {
  const installed = await isDesktopInstalled()
  if (!installed) {
    return { status: 'not-installed' }
  }

  let version: string | null
  try {
    version = await getDesktopVersion()
  } catch {
    // 尽力而为 —— 版本检测失败时仍继续 handoff
    return { status: 'ready', version: 'unknown' }
  }

  if (!version) {
    // 无法确定版本 —— 假定已就绪（开发模式或未知安装）
    return { status: 'ready', version: 'unknown' }
  }

  const coerced = semverCoerce(version)
  if (!coerced || !semverGte(coerced.version, MIN_DESKTOP_VERSION)) {
    return { status: 'version-too-old', version }
  }

  return { status: 'ready', version }
}

/**
 * 使用平台特定机制打开深度链接 URL。
 * 命令成功返回 true，否则返回 false。
 */
async function openDeepLink(deepLinkUrl: string): Promise<boolean> {
  const platform = process.platform
  logForDebugging(`Opening deep link: ${deepLinkUrl}`)

  if (platform === 'darwin') {
    if (isDevMode()) {
      // 开发模式下，`open` 会启动裸 Electron 二进制（不含应用代码）
      // 因为 setAsDefaultProtocolClient 仅注册了 Electron 可执行文件。
      // 使用 AppleScript 将 URL 路由到已运行的 Electron 应用。
      const { code } = await execFileNoThrow('osascript', [
        '-e',
        `tell application "Electron" to open location "${deepLinkUrl}"`,
      ])
      return code === 0
    }
    const { code } = await execFileNoThrow('open', [deepLinkUrl])
    return code === 0
  } else if (platform === 'linux') {
    const { code } = await execFileNoThrow('xdg-open', [deepLinkUrl])
    return code === 0
  } else if (platform === 'win32') {
    // Windows 上使用 cmd /c start 打开 URL
    const { code } = await execFileNoThrow('cmd', [
      '/c',
      'start',
      '',
      deepLinkUrl,
    ])
    return code === 0
  }

  return false
}

/**
 * 构建并打开深度链接以在 Claude Desktop 中恢复当前会话。
 * 返回包含成功状态和任何错误信息的对象。
 */
export async function openCurrentSessionInDesktop(): Promise<{
  success: boolean
  error?: string
  deepLinkUrl?: string
}> {
  const sessionId = getSessionId()

  // 检查 Desktop 是否已安装
  const installed = await isDesktopInstalled()
  if (!installed) {
    return {
      success: false,
      error:
        'Claude Desktop is not installed. Install it from https://claude.ai/download',
    }
  }

  // 构建并打开深度链接
  const deepLinkUrl = buildDesktopDeepLink(sessionId)
  const opened = await openDeepLink(deepLinkUrl)

  if (!opened) {
    return {
      success: false,
      error: 'Failed to open Claude Desktop. Please try opening it manually.',
      deepLinkUrl,
    }
  }

  return { success: true, deepLinkUrl }
}
