import { DiagLogLevel, diag, trace } from '@opentelemetry/api'
import { logs } from '@opentelemetry/api-logs'
// OTLP/Prometheus 导出器在下面的协议 switch 语句中动态导入。
// 每个进程每个信号最多使用一种协议变体，但静态导入会在每次启动时
// 加载全部 6 个变体（约 1.2MB）。
import {
  envDetector,
  hostDetector,
  osDetector,
  resourceFromAttributes,
} from '@opentelemetry/resources'
import {
  BatchLogRecordProcessor,
  ConsoleLogRecordExporter,
  LoggerProvider,
} from '@opentelemetry/sdk-logs'
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
} from '@opentelemetry/sdk-trace-base'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  SEMRESATTRS_HOST_ARCH,
} from '@opentelemetry/semantic-conventions'
import { HttpsProxyAgent } from 'https-proxy-agent'
import {
  getLoggerProvider,
  getMeterProvider,
  getTracerProvider,
  setEventLogger,
  setLoggerProvider,
  setMeterProvider,
  setTracerProvider,
} from 'src/bootstrap/state.js'
import {
  getOtelHeadersFromHelper,
  getSubscriptionType,
  is1PApiCustomer,
  isClaudeAISubscriber,
} from 'src/utils/auth.js'
import { getPlatform, getWslVersion } from 'src/utils/platform.js'

import { getCACertificates } from '../caCerts.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { getHasFormattedOutput, logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { errorMessage } from '../errors.js'
import { getMTLSConfig } from '../mtls.js'
import { getProxyUrl, shouldBypassProxy } from '../proxy.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { jsonStringify } from '../slowOperations.js'
import { profileCheckpoint } from '../startupProfiler.js'
import { isBetaTracingEnabled } from './betaSessionTracing.js'
import { BigQueryMetricsExporter } from './bigqueryExporter.js'
import { ClaudeCodeDiagLogger } from './logger.js'
import { initializePerfettoTracing } from './perfettoTracing.js'
import {
  endInteractionSpan,
  isEnhancedTelemetryEnabled,
} from './sessionTracing.js'

const DEFAULT_METRICS_EXPORT_INTERVAL_MS = 60000
const DEFAULT_LOGS_EXPORT_INTERVAL_MS = 5000
const DEFAULT_TRACES_EXPORT_INTERVAL_MS = 5000

class TelemetryTimeoutError extends Error {}

function telemetryTimeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(
      (rej: (e: Error) => void, msg: string) =>
        rej(new TelemetryTimeoutError(msg)),
      ms,
      reject,
      message,
    ).unref()
  })
}

export function bootstrapTelemetry() {
  if (process.env.USER_TYPE === 'ant') {
    // 从构建时定义的 ANT_ 前缀变量中读取
    if (process.env.ANT_OTEL_METRICS_EXPORTER) {
      process.env.OTEL_METRICS_EXPORTER = process.env.ANT_OTEL_METRICS_EXPORTER
    }
    if (process.env.ANT_OTEL_LOGS_EXPORTER) {
      process.env.OTEL_LOGS_EXPORTER = process.env.ANT_OTEL_LOGS_EXPORTER
    }
    if (process.env.ANT_OTEL_TRACES_EXPORTER) {
      process.env.OTEL_TRACES_EXPORTER = process.env.ANT_OTEL_TRACES_EXPORTER
    }
    if (process.env.ANT_OTEL_EXPORTER_OTLP_PROTOCOL) {
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL =
        process.env.ANT_OTEL_EXPORTER_OTLP_PROTOCOL
    }
    if (process.env.ANT_OTEL_EXPORTER_OTLP_ENDPOINT) {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT =
        process.env.ANT_OTEL_EXPORTER_OTLP_ENDPOINT
    }
    if (process.env.ANT_OTEL_EXPORTER_OTLP_HEADERS) {
      process.env.OTEL_EXPORTER_OTLP_HEADERS =
        process.env.ANT_OTEL_EXPORTER_OTLP_HEADERS
    }
  }

  // 将默认时间性设置为 'delta'，因为这是更合理的默认值
  if (!process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE) {
    process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE = 'delta'
  }
}

