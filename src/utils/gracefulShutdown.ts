import chalk from 'chalk'
import { writeSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { onExit } from 'signal-exit'
import type { ExitReason } from 'src/entrypoints/agentSdkTypes.js'
import {
  getIsInteractive,
  getIsScrollDraining,
  getLastMainRequestId,
  getSessionId,
  isSessionPersistenceDisabled,
} from '../bootstrap/state.js'
import {
  DISABLE_KITTY_KEYBOARD,
  DISABLE_MODIFY_OTHER_KEYS,
  DBP,
  DFE,
  DISABLE_MOUSE_TRACKING,
  EXIT_ALT_SCREEN,
  SHOW_CURSOR,
  CLEAR_ITERM2_PROGRESS,
  CLEAR_TAB_STATUS,
  CLEAR_TERMINAL_TITLE,
  instances,
  supportsTabStatus,
  wrapForMultiplexer,
} from '@anthropic/ink'
import { shutdownDatadog } from '../services/analytics/datadog.js'
import { shutdown1PEventLogging } from '../services/analytics/firstPartyEventLogger.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { AppState } from '../state/AppState.js'
import { runCleanupFunctions } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { isEnvTruthy } from './envUtils.js'
import { getCurrentSessionTitle, sessionIdExists } from './sessionStorage.js'
import { sleep } from './sleep.js'
import { closeSentry } from './sentry.js'
import { profileReport } from './startupProfiler.js'

/**
 * 在进程退出前同步清理终端模式。
 * 确保终端转义序列（Kitty 键盘模式、焦点上报等）
 * 被正确禁用，即使 React 的 componentWillUnmount 来不及执行。
 * 使用 writeSync 以确保写入在退出前完成。
 *
 * 我们无条件发送所有禁用序列，原因如下：
 * 1. 终端检测可能不总是正确（例如在 tmux、screen 中）
 * 2. 这些序列在不支持它们的终端上是空操作
 * 3. 未能禁用会导致终端处于损坏状态
 */
/* eslint-disable custom-rules/no-sync-fs -- 必须在 process.exit 前同步刷新 */
function cleanupTerminalModes(): void {
  if (!process.stdout.isTTY) {
    return
  }

  try {
    // 首先禁用鼠标跟踪，在 React 卸载树遍历之前。
    // 终端需要一次往返来处理此操作并停止发送事件；
    // 现在执行（而非卸载之后）可以在卸载过程中争取时间。
    // 否则事件会在 cooked 模式清理期间到达，
    // 要么回显到屏幕，要么泄漏到 shell。
    writeSync(1, DISABLE_MOUSE_TRACKING)
    // 首先退出备用屏幕，使 printResumeHint()（以及后续所有序列）
    // 输出到主缓冲区。
    //
    // 直接卸载 Ink 而非手动写入 EXIT_ALT_SCREEN。
    // Ink 在 signal-exit 注册了卸载回调，否则它会在
    // forceExit() → process.exit() 中再次运行。让其发生有两个问题：
    //   1. 如果我们在此写入 1049l，卸载稍后再次写入，
    //      第二次会触发另一个 DECRC —— 光标跳回恢复提示上方，
    //      shell 提示符落在错误的行。
    //   2. unmount() 的 onRender() 必须在 altScreenActive=true 时运行
    //      （备用屏幕光标计算），并且在备用缓冲区上运行。先在此退出
    //      备用屏幕会导致 onRender() 在主缓冲区上乱写 REPL 帧。
    // 现在调用 unmount() 会在备用缓冲区上完成最终渲染，
    // 取消订阅 signal-exit，并恰好写入一次 1049l。
    const inst = instances.get(process.stdout)
    if (inst?.isAltScreenActive) {
      try {
        inst.unmount()
      } catch {
        // 协调器/渲染器抛出异常 —— 回退到手动退出备用屏幕
        // 以确保 printResumeHint 仍能输出到主缓冲区。
        writeSync(1, EXIT_ALT_SCREEN)
      }
    }
    // 捕获在卸载树遍历期间到达的事件。
    // 下方的 detachForShutdown() 也会进行排空。
    inst?.drainStdin()
    // 标记 Ink 实例为已卸载，使 signal-exit 的延迟 ink.unmount()
    // 提前返回，而非发送多余的 EXIT_ALT_SCREEN 序列
    //（来自其 writeSync 清理块和 AlternateScreen 的卸载清理）。
    // 这些多余的序列会在 printResumeHint() 之后到达，
    // 在 tmux（及其他可能的终端）上通过恢复保存的光标位置来破坏恢复提示。
    // 跳过完整卸载是安全的：此函数已经发送所有终端重置序列，
    // 且进程即将退出。
    inst?.detachForShutdown()
    // 禁用扩展键上报 —— 始终发送两者，因为终端会默默忽略其不实现的序列
    writeSync(1, DISABLE_MODIFY_OTHER_KEYS)
    writeSync(1, DISABLE_KITTY_KEYBOARD)
    // 禁用焦点事件（DECSET 1004）
    writeSync(1, DFE)
    // 禁用括号粘贴模式
    writeSync(1, DBP)
    // 显示光标
    writeSync(1, SHOW_CURSOR)
    // 清除 iTerm2 进度条 —— 防止返回终端标签页时出现残留进度指示器
    // 或产生铃声
    writeSync(1, CLEAR_ITERM2_PROGRESS)
    // 清除标签页状态（OSC 21337），防止残留的点持续显示
    if (supportsTabStatus()) writeSync(1, wrapForMultiplexer(CLEAR_TAB_STATUS))
    // 清除终端标题，防止标签页显示过期的会话信息。
    // 遵守 CLAUDE_CODE_DISABLE_TERMINAL_TITLE —— 如果用户选择禁用标题更改，
    // 退出时也不要清除其现有标题。
    if (!isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE)) {
      if (process.platform === 'win32') {
        process.title = ''
      } else {
        writeSync(1, CLEAR_TERMINAL_TITLE)
      }
    }
  } catch {
    // 终端可能已经断开（例如关闭终端后的 SIGHUP）。
    // 忽略写入错误，因为我们即将退出。
  }
}

