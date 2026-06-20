import { z } from 'zod/v4'
import { getFeatureValue_DEPRECATED } from '../services/analytics/growthbook.js'
import { lazySchema } from '../utils/lazySchema.js'
import { lt } from '../utils/semver.js'
import { isEnvLessBridgeEnabled } from './bridgeEnabled.js'

export type EnvLessBridgeConfig = {
  // withRetry —— 初始化阶段的退避（createSession、POST /bridge、recovery /bridge）
  init_retry_max_attempts: number
  init_retry_base_delay_ms: number
  init_retry_jitter_fraction: number
  init_retry_max_delay_ms: number
  // POST /sessions、POST /bridge、POST /archive 的 axios 超时
  http_timeout_ms: number
  // BoundedUUIDSet 环形缓冲大小（用于 echo + 重投递去重）
  uuid_dedup_buffer_size: number
  // CCRClient worker heartbeat 节奏。服务器 TTL 是 60s —— 20s 给了 3 倍余量。
  heartbeat_interval_ms: number
  // 间隔的 ±fraction —— 每拍的抖动，分摊整个机群的负载。
  heartbeat_jitter_fraction: number
  // 距 expires_in 多少毫秒时主动刷新 JWT。buffer 越大，刷新越频繁
  //（刷新节奏 ≈ expires_in - buffer）。
  token_refresh_buffer_ms: number
  // teardown() 中 Archive POST 的超时。与 http_timeout_ms 不同，因为
  // gracefulShutdown 让 runCleanupFunctions() 与 2s 上限赛跑 —— 如果
  // archive 阻塞时 axios 还傻等 10s，会把整个预算烧光，而 forceExit
  // 反正会杀掉这个请求。
  teardown_archive_timeout_ms: number
  // transport.connect() 之后等多久 onConnect。如果 onConnect 和 onClose
  // 都没在此期限内触发，上报 tengu_bridge_repl_connect_timeout —— 这是
  // 针对约 1% 发了 `started` 之后就失联（无错误、无事件、什么都没有）
  // 的 session 的唯一埋点。
  connect_timeout_ms: number
  // env-less bridge 路径的 semver 下限。与 v1 tengu_bridge_min_version
  // 配置相互独立，让 v2 专属 bug 能单独强制升级，而不影响 v1（基于 env）
  // 客户端，反之亦然。
  min_version: string
  // 为 true 时，提示用户他们的 claude.ai app 可能太旧看不到 v2 session
  // —— 让我们可以在 app 上线新 session-list 查询之前先灰度 v2 bridge。
  should_show_app_upgrade_message: boolean
}

export const DEFAULT_ENV_LESS_BRIDGE_CONFIG: EnvLessBridgeConfig = {
  init_retry_max_attempts: 3,
  init_retry_base_delay_ms: 500,
  init_retry_jitter_fraction: 0.25,
  init_retry_max_delay_ms: 4000,
  http_timeout_ms: 10_000,
  uuid_dedup_buffer_size: 2000,
  heartbeat_interval_ms: 20_000,
  heartbeat_jitter_fraction: 0.1,
  token_refresh_buffer_ms: 300_000,
  teardown_archive_timeout_ms: 1500,
  connect_timeout_ms: 15_000,
  min_version: '0.0.0',
  should_show_app_upgrade_message: false,
}

