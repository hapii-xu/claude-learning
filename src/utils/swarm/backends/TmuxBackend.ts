import type { AgentColorName } from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js'
import { logForDebugging } from '../../../utils/debug.js'
import { execFileNoThrow } from '../../../utils/execFileNoThrow.js'
import { logError } from '../../../utils/log.js'
import { count } from '../../array.js'
import { sleep } from '../../sleep.js'
import {
  getSwarmSocketName,
  HIDDEN_SESSION_NAME,
  SWARM_SESSION_NAME,
  SWARM_VIEW_WINDOW_NAME,
  TMUX_COMMAND,
} from '../constants.js'
import {
  getLeaderPaneId,
  isInsideTmux as isInsideTmuxFromDetection,
  isTmuxAvailable,
} from './detection.js'
import { registerTmuxBackend } from './registry.js'
import type { CreatePaneResult, PaneBackend, PaneId } from './types.js'

// 追踪第一个 pane 是否已用于外部 swarm 会话
let firstPaneUsedForExternal = false

// 缓存的 leader 窗口目标（session:window 格式），避免重复查询
let cachedLeaderWindowTarget: string | null = null

// 锁机制，防止并行生成 teammate 时的竞态条件
let paneCreationLock: Promise<void> = Promise.resolve()

// pane 创建后延迟等待 shell 初始化（加载 rc 文件、提示符等）
// 200ms 对大多数 shell 配置足够，包括较慢的 starship/oh-my-zsh
const PANE_SHELL_INIT_DELAY_MS = 200

function waitForPaneShellReady(): Promise<void> {
  return sleep(PANE_SHELL_INIT_DELAY_MS)
}

/**
 * 获取 pane 创建的锁，确保顺序执行。
 * 返回一个释放函数，完成后必须调用。
 */
function acquirePaneCreationLock(): Promise<() => void> {
  let release: () => void
  const newLock = new Promise<void>(resolve => {
    release = resolve
  })

  const previousLock = paneCreationLock
  paneCreationLock = newLock

  return previousLock.then(() => release!)
}

/**
 * 获取给定 agent 颜色对应的 tmux 颜色名称。
 * 这些是 tmux 内置的颜色名称，可用于 pane-border-style。
 */
function getTmuxColorName(color: AgentColorName): string {
  const tmuxColors: Record<AgentColorName, string> = {
    red: 'red',
    blue: 'blue',
    green: 'green',
    yellow: 'yellow',
    purple: 'magenta',
    orange: 'colour208',
    pink: 'colour205',
    cyan: 'cyan',
  }
  return tmuxColors[color]
}

/**
 * 在用户的原始 tmux 会话中运行 tmux 命令（不覆盖 socket）。
 * 用于与用户的 tmux pane 交互的操作（与 leader 一起分割 pane）。
 */
function runTmuxInUserSession(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return execFileNoThrow(TMUX_COMMAND, args)
}

/**
 * 在外部 swarm socket 中运行 tmux 命令。
 * 用于独立 swarm 会话中的操作（当用户不在 tmux 中时）。
 */
function runTmuxInSwarm(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return execFileNoThrow(TMUX_COMMAND, ['-L', getSwarmSocketName(), ...args])
}

/**
 * TmuxBackend 使用 tmux 实现 PaneBackend 的 pane 管理。
 *
 * 在 tmux 内运行时（leader 在 tmux 中）：
 * - 分割当前窗口，将 teammate 添加到 leader 旁边
 * - Leader 保持在左侧（30%），teammate 在右侧（70%）
 *
 * 在 tmux 外运行时（leader 在普通终端中）：
 * - 创建 claude-swarm 会话和 swarm-view 窗口
 * - 所有 teammate 均等分布（无 leader pane）
 */
export class TmuxBackend implements PaneBackend {
  readonly type = 'tmux' as const
  readonly displayName = 'tmux'
  readonly supportsHideShow = true

  /**
   * 检查 tmux 是否已安装并可用。
   * 委托给 detection.ts 以保持一致的检测逻辑。
   */
  async isAvailable(): Promise<boolean> {
    return isTmuxAvailable()
  }

