import chalk from 'chalk'
import { toString as qrToString } from 'qrcode'
import {
  BRIDGE_FAILED_INDICATOR,
  BRIDGE_READY_INDICATOR,
  BRIDGE_SPINNER_FRAMES,
} from '../constants/figures.js'
import { stringWidth } from '@anthropic/ink'
import { logForDebugging } from '../utils/debug.js'
import {
  buildActiveFooterText,
  buildBridgeConnectUrl,
  buildBridgeSessionUrl,
  buildIdleFooterText,
  FAILED_FOOTER_TEXT,
  formatDuration,
  type StatusState,
  TOOL_DISPLAY_EXPIRY_MS,
  timestamp,
  truncatePrompt,
  wrapWithOsc8Link,
} from './bridgeStatusUtil.js'
import type {
  BridgeConfig,
  BridgeLogger,
  SessionActivity,
  SpawnMode,
} from './types.js'

const QR_OPTIONS = {
  type: 'utf8' as const,
  errorCorrectionLevel: 'L' as const,
  small: true,
}

/** 生成二维码并返回其每一行。 */
async function generateQr(url: string): Promise<string[]> {
  const qr = await qrToString(url, QR_OPTIONS)
  return qr.split('\n').filter((line: string) => line.length > 0)
}

export function createBridgeLogger(options: {
  verbose: boolean
  write?: (s: string) => void
}): BridgeLogger {
  const write = options.write ?? ((s: string) => process.stdout.write(s))
  const verbose = options.verbose

  // 追踪当前底部展示的状态行数
  let statusLineCount = 0

  // 状态机
  let currentState: StatusState = 'idle'
  let currentStateText = 'Ready'
  let repoName = ''
  let branch = ''
  let debugLogPath = ''

  // 连接 URL（在 printBanner 里构造，对 staging/prod 用对的 base）
  let connectUrl = ''
  let cachedIngressUrl = ''
  let cachedEnvironmentId = ''
  let activeSessionUrl: string | null = null

  // 当前 URL 对应的二维码行
  let qrLines: string[] = []
  let qrVisible = false

  // 用于第二状态行的工具活动信息
  let lastToolSummary: string | null = null
  let lastToolTime = 0

  // session 数量指示（多 session 模式启用时显示）
  let sessionActive = 0
  let sessionMax = 1
  // session-count 行展示的 spawn 模式 + 控制 `w` 提示是否出现
  let spawnModeDisplay: 'same-dir' | 'worktree' | null = null
  let spawnMode: SpawnMode = 'single-session'

  // 多 session bullet list 中每个 session 的展示信息（按 compat sessionId 索引）
  const sessionDisplayInfo = new Map<
    string,
    { title?: string; url: string; activity?: SessionActivity }
  >()

  // Connecting spinner 状态
  let connectingTimer: ReturnType<typeof setInterval> | null = null
  let connectingTick = 0

  /**
   * 计算一段字符串在终端里占多少行（考虑换行）。每个 `\n` 是一行，
   * 超出宽度的内容会自动换到下一行。
   */
  function countVisualLines(text: string): number {
    // eslint-disable-next-line custom-rules/prefer-use-terminal-size
    const cols = process.stdout.columns || 80 // 非 React CLI 上下文
    let count = 0
    // 按换行拆成 logical line
    for (const logical of text.split('\n')) {
      if (logical.length === 0) {
        // 连续 \n 之间的空段 —— 算 1 行
        count++
        continue
      }
      const width = stringWidth(logical)
      count += Math.max(1, Math.ceil(width / cols))
    }
    // "line\n" 末尾的 \n 会产生一个空的末尾元素 —— 不要算进去，
    // 因为光标停在下一行行首，并不占新的可视行。
    if (text.endsWith('\n')) {
      count--
    }
    return count
  }

  /** 写一行状态文本并记录它占的行数。 */
  function writeStatus(text: string): void {
    write(text)
    statusLineCount += countVisualLines(text)
  }

  /** 清掉当前展示的所有状态行。 */
  function clearStatusLines(): void {
    if (statusLineCount <= 0) return
    logForDebugging(`[bridge:ui] clearStatusLines count=${statusLineCount}`)
    // 把光标移到状态块开头，然后清除下方所有内容
    write(`\x1b[${statusLineCount}A`) // 光标上移 N 行
    write('\x1b[J') // 从光标清除到屏幕末尾
    statusLineCount = 0
  }

  /** 打印一条永久日志：先清状态、再写、再恢复。 */
  function printLog(line: string): void {
    clearStatusLines()
    write(line)
  }

  /** 用给定 URL 重新生成二维码。 */
  function regenerateQr(url: string): void {
    generateQr(url)
      .then(lines => {
        qrLines = lines
        renderStatusLine()
      })
      .catch(e => {
        logForDebugging(`QR code generation failed: ${e}`, { level: 'error' })
      })
  }

  /** 渲染 connecting spinner 行（首次 updateIdleStatus 之前显示）。 */
  function renderConnectingLine(): void {
    clearStatusLines()

    const frame =
      BRIDGE_SPINNER_FRAMES[connectingTick % BRIDGE_SPINNER_FRAMES.length]!
    let suffix = ''
    if (repoName) {
      suffix += chalk.dim(' \u00b7 ') + chalk.dim(repoName)
    }
    if (branch) {
      suffix += chalk.dim(' \u00b7 ') + chalk.dim(branch)
    }
    writeStatus(
      `${chalk.yellow(frame)} ${chalk.yellow('Connecting')}${suffix}\n`,
    )
  }

  /** 启动 connecting spinner。首次 updateIdleStatus() 会停掉它。 */
  function startConnecting(): void {
    stopConnecting()
    renderConnectingLine()
    connectingTimer = setInterval(() => {
      connectingTick++
      renderConnectingLine()
    }, 150)
  }

  /** 停掉 connecting spinner。 */
  function stopConnecting(): void {
    if (connectingTimer) {
      clearInterval(connectingTimer)
      connectingTimer = null
    }
  }

  /** 根据当前 state 渲染并写出状态行。 */
  function renderStatusLine(): void {
    if (currentState === 'reconnecting' || currentState === 'failed') {
      // 这两个状态由别的地方单独处理（updateReconnectingStatus /
      // updateFailedStatus）。这里提前 return 不清屏，避免 toggleQr、
      // setSpawnModeDisplay 之类的调用方在这些状态下把显示擦白。
      return
    }

    clearStatusLines()

    const isIdle = currentState === 'idle'

    // 状态行上方的二维码
    if (qrVisible) {
      for (const line of qrLines) {
        writeStatus(`${chalk.dim(line)}\n`)
      }
    }

    // 按 state 决定指示符和颜色
    const indicator = BRIDGE_READY_INDICATOR
    const indicatorColor = isIdle ? chalk.green : chalk.cyan
    const baseColor = isIdle ? chalk.green : chalk.cyan
    const stateText = baseColor(currentStateText)

    // 组装 repo 和 branch 后缀
    let suffix = ''
    if (repoName) {
      suffix += chalk.dim(' \u00b7 ') + chalk.dim(repoName)
    }
    // worktree 模式下每个 session 有自己的 branch，显示 bridge 的 branch
    // 会产生误导。
    if (branch && spawnMode !== 'worktree') {
      suffix += chalk.dim(' \u00b7 ') + chalk.dim(branch)
    }

    if (process.env.USER_TYPE === 'ant' && debugLogPath) {
      writeStatus(
        `${chalk.yellow('[ANT-ONLY] Logs:')} ${chalk.dim(debugLogPath)}\n`,
      )
    }
    writeStatus(`${indicatorColor(indicator)} ${stateText}${suffix}\n`)

    // session 数量和 per-session 列表（仅多 session 模式）
    if (sessionMax > 1) {
      const modeHint =
        spawnMode === 'worktree'
          ? 'New sessions will be created in an isolated worktree'
          : 'New sessions will be created in the current directory'
      writeStatus(
        `    ${chalk.dim(`Capacity: ${sessionActive}/${sessionMax} \u00b7 ${modeHint}`)}\n`,
      )
      for (const [, info] of sessionDisplayInfo) {
        const titleText = info.title
          ? truncatePrompt(info.title, 35)
          : chalk.dim('Attached')
        const titleLinked = wrapWithOsc8Link(titleText, info.url)
        const act = info.activity
        const showAct = act && act.type !== 'result' && act.type !== 'error'
        const actText = showAct
          ? chalk.dim(` ${truncatePrompt(act.summary, 40)}`)
          : ''
        writeStatus(`    ${titleLinked}${actText}
`)
      }
    }

    // 单槽 spawn 模式（或真正的单 session 模式）的 mode 行
    if (sessionMax === 1) {
      const modeText =
        spawnMode === 'single-session'
          ? 'Single session \u00b7 exits when complete'
          : spawnMode === 'worktree'
            ? `Capacity: ${sessionActive}/1 \u00b7 New sessions will be created in an isolated worktree`
            : `Capacity: ${sessionActive}/1 \u00b7 New sessions will be created in the current directory`
      writeStatus(`    ${chalk.dim(modeText)}\n`)
    }

    // 单 session 模式下的工具活动行
    if (
      sessionMax === 1 &&
      !isIdle &&
      lastToolSummary &&
      Date.now() - lastToolTime < TOOL_DISPLAY_EXPIRY_MS
    ) {
      writeStatus(`  ${chalk.dim(truncatePrompt(lastToolSummary, 60))}\n`)
    }

    // 底部文案前的空行分隔
    const url = activeSessionUrl ?? connectUrl
    if (url) {
      writeStatus('\n')
      const footerText = isIdle
        ? buildIdleFooterText(url)
        : buildActiveFooterText(url)
      const qrHint = qrVisible
        ? chalk.dim.italic('space to hide QR code')
        : chalk.dim.italic('space to show QR code')
      const toggleHint = spawnModeDisplay
        ? chalk.dim.italic(' \u00b7 w to toggle spawn mode')
        : ''
      writeStatus(`${chalk.dim(footerText)}\n`)
      writeStatus(`${qrHint}${toggleHint}\n`)
    }
  }

  return {
    printBanner(config: BridgeConfig, environmentId: string): void {
      cachedIngressUrl = config.sessionIngressUrl
      cachedEnvironmentId = environmentId
      connectUrl = buildBridgeConnectUrl(environmentId, cachedIngressUrl)
      regenerateQr(connectUrl)

      if (verbose) {
        write(chalk.dim(`Remote Control`) + ` v${MACRO.VERSION}\n`)
      }
      if (verbose) {
        if (config.spawnMode !== 'single-session') {
          write(chalk.dim(`Spawn mode: `) + `${config.spawnMode}\n`)
          write(
            chalk.dim(`Max concurrent sessions: `) + `${config.maxSessions}\n`,
          )
        }
        write(chalk.dim(`Environment ID: `) + `${environmentId}\n`)
      }
      if (config.sandbox) {
        write(chalk.dim(`Sandbox: `) + `${chalk.green('Enabled')}\n`)
      }
      write('\n')

      // 启动 connecting spinner —— 首次 updateIdleStatus() 会停掉它
      startConnecting()
    },

    logSessionStart(sessionId: string, prompt: string): void {
      if (verbose) {
        const short = truncatePrompt(prompt, 80)
        printLog(
          chalk.dim(`[${timestamp()}]`) +
            ` Session started: ${chalk.white(`"${short}"`)} (${chalk.dim(sessionId)})\n`,
        )
      }
    },

    logSessionComplete(sessionId: string, durationMs: number): void {
      printLog(
        chalk.dim(`[${timestamp()}]`) +
          ` Session ${chalk.green('completed')} (${formatDuration(durationMs)}) ${chalk.dim(sessionId)}\n`,
      )
    },

    logSessionFailed(sessionId: string, error: string): void {
      printLog(
        chalk.dim(`[${timestamp()}]`) +
          ` Session ${chalk.red('failed')}: ${error} ${chalk.dim(sessionId)}\n`,
      )
    },

    logStatus(message: string): void {
      printLog(chalk.dim(`[${timestamp()}]`) + ` ${message}\n`)
    },

    logVerbose(message: string): void {
      if (verbose) {
        printLog(chalk.dim(`[${timestamp()}] ${message}`) + '\n')
      }
    },

    logError(message: string): void {
      printLog(chalk.red(`[${timestamp()}] Error: ${message}`) + '\n')
    },

    logReconnected(disconnectedMs: number): void {
      printLog(
        chalk.dim(`[${timestamp()}]`) +
          ` ${chalk.green('Reconnected')} after ${formatDuration(disconnectedMs)}\n`,
      )
    },

    setRepoInfo(repo: string, branchName: string): void {
      repoName = repo
      branch = branchName
    },

    setDebugLogPath(path: string): void {
      debugLogPath = path
    },

    updateIdleStatus(): void {
      stopConnecting()

      currentState = 'idle'
      currentStateText = 'Ready'
      lastToolSummary = null
      lastToolTime = 0
      activeSessionUrl = null
      regenerateQr(connectUrl)
      renderStatusLine()
    },

    setAttached(sessionId: string): void {
      stopConnecting()
      currentState = 'attached'
      currentStateText = 'Connected'
      lastToolSummary = null
      lastToolTime = 0
      // 多 session：让 footer/QR 停留在 environment 的 connect URL 上，方
      // 便用户再开新 session。per-session 链接在 bullet list 里。
      if (sessionMax <= 1) {
        activeSessionUrl = buildBridgeSessionUrl(
          sessionId,
          cachedEnvironmentId,
          cachedIngressUrl,
        )
        regenerateQr(activeSessionUrl)
      }
      renderStatusLine()
    },

    updateReconnectingStatus(delayStr: string, elapsedStr: string): void {
      stopConnecting()
      clearStatusLines()
      currentState = 'reconnecting'

      // 状态行上方的二维码
      if (qrVisible) {
        for (const line of qrLines) {
          writeStatus(`${chalk.dim(line)}\n`)
        }
      }

      const frame =
        BRIDGE_SPINNER_FRAMES[connectingTick % BRIDGE_SPINNER_FRAMES.length]!
      connectingTick++
      writeStatus(
        `${chalk.yellow(frame)} ${chalk.yellow('Reconnecting')} ${chalk.dim('\u00b7')} ${chalk.dim(`retrying in ${delayStr}`)} ${chalk.dim('\u00b7')} ${chalk.dim(`disconnected ${elapsedStr}`)}\n`,
      )
    },

    updateFailedStatus(error: string): void {
      stopConnecting()
      clearStatusLines()
      currentState = 'failed'

      let suffix = ''
      if (repoName) {
        suffix += chalk.dim(' \u00b7 ') + chalk.dim(repoName)
      }
      if (branch) {
        suffix += chalk.dim(' \u00b7 ') + chalk.dim(branch)
      }

      writeStatus(
        `${chalk.red(BRIDGE_FAILED_INDICATOR)} ${chalk.red('Remote Control Failed')}${suffix}\n`,
      )
      writeStatus(`${chalk.dim(FAILED_FOOTER_TEXT)}\n`)

      if (error) {
        writeStatus(`${chalk.red(error)}\n`)
      }
    },

    updateSessionStatus(
      _sessionId: string,
      _elapsed: string,
      activity: SessionActivity,
      _trail: string[],
    ): void {
      // 把工具活动缓存起来供第二状态行使用
      if (activity.type === 'tool_start') {
        lastToolSummary = activity.summary
        lastToolTime = Date.now()
      }
      renderStatusLine()
    },

    clearStatus(): void {
      stopConnecting()
      clearStatusLines()
    },

    toggleQr(): void {
      qrVisible = !qrVisible
      renderStatusLine()
    },

    updateSessionCount(active: number, max: number, mode: SpawnMode): void {
      if (sessionActive === active && sessionMax === max && spawnMode === mode)
        return
      sessionActive = active
      sessionMax = max
      spawnMode = mode
      // 这里不重渲染 —— 状态 ticker 会按自己的节奏调 renderStatusLine，
      // 下一 tick 会把新值带进去。
    },

    setSpawnModeDisplay(mode: 'same-dir' | 'worktree' | null): void {
      if (spawnModeDisplay === mode) return
      spawnModeDisplay = mode
      // 同步 #21118 引入的 spawnMode，让下一次渲染展示正确的 mode hint
      // 和 branch 可见性。这里不渲染 —— 与 updateSessionCount 一致：
      // 在 printBanner 之前（初始设置）和 `w` 处理器中（紧跟着调
      // refreshDisplay）都会被调用。
      if (mode) spawnMode = mode
    },

    addSession(sessionId: string, url: string): void {
      sessionDisplayInfo.set(sessionId, { url })
    },

    updateSessionActivity(sessionId: string, activity: SessionActivity): void {
      const info = sessionDisplayInfo.get(sessionId)
      if (!info) return
      info.activity = activity
    },

    setSessionTitle(sessionId: string, title: string): void {
      const info = sessionDisplayInfo.get(sessionId)
      if (!info) return
      info.title = title
      // 防 reconnecting/failed —— renderStatusLine 在这两种状态下会先清屏
      // 再提前 return，会把 spinner/错误擦掉。
      if (currentState === 'reconnecting' || currentState === 'failed') return
      if (sessionMax === 1) {
        // 单 session：主状态栏也展示标题。
        currentState = 'titled'
        currentStateText = truncatePrompt(title, 40)
      }
      renderStatusLine()
    },

    removeSession(sessionId: string): void {
      sessionDisplayInfo.delete(sessionId)
    },

    refreshDisplay(): void {
      // reconnecting/failed 期间跳过 —— renderStatusLine 在这两种状态下会
      // 先清屏再提前 return，会把 spinner/错误擦掉。
      if (currentState === 'reconnecting' || currentState === 'failed') return
      renderStatusLine()
    },
  }
}
