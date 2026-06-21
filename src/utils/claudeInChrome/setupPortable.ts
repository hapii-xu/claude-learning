import { readdir } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { isFsInaccessible } from '../errors.js'

export const CHROME_EXTENSION_URL = 'https://claude.ai/chrome'

// 生产环境扩展 ID
const PROD_EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn'
// 开发环境扩展 ID（仅供内部使用）
const DEV_EXTENSION_ID = 'dihbgbndebgnbjfmelmegjepbnkhlgni'
const ANT_EXTENSION_ID = 'dngcpimnedloihjnnfngkgjoidhnaolf'

function getExtensionIds(): string[] {
  return process.env.USER_TYPE === 'ant'
    ? [PROD_EXTENSION_ID, DEV_EXTENSION_ID, ANT_EXTENSION_ID]
    : [PROD_EXTENSION_ID]
}

// 必须与 common.ts 中的 ChromiumBrowser 一致
export type ChromiumBrowser =
  | 'chrome'
  | 'brave'
  | 'arc'
  | 'chromium'
  | 'edge'
  | 'vivaldi'
  | 'opera'

export type BrowserPath = {
  browser: ChromiumBrowser
  path: string
}

type Logger = (message: string) => void

// 浏览器检测顺序 - 必须与 common.ts 中的 BROWSER_DETECTION_ORDER 一致
const BROWSER_DETECTION_ORDER: ChromiumBrowser[] = [
  'chrome',
  'brave',
  'arc',
  'edge',
  'chromium',
  'vivaldi',
  'opera',
]

type BrowserDataConfig = {
  macos: string[]
  linux: string[]
  windows: { path: string[]; useRoaming?: boolean }
}

// 必须与 common.ts 中的 CHROMIUM_BROWSERS dataPath 一致
const CHROMIUM_BROWSERS: Record<ChromiumBrowser, BrowserDataConfig> = {
  chrome: {
    macos: ['Library', 'Application Support', 'Google', 'Chrome'],
    linux: ['.config', 'google-chrome'],
    windows: { path: ['Google', 'Chrome', 'User Data'] },
  },
  brave: {
    macos: ['Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'],
    linux: ['.config', 'BraveSoftware', 'Brave-Browser'],
    windows: { path: ['BraveSoftware', 'Brave-Browser', 'User Data'] },
  },
  arc: {
    macos: ['Library', 'Application Support', 'Arc', 'User Data'],
    linux: [],
    windows: { path: ['Arc', 'User Data'] },
  },
  chromium: {
    macos: ['Library', 'Application Support', 'Chromium'],
    linux: ['.config', 'chromium'],
    windows: { path: ['Chromium', 'User Data'] },
  },
  edge: {
    macos: ['Library', 'Application Support', 'Microsoft Edge'],
    linux: ['.config', 'microsoft-edge'],
    windows: { path: ['Microsoft', 'Edge', 'User Data'] },
  },
  vivaldi: {
    macos: ['Library', 'Application Support', 'Vivaldi'],
    linux: ['.config', 'vivaldi'],
    windows: { path: ['Vivaldi', 'User Data'] },
  },
  opera: {
    macos: ['Library', 'Application Support', 'com.operasoftware.Opera'],
    linux: ['.config', 'opera'],
    windows: { path: ['Opera Software', 'Opera Stable'], useRoaming: true },
  },
}

/**
 * 获取所有浏览器数据路径以检查扩展安装。
 * 可移植版本，直接使用 process.platform。
 */
export function getAllBrowserDataPathsPortable(): BrowserPath[] {
  const home = homedir()
  const paths: BrowserPath[] = []

  for (const browserId of BROWSER_DETECTION_ORDER) {
    const config = CHROMIUM_BROWSERS[browserId]
    let dataPath: string[] | undefined

    switch (process.platform) {
      case 'darwin':
        dataPath = config.macos
        break
      case 'linux':
        dataPath = config.linux
        break
      case 'win32': {
        if (config.windows.path.length > 0) {
          const appDataBase = config.windows.useRoaming
            ? join(home, 'AppData', 'Roaming')
            : join(home, 'AppData', 'Local')
          paths.push({
            browser: browserId,
            path: join(appDataBase, ...config.windows.path),
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
 * 通过检查所有受支持的基于 Chromium 的浏览器及其配置文件的
 * Extensions 目录来检测 Claude in Chrome 扩展是否已安装。
 *
 * 这是一个可移植版本，TUI 和 VS Code 扩展都可使用。
 *
 * @param browserPaths - 要检查的浏览器数据路径数组（来自 getAllBrowserDataPaths）
 * @param log - 可选的调试日志回调
 * @returns 包含 isInstalled 布尔值和找到扩展的浏览器的对象
 */
export async function detectExtensionInstallationPortable(
  browserPaths: BrowserPath[],
  log?: Logger,
): Promise<{
  isInstalled: boolean
  browser: ChromiumBrowser | null
}> {
  if (browserPaths.length === 0) {
    log?.(`[Claude in Chrome] No browser paths to check`)
    return { isInstalled: false, browser: null }
  }

  const extensionIds = getExtensionIds()

  // 检查每个浏览器中是否存在该扩展
  for (const { browser, path: browserBasePath } of browserPaths) {
    let browserProfileEntries = []

    try {
      browserProfileEntries = await readdir(browserBasePath, {
        withFileTypes: true,
      })
    } catch (e) {
      // 浏览器未安装或路径不存在，继续检查下一个浏览器
      if (isFsInaccessible(e)) continue
      throw e
    }

    const profileDirs = browserProfileEntries
      .filter(entry => entry.isDirectory())
      .filter(
        entry => entry.name === 'Default' || entry.name.startsWith('Profile '),
      )
      .map(entry => entry.name)

    if (profileDirs.length > 0) {
      log?.(
        `[Claude in Chrome] Found ${browser} profiles: ${profileDirs.join(', ')}`,
      )
    }

    // 检查每个配置文件中是否存在任一扩展 ID
    for (const profile of profileDirs) {
      for (const extensionId of extensionIds) {
        const extensionPath = join(
          browserBasePath,
          profile,
          'Extensions',
          extensionId,
        )

        try {
          await readdir(extensionPath)
          log?.(
            `[Claude in Chrome] Extension ${extensionId} found in ${browser} ${profile}`,
          )
          return { isInstalled: true, browser }
        } catch {
          // 此配置文件中未找到扩展，继续检查
        }
      }
    }
  }

  log?.(`[Claude in Chrome] Extension not found in any browser`)
  return { isInstalled: false, browser: null }
}

/**
 * 简单封装，仅返回布尔结果
 */
export async function isChromeExtensionInstalledPortable(
  browserPaths: BrowserPath[],
  log?: Logger,
): Promise<boolean> {
  const result = await detectExtensionInstallationPortable(browserPaths, log)
  return result.isInstalled
}

/**
 * 便捷函数，自动获取浏览器路径。
 * 当不需要提供自定义浏览器路径时使用。
 */
export function isChromeExtensionInstalled(log?: Logger): Promise<boolean> {
  const browserPaths = getAllBrowserDataPathsPortable()
  return isChromeExtensionInstalledPortable(browserPaths, log)
}