  /**
   * 检查当前是否在 tmux 会话内运行。
   * 委托给 detection.ts 以保持一致的检测逻辑。
   */
  async isRunningInside(): Promise<boolean> {
    return isInsideTmuxFromDetection()
  }

  /**
   * 在 swarm 视图中创建新的 teammate pane。
   * 使用锁防止并行生成多个 teammate 时的竞态条件。
   */
  async createTeammatePaneInSwarmView(
    name: string,
    color: AgentColorName,
  ): Promise<CreatePaneResult> {
    const releaseLock = await acquirePaneCreationLock()

    try {
      const insideTmux = await this.isRunningInside()

      if (insideTmux) {
        return await this.createTeammatePaneWithLeader(name, color)
      }

      return await this.createTeammatePaneExternal(name, color)
    } finally {
      releaseLock()
    }
  }

  /**
   * 在 swarm 会话中为 teammate 创建独立的 tmux 窗口。
   * 由旧版 `use_splitpane: false` 路径使用。
   */
  async createTeammateWindowInSwarmView(
    name: string,
    color: AgentColorName,
  ): Promise<CreatePaneResult & { windowName: string }> {
    const windowName = `teammate-${name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`
    const { windowTarget } = await this.createExternalSwarmSession()
    void windowTarget

    const result = await runTmuxInSwarm([
      'new-window',
      '-t',
      SWARM_SESSION_NAME,
      '-n',
      windowName,
      '-P',
      '-F',
      '#{pane_id}',
    ])

    if (result.code !== 0) {
      throw new Error(
        `Failed to create tmux window: ${result.stderr || 'Unknown error'}`,
      )
    }

    const paneId = result.stdout.trim()
    await this.setPaneTitle(paneId, name, color, true)
    await this.setPaneBorderColor(paneId, color, true)

    return { paneId, isFirstTeammate: false, windowName }
  }

  /**
   * 向指定 pane 发送命令。
   */
  async sendCommandToPane(
    paneId: PaneId,
    command: string,
    useExternalSession = false,
  ): Promise<void> {
    const runTmux = useExternalSession ? runTmuxInSwarm : runTmuxInUserSession
    const result = await runTmux(['send-keys', '-t', paneId, command, 'Enter'])

    if (result.code !== 0) {
      throw new Error(
        `Failed to send command to pane ${paneId}: ${result.stderr}`,
      )
    }
  }

  /**
   * 设置指定 pane 的边框颜色。
   */
  async setPaneBorderColor(
    paneId: PaneId,
    color: AgentColorName,
    useExternalSession = false,
  ): Promise<void> {
    const tmuxColor = getTmuxColorName(color)
    const runTmux = useExternalSession ? runTmuxInSwarm : runTmuxInUserSession

    // 使用 pane 选项设置 pane 特定的边框样式（需要 tmux 3.2+）
    await runTmux([
      'select-pane',
      '-t',
      paneId,
      '-P',
      `bg=default,fg=${tmuxColor}`,
    ])

    await runTmux([
      'set-option',
      '-p',
      '-t',
      paneId,
      'pane-border-style',
      `fg=${tmuxColor}`,
    ])

    await runTmux([
      'set-option',
      '-p',
      '-t',
      paneId,
      'pane-active-border-style',
      `fg=${tmuxColor}`,
    ])
  }

  /**
   * 设置 pane 的标题（如果设置了 pane-border-status 则显示在 pane 边框中）。
   */
  async setPaneTitle(
    paneId: PaneId,
    name: string,
    color: AgentColorName,
    useExternalSession = false,
  ): Promise<void> {
    const tmuxColor = getTmuxColorName(color)
    const runTmux = useExternalSession ? runTmuxInSwarm : runTmuxInUserSession

    // 设置 pane 标题
    await runTmux(['select-pane', '-t', paneId, '-T', name])

    // 启用带彩色格式的 pane 边框状态
    await runTmux([
      'set-option',
      '-p',
      '-t',
      paneId,
      'pane-border-format',
      `#[fg=${tmuxColor},bold] #{pane_title} #[default]`,
    ])
  }

