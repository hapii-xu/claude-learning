import { resolve } from 'path'
import {
  type HeadlessBridgeOpts,
  BridgeHeadlessPermanentError,
  runBridgeHeadless,
} from '../bridge/bridgeMain.js'
import { getClaudeAIOAuthTokens } from '../utils/auth.js'
import { errorMessage } from '../utils/errors.js'

/**
 * supervisor 用于决定重试或停泊的退出码。
 * 永久性错误（信任未接受、worktree 缺少 git 仓库）使用
 * EXIT_CODE_PERMANENT，让 supervisor 不会浪费周期重试。
 */
const EXIT_CODE_PERMANENT = 78 // 来自 sysexits.h 的 EX_CONFIG
const EXIT_CODE_TRANSIENT = 1

/**
 * Daemon worker 入口。由 `cli.tsx` 通过以下方式调用：
 *   `claude --daemon-worker=<kind>`
 *
 * supervisor 将其作为子进程启动。每个 `kind` 映射到不同的长期运行任务。
 * 目前仅实现了 `remoteControl`——它运行接受远程会话的 headless bridge 循环。
 */
export async function runDaemonWorker(kind?: string): Promise<void> {
  if (!kind) {
    console.error('Error: --daemon-worker requires a worker kind')
    process.exitCode = EXIT_CODE_PERMANENT
    return
  }

  switch (kind) {
    case 'remoteControl':
      await runRemoteControlWorker()
      break
    default:
      console.error(`Error: unknown daemon worker kind '${kind}'`)
      process.exitCode = EXIT_CODE_PERMANENT
  }
}

/**
 * Remote Control worker —— 使用 daemon supervisor 设置的环境变量中的配置
 * 运行 `runBridgeHeadless()`。
 *
 * 环境变量（由 daemonMain 设置）：
 *   DAEMON_WORKER_DIR          —— 工作目录
 *   DAEMON_WORKER_NAME         —— 可选的会话名称
 *   DAEMON_WORKER_SPAWN_MODE   —— 'same-dir' | 'worktree'
 *   DAEMON_WORKER_CAPACITY     —— 最大并发会话数
 *   DAEMON_WORKER_PERMISSION   —— 权限模式
 *   DAEMON_WORKER_SANDBOX      —— '1' 表示沙箱模式
 *   DAEMON_WORKER_TIMEOUT_MS   —— 会话超时（毫秒）
 *   DAEMON_WORKER_CREATE_SESSION —— '1' 表示启动时预创建会话
 */
async function runRemoteControlWorker(): Promise<void> {
  const dir = process.env.DAEMON_WORKER_DIR || resolve('.')
  const name = process.env.DAEMON_WORKER_NAME || undefined
  const spawnMode =
    (process.env.DAEMON_WORKER_SPAWN_MODE as 'same-dir' | 'worktree') ||
    'same-dir'
  const capacity = parseInt(process.env.DAEMON_WORKER_CAPACITY || '4', 10)
  const permissionMode = process.env.DAEMON_WORKER_PERMISSION || undefined
  const sandbox = process.env.DAEMON_WORKER_SANDBOX === '1'
  const sessionTimeoutMs = process.env.DAEMON_WORKER_TIMEOUT_MS
    ? parseInt(process.env.DAEMON_WORKER_TIMEOUT_MS, 10)
    : undefined
  const createSessionOnStart = process.env.DAEMON_WORKER_CREATE_SESSION !== '0'

  const controller = new AbortController()

  // 在 supervisor 发来的 SIGTERM/SIGINT 上优雅关闭
  const onSignal = () => controller.abort()
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  const opts: HeadlessBridgeOpts = {
    dir,
    name,
    spawnMode,
    capacity,
    permissionMode,
    sandbox,
    sessionTimeoutMs,
    createSessionOnStart,
    getAccessToken: () => getClaudeAIOAuthTokens()?.accessToken,
    onAuth401: async (_failedToken: string) => {
      // 在 daemon 上下文中重新检查认证——supervisor 可能已刷新令牌。
      const tokens = getClaudeAIOAuthTokens()
      return !!tokens?.accessToken
    },
    log: (s: string) => {
      console.log(`[remoteControl] ${s}`)
    },
  }

  try {
    await runBridgeHeadless(opts, controller.signal)
  } catch (err) {
    if (err instanceof BridgeHeadlessPermanentError) {
      console.error(`[remoteControl] permanent error: ${err.message}`)
      process.exitCode = EXIT_CODE_PERMANENT
    } else {
      console.error(`[remoteControl] transient error: ${errorMessage(err)}`)
      process.exitCode = EXIT_CODE_TRANSIENT
    }
  } finally {
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
  }
}
