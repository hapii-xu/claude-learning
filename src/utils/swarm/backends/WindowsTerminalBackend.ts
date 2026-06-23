import { randomUUID } from 'crypto'
import { readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { AgentColorName } from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js'
import { logForDebugging } from '../../../utils/debug.js'
import { execFileNoThrow } from '../../../utils/execFileNoThrow.js'
import { getPlatform, type Platform } from '../../../utils/platform.js'
import { isInWindowsTerminal } from './detection.js'
import { registerWindowsTerminalBackend } from './registry.js'
import type { CreatePaneResult, PaneBackend, PaneId } from './types.js'

type CommandResult = { stdout: string; stderr: string; code: number }
type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>

type PaneStatus = 'registered' | 'spawning' | 'ready' | 'killing' | 'dead'

type WindowsTerminalPane = {
  title: string
  mode: 'pane' | 'window'
  pidFile: string
  status: PaneStatus
  pid?: number
  spawnPromise?: Promise<void>
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function wrapPowerShellCommand(command: string, pidFile: string): string {
  const quotedPidFile = quotePowerShellString(pidFile)
  // PowerShell 要求 try/catch/finally 为单个复合语句 —
  // 块之间的分号会导致 "Try 语句缺少自己的 Catch 或 Finally 块"。
  // 使用换行符 (\n) 使解析器将其视为一个语句。
  return [
    "$ErrorActionPreference = 'Stop'",
    `Set-Content -LiteralPath ${quotedPidFile} -Value $PID`,
    [
      `try { ${command}; if ($LASTEXITCODE -is [int]) { exit $LASTEXITCODE } }`,
      `catch { Write-Error $_; exit 1 }`,
      `finally { Remove-Item -LiteralPath ${quotedPidFile} -Force -ErrorAction SilentlyContinue }`,
    ].join('\n'),
  ].join('; ')
}

const WT_PANE_TIMEOUT_DEFAULT_MS = 8000
const WT_PANE_POLL_INTERVAL_MS = 200

function getWtPaneTimeoutMs(): number {
  const raw = process.env.CLAUDE_WT_PANE_TIMEOUT_MS
  if (!raw) return WT_PANE_TIMEOUT_DEFAULT_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : WT_PANE_TIMEOUT_DEFAULT_MS
}

async function waitForPidFile(
  pidFile: string,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      const content = (await readFile(pidFile, 'utf-8')).trim()
      if (!/^\d+$/.test(content)) {
        lastErr = new Error(
          `pidFile content not a valid pid: ${JSON.stringify(content)}`,
        )
      } else {
        const pid = Number.parseInt(content, 10)
        if (Number.isFinite(pid) && pid > 0) return pid
        lastErr = new Error(`pidFile content parsed to invalid pid: ${pid}`)
      }
    } catch (err) {
      lastErr = err
    }
    await new Promise(r => setTimeout(r, WT_PANE_POLL_INTERVAL_MS))
  }
  throw lastErr ?? new Error('pidFile never appeared')
}

/**
 * WindowsTerminalBackend 使用 wt.exe 创建可见的 teammate pane/标签页。
 *
 * Windows Terminal 的 CLI 直接在新 pane 中启动命令；它不会
 * 暴露一个稳定的 pane id 来后续接收任意输入。为了符合
 * PaneBackend 接口，createTeammatePaneInSwarmView 分配一个内部 id，
 * 而 sendCommandToPane 执行实际的 `wt split-pane` 启动。
 */
export class WindowsTerminalBackend implements PaneBackend {
  readonly type = 'windows-terminal' as const
  readonly displayName = 'Windows Terminal'
  readonly supportsHideShow = false

  private panes = new Map<PaneId, WindowsTerminalPane>()

  private readonly runCommand: CommandRunner
  private readonly getPlatformValue: () => Platform
  private readonly pidFileDir: string

  constructor(
    runCommandOrOptions?:
      | CommandRunner
      | {
          runCommand?: CommandRunner
          getPlatform?: () => Platform
          pidFileDir?: string
        },
    getPlatformValue?: () => Platform,
  ) {
    if (
      typeof runCommandOrOptions === 'function' ||
      runCommandOrOptions === undefined
    ) {
      this.runCommand = runCommandOrOptions ?? execFileNoThrow
      this.getPlatformValue = getPlatformValue ?? getPlatform
      this.pidFileDir = tmpdir()
    } else {
      this.runCommand = runCommandOrOptions.runCommand ?? execFileNoThrow
      this.getPlatformValue = runCommandOrOptions.getPlatform ?? getPlatform
      this.pidFileDir = runCommandOrOptions.pidFileDir ?? tmpdir()
    }
  }

