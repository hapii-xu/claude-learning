import { z } from 'zod/v4'
import { getFeatureValue_CACHED_WITH_REFRESH } from '../services/analytics/growthbook.js'
import { lazySchema } from '../utils/lazySchema.js'
import {
  DEFAULT_POLL_CONFIG,
  type PollIntervalConfig,
} from './pollConfigDefaults.js'

// 在 seek-work（寻找 work）相关 interval 上加 .min(100) 相当于恢复了
// 旧的 Math.max(..., 100) 纵深防御下限，防止 GrowthBook 配置被手滑填错。
// 与 clamp 不同，Zod 校验失败时会拒绝整个对象 —— 一个字段不合规的配置
// 会整体回退到 DEFAULT_POLL_CONFIG，而不是被部分信任。
//
// at_capacity 的 interval 采用 "0 或 ≥100" 的 refine：0 表示"禁用"
//（纯 heartbeat 模式），≥100 是防手滑下限。1–99 的值会被拒绝，避免
// 单位混淆（ops 以为是秒、填了 10）导致每 10ms 去打一次
// VerifyEnvironmentSecretAuth DB 路径。
//
// object 级别的 refine 要求至少启用一种 at-capacity 存活机制：
// heartbeat 或对应的 poll interval。否则 hb=0、atCapMs=0 这种漂移配置
//（ops 禁用了 heartbeat 却没恢复 at_capacity）会绕过所有节流点，
// 完全不 sleep —— 以 HTTP 往返速度紧循环 /poll。
const zeroOrAtLeast100 = {
  message: 'must be 0 (disabled) or ≥100ms',
}
const pollIntervalConfigSchema = lazySchema(() =>
  z
    .object({
      poll_interval_ms_not_at_capacity: z.number().int().min(100),
      // 0 = 不做 at-capacity 轮询。与 heartbeat 独立 —— 两者可同时启用
      //（heartbeat 跑着，周期性跳出来 poll）。
      poll_interval_ms_at_capacity: z
        .number()
        .int()
        .refine(v => v === 0 || v >= 100, zeroOrAtLeast100),
      // 0 = 禁用；正值 = 在 at-capacity 时按此间隔发 heartbeat。
      // 与 at-capacity 轮询并行而非取代。命名为 non_exclusive 是为了
      // 与旧的 heartbeat_interval_ms（#22145 之前客户端的"二选一"语义）
      // 区分。加 .default(0) 让缺少该字段的旧 GrowthBook 配置也能正常解析。
      non_exclusive_heartbeat_interval_ms: z.number().int().min(0).default(0),
      // Multisession（bridgeMain.ts）的 interval。默认值与单 session 一致，
      // 让缺少这些字段的旧配置保持原有行为。
      multisession_poll_interval_ms_not_at_capacity: z
        .number()
        .int()
        .min(100)
        .default(
          DEFAULT_POLL_CONFIG.multisession_poll_interval_ms_not_at_capacity,
        ),
      multisession_poll_interval_ms_partial_capacity: z
        .number()
        .int()
        .min(100)
        .default(
          DEFAULT_POLL_CONFIG.multisession_poll_interval_ms_partial_capacity,
        ),
      multisession_poll_interval_ms_at_capacity: z
        .number()
        .int()
        .refine(v => v === 0 || v >= 100, zeroOrAtLeast100)
        .default(DEFAULT_POLL_CONFIG.multisession_poll_interval_ms_at_capacity),
      // .min(1) 与服务器的 ge=1 约束对齐（work_v1.py:230）。
      reclaim_older_than_ms: z.number().int().min(1).default(5000),
      session_keepalive_interval_v2_ms: z
        .number()
        .int()
        .min(0)
        .default(120_000),
    })
    .refine(
      cfg =>
        cfg.non_exclusive_heartbeat_interval_ms > 0 ||
        cfg.poll_interval_ms_at_capacity > 0,
      {
        message:
          'at-capacity liveness requires non_exclusive_heartbeat_interval_ms > 0 or poll_interval_ms_at_capacity > 0',
      },
    )
    .refine(
      cfg =>
        cfg.non_exclusive_heartbeat_interval_ms > 0 ||
        cfg.multisession_poll_interval_ms_at_capacity > 0,
      {
        message:
          'at-capacity liveness requires non_exclusive_heartbeat_interval_ms > 0 or multisession_poll_interval_ms_at_capacity > 0',
      },
    ),
)

/**
 * 从 GrowthBook 获取 bridge poll interval 配置，带 5 分钟刷新窗口。
 * 按 schema 校验下发的 JSON；flag 缺失、格式错误或部分字段缺失时
 * 回退到默认值。
 *
 * bridgeMain.ts（standalone）和 replBridge.ts（REPL）共用，ops 一次
 * 配置推送就能全集群调两种 poll 频率。
 */
export function getPollIntervalConfig(): PollIntervalConfig {
  const raw = getFeatureValue_CACHED_WITH_REFRESH<unknown>(
    'tengu_bridge_poll_interval_config',
    DEFAULT_POLL_CONFIG,
    5 * 60 * 1000,
  )
  const parsed = pollIntervalConfigSchema().safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_POLL_CONFIG
}
