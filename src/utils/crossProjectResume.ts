import { sep } from 'path'
import { getOriginalCwd } from '../bootstrap/state.js'
import type { LogOption } from '../types/logs.js'
import { quote } from './bash/shellQuote.js'
import { getSessionIdFromLog } from './sessionStorage.js'

export type CrossProjectResumeResult =
  | {
      isCrossProject: false
    }
  | {
      isCrossProject: true
      isSameRepoWorktree: true
      projectPath: string
    }
  | {
      isCrossProject: true
      isSameRepoWorktree: false
      command: string
      projectPath: string
    }

/**
 * 检查日志是否来自不同的项目目录，并判断它是相关的 worktree
 * 还是完全独立的项目。
 *
 * 对于同一仓库的 worktree，可以直接 resume 而无需 cd。
 * 对于不同的项目，则生成 cd 命令。
 */
export function checkCrossProjectResume(
  log: LogOption,
  showAllProjects: boolean,
  worktreePaths: string[],
): CrossProjectResumeResult {
  const currentCwd = getOriginalCwd()

  if (!showAllProjects || !log.projectPath || log.projectPath === currentCwd) {
    return { isCrossProject: false }
  }

  // 将 worktree 检测限制在 ant 用户内以便分阶段推出
  if (process.env.USER_TYPE !== 'ant') {
    const sessionId = getSessionIdFromLog(log)
    const command = `cd ${quote([log.projectPath])} && claude --resume ${sessionId}`
    return {
      isCrossProject: true,
      isSameRepoWorktree: false,
      command,
      projectPath: log.projectPath,
    }
  }

  // 检查 log.projectPath 是否在同一仓库的 worktree 下
  const isSameRepo = worktreePaths.some(
    wt => log.projectPath === wt || log.projectPath!.startsWith(wt + sep),
  )

  if (isSameRepo) {
    return {
      isCrossProject: true,
      isSameRepoWorktree: true,
      projectPath: log.projectPath,
    }
  }

  // 不同的仓库 —— 生成 cd 命令
  const sessionId = getSessionIdFromLog(log)
  const command = `cd ${quote([log.projectPath])} && claude --resume ${sessionId}`
  return {
    isCrossProject: true,
    isSameRepoWorktree: false,
    command,
    projectPath: log.projectPath,
  }
}
