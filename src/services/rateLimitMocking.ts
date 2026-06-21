/**
 * 速率限制 header 处理的外观模式
 * 将 mock 逻辑与生产代码隔离
 */

import { APIError } from '@anthropic-ai/sdk'
import {
  applyMockHeaders,
  checkMockFastModeRateLimit,
  getMockHeaderless429Message,
  getMockHeaders,
  isMockFastModeRateLimitScenario,
  shouldProcessMockLimits,
} from './mockRateLimits.js'

/**
 * 处理 header，如果 /mock-limits 命令激活则应用 mock
 */
export function processRateLimitHeaders(
  headers: globalThis.Headers,
): globalThis.Headers {
  // 仅为使用 /mock-limits 命令的 Ant 员工应用 mock
  if (shouldProcessMockLimits()) {
    return applyMockHeaders(headers)
  }
  return headers
}

/**
 * 检查是否应处理速率限制（真实订阅者或 /mock-limits 命令）
 */
export function shouldProcessRateLimits(isSubscriber: boolean): boolean {
  return isSubscriber || shouldProcessMockLimits()
}

/**
 * 检查 mock 速率限制是否应抛出 429 错误
 * 返回要抛出的错误，如果不应抛出错误则返回 null
 * @param currentModel 当前请求使用的模型
 * @param isFastModeActive 快速模式当前是否激活（用于仅快速模式的 mock）
 */
export function checkMockRateLimitError(
  currentModel: string,
  isFastModeActive?: boolean,
): APIError | null {
  if (!shouldProcessMockLimits()) {
    return null
  }

  const headerlessMessage = getMockHeaderless429Message()
  if (headerlessMessage) {
    return new APIError(
      429,
      { error: { type: 'rate_limit_error', message: headerlessMessage } },
      headerlessMessage,
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      new globalThis.Headers(),
    )
  }

  const mockHeaders = getMockHeaders()
  if (!mockHeaders) {
    return null
  }

  // 检查是否应抛出 429 错误
  // 仅在以下情况抛出：
  // 1. status 为 rejected 且
  // 2. 要么没有超额用量 header，要么超额用量也被拒绝
  // 3. 对于 Opus 特定的限制，仅当实际使用 Opus 模型时才抛出
  const status = mockHeaders['anthropic-ratelimit-unified-status']
  const overageStatus =
    mockHeaders['anthropic-ratelimit-unified-overage-status']
  const rateLimitType =
    mockHeaders['anthropic-ratelimit-unified-representative-claim']

  // 检查这是否是 Opus 特定的速率限制
  const isOpusLimit = rateLimitType === 'seven_day_opus'

  // 检查当前模型是否为 Opus 模型（处理包括别名在内的所有变体）
  const isUsingOpus = currentModel.includes('opus')

  // 对于 Opus 限制，仅当实际使用 Opus 时才抛出 429
  // 这模拟了真实 API 行为，即回退到 Sonnet 会成功
  if (isOpusLimit && !isUsingOpus) {
    return null
  }

  // 检查 mock 快速模式速率限制（处理过期、倒计时等）
  if (isMockFastModeRateLimitScenario()) {
    const fastModeHeaders = checkMockFastModeRateLimit(isFastModeActive)
    if (fastModeHeaders === null) {
      return null
    }
    // 使用快速模式 header 创建 mock 429 错误
    const error = new APIError(
      429,
      { error: { type: 'rate_limit_error', message: 'Rate limit exceeded' } },
      'Rate limit exceeded',
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      new globalThis.Headers(
        Object.entries(fastModeHeaders).filter(([_, v]) => v !== undefined) as [
          string,
          string,
        ][],
      ),
    )
    return error
  }

  const shouldThrow429 =
    status === 'rejected' && (!overageStatus || overageStatus === 'rejected')

  if (shouldThrow429) {
    // 使用适当的 header 创建 mock 429 错误
    const error = new APIError(
      429,
      { error: { type: 'rate_limit_error', message: 'Rate limit exceeded' } },
      'Rate limit exceeded',
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      new globalThis.Headers(
        Object.entries(mockHeaders).filter(([_, v]) => v !== undefined) as [
          string,
          string,
        ][],
      ),
    )
    return error
  }

  return null
}

/**
 * 检查这是否是不应重试的 mock 429 错误
 */
export function isMockRateLimitError(error: APIError): boolean {
  return shouldProcessMockLimits() && error.status === 429
}

/**
 * 检查 /mock-limits 命令当前是否激活（用于 UI 目的）
 */
export { shouldProcessMockLimits }
