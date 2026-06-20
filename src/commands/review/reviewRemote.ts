/**
 * 传送式 /ultrareview 执行。基于当前 repo 创建 CCR session，
 * 将 review prompt 作为初始消息发送，并注册一个
 * RemoteAgentTask，以便轮询循环通过 task-notification 把结果
 * 回传到本地 session。对应 /ultraplan → CCR 流程。
 *
 * TODO(#22051): 待 useBundleMode 落地后传入，以便捕获 local-only /
 * 未提交的 repo 状态。当前的 GitHub-clone 路径只对
 * 已安装 Claude GitHub app 的 repo 上已 push 的分支生效。
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { fetchUltrareviewQuota } from '../../services/api/ultrareviewQuota.js'
import { fetchUtilization } from '../../services/api/usage.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  checkRemoteAgentEligibility,
  formatPreconditionError,
  getRemoteTaskSessionUrl,
  registerRemoteAgentTask,
  type BackgroundRemoteSessionPrecondition,
} from '../../tasks/RemoteAgentTask/RemoteAgentTask.js'
import { isEnterpriseSubscriber, isTeamSubscriber } from '../../utils/auth.js'
import { detectCurrentRepositoryWithHost } from '../../utils/detectRepository.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { getDefaultBranch, gitExe } from '../../utils/git.js'
import { teleportToRemote } from '../../utils/teleport.js'

// 一次性 session flag：一旦用户通过对话框确认了 overage 计费，
// 本 session 内后续所有的 /ultrareview 调用都不再提示。
let sessionOverageConfirmed = false

export function confirmOverage(): void {
  sessionOverageConfirmed = true
}

export type OverageGate =
  | { kind: 'proceed'; billingNote: string }
  | { kind: 'not-enabled' }
  | { kind: 'low-balance'; available: number }
  | { kind: 'needs-confirm' }

/**
 * 判断用户是否可以发起 ultrareview，以及在何种计费条件下。
 * 并行获取 quota 和 utilization。
 */
export async function checkOverageGate(): Promise<OverageGate> {
  // Team 和 Enterprise 套餐已包含 ultrareview — 无免费 review 额度
  // 也无 Extra Usage 对话框。该 quota 端点仅适用于消费者套餐
  // （pro/max）；对 team/ent 调用会弹出一个令人困惑的对话框。
  if (isTeamSubscriber() || isEnterpriseSubscriber()) {
    return { kind: 'proceed', billingNote: '' }
  }

  const [quota, utilization] = await Promise.all([
    fetchUltrareviewQuota(),
    fetchUtilization().catch(() => null),
  ])

  // 无 quota 信息（非订阅者或端点不可用）— 放行，
  // 由服务端计费处理。
  if (!quota) {
    return { kind: 'proceed', billingNote: '' }
  }

  if (quota.reviews_remaining > 0) {
    return {
      kind: 'proceed',
      billingNote: ` This is free ultrareview ${quota.reviews_used + 1} of ${quota.reviews_limit}.`,
    }
  }

  // Utilization 获取失败（瞬时网络错误、超时等）— 放行，
  // 理由同上面的 quota 兜底。
  if (!utilization) {
    return { kind: 'proceed', billingNote: '' }
  }

  // 免费 review 已用尽 — 检查 Extra Usage 设置。
  const extraUsage = utilization.extra_usage
  if (!extraUsage?.is_enabled) {
    logEvent('tengu_review_overage_not_enabled', {})
    return { kind: 'not-enabled' }
  }

  // 检查可用余额（monthly_limit 为 null 表示无限制）。
  const monthlyLimit = extraUsage.monthly_limit
  const usedCredits = extraUsage.used_credits ?? 0
  const available =
    monthlyLimit === null || monthlyLimit === undefined
      ? Infinity
      : monthlyLimit - usedCredits

  if (available < 10) {
    logEvent('tengu_review_overage_low_balance', { available })
    return { kind: 'low-balance', available }
  }

  if (!sessionOverageConfirmed) {
    logEvent('tengu_review_overage_dialog_shown', {})
    return { kind: 'needs-confirm' }
  }

  return {
    kind: 'proceed',
    billingNote: ' This review bills as Extra Usage.',
  }
}

