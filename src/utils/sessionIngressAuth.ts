import {
  getSessionIngressToken,
  setSessionIngressToken,
} from '../bootstrap/state.js'
import {
  CCR_SESSION_INGRESS_TOKEN_PATH,
  maybePersistTokenForSubprocesses,
  readTokenFromWellKnownFile,
} from './authFileDescriptor.js'
import { logForDebugging } from './debug.js'
import { errorMessage } from './errors.js'
import { getFsImplementation } from './fsOperations.js'

/**
 * 通过文件描述符读取令牌，失败时回退到知名文件。
 * 使用全局状态缓存结果，因为文件描述符只能读取一次。
 */
function getTokenFromFileDescriptor(): string | null {
  // 检查是否已尝试读取过令牌
  const cachedToken = getSessionIngressToken()
  if (cachedToken !== undefined) {
    return cachedToken
  }

  const fdEnv = process.env.CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR
  if (!fdEnv) {
    // 无 FD 环境变量 — 要么不在 CCR 中，要么我们是父进程已剥离
    // （无用的）FD 环境变量的子进程。尝试知名文件。
    const path =
      process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE ??
      CCR_SESSION_INGRESS_TOKEN_PATH
    const fromFile = readTokenFromWellKnownFile(path, 'session ingress token')
    setSessionIngressToken(fromFile)
    return fromFile
  }

  const fd = parseInt(fdEnv, 10)
  if (Number.isNaN(fd)) {
    logForDebugging(
      `CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR must be a valid file descriptor number, got: ${fdEnv}`,
      { level: 'error' },
    )
    setSessionIngressToken(null)
    return null
  }

  try {
    // 从文件描述符读取
    // macOS/BSD 使用 /dev/fd，Linux 使用 /proc/self/fd
    const fsOps = getFsImplementation()
    const fdPath =
      process.platform === 'darwin' || process.platform === 'freebsd'
        ? `/dev/fd/${fd}`
        : `/proc/self/fd/${fd}`

    const token = fsOps.readFileSync(fdPath, { encoding: 'utf8' }).trim()
    if (!token) {
      logForDebugging('File descriptor contained empty token', {
        level: 'error',
      })
      setSessionIngressToken(null)
      return null
    }
    logForDebugging(`Successfully read token from file descriptor ${fd}`)
    setSessionIngressToken(token)
    maybePersistTokenForSubprocesses(
      CCR_SESSION_INGRESS_TOKEN_PATH,
      token,
      'session ingress token',
    )
    return token
  } catch (error) {
    logForDebugging(
      `Failed to read token from file descriptor ${fd}: ${errorMessage(error)}`,
      { level: 'error' },
    )
    // FD 环境变量已设置但读取失败 — 通常是继承了环境变量
    // 但未继承 FD 的子进程（ENXIO）。尝试知名文件。
    const path =
      process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE ??
      CCR_SESSION_INGRESS_TOKEN_PATH
    const fromFile = readTokenFromWellKnownFile(path, 'session ingress token')
    setSessionIngressToken(fromFile)
    return fromFile
  }
}

/**
 * 获取会话入口认证令牌。
 *
 * 优先级顺序：
 *  1. 环境变量（CLAUDE_CODE_SESSION_ACCESS_TOKEN）— 在生成时设置，
 *     通过 updateSessionIngressAuthToken 或来自父 bridge 进程的
 *     update_environment_variables stdin 消息在进程内更新。
 *  2. 文件描述符（传统路径）— CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR，
 *     读取一次并缓存。
 *  3. 知名文件 — CLAUDE_SESSION_INGRESS_TOKEN_FILE 环境变量路径，或
 *     /home/claude/.hclaude/remote/.session_ingress_token。覆盖无法
 *     继承 FD 的子进程。
 */
export function getSessionIngressAuthToken(): string | null {
  // 1. 检查环境变量
  const envToken = process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
  if (envToken) {
    return envToken
  }

  // 2. 检查文件描述符（传统路径），带文件回退
  return getTokenFromFileDescriptor()
}

/**
 * 为当前会话令牌构建认证头。
 * 会话密钥（sk-ant-sid）使用 Cookie 认证 + X-Organization-Uuid；
 * JWT 使用 Bearer 认证。
 */
export function getSessionIngressAuthHeaders(): Record<string, string> {
  const token = getSessionIngressAuthToken()
  if (!token) return {}
  if (token.startsWith('sk-ant-sid')) {
    const headers: Record<string, string> = {
      Cookie: `sessionKey=${token}`,
    }
    const orgUuid = process.env.CLAUDE_CODE_ORGANIZATION_UUID
    if (orgUuid) {
      headers['X-Organization-Uuid'] = orgUuid
    }
    return headers
  }
  return { Authorization: `Bearer ${token}` }
}

/**
 * 通过设置环境变量在进程内更新会话入口认证令牌。
 * 由 REPL bridge 在重连后注入新令牌而无需重启进程。
 */
export function updateSessionIngressAuthToken(token: string): void {
  process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = token
}