// 根据 OTEL 规范，"none" 表示"该信号没有自动配置的导出器"。
// https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/#exporter-selection
export function parseExporterTypes(value: string | undefined): string[] {
  return (value || '')
    .trim()
    .split(',')
    .filter(Boolean)
    .map(t => t.trim())
    .filter(t => t !== 'none')
}

async function getOtlpReaders() {
  const exporterTypes = parseExporterTypes(process.env.OTEL_METRICS_EXPORTER)
  const exportInterval = parseInt(
    process.env.OTEL_METRIC_EXPORT_INTERVAL ||
      DEFAULT_METRICS_EXPORT_INTERVAL_MS.toString(),
    10,
  )

  const exporters = []
  for (const exporterType of exporterTypes) {
    if (exporterType === 'console') {
      // 自定义控制台导出器，显示资源属性
      const consoleExporter = new ConsoleMetricExporter()
      const originalExport = consoleExporter.export.bind(consoleExporter)

      consoleExporter.export = (metrics, callback) => {
        // 在开始时记录一次资源属性
        if (metrics.resource && metrics.resource.attributes) {
          // 控制台导出器用于调试，因此此处的控制台输出是有意的

          logForDebugging('\n=== Resource Attributes ===')
          logForDebugging(jsonStringify(metrics.resource.attributes))
          logForDebugging('===========================\n')
        }

        return originalExport(metrics, callback)
      }

      exporters.push(consoleExporter)
    } else if (exporterType === 'otlp') {
      const protocol =
        process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL?.trim() ||
        process.env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim()

      const httpConfig = getOTLPExporterConfig()

      switch (protocol) {
        case 'grpc': {
          // 延迟导入以避免在协议为 http/protobuf（内部默认）或 http/json 时
          // 将 @grpc/grpc-js（约 700KB）加载到遥测 chunk 中
          const { OTLPMetricExporter } = await import(
            '@opentelemetry/exporter-metrics-otlp-grpc'
          )
          exporters.push(new OTLPMetricExporter())
          break
        }
        case 'http/json': {
          const { OTLPMetricExporter } = await import(
            '@opentelemetry/exporter-metrics-otlp-http'
          )
          exporters.push(new OTLPMetricExporter(httpConfig))
          break
        }
        case 'http/protobuf': {
          const { OTLPMetricExporter } = await import(
            '@opentelemetry/exporter-metrics-otlp-proto'
          )
          exporters.push(new OTLPMetricExporter(httpConfig))
          break
        }
        default:
          throw new Error(
            `Unknown protocol set in OTEL_EXPORTER_OTLP_METRICS_PROTOCOL or OTEL_EXPORTER_OTLP_PROTOCOL env var: ${protocol}`,
          )
      }
    } else if (exporterType === 'prometheus') {
      const { PrometheusExporter } = await import(
        '@opentelemetry/exporter-prometheus'
      )
      exporters.push(new PrometheusExporter())
    } else {
      throw new Error(
        `Unknown exporter type set in OTEL_EXPORTER_OTLP_METRICS_PROTOCOL or OTEL_EXPORTER_OTLP_PROTOCOL env var: ${exporterType}`,
      )
    }
  }

  return exporters.map(exporter => {
    if ('export' in exporter) {
      return new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: exportInterval,
      })
    }
    return exporter
  })
}

