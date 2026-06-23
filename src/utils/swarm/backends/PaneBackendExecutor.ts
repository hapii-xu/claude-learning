import { getSessionId } from '../../../bootstrap/state.js'
import type { ToolUseContext } from '../../../Tool.js'
import { formatAgentId, parseAgentId } from '../../../utils/agentId.js'
import { quote } from '../../../utils/bash/shellQuote.js'
import { isInBundledMode } from '../../../utils/bundledMode.js'
import { registerCleanup } from '../../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../../utils/debug.js'
import { jsonStringify } from '../../../utils/slowOperations.js'
import { writeToMailbox } from '../../../utils/teammateMailbox.js'
import {
  buildInheritedCliArgParts,
  buildInheritedEnvVars,
  getInheritedEnvVarAssignments,
  getTeammateCommand,
} from '../spawnUtils.js'
import { assignTeammateColor } from '../teammateLayoutManager.js'
import { isInsideTmux } from './detection.js'
import type {
  BackendType,
  PaneBackend,
  TeammateExecutor,
  TeammateMessage,
  TeammateSpawnConfig,
  TeammateSpawnResult,
} from './types.js'

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function withoutModelArg(args: string[]): string[] {
  const filtered: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--model') {
      i += 1
      continue
    }
    filtered.push(args[i]!)
  }
  return filtered
}

function buildPowerShellSpawnCommand(
  binaryPath: string,
  args: string[],
  cwd: string,
): string {
  const envAssignments = getInheritedEnvVarAssignments().map(
    ([key, value]) => `$env:${key} = ${quotePowerShellString(value)}`,
  )
  // 在开发模式（非打包）下，binaryPath 是 .ts/.tsx 文件，PowerShell
  // 无法直接执行。前置 `bun run` 使 teammate 进程通过
  // Bun 运行时启动，与 `bun run dev` 的工作方式一致。
  const invocation = isInBundledMode()
    ? `& ${quotePowerShellString(binaryPath)}`
    : `& ${quotePowerShellString(process.execPath)} ${quotePowerShellString(binaryPath)}`
  return [
    `Set-Location -LiteralPath ${quotePowerShellString(cwd)}`,
    ...envAssignments,
    `${invocation} ${args.map(quotePowerShellString).join(' ')}`,
  ].join('; ')
}

/**
 * PaneBackendExecutor 将 PaneBackend 适配为 TeammateExecutor 接口。
 *
 * 这使得基于 pane 的 backend（tmux、iTerm2）可以通过与 InProcessBackend 相同的
 * TeammateExecutor 抽象使用，使 getTeammateExecutor() 无论执行模式如何
 * 都返回一个有意义的执行器。
 *
 * 适配器处理：
 * - spawn()：创建 pane 并向其发送 Claude CLI 命令
 * - sendMessage()：写入 teammate 的基于文件的 mailbox
 * - terminate()：通过 mailbox 发送关闭请求
 * - kill()：通过 backend 终止 pane
 * - isActive()：检查 pane 是否仍在运行
 */
export class PaneBackendExecutor implements TeammateExecutor {
  readonly type: BackendType

  private backend: PaneBackend
  private context: ToolUseContext | null = null

  /**
   * 通过 agentId -> paneId 映射跟踪已生成的 teammate。
   * 这允许我们为 kill/terminate 等操作找到 pane。
   */
  private spawnedTeammates: Map<string, { paneId: string; insideTmux: boolean }>
  private cleanupRegistered = false

  constructor(backend: PaneBackend) {
    this.backend = backend
    this.type = backend.type
    this.spawnedTeammates = new Map()
  }

  /**
   * 设置此执行器的 ToolUseContext。
   * 必须在 spawn() 之前调用，以提供对 AppState 和权限的访问。
   */
  setContext(context: ToolUseContext): void {
    this.context = context
  }

  /**
   * 检查底层 pane backend 是否可用。
   */
  async isAvailable(): Promise<boolean> {
    return this.backend.isAvailable()
  }

