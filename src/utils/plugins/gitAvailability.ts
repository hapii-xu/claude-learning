/**
 * 检测 git 可用性的工具模块。
 *
 * 安装基于 GitHub 的市场需要 git。本模块提供带记忆化的检测，
 * 用于判断 git 是否在系统上可用。
 */

import memoize from 'lodash-es/memoize.js'
import { which } from '../which.js'

/**
 * 检测 PATH 中是否存在某个命令。
 *
 * 使用 which 查找实际可执行文件而不执行它。
 * 这是避免在不受信目录中执行任意代码的安全最佳实践。
 *
 * @param command - 要检测的命令名
 * @returns 命令存在且可执行时返回 true
 */
async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    return !!(await which(command))
  } catch {
    return false
  }
}

/**
 * 检测系统上是否存在 git。
 *
 * 使用记忆化，在同一会话中多次调用会返回缓存结果。
 * 单次 CLI 会话期间 git 可用性不太可能改变。
 *
 * 仅检测 PATH —— 不执行 git。在 macOS 上，/usr/bin/git 的 xcrun shim
 * 在未安装 Xcode CLT 时也会通过检测；执行时遇到 `xcrun: error:` 的调用者
 * 应调用 markGitUnavailable()，使会话其余部分表现为 git 不存在。
 *
 * @returns git 已安装且可执行时返回 true
 */
export const checkGitAvailable = memoize(async (): Promise<boolean> => {
  return isCommandAvailable('git')
})

/**
 * 强制记忆化的 git 可用性检测在本次会话余下时间返回 false。
 *
 * 当 git 调用失败且表明二进制文件存在于 PATH 但无法实际运行时调用此函数 ——
 * 主要场景是 macOS xcrun shim（`xcrun: error: invalid active developer path`）。
 * 后续的 checkGitAvailable() 调用将直接短路返回 false，使依赖 git 可用性的下游代码
 * 能够干净跳过，而不是反复触发同一个执行错误。
 *
 * lodash memoize 使用无参数时的缓存键 undefined。
 */
export function markGitUnavailable(): void {
  checkGitAvailable.cache?.set?.(undefined, Promise.resolve(false))
}

/**
 * 清除 git 可用性缓存。
 * 仅用于测试目的。
 */
export function clearGitAvailabilityCache(): void {
  checkGitAvailable.cache?.clear?.()
}
