/**
 * Analytics sink 实现
 *
 * 本模块包含实际的 analytics 路由逻辑，应在 app 启动期间初始化。
 * 它将事件路由到 Datadog 和 1P event logging。
 *
 * 用法：在 app 启动期间调用 initializeAnalyticsSink() 来接入 sink。
 */

import { trackDatadogEvent } from './datadog.js'
import { logEventTo1P, shouldSampleEvent } from './firstPartyEventLogger.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from './growthbook.js'
import { attachAnalyticsSink, stripProtoFields } from './index.js'
import { isSinkKilled } from './sinkKillswitch.js'

// 与 logEvent 的 metadata 签名匹配的本地类型
type LogEventMetadata = { [key: string]: boolean | number | undefined }

const DATADOG_GATE_NAME = 'tengu_log_datadog_events'

// 模块级 gate 状态 - 初始为 undefined，启动期间初始化
let isDatadogGateEnabled: boolean | undefined

/**
 * 检查是否启用了 Datadog 追踪。
 * 尚未初始化时，回退到上一个 session 的缓存值。
 */
function shouldTrackDatadog(): boolean {
  if (isSinkKilled('datadog')) {
    return false
  }
  if (isDatadogGateEnabled !== undefined) {
    return isDatadogGateEnabled
  }

  // 回退到上一个 session 的缓存值
  try {
    return checkStatsigFeatureGate_CACHED_MAY_BE_STALE(DATADOG_GATE_NAME)
  } catch {
    return false
  }
}

/**
 * 记录一个事件（同步实现）
 */
function logEventImpl(eventName: string, metadata: LogEventMetadata): void {
  // 检查此事件是否应被采样
  const sampleResult = shouldSampleEvent(eventName)

  // 若采样结果为 0，表示该事件未被选中记录
  if (sampleResult === 0) {
    return
  }

  // 若采样结果为正数，将其加入 metadata
  const metadataWithSampleRate =
    sampleResult !== null
      ? { ...metadata, sample_rate: sampleResult }
      : metadata

  if (shouldTrackDatadog()) {
    // Datadog 是通用访问的后端 —— 剥离 _PROTO_* key
    //（未脱敏的 PII 标记值仅供 1P 特权列使用）。
    void trackDatadogEvent(eventName, stripProtoFields(metadataWithSampleRate))
  }

  // 1P 接收包含 _PROTO_* 的完整 payload —— exporter
  // 自行解构并将这些 key 路由到 proto 字段。
  logEventTo1P(eventName, metadataWithSampleRate)
}

/**
 * 记录一个事件（异步实现）
 *
 * 移除 Segment 后，剩下的两个 sink 都是 fire-and-forget，因此这里
 * 只是包装同步实现 —— 保留它是为了维持 sink 接口契约。
 */
function logEventAsyncImpl(
  eventName: string,
  metadata: LogEventMetadata,
): Promise<void> {
  logEventImpl(eventName, metadata)
  return Promise.resolve()
}

/**
 * 在启动期间初始化 analytics gate。
 *
 * 从 server 更新 gate 值。早期事件使用上一个 session 的缓存值，
 * 以避免初始化期间的数据丢失。
 *
 * 在 setupBackend() 期间由 main.tsx 调用。
 */
export function initializeAnalyticsGates(): void {
  isDatadogGateEnabled =
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE(DATADOG_GATE_NAME)
}

/**
 * 初始化 analytics sink。
 *
 * 在 app 启动期间调用以接入 analytics backend。
 * 在此之前记录的事件都会被入队并随后排空。
 *
 * 幂等：可安全多次调用（后续调用为 no-op）。
 */
export function initializeAnalyticsSink(): void {
  attachAnalyticsSink({
    logEvent: logEventImpl,
    logEventAsync: logEventAsyncImpl,
  })
}
