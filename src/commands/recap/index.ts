/**
 * /recap — 立即生成一行会话回顾。
 *
 * 别名：/away, /catchup
 *
 * 对应官方 v2.1.123 实现：
 *   - 受 AWAY_SUMMARY feature flag（必须在运行时设置）AND
 *     'tengu_sedge_lantern' GrowthBook flag（默认：true）双重门控
 *   - 调用 generateRecap()，该函数复用主循环的 prompt-cache 前缀
 *   - 返回一句简短（≤40 词）的纯文本，描述当前目标、进行中的任务和下一步行动
 *     — 不含 markdown，不含状态报告
 *
 * 当用户离开一段时间后回来时，可以输入 /recap（或 /away /
 * /catchup）立即获得上下文，而无需翻阅历史记录。
 *
 * isEnabled 守卫：REPL.tsx 中自动化的"离开期间"卡片已经
 * 检查了 feature('AWAY_SUMMARY')。对于手动的 /recap 命令，我们检查
 * 同一个 GrowthBook flag，使两处保持同步。
 */
import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type {
  Command,
  LocalCommandCall,
  LocalCommandResult,
} from '../../types/command.js'

// ── Call 实现 ───────────────────────────────────────────────────────

const call: LocalCommandCall = async (_args, context) => {
  // 动态 import 避免将体积庞大的 forkedAgent 依赖纳入模块加载
  const { generateRecap } = await import('./generateRecap.js')

  const signal = context.abortController?.signal ?? new AbortController().signal
  const result = await generateRecap(signal)

  switch (result.kind) {
    case 'ok':
    case 'api-error':
      return { type: 'text', value: result.text } satisfies LocalCommandResult

    case 'no-turn':
      return {
        type: 'text',
        value: 'Nothing to recap yet \u2014 send a message first.',
      } satisfies LocalCommandResult

    case 'aborted':
      return {
        type: 'text',
        value: 'Recap cancelled.',
      } satisfies LocalCommandResult

    case 'failed':
      return {
        type: 'text',
        value: 'Couldn\u2019t generate a recap. Run with --debug for details.',
      } satisfies LocalCommandResult
  }
}

// ── Command 声明 ───────────────────────────────────────────────────────

const recap = {
  type: 'local',
  name: 'recap',
  description: 'Generate a one-line session recap now',
  aliases: ['away', 'catchup'],
  /**
   * 启用条件：
   *  1. AWAY_SUMMARY feature flag 打开（build/env），AND
   *  2. 'tengu_sedge_lantern' GrowthBook flag 为 true（默认：true）
   *
   * 这与官方二进制中使用的 isEnabled() 谓词一致，
   * 并使本命令与 REPL 中自动化的离开-summary 卡片保持同步。
   */
  isEnabled: (): boolean => {
    if (!feature('AWAY_SUMMARY')) return false
    return getFeatureValue_CACHED_MAY_BE_STALE('tengu_sedge_lantern', true)
  },
  supportsNonInteractive: false,
  isHidden: false,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default recap
