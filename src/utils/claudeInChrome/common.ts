import { readdirSync } from 'fs'
import { stat } from 'fs/promises'
import { homedir, platform, tmpdir, userInfo } from 'os'
import { join } from 'path'
import { normalizeNameForMCP } from '../../services/mcp/normalization.js'
import { logForDebugging } from '../debug.js'
import { isFsInaccessible } from '../errors.js'
import { execFileNoThrow } from '../execFileNoThrow.js'
import { getPlatform } from '../platform.js'
import { which } from '../which.js'

export const CLAUDE_IN_CHROME_MCP_SERVER_NAME = 'claude-in-chrome'

// 为 setup.ts 重新导出 ChromiumBrowser 类型
export type { ChromiumBrowser } from './setupPortable.js'

// 本地使用的 import
import type { ChromiumBrowser } from './setupPortable.js'

type BrowserConfig = {
  name: string
  macos: {
    appName: string
    dataPath: string[]
    nativeMessagingPath: string[]
  }
  linux: {
    binaries: string[]
    dataPath: string[]
    nativeMessagingPath: string[]
  }
  windows: {
    dataPath: string[]
    registryKey: string
    useRoaming?: boolean // Opera 使用 Roaming 而非 Local
  }
}

export const CHROMIUM_BROWSERS: Record<ChromiumBrowser, BrowserConfig> = {
  chrome: {
    name: 'Google Chrome',
    macos: {
      appName: 'Google Chrome',
      dataPath: ['Library', 'Application Support', 'Google', 'Chrome'],
      nativeMessagingPath: [
        'Library',
        'Application Support',
        'Google',
        'Chrome',
        'NativeMessagingHosts',
      ],
    },
    linux: {
      binaries: ['google-chrome', 'google-chrome-stable'],
      dataPath: ['.config', 'google-chrome'],
      nativeMessagingPath: ['.config', 'google-chrome', 'NativeMessagingHosts'],
    },
    windows: {
      dataPath: ['Google', 'Chrome', 'User Data'],
      registryKey: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
    },
  },
  brave: {
    name: 'Brave',
    macos: {
      appName: 'Brave Browser',
      dataPath: [
        'Library',
        'Application Support',
        'BraveSoftware',
        'Brave-Browser',
      ],
      nativeMessagingPath: [
        'Library',
        'Application Support',
        'BraveSoftware',
        'Brave-Browser',
        'NativeMessagingHosts',
      ],
    },
    linux: {
      binaries: ['brave-browser', 'brave'],
      dataPath: ['.config', 'BraveSoftware', 'Brave-Browser'],
      nativeMessagingPath: [
        '.config',
        'BraveSoftware',
        'Brave-Browser',
        'NativeMessagingHosts',
      ],
    },
    windows: {
      dataPath: ['BraveSoftware', 'Brave-Browser', 'User Data'],
      registryKey:
        'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
    },
  },
  arc: {
    name: 'Arc',
    macos: {
      appName: 'Arc',
      dataPath: ['Library', 'Application Support', 'Arc', 'User Data'],
      nativeMessagingPath: [
        'Library',
        'Application Support',
        'Arc',
        'User Data',
        'NativeMessagingHosts',
      ],
    },
    linux: {
      // Arc 在 Linux 上不可用
      binaries: [],
      dataPath: [],
      nativeMessagingPath: [],
    },
    windows: {
      // Arc Windows 基于 Chromium
      dataPath: ['Arc', 'User Data'],
      registryKey: 'HKCU\\Software\\ArcBrowser\\Arc\\NativeMessagingHosts',
    },
  },
  chromium: {
    name: 'Chromium',
    macos: {
      appName: 'Chromium',
      dataPath: ['Library', 'Application Support', 'Chromium'],
      nativeMessagingPath: [
        'Library',
        'Application Support',
        'Chromium',
        'NativeMessagingHosts',
      ],
    },
    linux: {
      binaries: ['chromium', 'chromium-browser'],
      dataPath: ['.config', 'chromium'],
      nativeMessagingPath: ['.config', 'chromium', 'NativeMessagingHosts'],
    },
    windows: {
      dataPath: ['Chromium', 'User Data'],
      registryKey: 'HKCU\\Software\\Chromium\\NativeMessagingHosts',
    },
  },
  edge: {
    name: 'Microsoft Edge',
    macos: {
      appName: 'Microsoft Edge',
      dataPath: ['Library', 'Application Support', 'Microsoft Edge'],
      nativeMessagingPath: [
        'Library',
        'Application Support',
        'Microsoft Edge',
        'NativeMessagingHosts',
      ],
    },
    linux: {
      binaries: ['microsoft-edge', 'microsoft-edge-stable'],
      dataPath: ['.config', 'microsoft-edge'],
      nativeMessagingPath: [
        '.config',
        'microsoft-edge',
        'NativeMessagingHosts',
      ],
    },
    windows: {
      dataPath: ['Microsoft', 'Edge', 'User Data'],
      registryKey: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
    },
  },
  vivaldi: {
    name: 'Vivaldi',
    macos: {
      appName: 'Vivaldi',
      dataPath: ['Library', 'Application Support', 'Vivaldi'],
      nativeMessagingPath: [
        'Library',
        'Application Support',
        'Vivaldi',
        'NativeMessagingHosts',
      ],
    },
    linux: {
      binaries: ['vivaldi', 'vivaldi-stable'],
      dataPath: ['.config', 'vivaldi'],
      nativeMessagingPath: ['.config', 'vivaldi', 'NativeMessagingHosts'],
    },
    windows: {
      dataPath: ['Vivaldi', 'User Data'],
      registryKey: 'HKCU\\Software\\Vivaldi\\NativeMessagingHosts',
    },
  },
  opera: {
    name: 'Opera',
    macos: {
      appName: 'Opera',
      dataPath: ['Library', 'Application Support', 'com.operasoftware.Opera'],
      nativeMessagingPath: [
        'Library',
        'Application Support',
        'com.operasoftware.Opera',
        'NativeMessagingHosts',
      ],
    },
    linux: {
      binaries: ['opera'],
      dataPath: ['.config', 'opera'],
      nativeMessagingPath: ['.config', 'opera', 'NativeMessagingHosts'],
    },
    windows: {
      dataPath: ['Opera Software', 'Opera Stable'],
      registryKey:
        'HKCU\\Software\\Opera Software\\Opera Stable\\NativeMessagingHosts',
      useRoaming: true, // Opera 使用 Roaming AppData，而非 Local
    },
  },
}