  /**
   * 启用窗口的 pane 边框状态（显示 pane 标题）。
   */
  async enablePaneBorderStatus(
    windowTarget?: string,
    useExternalSession = false,
  ): Promise<void> {
    const target = windowTarget || (await this.getCurrentWindowTarget())
    if (!target) {
      return
    }

    const runTmux = useExternalSession ? runTmuxInSwarm : runTmuxInUserSession
    await runTmux([
      'set-option',
      '-w',
      '-t',
      target,
      'pane-border-status',
      'top',
    ])
  }

  /**
   * 重新平衡 pane 以达到期望的布局。
   */
  async rebalancePanes(
    windowTarget: string,
    hasLeader: boolean,
  ): Promise<void> {
    if (hasLeader) {
      await this.rebalancePanesWithLeader(windowTarget)
    } else {
      await this.rebalancePanesTiled(windowTarget)
    }
  }

  /**
   * 终止/关闭指定 pane。
   */
  async killPane(paneId: PaneId, useExternalSession = false): Promise<boolean> {
    const runTmux = useExternalSession ? runTmuxInSwarm : runTmuxInUserSession
    const result = await runTmux(['kill-pane', '-t', paneId])
    return result.code === 0
  }

  /**
   * 通过将 pane 移动到分离的隐藏会话来隐藏 pane。
   * 如果隐藏会话不存在则创建，然后使用 break-pane 将 pane 移动到那里。
   */
  async hidePane(paneId: PaneId, useExternalSession = false): Promise<boolean> {
    const runTmux = useExternalSession ? runTmuxInSwarm : runTmuxInUserSession

    // 如果隐藏会话不存在则创建（分离的，不可见）
    await runTmux(['new-session', '-d', '-s', HIDDEN_SESSION_NAME])

    // 将 pane 移动到隐藏会话
    const result = await runTmux([
      'break-pane',
      '-d',
      '-s',
      paneId,
      '-t',
      `${HIDDEN_SESSION_NAME}:`,
    ])

    if (result.code === 0) {
      logForDebugging(`[TmuxBackend] Hidden pane ${paneId}`)
    } else {
      logForDebugging(
        `[TmuxBackend] Failed to hide pane ${paneId}: ${result.stderr}`,
      )
    }

    return result.code === 0
  }

  /**
   * 通过将之前隐藏的 pane 重新加入目标窗口来显示它。
   * 使用 `tmux join-pane` 将 pane 移回，然后重新应用 main-vertical 布局，
   * leader 占 30%。
   */
  async showPane(
    paneId: PaneId,
    targetWindowOrPane: string,
    useExternalSession = false,
  ): Promise<boolean> {
    const runTmux = useExternalSession ? runTmuxInSwarm : runTmuxInUserSession

    // join-pane -s：要移动的源 pane
    // -t：要加入的目标窗口/pane
    // -h：水平加入（并排）
    const result = await runTmux([
      'join-pane',
      '-h',
      '-s',
      paneId,
      '-t',
      targetWindowOrPane,
    ])

    if (result.code !== 0) {
      logForDebugging(
        `[TmuxBackend] Failed to show pane ${paneId}: ${result.stderr}`,
      )
      return false
    }

    logForDebugging(
      `[TmuxBackend] Showed pane ${paneId} in ${targetWindowOrPane}`,
    )

    // 重新应用 main-vertical 布局，leader 占 30%
    await runTmux(['select-layout', '-t', targetWindowOrPane, 'main-vertical'])

    // 获取第一个 pane（leader）并调整大小为 30%
    const panesResult = await runTmux([
      'list-panes',
      '-t',
      targetWindowOrPane,
      '-F',
      '#{pane_id}',
    ])

    const panes = panesResult.stdout.trim().split('\n').filter(Boolean)
    if (panes[0]) {
      await runTmux(['resize-pane', '-t', panes[0], '-x', '30%'])
    }

    return true
  }

  // 私有辅助方法

