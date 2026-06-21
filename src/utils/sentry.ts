/**
 * Sentry 集成模块
 *
 * 当 SENTRY_DSN 环境变量被设置时初始化 Sentry SDK。
 * 当 DSN 未配置时，所有导出均为空操作。
 */

import * as Sentry from '@sentry/node'
import { logForDebugging } from './debug.js'

declare const BUILD_ENV: string | undefined

let initialized = false

/**
 * 初始化 Sentry SDK。可安全地多次调用 — 后续调用为空操作。
 * 仅在 SENTRY_DSN 环境变量被设置时激活。
 */
export function initSentry(): void {
  if (initialized) {
    return
  }

  const dsn = process.env.SENTRY_DSN
  if (!dsn) {
    logForDebugging('[sentry] SENTRY_DSN not set, skipping initialization')
    return
  }

  Sentry.init({
    dsn,
    release: typeof MACRO !== 'undefined' ? MACRO.VERSION : undefined,
    environment:
      typeof BUILD_ENV !== 'undefined'
        ? (BUILD_ENV as string)
        : process.env.NODE_ENV || 'development',

    // 限制面包屑和附件数量以控制负载大小
    maxBreadcrumbs: 20,

    // 错误事件的采样率（1.0 = 捕获全部）
    sampleRate: 1.0,

    // 发送前过滤敏感信息
    beforeSend(event) {
      // 从请求数据中剥离认证头
      const request = event.request
      if (request?.headers) {
        const sensitiveHeaders = [
          'authorization',
          'x-api-key',
          'cookie',
          'set-cookie',
        ]
        for (const key of Object.keys(request.headers)) {
          if (sensitiveHeaders.includes(key.toLowerCase())) {
            delete request.headers[key]
          }
        }
      }

      return event
    },

    // 忽略特定的错误模式
    ignoreErrors: [
      // 来自主机不可达的网络错误 — 不可操作
      'ECONNREFUSED',
      'ECONNRESET',
      'ENOTFOUND',
      'ETIMEDOUT',
      // 用户发起的中止
      'AbortError',
      'The user aborted a request',
      // 交互式取消信号
      'CancelError',
    ],

    beforeSendTransaction(_event) {
      // 暂时不发送性能事务 — 仅发送错误
      return null
    },
  })

  initialized = true
  logForDebugging('[sentry] Initialized successfully')
}

/**
 * 捕获异常并发送到 Sentry。
 * 如果 Sentry 尚未初始化，则为空操作。
 */
export function captureException(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  if (!initialized) {
    return
  }

  try {
    Sentry.withScope(scope => {
      if (context) {
        scope.setExtras(context)
      }
      Sentry.captureException(error)
    })
  } catch {
    // Sentry 自身失败 — 不应导致应用崩溃
  }
}

/**
 * 在当前作用域上设置标签，用于 Sentry 中的分组/过滤。
 * 如果 Sentry 尚未初始化，则为空操作。
 */
export function setTag(key: string, value: string): void {
  if (!initialized) {
    return
  }

  try {
    Sentry.setTag(key, value)
  } catch {
    // 忽略
  }
}

/**
 * 在 Sentry 中设置用户上下文，用于错误归属。
 * 如果 Sentry 尚未初始化，则为空操作。
 */
export function setUser(user: {
  id?: string
  email?: string
  username?: string
}): void {
  if (!initialized) {
    return
  }

  try {
    Sentry.setUser(user)
  } catch {
    // 忽略
  }
}

/**
 * 刷新待发送的 Sentry 事件并关闭客户端。
 * 在优雅关闭期间调用以确保事件被发送。
 */
export async function closeSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) {
    return
  }

  try {
    await Sentry.close(timeoutMs)
    logForDebugging('[sentry] Closed successfully')
  } catch {
    // 忽略 — 无论如何都在关闭中
  }
}

/**
 * 检查 Sentry 是否已初始化。用于条件性 UI 渲染。
 */
export function isSentryInitialized(): boolean {
  return initialized
}
