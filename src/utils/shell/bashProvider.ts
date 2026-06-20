import { feature } from 'bun:bundle'
import { access } from 'fs/promises'
import { tmpdir as osTmpdir } from 'os'
import { join as nativeJoin } from 'path'
import { join as posixJoin } from 'path/posix'
import { rearrangePipeCommand } from '../bash/bashPipeCommand.js'
import { createAndSaveSnapshot } from '../bash/ShellSnapshot.js'
import { formatShellPrefixCommand } from '../bash/shellPrefix.js'
import { quote } from '../bash/shellQuote.js'
import {
  quoteShellCommand,
  rewriteWindowsNullRedirect,
  shouldAddStdinRedirect,
} from '../bash/shellQuoting.js'
import { logForDebugging } from '../debug.js'
import { getPlatform } from '../platform.js'
import { getSessionEnvironmentScript } from '../sessionEnvironment.js'
import { getSessionEnvVars } from '../sessionEnvVars.js'
import {
  ensureSocketInitialized,
  getClaudeTmuxEnv,
  hasTmuxToolBeenUsed,
} from '../tmuxSocket.js'
import { windowsPathToPosixPath } from '../windowsPaths.js'
import type { ShellProvider } from './shellProvider.js'

/**
 * 返回一条用于禁用扩展 glob 模式的 shell 命令，以提升安全性。
 * 扩展 glob（bash 的 extglob、zsh 的 EXTENDED_GLOB）可能被恶意文件名利用，
 * 这些文件名会在我们的安全校验之后才发生展开。
 *
 * 当设置了 CLAUDE_CODE_SHELL_PREFIX 时，实际执行的 shell 可能与 shellPath
 * 不同（例如 shellPath 是 zsh，但 wrapper 运行的是 bash）。此时我们会同时
 * 包含两种 shell 的命令。stdout 和 stderr 都重定向到 /dev/null，因为
 * zsh 的 command_not_found_handler 会写入 STDOUT。
 *
 * 未设置 shell prefix 时，使用与检测到的 shell 匹配的命令。
 */
function getDisableExtglobCommand(shellPath: string): string | null {
  // 当设置了 CLAUDE_CODE_SHELL_PREFIX 时，wrapper 可能使用与 shellPath
  // 不同的 shell，因此同时包含 bash 和 zsh 的命令
  if (process.env.CLAUDE_CODE_SHELL_PREFIX) {
    // 同时重定向 stdout 和 stderr，因为 zsh 的 command_not_found_handler
    // 会写入 stdout 而不是 stderr
    return '{ shopt -u extglob || setopt NO_EXTENDED_GLOB; } >/dev/null 2>&1 || true'
  }

  // 未设置 shell prefix - 使用与 shell 匹配的命令
  if (shellPath.includes('bash')) {
    return 'shopt -u extglob 2>/dev/null || true'
  } else if (shellPath.includes('zsh')) {
    return 'setopt NO_EXTENDED_GLOB 2>/dev/null || true'
  }
  // 未知 shell - 什么都不做，因为我们不知道正确的命令
  return null
}