  /**
   * 获取 leader 的 pane ID。
   * 使用模块加载时捕获的 TMUX_PANE 环境变量，确保始终
   * 获取 leader 的原始 pane，即使用户已切换 pane。
   */
  private async getCurrentPaneId(): Promise<string | null> {
    // 使用启动时捕获的 pane ID（来自 TMUX_PANE 环境变量）
    const leaderPane = getLeaderPaneId()
    if (leaderPane) {
      return leaderPane
    }

    // 回退到动态查询（如果在 tmux 内则不应发生）
    const result = await execFileNoThrow(TMUX_COMMAND, [
      'display-message',
      '-p',
      '#{pane_id}',
    ])

    if (result.code !== 0) {
      logForDebugging(
        `[TmuxBackend] Failed to get current pane ID (exit ${result.code}): ${result.stderr}`,
      )
      return null
    }

    return result.stdout.trim()
  }

  /**
   * 获取 leader 的窗口目标（session:window 格式）。
   * 使用 leader 的 pane ID 查询其所在窗口，确保获取正确的窗口，
   * 即使用户已切换到其他窗口。
   * 缓存结果，因为 leader 的窗口不会改变。
   */
  private async getCurrentWindowTarget(): Promise<string | null> {
    // 如果有缓存值则返回
    if (cachedLeaderWindowTarget) {
      return cachedLeaderWindowTarget
    }

    // 构建命令 - 使用 -t 专门针对 leader 的 pane
    const leaderPane = getLeaderPaneId()
    const args = ['display-message']
    if (leaderPane) {
      args.push('-t', leaderPane)
    }
    args.push('-p', '#{session_name}:#{window_index}')

    const result = await execFileNoThrow(TMUX_COMMAND, args)

    if (result.code !== 0) {
      logForDebugging(
        `[TmuxBackend] Failed to get current window target (exit ${result.code}): ${result.stderr}`,
      )
      return null
    }

    cachedLeaderWindowTarget = result.stdout.trim()
    return cachedLeaderWindowTarget
  }

  /**
   * 获取窗口中的 pane 数量。
   */
  private async getCurrentWindowPaneCount(
    windowTarget?: string,
    useSwarmSocket = false,
  ): Promise<number | null> {
    const target = windowTarget || (await this.getCurrentWindowTarget())
    if (!target) {
      return null
    }

    const args = ['list-panes', '-t', target, '-F', '#{pane_id}']
    const result = useSwarmSocket
      ? await runTmuxInSwarm(args)
      : await runTmuxInUserSession(args)

    if (result.code !== 0) {
      logError(
        new Error(
          `[TmuxBackend] Failed to get pane count for ${target} (exit ${result.code}): ${result.stderr}`,
        ),
      )
      return null
    }

    return count(result.stdout.trim().split('\n'), Boolean)
  }

  /**
   * 检查 swarm socket 中是否存在指定的 tmux 会话。
   */
  private async hasSessionInSwarm(sessionName: string): Promise<boolean> {
    const result = await runTmuxInSwarm(['has-session', '-t', sessionName])
    return result.code === 0
  }

