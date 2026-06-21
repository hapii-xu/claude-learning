/**
 * IDE 通信的路径转换工具
 * 处理 Claude 环境与 IDE 环境之间的路径转换
 */

import { execFileSync } from 'child_process'

export interface IDEPathConverter {
  /**
   * 将路径从 IDE 格式转换为 Claude 的本地格式
   * 从 IDE lockfile 读取工作区文件夹时使用
   */
  toLocalPath(idePath: string): string

  /**
   * 将路径从 Claude 的本地格式转换为 IDE 格式
   * 向 IDE 发送路径时使用（showDiffInFE 等）
   */
  toIDEPath(localPath: string): string
}

/**
 * Windows IDE + WSL Claude 场景的转换器
 */
export class WindowsToWSLConverter implements IDEPathConverter {
  constructor(private wslDistroName: string | undefined) {}

  toLocalPath(windowsPath: string): string {
    if (!windowsPath) return windowsPath

    // 检查是否为来自不同 WSL 发行版的路径
    if (this.wslDistroName) {
      const wslUncMatch = windowsPath.match(
        /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(.*)$/,
      )
      if (wslUncMatch && wslUncMatch[1] !== this.wslDistroName) {
        // 不同发行版 - wslpath 会失败，因此返回原始路径
        return windowsPath
      }
    }

    try {
      // 使用 wslpath 将 Windows 路径转换为 WSL 路径
      const result = execFileSync('wslpath', ['-u', windowsPath], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'], // wslpath 将 "wslpath: <errortext>" 写入 stderr
      }).trim()

      return result
    } catch {
      // 若 wslpath 失败，回退到手动转换
      return windowsPath
        .replace(/\\/g, '/') // 将反斜杠转换为正斜杠
        .replace(/^([A-Z]):/i, (_, letter) => `/mnt/${letter.toLowerCase()}`)
    }
  }

  toIDEPath(wslPath: string): string {
    if (!wslPath) return wslPath

    try {
      // 使用 wslpath 将 WSL 路径转换为 Windows 路径
      const result = execFileSync('wslpath', ['-w', wslPath], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'], // wslpath 将 "wslpath: <errortext>" 写入 stderr
      }).trim()

      return result
    } catch {
      // 若 wslpath 失败，返回原始路径
      return wslPath
    }
  }
}

/**
 * 检查 WSL UNC 路径的发行版名称是否匹配
 */
export function checkWSLDistroMatch(
  windowsPath: string,
  wslDistroName: string,
): boolean {
  const wslUncMatch = windowsPath.match(
    /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(.*)$/,
  )
  if (wslUncMatch) {
    return wslUncMatch[1] === wslDistroName
  }
  return true // 不是 WSL UNC 路径，因此无发行版不匹配
}
