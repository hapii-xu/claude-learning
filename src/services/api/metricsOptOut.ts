import axios from 'axios'
import { hasProfileScope, isClaudeAISubscriber } from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { getAuthHeaders, withOAuth401Retry } from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import { memoizeWithTTLAsync } from '../../utils/memoize.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'

type MetricsEnabledResponse = {
  metrics_logging_enabled: boolean
}

type MetricsStatus = {
  enabled: boolean
  hasError: boolean
}

// In-memory TTL — dedupes calls within a single process
const CACHE_TTL_MS = 60 * 60 * 1000

// Disk TTL — org settings rarely change. When disk cache is fresher than this,
// we skip the network entirely (no background refresh). This is what collapses
// N `claude -p` invocations into ~1 API call/day.
const DISK_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Internal function to call the API and check if metrics are enabled
 * This is wrapped by memoizeWithTTLAsync to add caching behavior
 */
async function _fetchMetricsEnabled(): Promise<MetricsEnabledResponse> {
  const authResult = getAuthHeaders()
  if (authResult.error) {
    throw new Error(`Auth error: ${authResult.error}`)
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': getClaudeCodeUserAgent(),
    ...authResult.headers,
  }

  const endpoint = `https://api.anthropic.com/api/claude_code/organizations/metrics_enabled`
  const response = await axios.get<MetricsEnabledResponse>(endpoint, {
    headers,
    timeout: 5000,
  })
  return response.data
}

async function _checkMetricsEnabledAPI(): Promise<MetricsStatus> {
  // 事件兜底开关：当禁用非必要流量时跳过网络调用。
  // 返回 enabled:false 让消费端卸载负载（bigqueryExporter 跳过导出）。
  // 与下面非订阅用户的早返回结果一致。
  if (isEssentialTrafficOnly()) {
    return { enabled: false, hasError: false }
  }

  try {
    const data = await withOAuth401Retry(_fetchMetricsEnabled, {
      also403Revoked: true,
    })

    logForDebugging(
      `Metrics opt-out API response: enabled=${data.metrics_logging_enabled}`,
    )

    return {
      enabled: data.metrics_logging_enabled,
      hasError: false,
    }
  } catch (error) {
    logForDebugging(
      `Failed to check metrics opt-out status: ${errorMessage(error)}`,
    )
    logError(error)
    return { enabled: false, hasError: true }
  }
}

// 创建带自定义错误处理的 memoize 版本
const memoizedCheckMetrics = memoizeWithTTLAsync(
  _checkMetricsEnabledAPI,
  CACHE_TTL_MS,
)

/**
 * 拉取（内存 memoize）并在变化时持久化到磁盘。
 * 错误不持久化 —— 瞬时失败不应覆盖已知的良好磁盘值。
 */
async function refreshMetricsStatus(): Promise<MetricsStatus> {
  const result = await memoizedCheckMetrics()
  if (result.hasError) {
    return result
  }

  const cached = getGlobalConfig().metricsStatusCache
  const unchanged = cached !== undefined && cached.enabled === result.enabled
  // 未变化且时间戳仍然新鲜时跳过写入 —— 避免并发调用方越过陈旧的磁盘条目
  // 后都尝试写入导致的配置抖动。
  if (unchanged && Date.now() - cached.timestamp < DISK_CACHE_TTL_MS) {
    return result
  }

  saveGlobalConfig(current => ({
    ...current,
    metricsStatusCache: {
      enabled: result.enabled,
      timestamp: Date.now(),
    },
  }))
  return result
}

/**
 * 检查当前组织是否启用了 metrics。
 *
 * 两级缓存：
 * - 磁盘（24h TTL）：能在进程重启后保留。新鲜磁盘缓存 → 零网络。
 * - 内存（1h TTL）：在进程内对后台刷新去重。
 *
 * 调用方（bigqueryExporter）能容忍陈旧读取 —— 在 24h 窗口内漏掉或
 * 多出一次导出都是可以接受的。
 */
export async function checkMetricsEnabled(): Promise<MetricsStatus> {
  // Service key OAuth session 缺少 user:profile scope → 会返回 403。
  // API key 用户（非订阅）会走下来使用 x-api-key 认证。
  // 这个检查在磁盘读取之前运行，所以我们从不会持久化基于认证状态的
  // 结果 —— 只有真实的 API 响应才写入磁盘。否则一个 service-key
  // session 会污染后续完整 OAuth session 的缓存。
  if (isClaudeAISubscriber() && !hasProfileScope()) {
    return { enabled: false, hasError: false }
  }

  const cached = getGlobalConfig().metricsStatusCache
  if (cached) {
    if (Date.now() - cached.timestamp > DISK_CACHE_TTL_MS) {
      // saveGlobalConfig 的 fallback 路径（config.ts:731）在 locked 和
      // fallback 写入都失败时会抛错 —— 在这里 catch，避免触发即忘变成
      // 未处理的 rejection。
      void refreshMetricsStatus().catch(logError)
    }
    return {
      enabled: cached.enabled,
      hasError: false,
    }
  }

  // 本机首次运行：在网络阻塞，以填充磁盘缓存。
  return refreshMetricsStatus()
}

// 仅供测试导出
export const _clearMetricsEnabledCacheForTesting = (): void => {
  memoizedCheckMetrics.cache.clear()
}
