import { type ChildProcess } from 'child_process'
import { resolve } from 'path'
import { buildCliLaunch, spawnCli } from '../utils/cliLaunch.js'
import {
  writeDaemonState,
  removeDaemonState,
  queryDaemonStatus,
  stopDaemonByPid,
} from './state.js'

/**
 * worker 用于表示永久（不可重试）失败的退出码。
 * @see workerRegistry.ts EXIT_CODE_PERMANENT
 */
const EXIT_CODE_PERMANENT = 78

/**
 * 重启崩溃 worker 的退避配置。
 */
const BACKOFF_INITIAL_MS = 2_000
const BACKOFF_CAP_MS = 120_000
const BACKOFF_MULTIPLIER = 2
const MAX_RAPID_FAILURES = 5 // 快速崩溃达到此次数后将 worker 停泊

interface WorkerState {
  kind: string
  process: ChildProcess | null
  backoffMs: number
  failureCount: number
  parked: boolean
  lastStartTime: number
  restartTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Daemon supervisor 入口。由 `cli.tsx` 通过以下方式调用：
 *   `claude daemon [subcommand]`
 *
 * 在一个命名空间下同时管理 daemon supervisor 和后台会话。
 *
 * 子命令：
 *   (none)  — 统一状态（supervisor + 会话）
 *   start   — 使用默认 worker 启动 supervisor
 *   stop    — 向 supervisor 发送 SIGTERM
 *   status  — 统一状态（supervisor + 会话）
 *   ps      — status 的别名
 *   bg      — 启动后台会话
 *   attach  — 连接到后台会话
 *   logs    — 显示会话日志
 *   kill    — 终止会话
 */
export async function daemonMain(args: string[]): Promise<void> {
  const subcommand = args[0] || 'status'

  switch (subcommand) {
    // --- supervisor 管理 ---
    case 'start':
      await runSupervisor(args.slice(1))
      break
    case 'stop':
      await handleDaemonStop()
      break

    // --- 统一状态 ---
    case 'status':
    case 'ps':
      await showUnifiedStatus()
      break

    // --- 会话管理（委托给 bg.ts）---
    case 'bg': {
      const bg = await import('../cli/bg.js')
      await bg.handleBgStart(args.slice(1))
      break
    }
    case 'attach': {
      const bg = await import('../cli/bg.js')
      await bg.attachHandler(args[1])
      break
    }
    case 'logs': {
      const bg = await import('../cli/bg.js')
      await bg.logsHandler(args[1])
      break
    }
    case 'kill': {
      const bg = await import('../cli/bg.js')
      await bg.killHandler(args[1])
      break
    }

    case '--help':
    case '-h':
    case 'help':
      printHelp()
      break
    default:
      console.error(`Unknown daemon subcommand: ${subcommand}`)
      printHelp()
      process.exitCode = 1
  }
}

function printHelp(): void {
  console.log(`
Claude Code Daemon — background process management

USAGE
  claude daemon [subcommand]

SUBCOMMANDS
  status      Show daemon and session status (default)
  start       Start the daemon supervisor
  stop        Stop the daemon
  bg          Start a background session
  attach      Attach to a background session
  logs        Show session logs
  kill        Kill a session
  help        Show this help

REPL
  /daemon [subcommand]    Same commands available in interactive mode

OPTIONS (for start)
  --dir <path>              Working directory (default: current)
  --spawn-mode <mode>       Worker spawn mode: same-dir | worktree (default: same-dir)
  --capacity <N>            Max concurrent sessions per worker (default: 4)
  --permission-mode <mode>  Permission mode for spawned sessions
  --sandbox                 Enable sandbox mode
  --name <name>             Session name
  -h, --help                Show this help
`)
}

/**
 * 显示统一状态：daemon supervisor + 后台会话。
 */
async function showUnifiedStatus(): Promise<void> {
  // 1. daemon supervisor 状态
  const result = queryDaemonStatus()
  console.log('=== Daemon Supervisor ===')
  switch (result.status) {
    case 'running': {
      const s = result.state!
      console.log(`  Status:  running`)
      console.log(`  PID:     ${s.pid}`)
      console.log(`  CWD:     ${s.cwd}`)
      console.log(`  Started: ${s.startedAt}`)
      console.log(`  Workers: ${s.workerKinds.join(', ')}`)
      break
    }
    case 'stopped':
      console.log('  Status: stopped')
      break
    case 'stale':
      console.log('  Status: stale (cleaned up)')
      break
  }

  // 2. 后台会话
  console.log('\n=== Background Sessions ===')
  const bg = await import('../cli/bg.js')
  await bg.psHandler([])
}

/**
 * 从另一个 CLI 进程停止运行中的 daemon。
 */
async function handleDaemonStop(): Promise<void> {
  const result = queryDaemonStatus()

  if (result.status === 'stopped') {
    console.log('daemon is not running')
    return
  }

  if (result.status === 'stale') {
    console.log('daemon was stale (cleaned up)')
    return
  }

  console.log(`stopping daemon (PID: ${result.state!.pid})...`)
  const stopped = await stopDaemonByPid()

  if (stopped) {
    console.log('daemon stopped')
  } else {
    console.log('daemon could not be stopped (may have already exited)')
  }
}

/**
 * 从 CLI 解析 supervisor 参数。
 */
function parseSupervisorArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--dir' && i + 1 < args.length) {
      result.dir = resolve(args[++i]!)
    } else if (arg.startsWith('--dir=')) {
      result.dir = resolve(arg.slice('--dir='.length))
    } else if (arg === '--spawn-mode' && i + 1 < args.length) {
      result.spawnMode = args[++i]!
    } else if (arg.startsWith('--spawn-mode=')) {
      result.spawnMode = arg.slice('--spawn-mode='.length)
    } else if (arg === '--capacity' && i + 1 < args.length) {
      result.capacity = args[++i]!
    } else if (arg.startsWith('--capacity=')) {
      result.capacity = arg.slice('--capacity='.length)
    } else if (arg === '--permission-mode' && i + 1 < args.length) {
      result.permissionMode = args[++i]!
    } else if (arg.startsWith('--permission-mode=')) {
      result.permissionMode = arg.slice('--permission-mode='.length)
    } else if (arg === '--sandbox') {
      result.sandbox = '1'
    } else if (arg === '--name' && i + 1 < args.length) {
      result.name = args[++i]!
    } else if (arg.startsWith('--name=')) {
      result.name = arg.slice('--name='.length)
    }
  }
  return result
}