  /**
   * 在新 pane 中生成 teammate。
   *
   * 通过 backend 创建 pane，构建带有 teammate
   * 身份标志的 CLI 命令，并发送到 pane。
   */
  async spawn(config: TeammateSpawnConfig): Promise<TeammateSpawnResult> {
    const agentId = formatAgentId(config.name, config.teamName)

    if (!this.context) {
      logForDebugging(
        `[PaneBackendExecutor] spawn() called without context for ${config.name}`,
      )
      return {
        success: false,
        agentId,
        error:
          'PaneBackendExecutor not initialized. Call setContext() before spawn().',
      }
    }

    try {
      // 为此 teammate 分配唯一颜色
      const teammateColor = config.color ?? assignTeammateColor(agentId)

      const paneResult =
        config.useSplitPane === false &&
        this.backend.createTeammateWindowInSwarmView
          ? await this.backend.createTeammateWindowInSwarmView(
              config.name,
              teammateColor,
            )
          : await this.backend.createTeammatePaneInSwarmView(
              config.name,
              teammateColor,
            )
      const { paneId, isFirstTeammate } = paneResult

      // 检查是否在 tmux 内，以确定如何发送命令
      const insideTmux = await isInsideTmux()

      // 在 tmux 内时，第一个 teammate 启用 pane 边框状态
      if (isFirstTeammate && insideTmux) {
        await this.backend.enablePaneBorderStatus()
      }

      // 构建带 teammate 身份的 Claude Code 启动命令
      const binaryPath = getTeammateCommand()

      // 构建 teammate 身份 CLI 参数
      const teammateArgs = [
        '--agent-id',
        agentId,
        '--agent-name',
        config.name,
        '--team-name',
        config.teamName,
        '--agent-color',
        teammateColor,
        '--parent-session-id',
        config.parentSessionId || getSessionId(),
        ...(config.planModeRequired ? ['--plan-mode-required'] : []),
        ...(config.agentType ? ['--agent-type', config.agentType] : []),
      ]

      // 构建要传播给 teammate 的 CLI 标志
      const appState = this.context.getAppState()
      let inheritedArgParts = buildInheritedCliArgParts({
        planModeRequired: config.planModeRequired,
        permissionMode: appState.toolPermissionContext.mode,
      })

      // 如果 teammate 有自定义模型，添加 --model 标志（或替换继承的）
      if (config.model) {
        inheritedArgParts = withoutModelArg(inheritedArgParts)
        inheritedArgParts.push('--model', config.model)
      }

      const workingDir = config.cwd

      // 构建要转发给 teammate 的环境变量
      const envStr = buildInheritedEnvVars()

      const allArgs = [...teammateArgs, ...inheritedArgParts]
      const spawnCommand =
        this.type === 'windows-terminal'
          ? buildPowerShellSpawnCommand(binaryPath, allArgs, workingDir)
          : `cd ${quote([workingDir])} && env ${envStr} ${quote([binaryPath])} ${quote(allArgs)}`

      // 将命令发送到新 pane
      // 在 tmux 外运行时使用 swarm socket（外部 swarm 会话）
      await this.backend.sendCommandToPane(paneId, spawnCommand, !insideTmux)

      // 追踪已生成的 teammate
      this.spawnedTeammates.set(agentId, { paneId, insideTmux })

      // 注册清理函数，在 leader 退出时终止所有 pane（例如 SIGHUP）
      if (!this.cleanupRegistered) {
        this.cleanupRegistered = true
        registerCleanup(async () => {
          for (const [id, info] of this.spawnedTeammates) {
            logForDebugging(
              `[PaneBackendExecutor] Cleanup: killing pane for ${id}`,
            )
            await this.backend.killPane(info.paneId, !info.insideTmux)
          }
          this.spawnedTeammates.clear()
        })
      }

      // 通过 mailbox 向 teammate 发送初始指令
      await writeToMailbox(
        config.name,
        {
          from: 'team-lead',
          text: config.prompt,
          timestamp: new Date().toISOString(),
        },
        config.teamName,
      )

      logForDebugging(
        `[PaneBackendExecutor] Spawned teammate ${agentId} in pane ${paneId}`,
      )

      return {
        success: true,
        agentId,
        paneId,
        backendType: this.type,
        color: teammateColor,
        insideTmux,
        windowName:
          'windowName' in paneResult
            ? (paneResult as { windowName: string }).windowName
            : undefined,
        isSplitPane: config.useSplitPane !== false,
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logForDebugging(
        `[PaneBackendExecutor] Failed to spawn ${agentId}: ${errorMessage}`,
      )
      return {
        success: false,
        agentId,
        error: errorMessage,
      }
    }
  }

  /**
   * 通过基于文件的 mailbox 向 pane teammate 发送消息。
   *
   * 所有 teammate（pane 和 in-process）使用相同的 mailbox 机制。
   */
  async sendMessage(agentId: string, message: TeammateMessage): Promise<void> {
    logForDebugging(
      `[PaneBackendExecutor] sendMessage() to ${agentId}: ${message.text.substring(0, 50)}...`,
    )

    const parsed = parseAgentId(agentId)
    if (!parsed) {
      throw new Error(
        `Invalid agentId format: ${agentId}. Expected format: agentName@teamName`,
      )
    }

    const { agentName, teamName } = parsed

    await writeToMailbox(
      agentName,
      {
        text: message.text,
        from: message.from,
        color: message.color,
        timestamp: message.timestamp ?? new Date().toISOString(),
      },
      teamName,
    )

    logForDebugging(
      `[PaneBackendExecutor] sendMessage() completed for ${agentId}`,
    )
  }

  /**
   * 优雅地终止基于 pane 的 teammate。
   *
   * 对于基于 pane 的 teammate，我们通过 mailbox 发送关闭请求，
   * 让 teammate 进程自行处理优雅退出。
   */
  async terminate(agentId: string, reason?: string): Promise<boolean> {
    logForDebugging(
      `[PaneBackendExecutor] terminate() called for ${agentId}: ${reason}`,
    )

    const parsed = parseAgentId(agentId)
    if (!parsed) {
      logForDebugging(
        `[PaneBackendExecutor] terminate() failed: invalid agentId format`,
      )
      return false
    }

    const { agentName, teamName } = parsed

    // 通过 mailbox 发送关闭请求
    const shutdownRequest = {
      type: 'shutdown_request',
      requestId: `shutdown-${agentId}-${Date.now()}`,
      from: 'team-lead',
      reason,
    }

    await writeToMailbox(
      agentName,
      {
        from: 'team-lead',
        text: jsonStringify(shutdownRequest),
        timestamp: new Date().toISOString(),
      },
      teamName,
    )

    logForDebugging(
      `[PaneBackendExecutor] terminate() sent shutdown request to ${agentId}`,
    )

    return true
  }

  /**
   * 通过终止 pane 来强制杀掉基于 pane 的 teammate。
   */
  async kill(agentId: string): Promise<boolean> {
    logForDebugging(`[PaneBackendExecutor] kill() called for ${agentId}`)

    const teammateInfo = this.spawnedTeammates.get(agentId)
    if (!teammateInfo) {
      logForDebugging(
        `[PaneBackendExecutor] kill() failed: teammate ${agentId} not found in spawned map`,
      )
      return false
    }

    const { paneId, insideTmux } = teammateInfo

    // 通过 backend 终止 pane
    // 当在 tmux 外生成时使用外部会话 socket
    const killed = await this.backend.killPane(paneId, !insideTmux)

    if (killed) {
      this.spawnedTeammates.delete(agentId)
      logForDebugging(`[PaneBackendExecutor] kill() succeeded for ${agentId}`)
    } else {
      logForDebugging(`[PaneBackendExecutor] kill() failed for ${agentId}`)
    }

    return killed
  }

  /**
   * 检查基于 pane 的 teammate 是否仍然活跃。
   *
   * 对于基于 pane 的 teammate，我们检查 pane 是否仍然存在。
   * 这是尽力而为的检查 — pane 可能存在但其中的进程已经退出。
   */
  async isActive(agentId: string): Promise<boolean> {
    logForDebugging(`[PaneBackendExecutor] isActive() called for ${agentId}`)

    const teammateInfo = this.spawnedTeammates.get(agentId)
    if (!teammateInfo) {
      logForDebugging(
        `[PaneBackendExecutor] isActive(): teammate ${agentId} not found`,
      )
      return false
    }

    // 目前，如果有记录则假定活跃
    // 更可靠的检查是查询 backend 以确认 pane 存在，
    // 但那需要为 PaneBackend 添加新方法
    return true
  }
}

/**
 * 创建一个封装给定 PaneBackend 的 PaneBackendExecutor。
 */
export function createPaneBackendExecutor(
  backend: PaneBackend,
): PaneBackendExecutor {
  return new PaneBackendExecutor(backend)
}
