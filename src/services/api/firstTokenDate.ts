import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getAuthHeaders } from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'

/**
 * 获取用户首个 Claude Code token 的日期并写入配置。
 * 在登录成功后调用，用于缓存用户开始使用 Claude Code 的时间。
 */
export async function fetchAndStoreClaudeCodeFirstTokenDate(): Promise<void> {
  try {
    const config = getGlobalConfig()

    if (config.claudeCodeFirstTokenDate !== undefined) {
      return
    }

    const authHeaders = getAuthHeaders()
    if (authHeaders.error) {
      logError(new Error(`Failed to get auth headers: ${authHeaders.error}`))
      return
    }

    const oauthConfig = getOauthConfig()
    const url = `${oauthConfig.BASE_API_URL}/api/organization/claude_code_first_token_date`

    const response = await axios.get(url, {
      headers: {
        ...authHeaders.headers,
        'User-Agent': getClaudeCodeUserAgent(),
      },
      timeout: 10000,
    })

    const firstTokenDate = response.data?.first_token_date ?? null

    // 若不为 null，则校验日期
    if (firstTokenDate !== null) {
      const dateTime = new Date(firstTokenDate).getTime()
      if (isNaN(dateTime)) {
        logError(
          new Error(
            `Received invalid first_token_date from API: ${firstTokenDate}`,
          ),
        )
        // 不保存非法日期
        return
      }
    }

    saveGlobalConfig(current => ({
      ...current,
      claudeCodeFirstTokenDate: firstTokenDate,
    }))
  } catch (error) {
    logError(error)
  }
}
