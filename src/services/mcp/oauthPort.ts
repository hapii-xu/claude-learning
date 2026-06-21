/**
 * OAuth 重定向端口辅助函数 — 从 auth.ts 中提取以打破
 * auth.ts ↔ xaaIdpLogin.ts 的循环依赖。
 */
import { createServer } from 'http'
import { getPlatform } from '../../utils/platform.js'

// Windows 动态端口范围 49152-65535 已保留
const REDIRECT_PORT_RANGE =
  getPlatform() === 'windows'
    ? { min: 39152, max: 49151 }
    : { min: 49152, max: 65535 }
const REDIRECT_PORT_FALLBACK = 3118

/**
 * 在 localhost 上构建带有指定端口和固定 `/callback` 路径的重定向 URI。
 *
 * RFC 8252 第 7.3 节（原生应用的 OAuth）：回环重定向 URI 可以匹配任意
 * 端口，只要路径匹配即可。
 */
export function buildRedirectUri(
  port: number = REDIRECT_PORT_FALLBACK,
): string {
  return `http://localhost:${port}/callback`
}

function getMcpOAuthCallbackPort(): number | undefined {
  const port = parseInt(process.env.MCP_OAUTH_CALLBACK_PORT || '', 10)
  return port > 0 ? port : undefined
}

/**
 * 在指定范围内查找可用于 OAuth 重定向的端口
 * 使用随机选择以提高安全性
 */
export async function findAvailablePort(): Promise<number> {
  // 首先，尝试使用配置的端口（如果已指定）
  const configuredPort = getMcpOAuthCallbackPort()
  if (configuredPort) {
    return configuredPort
  }

  const { min, max } = REDIRECT_PORT_RANGE
  const range = max - min + 1
  const maxAttempts = Math.min(range, 100) // 不要无限尝试

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = min + Math.floor(Math.random() * range)

    try {
      await new Promise<void>((resolve, reject) => {
        const testServer = createServer()
        testServer.once('error', reject)
        testServer.listen(port, () => {
          testServer.close(() => resolve())
        })
      })
      return port
    } catch {}
  }

  // 如果随机选择失败，尝试回退端口
  try {
    await new Promise<void>((resolve, reject) => {
      const testServer = createServer()
      testServer.once('error', reject)
      testServer.listen(REDIRECT_PORT_FALLBACK, () => {
        testServer.close(() => resolve())
      })
    })
    return REDIRECT_PORT_FALLBACK
  } catch {
    throw new Error(`No available ports for OAuth redirect`)
  }
}