  /**
   * 在 tmux 外运行时，创建带有单个 teammate 窗口的 swarm 会话。
   */
  private async createExternalSwarmSession(): Promise<{
    windowTarget: string
    paneId: string
  }> {
    const sessionExists = await this.hasSessionInSwarm(SWARM_SESSION_NAME)

    if (!sessionExists) {
      const result = await runTmuxInSwarm([
        'new-session',
        '-d',
        '-s',
        SWARM_SESSION_NAME,
        '-n',
        SWARM_VIEW_WINDOW_NAME,
        '-P',
        '-F',
        '#{pane_id}',
      ])

      if (result.code !== 0) {
        throw new Error(
          `Failed to create swarm session: ${result.stderr || 'Unknown error'}`,
        )
      }

      const paneId = result.stdout.trim()
      const windowTarget = `${SWARM_SESSION_NAME}:${SWARM_VIEW_WINDOW_NAME}`

      logForDebugging(
        `[TmuxBackend] Created external swarm session with window ${windowTarget}, pane ${paneId}`,
      )

      return { windowTarget, paneId }
    }

    // 会话已存在，检查 swarm-view 窗口是否存在
    const listResult = await runTmuxInSwarm([
      'list-windows',
      '-t',
      SWARM_SESSION_NAME,
      '-F',
      '#{window_name}',
    ])

    const windows = listResult.stdout.trim().split('\n').filter(Boolean)
    const windowTarget = `${SWARM_SESSION_NAME}:${SWARM_VIEW_WINDOW_NAME}`

    if (windows.includes(SWARM_VIEW_WINDOW_NAME)) {
      const paneResult = await runTmuxInSwarm([
        'list-panes',
        '-t',
        windowTarget,
        '-F',
        '#{pane_id}',
      ])

      const panes = paneResult.stdout.trim().split('\n').filter(Boolean)
      return { windowTarget, paneId: panes[0] || '' }
    }

    // 创建 swarm-view 窗口
    const createResult = await runTmuxInSwarm([
      'new-window',
      '-t',
      SWARM_SESSION_NAME,
      '-n',
      SWARM_VIEW_WINDOW_NAME,
      '-P',
      '-F',
      '#{pane_id}',
    ])

    if (createResult.code !== 0) {
      throw new Error(
        `Failed to create swarm-view window: ${createResult.stderr || 'Unknown error'}`,
      )
    }

    return { windowTarget, paneId: createResult.stdout.trim() }
  }

  /**
   * 在 tmux 内运行时创建 teammate pane（有 leader）。
   */
  private async createTeammatePaneWithLeader(
    teammateName: string,
    teammateColor: AgentColorName,
  ): Promise<CreatePaneResult> {
    const currentPaneId = await this.getCurrentPaneId()
    const windowTarget = await this.getCurrentWindowTarget()

    if (!currentPaneId || !windowTarget) {
      throw new Error('Could not determine current tmux pane/window')
    }

    const paneCount = await this.getCurrentWindowPaneCount(windowTarget)
    if (paneCount === null) {
      throw new Error('Could not determine pane count for current window')
    }
    const isFirstTeammate = paneCount === 1

    let splitResult
    if (isFirstTeammate) {
      // 第一个 teammate：从 leader pane 水平分割
      splitResult = await execFileNoThrow(TMUX_COMMAND, [
        'split-window',
        '-t',
        currentPaneId,
        '-h',
        '-l',
        '70%',
        '-P',
        '-F',
        '#{pane_id}',
      ])
    } else {
      // 后续 teammate：从已有 teammate pane 分割
      const listResult = await execFileNoThrow(TMUX_COMMAND, [
        'list-panes',
        '-t',
        windowTarget,
        '-F',
        '#{pane_id}',
      ])

      const panes = listResult.stdout.trim().split('\n').filter(Boolean)
      const teammatePanes = panes.slice(1)
      const teammateCount = teammatePanes.length

      const splitVertically = teammateCount % 2 === 1
      const targetPaneIndex = Math.floor((teammateCount - 1) / 2)
      const targetPane =
        teammatePanes[targetPaneIndex] ||
        teammatePanes[teammatePanes.length - 1]

      splitResult = await execFileNoThrow(TMUX_COMMAND, [
        'split-window',
        '-t',
        targetPane!,
        splitVertically ? '-v' : '-h',
        '-P',
        '-F',
        '#{pane_id}',
      ])
    }

    if (splitResult.code !== 0) {
      throw new Error(`Failed to create teammate pane: ${splitResult.stderr}`)
    }

    const paneId = splitResult.stdout.trim()
    logForDebugging(
      `[TmuxBackend] Created teammate pane for ${teammateName}: ${paneId}`,
    )

    await this.setPaneBorderColor(paneId, teammateColor)
    await this.setPaneTitle(paneId, teammateName, teammateColor)
    await this.rebalancePanesWithLeader(windowTarget)

    // 等待 shell 初始化完成后再返回，以便可以立即发送命令
    await waitForPaneShellReady()

    return { paneId, isFirstTeammate }
  }

