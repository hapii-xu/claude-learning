import { feature } from 'bun:bundle'
import { basename } from 'path'
import { useCallback, useEffect, useRef } from 'react'
import { getSessionId } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import type { Tool } from '../../Tool.js'
import {
  clearServerCache,
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
  getMcpToolsCommandsAndResources,
  reconnectMcpServerImpl,
} from './client.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
  ServerResource,
} from './types.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const fetchMcpSkillsForClient = feature('MCP_SKILLS')
  ? (
      require('../../skills/mcpSkills.js') as typeof import('../../skills/mcpSkills.js')
    ).fetchMcpSkillsForClient
  : null
const clearSkillIndexCache = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (
      require('../skillSearch/localSearch.js') as typeof import('../skillSearch/localSearch.js')
    ).clearSkillIndexCache
  : null

import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import omit from 'lodash-es/omit.js'
import reject from 'lodash-es/reject.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  dedupClaudeAiMcpServers,
  doesEnterpriseMcpConfigExist,
  filterMcpServersByPolicy,
  getClaudeCodeMcpConfigs,
  isMcpServerDisabled,
  setMcpServerEnabled,
} from 'src/services/mcp/config.js'
import type { AppState } from 'src/state/AppState.js'
import type { PluginError } from 'src/types/plugin.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getAllowedChannels } from '../../bootstrap/state.js'
import { useNotifications } from '../../context/notifications.js'
import {
  useAppState,
  useAppStateStore,
  useSetAppState,
} from '../../state/AppState.js'
import { errorMessage } from '../../utils/errors.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { logMCPDebug, logMCPError } from '../../utils/log.js'
import { enqueue } from '../../utils/messageQueueManager.js'
import {
  CHANNEL_PERMISSION_METHOD,
  ChannelMessageNotificationSchema,
  ChannelPermissionNotificationSchema,
  findChannelEntry,
  gateChannelServer,
  wrapChannelMessage,
} from './channelNotification.js'
import {
  type ChannelPermissionCallbacks,
  createChannelPermissionCallbacks,
  isChannelPermissionRelayEnabled,
} from './channelPermissions.js'
import {
  clearClaudeAIMcpConfigsCache,
  fetchClaudeAIMcpConfigsIfEligible,
} from './claudeai.js'
import { registerElicitationHandler } from './elicitationHandler.js'
import { getMcpPrefix } from './mcpStringUtils.js'
import { commandBelongsToServer, excludeStalePluginClients } from './utils.js'

// 指数退避重连相关常量
const MAX_RECONNECT_ATTEMPTS = 5
const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30000

/**
 * 为插件错误创建唯一键以便去重
 */
function getErrorKey(error: PluginError): string {
  const plugin = 'plugin' in error ? error.plugin : 'no-plugin'
  return `${error.type}:${error.source}:${plugin}`
}

/**
 * 将错误添加到 AppState，进行去重以避免重复显示相同错误
 */
function addErrorsToAppState(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  newErrors: PluginError[],
): void {
  if (newErrors.length === 0) return

  setAppState(prevState => {
    // 构建已有错误的键集合
    const existingKeys = new Set(
      prevState.plugins.errors.map(e => getErrorKey(e)),
    )

    // 只添加尚不存在的错误
    const uniqueNewErrors = newErrors.filter(
      error => !existingKeys.has(getErrorKey(error)),
    )

    if (uniqueNewErrors.length === 0) {
      return prevState
    }

    return {
      ...prevState,
      plugins: {
        ...prevState.plugins,
        errors: [...prevState.plugins.errors, ...uniqueNewErrors],
      },
    }
  })
}

/**
 * 管理 MCP（模型上下文协议）服务器连接和更新的 Hook
 *
 * 此 Hook 的功能：
 * 1. 根据配置初始化 MCP 客户端连接
 * 2. 为连接生命周期事件和与 app state 的同步设置处理程序
 * 3. 管理 SSE 连接的自动重连
 * 4. 返回一个重连函数
 */