let resumeHintPrinted = false

/**
 * 打印关于如何恢复会话的提示。
 * 仅在启用了持久化的交互式会话中显示。
 */
function printResumeHint(): void {
  // 仅打印一次（故障安全计时器可能在正常关闭后再次调用此函数）
  if (resumeHintPrinted) {
    return
  }
  // 仅在 TTY、交互式会话和启用持久化时显示
  if (
    process.stdout.isTTY &&
    getIsInteractive() &&
    !isSessionPersistenceDisabled()
  ) {
    try {
      const sessionId = getSessionId()
      // 如果会话文件不存在则不显示恢复提示（例如 `claude update` 等子命令）
      if (!sessionIdExists(sessionId)) {
        return
      }
      const customTitle = getCurrentSessionTitle(sessionId)

      // 如果可用则使用自定义标题，否则回退到会话 ID
      let resumeArg: string
      if (customTitle) {
        // 用双引号包裹，先转义反斜杠再转义引号
        const escaped = customTitle.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        resumeArg = `"${escaped}"`
      } else {
        resumeArg = sessionId
      }

      writeSync(
        1,
        chalk.dim(
          `\nResume this session with:\nclaude --resume ${resumeArg}\n`,
        ),
      )
      resumeHintPrinted = true
    } catch {
      // 忽略写入错误
    }
  }
}
/* eslint-enable custom-rules/no-sync-fs */

/**
 * 强制进程退出，处理终端已断开的情况。
 * 当终端/PTY 被关闭时（例如 SIGHUP），process.exit() 可能抛出
 * EIO 错误，因为 Bun 会尝试将 stdout 刷新到已死去的文件描述符。
 * 此时回退到始终有效的 SIGKILL。
 */
