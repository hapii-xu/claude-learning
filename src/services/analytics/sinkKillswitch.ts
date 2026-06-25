import { getDynamicConfig_CACHED_MAY_BE_STALE } from './growthbook.js'

// 混淆名：针对单个 sink 的 analytics killswitch
const SINK_KILLSWITCH_CONFIG_NAME = 'tengu_frond_boric'

export type SinkName = 'datadog' | 'firstParty'

/**
 * 禁用单个 analytics sink 的 GrowthBook JSON 配置。
 * 结构：{ datadog?: boolean, firstParty?: boolean }
 * 某个 key 为 true 时，停止向该 sink 的所有分发。
 * 默认 {}（不禁用任何 sink）。Fail-open：缺失/格式错误的配置 = sink 保持开启。
 *
 * 注意：绝不能在 is1PEventLoggingEnabled() 内部调用 ——
 * growthbook.ts:isGrowthBookEnabled() 会调用它，因此在此处查找会导致递归。
 * 改为在每个事件的分发点调用。
 */
export function isSinkKilled(sink: SinkName): boolean {
  const config = getDynamicConfig_CACHED_MAY_BE_STALE<
    Partial<Record<SinkName, boolean>>
  >(SINK_KILLSWITCH_CONFIG_NAME, {})
  // getFeatureValue_CACHED_MAY_BE_STALE 以 `!== undefined` 作为判断，
  // 因此缓存的 JSON null 会泄漏进来，而不是回退到 {}。
  return config?.[sink] === true
}