  /**
   * 在 tmux 外运行时创建 teammate pane（tmux 中无 leader）。
   */
  private async createTeammatePaneExternal(
    teammateName: string,
    teammateColor: AgentColorName,
  ): Promise<CreatePaneResult> {
    const { windowTarget, paneId: firstPaneId } =
      await this.createExternalSwarmSession()

    const paneCount = await this.getCurrentWindowPaneCount(windowTarget, true)
    if (paneCount === null) {
      throw new Error('Could not determine pane count for swarm window')
    }
    const isFirstTeammate = !firstPaneUsedForExternal && paneCount === 1

    let paneId: string

    if (isFirstTeammate) {
      paneId = firstPaneId
      firstPaneUsedForExternal = true
      logForDebugging(
        `[TmuxBackend] Using initial pane for first teammate ${teammateName}: ${paneId}`,
      )

      await this.enablePaneBorderStatus(windowTarget, true)
    } else {
      const listResult = await runTmuxInSwarm([
        'list-panes',
        '-t',
        windowTarget,
        '-F',
        '#{pane_id}',
      ])

      const panes = listResult.stdout.trim().split('\n').filter(Boolean)
      const teammateCount = panes.length

      const splitVertically = teammateCount % 2 === 1
      const targetPaneIndex = Math.floor((teammateCount - 1) / 2)
      const targetPane = panes[targetPaneIndex] || panes[panes.length - 1]

      const splitResult = await runTmuxInSwarm([
        'split-window',
        '-t',
        targetPane!,
        splitVertically ? '-v' : '-h',
        '-P',
        '-F',
        '#{pane_id}',
      ])

      if (splitResult.code !== 0) {
        throw new Error(`Failed to create teammate pane: ${splitResult.stderr}`)
      }

      paneId = splitResult.stdout.trim()
      logForDebugging(
        `[TmuxBackend] Created teammate pane for ${teammateName}: ${paneId}`,
      )
    }

    await this.setPaneBorderColor(paneId, teammateColor, true)
    await this.setPaneTitle(paneId, teammateName, teammateColor, true)
    await this.rebalancePanesTiled(windowTarget)

    // 等待 shell 初始化完成后再返回，以便可以立即发送命令
    await waitForPaneShellReady()

    return { paneId, isFirstTeammate }
  }

  /**
   * 在有 leader 的窗口中重新平衡 pane。
   */
  private async rebalancePanesWithLeader(windowTarget: string): Promise<void> {
    const listResult = await runTmuxInUserSession([
      'list-panes',
      '-t',
      windowTarget,
      '-F',
      '#{pane_id}',
    ])

    const panes = listResult.stdout.trim().split('\n').filter(Boolean)
    if (panes.length <= 2) {
      return
    }

    await runTmuxInUserSession([
      'select-layout',
      '-t',
      windowTarget,
      'main-vertical',
    ])

    const leaderPane = panes[0]
    await runTmuxInUserSession(['resize-pane', '-t', leaderPane!, '-x', '30%'])

    logForDebugging(
      `[TmuxBackend] Rebalanced ${panes.length - 1} teammate panes with leader`,
    )
  }

  /**
   * 在无 leader 的窗口中重新平衡 pane（平铺布局）。
   */
  private async rebalancePanesTiled(windowTarget: string): Promise<void> {
    const listResult = await runTmuxInSwarm([
      'list-panes',
      '-t',
      windowTarget,
      '-F',
      '#{pane_id}',
    ])

    const panes = listResult.stdout.trim().split('\n').filter(Boolean)
    if (panes.length <= 1) {
      return
    }

    await runTmuxInSwarm(['select-layout', '-t', windowTarget, 'tiled'])

    logForDebugging(
      `[TmuxBackend] Rebalanced ${panes.length} teammate panes with tiled layout`,
    )
  }
}

// 在导入此模块时向 registry 注册 backend。
// 这个副作用是有意为之 — registry 需要 backend 自注册以避免循环依赖。
// eslint-disable-next-line custom-rules/no-top-level-side-effects
registerTmuxBackend(TmuxBackend)
