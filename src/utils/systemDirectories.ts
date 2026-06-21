import { homedir } from 'os'
import { join } from 'path'
import { logForDebugging } from './debug.js'
import { getPlatform, type Platform } from './platform.js'

export type SystemDirectories = {
  HOME: string
  DESKTOP: string
  DOCUMENTS: string
  DOWNLOADS: string
  [key: string]: string // 索引签名以与 Record<string, string> 兼容
}

type EnvLike = Record<string, string | undefined>

type SystemDirectoriesOptions = {
  env?: EnvLike
  homedir?: string
  platform?: Platform
}

/**
 * 获取跨平台系统目录
 * 处理 Windows、macOS、Linux 和 WSL 之间的差异
 * @param options 可选的测试覆盖（env、homedir、platform）
 */
export function getSystemDirectories(
  options?: SystemDirectoriesOptions,
): SystemDirectories {
  const platform = options?.platform ?? getPlatform()
  const homeDir = options?.homedir ?? homedir()
  const env = options?.env ?? process.env

  // 大多数平台使用的默认路径
  const defaults: SystemDirectories = {
    HOME: homeDir,
    DESKTOP: join(homeDir, 'Desktop'),
    DOCUMENTS: join(homeDir, 'Documents'),
    DOWNLOADS: join(homeDir, 'Downloads'),
  }

  switch (platform) {
    case 'windows': {
      // Windows：如果可用则使用 USERPROFILE（处理本地化的文件夹名称）
      const userProfile = env.USERPROFILE || homeDir
      return {
        HOME: homeDir,
        DESKTOP: join(userProfile, 'Desktop'),
        DOCUMENTS: join(userProfile, 'Documents'),
        DOWNLOADS: join(userProfile, 'Downloads'),
      }
    }

    case 'linux':
    case 'wsl': {
      // Linux/WSL：首先检查 XDG 基础目录规范
      return {
        HOME: homeDir,
        DESKTOP: env.XDG_DESKTOP_DIR || defaults.DESKTOP,
        DOCUMENTS: env.XDG_DOCUMENTS_DIR || defaults.DOCUMENTS,
        DOWNLOADS: env.XDG_DOWNLOAD_DIR || defaults.DOWNLOADS,
      }
    }

    case 'macos':
    default: {
      // macOS 和未知平台使用标准路径
      if (platform === 'unknown') {
        logForDebugging(`Unknown platform detected, using default paths`)
      }
      return defaults
    }
  }
}
