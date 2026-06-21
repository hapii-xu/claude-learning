import { feature } from 'bun:bundle'
import { stat } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { env, JETBRAINS_IDES } from './env.js'
import { isEnvTruthy } from './envUtils.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { getAncestorCommandsAsync } from './genericProcessUtils.js'

// 需要 execFileNoThrow 的函数，因此不能放在 env.ts 中

const getIsDocker = memoize(async (): Promise<boolean> => {
  if (process.platform !== 'linux') return false
  // 检查 .dockerenv 文件
  const { code } = await execFileNoThrow('test', ['-f', '/.dockerenv'])
  return code === 0
})

function getIsBubblewrapSandbox(): boolean {
  return (
    process.platform === 'linux' &&
    isEnvTruthy(process.env.CLAUDE_CODE_BUBBLEWRAP)
  )
}

// 运行时 musl 检测回退的缓存（仅限 node/unbundled）。
// 在原生 linux 构建中，feature flag 在编译时解析此问题，因此
// 缓存仅在 IS_LIBC_MUSL 和 IS_LIBC_GLIBC 都为 false 时被查询。
let muslRuntimeCache: boolean | null = null

// 即发即忘：为 node 回退路径填充 musl 缓存。
// 原生构建永远不会走到这里（feature flag 短路），因此这只
// 对 Linux 上的 unbundled node 有影响。原生构建上的 Installer
// 调用不受影响，因为 feature() 在编译时解析。
if (process.platform === 'linux') {
  const muslArch = process.arch === 'x64' ? 'x86_64' : 'aarch64'
  void stat(`/lib/libc.musl-${muslArch}.so.1`).then(
    () => {
      muslRuntimeCache = true
    },
    () => {
      muslRuntimeCache = false
    },
  )
}

/**
 * 检查系统是否使用 MUSL libc 而非 glibc。
 * 在原生 linux 构建中，这通过 IS_LIBC_MUSL/IS_LIBC_GLIBC 标志
 * 在编译时静态已知。
 * 在 node（unbundled）中，两个标志都为 false，我们回退到运行时
 * 异步 stat 检查，其结果在模块加载时缓存。若缓存尚未填充，返回 false。
 */
function isMuslEnvironment(): boolean {
  if (feature('IS_LIBC_MUSL')) return true
  if (feature('IS_LIBC_GLIBC')) return false

  // node 的回退：通过预填充缓存进行运行时检测
  if (process.platform !== 'linux') return false
  return muslRuntimeCache ?? false
}

// 异步 JetBrains 检测的缓存
let jetBrainsIDECache: string | null | undefined

async function detectJetBrainsIDEFromParentProcessAsync(): Promise<
  string | null
> {
  if (jetBrainsIDECache !== undefined) {
    return jetBrainsIDECache
  }

  if (process.platform === 'darwin') {
    jetBrainsIDECache = null
    return null // macOS 使用 bundle ID 检测，已处理
  }

  try {
    // 在单次调用中获取祖先命令（避免循环中的同步 bash）
    const commands = await getAncestorCommandsAsync(process.pid, 10)

    for (const command of commands) {
      const lowerCommand = command.toLowerCase()
      // 在命令行中检查特定的 JetBrains IDE
      for (const ide of JETBRAINS_IDES) {
        if (lowerCommand.includes(ide)) {
          jetBrainsIDECache = ide
          return ide
        }
      }
    }
  } catch {
    // 静默失败 - 这是尽力而为的检测
  }

  jetBrainsIDECache = null
  return null
}

export async function getTerminalWithJetBrainsDetectionAsync(): Promise<
  string | null
> {
  // 在 Linux/Windows 上检查 JetBrains 终端
  if (process.env.TERMINAL_EMULATOR === 'JetBrains-JediTerm') {
    // macOS 上，上方的 bundle ID 检测已处理 JetBrains IDE
    if (env.platform !== 'darwin') {
      const specificIDE = await detectJetBrainsIDEFromParentProcessAsync()
      return specificIDE || 'pycharm'
    }
  }
  return env.terminal
}

// 同步版本，返回缓存结果或回退到 env.terminal
// 用于向后兼容 - 调用方应迁移到异步版本
export function getTerminalWithJetBrainsDetection(): string | null {
  // 在 Linux/Windows 上检查 JetBrains 终端
  if (process.env.TERMINAL_EMULATOR === 'JetBrains-JediTerm') {
    // macOS 上，上方的 bundle ID 检测已处理 JetBrains IDE
    if (env.platform !== 'darwin') {
      // 若有缓存值则返回，否则回退到通用检测
      // 应在应用初始化早期调用异步版本以填充缓存
      if (jetBrainsIDECache !== undefined) {
        return jetBrainsIDECache || 'pycharm'
      }
      // 若缓存尚未填充，回退到通用的 'pycharm'
      return 'pycharm'
    }
  }
  return env.terminal
}

/**
 * 异步初始化 JetBrains IDE 检测。
 * 在应用初始化早期调用以填充缓存。
 * 此 Promise resolve 后，getTerminalWithJetBrainsDetection() 将返回准确结果。
 */
export async function initJetBrainsDetection(): Promise<void> {
  if (process.env.TERMINAL_EMULATOR === 'JetBrains-JediTerm') {
    await detectJetBrainsIDEFromParentProcessAsync()
  }
}

// 组合导出，包含所有 env 属性加动态函数
export const envDynamic = {
  ...env, // 包含 env 的所有属性
  terminal: getTerminalWithJetBrainsDetection(),
  getIsDocker,
  getIsBubblewrapSandbox,
  isMuslEnvironment,
  getTerminalWithJetBrainsDetectionAsync,
  initJetBrainsDetection,
}
