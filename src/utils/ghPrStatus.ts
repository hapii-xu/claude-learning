import { execFileNoThrow } from './execFileNoThrow.js'
import { getBranch, getDefaultBranch, getIsGit } from './git.js'
import { jsonParse } from './slowOperations.js'

export type PrReviewState =
  | 'approved'
  | 'pending'
  | 'changes_requested'
  | 'draft'
  | 'merged'
  | 'closed'

export type PrStatus = {
  number: number
  url: string
  reviewState: PrReviewState
}

const GH_TIMEOUT_MS = 5000

/**
 * 从 GitHub API 值派生 Review 状态。
 * Draft PR 始终显示为 'draft'，无论 reviewDecision 为何。
 * reviewDecision 可能为：APPROVED、CHANGES_REQUESTED、REVIEW_REQUIRED 或空字符串。
 */
export function deriveReviewState(
  isDraft: boolean,
  reviewDecision: string,
): PrReviewState {
  if (isDraft) return 'draft'
  switch (reviewDecision) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes_requested'
    default:
      return 'pending'
  }
}

/**
 * 使用 `gh pr view` 获取当前分支的 PR 状态。
 * 任何失败时返回 null（gh 未安装、无 PR、不在 git 仓库等）。
 * 若 PR 的 head 分支为默认分支（如 main/master）也返回 null。
 */
export async function fetchPrStatus(): Promise<PrStatus | null> {
  const isGit = await getIsGit()
  if (!isGit) return null

  // 在默认分支上跳过 - `gh pr view` 会返回最近
  // 合并的 PR，这会产生误导。
  const [branch, defaultBranch] = await Promise.all([
    getBranch(),
    getDefaultBranch(),
  ])
  if (branch === defaultBranch) return null

  const { stdout, code } = await execFileNoThrow(
    'gh',
    [
      'pr',
      'view',
      '--json',
      'number,url,reviewDecision,isDraft,headRefName,state',
    ],
    { timeout: GH_TIMEOUT_MS, preserveOutputOnError: false },
  )

  if (code !== 0 || !stdout.trim()) return null

  try {
    const data = jsonParse(stdout) as {
      number: number
      url: string
      reviewDecision: string
      isDraft: boolean
      headRefName: string
      state: string
    }

    // 不为来自默认分支（如 main、master）的 PR 显示 PR 状态
    // 当有人从 main 向另一个分支开 PR 时可能发生此情况
    if (
      data.headRefName === defaultBranch ||
      data.headRefName === 'main' ||
      data.headRefName === 'master'
    ) {
      return null
    }

    // 不为已合并或已关闭的 PR 显示 PR 状态 - `gh pr view` 会返回
    // 分支最近关联的 PR，可能已合并/关闭。
    // 状态行应仅显示开放中的 PR。
    if (data.state === 'MERGED' || data.state === 'CLOSED') {
      return null
    }

    return {
      number: data.number,
      url: data.url,
      reviewState: deriveReviewState(data.isDraft, data.reviewDecision),
    }
  } catch {
    return null
  }
}
