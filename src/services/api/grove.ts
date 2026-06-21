import axios from 'axios'
import memoize from 'lodash-es/memoize.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getOauthAccountInfo, isConsumerSubscriber } from 'src/utils/auth.js'
import { logForDebugging } from 'src/utils/debug.js'
import { gracefulShutdown } from 'src/utils/gracefulShutdown.js'
import { isEssentialTrafficOnly } from 'src/utils/privacyLevel.js'
import { writeToStderr } from 'src/utils/process.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import {
  getAuthHeaders,
  getUserAgent,
  withOAuth401Retry,
} from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'

// 缓存过期时间：24 小时
const GROVE_CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000

export type AccountSettings = {
  grove_enabled: boolean | null
  grove_notice_viewed_at: string | null
}

export type GroveConfig = {
  grove_enabled: boolean
  domain_excluded: boolean
  notice_is_grace_period: boolean
  notice_reminder_frequency: number | null
}

/**
 * 区分 API 失败与成功的结果类型。
 * - success: true 表示 API 调用成功（data 中仍可能包含 null 字段）
 * - success: false 表示 API 调用在重试后失败
 */
export type ApiResult<T> = { success: true; data: T } | { success: false }

/**
 * 获取用户账户当前的 Grove 设置。
 * 返回 ApiResult 以区分 API 失败与成功。
 * 复用现有的 OAuth 401 重试，仍失败则返回失败结果。
 *
 * 对整个 session 做了 memoize，避免每次渲染都重复请求。
 * 缓存在 updateGroveSettings() 中会失效，因此切换后的读取是最新值。
 */
export const getGroveSettings = memoize(
  async (): Promise<ApiResult<AccountSettings>> => {
    // Grove 是通知类功能；发生故障时跳过它是正确的。
    if (isEssentialTrafficOnly()) {
      return { success: false }
    }
    try {
      const response = await withOAuth401Retry(() => {
        const authHeaders = getAuthHeaders()
        if (authHeaders.error) {
          throw new Error(`Failed to get auth headers: ${authHeaders.error}`)
        }
        return axios.get<AccountSettings>(
          `${getOauthConfig().BASE_API_URL}/api/oauth/account/settings`,
          {
            headers: {
              ...authHeaders.headers,
              'User-Agent': getClaudeCodeUserAgent(),
            },
          },
        )
      })
      return { success: true, data: response.data }
    } catch (err) {
      logError(err)
      // 不缓存失败 —— 瞬时网络问题会让用户在整个 session 内无法访问隐私设置
      // （死锁：dialog 需要成功才能渲染开关，开关调用 updateGroveSettings，
      // 这是另一个清空缓存的地方）。
      getGroveSettings.cache.clear?.()
      return { success: false }
    }
  },
)

/**
 * 标记用户已查看过 Grove 通知
 */
export async function markGroveNoticeViewed(): Promise<void> {
  try {
    await withOAuth401Retry(() => {
      const authHeaders = getAuthHeaders()
      if (authHeaders.error) {
        throw new Error(`Failed to get auth headers: ${authHeaders.error}`)
      }
      return axios.post(
        `${getOauthConfig().BASE_API_URL}/api/oauth/account/grove_notice_viewed`,
        {},
        {
          headers: {
            ...authHeaders.headers,
            'User-Agent': getClaudeCodeUserAgent(),
          },
        },
      )
    })
    // 这会在服务端修改 grove_notice_viewed_at —— Grove.tsx:87 读取它来决定
    // 是否显示 dialog。若不清空缓存，同一 session 内的重新挂载会读到陈旧的
    // viewed_at:null 并再次显示 dialog。
    getGroveSettings.cache.clear?.()
  } catch (err) {
    logError(err)
  }
}

/**
 * 更新用户账户的 Grove 设置
 */
export async function updateGroveSettings(
  groveEnabled: boolean,
): Promise<void> {
  try {
    await withOAuth401Retry(() => {
      const authHeaders = getAuthHeaders()
      if (authHeaders.error) {
        throw new Error(`Failed to get auth headers: ${authHeaders.error}`)
      }
      return axios.patch(
        `${getOauthConfig().BASE_API_URL}/api/oauth/account/settings`,
        {
          grove_enabled: groveEnabled,
        },
        {
          headers: {
            ...authHeaders.headers,
            'User-Agent': getClaudeCodeUserAgent(),
          },
        },
      )
    })
    // 让 memoize 的设置失效，这样 privacy-settings.tsx 中切换后的确认读取
    // 能拿到新值。
    getGroveSettings.cache.clear?.()
  } catch (err) {
    logError(err)
  }
}

/**
 * 检查用户是否符合 Grove 资格（非阻塞、缓存优先）。
 *
 * 此函数绝不在网络上阻塞 —— 它立即返回缓存数据，必要时在后台拉取。
 * 冷启动（无缓存）时返回 false，Grove dialog 在下一次 session 之前不会显示。
 */
export async function isQualifiedForGrove(): Promise<boolean> {
  if (!isConsumerSubscriber()) {
    return false
  }

  const accountId = getOauthAccountInfo()?.accountUuid
  if (!accountId) {
    return false
  }

  const globalConfig = getGlobalConfig()
  const cachedEntry = globalConfig.groveConfigCache?.[accountId]
  const now = Date.now()

  // 无缓存 —— 触发后台拉取并返回 false（非阻塞）
  // 本次 session 不显示 Grove dialog，但符合资格时会在下次显示
  if (!cachedEntry) {
    logForDebugging(
      'Grove: No cache, fetching config in background (dialog skipped this session)',
    )
    void fetchAndStoreGroveConfig(accountId)
    return false
  }

  // 缓存存在但已过期 —— 返回缓存值并在后台刷新
  if (now - cachedEntry.timestamp > GROVE_CACHE_EXPIRATION_MS) {
    logForDebugging(
      'Grove: Cache stale, returning cached data and refreshing in background',
    )
    void fetchAndStoreGroveConfig(accountId)
    return cachedEntry.grove_enabled
  }

  // 缓存是新鲜的 —— 立即返回
  logForDebugging('Grove: Using fresh cached config')
  return cachedEntry.grove_enabled
}

