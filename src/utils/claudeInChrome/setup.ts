import { BROWSER_TOOLS } from '@ant/claude-for-chrome-mcp'
import { chmod, mkdir, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import {
  getIsInteractive,
  getIsNonInteractiveSession,
  getSessionBypassPermissionsMode,
} from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { isInBundledMode } from '../bundledMode.js'
import { distRoot } from '../distRoot.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'
import {
  getClaudeConfigHomeDir,
  isEnvDefinedFalsy,
  isEnvTruthy,
} from '../envUtils.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { getPlatform } from '../platform.js'
import { jsonStringify } from '../slowOperations.js'
import {
  CLAUDE_IN_CHROME_MCP_SERVER_NAME,
  getAllBrowserDataPaths,
  getAllNativeMessagingHostsDirs,
  getAllWindowsRegistryKeys,
  openInChrome,
} from './common.js'
import { getChromeSystemPrompt } from './prompt.js'
import { isChromeExtensionInstalledPortable } from './setupPortable.js'

const CHROME_EXTENSION_RECONNECT_URL = 'https://clau.de/chrome/reconnect'

const NATIVE_HOST_IDENTIFIER = 'com.anthropic.claude_code_browser_extension'
const NATIVE_HOST_MANIFEST_NAME = `${NATIVE_HOST_IDENTIFIER}.json`

export function shouldEnableClaudeInChrome(chromeFlag?: boolean): boolean {
  // 在非交互式会话中默认禁用（如 SDK、CI）
  if (getIsNonInteractiveSession() && chromeFlag !== true) {
    return false
  }

  // 检查 CLI 标志
  if (chromeFlag === true) {
    return true
  }
  if (chromeFlag === false) {
    return false
  }

  // 检查环境变量
  if (isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_CFC)) {
    return true
  }
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_ENABLE_CFC)) {
    return false
  }

  // 检查默认配置
  const config = getGlobalConfig()
  if (config.claudeInChromeDefaultEnabled !== undefined) {
    return config.claudeInChromeDefaultEnabled
  }

  return false
}

let shouldAutoEnable: boolean | undefined