/**
 * 运行 daemon supervisor 循环。启动 worker 并在崩溃时以指数退避方式重启。
 */
async function runSupervisor(args: string[]): Promise<void> {
  const config = parseSupervisorArgs(args)
  const dir = config.dir || resolve('.')

  console.log(`[daemon] supervisor starting in ${dir}`)

  const workers: WorkerState[] = [
    {
      kind: 'remoteControl',
      process: null,
      backoffMs: BACKOFF_INITIAL_MS,
      failureCount: 0,
      parked: false,
      lastStartTime: 0,
      restartTimer: null,
    },
  ]

  // 写入 daemon 状态文件，使其他 CLI 进程可以查询/停止我们
  writeDaemonState({
    pid: process.pid,
    cwd: dir,
    startedAt: new Date().toISOString(),
    workerKinds: workers.map(w => w.kind),
    lastStatus: 'running',
  })

  const controller = new AbortController()

  // 优雅关闭
  const shutdown = () => {
    console.log('[daemon] supervisor shutting down...')
    controller.abort()
    removeDaemonState()
    for (const w of workers) {
      if (w.restartTimer) {
        clearTimeout(w.restartTimer)
        w.restartTimer = null
      }
      if (w.process && !w.process.killed) {
        w.process.kill('SIGTERM')
      }
    }
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  // 启动并监督 worker
  for (const worker of workers) {
    if (!controller.signal.aborted) {
      spawnWorker(worker, dir, config, controller.signal)
    }
  }

  // 等待 abort 信号
  await new Promise<void>(resolve => {
    if (controller.signal.aborted) {
      resolve()
      return
    }
    controller.signal.addEventListener('abort', () => resolve(), { once: true })
  })

  // 等待所有 worker 退出
  await Promise.all(
    workers
      .filter(w => w.process && w.process.exitCode === null)
      .map(
        w =>
          new Promise<void>(resolve => {
            if (!w.process || w.process.exitCode !== null) {
              resolve()
              return
            }
            let killTimer: ReturnType<typeof setTimeout> | null = null
            w.process.on('exit', () => {
              if (killTimer) {
                clearTimeout(killTimer)
                killTimer = null
              }
              resolve()
            })
            // 宽限期后强制 kill
            killTimer = setTimeout(() => {
              if (w.process && w.process.exitCode === null) {
                w.process.kill('SIGKILL')
              }
              resolve()
            }, 30_000)
            killTimer.unref?.()
          }),
      ),
  )

  console.log('[daemon] supervisor stopped')
}

/**
 * 使用适当的环境变量启动 worker 子进程。
 */
function spawnWorker(
  worker: WorkerState,
  dir: string,
  config: Record<string, string>,
  signal: AbortSignal,
): void {
  if (signal.aborted || worker.parked) return

  worker.lastStartTime = Date.now()

  const env: Record<string, string | undefined> = {
    ...process.env,
    DAEMON_WORKER_DIR: dir,
    DAEMON_WORKER_NAME: config.name,
    DAEMON_WORKER_SPAWN_MODE: config.spawnMode || 'same-dir',
    DAEMON_WORKER_CAPACITY: config.capacity || '4',
    DAEMON_WORKER_PERMISSION: config.permissionMode,
    DAEMON_WORKER_SANDBOX: config.sandbox || '0',
    DAEMON_WORKER_CREATE_SESSION: '1',
    CLAUDE_CODE_SESSION_KIND: 'daemon-worker',
  }

  console.log(`[daemon] spawning worker '${worker.kind}'`)

  const launch = buildCliLaunch([`--daemon-worker=${worker.kind}`], { env })

  const child = spawnCli(launch, {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  worker.process = child

  // 将 worker 的 stdout/stderr 管道转发给 supervisor 并添加前缀
  child.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().trimEnd().split('\n')
    for (const line of lines) {
      console.log(`  ${line}`)
    }
  })
  child.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().trimEnd().split('\n')
    for (const line of lines) {
      console.error(`  ${line}`)
    }
  })

  child.on('exit', (code, sig) => {
    worker.process = null

    if (signal.aborted) {
      // supervisor 正在关闭，不要重启
      return
    }

    if (code === EXIT_CODE_PERMANENT) {
      console.error(
        `[daemon] worker '${worker.kind}' exited with permanent error — parking`,
      )
      worker.parked = true
      return
    }

    // 检查是否快速失败（启动后 10 秒内崩溃）
    const runDuration = Date.now() - worker.lastStartTime
    if (runDuration < 10_000) {
      worker.failureCount++
      if (worker.failureCount >= MAX_RAPID_FAILURES) {
        console.error(
          `[daemon] worker '${worker.kind}' failed ${worker.failureCount} times rapidly — parking`,
        )
        worker.parked = true
        return
      }
    } else {
      // 运行了合理的时间，重置失败计数
      worker.failureCount = 0
      worker.backoffMs = BACKOFF_INITIAL_MS
    }

    console.log(
      `[daemon] worker '${worker.kind}' exited (code=${code}, signal=${sig}), restarting in ${worker.backoffMs}ms`,
    )

    worker.restartTimer = setTimeout(() => {
      worker.restartTimer = null
      if (!signal.aborted && !worker.parked) {
        spawnWorker(worker, dir, config, signal)
      }
    }, worker.backoffMs)
    worker.restartTimer.unref?.()

    // 指数退避
    worker.backoffMs = Math.min(
      worker.backoffMs * BACKOFF_MULTIPLIER,
      BACKOFF_CAP_MS,
    )
  })
}
