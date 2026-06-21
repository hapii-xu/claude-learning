import { logForDebugging } from './debug.js'
import { which } from './which.js'

// 会话缓存，避免重复检查
const binaryCache = new Map<string, boolean>()

/**
 * 检查二进制文件/命令是否已安装且在系统上可用。
 * 在 Unix 系统（macOS、Linux、WSL）上使用 'which'，在 Windows 上使用 'where'。
 *
 * @param command - 要检查的命令名（例如 'gopls'、'rust-analyzer'）
 * @returns Promise<boolean> - 命令存在返回 true，否则返回 false
 */
export async function isBinaryInstalled(command: string): Promise<boolean> {
  // 边界情况：空或纯空白的命令
  if (!command || !command.trim()) {
    logForDebugging('[binaryCheck] Empty command provided, returning false')
    return false
  }

  // 去除命令两端的空白
  const trimmedCommand = command.trim()

  // 优先检查缓存
  const cached = binaryCache.get(trimmedCommand)
  if (cached !== undefined) {
    logForDebugging(
      `[binaryCheck] Cache hit for '${trimmedCommand}': ${cached}`,
    )
    return cached
  }

  let exists = false
  if (await which(trimmedCommand).catch(() => null)) {
    exists = true
  }

  // 缓存结果
  binaryCache.set(trimmedCommand, exists)

  logForDebugging(
    `[binaryCheck] Binary '${trimmedCommand}' ${exists ? 'found' : 'not found'}`,
  )

  return exists
}

/**
 * 清除二进制文件检查缓存（用于测试）
 */
export function clearBinaryCache(): void {
  binaryCache.clear()
}
