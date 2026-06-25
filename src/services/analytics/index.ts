/**
 * Analytics service - 事件日志的公开 API
 *
 * 本模块是 Claude CLI 中 analytics 事件的主入口。
 *
 * 设计：本模块没有任何依赖，以避免循环引用。
 * 事件会被入队，直到 app 初始化期间调用 attachAnalyticsSink()。
 * sink 负责将事件路由到 Datadog 和 1P event logging。
 */

/**
 * 标记类型，用于校验 analytics metadata 不含敏感数据
 *
 * 此类型强制开发者显式确认：被记录的字符串值
 * 不包含代码片段、文件路径或其他敏感信息。
 *
 * 用法：`myString as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never

/**
 * 标记类型，用于通过 `_PROTO_*` payload key 将值路由到 PII 标记的 proto 列。
 * 目标 BQ 列具有特权访问控制，因此可接受未脱敏的值——
 * 这一点与通用访问的后端不同。
 *
 * sink.ts 会在 Datadog 扇出前剥离 `_PROTO_*` key；只有 1P exporter
 *（firstPartyEventLoggingExporter）能看到它们，并将其提升到顶层 proto 字段。
 * 单次 stripProtoFields 调用即可守护所有非 1P sink——无需为每个 sink 单独过滤。
 *
 * 用法：`rawName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED`
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = never

/**
 * 从将要写入通用访问存储的 payload 中剥离 `_PROTO_*` key。
 * 使用方：
 *   - sink.ts：在 Datadog 扇出前（永远不会看到 PII 标记的值）
 *   - firstPartyEventLoggingExporter：在将已知 _PROTO_* key 提升到 proto 字段后，
 *     对 additional_metadata 做防御性剥离——防止未来某个无法识别的
 *     _PROTO_foo 静默落入 BQ JSON blob 中。
 *
 * 当不含任何 _PROTO_ key 时，原样返回输入（同一引用）。
 */
export function stripProtoFields<V>(
  metadata: Record<string, V>,
): Record<string, V> {
  let result: Record<string, V> | undefined
  for (const key in metadata) {
    if (key.startsWith('_PROTO_')) {
      if (result === undefined) {
        result = { ...metadata }
      }
      delete result[key]
    }
  }
  return result ?? metadata
}

// logEvent metadata 的内部类型——与 metadata.ts 中经 enrich 的 EventMetadata 不同
type LogEventMetadata = { [key: string]: boolean | number | undefined }

type QueuedEvent = {
  eventName: string
  metadata: LogEventMetadata
  async: boolean
}

/**
 * analytics backend 的 sink 接口
 */
export type AnalyticsSink = {
  logEvent: (eventName: string, metadata: LogEventMetadata) => void
  logEventAsync: (
    eventName: string,
    metadata: LogEventMetadata,
  ) => Promise<void>
}

// 在 sink 接入前记录的事件队列
const eventQueue: QueuedEvent[] = []

// Sink - 在 app 启动期间初始化
let sink: AnalyticsSink | null = null

/**
 * 接入将接收所有事件的 analytics sink。
 * 已入队的事件会通过 queueMicrotask 异步排空，以避免
 * 给启动路径增加延迟。
 *
 * 幂等：如果 sink 已接入，则为 no-op（空操作）。这允许
 * 同时从 preAction hook（针对 subcommand）和 setup()（针对
 * 默认 command）调用，而无需协调。
 */
export function attachAnalyticsSink(newSink: AnalyticsSink): void {
  if (sink !== null) {
    return
  }
  sink = newSink

  // 异步排空队列，避免阻塞启动
  if (eventQueue.length > 0) {
    const queuedEvents = [...eventQueue]
    eventQueue.length = 0

    // 为 ant 记录队列大小，帮助调试 analytics 初始化时序
    if (process.env.USER_TYPE === 'ant') {
      sink.logEvent('analytics_sink_attached', {
        queued_event_count: queuedEvents.length,
      })
    }

    queueMicrotask(() => {
      for (const event of queuedEvents) {
        if (event.async) {
          void sink!.logEventAsync(event.eventName, event.metadata)
        } else {
          sink!.logEvent(event.eventName, event.metadata)
        }
      }
    })
  }
}

/**
 * 向 analytics backend 记录一个事件（同步）
 *
 * 事件可能根据 'tengu_event_sampling_config' 动态配置被采样。
 * 命中采样时，sample_rate 会被加入事件 metadata。
 *
 * 若没有 sink 接入，事件会先入队，待 sink 接入后再排空。
 */
export function logEvent(
  eventName: string,
  // 故意不接收 string，除非带 AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS，
  // 以避免意外记录代码/文件路径
  metadata: LogEventMetadata,
): void {
  if (sink === null) {
    eventQueue.push({ eventName, metadata, async: false })
    return
  }
  sink.logEvent(eventName, metadata)
}

/**
 * 向 analytics backend 记录一个事件（异步）
 *
 * 事件可能根据 'tengu_event_sampling_config' 动态配置被采样。
 * 命中采样时，sample_rate 会被加入事件 metadata。
 *
 * 若没有 sink 接入，事件会先入队，待 sink 接入后再排空。
 */
export async function logEventAsync(
  eventName: string,
  // 故意不接收 string，以避免意外记录代码/文件路径
  metadata: LogEventMetadata,
): Promise<void> {
  if (sink === null) {
    eventQueue.push({ eventName, metadata, async: true })
    return
  }
  await sink.logEventAsync(eventName, metadata)
}

/**
 * 重置 analytics 状态，仅供测试使用。
 * @internal
 */
export function _resetForTesting(): void {
  sink = null
  eventQueue.length = 0
}
