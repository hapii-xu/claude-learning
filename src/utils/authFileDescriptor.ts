import { mkdirSync, writeFileSync } from 'fs'
import {
  getApiKeyFromFd,
  getOauthTokenFromFd,
  setApiKeyFromFd,
  setOauthTokenFromFd,
} from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { errorMessage, isENOENT } from './errors.js'
import { getFsImplementation } from './fsOperations.js'

/**
 * CCR 中已知的 token 文件位置。Go 环境管理器创建
 * /home/claude/.hclaude/remote/ 并（最终）也会写入这些文件。
 * 在此之前，此模块在成功读取 FD 后写入它们，以便 CCR 容器内
 * 生成的子进程可以找到 token 而无需继承 FD —— 它们无法继承：
 * 管道 FD 不能跨越 tmux/shell 边界。
 */
const CCR_TOKEN_DIR = '/home/claude/.hclaude/remote'
export const CCR_OAUTH_TOKEN_PATH = `${CCR_TOKEN_DIR}/.oauth_token`
export const CCR_API_KEY_PATH = `${CCR_TOKEN_DIR}/.api_key`
export const CCR_SESSION_INGRESS_TOKEN_PATH = `${CCR_TOKEN_DIR}/.session_ingress_token`

/**
 * 尽最大努力将 token 写入已知位置以供子进程访问。
 * CCR 限定：在 CCR 外部没有 /home/claude/，也没有理由将
 * FD 本应保持在磁盘外的 token 放到磁盘上。
 */
export function maybePersistTokenForSubprocesses(
  path: string,
  token: string,
  tokenName: string,
): void {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
    return
  }
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs -- one-shot startup write in CCR, caller is sync
    mkdirSync(CCR_TOKEN_DIR, { recursive: true, mode: 0o700 })
    // eslint-disable-next-line custom-rules/no-sync-fs -- one-shot startup write in CCR, caller is sync
    writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 })
    logForDebugging(`Persisted ${tokenName} to ${path} for subprocess access`)
  } catch (error) {
    logForDebugging(
      `Failed to persist ${tokenName} to disk (non-fatal): ${errorMessage(error)}`,
      { level: 'error' },
    )
  }
}

/**
 * 从已知文件回退读取。路径仅存在于 CCR 中（env-manager 创建目录），
 * 因此在其他地方文件未找到是预期结果 —— 视为"无回退"，而非错误。
 */
export function readTokenFromWellKnownFile(
  path: string,
  tokenName: string,
): string | null {
  try {
    const fsOps = getFsImplementation()
    // eslint-disable-next-line custom-rules/no-sync-fs -- fallback read for CCR subprocess path, one-shot at startup, caller is sync
    const token = fsOps.readFileSync(path, { encoding: 'utf8' }).trim()
    if (!token) {
      return null
    }
    logForDebugging(`Read ${tokenName} from well-known file ${path}`)
    return token
  } catch (error) {
    // ENOENT 是在 CCR 外部的预期结果 —— 保持沉默。其他任何情况
    //（EACCES 来自权限配置错误等）都值得在调试日志中显示，
    // 以便子进程认证失败不会变得神秘。
    if (!isENOENT(error)) {
      logForDebugging(
        `Failed to read ${tokenName} from ${path}: ${errorMessage(error)}`,
        { level: 'debug' },
      )
    }
    return null
  }
}

/**
 * 共享的 FD 或已知文件凭证读取器。
 *
 * 优先级顺序：
 *  1. 文件描述符（旧路径）—— 环境变量指向 Go env-manager 通过
 *     cmd.ExtraFiles 传递的管道 FD。管道在首次读取后排空，
 *     且不能跨越 exec/tmux 边界。
 *  2. 已知文件 —— 在成功读取 FD 后由此函数写入（最终由
 *     env-manager 直接写入）。覆盖无法继承 FD 的子进程。
 *
 * 如果两个来源都没有凭证则返回 null。缓存在全局状态中。
 */
function getCredentialFromFd({
  envVar,
  wellKnownPath,
  label,
  getCached,
  setCached,
}: {
  envVar: string
  wellKnownPath: string
  label: string
  getCached: () => string | null | undefined
  setCached: (value: string | null) => void
}): string | null {
  const cached = getCached()
  if (cached !== undefined) {
    return cached
  }

  const fdEnv = process.env[envVar]
  if (!fdEnv) {
    // 无 FD 环境变量 —— 要么不在 CCR 中，要么是父进程剥离了
    //（无用的）FD 环境变量的子进程。尝试已知文件。
    const fromFile = readTokenFromWellKnownFile(wellKnownPath, label)
    setCached(fromFile)
    return fromFile
  }

  const fd = parseInt(fdEnv, 10)
  if (Number.isNaN(fd)) {
    logForDebugging(
      `${envVar} must be a valid file descriptor number, got: ${fdEnv}`,
      { level: 'error' },
    )
    setCached(null)
    return null
  }

  try {
    // 在 macOS/BSD 上使用 /dev/fd，在 Linux 上使用 /proc/self/fd
    const fsOps = getFsImplementation()
    const fdPath =
      process.platform === 'darwin' || process.platform === 'freebsd'
        ? `/dev/fd/${fd}`
        : `/proc/self/fd/${fd}`

    // eslint-disable-next-line custom-rules/no-sync-fs -- legacy FD path, read once at startup, caller is sync
    const token = fsOps.readFileSync(fdPath, { encoding: 'utf8' }).trim()
    if (!token) {
      logForDebugging(`File descriptor contained empty ${label}`, {
        level: 'error',
      })
      setCached(null)
      return null
    }
    logForDebugging(`Successfully read ${label} from file descriptor ${fd}`)
    setCached(token)
    maybePersistTokenForSubprocesses(wellKnownPath, token, label)
    return token
  } catch (error) {
    logForDebugging(
      `Failed to read ${label} from file descriptor ${fd}: ${errorMessage(error)}`,
      { level: 'error' },
    )
    // FD 环境变量已设置但读取失败 —— 通常是继承了环境变量
    // 但没有继承 FD 的子进程（ENXIO）。尝试已知文件。
    const fromFile = readTokenFromWellKnownFile(wellKnownPath, label)
    setCached(fromFile)
    return fromFile
  }
}

/**
 * 获取 CCR 注入的 OAuth token。FD 与磁盘的选择理由见 getCredentialFromFd。
 * 环境变量：CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR。
 * 已知文件：/home/claude/.hclaude/remote/.oauth_token。
 */
export function getOAuthTokenFromFileDescriptor(): string | null {
  return getCredentialFromFd({
    envVar: 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
    wellKnownPath: CCR_OAUTH_TOKEN_PATH,
    label: 'OAuth token',
    getCached: getOauthTokenFromFd,
    setCached: setOauthTokenFromFd,
  })
}

/**
 * 获取 CCR 注入的 API 密钥。FD 与磁盘的选择理由见 getCredentialFromFd。
 * 环境变量：CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR。
 * 已知文件：/home/claude/.hclaude/remote/.api_key。
 */
export function getApiKeyFromFileDescriptor(): string | null {
  return getCredentialFromFd({
    envVar: 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
    wellKnownPath: CCR_API_KEY_PATH,
    label: 'API key',
    getCached: getApiKeyFromFd,
    setCached: setApiKeyFromFd,
  })
}
