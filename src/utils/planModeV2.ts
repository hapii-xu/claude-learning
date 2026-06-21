import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getRateLimitTier, getSubscriptionType } from './auth.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'

export function getPlanModeV2AgentCount(): number {
  // 环境变量覆盖优先
  if (process.env.CLAUDE_CODE_PLAN_V2_AGENT_COUNT) {
    const count = parseInt(process.env.CLAUDE_CODE_PLAN_V2_AGENT_COUNT, 10)
    if (!isNaN(count) && count > 0 && count <= 10) {
      return count
    }
  }

  const subscriptionType = getSubscriptionType()
  const rateLimitTier = getRateLimitTier()

  if (
    subscriptionType === 'max' &&
    rateLimitTier === 'default_claude_max_20x'
  ) {
    return 3
  }

  if (subscriptionType === 'enterprise' || subscriptionType === 'team') {
    return 3
  }

  return 1
}

export function getPlanModeV2ExploreAgentCount(): number {
  if (process.env.CLAUDE_CODE_PLAN_V2_EXPLORE_AGENT_COUNT) {
    const count = parseInt(
      process.env.CLAUDE_CODE_PLAN_V2_EXPLORE_AGENT_COUNT,
      10,
    )
    if (!isNaN(count) && count > 0 && count <= 10) {
      return count
    }
  }

  return 3
}

/**
 * 检查 plan mode 访谈阶段是否启用。
 *
 * 配置：ant=always_on，external=tengu_plan_mode_interview_phase 门控，envVar=true
 */
export function isPlanModeInterviewPhaseEnabled(): boolean {
  // 对 ants 始终开启
  if (process.env.USER_TYPE === 'ant') return true

  const env = process.env.CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE
  if (isEnvTruthy(env)) return true
  if (isEnvDefinedFalsy(env)) return false

  return getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_plan_mode_interview_phase',
    false,
  )
}

export type PewterLedgerVariant = 'trim' | 'cut' | 'cap' | null

/**
 * tengu_pewter_ledger — plan 文件结构提示实验。
 *
 * 控制 5 阶段 plan mode 工作流中第 4 阶段"最终 Plan"的
 * 要点（messages.ts 中的 getPlanPhase4Section）。5 阶段占 plan
 * 流量的 99%；interview-phase（ants）作为参照群体不受影响。
 *
 * 实验组：null（对照）、'trim'、'cut'、'cap' — 对 plan 文件大小的
 * 引导逐步更严格。
 *
 * 基线（对照，14 天至 2026-03-02，N=26.3M）：
 *   p50 4,906 字符 | p90 11,617 | 均值 6,207 | 82% Opus 4.6
 *   拒绝率随大小单调递增：<2K 时 20% → 20K+ 时 50%
 *
 * 主要指标：会话级平均成本（fact__201omjcij85f）— Opus 输出价格为
 *   输入的 5 倍，因此成本是输出加权的代理指标。planLengthChars
 *   在 tengu_plan_exit 上是机制而非目标 — cap 组可能缩小
 *   plan 文件但因 write→count→edit 循环而增加总输出。
 * 防护栏：feedback-bad 率、每会话请求数（过于简陋的 plan →
 *   更多实现迭代）、工具错误率
 */
export function getPewterLedgerVariant(): PewterLedgerVariant {
  const raw = getFeatureValue_CACHED_MAY_BE_STALE<string | null>(
    'tengu_pewter_ledger',
    null,
  )
  if (raw === 'trim' || raw === 'cut' || raw === 'cap') return raw
  return null
}