function forceExit(exitCode: number): never {
  // 清除故障安全计时器，因为我们即将退出
  if (failsafeTimer !== undefined) {
    clearTimeout(failsafeTimer)
    failsafeTimer = undefined
  }
  // 最后排空 stdin，在退出前执行。cleanupTerminalModes() 提前发送了
  // DISABLE_MOUSE_TRACKING，但终端往返加上任何已在途中的事件意味着
  // 在此期间异步清理的几秒钟内可能有字节到达。在此排空可以捕获它们。
  // 使用 Ink 类方法（而非独立的 drainStdin()）以排空实例的 stdin ——
  // 当 process.stdin 被管道化时，getStdinOverride() 会打开 /dev/tty
  // 作为真实输入流，类方法知道这一点；独立函数默认使用 process.stdin，
  // 在 isTTY=false 时会提前返回。
  try {
    instances.get(process.stdout)?.drainStdin()
  } catch {
    // 终端可能已断开（SIGHUP）。忽略 —— 我们即将退出。
  }
  try {
    process.exit(exitCode)
  } catch (e) {
    // process.exit() 抛出异常。在测试中，它被 mock 为抛出 —— 重新抛出以使测试感知。
    // 在生产中，可能是终端已死的 EIO —— 使用 SIGKILL。
    if ((process.env.NODE_ENV as string) === 'test') {
      throw e
    }
    // 回退到不尝试刷新任何内容的 SIGKILL。
    process.kill(process.pid, 'SIGKILL')
  }
  // 在测试中，process.exit 可能被 mock 为返回而非退出。
  // 在生产中，我们不应该到达这里。
  if ((process.env.NODE_ENV as string) !== 'test') {
    throw new Error('unreachable')
  }
  // TypeScript 技巧：转换为 never，因为我们知道这只发生在测试中，
  // mock 返回而非退出的情况
  return undefined as never
}

/**
 * 设置全局信号处理器以实现优雅关闭
 */
