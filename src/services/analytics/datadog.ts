import axios from 'axios'
import { createHash } from 'crypto'
import memoize from 'lodash-es/memoize.js'
import { getOrCreateUserID } from '../../utils/config.js'
import { logError } from '../../utils/log.js'
import { getCanonicalName } from '../../utils/model/model.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { MODEL_COSTS } from '../../utils/modelCost.js'
import { isAnalyticsDisabled } from './config.js'
import { getEventMetadata } from './metadata.js'

/**
 * Datadog 的 endpoint 和 token 通过环境变量配置。
 * 若两者都未设置，则完全禁用 Datadog 日志（不发送任何数据）。
 *
 *   DATADOG_LOGS_ENDPOINT=https://http-intake.logs.datadoghq.com/api/v2/logs
 *   DATADOG_API_KEY=<your-key>
 */
const DATADOG_LOGS_ENDPOINT = process.env.DATADOG_LOGS_ENDPOINT ?? ''
const DATADOG_CLIENT_TOKEN = process.env.DATADOG_API_KEY ?? ''
const DEFAULT_FLUSH_INTERVAL_MS = 15000
const MAX_BATCH_SIZE = 100
const NETWORK_TIMEOUT_MS = 5000

const DATADOG_ALLOWED_EVENTS = new Set([
  'chrome_bridge_connection_succeeded',
  'chrome_bridge_connection_failed',
  'chrome_bridge_disconnected',
  'chrome_bridge_tool_call_completed',
  'chrome_bridge_tool_call_error',
  'chrome_bridge_tool_call_started',
  'chrome_bridge_tool_call_timeout',
  'tengu_api_error',
  'tengu_api_success',
  'tengu_brief_mode_enabled',
  'tengu_brief_mode_toggled',
  'tengu_brief_send',
  'tengu_cancel',
  'tengu_compact_failed',
  'tengu_exit',
  'tengu_flicker',
  'tengu_init',
  'tengu_model_fallback_triggered',
  'tengu_oauth_error',
  'tengu_oauth_success',
  'tengu_oauth_token_refresh_failure',
  'tengu_oauth_token_refresh_success',
  'tengu_oauth_token_refresh_lock_acquiring',
  'tengu_oauth_token_refresh_lock_acquired',
  'tengu_oauth_token_refresh_starting',
  'tengu_oauth_token_refresh_completed',
  'tengu_oauth_token_refresh_lock_releasing',
  'tengu_oauth_token_refresh_lock_released',
  'tengu_query_error',
  'tengu_session_file_read',
  'tengu_started',
  'tengu_tool_use_error',
  'tengu_tool_use_granted_in_prompt_permanent',
  'tengu_tool_use_granted_in_prompt_temporary',
  'tengu_tool_use_rejected_in_prompt',
  'tengu_tool_use_success',
  'tengu_uncaught_exception',
  'tengu_unhandled_rejection',
  'tengu_voice_recording_started',
  'tengu_voice_toggled',
  'tengu_team_mem_sync_pull',
  'tengu_team_mem_sync_push',
  'tengu_team_mem_sync_started',
  'tengu_team_mem_entries_capped',
])

const TAG_FIELDS = [
  'arch',
  'clientType',
  'errorType',
  'http_status_range',
  'http_status',
  'kairosActive',
  'model',
  'platform',
  'provider',
  'skillMode',
  'subscriptionType',
  'toolName',
  'userBucket',
  'userType',
  'version',
  'versionBase',
]

function camelToSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
}

type DatadogLog = {
  ddsource: string
  ddtags: string
  message: string
  service: string
  hostname: string
  [key: string]: unknown
}

let logBatch: DatadogLog[] = []
let flushTimer: NodeJS.Timeout | null = null
let datadogInitialized: boolean | null = null

async function flushLogs(): Promise<void> {
  if (logBatch.length === 0) return

  const logsToSend = logBatch
  logBatch = []

  try {
    await axios.post(DATADOG_LOGS_ENDPOINT, logsToSend, {
      headers: {
        'Content-Type': 'application/json',
        'DD-API-KEY': DATADOG_CLIENT_TOKEN,
      },
      timeout: NETWORK_TIMEOUT_MS,
    })
  } catch (error) {
    logError(error)
  }
}

function scheduleFlush(): void {
  if (flushTimer) return

  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushLogs()
  }, getFlushIntervalMs()).unref()
}

export const initializeDatadog = memoize(async (): Promise<boolean> => {
  if (isAnalyticsDisabled()) {
    datadogInitialized = false
    return false
  }

  // 未配置自定义 endpoint —— 完全跳过 Datadog
  if (!DATADOG_LOGS_ENDPOINT || !DATADOG_CLIENT_TOKEN) {
    datadogInitialized = false
    return false
  }

  try {
    datadogInitialized = true
    return true
  } catch (error) {
    logError(error)
    datadogInitialized = false
    return false
  }
})

/**
 * 排空剩余的 Datadog 日志并关闭。
 * 在 process.exit() 之前由 gracefulShutdown() 调用，因为
 * forceExit() 会阻止 beforeExit handler 触发。
 */
export async function shutdownDatadog(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  await flushLogs()
}