async function getOtlpLogExporters() {
  const exporterTypes = parseExporterTypes(process.env.OTEL_LOGS_EXPORTER)

  const protocol =
    process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL?.trim() ||
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim()
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT

  logForDebugging(
    `[3P telemetry] getOtlpLogExporters: types=${jsonStringify(exporterTypes)}, protocol=${protocol}, endpoint=${endpoint}`,
  )

  const exporters = []
  for (const exporterType of exporterTypes) {
    if (exporterType === 'console') {
      exporters.push(new ConsoleLogRecordExporter())
    } else if (exporterType === 'otlp') {
      const httpConfig = getOTLPExporterConfig()

      switch (protocol) {
        case 'grpc': {
          const { OTLPLogExporter } = await import(
            '@opentelemetry/exporter-logs-otlp-grpc'
          )
          exporters.push(new OTLPLogExporter())
          break
        }
        case 'http/json': {
          const { OTLPLogExporter } = await import(
            '@opentelemetry/exporter-logs-otlp-http'
          )
          exporters.push(new OTLPLogExporter(httpConfig))
          break
        }
        case 'http/protobuf': {
          const { OTLPLogExporter } = await import(
            '@opentelemetry/exporter-logs-otlp-proto'
          )
          exporters.push(new OTLPLogExporter(httpConfig))
          break
        }
        default:
          throw new Error(
            `Unknown protocol set in OTEL_EXPORTER_OTLP_LOGS_PROTOCOL or OTEL_EXPORTER_OTLP_PROTOCOL env var: ${protocol}`,
          )
      }
    } else {
      throw new Error(
        `Unknown exporter type set in OTEL_LOGS_EXPORTER env var: ${exporterType}`,
      )
    }
  }

  return exporters
}

async function getOtlpTraceExporters() {
  const exporterTypes = parseExporterTypes(process.env.OTEL_TRACES_EXPORTER)

  const exporters = []
  for (const exporterType of exporterTypes) {
    if (exporterType === 'console') {
      exporters.push(new ConsoleSpanExporter())
    } else if (exporterType === 'otlp') {
      const protocol =
        process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL?.trim() ||
        process.env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim()

      const httpConfig = getOTLPExporterConfig()

      switch (protocol) {
        case 'grpc': {
          const { OTLPTraceExporter } = await import(
            '@opentelemetry/exporter-trace-otlp-grpc'
          )
          exporters.push(new OTLPTraceExporter())
          break
        }
        case 'http/json': {
          const { OTLPTraceExporter } = await import(
            '@opentelemetry/exporter-trace-otlp-http'
          )
          exporters.push(new OTLPTraceExporter(httpConfig))
          break
        }
        case 'http/protobuf': {
          const { OTLPTraceExporter } = await import(
            '@opentelemetry/exporter-trace-otlp-proto'
          )
          exporters.push(new OTLPTraceExporter(httpConfig))
          break
        }
        default:
          throw new Error(
            `Unknown protocol set in OTEL_EXPORTER_OTLP_TRACES_PROTOCOL or OTEL_EXPORTER_OTLP_PROTOCOL env var: ${protocol}`,
          )
      }
    } else {
      throw new Error(
        `Unknown exporter type set in OTEL_TRACES_EXPORTER env var: ${exporterType}`,
      )
    }
  }

  return exporters
}

export function isTelemetryEnabled() {
  return isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_TELEMETRY)
}

function getBigQueryExportingReader() {
  const bigqueryExporter = new BigQueryMetricsExporter()
  return new PeriodicExportingMetricReader({
    exporter: bigqueryExporter,
    exportIntervalMillis: 5 * 60 * 1000, // BigQuery 指标导出器的间隔为 5 分钟，以降低负载
  })
}

function isBigQueryMetricsEnabled() {
  // BigQuery 指标对以下用户启用：
  // 1. API 客户（不包括 Claude.ai 订阅者和 Bedrock/Vertex 用户）
  // 2. Claude for Enterprise (C4E) 用户
  // 3. Claude for Teams 用户
  const subscriptionType = getSubscriptionType()
  const isC4EOrTeamUser =
    isClaudeAISubscriber() &&
    (subscriptionType === 'enterprise' || subscriptionType === 'team')

  return is1PApiCustomer() || isC4EOrTeamUser
}

/**
 * 初始化 Beta 追踪 - 用于详细调试的独立代码路径。
 * 使用 BETA_TRACING_ENDPOINT 而非 OTEL_EXPORTER_OTLP_ENDPOINT。
 */
