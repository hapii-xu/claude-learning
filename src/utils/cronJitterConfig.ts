// 基于 GrowthBook 的 cron 抖动配置。
//
// 从 cronScheduler.ts 中分离出来，以便调度器可以在 Agent SDK 公开构建中
// 打包，而不会拉入 analytics/growthbook.ts 及其庞大的传递依赖集
//（settings/hooks/config 循环）。
//
// 用法：
//   REPL（useScheduledTasks.ts）：传递 `getJitterConfig: getCronJitterConfig`
//   Daemon/SDK：省略 getJitterConfig → 应用 DEFAULT_CRON_JITTER_CONFIG。

import { z } from 'zod/v4'
import { getFeatureValue_CACHED_WITH_REFRESH } from '../services/analytics/growthbook.js'
import {
  type CronJitterConfig,
  DEFAULT_CRON_JITTER_CONFIG,
} from './cronTasks.js'
import { lazySchema } from './lazySchema.js'

// 从 GrowthBook 重新获取 tengu_kairos_cron_config 的频率。时间较短，
// 因为这是一个事件杠杆 —— 当我们推送配置变更以分担 :00 负载时，
// 希望集群在一分钟内收敛，而非等到下次进程重启。底层调用是
// 同步缓存读取；刷新只是清除记忆化的条目，以便下次读取触发后台获取。
const JITTER_CONFIG_REFRESH_MS = 60 * 1000

// 此处的上限是对 GrowthBook 误操作的纵深防御。与 pollConfig.ts 类似，
// Zod 在任何违规时拒绝整个对象而非部分信任 —— 一个字段有误的配置会
// 完全回退到 DEFAULT_CRON_JITTER_CONFIG。oneShotFloorMs 与 oneShotMaxMs
// 共享上限（floor > max 会反转抖动范围），并在 refine 中交叉检查；
// 共享上限使单个约束在错误路径中保持明确。recurringMaxAgeMs 使用
// .default()，这样缺少该字段的现有 GB 配置不会被整体拒绝 ——
// 其他字段在配置创建时一起添加，不需要此处理。
const HALF_HOUR_MS = 30 * 60 * 1000
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const cronJitterConfigSchema = lazySchema(() =>
  z
    .object({
      recurringFrac: z.number().min(0).max(1),
      recurringCapMs: z.number().int().min(0).max(HALF_HOUR_MS),
      oneShotMaxMs: z.number().int().min(0).max(HALF_HOUR_MS),
      oneShotFloorMs: z.number().int().min(0).max(HALF_HOUR_MS),
      oneShotMinuteMod: z.number().int().min(1).max(60),
      recurringMaxAgeMs: z
        .number()
        .int()
        .min(0)
        .max(THIRTY_DAYS_MS)
        .default(DEFAULT_CRON_JITTER_CONFIG.recurringMaxAgeMs),
    })
    .refine(c => c.oneShotFloorMs <= c.oneShotMaxMs),
)

/**
 * 从 GrowthBook 读取 `tengu_kairos_cron_config`，验证，
 * 对缺失/格式错误/越界配置回退到默认值。通过 `getJitterConfig`
 * 回调在每个 tick 从 check() 调用 —— 成本低廉（同步缓存命中）。
 * 刷新窗口：JITTER_CONFIG_REFRESH_MS。
 *
 * 导出以便运维手册可以指向单个函数来记录此杠杆，
 * 也便于测试在不 mock GrowthBook 的情况下对其进行 spy。
 *
 * 在 REPL 上下文中调用 createCronScheduler 时将其作为
 * `getJitterConfig` 传入。Daemon/SDK 调用方省略 getJitterConfig
 * 并使用默认值。
 */
export function getCronJitterConfig(): CronJitterConfig {
  const raw = getFeatureValue_CACHED_WITH_REFRESH<unknown>(
    'tengu_kairos_cron_config',
    DEFAULT_CRON_JITTER_CONFIG,
    JITTER_CONFIG_REFRESH_MS,
  )
  const parsed = cronJitterConfigSchema().safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_CRON_JITTER_CONFIG
}
