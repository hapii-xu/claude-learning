import { readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import {
  type McpServerConfig,
  McpStdioServerConfigSchema,
} from '../services/mcp/types.js'
import { getErrnoCode } from './errors.js'
import { safeParseJSON } from './json.js'
import { logError } from './log.js'
import { getPlatform, SUPPORTED_PLATFORMS } from './platform.js'

export async function getClaudeDesktopConfigPath(): Promise<string> {
  const platform = getPlatform()

  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    throw new Error(
      `Unsupported platform: ${platform} - Claude Desktop integration only works on macOS and WSL.`,
    )
  }

  if (platform === 'macos') {
    return join(
      homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    )
  }

  // 首先，尝试使用 USERPROFILE 环境变量（若可用）
  const windowsHome = process.env.USERPROFILE
    ? process.env.USERPROFILE.replace(/\\/g, '/') // 将 Windows 反斜杠转换为正斜杠
    : null

  if (windowsHome) {
    // 移除盘符并转换为 WSL 路径格式
    const wslPath = windowsHome.replace(/^[A-Z]:/, '')
    const configPath = `/mnt/c${wslPath}/AppData/Roaming/Claude/claude_desktop_config.json`

    // 检查文件是否存在
    try {
      await stat(configPath)
      return configPath
    } catch {
      // 文件不存在，继续
    }
  }

  // 替代方案 —— 尝试基于典型 Windows 用户位置构造路径
  try {
    // 列出 /mnt/c/Users 目录以查找潜在的用户目录
    const usersDir = '/mnt/c/Users'

    try {
      const userDirs = await readdir(usersDir, { withFileTypes: true })

      // 在每个用户目录中查找 Claude Desktop 配置
      for (const user of userDirs) {
        if (
          user.name === 'Public' ||
          user.name === 'Default' ||
          user.name === 'Default User' ||
          user.name === 'All Users'
        ) {
          continue // 跳过系统目录
        }

        const potentialConfigPath = join(
          usersDir,
          user.name,
          'AppData',
          'Roaming',
          'Claude',
          'claude_desktop_config.json',
        )

        try {
          await stat(potentialConfigPath)
          return potentialConfigPath
        } catch {
          // 文件不存在，继续
        }
      }
    } catch {
      // usersDir 不存在或无法读取
    }
  } catch (dirError) {
    logError(dirError)
  }

  throw new Error(
    'Could not find Claude Desktop config file in Windows. Make sure Claude Desktop is installed on Windows.',
  )
}

export async function readClaudeDesktopMcpServers(): Promise<
  Record<string, McpServerConfig>
> {
  if (!SUPPORTED_PLATFORMS.includes(getPlatform())) {
    throw new Error(
      'Unsupported platform - Claude Desktop integration only works on macOS and WSL.',
    )
  }
  try {
    const configPath = await getClaudeDesktopConfigPath()

    let configContent: string
    try {
      configContent = await readFile(configPath, { encoding: 'utf8' })
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT') {
        return {}
      }
      throw e
    }

    const config = safeParseJSON(configContent)

    if (!config || typeof config !== 'object') {
      return {}
    }

    const mcpServers = (config as Record<string, unknown>).mcpServers
    if (!mcpServers || typeof mcpServers !== 'object') {
      return {}
    }

    const servers: Record<string, McpServerConfig> = {}

    for (const [name, serverConfig] of Object.entries(
      mcpServers as Record<string, unknown>,
    )) {
      if (!serverConfig || typeof serverConfig !== 'object') {
        continue
      }

      const result = McpStdioServerConfigSchema().safeParse(serverConfig)

      if (result.success) {
        servers[name] = result.data
      }
    }

    return servers
  } catch (error) {
    logError(error)
    return {}
  }
}
