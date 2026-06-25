/**
 * ACP Agent 实现——将 ACP 协议方法桥接到 Claude Code 内部的 QueryEngine / query() 流水线。
 *
 * 架构：使用内部 QueryEngine（而非 @anthropic-ai/claude-agent-sdk）直接运行查询，
 * 通过 bridge 层将 SDKMessage 转换为 ACP SessionUpdate。
 */
import type {
  Agent,
  AgentSideConnection,
  InitializeRequest,
  InitializeResponse,
  AuthenticateRequest,
  AuthenticateResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  CancelNotification,
  LoadSessionRequest,
  LoadSessionResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  ForkSessionRequest,
  ForkSessionResponse,
  CloseSessionRequest,
  CloseSessionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  ClientCapabilities,
  SessionModeState,
  SessionModelState,
  SessionConfigOption,
} from '@agentclientprotocol/sdk'
import { randomUUID, type UUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { Message } from '../../types/message.js'
import { deserializeMessages } from '../../utils/conversationRecovery.js'
import {
  getLastSessionLog,
  sessionIdExists,
} from '../../utils/sessionStorage.js'
import { QueryEngine } from '../../QueryEngine.js'
import type { QueryEngineConfig } from '../../QueryEngine.js'
import type { Tools } from '../../Tool.js'
import { getTools } from '../../tools.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { PermissionMode } from '../../types/permissions.js'
import type { Command } from '../../types/command.js'
import { getCommands } from '../../commands.js'
import { getAgentDefinitionsWithOverrides } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import {
  setOriginalCwd,
  switchSession,
  getSessionProjectDir,
} from '../../bootstrap/state.js'
import type { SessionId } from '../../types/ids.js'
import { enableConfigs } from '../../utils/config.js'
import { FileStateCache } from '../../utils/fileStateCache.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { AppState } from '../../state/AppStateStore.js'
import { createAcpCanUseTool } from './permissions.js'
import {
  forwardSessionUpdates,
  replayHistoryMessages,
  type ToolUseCache,
} from './bridge.js'
import {
  resolvePermissionMode,
  computeSessionFingerprint,
  sanitizeTitle,
} from './utils.js'
import { promptToQueryInput } from './promptConversion.js'
import { listSessionsImpl } from '../../utils/listSessionsImpl.js'
import { resolveSessionFilePath } from '../../utils/sessionStoragePortable.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { getModelOptions } from '../../utils/model/modelOptions.js'
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'

// ── Session 状态 ─────────────────────────────────────────────────

type AcpSession = {
  queryEngine: QueryEngine
  cancelled: boolean
  cancelGeneration: number
  cwd: string
  sessionFingerprint: string
  modes: SessionModeState
  models: SessionModelState
  configOptions: SessionConfigOption[]
  promptRunning: boolean
  pendingMessages: Map<string, PendingPrompt>
  pendingQueue: string[]
  pendingQueueHead: number
  toolUseCache: ToolUseCache
  clientCapabilities?: ClientCapabilities
  appState: AppState
  commands: Command[]
}

type PendingPrompt = {
  resolve: (cancelled: boolean) => void
}

// ── Agent 类 ───────────────────────────────────────────────────

export class AcpAgent implements Agent {
  private conn: AgentSideConnection
  sessions = new Map<string, AcpSession>()
  private clientCapabilities?: ClientCapabilities

  constructor(conn: AgentSideConnection) {
    this.conn = conn
  }

  // ── initialize（初始化）────────────────────────────────────────────

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = params.clientCapabilities

    return {
      protocolVersion: 1,
      agentInfo: {
        name: 'claude-code',
        title: 'Claude Code',
        version:
          typeof (globalThis as unknown as Record<string, unknown>).MACRO ===
            'object' &&
          (globalThis as unknown as Record<string, Record<string, unknown>>)
            .MACRO !== null
            ? String(
                (
                  (
                    globalThis as unknown as Record<
                      string,
                      Record<string, unknown>
                    >
                  ).MACRO as Record<string, unknown>
                ).VERSION ?? '0.0.0',
              )
            : '0.0.0',
      },
      agentCapabilities: {
        _meta: {
          claudeCode: {
            promptQueueing: true,
          },
        },
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
          sse: true,
        },
        loadSession: true,
        sessionCapabilities: {
          fork: {},
          list: {},
          resume: {},
          close: {},
        },
      },
    }
  }

  // ── authenticate（鉴权）──────────────────────────────────────────────

  async authenticate(
    _params: AuthenticateRequest,
  ): Promise<AuthenticateResponse> {
    // 无需鉴权——这是自托管/自定义部署
    return {}
  }

  // ── newSession（新建 session）────────────────────────────────────────────

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const result = await this.createSession(params)
    this.scheduleAvailableCommandsUpdate(result.sessionId)
    return result
  }

  // ── resumeSession（恢复 session）──────────────────────────────────────────

  async unstable_resumeSession(
    params: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
    const result = await this.getOrCreateSession(params)
    this.scheduleAvailableCommandsUpdate(result.sessionId)
    return result
  }

  // ── loadSession（加载 session）────────────────────────────────────────────

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const result = await this.getOrCreateSession(params)
    this.scheduleAvailableCommandsUpdate(result.sessionId)
    return result
  }

  // ── listSessions（列出 session）───────────────────────────────────────────

  async listSessions(
    params: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const candidates = await listSessionsImpl({
      dir: params.cwd ?? undefined,
      limit: 100,
    })

    const sessions = []
    for (const candidate of candidates) {
      if (!candidate.cwd) continue
      sessions.push({
        sessionId: candidate.sessionId,
        cwd: candidate.cwd,
        title: sanitizeTitle(candidate.summary ?? ''),
        updatedAt: new Date(candidate.lastModified).toISOString(),
      })
    }

    return { sessions }
  }

  // ── forkSession（fork session）────────────────────────────────────────────

  async unstable_forkSession(
    params: ForkSessionRequest,
  ): Promise<ForkSessionResponse> {
    const response = await this.createSession({
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      _meta: params._meta,
    })
    this.scheduleAvailableCommandsUpdate(response.sessionId)
    return response
  }

  // ── closeSession（关闭 session）───────────────────────────────────────────

  async unstable_closeSession(
    params: CloseSessionRequest,
  ): Promise<CloseSessionResponse> {
    const session = this.sessions.get(params.sessionId)
    if (!session) {
      throw new Error('Session not found')
    }
    await this.teardownSession(params.sessionId)
    return {}
  }

  // ── prompt（发送提示）────────────────────────────────────────────────────

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId)
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`)
    }

    // 从 prompt 中提取文本/图像内容
    const promptInput = promptToQueryInput(params.prompt)

    if (!promptInput.trim()) {
      return { stopReason: 'end_turn' }
    }

    const promptCancelGeneration = session.cancelGeneration

    // 处理 prompt 队列——如果已有 prompt 正在运行，则将本次排队
    if (session.promptRunning) {
      const promptUuid = randomUUID()
      const cancelled = await new Promise<boolean>(resolve => {
        session.pendingQueue.push(promptUuid)
        session.pendingMessages.set(promptUuid, { resolve })
      })
      if (cancelled) {
        return { stopReason: 'cancelled' }
      }
    }

    if (session.cancelGeneration !== promptCancelGeneration) {
      return { stopReason: 'cancelled' }
    }

    // 仅在本次 prompt 即将执行时才重置取消状态。排队中的 prompt
    // 不能清除当前活跃 prompt 的取消状态。
    session.cancelled = false
    session.promptRunning = true

    try {
      // 为新查询重置 query engine 的 abort controller。
      // 在上一次 interrupt() 之后，内部 controller 处于已中止状态——
      // 不重置的话，submitMessage() 会立即失败。
      session.queryEngine.resetAbortController()
      // 切换全局 session 状态，确保 recordTranscript 写入正确的 session 文件。
      // 不切换的话，多 session 场景（或在另一个 session 之后新建 session）
      // 会将 transcript 数据写入错误的文件。
      switchSession(params.sessionId as SessionId, getSessionProjectDir())

      const sdkMessages = session.queryEngine.submitMessage(promptInput)

      const { stopReason, usage } = await forwardSessionUpdates(
        params.sessionId,
        sdkMessages,
        this.conn,
        session.queryEngine.getAbortSignal(),
        session.toolUseCache,
        this.clientCapabilities,
        session.cwd,
        () => session.cancelled,
      )

      // 如果 session 在处理过程中被取消，则返回 cancelled
      if (session.cancelled) {
        return { stopReason: 'cancelled' }
      }

      return {
        stopReason,
        usage: usage
          ? {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cachedReadTokens: usage.cachedReadTokens,
              cachedWriteTokens: usage.cachedWriteTokens,
              totalTokens:
                usage.inputTokens +
                usage.outputTokens +
                usage.cachedReadTokens +
                usage.cachedWriteTokens,
            }
          : undefined,
      }
    } catch (err: unknown) {
      if (session.cancelled) {
        return { stopReason: 'cancelled' }
      }

      // 检查进程崩溃错误
      if (
        err instanceof Error &&
        (err.message.includes('terminated') ||
          err.message.includes('process exited'))
      ) {
        this.teardownSession(params.sessionId)
        throw new Error('Claude Agent 进程意外退出，请开启新 session。')
      }

      throw err
    } finally {
      // 若有排队中的 prompt，则触发下一个
      const nextPrompt = popNextPendingPrompt(session)
      if (nextPrompt) {
        session.promptRunning = true
        nextPrompt.resolve(false)
      } else {
        session.promptRunning = false
      }
    }
  }

  // ── cancel（取消）────────────────────────────────────────────────────

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId)
    if (!session) return

    // 设置取消标志——由 prompt() 循环检查以中断执行
    session.cancelled = true
    session.cancelGeneration += 1

    // 取消所有排队中的 prompt
    for (const [, pending] of session.pendingMessages) {
      pending.resolve(true)
    }
    session.pendingMessages.clear()
    session.pendingQueue = []
    session.pendingQueueHead = 0

    // 中断 query engine，终止当前 API 调用
    session.queryEngine.interrupt()
  }

  // ── setSessionMode（设置 session 模式）──────────────────────────────────────────

  async setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse> {
    const session = this.sessions.get(params.sessionId)
    if (!session) {
      throw new Error('Session not found')
    }

    this.applySessionMode(params.sessionId, params.modeId)
    await this.updateConfigOption(params.sessionId, 'mode', params.modeId)
    return {}
  }

  // ── setSessionModel（设置 session 模型）─────────────────────────────────────────

  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse> {
    const session = this.sessions.get(params.sessionId)
    if (!session) {
      throw new Error('Session not found')
    }
    // 存储原始值——QueryEngine.submitMessage() 会调用
    // parseUserSpecifiedModel() 解析别名（如 "sonnet" → "glm-5.1-turbo"）
    session.queryEngine.setModel(params.modelId)
    await this.updateConfigOption(params.sessionId, 'model', params.modelId)
    return {}
  }

  // ── setSessionConfigOption（设置 session 配置项）──────────────────────────────────────

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions.get(params.sessionId)
    if (!session) {
      throw new Error('Session not found')
    }
    if (typeof params.value !== 'string') {
      throw new Error(
        `Invalid value for config option ${params.configId}: ${String(params.value)}`,
      )
    }

    const option = session.configOptions.find(o => o.id === params.configId)
    if (!option) {
      throw new Error(`Unknown config option: ${params.configId}`)
    }

    const value = params.value

    if (params.configId === 'mode') {
      this.applySessionMode(params.sessionId, value)
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: value,
        },
      })
    } else if (params.configId === 'model') {
      session.queryEngine.setModel(value)
    }

    this.syncSessionConfigState(session, params.configId, value)

    session.configOptions = session.configOptions.map(o =>
      o.id === params.configId && typeof o.currentValue === 'string'
        ? { ...o, currentValue: value }
        : o,
    )

    return { configOptions: session.configOptions }
  }

  // ── 私有辅助方法 ─────────────────────────────────────────────

  private async createSession(
    params: NewSessionRequest,
    opts: {
      forceNewId?: boolean
      sessionId?: string
      initialMessages?: Message[]
    } = {},
  ): Promise<NewSessionResponse> {
    enableConfigs()

    const sessionId = opts.sessionId ?? randomUUID()
    const cwd = params.cwd

    // 同步全局 session 状态，确保 transcript 持久化、analytics 和成本追踪
    // 使用 ACP session ID。保留由 getOrCreateSession 设置的 projectDir，
    // 以便 getSessionProjectDir() 能继续正确解析。
    const currentProjectDir = getSessionProjectDir()
    switchSession(sessionId as SessionId, currentProjectDir)

    // 为 session 设置当前工作目录（CWD）
    setOriginalCwd(cwd)
    const previousProcessCwd = process.cwd()
    let processCwdChanged = false
    try {
      process.chdir(cwd)
      processCwdChanged = true
    } catch {
      // CWD 可能尚不存在；尽力执行即可
    }

    try {
      // 使用宽松权限上下文构建 tools。
      const permissionContext = getEmptyToolPermissionContext()
      const tools: Tools = getTools(permissionContext)

      // 从 _meta（由 RCS/acp-link 传入）或 settings 中解析权限模式。
      const meta = params._meta as Record<string, unknown> | null | undefined
      const hasMetaPermissionMode = hasOwnField(meta, 'permissionMode')
      const metaPermissionMode = hasMetaPermissionMode
        ? meta?.permissionMode
        : undefined
      const settingsPermissionMode = this.getSetting<string>(
        'permissions.defaultMode',
      )
      const permissionMode = resolveSessionPermissionMode(
        metaPermissionMode,
        hasMetaPermissionMode,
        settingsPermissionMode,
      )

      // 创建权限桥接的 canUseTool 函数
      const canUseTool = createAcpCanUseTool(
        this.conn,
        sessionId,
        () => this.sessions.get(sessionId)?.modes.currentModeId ?? 'default',
        this.clientCapabilities,
        cwd,
        (modeId: string) => {
          this.applySessionMode(sessionId, modeId)
        },
        () =>
          this.sessions.get(sessionId)?.appState.toolPermissionContext
            .isBypassPermissionsModeAvailable ?? false,
      )

      // 从 ACP 参数解析 MCP servers
      // MCP server 配置在 tools 系统中单独处理

      // 只有在进程和本地配置都允许时，ACP 客户端才能暴露 bypass 模式。
      const isBypassAvailable = isAcpBypassPermissionModeAvailable(
        settingsPermissionMode,
      )

      // 为 session 创建可变的 AppState
      const appState: AppState = {
        ...getDefaultAppState(),
        toolPermissionContext: {
          ...permissionContext,
          mode: permissionMode as PermissionMode,
          isBypassPermissionsModeAvailable: isBypassAvailable,
        },
      }

      // 加载 commands 和 agent 定义以支持 subagent
      const [commands, agentDefinitionsResult] = await Promise.all([
        getCommands(cwd),
        getAgentDefinitionsWithOverrides(cwd),
      ])

      // 将 agent 定义注入 appState
      appState.agentDefinitions = agentDefinitionsResult

      // 构建 QueryEngine 配置
      const engineConfig: QueryEngineConfig = {
        cwd,
        tools,
        commands,
        mcpClients: [],
        agents: agentDefinitionsResult.activeAgents,
        canUseTool,
        getAppState: () => appState,
        setAppState: (updater: (prev: AppState) => AppState) => {
          const updated = updater(appState)
          Object.assign(appState, updated)
        },
        readFileCache: new FileStateCache(500, 50 * 1024 * 1024),
        includePartialMessages: true,
        replayUserMessages: true,
        initialMessages: opts.initialMessages,
      }

      const queryEngine = new QueryEngine(engineConfig)

      // 构建 modes——bypassPermissions 对 ACP 客户端为可选启用。
      const availableModes = [
        {
          id: 'default',
          name: 'Default',
          description: 'Standard behavior, prompts for dangerous operations',
        },
        {
          id: 'acceptEdits',
          name: 'Accept Edits',
          description: 'Auto-accept file edit operations',
        },
        {
          id: 'plan',
          name: 'Plan Mode',
          description: 'Planning mode, no actual tool execution',
        },
        {
          id: 'auto',
          name: 'Auto',
          description:
            'Use a model classifier to approve/deny permission prompts.',
        },
        ...(isBypassAvailable
          ? [
              {
                id: 'bypassPermissions' as const,
                name: 'Bypass Permissions',
                description: 'Skip all permission checks',
              },
            ]
          : []),
        {
          id: 'dontAsk',
          name: "Don't Ask",
          description: "Don't prompt for permissions, deny if not pre-approved",
        },
      ]

      const modes: SessionModeState = {
        currentModeId: permissionMode,
        availableModes,
      }

      // 构建 models 列表
      const modelOptions = getModelOptions()
      const currentModel = getMainLoopModel()
      const models: SessionModelState = {
        availableModels: modelOptions.map(m => ({
          modelId: String(m.value ?? ''),
          name: m.label ?? String(m.value ?? ''),
          description: m.description ?? undefined,
        })),
        currentModelId: currentModel,
      }

      // 在 engine 上设置模型
      queryEngine.setModel(currentModel)

      // 构建 config 选项
      const configOptions = buildConfigOptions(modes, models)

      const session: AcpSession = {
        queryEngine,
        cancelled: false,
        cancelGeneration: 0,
        cwd,
        modes,
        models,
        configOptions,
        promptRunning: false,
        pendingMessages: new Map(),
        pendingQueue: [],
        pendingQueueHead: 0,
        toolUseCache: {},
        clientCapabilities: this.clientCapabilities,
        appState,
        commands,
        sessionFingerprint: computeSessionFingerprint({
          cwd,
          mcpServers: params.mcpServers as
            | Array<{ name: string; [key: string]: unknown }>
            | undefined,
        }),
      }

      this.sessions.set(sessionId, session)

      return {
        sessionId,
        models,
        modes,
        configOptions,
      }
    } finally {
      if (processCwdChanged) {
        process.chdir(previousProcessCwd)
      }
    }
  }

  private async getOrCreateSession(params: {
    sessionId: string
    cwd: string
    mcpServers?: NewSessionRequest['mcpServers']
    _meta?: NewSessionRequest['_meta']
  }): Promise<NewSessionResponse> {
    const existingSession = this.sessions.get(params.sessionId)
    if (existingSession) {
      const fingerprint = computeSessionFingerprint({
        cwd: params.cwd,
        mcpServers: params.mcpServers as
          | Array<{ name: string; [key: string]: unknown }>
          | undefined,
      })
      if (fingerprint === existingSession.sessionFingerprint) {
        const resolved = await resolveSessionFilePath(
          params.sessionId,
          params.cwd,
        )
        switchSession(
          params.sessionId as SessionId,
          resolved ? dirname(resolved.filePath) : null,
        )
        setOriginalCwd(params.cwd)

        await this.replaySessionHistory(params)

        return {
          sessionId: params.sessionId,
          modes: existingSession.modes,
          models: existingSession.models,
          configOptions: existingSession.configOptions,
        }
      }

      await this.teardownSession(params.sessionId)
    }

    // 跨所有项目目录通过 sessionId 定位 session 文件。
    // params.cwd 可能与 session 最初创建时的项目目录不匹配
    //（例如客户端发送的是子目录路径），因此先按 sessionId 搜索，
    // 再回退到基于 cwd 的查找。
    const resolved = await resolveSessionFilePath(params.sessionId, params.cwd)
    const projectDir = resolved ? dirname(resolved.filePath) : null
    switchSession(params.sessionId as SessionId, projectDir)
    setOriginalCwd(params.cwd)

    let initialMessages: Message[] | undefined
    if (resolved) {
      try {
        const log = await getLastSessionLog(params.sessionId as UUID)
        if (log && log.messages.length > 0) {
          initialMessages = deserializeMessages(log.messages)
        }
      } catch (err) {
        console.error('[ACP] Failed to load session history:', err)
      }
    }

    const response = await this.createSession(
      {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        _meta: params._meta,
      },
      { sessionId: params.sessionId, initialMessages },
    )

    // 如果加载了历史记录，则向客户端回放
    if (initialMessages && initialMessages.length > 0) {
      const session = this.sessions.get(params.sessionId)
      if (session) {
        await replayHistoryMessages(
          params.sessionId,
          initialMessages as unknown as Array<Record<string, unknown>>,
          this.conn,
          session.toolUseCache,
          this.clientCapabilities,
          session.cwd,
        )
      }
    }

    return {
      sessionId: response.sessionId,
      modes: response.modes,
      models: response.models,
      configOptions: response.configOptions,
    }
  }

  private async teardownSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    await this.cancel({ sessionId })
    this.sessions.delete(sessionId)
  }

  /**
   * 从磁盘加载 session 历史记录并回放给 ACP 客户端。
   * 用于切换回已在内存中的 session 时
   *（客户端需要回放对话以便展示）。
   */
  private async replaySessionHistory(params: {
    sessionId: string
    cwd: string
  }): Promise<void> {
    try {
      const log = await getLastSessionLog(params.sessionId as UUID)
      if (!log || log.messages.length === 0) return
      const messages = deserializeMessages(log.messages)
      if (messages.length === 0) return

      const session = this.sessions.get(params.sessionId)
      if (!session) return

      await replayHistoryMessages(
        params.sessionId,
        messages as unknown as Array<Record<string, unknown>>,
        this.conn,
        session.toolUseCache,
        this.clientCapabilities,
        session.cwd,
      )
    } catch (err) {
      console.error('[ACP] Failed to replay session history:', err)
    }
  }

  private applySessionMode(sessionId: string, modeId: string): void {
    if (!isPermissionMode(modeId)) {
      throw new Error(`Invalid mode: ${modeId}`)
    }
    const session = this.sessions.get(sessionId)
    if (session) {
      if (
        modeId === 'bypassPermissions' &&
        !session.appState.toolPermissionContext.isBypassPermissionsModeAvailable
      ) {
        throw new Error(`Mode not available: ${modeId}`)
      }
      const isAvailable = session.modes.availableModes.some(
        mode => mode.id === modeId,
      )
      if (!isAvailable) {
        throw new Error(`Mode not available: ${modeId}`)
      }

      session.modes = { ...session.modes, currentModeId: modeId }
      // 将 mode 同步到 appState，使权限流水线看到正确的模式
      session.appState.toolPermissionContext = {
        ...session.appState.toolPermissionContext,
        mode: modeId as PermissionMode,
      }
    }
  }

  private async updateConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    this.syncSessionConfigState(session, configId, value)

    session.configOptions = session.configOptions.map(o =>
      o.id === configId && typeof o.currentValue === 'string'
        ? { ...o, currentValue: value }
        : o,
    )

    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: session.configOptions,
      },
    })
  }

  private syncSessionConfigState(
    session: AcpSession,
    configId: string,
    value: string,
  ): void {
    if (configId === 'mode') {
      session.modes = { ...session.modes, currentModeId: value }
    } else if (configId === 'model') {
      session.models = { ...session.models, currentModelId: value }
    }
  }

  private async sendAvailableCommandsUpdate(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const availableCommands = session.commands
      .filter(
        cmd =>
          cmd.type === 'prompt' && !cmd.isHidden && cmd.userInvocable !== false,
      )
      .map(cmd => ({
        name: cmd.name,
        description: cmd.description,
        input: cmd.argumentHint ? { hint: cmd.argumentHint } : undefined,
      }))

    await this.conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands,
      },
    })
  }

  private scheduleAvailableCommandsUpdate(sessionId: string): void {
    setTimeout(() => {
      void this.sendAvailableCommandsUpdate(sessionId).catch(err => {
        console.error('[ACP] Failed to send available commands update:', err)
      })
    }, 0)
  }

  /** 从 Claude 配置中读取设置（简化版——不监听文件变化） */
  private getSetting<T>(key: string): T | undefined {
    const settings = getSettings_DEPRECATED() as Record<string, unknown>
    const value = key.split('.').reduce<unknown>((current, segment) => {
      if (!current || typeof current !== 'object') return undefined
      return (current as Record<string, unknown>)[segment]
    }, settings)
    return value as T | undefined
  }
}

// ── 辅助函数 ────────────────────────────────────────────────────────

const permissionModeIds: readonly PermissionMode[] = [
  'auto',
  'default',
  'acceptEdits',
  'bypassPermissions',
  'dontAsk',
  'plan',
]

function isPermissionMode(modeId: string): modeId is PermissionMode {
  return (permissionModeIds as readonly string[]).includes(modeId)
}

function resolveSessionPermissionMode(
  metaMode: unknown,
  hasMetaMode: boolean,
  settingsMode: unknown,
): PermissionMode {
  if (hasMetaMode) {
    const metaResolved = resolveRequiredPermissionMode(
      metaMode,
      '_meta.permissionMode',
    )
    if (
      metaResolved === 'bypassPermissions' &&
      !isAcpBypassPermissionModeAvailable(settingsMode)
    ) {
      throw new Error(
        'Mode not available: bypassPermissions requires a local ACP bypass opt-in.',
      )
    }

    return metaResolved
  }

  const settingsResolved = resolveConfiguredPermissionMode(settingsMode)
  return settingsResolved ?? 'default'
}

function resolveRequiredPermissionMode(
  mode: unknown,
  source: string,
): PermissionMode {
  if (mode === undefined || mode === null) {
    throw new Error(`Invalid ${source}: expected a string.`)
  }

  return resolvePermissionMode(mode, source) as PermissionMode
}

function resolveConfiguredPermissionMode(
  mode: unknown,
): PermissionMode | undefined {
  if (mode === undefined || mode === null) return undefined

  try {
    return resolvePermissionMode(
      mode,
      'permissions.defaultMode',
    ) as PermissionMode
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(
      '[ACP] Invalid permissions.defaultMode, using default:',
      reason,
    )
    return undefined
  }
}

function hasOwnField(
  value: Record<string, unknown> | null | undefined,
  key: string,
): boolean {
  return !!value && Object.hasOwn(value, key)
}

function isAcpBypassPermissionModeAvailable(settingsMode?: unknown): boolean {
  return (
    isProcessBypassPermissionModeAvailable() &&
    (isAcpBypassLocallyEnabled() ||
      isSettingsBypassPermissionMode(settingsMode))
  )
}

function isProcessBypassPermissionModeAvailable(): boolean {
  if (process.env.IS_SANDBOX) return true
  if (typeof process.geteuid === 'function') return process.geteuid() !== 0
  if (typeof process.getuid === 'function') return process.getuid() !== 0
  return true
}

function isAcpBypassLocallyEnabled(): boolean {
  return (
    process.env.ACP_PERMISSION_MODE === 'bypassPermissions' ||
    isTruthyEnv(process.env.CLAUDE_CODE_ACP_ALLOW_BYPASS_PERMISSIONS)
  )
}

function isSettingsBypassPermissionMode(settingsMode: unknown): boolean {
  try {
    return resolvePermissionMode(settingsMode) === 'bypassPermissions'
  } catch {
    return false
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

function popNextPendingPrompt(session: AcpSession): PendingPrompt | undefined {
  while (session.pendingQueueHead < session.pendingQueue.length) {
    const nextId = session.pendingQueue[session.pendingQueueHead++]
    if (!nextId) continue
    const next = session.pendingMessages.get(nextId)
    if (!next) continue
    session.pendingMessages.delete(nextId)
    compactPendingQueue(session)
    return next
  }

  compactPendingQueue(session)
  return undefined
}

function compactPendingQueue(session: AcpSession): void {
  if (session.pendingQueueHead === 0) return

  if (session.pendingQueueHead >= session.pendingQueue.length) {
    session.pendingQueue = []
    session.pendingQueueHead = 0
    return
  }

  if (
    session.pendingQueueHead > 1024 &&
    session.pendingQueueHead * 2 > session.pendingQueue.length
  ) {
    session.pendingQueue = session.pendingQueue.slice(session.pendingQueueHead)
    session.pendingQueueHead = 0
  }
}

function buildConfigOptions(
  modes: SessionModeState,
  models: SessionModelState,
): SessionConfigOption[] {
  return [
    {
      id: 'mode',
      name: 'Mode',
      description: 'Session permission mode',
      category: 'mode',
      type: 'select' as const,
      currentValue: modes.currentModeId,
      options: modes.availableModes.map(
        (m: SessionModeState['availableModes'][number]) => ({
          value: m.id,
          name: m.name,
          description: m.description,
        }),
      ),
    },
    {
      id: 'model',
      name: 'Model',
      description: 'AI model to use',
      category: 'model',
      type: 'select' as const,
      currentValue: models.currentModelId,
      options: models.availableModels.map(
        (m: SessionModelState['availableModels'][number]) => ({
          value: m.modelId,
          name: m.name,
          description: m.description ?? undefined,
        }),
      ),
    },
  ] as SessionConfigOption[]
}