async function initializeBetaTracing(
  resource: ReturnType<typeof resourceFromAttributes>,
): Promise<void> {
  const endpoint = process.env.BETA_TRACING_ENDPOINT
  if (!endpoint) {
    return
  }

  const [{ OTLPTraceExporter }, { OTLPLogExporter }] = await Promise.all([
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/exporter-logs-otlp-http'),
  ])

  const httpConfig = {
    url: `${endpoint}/v1/traces`,
  }

  const logHttpConfig = {
    url: `${endpoint}/v1/logs`,
  }

  // 初始化追踪导出器
  const traceExporter = new OTLPTraceExporter(httpConfig)
  const spanProcessor = new BatchSpanProcessor(traceExporter, {
    scheduledDelayMillis: DEFAULT_TRACES_EXPORT_INTERVAL_MS,
  })

  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [spanProcessor],
  })

  trace.setGlobalTracerProvider(tracerProvider)
  setTracerProvider(tracerProvider)

  // 初始化日志导出器
  const logExporter = new OTLPLogExporter(logHttpConfig)
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor(logExporter, {
        scheduledDelayMillis: DEFAULT_LOGS_EXPORT_INTERVAL_MS,
      }),
    ],
  })

  logs.setGlobalLoggerProvider(loggerProvider)
  setLoggerProvider(loggerProvider)

  // 初始化事件日志记录器
  const eventLogger = logs.getLogger(
    'com.anthropic.claude_code.events',
    MACRO.VERSION,
  )
  setEventLogger(eventLogger)

  // 设置刷新处理器 - 同时刷新日志和追踪
  process.on('beforeExit', async () => {
    await loggerProvider?.forceFlush()
    await tracerProvider?.forceFlush()
  })

  process.on('exit', () => {
    void loggerProvider?.forceFlush()
    void tracerProvider?.forceFlush()
  })
}