  private makePidFile(paneId: string): string {
    return join(
      this.pidFileDir,
      `${paneId.replace(/[^a-zA-Z0-9_-]/g, '-')}.pid`,
    )
  }

  async isAvailable(): Promise<boolean> {
    if (this.getPlatformValue() !== 'windows') {
      return false
    }
    // 不要运行 `wt.exe --version` — wt.exe 是 UWP 应用桥接器，会打开
    // Windows Terminal 应用来渲染版本信息，每次检查可用性时
    // 都会产生一个幻影 "Windows 终端 1.24.x" 窗口。
    // 改为检查 WT_SESSION 环境变量（在 WT 内设置）或验证
    // 二进制文件存在于 PATH 中而不执行它。
    if (process.env.WT_SESSION) {
      return true
    }
    const result = await this.runCommand('where.exe', ['wt.exe'])
    return result.code === 0
  }

  async isRunningInside(): Promise<boolean> {
    return this.getPlatformValue() === 'windows' && isInWindowsTerminal()
  }

  async createTeammatePaneInSwarmView(
    name: string,
    _color: AgentColorName,
  ): Promise<CreatePaneResult> {
    const paneId = `wt-${randomUUID()}`
    const isFirstTeammate = this.panes.size === 0
    this.panes.set(paneId, {
      title: name,
      mode: 'pane',
      pidFile: this.makePidFile(paneId),
      status: 'registered',
    })
    return { paneId, isFirstTeammate }
  }

  async createTeammateWindowInSwarmView(
    name: string,
    _color: AgentColorName,
  ): Promise<CreatePaneResult & { windowName: string }> {
    const paneId = `wt-${randomUUID()}`
    const windowName = `teammate-${name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`
    this.panes.set(paneId, {
      title: name,
      mode: 'window',
      pidFile: this.makePidFile(paneId),
      status: 'registered',
    })
    return { paneId, isFirstTeammate: false, windowName }
  }

  async sendCommandToPane(
    paneId: PaneId,
    command: string,
    _useExternalSession?: boolean,
  ): Promise<void> {
    const pane = this.panes.get(paneId)
    if (!pane) {
      throw new Error(`Unknown Windows Terminal pane id: ${paneId}`)
    }

    // 拒绝 ready 态重 spawn（避免同 pidFile 双进程竞争）
    if (pane.status === 'ready' || pane.status === 'killing') {
      throw new Error(
        `Pane ${paneId} already spawned (status=${pane.status}); create a new pane to re-launch`,
      )
    }
    if (pane.status === 'spawning') {
      throw new Error(
        `Pane ${paneId} is currently spawning; wait for the in-flight launch to complete`,
      )
    }
    if (pane.status === 'dead') {
      throw new Error(`Pane ${paneId} is dead; create a new pane`)
    }
    // pane.status === 'registered' → 继续

    // 提前赋值 spawnPromise 在任何 await 前（inner Promise 包装）
    // 立即附加无操作的 .catch() 以防止未处理拒绝警告，
    // 以防 killPane 从未 await spawnPromise（例如 sendCommandToPane
    // 在调用 killPane 之前失败）。
    let resolveSpawn!: () => void
    let rejectSpawn!: (err: unknown) => void
    const spawnPromise = new Promise<void>((res, rej) => {
      resolveSpawn = res
      rejectSpawn = rej
    })
    // 静默未处理拒绝：killPane 可能会稍后 .catch() 这个，但如果
    // pane 在尝试任何 kill 之前就死了，拒绝不能泄漏。
    spawnPromise.catch(() => {})
    pane.status = 'spawning'
    pane.spawnPromise = spawnPromise

    try {
      const launcher = wrapPowerShellCommand(command, pane.pidFile)
      // wt.exe 将 ';' 视为自己的命令分隔符，这会破坏
      // 通过 -Command 传递的多语句 PowerShell 命令。将整个
      // 脚本编码为 Base64 UTF-16LE 并改用 -EncodedCommand。
      const encoded = Buffer.from(launcher, 'utf16le').toString('base64')
      const args =
        pane.mode === 'window'
          ? ['-w', '-1', 'new-tab', '--title', pane.title]
          : ['-w', '0', 'split-pane', '--vertical', '--title', pane.title]

      await unlink(pane.pidFile).catch(() => {})

      const result = await this.runCommand('wt.exe', [
        ...args,
        'powershell.exe',
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encoded,
      ])

      if (result.code !== 0) {
        throw new Error(
          `Failed to launch Windows Terminal teammate ${paneId}: ${result.stderr}`,
        )
      }

      const timeoutMs = getWtPaneTimeoutMs()
      let pid: number
      try {
        pid = await waitForPidFile(pane.pidFile, timeoutMs)
      } catch (err) {
        throw new Error(
          `Windows Terminal pane failed to launch within ${timeoutMs}ms\n` +
            `  paneId: ${paneId}\n` +
            `  pidFile: ${pane.pidFile}\n` +
            `  wt.exe stdout: ${result.stdout || '(empty)'}\n` +
            `  wt.exe stderr: ${result.stderr || '(empty)'}\n` +
            `  underlying: ${err instanceof Error ? err.message : String(err)}\n` +
            `  override timeout via env CLAUDE_WT_PANE_TIMEOUT_MS`,
        )
      }

      pane.pid = pid
      pane.status = 'ready'
      resolveSpawn()
    } catch (err) {
      pane.status = 'dead'
      pane.pid = undefined
      rejectSpawn(err)
      throw err
    } finally {
      pane.spawnPromise = undefined
    }
  }