/**
 * 从 API 拉取 Grove 配置并存入缓存
 */
async function fetchAndStoreGroveConfig(accountId: string): Promise<void> {
  try {
    const result = await getGroveNoticeConfig()
    if (!result.success) {
      return
    }
    const groveEnabled = result.data.grove_enabled
    const cachedEntry = getGlobalConfig().groveConfigCache?.[accountId]
    if (
      cachedEntry?.grove_enabled === groveEnabled &&
      Date.now() - cachedEntry.timestamp <= GROVE_CACHE_EXPIRATION_MS
    ) {
      return
    }
    saveGlobalConfig(current => ({
      ...current,
      groveConfigCache: {
        ...current.groveConfigCache,
        [accountId]: {
          grove_enabled: groveEnabled,
          timestamp: Date.now(),
        },
      },
    }))
  } catch (err) {
    logForDebugging(`Grove: Failed to fetch and store config: ${err}`)
  }
}

/**
 * 从 API 获取 Grove 的 Statsig 配置。
 * 返回 ApiResult 以区分 API 失败与成功。
 * 复用现有的 OAuth 401 重试，仍失败则返回失败结果。
 */
export const getGroveNoticeConfig = memoize(
  async (): Promise<ApiResult<GroveConfig>> => {
    // Grove 是通知类功能；发生故障时跳过它是正确的。
    if (isEssentialTrafficOnly()) {
      return { success: false }
    }
    try {
      const response = await withOAuth401Retry(() => {
        const authHeaders = getAuthHeaders()
        if (authHeaders.error) {
          throw new Error(`Failed to get auth headers: ${authHeaders.error}`)
        }
        return axios.get<GroveConfig>(
          `${getOauthConfig().BASE_API_URL}/api/claude_code_grove`,
          {
            headers: {
              ...authHeaders.headers,
              'User-Agent': getUserAgent(),
            },
            timeout: 3000, // Short timeout - if slow, skip Grove dialog
          },
        )
      })

      // 把 API 响应映射到 GroveConfig 类型
      const {
        grove_enabled,
        domain_excluded,
        notice_is_grace_period,
        notice_reminder_frequency,
      } = response.data

      return {
        success: true,
        data: {
          grove_enabled,
          domain_excluded: domain_excluded ?? false,
          notice_is_grace_period: notice_is_grace_period ?? true,
          notice_reminder_frequency,
        },
      }
    } catch (err) {
      logForDebugging(`Failed to fetch Grove notice config: ${err}`)
      return { success: false }
    }
  },
)

/**
 * 判断是否应当显示 Grove dialog。
 * 若两次 API 调用中任意一次（重试后）失败则返回 false —— 我们在 API 失败时隐藏 dialog。
 */
export function calculateShouldShowGrove(
  settingsResult: ApiResult<AccountSettings>,
  configResult: ApiResult<GroveConfig>,
  showIfAlreadyViewed: boolean,
): boolean {
  // API 失败（重试后）时隐藏 dialog
  if (!settingsResult.success || !configResult.success) {
    return false
  }

  const settings = settingsResult.data
  const config = configResult.data

  const hasChosen = settings.grove_enabled !== null
  if (hasChosen) {
    return false
  }
  if (showIfAlreadyViewed) {
    return true
  }
  if (!config.notice_is_grace_period) {
    return true
  }
  // 检查是否需要提醒用户接受条款并选择是否帮助改进 Claude
  const reminderFrequency = config.notice_reminder_frequency
  if (reminderFrequency !== null && settings.grove_notice_viewed_at) {
    const daysSinceViewed = Math.floor(
      (Date.now() - new Date(settings.grove_notice_viewed_at).getTime()) /
        (1000 * 60 * 60 * 24),
    )
    return daysSinceViewed >= reminderFrequency
  } else {
    // 从未查看过则显示
    const viewedAt = settings.grove_notice_viewed_at
    return viewedAt === null || viewedAt === undefined
  }
}

export async function checkGroveForNonInteractive(): Promise<void> {
  const [settingsResult, configResult] = await Promise.all([
    getGroveSettings(),
    getGroveNoticeConfig(),
  ])

  // 检查用户是否尚未做出选择（API 失败时返回 false）
  const shouldShowGrove = calculateShouldShowGrove(
    settingsResult,
    configResult,
    false,
  )

  if (shouldShowGrove) {
    // shouldShowGrove 为 true 仅在两次 API 调用都成功时
    const config = configResult.success ? configResult.data : null
    logEvent('tengu_grove_print_viewed', {
      dismissable:
        config?.notice_is_grace_period as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    if (config === null || config.notice_is_grace_period) {
      // 宽限期仍在生效 —— 显示信息性消息并继续
      writeToStderr(
        '\nAn update to our Consumer Terms and Privacy Policy will take effect on October 8, 2025. Run `claude` to review the updated terms.\n\n',
      )
      await markGroveNoticeViewed()
    } else {
      // 宽限期已结束 —— 显示错误消息并退出
      writeToStderr(
        '\n[ACTION REQUIRED] An update to our Consumer Terms and Privacy Policy has taken effect on October 8, 2025. You must run `claude` to review the updated terms.\n\n',
      )
      await gracefulShutdown(1)
    }
  }
}
