import type { AgentColorName } from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js'
import { logForDebugging } from '../../../utils/debug.js'
import { execFileNoThrow } from '../../../utils/execFileNoThrow.js'
import { IT2_COMMAND, isInITerm2, isIt2CliAvailable } from './detection.js'
import { registerITermBackend } from './registry.js'
import type { CreatePaneResult, PaneBackend, PaneId } from './types.js'

// 跟踪 teammate 的 session ID
const teammateSessionIds: string[] = []

// 跟踪第一个 pane 是否已被使用
let firstPaneUsed = false

// 锁机制，防止并行生成 teammate 时的竞态条件
let paneCreationLock: Promise<void> = Promise.resolve()

/**
 * 获取 pane 创建的锁，确保顺序执行。
 * 返回一个必须在完成后调用的释放函数。
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
 * 运行 it2 CLI 命令并返回结果。
 */
function runIt2(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return execFileNoThrow(IT2_COMMAND, args)
}

/**
 * 从 `it2 session split` 输出中解析 session ID。
 * 格式："Created new pane: <session-id>"
 *
 * 注意：此 UUID 仅在使用 -s 标志从特定会话分割时有效。
 * 从"活动"会话分割时，如果分割发生在不同窗口中，
 * UUID 可能无法访问。
 */
function parseSplitOutput(output: string): string {
  const match = output.match(/Created new pane:\s*(.+)/)
  if (match && match[1]) {
    return match[1].trim()
  }
  return ''
}

/**
 * 从 ITERM_SESSION_ID 环境变量获取 leader 的 session ID。
 * 格式："wXtYpZ:UUID" —— 我们提取冒号后的 UUID 部分。
 * 如果不在 iTerm2 中或环境变量未设置则返回 null。
 */
function getLeaderSessionId(): string | null {
  const itermSessionId = process.env.ITERM_SESSION_ID
  if (!itermSessionId) {
    return null
  }
  const colonIndex = itermSessionId.indexOf(':')
  if (colonIndex === -1) {
    return null
  }
  return itermSessionId.slice(colonIndex + 1)
}

/**
 * ITermBackend 通过 it2 CLI 工具使用 iTerm2 的原生分割 pane 实现 pane 管理。
 */
export class ITermBackend implements PaneBackend {
  readonly type = 'iterm2' as const
  readonly displayName = 'iTerm2'
  readonly supportsHideShow = false

  /**
   * 检查 iTerm2 backend 是否可用（在 iTerm2 中且已安装 it2 CLI）。
   */
  async isAvailable(): Promise<boolean> {
    const inITerm2 = isInITerm2()
    logForDebugging(`[ITermBackend] isAvailable check: inITerm2=${inITerm2}`)
    if (!inITerm2) {
      logForDebugging('[ITermBackend] isAvailable: false (not in iTerm2)')
      return false
    }
    const it2Available = await isIt2CliAvailable()
    logForDebugging(
      `[ITermBackend] isAvailable: ${it2Available} (it2 CLI ${it2Available ? 'found' : 'not found'})`,
    )
    return it2Available
  }

  /**
   * 检查当前是否在 iTerm2 中运行。
   */
  async isRunningInside(): Promise<boolean> {
    const result = isInITerm2()
    logForDebugging(`[ITermBackend] isRunningInside: ${result}`)
    return result
  }

