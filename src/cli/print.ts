// biome-ignore-all assist/source/organizeImports: ANT-ONLY 的 import 标记不可重新排序
import { feature } from 'bun:bundle'
import { readFile, stat } from 'fs/promises'
import { dirname } from 'path'
import {
  downloadUserSettings,
  redownloadUserSettings,
} from 'src/services/settingsSync/index.js'
import { waitForRemoteManagedSettingsToLoad } from 'src/services/remoteManagedSettings/index.js'
import { StructuredIO } from 'src/cli/structuredIO.js'
import { RemoteIO } from 'src/cli/remoteIO.js'
import {
  type Command,
  formatDescriptionWithSource,
  getCommandName,
} from 'src/commands.js'
import { createStreamlinedTransformer } from 'src/utils/streamlinedTransform.js'
import { installStreamJsonStdoutGuard } from 'src/utils/streamJsonStdoutGuard.js'
import type { ToolPermissionContext } from 'src/Tool.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'
import { assembleToolPool, filterToolsByDenyRules } from 'src/tools.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { uniq } from 'src/utils/array.js'
import { mergeAndFilterTools } from 'src/utils/toolPool.js'
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { logForDebugging } from 'src/utils/debug.js'
import {
  logForDiagnosticsNoPII,
  withDiagnosticsTiming,
} from 'src/utils/diagLogs.js'
import { toolMatchesName, type Tool, type Tools } from 'src/Tool.js'
import {
  type AgentDefinition,
  isBuiltInAgent,
  parseAgentsFromJson,
} from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import type { Message, NormalizedUserMessage } from 'src/types/message.js'
import type { QueuedCommand } from 'src/types/textInputTypes.js'
import {
  dequeue,
  dequeueAllMatching,
  enqueue,
  hasCommandsInQueue,
  peek,
  subscribeToCommandQueue,
  getCommandsByMaxPriority,
} from 'src/utils/messageQueueManager.js'
import { notifyCommandLifecycle } from 'src/utils/commandLifecycle.js'
import {
  getSessionState,
  notifySessionStateChanged,
  notifySessionMetadataChanged,
  setPermissionModeChangedListener,
  type RequiresActionDetails,
  type SessionExternalMetadata,
} from 'src/utils/sessionState.js'
import { externalMetadataToAppState } from 'src/state/onChangeAppState.js'
import { getInMemoryErrors, logError, logMCPDebug } from 'src/utils/log.js'
import {
  writeToStdout,
  registerProcessOutputErrorHandlers,
} from 'src/utils/process.js'
import type { Stream } from 'src/utils/stream.js'
import { EMPTY_USAGE } from '@ant/model-provider'
import {
  loadConversationForResume,
  type TurnInterruptionState,
} from 'src/utils/conversationRecovery.js'
import type {
  MCPServerConnection,
  McpSdkServerConfig,
  ScopedMcpServerConfig,
} from 'src/services/mcp/types.js'
import {
  ChannelMessageNotificationSchema,
  gateChannelServer,
  wrapChannelMessage,
  findChannelEntry,
} from 'src/services/mcp/channelNotification.js'
import {
  isChannelAllowlisted,
  isChannelsEnabled,
} from 'src/services/mcp/channelAllowlist.js'
import { parsePluginIdentifier } from 'src/utils/plugins/pluginIdentifier.js'
import { validateUuid } from 'src/utils/uuid.js'
import { fromArray } from 'src/utils/generators.js'
import { ask } from 'src/QueryEngine.js'
import type { PermissionPromptTool } from 'src/utils/queryHelpers.js'
import {
  createFileStateCacheWithSizeLimit,
  mergeFileStateCaches,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/utils/fileStateCache.js'
import { expandPath } from 'src/utils/path.js'
import { extractReadFilesFromMessages } from 'src/utils/queryHelpers.js'
import { registerHookEventHandler } from 'src/utils/hooks/hookEvents.js'
import { executeFilePersistence } from 'src/utils/filePersistence/filePersistence.js'
import { finalizePendingAsyncHooks } from 'src/utils/hooks/AsyncHookRegistry.js'
import {
  gracefulShutdown,
  gracefulShutdownSync,
  isShuttingDown,
} from 'src/utils/gracefulShutdown.js'
import { registerCleanup } from 'src/utils/cleanupRegistry.js'
import { createIdleTimeoutManager } from 'src/utils/idleTimeout.js'
import type {
  SDKStatus,
  ModelInfo,
  SDKMessage,
  SDKUserMessage,
  PermissionResult,
  McpServerConfigForProcessTransport,
  McpServerStatus,
  RewindFilesResult,
} from 'src/entrypoints/agentSdkTypes.js'
import type {
  StdoutMessage,
  SDKControlInitializeRequest,
  SDKControlInitializeResponse,
  SDKControlRequest,
  SDKControlResponse,
  SDKControlMcpSetServersResponse,
  SDKControlReloadPluginsResponse,
} from 'src/entrypoints/sdk/controlTypes.js'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionMode as InternalPermissionMode } from 'src/types/permissions.js'
import { cwd } from 'process'
import { getCwd } from 'src/utils/cwd.js'
import omit from 'lodash-es/omit.js'
import reject from 'lodash-es/reject.js'
import { isPolicyAllowed } from 'src/services/policyLimits/index.js'
import type { ReplBridgeHandle } from 'src/bridge/replBridge.js'
import { getRemoteSessionUrl } from 'src/constants/product.js'
import { buildBridgeConnectUrl } from 'src/bridge/bridgeStatusUtil.js'
import { extractInboundMessageFields } from 'src/bridge/inboundMessages.js'
import { resolveAndPrepend } from 'src/bridge/inboundAttachments.js'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import { hasPermissionsToUseTool } from 'src/utils/permissions/permissions.js'
import { safeParseJSON } from 'src/utils/json.js'
import {
  outputSchema as permissionToolOutputSchema,
  permissionPromptToolResultToPermissionDecision,
} from 'src/utils/permissions/PermissionPromptToolResultSchema.js'
import { createAbortController } from 'src/utils/abortController.js'
import { createCombinedAbortSignal } from 'src/utils/combinedAbortSignal.js'
import { generateSessionTitle } from 'src/utils/sessionTitle.js'
import { buildSideQuestionFallbackParams } from 'src/utils/queryContext.js'
import { runSideQuestion } from 'src/utils/sideQuestion.js'
import {
  processSessionStartHooks,
  processSetupHooks,
  takeInitialUserMessage,
} from 'src/utils/sessionStart.js'
import {
  DEFAULT_OUTPUT_STYLE_NAME,
  getAllOutputStyles,
} from 'src/constants/outputStyles.js'
import { TEAMMATE_MESSAGE_TAG, TICK_TAG } from 'src/constants/xml.js'
import {
  getSettings_DEPRECATED,
  getSettingsWithSources,
} from 'src/utils/settings/settings.js'
import { settingsChangeDetector } from 'src/utils/settings/changeDetector.js'
import { applySettingsChange } from 'src/utils/settings/applySettingsChange.js'
import {
  isFastModeAvailable,
  isFastModeEnabled,
  isFastModeSupportedByModel,
  getFastModeState,
} from 'src/utils/fastMode.js'
import {
  isAutoModeGateEnabled,
  getAutoModeUnavailableNotification,
  getAutoModeUnavailableReason,
  isBypassPermissionsModeDisabled,
  transitionPermissionMode,
} from 'src/utils/permissions/permissionSetup.js'
import {
  tryGenerateSuggestion,
  logSuggestionOutcome,
  logSuggestionSuppressed,
  type PromptVariant,
} from 'src/services/PromptSuggestion/promptSuggestion.js'
import { getLastCacheSafeParams } from 'src/utils/forkedAgent.js'
import { getAccountInformation } from 'src/utils/auth.js'
import { OAuthService } from 'src/services/oauth/index.js'
import { installOAuthTokens } from 'src/cli/handlers/auth.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import type { HookCallbackMatcher } from 'src/types/hooks.js'
import { AwsAuthStatusManager } from 'src/utils/awsAuthStatusManager.js'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import {
  registerHookCallbacks,
  setInitJsonSchema,
  getInitJsonSchema,
  setSdkAgentProgressSummariesEnabled,
} from 'src/bootstrap/state.js'
import { createSyntheticOutputTool } from '@claude-code-best/builtin-tools/tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { parseSessionIdentifier } from 'src/utils/sessionUrl.js'
import {
  hydrateRemoteSession,
  hydrateFromCCRv2InternalEvents,
  resetSessionFilePointer,
  doesMessageExistInSession,
  findUnresolvedToolUse,
  recordAttributionSnapshot,
  saveAgentSetting,
  saveMode,
  saveAiGeneratedTitle,
  restoreSessionMetadata,
} from 'src/utils/sessionStorage.js'
import { incrementPromptCount } from 'src/utils/commitAttribution.js'
import {
  setupSdkMcpClients,
  connectToServer,
  clearServerCache,
  fetchToolsForClient,
  areMcpConfigsEqual,
  reconnectMcpServerImpl,
} from 'src/services/mcp/client.js'
import {
  filterMcpServersByPolicy,
  getMcpConfigByName,
  isMcpServerDisabled,
  setMcpServerEnabled,
} from 'src/services/mcp/config.js'
import {
  performMCPOAuthFlow,
  revokeServerTokens,
} from 'src/services/mcp/auth.js'
import {
  runElicitationHooks,
  runElicitationResultHooks,
} from 'src/services/mcp/elicitationHandler.js'
import { executeNotificationHooks } from 'src/utils/hooks.js'
import {
  ElicitRequestSchema,
  ElicitationCompleteNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { getMcpPrefix } from 'src/services/mcp/mcpStringUtils.js'
import {
  commandBelongsToServer,
  filterToolsByServer,
} from 'src/services/mcp/utils.js'
import { setupVscodeSdkMcp } from 'src/services/mcp/vscodeSdkMcp.js'
import { getAllMcpConfigs } from 'src/services/mcp/config.js'
import {
  isQualifiedForGrove,
  checkGroveForNonInteractive,
} from 'src/services/api/grove.js'
import {
  toInternalMessages,
  toSDKRateLimitInfo,
} from 'src/utils/messages/mappers.js'
import { createModelSwitchBreadcrumbs } from 'src/utils/messages.js'
import { collectContextData } from 'src/commands/context/context-noninteractive.js'
import { LOCAL_COMMAND_STDOUT_TAG } from 'src/constants/xml.js'
import {
  statusListeners,
  type ClaudeAILimits,
} from 'src/services/claudeAiLimits.js'
import {
  getDefaultMainLoopModel,
  getMainLoopModel,
  modelDisplayString,
  parseUserSpecifiedModel,
} from 'src/utils/model/model.js'
import { getModelOptions } from 'src/utils/model/modelOptions.js'
import {
  modelSupportsEffort,
  modelSupportsMaxEffort,
  EFFORT_LEVELS,
  resolveAppliedEffort,
} from 'src/utils/effort.js'
import { modelSupportsAdaptiveThinking } from 'src/utils/thinking.js'
import { modelSupportsAutoMode } from 'src/utils/betas.js'
import { ensureModelStringsInitialized } from 'src/utils/model/modelStrings.js'
import {
  getSessionId,
  setMainLoopModelOverride,
  setMainThreadAgentType,
  switchSession,
  isSessionPersistenceDisabled,
  getIsRemoteMode,
  getFlagSettingsInline,
  setFlagSettingsInline,
  getMainThreadAgentType,
  getAllowedChannels,
  setAllowedChannels,
  type ChannelEntry,
} from 'src/bootstrap/state.js'
import { runWithWorkload, WORKLOAD_CRON } from 'src/utils/workloadContext.js'
import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { AppState } from 'src/state/AppStateStore.js'
import {
  fileHistoryRewind,
  fileHistoryCanRestore,
  fileHistoryEnabled,
  fileHistoryGetDiffStats,
} from 'src/utils/fileHistory.js'
import {
  restoreAgentFromSession,
  restoreSessionStateFromLog,
} from 'src/utils/sessionRestore.js'
import { SandboxManager } from 'src/utils/sandbox/sandbox-adapter.js'
import {
  headlessProfilerStartTurn,
  headlessProfilerCheckpoint,
  logHeadlessProfilerTurn,
} from 'src/utils/headlessProfiler.js'
import {
  startQueryProfile,
  logQueryProfileReport,
} from 'src/utils/queryProfiler.js'
import { asSessionId } from 'src/types/ids.js'
import {
  createAutonomyQueuedPromptIfNoActiveSource,
  createProactiveAutonomyCommands,
  markAutonomyRunFailed,
} from 'src/utils/autonomyRuns.js'
import {
  cancelQueuedAutonomyCommands,
  claimConsumableQueuedAutonomyCommands,
  finalizeAutonomyCommandsForTurn,
} from 'src/utils/autonomyQueueLifecycle.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { skillChangeDetector } from '../utils/skills/skillChangeDetector.js'
import { getCommands, clearCommandsCache } from '../commands.js'
import {
  isBareMode,
  isEnvTruthy,
  isEnvDefinedFalsy,
} from '../utils/envUtils.js'
import { installPluginsForHeadless } from '../utils/plugins/headlessPluginInstall.js'
import { refreshActivePlugins } from '../utils/plugins/refresh.js'
import { loadAllPluginsCacheOnly } from '../utils/plugins/pluginLoader.js'
import {
  isTeamLead,
  hasActiveInProcessTeammates,
  hasWorkingInProcessTeammates,
  waitForTeammatesToBecomeIdle,
} from '../utils/teammate.js'
import {
  readUnreadMessages,
  markMessagesAsRead,
  isShutdownApproved,
} from '../utils/teammateMailbox.js'
import { removeTeammateFromTeamFile } from '../utils/swarm/teamHelpers.js'
import { unassignTeammateTasks } from '../utils/tasks.js'
import { getRunningTasks } from '../utils/task/framework.js'
import { isBackgroundTask } from '../tasks/types.js'
import { stopTask } from '../tasks/stopTask.js'
import { drainSdkEvents } from '../utils/sdkEventQueue.js'
import { initializeGrowthBook } from '../services/analytics/growthbook.js'
import { errorMessage, toError } from '../utils/errors.js'
import { sleep } from '../utils/sleep.js'
import { isExtractModeActive } from '../memdir/paths.js'

// 死代码消除：条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js'))
  : null
const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? (require('../proactive/index.js') as typeof import('../proactive/index.js'))
    : null
const cronSchedulerModule =
  require('../utils/cronScheduler.js') as typeof import('../utils/cronScheduler.js')
const cronJitterConfigModule =
  require('../utils/cronJitterConfig.js') as typeof import('../utils/cronJitterConfig.js')
const cronGate =
  require('@claude-code-best/builtin-tools/tools/ScheduleCronTool/prompt.js') as typeof import('@claude-code-best/builtin-tools/tools/ScheduleCronTool/prompt.js')
/* eslint-enable @typescript-eslint/no-require-imports */

const SHUTDOWN_TEAM_PROMPT = `<system-reminder>
You are running in non-interactive mode and cannot return a response to the user until your team is shut down.

You MUST shut down your team before preparing your final response:
1. Use requestShutdown to ask each team member to shut down gracefully
2. Wait for shutdown approvals
3. Use the cleanup operation to clean up the team
4. Only then provide your final response to the user

The user cannot receive your response until the team is completely shut down.
</system-reminder>

Shut down your team and prepare your final response for the user.`

// 跟踪当前会话运行期间收到的消息 UUID
const MAX_RECEIVED_UUIDS = 10_000
const receivedMessageUuids = new Set<UUID>()
const receivedMessageUuidsOrder: UUID[] = []

function trackReceivedMessageUuid(uuid: UUID): boolean {
  if (receivedMessageUuids.has(uuid)) {
    return false // 重复
  }
  receivedMessageUuids.add(uuid)
  receivedMessageUuidsOrder.push(uuid)
  // 容量满时淘汰最早的条目
  if (receivedMessageUuidsOrder.length > MAX_RECEIVED_UUIDS) {
    const toEvict = receivedMessageUuidsOrder.splice(
      0,
      receivedMessageUuidsOrder.length - MAX_RECEIVED_UUIDS,
    )
    for (const old of toEvict) {
      receivedMessageUuids.delete(old)
    }
  }
  return true // 新 UUID
}

type PromptValue = string | ContentBlockParam[]

function toBlocks(v: PromptValue): ContentBlockParam[] {
  return typeof v === 'string' ? [{ type: 'text', text: v }] : v
}

/**
 * 将多个排队命令的 prompt 值合并为一个。字符串会以换行符拼接；
 * 若任一值为 block 数组，则所有值都会归一化为 block 并拼接。
 */
export function joinPromptValues(values: PromptValue[]): PromptValue {
  if (values.length === 1) return values[0]!
  if (values.every(v => typeof v === 'string')) {
    return values.join('\n')
  }
  return values.flatMap(toBlocks)
}

/**
 * `next` 是否可以与 `head` 合并到同一次 ask() 调用中。只有 prompt 模式的
 * 命令才会合并，并且仅当 workload 标签匹配（以确保合并后的回合被正确归因）
 * 以及 isMeta 标志匹配（防止主动触发 tick 合并到用户 prompt 中，从而在 head
 * 被铺开到合并后的命令上时丢失其在 transcript 中的隐藏标记）时才会合并。
 */
export function canBatchWith(
  head: QueuedCommand,
  next: QueuedCommand | undefined,
): boolean {
  return (
    next !== undefined &&
    next.mode === 'prompt' &&
    next.workload === head.workload &&
    next.isMeta === head.isMeta
  )
}

export async function runHeadless(
  inputPrompt: string | AsyncIterable<string>,
  getAppState: () => AppState,
  setAppState: (f: (prev: AppState) => AppState) => void,
  commands: Command[],
  tools: Tools,
  sdkMcpConfigs: Record<string, McpSdkServerConfig>,
  agents: AgentDefinition[],
  options: {
    continue: boolean | undefined
    resume: string | boolean | undefined
    resumeSessionAt: string | undefined
    verbose: boolean | undefined
    outputFormat: string | undefined
    jsonSchema: Record<string, unknown> | undefined
    permissionPromptToolName: string | undefined
    allowedTools: string[] | undefined
    thinkingConfig: ThinkingConfig | undefined
    maxTurns: number | undefined
    maxBudgetUsd: number | undefined
    taskBudget: { total: number } | undefined
    systemPrompt: string | undefined
    appendSystemPrompt: string | undefined
    userSpecifiedModel: string | undefined
    fallbackModel: string | undefined
    teleport: string | true | null | undefined
    sdkUrl: string | undefined
    replayUserMessages: boolean | undefined
    includePartialMessages: boolean | undefined
    forkSession: boolean | undefined
    rewindFiles: string | undefined
    enableAuthStatus: boolean | undefined
    agent: string | undefined
    workload: string | undefined
    setupTrigger?: 'init' | 'maintenance' | undefined
    sessionStartHooksPromise?: ReturnType<typeof processSessionStartHooks>
    setSDKStatus?: (status: SDKStatus) => void
  },
): Promise<void> {
  const promptDesc =
    typeof inputPrompt === 'string'
      ? `string(len=${inputPrompt.length})`
      : 'AsyncIterable'
  logForDebugging(
    `[Hapii] runHeadless 入口 prompt=${promptDesc} outputFormat=${options.outputFormat} tools=${tools.length}`,
    { level: 'info' },
  )
  if (
    process.env.USER_TYPE === 'ant' &&
    isEnvTruthy(process.env.CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER)
  ) {
    process.stderr.write(
      `\nStartup time: ${Math.round(process.uptime() * 1000)}ms\n`,
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  }

  // 现在触发用户设置下载，使其与下面的 MCP/工具设置并行进行。
  // 托管设置已经在 main.tsx 的 preAction 中启动；此处让用户设置也能获得类似的
  // 提前启动机会。缓存的 promise 会在 installPluginsAndApplyMcpInBackground
  // 读取 enabledPlugins 进行插件安装之前被 join。
  if (
    feature('DOWNLOAD_USER_SETTINGS') &&
    (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) || getIsRemoteMode())
  ) {
    void downloadUserSettings()
  }

  // 在 headless 模式下没有 React 树，因此 useSettingsChange hook 永远不会
  // 执行。直接订阅，确保设置变更（包括 managed-settings / 策略更新）被完整应用。
  settingsChangeDetector.subscribe(source => {
    applySettingsChange(source, setAppState)

    // 在 headless 模式下，还需从设置同步反规范化的 fastMode 字段。
    // TUI 通过 UI 管理 fastMode，因此会跳过此步骤。
    if (isFastModeEnabled()) {
      setAppState(prev => {
        const s = prev.settings as Record<string, unknown>
        const fastMode = s.fastMode === true && !s.fastModePerSessionOptIn
        return { ...prev, fastMode }
      })
    }
  })

  // 主动激活现在已在 main.tsx 的 getTools() 之前处理，以便 SleepTool 能通过
  // isEnabled() 过滤。此回退逻辑用于处理 CLAUDE_CODE_PROACTIVE 已设置但
  // main.tsx 的检查未触发的情况（例如：argv 解析之后环境变量由 SDK transport 注入）。
  if (
    (feature('PROACTIVE') || feature('KAIROS')) &&
    proactiveModule &&
    !proactiveModule.isProactiveActive() &&
    isEnvTruthy(process.env.CLAUDE_CODE_PROACTIVE)
  ) {
    proactiveModule.activateProactive('command')
  }

  // 定期运行 GC 以控制内存使用。
  // 当 RSS 超过 350MB 时通过内存阈值触发一次强制（major）GC —— 增量 GC
  // 在峰值期间（大量 DOM 节点挂载的紧凑长会话）可能回收不够。
  if (typeof Bun !== 'undefined') {
    const gcTimer = setInterval(() => {
      const rss = process.memoryUsage.rss()
      if (rss > 350 * 1024 * 1024) {
        Bun.gc(true)
      } else {
        Bun.gc(false)
      }
    }, 1000)
    gcTimer.unref()
  }

  // 为第一个回合启动 headless profiler
  headlessProfilerStartTurn()
  headlessProfilerCheckpoint('runHeadless_entry')

  // 检查非交互式消费者订阅方的 Grove 要求
  if (await isQualifiedForGrove()) {
    await checkGroveForNonInteractive()
  }
  headlessProfilerCheckpoint('after_grove_check')

  // 初始化 GrowthBook，使 feature flag 在 headless 模式下生效。
  // 否则磁盘缓存为空，所有 flag 都会回退到默认值。
  void initializeGrowthBook()

  if (options.resumeSessionAt && !options.resume) {
    process.stderr.write(`Error: --resume-session-at requires --resume\n`)
    gracefulShutdownSync(1)
    return
  }

  if (options.rewindFiles && !options.resume) {
    process.stderr.write(`Error: --rewind-files requires --resume\n`)
    gracefulShutdownSync(1)
    return
  }

  if (options.rewindFiles && inputPrompt) {
    process.stderr.write(
      `Error: --rewind-files is a standalone operation and cannot be used with a prompt\n`,
    )
    gracefulShutdownSync(1)
    return
  }

  const structuredIO = getStructuredIO(inputPrompt, options)

  // 在为 SDK 客户端输出 NDJSON 时，任何对 stdout 的杂散写入（调试打印、
  // 依赖的 console.log、库的横幅）都会破坏客户端逐行解析 JSON 的逻辑。
  // 安装一个守卫，将非 JSON 行重定向到 stderr，以保持输出流干净。必须在
  // 下面第一次 structuredIO.write 之前执行。
  if (options.outputFormat === 'stream-json') {
    installStreamJsonStdoutGuard()
  }

  // #34044: 如果用户显式设置了 sandbox.enabled=true 但依赖缺失，
  // isSandboxingEnabled() 会静默返回 false。此处显式暴露原因，让用户知道
  // 他们的安全配置没有被强制执行。
  const sandboxUnavailableReason = SandboxManager.getSandboxUnavailableReason()
  if (sandboxUnavailableReason) {
    if (SandboxManager.isSandboxRequired()) {
      process.stderr.write(
        `\nError: sandbox required but unavailable: ${sandboxUnavailableReason}\n` +
          `  sandbox.failIfUnavailable is set — refusing to start without a working sandbox.\n\n`,
      )
      gracefulShutdownSync(1)
      return
    }
    process.stderr.write(
      `\n⚠ Sandbox disabled: ${sandboxUnavailableReason}\n` +
        `  Commands will run WITHOUT sandboxing. Network and filesystem restrictions will NOT be enforced.\n\n`,
    )
  } else if (SandboxManager.isSandboxingEnabled()) {
    // 用一个回调初始化 sandbox，该回调通过 can_use_tool control_request
    // 协议将网络权限请求转发给 SDK 宿主。必须发生在 structuredIO 创建之后，
    // 以便我们能够发送请求。
    try {
      await SandboxManager.initialize(structuredIO.createSandboxAskCallback())
    } catch (err) {
      process.stderr.write(`\n❌ Sandbox Error: ${errorMessage(err)}\n`)
      gracefulShutdownSync(1, 'other')
      return
    }
  }

  if (options.outputFormat === 'stream-json' && options.verbose) {
    registerHookEventHandler(event => {
      const message: StdoutMessage = (() => {
        switch (event.type) {
          case 'started':
            return {
              type: 'system' as const,
              subtype: 'hook_started' as const,
              hook_id: event.hookId,
              hook_name: event.hookName,
              hook_event: event.hookEvent,
              uuid: randomUUID(),
              session_id: getSessionId(),
            }
          case 'progress':
            return {
              type: 'system' as const,
              subtype: 'hook_progress' as const,
              hook_id: event.hookId,
              hook_name: event.hookName,
              hook_event: event.hookEvent,
              stdout: event.stdout,
              stderr: event.stderr,
              output: event.output,
              uuid: randomUUID(),
              session_id: getSessionId(),
            }
          case 'response':
            return {
              type: 'system' as const,
              subtype: 'hook_response' as const,
              hook_id: event.hookId,
              hook_name: event.hookName,
              hook_event: event.hookEvent,
              output: event.output,
              stdout: event.stdout,
              stderr: event.stderr,
              exit_code: event.exitCode,
              outcome: event.outcome,
              uuid: randomUUID(),
              session_id: getSessionId(),
            }
        }
      })()
      void structuredIO.write(message)
    })
  }

  if (options.setupTrigger) {
    await processSetupHooks(options.setupTrigger)
  }

  headlessProfilerCheckpoint('before_loadInitialMessages')
  const appState = getAppState()
  const {
    messages: initialMessages,
    turnInterruptionState,
    agentSetting: resumedAgentSetting,
  } = await loadInitialMessages(setAppState, {
    continue: options.continue,
    teleport: options.teleport,
    resume: options.resume,
    resumeSessionAt: options.resumeSessionAt,
    forkSession: options.forkSession,
    outputFormat: options.outputFormat,
    sessionStartHooksPromise: options.sessionStartHooksPromise,
    restoredWorkerState: structuredIO.restoredWorkerState,
  })

  // SessionStart hook 可能输出 initialUserMessage —— 即 headless 编排会话的
  // 第一个用户回合。在 stdin 为空的情况下，仅靠 additionalContext（是一个附件，
  // 不是回合）会让 REPL 无内容可响应。该 hook 的 promise 在 loadInitialMessages
  // 内部被 await，因此到达此处时模块级的 pending 值已被设置。
  const hookInitialUserMessage = takeInitialUserMessage()
  if (hookInitialUserMessage) {
    structuredIO.prependUserMessage(hookInitialUserMessage)
  }

  // 从已恢复的会话中还原 agent 设置（除非当前 --agent 标志或基于设置的 agent
  // 已覆盖，这两者都会在 main.tsx 中设置 mainThreadAgentType）
  if (!options.agent && !getMainThreadAgentType() && resumedAgentSetting) {
    const { agentDefinition: restoredAgent } = restoreAgentFromSession(
      resumedAgentSetting,
      undefined,
      { activeAgents: agents, allAgents: agents },
    )
    if (restoredAgent) {
      setAppState(prev => ({ ...prev, agent: restoredAgent.agentType }))
      // 对非内置 agent 应用其 system prompt（与 main.tsx 初始 --agent 路径一致）
      if (!options.systemPrompt && !isBuiltInAgent(restoredAgent)) {
        const agentSystemPrompt = restoredAgent.getSystemPrompt()
        if (agentSystemPrompt) {
          options.systemPrompt = agentSystemPrompt
        }
      }
      // 重新持久化 agent 设置，以便未来 resume 仍能保留该 agent
      saveAgentSetting(restoredAgent.agentType)
    }
  }

  // gracefulShutdownSync 会调度一个异步关闭流程并设置 process.exitCode。
  // 如果 loadInitialMessages 的错误路径已经触发了它，提前退出以避免进程
  // 收尾期间进行不必要的工作。
  if (initialMessages.length === 0 && process.exitCode !== undefined) {
    return
  }

  // 处理 --rewind-files：还原文件系统并立即退出
  if (options.rewindFiles) {
    // 文件历史快照仅针对用户消息创建，
    // 因此要求目标必须是用户消息
    const targetMessage = initialMessages.find(
      m => m.uuid === options.rewindFiles,
    )

    if (!targetMessage || targetMessage.type !== 'user') {
      process.stderr.write(
        `Error: --rewind-files requires a user message UUID, but ${options.rewindFiles} is not a user message in this session\n`,
      )
      gracefulShutdownSync(1)
      return
    }

    const currentAppState = getAppState()
    const result = await handleRewindFiles(
      options.rewindFiles as UUID,
      currentAppState,
      setAppState,
      false,
    )
    if (!result.canRewind) {
      process.stderr.write(`Error: ${result.error || 'Unexpected error'}\n`)
      gracefulShutdownSync(1)
      return
    }

    // Rewind 完成 - 成功退出
    process.stdout.write(
      `Files rewound to state at message ${options.rewindFiles}\n`,
    )
    gracefulShutdownSync(0)
    return
  }

  // 检查是否需要输入 prompt —— 当通过有效的 session ID/JSONL 文件 resume 或使用 SDK URL 时跳过
  const hasValidResumeSessionId =
    typeof options.resume === 'string' &&
    (Boolean(validateUuid(options.resume)) || options.resume.endsWith('.jsonl'))
  const isUsingSdkUrl = Boolean(options.sdkUrl)

  if (!inputPrompt && !hasValidResumeSessionId && !isUsingSdkUrl) {
    process.stderr.write(
      `Error: Input must be provided either through stdin or as a prompt argument when using --print\n`,
    )
    gracefulShutdownSync(1)
    return
  }

  if (options.outputFormat === 'stream-json' && !options.verbose) {
    process.stderr.write(
      'Error: When using --print, --output-format=stream-json requires --verbose\n',
    )
    gracefulShutdownSync(1)
    return
  }

  // 过滤掉位于拒绝列表中的 MCP 工具
  const allowedMcpTools = filterToolsByDenyRules(
    appState.mcp.tools,
    appState.toolPermissionContext,
  )
  let filteredTools = [...tools, ...allowedMcpTools]

  // 使用 SDK URL 时，始终使用 stdio 权限提示，将其委托给 SDK
  const effectivePermissionPromptToolName = options.sdkUrl
    ? 'stdio'
    : options.permissionPromptToolName

  // 权限提示展示时的回调
  const onPermissionPrompt = (details: RequiresActionDetails) => {
    if (feature('COMMIT_ATTRIBUTION')) {
      setAppState(prev => ({
        ...prev,
        attribution: {
          ...prev.attribution,
          permissionPromptCount: prev.attribution.permissionPromptCount + 1,
        },
      }))
    }
    notifySessionStateChanged('requires_action', details)
  }

  const canUseTool = getCanUseToolFn(
    effectivePermissionPromptToolName,
    structuredIO,
    () => getAppState().mcp.tools,
    onPermissionPrompt,
  )
  if (options.permissionPromptToolName) {
    // 从可用工具列表中移除权限提示工具。
    filteredTools = filteredTools.filter(
      tool => !toolMatchesName(tool, options.permissionPromptToolName!),
    )
  }

  // 安装错误处理器以优雅处理 broken pipe（例如：父进程死亡时）
  registerProcessOutputErrorHandlers()

  headlessProfilerCheckpoint('after_loadInitialMessages')

  // 确保在生成模型选项前完成 model 字符串初始化。
  // 对 Bedrock 用户，这会等待 profile 拉取以获得正确的 region 字符串。
  await ensureModelStringsInitialized()
  headlessProfilerCheckpoint('after_modelStrings')

  // UDS inbox store 的注册被推迟到 `run` 定义完成之后，
  // 以便把 `run` 作为 onEnqueue 回调传入（见下文）。

  // 只有 `json` + `verbose` 需要完整数组（见下方 jsonStringify(messages)）。
  // 对于 stream-json（SDK/CCR）和默认文本输出，只会读取最后一条消息用于
  // 退出码/最终结果。避免在整个会话期间把每条消息都累积到内存中。
  const needsFullArray = options.outputFormat === 'json' && options.verbose
  const messages: SDKMessage[] = []
  let lastMessage: SDKMessage | undefined
  // 简化模式会在 CLAUDE_CODE_STREAMLINED_OUTPUT=true 且使用 stream-json 时转换消息
  // Build flag 将其排除在外部构建之外；环境变量是 ant 构建的运行时开关
  const transformToStreamlined =
    feature('STREAMLINED_OUTPUT') &&
    isEnvTruthy(process.env.CLAUDE_CODE_STREAMLINED_OUTPUT) &&
    options.outputFormat === 'stream-json'
      ? createStreamlinedTransformer()
      : null

  headlessProfilerCheckpoint('before_runHeadlessStreaming')
  logForDebugging(
    `[Hapii] runHeadless 开始流式处理 filteredTools=${filteredTools.length} initialMessages=${initialMessages.length}`,
    { level: 'info' },
  )
  for await (const message of runHeadlessStreaming(
    structuredIO,
    appState.mcp.clients,
    [...commands, ...appState.mcp.commands],
    filteredTools,
    initialMessages,
    canUseTool,
    sdkMcpConfigs,
    getAppState,
    setAppState,
    agents,
    options,
    turnInterruptionState,
  )) {
    if (transformToStreamlined) {
      // 简化模式：转换消息并立即流式输出
      const transformed = transformToStreamlined(message)
      if (transformed) {
        await structuredIO.write(transformed)
      }
    } else if (options.outputFormat === 'stream-json' && options.verbose) {
      await structuredIO.write(message)
    }
    // 非流式模式下不应收到 control 消息或 stream 事件。
    // 同时过滤掉 streamlined 类型，因为它们只由 transformer 产生。
    // SDK 专属的系统事件被排除，使 lastMessage 停留在 result
    // （即 session_state_changed(idle) 以及在 finally 块中 result 之后排空的
    // 任何延迟 task_notification）。
    if (
      message.type !== 'control_response' &&
      message.type !== 'control_request' &&
      message.type !== 'control_cancel_request' &&
      !(
        message.type === 'system' &&
        (message.subtype === 'session_state_changed' ||
          message.subtype === 'task_notification' ||
          message.subtype === 'task_started' ||
          message.subtype === 'task_progress' ||
          message.subtype === 'post_turn_summary')
      ) &&
      message.type !== 'stream_event' &&
      message.type !== 'keep_alive' &&
      message.type !== 'streamlined_text' &&
      message.type !== 'streamlined_tool_use_summary' &&
      message.type !== 'prompt_suggestion'
    ) {
      if (needsFullArray) {
        messages.push(message)
      }
      lastMessage = message
    }
  }

  logForDebugging(
    `[Hapii] runHeadless 输出格式决策 outputFormat=${options.outputFormat}`,
    { level: 'info' },
  )
  switch (options.outputFormat) {
    case 'json':
      if (!lastMessage || lastMessage.type !== 'result') {
        throw new Error('No messages returned')
      }
      if (options.verbose) {
        writeToStdout(jsonStringify(messages) + '\n')
        break
      }
      writeToStdout(jsonStringify(lastMessage) + '\n')
      break
    case 'stream-json':
      // 已在上方输出
      break
    default:
      if (!lastMessage || lastMessage.type !== 'result') {
        throw new Error('No messages returned')
      }
      switch (lastMessage.subtype) {
        case 'success':
          writeToStdout(
            (lastMessage.result as string).endsWith('\n')
              ? (lastMessage.result as string)
              : (lastMessage.result as string) + '\n',
          )
          break
        case 'error_during_execution':
          writeToStdout(`Execution error`)
          break
        case 'error_max_turns':
          writeToStdout(
            `Error: Reached max turns (${options.maxTurns}).\nTip: Increase the limit with --max-turns or continue in a new session.`,
          )
          break
        case 'error_max_budget_usd':
          writeToStdout(
            `Error: Exceeded USD budget ($${options.maxBudgetUsd}).\nTip: Increase the limit with --max-budget-usd or start a new session to continue.`,
          )
          break
        case 'error_max_structured_output_retries':
          writeToStdout(
            `Error: Failed to provide valid structured output after maximum retries.\nTip: Simplify your schema or check if the output format matches the expected structure.`,
          )
      }
  }

  // 记录最后一个回合的 headless 延迟指标
  logHeadlessProfilerTurn()

  // 在关闭之前排空仍在进行的 memory 提取。响应已经在上方刷出，因此不会
  // 增加用户可见的延迟 —— 只会延迟进程退出，避免 gracefulShutdownSync 的 5 秒
  // 兜底机制在 fork 出的 agent 进行中将其杀死。通过 isExtractModeActive 进行门控，
  // 使 tengu_slate_thimble flag 能端到端控制非交互式提取。
  if (feature('EXTRACT_MEMORIES') && isExtractModeActive()) {
    try {
      const { drainPendingExtraction } = await import(
        '../services/extractMemories/extractMemories.js'
      )
      await drainPendingExtraction()
    } catch {
      // 模块加载失败 —— 在关闭阶段属于非关键错误
    }
  }

  gracefulShutdownSync(
    lastMessage?.type === 'result' && lastMessage?.is_error ? 1 : 0,
  )
}

function runHeadlessStreaming(
  structuredIO: StructuredIO,
  mcpClients: MCPServerConnection[],
  commands: Command[],
  tools: Tools,
  initialMessages: Message[],
  canUseTool: CanUseToolFn,
  sdkMcpConfigs: Record<string, McpSdkServerConfig>,
  getAppState: () => AppState,
  setAppState: (f: (prev: AppState) => AppState) => void,
  agents: AgentDefinition[],
  options: {
    verbose: boolean | undefined
    jsonSchema: Record<string, unknown> | undefined
    permissionPromptToolName: string | undefined
    allowedTools: string[] | undefined
    thinkingConfig: ThinkingConfig | undefined
    maxTurns: number | undefined
    maxBudgetUsd: number | undefined
    taskBudget: { total: number } | undefined
    systemPrompt: string | undefined
    appendSystemPrompt: string | undefined
    userSpecifiedModel: string | undefined
    fallbackModel: string | undefined
    replayUserMessages?: boolean | undefined
    includePartialMessages?: boolean | undefined
    enableAuthStatus?: boolean | undefined
    agent?: string | undefined
    setSDKStatus?: (status: SDKStatus) => void
    promptSuggestions?: boolean | undefined
    workload?: string | undefined
  },
  turnInterruptionState?: TurnInterruptionState,
): AsyncIterable<StdoutMessage> {
  let running = false
  let runPhase:
    | 'draining_commands'
    | 'waiting_for_agents'
    | 'finally_flush'
    | 'finally_post_flush'
    | undefined
  let inputClosed = false
  let shutdownPromptInjected = false
  let heldBackResult: StdoutMessage | null = null
  let abortController: AbortController | undefined
  // 与 sendRequest() 入队时使用的同一个队列 —— 所有内容共用一个 FIFO。
  const output = structuredIO.outbound

  // -p 模式下的 Ctrl+C：中止进行中的 query，然后优雅关闭。
  // gracefulShutdown 会持久化会话状态并刷出分析数据，并带有兜底定时器，
  // 在清理卡住时强制退出。
  const sigintHandler = () => {
    logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGINT' })
    if (abortController && !abortController.signal.aborted) {
      abortController.abort()
    }
    void gracefulShutdown(0)
  }
  process.on('SIGINT', sigintHandler)

  // 在 SIGTERM 时导出 run() 的状态，以便卡住会话的 healthsweep 能在
  // 不读取 transcript 的情况下指出 do/while(waitingForAgents) 轮询。
  registerCleanup(async () => {
    const bg: Record<string, number> = {}
    for (const t of getRunningTasks(getAppState())) {
      if (isBackgroundTask(t)) bg[t.type] = (bg[t.type] ?? 0) + 1
    }
    logForDiagnosticsNoPII('info', 'run_state_at_shutdown', {
      run_active: running,
      run_phase: runPhase,
      worker_status: getSessionState(),
      internal_events_pending: structuredIO.internalEventsPending,
      bg_tasks: bg,
    })
  })

  // 将核心的 onChangeAppState 模式 diff hook 连接到 SDK 输出流。
  // 它会在任意代码路径修改 toolPermissionContext.mode 时触发 ——
  // Shift+Tab、ExitPlanMode 对话框、/plan 斜杠命令、rewind、bridge
  // set_permission_mode、query 循环、stop_task —— 而不像以前只有两条
  // 路径通过自定义 wrapper。
  // wrapper 的逻辑完全冗余（它在此处入队，并调用
  // notifySessionMetadataChanged，二者现在都由 onChangeAppState 处理）；
  // 保留它会导致状态消息被重复发送。
  setPermissionModeChangedListener(newMode => {
    // 仅针对 SDK 暴露的模式发送。
    if (
      newMode === 'default' ||
      newMode === 'acceptEdits' ||
      newMode === 'bypassPermissions' ||
      newMode === 'plan' ||
      newMode === (feature('TRANSCRIPT_CLASSIFIER') && 'auto') ||
      newMode === 'dontAsk'
    ) {
      output.enqueue({
        type: 'system',
        subtype: 'status',
        status: null,
        permissionMode: newMode as PermissionMode,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    }
  })

  // Prompt 建议追踪（push 模型）
  const suggestionState: {
    abortController: AbortController | null
    inflightPromise: Promise<void> | null
    lastEmitted: {
      text: string
      emittedAt: number
      promptId: PromptVariant
      generationRequestId: string | null
    } | null
    pendingSuggestion: {
      type: 'prompt_suggestion'
      suggestion: string
      uuid: UUID
      session_id: string
    } | null
    pendingLastEmittedEntry: {
      text: string
      promptId: PromptVariant
      generationRequestId: string | null
    } | null
  } = {
    abortController: null,
    inflightPromise: null,
    lastEmitted: null,
    pendingSuggestion: null,
    pendingLastEmittedEntry: null,
  }

  // 在启用时设置 AWS 认证状态监听器
  let unsubscribeAuthStatus: (() => void) | undefined
  if (options.enableAuthStatus) {
    const authStatusManager = AwsAuthStatusManager.getInstance()
    unsubscribeAuthStatus = authStatusManager.subscribe(status => {
      output.enqueue({
        type: 'auth_status',
        isAuthenticating: status.isAuthenticating,
        output: status.output,
        error: status.error,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    })
  }

  // 设置 rate limit 状态监听器，对所有状态变更发送 SDKRateLimitEvent。
  // 为所有状态（包括 'allowed'）发送事件，可确保消费方在 rate limit 重置时能清除
  // 告警。上游的 emitStatusChange 已经通过 isEqual 去重。
  const rateLimitListener = (limits: ClaudeAILimits) => {
    const rateLimitInfo = toSDKRateLimitInfo(limits)
    if (rateLimitInfo) {
      output.enqueue({
        type: 'rate_limit_event',
        rate_limit_info: rateLimitInfo,
        uuid: randomUUID(),
        session_id: getSessionId(),
      } as unknown as Parameters<typeof output.enqueue>[0])
    }
  }
  statusListeners.add(rateLimitListener)

  // 内部追踪用的消息，直接由 ask() 修改。这些消息包括 Assistant、User、
  // Attachment 和 Progress 消息。
  // TODO: 清理这段代码，避免到处传递可变数组。
  const mutableMessages: Message[] = initialMessages

  // 用 transcript（模型所见的内容，带消息时间戳）初始化 readFileState 缓存，
  // 以便 getChangedFiles 能检测到外部修改。
  // 该缓存实例必须在多次 ask() 调用之间持久存在，因为编辑工具依赖其作为
  // 全局状态。
  let readFileState = extractReadFilesFromMessages(
    initialMessages,
    cwd(),
    READ_FILE_STATE_CACHE_SIZE,
  )

  // 客户端提供的 readFileState 种子（通过 seed_read_state control 请求）。
  // stdin IIFE 与 ask() 并发执行 —— 如果直接写入 readFileState，回合中途到达
  // 的种子会因 ask() 的 clone-then-replace（QueryEngine.ts 的 finally 块）而
  // 丢失。因此种子先落在此处，再合并进 getReadFileCache 的视图（平局时 readFileState
  // 优先：种子用于填补空缺），并在 setReadFileCache 中被重新应用随后清空。
  // 一次性：每个种子仅存活一次 clone-replace 周期，随后变成普通的
  // readFileState 条目，和其他条目一样会被 compact 清空。
  const pendingSeeds = createFileStateCacheWithSizeLimit(
    READ_FILE_STATE_CACHE_SIZE,
  )

  // 重启时自动 resume 被中断的回合，让 CC 从中断处继续，而不需要 SDK 重新发送 prompt。
  const resumeInterruptedTurnEnv =
    process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN
  if (
    turnInterruptionState &&
    turnInterruptionState.kind !== 'none' &&
    resumeInterruptedTurnEnv
  ) {
    logForDebugging(
      `[print.ts] Auto-resuming interrupted turn (kind: ${turnInterruptionState.kind})`,
    )

    // 移除被中断的消息及其哨兵值，然后重新入队，确保模型只看到它一次。
    // 对于回合中途的中断，反序列化层会通过追加一条合成的 "Continue from
    // where you left off." 消息将其转换为 interrupted_prompt。
    removeInterruptedMessage(mutableMessages, turnInterruptionState.message)
    enqueue({
      mode: 'prompt',
      value: turnInterruptionState.message.message!.content as
        | string
        | ContentBlockParam[],
      uuid: randomUUID(),
    })
  }

  const modelOptions = getModelOptions()
  const modelInfos = modelOptions.map(option => {
    const modelId = option.value === null ? 'default' : option.value
    const resolvedModel =
      modelId === 'default'
        ? getDefaultMainLoopModel()
        : parseUserSpecifiedModel(modelId)
    const hasEffort = modelSupportsEffort(resolvedModel)
    const hasAdaptiveThinking = modelSupportsAdaptiveThinking(resolvedModel)
    const hasFastMode = isFastModeSupportedByModel(option.value)
    const hasAutoMode = modelSupportsAutoMode(resolvedModel)
    return {
      name: modelId,
      value: modelId,
      displayName: option.label,
      description: option.description,
      ...(hasEffort && {
        supportsEffort: true,
        supportedEffortLevels: modelSupportsMaxEffort(resolvedModel)
          ? [...EFFORT_LEVELS]
          : EFFORT_LEVELS.filter(l => l !== 'max'),
      }),
      ...(hasAdaptiveThinking && { supportsAdaptiveThinking: true }),
      ...(hasFastMode && { supportsFastMode: true }),
      ...(hasAutoMode && { supportsAutoMode: true }),
    }
  })
  let activeUserSpecifiedModel = options.userSpecifiedModel

  function injectModelSwitchBreadcrumbs(
    modelArg: string,
    resolvedModel: string,
  ): void {
    const breadcrumbs = createModelSwitchBreadcrumbs(
      modelArg,
      modelDisplayString(resolvedModel),
    )
    mutableMessages.push(...breadcrumbs)
    for (const crumb of breadcrumbs) {
      if (
        typeof crumb.message.content === 'string' &&
        crumb.message.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`)
      ) {
        output.enqueue({
          type: 'user',
          content: crumb.message.content,
          message: crumb.message as unknown,
          session_id: getSessionId(),
          parent_tool_use_id: null,
          uuid: crumb.uuid,
          timestamp: crumb.timestamp,
          isReplay: true,
        } as unknown as StdoutMessage)
      }
    }
  }

  // 缓存 SDK MCP 客户端，避免每次 run 都重新连接
  let sdkClients: MCPServerConnection[] = []
  let sdkTools: Tools = []

  // 跟踪已注册过 elicitation handler 的 MCP 客户端
  const elicitationRegistered = new Set<string>()

  /**
   * 在尚未注册的已连接 MCP 客户端上注册 elicitation 请求/完成 handler。
   * SDK MCP server 被排除在外，因为它们通过 SdkControlClientTransport 路由。
   * Hook 会先执行（与 REPL 行为一致）；若没有 hook 响应，则通过 control
   * 协议将请求转发给 SDK 消费方。
   */
  function registerElicitationHandlers(clients: MCPServerConnection[]): void {
    for (const connection of clients) {
      if (
        connection.type !== 'connected' ||
        elicitationRegistered.has(connection.name)
      ) {
        continue
      }
      // 跳过 SDK MCP server —— elicitation 通过 SdkControlClientTransport 流转
      if (connection.config.type === 'sdk') {
        continue
      }
      const serverName = connection.name

      // 用 try/catch 包裹，因为如果客户端创建时未声明 elicitation 能力
      // （例如 SDK 创建的客户端），setRequestHandler 会抛错。
      try {
        connection.client.setRequestHandler(
          ElicitRequestSchema,
          async (request, extra) => {
            logMCPDebug(
              serverName,
              `Elicitation request received in print mode: ${jsonStringify(request)}`,
            )

            const mode = request.params.mode === 'url' ? 'url' : 'form'

            logEvent('tengu_mcp_elicitation_shown', {
              mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })

            // 先运行 elicitation hook —— 它们可以以编程方式提供响应
            const hookResponse = await runElicitationHooks(
              serverName,
              request.params,
              extra.signal,
            )
            if (hookResponse) {
              logMCPDebug(
                serverName,
                `Elicitation resolved by hook: ${jsonStringify(hookResponse)}`,
              )
              logEvent('tengu_mcp_elicitation_response', {
                mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                action:
                  hookResponse.action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              })
              return hookResponse
            }

            // 通过 control 协议委托给 SDK 消费方
            const url =
              'url' in request.params
                ? (request.params.url as string)
                : undefined
            const requestedSchema =
              'requestedSchema' in request.params
                ? (request.params.requestedSchema as
                    | Record<string, unknown>
                    | undefined)
                : undefined

            const elicitationId =
              'elicitationId' in request.params
                ? (request.params.elicitationId as string | undefined)
                : undefined

            const rawResult = await structuredIO.handleElicitation(
              serverName,
              request.params.message,
              requestedSchema,
              extra.signal,
              mode,
              url,
              elicitationId,
            )

            const result = await runElicitationResultHooks(
              serverName,
              rawResult,
              extra.signal,
              mode,
              elicitationId,
            )

            logEvent('tengu_mcp_elicitation_response', {
              mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              action:
                result.action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            return result
          },
        )

        // 将完成通知暴露给 SDK 消费方（URL 模式）
        connection.client.setNotificationHandler(
          ElicitationCompleteNotificationSchema,
          notification => {
            const { elicitationId } = notification.params
            logMCPDebug(
              serverName,
              `Elicitation completion notification: ${elicitationId}`,
            )
            void executeNotificationHooks({
              message: `MCP server "${serverName}" confirmed elicitation ${elicitationId} complete`,
              notificationType: 'elicitation_complete',
            })
            output.enqueue({
              type: 'system',
              subtype: 'elicitation_complete',
              mcp_server_name: serverName,
              elicitation_id: elicitationId,
              uuid: randomUUID(),
              session_id: getSessionId(),
            })
          },
        )

        elicitationRegistered.add(serverName)
      } catch {
        // 若客户端创建时未声明 elicitation 能力，setRequestHandler 会抛错 —— 静默跳过
      }
    }
  }

  async function updateSdkMcp() {
    // 检查 SDK MCP server 是否需要更新（新增或移除了 server）
    const currentServerNames = new Set(Object.keys(sdkMcpConfigs))
    const connectedServerNames = new Set(sdkClients.map(c => c.name))

    // 检查是否存在差异（新增或移除）
    const hasNewServers = Array.from(currentServerNames).some(
      name => !connectedServerNames.has(name),
    )
    const hasRemovedServers = Array.from(connectedServerNames).some(
      name => !currentServerNames.has(name),
    )
    // 检查是否有处于 pending 状态、需要升级的 SDK 客户端
    const hasPendingSdkClients = sdkClients.some(c => c.type === 'pending')
    // 检查是否有握手失败、需要重试的 SDK 客户端。
    // 否则进入 'failed' 状态的客户端（例如 WS 重连竞争中的握手超时）会永远停留
    // 在 failed —— 其名字满足 connectedServerNames 的 diff，但它贡献的工具数为零。
    const hasFailedSdkClients = sdkClients.some(c => c.type === 'failed')

    const haveServersChanged =
      hasNewServers ||
      hasRemovedServers ||
      hasPendingSdkClients ||
      hasFailedSdkClients

    if (haveServersChanged) {
      // 清理已移除的 server
      for (const client of sdkClients) {
        if (!currentServerNames.has(client.name)) {
          if (client.type === 'connected') {
            await client.cleanup()
          }
        }
      }

      // 使用当前配置重新初始化所有 SDK MCP server
      const sdkSetup = await setupSdkMcpClients(
        sdkMcpConfigs,
        (serverName, message) =>
          structuredIO.sendMcpMessage(serverName, message),
      )
      sdkClients = sdkSetup.clients
      sdkTools = sdkSetup.tools

      // 将 SDK MCP 工具存入 appState，使 subagent 可通过 assembleToolPool
      // 访问。这里只存储工具 —— SDK 客户端已在 query 循环（allMcpClients）和
      // mcp_status handler 中单独合并。
      // 同时使用旧的（connectedServerNames）和新的（currentServerNames）名字，
      // 以便在新增或移除 server 时清除过期的 SDK 工具。
      const allSdkNames = uniq([...connectedServerNames, ...currentServerNames])
      setAppState(prev => ({
        ...prev,
        mcp: {
          ...prev.mcp,
          tools: [
            ...prev.mcp.tools.filter(
              t =>
                !allSdkNames.some(name =>
                  t.name.startsWith(getMcpPrefix(name)),
                ),
            ),
            ...sdkTools,
          ],
        },
      }))

      // 如有必要，设置特殊的内部 VSCode MCP server。
      setupVscodeSdkMcp(sdkClients)
    }
  }

  void updateSdkMcp()

  // 动态添加的 MCP server 的状态（通过 mcp_set_servers control 消息）
  // 它们独立于 SDK MCP server，并支持所有 transport 类型
  let dynamicMcpState: DynamicMcpState = {
    clients: [],
    tools: [],
    configs: {},
  }

  // ask() 与 get_context_usage control 请求共享的工具装配。
  // 闭包捕获可变的 sdkTools/dynamicMcpState 绑定，使两个调用点都能看到
  // 延迟连接的 server。
  const buildAllTools = (appState: AppState): Tools => {
    const assembledTools = assembleToolPool(
      appState.toolPermissionContext,
      appState.mcp.tools,
    )
    let allTools = uniqBy(
      mergeAndFilterTools(
        [...tools, ...sdkTools, ...dynamicMcpState.tools],
        assembledTools,
        appState.toolPermissionContext.mode,
      ),
      'name',
    )
    if (options.permissionPromptToolName) {
      allTools = allTools.filter(
        tool => !toolMatchesName(tool, options.permissionPromptToolName!),
      )
    }
    const initJsonSchema = getInitJsonSchema()
    if (initJsonSchema && !options.jsonSchema) {
      const syntheticOutputResult = createSyntheticOutputTool(initJsonSchema)
      if ('tool' in syntheticOutputResult) {
        allTools = [...allTools, syntheticOutputResult.tool]
      }
    }
    return allTools
  }

  // Bridge handle（用于 remote-control，SDK control 消息）。
  // 与 REPL 的 useReplBridge hook 行为一致：`remote_control` 启用时创建 handle，
  // 禁用时销毁。
  let bridgeHandle: ReplBridgeHandle | null = null
  // mutableMessages 的游标 —— 记录我们已经转发到哪了。
  // 与 useReplBridge 的 lastWrittenIndexRef 一样基于 index diff。
  let bridgeLastForwardedIndex = 0

  // 将 mutableMessages 中的新消息转发给 bridge。
  // 每个回合期间增量调用（让 claude.ai 能看到进度并在权限等待期间保持存活），
  // 并在回合结束后再次调用。
  //
  // writeMessages 自带基于 UUID 的去重（initialMessageUUIDs、
  // recentPostedUUIDs）—— 此处的 index 游标只是前置过滤器，避免每次调用都
  // O(n) 重新扫描已发送的消息。
  function forwardMessagesToBridge(): void {
    if (!bridgeHandle) return
    // 防护 mutableMessages 缩短（compaction 会截断它）。
    const startIndex = Math.min(
      bridgeLastForwardedIndex,
      mutableMessages.length,
    )
    const newMessages = mutableMessages
      .slice(startIndex)
      .filter(m => m.type === 'user' || m.type === 'assistant')
    bridgeLastForwardedIndex = mutableMessages.length
    if (newMessages.length > 0) {
      bridgeHandle.writeMessages(newMessages)
    }
  }

  // 应用 MCP server 变更的辅助函数 —— mcp_set_servers control 消息和后台
  // 插件安装都使用它。
  // NOTE：必须是嵌套函数 —— 会修改闭包状态（sdkMcpConfigs、sdkClients 等）
  let mcpChangesPromise: Promise<{
    response: SDKControlMcpSetServersResponse
    sdkServersChanged: boolean
  }> = Promise.resolve({
    response: {
      added: [] as string[],
      removed: [] as string[],
      errors: {} as Record<string, string>,
    },
    sdkServersChanged: false,
  })

  function applyMcpServerChanges(
    servers: Record<string, McpServerConfigForProcessTransport>,
  ): Promise<{
    response: SDKControlMcpSetServersResponse
    sdkServersChanged: boolean
  }> {
    // 串行化调用，防止并发调用方之间的竞争
    // （后台插件安装与 mcp_set_servers control 消息）
    const doWork = async (): Promise<{
      response: SDKControlMcpSetServersResponse
      sdkServersChanged: boolean
    }> => {
      const oldSdkClientNames = new Set(sdkClients.map(c => c.name))

      const result = await handleMcpSetServers(
        servers,
        { configs: sdkMcpConfigs, clients: sdkClients, tools: sdkTools },
        dynamicMcpState,
        setAppState,
      )

      // 更新 SDK 状态（需要原地修改 sdkMcpConfigs，因为它是共享的）
      for (const key of Object.keys(sdkMcpConfigs)) {
        delete sdkMcpConfigs[key]
      }
      Object.assign(sdkMcpConfigs, result.newSdkState.configs)
      sdkClients = result.newSdkState.clients
      sdkTools = result.newSdkState.tools
      dynamicMcpState = result.newDynamicState

      // 保持 appState.mcp.tools 同步，使 subagent 能看到 SDK MCP 工具。
      // 同时使用旧的和新的 SDK 客户端名字，以移除过期工具。
      if (result.sdkServersChanged) {
        const newSdkClientNames = new Set(sdkClients.map(c => c.name))
        const allSdkNames = uniq([...oldSdkClientNames, ...newSdkClientNames])
        setAppState(prev => ({
          ...prev,
          mcp: {
            ...prev.mcp,
            tools: [
              ...prev.mcp.tools.filter(
                t =>
                  !allSdkNames.some(name =>
                    t.name.startsWith(getMcpPrefix(name)),
                  ),
              ),
              ...sdkTools,
            ],
          },
        }))
      }

      return {
        response: result.response,
        sdkServersChanged: result.sdkServersChanged,
      }
    }

    mcpChangesPromise = mcpChangesPromise.then(doWork, doWork)
    return mcpChangesPromise
  }

  // 构建 control 响应所用的 McpServerStatus[]。由 mcp_status 和 reload_plugins
  // handler 共享。读取闭包状态：sdkClients、dynamicMcpState。
  function buildMcpServerStatuses(): McpServerStatus[] {
    const currentAppState = getAppState()
    const currentMcpClients = currentAppState.mcp.clients
    const allMcpTools = uniqBy(
      [...currentAppState.mcp.tools, ...dynamicMcpState.tools],
      'name',
    )
    const existingNames = new Set([
      ...currentMcpClients.map(c => c.name),
      ...sdkClients.map(c => c.name),
    ])
    return [
      ...currentMcpClients,
      ...sdkClients,
      ...dynamicMcpState.clients.filter(c => !existingNames.has(c.name)),
    ].map(connection => {
      let config
      if (
        connection.config.type === 'sse' ||
        connection.config.type === 'http'
      ) {
        config = {
          type: connection.config.type,
          url: connection.config.url,
          headers: connection.config.headers,
          oauth: connection.config.oauth,
        }
      } else if (connection.config.type === 'claudeai-proxy') {
        config = {
          type: 'claudeai-proxy' as const,
          url: connection.config.url,
          id: connection.config.id,
        }
      } else if (
        connection.config.type === 'stdio' ||
        connection.config.type === undefined
      ) {
        const stdioConfig = connection.config as {
          command: string
          args: string[]
        }
        config = {
          type: 'stdio' as const,
          command: stdioConfig.command,
          args: stdioConfig.args,
        }
      }
      const serverTools =
        connection.type === 'connected'
          ? filterToolsByServer(allMcpTools, connection.name).map(tool => ({
              name: tool.mcpInfo?.toolName ?? tool.name,
              annotations: {
                readOnly: tool.isReadOnly({}) || undefined,
                destructive: tool.isDestructive?.({}) || undefined,
                openWorld: tool.isOpenWorld?.({}) || undefined,
              },
            }))
          : undefined
      // Capabilities 透传，并带 allowlist 前置过滤。IDE 通过读取
      // experimental['claude/channel'] 决定是否显示 Enable-channel 提示 —— 只有在
      // channel_enable 确实会通过 allowlist 时才回传它。这不是安全边界
      // （handler 会重新运行完整的 gate）；只是为了避免出现"死按钮"。
      let capabilities: { experimental?: Record<string, unknown> } | undefined
      if (
        (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
        connection.type === 'connected' &&
        connection.capabilities.experimental
      ) {
        const exp = { ...connection.capabilities.experimental }
        if (
          exp['claude/channel'] &&
          (!isChannelsEnabled() ||
            !isChannelAllowlisted(connection.config.pluginSource))
        ) {
          delete exp['claude/channel']
        }
        if (Object.keys(exp).length > 0) {
          capabilities = { experimental: exp }
        }
      }
      return {
        name: connection.name,
        status: connection.type as McpServerStatus['status'],
        serverInfo:
          connection.type === 'connected' ? connection.serverInfo : undefined,
        error: connection.type === 'failed' ? connection.error : undefined,
        config,
        scope: connection.config.scope,
        tools: serverTools,
        capabilities,
      }
    }) as McpServerStatus[]
  }

  // NOTE：必须是嵌套函数 —— 需要闭包访问 applyMcpServerChanges 和 updateSdkMcp
  async function installPluginsAndApplyMcpInBackground(): Promise<void> {
    try {
      // 用户设置（在 runHeadless 入口触发）与托管设置（在 main.tsx preAction
      // 中触发）的 join 点。downloadUserSettings() 会缓存其 promise，因此这里
      // await 的是同一个进行中的请求。
      await Promise.all([
        feature('DOWNLOAD_USER_SETTINGS') &&
        (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) || getIsRemoteMode())
          ? withDiagnosticsTiming('headless_user_settings_download', () =>
              downloadUserSettings(),
            )
          : Promise.resolve(),
        withDiagnosticsTiming('headless_managed_settings_wait', () =>
          waitForRemoteManagedSettingsToLoad(),
        ),
      ])

      const pluginsInstalled = await installPluginsForHeadless()

      if (pluginsInstalled) {
        await applyPluginMcpDiff()
      }
    } catch (error) {
      logError(error)
    }
  }

  // 为所有 headless 用户在后台安装插件
  // 安装 extraKnownMarketplaces 中的 marketplace 以及缺失的已启用插件
  // CLAUDE_CODE_SYNC_PLUGIN_INSTALL=true：在首次 query 之前于 run() 中解析完成，
  // 保证首次 ask() 时插件可用。
  let pluginInstallPromise: Promise<void> | null = null
  // --bare / SIMPLE：跳过插件安装。脚本化调用不会在会话中途新增插件；
  // 下一次交互式 run 会进行对账。
  if (!isBareMode()) {
    if (isEnvTruthy(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL)) {
      pluginInstallPromise = installPluginsAndApplyMcpInBackground()
    } else {
      void installPluginsAndApplyMcpInBackground()
    }
  }

  // 空闲超时管理
  const idleTimeout = createIdleTimeoutManager(() => !running)

  // 用于热重载的可变 commands 和 agents
  let currentCommands = commands
  let currentAgents = agents

  // 清除所有与插件相关的缓存，并重载 commands/agents/hooks。
  // 在 CLAUDE_CODE_SYNC_PLUGIN_INSTALL 完成后（首次 query 之前）调用，
  // 也在非同步后台安装完成后调用。
  // refreshActivePlugins 会调用 clearAllCaches()，这一步是必须的，因为
  // loadAllPlugins() 可能已在 main.tsx 启动期间、托管设置拉取之前运行过。
  // 如果不清除，getCommands() 会基于过期的插件列表重建。
  async function refreshPluginState(): Promise<void> {
    // refreshActivePlugins 负责完整的缓存清理（clearAllCaches）、重载所有
    // 插件 component loader、写入 AppState.plugins + AppState.agentDefinitions、
    // 注册 hook，并递增 mcp.pluginReconnectKey。
    const { agentDefinitions: freshAgentDefs } =
      await refreshActivePlugins(setAppState)

    // headless 专属：currentCommands/currentAgents 是被 query 循环捕获的局部
    // 可变引用（REPL 使用 AppState 代替）。getCommands 是最新的，因为
    // refreshActivePlugins 已清空其缓存。
    currentCommands = await getCommands(cwd())

    // 保留 SDK 提供的 agent（--agents CLI 标志或 SDK initialize
    // control_request）—— 二者都通过 parseAgentsFromJson 注入，source 为
    // 'flagSettings'。loadMarkdownFilesForSubdir 永远不会赋这个 source，
    // 因此能干净地区分"已注入但不可从磁盘加载"。
    //
    // 之前的过滤器使用负向集合 diff（!freshAgentTypes.has(a)），结果也匹配了
    // 那些在被污染的初始 currentAgents 中、但在应用托管设置后被正确排除出
    // freshAgentDefs 的插件 agent —— 把被策略阻止的 agent 泄漏到了 init 消息里。
    // 见 gh-23085：Commander 定义阶段调用的 isBridgeEnabled() 在
    // setEligibility(true) 运行之前污染了设置缓存。
    const sdkAgents = currentAgents.filter(a => a.source === 'flagSettings')
    currentAgents = [...freshAgentDefs.allAgents, ...sdkAgents]
  }

  // 在插件状态变化后重新 diff MCP 配置。过滤到 process-transport 支持的
  // 类型，并让 SDK 模式的 server 透传，避免 applyMcpServerChanges 的 diff
  // 关闭它们的 transport。
  // 嵌套函数：需要闭包访问 sdkMcpConfigs、applyMcpServerChanges、updateSdkMcp。
  async function applyPluginMcpDiff(): Promise<void> {
    const { servers: newConfigs } = await getAllMcpConfigs()
    const supportedConfigs: Record<string, McpServerConfigForProcessTransport> =
      {}
    for (const [name, config] of Object.entries(newConfigs)) {
      const type = config.type
      if (
        type === undefined ||
        type === 'stdio' ||
        type === 'sse' ||
        type === 'http' ||
        type === 'sdk'
      ) {
        supportedConfigs[name] = config as McpServerConfigForProcessTransport
      }
    }
    for (const [name, config] of Object.entries(sdkMcpConfigs)) {
      if (config.type === 'sdk' && !(name in supportedConfigs)) {
        supportedConfigs[name] =
          config as unknown as McpServerConfigForProcessTransport
      }
    }
    const { response, sdkServersChanged } =
      await applyMcpServerChanges(supportedConfigs)
    if (sdkServersChanged) {
      void updateSdkMcp()
    }
    logForDebugging(
      `Headless MCP refresh: added=${response.added.length}, removed=${response.removed.length}`,
    )
  }

  // 订阅 skill 变更以实现热重载
  const unsubscribeSkillChanges = skillChangeDetector.subscribe(() => {
    clearCommandsCache()
    void getCommands(cwd()).then(newCommands => {
      currentCommands = newCommands
    })
  })

  // 主动模式：调度一次 tick，让模型持续自主循环。
  // setTimeout(0) 让出事件循环，使待处理的 stdin 消息（中断、用户消息）在
  // tick 触发之前先被处理。
  const scheduleProactiveTick =
    feature('PROACTIVE') || feature('KAIROS')
      ? () => {
          setTimeout(() => {
            if (
              !proactiveModule?.isProactiveActive() ||
              proactiveModule.isProactivePaused() ||
              inputClosed
            ) {
              return
            }
            void (async () => {
              const commands = await createProactiveAutonomyCommands({
                basePrompt: `<${TICK_TAG}>${new Date().toLocaleTimeString()}</${TICK_TAG}>`,
                currentDir: cwd(),
                shouldCreate: () => !inputClosed,
              })
              if (inputClosed) {
                await cancelQueuedAutonomyCommands({ commands })
                return
              }
              for (const command of commands) {
                enqueue({
                  ...command,
                  uuid: randomUUID(),
                })
              }
              void run()
            })().catch(error => {
              logError(error)
              logForDebugging(
                `[Proactive] failed to create headless tick: ${error}`,
                {
                  level: 'error',
                },
              )
            })
          }, 0)
        }
      : undefined

  // 当 'now' 优先级的消息到达时中止当前操作。
  subscribeToCommandQueue(() => {
    if (abortController && getCommandsByMaxPriority('now').length > 0) {
      abortController.abort('interrupt')
    }
  })

  const run = async () => {
    if (running) {
      return
    }

    running = true
    runPhase = undefined
    notifySessionStateChanged('running')
    idleTimeout.stop()

    headlessProfilerCheckpoint('run_entry')
    // TODO(custom-tool-refactor): 应迁移到 init 消息中，与 browser 一致

    await updateSdkMcp()
    headlessProfilerCheckpoint('after_updateSdkMcp')

    // 解析延迟的插件安装（CLAUDE_CODE_SYNC_PLUGIN_INSTALL）。
    // 该 promise 已经提前启动，使安装与其他初始化并行。
    // 在此处 await 可保证首次 ask() 之前插件就绪。
    // 如果设置了 CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS，会与该截止时间
    // 赛跑，超时则在无插件情况下继续（记录一条错误日志）。
    if (pluginInstallPromise) {
      const timeoutMs = parseInt(
        process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS || '',
        10,
      )
      if (timeoutMs > 0) {
        const timeout = sleep(timeoutMs).then(() => 'timeout' as const)
        const result = await Promise.race([pluginInstallPromise, timeout])
        if (result === 'timeout') {
          logError(
            new Error(
              `CLAUDE_CODE_SYNC_PLUGIN_INSTALL: plugin installation timed out after ${timeoutMs}ms`,
            ),
          )
          logEvent('tengu_sync_plugin_install_timeout', {
            timeout_ms: timeoutMs,
          })
        }
      } else {
        await pluginInstallPromise
      }
      pluginInstallPromise = null

      // 插件已安装，现在刷新 commands、agents 和 hooks
      await refreshPluginState()

      // 初始安装已完成，现在为 plugin hooks 设置热重载。
      // 在 sync-install 模式下，setup.ts 会跳过此步骤以避免与安装竞争。
      const { setupPluginHookHotReload } = await import(
        '../utils/plugins/loadPluginHooks.js'
      )
      setupPluginHookHotReload()
    }

    // 仅处理主线程命令（agentId===undefined）—— subagent 的通知由
    // query.ts 中 subagent 的回合中途 gate 排空。
    // 定义在 try 块之外，以便在 run() 末尾 finally 之后的队列重新检查中可访问。
    const isMainThread = (cmd: QueuedCommand) => cmd.agentId === undefined

    try {
      let command: QueuedCommand | undefined
      let waitingForAgents = false

      // 将命令处理抽取为具名函数，用于 do-while 模式。
      // 排空队列，把连续的 prompt 模式命令批处理为一次 ask() 调用，
      // 使长时间回合期间累积的消息合并为一次后续回合，而不是 N 次独立回合。
      const drainCommandQueue = async () => {
        while ((command = dequeue(isMainThread))) {
          if (
            command.mode !== 'prompt' &&
            command.mode !== 'orphaned-permission' &&
            command.mode !== 'task-notification'
          ) {
            throw new Error(
              'only prompt commands are supported in streaming mode',
            )
          }

          // 非 prompt 命令（task-notification、orphaned-permission）带有副作用
          // 或 orphanedPermission 状态，因此按单条处理。
          // prompt 命令贪心地收集 workload 匹配的后续命令。
          let batch: QueuedCommand[] = [command]
          if (command.mode === 'prompt') {
            while (canBatchWith(command, peek(isMainThread))) {
              batch.push(dequeue(isMainThread)!)
            }
          }
          const queuedAutonomyClaim =
            await claimConsumableQueuedAutonomyCommands(batch)
          batch = queuedAutonomyClaim.attachmentCommands
          if (batch.length === 0) {
            continue
          }
          command = batch[0]!
          if (command.mode === 'prompt' && batch.length > 1) {
            command = {
              ...command,
              value: joinPromptValues(batch.map(c => c.value)),
              uuid: batch.findLast(c => c.uuid)?.uuid ?? command.uuid,
            }
          }
          const batchUuids = batch.map(c => c.uuid).filter(u => u !== undefined)

          // QueryEngine 会通过其 messagesToAck 路径为 command.uuid（批次中
          // 最后一个 uuid）发送 replay。此处为其余消息补发 replay，使那些按
          // uuid 跟踪投递的消费方（clank 的 asyncMessages footer、CCR）能看到
          // 它们发送的每条消息的 ack，而不只是合并后存活下来的那一条。
          if (options.replayUserMessages && batch.length > 1) {
            for (const c of batch) {
              if (c.uuid && c.uuid !== command.uuid) {
                output.enqueue({
                  type: 'user',
                  content: c.value,
                  message: { role: 'user', content: c.value } as unknown,
                  session_id: getSessionId(),
                  parent_tool_use_id: null,
                  uuid: c.uuid as string,
                  isReplay: true,
                } as unknown as StdoutMessage)
              }
            }
          }

          // 合并所有 MCP 客户端。appState.mcp 由 main.tsx 按 server 增量填充
          // （与 useManageMCPConnections 行为一致）。按命令读取最新值，意味着
          // 延迟连接的 server 在下一个回合可见。registerElicitationHandlers
          // 是幂等的（基于追踪集合）。
          const appState = getAppState()
          const allMcpClients = [
            ...appState.mcp.clients,
            ...sdkClients,
            ...dynamicMcpState.clients,
          ]
          registerElicitationHandlers(allMcpClients)
          // 为构造时通过 --channels 加入 allowlist 的 server（或在会话中调用
          // enableChannel()）注册 channel handler。每个回合都会运行，就像
          // registerElicitationHandlers 一样 —— 对每个客户端幂等
          // （setNotificationHandler 是替换而非叠加），对非 allowlist 的 server
          // 直接 no-op（一次 feature-flag 检查）。
          for (const client of allMcpClients) {
            reregisterChannelHandlerAfterReconnect(client)
          }

          const allTools = buildAllTools(appState)

          for (const uuid of batchUuids) {
            notifyCommandLifecycle(uuid, 'started')
          }

          // 后台 agent 完成时会到达 task 通知。
          // 为 SDK 消费方发送一个 SDK 系统事件，然后继续落入 ask()，让模型看到
          // agent 的结果并据此行动。
          // 这与 TUI 行为一致 —— 无论是否处于 coordinator 模式，useQueueProcessor
          // 都会把通知喂给模型。
          if (command.mode === 'task-notification') {
            const notificationText =
              typeof command.value === 'string' ? command.value : ''
            // 解析 XML 格式的通知
            const taskIdMatch = notificationText.match(
              /<task-id>([^<]+)<\/task-id>/,
            )
            const toolUseIdMatch = notificationText.match(
              /<tool-use-id>([^<]+)<\/tool-use-id>/,
            )
            const outputFileMatch = notificationText.match(
              /<output-file>([^<]+)<\/output-file>/,
            )
            const statusMatch = notificationText.match(
              /<status>([^<]+)<\/status>/,
            )
            const summaryMatch = notificationText.match(
              /<summary>([^<]+)<\/summary>/,
            )

            const isValidStatus = (
              s: string | undefined,
            ): s is 'completed' | 'failed' | 'stopped' | 'killed' =>
              s === 'completed' ||
              s === 'failed' ||
              s === 'stopped' ||
              s === 'killed'
            const rawStatus = statusMatch?.[1]
            const status = isValidStatus(rawStatus)
              ? rawStatus === 'killed'
                ? 'stopped'
                : rawStatus
              : 'completed'

            const usageMatch = notificationText.match(
              /<usage>([\s\S]*?)<\/usage>/,
            )
            const usageContent = usageMatch?.[1] ?? ''
            const totalTokensMatch = usageContent.match(
              /<total_tokens>(\d+)<\/total_tokens>/,
            )
            const toolUsesMatch = usageContent.match(
              /<tool_uses>(\d+)<\/tool_uses>/,
            )
            const durationMsMatch = usageContent.match(
              /<duration_ms>(\d+)<\/duration_ms>/,
            )

            // 只有当存在 <status> 标签时才发送 task_notification SDK 事件 ——
            // 这表示这是一个终止性通知（completed/failed/stopped）。来自
            // enqueueStreamEvent 的流事件不携带 <status>（它们只是进度心跳）；
            // 在这里发送会被默认为 'completed'，从而为 SDK 消费方错误地关闭任务。
            // 终止性事件现在通过 emitTaskTerminatedSdk 直接发送，因此跳过无状态
            // 事件是安全的。
            if (statusMatch) {
              output.enqueue({
                type: 'system',
                subtype: 'task_notification',
                task_id: taskIdMatch?.[1] ?? '',
                tool_use_id: toolUseIdMatch?.[1],
                status,
                output_file: outputFileMatch?.[1] ?? '',
                summary: summaryMatch?.[1] ?? '',
                usage:
                  totalTokensMatch && toolUsesMatch
                    ? {
                        total_tokens: parseInt(totalTokensMatch[1]!, 10),
                        tool_uses: parseInt(toolUsesMatch[1]!, 10),
                        duration_ms: durationMsMatch
                          ? parseInt(durationMsMatch[1]!, 10)
                          : 0,
                      }
                    : undefined,
                session_id: getSessionId(),
                uuid: randomUUID(),
              })
            }
            // 不 continue —— 直接落入 ask()，让模型处理结果
          }

          const input = command.value
          const claimedAutonomyCommands = queuedAutonomyClaim.claimedCommands

          if (structuredIO instanceof RemoteIO && command.mode === 'prompt') {
            logEvent('tengu_bridge_message_received', {
              is_repl: false,
            })
          }

          // 中止任何进行中的建议生成，并记录采纳情况
          suggestionState.abortController?.abort()
          suggestionState.abortController = null
          suggestionState.pendingSuggestion = null
          suggestionState.pendingLastEmittedEntry = null
          if (suggestionState.lastEmitted) {
            if (command.mode === 'prompt') {
              // SDK 用户消息入队的是 ContentBlockParam[]，而不是纯字符串
              const inputText =
                typeof input === 'string'
                  ? input
                  : (
                      input.find(b => b.type === 'text') as
                        | { type: 'text'; text: string }
                        | undefined
                    )?.text
              if (typeof inputText === 'string') {
                logSuggestionOutcome(
                  suggestionState.lastEmitted.text,
                  inputText,
                  suggestionState.lastEmitted.emittedAt,
                  suggestionState.lastEmitted.promptId,
                  suggestionState.lastEmitted.generationRequestId,
                )
              }
              suggestionState.lastEmitted = null
            }
          }

          abortController = createAbortController()
          const turnStartTime = feature('FILE_PERSISTENCE')
            ? Date.now()
            : undefined

          headlessProfilerCheckpoint('before_ask')
          startQueryProfile()
          // 每次迭代的 ALS 上下文，使 ask() 内部生成的后台 agent 在其分离的
          // await 之间继承 workload。进程内 cron 会打上 cmd.workload；
          // SDK 的 --workload 标志对应 options.workload。
          // const 捕获：TS 在闭包内会丢失 `while ((command = dequeue()))`
          // 的类型收窄。
          const cmd = command
          let lastResultIsError = false
          try {
            await runWithWorkload(
              cmd.workload ?? options.workload,
              async () => {
                for await (const message of ask({
                  commands: uniqBy(
                    [...currentCommands, ...appState.mcp.commands],
                    'name',
                  ),
                  prompt: input,
                  promptUuid: cmd.uuid,
                  isMeta: cmd.isMeta,
                  cwd: cwd(),
                  tools: allTools,
                  verbose: options.verbose,
                  mcpClients: allMcpClients,
                  thinkingConfig: options.thinkingConfig,
                  maxTurns: options.maxTurns,
                  maxBudgetUsd: options.maxBudgetUsd,
                  taskBudget: options.taskBudget,
                  canUseTool,
                  userSpecifiedModel: activeUserSpecifiedModel,
                  fallbackModel: options.fallbackModel,
                  jsonSchema: getInitJsonSchema() ?? options.jsonSchema,
                  mutableMessages,
                  getReadFileCache: () =>
                    pendingSeeds.size === 0
                      ? readFileState
                      : mergeFileStateCaches(readFileState, pendingSeeds),
                  setReadFileCache: cache => {
                    readFileState = cache
                    for (const [path, seed] of pendingSeeds.entries()) {
                      const existing = readFileState.get(path)
                      if (!existing || seed.timestamp > existing.timestamp) {
                        readFileState.set(path, seed)
                      }
                    }
                    pendingSeeds.clear()
                  },
                  customSystemPrompt: options.systemPrompt,
                  appendSystemPrompt: options.appendSystemPrompt,
                  getAppState,
                  setAppState,
                  abortController,
                  replayUserMessages: options.replayUserMessages,
                  includePartialMessages: options.includePartialMessages,
                  handleElicitation: (serverName, params, elicitSignal) =>
                    structuredIO.handleElicitation(
                      serverName,
                      params.message,
                      undefined,
                      elicitSignal,
                      params.mode,
                      params.url,
                      'elicitationId' in params
                        ? params.elicitationId
                        : undefined,
                    ),
                  agents: currentAgents,
                  orphanedPermission: cmd.orphanedPermission,
                  setSDKStatus: status => {
                    output.enqueue({
                      type: 'system',
                      subtype: 'status',
                      status: status as 'compacting' | null,
                      session_id: getSessionId(),
                      uuid: randomUUID(),
                    })
                  },
                })) {
                  // 增量地把消息转发给 bridge（回合进行中），让 claude.ai 能看到
                  // 进度，并在权限请求阻塞期间保持连接存活。
                  forwardMessagesToBridge()

                  if (message.type === 'result') {
                    lastResultIsError = !!(message as Record<string, unknown>)
                      .is_error
                    // 刷出待处理的 SDK 事件，使其在流上位于 result 之前。
                    for (const event of drainSdkEvents()) {
                      output.enqueue(event)
                    }

                    // 暂缓：后台 agent 仍在运行时不发送 result
                    const currentState = getAppState()
                    if (
                      getRunningTasks(currentState).some(
                        t =>
                          (t.type === 'local_agent' ||
                            t.type === 'local_workflow') &&
                          isBackgroundTask(t),
                      )
                    ) {
                      heldBackResult = message as StdoutMessage
                    } else {
                      heldBackResult = null
                      output.enqueue(message as StdoutMessage)
                    }
                  } else {
                    // 刷出 SDK 事件（task_started、task_progress），使后台 agent
                    // 进度实时流式输出，而不是积压到 result 才一起发送。
                    for (const event of drainSdkEvents()) {
                      output.enqueue(event)
                    }
                    output.enqueue(message as StdoutMessage)
                  }
                }
              },
            ) // end runWithWorkload
            if (lastResultIsError) {
              await finalizeAutonomyCommandsForTurn({
                commands: claimedAutonomyCommands,
                outcome: {
                  type: 'failed',
                  message: 'ask() returned an error result',
                },
                currentDir: cwd(),
                priority: 'later',
                workload: cmd.workload ?? options.workload,
              })
            } else {
              const nextCommands = await finalizeAutonomyCommandsForTurn({
                commands: claimedAutonomyCommands,
                outcome: { type: 'completed' },
                currentDir: cwd(),
                priority: 'later',
                workload: cmd.workload ?? options.workload,
              })
              for (const nextCommand of nextCommands) {
                enqueue({
                  ...nextCommand,
                  uuid: randomUUID(),
                })
              }
            }
          } catch (error) {
            await finalizeAutonomyCommandsForTurn({
              commands: claimedAutonomyCommands,
              outcome: { type: 'failed', error },
              currentDir: cwd(),
              priority: 'later',
              workload: cmd.workload ?? options.workload,
            })
            throw error
          }

          for (const uuid of batchUuids) {
            notifyCommandLifecycle(uuid, 'completed')
          }

          // 每个回合结束后将消息转发给 bridge
          forwardMessagesToBridge()
          bridgeHandle?.sendResult()

          if (feature('FILE_PERSISTENCE') && turnStartTime !== undefined) {
            void executeFilePersistence(
              {
                turnStartTime,
              } as import('src/utils/filePersistence/types.js').TurnStartTime,
              abortController.signal,
              result => {
                const filesResult = result as unknown as {
                  persistedFiles: { filename: string; file_id: string }[]
                  failedFiles: { filename: string; error: string }[]
                }
                output.enqueue({
                  type: 'system' as const,
                  subtype: 'files_persisted' as const,
                  files: filesResult.persistedFiles,
                  failed: filesResult.failedFiles,
                  processed_at: new Date().toISOString(),
                  uuid: randomUUID(),
                  session_id: getSessionId(),
                })
              },
            )
          }

          // 为 SDK 消费方生成并发送 prompt 建议
          if (
            options.promptSuggestions &&
            !isEnvDefinedFalsy(process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION)
          ) {
            // TS 在 while 循环体内会把 suggestionState 收窄为 never；
            // 通过 unknown 断言重置收窄。
            const state = suggestionState as unknown as typeof suggestionState
            state.abortController?.abort()
            const localAbort = new AbortController()
            suggestionState.abortController = localAbort

            const cacheSafeParams = getLastCacheSafeParams()
            if (!cacheSafeParams) {
              logSuggestionSuppressed(
                'sdk_no_params',
                undefined,
                undefined,
                'sdk',
              )
            } else {
              // 使用 ref 对象，使 IIFE 的 finally 可以与自身的 promise 比较，
              // 而不需要自引用（自引用会扰乱 TypeScript 的流分析）。
              const ref: { promise: Promise<void> | null } = { promise: null }
              ref.promise = (async () => {
                try {
                  const result = await tryGenerateSuggestion(
                    localAbort,
                    mutableMessages,
                    getAppState,
                    cacheSafeParams,
                    'sdk',
                  )
                  if (!result || localAbort.signal.aborted) return
                  const suggestionMsg = {
                    type: 'prompt_suggestion' as const,
                    suggestion: result.suggestion,
                    uuid: randomUUID(),
                    session_id: getSessionId(),
                  }
                  const lastEmittedEntry = {
                    text: result.suggestion,
                    emittedAt: Date.now(),
                    promptId: result.promptId,
                    generationRequestId: result.generationRequestId,
                  }
                  // 如果 result 正在为后台 agent 暂缓，则推迟发送，确保
                  // prompt_suggestion 始终在 result 之后到达。
                  // 只有当建议真正投递给消费方时才设置 lastEmitted；被推迟的
                  // 建议若在新命令先到达之前未投递，可能会被丢弃。
                  if (heldBackResult) {
                    suggestionState.pendingSuggestion = suggestionMsg
                    suggestionState.pendingLastEmittedEntry = {
                      text: lastEmittedEntry.text,
                      promptId: lastEmittedEntry.promptId,
                      generationRequestId: lastEmittedEntry.generationRequestId,
                    }
                  } else {
                    suggestionState.lastEmitted = lastEmittedEntry
                    output.enqueue(suggestionMsg)
                  }
                } catch (error) {
                  if (
                    error instanceof Error &&
                    (error.name === 'AbortError' ||
                      error.name === 'APIUserAbortError')
                  ) {
                    logSuggestionSuppressed(
                      'aborted',
                      undefined,
                      undefined,
                      'sdk',
                    )
                    return
                  }
                  logError(toError(error))
                } finally {
                  if (suggestionState.inflightPromise === ref.promise) {
                    suggestionState.inflightPromise = null
                  }
                }
              })()
              suggestionState.inflightPromise = ref.promise
            }
          }

          // 记录本回合的 headless profiler 指标，并开始下一个回合
          logHeadlessProfilerTurn()
          logQueryProfileReport()
          headlessProfilerStartTurn()
        }
      }

      // 使用 do-while 循环排空命令，然后等待仍在运行的后台 agent。
      // 当 agent 完成时，其通知会被入队，循环再次排空。
      do {
        // 在命令队列之前排空 SDK 事件（task_started、task_progress），
        // 使进度事件在流上位于 task_notification 之前。
        for (const event of drainSdkEvents()) {
          output.enqueue(event)
        }

        runPhase = 'draining_commands'
        await drainCommandQueue()

        // 退出前检查仍在运行的后台任务。
        // 排除 in_process_teammate —— teammate 按设计是长生命周期的
        // （整个生命周期 status 都是 'running'，由关闭协议清理，而不是通过
        // 转为 'completed' 清理）。在此处等待它们会陷入死循环（gh-30008）。
        // useBackgroundTaskNavigation.ts:55 出于同样原因已存在相同排除逻辑；
        // 上方 L1839 的范围更窄（type === 'local_agent'），因此不会触发此问题。
        waitingForAgents = false
        {
          const state = getAppState()
          const hasRunningBg = getRunningTasks(state).some(
            t => isBackgroundTask(t) && t.type !== 'in_process_teammate',
          )
          const hasMainThreadQueued = peek(isMainThread) !== undefined
          if (hasRunningBg || hasMainThreadQueued) {
            waitingForAgents = true
            if (!hasMainThreadQueued) {
              runPhase = 'waiting_for_agents'
              // 暂时没有命令就绪，等待任务完成
              await sleep(100)
            }
            // 回到循环开头，排空新入队的命令
          }
        }
      } while (waitingForAgents)

      if (heldBackResult) {
        output.enqueue(heldBackResult)
        heldBackResult = null
        if (suggestionState.pendingSuggestion) {
          output.enqueue(suggestionState.pendingSuggestion)
          // 建议已真正投递，现在记录到采纳追踪
          if (suggestionState.pendingLastEmittedEntry) {
            suggestionState.lastEmitted = {
              ...suggestionState.pendingLastEmittedEntry,
              emittedAt: Date.now(),
            }
            suggestionState.pendingLastEmittedEntry = null
          }
          suggestionState.pendingSuggestion = null
        }
      }
    } catch (error) {
      // 关闭前发送错误 result 消息
      // 直接写入 structuredIO 以确保立即投递
      try {
        await structuredIO.write({
          type: 'result',
          subtype: 'error_during_execution',
          duration_ms: 0,
          duration_api_ms: 0,
          is_error: true,
          num_turns: 0,
          stop_reason: null,
          session_id: getSessionId(),
          total_cost_usd: 0,
          usage: EMPTY_USAGE,
          modelUsage: {},
          permission_denials: [],
          uuid: randomUUID(),
          errors: [
            errorMessage(error),
            ...getInMemoryErrors().map(_ => _.error),
          ],
        })
      } catch {
        // 如果无法发送错误 result，仍然继续关闭流程
      }
      suggestionState.abortController?.abort()
      gracefulShutdownSync(1)
      return
    } finally {
      runPhase = 'finally_flush'
      // 进入空闲前刷出待处理的内部事件
      await structuredIO.flushInternalEvents()
      runPhase = 'finally_post_flush'
      if (!isShuttingDown()) {
        notifySessionStateChanged('idle')
        // 排空事件，使空闲的 session_state_changed SDK 事件（以及后台 agent
        // 拆除期间发送的任何终止性 task_notification 收尾事件）在我们阻塞等待
        // 下一条命令之前到达输出流。上方的 do-while 排空只在
        // waitingForAgents 时运行；到达此处后，下一次排空要等到下一次 run()
        // 的开头才会发生，而输入空闲时不会再有下一次 run()。
        for (const event of drainSdkEvents()) {
          output.enqueue(event)
        }
      }
      running = false
      // 处理完成并等待输入时启动空闲计时器
      idleTimeout.start()
    }

    // 主动 tick：如果主动模式处于激活状态且队列为空，注入一次 tick
    if (
      (feature('PROACTIVE') || feature('KAIROS')) &&
      proactiveModule?.isProactiveActive() &&
      !proactiveModule.isProactivePaused()
    ) {
      if (peek(isMainThread) === undefined && !inputClosed) {
        scheduleProactiveTick!()
        return
      }
    }

    // 释放互斥锁后重新检查队列。在上一次 dequeue() 返回 undefined 与上方
    // `running = false` 之间，可能有消息到达（并调用了 run()）。此时调用方
    // 看到 `running === true` 就立即返回，使消息滞留在队列中无人处理。
    if (peek(isMainThread) !== undefined) {
      void run()
      return
    }

    // 检查未读的 teammate 消息并处理它们
    // 这与交互式 REPL 模式下 useInboxPoller 的行为一致
    // 持续轮询直到没有更多消息（teammate 可能仍在工作）
    {
      const currentAppState = getAppState()
      const teamContext = currentAppState.teamContext

      if (teamContext && isTeamLead(teamContext)) {
        const agentName = 'team-lead'

        // 当 teammate 仍处于活跃状态时轮询消息
        // 这是必要的，因为 teammate 可能会在我们等待期间发送消息
        // 持续轮询，直到整个 team 被关闭
        const POLL_INTERVAL_MS = 500

        while (true) {
          // 检查 teammate 是否仍处于活跃状态
          const refreshedState = getAppState()
          const hasActiveTeammates =
            hasActiveInProcessTeammates(refreshedState) ||
            (refreshedState.teamContext &&
              Object.keys(refreshedState.teamContext.teammates).length > 0)

          if (!hasActiveTeammates) {
            logForDebugging(
              '[print.ts] No more active teammates, stopping poll',
            )
            break
          }

          const unread = await readUnreadMessages(
            agentName,
            refreshedState.teamContext?.teamName,
          )

          if (unread.length > 0) {
            logForDebugging(
              `[print.ts] Team-lead found ${unread.length} unread messages`,
            )

            // 立即标记为已读，避免重复处理
            await markMessagesAsRead(
              agentName,
              refreshedState.teamContext?.teamName,
            )

            // 处理 shutdown_approved 消息 —— 从 team 文件中移除 teammate
            // 这与交互式模式下 useInboxPoller 的行为一致（第 546-606 行）
            const teamName = refreshedState.teamContext?.teamName
            for (const m of unread) {
              const shutdownApproval = isShutdownApproved(m.text)
              if (shutdownApproval && teamName) {
                const teammateToRemove = shutdownApproval.from
                logForDebugging(
                  `[print.ts] Processing shutdown_approved from ${teammateToRemove}`,
                )

                // 根据名字查找 teammate ID
                const teammateId = refreshedState.teamContext?.teammates
                  ? Object.entries(refreshedState.teamContext.teammates).find(
                      ([, t]) => t.name === teammateToRemove,
                    )?.[0]
                  : undefined

                if (teammateId) {
                  // 从 team 文件中移除
                  removeTeammateFromTeamFile(teamName, {
                    agentId: teammateId,
                    name: teammateToRemove,
                  })
                  logForDebugging(
                    `[print.ts] Removed ${teammateToRemove} from team file`,
                  )

                  // 取消分配给该 teammate 的任务
                  await unassignTeammateTasks(
                    teamName,
                    teammateId,
                    teammateToRemove,
                    'shutdown',
                  )

                  // 从 AppState 的 teamContext 中移除
                  setAppState(prev => {
                    if (!prev.teamContext?.teammates) return prev
                    if (!(teammateId in prev.teamContext.teammates)) return prev
                    const { [teammateId]: _, ...remainingTeammates } =
                      prev.teamContext.teammates
                    return {
                      ...prev,
                      teamContext: {
                        ...prev.teamContext,
                        teammates: remainingTeammates,
                      },
                    }
                  })
                }
              }
            }

            // 格式化消息，与 useInboxPoller 的方式一致
            const formatted = unread
              .map(
                (m: { from: string; text: string; color?: string }) =>
                  `<${TEAMMATE_MESSAGE_TAG} teammate_id="${m.from}"${m.color ? ` color="${m.color}"` : ''}>\n${m.text}\n</${TEAMMATE_MESSAGE_TAG}>`,
              )
              .join('\n\n')

            // 入队并处理
            enqueue({
              mode: 'prompt',
              value: formatted,
              uuid: randomUUID(),
            })
            void run()
            return // run() 在处理完毕后会回到这里
          }

          // 没有消息 —— 检查是否需要发起关闭提示
          // 如果输入已关闭且仍有活跃的 teammate，注入一次关闭提示
          if (inputClosed && !shutdownPromptInjected) {
            shutdownPromptInjected = true
            logForDebugging(
              '[print.ts] Input closed with active teammates, injecting shutdown prompt',
            )
            enqueue({
              mode: 'prompt',
              value: SHUTDOWN_TEAM_PROMPT,
              uuid: randomUUID(),
            })
            void run()
            return // run() 在处理完毕后会回到这里
          }

          // 等待后再次检查
          await sleep(POLL_INTERVAL_MS)
        }
      }
    }

    if (inputClosed) {
      // 检查是否有活跃的 swarm 需要关闭
      const hasActiveSwarm = await (async () => {
        // 等待任何正在工作的进程内 team member 完成
        const currentAppState = getAppState()
        if (hasWorkingInProcessTeammates(currentAppState)) {
          await waitForTeammatesToBecomeIdle(setAppState, currentAppState)
        }

        // 在可能的等待之后重新获取状态
        const refreshedAppState = getAppState()
        const refreshedTeamContext = refreshedAppState.teamContext
        const hasTeamMembersNotCleanedUp =
          refreshedTeamContext &&
          Object.keys(refreshedTeamContext.teammates).length > 0

        return (
          hasTeamMembersNotCleanedUp ||
          hasActiveInProcessTeammates(refreshedAppState)
        )
      })()

      if (hasActiveSwarm) {
        // Team member 处于空闲状态或基于 pane —— 注入提示以关闭 team
        enqueue({
          mode: 'prompt',
          value: SHUTDOWN_TEAM_PROMPT,
          uuid: randomUUID(),
        })
        void run()
      } else {
        // 在关闭输出流之前，等待任何进行中的 push suggestion。
        if (suggestionState.inflightPromise) {
          await Promise.race([suggestionState.inflightPromise, sleep(5000)])
        }
        suggestionState.abortController?.abort()
        suggestionState.abortController = null
        await finalizePendingAsyncHooks()
        unsubscribeSkillChanges()
        unsubscribeAuthStatus?.()
        statusListeners.delete(rateLimitListener)
        output.done()
      }
    }
  }

  // 设置 UDS inbox 回调，使 headless 模式下当消息通过 UDS socket 到达时
  // 能触发 query 循环。
  if (feature('UDS_INBOX')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { drainInbox, setOnEnqueue } =
      require('../utils/udsMessaging.js') as typeof import('../utils/udsMessaging.js')
    /* eslint-enable @typescript-eslint/no-require-imports */

    const enqueueUdsInboxMessages = (): boolean => {
      const entries = drainInbox()
      for (const entry of entries) {
        const value =
          typeof entry.message.data === 'string'
            ? entry.message.data
            : jsonStringify(entry.message.data)
        enqueue({
          mode: 'prompt',
          value,
          uuid: randomUUID(),
        })
      }
      return entries.length > 0
    }

    setOnEnqueue(() => {
      if (!inputClosed) {
        if (enqueueUdsInboxMessages()) {
          void run()
        }
      }
    })

    if (enqueueUdsInboxMessages()) {
      void run()
    }
  }

  // Cron 调度器：在 SDK/-p 模式下运行 scheduled_tasks.json 中的任务。
  // 镜像 REPL 的 useScheduledTasks hook。触发的 prompt 直接入队并启动
  // run() —— 与 REPL 不同，这里没有会在空闲时按 enqueue 排空的队列订阅方。
  // run() 的互斥锁确保在活跃回合期间是安全的：调用会直接 no-op，
  // 而 run() 末尾的回合后复查会捡起已入队的命令。
  let cronScheduler: import('../utils/cronScheduler.js').CronScheduler | null =
    null
  if (cronGate.isKairosCronEnabled()) {
    // 三个 cron 入口（legacy onFire、onFireTask agent、onFireTask non-agent）
    // 共享的"去重认领 → 输入关闭复查 → onSuccess"管道。把延迟关闭时取消的契约
    // 集中在此处，可避免三个分支在 claim 与 dispatch 之间的行为出现漂移。
    // onSuccess 接收已认领的 QueuedCommand，并决定是将其入队（正常路径）还是
    // 将此次 run 标记为失败（agent 路径）。
    const dispatchHeadlessCronCommand = (params: {
      basePrompt: string
      sourceId: string
      sourceLabel: string
      logSuffix: string
      onSuccess: (command: QueuedCommand) => void | Promise<void>
    }): void => {
      if (inputClosed) return
      void (async () => {
        const command = await createAutonomyQueuedPromptIfNoActiveSource({
          basePrompt: params.basePrompt,
          trigger: 'scheduled-task',
          currentDir: cwd(),
          sourceId: params.sourceId,
          sourceLabel: params.sourceLabel,
          workload: WORKLOAD_CRON,
          shouldCreate: () => !inputClosed,
        })
        if (!command) return
        if (inputClosed) {
          await cancelQueuedAutonomyCommands({ commands: [command] })
          return
        }
        await params.onSuccess(command)
      })().catch(error => {
        logError(error)
        logForDebugging(
          `[ScheduledTasks] failed to enqueue headless task${params.logSuffix}: ${error}`,
          { level: 'error' },
        )
      })
    }

    const enqueueAndRun = (command: QueuedCommand): void => {
      enqueue({
        ...command,
        uuid: randomUUID(),
      })
      void run()
    }

    cronScheduler = cronSchedulerModule.createCronScheduler({
      onFire: prompt => {
        // Legacy KAIROS 风格的条目：prompt 文本本身就是唯一标识 cron 条目
        // 的内容，因此在去重时同时作为 source id 与 source label 使用。
        dispatchHeadlessCronCommand({
          basePrompt: prompt,
          sourceId: prompt,
          sourceLabel: prompt,
          logSuffix: '',
          onSuccess: enqueueAndRun,
        })
      },
      onFireTask: task => {
        if (task.agentId) {
          dispatchHeadlessCronCommand({
            basePrompt: task.prompt,
            sourceId: task.id,
            sourceLabel: task.prompt,
            logSuffix: ` ${task.id}`,
            onSuccess: async command => {
              await markAutonomyRunFailed(
                command.autonomy!.runId,
                `No teammate runtime available for scheduled task owner ${task.agentId} in headless mode.`,
                command.autonomy!.rootDir,
              )
            },
          })
          return
        }
        dispatchHeadlessCronCommand({
          basePrompt: task.prompt,
          sourceId: task.id,
          sourceLabel: task.prompt,
          logSuffix: ` ${task.id}`,
          onSuccess: enqueueAndRun,
        })
      },
      isLoading: () => running || inputClosed,
      getJitterConfig: cronJitterConfigModule?.getCronJitterConfig,
      isKilled: () => !cronGate?.isKairosCronEnabled(),
    })
    cronScheduler.start()
  }

  const sendControlResponseSuccess = function (
    message: { request_id: string } | SDKControlRequest,
    response?: Record<string, unknown>,
  ) {
    output.enqueue({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: message.request_id,
        response: response,
      },
    })
  }

  const sendControlResponseError = function (
    message: { request_id: string } | SDKControlRequest,
    errorMessage: string,
  ) {
    output.enqueue({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: message.request_id,
        error: errorMessage,
      },
    })
  }

  // 处理意外的权限响应：在 transcript 中查找未解析的工具调用并执行它
  const handledOrphanedToolUseIds = new Set<string>()
  structuredIO.setUnexpectedResponseCallback(async message => {
    await handleOrphanedPermissionResponse({
      message,
      setAppState,
      handledToolUseIds: handledOrphanedToolUseIds,
      onEnqueued: () => {
        // 一个会话的第一条消息可能是孤儿权限检查，而不是用户 prompt，
        // 因此需要在此启动循环。
        void run()
      },
    })
  })

  // 按 server 跟踪活跃的 OAuth 流程，使同一 server 新的 mcp_authenticate
  // 请求到达时可以中止前一个流程。
  const activeOAuthFlows = new Map<string, AbortController>()
  // 跟踪活跃 OAuth 流程的手动 callback URL 提交函数。
  // 用于 localhost 不可达的场景（例如基于浏览器的 IDE）。
  const oauthCallbackSubmitters = new Map<
    string,
    (callbackUrl: string) => void
  >()
  // 跟踪实际调用过手动 callback 的 server（让自动重连路径知道需要跳过 ——
  // 扩展会负责重连）。
  const oauthManualCallbackUsed = new Set<string>()
  // 跟踪 OAuth 仅认证的 promise，使 mcp_oauth_callback_url 可以等待
  // token 交换完成。重连由扩展通过 handleAuthDone → mcp_reconnect 单独处理。
  const oauthAuthPromises = new Map<string, Promise<void>>()

  // 进行中的 Anthropic OAuth 流程（claude_authenticate）。单槽位：第二次
  // authenticate 请求会清理第一次的流程。service 持有 PKCE verifier 和
  // localhost 监听器；promise 在 installOAuthTokens 之后 settle —— resolve
  // 之后，进程内 memoized 的 token 缓存已被清除，下一次 API 调用会拿到
  // 新的凭据。
  let claudeOAuth: {
    service: OAuthService
    flow: Promise<void>
  } | null = null

  // 这本质上是启动一个并行异步任务 —— 我们有两个并行运行：
  // 一个从 stdin 读取并加入待处理队列，另一个从队列中读取、处理并
  // 返回生成结果。
  // 当输入流结束且队列中最后一次生成完成时，整个流程结束。
  void (async () => {
    let initialized = false
    logForDiagnosticsNoPII('info', 'cli_message_loop_started')
    for await (const message of structuredIO.structuredInput) {
      // 非用户事件会在原地处理（不进入队列）。同一 tick 内的 started→completed
      // 不携带任何信息，因此只触发 completed。
      // control_response 由 StructuredIO.processLine 上报（它也会看到
      // 永远不会 yield 到这里的 orphan）。
      const eventId = 'uuid' in message ? message.uuid : undefined
      if (
        eventId &&
        message.type !== 'user' &&
        message.type !== 'control_response'
      ) {
        notifyCommandLifecycle(eventId as string, 'completed')
      }

      if (message.type === 'control_request') {
        // 类型断言：structuredInput 产出 StdinMessage | SDKMessage，但当
        // type === 'control_request' 时该对象有 request_id 和 request。
        // 与 SDKMessage（类型为 `any`）的联合会让 request 变成 `unknown`。
        // 通过 unknown 转为 SDKControlRequest，以便在已知的 subtype 上获得类型安全，
        // 对于不在 zod schema 联合中的 subtype 使用 Record<string, unknown>。
        const msg = message as unknown as SDKControlRequest
        // 为不在 zod schema 中的 subtype 的 request 属性提供一个更宽泛的类型别名。
        // schema 联合并不包含 end_session、channel_enable、mcp_authenticate、
        // claude_authenticate 等，因此访问它们的属性会被收窄为 `never`。
        const req = msg.request as Record<string, unknown>
        if (msg.request.subtype === 'interrupt') {
          // 追踪 escape 次数用于归因（ant 专属 feature）
          if (feature('COMMIT_ATTRIBUTION')) {
            setAppState(prev => ({
              ...prev,
              attribution: {
                ...prev.attribution,
                escapeCount: prev.attribution.escapeCount + 1,
              },
            }))
          }
          if (abortController) {
            abortController.abort()
          }
          suggestionState.abortController?.abort()
          suggestionState.abortController = null
          suggestionState.lastEmitted = null
          suggestionState.pendingSuggestion = null
          sendControlResponseSuccess(msg)
        } else if (req.subtype === 'end_session') {
          logForDebugging(
            `[print.ts] end_session received, reason=${req.reason ?? 'unspecified'}`,
          )
          if (abortController) {
            abortController.abort()
          }
          suggestionState.abortController?.abort()
          suggestionState.abortController = null
          suggestionState.lastEmitted = null
          suggestionState.pendingSuggestion = null
          sendControlResponseSuccess(msg)
          break // 退出 for-await → 进入下方 inputClosed=true 的排空分支
        } else if (msg.request.subtype === 'initialize') {
          // 来自 initialize 消息的 SDK MCP server 名称
          // 由 browser 和 ProcessTransport 会话两端共同填充
          if (
            msg.request.sdkMcpServers &&
            msg.request.sdkMcpServers.length > 0
          ) {
            for (const serverName of msg.request.sdkMcpServers) {
              // 为 SDK MCP server 创建占位 config
              // 实际的 server 连接由 SDK Query 类管理
              sdkMcpConfigs[serverName] = {
                type: 'sdk',
                name: serverName,
              }
            }
          }

          await handleInitializeRequest(
            msg.request,
            msg.request_id,
            initialized,
            output,
            commands,
            modelInfos,
            structuredIO,
            !!options.enableAuthStatus,
            options,
            agents,
            getAppState,
          )

          // 当 SDK 消费方主动开启时，在 AppState 中启用 prompt 建议。
          // shouldEnablePromptSuggestion() 对非交互式会话会返回 false，
          // 但这里 SDK 消费方明确请求了 suggestions。
          if (msg.request.promptSuggestions) {
            setAppState(prev => {
              if (prev.promptSuggestionEnabled) return prev
              return { ...prev, promptSuggestionEnabled: true }
            })
          }

          if (
            msg.request.agentProgressSummaries &&
            getFeatureValue_CACHED_MAY_BE_STALE('tengu_slate_prism', true)
          ) {
            setSdkAgentProgressSummariesEnabled(true)
          }

          initialized = true

          // 如果自动恢复逻辑预先入队了命令，在 initialize 设置完
          // systemPrompt、agents、hooks 等之后立即排空它。
          if (hasCommandsInQueue()) {
            void run()
          }
        } else if (msg.request.subtype === 'set_permission_mode') {
          const m = msg.request // 为 TypeScript 准备（TODO: 改用 readonly 类型以避免此举）
          setAppState(prev => ({
            ...prev,
            toolPermissionContext: handleSetPermissionMode(
              m,
              msg.request_id,
              prev.toolPermissionContext,
              output,
            ),
            isUltraplanMode: m.ultraplan ?? prev.isUltraplanMode,
          }))
          // handleSetPermissionMode 会发送 control_response；此处过去跟随的
          // notifySessionMetadataChanged 现已由 onChangeAppState 触发（带外部化的
          // mode 名称）。
        } else if (msg.request.subtype === 'set_model') {
          const requestedModel = msg.request.model ?? 'default'
          const model =
            requestedModel === 'default'
              ? getDefaultMainLoopModel()
              : requestedModel
          activeUserSpecifiedModel = model
          setMainLoopModelOverride(model)
          notifySessionMetadataChanged({ model })
          injectModelSwitchBreadcrumbs(requestedModel, model)

          sendControlResponseSuccess(msg)
        } else if (msg.request.subtype === 'set_max_thinking_tokens') {
          if (msg.request.max_thinking_tokens === null) {
            options.thinkingConfig = undefined
          } else if (msg.request.max_thinking_tokens === 0) {
            options.thinkingConfig = { type: 'disabled' }
          } else {
            options.thinkingConfig = {
              type: 'enabled',
              budgetTokens: msg.request.max_thinking_tokens,
            }
          }
          sendControlResponseSuccess(msg)
        } else if (msg.request.subtype === 'mcp_status') {
          sendControlResponseSuccess(msg, {
            mcpServers: buildMcpServerStatuses(),
          })
        } else if (msg.request.subtype === 'get_context_usage') {
          try {
            const appState = getAppState()
            const data = await collectContextData({
              messages: mutableMessages,
              getAppState,
              options: {
                mainLoopModel: getMainLoopModel(),
                tools: buildAllTools(appState),
                agentDefinitions: appState.agentDefinitions,
                customSystemPrompt: options.systemPrompt,
                appendSystemPrompt: options.appendSystemPrompt,
              },
            })
            sendControlResponseSuccess(msg, { ...data })
          } catch (error) {
            sendControlResponseError(msg, errorMessage(error))
          }
        } else if (msg.request.subtype === 'mcp_message') {
          // 处理来自 SDK server 的 MCP notification
          const mcpRequest = msg.request as Record<string, unknown>
          const sdkClient = sdkClients.find(
            client => client.name === mcpRequest.server_name,
          )
          // 检查 client 是否存在 —— 动态加入的 SDK server 在 updateSdkMcp()
          // 运行之前可能持有 null client 的占位 client
          if (
            sdkClient &&
            sdkClient.type === 'connected' &&
            sdkClient.client?.transport?.onmessage
          ) {
            sdkClient.client.transport.onmessage(
              mcpRequest.message as import('@modelcontextprotocol/sdk/types.js').JSONRPCMessage,
            )
          }
          sendControlResponseSuccess(msg)
        } else if (msg.request.subtype === 'rewind_files') {
          const appState = getAppState()
          const result = await handleRewindFiles(
            msg.request.user_message_id as UUID,
            appState,
            setAppState,
            msg.request.dry_run ?? false,
          )
          if (result.canRewind || msg.request.dry_run) {
            sendControlResponseSuccess(msg, result)
          } else {
            sendControlResponseError(
              msg,
              (result.error as string) ?? 'Unexpected error',
            )
          }
        } else if (msg.request.subtype === 'cancel_async_message') {
          const targetUuid = msg.request.message_uuid
          const removed = dequeueAllMatching(cmd => cmd.uuid === targetUuid)
          sendControlResponseSuccess(msg, {
            cancelled: removed.length > 0,
          })
        } else if (msg.request.subtype === 'seed_read_state') {
          // 客户端观测到一次 Read，但该 Read 随后被从上下文中移除（例如被 snip
          // 移除），因此基于 transcript 的 seeding 错过了它。将其加入
          // pendingSeeds；在下一次 clone-replace 边界处应用。
          try {
            // expandPath：所有其他的 readFileState 写入方都会进行归一化（~、
            // 相对路径、session cwd 与 process cwd 的差异）。FileEditTool 按
            // expandPath 后的 key 查找 —— 客户端字面路径会查不到。
            const normalizedPath = expandPath(msg.request.path)
            // 读取内容之前先检查磁盘 mtime。如果文件自客户端观测以来发生了
            // 变化，readFile 会返回 C_current，但我们仍会以客户端的 M_observed
            // 存储 —— getChangedFiles 随后会看到 disk > cache.timestamp，重新
            // 读取，对比 C_current 与 C_current = 空，不发出任何 attachment，
            // 模型永远不知道 C_observed → C_current 的变化。跳过 seeding
            // 会让 Edit 失败并报 "file not read yet" → 强制进行一次新的 Read。
            // Math.floor 与 FileReadTool 和 getFileModificationTime 保持一致。
            const diskMtime = Math.floor((await stat(normalizedPath)).mtimeMs)
            if (diskMtime <= msg.request.mtime) {
              const raw = await readFile(normalizedPath, 'utf-8')
              // 去除 BOM 并将 CRLF 归一化为 LF，与 readFileInRange 和
              // readFileSyncWithMetadata 保持一致。FileEditTool 的内容比较
              // 回退逻辑（针对 Windows 上 mtime 变化但内容未变的情况）会与
              // LF 归一化后的磁盘读取结果进行对比。
              const content = (
                raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
              ).replaceAll('\r\n', '\n')
              pendingSeeds.set(normalizedPath, {
                content,
                timestamp: diskMtime,
                offset: undefined,
                limit: undefined,
              })
            }
          } catch {
            // ENOENT 等 —— 跳过 seeding，但仍返回成功
          }
          sendControlResponseSuccess(msg)
        } else if (msg.request.subtype === 'mcp_set_servers') {
          const { response, sdkServersChanged } = await applyMcpServerChanges(
            msg.request.servers as Record<
              string,
              McpServerConfigForProcessTransport
            >,
          )
          sendControlResponseSuccess(msg, response)

          // 在响应之后才连接 SDK server，避免死锁
          if (sdkServersChanged) {
            void updateSdkMcp()
          }
        } else if (msg.request.subtype === 'reload_plugins') {
          try {
            if (
              feature('DOWNLOAD_USER_SETTINGS') &&
              (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) || getIsRemoteMode())
            ) {
              // 重新拉取用户设置，使从用户本地 CLI 推送过来的 enabledPlugins
              // 在缓存清理之前生效。
              const applied = await redownloadUserSettings()
              if (applied) {
                settingsChangeDetector.notifyChange('userSettings')
              }
            }

            const r = await refreshActivePlugins(setAppState)

            const sdkAgents = currentAgents.filter(
              a => a.source === 'flagSettings',
            )
            currentAgents = [...r.agentDefinitions.allAgents, ...sdkAgents]

            // 重载成功 —— 尽力收集响应数据，避免一次读取失败掩盖成功的状态变更。
            // 使用 allSettled 使一个失败不会丢弃其他结果。
            let plugins: SDKControlReloadPluginsResponse['plugins'] = []
            const [cmdsR, mcpR, pluginsR] = await Promise.allSettled([
              getCommands(cwd()),
              applyPluginMcpDiff(),
              loadAllPluginsCacheOnly(),
            ])
            if (cmdsR.status === 'fulfilled') {
              currentCommands = cmdsR.value
            } else {
              logError(cmdsR.reason)
            }
            if (mcpR.status === 'rejected') {
              logError(mcpR.reason)
            }
            if (pluginsR.status === 'fulfilled') {
              plugins = pluginsR.value.enabled.map(p => ({
                name: p.name,
                path: p.path,
                source: p.source,
              }))
            } else {
              logError(pluginsR.reason)
            }

            sendControlResponseSuccess(msg, {
              commands: currentCommands
                .filter(cmd => cmd.userInvocable !== false)
                .map(cmd => ({
                  name: getCommandName(cmd),
                  description: formatDescriptionWithSource(cmd),
                  argumentHint: cmd.argumentHint || '',
                })),
              agents: currentAgents.map(a => ({
                name: a.agentType,
                description: a.whenToUse,
                model: a.model === 'inherit' ? undefined : a.model,
              })),
              plugins,
              mcpServers:
                buildMcpServerStatuses() as SDKControlReloadPluginsResponse['mcpServers'],
              error_count: r.error_count,
            } satisfies SDKControlReloadPluginsResponse)
          } catch (error) {
            sendControlResponseError(msg, errorMessage(error))
          }
        } else if (msg.request.subtype === 'mcp_reconnect') {
          const currentAppState = getAppState()
          const { serverName } = msg.request
          elicitationRegistered.delete(serverName)
          // config 存在性检查必须覆盖与下方操作相同的来源。SDK 注入的 server
          // （query({mcpServers:{...}})）和动态添加的 server 之前在此缺失，因此
          // toggleMcpServer/reconnect 即使断开/重连本可以工作，也返回了
          // "Server not found"（gh-31339 / CC-314）。
          const config =
            getMcpConfigByName(serverName) ??
            mcpClients.find(c => c.name === serverName)?.config ??
            sdkClients.find(c => c.name === serverName)?.config ??
            dynamicMcpState.clients.find(c => c.name === serverName)?.config ??
            currentAppState.mcp.clients.find(c => c.name === serverName)
              ?.config ??
            null
          if (!config) {
            sendControlResponseError(msg, `Server not found: ${serverName}`)
          } else {
            const result = await reconnectMcpServerImpl(serverName, config)
            // 用新的 client、tools、commands 和 resources 更新 appState.mcp
            const prefix = getMcpPrefix(serverName)
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                clients: prev.mcp.clients.map(c =>
                  c.name === serverName ? result.client : c,
                ),
                tools: [
                  ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                  ...result.tools,
                ],
                commands: [
                  ...reject(prev.mcp.commands, c =>
                    commandBelongsToServer(c, serverName),
                  ),
                  ...result.commands,
                ],
                resources:
                  result.resources && result.resources.length > 0
                    ? { ...prev.mcp.resources, [serverName]: result.resources }
                    : omit(prev.mcp.resources, serverName),
              },
            }))
            // 同时更新 dynamicMcpState，使 run() 在下一个回合能拿到新的 tools
            // （run() 读的是 dynamicMcpState，而不是 appState）
            dynamicMcpState = {
              ...dynamicMcpState,
              clients: [
                ...dynamicMcpState.clients.filter(c => c.name !== serverName),
                result.client,
              ],
              tools: [
                ...dynamicMcpState.tools.filter(
                  t => !t.name?.startsWith(prefix),
                ),
                ...result.tools,
              ],
            }
            if (result.client.type === 'connected') {
              registerElicitationHandlers([result.client])
              reregisterChannelHandlerAfterReconnect(result.client)
              sendControlResponseSuccess(msg)
            } else {
              const errorMessage =
                result.client.type === 'failed'
                  ? (result.client.error ?? 'Connection failed')
                  : `Server status: ${result.client.type}`
              sendControlResponseError(msg, errorMessage)
            }
          }
        } else if (msg.request.subtype === 'mcp_toggle') {
          const currentAppState = getAppState()
          const { serverName, enabled } = msg.request
          elicitationRegistered.delete(serverName)
          // 检查必须与下方 client 查找的展开范围一致（其中包含 sdkClients
          // 和 dynamicMcpState.clients）。与上方 mcp_reconnect 是同一个修复
          // （gh-31339 / CC-314）。
          const config =
            getMcpConfigByName(serverName) ??
            mcpClients.find(c => c.name === serverName)?.config ??
            sdkClients.find(c => c.name === serverName)?.config ??
            dynamicMcpState.clients.find(c => c.name === serverName)?.config ??
            currentAppState.mcp.clients.find(c => c.name === serverName)
              ?.config ??
            null

          if (!config) {
            sendControlResponseError(msg, `Server not found: ${serverName}`)
          } else if (!enabled) {
            // 禁用：持久化 + 断开连接（与 TUI 的 toggleMcpServer 行为一致）
            setMcpServerEnabled(serverName, false)
            const client = [
              ...mcpClients,
              ...sdkClients,
              ...dynamicMcpState.clients,
              ...currentAppState.mcp.clients,
            ].find(c => c.name === serverName)
            if (client && client.type === 'connected') {
              await clearServerCache(serverName, config)
            }
            // 更新 appState.mcp 以反映禁用状态，并移除相应的 tools/commands/resources
            const prefix = getMcpPrefix(serverName)
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                clients: prev.mcp.clients.map(c =>
                  c.name === serverName
                    ? { name: serverName, type: 'disabled' as const, config }
                    : c,
                ),
                tools: reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                commands: reject(prev.mcp.commands, c =>
                  commandBelongsToServer(c, serverName),
                ),
                resources: omit(prev.mcp.resources, serverName),
              },
            }))
            sendControlResponseSuccess(msg)
          } else {
            // 启用：持久化 + 重连
            setMcpServerEnabled(serverName, true)
            const result = await reconnectMcpServerImpl(serverName, config)
            // 用新的 client、tools、commands 和 resources 更新 appState.mcp
            // 以确保启用 server 后 LLM 能看到更新后的 tools
            const prefix = getMcpPrefix(serverName)
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                clients: prev.mcp.clients.map(c =>
                  c.name === serverName ? result.client : c,
                ),
                tools: [
                  ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                  ...result.tools,
                ],
                commands: [
                  ...reject(prev.mcp.commands, c =>
                    commandBelongsToServer(c, serverName),
                  ),
                  ...result.commands,
                ],
                resources:
                  result.resources && result.resources.length > 0
                    ? { ...prev.mcp.resources, [serverName]: result.resources }
                    : omit(prev.mcp.resources, serverName),
              },
            }))
            if (result.client.type === 'connected') {
              registerElicitationHandlers([result.client])
              reregisterChannelHandlerAfterReconnect(result.client)
              sendControlResponseSuccess(msg)
            } else {
              const errorMessage =
                result.client.type === 'failed'
                  ? (result.client.error ?? 'Connection failed')
                  : `Server status: ${result.client.type}`
              sendControlResponseError(msg, errorMessage)
            }
          }
        } else if (req.subtype === 'channel_enable') {
          const currentAppState = getAppState()
          handleChannelEnable(
            msg.request_id,
            req.serverName as string,
            // client 池的展开与 mcp_status 保持一致 —— 包含全部三个 client 来源。
            [
              ...currentAppState.mcp.clients,
              ...sdkClients,
              ...dynamicMcpState.clients,
            ],
            output,
          )
        } else if (req.subtype === 'mcp_authenticate') {
          const serverName = req.serverName as string
          const currentAppState = getAppState()
          const config =
            getMcpConfigByName(serverName) ??
            mcpClients.find(c => c.name === serverName)?.config ??
            currentAppState.mcp.clients.find(c => c.name === serverName)
              ?.config ??
            null
          if (!config) {
            sendControlResponseError(msg, `Server not found: ${serverName}`)
          } else if (config.type !== 'sse' && config.type !== 'http') {
            sendControlResponseError(
              msg,
              `Server type "${config.type}" does not support OAuth authentication`,
            )
          } else {
            try {
              // 中止该 server 之前进行中的 OAuth 流程
              activeOAuthFlows.get(serverName as string)?.abort()
              const controller = new AbortController()
              activeOAuthFlows.set(serverName as string, controller)

              // 从回调中捕获 auth URL
              let resolveAuthUrl: (url: string) => void
              const authUrlPromise = new Promise<string>(resolve => {
                resolveAuthUrl = resolve
              })

              // 在后台启动 OAuth 流程
              const oauthPromise = performMCPOAuthFlow(
                serverName as string,
                config,
                url => resolveAuthUrl!(url),
                controller.signal,
                {
                  skipBrowserOpen: true,
                  onWaitingForCallback: submit => {
                    oauthCallbackSubmitters.set(serverName as string, submit)
                  },
                },
              )

              // 等待 auth URL（或流程在没有重定向需求的情况下直接完成）
              const authUrl = await Promise.race([
                authUrlPromise,
                oauthPromise.then(() => null as string | null),
              ])

              if (authUrl) {
                sendControlResponseSuccess(msg, {
                  authUrl,
                  requiresUserAction: true,
                })
              } else {
                sendControlResponseSuccess(msg, {
                  requiresUserAction: false,
                })
              }

              // 为 mcp_oauth_callback_url handler 存储仅认证的 promise。
              // 不要吞掉错误 —— callback handler 需要检测认证失败并上报给调用方。
              oauthAuthPromises.set(serverName, oauthPromise)

              // 处理后台完成 —— 在认证之后进行重连。
              // 当使用手动 callback 时，这里跳过重连；
              // 扩展的 handleAuthDone → mcp_reconnect 会负责处理
              // （它也会更新 dynamicMcpState 以完成工具注册）。
              const fullFlowPromise = oauthPromise
                .then(async () => {
                  // 如果 server 在 OAuth 流程期间被禁用，则不重连
                  if (isMcpServerDisabled(serverName as string)) {
                    return
                  }
                  // 如果使用了手动 callback 路径则跳过重连 ——
                  // handleAuthDone 会通过 mcp_reconnect 完成
                  // （它也会更新 dynamicMcpState 以完成工具注册）。
                  if (oauthManualCallbackUsed.has(serverName as string)) {
                    return
                  }
                  // 认证成功后重连 server
                  const result = await reconnectMcpServerImpl(
                    serverName as string,
                    config,
                  )
                  const prefix = getMcpPrefix(serverName as string)
                  setAppState(prev => ({
                    ...prev,
                    mcp: {
                      ...prev.mcp,
                      clients: prev.mcp.clients.map(c =>
                        c.name === (serverName as string) ? result.client : c,
                      ),
                      tools: [
                        ...reject(prev.mcp.tools, t =>
                          t.name?.startsWith(prefix),
                        ),
                        ...result.tools,
                      ],
                      commands: [
                        ...reject(prev.mcp.commands, c =>
                          commandBelongsToServer(c, serverName as string),
                        ),
                        ...result.commands,
                      ],
                      resources:
                        result.resources && result.resources.length > 0
                          ? {
                              ...prev.mcp.resources,
                              [serverName as string]: result.resources,
                            }
                          : omit(prev.mcp.resources, serverName as string),
                    },
                  }))
                  // 同时更新 dynamicMcpState，使 run() 在下一个回合能拿到新的 tools
                  // （run() 读的是 dynamicMcpState，而不是 appState）
                  dynamicMcpState = {
                    ...dynamicMcpState,
                    clients: [
                      ...dynamicMcpState.clients.filter(
                        c => c.name !== serverName,
                      ),
                      result.client,
                    ],
                    tools: [
                      ...dynamicMcpState.tools.filter(
                        t => !t.name?.startsWith(prefix),
                      ),
                      ...result.tools,
                    ],
                  }
                })
                .catch(error => {
                  logForDebugging(
                    `MCP OAuth failed for ${serverName as string}: ${error}`,
                    { level: 'error' },
                  )
                })
                .finally(() => {
                  // 仅当这仍是当前活跃的流程时才清理
                  if (
                    activeOAuthFlows.get(serverName as string) === controller
                  ) {
                    activeOAuthFlows.delete(serverName as string)
                    oauthCallbackSubmitters.delete(serverName as string)
                    oauthManualCallbackUsed.delete(serverName as string)
                    oauthAuthPromises.delete(serverName as string)
                  }
                })
              void fullFlowPromise
            } catch (error) {
              sendControlResponseError(msg, errorMessage(error))
            }
          }
        } else if (req.subtype === 'mcp_oauth_callback_url') {
          const serverName = req.serverName as string
          const callbackUrl = req.callbackUrl as string
          const submit = oauthCallbackSubmitters.get(serverName)
          if (submit) {
            // 提交前先校验 callback URL。auth.ts 中的 submit callback 会
            // 静默忽略缺少 code 参数的 URL，这会让 auth promise 永远得不到
            // resolve，并把 control 消息循环阻塞到超时。
            let hasCodeOrError = false
            try {
              const parsed = new URL(callbackUrl as string | URL)
              hasCodeOrError =
                parsed.searchParams.has('code') ||
                parsed.searchParams.has('error')
            } catch {
              // 无效 URL
            }
            if (!hasCodeOrError) {
              sendControlResponseError(
                msg,
                'Invalid callback URL: missing authorization code. Please paste the full redirect URL including the code parameter.',
              )
            } else {
              oauthManualCallbackUsed.add(serverName)
              submit(callbackUrl as string)
              // 在响应之前等待认证（token 交换）完成。
              // 重连由扩展通过 handleAuthDone → mcp_reconnect 处理
              // （它会更新 dynamicMcpState 以注册 tools）。
              const authPromise = oauthAuthPromises.get(serverName)
              if (authPromise) {
                try {
                  await authPromise
                  sendControlResponseSuccess(msg)
                } catch (error) {
                  sendControlResponseError(
                    msg,
                    error instanceof Error
                      ? error.message
                      : 'OAuth authentication failed',
                  )
                }
              } else {
                sendControlResponseSuccess(msg)
              }
            }
          } else {
            sendControlResponseError(
              msg,
              `No active OAuth flow for server: ${serverName}`,
            )
          }
        } else if (req.subtype === 'claude_authenticate') {
          // 通过 control 通道进行的 Anthropic OAuth。SDK client 拥有用户的
          // 浏览器（我们在 -p 模式下是 headless 的）；我们把两个 URL 都回传
          // 并等待。automatic URL → localhost listener 会在浏览器与当前主机
          // 相同时捕获到重定向；manual URL → 成功页会展示 "code#state" 用于
          // claude_oauth_callback。
          const loginWithClaudeAi = req.loginWithClaudeAi as boolean | undefined

          // 清理之前可能存在的流程。cleanup() 会关闭 localhost listener 并
          // 清空 manual resolver。之前的 `flow` promise 会保持 pending
          // （AuthCodeListener.close() 不会 reject），但其对象图在 server
          // handle 释放后就会变得不可达，随后被 GC —— 不会占用任何 fd 或端口。
          claudeOAuth?.service.cleanup()

          logEvent('tengu_oauth_flow_start', {
            loginWithClaudeAi: (loginWithClaudeAi ?? true) as boolean | number,
          })

          const service = new OAuthService()
          let urlResolver!: (urls: {
            manualUrl: string
            automaticUrl: string
          }) => void
          const urlPromise = new Promise<{
            manualUrl: string
            automaticUrl: string
          }>(resolve => {
            urlResolver = resolve
          })

          const flow = service
            .startOAuthFlow(
              async (manualUrl, automaticUrl) => {
                // 当设置了 skipBrowserOpen 时，automaticUrl 一定有定义；
                // 该参数之所以可选，只是为了兼容已有的单参数调用方。
                urlResolver({ manualUrl, automaticUrl: automaticUrl! })
              },
              {
                loginWithClaudeAi: (loginWithClaudeAi ?? true) as boolean,
                skipBrowserOpen: true,
              },
            )
            .then(async tokens => {
              // installOAuthTokens：performLogout（清理过期状态）→
              // store profile → saveOAuthTokensIfNeeded → clearOAuthTokenCache
              // → clearAuthRelatedCaches。resolve 之后，本进程中 memoized 的
              // getClaudeAIOAuthTokens 即被作废；下一次 API 调用会重新读取
              // keychain/file 并正常工作。无需重启进程。
              await installOAuthTokens(tokens)
              logEvent('tengu_oauth_success', {
                loginWithClaudeAi: (loginWithClaudeAi ?? true) as
                  | boolean
                  | number,
              })
            })
            .finally(() => {
              service.cleanup()
              if (claudeOAuth?.service === service) {
                claudeOAuth = null
              }
            })

          claudeOAuth = { service, flow }

          // 在 await 之前挂上 rejection handler，避免同步的 startOAuthFlow
          // 失败被上报为 unhandled rejection。claude_oauth_callback handler
          // 会在手动路径上重新 await flow，并把真实错误暴露给客户端。
          void flow.catch(err =>
            logForDebugging(`claude_authenticate flow ended: ${err}`, {
              level: 'info',
            }),
          )

          try {
            // 与 flow 竞速：如果 startOAuthFlow 在调用 authURLHandler 之前就
            // reject（例如 AuthCodeListener.start() 因 EACCES 或 fd 耗尽而失败），
            // urlPromise 会永远 pending 并卡住 stdin 循环。实践中 flow 不可能
            // 先 resolve（它正挂起等待的就是我们正在等待的那些 url）。
            const { manualUrl, automaticUrl } = await Promise.race([
              urlPromise,
              flow.then(() => {
                throw new Error(
                  'OAuth flow completed without producing auth URLs',
                )
              }),
            ])
            sendControlResponseSuccess(msg, {
              manualUrl,
              automaticUrl,
            })
          } catch (error) {
            sendControlResponseError(msg, errorMessage(error))
          }
        } else if (
          req.subtype === 'claude_oauth_callback' ||
          req.subtype === 'claude_oauth_wait_for_completion'
        ) {
          if (!claudeOAuth) {
            sendControlResponseError(msg, 'No active claude_authenticate flow')
          } else {
            // 同步注入手动 code —— 必须按 stdin 消息顺序执行，确保后续的
            // claude_authenticate 不会在 code 到位之前替换掉 service。
            if (req.subtype === 'claude_oauth_callback') {
              claudeOAuth.service.handleManualAuthCodeInput({
                authorizationCode: req.authorizationCode as string,
                state: req.state as string,
              })
            }
            // 将 await 解耦 —— stdin 读取是串行的，阻塞在此会让
            // claude_oauth_wait_for_completion 死锁：flow 可能只能通过
            // 未来的 stdin 上的 claude_oauth_callback 才会 resolve，
            // 而我们停在原地时根本读不到。捕获绑定；claudeOAuth 会在
            // flow 自己的 .finally 中被置为 null。
            const { flow } = claudeOAuth
            void flow.then(
              () => {
                const accountInfo = getAccountInformation()
                sendControlResponseSuccess(msg, {
                  account: {
                    email: accountInfo?.email,
                    organization: accountInfo?.organization,
                    subscriptionType: accountInfo?.subscription,
                    tokenSource: accountInfo?.tokenSource,
                    apiKeySource: accountInfo?.apiKeySource,
                    apiProvider: getAPIProvider(),
                  },
                })
              },
              (error: unknown) =>
                sendControlResponseError(msg, errorMessage(error)),
            )
          }
        } else if (req.subtype === 'mcp_clear_auth') {
          const serverName = req.serverName as string
          const currentAppState = getAppState()
          const config =
            getMcpConfigByName(serverName) ??
            mcpClients.find(c => c.name === serverName)?.config ??
            currentAppState.mcp.clients.find(c => c.name === serverName)
              ?.config ??
            null
          if (!config) {
            sendControlResponseError(msg, `Server not found: ${serverName}`)
          } else if (config.type !== 'sse' && config.type !== 'http') {
            sendControlResponseError(
              msg,
              `Cannot clear auth for server type "${config.type}"`,
            )
          } else {
            await revokeServerTokens(serverName, config)
            const result = await reconnectMcpServerImpl(serverName, config)
            const prefix = getMcpPrefix(serverName)
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                clients: prev.mcp.clients.map(c =>
                  c.name === (serverName as string) ? result.client : c,
                ),
                tools: [
                  ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                  ...result.tools,
                ],
                commands: [
                  ...reject(prev.mcp.commands, c =>
                    commandBelongsToServer(c, serverName),
                  ),
                  ...result.commands,
                ],
                resources:
                  result.resources && result.resources.length > 0
                    ? {
                        ...prev.mcp.resources,
                        [serverName]: result.resources,
                      }
                    : omit(prev.mcp.resources, serverName),
              },
            }))
            sendControlResponseSuccess(msg, {})
          }
        } else if (msg.request.subtype === 'apply_flag_settings') {
          // 应用之前先快照当前 model —— 我们需要检测 model 切换，
          // 以便注入 breadcrumb 并通知 listener。
          const prevModel = getMainLoopModel()

          // 将传入的设置合并到内存中的 flag 设置
          const existing = getFlagSettingsInline() ?? {}
          const incoming = msg.request.settings
          // 对顶层 key 进行浅合并；getSettingsForSource 通过 mergeWith 负责与
          // 基于文件的 flag 设置的深度合并。
          // JSON 序列化会丢弃 `undefined`，所以调用方使用 `null` 表示
          // "清除该 key"。把 null 转为删除，这样 SettingsSchema().safeParse()
          // 才不会因为整个对象被拒（z.string().optional() 接受 string | undefined，
          // 而不是 null）。
          const merged = { ...existing, ...incoming }
          for (const key of Object.keys(merged)) {
            if (merged[key as keyof typeof merged] === null) {
              delete merged[key as keyof typeof merged]
            }
          }
          setFlagSettingsInline(merged)
          // 走 notifyChange 路径，让 fanOut() 在 listener 运行之前重置设置缓存。
          // :392 处的订阅方会为我们调用 applySettingsChange。#20625 之前这里是
          // 直接调用 applySettingsChange()，依赖其内部的重置 —— 现在重置集中在
          // fanOut 中，若直接调用则会读到过期的缓存设置，从而静默丢弃更新。
          // 附带好处：走 notifyChange 还能让其他订阅方（loadPluginHooks、
          // sandbox-adapter）知道这次变更，而这正是之前的直接调用所跳过的。
          settingsChangeDetector.notifyChange('flagSettings')

          // 如果传入的设置中包含 model 变更，则更新 override，使
          // getMainLoopModel() 能反映该变更。override 在
          // getUserSpecifiedModelSetting() 中优先级高于设置级联，
          // 若不更新，getMainLoopModel() 会返回过期的 override，model 变更
          // 会被静默忽略（与 :2811 的 set_model 行为一致）。
          if ('model' in incoming) {
            if (incoming.model != null) {
              setMainLoopModelOverride(String(incoming.model))
            } else {
              setMainLoopModelOverride(undefined)
            }
          }

          // 如果 model 发生了变化，注入 breadcrumb 让模型看到这次会话中途的切换，
          // 并通知 metadata listener（CCR）。
          const newModel = getMainLoopModel()
          if (newModel !== prevModel) {
            activeUserSpecifiedModel = newModel
            const modelArg = incoming.model ? String(incoming.model) : 'default'
            notifySessionMetadataChanged({ model: newModel })
            injectModelSwitchBreadcrumbs(modelArg, newModel)
          }

          sendControlResponseSuccess(msg)
        } else if (msg.request.subtype === 'get_settings') {
          const currentAppState = getAppState()
          const model = getMainLoopModel()
          // modelSupportsEffort 的门控与 claude.ts 保持一致 —— applied.effort 必须
          // 反映真正发往 API 的内容，而不仅仅是配置的内容。
          const effort = modelSupportsEffort(model)
            ? resolveAppliedEffort(model, currentAppState.effortValue)
            : undefined
          sendControlResponseSuccess(msg, {
            ...getSettingsWithSources(),
            applied: {
              model,
              // 数值型 effort（ant 专属）→ null；SDK schema 只接受字符串级别。
              effort: typeof effort === 'string' ? effort : null,
            },
          })
        } else if (msg.request.subtype === 'stop_task') {
          const { task_id: taskId } = msg.request
          try {
            await stopTask(taskId, {
              getAppState,
              setAppState,
            })
            sendControlResponseSuccess(msg, {})
          } catch (error) {
            sendControlResponseError(msg, errorMessage(error))
          }
        } else if (req.subtype === 'generate_session_title') {
          // 触发即忘（fire-and-forget），避免 Haiku 调用阻塞 stdin 循环
          // （否则会延迟后续用户消息 / 中断的处理，延迟时长即该次 API 往返时间）。
          const description = req.description as string
          const persist = req.persist as boolean
          // 仅当当前 controller 尚未被 abort（例如被 interrupt() 中止）时才复用它；
          // 已 abort 的 signal 会让 queryHaiku 立即抛出 APIUserAbortError
          // → {title: null}。
          const titleSignal = (
            abortController && !abortController.signal.aborted
              ? abortController
              : createAbortController()
          ).signal
          void (async () => {
            try {
              const title = await generateSessionTitle(description, titleSignal)
              if (title && persist) {
                try {
                  saveAiGeneratedTitle(getSessionId() as UUID, title)
                } catch (e) {
                  logError(e)
                }
              }
              sendControlResponseSuccess(msg, { title })
            } catch (e) {
              // 实践中不可达 —— generateSessionTitle 内部已包裹并返回 null，
              // saveAiGeneratedTitle 也已在上方包裹。此处继续向上抛出
              // （而不是吞掉），使意外失败能被 SDK 调用方看到
              // （hostComms.ts 会捕获并记录日志）。
              sendControlResponseError(msg, errorMessage(e))
            }
          })()
        } else if (req.subtype === 'side_question') {
          // 与上方 generate_session_title 相同的 fire-and-forget 模式 ——
          // fork 出的 agent 的 API 往返不能阻塞 stdin 循环。
          //
          // stopHooks（当 querySource === 'sdk' 时）捕获的快照保存了上一次
          // 主线程回合所发送的精确 systemPrompt/userContext/systemContext/
          // messages。复用它们可以得到字节级一致的前缀 → 命中 prompt 缓存。
          //
          // 回退路径（第一次回合完成之前 resume —— 还没有快照）：
          // 从零重建。buildSideQuestionFallbackParams 镜像了
          // QueryEngine.ts:ask() 的 system prompt 组装逻辑（包含
          // --system-prompt / --append-system-prompt），使重建出的前缀
          // 在常见情况下能匹配上。在 coordinator 模式或 memory-mechanics 额外
          // 内容下仍可能错失缓存 —— 可接受，另一种选择是 side question 直接失败。
          const question = req.question as string
          void (async () => {
            try {
              const saved = getLastCacheSafeParams()
              const cacheSafeParams = saved
                ? {
                    ...saved,
                    // 如果上一回合被中断，快照中持有的就是一个已经 abort 的
                    // controller；否则 createSubagentContext 会把它传递下去，导致 fork
                    // 在发请求之前就死掉。该 controller 并不属于 cache key ——
                    // 替换成一个全新的 controller 是安全的。与上方
                    // generate_session_title 的保护逻辑一致。
                    toolUseContext: {
                      ...saved.toolUseContext,
                      abortController: createAbortController(),
                    },
                  }
                : await buildSideQuestionFallbackParams({
                    tools: buildAllTools(getAppState()),
                    commands: currentCommands,
                    mcpClients: [
                      ...getAppState().mcp.clients,
                      ...sdkClients,
                      ...dynamicMcpState.clients,
                    ],
                    messages: mutableMessages,
                    readFileState,
                    getAppState,
                    setAppState,
                    customSystemPrompt: options.systemPrompt,
                    appendSystemPrompt: options.appendSystemPrompt,
                    thinkingConfig: options.thinkingConfig,
                    agents: currentAgents,
                  })
              const result = await runSideQuestion({
                question,
                cacheSafeParams,
              })
              sendControlResponseSuccess(msg, { response: result.response })
            } catch (e) {
              sendControlResponseError(msg, errorMessage(e))
            }
          })()
        } else if (
          (feature('PROACTIVE') || feature('KAIROS')) &&
          (msg.request as { subtype: string }).subtype === 'set_proactive'
        ) {
          const req = msg.request as unknown as {
            subtype: string
            enabled: boolean
          }
          if (req.enabled) {
            if (!proactiveModule!.isProactiveActive()) {
              proactiveModule!.activateProactive('command')
              scheduleProactiveTick!()
            }
          } else {
            proactiveModule!.deactivateProactive()
          }
          sendControlResponseSuccess(msg)
        } else if (req.subtype === 'remote_control') {
          if (req.enabled as boolean) {
            if (bridgeHandle) {
              // 已连接
              sendControlResponseSuccess(msg, {
                session_url: getRemoteSessionUrl(
                  bridgeHandle.bridgeSessionId,
                  bridgeHandle.sessionIngressUrl,
                ),
                connect_url: buildBridgeConnectUrl(
                  bridgeHandle.environmentId,
                  bridgeHandle.sessionIngressUrl,
                ),
                environment_id: bridgeHandle.environmentId,
              })
            } else {
              // initReplBridge 会通过 onStateChange('failed', detail) 在返回 null
              // 之前暴露门控失败的原因。捕获该详情，使 control-response 的错误
              // 是可操作的（"/login"、"disabled by your organization's policy" 等），
              // 而不是一条泛泛的 "initialization failed"。
              let bridgeFailureDetail: string | undefined
              try {
                const { initReplBridge } = await import(
                  'src/bridge/initReplBridge.js'
                )
                const handle = await initReplBridge({
                  onInboundMessage(msg) {
                    const fields = extractInboundMessageFields(msg)
                    if (!fields) return
                    const { content, uuid } = fields
                    enqueue({
                      value: content,
                      mode: 'prompt' as const,
                      uuid,
                      skipSlashCommands: true,
                    })
                    void run()
                  },
                  onPermissionResponse(response) {
                    // 把 bridge 的权限响应转发到 stdin 处理循环，
                    // 以便解析来自 SDK 消费方的待处理权限请求。
                    structuredIO.injectControlResponse(response)
                  },
                  onInterrupt() {
                    abortController?.abort()
                  },
                  onSetModel(model) {
                    const resolved =
                      model === 'default' ? getDefaultMainLoopModel() : model
                    activeUserSpecifiedModel = resolved
                    setMainLoopModelOverride(resolved)
                  },
                  onSetMaxThinkingTokens(maxTokens) {
                    if (maxTokens === null) {
                      options.thinkingConfig = undefined
                    } else if (maxTokens === 0) {
                      options.thinkingConfig = { type: 'disabled' }
                    } else {
                      options.thinkingConfig = {
                        type: 'enabled',
                        budgetTokens: maxTokens,
                      }
                    }
                  },
                  onStateChange(state, detail) {
                    if (state === 'failed') {
                      bridgeFailureDetail = detail
                    }
                    logForDebugging(
                      `[bridge:sdk] State change: ${state}${detail ? ` — ${detail}` : ''}`,
                    )
                    output.enqueue({
                      type: 'system' as StdoutMessage['type'],
                      subtype: 'bridge_state' as string,
                      state,
                      detail,
                      uuid: randomUUID(),
                      session_id: getSessionId(),
                    } as StdoutMessage)
                  },
                  initialMessages:
                    mutableMessages.length > 0 ? mutableMessages : undefined,
                })
                if (!handle) {
                  sendControlResponseError(
                    msg,
                    bridgeFailureDetail ??
                      'Remote Control initialization failed',
                  )
                } else {
                  bridgeHandle = handle
                  bridgeLastForwardedIndex = mutableMessages.length
                  // 将权限请求转发给 bridge
                  structuredIO.setOnControlRequestSent(request => {
                    handle.sendControlRequest(request)
                  })
                  // 当 SDK 消费方先解析了 can_use_tool 请求时，
                  // 取消过期的 bridge 权限提示。
                  structuredIO.setOnControlRequestResolved(requestId => {
                    handle.sendControlCancelRequest(requestId)
                  })
                  sendControlResponseSuccess(msg, {
                    session_url: getRemoteSessionUrl(
                      handle.bridgeSessionId,
                      handle.sessionIngressUrl,
                    ),
                    connect_url: buildBridgeConnectUrl(
                      handle.environmentId,
                      handle.sessionIngressUrl,
                    ),
                    environment_id: handle.environmentId,
                  })
                }
              } catch (err) {
                sendControlResponseError(msg, errorMessage(err))
              }
            }
          } else {
            // 禁用
            if (bridgeHandle) {
              structuredIO.setOnControlRequestSent(undefined)
              structuredIO.setOnControlRequestResolved(undefined)
              await bridgeHandle.teardown()
              bridgeHandle = null
            }
            sendControlResponseSuccess(msg)
          }
        } else {
          // 未知的 control request subtype —— 发送错误响应，避免调用方一直
          // 等待一个永远不会到来的回复而挂起。
          sendControlResponseError(
            msg,
            `Unsupported control request subtype: ${(msg.request as { subtype: string }).subtype}`,
          )
        }
        continue
      } else if (message.type === 'control_response') {
        // 当 replay 模式启用时，重放 control_response 消息
        if (options.replayUserMessages) {
          output.enqueue(message as StdoutMessage)
        }
        continue
      } else if (message.type === 'keep_alive') {
        // 静默忽略 keep-alive 消息
        continue
      } else if (message.type === 'update_environment_variables') {
        // 在 structuredIO.ts 中已处理，此处仅为 TypeScript 的类型守卫
        continue
      } else if (message.type === 'assistant' || message.type === 'system') {
        // 来自 bridge 的历史重放：作为会话上下文注入到 mutableMessages，
        // 让模型能看到之前的回合。
        const internalMsgs = toInternalMessages([message as SDKMessage])
        mutableMessages.push(...internalMsgs)
        // 把 assistant 消息回显，以便 CCR 能显示
        if (message.type === 'assistant' && options.replayUserMessages) {
          output.enqueue(message as StdoutMessage)
        }
        continue
      }
      // 上方处理完 control、keep-alive、env-var、assistant、system 消息之后，
      // 只应剩下 user 消息。
      if (message.type !== 'user') {
        continue
      }
      // 类型断言：经过类型守卫之后，message 是一条 user 消息。
      // 与 SDKMessage（any）的联合会阻止正确的类型收窄。
      const userMsg = message as SDKUserMessage

      // 第一条 prompt 消息若尚未初始化，则隐式初始化。
      initialized = true

      // 检查是否为重复的 user 消息 —— 若已处理过则跳过
      if (userMsg.uuid) {
        const sessionId = getSessionId() as UUID
        const existsInSession = await doesMessageExistInSession(
          sessionId,
          userMsg.uuid as UUID,
        )

        // 同时检查历史重复（来自文件）和运行时重复（本次会话内）
        if (existsInSession || receivedMessageUuids.has(userMsg.uuid as UUID)) {
          logForDebugging(`Skipping duplicate user message: ${userMsg.uuid}`)
          // 当 replay 模式启用时，为重复消息发送回执
          if (options.replayUserMessages) {
            logForDebugging(
              `Sending acknowledgment for duplicate user message: ${userMsg.uuid}`,
            )
            output.enqueue({
              type: 'user',
              content: (userMsg.message as { content?: string })?.content ?? '',
              message: userMsg.message as unknown,
              session_id: sessionId,
              parent_tool_use_id: null,
              uuid: userMsg.uuid as string,
              timestamp: (userMsg as { timestamp?: string }).timestamp,
              isReplay: true,
            } as unknown as StdoutMessage)
          }
          // 历史重复 = transcript 中已经有这一回合的输出，说明它跑过了，
          // 但其生命周期从未被关闭（在 ack 之前被中断）。
          // 运行时重复不需要这样做 —— 原始的入队路径会关闭它们。
          if (existsInSession) {
            notifyCommandLifecycle(userMsg.uuid as string, 'completed')
          }
          // 不对重复消息进行入队执行
          continue
        }

        // 记录此 UUID，防止运行时重复
        trackReceivedMessageUuid(userMsg.uuid as UUID)
      }

      enqueue({
        mode: 'prompt' as const,
        // file_attachments 搭乘 web composer protobuf 的 catchall。
        // 缺失时是同引用的 no-op（没有 'file_attachments' key）。
        value: await resolveAndPrepend(
          userMsg,
          (userMsg.message as { content: ContentBlockParam[] }).content,
        ),
        uuid: userMsg.uuid as `${string}-${string}-${string}-${string}-${string}`,
        priority: (userMsg as { priority?: string })
          .priority as import('src/types/textInputTypes.js').QueuePriority,
      })
      // 自增 prompt 计数用于归因追踪，并保存快照
      // 快照会持久化 promptCount，使其能挺过 compaction
      if (feature('COMMIT_ATTRIBUTION')) {
        setAppState(prev => ({
          ...prev,
          attribution: incrementPromptCount(prev.attribution, snapshot => {
            void recordAttributionSnapshot(snapshot).catch(error => {
              logForDebugging(`Attribution: Failed to save snapshot: ${error}`)
            })
          }),
        }))
      }
      void run()
    }
    inputClosed = true
    cronScheduler?.stop()
    if (!running) {
      // 如果有进行中的 push-suggestion，等待它发出后再关闭输出流
      // （5 秒安全超时，防止卡死）。
      if (suggestionState.inflightPromise) {
        await Promise.race([suggestionState.inflightPromise, sleep(5000)])
      }
      suggestionState.abortController?.abort()
      suggestionState.abortController = null
      await finalizePendingAsyncHooks()
      unsubscribeSkillChanges()
      unsubscribeAuthStatus?.()
      statusListeners.delete(rateLimitListener)
      output.done()
    }
  })()

  return output
}

/**
 * 创建一个整合了自定义权限提示工具的 CanUseToolFn。
 * 该函数把 permissionPromptTool 转换成一个可在 ask.tsx 中使用的 CanUseToolFn
 */
export function createCanUseToolWithPermissionPrompt(
  permissionPromptTool: PermissionPromptTool,
): CanUseToolFn {
  const canUseTool: CanUseToolFn = async (
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseId,
    forceDecision,
  ) => {
    const mainPermissionResult =
      forceDecision ??
      (await hasPermissionsToUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseId,
      ))

    // 如果工具被允许或拒绝，直接返回结果
    if (
      mainPermissionResult.behavior === 'allow' ||
      mainPermissionResult.behavior === 'deny'
    ) {
      return mainPermissionResult
    }

    // 让权限提示工具与 abort signal 竞速。
    //
    // 为什么要这样做：权限提示工具可能会在等待用户输入（例如通过 stdin 或
    // UI 对话框）时无限期阻塞。如果用户触发了中断（Ctrl+C），我们需要即使
    // 在工具阻塞期间也能检测到。如果不竞速，abort 检查只有在工具完成后才会
    // 运行，而工具可能永远等不到永远不会到来的输入，也就永远不会完成。
    //
    // 第二个检查（combinedSignal.aborted）用于处理竞态：abort 在
    // Promise.race resolve 之后、但还没到达本检查之前触发的情况。
    const { signal: combinedSignal, cleanup: cleanupAbortListener } =
      createCombinedAbortSignal(toolUseContext.abortController.signal)

    // 在开始竞速之前检查是否已 abort
    if (combinedSignal.aborted) {
      cleanupAbortListener()
      return {
        behavior: 'deny',
        message: 'Permission prompt was aborted.',
        decisionReason: {
          type: 'permissionPromptTool' as const,
          permissionPromptToolName: tool.name,
          toolResult: undefined,
        },
      }
    }

    const abortPromise = new Promise<'aborted'>(resolve => {
      combinedSignal.addEventListener('abort', () => resolve('aborted'), {
        once: true,
      })
    })

    const toolCallPromise = permissionPromptTool.call(
      {
        tool_name: tool.name,
        input,
        tool_use_id: toolUseId,
      },
      toolUseContext,
      canUseTool,
      assistantMessage,
    )

    const raceResult = await Promise.race([toolCallPromise, abortPromise])
    cleanupAbortListener()

    if (raceResult === 'aborted' || combinedSignal.aborted) {
      return {
        behavior: 'deny',
        message: 'Permission prompt was aborted.',
        decisionReason: {
          type: 'permissionPromptTool' as const,
          permissionPromptToolName: tool.name,
          toolResult: undefined,
        },
      }
    }

    // TypeScript 类型收窄：经过 abort 检查之后，raceResult 必定是 ToolResult
    const result = raceResult as Awaited<typeof toolCallPromise>

    const permissionToolResultBlockParam =
      permissionPromptTool.mapToolResultToToolResultBlockParam(result.data, '1')
    if (
      !permissionToolResultBlockParam.content ||
      !Array.isArray(permissionToolResultBlockParam.content) ||
      !permissionToolResultBlockParam.content[0] ||
      permissionToolResultBlockParam.content[0].type !== 'text' ||
      typeof permissionToolResultBlockParam.content[0].text !== 'string'
    ) {
      throw new Error(
        'Permission prompt tool returned an invalid result. Expected a single text block param with type="text" and a string text value.',
      )
    }
    return permissionPromptToolResultToPermissionDecision(
      permissionToolOutputSchema().parse(
        safeParseJSON(permissionToolResultBlockParam.content[0].text),
      ),
      permissionPromptTool,
      input,
      toolUseContext,
    )
  }
  return canUseTool
}

// 为测试而导出 —— 回归说明：以前当 getMcpTools() 为空时（per-server 连接填充
// appState 之前），此处会在构造时崩溃。
export function getCanUseToolFn(
  permissionPromptToolName: string | undefined,
  structuredIO: StructuredIO,
  getMcpTools: () => Tool[],
  onPermissionPrompt?: (details: RequiresActionDetails) => void,
): CanUseToolFn {
  if (permissionPromptToolName === 'stdio') {
    return structuredIO.createCanUseTool(onPermissionPrompt)
  }
  if (!permissionPromptToolName) {
    return async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseId,
      forceDecision,
    ) =>
      forceDecision ??
      (await hasPermissionsToUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseId,
      ))
  }
  // 延迟查找：print 模式下 MCP 连接是按 server 增量的，因此工具在 init 时
  // 可能尚未出现在 appState 中。在第一次调用（第一次权限提示）时再解析，
  // 那时各连接已有时间完成。
  let resolved: CanUseToolFn | null = null
  return async (
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseId,
    forceDecision,
  ) => {
    if (!resolved) {
      const mcpTools = getMcpTools()
      const permissionPromptTool = mcpTools.find(t =>
        toolMatchesName(t, permissionPromptToolName),
      ) as PermissionPromptTool | undefined
      if (!permissionPromptTool) {
        const error = `Error: MCP tool ${permissionPromptToolName} (passed via --permission-prompt-tool) not found. Available MCP tools: ${mcpTools.map(t => t.name).join(', ') || 'none'}`
        process.stderr.write(`${error}\n`)
        gracefulShutdownSync(1)
        throw new Error(error)
      }
      if (!permissionPromptTool.inputJSONSchema) {
        const error = `Error: tool ${permissionPromptToolName} (passed via --permission-prompt-tool) must be an MCP tool`
        process.stderr.write(`${error}\n`)
        gracefulShutdownSync(1)
        throw new Error(error)
      }
      resolved = createCanUseToolWithPermissionPrompt(permissionPromptTool)
    }
    return resolved(
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseId,
      forceDecision,
    )
  }
}

async function handleInitializeRequest(
  request: SDKControlInitializeRequest,
  requestId: string,
  initialized: boolean,
  output: Stream<StdoutMessage>,
  commands: Command[],
  modelInfos: ModelInfo[],
  structuredIO: StructuredIO,
  enableAuthStatus: boolean,
  options: {
    systemPrompt: string | undefined
    appendSystemPrompt: string | undefined
    agent?: string | undefined
    userSpecifiedModel?: string | undefined
    [key: string]: unknown
  },
  agents: AgentDefinition[],
  getAppState: () => AppState,
): Promise<void> {
  if (initialized) {
    output.enqueue({
      type: 'control_response',
      response: {
        subtype: 'error',
        error: 'Already initialized',
        request_id: requestId,
        pending_permission_requests:
          structuredIO.getPendingPermissionRequests(),
      },
    })
    return
  }

  // 从 stdin 应用 systemPrompt/appendSystemPrompt，避免触及 ARG_MAX 限制
  if (request.systemPrompt !== undefined) {
    options.systemPrompt = request.systemPrompt
  }
  if (request.appendSystemPrompt !== undefined) {
    options.appendSystemPrompt = request.appendSystemPrompt
  }
  if (request.promptSuggestions !== undefined) {
    options.promptSuggestions = request.promptSuggestions
  }

  // 从 stdin 合并 agents，避免触及 ARG_MAX 限制
  if (request.agents) {
    const stdinAgents = parseAgentsFromJson(request.agents, 'flagSettings')
    agents.push(...stdinAgents)
  }

  // 在 SDK agents 合并之后重新评估主线程 agent
  // 这使得 --agent 可以引用通过 SDK 定义的 agent
  if (options.agent) {
    // 如果 main.tsx 已经找到该 agent（基于文件系统定义），它已经应用过
    // systemPrompt/model/initialPrompt。跳过避免重复应用。
    const alreadyResolved = getMainThreadAgentType() === options.agent
    const mainThreadAgent = agents.find(a => a.agentType === options.agent)
    if (mainThreadAgent && !alreadyResolved) {
      // 更新 bootstrap state 中的主线程 agent 类型
      setMainThreadAgentType(mainThreadAgent.agentType)

      // 如果用户没有指定自定义 system prompt，则应用 agent 的 system prompt
      // SDK agents 始终是自定义 agent（非内置），所以 getSystemPrompt() 不接受参数
      if (!options.systemPrompt && !isBuiltInAgent(mainThreadAgent)) {
        const agentSystemPrompt = mainThreadAgent.getSystemPrompt()
        if (agentSystemPrompt) {
          options.systemPrompt = agentSystemPrompt
        }
      }

      // 如果用户未指定 model 且 agent 有 model，则应用 agent 的 model
      if (
        !options.userSpecifiedModel &&
        mainThreadAgent.model &&
        mainThreadAgent.model !== 'inherit'
      ) {
        const agentModel = parseUserSpecifiedModel(mainThreadAgent.model)
        setMainLoopModelOverride(agentModel)
      }

      // SDK 定义的 agent 是通过 init 到达的，所以 main.tsx 的查找错过了它们。
      if (mainThreadAgent.initialPrompt) {
        structuredIO.prependUserMessage(mainThreadAgent.initialPrompt)
      }
    } else if (mainThreadAgent?.initialPrompt) {
      // 基于文件系统定义的 agent（已被 main.tsx 解析）。main.tsx 会为字符串
      // inputPrompt 的情况处理 initialPrompt，但当 inputPrompt 是
      // AsyncIterable（SDK stream-json）时，它无法进行拼接 ——
      // 在此回退到 prependUserMessage。
      structuredIO.prependUserMessage(mainThreadAgent.initialPrompt)
    }
  }

  const settings = getSettings_DEPRECATED()
  const outputStyle = settings?.outputStyle || DEFAULT_OUTPUT_STYLE_NAME
  const availableOutputStyles = await getAllOutputStyles(getCwd())

  // 获取账户信息
  const accountInfo = getAccountInformation()
  if (request.hooks) {
    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {}
    for (const [event, matchers] of Object.entries(request.hooks) as [
      string,
      Array<{ hookCallbackIds: string[]; timeout?: number; matcher?: string }>,
    ][]) {
      hooks[event as HookEvent] = matchers.map(matcher => {
        const callbacks = matcher.hookCallbackIds.map(callbackId => {
          return structuredIO.createHookCallback(callbackId, matcher.timeout)
        })
        return {
          matcher: matcher.matcher,
          hooks: callbacks,
        }
      })
    }
    registerHookCallbacks(hooks)
  }
  if (request.jsonSchema) {
    setInitJsonSchema(request.jsonSchema)
  }
  const initResponse: SDKControlInitializeResponse = {
    commands: commands
      .filter(cmd => cmd.userInvocable !== false)
      .map(cmd => ({
        name: getCommandName(cmd),
        description: formatDescriptionWithSource(cmd),
        argumentHint: cmd.argumentHint || '',
      })),
    agents: agents.map(agent => ({
      name: agent.agentType,
      description: agent.whenToUse,
      // 'inherit' 是内部哨兵值；在公开 API 中归一化为 undefined
      model: agent.model === 'inherit' ? undefined : agent.model,
    })),
    output_style: outputStyle,
    available_output_styles: Object.keys(availableOutputStyles),
    models: modelInfos as unknown as SDKControlInitializeResponse['models'],
    account: {
      email: accountInfo?.email,
      organization: accountInfo?.organization,
      subscriptionType: accountInfo?.subscription,
      tokenSource: accountInfo?.tokenSource,
      apiKeySource: accountInfo?.apiKeySource,
      // 在第三方 provider 下 getAccountInformation() 返回 undefined，因此
      // 其他字段都缺失。apiProvider 用于区分"未登录"（firstParty +
      // tokenSource:none）与"第三方 provider，登录不适用"两种情况。
      apiProvider: getAPIProvider() as
        | 'firstParty'
        | 'bedrock'
        | 'vertex'
        | 'foundry',
    },
    pid: process.pid,
  }

  if (isFastModeEnabled() && isFastModeAvailable()) {
    const appState = getAppState()
    initResponse.fast_mode_state = getFastModeState(
      options.userSpecifiedModel ?? null,
      appState.fastMode,
    )
  }

  output.enqueue({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: initResponse,
    },
  })

  // initialize 消息之后检查认证状态 ——
  // 后续变更会被通知，但我们也希望主动发送初始状态。
  if (enableAuthStatus) {
    const authStatusManager = AwsAuthStatusManager.getInstance()
    const status = authStatusManager.getStatus()
    if (status) {
      output.enqueue({
        type: 'auth_status',
        isAuthenticating: status.isAuthenticating,
        output: status.output,
        error: status.error,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    }
  }
}

async function handleRewindFiles(
  userMessageId: UUID,
  appState: AppState,
  setAppState: (updater: (prev: AppState) => AppState) => void,
  dryRun: boolean,
): Promise<RewindFilesResult> {
  if (!fileHistoryEnabled()) {
    return {
      canRewind: false,
      error: 'File rewinding is not enabled.',
      filesChanged: [],
    }
  }
  if (!fileHistoryCanRestore(appState.fileHistory, userMessageId)) {
    return {
      canRewind: false,
      error: 'No file checkpoint found for this message.',
      filesChanged: [],
    }
  }

  if (dryRun) {
    const diffStats = await fileHistoryGetDiffStats(
      appState.fileHistory,
      userMessageId,
    )
    return {
      canRewind: true,
      filesChanged: diffStats?.filesChanged ?? [],
      insertions: diffStats?.insertions,
      deletions: diffStats?.deletions,
    }
  }

  try {
    await fileHistoryRewind(
      updater =>
        setAppState(prev => ({
          ...prev,
          fileHistory: updater(prev.fileHistory),
        })),
      userMessageId,
    )
  } catch (error) {
    return {
      canRewind: false,
      error: `Failed to rewind: ${errorMessage(error)}`,
      filesChanged: [],
    }
  }

  return { canRewind: true, filesChanged: [] }
}

function handleSetPermissionMode(
  request: { mode: InternalPermissionMode },
  requestId: string,
  toolPermissionContext: ToolPermissionContext,
  output: Stream<StdoutMessage>,
): ToolPermissionContext {
  // 检查是否尝试切换到 bypassPermissions 模式
  if (request.mode === 'bypassPermissions') {
    if (isBypassPermissionsModeDisabled()) {
      output.enqueue({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error:
            'Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration',
        },
      })
      return toolPermissionContext
    }
    if (!toolPermissionContext.isBypassPermissionsModeAvailable) {
      output.enqueue({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error:
            'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions',
        },
      })
      return toolPermissionContext
    }
  }

  // 检查是否在未通过 classifier gate 的情况下尝试切换到 auto 模式
  if (
    feature('TRANSCRIPT_CLASSIFIER') &&
    request.mode === 'auto' &&
    !isAutoModeGateEnabled()
  ) {
    const reason = getAutoModeUnavailableReason()
    output.enqueue({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: requestId,
        error: reason
          ? `Cannot set permission mode to auto: ${getAutoModeUnavailableNotification(reason)}`
          : 'Cannot set permission mode to auto',
      },
    })
    return toolPermissionContext
  }

  // 允许 mode 切换
  output.enqueue({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: {
        mode: request.mode,
      },
    },
  })

  return {
    ...transitionPermissionMode(
      toolPermissionContext.mode,
      request.mode,
      toolPermissionContext,
    ),
    mode: request.mode,
  }
}

/**
 * 由 IDE 触发的 channel 启用。从连接的 pluginSource 推导出 ChannelEntry
 * （IDE 无法伪造 kind/marketplace —— 我们只接收 server 名），把它追加到
 * 会话的 allowedChannels，并运行完整的 gate。gate 失败时回滚这次追加；
 * 成功时注册一个 notification handler，将 channel 消息以 priority:'next'
 * 入队 —— drainCommandQueue 会在回合之间把它们取走。
 *
 * 故意不注册 useManageMCPConnections 为交互模式设置的 claude/channel/permission
 * handler。该 handler 用于在 handleInteractivePermission 内部解析一个待处理
 * 对话框 —— 但 print.ts 从不调用 handleInteractivePermission。当 SDK 权限
 * 判定为 'ask' 时，会通过 stdio 走到消费方的 canUseTool 回调；远端的
 * "yes tbxkq" 没有客户端侧的对话框可以去 resolve。如果 IDE 希望对 channel
 * 转发的工具审批进行处理，那属于 IDE 侧的管道，要针对它自己的 pending-map
 * 实现。（此外该项还由 tengu_harbor_permissions 单独门控 —— 交互模式也尚未
 * 发布。）
 */
function handleChannelEnable(
  requestId: string,
  serverName: string,
  connectionPool: readonly MCPServerConnection[],
  output: Stream<StdoutMessage>,
): void {
  const respondError = (error: string) =>
    output.enqueue({
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error },
    })

  if (!(feature('KAIROS') || feature('KAIROS_CHANNELS'))) {
    return respondError('channels feature not available in this build')
  }

  // 只有 'connected' 状态的 client 才有 .capabilities 和 .client 可用于注册
  // handler。调用点处的 pool 展开与 mcp_status 保持一致。
  const connection = connectionPool.find(
    c => c.name === serverName && c.type === 'connected',
  )
  if (!connection || connection.type !== 'connected') {
    return respondError(`server ${serverName} is not connected`)
  }

  const pluginSource = connection.config.pluginSource
  const parsed = pluginSource ? parsePluginIdentifier(pluginSource) : undefined
  if (!parsed?.marketplace) {
    // 没有 pluginSource 或 source 不含 @ —— 永远无法通过以 {plugin, marketplace}
    // 为 key 的 allowlist。直接短路，返回与 gate 相同的失败原因。
    return respondError(
      `server ${serverName} is not plugin-sourced; channel_enable requires a marketplace plugin`,
    )
  }

  const entry: ChannelEntry = {
    kind: 'plugin',
    name: parsed.name,
    marketplace: parsed.marketplace,
  }
  // 幂等：重复启用时不要重复追加。
  const prior = getAllowedChannels()
  const already = prior.some(
    e =>
      e.kind === 'plugin' &&
      e.name === entry.name &&
      e.marketplace === entry.marketplace,
  )
  if (!already) setAllowedChannels([...prior, entry])

  const gate = gateChannelServer(
    serverName,
    connection.capabilities,
    pluginSource,
  )
  if (gate.action === 'skip') {
    // 回滚 —— 只移除我们刚追加的那条 entry。
    if (!already) setAllowedChannels(prior)
    return respondError(gate.reason)
  }

  const pluginId =
    `${entry.name}@${entry.marketplace}` as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  logMCPDebug(serverName, 'Channel notifications registered')
  logEvent('tengu_mcp_channel_enable', { plugin: pluginId })

  // 与 useManageMCPConnections 中交互式 register 块的入队形状完全一致。
  // drainCommandQueue 在回合之间处理它 —— channel 消息以 priority 'next'
  // 入队，模型会在其到达后的下一个回合看到。
  connection.client.setNotificationHandler(
    ChannelMessageNotificationSchema() as any,
    async notification => {
      const { content, meta } = notification.params
      logMCPDebug(
        serverName,
        `notifications/claude/channel: ${content.slice(0, 80)}`,
      )
      logEvent('tengu_mcp_channel_message', {
        content_length: content.length,
        meta_key_count: Object.keys(meta ?? {}).length,
        entry_kind:
          'plugin' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        is_dev: false,
        plugin: pluginId,
      })
      enqueue({
        mode: 'prompt',
        value: wrapChannelMessage(serverName, content, meta),
        priority: 'next',
        isMeta: true,
        origin: { kind: 'channel', server: serverName } as unknown as string,
        skipSlashCommands: true,
      })
    },
  )

  output.enqueue({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: undefined,
    },
  })
}

/**
 * 在 mcp_reconnect / mcp_toggle 创建了新 client 之后重新注册 channel
 * notification handler。handleChannelEnable 把 handler 绑定到了旧的 client
 * 对象上；allowedChannels 能在重连中存活，但 handler 的绑定不能。若不重新
 * 注册，重连后 channel 消息会被静默丢弃，而 IDE 仍以为 channel 是活跃的。
 *
 * 镜像交互式 CLI 中 useManageMCPConnections 的 onConnectionAttempt，后者对
 * 每次新连接都重新进行 gate。与 registerElicitationHandlers 在相同的调用点
 * 配对使用。
 *
 * 若 server 从未被 channel-enabled 则为 no-op：gateChannelServer 内部会调用
 * findChannelEntry，对未列入的 server 返回 skip/session，因此重连一个非
 * channel 的 MCP server 只多花一次 feature-flag 检查。
 */
function reregisterChannelHandlerAfterReconnect(
  connection: MCPServerConnection,
): void {
  // Channels 始终可用 —— feature flag 守卫已移除
  if (connection.type !== 'connected') return

  const gate = gateChannelServer(
    connection.name,
    connection.capabilities,
    connection.config.pluginSource,
  )
  if (gate.action !== 'register') return

  const entry = findChannelEntry(connection.name, getAllowedChannels())
  const pluginId =
    entry?.kind === 'plugin'
      ? (`${entry.name}@${entry.marketplace}` as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      : undefined

  logMCPDebug(
    connection.name,
    'Channel notifications re-registered after reconnect',
  )
  connection.client.setNotificationHandler(
    ChannelMessageNotificationSchema() as any,
    async notification => {
      const { content, meta } = notification.params
      logMCPDebug(
        connection.name,
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
        value: wrapChannelMessage(connection.name, content, meta),
        priority: 'next',
        isMeta: true,
        origin: {
          kind: 'channel',
          server: connection.name,
        } as unknown as string,
        skipSlashCommands: true,
      })
    },
  )
}

/**
 * 根据 outputFormat 以正确的格式输出错误消息。
 * 使用 stream-json 时将 JSON 写到 stdout；否则把纯文本写到 stderr。
 */
function emitLoadError(
  message: string,
  outputFormat: string | undefined,
): void {
  if (outputFormat === 'stream-json') {
    const errorResult = {
      type: 'result',
      subtype: 'error_during_execution',
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: true,
      num_turns: 0,
      stop_reason: null,
      session_id: getSessionId(),
      total_cost_usd: 0,
      usage: EMPTY_USAGE,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      errors: [message],
    }
    process.stdout.write(jsonStringify(errorResult) + '\n')
  } else {
    process.stderr.write(message + '\n')
  }
}

/**
 * 从消息数组中移除被中断的 user 消息及其合成的 assistant 哨兵值。
 * 用于 gateway 触发的重启场景：在重新入队被中断的 prompt 之前清理消息历史。
 *
 * @internal 为测试而导出
 */
export function removeInterruptedMessage(
  messages: Message[],
  interruptedUserMessage: NormalizedUserMessage,
): void {
  const idx = messages.findIndex(m => m.uuid === interruptedUserMessage.uuid)
  if (idx !== -1) {
    // 移除该 user 消息以及紧随其后的哨兵值。
    // 即使 idx 是最后一个元素，splice 也能安全处理。
    messages.splice(idx, 2)
  }
}

type LoadInitialMessagesResult = {
  messages: Message[]
  turnInterruptionState?: TurnInterruptionState
  agentSetting?: string
}

async function loadInitialMessages(
  setAppState: (f: (prev: AppState) => AppState) => void,
  options: {
    continue: boolean | undefined
    teleport: string | true | null | undefined
    resume: string | boolean | undefined
    resumeSessionAt: string | undefined
    forkSession: boolean | undefined
    outputFormat: string | undefined
    sessionStartHooksPromise?: ReturnType<typeof processSessionStartHooks>
    restoredWorkerState: Promise<SessionExternalMetadata | null>
  },
): Promise<LoadInitialMessagesResult> {
  const persistSession = !isSessionPersistenceDisabled()
  // 在 print 模式下处理 continue
  if (options.continue) {
    try {
      logEvent('tengu_continue_print', {})

      const result = await loadConversationForResume(
        undefined /* sessionId */,
        undefined /* file path */,
      )
      if (result) {
        // 把 coordinator 模式与所恢复会话的 mode 对齐
        if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
          const warning = coordinatorModeModule.matchSessionMode(result.mode)
          if (warning) {
            process.stderr.write(warning + '\n')
            // 刷新 agent 定义以反映 mode 切换
            const {
              getAgentDefinitionsWithOverrides,
              getActiveAgentsFromList,
            } =
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              require('@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js') as typeof import('@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js')
            getAgentDefinitionsWithOverrides.cache.clear?.()
            const freshAgentDefs = await getAgentDefinitionsWithOverrides(
              getCwd(),
            )

            setAppState(prev => ({
              ...prev,
              agentDefinitions: {
                ...freshAgentDefs,
                allAgents: freshAgentDefs.allAgents,
                activeAgents: getActiveAgentsFromList(freshAgentDefs.allAgents),
              },
            }))
          }
        }

        // 复用所恢复会话的 ID
        if (!options.forkSession) {
          if (result.sessionId) {
            switchSession(
              asSessionId(result.sessionId),
              result.fullPath ? dirname(result.fullPath) : null,
            )
            if (persistSession) {
              await resetSessionFilePointer()
            }
          }
        }
        restoreSessionStateFromLog(result, setAppState)

        // 恢复会话元数据，使其在退出时通过 reAppendSessionMetadata 被重新追加
        restoreSessionMetadata(
          options.forkSession
            ? { ...result, worktreeSession: undefined }
            : result,
        )

        // 为所恢复的会话写入 mode 条目
        if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
          saveMode(
            coordinatorModeModule.isCoordinatorMode()
              ? 'coordinator'
              : 'normal',
          )
        }

        return {
          messages: result.messages,
          turnInterruptionState: result.turnInterruptionState,
          agentSetting: result.agentSetting,
        }
      }
    } catch (error) {
      logError(error)
      gracefulShutdownSync(1)
      return { messages: [] }
    }
  }

  // 在 print 模式下处理 teleport
  if (options.teleport) {
    try {
      if (!isPolicyAllowed('allow_remote_sessions')) {
        throw new Error(
          "Remote sessions are disabled by your organization's policy.",
        )
      }

      logEvent('tengu_teleport_print', {})

      if (typeof options.teleport !== 'string') {
        throw new Error('No session ID provided for teleport')
      }

      const {
        checkOutTeleportedSessionBranch,
        processMessagesForTeleportResume,
        teleportResumeCodeSession,
        validateGitState,
      } = await import('src/utils/teleport.js')
      await validateGitState()
      const teleportResult = await teleportResumeCodeSession(options.teleport)
      const { branchError } = await checkOutTeleportedSessionBranch(
        teleportResult.branch,
      )
      return {
        messages: processMessagesForTeleportResume(
          teleportResult.log,
          branchError,
        ),
      }
    } catch (error) {
      logError(error)
      gracefulShutdownSync(1)
      return { messages: [] }
    }
  }

  // 在 print 模式下处理 resume（接受 session ID 或 URL）
  // URL 是 [ANT-ONLY] 的
  if (options.resume) {
    try {
      logEvent('tengu_resume_print', {})

      // 在 print 模式下 —— 我们要求一个有效的 session ID、JSONL 文件或 URL
      const parsedSessionId = parseSessionIdentifier(
        typeof options.resume === 'string' ? options.resume : '',
      )
      if (!parsedSessionId) {
        let errorMessage =
          'Error: --resume requires a valid session ID when used with --print. Usage: claude -p --resume <session-id>'
        if (typeof options.resume === 'string') {
          errorMessage += `. Session IDs must be in UUID format (e.g., 550e8400-e29b-41d4-a716-446655440000). Provided value "${options.resume}" is not a valid UUID`
        }
        emitLoadError(errorMessage, options.outputFormat)
        gracefulShutdownSync(1)
        return { messages: [] }
      }

      // 在加载之前从远端 hydrate 本地 transcript
      if (isEnvTruthy(process.env.CLAUDE_CODE_USE_CCR_V2)) {
        // 在 hydrate 的同时 await restore，使 SSE catchup 落到已恢复的状态上，
        // 而不是一份全新的默认状态。
        const [, metadata] = await Promise.all([
          hydrateFromCCRv2InternalEvents(parsedSessionId.sessionId),
          options.restoredWorkerState,
        ])
        if (metadata) {
          setAppState(externalMetadataToAppState(metadata))
          if (typeof metadata.model === 'string') {
            setMainLoopModelOverride(metadata.model)
          }
        }
      } else if (
        parsedSessionId.isUrl &&
        parsedSessionId.ingressUrl &&
        isEnvTruthy(process.env.ENABLE_SESSION_PERSISTENCE)
      ) {
        // v1：从 Session Ingress 拉取会话日志
        await hydrateRemoteSession(
          parsedSessionId.sessionId,
          parsedSessionId.ingressUrl,
        )
      }

      // 用指定 session ID 加载会话
      const result = await loadConversationForResume(
        parsedSessionId.sessionId,
        parsedSessionId.jsonlFile || undefined,
      )

      // hydrateFromCCRv2InternalEvents 对全新会话会写一个空的 transcript 文件
      // （writeFile(sessionFile, '')，没有任何事件），因此 loadConversationForResume
      // 返回的是 {messages: []} 而不是 null。把空视为 null，这样 SessionStart
      // 仍然会触发。
      if (!result || result.messages.length === 0) {
        // 对基于 URL 的 resume 或 CCR v2 resume，以空会话启动
        // （已被 hydrate 但内容为空）
        if (
          parsedSessionId.isUrl ||
          isEnvTruthy(process.env.CLAUDE_CODE_USE_CCR_V2)
        ) {
          // 因为是新会话，执行 startup 的 SessionStart hooks
          return {
            messages: await (options.sessionStartHooksPromise ??
              processSessionStartHooks('startup')),
          }
        } else {
          emitLoadError(
            `No conversation found with session ID: ${parsedSessionId.sessionId}`,
            options.outputFormat,
          )
          gracefulShutdownSync(1)
          return { messages: [] }
        }
      }

      // 处理 resumeSessionAt 特性
      if (options.resumeSessionAt) {
        const index = result.messages.findIndex(
          m => m.uuid === options.resumeSessionAt,
        )
        if (index < 0) {
          emitLoadError(
            `No message found with message.uuid of: ${options.resumeSessionAt}`,
            options.outputFormat,
          )
          gracefulShutdownSync(1)
          return { messages: [] }
        }

        result.messages = index >= 0 ? result.messages.slice(0, index + 1) : []
      }

      // 把 coordinator 模式与所恢复会话的 mode 对齐
      if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
        const warning = coordinatorModeModule.matchSessionMode(result.mode)
        if (warning) {
          process.stderr.write(warning + '\n')
          // 刷新 agent 定义以反映 mode 切换
          const { getAgentDefinitionsWithOverrides, getActiveAgentsFromList } =
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require('@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js') as typeof import('@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js')
          getAgentDefinitionsWithOverrides.cache.clear?.()
          const freshAgentDefs = await getAgentDefinitionsWithOverrides(
            getCwd(),
          )

          setAppState(prev => ({
            ...prev,
            agentDefinitions: {
              ...freshAgentDefs,
              allAgents: freshAgentDefs.allAgents,
              activeAgents: getActiveAgentsFromList(freshAgentDefs.allAgents),
            },
          }))
        }
      }

      // 复用所恢复会话的 ID
      if (!options.forkSession && result.sessionId) {
        switchSession(
          asSessionId(result.sessionId),
          result.fullPath ? dirname(result.fullPath) : null,
        )
        if (persistSession) {
          await resetSessionFilePointer()
        }
      }
      restoreSessionStateFromLog(result, setAppState)

      // 恢复会话元数据，使其在退出时通过 reAppendSessionMetadata 被重新追加
      restoreSessionMetadata(
        options.forkSession
          ? { ...result, worktreeSession: undefined }
          : result,
      )

      // 为所恢复的会话写入 mode 条目
      if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
        saveMode(
          coordinatorModeModule.isCoordinatorMode() ? 'coordinator' : 'normal',
        )
      }

      return {
        messages: result.messages,
        turnInterruptionState: result.turnInterruptionState,
        agentSetting: result.agentSetting,
      }
    } catch (error) {
      logError(error)
      const errorMessage =
        error instanceof Error
          ? `Failed to resume session: ${error.message}`
          : 'Failed to resume session with --print mode'
      emitLoadError(errorMessage, options.outputFormat)
      gracefulShutdownSync(1)
      return { messages: [] }
    }
  }

  // 等待在 main.tsx 中启动的 SessionStart hooks promise（若未启动则重新运行；
  // 例如：--continue 在没有前置会话时会落到此处，且 sessionStartHooksPromise 为
  // undefined，因为 main.tsx 针对 continue 做了守卫）
  return {
    messages: await (options.sessionStartHooksPromise ??
      processSessionStartHooks('startup')),
  }
}

function getStructuredIO(
  inputPrompt: string | AsyncIterable<string>,
  options: {
    sdkUrl: string | undefined
    replayUserMessages?: boolean
  },
): StructuredIO {
  let inputStream: AsyncIterable<string>
  if (typeof inputPrompt === 'string') {
    if (inputPrompt.trim() !== '') {
      // 归一化为流式输入。
      inputStream = fromArray([
        jsonStringify({
          type: 'user',
          content: inputPrompt,
          uuid: '',
          session_id: '',
          message: {
            role: 'user',
            content: inputPrompt,
          },
          parent_tool_use_id: null,
        } satisfies SDKUserMessage),
      ])
    } else {
      // 空字符串 —— 创建一个空流
      inputStream = fromArray([])
    }
  } else {
    inputStream = inputPrompt
  }

  // 如果提供了 sdkUrl 则使用 RemoteIO，否则使用普通的 StructuredIO
  return options.sdkUrl
    ? new RemoteIO(options.sdkUrl, inputStream, options.replayUserMessages)
    : new StructuredIO(inputStream, options.replayUserMessages)
}

/**
 * 处理意外的权限响应：在 transcript 中查找未解析的工具调用并将其入队执行。
 *
 * 如果已入队一个权限则返回 true，否则返回 false。
 */
export async function handleOrphanedPermissionResponse({
  message,
  setAppState: _setAppState,
  onEnqueued,
  handledToolUseIds,
}: {
  message: SDKControlResponse
  setAppState: (f: (prev: AppState) => AppState) => void
  onEnqueued?: () => void
  handledToolUseIds: Set<string>
}): Promise<boolean> {
  const responseInner = message.response as
    | {
        subtype?: string
        response?: Record<string, unknown>
        request_id?: string
      }
    | undefined
  if (
    responseInner?.subtype === 'success' &&
    responseInner.response?.toolUseID &&
    typeof responseInner.response.toolUseID === 'string'
  ) {
    const permissionResult = responseInner.response as PermissionResult & {
      toolUseID?: string
    }
    const toolUseID = permissionResult.toolUseID
    if (!toolUseID) {
      return false
    }

    logForDebugging(
      `handleOrphanedPermissionResponse: received orphaned control_response for toolUseID=${toolUseID} request_id=${responseInner.request_id}`,
    )

    // 防止对同一个孤儿 tool_use 重复处理。如果没有这道防护，重复投递的
    // control_response（例如来自 WebSocket 重连）会导致同一个工具被执行多次，
    // 在 messages 数组中产生重复的 tool_use ID，进而触发 API 的 400 错误。
    // 一旦损坏，每次重试都会累积更多重复项。
    if (handledToolUseIds.has(toolUseID)) {
      logForDebugging(
        `handleOrphanedPermissionResponse: skipping duplicate orphaned permission for toolUseID=${toolUseID} (already handled)`,
      )
      return false
    }

    const assistantMessage = await findUnresolvedToolUse(toolUseID)
    if (!assistantMessage) {
      logForDebugging(
        `handleOrphanedPermissionResponse: no unresolved tool_use found for toolUseID=${toolUseID} (already resolved in transcript)`,
      )
      return false
    }

    handledToolUseIds.add(toolUseID)
    logForDebugging(
      `handleOrphanedPermissionResponse: enqueuing orphaned permission for toolUseID=${toolUseID} messageID=${assistantMessage.message.id}`,
    )
    enqueue({
      mode: 'orphaned-permission' as const,
      value: [],
      orphanedPermission: {
        permissionResult,
        assistantMessage,
      },
    })

    onEnqueued?.()
    return true
  }
  return false
}

export type DynamicMcpState = {
  clients: MCPServerConnection[]
  tools: Tools
  configs: Record<string, ScopedMcpServerConfig>
}

/**
 * 将一个 process transport config 转换为 scoped config。
 * 两者的类型在结构上是兼容的，因此只需补上 scope。
 */
function toScopedConfig(
  config: McpServerConfigForProcessTransport,
): ScopedMcpServerConfig {
  // McpServerConfigForProcessTransport 是 McpServerConfig 的子集
  // （它排除了 IDE 专属类型，例如 sse-ide 和 ws-ide）
  // 补上 scope 即可成为一个合法的 ScopedMcpServerConfig
  return { ...config, scope: 'dynamic' } as ScopedMcpServerConfig
}

/**
 * 运行在 SDK 进程内的 SDK MCP server 的状态。
 */
export type SdkMcpState = {
  configs: Record<string, McpSdkServerConfig>
  clients: MCPServerConnection[]
  tools: Tools
}

/**
 * handleMcpSetServers 的返回结果 —— 包含新的状态与响应数据。
 */
export type McpSetServersResult = {
  response: SDKControlMcpSetServersResponse
  newSdkState: SdkMcpState
  newDynamicState: DynamicMcpState
  sdkServersChanged: boolean
}

/**
 * 处理 mcp_set_servers 请求：同时处理 SDK server 和基于进程的 server。
 * SDK server 运行在 SDK 进程内；基于进程的 server 由 CLI 拉起。
 *
 * 应用企业的 allowedMcpServers/deniedMcpServers 策略 —— 与 --mcp-config 的过滤
 * 相同（见 main.tsx 中的 filterMcpServersByPolicy 调用）。否则 SDK V2
 * Query.setMcpServers() 会成为第二条绕过策略的路径。被阻止的 server 会写到
 * response.errors 中，让 SDK 消费方知道它们未被添加的原因。
 */
export async function handleMcpSetServers(
  servers: Record<string, McpServerConfigForProcessTransport>,
  sdkState: SdkMcpState,
  dynamicState: DynamicMcpState,
  setAppState: (f: (prev: AppState) => AppState) => void,
): Promise<McpSetServersResult> {
  // 对基于进程的 server（stdio/http/sse）强制执行企业 MCP 策略。
  // 与 main.tsx 中的 --mcp-config 过滤镜像 —— 两条用户可控的注入路径必须有
  // 相同的门控。type:'sdk' 的 server 被豁免（由 SDK 管理，CLI 从不为其
  // spawn/连接 —— 见 filterMcpServersByPolicy 的 jsdoc）。被阻止的 server 会
  // 写入 response.errors，让 SDK 调用方看到原因。
  const { allowed: allowedServers, blocked } = filterMcpServersByPolicy(servers)
  const policyErrors: Record<string, string> = {}
  for (const name of blocked) {
    policyErrors[name] =
      'Blocked by enterprise policy (allowedMcpServers/deniedMcpServers)'
  }

  // 将 SDK server 与基于进程的 server 分开
  const sdkServers: Record<string, McpSdkServerConfig> = {}
  const processServers: Record<string, McpServerConfigForProcessTransport> = {}

  for (const [name, config] of Object.entries(allowedServers)) {
    if ((config.type as string) === 'sdk') {
      sdkServers[name] = config as unknown as McpSdkServerConfig
    } else {
      processServers[name] = config
    }
  }

  // 处理 SDK server
  const currentSdkNames = new Set(Object.keys(sdkState.configs))
  const newSdkNames = new Set(Object.keys(sdkServers))
  const sdkAdded: string[] = []
  const sdkRemoved: string[] = []

  const newSdkConfigs = { ...sdkState.configs }
  let newSdkClients = [...sdkState.clients]
  let newSdkTools = [...sdkState.tools]

  // 移除不再出现在目标状态中的 SDK server
  for (const name of currentSdkNames) {
    if (!newSdkNames.has(name)) {
      const client = newSdkClients.find(c => c.name === name)
      if (client && client.type === 'connected') {
        await client.cleanup()
      }
      newSdkClients = newSdkClients.filter(c => c.name !== name)
      const prefix = `mcp__${name}__`
      newSdkTools = newSdkTools.filter(t => !t.name.startsWith(prefix))
      delete newSdkConfigs[name]
      sdkRemoved.push(name)
    }
  }

  // 把新的 SDK server 以 pending 状态加入 —— 它们会在下一次 query 运行
  // updateSdkMcp() 时被升级为 connected
  for (const [name, config] of Object.entries(sdkServers)) {
    if (!currentSdkNames.has(name)) {
      newSdkConfigs[name] = config
      const pendingClient: MCPServerConnection = {
        type: 'pending',
        name,
        config: { ...config, scope: 'dynamic' as const },
      }
      newSdkClients = [...newSdkClients, pendingClient]
      sdkAdded.push(name)
    }
  }

  // 处理基于进程的 server
  const processResult = await reconcileMcpServers(
    processServers,
    dynamicState,
    setAppState,
  )

  return {
    response: {
      added: [...sdkAdded, ...processResult.response.added],
      removed: [...sdkRemoved, ...processResult.response.removed],
      errors: { ...policyErrors, ...processResult.response.errors },
    },
    newSdkState: {
      configs: newSdkConfigs,
      clients: newSdkClients,
      tools: newSdkTools,
    },
    newDynamicState: processResult.newState,
    sdkServersChanged: sdkAdded.length > 0 || sdkRemoved.length > 0,
  }
}

/**
 * 将当前的动态 MCP server 集合与新的目标状态进行对账。
 * 负责处理新增、移除以及 config 变更。
 */
export async function reconcileMcpServers(
  desiredConfigs: Record<string, McpServerConfigForProcessTransport>,
  currentState: DynamicMcpState,
  setAppState: (f: (prev: AppState) => AppState) => void,
): Promise<{
  response: SDKControlMcpSetServersResponse
  newState: DynamicMcpState
}> {
  const currentNames = new Set(Object.keys(currentState.configs))
  const desiredNames = new Set(Object.keys(desiredConfigs))

  const toRemove = [...currentNames].filter(n => !desiredNames.has(n))
  const toAdd = [...desiredNames].filter(n => !currentNames.has(n))

  // 检查 config 是否变化（同名但 config 不同）
  const toCheck = [...currentNames].filter(n => desiredNames.has(n))
  const toReplace = toCheck.filter(name => {
    const currentConfig = currentState.configs[name]
    const desiredConfigRaw = desiredConfigs[name]
    if (!currentConfig || !desiredConfigRaw) return true
    const desiredConfig = toScopedConfig(desiredConfigRaw)
    return !areMcpConfigsEqual(currentConfig, desiredConfig)
  })

  const removed: string[] = []
  const added: string[] = []
  const errors: Record<string, string> = {}

  let newClients = [...currentState.clients]
  let newTools = [...currentState.tools]

  // 移除旧的 server（包括正在被替换的）
  for (const name of [...toRemove, ...toReplace]) {
    const client = newClients.find(c => c.name === name)
    const config = currentState.configs[name]
    if (client && config) {
      if (client.type === 'connected') {
        try {
          await client.cleanup()
        } catch (e) {
          logError(e)
        }
      }
      // 清空 memoization 缓存
      await clearServerCache(name, config)
    }

    // 移除该 server 对应的 tools
    const prefix = `mcp__${name}__`
    newTools = newTools.filter(t => !t.name.startsWith(prefix))

    // 从 clients 列表中移除
    newClients = newClients.filter(c => c.name !== name)

    // 记录移除（只针对真正被移除的，不包含被替换的）
    if (toRemove.includes(name)) {
      removed.push(name)
    }
  }

  // 新增 server（包括被替换的）
  for (const name of [...toAdd, ...toReplace]) {
    const config = desiredConfigs[name]
    if (!config) continue
    const scopedConfig = toScopedConfig(config)

    // SDK server 由 SDK 进程管理，不由 CLI 管理。
    // 只跟踪它们，不尝试连接。
    if ((config.type as string) === 'sdk') {
      added.push(name)
      continue
    }

    try {
      const client = await connectToServer(name, scopedConfig)
      newClients.push(client)

      if (client.type === 'connected') {
        const serverTools = await fetchToolsForClient(client)
        newTools.push(...serverTools)
      } else if (client.type === 'failed') {
        errors[name] = client.error || 'Connection failed'
      }

      added.push(name)
    } catch (e) {
      const err = toError(e)
      errors[name] = err.message
      logError(err)
    }
  }

  // 构建新的 configs
  const newConfigs: Record<string, ScopedMcpServerConfig> = {}
  for (const name of desiredNames) {
    const config = desiredConfigs[name]
    if (config) {
      newConfigs[name] = toScopedConfig(config)
    }
  }

  const newState: DynamicMcpState = {
    clients: newClients,
    tools: newTools,
    configs: newConfigs,
  }

  // 用新的 tools 更新 AppState
  setAppState(prev => {
    // 收集所有动态 server 名（当前 + 新增）
    const allDynamicServerNames = new Set([
      ...Object.keys(currentState.configs),
      ...Object.keys(newConfigs),
    ])

    // 移除旧的动态 tools
    const nonDynamicTools = prev.mcp.tools.filter(t => {
      for (const serverName of allDynamicServerNames) {
        if (t.name.startsWith(`mcp__${serverName}__`)) {
          return false
        }
      }
      return true
    })

    // 移除旧的动态 clients
    const nonDynamicClients = prev.mcp.clients.filter(c => {
      return !allDynamicServerNames.has(c.name)
    })

    return {
      ...prev,
      mcp: {
        ...prev.mcp,
        tools: [...nonDynamicTools, ...newTools],
        clients: [...nonDynamicClients, ...newClients],
      },
    }
  })

  return {
    response: { added, removed, errors },
    newState,
  }
}