  async setPaneBorderColor(
    _paneId: PaneId,
    _color: AgentColorName,
    _useExternalSession?: boolean,
  ): Promise<void> {
    // Windows Terminal 不通过 wt.exe 暴露每个 pane 的边框颜色。
  }

  async setPaneTitle(
    _paneId: PaneId,
    _name: string,
    _color: AgentColorName,
    _useExternalSession?: boolean,
  ): Promise<void> {
    // 标题在 sendCommandToPane 启动时传递。
  }

  async enablePaneBorderStatus(
    _windowTarget?: string,
    _useExternalSession?: boolean,
  ): Promise<void> {
    // Windows Terminal 的 wt.exe 接口不支持此功能。
  }

  async rebalancePanes(
    _windowTarget: string,
    _hasLeader: boolean,
  ): Promise<void> {
    // Windows Terminal 自行处理分割布局。
  }

  async killPane(
    paneId: PaneId,
    _useExternalSession?: boolean,
  ): Promise<boolean> {
    const pane = this.panes.get(paneId)
    if (!pane) {
      return false
    }

    // 1. 解 kill-while-spawn race：await spawn 完成（不论成功失败）
    if (pane.status === 'spawning' && pane.spawnPromise) {
      await pane.spawnPromise.catch(() => {})
    }

    // 2. TOCTOU 修正：重读 status/pid
    if (pane.status === 'dead') {
      this.panes.delete(paneId)
      return false
    }
    if (pane.status !== 'ready') {
      // 还在其它非终态（理论不可达，保险）
      return false
    }

    pane.status = 'killing'

    // 3. 优先用缓存 pid
    let pid: number | undefined = pane.pid

    // 4. fallback：缓存没有则读盘（保留 retry 3×500ms）
    if (pid === undefined) {
      let pidContent: string | null = null
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          pidContent = (await readFile(pane.pidFile, 'utf-8')).trim()
          break
        } catch {
          if (attempt === 2) {
            pane.status = 'dead'
            this.panes.delete(paneId)
            return false
          }
          await new Promise(r => setTimeout(r, 500))
        }
      }
      if (!pidContent || !/^\d+$/.test(pidContent)) {
        pane.status = 'dead'
        this.panes.delete(paneId)
        return false
      }
      const parsed = Number.parseInt(pidContent, 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        pane.status = 'dead'
        this.panes.delete(paneId)
        return false
      }
      pid = parsed
    }

    // 5. 执行 Stop-Process
    const result = await this.runCommand('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-Command',
      `Stop-Process -Id ${pid} -Force -ErrorAction Stop`,
    ])

    // 6. 不管成功失败都清缓存 + 标 dead + 从 map 删（防 PID 复用误杀）
    pane.pid = undefined
    pane.status = 'dead'
    this.panes.delete(paneId)

    logForDebugging(
      `[WindowsTerminalBackend] killPane ${paneId} pid=${pid} code=${result.code}`,
    )
    return result.code === 0
  }

  async hidePane(
    _paneId: PaneId,
    _useExternalSession?: boolean,
  ): Promise<boolean> {
    return false
  }

  async showPane(
    _paneId: PaneId,
    _targetWindowOrPane: string,
    _useExternalSession?: boolean,
  ): Promise<boolean> {
    return false
  }
}

// 在导入此模块时向 registry 注册 backend。
// 这个副作用是有意为之 — registry 需要 backend 自注册。
// eslint-disable-next-line custom-rules/no-top-level-side-effects
registerWindowsTerminalBackend(WindowsTerminalBackend)