// 浏览器检测的优先级顺序（最常见的优先）
export const BROWSER_DETECTION_ORDER: ChromiumBrowser[] = [
  'chrome',
  'brave',
  'arc',
  'edge',
  'chromium',
  'vivaldi',
  'opera',
]

/**
 * 获取所有浏览器数据路径以检查扩展安装
 */
export function getAllBrowserDataPaths(): {
  browser: ChromiumBrowser
  path: string
}[] {
  const platform = getPlatform()
  const home = homedir()
  const paths: { browser: ChromiumBrowser; path: string }[] = []

  for (const browserId of BROWSER_DETECTION_ORDER) {
    const config = CHROMIUM_BROWSERS[browserId]
    let dataPath: string[] | undefined

    switch (platform) {
      case 'macos':
        dataPath = config.macos.dataPath
        break
      case 'linux':
      case 'wsl':
        dataPath = config.linux.dataPath
        break
      case 'windows': {
        if (config.windows.dataPath.length > 0) {
          const appDataBase = config.windows.useRoaming
            ? join(home, 'AppData', 'Roaming')
            : join(home, 'AppData', 'Local')
          paths.push({
            browser: browserId,
            path: join(appDataBase, ...config.windows.dataPath),
          })
        }
        continue
      }
    }

    if (dataPath && dataPath.length > 0) {
      paths.push({
        browser: browserId,
        path: join(home, ...dataPath),
      })
    }
  }

  return paths
}

/**
 * 获取所有受支持浏览器的原生消息宿主目录
 */
export function getAllNativeMessagingHostsDirs(): {
  browser: ChromiumBrowser
  path: string
}[] {
  const platform = getPlatform()
  const home = homedir()
  const paths: { browser: ChromiumBrowser; path: string }[] = []

  for (const browserId of BROWSER_DETECTION_ORDER) {
    const config = CHROMIUM_BROWSERS[browserId]

    switch (platform) {
      case 'macos':
        if (config.macos.nativeMessagingPath.length > 0) {
          paths.push({
            browser: browserId,
            path: join(home, ...config.macos.nativeMessagingPath),
          })
        }
        break
      case 'linux':
      case 'wsl':
        if (config.linux.nativeMessagingPath.length > 0) {
          paths.push({
            browser: browserId,
            path: join(home, ...config.linux.nativeMessagingPath),
          })
        }
        break
      case 'windows':
        // Windows 使用注册表而非文件路径进行原生消息通信
        // 我们将为 manifest 文件使用一个通用位置
        break
    }
  }

  return paths
}

/**
 * 获取所有受支持浏览器的 Windows 注册表键
 */
export function getAllWindowsRegistryKeys(): {
  browser: ChromiumBrowser
  key: string
}[] {
  const keys: { browser: ChromiumBrowser; key: string }[] = []

  for (const browserId of BROWSER_DETECTION_ORDER) {
    const config = CHROMIUM_BROWSERS[browserId]
    if (config.windows.registryKey) {
      keys.push({
        browser: browserId,
        key: config.windows.registryKey,
      })
    }
  }

  return keys
}

/**
 * 检测应使用哪个浏览器打开 URL
 * 返回第一个可用的浏览器，若无则返回 null
 */
