import { type ChildProcess, spawn, type SpawnOptions } from 'child_process'
import { isInBundledMode } from './bundledMode.js'
import { quote } from './bash/shellQuote.js'

/**
 * CliLaunchSpec —— 生成子 CLI 进程的规范化描述符。
 *
 * 每个重新执行 CLI 的位置（daemon worker、bg session、bridge session、
 * assistant/RCS daemon 启动器）都应使用此接口，而非手动组装
 * `[...process.execArgv, process.argv[1]!, ...]`。
 *
 * 集中化引导约定可防止一类 bug：各个 spawn 位置忘记传递 execArgv、
 * windowsHide 或 env 传播。
 */
export interface CliLaunchSpec {
  /** 运行时二进制路径（如 bun、node）。 */
  execPath: string
  /** 完整参数列表，包含引导参数和 CLI 参数。 */
  args: string[]
  /** 子进程的环境变量。 */
  env: NodeJS.ProcessEnv
  /** 在 Windows 上是否隐藏控制台窗口。 */
  windowsHide: boolean
}

// ---------------------------------------------------------------------------
// 冻结的引导快照 —— 在模块加载时计算一次。
//
// Bun 特性（https://github.com/oven-sh/bun/issues/11673）：在单文件可执行文件中，
// process.argv 的应用参数可能泄漏到 process.execArgv。
// 我们快照并过滤一次，因此无论何时调用 buildCliLaunch，
// 每个子进程都能获得干净、稳定的运行时标志集合。
// ---------------------------------------------------------------------------

/**
 * 从 process.execArgv 中过滤泄漏的应用参数。
 * 仅保留已知的运行时标志：-d（定义）、--feature、--inspect 变体。
 */
function sanitizeExecArgv(raw: readonly string[]): string[] {
  const result: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i]!
    // Bun 定义标志：-d KEY:VALUE 或 -dKEY:VALUE
    if (arg === '-d' || arg.startsWith('-d ') || arg.startsWith('-d\t')) {
      result.push(arg)
      if (arg === '-d' && i + 1 < raw.length) {
        result.push(raw[++i]!)
      }
      continue
    }
    if (arg.startsWith('-d') && arg.includes(':')) {
      result.push(arg)
      continue
    }
    // Bun 功能标志：--feature NAME
    if (arg === '--feature') {
      result.push(arg)
      if (i + 1 < raw.length) {
        result.push(raw[++i]!)
      }
      continue
    }
    // Node/Bun inspect 标志
    if (/^--inspect(-brk)?(=|$)/.test(arg)) {
      result.push(arg)
      continue
    }
    // 保留其他已知的运行时标志（如 --conditions、--experimental-*）
    if (arg.startsWith('--') && !arg.includes('=') && i + 1 < raw.length) {
      // 未知的两段式标志 —— 仅在打包模式下保守跳过
      if (isInBundledMode()) continue
      result.push(arg)
      result.push(raw[++i]!)
      continue
    }
    if (arg.startsWith('-') && !isInBundledMode()) {
      result.push(arg)
    }
  }
  return result
}

const BOOTSTRAP_ARGS: readonly string[] = Object.freeze(
  sanitizeExecArgv(process.execArgv),
)
const SCRIPT_PATH: string | undefined = process.argv[1]
const EXEC_PATH: string = process.execPath
const IS_WINDOWS = process.platform === 'win32'

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * 构建规范化的启动描述符，用于生成子 CLI 进程。
 *
 * @param cliArgs  传递给 CLI 入口的参数（如 ['daemon', 'start']）
 * @param opts.env 覆盖环境变量（默认使用 process.env）
 */
export function buildCliLaunch(
  cliArgs: string[],
  opts?: { env?: NodeJS.ProcessEnv },
): CliLaunchSpec {
  const baseEnv = opts?.env ?? process.env

  // 在打包模式下，execPath 就是 CLI 二进制文件 —— 无需脚本路径。
  // 在脚本模式（dev / npm）下，需要在运行时标志和 CLI 参数之间
  // 放置脚本路径，以便运行时知道要执行哪个文件。
  const args: string[] =
    isInBundledMode() || !SCRIPT_PATH
      ? [...BOOTSTRAP_ARGS, ...cliArgs]
      : [...BOOTSTRAP_ARGS, SCRIPT_PATH, ...cliArgs]

  // 确保 Windows 子进程能发现 git-bash 而无需通过 shell 调用
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  if (IS_WINDOWS) {
    if (
      process.env.CLAUDE_CODE_GIT_BASH_PATH &&
      !env.CLAUDE_CODE_GIT_BASH_PATH
    ) {
      env.CLAUDE_CODE_GIT_BASH_PATH = process.env.CLAUDE_CODE_GIT_BASH_PATH
    }
    if (process.env.SHELL && !env.SHELL) {
      env.SHELL = process.env.SHELL
    }
  }

  return {
    execPath: EXEC_PATH,
    args,
    env,
    windowsHide: IS_WINDOWS,
  }
}

/**
 * 从启动描述符生成子 CLI 进程。
 *
 * 调用方提供传输层选项（stdio、detached、cwd），
 * 描述符处理引导相关（execPath、args、env、windowsHide）。
 *
 * Windows 注意：Windows 上的 `detached: true` 会创建新的控制台窗口
 *（与 Unix 上仅创建新进程组不同）。Node.js 使用 `windowsHide`
 * 传递 CREATE_NO_WINDOW，但 Bun 可能未实现。
 * 作为回退，我们总是同时设置 `windowsHide: true` 并保持 `detached`
 * 不变 —— 子进程需要 `detached` 才能在父进程之后继续存活。
 */
export function spawnCli(
  spec: CliLaunchSpec,
  spawnOpts: Omit<SpawnOptions, 'windowsHide'>,
): ChildProcess {
  return spawn(spec.execPath, spec.args, {
    ...spawnOpts,
    env: { ...spec.env, ...(spawnOpts.env as NodeJS.ProcessEnv) },
    windowsHide: spec.windowsHide,
  })
}

/**
 * 将启动描述符引用为单个 shell 命令字符串（用于 tmux）。
 */
export function quoteCliLaunch(spec: CliLaunchSpec): string {
  return quote([spec.execPath, ...spec.args])
}

/**
 * 获取冻结的引导参数快照。
 * 用于需要原始参数的调用位置（如 bridgeMain 依赖）。
 */
export function getBootstrapArgs(): readonly string[] {
  return BOOTSTRAP_ARGS
}

/**
 * 获取脚本路径（启动时的 process.argv[1]）。
 * 打包模式下返回 undefined。
 */
export function getScriptPath(): string | undefined {
  return SCRIPT_PATH
}