/**
 * 启动一个传送式 review session。返回 ContentBlockParam[] 描述启动
 * 结果，用于注入本地会话（随后模型会基于这些内容被查询，从而向用户
 * 叙述启动情况）。
 *
 * 当出现可恢复的失败（缺少 merge-base、diff 为空、bundle 过大）时，
 * 返回包含面向用户错误信息的 ContentBlockParam[]；其他失败返回 null，
 * 让调用方回退到 local-review prompt。失败原因会被记录到 analytics。
 *
 * 调用方必须在调用本函数之前先执行 checkOverageGate()
 * （对话框由 ultrareviewCommand.tsx 处理）。
 */
export async function launchRemoteReview(
  args: string,
  context: ToolUseContext,
  billingNote?: string,
): Promise<ContentBlockParam[] | null> {
  const eligibility = await checkRemoteAgentEligibility()
  // 合成的 DEFAULT_CODE_REVIEW_ENVIRONMENT_ID 无需按组织配置 CCR 即可工作，
  // 因此 no_remote_environment 不是阻塞项。服务端在 session 创建时消费
  // quota 并路由计费：前 N 次零费率，之后走
  // anthropic:cccr org-service-key（仅 overage）。
  if (!eligibility.eligible) {
    const blockers = (
      eligibility as { eligible: false; errors: Array<{ type: string }> }
    ).errors.filter(e => e.type !== 'no_remote_environment')
    if (blockers.length > 0) {
      logEvent('tengu_review_remote_precondition_failed', {
        precondition_errors: blockers
          .map(e => e.type)
          .join(
            ',',
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      const reasons = (blockers as BackgroundRemoteSessionPrecondition[])
        .map(formatPreconditionError)
        .join('\n')
      return [
        {
          type: 'text',
          text: `Ultrareview cannot launch:\n${reasons}`,
        },
      ]
    }
  }

  const resolvedBillingNote = billingNote ?? ''

  const prNumber = args.trim()
  const isPrNumber = /^\d+$/.test(prNumber)
  // 合成的 code_review env。Go 的 taggedid.FromUUID(TagEnvironment,
  // UUID{...,0x02}) 以版本前缀 '01' 编码 — 不是 Python 的
  // legacy tagged_id() 格式。已在生产环境验证。
  const CODE_REVIEW_ENV_ID = 'env_011111111111111111111113'
  // Lite-review 完全绕过 bughunter.go，因此它读不到
  // webhook 里的 bug_hunter_config（属于不同的 GB project）。这些环境变量是
  // 唯一可调的入口 — 不设置的话，run_hunt.sh 的 bash 默认值
  // 会生效（60min wallclock、120s agent timeout），而 120s 会
  // 在运行中杀死 verifier，从而引发无限重启。
  //
  // total_wallclock 必须低于 RemoteAgentTask 的 30min 轮询超时，
  // 并为收尾（约 3min synthesis）留出余量。各字段守卫
  // 与 autoDream.ts 一致 — GB 缓存可能返回过期的错误类型值。
  const raw = getFeatureValue_CACHED_MAY_BE_STALE<Record<
    string,
    unknown
  > | null>('tengu_review_bughunter_config', null)
  const posInt = (v: unknown, fallback: number, max?: number): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
    const n = Math.floor(v)
    if (n <= 0) return fallback
    return max !== undefined && n > max ? fallback : n
  }
  // 上限：wallclock 取 27min，在 RemoteAgentTask 30min 轮询超时下
  // 留出约 3min 用于收尾。如果 GB 设置值高于该上限，我们正在修复的
  // 挂起问题就会复现 — 因此回退到安全默认值。
  const commonEnvVars = {
    BUGHUNTER_DRY_RUN: '1',
    BUGHUNTER_FLEET_SIZE: String(posInt(raw?.fleet_size, 5, 20)),
    BUGHUNTER_MAX_DURATION: String(posInt(raw?.max_duration_minutes, 10, 25)),
    BUGHUNTER_AGENT_TIMEOUT: String(
      posInt(raw?.agent_timeout_seconds, 600, 1800),
    ),
    BUGHUNTER_TOTAL_WALLCLOCK: String(
      posInt(raw?.total_wallclock_minutes, 22, 27),
    ),
    ...(process.env.BUGHUNTER_DEV_BUNDLE_B64 && {
      BUGHUNTER_DEV_BUNDLE_B64: process.env.BUGHUNTER_DEV_BUNDLE_B64,
    }),
  }

  let session
  let command
  let target
  if (isPrNumber) {
    // PR 模式：通过 github.com 拉取 refs/pull/N/head。Orchestrator 使用 --pr N。
    const repo = await detectCurrentRepositoryWithHost()
    if (!repo || repo.host !== 'github.com') {
      logEvent('tengu_review_remote_precondition_failed', {})
      return null
    }
    session = await teleportToRemote({
      initialMessage: null,
      description: `ultrareview: ${repo.owner}/${repo.name}#${prNumber}`,
      signal: context.abortController.signal,
      branchName: `refs/pull/${prNumber}/head`,
      environmentId: CODE_REVIEW_ENV_ID,
      environmentVariables: {
        BUGHUNTER_PR_NUMBER: prNumber,
        BUGHUNTER_REPOSITORY: `${repo.owner}/${repo.name}`,
        ...commonEnvVars,
      },
    })
    command = `/ultrareview ${prNumber}`
    target = `${repo.owner}/${repo.name}#${prNumber}`
  } else {
    // Branch 模式：打包工作区，orchestrator 基于
    // fork point 做 diff。无 PR，无既有评论，无去重。
    const baseBranch = (await getDefaultBranch()) || 'main'
    // Env-manager 在 bundle-clone 之后执行 `git remote remove origin`，
    // 这会删除 refs/remotes/origin/* — base 分支名在容器中将无法解析。
    // 改为传 merge-base SHA：它可以从 HEAD 的历史中到达，
    // 因此 `git diff <sha>` 无需命名 ref 即可工作。
    const { stdout: mbOut, code: mbCode } = await execFileNoThrow(
      gitExe(),
      ['merge-base', baseBranch, 'HEAD'],
      { preserveOutputOnError: false },
    )
    const mergeBaseSha = mbOut.trim()
    if (mbCode !== 0 || !mergeBaseSha) {
      logEvent('tengu_review_remote_precondition_failed', {})
      return [
        {
          type: 'text',
          text: `Could not find merge-base with ${baseBranch}. Make sure you're in a git repo with a ${baseBranch} branch.`,
        },
      ]
    }

    // 对空 diff 提前退出，而不是启动一个只会回显"no changes"的容器。
    const { stdout: diffStat, code: diffCode } = await execFileNoThrow(
      gitExe(),
      ['diff', '--shortstat', mergeBaseSha],
      { preserveOutputOnError: false },
    )
    if (diffCode === 0 && !diffStat.trim()) {
      logEvent('tengu_review_remote_precondition_failed', {})
      return [
        {
          type: 'text',
          text: `No changes against the ${baseBranch} fork point. Make some commits or stage files first.`,
        },
      ]
    }

    session = await teleportToRemote({
      initialMessage: null,
      description: `ultrareview: ${baseBranch}`,
      signal: context.abortController.signal,
      useBundle: true,
      environmentId: CODE_REVIEW_ENV_ID,
      environmentVariables: {
        BUGHUNTER_BASE_BRANCH: mergeBaseSha,
        ...commonEnvVars,
      },
    })
    if (!session) {
      logEvent('tengu_review_remote_teleport_failed', {})
      return [
        {
          type: 'text',
          text: 'Repo is too large. Push a PR and use `/ultrareview <PR#>` instead.',
        },
      ]
    }
    command = '/ultrareview'
    target = baseBranch
  }

  if (!session) {
    logEvent('tengu_review_remote_teleport_failed', {})
    return null
  }
  registerRemoteAgentTask({
    remoteTaskType: 'ultrareview',
    session,
    command,
    context,
    isRemoteReview: true,
  })
  logEvent('tengu_review_remote_launched', {})
  const sessionUrl = getRemoteTaskSessionUrl(session.id)
  // 简洁 — tool-output 块对用户可见，因此模型不应
  // 重复相同信息。只给 Claude 足够的信息来确认启动，
  // 而不重复 target/URL（两者已在上方打印）。
  return [
    {
      type: 'text',
      text: `Ultrareview launched for ${target} (~10–20 min, runs in the cloud). Track: ${sessionUrl}${resolvedBillingNote} Findings arrive via task-notification. Briefly acknowledge the launch to the user without repeating the target or URL — both are already visible in the tool output above.`,
    },
  ]
}