export async function initializeTelemetry() {
  profileCheckpoint('telemetry_init_start')
  bootstrapTelemetry()

  // 控制台导出器通过定时器（日志/追踪 5 秒，指标 60 秒）
  // 调用 console.dir，将格式化的对象写入 stdout。在 stream-json
  // 模式下，stdout 是 SDK 的消息通道；第一行（`{`）会破坏
  // SDK 的行读取器。在此处剥离（而非 main.tsx），因为 init.ts
  // 会在 initializeTelemetry-AfterTrust 中为远程托管设置用户
  // 重新运行 applyConfigEnvironmentVariables()，而上面的
  // bootstrapTelemetry 会为内部用户复制 ANT_OTEL_* — 两者
  // 都会撤销更早的剥离操作。
  if (getHasFormattedOutput()) {
    for (const key of [
      'OTEL_METRICS_EXPORTER',
      'OTEL_LOGS_EXPORTER',
      'OTEL_TRACES_EXPORTER',
    ] as const) {
      const v = process.env[key]
      if (v?.includes('console')) {
        process.env[key] = v
          .split(',')
          .map(s => s.trim())
          .filter(s => s !== 'console')
          .join(',')
      }
    }
  }

  diag.setLogger(new ClaudeCodeDiagLogger(), DiagLogLevel.ERROR)

  // 初始化 Perfetto 追踪（独立于 OTEL）
  // 通过 CLAUDE_CODE_PERFETTO_TRACE=1 或 CLAUDE_CODE_PERFETTO_TRACE=<path> 启用
  initializePerfettoTracing()

  const readers = []

  // 添加客户导出器（如果已启用）
  const telemetryEnabled = isTelemetryEnabled()
  logForDebugging(
    `[3P telemetry] isTelemetryEnabled=${telemetryEnabled} (CLAUDE_CODE_ENABLE_TELEMETRY=${process.env.CLAUDE_CODE_ENABLE_TELEMETRY})`,
  )
  if (telemetryEnabled) {
    readers.push(...(await getOtlpReaders()))
  }

  // 添加 BigQuery 导出器（适用于 API 客户、C4E 用户和内部用户）
  if (isBigQueryMetricsEnabled()) {
    readers.push(getBigQueryExportingReader())
  }

  // 创建带有服务属性的基础资源
  const platform = getPlatform()
  const baseAttributes: Record<string, string> = {
    [ATTR_SERVICE_NAME]: 'claude-code',
    [ATTR_SERVICE_VERSION]: MACRO.VERSION,
  }

  // 如果在 WSL 上运行则添加 WSL 特定属性
  if (platform === 'wsl') {
    const wslVersion = getWslVersion()
    if (wslVersion) {
      baseAttributes['wsl.version'] = wslVersion
    }
  }

  const baseResource = resourceFromAttributes(baseAttributes)

  // 使用 OpenTelemetry 检测器
  const osResource = resourceFromAttributes(
    osDetector.detect().attributes || {},
  )

  // 仅从 hostDetector 中提取 host.arch
  const hostDetected = hostDetector.detect()
  const hostArchAttributes = hostDetected.attributes?.[SEMRESATTRS_HOST_ARCH]
    ? {
        [SEMRESATTRS_HOST_ARCH]: hostDetected.attributes[SEMRESATTRS_HOST_ARCH],
      }
    : {}
  const hostArchResource = resourceFromAttributes(hostArchAttributes)

  const envResource = resourceFromAttributes(
    envDetector.detect().attributes || {},
  )

  // 合并资源 - 后面的资源优先
  const resource = baseResource
    .merge(osResource)
    .merge(hostArchResource)
    .merge(envResource)

  // 检查是否启用了 Beta 追踪 - 这是独立的代码路径
  // 所有设置了 ENABLE_BETA_TRACING_DETAILED=1 和 BETA_TRACING_ENDPOINT 的用户可用
  if (isBetaTracingEnabled()) {
    void initializeBetaTracing(resource).catch(e =>
      logForDebugging(`Beta tracing init failed: ${e}`, { level: 'error' }),
    )
    // 仍然设置 meter provider 用于指标（但跳过常规日志/追踪设置）
    const meterProvider = new MeterProvider({
      resource,
      views: [],
      readers,
    })
    setMeterProvider(meterProvider)

    // 注册 Beta 追踪的关闭处理
    const shutdownTelemetry = async () => {
      const timeoutMs = parseInt(
        process.env.CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS || '2000',
        10,
      )
      try {
        endInteractionSpan()

        // 在超时时间内一起执行强制刷新和关闭。之前 forceFlush
        // 在 race 之前被无限制地 await，在 OTLP 端点缓慢时会阻塞退出。
        // 每个 provider 的 flush→shutdown 独立链接，因此缓慢的 logger
        // 刷新不会延迟 meterProvider/tracerProvider 的关闭（无级联等待）。
        const loggerProvider = getLoggerProvider()
        const tracerProvider = getTracerProvider()

        const chains: Promise<void>[] = [meterProvider.shutdown()]
        if (loggerProvider) {
          chains.push(
            loggerProvider.forceFlush().then(() => loggerProvider.shutdown()),
          )
        }
        if (tracerProvider) {
          chains.push(
            tracerProvider.forceFlush().then(() => tracerProvider.shutdown()),
          )
        }

        await Promise.race([
          Promise.all(chains),
          telemetryTimeout(timeoutMs, 'OpenTelemetry shutdown timeout'),
        ])
      } catch {
        // 忽略关闭错误
      }
    }
    registerCleanup(shutdownTelemetry)

    return meterProvider.getMeter('com.anthropic.claude_code', MACRO.VERSION)
  }

  const meterProvider = new MeterProvider({
    resource,
    views: [],
    readers,
  })

  // 在状态中保存引用以便刷新
  setMeterProvider(meterProvider)

  // 如果遥测已启用则初始化日志
  if (telemetryEnabled) {
    const logExporters = await getOtlpLogExporters()
    logForDebugging(
      `[3P telemetry] Created ${logExporters.length} log exporter(s)`,
    )

    if (logExporters.length > 0) {
      const loggerProvider = new LoggerProvider({
        resource,
        // 为每个导出器添加批处理器
        processors: logExporters.map(
          exporter =>
            new BatchLogRecordProcessor(exporter, {
              scheduledDelayMillis: parseInt(
                process.env.OTEL_LOGS_EXPORT_INTERVAL ||
                  DEFAULT_LOGS_EXPORT_INTERVAL_MS.toString(),
                10,
              ),
            }),
        ),
      })

      // 全局注册 logger provider
      logs.setGlobalLoggerProvider(loggerProvider)
      setLoggerProvider(loggerProvider)

      // 初始化事件日志记录器
      const eventLogger = logs.getLogger(
        'com.anthropic.claude_code.events',
        MACRO.VERSION,
      )
      setEventLogger(eventLogger)
      logForDebugging('[3P telemetry] Event logger set successfully')

      // 当 Node.js 清空事件循环且没有额外工作可调度时，会触发 'beforeExit'。
      // 与 'exit' 不同，它允许执行异步操作，因此适合在进程自然退出前
      // 让网络请求完成。
      process.on('beforeExit', async () => {
        await loggerProvider?.forceFlush()
        // 同时刷新追踪 - 它们使用 BatchSpanProcessor，需要显式刷新
        const tracerProvider = getTracerProvider()
        await tracerProvider?.forceFlush()
      })

      process.on('exit', () => {
        // 最后一次尝试刷新日志和追踪
        void loggerProvider?.forceFlush()
        void getTracerProvider()?.forceFlush()
      })
    }
  }

  // 如果增强遥测已启用则初始化追踪（BETA）
  if (telemetryEnabled && isEnhancedTelemetryEnabled()) {
    const traceExporters = await getOtlpTraceExporters()
    if (traceExporters.length > 0) {
      // 为每个导出器创建跨度处理器
      const spanProcessors = traceExporters.map(
        exporter =>
          new BatchSpanProcessor(exporter, {
            scheduledDelayMillis: parseInt(
              process.env.OTEL_TRACES_EXPORT_INTERVAL ||
                DEFAULT_TRACES_EXPORT_INTERVAL_MS.toString(),
              10,
            ),
          }),
      )

      const tracerProvider = new BasicTracerProvider({
        resource,
        spanProcessors,
      })

      // 全局注册 tracer provider
      trace.setGlobalTracerProvider(tracerProvider)
      setTracerProvider(tracerProvider)
    }
  }

  // 退出时关闭指标和日志（刷新并关闭导出器）
  const shutdownTelemetry = async () => {
    const timeoutMs = parseInt(
      process.env.CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS || '2000',
      10,
    )

    try {
      // 在关闭前结束任何活跃的交互跨度
      endInteractionSpan()

      const shutdownPromises = [meterProvider.shutdown()]
      const loggerProvider = getLoggerProvider()
      if (loggerProvider) {
        shutdownPromises.push(loggerProvider.shutdown())
      }
      const tracerProvider = getTracerProvider()
      if (tracerProvider) {
        shutdownPromises.push(tracerProvider.shutdown())
      }

      await Promise.race([
        Promise.all(shutdownPromises),
        telemetryTimeout(timeoutMs, 'OpenTelemetry shutdown timeout'),
      ])
    } catch (error) {
      if (error instanceof Error && error.message.includes('timeout')) {
        logForDebugging(
          `
OpenTelemetry telemetry flush timed out after ${timeoutMs}ms

To resolve this issue, you can:
1. Increase the timeout by setting CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS env var (e.g., 5000 for 5 seconds)
2. Check if your OpenTelemetry backend is experiencing scalability issues
3. Disable OpenTelemetry by unsetting CLAUDE_CODE_ENABLE_TELEMETRY env var

Current timeout: ${timeoutMs}ms
`,
          { level: 'error' },
        )
      }
      throw error
    }
  }

  // 始终注册关闭处理（内部指标始终启用）
  registerCleanup(shutdownTelemetry)

  return meterProvider.getMeter('com.anthropic.claude_code', MACRO.VERSION)
}

