// autofix-pr 完成判定的纯决策矩阵。
//
// 给定 PR 的一组快照（state、head SHA、CI rollup）以及 /autofix-pr
// 启动时记录的 baseline head SHA，判定 autofix 是否结束。没有副作用 ——
// 从 prFetch.ts 中 gh CLI 调用里抽离出来，方便单元测试不 spawn 子进程
// 就能覆盖每条分支。

export type AutofixOutcomeProbeResult =
  | { completed: true; summary: string }
  | { completed: false }

export interface PrViewPayload {
  headRefOid: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  statusCheckRollup?: Array<{
    conclusion?: string | null
    status?: string | null
    name?: string
  }>
}

export interface AutofixOutcomeIdentity {
  owner: string
  repo: string
  prNumber: number
  /**
   * /autofix-pr 启动时记录的 head commit SHA。当它与当前 head 不同时，
   * 说明 autofix 至少 push 了一个 commit。可选 —— 缺省时只能依据 PR 终态
   * （merged/closed）判定完成。
   */
  initialHeadSha?: string
}

/**
 * 给定 PR 快照与 baseline head SHA，纯逻辑地判定 autofix 是否结束。
 * 决策矩阵：
 *   - MERGED                         → 完成（已合并）
 *   - CLOSED（未合并）               → 完成（关闭但未修复）
 *   - OPEN、无 baseline              → 继续轮询
 *   - OPEN、head 未变                → 继续轮询（agent 还没 push）
 *   - OPEN、head 变化、CI pending    → 继续轮询（等 CI）
 *   - OPEN、head 变化、CI failure    → 完成（暴露 red，用户可重试）
 *   - OPEN、head 变化、CI success    → 完成（干净的修复）
 */
export function summariseAutofixOutcome(
  payload: PrViewPayload,
  identity: AutofixOutcomeIdentity,
): AutofixOutcomeProbeResult {
  const { owner, repo, prNumber, initialHeadSha } = identity

  if (payload.state === 'MERGED') {
    return {
      completed: true,
      summary: `${owner}/${repo}#${prNumber} merged. Autofix monitoring complete.`,
    }
  }
  if (payload.state === 'CLOSED') {
    return {
      completed: true,
      summary: `${owner}/${repo}#${prNumber} closed without merge. Autofix monitoring complete.`,
    }
  }

  if (!initialHeadSha) return { completed: false }
  if (payload.headRefOid === initialHeadSha) return { completed: false }

  const ciState = summariseCiRollup(payload.statusCheckRollup)
  if (ciState.state === 'pending') return { completed: false }
  if (ciState.state === 'failure') {
    return {
      completed: true,
      summary: `Autofix pushed commits to ${owner}/${repo}#${prNumber} but CI is failing (${ciState.detail}).`,
    }
  }
  return {
    completed: true,
    summary: `Autofix pushed commits to ${owner}/${repo}#${prNumber}, CI green.`,
  }
}

interface CiSummary {
  state: 'success' | 'pending' | 'failure'
  detail: string
}

function summariseCiRollup(
  rollup: PrViewPayload['statusCheckRollup'],
): CiSummary {
  if (!rollup || rollup.length === 0) {
    // 该仓库没有配置 checks —— 视作成功，只要 push 就能触发完成。
    // 没有 CI 的 PR 是完全合法的。
    return { state: 'success', detail: 'no checks configured' }
  }
  let pending = 0
  let failed = 0
  const total = rollup.length
  for (const check of rollup) {
    const status = (check.status ?? '').toUpperCase()
    const conclusion = (check.conclusion ?? '').toUpperCase()
    if (status && status !== 'COMPLETED') {
      pending++
      continue
    }
    if (
      conclusion === 'SUCCESS' ||
      conclusion === 'NEUTRAL' ||
      conclusion === 'SKIPPED'
    ) {
      continue
    }
    if (conclusion === '') {
      pending++
      continue
    }
    failed++
  }
  if (pending > 0)
    return { state: 'pending', detail: `${pending}/${total} checks pending` }
  if (failed > 0)
    return { state: 'failure', detail: `${failed}/${total} checks failing` }
  return { state: 'success', detail: `${total}/${total} checks passing` }
}
