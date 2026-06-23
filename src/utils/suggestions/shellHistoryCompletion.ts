import { getHistory } from '../../history.js'
import { logForDebugging } from '../debug.js'

/**
 * Shell 历史补全查找的结果
 */
export type ShellHistoryMatch = {
  /** 历史记录中的完整命令 */
  fullCommand: string
  /** 以幽灵文本显示的补全后缀（用户输入之后的部分） */
  suffix: string
}

// 缓存 Shell 历史命令，避免重复异步读取
// 历史记录只在用户提交命令时才会变化，因此可以使用较长的 TTL
let shellHistoryCache: string[] | null = null
let shellHistoryCacheTimestamp = 0
const CACHE_TTL_MS = 60000 // 60 秒 - 输入过程中历史不会变化

/**
 * 从历史记录中获取 Shell 命令，带缓存
 */
async function getShellHistoryCommands(): Promise<string[]> {
  const now = Date.now()

  // 如果缓存仍然有效则直接返回
  if (shellHistoryCache && now - shellHistoryCacheTimestamp < CACHE_TTL_MS) {
    return shellHistoryCache
  }

  const commands: string[] = []
  const seen = new Set<string>()

  try {
    // 读取历史记录条目并筛选出 bash 命令
    for await (const entry of getHistory()) {
      if (entry.display && entry.display.startsWith('!')) {
        // 去掉 '!' 前缀以获取实际命令
        const command = entry.display.slice(1).trim()
        if (command && !seen.has(command)) {
          seen.add(command)
          commands.push(command)
        }
      }
      // 最多保留最近 50 条不重复的命令
      if (commands.length >= 50) {
        break
      }
    }
  } catch (error) {
    logForDebugging(`Failed to read shell history: ${error}`)
  }

  shellHistoryCache = commands
  shellHistoryCacheTimestamp = now
  return commands
}

/**
 * 清除 Shell 历史缓存（在历史记录更新时调用）
 */
export function clearShellHistoryCache(): void {
  shellHistoryCache = null
  shellHistoryCacheTimestamp = 0
}

/**
 * 将一个命令添加到 Shell 历史缓存的头部，无需
 * 清空整个缓存。如果该命令已存在于缓存中，则将其
 * 移动到头部（去重）。当缓存尚未被填充时，此操作
 * 不生效 —— 下次查询时会读取完整历史，其中已包含
 * 该新命令。
 */
export function prependToShellHistoryCache(command: string): void {
  if (!shellHistoryCache) {
    return
  }
  const idx = shellHistoryCache.indexOf(command)
  if (idx !== -1) {
    shellHistoryCache.splice(idx, 1)
  }
  shellHistoryCache.unshift(command)
}

/**
 * 根据当前输入从历史记录中查找最匹配的 Shell 命令
 *
 * @param input 当前用户输入（不含 '!' 前缀）
 * @returns 最佳匹配结果，未找到匹配时返回 null
 */
export async function getShellHistoryCompletion(
  input: string,
): Promise<ShellHistoryMatch | null> {
  // 输入为空或太短时不进行补全
  if (!input || input.length < 2) {
    return null
  }

  // 检查去除空白后的输入，确保有实际内容
  const trimmedInput = input.trim()
  if (!trimmedInput) {
    return null
  }

  const commands = await getShellHistoryCommands()

  // 查找第一条以精确输入开头的命令（包括空格）
  // 这确保了 "ls " 能匹配 "ls -lah"，而 "ls  "（两个空格）不会匹配
  for (const command of commands) {
    if (command.startsWith(input) && command !== input) {
      return {
        fullCommand: command,
        suffix: command.slice(input.length),
      }
    }
  }

  return null
}
