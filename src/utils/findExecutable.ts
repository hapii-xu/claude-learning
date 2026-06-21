import { whichSync } from './which.js'

/**
 * 通过搜索 PATH 查找可执行文件，类似 `which`。
 * 替代 spawn-rx 的 findActualExecutable 以避免引入 rxjs（约 313 KB）。
 *
 * 返回 { cmd, args } 以匹配 spawn-rx 的 API 形态。
 * `cmd` 为找到的解析路径，若未找到则为原始名称。
 * `args` 始终是输入 args 的透传。
 */
export function findExecutable(
  exe: string,
  args: string[],
): { cmd: string; args: string[] } {
  const resolved = whichSync(exe)
  return { cmd: resolved ?? exe, args }
}
