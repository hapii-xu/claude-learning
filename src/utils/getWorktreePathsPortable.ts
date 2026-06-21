import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFileCb)

/**
 * 可移植的 worktree 检测，仅使用 child_process - 无分析，
 * 无 bootstrap 依赖，无 execa。被 listSessionsImpl.ts（SDK）和
 * 任何需要 worktree 路径但不想引入 CLI
 * 依赖链（execa → cross-spawn → which）的地方使用。
 */
export async function getWorktreePathsPortable(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd, timeout: 5000 },
    )
    if (!stdout) return []
    return stdout
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length).normalize('NFC'))
  } catch {
    return []
  }
}