export async function detectAvailableBrowser(): Promise<ChromiumBrowser | null> {
  const platform = getPlatform()

  for (const browserId of BROWSER_DETECTION_ORDER) {
    const config = CHROMIUM_BROWSERS[browserId]

    switch (platform) {
      case 'macos': {
        // 检查 .app bundle（一个目录）是否存在
        const appPath = `/Applications/${config.macos.appName}.app`
        try {
          const stats = await stat(appPath)
          if (stats.isDirectory()) {
            logForDebugging(
              `[Claude in Chrome] Detected browser: ${config.name}`,
            )
            return browserId
          }
        } catch (e) {
          if (!isFsInaccessible(e)) throw e
          // 未找到 App，继续检查
        }
        break
      }
      case 'wsl':
      case 'linux': {
        // 检查是否有任何二进制文件存在
        for (const binary of config.linux.binaries) {
          if (await which(binary).catch(() => null)) {
            logForDebugging(
              `[Claude in Chrome] Detected browser: ${config.name}`,
            )
            return browserId
          }
        }
        break
      }
      case 'windows': {
        // 检查数据路径是否存在（表示浏览器已安装）
        const home = homedir()
        if (config.windows.dataPath.length > 0) {
          const appDataBase = config.windows.useRoaming
            ? join(home, 'AppData', 'Roaming')
            : join(home, 'AppData', 'Local')
          const dataPath = join(appDataBase, ...config.windows.dataPath)
          try {
            const stats = await stat(dataPath)
            if (stats.isDirectory()) {
              logForDebugging(
                `[Claude in Chrome] Detected browser: ${config.name}`,
              )
              return browserId
            }
          } catch (e) {
            if (!isFsInaccessible(e)) throw e
            // 未找到浏览器，继续检查
          }
        }
        break
      }
    }
  }

  return null
}

export function isClaudeInChromeMCPServer(name: string): boolean {
  return normalizeNameForMCP(name) === CLAUDE_IN_CHROME_MCP_SERVER_NAME
}

const MAX_TRACKED_TABS = 200
const trackedTabIds = new Set<number>()

export function trackClaudeInChromeTabId(tabId: number): void {
  if (trackedTabIds.size >= MAX_TRACKED_TABS && !trackedTabIds.has(tabId)) {
    trackedTabIds.clear()
  }
  trackedTabIds.add(tabId)
}

export function isTrackedClaudeInChromeTabId(tabId: number): boolean {
  return trackedTabIds.has(tabId)
}

export async function openInChrome(url: string): Promise<boolean> {
  const currentPlatform = getPlatform()

  // 检测最佳可用浏览器
  const browser = await detectAvailableBrowser()

  if (!browser) {
    logForDebugging('[Claude in Chrome] No compatible browser found')
    return false
  }

  const config = CHROMIUM_BROWSERS[browser]

  switch (currentPlatform) {
    case 'macos': {
      const { code } = await execFileNoThrow('open', [
        '-a',
        config.macos.appName,
        url,
      ])
      return code === 0
    }
    case 'windows': {
      // 使用 rundll32 以避免 cmd.exe 元字符问题（URL 中可能包含 & | > <）
      const { code } = await execFileNoThrow('rundll32', ['url,OpenURL', url])
      return code === 0
    }
    case 'wsl':
    case 'linux': {
      for (const binary of config.linux.binaries) {
        const { code } = await execFileNoThrow(binary, [url])
        if (code === 0) {
          return true
        }
      }
      return false
    }
    default:
      return false
  }
}

/**
 * 获取 socket 目录路径（仅 Unix）
 */
export function getSocketDir(): string {
  return `/tmp/claude-mcp-browser-bridge-${getUsername()}`
}

/**
 * 获取 socket 路径（Unix）或管道名（Windows）
 */
export function getSecureSocketPath(): string {
  if (platform() === 'win32') {
    return `\\\\.\\pipe\\${getSocketName()}`
  }
  return join(getSocketDir(), `${process.pid}.sock`)
}

/**
 * 获取所有 socket 路径，包括目录中基于 PID 的 socket
 * 和旧版回退路径
 */
export function getAllSocketPaths(): string[] {
  // Windows 使用命名管道，而非 Unix socket
  if (platform() === 'win32') {
    return [`\\\\.\\pipe\\${getSocketName()}`]
  }

  const paths: string[] = []
  const socketDir = getSocketDir()

  // 扫描 socket 目录下的 *.sock 文件
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs -- ClaudeForChromeContext.getSocketPaths（外部 @ant/claude-for-chrome-mcp）需要同步的 () => string[] 回调
    const files = readdirSync(socketDir)
    for (const file of files) {
      if (file.endsWith('.sock')) {
        paths.push(join(socketDir, file))
      }
    }
  } catch {
    // 目录可能尚未存在
  }

  // 旧版回退路径
  const legacyName = `claude-mcp-browser-bridge-${getUsername()}`
  const legacyTmpdir = join(tmpdir(), legacyName)
  const legacyTmp = `/tmp/${legacyName}`

  if (!paths.includes(legacyTmpdir)) {
    paths.push(legacyTmpdir)
  }
  if (legacyTmpdir !== legacyTmp && !paths.includes(legacyTmp)) {
    paths.push(legacyTmp)
  }

  return paths
}

function getSocketName(): string {
  // 注意：此处必须与 Claude in Chrome MCP 中使用的一致
  return `claude-mcp-browser-bridge-${getUsername()}`
}

function getUsername(): string {
  try {
    return userInfo().username || 'default'
  } catch {
    return process.env.USER || process.env.USERNAME || 'default'
  }
}