/**
 * 立即刷新所有待处理的遥测数据。
 * 应在登出或切换组织之前调用，以防止数据泄漏。
 */
export async function flushTelemetry(): Promise<void> {
  const meterProvider = getMeterProvider()
  if (!meterProvider) {
    return
  }

  const timeoutMs = parseInt(
    process.env.CLAUDE_CODE_OTEL_FLUSH_TIMEOUT_MS || '5000',
    10,
  )

  try {
    const flushPromises = [meterProvider.forceFlush()]
    const loggerProvider = getLoggerProvider()
    if (loggerProvider) {
      flushPromises.push(loggerProvider.forceFlush())
    }
    const tracerProvider = getTracerProvider()
    if (tracerProvider) {
      flushPromises.push(tracerProvider.forceFlush())
    }

    await Promise.race([
      Promise.all(flushPromises),
      telemetryTimeout(timeoutMs, 'OpenTelemetry flush timeout'),
    ])

    logForDebugging('Telemetry flushed successfully')
  } catch (error) {
    if (error instanceof TelemetryTimeoutError) {
      logForDebugging(
        `Telemetry flush timed out after ${timeoutMs}ms. Some metrics may not be exported.`,
        { level: 'warn' },
      )
    } else {
      logForDebugging(`Telemetry flush failed: ${errorMessage(error)}`, {
        level: 'error',
      })
    }
    // 不抛出异常 - 即使刷新失败也允许登出继续
  }
}

