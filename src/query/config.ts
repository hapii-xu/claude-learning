import { getSessionId } from '../bootstrap/state.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import type { SessionId } from '../types/ids.js'
import { isEnvTruthy } from '../utils/envUtils.js'

// -- 配置

// 在 query() 入口处一次性快照的不可变值。将这些与每次迭代的 State 结构
// 和可变的 ToolUseContext 分离，使未来的 step() 提取变得可处理——
// 纯 reducer 可以接受 (state, event, config)，其中 config 是纯数据。
//
// 特意排除 feature() 门控——这些是 tree-shaking 边界，
// 必须在守卫块中保持内联以便死代码消除。
export type QueryConfig = {
  sessionId: SessionId

  // 运行时门控（env/statsig）。不是 feature() 门控——见上文。
  gates: {
    // Statsig —— CACHED_MAY_BE_STALE 已经承认陈旧性，因此每次 query()
    // 调用快照一次仍保持在现有契约范围内。
    streamingToolExecution: boolean
    emitToolUseSummaries: boolean
    isAnt: boolean
    fastModeEnabled: boolean
  }
}

export function buildQueryConfig(): QueryConfig {
  return {
    sessionId: getSessionId(),
    gates: {
      streamingToolExecution: checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
        'tengu_streaming_tool_execution2',
      ),
      emitToolUseSummaries: isEnvTruthy(
        process.env.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES,
      ),
      isAnt: process.env.USER_TYPE === 'ant',
      // 从 fastMode.ts 内联以避免将其繁重的模块图
      // （axios、settings、auth、model、oauth、config）拉入之前未加载它
      // 的测试分片——更改初始化顺序会破坏不相关的测试。
      fastModeEnabled: !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FAST_MODE),
    },
  }
}