export function useManageMCPConnections(
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig> | undefined,
  isStrictMcpConfig = false,
) {
  const store = useAppStateStore()
  const _authVersion = useAppState(s => s.authVersion)
  // 由 /reload-plugins 触发（refreshActivePlugins）以获取新启用的插件 MCP 服务器。
  // getClaudeCodeMcpConfigs() 读取 loadAllPlugins()，后者已被 refreshActivePlugins 清除，
  // 因此下方的 effect 在重新运行时能看到最新的插件数据。
  const _pluginReconnectKey = useAppState(s => s.mcp.pluginReconnectKey)
  const setAppState = useSetAppState()

  // 跟踪活跃的重连尝试，以便支持取消
  const reconnectTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map())

  // 对 --channels 阻止警告进行去重（按跳过类型），这样当用户看到
  // "run /login"（auth skip）、登录后又触达策略门控时，会收到第二条 toast。
  const channelWarnedKindsRef = useRef<
    Set<'disabled' | 'auth' | 'policy' | 'marketplace' | 'allowlist'>
  >(new Set())
  // 频道权限回调 —— 只构建一次，保持引用稳定。存储在 AppState 中
  // 以便 interactiveHandler 可以订阅。待处理的 Map 位于闭包内部
  // （不在模块级别，也不在 AppState —— 将函数放入 state 是脆弱的）。
  const channelPermCallbacksRef = useRef<ChannelPermissionCallbacks | null>(
    null,
  )
  if (
    (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
    channelPermCallbacksRef.current === null
  ) {
    channelPermCallbacksRef.current = createChannelPermissionCallbacks()
  }
  // 将回调存储到 AppState，以便 interactiveHandler.ts 可以通过
  // ctx.toolUseContext.getAppState() 访问它们。一次性设置 —— ref 是稳定的。
  useEffect(() => {
    if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
      const callbacks = channelPermCallbacksRef.current
      if (!callbacks) return
      // GrowthBook 运行时门控 —— 与 channels 功能分离，channels 可以
      // 独立于此功能发布。在挂载时检查；会话中途切换需要重启。
      // 如果关闭，回调永远不会进入 AppState → interactiveHandler 看到的是
      // undefined → 永远不会发送 → 拦截没有待处理项 → "yes tbxkq"
      // 作为普通聊天传给 Claude。一个门控，完全禁用。
      if (!isChannelPermissionRelayEnabled()) return
      setAppState(prev => {
        if (prev.channelPermissionCallbacks === callbacks) return prev
        return { ...prev, channelPermissionCallbacks: callbacks }
      })
      return () => {
        setAppState(prev => {
          if (prev.channelPermissionCallbacks === undefined) return prev
          return { ...prev, channelPermissionCallbacks: undefined }
        })
      }
    }
  }, [setAppState])
  const { addNotification } = useNotifications()

  // 批量 MCP 状态更新：将单个服务器更新入队，然后通过 setTimeout
  // 在一次 setAppState 调用中批量刷新。使用基于时间的窗口
  // （而不是 queueMicrotask）确保即使连接回调因网络 I/O
  // 在不同时间到达时也能批量处理更新。
  const MCP_BATCH_FLUSH_MS = 16
  type PendingUpdate = MCPServerConnection & {
    tools?: Tool[]
    commands?: Command[]
    resources?: ServerResource[]
  }
  const pendingUpdatesRef = useRef<PendingUpdate[]>([])
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushPendingUpdates = useCallback(() => {
    flushTimerRef.current = null
    const updates = pendingUpdatesRef.current
    if (updates.length === 0) return
    pendingUpdatesRef.current = []

    setAppState(prevState => {
      let mcp = prevState.mcp

      for (const update of updates) {
        const {
          tools: rawTools,
          commands: rawCmds,
          resources: rawRes,
          ...client
        } = update
        const tools =
          client.type === 'disabled' || client.type === 'failed'
            ? (rawTools ?? [])
            : rawTools
        const commands =
          client.type === 'disabled' || client.type === 'failed'
            ? (rawCmds ?? [])
            : rawCmds
        const resources =
          client.type === 'disabled' || client.type === 'failed'
            ? (rawRes ?? [])
            : rawRes

        const prefix = getMcpPrefix(client.name)
        const existingClientIndex = mcp.clients.findIndex(
          c => c.name === client.name,
        )

        const updatedClients =
          existingClientIndex === -1
            ? [...mcp.clients, client]
            : mcp.clients.map(c => (c.name === client.name ? client : c))

        const updatedTools =
          tools === undefined
            ? mcp.tools
            : [...reject(mcp.tools, t => t.name?.startsWith(prefix)), ...tools]

        const updatedCommands =
          commands === undefined
            ? mcp.commands
            : [
                ...reject(mcp.commands, c =>
                  commandBelongsToServer(c, client.name),
                ),
                ...commands,
              ]

        const updatedResources =
          resources === undefined
            ? mcp.resources
            : {
                ...mcp.resources,
                ...(resources.length > 0
                  ? { [client.name]: resources }
                  : omit(mcp.resources, client.name)),
              }

        mcp = {
          ...mcp,
          clients: updatedClients,
          tools: updatedTools,
          commands: updatedCommands,
          resources: updatedResources,
        }
      }

      return { ...prevState, mcp }
    })
  }, [setAppState])

  // 更新服务器状态、工具、命令和资源。
  // 当 tools、commands 或 resources 为 undefined 时，保留现有值。
  // 当 type 为 'disabled' 或 'failed' 时，tools/commands/resources 会自动清空。
  // 更新通过 setTimeout 批量处理，合并 MCP_BATCH_FLUSH_MS 内到达的更新。
  const updateServer = useCallback(
    (update: PendingUpdate) => {
      pendingUpdatesRef.current.push(update)
      if (flushTimerRef.current === null) {
        flushTimerRef.current = setTimeout(
          flushPendingUpdates,
          MCP_BATCH_FLUSH_MS,
        )
      }
    },
    [flushPendingUpdates],
  )

  const onConnectionAttempt = useCallback(
    ({
      client,
      tools,
      commands,
      resources,
    }: {
      client: MCPServerConnection
      tools: Tool[]
      commands: Command[]
      resources?: ServerResource[]
    }) => {
      updateServer({ ...client, tools, commands, resources })

      // 根据客户端状态处理副作用
      switch (client.type) {
        case 'connected': {
          // 覆盖 connectToServer 中注册的默认 elicitation 处理程序，
          // 替换为真实的处理程序（将 elicitation 加入 AppState 队列以显示 UI）。
          // 在此处注册（每次连接一次）而非在 [mcpClients] effect 中，
          // 避免每次状态变更时为所有已连接服务器重新运行。
          registerElicitationHandler(client.client, client.name, setAppState)

          client.client.onclose = () => {
            const configType = client.config.type ?? 'stdio'

            clearServerCache(client.name, client.config).catch(() => {
              logForDebugging(
                `Failed to invalidate the server cache: ${client.name}`,
              )
            })

            // TODO: 这确实不太理想：理想情况下我们应该将 appstate 作为
            // 是否因禁用而断开的真实来源，但此时 appstate 已经过时了。
            // 获取 appstate 的实时引用感觉有点 hacky，所以我们只检查磁盘状态。
            // 我们可能需要重构其中的一部分。
            if (isMcpServerDisabled(client.name)) {
              logMCPDebug(
                client.name,
                `Server is disabled, skipping automatic reconnection`,
              )
              return
            }

            // 处理远程传输的自动重连
            // 跳过 stdio（本地进程）和 sdk（内部） —— 它们不支持重连
            if (configType !== 'stdio' && configType !== 'sdk') {
              const transportType = getTransportDisplayName(configType)
              logMCPDebug(
                client.name,
                `${transportType} transport closed/disconnected, attempting automatic reconnection`,
              )

              // 取消该服务器已有的重连尝试
              const existingTimer = reconnectTimersRef.current.get(client.name)
              if (existingTimer) {
                clearTimeout(existingTimer)
                reconnectTimersRef.current.delete(client.name)
              }

              // 使用指数退避尝试重连
              const reconnectWithBackoff = async () => {
                for (
                  let attempt = 1;
                  attempt <= MAX_RECONNECT_ATTEMPTS;
                  attempt++
                ) {
                  // 检查在等待期间服务器是否被禁用
                  if (isMcpServerDisabled(client.name)) {
                    logMCPDebug(
                      client.name,
                      `Server disabled during reconnection, stopping retry`,
                    )
                    reconnectTimersRef.current.delete(client.name)
                    return
                  }

                  updateServer({
                    ...client,
                    type: 'pending',
                    reconnectAttempt: attempt,
                    maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
                  })

                  const reconnectStartTime = Date.now()
                  try {
                    const result = await reconnectMcpServerImpl(
                      client.name,
                      client.config,
                    )
                    const elapsed = Date.now() - reconnectStartTime

                    if (result.client.type === 'connected') {
                      logMCPDebug(
                        client.name,
                        `${transportType} reconnection successful after ${elapsed}ms (attempt ${attempt})`,
                      )
                      reconnectTimersRef.current.delete(client.name)
                      onConnectionAttempt(result)
                      return
                    }

                    logMCPDebug(
                      client.name,
                      `${transportType} reconnection attempt ${attempt} completed with status: ${result.client.type}`,
                    )

                    // 在最后一次尝试时，用结果更新状态
                    if (attempt === MAX_RECONNECT_ATTEMPTS) {
                      logMCPDebug(
                        client.name,
                        `Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached, giving up`,
                      )
                      reconnectTimersRef.current.delete(client.name)
                      onConnectionAttempt(result)
                      return
                    }
                  } catch (error) {
                    const elapsed = Date.now() - reconnectStartTime
                    logMCPError(
                      client.name,
                      `${transportType} reconnection attempt ${attempt} failed after ${elapsed}ms: ${error}`,
                    )

                    // 在最后一次尝试时，标记为失败
                    if (attempt === MAX_RECONNECT_ATTEMPTS) {
                      logMCPDebug(
                        client.name,
                        `Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached, giving up`,
                      )
                      reconnectTimersRef.current.delete(client.name)
                      updateServer({ ...client, type: 'failed' })
                      return
                    }
                  }

                  // 使用指数退避安排下一次重试
                  const backoffMs = Math.min(
                    INITIAL_BACKOFF_MS * 2 ** (attempt - 1),
                    MAX_BACKOFF_MS,
                  )
                  logMCPDebug(
                    client.name,
                    `Scheduling reconnection attempt ${attempt + 1} in ${backoffMs}ms`,
                  )

                  await new Promise<void>(resolve => {
                    // eslint-disable-next-line no-restricted-syntax -- timer stored in ref for cancellation; sleep() doesn't expose the handle
                    const timer = setTimeout(resolve, backoffMs)
                    reconnectTimersRef.current.set(client.name, timer)
                  })
                }
              }

              void reconnectWithBackoff()
            } else {
              updateServer({ ...client, type: 'failed' })
            }
          }

          // 频道推送：notifications/claude/channel → enqueue()。
          // 门控决定是否注册处理程序；无论如何连接都会保持
          // （allowedMcpServers 控制这一点）。
          const gate = gateChannelServer(
            client.name,
            client.capabilities,
            client.config.pluginSource,
          )
          const entry = findChannelEntry(client.name, getAllowedChannels())
          // 插件标识符，用于遥测 —— 对于任何 plugin 类型的条目，
          // 记录 name@marketplace（与 tengu_plugin_installed 同级别，
          // 该事件记录任意的 plugin_id+marketplace_name，无门控限制）。
          // server 类型的名称是 MCP 服务器名称级别；这些在其他地方
          // 仅在选择性启用时记录（参见 metadata.ts 中的
          // isAnalyticsToolDetailsLoggingEnabled），此处不记录。
          // is_dev/entry_kind 进一步细分其余信息。
          const pluginId =
            entry?.kind === 'plugin'
              ? (`${entry.name}@${entry.marketplace}` as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : undefined
          // 跳过能力缺失 —— 每个非频道 MCP 服务器都会触发。
          if (gate.action === 'register' || gate.kind !== 'capability') {
            logEvent('tengu_mcp_channel_gate', {
              registered: gate.action === 'register',
              skip_kind:
                gate.action === 'skip'
                  ? (gate.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
                  : undefined,
              entry_kind:
                entry?.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              is_dev: entry?.dev ?? false,
              plugin: pluginId,
            })
          }
          switch (gate.action) {
            case 'register':
              logMCPDebug(client.name, 'Channel notifications registered')
              client.client.setNotificationHandler(
                ChannelMessageNotificationSchema() as any,
                async notification => {
                  const { content, meta } = notification.params
                  logMCPDebug(
                    client.name,
                    `notifications/claude/channel: ${content.slice(0, 80)}`,
                  )
                  logEvent('tengu_mcp_channel_message', {
                    content_length: content.length,
                    meta_key_count: Object.keys(meta ?? {}).length,
                    entry_kind:
                      entry?.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    is_dev: entry?.dev ?? false,
                    plugin: pluginId,
                  })
                  enqueue({
                    mode: 'prompt',
                    value: wrapChannelMessage(client.name, content, meta),
                    priority: 'next',
                    isMeta: true,
                    origin: { kind: 'channel', server: client.name } as any,
                    skipSlashCommands: true,
                  })
                },
              )
              // 权限回复处理程序 —— 独立事件，独立能力。
              // 仅在服务器声明了 claude/channel/permission 时注册
              // （与 interactiveHandler.ts 中发送路径的相同 opt-in 检查）。
              // 服务器解析用户的回复并发出 {request_id, behavior}；
              // 我们这边不做正则匹配，通用频道中的文本
              // 不会意外匹配。
              if (
                client.capabilities?.experimental?.['claude/channel/permission']
              ) {
                client.client.setNotificationHandler(
                  ChannelPermissionNotificationSchema() as any,
                  async notification => {
                    const { request_id, behavior } = notification.params
                    const resolved =
                      channelPermCallbacksRef.current?.resolve(
                        request_id,
                        behavior,
                        client.name,
                      ) ?? false
                    logMCPDebug(
                      client.name,
                      `notifications/claude/channel/permission: ${request_id} → ${behavior} (${resolved ? 'matched pending' : 'no pending entry — stale or unknown ID'})`,
                    )
                  },
                )
              }
              break
            case 'skip':
              // 幂等卸载，以便 register→skip 重新门控（例如
              // /logout 后 effect 重新运行）能真正移除活跃的处理程序。
              // 如果不这样做，会话中途降级就是单向的：
              // 门控说 skip，但之前的处理程序仍在入队。
              // Map.delete —— 未注册时调用也是安全的。
              client.client.removeNotificationHandler(
                'notifications/claude/channel',
              )
              client.client.removeNotificationHandler(CHANNEL_PERMISSION_METHOD)
              logMCPDebug(
                client.name,
                `Channel notifications skipped: ${gate.reason}`,
              )
              // 当频道服务器被阻止时，显示每种类型一次的 toast。
              // 这是唯一用户可见的信号（上述 logMCPDebug 需要 --debug）。
              // 能力/会话跳过的预期噪声只记录在调试级别。
              // marketplace/allowlist 在会话后运行 —— 如果这里出现
              // 这些类型，是用户主动请求的。
              if (
                gate.kind !== 'capability' &&
                gate.kind !== 'session' &&
                !channelWarnedKindsRef.current.has(gate.kind) &&
                (gate.kind === 'marketplace' ||
                  gate.kind === 'allowlist' ||
                  entry !== undefined)
              ) {
                channelWarnedKindsRef.current.add(gate.kind)
                // disabled/auth/policy 使用自定义 toast 文案（更短、可操作）；
                // marketplace/allowlist 直接复用门控的 reason，
                // 因为它已经说明了不匹配的原因。
                const text =
                  gate.kind === 'disabled'
                    ? 'Channels are not currently available'
                    : gate.kind === 'auth'
                      ? 'Channels require claude.ai authentication · run /login'
                      : gate.kind === 'policy'
                        ? 'Channels are not enabled for your org · have an administrator set channelsEnabled: true in managed settings'
                        : gate.reason
                addNotification({
                  key: `channels-blocked-${gate.kind}`,
                  priority: 'high',
                  text,
                  color: 'warning',
                  timeoutMs: 12000,
                })
              }
              break
          }

          // 注册 list_changed 通知处理程序
          // 这些处理程序允许服务器在工具、提示或资源变更时通知我们
          if (client.capabilities?.tools?.listChanged) {
            client.client.setNotificationHandler(
              ToolListChangedNotificationSchema,
              async () => {
                logMCPDebug(
                  client.name,
                  `Received tools/list_changed notification, refreshing tools`,
                )
                try {
                  // 在清除缓存前获取缓存的 promise 以记录先前的数量
                  const previousToolsPromise = fetchToolsForClient.cache.get(
                    client.name,
                  )
                  fetchToolsForClient.cache.delete(client.name)
                  const newTools = await fetchToolsForClient(client)
                  const newCount = newTools.length
                  if (previousToolsPromise) {
                    previousToolsPromise.then(
                      (previousTools: Tool[]) => {
                        logEvent('tengu_mcp_list_changed', {
                          type: 'tools' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                          previousCount: previousTools.length,
                          newCount,
                        })
                      },
                      () => {
                        logEvent('tengu_mcp_list_changed', {
                          type: 'tools' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                          newCount,
                        })
                      },
                    )
                  } else {
                    logEvent('tengu_mcp_list_changed', {
                      type: 'tools' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      newCount,
                    })
                  }
                  updateServer({ ...client, tools: newTools })
                } catch (error) {
                  logMCPError(
                    client.name,
                    `Failed to refresh tools after list_changed notification: ${errorMessage(error)}`,
                  )
                }
              },
            )
          }

          if (client.capabilities?.prompts?.listChanged) {
            client.client.setNotificationHandler(
              PromptListChangedNotificationSchema,
              async () => {
                logMCPDebug(
                  client.name,
                  `Received prompts/list_changed notification, refreshing prompts`,
                )
                logEvent('tengu_mcp_list_changed', {
                  type: 'prompts' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                })
                try {
                  // 技能来自资源，不是提示 —— 不要在此处清除它们的缓存。
                  // fetchMcpSkillsForClient 返回缓存的结果。
                  fetchCommandsForClient.cache.delete(client.name)
                  const [mcpPrompts, mcpSkills] = await Promise.all([
                    fetchCommandsForClient(client),
                    feature('MCP_SKILLS')
                      ? fetchMcpSkillsForClient!(client)
                      : Promise.resolve([]),
                  ])
                  updateServer({
                    ...client,
                    commands: [...mcpPrompts, ...mcpSkills],
                  })
                  // MCP 技能已变更 —— 使 skill-search 索引失效，
                  // 以便下次发现时用新集合重建。
                  clearSkillIndexCache?.()
                } catch (error) {
                  logMCPError(
                    client.name,
                    `Failed to refresh prompts after list_changed notification: ${errorMessage(error)}`,
                  )
                }
              },
            )
          }

          if (client.capabilities?.resources?.listChanged) {
            client.client.setNotificationHandler(
              ResourceListChangedNotificationSchema,
              async () => {
                logMCPDebug(
                  client.name,
                  `Received resources/list_changed notification, refreshing resources`,
                )
                logEvent('tengu_mcp_list_changed', {
                  type: 'resources' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                })
                try {
                  fetchResourcesForClient.cache.delete(client.name)
                  if (feature('MCP_SKILLS')) {
                    // 技能是从资源中发现的，所以也需要刷新它们。
                    // 同时使提示缓存失效：我们在此处写入 commands，
                    // 而并发的 prompts/list_changed 可能会使我们用
                    // 缓存的旧结果覆盖其最新结果。
                    fetchMcpSkillsForClient!.cache.delete(client.name)
                    fetchCommandsForClient.cache.delete(client.name)
                    const [newResources, mcpPrompts, mcpSkills] =
                      await Promise.all([
                        fetchResourcesForClient(client),
                        fetchCommandsForClient(client),
                        fetchMcpSkillsForClient!(client),
                      ])
                    updateServer({
                      ...client,
                      resources: newResources,
                      commands: [...mcpPrompts, ...mcpSkills],
                    })
                    // MCP 技能已变更 —— 使 skill-search 索引失效，
                    // 以便下次发现时用新集合重建。
                    clearSkillIndexCache?.()
                  } else {
                    const newResources = await fetchResourcesForClient(client)
                    updateServer({ ...client, resources: newResources })
                  }
                } catch (error) {
                  logMCPError(
                    client.name,
                    `Failed to refresh resources after list_changed notification: ${errorMessage(error)}`,
                  )
                }
              },
            )
          }
          break
        }

        case 'needs-auth':
        case 'failed':
        case 'pending':
        case 'disabled':
          break
      }
    },
    [updateServer],
  )

  // 如果所有服务器在 appState 中不存在，则初始化为 pending 状态。
  // 在会话变更（/clear）和 /reload-plugins（pluginReconnectKey）时重新运行。
  // 在插件重新加载时，还会断开不再出现在配置中的陈旧插件 MCP 服务器
  // （scope 'dynamic'） —— 防止已禁用插件残留 ghost 工具。
  // 此处跳过 claude.ai 去重，避免阻塞网络请求；下方的 connect
  // useEffect 紧随其后运行，在连接前进行去重。
  const sessionId = getSessionId()
  useEffect(() => {
    async function initializeServersAsPending() {
      const { servers: existingConfigs, errors: mcpErrors } = isStrictMcpConfig
        ? { servers: {}, errors: [] }
        : await getClaudeCodeMcpConfigs(dynamicMcpConfig)
      const configs = { ...existingConfigs, ...dynamicMcpConfig }

      // 将 MCP 错误添加到插件错误中以便 UI 可见（已去重）
      addErrorsToAppState(setAppState, mcpErrors)

      setAppState(prevState => {
        // 断开陈旧的 MCP 服务器连接：已从配置中移除的插件服务器，
        // 或配置哈希值已变更（编辑了 .mcp.json）的任何服务器。
        // 陈旧的服务器会在下方被重新添加为 'pending'，因为它们的名称
        // 已经从 mcpWithoutStale.clients 中消失。
        const { stale, ...mcpWithoutStale } = excludeStalePluginClients(
          prevState.mcp,
          configs,
        )
        // 清理陈旧连接。Fire-and-forget —— 状态更新器必须是同步的。
        // 调用 cleanup 之前需要排除三个隐患：
        //   1. 待处理的重连定时器会用旧的配置触发。
        //   2. onclose（在 L254 处设置）会从闭包中用旧配置启动
        //      reconnectWithBackoff —— 它检查 isMcpServerDisabled，
        //      但配置变更的服务器并非被禁用，所以它会与新的连接竞争，
        //      最后 updateServer 会获胜。
        //   3. clearServerCache 内部调用 connectToServer（已记忆化）。
        //      对于从未连接的服务器（disabled/pending/failed），缓存为空
        //      → 真实的连接尝试 → 会启动/进行 OAuth 只为立即终止。
        //      只有已连接的服务器需要清理。
        for (const s of stale) {
          const timer = reconnectTimersRef.current.get(s.name)
          if (timer) {
            clearTimeout(timer)
            reconnectTimersRef.current.delete(s.name)
          }
          if (s.type === 'connected') {
            s.client.onclose = undefined
            void clearServerCache(s.name, s.config).catch(() => {})
          }
        }

        const existingServerNames = new Set(
          mcpWithoutStale.clients.map(c => c.name),
        )
        const newClients = Object.entries(configs)
          .filter(([name]) => !existingServerNames.has(name))
          .map(([name, config]) => ({
            name,
            type: isMcpServerDisabled(name)
              ? ('disabled' as const)
              : ('pending' as const),
            config,
          }))

        if (newClients.length === 0 && stale.length === 0) {
          return prevState
        }

        return {
          ...prevState,
          mcp: {
            ...prevState.mcp,
            ...mcpWithoutStale,
            clients: [...mcpWithoutStale.clients, ...newClients],
          },
        }
      })
    }

    void initializeServersAsPending().catch(error => {
      logMCPError(
        'useManageMCPConnections',
        `Failed to initialize servers as pending: ${errorMessage(error)}`,
      )
    })
  }, [
    isStrictMcpConfig,
    dynamicMcpConfig,
    setAppState,
    sessionId,
    _pluginReconnectKey,
  ])

  // 加载 MCP 配置并连接到服务器
  // 两阶段加载：先加载 Claude Code 配置（快速），再加载 claude.ai 配置（可能较慢）
  useEffect(() => {
    let cancelled = false

    async function loadAndConnectMcpConfigs() {
      logForDebugging('[Hapii] Mcp.manageConnections 两阶段调度开始', {
        level: 'info',
      })
      // 清除 claude.ai MCP 缓存，以便使用当前认证状态获取最新配置。
      // 当 authVersion 变化时（例如登录后/登出后）这一点很重要。
      // 启动此 fetch 使其与 getClaudeCodeMcpConfigs 中的 loadAllPlugins()
      // 并行执行；仅在去重步骤处等待。第二阶段（Phase 2）等待同一个
      // promise —— 不会有第二次网络调用。
      let claudeaiPromise: Promise<Record<string, ScopedMcpServerConfig>>
      if (isStrictMcpConfig || doesEnterpriseMcpConfigExist()) {
        claudeaiPromise = Promise.resolve({})
      } else {
        clearClaudeAIMcpConfigsCache()
        claudeaiPromise = fetchClaudeAIMcpConfigsIfEligible()
      }

      // 阶段 1：加载 Claude Code 配置。与 --mcp-config 条目或 claude.ai
      // 连接器重复的插件 MCP 服务器会在此处被抑制，这样它们就不会在
      // 第二阶段与连接器同时连接。
      const { servers: claudeCodeConfigs, errors: mcpErrors } =
        isStrictMcpConfig
          ? { servers: {}, errors: [] }
          : await getClaudeCodeMcpConfigs(dynamicMcpConfig, claudeaiPromise)
      if (cancelled) return

      // 将 MCP 错误添加到插件错误中以便 UI 可见（已去重）
      addErrorsToAppState(setAppState, mcpErrors)

      const configs = { ...claudeCodeConfigs, ...dynamicMcpConfig }

      // 开始连接 Claude Code 服务器（不等待 —— 与阶段 2 并行运行）
      // 过滤掉禁用的服务器以避免不必要的连接尝试
      const enabledConfigs = Object.fromEntries(
        Object.entries(configs).filter(([name]) => !isMcpServerDisabled(name)),
      )
      getMcpToolsCommandsAndResources(
        onConnectionAttempt,
        enabledConfigs,
      ).catch(error => {
        logMCPError(
          'useManageMcpConnections',
          `Failed to get MCP resources: ${errorMessage(error)}`,
        )
      })

      // 阶段 2：等待 claude.ai 配置（已在上方启动；已记忆化 —— 不会重复 fetch）
      let claudeaiConfigs: Record<string, ScopedMcpServerConfig> = {}
      if (!isStrictMcpConfig) {
        claudeaiConfigs = filterMcpServersByPolicy(
          await claudeaiPromise,
        ).allowed
        if (cancelled) return

        // 抑制与已启用的手动服务器重复的 claude.ai 连接器。
        // 键永远不会冲突（`slack` vs `claude.ai Slack`），所以下面的合并
        // 无法捕获 —— 需要按 URL 签名进行基于内容的去重。
        if (Object.keys(claudeaiConfigs).length > 0) {
          const { servers: dedupedClaudeAi } = dedupClaudeAiMcpServers(
            claudeaiConfigs,
            configs,
          )
          claudeaiConfigs = dedupedClaudeAi
        }

        if (Object.keys(claudeaiConfigs).length > 0) {
          // 立即将 claude.ai 服务器添加为 pending，以便它们在 UI 中显示
          setAppState(prevState => {
            const existingServerNames = new Set(
              prevState.mcp.clients.map(c => c.name),
            )
            const newClients = Object.entries(claudeaiConfigs)
              .filter(([name]) => !existingServerNames.has(name))
              .map(([name, config]) => ({
                name,
                type: isMcpServerDisabled(name)
                  ? ('disabled' as const)
                  : ('pending' as const),
                config,
              }))
            if (newClients.length === 0) return prevState
            return {
              ...prevState,
              mcp: {
                ...prevState.mcp,
                clients: [...prevState.mcp.clients, ...newClients],
              },
            }
          })

          // 现在开始连接（仅已启用的服务器）
          const enabledClaudeaiConfigs = Object.fromEntries(
            Object.entries(claudeaiConfigs).filter(
              ([name]) => !isMcpServerDisabled(name),
            ),
          )
          getMcpToolsCommandsAndResources(
            onConnectionAttempt,
            enabledClaudeaiConfigs,
          ).catch(error => {
            logMCPError(
              'useManageMcpConnections',
              `Failed to get claude.ai MCP resources: ${errorMessage(error)}`,
            )
          })
        }
      }

      // 两阶段完成后记录服务器数量
      const allConfigs = { ...configs, ...claudeaiConfigs }
      const counts = {
        enterprise: 0,
        global: 0,
        project: 0,
        user: 0,
        plugin: 0,
        claudeai: 0,
      }
      // Ant-only: 收集 stdio 命令的 basename，以便与 RSS/FPS 指标关联。
      // 像 rust-analyzer 这样的 stdio 服务器可能消耗较大，我们想知道
      // 哪些与会话性能问题相关联。
      const stdioCommands: string[] = []
      for (const [name, serverConfig] of Object.entries(allConfigs)) {
        if (serverConfig.scope === 'enterprise') counts.enterprise++
        else if (serverConfig.scope === 'user') counts.global++
        else if (serverConfig.scope === 'project') counts.project++
        else if (serverConfig.scope === 'local') counts.user++
        else if (serverConfig.scope === 'dynamic') counts.plugin++
        else if (serverConfig.scope === 'claudeai') counts.claudeai++

        if (
          process.env.USER_TYPE === 'ant' &&
          !isMcpServerDisabled(name) &&
          (serverConfig.type === undefined || serverConfig.type === 'stdio') &&
          'command' in serverConfig
        ) {
          stdioCommands.push(basename(serverConfig.command))
        }
      }
      logEvent('tengu_mcp_servers', {
        ...counts,
        ...(process.env.USER_TYPE === 'ant' && stdioCommands.length > 0
          ? {
              stdio_commands: stdioCommands
                .sort()
                .join(
                  ',',
                ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            }
          : {}),
      })
    }

    void loadAndConnectMcpConfigs()

    return () => {
      cancelled = true
    }
  }, [
    isStrictMcpConfig,
    dynamicMcpConfig,
    onConnectionAttempt,
    setAppState,
    _authVersion,
    sessionId,
    _pluginReconnectKey,
  ])

  // 卸载时清理所有定时器
  useEffect(() => {
    const timers = reconnectTimersRef.current
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer)
      }
      timers.clear()
      // 在卸载前刷新任何待处理的批量 MCP 更新
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
        flushPendingUpdates()
      }
    }
  }, [flushPendingUpdates])

  // 暴露 reconnectMcpServer 函数供组件使用。
  // 通过 store.getState() 读取 mcp.clients，使此回调在客户端状态
  // 转换时保持稳定（无需在每次连接时重新创建）。
  const reconnectMcpServer = useCallback(
    async (serverName: string) => {
      const client = store
        .getState()
        .mcp.clients.find(c => c.name === serverName)
      if (!client) {
        throw new Error(`MCP server ${serverName} not found`)
      }

      // 取消任何待处理的自动重连尝试
      const existingTimer = reconnectTimersRef.current.get(serverName)
      if (existingTimer) {
        clearTimeout(existingTimer)
        reconnectTimersRef.current.delete(serverName)
      }

      const result = await reconnectMcpServerImpl(serverName, client.config)

      onConnectionAttempt(result)

      // 不要抛出异常，让 UI 处理客户端类型以应对重连失败的情况
      // （详细日志可通过 --debug 在 reconnectMcpServerImpl 中查看）
      return result
    },
    [store, onConnectionAttempt],
  )

  // 暴露函数以切换服务器的启用/禁用状态
  const toggleMcpServer = useCallback(
    async (serverName: string): Promise<void> => {
      const client = store
        .getState()
        .mcp.clients.find(c => c.name === serverName)
      if (!client) {
        throw new Error(`MCP server ${serverName} not found`)
      }

      const isCurrentlyDisabled = client.type === 'disabled'

      if (!isCurrentlyDisabled) {
        // 取消任何待处理的自动重连尝试
        const existingTimer = reconnectTimersRef.current.get(serverName)
        if (existingTimer) {
          clearTimeout(existingTimer)
          reconnectTimersRef.current.delete(serverName)
        }

        // 先清除缓存前，先将禁用状态持久化到磁盘
        // 这一点很重要，因为 onclose 处理程序会检查磁盘状态
        setMcpServerEnabled(serverName, false)

        // 禁用：如果当前已连接，则断开连接并清理
        if (client.type === 'connected') {
          await clearServerCache(serverName, client.config)
        }

        // 更新为禁用状态（工具/命令/资源会自动清除）
        updateServer({
          name: serverName,
          type: 'disabled',
          config: client.config,
        })
      } else {
        // 启用：先将启用状态持久化到磁盘
        setMcpServerEnabled(serverName, true)

        // 标记为 pending 并重新连接
        updateServer({
          name: serverName,
          type: 'pending',
          config: client.config,
        })

        // 重新连接服务器
        const result = await reconnectMcpServerImpl(serverName, client.config)

        onConnectionAttempt(result)
      }
    },
    [store, updateServer, onConnectionAttempt],
  )

  return { reconnectMcpServer, toggleMcpServer }
}

function getTransportDisplayName(type: string): string {
  switch (type) {
    case 'http':
      return 'HTTP'
    case 'ws':
    case 'ws-ide':
      return 'WebSocket'
    default:
      return 'SSE'
  }
}
