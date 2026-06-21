import { execFileSync, spawn } from 'child_process'
import { constants as fsConstants, readFileSync, unlinkSync } from 'fs'
import { type FileHandle, mkdir, open, realpath } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { tmpdir } from 'os'
import { isAbsolute, resolve } from 'path'
import { join as posixJoin } from 'path/posix'
import { logEvent } from 'src/services/analytics/index.js'
import {
  getOriginalCwd,
  getSessionId,
  setCwdState,
} from '../bootstrap/state.js'
import { generateTaskId } from '../Task.js'
import { pwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { errorMessage, isENOENT } from './errors.js'
import { getFsImplementation } from './fsOperations.js'
import { logError } from './log.js'
import {
  createAbortedCommand,
  createFailedCommand,
  type ShellCommand,
  wrapSpawn,
} from './ShellCommand.js'
import { getTaskOutputDir } from './task/diskOutput.js'
import { TaskOutput } from './task/TaskOutput.js'
import { which } from './which.js'

export type { ExecResult } from './ShellCommand.js'

import { accessSync } from 'fs'
import { onCwdChangedForHooks } from './hooks/fileChangedWatcher.js'
import { getClaudeTempDirName } from './permissions/filesystem.js'
import { getPlatform } from './platform.js'
import { SandboxManager } from './sandbox/sandbox-adapter.js'
import { invalidateSessionEnvCache } from './sessionEnvironment.js'
import { createBashShellProvider } from './shell/bashProvider.js'
import { getCachedPowerShellPath } from './shell/powershellDetection.js'
import { createPowerShellProvider } from './shell/powershellProvider.js'
import type { ShellProvider, ShellType } from './shell/shellProvider.js'
import { subprocessEnv } from './subprocessEnv.js'
import { posixPathToWindowsPath } from './windowsPaths.js'

const DEFAULT_TIMEOUT = 30 * 60 * 1000 // 30 分钟

export type ShellConfig = {
  provider: ShellProvider
}

function isExecutable(shellPath: string): boolean {
  try {
    accessSync(shellPath, fsConstants.X_OK)
    return true
  } catch (_err) {
    // 回退到 Nix 等环境中 X_OK 检查可能失败的情况
    try {
      // 尝试用 --version 执行 shell，应该快速退出
      // 使用 execFileSync 以避免 shell 注入漏洞
      execFileSync(shellPath, ['--version'], {
        timeout: 1000,
        stdio: 'ignore',
      })
      return true
    } catch {
      return false
    }
  }
}

/**
 * 确定最佳可用 shell 使用。
 */
export async function findSuitableShell(): Promise<string> {
  // 首先检查显式 shell 覆盖
  const shellOverride = process.env.CLAUDE_CODE_SHELL
  if (shellOverride) {
    // 验证是否为受支持的 shell 类型
    const isSupported =
      shellOverride.includes('bash') || shellOverride.includes('zsh')
    if (isSupported && isExecutable(shellOverride)) {
      logForDebugging(`Using shell override: ${shellOverride}`)
      return shellOverride
    } else {
      // 注意，如果将来想在此处添加对新 shell 的支持，
      // 需要更新或 Bash 工具解析以考虑这一点
      logForDebugging(
        `CLAUDE_CODE_SHELL="${shellOverride}" is not a valid bash/zsh path, falling back to detection`,
      )
    }
  }

  // 从环境变量检查用户的首选 shell
  const env_shell = process.env.SHELL
  // 仅当是 bash 或 zsh 时才考虑 SHELL
  const isEnvShellSupported =
    env_shell && (env_shell.includes('bash') || env_shell.includes('zsh'))
  const preferBash = env_shell?.includes('bash')

  // 尝试使用 which 定位 shell（可用时使用 Bun.which）
  const [zshPath, bashPath] = await Promise.all([which('zsh'), which('bash')])

  // 从 which 结果和回退位置填充 shell 路径
  const shellPaths = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']

  // 根据用户偏好排序 shell
  const shellOrder = preferBash ? ['bash', 'zsh'] : ['zsh', 'bash']
  const supportedShells = shellOrder.flatMap(shell =>
    shellPaths.map(path => `${path}/${shell}`),
  )

  // 将发现的路径添加到搜索列表开头
  // 将用户的首选 shell 类型放在首位
  if (preferBash) {
    if (bashPath) supportedShells.unshift(bashPath)
    if (zshPath) supportedShells.push(zshPath)
  } else {
    if (zshPath) supportedShells.unshift(zshPath)
    if (bashPath) supportedShells.push(bashPath)
  }

  // 如果是受支持的 shell 类型，始终优先考虑 SHELL 环境变量
  if (isEnvShellSupported && isExecutable(env_shell)) {
    supportedShells.unshift(env_shell)
  }

  const shellPath = supportedShells.find(shell => shell && isExecutable(shell))

  // 如果未找到有效 shell，抛出有用的错误
  if (!shellPath) {
    const errorMsg =
      'No suitable shell found. Claude CLI requires a Posix shell environment. ' +
      'Please ensure you have a valid shell installed and the SHELL environment variable set.'
    logError(new Error(errorMsg))
    throw new Error(errorMsg)
  }

  return shellPath
}

async function getShellConfigImpl(): Promise<ShellConfig> {
  const binShell = await findSuitableShell()
  const provider = await createBashShellProvider(binShell)
  return { provider }
}

// 记忆化整个 shell 配置，使每个会话只执行一次
export const getShellConfig = memoize(getShellConfigImpl)

export const getPsProvider = memoize(async (): Promise<ShellProvider> => {
  const psPath = await getCachedPowerShellPath()
  if (!psPath) {
    throw new Error('PowerShell is not available')
  }
  return createPowerShellProvider(psPath)
})

const resolveProvider: Record<ShellType, () => Promise<ShellProvider>> = {
  bash: async () => (await getShellConfig()).provider,
  powershell: getPsProvider,
}

export type ExecOptions = {
  timeout?: number
  onProgress?: (
    lastLines: string,
    allLines: string,
    totalLines: number,
    totalBytes: number,
    isIncomplete: boolean,
  ) => void
  preventCwdChanges?: boolean
  shouldUseSandbox?: boolean
  shouldAutoBackground?: boolean
  /** 提供时，stdout 被管道化（不发送到文件），且此回调在每个数据块上触发。 */
  onStdout?: (data: string) => void
}

/**
 * 使用环境快照执行 shell 命令
 * 为每次命令执行创建新的 shell 进程
 */
export async function exec(
  command: string,
  abortSignal: AbortSignal,
  shellType: ShellType,
  options?: ExecOptions,
): Promise<ShellCommand> {
  const {
    timeout,
    onProgress,
    preventCwdChanges,
    shouldUseSandbox,
    shouldAutoBackground,
    onStdout,
  } = options ?? {}
  const commandTimeout = timeout || DEFAULT_TIMEOUT

  const provider = await resolveProvider[shellType]()

  const id = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0')

  // 沙箱临时目录 - 使用每用户目录名以防止多用户权限冲突。
  // tmpdir() 遵循 $TMPDIR，因此非 /tmp 环境（Termux/Android、容器）可直接工作。
  const sandboxTmpDir = posixJoin(
    process.env.CLAUDE_CODE_TMPDIR || tmpdir(),
    getClaudeTempDirName(),
  )

  const { commandString: builtCommand, cwdFilePath } =
    await provider.buildExecCommand(command, {
      id,
      sandboxTmpDir: shouldUseSandbox ? sandboxTmpDir : undefined,
      useSandbox: shouldUseSandbox ?? false,
    })

  let commandString = builtCommand

  let cwd = pwd()

  // 如果当前工作目录在磁盘上不再存在则恢复。
  // 当命令删除其自己的 CWD（例如，临时目录清理）时会发生这种情况。
  try {
    await realpath(cwd)
  } catch {
    const fallback = getOriginalCwd()
    logForDebugging(
      `Shell CWD "${cwd}" no longer exists, recovering to "${fallback}"`,
    )
    try {
      await realpath(fallback)
      setCwdState(fallback)
      cwd = fallback
    } catch {
      return createFailedCommand(
        `Working directory "${cwd}" no longer exists. Please restart Claude from an existing directory.`,
      )
    }
  }

  // 如果已中止，则根本不要生成进程
  if (abortSignal.aborted) {
    return createAbortedCommand()
  }

  const binShell = provider.shellPath

  // 沙箱化的 PowerShell：wrapWithSandbox 硬编码 `<binShell> -c '<cmd>'` —
  // 在那里使用 pwsh 会丢失 -NoProfile -NonInteractive（沙箱内加载
  // 配置文件 → 延迟、杂散输出、可能在提示处挂起）。替代方案：
  //   • powershellProvider.buildExecCommand（useSandbox）预包装为
  //     `pwsh -NoProfile -NonInteractive -EncodedCommand <base64>` — base64
  //     在运行时的 shellquote.quote() 层中存活
  //   • 传递 /bin/sh 作为沙箱的内部 shell 来执行该调用
  //   • 外部 spawn 也是 /bin/sh -c 以解析运行时的 POSIX 输出
  // /bin/sh 存在于沙箱受支持的每个平台上。
  const isSandboxedPowerShell = shouldUseSandbox && shellType === 'powershell'
  const sandboxBinShell = isSandboxedPowerShell ? '/bin/sh' : binShell

  if (shouldUseSandbox) {
    commandString = await SandboxManager.wrapWithSandbox(
      commandString,
      sandboxBinShell,
      undefined,
      abortSignal,
    )
    // 为沙箱化进程创建具有安全权限的沙箱临时目录
    try {
      const fs = getFsImplementation()
      await fs.mkdir(sandboxTmpDir, { mode: 0o700 })
    } catch (error) {
      logForDebugging(`Failed to create ${sandboxTmpDir} directory: ${error}`)
    }
  }

  const spawnBinary = isSandboxedPowerShell ? '/bin/sh' : binShell
  const shellArgs = isSandboxedPowerShell
    ? ['-c', commandString]
    : provider.getSpawnArgs(commandString)
  const envOverrides = await provider.getEnvironmentOverrides(command)

  // 当提供 onStdout 时，使用管道模式：stdout 通过
  // StreamWrapper → TaskOutput 内存缓冲区流动，而非文件 fd。
  // 这使调用方可以接收实时 stdout 回调。
  const usePipeMode = !!onStdout
  const taskId = generateTaskId('local_bash')
  const taskOutput = new TaskOutput(taskId, onProgress ?? null, !usePipeMode)
  await mkdir(getTaskOutputDir(), { recursive: true })

  // 在文件模式下，stdout 和 stderr 都进入同一个文件 fd。
  // 在 POSIX 上，O_APPEND 使每次写入原子化（寻址到末尾 + 写入），因此
  // stdout 和 stderr 按时间顺序交错而无撕裂。
  // 在 Windows 上，'a' 模式剥离 FILE_WRITE_DATA（仅授予 FILE_APPEND_DATA），
  // 通过 libuv 的 fs__open。MSYS2/Cygwin 使用 NtQueryInformationFile
  //（FileAccessInformation）探测继承的句柄并将没有 FILE_WRITE_DATA 的句柄
  // 视为只读，静默丢弃所有输出。使用 'w' 授予 FILE_GENERIC_WRITE。
  // 原子性得到保留，因为复制的句柄共享同一个 FILE_OBJECT，
  // 带有 FILE_SYNCHRONOUS_IO_NONALERT，通过单个内核锁序列化所有 I/O。
  // 安全：O_NOFOLLOW 防止沙箱的符号链接跟踪攻击。
  // 在 Windows 上，使用字符串标志 — 数字标志可能通过 libuv 产生 EINVAL。
  let outputHandle: FileHandle | undefined
  if (!usePipeMode) {
    const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0
    outputHandle = await open(
      taskOutput.path,
      process.platform === 'win32'
        ? 'w'
        : fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_APPEND |
            O_NOFOLLOW,
    )
  }

  try {
    const childProcess = spawn(spawnBinary, shellArgs, {
      env: {
        ...subprocessEnv(),
        SHELL: shellType === 'bash' ? binShell : undefined,
        GIT_EDITOR: 'true',
        CLAUDECODE: '1',
        ...envOverrides,
        ...(process.env.USER_TYPE === 'ant'
          ? {
              CLAUDE_CODE_SESSION_ID: getSessionId(),
            }
          : {}),
      },
      cwd,
      stdio: usePipeMode
        ? ['pipe', 'pipe', 'pipe']
        : ['pipe', outputHandle?.fd, outputHandle?.fd],
      // 不传递 signal — 我们将使用 tree-kill 自行处理终止
      detached: provider.detached,
      // 在 Windows 上防止可见的控制台窗口（在其他平台上为空操作）
      windowsHide: true,
    })

    const shellCommand = wrapSpawn(
      childProcess,
      abortSignal,
      commandTimeout,
      taskOutput,
      shouldAutoBackground,
    )

    // 关闭我们的 fd 副本 — 子进程有自己的 dup。
    // 必须在 wrapSpawn 附加 'error' 监听器之后发生，因为 await
    // 让出控制权，而子进程的 ENOENT 'error' 事件可能在该窗口中触发。
    // 包装在自己的 try/catch 中，以便关闭失败（例如 EIO）不会落入
    // spawn 失败的 catch 块，否则会使子进程成为孤儿。
    if (outputHandle !== undefined) {
      try {
        await outputHandle.close()
      } catch {
        // fd 可能已被子进程关闭；可安全忽略
      }
    }

    // 在管道模式下，将调用方的回调与 StreamWrapper 一起附加。
    // 两个监听器接收相同的数据块（Node.js ReadableStream 支持
    // 多个 'data' 监听器）。StreamWrapper 将数据提供给 TaskOutput
    // 以进行持久化；这些回调给调用方提供实时访问。
    if (childProcess.stdout && onStdout) {
      childProcess.stdout.on('data', (chunk: string | Buffer) => {
        onStdout(typeof chunk === 'string' ? chunk : chunk.toString())
      })
    }

    // 将清理附加到命令结果
    // 注意：此处的 readFileSync/unlinkSync 是有意的 — 这些必须在
    // .then() 微任务中同步完成，以便 `await shellCommand.result` 的调用方
    // 在之后立即看到更新的 cwd。使用异步 readFile 会引入微任务边界，
    // 导致调用方继续时 cwd 尚未更新的竞态。

    // 在 Windows 上，cwdFilePath 是 POSIX 路径（用于 bash 的 `pwd -P >| $path`），
    // 但 Node.js 需要原生 Windows 路径用于 readFileSync/unlinkSync。
    // 类似地，`pwd -P` 输出的 POSIX 路径必须在 setCwd 之前转换。
    const nativeCwdFilePath =
      getPlatform() === 'windows'
        ? posixPathToWindowsPath(cwdFilePath)
        : cwdFilePath

    void shellCommand.result.then(async result => {
      // 在 Linux 上，bwrap 在主机上创建 0 字节的挂载点文件以阻止
      // 写入不存在的路径（.bashrc、HEAD 等）。这些在 bwrap 退出后
      // 作为 cwd 中的幽灵点文件持续存在。清理是同步的且在 macOS 上
      // 为空操作。在任何 await 之前保持，以便等待 .result 的调用方
      // 在同一个微任务中看到干净的工作树。
      if (shouldUseSandbox) {
        SandboxManager.cleanupAfterCommand()
      }
      // 仅前台任务更新 cwd
      if (result && !preventCwdChanges && !result.backgroundTaskId) {
        try {
          let newCwd = readFileSync(nativeCwdFilePath, {
            encoding: 'utf8',
          }).trim()
          if (getPlatform() === 'windows') {
            newCwd = posixPathToWindowsPath(newCwd)
          }
          // cwd 是 NFC 规范化的（setCwdState）；来自 `pwd -P` 的 newCwd
          // 在 macOS APFS 上可能是 NFD。在比较之前规范化，以便 Unicode
          // 路径不会在每条命令上都误判为"已更改"。
          if (newCwd.normalize('NFC') !== cwd) {
            setCwd(newCwd, cwd)
            invalidateSessionEnvCache()
            void onCwdChangedForHooks(cwd, newCwd)
          }
        } catch {
          logEvent('tengu_shell_set_cwd', { success: false })
        }
      }
      // 清理用于 cwd 跟踪的临时文件
      try {
        unlinkSync(nativeCwdFilePath)
      } catch {
        // 如果命令在 pwd -P 运行之前失败，文件可能不存在
      }
    })

    return shellCommand
  } catch (error) {
    // 如果 spawn 失败，关闭 fd（子进程从未获得其 dup）
    if (outputHandle !== undefined) {
      try {
        await outputHandle.close()
      } catch {
        // 可能已经关闭
      }
    }
    taskOutput.clear()

    logForDebugging(`Shell exec error: ${errorMessage(error)}`)

    return createAbortedCommand(undefined, {
      code: 126, // 执行错误的标准 Unix 代码
      stderr: errorMessage(error),
    })
  }
}

/**
 * 设置当前工作目录
 */
export function setCwd(path: string, relativeTo?: string): void {
  const resolved = isAbsolute(path)
    ? path
    : resolve(relativeTo || getFsImplementation().cwd(), path)
  // 解析符号链接以匹配 pwd -P 的行为。
  // realpathSync 在路径不存在时抛出 ENOENT — 转换为更友好的
  // 错误消息，而非单独的 existsSync 预检查（TOCTOU）。
  let physicalPath: string
  try {
    physicalPath = getFsImplementation().realpathSync(resolved)
  } catch (e) {
    if (isENOENT(e)) {
      throw new Error(`Path "${resolved}" does not exist`)
    }
    throw e
  }

  setCwdState(physicalPath)
  if (process.env.NODE_ENV !== 'test') {
    try {
      logEvent('tengu_shell_set_cwd', {
        success: true,
      })
    } catch (_error) {
      // 忽略日志错误以防止测试失败
    }
  }
}
