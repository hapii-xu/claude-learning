/**
 * bridge poll interval 的默认值。从 pollConfig.ts 中抽出来，让不需要
 * GrowthBook 实时调优的调用方（Agent SDK 场景下的 daemon）可以避开
 * growthbook.ts → config.ts → file.ts → sessionStorage.ts → commands.ts
 * 这条传递依赖链。
 */

/**
 * 正在主动找 work（没有 transport / 未达 maxSessions）时的 poll interval。
 * 决定了用户可见的 "connecting…" 延迟（初次接 work）以及服务器重新派发
 * work item 之后的恢复速度。
 */
const POLL_INTERVAL_MS_NOT_AT_CAPACITY = 2000

/**
 * transport 已连接时的 poll interval。与 heartbeat 独立运行 —— 两者都
 * 启用时，heartbeat 循环会按此间隔跳出一次去 poll。设为 0 表示完全关闭
 * at-capacity 轮询。
 *
 * 约束此值上界的服务器侧常量：
 * - BRIDGE_LAST_POLL_TTL = 4h（Redis key 过期 → environment 自动归档）
 * - max_poll_stale_seconds = 24h（session 创建健康闸门，当前关闭）
 *
 * 10 分钟相对 Redis TTL 有 24 倍余量，同时仍能在一个 poll 周期内拿到
 * 服务器主动发起的 token 轮换派发。transport 在瞬时 WS 失败时会内部
 * 自动重连 10 分钟，所以 poll 不是恢复路径 —— 它严格来说是存活信号，
 * 再加上 permanent close 的兜底。
 */
const POLL_INTERVAL_MS_AT_CAPACITY = 600_000

/**
 * 多 session bridge（bridgeMain.ts）的 poll interval。默认值与单 session
 * 一致，让缺少这些字段的旧 GrowthBook 配置保持原有行为。ops 可以通过
 * tengu_bridge_poll_interval_config GB flag 独立调这些值。
 */
const MULTISESSION_POLL_INTERVAL_MS_NOT_AT_CAPACITY =
  POLL_INTERVAL_MS_NOT_AT_CAPACITY
const MULTISESSION_POLL_INTERVAL_MS_PARTIAL_CAPACITY =
  POLL_INTERVAL_MS_NOT_AT_CAPACITY
const MULTISESSION_POLL_INTERVAL_MS_AT_CAPACITY = POLL_INTERVAL_MS_AT_CAPACITY

export type PollIntervalConfig = {
  poll_interval_ms_not_at_capacity: number
  poll_interval_ms_at_capacity: number
  non_exclusive_heartbeat_interval_ms: number
  multisession_poll_interval_ms_not_at_capacity: number
  multisession_poll_interval_ms_partial_capacity: number
  multisession_poll_interval_ms_at_capacity: number
  reclaim_older_than_ms: number
  session_keepalive_interval_v2_ms: number
}

export const DEFAULT_POLL_CONFIG: PollIntervalConfig = {
  poll_interval_ms_not_at_capacity: POLL_INTERVAL_MS_NOT_AT_CAPACITY,
  poll_interval_ms_at_capacity: POLL_INTERVAL_MS_AT_CAPACITY,
  // 0 = 禁用。> 0 时，at-capacity 循环按此间隔对每个 work item 发
  // heartbeat。与 poll_interval_ms_at_capacity 独立 —— 两者可以同时运行
  //（heartbeat 周期性地让位一次去 poll）。60s 相对服务器 300s heartbeat
  // TTL 有 5 倍余量。命名为 non_exclusive 是为了和旧的 heartbeat_interval_ms
  // 字段区分（#22145 之前的客户端是"二选一"语义 —— heartbeat 会压制 poll）。
  // 旧客户端忽略此 key；ops 可以在灰度期间同时配两个字段。
  non_exclusive_heartbeat_interval_ms: 0,
  multisession_poll_interval_ms_not_at_capacity:
    MULTISESSION_POLL_INTERVAL_MS_NOT_AT_CAPACITY,
  multisession_poll_interval_ms_partial_capacity:
    MULTISESSION_POLL_INTERVAL_MS_PARTIAL_CAPACITY,
  multisession_poll_interval_ms_at_capacity:
    MULTISESSION_POLL_INTERVAL_MS_AT_CAPACITY,
  // poll 查询参数：reclaim 超过此时间仍未被 ack 的 work item。与服务器
  // 侧的 DEFAULT_RECLAIM_OLDER_THAN_MS（work_service.py:24）对齐。用于
  // 在 JWT 过期后捞回 stale-pending 的 work —— 此前的 ack 因为
  // session_ingress_token 已过期而失败。
  reclaim_older_than_ms: 5000,
  // 0 = 禁用。> 0 时，按此间隔向 session-ingress 推一个静默的
  // {type:'keep_alive'} 帧，防止上游代理 GC 空闲的 remote-control session。
  // 默认 2 分钟。_v2：仅 bridge 使用的 key（pre-v2 客户端读旧 key，新
  // 客户端忽略旧 key）。
  session_keepalive_interval_v2_ms: 120_000,
}
