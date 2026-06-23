import type { ToolUseContext } from '../../../Tool.js'
import {
  findTeammateTaskByAgentId,
  requestTeammateShutdown,
} from '../../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { parseAgentId } from '../../../utils/agentId.js'
import { logForDebugging } from '../../../utils/debug.js'
import { jsonStringify } from '../../../utils/slowOperations.js'
import {
  createShutdownRequestMessage,
  writeToMailbox,
} from '../../../utils/teammateMailbox.js'
import { startInProcessTeammate } from '../inProcessRunner.js'
import {
  killInProcessTeammate,
  spawnInProcessTeammate,
} from '../spawnInProcess.js'
import type {
  TeammateExecutor,
  TeammateMessage,
  TeammateSpawnConfig,
  TeammateSpawnResult,
} from './types.js'

/**
 * InProcessBackend 为进程内 teammate 实现 TeammateExecutor。
 *
 * 与基于 pane 的 backend（tmux/iTerm2）不同，进程内 teammate 在
 * 同一 Node.js 进程中运行，通过 AsyncLocalStorage 实现上下文隔离。它们：
 * - 与 leader 共享资源（API 客户端、MCP 连接）
 * - 通过基于文件的 mailbox 通信（与基于 pane 的 teammate 相同）
 * - 通过 AbortController 终止（而非 kill-pane）
 *
 * 重要：在生成之前，调用 setContext() 提供 AppState 访问所需的
 * ToolUseContext。这旨在通过 TeammateExecutor 抽象使用
 * （registry.ts 中的 getTeammateExecutor()）。
 */
export class InProcessBackend implements TeammateExecutor {
  readonly type = 'in-process' as const

  /**
   * 用于 AppState 访问的工具使用上下文。
   * 必须在调用 spawn() 之前通过 setContext() 设置。
   */
  private context: ToolUseContext | null = null

  /**
   * 设置此 backend 的 ToolUseContext。
   * 由 TeammateTool 在生成之前调用，以提供 AppState 访问。
   */
  setContext(context: ToolUseContext): void {
    this.context = context
  }

  /**
   * 进程内 backend 始终可用（无外部依赖）。
   */
  async isAvailable(): Promise<boolean> {
    return true
  }

  /**
   * 生成进程内 teammate。
   *
   * 使用 spawnInProcessTeammate() 来：
   * 1. 通过 createTeammateContext() 创建 TeammateContext
   * 2. 创建独立的 AbortController（不与父级关联）
   * 3. 在 AppState.tasks 中注册 teammate
   * 4. 通过 startInProcessTeammate() 启动 agent 执行
   * 5. 返回包含 agentId、taskId、abortController 的生成结果
   */
  async spawn(config: TeammateSpawnConfig): Promise<TeammateSpawnResult> {
    if (!this.context) {
      logForDebugging(
        `[InProcessBackend] spawn() called without context for ${config.name}`,
      )
      return {
        success: false,
        agentId: `${config.name}@${config.teamName}`,
        error:
          'InProcessBackend not initialized. Call setContext() before spawn().',
      }
    }

    logForDebugging(`[InProcessBackend] spawn() called for ${config.name}`)

    const result = await spawnInProcessTeammate(
      {
        name: config.name,
        teamName: config.teamName,
        prompt: config.prompt,
        color: config.color,
        planModeRequired: config.planModeRequired ?? false,
        model: config.model,
      },
      this.context,
    )

    // 如果生成成功，启动 agent 执行循环
    if (
      result.success &&
      result.taskId &&
      result.teammateContext &&
      result.abortController
    ) {
      // 在后台启动 agent 循环（即发即忘）
      // prompt 通过 task state 和 config 传递
      startInProcessTeammate({
        identity: {
          agentId: result.agentId,
          agentName: config.name,
          teamName: config.teamName,
          color: config.color,
          planModeRequired: config.planModeRequired ?? false,
          parentSessionId: result.teammateContext.parentSessionId,
        },
        taskId: result.taskId,
        prompt: config.prompt,
        description: config.description,
        agentDefinition: config.agentDefinition,
        teammateContext: result.teammateContext,
        // 剥离 messages：teammate 从不读取 toolUseContext.messages
        // （runAgent 通过 createSubagentContext 覆盖它）。传递父级的
        // 对话会在 teammate 的整个生命周期内固定它。
        toolUseContext: { ...this.context, messages: [] },
        abortController: result.abortController,
        model: config.model,
        systemPrompt: config.systemPrompt,
        systemPromptMode: config.systemPromptMode,
        allowedTools: config.permissions,
        allowPermissionPrompts: config.allowPermissionPrompts,
        invokingRequestId: config.invokingRequestId,
      })

      logForDebugging(
        `[InProcessBackend] Started agent execution for ${result.agentId}`,
      )
    }

    return {
      success: result.success,
      agentId: result.agentId,
      taskId: result.taskId,
      abortController: result.abortController,
      backendType: this.type,
      color: config.color,
      error: result.error,
    }
  }