export const setupGracefulShutdown = memoize(() => {
  // 绕过 Bun 的一个 bug：process.removeListener(sig, fn) 会重置该信号的内核
  // sigaction，即使还有其他 JS 监听器存在 —— 信号随后会回退到默认行为（终止），
  // 我们的 process.on('SIGTERM') 处理器永远不会运行。
  //
  // 触发条件：任何短暂存在的 signal-exit v4 订阅者（例如每个子进程的 execa，
  // 或卸载的 Ink 实例）。当其取消订阅运行时，且它是最后一个 v4 订阅者时，
  // v4.unload() 会对列表中的每个信号（SIGTERM、SIGINT、SIGHUP 等）调用
  // removeListener，触发 Bun bug 并在内核级别清除我们的处理器。
  //
  // 修复：通过注册一个永不取消订阅的无操作 onExit 回调来固定 signal-exit v4。
  // 这使 v4 的内部发射器计数保持 > 0，因此 unload() 永远不会运行，
  // removeListener 也永远不会被调用。在 Node.js 下无害 —— 固定也确保
  // signal-exit 的 process.exit 钩子保持活跃以供 Ink 清理。
  onExit(() => {})

  process.on('SIGINT', () => {
    // 在打印模式下，print.ts 注册了自己的 SIGINT 处理器来中止
    // 正在进行的查询并调用 gracefulShutdown(0)；在此跳过以避免与其竞争。
    // 仅检查打印模式 —— 其他非交互式会话（--sdk-url、--init-only、
    // 非 TTY）不注册自己的 SIGINT 处理器，需要 gracefulShutdown 运行。
    if (process.argv.includes('-p') || process.argv.includes('--print')) {
      return
    }
    logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGINT' })
    void gracefulShutdown(0)
  })
  process.on('SIGTERM', () => {
    logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGTERM' })
    void gracefulShutdown(143) // SIGTERM 的退出码 143 (128 + 15)
  })
  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => {
      logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGHUP' })
      void gracefulShutdown(129) // SIGHUP 的退出码 129 (128 + 1)
    })

    // 检测终端关闭但未发送 SIGHUP 时的孤儿进程。
    // macOS 会撤销 TTY 文件描述符而非发送信号，使进程存活但无法读写。
    // 定期检查 stdin 有效性。
    if (process.stdin.isTTY) {
      orphanCheckInterval = setInterval(() => {
        // 在滚动排空期间跳过 —— 即使是廉价的检查也会消耗滚动帧需要的事件循环 tick。
        // 30 秒间隔 → 漏掉一次也没关系。
        if (getIsScrollDraining()) return
        // 当 TTY 被撤销时，process.stdout.writable 变为 false
        if (!process.stdout.writable || !process.stdin.readable) {
          clearInterval(orphanCheckInterval)
          logForDiagnosticsNoPII('info', 'shutdown_signal', {
            signal: 'orphan_detected',
          })
          void gracefulShutdown(129)
        }
      }, 30_000) // 每 30 秒检查一次
      orphanCheckInterval.unref() // 不要仅为此检查而保持进程存活
    }
  }

  // 记录未捕获的异常以用于容器可观测性和分析
  // 错误名称（例如 "TypeError"）不是敏感信息 —— 可以安全记录
  process.on('uncaughtException', error => {
    logForDiagnosticsNoPII('error', 'uncaught_exception', {
      error_name: error.name,
      error_message: error.message.slice(0, 2000),
    })
    logEvent('tengu_uncaught_exception', {
      error_name:
        error.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  })

  // 记录未处理的 Promise 拒绝以用于容器可观测性和分析
  process.on('unhandledRejection', reason => {
    const errorName =
      reason instanceof Error
        ? reason.name
        : typeof reason === 'string'
          ? 'string'
          : 'unknown'
    const errorInfo =
      reason instanceof Error
        ? {
            error_name: reason.name,
            error_message: reason.message.slice(0, 2000),
            error_stack: reason.stack?.slice(0, 4000),
          }
        : { error_message: String(reason).slice(0, 2000) }
    logForDiagnosticsNoPII('error', 'unhandled_rejection', errorInfo)
    logEvent('tengu_unhandled_rejection', {
      error_name:
        errorName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  })
})

export function gracefulShutdownSync(
  exitCode = 0,
  reason: ExitReason = 'other',
  options?: {
    getAppState?: () => AppState
    setAppState?: (f: (prev: AppState) => AppState) => void
  },
): void {
  // 设置进程自然退出时将使用的退出码。注意我们也在同步版本中执行此操作，
  // 以便可以通过检查 process.exitCode 来判断 gracefulShutdownSync 是否被调用。
  process.exitCode = exitCode

  pendingShutdown = gracefulShutdown(exitCode, reason, options)
    .catch(error => {
      logForDebugging(`Graceful shutdown failed: ${error}`, { level: 'error' })
      cleanupTerminalModes()
      printResumeHint()
      forceExit(exitCode)
    })
    // 防止未处理的拒绝：forceExit 在测试模式下会重新抛出，
    // 这会作为新的拒绝逃逸到上方的 .catch() 处理器之外。
    .catch(() => {})
}

let shutdownInProgress = false
let failsafeTimer: ReturnType<typeof setTimeout> | undefined
let orphanCheckInterval: ReturnType<typeof setInterval> | undefined
let pendingShutdown: Promise<void> | undefined

/** 检查优雅关闭是否正在进行 */
export function isShuttingDown(): boolean {
  return shutdownInProgress
}

/** 重置关闭状态 —— 仅用于测试 */
export function resetShutdownState(): void {
  shutdownInProgress = false
  resumeHintPrinted = false
  if (failsafeTimer !== undefined) {
    clearTimeout(failsafeTimer)
    failsafeTimer = undefined
  }
  pendingShutdown = undefined
}

/**
 * 返回进行中的关闭 Promise（如果有）。仅用于测试中
 * 在恢复 mock 之前等待完成。
 */
export function getPendingShutdownForTesting(): Promise<void> | undefined {
  return pendingShutdown
}

// 排空事件循环的优雅关闭函数
export async function gracefulShutdown(
  exitCode = 0,
  reason: ExitReason = 'other',
  options?: {
    getAppState?: () => AppState
    setAppState?: (f: (prev: AppState) => AppState) => void
    /** 在退出备用屏幕后、forceExit 之前打印到 stderr。 */
    finalMessage?: string
  },
): Promise<void> {
  if (shutdownInProgress) {
    return
  }
  shutdownInProgress = true

  // 在启动故障安全之前解析 SessionEnd 钩子预算，使故障安全可以与之匹配。
  // 否则，用户配置的 10 秒钩子预算会被 5 秒故障安全静默截断（gh-32712 后续修复）。
  const { executeSessionEndHooks, getSessionEndHookTimeoutMs } = await import(
    './hooks.js'
  )
  const sessionEndTimeoutMs = getSessionEndHookTimeoutMs()

  // 故障安全：即使清理挂起（例如 MCP 连接）也保证进程退出。
  // 首先运行 cleanupTerminalModes，使挂起的清理不会留下脏终端。
  // 预算 = max(5s，钩子预算 + 3.5s 清理和分析刷新的余量）。
  failsafeTimer = setTimeout(
    code => {
      cleanupTerminalModes()
      printResumeHint()
      forceExit(code)
    },
    Math.max(5000, sessionEndTimeoutMs + 3500),
    exitCode,
  )
  failsafeTimer.unref()

  // 设置进程自然退出时将使用的退出码
  process.exitCode = exitCode

  // 首先退出备用屏幕并打印恢复提示，在任何异步操作之前。
  // 这确保即使进程在清理期间被杀死（例如 macOS 重启时的 SIGKILL），
  // 提示仍然可见。否则，恢复提示只会在清理函数、钩子和分析刷新之后出现
  // —— 这可能需要几秒钟。
  cleanupTerminalModes()
  printResumeHint()

  // 首先刷新会话数据 —— 这是最关键的清理。如果终端已死（SIGHUP、SSH 断开），
  // 钩子和分析可能会挂在对已死 TTY 或不可达网络的 I/O 上，消耗故障安全预算。
  // 会话持久化必须在其他任何操作之前完成。
  let cleanupTimeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    const cleanupPromise = (async () => {
      try {
        await runCleanupFunctions()
      } catch {
        // 静默忽略清理错误
      }
    })()

    await Promise.race([
      cleanupPromise,
      new Promise((_, reject) => {
        cleanupTimeoutId = setTimeout(
          rej => rej(new CleanupTimeoutError()),
          2000,
          reject,
        )
      }),
    ])
    clearTimeout(cleanupTimeoutId)
  } catch {
    // 静默处理超时和其他错误
    clearTimeout(cleanupTimeoutId)
  }

  // 执行 SessionEnd 钩子。通过单一预算同时约束每个钩子的默认超时和整体执行时间
  //（CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS，默认 1.5s）。
  // 设置中的 hook.timeout 在此上限内被尊重。
  try {
    await executeSessionEndHooks(reason, {
      ...options,
      signal: AbortSignal.timeout(sessionEndTimeoutMs),
      timeoutMs: sessionEndTimeoutMs,
    })
  } catch {
    // 忽略 SessionEnd 钩子异常（包括超时时的 AbortError）
  }

  // 在分析关闭刷新/取消计时器之前记录启动性能
  try {
    profileReport()
  } catch {
    // 忽略关闭期间的性能分析错误
  }

  // 向推理端发出信号，表示此会话的缓存可以被逐出。
  // 在分析刷新之前触发，使事件能够到达管道。
  const lastRequestId = getLastMainRequestId()
  if (lastRequestId) {
    logEvent('tengu_cache_eviction_hint', {
      scope:
        'session_end' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      last_request_id:
        lastRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // 刷新分析 —— 上限 500ms。之前无上限：第一方导出器等待所有待处理的
  // axios POST（每个 10 秒），消耗完整的故障安全预算。
  // 慢网络下丢失分析数据可以接受；挂起的退出则不可接受。
  try {
    await Promise.race([
      Promise.all([
        shutdown1PEventLogging(),
        shutdownDatadog(),
        closeSentry(2000),
      ]),
      sleep(500),
    ])
  } catch {
    // 忽略分析关闭错误
  }

  if (options?.finalMessage) {
    try {
      // eslint-disable-next-line custom-rules/no-sync-fs -- 必须在 forceExit 前刷新
      writeSync(2, options.finalMessage + '\n')
    } catch {
      // stderr 可能已关闭（例如 SSH 断开）。忽略写入错误。
    }
  }

  forceExit(exitCode)
}

class CleanupTimeoutError extends Error {
  constructor() {
    super('Cleanup timeout')
  }
}