export async function createBashShellProvider(
  shellPath: string,
  options?: { skipSnapshot?: boolean },
): Promise<ShellProvider> {
  let currentSandboxTmpDir: string | undefined
  const snapshotPromise: Promise<string | undefined> = options?.skipSnapshot
    ? Promise.resolve(undefined)
    : createAndSaveSnapshot(shellPath).catch(error => {
        logForDebugging(`Failed to create shell snapshot: ${error}`)
        return undefined
      })
  // 记录最近解析到的 snapshot 路径，供 getSpawnArgs 使用
  let lastSnapshotFilePath: string | undefined

  return {
    type: 'bash',
    shellPath,
    detached: true,

    async buildExecCommand(
      command: string,
      opts: {
        id: number | string
        sandboxTmpDir?: string
        useSandbox: boolean
      },
    ): Promise<{ commandString: string; cwdFilePath: string }> {
      let snapshotFilePath = await snapshotPromise
      // 这里的 access() 检查并非纯粹的 TOCTOU — 它是 getSpawnArgs 的兜底
      // 决策点。当 snapshot 在会话中途消失（tmpdir 被清理）时，必须清空
      // lastSnapshotFilePath，这样 getSpawnArgs 才会加上 -l，使命令走
      // login-shell 初始化。没有这个检查的话，`source ... || true` 会
      // 静默失败，命令将以完全没有 shell 初始化的方式运行（既没有
      // snapshot 环境，也没有 login profile）。source 上的 `|| true`
      // 仍然用于防御此检查与 spawned shell 之间的竞态。
      if (snapshotFilePath) {
        try {
          await access(snapshotFilePath)
        } catch {
          logForDebugging(
            `Snapshot file missing, falling back to login shell: ${snapshotFilePath}`,
          )
          snapshotFilePath = undefined
        }
      }
      lastSnapshotFilePath = snapshotFilePath

      // 暂存 sandboxTmpDir，供 getEnvironmentOverrides 使用
      currentSandboxTmpDir = opts.sandboxTmpDir

      const tmpdir = osTmpdir()
      const isWindows = getPlatform() === 'windows'
      const shellTmpdir = isWindows ? windowsPathToPosixPath(tmpdir) : tmpdir

      // shellCwdFilePath：bash 命令内部使用的 POSIX 路径（pwd -P >| ...）
      // cwdFilePath：Node.js 用于 readFileSync/unlinkSync 的原生 OS 路径
      // 非 Windows 下两者相同；在 Windows 下，Git Bash 需要 POSIX 路径，
      // 而 Node.js 需要原生 Windows 路径来操作文件。
      const shellCwdFilePath = opts.useSandbox
        ? posixJoin(opts.sandboxTmpDir!, `cwd-${opts.id}`)
        : posixJoin(shellTmpdir, `claude-${opts.id}-cwd`)
      const cwdFilePath = opts.useSandbox
        ? posixJoin(opts.sandboxTmpDir!, `cwd-${opts.id}`)
        : nativeJoin(tmpdir, `claude-${opts.id}-cwd`)

      // 防御性重写：模型偶尔会输出 Windows CMD 风格的 `2>nul` 重定向。
      // 在 POSIX bash（包括 Windows 上的 Git Bash）中，这会创建一个名为
      // `nul` 的真实文件 — 这是保留的设备名，会让 git 出错。
      // 见 anthropics/claude-code#4928。
      const normalizedCommand = rewriteWindowsNullRedirect(command)
      const addStdinRedirect = shouldAddStdinRedirect(normalizedCommand)
      let quotedCommand = quoteShellCommand(normalizedCommand, addStdinRedirect)

      // 对 heredoc/多行命令输出 debug 日志，便于追踪 trailer 处理
      // 仅在启用 commit attribution 时记录，避免日志噪声
      if (
        feature('COMMIT_ATTRIBUTION') &&
        (command.includes('<<') || command.includes('\n'))
      ) {
        logForDebugging(
          `Shell: Command before quoting (first 500 chars):\n${command.slice(0, 500)}`,
        )
        logForDebugging(
          `Shell: Quoted command (first 500 chars):\n${quotedCommand.slice(0, 500)}`,
        )
      }

      // 对管道的特殊处理：把 stdin 重定向移到第一条命令之后
      // 确保重定向作用于第一条命令，而不是 eval 本身。
      // 否则 `eval 'rg foo | wc -l' \< /dev/null` 会变成
      // `rg foo | wc -l < /dev/null` — wc 读取 /dev/null 输出 0，
      // 而 rg（没有 path 参数）会永远等待 spawn 打开的 stdin 管道。
      // sandbox 模式同样适用：sandbox 包装的是已组装的 commandString，
      // 而不是原始 command（自 PR #9189 起）。
      if (normalizedCommand.includes('|') && addStdinRedirect) {
        quotedCommand = rearrangePipeCommand(normalizedCommand)
      }

      const commandParts: string[] = []

      // source snapshot 文件。`|| true` 用于防御上面的 access() 检查与
      // spawned shell 的 `source` 之间的竞态 — 如果文件在这个时间窗内消失，
      // `&&` 链仍然可以继续执行。
      if (snapshotFilePath) {
        const finalPath =
          getPlatform() === 'windows'
            ? windowsPathToPosixPath(snapshotFilePath)
            : snapshotFilePath
        commandParts.push(`source ${quote([finalPath])} 2>/dev/null || true`)
      }

      // source 从 session start hook 中捕获的 session 环境变量
      const sessionEnvScript = await getSessionEnvironmentScript()
      if (sessionEnvScript) {
        commandParts.push(sessionEnvScript)
      }

      // 出于安全考虑禁用扩展 glob 模式（放在 source 用户配置之后，以便覆盖）
      const disableExtglobCmd = getDisableExtglobCommand(shellPath)
      if (disableExtglobCmd) {
        commandParts.push(disableExtglobCmd)
      }

      // source 文件后定义的 aliases 不会在同一行命令里展开，因为 shell
      // 在执行前会先解析整行。在 source 之后使用 eval 可以触发第二次解析，
      // 此时 aliases 已经可用，可以被正确展开。
      commandParts.push(`eval ${quotedCommand}`)
      // 使用 `pwd -P` 获取当前工作目录的物理路径，与 `process.cwd()` 保持一致
      commandParts.push(`pwd -P >| ${quote([shellCwdFilePath])}`)
      let commandString = commandParts.join(' && ')

      // 如果设置了 CLAUDE_CODE_SHELL_PREFIX 则应用
      if (process.env.CLAUDE_CODE_SHELL_PREFIX) {
        commandString = formatShellPrefixCommand(
          process.env.CLAUDE_CODE_SHELL_PREFIX,
          commandString,
        )
      }

      return { commandString, cwdFilePath }
    },

    getSpawnArgs(commandString: string): string[] {
      const skipLoginShell = lastSnapshotFilePath !== undefined
      if (skipLoginShell) {
        logForDebugging('Spawning shell without login (-l flag skipped)')
      }
      return ['-c', ...(skipLoginShell ? [] : ['-l']), commandString]
    },

    async getEnvironmentOverrides(
      command: string,
    ): Promise<Record<string, string>> {
      // TMUX SOCKET 隔离（延迟初始化）：
      // 我们只在 Tmux 工具至少被使用过一次，或当前命令看起来使用了 tmux
      // 时才初始化 Claude 的 tmux socket。这样可以把启动开销推迟到
      // 真正需要 tmux 的时候。
      //
      // 一旦 Tmux 工具被使用（或运行了 tmux 命令），所有后续的 Bash 命令
      // 都会通过 TMUX 环境变量覆盖，使用 Claude 的隔离 socket。
      //
      // 完整的隔离架构文档见 tmuxSocket.ts。
      const commandUsesTmux = command.includes('tmux')
      if (
        process.env.USER_TYPE === 'ant' &&
        (hasTmuxToolBeenUsed() || commandUsesTmux)
      ) {
        await ensureSocketInitialized()
      }
      const claudeTmuxEnv = getClaudeTmuxEnv()
      const env: Record<string, string> = {}
      // 关键：覆盖 TMUX，把所有 tmux 命令隔离到 Claude 的 socket。
      // 这不是用户的 TMUX 值 — 它指向 Claude 的隔离 socket。
      // 为 null（socket 初始化之前）时，保留用户原有的 TMUX。
      if (claudeTmuxEnv) {
        env.TMUX = claudeTmuxEnv
      }
      if (currentSandboxTmpDir) {
        let posixTmpDir = currentSandboxTmpDir
        if (getPlatform() === 'windows') {
          posixTmpDir = windowsPathToPosixPath(posixTmpDir)
        }
        env.TMPDIR = posixTmpDir
        env.CLAUDE_CODE_TMPDIR = posixTmpDir
        // zsh 使用 TMPPREFIX（默认 /tmp/zsh）作为 heredoc 临时文件路径，
        // 而不是 TMPDIR。把它指向 sandbox tmp 目录内的路径，保证
        // sandbox 中的 zsh 命令也能正常使用 heredoc。
        // 无条件设置是安全的 — 非 zsh shell 会忽略 TMPPREFIX。
        env.TMPPREFIX = posixJoin(posixTmpDir, 'zsh')
      }
      // 应用通过 /env 设置的 session 环境变量（仅作用于子进程，不影响 REPL）
      for (const [key, value] of getSessionEnvVars()) {
        env[key] = value
      }
      return env
    },
  }
}