  /**
   * 向进程内 teammate 发送消息。
   *
   * 所有 teammate 都使用基于文件的 mailbox，以简化实现。
   */
  async sendMessage(agentId: string, message: TeammateMessage): Promise<void> {
    logForDebugging(
      `[InProcessBackend] sendMessage() to ${agentId}: ${message.text.substring(0, 50)}...`,
    )

    // 解析 agentId 以获取 agentName 和 teamName
    // agentId 格式："agentName@teamName"（例如 "researcher@my-team"）
    const parsed = parseAgentId(agentId)
    if (!parsed) {
      logForDebugging(`[InProcessBackend] Invalid agentId format: ${agentId}`)
      throw new Error(
        `Invalid agentId format: ${agentId}. Expected format: agentName@teamName`,
      )
    }

    const { agentName, teamName } = parsed

    // 写入基于文件的 mailbox
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

    logForDebugging(`[InProcessBackend] sendMessage() completed for ${agentId}`)
  }

  /**
   * 优雅地终止进程内 teammate。
   *
   * 向 teammate 发送关闭请求消息并设置
   * shutdownRequested 标志。teammate 处理该请求并
   * 批准（退出）或拒绝（继续工作）。
   *
   * 与基于 pane 的 teammate 不同，进程内 teammate 通过
   * 关闭流程自行处理退出——不需要外部 killPane()。
   */
  async terminate(agentId: string, reason?: string): Promise<boolean> {
    logForDebugging(
      `[InProcessBackend] terminate() called for ${agentId}: ${reason}`,
    )

    if (!this.context) {
      logForDebugging(
        `[InProcessBackend] terminate() failed: no context set for ${agentId}`,
      )
      return false
    }

    // 获取当前 AppState 以查找 task
    const state = this.context.getAppState()
    const task = findTeammateTaskByAgentId(agentId, state.tasks)

    if (!task) {
      logForDebugging(
        `[InProcessBackend] terminate() failed: task not found for ${agentId}`,
      )
      return false
    }

    // 如果已有待处理的关闭请求，不要再次发送
    if (task.shutdownRequested) {
      logForDebugging(
        `[InProcessBackend] terminate(): shutdown already requested for ${agentId}`,
      )
      return true
    }

    // 生成确定性的 request ID
    const requestId = `shutdown-${agentId}-${Date.now()}`

    // 创建关闭请求消息
    const shutdownRequest = createShutdownRequestMessage({
      requestId,
      from: 'team-lead', // 终止始终由 leader 调用
      reason,
    })

    // 发送到 teammate 的 mailbox
    const teammateAgentName = task.identity.agentName
    await writeToMailbox(
      teammateAgentName,
      {
        from: 'team-lead',
        text: jsonStringify(shutdownRequest),
        timestamp: new Date().toISOString(),
      },
      task.identity.teamName,
    )

    // 将 task 标记为已请求关闭
    requestTeammateShutdown(task.id, this.context.setAppState)

    logForDebugging(
      `[InProcessBackend] terminate() sent shutdown request to ${agentId}`,
    )

    return true
  }

  /**
   * 立即强制终止进程内 teammate。
   *
   * 使用 teammate 的 AbortController 取消所有异步操作
   * 并将 task 状态更新为 'killed'。
   */
  async kill(agentId: string): Promise<boolean> {
    logForDebugging(`[InProcessBackend] kill() called for ${agentId}`)

    if (!this.context) {
      logForDebugging(
        `[InProcessBackend] kill() failed: no context set for ${agentId}`,
      )
      return false
    }

    // 获取当前 AppState 以查找 task
    const state = this.context.getAppState()
    const task = findTeammateTaskByAgentId(agentId, state.tasks)

    if (!task) {
      logForDebugging(
        `[InProcessBackend] kill() failed: task not found for ${agentId}`,
      )
      return false
    }

    // 通过现有辅助函数终止 teammate
    const killed = killInProcessTeammate(task.id, this.context.setAppState)

    logForDebugging(
      `[InProcessBackend] kill() ${killed ? 'succeeded' : 'failed'} for ${agentId}`,
    )

    return killed
  }

  /**
   * 检查进程内 teammate 是否仍然活跃。
   *
   * 如果 teammate 存在、状态为 'running'
   * 且 AbortController 尚未被中止，则返回 true。
   */
  async isActive(agentId: string): Promise<boolean> {
    logForDebugging(`[InProcessBackend] isActive() called for ${agentId}`)

    if (!this.context) {
      logForDebugging(
        `[InProcessBackend] isActive() failed: no context set for ${agentId}`,
      )
      return false
    }

    // 获取当前 AppState 以查找 task
    const state = this.context.getAppState()
    const task = findTeammateTaskByAgentId(agentId, state.tasks)

    if (!task) {
      logForDebugging(
        `[InProcessBackend] isActive(): task not found for ${agentId}`,
      )
      return false
    }

    // 检查 task 是否正在运行且未被中止
    const isRunning = task.status === 'running'
    const isAborted = task.abortController?.signal.aborted ?? true

    const active = isRunning && !isAborted

    logForDebugging(
      `[InProcessBackend] isActive() for ${agentId}: ${active} (running=${isRunning}, aborted=${isAborted})`,
    )

    return active
  }
}

/**
 * 创建 InProcessBackend 实例的工厂函数。
 * 由 registry（Task #8）使用以获取 backend 实例。
 */
export function createInProcessBackend(): InProcessBackend {
  return new InProcessBackend()
}