export function shouldAutoEnableClaudeInChrome(): boolean {
  if (shouldAutoEnable !== undefined) {
    return shouldAutoEnable
  }

  shouldAutoEnable =
    getIsInteractive() &&
    isChromeExtensionInstalled_CACHED_MAY_BE_STALE() &&
    (process.env.USER_TYPE === 'ant' ||
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_chrome_auto_enable', false))

  return shouldAutoEnable
}

/**
 * 设置 Claude in Chrome MCP server 和工具
 *
 * @returns MCP 配置和允许的工具，若平台不支持则抛出错误
 */
export function setupClaudeInChrome(): {
  mcpConfig: Record<string, ScopedMcpServerConfig>
  allowedTools: string[]
  systemPrompt: string
} {
  const isNativeBuild = isInBundledMode()
  const allowedTools = BROWSER_TOOLS.map(
    tool => `mcp__claude-in-chrome__${tool.name}`,
  )

  const env: Record<string, string> = {}
  if (getSessionBypassPermissionsMode()) {
    env.CLAUDE_CHROME_PERMISSION_MODE = 'skip_all_permission_checks'
  }
  const hasEnv = Object.keys(env).length > 0

  if (isNativeBuild) {
    // 创建一个 wrapper 脚本，使用 --chrome-native-host 调用同一个二进制。这
    // 是必需的，因为原生宿主 manifest 的 "path" 字段不能包含参数。
    const execCommand = `"${process.execPath}" --chrome-native-host`

    // 异步运行不阻塞；尽力而为，因此吞掉错误
    void createWrapperScript(execCommand)
      .then(manifestBinaryPath =>
        installChromeNativeHostManifest(manifestBinaryPath),
      )
      .catch(e =>
        logForDebugging(
          `[Claude in Chrome] Failed to install native host: ${e}`,
          { level: 'error' },
        ),
      )

    return {
      mcpConfig: {
        [CLAUDE_IN_CHROME_MCP_SERVER_NAME]: {
          type: 'stdio' as const,
          command: process.execPath,
          args: ['--claude-in-chrome-mcp'],
          scope: 'dynamic' as const,
          ...(hasEnv && { env }),
        },
      },
      allowedTools,
      systemPrompt: getChromeSystemPrompt(),
    }
  } else {
    const cliPath = join(distRoot, 'cli.js')

    void createWrapperScript(
      `"${process.execPath}" "${cliPath}" --chrome-native-host`,
    )
      .then(manifestBinaryPath =>
        installChromeNativeHostManifest(manifestBinaryPath),
      )
      .catch(e =>
        logForDebugging(
          `[Claude in Chrome] Failed to install native host: ${e}`,
          { level: 'error' },
        ),
      )

    const mcpConfig = {
      [CLAUDE_IN_CHROME_MCP_SERVER_NAME]: {
        type: 'stdio' as const,
        command: process.execPath,
        args: [`${cliPath}`, '--claude-in-chrome-mcp'],
        scope: 'dynamic' as const,
        ...(hasEnv && { env }),
      },
    }

    return {
      mcpConfig,
      allowedTools,
      systemPrompt: getChromeSystemPrompt(),
    }
  }
}

/**
 * 获取所有受支持浏览器的原生消息宿主目录
 * 返回应安装原生宿主 manifest 的目录数组
 */
function getNativeMessagingHostsDirs(): string[] {
  const platform = getPlatform()

  if (platform === 'windows') {
    // Windows 使用单一位置，通过注册表项指向它
    const home = homedir()
    const appData = process.env.APPDATA || join(home, 'AppData', 'Local')
    return [join(appData, 'Claude Code', 'ChromeNativeHost')]
  }

  // macOS 和 Linux：返回所有浏览器的原生消息目录
  return getAllNativeMessagingHostsDirs().map(({ path }) => path)
}

export async function installChromeNativeHostManifest(
  manifestBinaryPath: string,
): Promise<void> {
  const manifestDirs = getNativeMessagingHostsDirs()
  if (manifestDirs.length === 0) {
    throw Error('Claude in Chrome Native Host not supported on this platform')
  }

  const manifest = {
    name: NATIVE_HOST_IDENTIFIER,
    description: 'Claude Code Browser Extension Native Host',
    path: manifestBinaryPath,
    type: 'stdio',
    allowed_origins: [
      `chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/`, // PROD_EXTENSION_ID
      ...(process.env.USER_TYPE === 'ant'
        ? [
            'chrome-extension://dihbgbndebgnbjfmelmegjepbnkhlgni/', // DEV_EXTENSION_ID
            'chrome-extension://dngcpimnedloihjnnfngkgjoidhnaolf/', // ANT_EXTENSION_ID
          ]
        : []),
    ],
  }

  const manifestContent = jsonStringify(manifest, null, 2)
  let anyManifestUpdated = false

  // 将 manifest 安装到所有浏览器目录
  for (const manifestDir of manifestDirs) {
    const manifestPath = join(manifestDir, NATIVE_HOST_MANIFEST_NAME)

    // 检查内容是否匹配以避免不必要的写入
    const existingContent = await readFile(manifestPath, 'utf-8').catch(
      () => null,
    )
    if (existingContent === manifestContent) {
      continue
    }

    try {
      await mkdir(manifestDir, { recursive: true })
      await writeFile(manifestPath, manifestContent)
      logForDebugging(
        `[Claude in Chrome] Installed native host manifest at: ${manifestPath}`,
      )
      anyManifestUpdated = true
    } catch (error) {
      // 记录但不失败 - 浏览器可能未安装
      logForDebugging(
        `[Claude in Chrome] Failed to install manifest at ${manifestPath}: ${error}`,
      )
    }
  }

  // Windows 需要为每个浏览器添加指向 manifest 的注册表项
  if (getPlatform() === 'windows') {
    const manifestPath = join(manifestDirs[0]!, NATIVE_HOST_MANIFEST_NAME)
    registerWindowsNativeHosts(manifestPath)
  }

  // 若重写了任何 manifest 则重启原生宿主
  if (anyManifestUpdated) {
    void isChromeExtensionInstalled().then(isInstalled => {
      if (isInstalled) {
        logForDebugging(
          `[Claude in Chrome] First-time install detected, opening reconnect page in browser`,
        )
        void openInChrome(CHROME_EXTENSION_RECONNECT_URL)
      } else {
        logForDebugging(
          `[Claude in Chrome] First-time install detected, but extension not installed, skipping reconnect`,
        )
      }
    })
  }
}

/**
 * 在 Windows 注册表中为所有受支持的浏览器注册原生宿主
 */
function registerWindowsNativeHosts(manifestPath: string): void {
  const registryKeys = getAllWindowsRegistryKeys()

  for (const { browser, key } of registryKeys) {
    const fullKey = `${key}\\${NATIVE_HOST_IDENTIFIER}`
    // 使用 reg.exe 添加注册表项
    // https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
    void execFileNoThrowWithCwd('reg', [
      'add',
      fullKey,
      '/ve', // 设置默认（未命名）值
      '/t',
      'REG_SZ',
      '/d',
      manifestPath,
      '/f', // 强制覆盖而不提示
    ]).then(result => {
      if (result.code === 0) {
        logForDebugging(
          `[Claude in Chrome] Registered native host for ${browser} in Windows registry: ${fullKey}`,
        )
      } else {
        logForDebugging(
          `[Claude in Chrome] Failed to register native host for ${browser} in Windows registry: ${result.stderr}`,
        )
      }
    })
  }
}

/**
 * 在 ~/.claude/chrome/ 中创建调用指定命令的 wrapper 脚本。这
 * 是必需的，因为 Chrome 的原生宿主 manifest "path" 字段不能包含参数。
 *
 * @param command - 要执行的完整命令（如 "/path/to/claude --chrome-native-host"）
 * @returns wrapper 脚本的路径
 */
async function createWrapperScript(command: string): Promise<string> {
  const platform = getPlatform()
  const chromeDir = join(getClaudeConfigHomeDir(), 'chrome')
  const wrapperPath =
    platform === 'windows'
      ? join(chromeDir, 'chrome-native-host.bat')
      : join(chromeDir, 'chrome-native-host')

  const scriptContent =
    platform === 'windows'
      ? `@echo off
REM Chrome native host wrapper script
REM Generated by Claude Code - do not edit manually
${command}
`
      : `#!/bin/sh
# Chrome native host wrapper script
# Generated by Claude Code - do not edit manually
exec ${command}
`

  // 检查内容是否匹配以避免不必要的写入
  const existingContent = await readFile(wrapperPath, 'utf-8').catch(() => null)
  if (existingContent === scriptContent) {
    return wrapperPath
  }

  await mkdir(chromeDir, { recursive: true })
  await writeFile(wrapperPath, scriptContent)

  if (platform !== 'windows') {
    await chmod(wrapperPath, 0o755)
  }

  logForDebugging(
    `[Claude in Chrome] Created Chrome native host wrapper script: ${wrapperPath}`,
  )
  return wrapperPath
}

/**
 * 获取 Chrome 扩展是否已安装的缓存值。立即从
 * 磁盘缓存返回，在后台更新缓存。
 *
 * 在无法接受阻塞文件系统访问的同步/启动关键路径上使用。若缓存
 * 近期未更新，该值可能已过期。
 *
 * 仅持久化正向检测结果。文件系统扫描的负结果不会缓存，
 * 因为它可能来自一台共享 ~/.claude.json 但本地没有 Chrome 的机器
 * （如使用 bridge 的远程开发环境），缓存它将永久破坏
 * 读取该配置的每台机器上每个会话的自动启用。
 */
function isChromeExtensionInstalled_CACHED_MAY_BE_STALE(): boolean {
  // 在后台更新缓存，不阻塞
  void isChromeExtensionInstalled().then(isInstalled => {
    // 仅持久化正向检测 — 参见文档注释。过期的 `true` 代价
    // 是每个会话一次静默 MCP 连接尝试；过期 `false` 的代价
    // 是自动启用永远无法工作，需手动修复。
    if (!isInstalled) {
      return
    }
    const config = getGlobalConfig()
    if (config.cachedChromeExtensionInstalled !== isInstalled) {
      saveGlobalConfig(prev => ({
        ...prev,
        cachedChromeExtensionInstalled: isInstalled,
      }))
    }
  })

  // 立即从磁盘返回缓存值
  const cached = getGlobalConfig().cachedChromeExtensionInstalled
  return cached ?? false
}

/**
 * 通过检查所有受支持的基于 Chromium 的浏览器及其配置文件的
 * Extensions 目录来检测 Claude in Chrome 扩展是否已安装。
 *
 * @returns 包含 isInstalled 布尔值和找到扩展的浏览器的对象
 */
export async function isChromeExtensionInstalled(): Promise<boolean> {
  const browserPaths = getAllBrowserDataPaths()
  if (browserPaths.length === 0) {
    logForDebugging(
      `[Claude in Chrome] Unsupported platform for extension detection: ${getPlatform()}`,
    )
    return false
  }
  return isChromeExtensionInstalledPortable(browserPaths, logForDebugging)
}