// 数值下限在违反时会让整个对象被拒绝（回退到 DEFAULT），而不是部分信任
// —— 与 pollConfig.ts 的纵深防御思路一致。
const envLessBridgeConfigSchema = lazySchema(() =>
  z.object({
    init_retry_max_attempts: z.number().int().min(1).max(10).default(3),
    init_retry_base_delay_ms: z.number().int().min(100).default(500),
    init_retry_jitter_fraction: z.number().min(0).max(1).default(0.25),
    init_retry_max_delay_ms: z.number().int().min(500).default(4000),
    http_timeout_ms: z.number().int().min(2000).default(10_000),
    uuid_dedup_buffer_size: z.number().int().min(100).max(50_000).default(2000),
    // 服务器 TTL 是 60s。下限 5s 防止 thrash；上限 30s 保持 ≥2 倍余量。
    heartbeat_interval_ms: z
      .number()
      .int()
      .min(5000)
      .max(30_000)
      .default(20_000),
    // 每拍 ±fraction。上限 0.5：在最大间隔（30s）× 1.5 = 45s 最坏情况下，
    // 仍低于 60s TTL。
    heartbeat_jitter_fraction: z.number().min(0).max(0.5).default(0.1),
    // 下限 30s 防止紧循环。上限 30min 拒绝"buffer 与 delay"语义颠倒的
    // 配置：ops 如果把 expires_in-5min（*到刷新的延迟*）当成 5min（*到
    // 过期的 buffer*）填进来，delayMs = expires_in - buffer ≈ 5min 而非
    // 约 4h。两者都是正数，光靠 .min() 分不出来；buffer ≥ 30min 对一个
    // 数小时级的 JWT 来说不合理，.max() 能抓住这个颠倒值。
    token_refresh_buffer_ms: z
      .number()
      .int()
      .min(30_000)
      .max(1_800_000)
      .default(300_000),
    // 上限 2000 让它小于 gracefulShutdown 的 2s cleanup 赛跑 —— 再高的
    // 超时只是骗 axios，反正 forceExit 会直接杀 socket。
    teardown_archive_timeout_ms: z
      .number()
      .int()
      .min(500)
      .max(2000)
      .default(1500),
    // 观测到的 p99 connect 约 2-3s；15s 约 5 倍余量。下限 5s 在瞬时变慢
    // 时控制误报率；上限 60s 限制真正卡死的 session 黑屏时长。
    connect_timeout_ms: z.number().int().min(5_000).max(60_000).default(15_000),
    min_version: z
      .string()
      .refine(v => {
        try {
          lt(v, '0.0.0')
          return true
        } catch {
          return false
        }
      })
      .default('0.0.0'),
    should_show_app_upgrade_message: z.boolean().default(false),
  }),
)

/**
 * 从 GrowthBook 拉取 env-less bridge 的时序配置。每次 initEnvLessBridgeCore
 * 调用读一次 —— bridge session 生命周期内配置是固定的。
 *
 * 使用阻塞式 getter（而非 _CACHED_MAY_BE_STALE），因为 /remote-control 的
 * 执行时间远远晚于 GrowthBook init —— initializeGrowthBook() 会立刻
 * resolve，不会拖慢启动，而且我们能拿到内存里最新的 remoteEval 值，而不是
 * 首次读时陈旧的磁盘缓存。_DEPRECATED 后缀只是警告不要在启动路径上用，
 * 这里不属于启动路径。
 */
export async function getEnvLessBridgeConfig(): Promise<EnvLessBridgeConfig> {
  const raw = await getFeatureValue_DEPRECATED<unknown>(
    'tengu_bridge_repl_v2_config',
    DEFAULT_ENV_LESS_BRIDGE_CONFIG,
  )
  const parsed = envLessBridgeConfigSchema().safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_ENV_LESS_BRIDGE_CONFIG
}

/**
 * 当前 CLI 版本低于 env-less（v2）bridge 路径所需的最低版本时返回错误
 * 信息；版本正常则返回 null。
 *
 * v2 对应 checkBridgeMinVersion() —— 读的是 tengu_bridge_repl_v2_config
 * 而不是 tengu_bridge_min_version，让两套实现强制各自独立的下限。
 */
export async function checkEnvLessBridgeMinVersion(): Promise<string | null> {
  const cfg = await getEnvLessBridgeConfig()
  if (cfg.min_version && lt(MACRO.VERSION, cfg.min_version)) {
    return `Your version of Claude Code (${MACRO.VERSION}) is too old for Remote Control.\nVersion ${cfg.min_version} or higher is required. Run \`claude update\` to update.`
  }
  return null
}

/**
 * 是否在 Remote Control session 启动时提示用户升级 claude.ai app。仅当
 * v2 bridge 已启用并且 should_show_app_upgrade_message 配置位被置起时
 * 返回 true —— 让我们能在 app 上线新 session-list 查询之前先灰度
 * v2 bridge。
 */
export async function shouldShowAppUpgradeMessage(): Promise<boolean> {
  if (!isEnvLessBridgeEnabled()) return false
  const cfg = await getEnvLessBridgeConfig()
  return cfg.should_show_app_upgrade_message
}