// 注意：通过 src/services/analytics/index.ts > logEvent 使用
export async function trackDatadogEvent(
  eventName: string,
  properties: { [key: string]: boolean | number | undefined },
): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    return
  }

  // 不为 3P provider（Bedrock、Vertex、Foundry）发送事件
  if (getAPIProvider() !== 'firstParty') {
    return
  }

  // 快速路径：如可用则使用缓存结果，避免 await 开销
  let initialized = datadogInitialized
  if (initialized === null) {
    initialized = await initializeDatadog()
  }
  if (!initialized || !DATADOG_ALLOWED_EVENTS.has(eventName)) {
    return
  }

  try {
    const metadata = await getEventMetadata({
      model: properties.model,
      betas: properties.betas,
    })
    // 解构以避免 envContext 重复（一次嵌套、一次展开）
    const { envContext, ...restMetadata } = metadata
    const allData: Record<string, unknown> = {
      ...restMetadata,
      ...envContext,
      ...properties,
      userBucket: getUserBucket(),
    }

    // 将 MCP tool 名归一化为 "mcp"，以降低 cardinality（基数）
    if (
      typeof allData.toolName === 'string' &&
      allData.toolName.startsWith('mcp__')
    ) {
      allData.toolName = 'mcp'
    }

    // 归一化 model 名以降低 cardinality（仅对外部用户）
    if (process.env.USER_TYPE !== 'ant' && typeof allData.model === 'string') {
      const shortName = getCanonicalName(allData.model.replace(/\[1m]$/i, ''))
      allData.model = shortName in MODEL_COSTS ? shortName : 'other'
    }

    // 将 dev 版本截断为 base + date（移除 timestamp 和 sha 以降低 cardinality）
    // 例如 "2.0.53-dev.20251124.t173302.sha526cc6a" -> "2.0.53-dev.20251124"
    if (typeof allData.version === 'string') {
      allData.version = allData.version.replace(
        /^(\d+\.\d+\.\d+-dev\.\d{8})\.t\d+\.sha[a-f0-9]+$/,
        '$1',
      )
    }

    // 将 status 转换为 http_status 和 http_status_range，以避开 Datadog 的保留字段
    if (allData.status !== undefined && allData.status !== null) {
      const statusCode = String(allData.status)
      allData.http_status = statusCode

      // 判断 status 区间（1xx、2xx、3xx、4xx、5xx）
      const firstDigit = statusCode.charAt(0)
      if (firstDigit >= '1' && firstDigit <= '5') {
        allData.http_status_range = `${firstDigit}xx`
      }

      // 移除原始 status 字段，避免与 Datadog 的保留字段冲突
      delete allData.status
    }

    // 用高 cardinality 字段构建 ddtags，便于过滤。
    // 前置 event:<name>，使事件名可通过 log search API 检索——
    // `message` 字段（eventName 也存放在这里）是 DD 保留字段，
    // 无法从 dashboard widget 查询或 aggregation API 检索。
    // 参见 scripts/release/MONITORING.md。
    const allDataRecord = allData
    const tags = [
      `event:${eventName}`,
      ...TAG_FIELDS.filter(
        field =>
          allDataRecord[field] !== undefined && allDataRecord[field] !== null,
      ).map(field => `${camelToSnakeCase(field)}:${allDataRecord[field]}`),
    ]

    const log: DatadogLog = {
      ddsource: 'nodejs',
      ddtags: tags.join(','),
      message: eventName,
      service: 'claude-code',
      hostname: 'claude-code',
      env: process.env.USER_TYPE,
    }

    // 将所有字段作为可搜索 attribute 加入（不与 tags 重复）
    for (const [key, value] of Object.entries(allData)) {
      if (value !== undefined && value !== null) {
        log[camelToSnakeCase(key)] = value
      }
    }

    logBatch.push(log)

    // 若批次已满则立即排空，否则调度排空
    if (logBatch.length >= MAX_BATCH_SIZE) {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      void flushLogs()
    } else {
      scheduleFlush()
    }
  } catch (error) {
    logError(error)
  }
}

const NUM_USER_BUCKETS = 30

/**
 * 获取 user ID 所属的 'bucket'（桶）。
 *
 * 出于告警目的，我们希望针对受某问题影响的用户数量告警，
 * 而非事件数量——少数用户往往会产生大量事件（如因重试）。
 * 为在不直接计数 user ID（以免破坏 cardinality）的前提下近似这一目标，
 * 我们对 user ID 做哈希，并将其分配到固定数量的 bucket 之一。
 *
 * 这使我们可以通过计数唯一 bucket 来估算唯一用户数，
 * 同时保护用户隐私并降低 cardinality。
 */
const getUserBucket = memoize((): number => {
  const userId = getOrCreateUserID()
  const hash = createHash('sha256').update(userId).digest('hex')
  return parseInt(hash.slice(0, 8), 16) % NUM_USER_BUCKETS
})

function getFlushIntervalMs(): number {
  // 允许测试覆盖，以免阻塞在默认 flush 间隔上。
  return (
    parseInt(process.env.CLAUDE_CODE_DATADOG_FLUSH_INTERVAL_MS || '', 10) ||
    DEFAULT_FLUSH_INTERVAL_MS
  )
}