function parseOtelHeadersEnvVar(): Record<string, string> {
  const headers: Record<string, string> = {}
  const envHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS
  if (envHeaders) {
    for (const pair of envHeaders.split(',')) {
      const [key, ...valueParts] = pair.split('=')
      if (key && valueParts.length > 0) {
        headers[key.trim()] = valueParts.join('=').trim()
      }
    }
  }
  return headers
}

/**
 * 获取 OTLP 导出器的配置，包括：
 * - HTTP Agent 选项（代理、mTLS）
 * - 通过 otelHeadersHelper 的动态头部或来自环境变量的静态头部
 */
function getOTLPExporterConfig() {
  const proxyUrl = getProxyUrl()
  const mtlsConfig = getMTLSConfig()
  const settings = getSettings_DEPRECATED()

  // 构建基础配置
  const config: Record<string, unknown> = {}

  // 从环境变量中解析静态头部（运行时不会变化）
  const staticHeaders = parseOtelHeadersEnvVar()

  // 如果配置了 otelHeadersHelper，使用异步头部函数进行动态刷新
  // 否则仅返回静态头部（如果存在）
  if (settings?.otelHeadersHelper) {
    config.headers = async (): Promise<Record<string, string>> => {
      const dynamicHeaders = getOtelHeadersFromHelper()
      return { ...staticHeaders, ...dynamicHeaders }
    }
  } else if (Object.keys(staticHeaders).length > 0) {
    config.headers = async (): Promise<Record<string, string>> => staticHeaders
  }

  // 检查是否应为 OTEL 端点绕过代理
  const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!proxyUrl || (otelEndpoint && shouldBypassProxy(otelEndpoint))) {
    // 未配置代理或 OTEL 端点应绕过代理
    const caCerts = getCACertificates()
    if (mtlsConfig || caCerts) {
      config.httpAgentOptions = {
        ...mtlsConfig,
        ...(caCerts && { ca: caCerts }),
      }
    }
    return config
  }

  // 返回一个 HttpAgentFactory 函数来创建代理 Agent
  const caCerts = getCACertificates()
  const agentFactory = (_protocol: string) => {
    // 创建并返回带有 mTLS 和 CA 证书配置的代理 Agent
    const proxyAgent =
      mtlsConfig || caCerts
        ? new HttpsProxyAgent(proxyUrl, {
            ...(mtlsConfig && {
              cert: mtlsConfig.cert,
              key: mtlsConfig.key,
              passphrase: mtlsConfig.passphrase,
            }),
            ...(caCerts && { ca: caCerts }),
          })
        : new HttpsProxyAgent(proxyUrl)

    return proxyAgent
  }

  config.httpAgentOptions = agentFactory
  return config
}