  /**
   * 在 swarm 视图中创建新的 teammate pane。
   * 使用锁防止并行生成多个 teammate 时的竞态条件。
   */
  async createTeammatePaneInSwarmView(
    name: string,
    color: AgentColorName,
  ): Promise<CreatePaneResult> {
    logForDebugging(
      `[ITermBackend] createTeammatePaneInSwarmView called for ${name} with color ${color}`,
    )
    const releaseLock = await acquirePaneCreationLock()

    try {
      // 布局：leader 在左侧，teammate 在右侧垂直堆叠
      // - 第一个 teammate：从 leader 的会话垂直分割（-v）
      // - 后续 teammate：从上一个 teammate 的会话水平分割
      //
      // 我们使用 -s 标志明确指定要分割的会话，
      // 即使用户点击不同 pane 也能确保正确布局。
      //
      // 故障恢复：如果定向的 teammate 会话已终止
      // （用户通过 Cmd+W / X 关闭了 pane，或进程崩溃），
      // 则清理并重试使用倒数第二个。比每次生成时主动
      // 执行 'it2 session list' 更经济。
      // 迭代次数上限为 O(N+1)：每次 continue 将 teammateSessionIds 减少 1；
      // 清空后 → firstPaneUsed 重置 → 下次迭代无目标 → 抛出异常。
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const isFirstTeammate = !firstPaneUsed
        logForDebugging(
          `[ITermBackend] Creating pane: isFirstTeammate=${isFirstTeammate}, existingPanes=${teammateSessionIds.length}`,
        )

        let splitArgs: string[]
        let targetedTeammateId: string | undefined
        if (isFirstTeammate) {
          // 从 leader 的会话分割（从 ITERM_SESSION_ID 环境变量提取）
          const leaderSessionId = getLeaderSessionId()
          if (leaderSessionId) {
            splitArgs = ['session', 'split', '-v', '-s', leaderSessionId]
            logForDebugging(
              `[ITermBackend] First split from leader session: ${leaderSessionId}`,
            )
          } else {
            // 如果无法获取 leader 的 ID，回退到活动会话
            splitArgs = ['session', 'split', '-v']
            logForDebugging(
              '[ITermBackend] First split from active session (no leader ID)',
            )
          }
        } else {
          // 从上一个 teammate 的会话分割，垂直堆叠
          targetedTeammateId = teammateSessionIds[teammateSessionIds.length - 1]
          if (targetedTeammateId) {
            splitArgs = ['session', 'split', '-s', targetedTeammateId]
            logForDebugging(
              `[ITermBackend] Subsequent split from teammate session: ${targetedTeammateId}`,
            )
          } else {
            // 回退到活动会话
            splitArgs = ['session', 'split']
            logForDebugging(
              '[ITermBackend] Subsequent split from active session (no teammate ID)',
            )
          }
        }

        const splitResult = await runIt2(splitArgs)

        if (splitResult.code !== 0) {
          // 如果定向到 teammate 会话，在清理之前先确认它确实已终止——
          // 'session list' 可以区分已终止的定向目标和系统性故障
          // （Python API 关闭、it2 被移除、瞬时 socket 错误）。
          // 在系统性故障时清理会导致所有活跃 ID 被清除——状态被破坏。
          if (targetedTeammateId) {
            const listResult = await runIt2(['session', 'list'])
            if (
              listResult.code === 0 &&
              !listResult.stdout.includes(targetedTeammateId)
            ) {
              // 确认已终止——清理并使用倒数第二个（或 leader）重试。
              logForDebugging(
                `[ITermBackend] Split failed targeting dead session ${targetedTeammateId}, pruning and retrying: ${splitResult.stderr}`,
              )
              const idx = teammateSessionIds.indexOf(targetedTeammateId)
              if (idx !== -1) {
                teammateSessionIds.splice(idx, 1)
              }
              if (teammateSessionIds.length === 0) {
                firstPaneUsed = false
              }
              continue
            }
            // 目标仍然存活或无法判断——不要破坏状态，直接抛出错误。
          }
          throw new Error(
            `Failed to create iTerm2 split pane: ${splitResult.stderr}`,
          )
        }

        if (isFirstTeammate) {
          firstPaneUsed = true
        }

        // 从分割输出中解析 session ID
        // 这是有效的，因为我们从特定会话分割（-s 标志），
        // 所以新 pane 在同一个窗口中，UUID 有效。
        const paneId = parseSplitOutput(splitResult.stdout)

        if (!paneId) {
          throw new Error(
            `Failed to parse session ID from split output: ${splitResult.stdout}`,
          )
        }
        logForDebugging(
          `[ITermBackend] Created teammate pane for ${name}: ${paneId}`,
        )

        teammateSessionIds.push(paneId)

        // 设置 pane 颜色和标题
        // 暂时跳过颜色和标题——每次 it2 调用都很慢（Python 进程 + API）
        // pane 在没有这些装饰功能的情况下也能正常工作
        // TODO: 考虑批量处理或使其异步/即发即忘

        return { paneId, isFirstTeammate }
      }
    } finally {
      releaseLock()
    }
  }

  /**
   * 向指定 pane 发送命令。
   */
  async sendCommandToPane(
    paneId: PaneId,
    command: string,
    _useExternalSession?: boolean,
  ): Promise<void> {
    // 使用 it2 session run 执行命令（自动添加换行）
    // 始终使用 -s 标志定向到特定会话——这确保命令
    // 发送到正确的 pane，即使用户切换窗口也不受影响
    const args = paneId
      ? ['session', 'run', '-s', paneId, command]
      : ['session', 'run', command]

    const result = await runIt2(args)

    if (result.code !== 0) {
      throw new Error(
        `Failed to send command to iTerm2 pane ${paneId}: ${result.stderr}`,
      )
    }
  }

  /**
   * iTerm2 的无操作——标签颜色需要转义序列，
   * 但我们为了性能而跳过（每次 it2 调用都很慢）。
   */
  async setPaneBorderColor(
    _paneId: PaneId,
    _color: AgentColorName,
    _useExternalSession?: boolean,
  ): Promise<void> {
    // 为了性能而跳过——每次 it2 调用都会生成 Python 进程
  }

  /**
   * iTerm2 的无操作——标题需要转义序列，
   * 但我们为了性能而跳过（每次 it2 调用都很慢）。
   */
  async setPaneTitle(
    _paneId: PaneId,
    _name: string,
    _color: AgentColorName,
    _useExternalSession?: boolean,
  ): Promise<void> {
    // 为了性能而跳过——每次 it2 调用都会生成 Python 进程
  }

  /**
   * iTerm2 的无操作——pane 标题自动在标签中显示。
   */
  async enablePaneBorderStatus(
    _windowTarget?: string,
    _useExternalSession?: boolean,
  ): Promise<void> {
    // iTerm2 没有 tmux 那样的 pane 边框状态概念
    // 标题自动在标签中显示
  }

  /**
   * iTerm2 的无操作——pane 平衡自动处理。
   */
  async rebalancePanes(
    _windowTarget: string,
    _hasLeader: boolean,
  ): Promise<void> {
    // iTerm2 自动处理 pane 平衡
    logForDebugging(
      '[ITermBackend] Pane rebalancing not implemented for iTerm2',
    )
  }

  /**
   * 使用 it2 CLI 关闭/终止指定 pane。
   * 同时从已跟踪的 session ID 中移除该 pane，
   * 避免后续生成尝试从已终止的会话中分割。
   */
  async killPane(
    paneId: PaneId,
    _useExternalSession?: boolean,
  ): Promise<boolean> {
    // -f（强制）是必需的：不使用时，iTerm2 会遵守"关闭前确认"偏好设置，
    // 当会话中仍有运行中的进程时（shell 始终在运行），
    // 会显示对话框或拒绝关闭。tmux kill-pane 没有
    // 这样的提示，这就是为什么只在 iTerm2 中才会出现此问题。
    const result = await runIt2(['session', 'close', '-f', '-s', paneId])
    // 无论关闭结果如何，都清理模块状态——即使 pane 已不存在
    // （例如用户手动关闭），移除过期 ID 也是正确的。
    const idx = teammateSessionIds.indexOf(paneId)
    if (idx !== -1) {
      teammateSessionIds.splice(idx, 1)
    }
    if (teammateSessionIds.length === 0) {
      firstPaneUsed = false
    }
    return result.code === 0
  }

  /**
   * 隐藏 pane 的桩实现——iTerm2 backend 不支持。
   * iTerm2 没有直接等效于 tmux break-pane 的功能。
   */
  async hidePane(
    _paneId: PaneId,
    _useExternalSession?: boolean,
  ): Promise<boolean> {
    logForDebugging('[ITermBackend] hidePane not supported in iTerm2')
    return false
  }

  /**
   * 显示已隐藏 pane 的桩实现——iTerm2 backend 不支持。
   * iTerm2 没有直接等效于 tmux join-pane 的功能。
   */
  async showPane(
    _paneId: PaneId,
    _targetWindowOrPane: string,
    _useExternalSession?: boolean,
  ): Promise<boolean> {
    logForDebugging('[ITermBackend] showPane not supported in iTerm2')
    return false
  }
}

// 在模块导入时向 registry 注册 backend。
// 这个副作用是有意的——registry 需要 backend 自注册以避免循环依赖。
// eslint-disable-next-line custom-rules/no-top-level-side-effects
registerITermBackend(ITermBackend)
