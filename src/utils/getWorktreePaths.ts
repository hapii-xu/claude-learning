import { sep } from 'path'
import { logEvent } from '../services/analytics/index.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { gitExe } from './git.js'

/**
 * 返回当前 git 仓库所有 worktree 的路径。
 * 若 git 不可用、不在 git 仓库中或仅有一个 worktree，
 * 则返回空数组。
 *
 * 此版本包含分析跟踪并使用 CLI 的 gitExe()
 * 解析器。如需无 CLI 依赖的可移植版本，请使用
 * getWorktreePathsPortable()。
 *
 * @param cwd 执行命令的目录
 * @returns 绝对 worktree 路径的数组
 */
export async function getWorktreePaths(cwd: string): Promise<string[]> {
  const startTime = Date.now()

  const { stdout, code } = await execFileNoThrowWithCwd(
    gitExe(),
    ['worktree', 'list', '--porcelain'],
    {
      cwd,
      preserveOutputOnError: false,
    },
  )

  const durationMs = Date.now() - startTime

  if (code !== 0) {
    logEvent('tengu_worktree_detection', {
      duration_ms: durationMs,
      worktree_count: 0,
      success: false,
    })
    return []
  }

  // 解析 porcelain 输出 - 以 "worktree " 开头的行包含路径
  // 示例：
  // worktree /Users/foo/repo
  // HEAD abc123
  // branch refs/heads/main
  //
  // worktree /Users/foo/repo-wt1
  // HEAD def456
  // branch refs/heads/feature
  const worktreePaths = stdout
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length).normalize('NFC'))

  logEvent('tengu_worktree_detection', {
    duration_ms: durationMs,
    worktree_count: worktreePaths.length,
    success: true,
  })

  // 排序 worktree：当前 worktree 优先，其余按字母顺序
  const currentWorktree = worktreePaths.find(
    path => cwd === path || cwd.startsWith(path + sep),
  )
  const otherWorktrees = worktreePaths
    .filter(path => path !== currentWorktree)
    .sort((a, b) => a.localeCompare(b))

  return currentWorktree ? [currentWorktree, ...otherWorktrees] : otherWorktrees
}
