// biome-ignore-all assist/source/organizeImports: ANT-ONLY 导入标记不可重新排序
import { feature } from 'bun:bundle';
import { spawnSync } from 'child_process';
import {
  snapshotOutputTokensForTurn,
  getCurrentTurnTokenBudget,
  getTurnOutputTokens,
  getBudgetContinuationCount,
  getTotalInputTokens,
} from '../bootstrap/state.js';
import { parseTokenBudget } from '../utils/tokenBudget.js';
import { count } from '../utils/array.js';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import figures from 'figures';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- / n N Esc [ v 在 transcript modal 上下文中是裸字母，与 ScrollKeybindingHandler 中的 g/G/j/k 同类
import { useInput } from '@anthropic/ink';
import { useSearchInput } from '../hooks/useSearchInput.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useSearchHighlight } from '@anthropic/ink';
import type { JumpHandle } from '../components/VirtualMessageList.js';
import { renderMessagesToPlainText } from '../utils/exportRenderer.js';
import { openFileInExternalEditor } from '../utils/editor.js';
import { writeFile } from 'fs/promises';
import {
  type TabStatusKind,
  Box,
  Text,
  useStdin,
  useTheme,
  useTerminalFocus,
  useTerminalTitle,
  useTabStatus,
} from '@anthropic/ink';
import { CostThresholdDialog } from '../components/CostThresholdDialog.js';
import { IdleReturnDialog } from '../components/IdleReturnDialog.js';
import * as React from 'react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  useDeferredValue,
  useLayoutEffect,
  type RefObject,
} from 'react';
import { useNotifications } from '../context/notifications.js';
import { sendNotification } from '../services/notifier.js';
import { startPreventSleep, stopPreventSleep } from '../services/preventSleep.js';
import { useTerminalNotification, hasCursorUpViewportYankBug } from '@anthropic/ink';
import {
  createFileStateCacheWithSizeLimit,
  mergeFileStateCaches,
  READ_FILE_STATE_CACHE_SIZE,
} from '../utils/fileStateCache.js';
import {
  updateLastInteractionTime,
  getLastInteractionTime,
  getOriginalCwd,
  getProjectRoot,
  getSessionId,
  switchSession,
  setCostStateForRestore,
  getTurnHookDurationMs,
  getTurnHookCount,
  resetTurnHookDuration,
  getTurnToolDurationMs,
  getTurnToolCount,
  resetTurnToolDuration,
  getTurnClassifierDurationMs,
  getTurnClassifierCount,
  resetTurnClassifierDuration,
} from '../bootstrap/state.js';
import { asSessionId, asAgentId } from '../types/ids.js';
import { logForDebugging } from '../utils/debug.js';
import { QueryGuard } from '../utils/QueryGuard.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import { formatTokens, truncateToWidth } from '../utils/format.js';
import { consumeEarlyInput } from '../utils/earlyInput.js';
import {
  claimConsumableQueuedAutonomyCommands,
  finalizeAutonomyCommandsForTurn,
} from '../utils/autonomyQueueLifecycle.js';

import { setMemberActive } from '../utils/swarm/teamHelpers.js';
import {
  isSwarmWorker,
  generateSandboxRequestId,
  sendSandboxPermissionRequestViaMailbox,
  sendSandboxPermissionResponseViaMailbox,
} from '../utils/swarm/permissionSync.js';
import { registerSandboxPermissionCallback } from '../hooks/useSwarmPermissionPoller.js';
import { getTeamName, getAgentName } from '../utils/teammate.js';
import { WorkerPendingPermission } from '../components/permissions/WorkerPendingPermission.js';
import {
  injectUserMessageToTeammate,
  getAllInProcessTeammateTasks,
} from '../tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import {
  isLocalAgentTask,
  queuePendingMessage,
  appendMessageToLocalAgent,
  type LocalAgentTaskState,
} from '../tasks/LocalAgentTask/LocalAgentTask.js';
import {
  registerLeaderToolUseConfirmQueue,
  unregisterLeaderToolUseConfirmQueue,
  registerLeaderSetToolPermissionContext,
  unregisterLeaderSetToolPermissionContext,
} from '../utils/swarm/leaderPermissionBridge.js';
import { endInteractionSpan } from '../utils/telemetry/sessionTracing.js';
import { useLogMessages } from '../hooks/useLogMessages.js';
import { useReplBridge } from '../hooks/useReplBridge.js';
import {
  type Command,
  type CommandResultDisplay,
  type ResumeEntrypoint,
  getCommandName,
  isCommandEnabled,
} from '../commands.js';
import type { PromptInputMode, QueuedCommand, VimMode } from '../types/textInputTypes.js';
import {
  MessageSelector,
  selectableUserMessagesFilter,
  messagesAfterAreOnlySynthetic,
} from '../components/MessageSelector.js';
import { useIdeLogging } from '../hooks/useIdeLogging.js';
import { PermissionRequest, type ToolUseConfirm } from '../components/permissions/PermissionRequest.js';
import { ElicitationDialog } from '../components/mcp/ElicitationDialog.js';
import { PromptDialog } from '../components/hooks/PromptDialog.js';
import type { PromptRequest, PromptResponse } from '../types/hooks.js';
import PromptInput from '../components/PromptInput/PromptInput.js';
import { PromptInputQueuedCommands } from '../components/PromptInput/PromptInputQueuedCommands.js';
import { useRemoteSession } from '../hooks/useRemoteSession.js';
import { useDirectConnect } from '../hooks/useDirectConnect.js';
import type { DirectConnectConfig } from '../server/directConnectManager.js';
import { useSSHSession } from '../hooks/useSSHSession.js';
import { useAssistantHistory } from '../hooks/useAssistantHistory.js';
import type { SSHSession } from '../ssh/createSSHSession.js';
import { SkillImprovementSurvey } from '../components/SkillImprovementSurvey.js';
import { useSkillImprovementSurvey } from '../hooks/useSkillImprovementSurvey.js';
import { useMoreRight } from '../moreright/useMoreRight.js';
import { SpinnerWithVerb, BriefIdleStatus, type SpinnerMode } from '../components/Spinner.js';
import { getSystemPrompt } from '../constants/prompts.js';
import { buildEffectiveSystemPrompt } from '../utils/systemPrompt.js';
import { getSystemContext, getUserContext } from '../context.js';
import { getMemoryFiles } from '../utils/claudemd.js';
import { startBackgroundHousekeeping } from '../utils/backgroundHousekeeping.js';
import { getTotalCost, saveCurrentSessionCosts, resetCostState, getStoredSessionCosts } from '../cost-tracker.js';
import { useCostSummary } from '../costHook.js';
import { useFpsMetrics } from '../context/fpsMetrics.js';
import { useAfterFirstRender } from '../hooks/useAfterFirstRender.js';
import { useDeferredHookMessages } from '../hooks/useDeferredHookMessages.js';
import { addToHistory, removeLastFromHistory, expandPastedTextRefs, parseReferences } from '../history.js';
import { prependModeCharacterToInput } from '../components/PromptInput/inputModes.js';
import { prependToShellHistoryCache } from '../utils/suggestions/shellHistoryCompletion.js';
import { useApiKeyVerification } from '../hooks/useApiKeyVerification.js';
import { GlobalKeybindingHandlers } from '../hooks/useGlobalKeybindings.js';
import { CommandKeybindingHandlers } from '../hooks/useCommandKeybindings.js';
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js';
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js';
import { getShortcutDisplay } from '../keybindings/shortcutFormat.js';
import { CancelRequestHandler } from '../hooks/useCancelRequest.js';
import { useBackgroundTaskNavigation } from '../hooks/useBackgroundTaskNavigation.js';
import { useSwarmInitialization } from '../hooks/useSwarmInitialization.js';
import { useTeammateViewAutoExit } from '../hooks/useTeammateViewAutoExit.js';
import { errorMessage, toError } from '../utils/errors.js';
import { isHumanTurn } from '../utils/messagePredicates.js';
import { logError } from '../utils/log.js';
import { getCwd } from '../utils/cwd.js';
// 死代码消除：条件导入
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const useVoiceIntegration: typeof import('../hooks/useVoiceIntegration.js').useVoiceIntegration = feature('VOICE_MODE')
  ? require('../hooks/useVoiceIntegration.js').useVoiceIntegration
  : () => ({
      stripTrailing: () => 0,
      handleKeyEvent: () => {},
      resetAnchor: () => {},
    });
const VoiceKeybindingHandler: typeof import('../hooks/useVoiceIntegration.js').VoiceKeybindingHandler = feature(
  'VOICE_MODE',
)
  ? require('../hooks/useVoiceIntegration.js').VoiceKeybindingHandler
  : () => null;
// 挫败感检测仅限 ant 使用（内部试用）。通过条件 require 让外部构建
// 完全移除该模块（包括两个会在每次 messages 变化时运行的 O(n) useMemo，
// 以及 GrowthBook 请求）。
const useFrustrationDetection: typeof import('../components/FeedbackSurvey/useFrustrationDetection.js').useFrustrationDetection =
  process.env.USER_TYPE === 'ant'
    ? require('../components/FeedbackSurvey/useFrustrationDetection.js').useFrustrationDetection
    : () => ({ state: 'closed', handleTranscriptSelect: () => {} });
// 仅限 ant 的组织警告。通过条件 require 让外部构建消除组织 UUID 列表
// （其中一个 UUID 在排除字符串列表中）。
const useAntOrgWarningNotification: typeof import('../hooks/notifs/useAntOrgWarningNotification.js').useAntOrgWarningNotification =
  process.env.USER_TYPE === 'ant'
    ? require('../hooks/notifs/useAntOrgWarningNotification.js').useAntOrgWarningNotification
    : () => {};
// 死代码消除：coordinator 模式的条件导入
const getCoordinatorUserContext: (
  mcpClients: ReadonlyArray<{ name: string }>,
  scratchpadDir?: string,
) => { [k: string]: string } = feature('COORDINATOR_MODE')
  ? require('../coordinator/coordinatorMode.js').getCoordinatorUserContext
  : () => ({});
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import useCanUseTool from '../hooks/useCanUseTool.js';
import type { ToolPermissionContext, Tool } from '../Tool.js';
import { notifyAutomationStateChanged } from '../utils/sessionState.js';
import {
  applyPermissionUpdate,
  applyPermissionUpdates,
  persistPermissionUpdate,
} from '../utils/permissions/PermissionUpdate.js';
import { buildPermissionUpdates } from '../components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.js';
import { stripDangerousPermissionsForAutoMode } from '../utils/permissions/permissionSetup.js';
import { getScratchpadDir, isScratchpadEnabled } from '../utils/permissions/filesystem.js';
import { WEB_FETCH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/WebFetchTool/prompt.js';
import { SLEEP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/SleepTool/prompt.js';
import { clearSpeculativeChecks } from '@claude-code-best/builtin-tools/tools/BashTool/bashPermissions.js';
import type { AutoUpdaterResult } from '../utils/autoUpdater.js';
import { getGlobalConfig, saveGlobalConfig, getGlobalConfigWriteCount } from '../utils/config.js';
import { hasConsoleBillingAccess } from '../utils/billing.js';
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js';
import {
  textForResubmit,
  handleMessageFromStream,
  type StreamingToolUse,
  type StreamingThinking,
  isCompactBoundaryMessage,
  getMessagesAfterCompactBoundary,
  getContentText,
  createUserMessage,
  createAssistantMessage,
  createTurnDurationMessage,
  createAgentsKilledMessage,
  createApiMetricsMessage,
  createSystemMessage,
  createCommandInputMessage,
  formatCommandInputTags,
} from '../utils/messages.js';
import { generateSessionTitle } from '../utils/sessionTitle.js';
import {
  BASH_INPUT_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  FORK_BOILERPLATE_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../constants/xml.js';
import { FORK_SUBAGENT_TYPE } from '@claude-code-best/builtin-tools/tools/AgentTool/forkSubagent.js';
import { escapeXml } from '../utils/xml.js';
import type { ThinkingConfig } from '../utils/thinking.js';
import { gracefulShutdownSync } from '../utils/gracefulShutdown.js';
import { handlePromptSubmit, type PromptInputHelpers } from '../utils/handlePromptSubmit.js';
import { useQueueProcessor } from '../hooks/useQueueProcessor.js';
import { useMailboxBridge } from '../hooks/useMailboxBridge.js';
import { queryCheckpoint, logQueryProfileReport } from '../utils/queryProfiler.js';
import type {
  Message as MessageType,
  UserMessage,
  ProgressMessage,
  HookResultMessage,
  PartialCompactDirection,
} from '../types/message.js';
import { query } from '../query.js';
import { mergeClients, useMergedClients } from '../hooks/useMergedClients.js';
import { getQuerySourceForREPL } from '../utils/promptCategory.js';
import { useMergedTools } from '../hooks/useMergedTools.js';
import { mergeAndFilterTools } from '../utils/toolPool.js';
import { useMergedCommands } from '../hooks/useMergedCommands.js';
import { useSkillsChange } from '../hooks/useSkillsChange.js';
import { useManagePlugins } from '../hooks/useManagePlugins.js';
import { Messages } from '../components/Messages.js';
import { TaskListV2 } from '../components/TaskListV2.js';
import { TeammateViewHeader } from '../components/TeammateViewHeader.js';
import { getPipeIpc } from '../utils/pipeTransport.js';
import { useTasksV2WithCollapseEffect } from '../hooks/useTasksV2.js';
import { maybeMarkProjectOnboardingComplete } from '../projectOnboardingState.js';
import type { MCPServerConnection } from '../services/mcp/types.js';
import type { ScopedMcpServerConfig } from '../services/mcp/types.js';
import { randomUUID, type UUID } from 'crypto';
import { processSessionStartHooks } from '../utils/sessionStart.js';
import { executeSessionEndHooks, getSessionEndHookTimeoutMs } from '../utils/hooks.js';
import { type IDESelection, useIdeSelection } from '../hooks/useIdeSelection.js';
import { getTools, assembleToolPool } from '../tools.js';
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js';
import { resolveAgentTools } from '@claude-code-best/builtin-tools/tools/AgentTool/agentToolUtils.js';
import { resumeAgentBackground } from '@claude-code-best/builtin-tools/tools/AgentTool/resumeAgent.js';
import { useMainLoopModel } from '../hooks/useMainLoopModel.js';
import { useAppState, useSetAppState, useAppStateStore } from '../state/AppState.js';
import type { ContentBlockParam, ContentBlock, ImageBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs';
import type { ProcessUserInputContext } from '../utils/processUserInput/processUserInput.js';
import type { PastedContent } from '../utils/config.js';
import type { InternalPermissionMode } from '../types/permissions.js';
import { copyPlanForFork, copyPlanForResume, getPlanSlug, setPlanSlug } from '../utils/plans.js';
import {
  clearSessionMetadata,
  resetSessionFilePointer,
  adoptResumedSessionFile,
  removeTranscriptMessage,
  restoreSessionMetadata,
  getCurrentSessionTitle,
  isEphemeralToolProgress,
  isLoggableMessage,
  saveWorktreeState,
  getAgentTranscript,
} from '../utils/sessionStorage.js';
import { deserializeMessages } from '../utils/conversationRecovery.js';
import { extractReadFilesFromMessages, extractBashToolsFromMessages } from '../utils/queryHelpers.js';
import { resetMicrocompactState } from '../services/compact/microCompact.js';
import { runPostCompactCleanup, registerCompactCleanup } from '../services/compact/postCompactCleanup.js';
import {
  createContentReplacementState,
  provisionContentReplacementState,
  reconstructContentReplacementState,
  type ContentReplacementRecord,
} from '../utils/toolResultStorage.js';
import { partialCompactConversation } from '../services/compact/compact.js';
import type { LogOption } from '../types/logs.js';
import type { AgentColorName } from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js';
import {
  fileHistoryMakeSnapshot,
  type FileHistoryState,
  fileHistoryRewind,
  type FileHistorySnapshot,
  copyFileHistoryForResume,
  fileHistoryEnabled,
  fileHistoryHasAnyChanges,
} from '../utils/fileHistory.js';
import { type AttributionState, incrementPromptCount } from '../utils/commitAttribution.js';
import { recordAttributionSnapshot } from '../utils/sessionStorage.js';
import {
  computeStandaloneAgentContext,
  restoreAgentFromSession,
  restoreSessionStateFromLog,
  restoreWorktreeForResume,
  exitRestoredWorktree,
} from '../utils/sessionRestore.js';
import { isBgSession, updateSessionName, updateSessionActivity } from '../utils/concurrentSessions.js';
import { isInProcessTeammateTask, type InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js';
import { restoreRemoteAgentTasks } from '../tasks/RemoteAgentTask/RemoteAgentTask.js';
import { BackgroundAgentSelector } from '../components/tasks/BackgroundAgentSelector.js';
import { useInboxPoller } from '../hooks/useInboxPoller.js';
// 死代码消除：loop 模式的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule = feature('PROACTIVE') || feature('KAIROS') ? require('../proactive/index.js') : null;
const PROACTIVE_NO_OP_SUBSCRIBE = (_cb: () => void) => () => {};
const PROACTIVE_FALSE = () => false;
const PROACTIVE_NULL = (): number | null => null;
const SUGGEST_BG_PR_NOOP = (_p: string, _n: string): boolean => false;
const useProactive =
  feature('PROACTIVE') || feature('KAIROS') ? require('../proactive/useProactive.js').useProactive : null;
const useScheduledTasks = feature('AGENT_TRIGGERS') ? require('../hooks/useScheduledTasks.js').useScheduledTasks : null;
const useGoalContinuation: typeof import('../hooks/useGoalContinuation.js').useGoalContinuation | null = feature('GOAL')
  ? require('../hooks/useGoalContinuation.js').useGoalContinuation
  : null;
const useMasterMonitor = feature('UDS_INBOX')
  ? require('../hooks/useMasterMonitor.js').useMasterMonitor
  : () => undefined;
const useSlaveNotifications = feature('UDS_INBOX')
  ? require('../hooks/useSlaveNotifications.js').useSlaveNotifications
  : () => undefined;
const usePipeIpc = feature('UDS_INBOX') ? require('../hooks/usePipeIpc.js').usePipeIpc : () => undefined;
const usePipeRelay = feature('UDS_INBOX')
  ? require('../hooks/usePipeRelay.js').usePipeRelay
  : () => ({ relayPipeMessage: () => false, pipeReturnHadErrorRef: { current: false } });
const usePipePermissionForward = feature('UDS_INBOX')
  ? require('../hooks/usePipePermissionForward.js').usePipePermissionForward
  : () => undefined;
const usePipeMuteSync = feature('UDS_INBOX') ? require('../hooks/usePipeMuteSync.js').usePipeMuteSync : () => undefined;
const usePipeRouter = feature('UDS_INBOX')
  ? require('../hooks/usePipeRouter.js').usePipeRouter
  : () => ({ routeToSelectedPipes: () => false });
/* eslint-enable @typescript-eslint/no-require-imports */
import { isAgentSwarmsEnabled } from '../utils/agentSwarmsEnabled.js';
import { useTaskListWatcher } from '../hooks/useTaskListWatcher.js';
import type { SandboxAskCallback, NetworkHostPattern } from '../utils/sandbox/sandbox-adapter.js';

import {
  type IDEExtensionInstallationStatus,
  closeOpenDiffs,
  getConnectedIdeClient,
  type IdeType,
} from '../utils/ide.js';
import { useIDEIntegration } from '../hooks/useIDEIntegration.js';
import exit from '../commands/exit/index.js';
import { ExitFlow } from '../components/ExitFlow.js';
import { getCurrentWorktreeSession } from '../utils/worktree.js';
import {
  popAllEditable,
  enqueue,
  type SetAppState,
  getCommandQueue,
  getCommandQueueLength,
  removeByFilter,
} from '../utils/messageQueueManager.js';
import { useCommandQueue } from '../hooks/useCommandQueue.js';
import { SessionBackgroundHint } from '../components/SessionBackgroundHint.js';
import { startBackgroundSession } from '../tasks/LocalMainSessionTask.js';
import { useSessionBackgrounding } from '../hooks/useSessionBackgrounding.js';
import { diagnosticTracker } from '../services/diagnosticTracking.js';
import { handleSpeculationAccept, type ActiveSpeculationState } from '../services/PromptSuggestion/speculation.js';
import { IdeOnboardingDialog } from '../components/IdeOnboardingDialog.js';
import { EffortCallout, shouldShowEffortCallout } from '../components/EffortCallout.js';
import type { EffortValue } from '../utils/effort.js';
import { RemoteCallout } from '../components/RemoteCallout.js';
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const AntModelSwitchCallout =
  process.env.USER_TYPE === 'ant' ? require('../components/AntModelSwitchCallout.js').AntModelSwitchCallout : null;
const shouldShowAntModelSwitch =
  process.env.USER_TYPE === 'ant'
    ? require('../components/AntModelSwitchCallout.js').shouldShowModelSwitchCallout
    : (): boolean => false;
const UndercoverAutoCallout =
  process.env.USER_TYPE === 'ant' ? require('../components/UndercoverAutoCallout.js').UndercoverAutoCallout : null;
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import { activityManager } from '../utils/activityManager.js';
import { createAbortController } from '../utils/abortController.js';
import { MCPConnectionManager } from 'src/services/mcp/MCPConnectionManager.js';
import { useFeedbackSurvey } from 'src/components/FeedbackSurvey/useFeedbackSurvey.js';
import { useMemorySurvey } from 'src/components/FeedbackSurvey/useMemorySurvey.js';
import { usePostCompactSurvey } from 'src/components/FeedbackSurvey/usePostCompactSurvey.js';
import { FeedbackSurvey } from 'src/components/FeedbackSurvey/FeedbackSurvey.js';
import { useInstallMessages } from 'src/hooks/notifs/useInstallMessages.js';
import { useAwaySummary } from 'src/hooks/useAwaySummary.js';
import { useChromeExtensionNotification } from 'src/hooks/useChromeExtensionNotification.js';
import { useOfficialMarketplaceNotification } from 'src/hooks/useOfficialMarketplaceNotification.js';
import { usePromptsFromClaudeInChrome } from 'src/hooks/usePromptsFromClaudeInChrome.js';
import { getTipToShowOnSpinner, recordShownTip } from 'src/services/tips/tipScheduler.js';
import type { Theme } from 'src/utils/theme.js';
import {
  checkAndDisableAutoModeIfNeeded,
  useKickOffCheckAndDisableAutoModeIfNeeded,
} from 'src/utils/permissions/bypassPermissionsKillswitch.js';
import { SandboxManager } from 'src/utils/sandbox/sandbox-adapter.js';
import { SANDBOX_NETWORK_ACCESS_TOOL_NAME } from 'src/cli/structuredIO.js';
import { useFileHistorySnapshotInit } from 'src/hooks/useFileHistorySnapshotInit.js';
import { SandboxPermissionRequest } from 'src/components/permissions/SandboxPermissionRequest.js';
import { SandboxViolationExpandedView } from 'src/components/SandboxViolationExpandedView.js';
import { useSettingsErrors } from 'src/hooks/notifs/useSettingsErrors.js';
import { useMcpConnectivityStatus } from 'src/hooks/notifs/useMcpConnectivityStatus.js';
import { AUTO_MODE_DESCRIPTION } from 'src/components/AutoModeOptInDialog.js';
import { useLspInitializationNotification } from 'src/hooks/notifs/useLspInitializationNotification.js';
import { useLspPluginRecommendation } from 'src/hooks/useLspPluginRecommendation.js';
import { LspRecommendationMenu } from 'src/components/LspRecommendation/LspRecommendationMenu.js';
import { useClaudeCodeHintRecommendation } from 'src/hooks/useClaudeCodeHintRecommendation.js';
import { PluginHintMenu } from 'src/components/ClaudeCodeHint/PluginHintMenu.js';
import { SearchExtraToolsHint } from 'src/components/SearchExtraToolsHint.js';
import { useSearchExtraToolsHint } from 'src/hooks/useSearchExtraToolsHint.js';
import {
  DesktopUpsellStartup,
  shouldShowDesktopUpsellStartup,
} from 'src/components/DesktopUpsell/DesktopUpsellStartup.js';
import { usePluginInstallationStatus } from 'src/hooks/notifs/usePluginInstallationStatus.js';
import { usePluginAutoupdateNotification } from 'src/hooks/notifs/usePluginAutoupdateNotification.js';
import { performStartupChecks } from 'src/utils/plugins/performStartupChecks.js';
import { UserTextMessage } from 'src/components/messages/UserTextMessage.js';
import { AwsAuthStatusBox } from '../components/AwsAuthStatusBox.js';
import { useRateLimitWarningNotification } from 'src/hooks/notifs/useRateLimitWarningNotification.js';
import { useDeprecationWarningNotification } from 'src/hooks/notifs/useDeprecationWarningNotification.js';
import { useNpmDeprecationNotification } from 'src/hooks/notifs/useNpmDeprecationNotification.js';
import { useIDEStatusIndicator } from 'src/hooks/notifs/useIDEStatusIndicator.js';
import { useModelMigrationNotifications } from 'src/hooks/notifs/useModelMigrationNotifications.js';
import { useCanSwitchToExistingSubscription } from 'src/hooks/notifs/useCanSwitchToExistingSubscription.js';
import { useTeammateLifecycleNotification } from 'src/hooks/notifs/useTeammateShutdownNotification.js';
import { useFastModeNotification } from 'src/hooks/notifs/useFastModeNotification.js';
import {
  AutoRunIssueNotification,
  shouldAutoRunIssue,
  getAutoRunIssueReasonText,
  getAutoRunCommand,
  type AutoRunIssueReason,
} from '../utils/autoRunIssue.js';
import type { HookProgress } from '../types/hooks.js';
import { TungstenLiveMonitor } from '@claude-code-best/builtin-tools/tools/TungstenTool/TungstenLiveMonitor.js';
// WebBrowserPanel 已移除 — browser-lite 通过 tool_result 内联返回结果。
// 完整的浏览器交互请使用 Claude-in-Chrome MCP 工具。
import { IssueFlagBanner } from '../components/PromptInput/IssueFlagBanner.js';
import { useIssueFlagBanner } from '../hooks/useIssueFlagBanner.js';
import { CompanionSprite, CompanionFloatingBubble, MIN_COLS_FOR_FULL_SPRITE } from '../buddy/CompanionSprite.js';
import { DevBar } from '../components/DevBar.js';
import { UltraplanChoiceDialog } from '../components/ultraplan/UltraplanChoiceDialog.js';
import { UltraplanLaunchDialog } from '../components/ultraplan/UltraplanLaunchDialog.js';
import { launchUltraplan } from '../commands/ultraplan.js';
// Session 管理器已移除 — 现在使用 AppState
import type { RemoteSessionConfig } from '../remote/RemoteSessionManager.js';
import { REMOTE_SAFE_COMMANDS } from '../commands.js';
import type { RemoteMessageContent } from '../utils/teleport/api.js';
import { FullscreenLayout, useUnseenDivider, computeUnseenDivider } from '../components/FullscreenLayout.js';
import { isFullscreenEnvEnabled, maybeGetTmuxMouseHint, isMouseTrackingEnabled } from '../utils/fullscreen.js';
import { AlternateScreen } from '@anthropic/ink';
import { ScrollKeybindingHandler } from '../components/ScrollKeybindingHandler.js';
import {
  useMessageActions,
  MessageActionsKeybindings,
  MessageActionsBar,
  type MessageActionsState,
  type MessageActionsNav,
  type MessageActionCaps,
} from '../components/messageActions.js';
import { setClipboard } from '@anthropic/ink';
import type { ScrollBoxHandle } from '@anthropic/ink';
import { createAttachmentMessage, getQueuedCommandAttachments } from '../utils/attachments.js';

// 接受 MCPServerConnection[] 的 hooks 使用的稳定空数组 — 避免在远程模式下
// 每次渲染都创建新的 [] 字面量，否则会导致 useEffect 依赖变化和无限重渲染循环。
const EMPTY_MCP_CLIENTS: MCPServerConnection[] = [];

// useAssistantHistory 非 KAIROS 分支使用的稳定存根 — 避免每次渲染
// 产生新的函数身份，否则会破坏 composedOnScroll 的 memo。
const HISTORY_STUB = { maybeLoadOlder: (_: ScrollBoxHandle) => {} };
// 用户发起滚动后的时间窗口，在此期间 type-into-empty 不会重新固定到底部。
// Josh Rosen 的工作流：Claude 输出长内容 → 向上滚动阅读开头 → 开始输入
// → 在此修复之前，会被强制滚动到底部。
// https://anthropic.slack.com/archives/C07VBSHV7EV/p1773545449871739
const RECENT_SCROLL_REPIN_WINDOW_MS = 3000;

// 使用 LRU 缓存防止内存无限增长
// 100 个文件应足以应对大多数编码会话，同时避免在大型项目中
// 处理多个文件时的内存问题

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/**
 * 显示 transcript 模式页脚（含动态快捷键）的小组件。
 * 必须渲染在 KeybindingSetup 内部以访问 keybinding 上下文。
 */
function TranscriptModeFooter({
  showAllInTranscript,
  virtualScroll,
  searchBadge,
  suppressShowAll = false,
  status,
}: {
  showAllInTranscript: boolean;
  virtualScroll: boolean;
  /** 闭栏搜索导航时的 minimap。显示 n/N 提示 + 右对齐计数，
   *  替代滚动提示。 */
  searchBadge?: { current: number; count: number };
  /** 隐藏 ctrl+e 提示。[ dump 路径与环境变量驱动的 dump
   *  （CLAUDE_CODE_NO_FLICKER=0 / DISABLE_VIRTUAL_SCROLL=1）共用此页脚，
   *  但 ctrl+e 仅在环境变量场景下生效 — useGlobalKeybindings.tsx 基于
   *  !virtualScrollActive（由环境变量派生）做门控，不知道 [
   *  事件发生过。 */
  suppressShowAll?: boolean;
  /** 瞬态状态（v-for-editor 进度）。通知在 PromptInput 内部渲染，
   *  而 PromptInput 在 transcript 中未挂载 — addNotification 只是入队，
   *  没有东西会渲染它。 */
  status?: string;
}): React.ReactNode {
  const toggleShortcut = useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o');
  const showAllShortcut = useShortcutDisplay('transcript:toggleShowAll', 'Transcript', 'ctrl+e');
  return (
    <Box
      noSelect
      alignItems="center"
      alignSelf="center"
      borderTopDimColor
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderStyle="single"
      marginTop={1}
      paddingLeft={2}
      width="100%"
    >
      <Text dimColor>
        Showing detailed transcript · {toggleShortcut} to toggle
        {searchBadge
          ? ' · n/N to navigate'
          : virtualScroll
            ? ` · ${figures.arrowUp}${figures.arrowDown} scroll · home/end top/bottom`
            : suppressShowAll
              ? ''
              : ` · ${showAllShortcut} to ${showAllInTranscript ? 'collapse' : 'show all'}`}
      </Text>
      {status ? (
        // v-for-editor 渲染进度 — 瞬态，优先级高于搜索 badge，
        // 因为用户刚按了 v 并想看到正在发生什么。4 秒后清除。
        <>
          <Box flexGrow={1} />
          <Text>{status} </Text>
        </>
      ) : searchBadge ? (
        // 引擎计数 — 作为粗略位置提示足够接近。对于 ghost/phantom
        // 消息可能与渲染计数有偏差。
        <>
          <Box flexGrow={1} />
          <Text dimColor>
            {searchBadge.current}/{searchBadge.count}
            {'  '}
          </Text>
        </>
      ) : null}
    </Box>
  );
}

/** less 风格的 / 搜索栏。单行，与 TranscriptModeFooter 使用相同的
 *  border-top 样式，以便在底部槽位中替换它们时不会改变 ScrollBox 高度。
 *  useSearchInput 处理 readline 编辑；我们报告 query 变化并渲染计数器。
 *  增量式 — 每次按键都重新搜索 + 高亮。 */
function TranscriptSearchBar({
  jumpRef,
  count,
  current,
  onClose,
  onCancel,
  setHighlight,
  initialQuery,
}: {
  jumpRef: RefObject<JumpHandle | null>;
  count: number;
  current: number;
  /** Enter — 提交。Query 持久化以供 n/N 使用。 */
  onClose: (lastQuery: string) => void;
  /** Esc/ctrl+c/ctrl+g — 回退到 / 之前的状态。 */
  onCancel: () => void;
  setHighlight: (query: string) => void;
  // 使用上一个 query 作为种子（less 风格：/ 显示上次的 pattern）。挂载时
  // 触发 effect 会用相同的 query 重新扫描 — 幂等（相同匹配、相同 nearest-ptr、
  // 相同高亮）。用户可以编辑或清除。
  initialQuery: string;
}): React.ReactNode {
  const { query, cursorOffset } = useSearchInput({
    isActive: true,
    initialQuery,
    onExit: () => onClose(query),
    onCancel,
  });
  // 索引预热在 query effect 之前运行，以测量真实开销 —
  // 否则 setSearchQuery 会先填充缓存，导致预热报告 ~0ms，
  // 而用户实际感受到了延迟。
  // 一个 transcript 会话中的第一次 / 承担 extractSearchText 开销。
  // 后续 / 立即返回 0（VML 中的 indexWarmed ref）。
  // Transcript 在 ctrl+o 时被冻结，所以缓存保持有效。
  // 初始为 'building'，使 warmDone 在挂载时为 false — [query] effect
  // 等待预热 effect 的第一次 resolve，而不是与之竞速。如果初始为 null，
  // warmDone 会在挂载时为 true → [query] 触发 → setSearchQuery 填充缓存
  // → 预热报告 ~0ms，而用户实际感受到了延迟。
  const [indexStatus, setIndexStatus] = React.useState<'building' | { ms: number } | null>('building');
  React.useEffect(() => {
    let alive = true;
    let hideTimeout: ReturnType<typeof setTimeout> | undefined;
    const warm = jumpRef.current?.warmSearchIndex;
    if (!warm) {
      setIndexStatus(null); // VML 尚未挂载 — 罕见情况，跳过指示器
      return;
    }
    setIndexStatus('building');
    warm().then(ms => {
      if (!alive) return;
      // <20ms = 不可感知。没必要显示 "indexed in 3ms"。
      if (ms < 20) {
        setIndexStatus(null);
      } else {
        setIndexStatus({ ms });
        hideTimeout = setTimeout(() => alive && setIndexStatus(null), 2000);
      }
    });
    return () => {
      alive = false;
      if (hideTimeout) clearTimeout(hideTimeout);
    };
  }, [jumpRef]); // 仅挂载时触发，因为搜索栏 ref 稳定
  // 将 query effect 门控在预热完成上。setHighlight 保持即时
  // （屏幕空间覆盖，无索引）。setSearchQuery（扫描）会等待。
  const warmDone = indexStatus !== 'building';
  useEffect(() => {
    if (!warmDone) return;
    jumpRef.current?.setSearchQuery(query);
    setHighlight(query);
  }, [jumpRef, query, setHighlight, warmDone]);
  const off = cursorOffset;
  const cursorChar = off < query.length ? query[off] : ' ';
  return (
    <Box
      borderTopDimColor
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderStyle="single"
      marginTop={1}
      paddingLeft={2}
      width="100%"
      // applySearchHighlight 会扫描整个屏幕缓冲区。此处渲染的 query
      // 文本确实在屏幕上 — /foo 会匹配搜索栏中自己的 'foo'。如果
      // 没有内容匹配，这是唯一可见的匹配 → 变为 CURRENT → 加下划线。
      // noSelect 让 searchHighlight.ts:76 跳过这些单元格（与 gutter
      // 的排除规则相同）。你也无法文本选择搜索栏；它是瞬态 UI，无影响。
      noSelect
    >
      <Text>/</Text>
      <Text>{query.slice(0, off)}</Text>
      <Text inverse>{cursorChar}</Text>
      {off < query.length && <Text>{query.slice(off + 1)}</Text>}
      <Box flexGrow={1} />
      {indexStatus === 'building' ? (
        <Text dimColor>indexing… </Text>
      ) : indexStatus ? (
        <Text dimColor>indexed in {indexStatus.ms}ms </Text>
      ) : count === 0 && query ? (
        <Text color="error">no matches </Text>
      ) : count > 0 ? (
        // 引擎计数（基于 extractSearchText 的 indexOf）。对于 ghost/phantom
        // 消息可能与渲染计数有偏差 — badge 只是粗略位置提示。scanElement
        // 提供精确的每条消息位置，但统计所有匹配会消耗约 1-3ms × 匹配消息数。
        <Text dimColor>
          {current}/{count}
          {'  '}
        </Text>
      ) : null}
    </Box>
  );
}

const TITLE_ANIMATION_FRAMES = ['⠂', '⠐'];
const TITLE_STATIC_PREFIX = '✳';
const TITLE_ANIMATION_INTERVAL_MS = 960;

/**
 * 设置终端 tab 标题，query 运行时显示动画前缀字符。从 REPL 中隔离，
 * 使得 960ms 的动画 tick 只重新渲染这个叶子组件（返回 null — 纯副作用），
 * 而不是整个 REPL 树。在抽取之前，这个 tick 会在每次 turn 期间每秒触发
 * 约 1 次 REPL 渲染，并连带重新渲染 PromptInput 等。
 */
function AnimatedTerminalTitle({
  isAnimating,
  title,
  disabled,
  noPrefix,
}: {
  isAnimating: boolean;
  title: string;
  disabled: boolean;
  noPrefix: boolean;
}): null {
  const terminalFocused = useTerminalFocus();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (disabled || noPrefix || !isAnimating || !terminalFocused) return;
    const interval = setInterval(
      setFrame => setFrame(f => (f + 1) % TITLE_ANIMATION_FRAMES.length),
      TITLE_ANIMATION_INTERVAL_MS,
      setFrame,
    );
    return () => clearInterval(interval);
  }, [disabled, noPrefix, isAnimating, terminalFocused]);
  const prefix = isAnimating ? (TITLE_ANIMATION_FRAMES[frame] ?? TITLE_STATIC_PREFIX) : TITLE_STATIC_PREFIX;
  useTerminalTitle(disabled ? null : noPrefix ? title : `${prefix} ${title}`);
  return null;
}

export type Props = {
  commands: Command[];
  debug: boolean;
  initialTools: Tool[];
  // 用于初始化 REPL 的初始消息
  initialMessages?: MessageType[];
  // 延迟 hook 消息的 Promise — REPL 立即渲染，在它们 resolve 后注入
  // hook 消息。在第一次 API 调用之前会被 await。
  pendingHookMessages?: Promise<HookResultMessage[]>;
  initialFileHistorySnapshots?: FileHistorySnapshot[];
  // 从恢复的 session transcript 中得到的内容替换记录 — 用于重建
  // contentReplacementState，使相同的结果被重新替换
  initialContentReplacements?: ContentReplacementRecord[];
  // session 恢复时的初始 agent 上下文（name/color 通过 /rename 或 /color 设置）
  initialAgentName?: string;
  initialAgentColor?: AgentColorName;
  mcpClients?: MCPServerConnection[];
  dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>;
  autoConnectIdeFlag?: boolean;
  strictMcpConfig?: boolean;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  // 可选回调，在 query 执行前调用
  // 在用户消息加入会话后、API 调用前调用
  // 返回 false 可阻止 query 执行
  onBeforeQuery?: (input: string, newMessages: MessageType[]) => Promise<boolean>;
  // 可选回调，当一个 turn 完成时调用（模型完成响应）
  onTurnComplete?: (messages: MessageType[]) => void | Promise<void>;
  // 为 true 时禁用 REPL 输入（隐藏 prompt 并禁用消息选择器）
  disabled?: boolean;
  // 用于主线程的可选 agent 定义
  mainThreadAgentDefinition?: AgentDefinition;
  // 为 true 时禁用所有 slash 命令
  disableSlashCommands?: boolean;
  // Task list id：设置后启用 tasks 模式，会监听任务列表并自动处理任务。
  taskListId?: string;
  // --remote 模式的远程 session 配置（使用 CCR 作为执行引擎）
  remoteSessionConfig?: RemoteSessionConfig;
  // `claude connect` 模式的直连配置（连接到 claude 服务器）
  directConnectConfig?: DirectConnectConfig;
  // `claude ssh` 模式的 SSH session（本地 REPL，远程工具通过 ssh）
  sshSession?: SSHSession;
  // 启用 thinking 时使用的 thinking 配置
  thinkingConfig: ThinkingConfig;
};

export type Screen = 'prompt' | 'transcript';

// 样板载体位于一个混合用户消息（[tool_result..., text]）中，
// AgentTool/forkSubagent.buildForkedMessages 将其作为 fork 子进程的
// 第一个用户 turn 输出。text 块包裹 <FORK_BOILERPLATE_TAG>...</..> + 用户
// prompt；tool_result 兄弟节点保持父级的 tool 调用处于关闭状态。
const FORK_BOILERPLATE_OPEN_TAG = `<${FORK_BOILERPLATE_TAG}>`;

function isForkBoilerplateTextBlock(block: { type: string; text?: string }): boolean {
  return block.type === 'text' && typeof block.text === 'string' && block.text.includes(FORK_BOILERPLATE_OPEN_TAG);
}

function isForkBoilerplateMessage(message: MessageType): boolean {
  if (message.type !== 'user' || !Array.isArray(message.message?.content)) return false;
  return message.message.content.some(isForkBoilerplateTextBlock);
}

export function REPL({
  commands: initialCommands,
  debug,
  initialTools,
  initialMessages,
  pendingHookMessages,
  initialFileHistorySnapshots,
  initialContentReplacements,
  initialAgentName: _initialAgentName,
  initialAgentColor: _initialAgentColor,
  mcpClients: initialMcpClients,
  dynamicMcpConfig: initialDynamicMcpConfig,
  autoConnectIdeFlag,
  strictMcpConfig = false,
  systemPrompt: customSystemPrompt,
  appendSystemPrompt,
  onBeforeQuery,
  onTurnComplete,
  disabled = false,
  mainThreadAgentDefinition: initialMainThreadAgentDefinition,
  disableSlashCommands = false,
  taskListId,
  remoteSessionConfig,
  directConnectConfig,
  sshSession,
  thinkingConfig,
}: Props): React.ReactNode {
  const isRemoteSession = !!remoteSessionConfig;
  logForDebugging(
    `[Hapii] REPL 组件渲染 isRemoteSession=${isRemoteSession} debug=${debug} initialTools=${initialTools.length} initialMessages=${initialMessages?.length ?? 0} hasAgentDef=${!!initialMainThreadAgentDefinition}`,
    { level: 'info' },
  );

  // 环境变量门控提升到挂载时 — isEnvTruthy 会做 toLowerCase+trim+includes，
  // 而这些原来在渲染路径上（PageUp 连按时是热点）。
  const titleDisabled = useMemo(() => isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE), []);
  const moreRightEnabled = useMemo(
    () => process.env.USER_TYPE === 'ant' && isEnvTruthy(process.env.CLAUDE_MORERIGHT),
    [],
  );
  const disableVirtualScroll = useMemo(() => isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL), []);
  const disableMessageActionsRaw = useMemo(() => isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_MESSAGE_ACTIONS), []);
  const disableMessageActions = feature('MESSAGE_ACTIONS') ? disableMessageActionsRaw : false;

  // 记录 REPL 挂载/卸载生命周期
  useEffect(() => {
    logForDebugging(`[REPL:mount] REPL mounted, disabled=${disabled}`);
    return () => logForDebugging(`[REPL:unmount] REPL unmounting`);
  }, [disabled]);

  // Agent 定义是 state，这样 /resume 可以在会话中途更新它
  const [mainThreadAgentDefinition, setMainThreadAgentDefinition] = useState(initialMainThreadAgentDefinition);

  const toolPermissionContext = useAppState(s => s.toolPermissionContext);
  const verbose = useAppState(s => s.verbose);
  const mcp = useAppState(s => s.mcp);
  const plugins = useAppState(s => s.plugins);
  const agentDefinitions = useAppState(s => s.agentDefinitions);
  const fileHistory = useAppState(s => s.fileHistory);
  const initialMessage = useAppState(s => s.initialMessage);
  const queuedCommands = useCommandQueue();
  // feature() 是构建时常量 — 死代码消除在外部构建中会完全移除 hook 调用，
  // 所以尽管看起来是条件性的，但这是安全的。
  // 这些字段包含不能出现在外部构建中的排除字符串。
  const spinnerTip = useAppState(s => s.spinnerTip);
  const showExpandedTodos = useAppState(s => s.expandedView) === 'tasks';
  const pendingWorkerRequest = useAppState(s => s.pendingWorkerRequest);
  const pendingSandboxRequest = useAppState(s => s.pendingSandboxRequest);
  const teamContext = useAppState(s => s.teamContext);
  const tasks = useAppState(s => s.tasks);
  const workerSandboxPermissions = useAppState(s => s.workerSandboxPermissions);
  const elicitation = useAppState(s => s.elicitation);
  const ultraplanPendingChoice = useAppState(s => s.ultraplanPendingChoice);
  const ultraplanLaunchPending = useAppState(s => s.ultraplanLaunchPending);
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId);
  const setAppState = useSetAppState();

  // Bootstrap：保留的 local_agent 尚未从磁盘加载 → 读取 sidechain JSONL
  // 并与 stream 已追加的内容做 UUID 合并。Stream 在 retain 时立即追加
  // （无延迟）；bootstrap 填充前缀。先写盘再返回意味着 live 始终是 disk 的后缀。
  const viewedLocalAgent = viewingAgentTaskId ? tasks[viewingAgentTaskId] : undefined;
  const needsBootstrap = isLocalAgentTask(viewedLocalAgent) && viewedLocalAgent.retain && !viewedLocalAgent.diskLoaded;
  if (needsBootstrap) {
    logForDebugging(`[Hapii] REPL.bootstrap local_agent 需要从磁盘加载 taskId=${viewingAgentTaskId}`, {
      level: 'info',
    });
  }
  useEffect(() => {
    if (!viewingAgentTaskId || !needsBootstrap) return;
    const taskId = viewingAgentTaskId;
    void getAgentTranscript(asAgentId(taskId)).then(result => {
      setAppState(prev => {
        const t = prev.tasks[taskId];
        if (!isLocalAgentTask(t) || t.diskLoaded || !t.retain) return prev;
        const live = t.messages ?? [];
        const liveUuids = new Set(live.map(m => m.uuid));
        const diskOnly = result ? result.messages.filter(m => !liveUuids.has(m.uuid)) : [];
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: {
              ...t,
              messages: [...diskOnly, ...live],
              diskLoaded: true,
            },
          },
        };
      });
    });
  }, [viewingAgentTaskId, needsBootstrap, setAppState]);

  const store = useAppStateStore();
  const terminal = useTerminalNotification();
  const mainLoopModel = useMainLoopModel();

  // 注意：standaloneAgentContext 在 main.tsx（通过 initialState）或
  // ResumeConversation.tsx（渲染 REPL 前通过 setAppState）中初始化，
  // 以避免在挂载时通过 useEffect 初始化状态（遵循 CLAUDE.md 指南）

  // 命令的本地状态（skill 文件变化时可热重载）
  const [localCommands, setLocalCommands] = useState(initialCommands);

  // 监听 skill 文件变化并重新加载所有命令
  useSkillsChange(isRemoteSession ? undefined : getProjectRoot(), setLocalCommands);

  // 为 tools 依赖跟踪 proactive 模式 — SleepTool 按 proactive 状态过滤
  const proactiveActive = React.useSyncExternalStore(
    proactiveModule?.subscribeToProactiveChanges ?? PROACTIVE_NO_OP_SUBSCRIBE,
    proactiveModule?.isProactiveActive ?? PROACTIVE_FALSE,
  );
  const proactiveNextTickAt = React.useSyncExternalStore<number | null>(
    proactiveModule?.subscribeToProactiveChanges ?? PROACTIVE_NO_OP_SUBSCRIBE,
    proactiveModule?.getNextTickAt ?? PROACTIVE_NULL,
  );

  // BriefTool.isEnabled() 从 bootstrap state 读取 getUserMsgOptIn()，而
  // /brief 会在会话中途与 isBriefOnly 一起翻转。下面的 memo 需要一个
  // React 可见的依赖，以便在发生这种情况时重新运行 getTools()；isBriefOnly
  // 是触发重新渲染的 AppState 镜像。否则，在会话中途切换 /brief 会留下
  // 陈旧的 tool 列表（没有 SendUserMessage），模型输出的纯文本会被 brief
  // 过滤器隐藏。
  const isBriefOnly = useAppState(s => s.isBriefOnly);

  const localTools = useMemo(
    () => getTools(toolPermissionContext),
    [toolPermissionContext, proactiveActive, isBriefOnly],
  );

  useKickOffCheckAndDisableAutoModeIfNeeded();

  const [dynamicMcpConfig, setDynamicMcpConfig] = useState<Record<string, ScopedMcpServerConfig> | undefined>(
    initialDynamicMcpConfig,
  );

  const onChangeDynamicMcpConfig = useCallback(
    (config: Record<string, ScopedMcpServerConfig>) => {
      setDynamicMcpConfig(config);
    },
    [setDynamicMcpConfig],
  );

  const [screen, setScreen] = useState<Screen>('prompt');
  const [showAllInTranscript, setShowAllInTranscript] = useState(false);
  // [ 强制在 transcript 模式中走 dump-to-scrollback 路径。与
  // CLAUDE_CODE_NO_FLICKER=0（进程生命周期）分离 — 这是瞬态的，
  // 在退出 transcript 时重置。诊断逃生通道，让 terminal/tmux 原生的
  // cmd-F 能搜索完整的扁平渲染。
  const [dumpMode, setDumpMode] = useState(false);
  // v-for-editor 渲染进度。内联在页脚 — 通知在 PromptInput 内渲染，
  // 而 PromptInput 在 transcript 中未挂载。
  const [editorStatus, setEditorStatus] = useState('');
  // 退出 transcript 时递增。异步 v-render 在开始时捕获此值；
  // 每次状态写入如果已过期则 no-op（用户在渲染中途离开 transcript —
  // 否则稳定的 setState 会在下一个 session 中盖印一个幽灵 toast）。
  // 同时清除任何挂起的 4s 自动清除。
  const editorGenRef = useRef(0);
  const editorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const editorRenderingRef = useRef(false);
  const { addNotification, removeNotification } = useNotifications();

  // eslint-disable-next-line prefer-const
  let trySuggestBgPRIntercept = SUGGEST_BG_PR_NOOP;

  const mcpClients = useMergedClients(initialMcpClients, mcp.clients);

  // IDE 集成
  const [ideSelection, setIDESelection] = useState<IDESelection | undefined>(undefined);
  const [ideToInstallExtension, setIDEToInstallExtension] = useState<IdeType | null>(null);
  const [ideInstallationStatus, setIDEInstallationStatus] = useState<IDEExtensionInstallationStatus | null>(null);
  const [showIdeOnboarding, setShowIdeOnboarding] = useState(false);
  // 死代码消除：模型切换提示状态（仅限 ant）
  const [showModelSwitchCallout, setShowModelSwitchCallout] = useState(() => {
    if (process.env.USER_TYPE === 'ant') {
      return shouldShowAntModelSwitch();
    }
    return false;
  });
  const [showEffortCallout, setShowEffortCallout] = useState(() => shouldShowEffortCallout(mainLoopModel));
  const showRemoteCallout = useAppState(s => s.showRemoteCallout);
  const [showDesktopUpsellStartup, setShowDesktopUpsellStartup] = useState(() => shouldShowDesktopUpsellStartup());
  // 通知
  useModelMigrationNotifications();
  useCanSwitchToExistingSubscription();
  useIDEStatusIndicator({ ideSelection, mcpClients, ideInstallationStatus });
  useMcpConnectivityStatus({ mcpClients });
  usePluginInstallationStatus();
  usePluginAutoupdateNotification();
  useSettingsErrors();
  useRateLimitWarningNotification(mainLoopModel);
  useFastModeNotification();
  useDeprecationWarningNotification(mainLoopModel);
  useNpmDeprecationNotification();
  useAntOrgWarningNotification();
  useInstallMessages();
  useChromeExtensionNotification();
  useOfficialMarketplaceNotification();
  useLspInitializationNotification();
  useTeammateLifecycleNotification();
  const { recommendation: lspRecommendation, handleResponse: handleLspResponse } = useLspPluginRecommendation();
  const { recommendation: hintRecommendation, handleResponse: handleHintResponse } = useClaudeCodeHintRecommendation();
  const searchExtraToolsHint = useSearchExtraToolsHint();

  // 对组合的初始 tools 数组做 memo，以防止引用变化
  const combinedInitialTools = useMemo(() => {
    return [...localTools, ...initialTools];
  }, [localTools, initialTools]);

  // 初始化插件管理
  useManagePlugins({ enabled: !isRemoteSession });

  const tasksV2 = useTasksV2WithCollapseEffect();

  // 启动后台插件安装

  // 安全：此代码保证只在用户确认"信任此文件夹"对话框后才运行。信任对话框
  // 在 cli.tsx（约 387 行）中、REPL 组件渲染之前显示。该对话框会阻塞执行，
  // 直到用户接受，然后才会挂载 REPL 组件并运行此 effect。
  // 这确保来自仓库和用户设置的插件安装只在用户明确同意信任当前工作目录后进行。
  useEffect(() => {
    if (isRemoteSession) return;
    logForDebugging('[Hapii] REPL: 执行 startupChecks（插件/安全检测）', { level: 'info' });
    void performStartupChecks(setAppState);
  }, [setAppState, isRemoteSession]);

  // 允许 Claude in Chrome MCP 通过 MCP 通知发送 prompt
  // 并同步权限模式变化到 Chrome 扩展
  usePromptsFromClaudeInChrome(isRemoteSession ? EMPTY_MCP_CLIENTS : mcpClients, toolPermissionContext.mode);

  // 初始化 swarm 功能：teammate hooks 和上下文
  // 同时处理全新生成和恢复的 teammate 会话
  useSwarmInitialization(setAppState, initialMessages, {
    enabled: !isRemoteSession,
  });

  const mergedTools = useMergedTools(combinedInitialTools, mcp.tools, toolPermissionContext);

  // 如果设置了 mainThreadAgentDefinition，应用 agent 工具限制
  const { tools, allowedAgentTypes } = useMemo(() => {
    if (!mainThreadAgentDefinition) {
      return {
        tools: mergedTools,
        allowedAgentTypes: undefined as string[] | undefined,
      };
    }
    const resolved = resolveAgentTools(mainThreadAgentDefinition, mergedTools, false, true);
    return {
      tools: resolved.resolvedTools,
      allowedAgentTypes: resolved.allowedAgentTypes,
    };
  }, [mainThreadAgentDefinition, mergedTools]);

  // 合并本地状态、插件和 MCP 的命令
  const commandsWithPlugins = useMergedCommands(localCommands, plugins.commands as Command[]);
  const mergedCommands = useMergedCommands(commandsWithPlugins, mcp.commands as Command[]);
  // 如果 disableSlashCommands 为 true，过滤掉所有命令
  const commands = useMemo(() => (disableSlashCommands ? [] : mergedCommands), [disableSlashCommands, mergedCommands]);

  useIdeLogging(isRemoteSession ? EMPTY_MCP_CLIENTS : mcp.clients);
  useIdeSelection(isRemoteSession ? EMPTY_MCP_CLIENTS : mcp.clients, setIDESelection);

  const [streamMode, setStreamMode] = useState<SpinnerMode>('responding');
  // Ref 镜像，使 onSubmit 可以读取最新值而无需将 streamMode 加入依赖。
  // streamMode 在流式传输期间每个 turn 在 requesting/responding/tool-use
  // 之间翻转约 10 次；将其放入 onSubmit 的依赖会在每次翻转时重建 onSubmit，
  // 进而级联导致 PromptInput prop 抖动和下游 useCallback/useMemo 失效。
  // 回调内部唯一的消费者是调试日志和 telemetry（handlePromptSubmit.ts），
  // 所以延迟一帧的值是无害的 — 但 ref 镜像会在每次渲染时同步，因此始终新鲜。
  const streamModeRef = useRef(streamMode);
  streamModeRef.current = streamMode;
  const [streamingToolUses, setStreamingToolUses] = useState<StreamingToolUse[]>([]);
  const [streamingThinking, setStreamingThinking] = useState<StreamingThinking | null>(null);

  // streaming thinking 完成 30 秒后自动隐藏
  useEffect(() => {
    if (streamingThinking && !streamingThinking.isStreaming && streamingThinking.streamingEndedAt) {
      const elapsed = Date.now() - streamingThinking.streamingEndedAt;
      const remaining = 30000 - elapsed;
      if (remaining > 0) {
        const timer = setTimeout(setStreamingThinking, remaining, null);
        return () => clearTimeout(timer);
      } else {
        setStreamingThinking(null);
      }
    }
  }, [streamingThinking]);

  const [abortController, setAbortController] = useState<AbortController | null>(null);
  // 始终指向当前 abort controller 的 ref，REPL bridge 在收到远程中断时
  // 使用它中止活跃 query。
  const abortControllerRef = useRef<AbortController | null>(null);
  abortControllerRef.current = abortController;

  // 最近一次 local-jsx 面板关闭的时间戳（ms）（例如对 /workflows 按 ESC）。
  // 被 onCancel 的宽限期守卫使用：关闭 local-jsx 面板的 ESC（或宽限窗口内
  // 紧随其后的任何 ESC）不得落入 abortController.abort('user-cancel') —
  // 否则通过 ESC 关闭 /workflows 面板会杀死正在运行的 Workflow 工具。
  // chat:cancel keybinding 的 isActive 门控（`!isLocalJSXCommand`）仅在
  // 面板挂载时保护它；一旦 React 提交卸载，下一个 ESC 会无保护地到达
  // onCancel。此 ref 在不修改 keybinding 注册顺序的情况下解决了该竞态。
  const LOCAL_JSX_CLOSE_CANCEL_GRACE_MS = 500;
  const localJSXClosedAtRef = useRef(0);

  // 跟踪上一个 turn 是否被用户中止（Ctrl+C / Escape）。
  // 为 true 时，useGoalContinuation 跳过 continuation 入队，使被中断的
  // turn 不会陷入不可停止的循环。在下一次用户发起的 turn 开始时重置为 false。
  const [wasAborted, setWasAborted] = useState(false);

  // bridge 结果回调的 ref — 在 useReplBridge 初始化后设置，在 onQuery
  // finally 块中读取，用于通知移动端客户端 turn 已结束。
  const sendBridgeResultRef = useRef<() => void>(() => {});

  // 同步 restore 回调的 ref — 在 restoreMessageSync 定义后设置，在
  // onQuery finally 块中读取，用于中断时自动恢复。
  const restoreMessageSyncRef = useRef<(m: UserMessage) => void>(() => {});

  // 全屏布局 scroll box 的 ref，用于键盘滚动。
  // 全屏模式禁用时为 null（ref 从未附加）。
  const scrollRef = useRef<ScrollBoxHandle>(null);
  // modal 槽位内部 ScrollBox 的独立 ref — 通过
  // FullscreenLayout → ModalContext 传递，让 Tabs 将其附加到自己的
  // ScrollBox 上以处理长内容（例如 /status 的 MCP 服务器列表）。非键盘
  // 驱动 — ScrollKeybindingHandler 保留在外部 ref 上，使 PgUp/PgDn/wheel
  // 始终滚动 modal 后面的 transcript。保留管道以便未来 modal 滚动接线。
  const modalScrollRef = useRef<ScrollBoxHandle>(null);
  // 最近一次用户发起滚动的时间戳（wheel、PgUp/PgDn、ctrl+u、End/Home、G、
  // 拖拽滚动）。在 composedOnScroll 中盖戳 — 这是 ScrollKeybindingHandler
  // 为每个用户滚动动作调用的唯一汇聚点。程序化滚动（repinScroll 的
  // scrollToBottom、sticky 自动跟随）不走 composedOnScroll，所以不会盖戳。
  // 使用 ref 而非 state：wheel 每次触发不重新渲染。
  const lastUserScrollTsRef = useRef(0);

  // query 生命周期的同步状态机。替代了易出错的双状态模式（isLoading 为
  // React state、异步批处理，与 isQueryRunning 为 ref、同步，两者可能不同步）。
  // 见 QueryGuard.ts。
  const queryGuard = React.useRef(new QueryGuard()).current;

  // 订阅 guard — dispatching 或 running 期间为 true。
  // 这是"是否有本地 query 正在进行"的唯一真相来源。
  const isQueryActive = React.useSyncExternalStore(queryGuard.subscribe, queryGuard.getSnapshot);

  // 本地 query guard 之外的操作的独立 loading 标志：
  // 远程会话（useRemoteSession / useDirectConnect）和前台化的后台任务
  // （useSessionBackgrounding）。这些不经过 onQuery / queryGuard，所以需要
  // 自己的 spinner 可见性状态。远程模式带初始 prompt 时初始化为 true
  // （由 CCR 处理）。
  const [isExternalLoading, setIsExternalLoadingRaw] = React.useState(remoteSessionConfig?.hasInitialPrompt ?? false);

  // 派生：任何 loading 源活跃。只读 — 无 setter。本地 query loading 由
  // queryGuard（reserve/tryStart/end/cancelReservation）驱动，外部 loading
  // 由 setIsExternalLoading 驱动。
  const isLoading = isQueryActive || isExternalLoading;

  // 经过时间由 SpinnerWithVerb 在每个动画帧从这些 ref 计算，避免使用会
  // 重新渲染整个 REPL 的 useInterval。
  const [userInputOnProcessing, setUserInputOnProcessingRaw] = React.useState<string | undefined>(undefined);
  // 设置 userInputOnProcessing 时的 messagesRef.current.length。
  // 当 displayedMessages 增长超过此值时占位符隐藏 — 即真实用户消息已落地到
  // 可见 transcript。
  const userInputBaselineRef = React.useRef(0);
  // 在已提交 prompt 正在处理但用户消息尚未到达 setMessages 时为 true。
  // setMessages 使用此标志在该窗口期间当无关异步消息（bridge 状态、hook
  // 结果、计划任务）落地时保持 baseline 同步。
  const userMessagePendingRef = React.useRef(false);

  // 用于精确计算经过时间的墙钟时间跟踪 ref
  const loadingStartTimeRef = React.useRef<number>(0);
  const totalPausedMsRef = React.useRef(0);
  const pauseStartTimeRef = React.useRef<number | null>(null);
  const resetTimingRefs = React.useCallback(() => {
    loadingStartTimeRef.current = Date.now();
    totalPausedMsRef.current = 0;
    pauseStartTimeRef.current = null;
  }, []);

  // 当 isQueryActive 从 false 变为 true 时内联重置计时 ref。
  // queryGuard.reserve()（在 executeUserInput 中）在 processUserInput 的
  // 第一次 await 之前触发，但 onQuery try 块中的 ref 重置在其之后运行。
  // 在这个间隙，React 会以 loadingStartTimeRef=0 渲染 spinner，计算出
  // elapsedTimeMs = Date.now() - 0 ≈ 56 年。这个内联重置在第一次观察到
  // isQueryActive 为 true 的渲染上运行 — 即第一次显示 spinner 的同一渲染
  // — 所以 ref 在 spinner 读取它时已是正确的。见 INC-4549。
  const wasQueryActiveRef = React.useRef(false);
  if (isQueryActive && !wasQueryActiveRef.current) {
    resetTimingRefs();
  }
  wasQueryActiveRef.current = isQueryActive;

  // setIsExternalLoading 的包装器，在转为 true 时重置计时 ref —
  // SpinnerWithVerb 读取这些值计算经过时间，所以远程会话 / 前台化任务
  // 也必须重置它们（不仅仅是本地 query，本地 query 在 onQuery 中重置）。
  // 否则，纯远程会话会显示约 56 年的经过时间（Date.now() - 0）。
  const setIsExternalLoading = React.useCallback(
    (value: boolean) => {
      setIsExternalLoadingRaw(value);
      if (value) resetTimingRefs();
    },
    [resetTimingRefs],
  );

  // 第一个有 swarm teammate 运行的 turn 的开始时间
  // 用于为延迟消息计算总经过时间（包括 teammate 执行）
  const swarmStartTimeRef = React.useRef<number | null>(null);
  const swarmBudgetInfoRef = React.useRef<{ tokens: number; limit: number; nudges: number } | undefined>(undefined);

  // 跟踪当前 focusedInputDialog 的 ref，用于回调中
  // 避免在定时器回调中检查 dialog 状态时出现陈旧闭包
  const focusedInputDialogRef = React.useRef<ReturnType<typeof getFocusedInputDialog>>(undefined);

  // 最后一次按键后多久才显示延迟对话框
  const PROMPT_SUPPRESSION_MS = 1500;
  // 用户正在积极输入时为 true — 延迟中断对话框，使按键不会意外关闭
  // 或回答用户还没读过的权限提示。
  const [isPromptInputActive, setIsPromptInputActive] = React.useState(false);

  const [autoUpdaterResult, setAutoUpdaterResult] = useState<AutoUpdaterResult | null>(null);

  useEffect(() => {
    if (autoUpdaterResult?.notifications) {
      autoUpdaterResult.notifications.forEach(notification => {
        addNotification({
          key: 'auto-updater-notification',
          text: notification,
          priority: 'low',
        });
      });
    }
  }, [autoUpdaterResult, addNotification]);

  // tmux + 全屏 + `mouse off`：一次性提示 wheel 不会滚动。
  // 我们不再修改 tmux 的 session 级 mouse 选项（它会污染同兄弟窗格）；
  // tmux 用户从 vim/less 中已经知道这个权衡。
  useEffect(() => {
    if (isFullscreenEnvEnabled()) {
      void maybeGetTmuxMouseHint().then(hint => {
        if (hint) {
          addNotification({
            key: 'tmux-mouse-hint',
            text: hint,
            priority: 'low',
          });
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [showUndercoverCallout, setShowUndercoverCallout] = useState(false);
  useEffect(() => {
    if (process.env.USER_TYPE === 'ant') {
      void (async () => {
        // 等待仓库分类稳定（已 memo，如果已初始化则为 no-op）。
        const { isInternalModelRepo } = await import('../utils/commitAttribution.js');
        await isInternalModelRepo();
        const { shouldShowUndercoverAutoNotice } = await import('../utils/undercover.js');
        if (shouldShowUndercoverAutoNotice()) {
          setShowUndercoverCallout(true);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [toolJSX, setToolJSXInternal] = useState<{
    jsx: React.ReactNode | null;
    shouldHidePromptInput: boolean;
    shouldContinueAnimation?: true;
    showSpinner?: boolean;
    isLocalJSXCommand?: boolean;
    isImmediate?: boolean;
  } | null>(null);

  // 单独跟踪本地 JSX 命令，使工具不能覆盖它们。
  // 这让"immediate"命令（如 /btw）在 Claude 处理期间也能持久存在。
  const localJSXCommandRef = useRef<{
    jsx: React.ReactNode | null;
    shouldHidePromptInput: boolean;
    shouldContinueAnimation?: true;
    showSpinner?: boolean;
    isLocalJSXCommand: true;
  } | null>(null);

  // setToolJSX 的包装器，保留本地 JSX 命令（如 /btw）。
  // 当本地 JSX 命令活跃时，我们忽略来自工具的更新，
  // 除非它们显式设置 clearLocalJSX: true（来自 onDone 回调）。
  //
  // 添加新的 IMMEDIATE 命令：
  // 1. 在命令定义中设置 `immediate: true`
  // 2. 在命令的 JSX 中调用 setToolJSX 时设置 `isLocalJSXCommand: true`
  // 3. 在 onDone 回调中，使用 `setToolJSX({ jsx: null, shouldHidePromptInput: false, clearLocalJSX: true })`
  //    在用户关闭覆盖层时显式清除它
  const setToolJSX = useCallback(
    (
      args: {
        jsx: React.ReactNode | null;
        shouldHidePromptInput: boolean;
        shouldContinueAnimation?: true;
        showSpinner?: boolean;
        isLocalJSXCommand?: boolean;
        clearLocalJSX?: boolean;
      } | null,
    ) => {
      // 如果设置的是本地 JSX 命令，将其存入 ref
      if (args?.isLocalJSXCommand) {
        const { clearLocalJSX: _, ...rest } = args;
        localJSXCommandRef.current = { ...rest, isLocalJSXCommand: true };
        setToolJSXInternal(rest);
        return;
      }

      // 如果 ref 中有活跃的本地 JSX 命令
      if (localJSXCommandRef.current) {
        // 仅在显式请求时允许清除（来自 onDone 回调）
        if (args?.clearLocalJSX) {
          localJSXCommandRef.current = null;
          setToolJSXInternal(null);
          // 盖戳关闭时间，使 onCancel 的宽限期守卫能吞掉刚关闭面板的
          // ESC（及紧随其后的任何 ESC）。
          localJSXClosedAtRef.current = Date.now();
          return;
        }
        // 否则，保持本地 JSX 命令可见 - 忽略工具更新
        return;
      }

      // 没有活跃的本地 JSX 命令，允许任何更新
      if (args?.clearLocalJSX) {
        setToolJSXInternal(null);
        return;
      }
      setToolJSXInternal(args);
    },
    [],
  );
  const [toolUseConfirmQueue, setToolUseConfirmQueue] = useState<ToolUseConfirm[]>([]);
  // 权限请求组件（目前仅 ExitPlanModePermissionRequest）注册的粘性页脚 JSX。
  // 在 FullscreenLayout 的 `bottom` 槽位中渲染，使响应选项在用户滚动长计划时保持可见。
  const [permissionStickyFooter, setPermissionStickyFooter] = useState<React.ReactNode | null>(null);
  const [sandboxPermissionRequestQueue, setSandboxPermissionRequestQueue] = useState<
    Array<{
      hostPattern: NetworkHostPattern;
      resolvePromise: (allowConnection: boolean) => void;
    }>
  >([]);
  const [promptQueue, setPromptQueue] = useState<
    Array<{
      request: PromptRequest;
      title: string;
      toolInputSummary?: string | null;
      resolve: (response: PromptResponse) => void;
      reject: (error: Error) => void;
    }>
  >([]);

  // 跟踪 sandbox 权限请求的 bridge 清理函数，使本地对话框处理器能在
  // 本地用户先响应时取消远程提示。以 host 为键以支持同 host 的并发请求。
  const sandboxBridgeCleanupRef = useRef<Map<string, Array<() => void>>>(new Map());

  // -- 终端标题管理
  // session 标题（通过 /rename 设置或恢复时还原）优先于
  // agent 名称，agent 名称优先于 Haiku 提取的主题；
  // 全部回退到产品名。
  const terminalTitleFromRename = useAppState(s => s.settings.terminalTitleFromRename) !== false;
  const sessionTitle = terminalTitleFromRename ? getCurrentSessionTitle(getSessionId()) : undefined;
  const [haikuTitle, setHaikuTitle] = useState<string>();
  // 门控生成 tab 标题的一次性 Haiku 调用。恢复时（有 initialMessages）
  // 初始化为 true，使我们不从会话中途的上下文重新为恢复的 session 命名。
  const haikuTitleAttemptedRef = useRef((initialMessages?.length ?? 0) > 0);
  const agentTitle = mainThreadAgentDefinition?.agentType;
  const terminalTitle = sessionTitle ?? agentTitle ?? haikuTitle ?? 'Claude Code';
  const isWaitingForApproval =
    toolUseConfirmQueue.length > 0 || promptQueue.length > 0 || pendingWorkerRequest || pendingSandboxRequest;
  // local-jsx 命令（如 /plugin、/config）显示用户面对的对话框并
  // 等待输入。要求 jsx != null — 如果标志卡在 true 但 jsx 为 null，
  // 当作未显示处理，使 TextInput 焦点和队列处理器不被幽灵覆盖层死锁。
  const isShowingLocalJSXCommand = toolJSX?.isLocalJSXCommand === true && toolJSX?.jsx != null;
  const titleIsAnimating = isLoading && !isWaitingForApproval && !isShowingLocalJSXCommand;
  // 标题动画状态放在 <AnimatedTerminalTitle> 中，使 960ms tick 不会
  // 重新渲染 REPL。titleDisabled/terminalTitle 仍在此处计算，因为
  // onQueryImpl 读取它们（后台 session 描述、haiku 标题提取门控）。

  // Claude 工作时防止 macOS 进入睡眠
  useEffect(() => {
    if (isLoading && !isWaitingForApproval && !isShowingLocalJSXCommand) {
      startPreventSleep();
      return () => stopPreventSleep();
    }
  }, [isLoading, isWaitingForApproval, isShowingLocalJSXCommand]);

  const sessionStatus: TabStatusKind =
    isWaitingForApproval || isShowingLocalJSXCommand ? 'waiting' : isLoading ? 'busy' : 'idle';

  const waitingFor =
    sessionStatus !== 'waiting'
      ? undefined
      : toolUseConfirmQueue.length > 0
        ? `approve ${toolUseConfirmQueue[0]!.tool.name}`
        : pendingWorkerRequest
          ? 'worker request'
          : pendingSandboxRequest
            ? 'sandbox request'
            : isShowingLocalJSXCommand
              ? 'dialog open'
              : 'input needed';

  // 将状态推送到 PID 文件供 `claude ps` 使用。Fire-and-forget；当此文件
  // 缺失/过期时，ps 回退到 transcript 尾部推导。
  useEffect(() => {
    if (feature('BG_SESSIONS')) {
      void updateSessionActivity({ status: sessionStatus, waitingFor });
    }
  }, [sessionStatus, waitingFor]);

  // 3P 默认关闭 —— OSC 21337 在规范稳定前为 ant 专属。
  // 做门控，以便在侧栏指示器与标题 spinner 冲突时（在同时渲染两者的
  // 终端中）可以回滚。当标志开启时，由用户可见的配置设置控制其是否活跃。
  const tabStatusGateEnabled = getFeatureValue_CACHED_MAY_BE_STALE('tengu_terminal_sidebar', false);
  const showStatusInTerminalTab = tabStatusGateEnabled && (getGlobalConfig().showStatusInTerminalTab ?? false);
  useTabStatus(titleDisabled || !showStatusInTerminalTab ? null : sessionStatus);

  // 为进程内 teammate 注册 leader 的 setToolUseConfirmQueue
  useEffect(() => {
    registerLeaderToolUseConfirmQueue(setToolUseConfirmQueue);
    return () => unregisterLeaderToolUseConfirmQueue();
  }, [setToolUseConfirmQueue]);

  const [messages, rawSetMessages] = useState<MessageType[]>(initialMessages ?? []);
  const messagesRef = useRef(messages);
  // 存储已显示的 willowMode 变体（如未显示提示则为 false）。
  // 在 hint_shown 时捕获，使 hint_converted telemetry 报告相同的变体 —
  // GrowthBook 值不应在会话中途改变，但只读一次可保证配对事件之间的一致性。
  const idleHintShownRef = useRef<string | false>(false);
  // 包装 setMessages，使 messagesRef 在调用返回瞬间即保持最新 —
  // 而不是等 React 稍后处理批处理。对 ref 先应用 updater，然后把计算值交给 React
  // （而不是函数）。rawSetMessages 的批处理变为 last-write-wins，
  // 而最后一次写入是正确的，因为每次调用都基于已更新的 ref 进行组合。
  // 这是 Zustand 模式：ref 是真相源，React state 是渲染投射。没有这个，
  // 那些入队函数式 updater 然后同步读取 ref 的路径
  // （例如 handleSpeculationAccept → onQuery）会看到陈旧数据。
  const setMessages = useCallback((action: React.SetStateAction<MessageType[]>) => {
    const prev = messagesRef.current;
    const next = typeof action === 'function' ? action(messagesRef.current) : action;
    messagesRef.current = next;
    if (next.length < userInputBaselineRef.current) {
      // 缩短（compact/rewind/clear）— 钳制，使 placeholderText 的长度
      // 检查不会过期。
      userInputBaselineRef.current = 0;
    } else if (next.length > prev.length && userMessagePendingRef.current) {
      // 在已提交用户消息尚未落地时增长了。如果添加的消息不包含它
      // （bridge 状态、hook 结果、processUserInputBase 期间异步落地的
      // 计划任务），提升 baseline 使占位符保持可见。一旦用户消息落地，
      // 停止跟踪 — 后续追加（assistant stream）不应重新显示占位符。
      const delta = next.length - prev.length;
      const added = prev.length === 0 || next[0] === prev[0] ? next.slice(-delta) : next.slice(0, delta);
      if (added.some(isHumanTurn)) {
        userMessagePendingRef.current = false;
      } else {
        userInputBaselineRef.current = next.length;
      }
    }
    rawSetMessages(next);
  }, []);
  // 与占位符文本一起捕获 baseline 消息计数，使渲染能在
  // displayedMessages 增长超过 baseline 后隐藏占位符。
  const setUserInputOnProcessing = useCallback((input: string | undefined) => {
    if (input !== undefined) {
      userInputBaselineRef.current = messagesRef.current.length;
      userMessagePendingRef.current = true;
    } else {
      userMessagePendingRef.current = false;
    }
    setUserInputOnProcessingRaw(input);
  }, []);
  // 全屏：跟踪 unseen-divider 位置。dividerIndex 每个滚动会话只变化约
  // 两次（第一次滚走 + 重新固定）。pillVisible 和 stickyPrompt 现在位于
  // FullscreenLayout — 它们直接订阅 ScrollBox，使逐帧滚动永不重新渲染 REPL。
  const { dividerIndex, dividerYRef, onScrollAway, onRepin, jumpToNew, shiftDivider } = useUnseenDivider(
    messages.length,
  );
  if (feature('AWAY_SUMMARY')) {
    useAwaySummary(messages, setMessages, isLoading);
  }
  const [cursor, setCursor] = useState<MessageActionsState | null>(null);
  const cursorNavRef = useRef<MessageActionsNav | null>(null);
  // 做 memo，使 Messages 的 React.memo 生效。
  const unseenDivider = useMemo(
    () => computeUnseenDivider(messages, dividerIndex),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 长度变化覆盖 append；useUnseenDivider 的 count-drop 守卫在 replace/rewind 时清除 dividerIndex
    [dividerIndex, messages.length],
  );
  // 重新固定滚动到底部并清除 unseen-messages baseline。在任何用户驱动的
  // 返回实时操作时调用（提交、输入空内容、覆盖层出现/消失）。
  const repinScroll = useCallback(() => {
    scrollRef.current?.scrollToBottom();
    onRepin();
    setCursor(null);
  }, [onRepin, setCursor]);
  // onSubmit 中提交处理器重新固定的兜底。如果在 handler 触发与 state 提交
  // 之间有缓冲 stdin 事件（wheel/drag）竞态，handler 的 scrollToBottom 可能
  // 被撤销。此 effect 在用户消息实际落地的渲染上触发 — 绑定到 React 的
  // 提交周期，所以不会与 stdin 竞态。以 lastMsg 身份（非 messages.length）
  // 为键，使 useAssistantHistory 的前缀追加不会错误地重新固定。
  const lastMsg = messages.at(-1);
  const lastMsgIsHuman = lastMsg != null && isHumanTurn(lastMsg);
  useEffect(() => {
    if (lastMsgIsHuman) {
      repinScroll();
    }
  }, [lastMsgIsHuman, lastMsg, repinScroll]);
  // Assistant-chat：向上滚动时懒加载远程历史。除非 KAIROS 构建 +
  // config.viewerOnly，否则为 no-op。feature() 是构建时常量，所以在
  // 非 KAIROS 构建中此分支被死代码消除（与上面 useUnseenDivider 相同模式）。
  const assistantHistoryResult = useAssistantHistory({
    config: remoteSessionConfig,
    setMessages,
    scrollRef,
    onPrepend: shiftDivider,
  });
  const { maybeLoadOlder } = feature('KAIROS') ? assistantHistoryResult : HISTORY_STUB;
  // 将 useUnseenDivider 的回调与懒加载触发器组合。
  const composedOnScroll = useCallback(
    (sticky: boolean, handle: ScrollBoxHandle) => {
      lastUserScrollTsRef.current = Date.now();
      if (sticky) {
        onRepin();
      } else {
        onScrollAway(handle);
        if (feature('KAIROS')) maybeLoadOlder(handle);
        // 滚动时关闭 companion 气泡 — 它绝对定位在右下角并覆盖
        // transcript 内容。滚动 = 用户试图读取其下方的内容。
        if (feature('BUDDY')) {
          setAppState(prev =>
            prev.companionReaction === undefined ? prev : { ...prev, companionReaction: undefined },
          );
        }
      }
    },
    [onRepin, onScrollAway, maybeLoadOlder, setAppState],
  );
  // 延迟的 SessionStart hook 消息 — REPL 立即渲染，hook 消息在它们
  // resolve 后注入。awaitPendingHooks() 必须在第一次 API 调用前调用，
  // 使模型看到 hook 上下文。
  const awaitPendingHooks = useDeferredHookMessages(pendingHookMessages, setMessages);

  // Messages 组件的延迟消息 — 以 transition 优先级渲染，使 reconciler
  // 每 5ms 让出一次，在运行昂贵的消息处理流水线时保持输入响应性。
  // 上限 500 条消息以限制内存双缓冲。展示时在流式传输和非 loading
  // 期间的 bypass 使用同步消息，所以此上限只影响 reduced-motion 场景。
  const DEFERRED_CAP = 500;
  const cappedMessages = React.useMemo(
    () => (messages.length > DEFERRED_CAP ? messages.slice(-DEFERRED_CAP) : messages),
    [messages],
  );
  const deferredMessages = useDeferredValue(cappedMessages);
  const deferredBehind = messages.length - deferredMessages.length;
  if (deferredBehind > 0) {
    logForDebugging(
      `[useDeferredValue] Messages deferred by ${deferredBehind} (${deferredMessages.length}→${messages.length})`,
    );
  }

  // transcript 模式的冻结状态 — 存储长度而非克隆数组以提升内存效率
  const [frozenTranscriptState, setFrozenTranscriptState] = useState<{
    messagesLength: number;
    streamingToolUsesLength: number;
  } | null>(null);
  // 使用 REPL 就绪前捕获的早期输入初始化输入。
  // 使用惰性初始化确保 PromptInput 中的光标偏移设置正确。
  const [inputValue, setInputValueRaw] = useState(() => consumeEarlyInput());
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;
  const insertTextRef = useRef<{
    insert: (text: string) => void;
    setInputWithCursor: (value: string, cursor: number) => void;
    cursorOffset: number;
  } | null>(null);

  // 包装 setInputValue，将抑制状态更新放在一起。
  // 两次 setState 在同一同步上下文中发生，React 将它们批处理为单次渲染，
  // 消除了之前 useEffect → setState 模式导致的额外渲染。
  const setInputValue = useCallback(
    (value: string) => {
      if (trySuggestBgPRIntercept(inputValueRef.current, value)) return;
      // 全屏模式下，在空 prompt 中输入会重新固定滚动到底部。仅在 empty→non-empty
      // 时触发，使编写消息时向上滚动引用某内容不会在每次按键时把视图拽回。
      // 恢复全屏前的肌肉记忆 — 输入即跳到会话末尾。
      // 如果用户在过去 3 秒内滚动过则跳过 — 他们正在积极阅读，不是迷路了。
      // lastUserScrollTsRef 从 0 开始，所以首次按键（尚未滚动）总是重新固定。
      if (
        inputValueRef.current === '' &&
        value !== '' &&
        Date.now() - lastUserScrollTsRef.current >= RECENT_SCROLL_REPIN_WINDOW_MS
      ) {
        repinScroll();
      }
      // 立即同步 ref（类似 setMessages），使在 React 提交前读取
      // inputValueRef 的调用方 — 例如 auto-restore finally 块的
      // `=== ''` 守卫 — 看到的是新值，而非陈旧渲染。
      inputValueRef.current = value;
      setInputValueRaw(value);
      setIsPromptInputActive(value.trim().length > 0);
    },
    [setIsPromptInputActive, repinScroll, trySuggestBgPRIntercept],
  );

  // 安排一个 timeout，在用户停止输入后停止抑制对话框。
  // 仅管理 timeout — 即时激活由上面的 setInputValue 处理。
  useEffect(() => {
    if (inputValue.trim().length === 0) return;
    const timer = setTimeout(setIsPromptInputActive, PROMPT_SUPPRESSION_MS, false);
    return () => clearTimeout(timer);
  }, [inputValue]);

  const [inputMode, setInputMode] = useState<PromptInputMode>('prompt');
  const [stashedPrompt, setStashedPrompt] = useState<
    | {
        text: string;
        cursorOffset: number;
        pastedContents: Record<number, PastedContent>;
      }
    | undefined
  >();

  // 基于 CCR 可用 slash 命令过滤命令的回调
  const handleRemoteInit = useCallback(
    (remoteSlashCommands: string[]) => {
      const remoteCommandSet = new Set(remoteSlashCommands);
      // 保留 CCR 列出的命令或在本地安全集合中的命令
      setLocalCommands(prev => prev.filter(cmd => remoteCommandSet.has(cmd.name) || REMOTE_SAFE_COMMANDS.has(cmd)));
    },
    [setLocalCommands],
  );

  const [inProgressToolUseIDs, setInProgressToolUseIDs] = useState<Set<string>>(new Set());
  const hasInterruptibleToolInProgressRef = useRef(false);

  // 远程会话 hook - 管理 --remote 模式的 WebSocket 连接和消息处理
  const remoteSession = useRemoteSession({
    config: remoteSessionConfig,
    setMessages,
    setIsLoading: setIsExternalLoading,
    onInit: handleRemoteInit,
    setToolUseConfirmQueue,
    tools: combinedInitialTools,
    setStreamingToolUses,
    setStreamMode,
    setInProgressToolUseIDs,
  });

  // 直连 hook - 管理 `claude connect` 模式下到 claude 服务器的 WebSocket
  const directConnect = useDirectConnect({
    config: directConnectConfig,
    setMessages,
    setIsLoading: setIsExternalLoading,
    setToolUseConfirmQueue,
    tools: combinedInitialTools,
  });

  // SSH 会话 hook - 管理 `claude ssh` 模式下的 ssh 子进程。
  // 与 useDirectConnect 的回调形态相同；只是底层传输不同
  // （ChildProcess stdin/stdout vs WebSocket）。
  const sshRemote = useSSHSession({
    session: sshSession,
    setMessages,
    setIsLoading: setIsExternalLoading,
    setToolUseConfirmQueue,
    tools: combinedInitialTools,
  });

  // 使用当前活跃的远程模式
  const activeRemote = sshRemote.isRemoteMode ? sshRemote : directConnect.isRemoteMode ? directConnect : remoteSession;

  const [pastedContents, setPastedContents] = useState<Record<number, PastedContent>>({});
  const [submitCount, setSubmitCount] = useState(0);
  // 使用 ref 而非 state，避免每次 streaming text_delta 都触发 React 重新渲染。
  // spinner 通过其动画定时器读取此值。
  const responseLengthRef = useRef(0);
  // 仅 ant 使用的 spinner API 性能指标 ref（TTFT/OTPS）。
  // 在一个 turn 中累积所有 API 请求的指标用于 P50 聚合。
  const apiMetricsRef = useRef<
    Array<{
      ttftMs: number;
      firstTokenTime: number;
      lastTokenTime: number;
      responseLengthBaseline: number;
      // 跟踪最后一次内容添加时的 responseLengthRef。
      // 由 streaming delta 和 subagent 消息内容同时更新。
      // lastTokenTime 也在同一时间更新，所以 OTPS 分母正确包含
      // subagent 处理时间。
      endResponseLength: number;
    }>
  >([]);
  const setResponseLength = useCallback((f: (prev: number) => number) => {
    const prev = responseLengthRef.current;
    responseLengthRef.current = f(prev);
    // 当内容添加（非 compaction 重置）时，更新最新 metrics 条目，
    // 使 OTPS 反映所有内容生成活动。在此更新 lastTokenTime 确保分母
    // 同时包含 streaming 时间和 subagent 执行时间，防止膨胀。
    if (responseLengthRef.current > prev) {
      const entries = apiMetricsRef.current;
      if (entries.length > 0) {
        const lastEntry = entries.at(-1)!;
        lastEntry.lastTokenTime = Date.now();
        lastEntry.endResponseLength = responseLengthRef.current;
      }
    }
  }, []);

  // 流式文本显示：每个 delta 直接设置 state（Ink 的 16ms 渲染节流会批处理
  // 快速更新）。消息到达时清除（messages.ts），使 displayedMessages 从
  // deferredMessages 原子地切换到 messages。
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const reducedMotion = useAppState(s => s.settings.prefersReducedMotion) ?? false;
  const showStreamingText = !reducedMotion && !hasCursorUpViewportYankBug();
  const onStreamingText = useCallback(
    (f: (current: string | null) => string | null) => {
      if (!showStreamingText) return;
      setStreamingText(f);
    },
    [showStreamingText],
  );

  // 隐藏进行中的源码行，使文本按行流式而非按字符。lastIndexOf 在无换行时
  // 返回 -1，得到 '' → null。基于 showStreamingText 做门控，使在流中途切换
  // reducedMotion 能立即隐藏流式预览。
  const visibleStreamingText =
    streamingText && showStreamingText ? streamingText.substring(0, streamingText.lastIndexOf('\n') + 1) || null : null;

  const [lastQueryCompletionTime, setLastQueryCompletionTime] = useState(0);
  const [spinnerMessage, setSpinnerMessage] = useState<string | null>(null);
  const [spinnerColor, setSpinnerColor] = useState<keyof Theme | null>(null);
  const [spinnerShimmerColor, setSpinnerShimmerColor] = useState<keyof Theme | null>(null);
  const [isMessageSelectorVisible, setIsMessageSelectorVisible] = useState(false);
  const [messageSelectorPreselect, setMessageSelectorPreselect] = useState<UserMessage | undefined>(undefined);
  const [showCostDialog, setShowCostDialog] = useState(false);
  const [conversationId, setConversationId] = useState(randomUUID());

  // 空闲返回对话框：用户在长时间空闲后提交时显示
  const [idleReturnPending, setIdleReturnPending] = useState<{
    input: string;
    idleMinutes: number;
  } | null>(null);
  const skipIdleCheckRef = useRef(false);
  const lastQueryCompletionTimeRef = useRef(lastQueryCompletionTime);
  lastQueryCompletionTimeRef.current = lastQueryCompletionTime;

  // 聚合 tool 结果预算：每个会话的决策跟踪。
  // 当 GrowthBook flag 开启时，query.ts 强制执行预算；关闭（undefined）时，
  // 完全跳过强制执行。之后的陈旧条目
  // /clear、rewind 或 compact 之后是无害的（tool_use_ids 是 UUID，陈旧
  // 键永不会被查找）。内存受总替换数 × REPL 生命周期内约 2KB 预览限制 —
  // 可忽略。
  //
  // 通过 useState 初始化器惰性初始化 — useRef(expr) 会在每次渲染时求值 expr
  // （React 在第一次后忽略它，但计算仍会运行）。
  // 对于大型恢复会话，重构执行 O(messages × blocks)
  // 的工作；我们只需要做一次。
  const [contentReplacementStateRef] = useState(() => ({
    current: provisionContentReplacementState(initialMessages, initialContentReplacements),
  }));
  registerCompactCleanup(() => {
    contentReplacementStateRef.current = createContentReplacementState();
  });

  const [haveShownCostDialog, setHaveShownCostDialog] = useState(getGlobalConfig().hasAcknowledgedCostThreshold);
  const [vimMode, setVimMode] = useState<VimMode>('INSERT');
  const [showBashesDialog, setShowBashesDialog] = useState<string | boolean>(false);
  const [isSearchingHistory, setIsSearchingHistory] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  // showBashesDialog 是 REPL 级的，所以能在 PromptInput 卸载时保留。
  // 当 pill 对话框打开时 ultraplan 审批触发，PromptInput 会卸载
  // （focusedInputDialog → 'ultraplan-choice'）但此值保持 true；
  // 接受后，PromptInput 重新挂载到空的 "No tasks" 对话框
  //（已完成的 ultraplan 任务已被过滤掉）。在这里关闭。
  useEffect(() => {
    if (ultraplanPendingChoice && showBashesDialog) {
      setShowBashesDialog(false);
    }
  }, [ultraplanPendingChoice, showBashesDialog]);

  const isTerminalFocused = useTerminalFocus();
  const terminalFocusRef = useRef(isTerminalFocused);
  terminalFocusRef.current = isTerminalFocused;

  const [theme] = useTheme();

  // resetLoadingState 每个 turn 运行两次（onQueryImpl 尾部 + onQuery finally）。
  // 没有此守卫，两次调用都会挑选 tip → 两次 recordShownTip → 两次
  // saveGlobalConfig 连续写。在 onSubmit 提交时重置。
  const tipPickedThisTurnRef = React.useRef(false);
  const pickNewSpinnerTip = useCallback(() => {
    if (tipPickedThisTurnRef.current) return;
    tipPickedThisTurnRef.current = true;
    const newMessages = messagesRef.current.slice(bashToolsProcessedIdx.current);
    for (const tool of extractBashToolsFromMessages(newMessages)) {
      bashTools.current.add(tool);
    }
    bashToolsProcessedIdx.current = messagesRef.current.length;
    void getTipToShowOnSpinner({
      theme,
      readFileState: readFileState.current,
      bashTools: bashTools.current,
    }).then(async tip => {
      if (tip) {
        const content = await tip.content({ theme });
        setAppState(prev => ({
          ...prev,
          spinnerTip: content,
        }));
        recordShownTip(tip);
      } else {
        setAppState(prev => {
          if (prev.spinnerTip === undefined) return prev;
          return { ...prev, spinnerTip: undefined };
        });
      }
    });
  }, [setAppState, theme]);

  // 重置 UI loading 状态。不会调用 onTurnComplete — 那应该在 query turn
  // 实际完成时显式调用。
  const resetLoadingState = useCallback(() => {
    // isLoading 现在派生自 queryGuard — 无需 setter 调用。
    // queryGuard.end()（onQuery finally）或 cancelReservation()
    // （executeUserInput finally）在此运行时已将 guard 转为 idle。
    // 外部 loading（远程/后台化）由这些 hook 单独重置。
    setIsExternalLoading(false);
    setUserInputOnProcessing(undefined);
    responseLengthRef.current = 0;
    apiMetricsRef.current = [];
    setStreamingText(null);
    setStreamingToolUses([]);
    setSpinnerMessage(null);
    setSpinnerColor(null);
    setSpinnerShimmerColor(null);
    pickNewSpinnerTip();
    endInteractionSpan();
    // 推测式 bash 分类器检查仅对当前 turn 的命令有效 — 每个 turn 后
    // 清除以避免为未消费的检查（拒绝/中止路径）累积 Promise 链。
    clearSpeculativeChecks();
  }, [pickNewSpinnerTip]);

  // 会话后台化 — hook 在下面，在 getToolUseContext 之后

  const hasRunningTeammates = useMemo(
    () => getAllInProcessTeammateTasks(tasks).some(t => t.status === 'running'),
    [tasks],
  );

  // 所有 swarm teammate 完成后显示延迟的 turn 持续时间消息
  useEffect(() => {
    if (!hasRunningTeammates && swarmStartTimeRef.current !== null) {
      const totalMs = Date.now() - swarmStartTimeRef.current;
      const deferredBudget = swarmBudgetInfoRef.current;
      swarmStartTimeRef.current = null;
      swarmBudgetInfoRef.current = undefined;
      setMessages(prev => [
        ...prev,
        createTurnDurationMessage(
          totalMs,
          deferredBudget,
          // 只统计 recordTranscript 会持久化的内容 — 瞬态进度 tick 和
          // 非 ant 附件会被 isLoggableMessage 过滤，不会到达磁盘。使用原始
          // prev.length 会让 checkResumeConsistency 在每个运行进度发出工具
          // 的 turn 上报告虚假的 delta<0。
          count(prev, isLoggableMessage),
        ),
      ]);
    }
  }, [hasRunningTeammates, setMessages]);

  // 进入 auto 模式时显示自动权限警告
  //（通过 Shift+Tab 切换或启动时）。做防抖以避免
  // 用户快速切换模式时的闪烁。
  // 跨会话总共只显示 3 次。
  const safeYoloMessageShownRef = useRef(false);
  useEffect(() => {
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      if (toolPermissionContext.mode !== 'auto') {
        safeYoloMessageShownRef.current = false;
        return;
      }
      if (safeYoloMessageShownRef.current) return;
      const config = getGlobalConfig();
      const count = config.autoPermissionsNotificationCount ?? 0;
      if (count >= 3) return;
      const timer = setTimeout(
        (ref, setMessages) => {
          ref.current = true;
          saveGlobalConfig(prev => {
            const prevCount = prev.autoPermissionsNotificationCount ?? 0;
            if (prevCount >= 3) return prev;
            return {
              ...prev,
              autoPermissionsNotificationCount: prevCount + 1,
            };
          });
          setMessages(prev => [...prev, createSystemMessage(AUTO_MODE_DESCRIPTION, 'warning')]);
        },
        800,
        safeYoloMessageShownRef,
        setMessages,
      );
      return () => clearTimeout(timer);
    }
  }, [toolPermissionContext.mode, setMessages]);

  // 如果 worktree 创建慢且未配置 sparse-checkout，
  // 引导用户使用 settings.worktree.sparsePaths。
  const worktreeTipShownRef = useRef(false);
  useEffect(() => {
    if (worktreeTipShownRef.current) return;
    const wt = getCurrentWorktreeSession();
    if (!wt?.creationDurationMs || wt.usedSparsePaths) return;
    if (wt.creationDurationMs < 15_000) return;
    worktreeTipShownRef.current = true;
    const secs = Math.round(wt.creationDurationMs / 1000);
    setMessages(prev => [
      ...prev,
      createSystemMessage(
        `Worktree creation took ${secs}s. For large repos, set \`worktree.sparsePaths\` in .hclaude/settings.json to check out only the directories you need — e.g. \`{"worktree": {"sparsePaths": ["src", "packages/foo"]}}\`.`,
        'info',
      ),
    ]);
  }, [setMessages]);

  // 当唯一进行中的工具是 Sleep 时隐藏 spinner
  const onlySleepToolActive = useMemo(() => {
    const lastAssistant = messages.findLast(m => m.type === 'assistant');
    if (lastAssistant?.type !== 'assistant') return false;
    const content = lastAssistant.message?.content;
    const contentArray = Array.isArray(content) ? content : [];
    const inProgressToolUses = contentArray.filter(
      (b): b is ContentBlock & { type: 'tool_use'; id: string } =>
        b.type === 'tool_use' && inProgressToolUseIDs.has((b as { id: string }).id),
    );
    return (
      inProgressToolUses.length > 0 &&
      inProgressToolUses.every(b => b.type === 'tool_use' && b.name === SLEEP_TOOL_NAME)
    );
  }, [messages, inProgressToolUseIDs]);

  const {
    onBeforeQuery: mrOnBeforeQuery,
    onTurnComplete: mrOnTurnComplete,
    render: mrRender,
  } = useMoreRight({
    enabled: moreRightEnabled,
    setMessages,
    inputValue,
    setInputValue,
    setToolJSX,
  });

  const showSpinner =
    (!toolJSX || toolJSX.showSpinner === true) &&
    toolUseConfirmQueue.length === 0 &&
    promptQueue.length === 0 &&
    // 在输入处理、API 调用、teammate 运行期间或有待处理任务通知排队时显示 spinner
    // （防止连续通知之间 spinner 跳动）
    (isLoading ||
      userInputOnProcessing ||
      hasRunningTeammates ||
      // 任务通知排队等待处理时保持 spinner 可见。
      // 否则，连续通知之间 spinner 会短暂消失
      // （例如多个后台 agent 快速连续完成），因为处理每个通知之间
      // isLoading 短暂变为 false。
      getCommandQueueLength() > 0) &&
    // 等待 leader 审批权限请求时隐藏 spinner
    !pendingWorkerRequest &&
    !onlySleepToolActive &&
    // 流式文本可见时隐藏 spinner（文本本身就是反馈），
    // 但当 isBriefOnly 抑制流式文本显示时保留 spinner
    (!visibleStreamingText || isBriefOnly);

  // 检查当前是否有权限或提问 prompt 可见
  // 用于防止在 prompt 活跃时打开调查
  const hasActivePrompt =
    toolUseConfirmQueue.length > 0 ||
    promptQueue.length > 0 ||
    sandboxPermissionRequestQueue.length > 0 ||
    elicitation.queue.length > 0 ||
    workerSandboxPermissions.queue.length > 0;

  const feedbackSurveyOriginal = useFeedbackSurvey(messages, isLoading, submitCount, 'session', hasActivePrompt);

  const skillImprovementSurvey = useSkillImprovementSurvey(setMessages);

  const showIssueFlagBanner = useIssueFlagBanner(messages, submitCount);

  // 包装 feedback survey handler 以触发 auto-run /issue
  const feedbackSurvey = useMemo(
    () => ({
      ...feedbackSurveyOriginal,
      handleSelect: (selected: 'dismissed' | 'bad' | 'fine' | 'good') => {
        // 新的 survey 响应到来时重置 ref
        didAutoRunIssueRef.current = false;
        const showedTranscriptPrompt = feedbackSurveyOriginal.handleSelect(selected);
        // 如果未显示 transcript prompt，为 "bad" 自动运行 /issue
        if (selected === 'bad' && !showedTranscriptPrompt && shouldAutoRunIssue('feedback_survey_bad')) {
          setAutoRunIssueReason('feedback_survey_bad');
          didAutoRunIssueRef.current = true;
        }
      },
    }),
    [feedbackSurveyOriginal],
  );

  // Post-compact 调查：如果 feature gate 启用，在 compaction 后显示
  const postCompactSurvey = usePostCompactSurvey(messages, isLoading, hasActivePrompt, { enabled: !isRemoteSession });

  // Memory 调查：当 assistant 提到 memory 且本会话读取过 memory 文件时显示
  const memorySurvey = useMemorySurvey(messages, isLoading, hasActivePrompt, {
    enabled: !isRemoteSession,
  });

  // 挫败感检测：检测到挫败消息后显示 transcript 分享 prompt
  const frustrationDetection = useFrustrationDetection(
    messages,
    isLoading,
    hasActivePrompt,
    feedbackSurvey.state !== 'closed' || postCompactSurvey.state !== 'closed' || memorySurvey.state !== 'closed',
  );

  // 初始化 IDE 集成
  useIDEIntegration({
    autoConnectIdeFlag,
    ideToInstallExtension,
    setDynamicMcpConfig,
    setShowIdeOnboarding,
    setIDEInstallationState: setIDEInstallationStatus,
  });

  useFileHistorySnapshotInit(initialFileHistorySnapshots, fileHistory, fileHistoryState =>
    setAppState(prev => ({
      ...prev,
      fileHistory: fileHistoryState,
    })),
  );

  const resume = useCallback(
    async (sessionId: UUID, log: LogOption, entrypoint: ResumeEntrypoint) => {
      const resumeStart = performance.now();
      try {
        // 反序列化消息以正确清理会话
        // 这会过滤未解析的 tool uses 并在需要时添加合成 assistant 消息
        const messages = deserializeMessages(log.messages);

        // 将 coordinator/normal 模式匹配到恢复的会话
        if (feature('COORDINATOR_MODE')) {
          /* eslint-disable @typescript-eslint/no-require-imports */
          const coordinatorModule =
            require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js');
          /* eslint-enable @typescript-eslint/no-require-imports */
          const warning = coordinatorModule.matchSessionMode(log.mode);
          if (warning) {
            // 模式切换后重新派生 agent 定义，使内置 agent
            // 反映新的 coordinator/normal 模式
            /* eslint-disable @typescript-eslint/no-require-imports */
            const { getAgentDefinitionsWithOverrides, getActiveAgentsFromList } =
              require('@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js') as typeof import('@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js');
            /* eslint-enable @typescript-eslint/no-require-imports */
            getAgentDefinitionsWithOverrides.cache.clear?.();
            const freshAgentDefs = await getAgentDefinitionsWithOverrides(getOriginalCwd());

            setAppState(prev => ({
              ...prev,
              agentDefinitions: {
                ...freshAgentDefs,
                allAgents: freshAgentDefs.allAgents,
                activeAgents: getActiveAgentsFromList(freshAgentDefs.allAgents),
              },
            }));
            messages.push(createSystemMessage(warning, 'warning'));
          }
        }

        // 在启动恢复的会话之前为当前会话触发 SessionEnd hooks，
        // 与 conversation.ts 中 /clear 流程一致。
        const sessionEndTimeoutMs = getSessionEndHookTimeoutMs();
        await executeSessionEndHooks('resume', {
          getAppState: () => store.getState(),
          setAppState,
          signal: AbortSignal.timeout(sessionEndTimeoutMs),
          timeoutMs: sessionEndTimeoutMs,
        });

        // 为 resume 处理 session start hooks
        const hookMessages = await processSessionStartHooks('resume', {
          sessionId,
          agentType: mainThreadAgentDefinition?.agentType,
          model: mainLoopModel,
        });

        // 将 hook 消息追加到会话
        messages.push(...hookMessages);
        // 对于 fork，生成新的 plan slug 并复制 plan 内容，使原始和 fork
        // 会话不互相覆盖 plan 文件。
        // 对于常规 resume，复用原始会话的 plan slug。
        if (entrypoint === 'fork') {
          void copyPlanForFork(log, asSessionId(sessionId));
        } else {
          void copyPlanForResume(log, asSessionId(sessionId));
        }

        // 从恢复的会话中恢复文件历史和 attribution 状态
        restoreSessionStateFromLog(log, setAppState);
        if (log.fileHistorySnapshots) {
          void copyFileHistoryForResume(log);
        }

        // 从恢复的会话中恢复 agent 设置
        // 始终重置为新会话的值（或如果没有则清除），
        // 与下面的 standaloneAgentContext 模式一致
        const { agentDefinition: restoredAgent } = restoreAgentFromSession(
          log.agentSetting,
          initialMainThreadAgentDefinition,
          agentDefinitions,
        );
        setMainThreadAgentDefinition(restoredAgent);
        setAppState(prev => ({ ...prev, agent: restoredAgent?.agentType }));

        // 从恢复的会话中恢复独立 agent 上下文
        // 始终重置为新会话的值（或如果没有则清除）
        setAppState(prev => ({
          ...prev,
          standaloneAgentContext: computeStandaloneAgentContext(log.agentName, log.agentColor),
        }));
        void updateSessionName(log.agentName);

        // 从消息历史中恢复读取的文件状态
        restoreReadFileState(messages, log.projectPath ?? getOriginalCwd());

        // 清除任何活跃的 loading 状态（无 queryId，因为不在 query 中）
        resetLoadingState();
        setAbortController(null);

        setConversationId(sessionId);

        // 在保存当前会话之前获取目标会话的成本
        //（saveCurrentSessionCosts 会覆盖 config，所以需要先读取）
        const targetSessionCosts = getStoredSessionCosts(sessionId);

        // 切换前保存当前会话的成本，避免丢失累积成本
        saveCurrentSessionCosts();

        // 恢复目标会话前重置成本状态以获得干净起点
        resetCostState();

        // 切换会话（id + 项目目录原子操作）。fullPath 可能指向
        // 不同项目（跨 worktree、/branch）；null 从当前 originalCwd 派生。
        switchSession(asSessionId(sessionId), log.fullPath ? dirname(log.fullPath) : null);
        // 重命名 asciicast 录制以匹配恢复的 session ID
        const { renameRecordingForSession } = await import('../utils/asciicast.js');
        await renameRecordingForSession();
        await resetSessionFilePointer();

        // 先清除再恢复 session 元数据，使其在退出时通过
        // reAppendSessionMetadata 重新追加。必须先调用 clearSessionMetadata：
        // restoreSessionMetadata 只在真值时设置，所以不清除的话，
        // 没有 agent 名称的会话会继承上一个会话的缓存名称，
        // 并在第一条消息时写入错误的 transcript。
        clearSessionMetadata();
        restoreSessionMetadata(log);

        // 从恢复会话的 transcript 中水合 goal 状态
        if (feature('GOAL') && log.goal) {
          const { hydrateGoalFromTranscript } =
            require('../services/goal/goalStorage.js') as typeof import('../services/goal/goalStorage.js');
          const goalsMap = new Map<UUID, import('../types/logs.js').GoalState>();
          goalsMap.set(sessionId as UUID, log.goal);
          hydrateGoalFromTranscript(goalsMap, sessionId as UUID);
        }

        // 恢复的会话不应从会话中途的上下文重新命名
        //（与 useRef seed 同样的理由），且上一个会话的
        // Haiku 标题不应保留。
        haikuTitleAttemptedRef.current = true;
        setHaikuTitle(undefined);

        // 退出先前 /resume 进入的 worktree，然后 cd 到本会话所在的
        // worktree。不退出的话，从 worktree B 恢复到非 worktree C 会
        // 使 cwd/currentWorktreeSession 过期；B→C 恢复（C 也是 worktree）
        // 会完全失败
        //（getCurrentWorktreeSession 守卫会阻塞切换）。
        //
        // 对 /branch 跳过：forkLog 不携带 worktreeSession，所以这会
        // 把用户踢出他们仍在工作的 worktree。与 processResumedConversation
        // 的 adopt 使用相同的 fork 跳过 — fork 在 REPL 挂载时通过
        // recordTranscript 物化自己的文件。
        if (entrypoint !== 'fork') {
          exitRestoredWorktree();
          restoreWorktreeForResume(log.worktreeSession);
          adoptResumedSessionFile();
          void restoreRemoteAgentTasks({
            abortController: new AbortController(),
            getAppState: () => store.getState(),
            setAppState,
          });
        } else {
          // Fork：与 /clear（conversation.ts）相同的重新持久化。上面的清除
          // 已擦除 currentSessionWorktree，forkLog 不携带它，
          // 且进程仍在同一 worktree 中。
          const ws = getCurrentWorktreeSession();
          if (ws) saveWorktreeState(ws);
        }

        // 持久化当前模式，使未来恢复知道本会话是什么模式
        if (feature('COORDINATOR_MODE')) {
          /* eslint-disable @typescript-eslint/no-require-imports */
          const { saveMode } = require('../utils/sessionStorage.js');
          const { isCoordinatorMode } =
            require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js');
          /* eslint-enable @typescript-eslint/no-require-imports */
          saveMode(isCoordinatorMode() ? 'coordinator' : 'normal');
        }

        // 从我们之前读取的数据中恢复目标会话的成本
        if (targetSessionCosts) {
          setCostStateForRestore(targetSessionCosts);
        }

        // 为恢复的会话重构替换状态。在 setSessionId 之后运行，使恢复后
        // 任何新的替换都写入恢复会话的 tool-results 目录。基于 ref.current
        // 门控：初始挂载已读取 feature flag，所以这里不再读取
        // （会话中途的 flag 翻转在两个方向都保持不可观察）。
        //
        // 对会话内 /branch 跳过：现有 ref 已经正确
        //（branch 保留 tool_use_ids），所以无需重建。
        // createFork() 确实将 content-replacement 条目写入 fork 的 JSONL，
        // 使用 fork 的 sessionId，所以 `claude -r {forkId}` 也可用。
        if (contentReplacementStateRef.current && entrypoint !== 'fork') {
          contentReplacementStateRef.current = reconstructContentReplacementState(
            messages,
            log.contentReplacements ?? [],
          );
        }

        // 将消息重置为提供的初始消息
        // 使用回调确保不依赖于陈旧 state
        setMessages(() => messages);

        // 清除任何活跃的 tool JSX
        setToolJSX(null);

        // 清除输入确保没有残留状态
        setInputValue('');

        logEvent('tengu_session_resumed', {
          entrypoint: entrypoint as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          success: true,
          resume_duration_ms: Math.round(performance.now() - resumeStart),
        });
      } catch (error) {
        logEvent('tengu_session_resumed', {
          entrypoint: entrypoint as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          success: false,
        });
        throw error;
      }
    },
    [resetLoadingState, setAppState],
  );

  // 惰性初始化：useRef(createX()) 会在每次渲染时调用 createX 并丢弃结果。
  // FileStateCache 内部的 LRUCache 构造昂贵（约 170ms），所以使用 useState
  // 的惰性初始化器只创建一次，然后将该稳定引用喂给 useRef。
  const [initialReadFileState] = useState(() => createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE));
  const readFileState = useRef(initialReadFileState);
  const bashTools = useRef(new Set<string>());
  const bashToolsProcessedIdx = useRef(0);
  // 会话级 skill 发现跟踪（供 tengu_skill_tool_invocation 的 was_discovered
  // 使用）。必须在一个会话内的 getToolUseContext 重建之间持久化：
  // turn-0 的发现在 onQuery 构建自己的上下文之前通过 processUserInput 写入，
  // 而 turn N 上的发现必须仍能归因到 turn N+k 上的 SkillTool 调用。
  // 在 clearConversation 中清除。
  const discoveredSkillNamesRef = useRef(new Set<string>());
  // nested_memory CLAUDE.md 附件的会话级去重。
  // readFileState 是 100 条目的 LRU；一旦它驱逐一个 CLAUDE.md 路径，
  // 下一个发现周期会重新注入它。在 clearConversation 中清除。
  const loadedNestedMemoryPathsRef = useRef(new Set<string>());

  // 从消息中恢复读取文件状态的辅助函数（用于 resume 流程）
  // 这让 Claude 能编辑之前会话中读取过的文件
  const restoreReadFileState = useCallback((messages: MessageType[], cwd: string) => {
    const extracted = extractReadFilesFromMessages(messages, cwd, READ_FILE_STATE_CACHE_SIZE);
    readFileState.current = mergeFileStateCaches(readFileState.current, extracted);
    for (const tool of extractBashToolsFromMessages(messages)) {
      bashTools.current.add(tool);
    }
  }, []);

  // 挂载时从 initialMessages 提取读取文件状态
  // 这处理 CLI flag resume（--resume-session）和 ResumeConversation 屏幕，
  // 其中消息作为 props 传递而非通过 resume 回调
  useEffect(() => {
    if (initialMessages && initialMessages.length > 0) {
      restoreReadFileState(initialMessages, getOriginalCwd());
      void restoreRemoteAgentTasks({
        abortController: new AbortController(),
        getAppState: () => store.getState(),
        setAppState,
      });
    }
    // 仅挂载时运行 - initialMessages 在组件生命周期内不应改变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { status: apiKeyStatus, reverify } = useApiKeyVerification();

  // Auto-run /issue 状态
  const [autoRunIssueReason, setAutoRunIssueReason] = useState<AutoRunIssueReason | null>(null);
  // 跟踪本 survey 周期是否已触发 autoRunIssue 的 ref，
  // 使我们能在 autoRunIssueReason 被清除后仍抑制 [1] 后续 prompt。
  const didAutoRunIssueRef = useRef(false);

  // 退出反馈流程的状态
  const [exitFlow, setExitFlow] = useState<React.ReactNode>(null);
  const [isExiting, setIsExiting] = useState(false);

  // 计算是否应显示成本对话框
  const showingCostDialog = !isLoading && showCostDialog;

  // 确定哪个对话框应获得焦点（如果有）
  // 权限和交互式对话框即使设置了 toolJSX 也能显示，
  // 只要 shouldContinueAnimation 为 true。这防止 agent 在等待用户交互时
  // 设置后台提示导致的死锁。
  function getFocusedInputDialog():
    | 'message-selector'
    | 'sandbox-permission'
    | 'tool-permission'
    | 'prompt'
    | 'worker-sandbox-permission'
    | 'elicitation'
    | 'cost'
    | 'idle-return'
    | 'init-onboarding'
    | 'ide-onboarding'
    | 'model-switch'
    | 'undercover-callout'
    | 'effort-callout'
    | 'remote-callout'
    | 'lsp-recommendation'
    | 'plugin-hint'
    | 'search-extra-tools-hint'
    | 'desktop-upsell'
    | 'ultraplan-choice'
    | 'ultraplan-launch'
    | undefined {
    // 退出状态始终优先
    if (isExiting || exitFlow) return undefined;

    // 高优先级对话框（无论是否在输入都始终显示）
    if (isMessageSelectorVisible) return 'message-selector';

    // 用户正在积极输入时抑制中断对话框
    if (isPromptInputActive) return undefined;

    if (sandboxPermissionRequestQueue[0]) return 'sandbox-permission';

    // 权限/交互式对话框（除非被 toolJSX 阻塞，否则显示）
    const allowDialogsWithAnimation = !toolJSX || toolJSX.shouldContinueAnimation;

    if (allowDialogsWithAnimation && toolUseConfirmQueue[0]) return 'tool-permission';
    if (allowDialogsWithAnimation && promptQueue[0]) return 'prompt';
    // 来自 swarm worker 的 worker sandbox 权限提示（网络访问）
    if (allowDialogsWithAnimation && workerSandboxPermissions.queue[0]) return 'worker-sandbox-permission';
    if (allowDialogsWithAnimation && elicitation.queue[0]) return 'elicitation';
    if (allowDialogsWithAnimation && showingCostDialog) return 'cost';
    if (allowDialogsWithAnimation && idleReturnPending) return 'idle-return';

    if (feature('ULTRAPLAN') && allowDialogsWithAnimation && !isLoading && ultraplanPendingChoice)
      return 'ultraplan-choice';

    if (feature('ULTRAPLAN') && allowDialogsWithAnimation && !isLoading && ultraplanLaunchPending)
      return 'ultraplan-launch';

    // 引导对话框（特殊条件）
    if (allowDialogsWithAnimation && showIdeOnboarding) return 'ide-onboarding';

    // 模型切换提示（仅 ant，从外部构建中消除）
    if (process.env.USER_TYPE === 'ant' && allowDialogsWithAnimation && showModelSwitchCallout) return 'model-switch';

    // Undercover 自动启用说明（仅 ant，从外部构建中消除）
    if (process.env.USER_TYPE === 'ant' && allowDialogsWithAnimation && showUndercoverCallout)
      return 'undercover-callout';

    // Effort 提示（对 Opus 4.6 用户在 effort 启用时显示一次）
    if (allowDialogsWithAnimation && showEffortCallout) return 'effort-callout';

    // 远程提示（首次启用 bridge 前显示一次）
    if (allowDialogsWithAnimation && showRemoteCallout) return 'remote-callout';

    // LSP 插件推荐（最低优先级 - 非阻塞建议）
    if (allowDialogsWithAnimation && lspRecommendation) return 'lsp-recommendation';

    // 来自 CLI/SDK stderr 的插件提示（与 LSP 推荐相同的优先级带）
    if (allowDialogsWithAnimation && hintRecommendation) return 'plugin-hint';

    // 工具搜索提示（发现与当前 query 相关的工具）
    if (allowDialogsWithAnimation && searchExtraToolsHint.visible) return 'search-extra-tools-hint';

    // 桌面应用推广（最多 3 次启动，最低优先级）
    if (allowDialogsWithAnimation && showDesktopUpsellStartup) return 'desktop-upsell';

    return undefined;
  }

  const focusedInputDialog = getFocusedInputDialog();

  // 存在权限提示但因用户正在输入而被隐藏时为 true
  const hasSuppressedDialogs =
    isPromptInputActive &&
    (sandboxPermissionRequestQueue[0] ||
      toolUseConfirmQueue[0] ||
      promptQueue[0] ||
      workerSandboxPermissions.queue[0] ||
      elicitation.queue[0] ||
      showingCostDialog);

  // 保持 ref 同步，使定时器回调能读取当前值
  focusedInputDialogRef.current = focusedInputDialog;

  // focusedInputDialog 变化时立即捕获暂停/恢复
  // 这确保即使在高系统负载下也能精确计时，而不是依赖 100ms 轮询间隔
  // 来检测状态变化
  useEffect(() => {
    if (!isLoading) return;

    const isPaused = focusedInputDialog === 'tool-permission';
    const now = Date.now();

    if (isPaused && pauseStartTimeRef.current === null) {
      // 刚进入暂停状态 - 记录精确时刻
      pauseStartTimeRef.current = now;
    } else if (!isPaused && pauseStartTimeRef.current !== null) {
      // 刚退出暂停状态 - 立即累积暂停时间
      totalPausedMsRef.current += now - pauseStartTimeRef.current;
      pauseStartTimeRef.current = null;
    }
  }, [focusedInputDialog, isLoading]);

  // 权限覆盖层出现或消失时重新固定滚动到底部。覆盖层现在在同一个
  // ScrollBox 内的消息下方渲染（无重新挂载），所以我们需要显式
  // scrollToBottom 用于：
  //  - 出现：用户可能已向上滚动（sticky 失效）— 对话框是阻塞的，必须可见
  //  - 消失：用户可能在覆盖层期间向上滚动读取上下文，onScroll 被抑制
  //    所以 pill 状态已过期
  // 使用 useLayoutEffect 使重新固定在 Ink 帧渲染前提交 —
  // 无错误滚动位置的 1 帧闪烁。
  const prevDialogRef = useRef(focusedInputDialog);
  useLayoutEffect(() => {
    const was = prevDialogRef.current === 'tool-permission';
    const now = focusedInputDialog === 'tool-permission';
    if (was !== now) repinScroll();
    prevDialogRef.current = focusedInputDialog;
  }, [focusedInputDialog, repinScroll]);

  function onCancel() {
    if (focusedInputDialog === 'elicitation') {
      // Elicitation 对话框处理自己的 Escape，关闭它不应影响任何 loading 状态。
      return;
    }

    // 宽限期守卫：如果 local-jsx 面板（如 /workflows）刚通过 ESC 关闭，
    // 吞掉该 ESC 及紧随其后的 ESC，使其不会落入
    // abortController.abort('user-cancel') 并杀死正在运行的 Workflow 工具。
    // 单次 ESC 关闭面板
    //（由面板自身的 useInput → onDone → setToolJSX 处理）；
    // chat:cancel keybinding 的 isActive 门控在面板挂载时保护它，
    // 但不在卸载后的 React 提交窗口中。
    // 重置时间戳，使后续的有意 ESC 仍能正常取消。
    if (
      localJSXClosedAtRef.current !== 0 &&
      Date.now() - localJSXClosedAtRef.current < LOCAL_JSX_CLOSE_CANCEL_GRACE_MS
    ) {
      localJSXClosedAtRef.current = 0;
      logForDebugging('[onCancel] suppressed: local-jsx panel just dismissed');
      return;
    }
    localJSXClosedAtRef.current = 0;

    logForDebugging(`[onCancel] focusedInputDialog=${focusedInputDialog} streamMode=${streamMode}`);
    logForDebugging(
      `[Hapii] REPL.onCancel 开始取消 isLoading=${queryGuard.getSnapshot()} msgs=${messagesRef.current.length} streamingText=${streamingText?.length ?? 0}`,
      { level: 'info' },
    );

    // 暂停 proactive 模式，使用户重新获得控制权。
    // 它会在用户提交下一个输入时恢复（见 onSubmit）。
    if (feature('PROACTIVE') || feature('KAIROS')) {
      proactiveModule?.pauseProactive();
    }

    // 活跃 goal turn 期间按 Ctrl+C 会暂停 goal，使 continuation 循环停止。
    // 用户可以 /goal resume 稍后继续。
    // 守卫：仅当 query 实际进行中时才暂停。onCancel() 也会从
    // restore/edit 流程（idle）调用，那时暂停会错误地停止下一个 continuation。
    if (feature('GOAL') && queryGuard.getSnapshot()) {
      const { getGoal, pauseGoal } =
        require('../services/goal/goalState.js') as typeof import('../services/goal/goalState.js');
      const { persistCurrentGoal } =
        require('../services/goal/goalStorage.js') as typeof import('../services/goal/goalStorage.js');
      const currentGoal = getGoal();
      if (currentGoal?.status === 'active') {
        pauseGoal();
        persistCurrentGoal();
      }
    }
    setWasAborted(true);

    queryGuard.forceEnd();
    skipIdleCheckRef.current = false;

    // 保留部分流式文本，使用户能读取按 Esc 前生成的内容。在
    // resetLoadingState 清除 streamingText 之前推送，且在 query.ts yield
    // 异步中断标记之前，给出最终顺序 [user, partial-assistant,
    // [Request interrupted by user]]。
    if (streamingText?.trim()) {
      setMessages(prev => [...prev, createAssistantMessage({ content: streamingText })]);
    }

    resetLoadingState();

    // 清除任何活跃的 token budget，使兜底不在陈旧 budget 上触发
    // （如果 query 生成器尚未退出）。
    if (feature('TOKEN_BUDGET')) {
      snapshotOutputTokensForTurn(null);
    }

    if (focusedInputDialog === 'tool-permission') {
      // Tool use confirm 自行处理 abort 信号
      toolUseConfirmQueue[0]?.onAbort();
      setToolUseConfirmQueue([]);
    } else if (focusedInputDialog === 'prompt') {
      // 拒绝所有挂起 prompt 并清空队列
      for (const item of promptQueue) {
        item.reject(new Error('Prompt cancelled by user'));
      }
      setPromptQueue([]);
      abortController?.abort('user-cancel');
    } else if (activeRemote.isRemoteMode) {
      // 远程模式：向 CCR 发送中断信号
      activeRemote.cancelRequest();
    } else {
      abortController?.abort('user-cancel');
    }

    // 清除 controller，使后续 Escape 按键不会看到陈旧的中止信号。
    // 否则，canCancelRunningTask 为 false（signal 已定义但 .aborted === true），
    // 如果没有其他激活条件成立，isActive 变为 false — 使 Escape keybinding 失效。
    setAbortController(null);

    // forceEnd() 跳过 finally 路径 — 直接触发（aborted=true）。
    void mrOnTurnComplete(messagesRef.current, true);
  }

  // 取消权限请求时处理排队命令的函数
  const handleQueuedCommandOnCancel = useCallback(() => {
    const result = popAllEditable(inputValue, 0);
    if (!result) return;
    setInputValue(result.text);
    setInputMode('prompt');

    // 将排队命令中的图像恢复到 pastedContents
    if (result.images.length > 0) {
      setPastedContents(prev => {
        const newContents = { ...prev };
        for (const image of result.images) {
          newContents[image.id] = image;
        }
        return newContents;
      });
    }
  }, [setInputValue, setInputMode, inputValue, setPastedContents]);

  // CancelRequestHandler props - 渲染在 KeybindingSetup 内部
  const cancelRequestProps = {
    setToolUseConfirmQueue,
    onCancel,
    onAgentsKilled: () => setMessages(prev => [...prev, createAgentsKilledMessage()]),
    isMessageSelectorVisible: isMessageSelectorVisible || !!showBashesDialog,
    screen,
    abortSignal: abortController?.signal,
    popCommandFromQueue: handleQueuedCommandOnCancel,
    vimMode,
    isLocalJSXCommand: toolJSX?.isLocalJSXCommand,
    isSearchingHistory,
    isHelpOpen,
    inputMode,
    inputValue,
    streamMode,
  };

  useEffect(() => {
    const totalCost = getTotalCost();
    if (totalCost >= 5 /* $5 */ && !showCostDialog && !haveShownCostDialog) {
      logEvent('tengu_cost_threshold_reached', {});
      // 即使对话框不会渲染（无控制台计费访问）也标记为已显示。
      // 否则此 effect 会在会话剩余时间内每次消息变化时重新触发 —
      // 已观察到 20 万+ 虚假事件。
      setHaveShownCostDialog(true);
      if (hasConsoleBillingAccess()) {
        setShowCostDialog(true);
      }
    }
  }, [messages, showCostDialog, haveShownCostDialog]);

  const sandboxAskCallback: SandboxAskCallback = useCallback(
    async (hostPattern: NetworkHostPattern) => {
      // 如果作为 swarm worker 运行，通过 mailbox 将请求转发给 leader
      if (isAgentSwarmsEnabled() && isSwarmWorker()) {
        const requestId = generateSandboxRequestId();

        // 通过 mailbox 向 leader 发送请求
        const sent = await sendSandboxPermissionRequestViaMailbox(hostPattern.host, requestId);

        return new Promise(resolveShouldAllowHost => {
          if (!sent) {
            // 如果无法通过 mailbox 发送，回退到本地处理
            setSandboxPermissionRequestQueue(prev => [
              ...prev,
              {
                hostPattern,
                resolvePromise: resolveShouldAllowHost,
              },
            ]);
            return;
          }

          // 注册 leader 响应时的回调
          registerSandboxPermissionCallback({
            requestId,
            host: hostPattern.host,
            resolve: resolveShouldAllowHost,
          });

          // 更新 AppState 以显示待处理指示器
          setAppState(prev => ({
            ...prev,
            pendingSandboxRequest: {
              requestId,
              host: hostPattern.host,
            },
          }));
        });
      }

      // 非 worker 的正常流程：显示本地 UI，如果已连接则可选地与
      // REPL bridge（Remote Control）竞速。
      return new Promise(resolveShouldAllowHost => {
        let resolved = false;
        function resolveOnce(allow: boolean): void {
          if (resolved) return;
          resolved = true;
          resolveShouldAllowHost(allow);
        }

        // 将本地 sandbox 权限对话框入队
        setSandboxPermissionRequestQueue(prev => [
          ...prev,
          {
            hostPattern,
            resolvePromise: resolveOnce,
          },
        ]);

        // REPL bridge 连接时，也将 sandbox 权限请求作为
        // can_use_tool control_request 转发，使远程用户（例如在 claude.ai 上）
        // 也能审批。
        if (feature('BRIDGE_MODE')) {
          const bridgeCallbacks = store.getState().replBridgePermissionCallbacks;
          if (bridgeCallbacks) {
            const bridgeRequestId = randomUUID();
            bridgeCallbacks.sendRequest(
              bridgeRequestId,
              SANDBOX_NETWORK_ACCESS_TOOL_NAME,
              { host: hostPattern.host },
              randomUUID(),
              `Allow network connection to ${hostPattern.host}?`,
            );

            const unsubscribe = bridgeCallbacks.onResponse(bridgeRequestId, response => {
              unsubscribe();
              const allow = response.behavior === 'allow';
              // 解决同一 host 的所有挂起请求，不仅仅是这个 —
              // 与本地对话框处理器模式一致。
              setSandboxPermissionRequestQueue(queue => {
                queue
                  .filter(item => item.hostPattern.host === hostPattern.host)
                  .forEach(item => item.resolvePromise(allow));
                return queue.filter(item => item.hostPattern.host !== hostPattern.host);
              });
              // 清理此 host 的所有兄弟 bridge 订阅
              //（其他并发的同 host 请求）再删除。
              const siblingCleanups = sandboxBridgeCleanupRef.current.get(hostPattern.host);
              if (siblingCleanups) {
                for (const fn of siblingCleanups) {
                  fn();
                }
                sandboxBridgeCleanupRef.current.delete(hostPattern.host);
              }
            });

            // 注册清理，使本地对话框处理器能在本地用户先响应时
            // 取消远程 prompt 并取消订阅。
            const cleanup = () => {
              unsubscribe();
              bridgeCallbacks.cancelRequest(bridgeRequestId);
            };
            const existing = sandboxBridgeCleanupRef.current.get(hostPattern.host) ?? [];
            existing.push(cleanup);
            sandboxBridgeCleanupRef.current.set(hostPattern.host, existing);
          }
        }
      });
    },
    [setAppState, store],
  );

  // #34044：若用户显式设置了 sandbox.enabled=true 但依赖缺失，
  // isSandboxingEnabled() 静默返回 false。挂载时呈现一次原因，让用户知道
  // 他们的安全配置未被强制执行。完整原因进入调试日志；通知指向 /sandbox
  // 查看详情。addNotification 稳定（useCallback），所以 effect 只触发一次。
  useEffect(() => {
    const reason = SandboxManager.getSandboxUnavailableReason();
    if (!reason) return;
    if (SandboxManager.isSandboxRequired()) {
      process.stderr.write(
        `\nError: sandbox required but unavailable: ${reason}\n` +
          `  sandbox.failIfUnavailable is set — refusing to start without a working sandbox.\n\n`,
      );
      gracefulShutdownSync(1, 'other');
      return;
    }
    logForDebugging(`sandbox disabled: ${reason}`, { level: 'warn' });
    addNotification({
      key: 'sandbox-unavailable',
      jsx: (
        <>
          <Text color="warning">sandbox disabled</Text>
          <Text dimColor> · /sandbox</Text>
        </>
      ),
      priority: 'medium',
    });
  }, [addNotification]);

  if (SandboxManager.isSandboxingEnabled()) {
    // 如果启用 sandboxing（setting.sandbox 已定义，初始化 manager）
    SandboxManager.initialize(sandboxAskCallback).catch(err => {
      // 初始化/验证失败 - 显示错误并退出
      process.stderr.write(`\n❌ Sandbox Error: ${errorMessage(err)}\n`);
      gracefulShutdownSync(1, 'other');
    });
  }

  const setToolPermissionContext = useCallback(
    (context: ToolPermissionContext, options?: { preserveMode?: boolean }) => {
      setAppState(prev => ({
        ...prev,
        toolPermissionContext: {
          ...context,
          // 仅在显式请求时保留 coordinator 的模式。
          // Worker 的 getAppState() 返回已转换的上下文，模式为
          // 'acceptEdits'，不能通过 permission-rule 更新泄露到 coordinator
          // 的实际状态 — 这些调用点传递 { preserveMode: true }。
          // 用户发起的模式更改（例如选择 "allow all edits"）绝不能被覆盖。
          mode: options?.preserveMode ? prev.toolPermissionContext.mode : context.mode,
        },
      }));

      // 权限上下文变化时，重新检查所有排队项
      // 这处理了这种情况：通过 "don't ask again" 批准 item1 时
      // 应自动批准现在匹配更新规则的其他排队项
      setImmediate(setToolUseConfirmQueue => {
        // 使用 setToolUseConfirmQueue 回调获取当前队列状态，
        // 而非在闭包中捕获，以避免陈旧闭包问题
        setToolUseConfirmQueue(currentQueue => {
          currentQueue.forEach(item => {
            void item.recheckPermission();
          });
          return currentQueue;
        });
      }, setToolUseConfirmQueue);
    },
    [setAppState, setToolUseConfirmQueue],
  );

  // 为进程内 teammate 注册 leader 的 setToolPermissionContext
  useEffect(() => {
    registerLeaderSetToolPermissionContext(setToolPermissionContext);
    return () => unregisterLeaderSetToolPermissionContext();
  }, [setToolPermissionContext]);

  const canUseTool = useCanUseTool(setToolUseConfirmQueue, setToolPermissionContext);

  const requestPrompt = useCallback(
    (title: string, toolInputSummary?: string | null) =>
      (request: PromptRequest): Promise<PromptResponse> =>
        new Promise<PromptResponse>((resolve, reject) => {
          setPromptQueue(prev => [...prev, { request, title, toolInputSummary, resolve, reject }]);
        }),
    [],
  );

  const getToolUseContext = useCallback(
    (
      messages: MessageType[],
      _newMessages: MessageType[],
      abortController: AbortController,
      mainLoopModel: string,
    ): ProcessUserInputContext => {
      // 从 store 读取可变值的新鲜值，而非闭包捕获 useAppState() 快照。
      // 目前值相同（闭包由 turn 之间的渲染刷新）；为未来的 headless 对话
      // 循环将新鲜度与 React 渲染周期解耦。与 refreshTools() 使用的模式相同。
      const s = store.getState();

      // 从 store.getState() 新鲜计算 tools，而非闭包捕获的 `tools`。
      // useManageMCPConnections 在服务器连接时异步填充 appState.mcp —
      // store 可能有比渲染时闭包捕获更新的 MCP 状态。同时也作为
      // refreshTools() 用于 query 中途的 tool 列表更新。
      const computeTools = () => {
        const state = store.getState();
        const assembled = assembleToolPool(state.toolPermissionContext, state.mcp.tools);
        const merged = mergeAndFilterTools(combinedInitialTools, assembled, state.toolPermissionContext.mode);
        if (!mainThreadAgentDefinition) return merged;
        return resolveAgentTools(mainThreadAgentDefinition, merged, false, true).resolvedTools;
      };

      return {
        abortController,
        options: {
          commands,
          tools: computeTools(),
          debug,
          verbose: s.verbose,
          mainLoopModel,
          thinkingConfig: s.thinkingEnabled !== false ? thinkingConfig : { type: 'disabled' },
          // 从 store 新鲜合并，而非闭包捕获 useMergedClients 的 memoized 输出。
          // initialMcpClients 是 prop（会话常量）。
          mcpClients: mergeClients(initialMcpClients, s.mcp.clients),
          mcpResources: s.mcp.resources,
          ideInstallationStatus: ideInstallationStatus,
          isNonInteractiveSession: false,
          dynamicMcpConfig,
          theme,
          agentDefinitions: allowedAgentTypes ? { ...s.agentDefinitions, allowedAgentTypes } : s.agentDefinitions,
          customSystemPrompt,
          appendSystemPrompt,
          refreshTools: computeTools,
        },
        getAppState: () => store.getState(),
        setAppState,
        messages,
        setMessages,
        updateFileHistoryState(updater: (prev: FileHistoryState) => FileHistoryState) {
          // 性能：updater 返回相同引用时跳过 setState
          // （例如 fileHistoryTrackEdit 在文件已被跟踪时返回 `state`）。
          // 否则每次 no-op 调用都会通知所有 store 监听器。
          setAppState(prev => {
            const updated = updater(prev.fileHistory);
            if (updated === prev.fileHistory) return prev;
            return { ...prev, fileHistory: updated };
          });
        },
        updateAttributionState(updater: (prev: AttributionState) => AttributionState) {
          setAppState(prev => {
            const updated = updater(prev.attribution);
            if (updated === prev.attribution) return prev;
            return { ...prev, attribution: updated };
          });
        },
        openMessageSelector: () => {
          if (!disabled) {
            setIsMessageSelectorVisible(true);
          }
        },
        onChangeAPIKey: reverify,
        readFileState: readFileState.current,
        setToolJSX,
        addNotification,
        appendSystemMessage: msg => setMessages(prev => [...prev, msg]),
        sendOSNotification: opts => {
          void sendNotification(opts, terminal);
        },
        onChangeDynamicMcpConfig,
        onInstallIDEExtension: setIDEToInstallExtension,
        nestedMemoryAttachmentTriggers: new Set<string>(),
        loadedNestedMemoryPaths: loadedNestedMemoryPathsRef.current,
        dynamicSkillDirTriggers: new Set<string>(),
        discoveredSkillNames: discoveredSkillNamesRef.current,
        setResponseLength,
        pushApiMetricsEntry:
          process.env.USER_TYPE === 'ant'
            ? (ttftMs: number) => {
                const now = Date.now();
                const baseline = responseLengthRef.current;
                apiMetricsRef.current.push({
                  ttftMs,
                  firstTokenTime: now,
                  lastTokenTime: now,
                  responseLengthBaseline: baseline,
                  endResponseLength: baseline,
                });
              }
            : undefined,
        setStreamMode,
        onCompactProgress: event => {
          switch (event.type) {
            case 'hooks_start':
              setSpinnerColor('claudeBlue_FOR_SYSTEM_SPINNER');
              setSpinnerShimmerColor('claudeBlueShimmer_FOR_SYSTEM_SPINNER');
              setSpinnerMessage(
                event.hookType === 'pre_compact'
                  ? 'Running PreCompact hooks\u2026'
                  : event.hookType === 'post_compact'
                    ? 'Running PostCompact hooks\u2026'
                    : 'Running SessionStart hooks\u2026',
              );
              break;
            case 'compact_start':
              setSpinnerMessage('Compacting conversation');
              break;
            case 'compact_end':
              setSpinnerMessage(null);
              setSpinnerColor(null);
              setSpinnerShimmerColor(null);
              break;
          }
        },
        setInProgressToolUseIDs,
        setHasInterruptibleToolInProgress: (v: boolean) => {
          hasInterruptibleToolInProgressRef.current = v;
        },
        resume,
        setConversationId,
        requestPrompt: feature('HOOK_PROMPTS') ? requestPrompt : undefined,
        contentReplacementState: contentReplacementStateRef.current,
      };
    },
    [
      commands,
      combinedInitialTools,
      mainThreadAgentDefinition,
      debug,
      initialMcpClients,
      ideInstallationStatus,
      dynamicMcpConfig,
      theme,
      allowedAgentTypes,
      store,
      setAppState,
      reverify,
      addNotification,
      setMessages,
      onChangeDynamicMcpConfig,
      resume,
      requestPrompt,
      disabled,
      customSystemPrompt,
      appendSystemPrompt,
      setConversationId,
    ],
  );

  // 会话后台化（Ctrl+B 切换前台/后台）
  const handleBackgroundQuery = useCallback(() => {
    // 停止前台 query，使后台 query 接管
    abortController?.abort('background');
    logForDebugging(
      `[Hapii] REPL.handleBackgroundQuery 开始: abortController=${abortController ? '存在' : 'null'} appendSystemPrompt=${appendSystemPrompt ? `已设置(${appendSystemPrompt.length}字符)` : '未设置'} customSystemPrompt=${customSystemPrompt ? `已设置(${customSystemPrompt.length}字符)` : '未设置'} agentDef=${mainThreadAgentDefinition ? (mainThreadAgentDefinition.agentType ?? 'custom') : '无'} model=${mainLoopModel}`,
      { level: 'info' },
    );
    // 中止 subagent 可能产生 task-completed 通知。
    // 清除任务通知，使队列处理器不会立即启动新的前台 query；
    // 将它们转发到后台会话。
    const removedNotifications = removeByFilter(cmd => cmd.mode === 'task-notification');

    void (async () => {
      const toolUseContext = getToolUseContext(messagesRef.current, [], new AbortController(), mainLoopModel);

      const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
        getSystemPrompt(
          toolUseContext.options.tools,
          mainLoopModel,
          Array.from(toolPermissionContext.additionalWorkingDirectories.keys()),
          toolUseContext.options.mcpClients,
        ),
        getUserContext(),
        getSystemContext(),
      ]);

      const systemPrompt = buildEffectiveSystemPrompt({
        mainThreadAgentDefinition,
        toolUseContext,
        customSystemPrompt,
        defaultSystemPrompt,
        appendSystemPrompt,
      });
      toolUseContext.renderedSystemPrompt = systemPrompt;
      logForDebugging(
        `[Hapii] REPL.handleBackgroundQuery 系统提示构建完成: len=${systemPrompt?.length ?? 0} tools=${toolUseContext.options.tools?.length ?? 0} mcpClients=${toolUseContext.options.mcpClients?.length ?? 0}`,
        { level: 'info' },
      );

      const notificationAttachments = await getQueuedCommandAttachments(removedNotifications).catch(() => []);
      const notificationMessages = notificationAttachments.map(createAttachmentMessage);

      // 去重：如果 query 循环已在我们从队列移除之前将通知 yield 到
      // messagesRef，跳过重复项。
      // 我们使用 prompt 文本去重，因为 task-notification QueuedCommands
      // 不设置 source_uuid（enqueuePendingNotification 调用方不传 uuid），
      // 所以它总是 undefined。
      const existingPrompts = new Set<string>();
      for (const m of messagesRef.current) {
        if (
          m.type === 'attachment' &&
          m.attachment!.type === 'queued_command' &&
          m.attachment!.commandMode === 'task-notification' &&
          typeof m.attachment!.prompt === 'string'
        ) {
          existingPrompts.add(m.attachment!.prompt);
        }
      }
      const uniqueNotifications = notificationMessages.filter(
        m =>
          m.attachment.type === 'queued_command' &&
          (typeof m.attachment.prompt !== 'string' || !existingPrompts.has(m.attachment.prompt)),
      );

      startBackgroundSession({
        messages: [...messagesRef.current, ...uniqueNotifications],
        queryParams: {
          systemPrompt,
          userContext,
          systemContext,
          canUseTool,
          toolUseContext,
          querySource: getQuerySourceForREPL(),
        },
        description: terminalTitle,
        setAppState,
        agentDefinition: mainThreadAgentDefinition,
      });
    })();
  }, [
    abortController,
    mainLoopModel,
    toolPermissionContext,
    mainThreadAgentDefinition,
    getToolUseContext,
    customSystemPrompt,
    appendSystemPrompt,
    canUseTool,
    setAppState,
  ]);

  const { handleBackgroundSession } = useSessionBackgrounding({
    setMessages,
    setIsLoading: setIsExternalLoading,
    resetLoadingState,
    setAbortController,
    onBackgroundQuery: handleBackgroundQuery,
  });

  const onQueryEvent = useCallback(
    (event: Parameters<typeof handleMessageFromStream>[0]) => {
      // ── 学习日志：进入时打印 event 全量内容 ──────────────────────────────
      // stream_event 每个 token 都触发，只打印 subtype + delta 摘要（避免刷屏）。
      // 其他事件打印完整 JSON（字符串字段 >300 字符时截断），换行格式化便于阅读。
      // 通过 --verbose 或 CLAUDE_CODE_DEBUG=1 开启 verbose 日志可见。
      if (event.type === 'stream_event') {
        const se = event as {
          type: string;
          event?: {
            type?: string;
            delta?: { type?: string; text?: string; thinking?: string };
          };
        };
        const subtype = se.event?.type ?? '?';
        const delta = se.event?.delta;
        const snippet = delta?.text
          ? `text="${delta.text.slice(0, 40)}${delta.text.length > 40 ? '…' : ''}"`
          : delta?.thinking
            ? `thinking="${delta.thinking.slice(0, 40)}${delta.thinking.length > 40 ? '…' : ''}"`
            : (delta?.type ?? '');
        logForDebugging(`[Hapii] REPL.onQueryEvent [stream_event/${subtype}] ${snippet}`, { level: 'verbose' });
      } else {
        // 非流式事件：完整序列化，字符串字段超长时截断
        const serialized = (() => {
          try {
            return JSON.stringify(
              event,
              (_, val) =>
                typeof val === 'string' && val.length > 300 ? `${val.slice(0, 300)}…[+${val.length - 300}字符]` : val,
              2,
            );
          } catch {
            return `[序列化失败] type=${event.type}`;
          }
        })();
        logForDebugging(`[Hapii] REPL.onQueryEvent [${event.type}]:\n${serialized}`, { level: 'verbose' });
      }
      // ────────────────────────────────────────────────────────────────────
      handleMessageFromStream(
        event,
        newMessage => {
          if (isCompactBoundaryMessage(newMessage)) {
            // 全屏：保留 pre-compact 消息用于回滚。query.ts 在边界处切片
            // 用于 API 调用，Messages.tsx 在全屏中跳过边界过滤，
            // useLogMessages 将此视为增量追加（第一个 uuid 不变）。
            // 限制为一个 compact-interval 的回滚量 —
            // normalizeMessages/applyGrouping 每次渲染为 O(n)，所以丢弃
            // 前一个边界之前的所有内容，使 n 在多日会话中保持有界。
            if (isFullscreenEnvEnabled()) {
              setMessages(old => {
                const postBoundary = getMessagesAfterCompactBoundary(old, {
                  includeSnipped: true,
                });
                // 硬上限：全屏回滚中最多保留 500 条消息，防止多日会话中内存无限增长。
                // normalizeMessages/applyGrouping 为 O(n)，Ink fiber 树每条
                // 消息约 250KB RSS。没有此上限，多次 compaction 后回滚可达
                // 数千条消息（已观察到 1.3 万+，堆 1GB+）。
                const MAX_FULLSCREEN_SCROLLBACK = 500;
                const kept =
                  postBoundary.length > MAX_FULLSCREEN_SCROLLBACK
                    ? postBoundary.slice(-MAX_FULLSCREEN_SCROLLBACK)
                    : postBoundary;
                return [...kept, newMessage];
              });
            } else {
              setMessages(() => [newMessage]);
            }
            // 提升 conversationId，使 Messages.tsx 行 key 变化，
            // 陈旧的 memoized 行以 compact 后的内容重新挂载。
            setConversationId(randomUUID());
            // Compaction 成功 — 清除 context-blocked 标志，使 tick 恢复
            if (feature('PROACTIVE') || feature('KAIROS')) {
              proactiveModule?.setContextBlocked(false);
            }
          } else if (
            newMessage.type === 'progress' &&
            isEphemeralToolProgress((newMessage as unknown as { data?: { type?: string } }).data?.type)
          ) {
            // 替换同一 tool 调用的前一个瞬态进度 tick，而非追加。
            // Sleep/Bash 每秒发出一个 tick，只有最后一个被渲染；追加会使
            // messages 数组膨胀（已观察到 1.3 万+）和 transcript（120MB 的
            // sleep_progress 行）。useLogMessages 跟踪长度，所以等长替换
            // 也跳过 transcript 写入。
            // agent_progress / hook_progress / skill_progress 不是瞬态的
            // — 每个都携带 UI 需要的独特状态（例如 subagent 工具历史）。
            // 替换它们会使 AgentTool UI 卡在
            // "Initializing…"，因为它渲染完整的进度轨迹。
            setMessages(oldMessages => {
              const newData = newMessage.data as Record<string, unknown>;
              // 向后扫描查找匹配 parentToolUseID 和类型的最后一个瞬态进度。
              // 之前只检查最后一条消息，所以交错的非瞬态消息导致重复进度条目
              // 累积（在 sleep 密集会话中观察到 1.3 万+ 条目）。
              for (let i = oldMessages.length - 1; i >= 0; i--) {
                const m = oldMessages[i]!;
                if (m.type !== 'progress') break;
                const mData = m.data as Record<string, unknown> | undefined;
                if (m.parentToolUseID === newMessage.parentToolUseID && mData?.type === newData.type) {
                  const copy = oldMessages.slice();
                  copy[i] = newMessage;
                  return copy;
                }
              }
              return [...oldMessages, newMessage];
            });
          } else {
            setMessages(oldMessages => [...oldMessages, newMessage]);
          }
          // API 错误时阻塞 tick，防止 tick → error → tick 失控循环
          // （例如认证失败、速率限制、阻塞限制）。
          // 在 compact 边界（上面）或成功响应（下面）时清除。
          if (feature('PROACTIVE') || feature('KAIROS')) {
            if (newMessage.type === 'assistant' && 'isApiErrorMessage' in newMessage && newMessage.isApiErrorMessage) {
              proactiveModule?.setContextBlocked(true);
            } else if (newMessage.type === 'assistant') {
              proactiveModule?.setContextBlocked(false);
            }
          }
          // 当 turn 因连接问题失败时自动暂停活跃的 /goal。
          // 网络失败后立即继续通常会浪费 turn 而无进展，
          // 并可能快速触及 max-turn 守卫。
          if (
            feature('GOAL') &&
            newMessage.type === 'assistant' &&
            'isApiErrorMessage' in newMessage &&
            newMessage.isApiErrorMessage
          ) {
            const assistantText =
              getContentText((newMessage.message?.content ?? '') as string | ContentBlockParam[]) ?? '';
            const lowerText = assistantText.toLowerCase();
            const isConnectivityFailure =
              lowerText.includes('connection error') ||
              lowerText.includes('fetch failed') ||
              lowerText.includes('network error') ||
              lowerText.includes('enotfound') ||
              lowerText.includes('econnreset') ||
              lowerText.includes('etimedout');

            if (isConnectivityFailure) {
              const { getGoal, pauseGoal } =
                require('../services/goal/goalState.js') as typeof import('../services/goal/goalState.js');
              const { persistCurrentGoal } =
                require('../services/goal/goalStorage.js') as typeof import('../services/goal/goalStorage.js');
              const currentGoal = getGoal();
              if (currentGoal?.status === 'active') {
                pauseGoal();
                persistCurrentGoal();
                addNotification({
                  key: 'goal-auto-paused-connectivity-error',
                  text: 'Detected connection error. Active goal was auto-paused. Run /goal resume after network recovers.',
                  priority: 'immediate',
                });
              }
            }
          }
          // slave 模式时将 assistant 响应中继到 master。
          if (feature('UDS_INBOX') && newMessage.type === 'assistant') {
            // 从内容块提取文本（API 格式）
            const msg = newMessage.message as any;
            const contentBlocks = msg?.content ?? (newMessage as any).content ?? [];
            const textParts: string[] = [];
            if (Array.isArray(contentBlocks)) {
              for (const block of contentBlocks) {
                if (typeof block === 'string') {
                  textParts.push(block);
                } else if (block?.type === 'text' && block.text) {
                  textParts.push(block.text);
                }
              }
            } else if (typeof contentBlocks === 'string') {
              textParts.push(contentBlocks);
            }
            const text = textParts.join('\n').trim();
            if ('isApiErrorMessage' in newMessage && newMessage.isApiErrorMessage) {
              pipeReturnHadErrorRef.current = true;
              relayPipeMessage({
                type: 'error',
                data: text || 'Slave request failed',
              });
            } else if (text) {
              relayPipeMessage({ type: 'stream', data: text });
            }
          }
        },
        newContent => {
          // setResponseLength 处理同时更新 responseLengthRef（用于 spinner
          // 动画）和 apiMetricsRef（endResponseLength/lastTokenTime 用于 OTPS）。
          // 此处无需单独的 metrics 更新。
          setResponseLength(length => length + newContent.length);
        },
        setStreamMode,
        setStreamingToolUses,
        tombstonedMessage => {
          setMessages(oldMessages => oldMessages.filter(m => m !== tombstonedMessage));
          void removeTranscriptMessage(tombstonedMessage.uuid);
        },
        setStreamingThinking,
        metrics => {
          const now = Date.now();
          const baseline = responseLengthRef.current;
          apiMetricsRef.current.push({
            ...metrics,
            firstTokenTime: now,
            lastTokenTime: now,
            responseLengthBaseline: baseline,
            endResponseLength: baseline,
          });
        },
        onStreamingText,
      );
    },
    [setMessages, setResponseLength, setStreamMode, setStreamingToolUses, setStreamingThinking, onStreamingText],
  );

  const onQueryImpl = useCallback(
    async (
      messagesIncludingNewMessages: MessageType[],
      newMessages: MessageType[],
      abortController: AbortController,
      shouldQuery: boolean,
      additionalAllowedTools: string[],
      mainLoopModelParam: string,
      effort?: EffortValue,
    ) => {
      logForDebugging(
        `[REPL] onQueryImpl 开始, shouldQuery=${shouldQuery}, 新消息数=${newMessages.length}, model=${mainLoopModelParam}`,
        { level: 'info' },
      );
      logForDebugging(
        `[REPL] onQueryImpl feature flags: PROACTIVE=${feature('PROACTIVE') ? 'on' : 'off'} KAIROS=${feature('KAIROS') ? 'on' : 'off'} TRANSCRIPT_CLASSIFIER=${feature('TRANSCRIPT_CLASSIFIER') ? 'on' : 'off'} BUDDY=${feature('BUDDY') ? 'on' : 'off'} COORDINATOR_MODE=${feature('COORDINATOR_MODE') ? 'on' : 'off'}`,
        { level: 'info' },
      );
      logForDebugging(
        `[REPL] onQueryImpl system prompt params: appendSystemPrompt=${appendSystemPrompt ? `已设置(${appendSystemPrompt.length}字符)` : '未设置'} customSystemPrompt=${customSystemPrompt ? `已设置(${customSystemPrompt.length}字符)` : '未设置'} agentDef=${mainThreadAgentDefinition ? (mainThreadAgentDefinition.agentType ?? 'custom') : '无'}`,
        { level: 'info' },
      );
      // 为新 prompt 准备 IDE 集成。从 store 新鲜读取 mcpClients —
      // useManageMCPConnections 可能在捕获此闭包的渲染之后填充了它
      // （与 computeTools 相同模式）。
      if (shouldQuery) {
        const freshClients = mergeClients(initialMcpClients, store.getState().mcp.clients);
        void diagnosticTracker.handleQueryStart(freshClients);
        const ideClient = getConnectedIdeClient(freshClients);
        if (ideClient) {
          void closeOpenDiffs(ideClient);
        }
      }

      // 当任何用户消息发送给 Claude 时标记引导完成
      void maybeMarkProjectOnboardingComplete();

      // 从第一条真实用户消息提取 session 标题。通过 ref 一次性触发
      // （曾是 tengu_birch_mist 实验：仅首条消息以节省 Haiku 调用）。
      // 该 ref 替代了旧的 `messages.length <= 1` 检查，该检查被
      // SessionStart hook 消息（通过 useDeferredHookMessages 前置）和
      // 附件消息（由 processTextPrompt 追加）破坏 — 两者都在第一个 turn
      // 就把长度推过 1，所以标题静默回退到 "Claude Code" 默认值。
      if (!titleDisabled && !sessionTitle && !agentTitle && !haikuTitleAttemptedRef.current) {
        // titleDisabled 用户设置了环境变量 process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1，表示完全不想让 Claude Code 修改终端标题栏   ---------- 场景：运维人员在脚本里跑 Claude Code，不希望终端 tab 标题被改。
        // sessionTitle 用户主动用 --name "我的项目" 参数启动了 Claude Code，或者之前用过 /rename 命令给 session 起了名字，这个名字被持久化到 session 存储里了。 ---------- 场景：claude --name "重构任务" 启动 → sessionTitle = "重构任务" → 不再自动生成标题，尊重用户自定义。
        // agentTitle 这个 REPL 实例是以某个特定 Agent 身份运行的（比如 Plan、Explore、code-reviewer 等）。mainThreadAgentDefinition 是从 props 传入的，agent 有自己的 agentType 名称。 ------------- 场景：你调用 /plan 技能，它会在内部启动一个 REPL，agentTitle = "Plan"，终端标题直接显示 agent 名，不需要再基于对话内容生成标题。
        // haikuTitleAttempted 已经尝试过/是恢复的会话       防重复/防中途重命名

        const firstUserMessage = newMessages.find(m => m.type === 'user' && !m.isMeta);
        const text =
          firstUserMessage?.type === 'user'
            ? getContentText(firstUserMessage.message!.content as string | ContentBlockParam[])
            : null;
        // 跳过合成面包屑 — slash 命令输出、prompt-skill 展开
        // （/commit → <command-message>）、本地命令头
        // （/help → <command-name>）、bash 模式（!cmd → <bash-input>）。
        // 这些都不是用户的主题；等待真实散文。
        if (
          text &&
          !text.startsWith(`<${LOCAL_COMMAND_STDOUT_TAG}>`) &&
          !text.startsWith(`<${COMMAND_MESSAGE_TAG}>`) &&
          !text.startsWith(`<${COMMAND_NAME_TAG}>`) &&
          !text.startsWith(`<${BASH_INPUT_TAG}>`)
        ) {
          haikuTitleAttemptedRef.current = true;
          void generateSessionTitle(text, new AbortController().signal).then(
            title => {
              if (title) setHaikuTitle(title);
              else haikuTitleAttemptedRef.current = false;
            },
            () => {
              haikuTitleAttemptedRef.current = false;
            },
          );
        }
      }

      // 将 slash 命令作用域的 allowedTools（来自 skill frontmatter）应用到 store，每个 turn 一次。这也覆盖重置：下一个非 skill turn 传递 []
      // 并清除它。必须在 !shouldQuery 门控之前运行：fork 命令 （executeForkedSlashCommand）返回 shouldQuery=false，而
      // forkedAgent.ts 中的 createGetAppStateWithAllowedTools 读取此字段，所以陈旧的 skill 工具否则会泄露到 fork agent 权限中。
      // 之前此写入隐藏在 getToolUseContext 的 getAppState 内部（约 85 次调用/turn）；在此提升使 getAppState 成为纯读取，并阻止
      // 瞬态上下文（权限对话框、BackgroundTasksDialog）在 turn 中途意外清除它。
      store.setState(prev => {
        const cur = prev.toolPermissionContext.alwaysAllowRules.command;
        if (
          cur === additionalAllowedTools ||
          (cur?.length === additionalAllowedTools.length && cur.every((v, i) => v === additionalAllowedTools[i]))
        ) {
          return prev;
        }
        return {
          ...prev,
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            alwaysAllowRules: {
              ...prev.toolPermissionContext.alwaysAllowRules,
              command: additionalAllowedTools,
            },
          },
        };
      });

      // 如果用户输入是 bash 命令或无效 slash 命令，
      // 则最后一条消息是 assistant 消息。
      if (!shouldQuery) {
        // 手动 /compact 直接设置 messages（shouldQuery=false），绕过
        // handleMessageFromStream。如果存在 compact 边界则清除
        // context-blocked，使 proactive tick 在 compaction 后恢复。
        if (newMessages.some(isCompactBoundaryMessage)) {
          // 提升 conversationId，使 Messages.tsx 行 key 变化，
          // 陈旧的 memoized 行以 compact 后的内容重新挂载。
          setConversationId(randomUUID());
          if (feature('PROACTIVE') || feature('KAIROS')) {
            proactiveModule?.setContextBlocked(false);
          }
        }
        resetLoadingState();
        setAbortController(null);
        return;
      }

      const toolUseContext = getToolUseContext(
        messagesIncludingNewMessages,
        newMessages,
        abortController,
        mainLoopModelParam,
      );
      // getToolUseContext 从 store.getState() 新鲜读取 tools/mcpClients
      // （通过 computeTools/mergeClients）。使用这些而非闭包捕获的
      // `tools`/`mcpClients` — useManageMCPConnections 可能在捕获此闭包的
      // 渲染和现在之间刷新了新的 MCP 状态。通过 processInitialMessage 的
      // turn 1 是主要受益者。
      const { tools: freshTools, mcpClients: freshMcpClients } = toolUseContext.options;

      // 将 skill 的 effort 覆盖仅限定于本 turn 的上下文 —
      // 包装 getAppState 使覆盖不进入全局 store，使后台 agent 和 UI
      // 订阅者（Spinner、LogoV2）永远看不到它。
      if (effort !== undefined) {
        const previousGetAppState = toolUseContext.getAppState;
        toolUseContext.getAppState = () => ({
          ...previousGetAppState(),
          effortValue: effort,
        });
      }

      queryCheckpoint('query_context_loading_start');
      const [, , defaultSystemPrompt, baseUserContext, systemContext] = await Promise.all([
        // 重要：在上方 setMessages() 之后执行，避免 UI 抖动
        undefined,
        // Fast-mode 断路器检查
        feature('TRANSCRIPT_CLASSIFIER')
          ? checkAndDisableAutoModeIfNeeded(toolPermissionContext, setAppState, store.getState().fastMode)
          : undefined,
        getSystemPrompt(
          freshTools,
          mainLoopModelParam,
          Array.from(toolPermissionContext.additionalWorkingDirectories.keys()),
          freshMcpClients,
        ),
        getUserContext(),
        getSystemContext(),
      ]);
      const userContext = {
        ...baseUserContext,
        ...getCoordinatorUserContext(freshMcpClients, isScratchpadEnabled() ? getScratchpadDir() : undefined),
        ...((feature('PROACTIVE') || feature('KAIROS')) &&
        proactiveModule?.isProactiveActive() &&
        !terminalFocusRef.current
          ? {
              terminalFocus: '终端未聚焦 - 用户未主动查看。',
            }
          : {}),
      };
      if (feature('PROACTIVE') || feature('KAIROS')) {
        logForDebugging(
          `[REPL] onQueryImpl proactive/kairos: proactiveModule=${proactiveModule ? 'loaded' : 'null'} isProactiveActive=${proactiveModule?.isProactiveActive() ?? false} terminalFocused=${terminalFocusRef.current} terminalFocusInjected=${'terminalFocus' in userContext}`,
          { level: 'info' },
        );
      }
      logForDebugging(`[REPL] onQueryImpl userContext keys=[${Object.keys(userContext).join(', ')}]`, {
        level: 'info',
      });
      queryCheckpoint('query_context_loading_end');

      const systemPrompt = buildEffectiveSystemPrompt({
        mainThreadAgentDefinition,
        toolUseContext,
        customSystemPrompt,
        defaultSystemPrompt,
        appendSystemPrompt,
      });
      logForDebugging(
        `[Hapii] REPL.onQueryImpl 系统提示已构建 tools=${freshTools.length} mcpClients=${freshMcpClients.length} sysPromptLen=${systemPrompt?.length ?? 0}`,
        { level: 'info' },
      );
      toolUseContext.renderedSystemPrompt = systemPrompt;

      queryCheckpoint('query_query_start');
      resetTurnHookDuration();
      resetTurnToolDuration();
      resetTurnClassifierDuration();

      logForDebugging(`[REPL] 开始执行 query() 循环, 消息数=${messagesIncludingNewMessages.length}`, { level: 'info' });
      for await (const event of query({
        messages: messagesIncludingNewMessages,
        systemPrompt,
        userContext,
        systemContext,
        canUseTool,
        toolUseContext,
        querySource: getQuerySourceForREPL(),
      })) {
        onQueryEvent(event); //stream_request_start
      }

      logForDebugging(`[REPL] query() 循环完成`, { level: 'info' });

      if (feature('BUDDY') && typeof (globalThis as Record<string, unknown>).fireCompanionObserver === 'function') {
        const _fireCompanionObserver = (globalThis as Record<string, unknown>).fireCompanionObserver as (
          msgs: unknown,
          cb: (r: unknown) => void,
        ) => void;
        void _fireCompanionObserver(messagesRef.current, reaction =>
          setAppState(prev =>
            prev.companionReaction === (reaction as typeof prev.companionReaction)
              ? prev
              : { ...prev, companionReaction: reaction as typeof prev.companionReaction },
          ),
        );
      }

      queryCheckpoint('query_end');

      if (feature('UDS_INBOX')) {
        if (abortController.signal.aborted) {
          pipeReturnHadErrorRef.current = true;
          relayPipeMessage({
            type: 'error',
            data: 'Slave request was interrupted before completion.',
          });
        }
      }

      // 在 resetLoadingState 清除 ref 之前捕获仅 ant 的 API metrics。
      // 对于多请求 turn（tool use 循环），跨所有请求计算 P50。
      if (process.env.USER_TYPE === 'ant' && apiMetricsRef.current.length > 0) {
        const entries = apiMetricsRef.current;

        const ttfts = entries.map(e => e.ttftMs);
        // 仅使用活跃 streaming 时间和仅 streaming 内容计算每请求 OTPS。
        // endResponseLength 仅跟踪 streaming delta 添加的内容，排除
        // subagent/compaction 膨胀。
        const otpsValues = entries.map(e => {
          const delta = Math.round((e.endResponseLength - e.responseLengthBaseline) / 4);
          const samplingMs = e.lastTokenTime - e.firstTokenTime;
          return samplingMs > 0 ? Math.round(delta / (samplingMs / 1000)) : 0;
        });

        const isMultiRequest = entries.length > 1;
        const hookMs = getTurnHookDurationMs();
        const hookCount = getTurnHookCount();
        const toolMs = getTurnToolDurationMs();
        const toolCount = getTurnToolCount();
        const classifierMs = getTurnClassifierDurationMs();
        const classifierCount = getTurnClassifierCount();
        const turnMs = Date.now() - loadingStartTimeRef.current;
        setMessages(prev => [
          ...prev,
          createApiMetricsMessage({
            ttftMs: isMultiRequest ? median(ttfts) : ttfts[0]!,
            otps: isMultiRequest ? median(otpsValues) : otpsValues[0]!,
            isP50: isMultiRequest,
            hookDurationMs: hookMs > 0 ? hookMs : undefined,
            hookCount: hookCount > 0 ? hookCount : undefined,
            turnDurationMs: turnMs > 0 ? turnMs : undefined,
            toolDurationMs: toolMs > 0 ? toolMs : undefined,
            toolCount: toolCount > 0 ? toolCount : undefined,
            classifierDurationMs: classifierMs > 0 ? classifierMs : undefined,
            classifierCount: classifierCount > 0 ? classifierCount : undefined,
            configWriteCount: getGlobalConfigWriteCount(),
          }),
        ]);
      }

      resetLoadingState();

      // 如果启用则记录 query 性能分析报告
      logQueryProfileReport();

      // 标记 query turn 已成功完成
      await onTurnComplete?.(messagesRef.current);
    },
    [
      initialMcpClients,
      resetLoadingState,
      getToolUseContext,
      toolPermissionContext,
      setAppState,
      customSystemPrompt,
      onTurnComplete,
      appendSystemPrompt,
      canUseTool,
      mainThreadAgentDefinition,
      onQueryEvent,
      sessionTitle,
      titleDisabled,
    ],
  );

  const onQuery = useCallback(
    async (
      newMessages: MessageType[],
      abortController: AbortController,
      shouldQuery: boolean,
      additionalAllowedTools: string[],
      mainLoopModelParam: string,
      onBeforeQueryCallback?: (input: string, newMessages: MessageType[]) => Promise<boolean>,
      input?: string,
      effort?: EffortValue,
    ): Promise<boolean> => {
      logForDebugging(
        `[Hapii] REPL.onQuery 入口 newMsgs=${newMessages.length} shouldQuery=${shouldQuery} model=${mainLoopModelParam} effort=${effort ?? 'default'} allowedTools=${additionalAllowedTools.length}`,
        { level: 'info' },
      );
      // 如果是 teammate，在开始 turn 时标记为活跃
      if (isAgentSwarmsEnabled()) {
        const teamName = getTeamName();
        const agentName = getAgentName();
        if (teamName && agentName) {
          // Fire-and-forget —— turn 立即开始，写入在后台进行
          void setMemberActive(teamName, agentName, true);
        }
      }

      // 通过状态机做并发守卫。tryStart() 原子地检查并从 idle 转为 running，
      // 返回 generation 号。
      // 如果已在运行则返回 null — 无单独的 check-then-set。
      const thisGeneration = queryGuard.tryStart();
      if (thisGeneration === null) {
        logForDebugging('[Hapii] REPL.onQuery queryGuard.tryStart 失败，并发查询被拒绝，消息入队', { level: 'warn' });
        logEvent('tengu_concurrent_onquery_detected', {});

        // 提取并将用户消息文本入队，跳过 meta 消息
        // （例如展开的 skill 内容、tick prompt），这些不应作为用户可见文本重放。
        newMessages
          .filter((m): m is UserMessage => m.type === 'user' && !m.isMeta)
          .map(_ => getContentText(_.message.content as string | ContentBlockParam[]))
          .filter(_ => _ !== null)
          .forEach((msg, i) => {
            enqueue({ value: msg, mode: 'prompt' });
            if (i === 0) {
              logEvent('tengu_concurrent_onquery_enqueued', {});
            }
          });
        return false;
      }

      logForDebugging(`[Hapii] REPL.onQuery queryGuard generation=${thisGeneration} 查询启动`, { level: 'info' });

      try {
        pipeReturnHadErrorRef.current = false;
        setWasAborted(false);
        // isLoading 派生自 queryGuard — 上面的 tryStart() 已将
        // dispatching 转为 running，所以此处无需 setter 调用。
        resetTimingRefs();
        setMessages(oldMessages => [...oldMessages, ...newMessages]);
        responseLengthRef.current = 0;
        if (feature('TOKEN_BUDGET')) {
          const parsedBudget = input ? parseTokenBudget(input) : null;
          snapshotOutputTokensForTurn(parsedBudget ?? getCurrentTurnTokenBudget());
        }
        apiMetricsRef.current = [];
        setStreamingToolUses([]);
        setStreamingText(null);

        // messagesRef 由上面的 setMessages 包装器同步更新，
        // 所以它已包含本 try 块顶部追加的 newMessages。无需重构，
        // 无需等待 React 调度器（之前每个 prompt 消耗 20-56ms；
        // 56ms 的情况是 await 期间捕获的 GC 暂停）。
        const latestMessages = messagesRef.current;

        if (input) {
          await mrOnBeforeQuery(input, latestMessages, newMessages.length);
        }

        // 将完整会话历史传递给回调
        if (onBeforeQueryCallback && input) {
          const shouldProceed = await onBeforeQueryCallback(input, latestMessages);
          if (!shouldProceed) {
            return true;
          }
        }

        try {
          await onQueryImpl(
            latestMessages,
            newMessages,
            abortController,
            shouldQuery,
            additionalAllowedTools,
            mainLoopModelParam,
            effort,
          );
        } catch (error) {
          logForDebugging(
            `[Hapii] REPL.onQuery onQueryImpl 抛出错误: ${error instanceof Error ? error.message : String(error)}`,
            { level: 'error' },
          );
          if (feature('UDS_INBOX')) {
            pipeReturnHadErrorRef.current = true;
            relayPipeMessage({
              type: 'error',
              data: error instanceof Error ? error.message : String(error),
            });
          }
          throw error;
        }
      } finally {
        logForDebugging(
          `[Hapii] REPL.onQuery finally 块执行 aborted=${abortController.signal.aborted} msgs=${messagesRef.current.length}`,
          { level: 'info' },
        );
        // queryGuard.end() 原子地检查 generation 并将 running 转为 idle。
        // 如果更新的 query 拥有 guard 则返回 false
        //（cancel+resubmit 竞态中陈旧的 finally 作为 microtask 触发）。
        if (queryGuard.end(thisGeneration)) {
          setWasAborted(abortController.signal.aborted);
          setLastQueryCompletionTime(Date.now());
          skipIdleCheckRef.current = false;
          // 始终在 finally 中重置 loading 状态 - 确保即使 onQueryImpl 抛出
          // 也能清理。onTurnComplete 仅在 onQueryImpl 中成功完成时单独调用。
          resetLoadingState();

          await mrOnTurnComplete(messagesRef.current, abortController.signal.aborted);

          if (feature('UDS_INBOX') && !pipeReturnHadErrorRef.current) {
            relayPipeMessage({
              type: 'done',
              data: '',
            });
          }

          // 通知 bridge 客户端 turn 已完成，使移动应用能停止火花动画
          // 并显示 turn 后的 UI。
          sendBridgeResultRef.current();

          // turn 结束时自动隐藏 tungsten 面板内容（仅 ant），但保持
          // tungstenActiveSession 设置，使 pill 留在页脚，用户可重新打开面板。
          // 后台 tmux 任务（例如 /hunter）运行数分钟 — 擦除 session 会使 pill
          // 完全消失，迫使用户重新调用 Tmux 才能查看。中止时跳过，使面板保持
          // 打开以供检查（与下面的 turn 持续时间守卫一致）。
          if (process.env.USER_TYPE === 'ant' && !abortController.signal.aborted) {
            setAppState(prev => {
              if (prev.tungstenActiveSession === undefined) return prev;
              if (prev.tungstenPanelAutoHidden === true) return prev;
              return { ...prev, tungstenPanelAutoHidden: true };
            });
          }

          // 清除前捕获 budget 信息（仅 ant）
          let budgetInfo: { tokens: number; limit: number; nudges: number } | undefined;
          if (feature('TOKEN_BUDGET')) {
            if (
              getCurrentTurnTokenBudget() !== null &&
              getCurrentTurnTokenBudget()! > 0 &&
              !abortController.signal.aborted
            ) {
              budgetInfo = {
                tokens: getTurnOutputTokens(),
                limit: getCurrentTurnTokenBudget()!,
                nudges: getBudgetContinuationCount(),
              };
            }
            snapshotOutputTokensForTurn(null);
          }

          // 为超过 30 秒或带 budget 的 turn 添加 turn 持续时间消息
          // 用户中止或 loop 模式时跳过（tick 之间太吵）
          // 如果 swarm teammate 仍在运行则延迟（在它们完成时显示）
          const turnDurationMs = Date.now() - loadingStartTimeRef.current - totalPausedMsRef.current;
          if (
            (turnDurationMs > 30000 || budgetInfo !== undefined) &&
            !abortController.signal.aborted &&
            !proactiveActive
          ) {
            const hasRunningSwarmAgents = getAllInProcessTeammateTasks(store.getState().tasks).some(
              t => t.status === 'running',
            );
            if (hasRunningSwarmAgents) {
              // 仅在第一个延迟 turn 记录开始时间
              if (swarmStartTimeRef.current === null) {
                swarmStartTimeRef.current = loadingStartTimeRef.current;
              }
              // 始终更新 budget — 后续 turn 可能携带实际 budget
              if (budgetInfo) {
                swarmBudgetInfoRef.current = budgetInfo;
              }
            } else {
              setMessages(prev => [
                ...prev,
                createTurnDurationMessage(turnDurationMs, budgetInfo, count(prev, isLoggableMessage)),
              ]);
            }
          }
          // 清除 controller，使 CancelRequestHandler 的 canCancelRunningTask
          // 在 idle prompt 时读取 false。否则，陈旧的非中止 controller 使
          // ctrl+c 触发 onCancel()（中止无）而非传播到双击退出流程。
          setAbortController(null);
        }

        // 自动恢复：如果用户在任何有意义的响应到达前中断，回退会话并恢复其
        // prompt — 与打开消息选择器并选择最后一条消息相同。
        // 这运行在 queryGuard.end() 检查之外，因为 onCancel 调用 forceEnd()，
        // 它提升 generation 使上面的 end() 返回 false。
        // 守卫：reason === 'user-cancel'（onCancel/Esc；程序化 abort 使用
        // 'background'/'interrupt'，不得回退 — 注意无参数 abort() 将 reason
        // 设为 DOMException 而非 undefined），!isActive（无更新的 query 启动 —
        // cancel+resubmit 竞态），空输入（不覆盖 loading 期间输入的文本），
        // 无排队命令（用户在 A loading 时排队 B → 他们已继续，不恢复 A；
        // 也避免 removeLastFromHistory 移除 B 的条目而非 A 的），不查看
        // teammate（messagesRef 是主会话 — 旧的 Up 箭头快速恢复有此守卫，保留）。
        if (
          abortController.signal.reason === 'user-cancel' &&
          !queryGuard.isActive &&
          inputValueRef.current === '' &&
          getCommandQueueLength() === 0 &&
          !store.getState().viewingAgentTaskId
        ) {
          const msgs = messagesRef.current;
          const lastUserMsg = msgs.findLast(selectableUserMessagesFilter);
          if (lastUserMsg) {
            const idx = msgs.lastIndexOf(lastUserMsg);
            if (messagesAfterAreOnlySynthetic(msgs, idx)) {
              // 提交正在被撤销 — 也撤销其历史条目，
              // 否则 Up 箭头会两次显示恢复的文本。
              removeLastFromHistory();
              restoreMessageSyncRef.current(lastUserMsg);
            }
          }
        }
      }
      return true;
    },
    [onQueryImpl, setAppState, resetLoadingState, queryGuard, mrOnBeforeQuery, mrOnTurnComplete],
  );

  // 处理初始消息（来自 CLI 参数或带上下文清除的 plan 模式退出）
  // 此 effect 在 isLoading 变为 false 且有待处理消息时运行
  const initialMessageRef = useRef(false);
  useEffect(() => {
    const pending = initialMessage;
    if (!pending || isLoading || initialMessageRef.current) return;

    // 标记为处理中以防重入
    initialMessageRef.current = true;

    async function processInitialMessage(initialMsg: NonNullable<typeof pending>) {
      // 如果请求则清除上下文（plan 模式退出）
      if (initialMsg.clearContext) {
        // 清除上下文前保留 plan slug，使新会话能在 regenerateSessionId()
        // 后访问同一 plan 文件
        const oldPlanSlug = initialMsg.message.planContent ? getPlanSlug() : undefined;

        const { clearConversation } = await import('../commands/clear/conversation.js');
        await clearConversation({
          setMessages,
          readFileState: readFileState.current,
          discoveredSkillNames: discoveredSkillNamesRef.current,
          loadedNestedMemoryPaths: loadedNestedMemoryPathsRef.current,
          getAppState: () => store.getState(),
          setAppState,
          setConversationId,
        });
        haikuTitleAttemptedRef.current = false;
        setHaikuTitle(undefined);
        bashTools.current.clear();
        bashToolsProcessedIdx.current = 0;

        // 为新会话恢复 plan slug，使 getPlan() 找到文件
        if (oldPlanSlug) {
          setPlanSlug(getSessionId(), oldPlanSlug);
        }
      }

      // 原子地：清除初始消息，设置权限模式和规则
      setAppState(prev => {
        // 构建并应用权限更新（模式 + allowedPrompts 规则）
        let updatedToolPermissionContext = initialMsg.mode
          ? applyPermissionUpdates(
              prev.toolPermissionContext,
              buildPermissionUpdates(initialMsg.mode, initialMsg.allowedPrompts),
            )
          : prev.toolPermissionContext;
        // 对于 auto，覆盖模式（buildPermissionUpdates 通过
        // toExternalPermissionMode 将其映射为 'default'）并剥离危险规则
        if (feature('TRANSCRIPT_CLASSIFIER') && initialMsg.mode === 'auto') {
          updatedToolPermissionContext = stripDangerousPermissionsForAutoMode({
            ...updatedToolPermissionContext,
            mode: 'auto',
            prePlanMode: undefined,
          });
        }

        return {
          ...prev,
          initialMessage: null,
          toolPermissionContext: updatedToolPermissionContext,
        };
      });

      // 为代码回退创建文件历史快照
      if (fileHistoryEnabled()) {
        void fileHistoryMakeSnapshot((updater: (prev: FileHistoryState) => FileHistoryState) => {
          setAppState(prev => ({
            ...prev,
            fileHistory: updater(prev.fileHistory),
          }));
        }, initialMsg.message.uuid);
      }

      // 确保第一次 API 调用前 SessionStart hook 上下文可用。onSubmit 内部
      // 调用此函数，但下面的 onQuery 路径绕过 onSubmit — 在此提升使两条路径
      // 都能看到 hook 消息。
      await awaitPendingHooks();

      // 将所有初始 prompt 路由到 onSubmit，确保 UserPromptSubmit hooks 触发
      // TODO：一旦 onSubmit 支持 ContentBlockParam 数组（图像）作为输入，
      // 简化为始终通过 onSubmit 路由
      const content = initialMsg.message.message.content;

      // 将所有字符串内容通过 onSubmit 路由以确保 hooks 触发
      // 对于复杂内容（图像等），回退到直接 onQuery
      // Plan 消息绕过 onSubmit 以保留 planContent metadata 用于渲染
      if (typeof content === 'string' && !initialMsg.message.planContent) {
        // 通过 onSubmit 路由以正确处理，包括 UserPromptSubmit hooks
        void onSubmit(content, {
          setCursorOffset: () => {},
          clearBuffer: () => {},
          resetHistory: () => {},
        });
      } else {
        // Plan 消息或复杂内容（图像等） - 直接发送给模型
        // Plan 消息使用 onQuery 以保留 planContent metadata 用于渲染
        // TODO：一旦 onSubmit 支持 ContentBlockParam 数组，移除此分支
        const newAbortController = createAbortController();
        setAbortController(newAbortController);

        void onQuery(
          [initialMsg.message],
          newAbortController,
          true, // shouldQuery
          [], // additionalAllowedTools
          mainLoopModel,
        );
      }

      // 延迟后重置 ref 以允许新的初始消息
      setTimeout(
        ref => {
          ref.current = false;
        },
        100,
        initialMessageRef,
      );
    }

    void processInitialMessage(pending);
  }, [initialMessage, isLoading, setMessages, setAppState, onQuery, mainLoopModel, tools]);

  const onSubmit = useCallback(
    async (
      input: string,
      helpers: PromptInputHelpers,
      speculationAccept?: {
        state: ActiveSpeculationState;
        speculationSessionTimeSavedMs: number;
        setAppState: SetAppState;
      },
      options?: { fromKeybinding?: boolean },
    ) => {
      logForDebugging(
        `[Hapii] REPL.onSubmit 收到用户输入 input = ${input} len=${typeof input === 'string' ? input.length : '?'} isLoading=${queryGuard.getSnapshot()} fromKeybinding=${options?.fromKeybinding ?? false}`,
        { level: 'info' },
      );
      // 提交时重新固定滚动到底部，使用户始终看到新交流
      // （匹配 OpenCode 的自动滚动行为）。
      repinScroll();

      // 如果已暂停则恢复 loop 模式
      if (feature('PROACTIVE') || feature('KAIROS')) {
        proactiveModule?.resumeProactive();
      }

      // 将用户输入路由到选定的 pipe 目标（抽取到 usePipeRouter）
      if (routeToSelectedPipes(input)) {
        logForDebugging('[Hapii] REPL.onSubmit 路由到 pipe 目标（非 Claude 处理）', { level: 'info' });
        // 在消息列表中显示用户的 prompt，使他们能看到发送了什么
        const userMessage = createUserMessage({ content: input });
        setMessages(prev => [...prev, userMessage]);

        if (!options?.fromKeybinding) {
          addToHistory({
            display: prependModeCharacterToInput(input, inputMode),
            pastedContents,
          });
        }
        setInputValue('');
        helpers.setCursorOffset(0);
        helpers.clearBuffer();
        setPastedContents({});
        setInputMode('prompt');
        setIDESelection(undefined);
        return;
      }

      // 处理 immediate 命令 - 这些绕过队列立即执行，即使 Claude 正在处理。
      // 命令通过 `immediate: true` 选择加入。
      // 通过 keybinding 触发的命令始终视为 immediate。
      if (!speculationAccept && input.trim().startsWith('/')) {
        // 展开 [Pasted text #N] 引用，使 immediate 命令（例如 /btw）接收
        // 粘贴的内容，而非占位符。非 immediate 路径稍后在 handlePromptSubmit
        // 中获得此展开。
        const trimmedInput = expandPastedTextRefs(input, pastedContents).trim();
        const spaceIndex = trimmedInput.indexOf(' ');
        const commandName = spaceIndex === -1 ? trimmedInput.slice(1) : trimmedInput.slice(1, spaceIndex);
        const commandArgs = spaceIndex === -1 ? '' : trimmedInput.slice(spaceIndex + 1).trim();

        // 查找匹配命令 - 在以下情况视为 immediate：
        // 1. 命令带 `immediate: true`，或
        // 2. 命令通过 keybinding 触发（fromKeybinding 选项）
        const matchingCommand = commands.find(
          cmd =>
            isCommandEnabled(cmd) &&
            (cmd.name === commandName || cmd.aliases?.includes(commandName) || getCommandName(cmd) === commandName),
        );
        if (matchingCommand?.name === 'clear' && idleHintShownRef.current) {
          logEvent('tengu_idle_return_action', {
            action: 'hint_converted' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            variant: idleHintShownRef.current as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            idleMinutes: Math.round((Date.now() - lastQueryCompletionTimeRef.current) / 60_000),
            messageCount: messagesRef.current.length,
            totalInputTokens: getTotalInputTokens(),
          });
          idleHintShownRef.current = false;
        }

        const shouldTreatAsImmediate = queryGuard.isActive && (matchingCommand?.immediate || options?.fromKeybinding);

        if (matchingCommand) {
          logForDebugging(
            `[Hapii] REPL.onSubmit slash 命令 cmd=${matchingCommand.name} immediate=${shouldTreatAsImmediate} type=${matchingCommand.type}`,
            { level: 'info' },
          );
        }

        if (matchingCommand && shouldTreatAsImmediate && matchingCommand.type === 'local-jsx') {
          // 仅当提交文本与 prompt 中内容匹配时才清除输入。
          // 当命令 keybinding 触发时，输入是 "/<command>" 但实际输入值是
          // 用户的现有文本 - 那种情况下不清除。
          if (input.trim() === inputValueRef.current.trim()) {
            setInputValue('');
            helpers.setCursorOffset(0);
            helpers.clearBuffer();
            setPastedContents({});
          }

          const pastedTextRefs = parseReferences(input).filter(r => pastedContents[r.id]?.type === 'text');
          const pastedTextCount = pastedTextRefs.length;
          const pastedTextBytes = pastedTextRefs.reduce(
            (sum, r) => sum + (pastedContents[r.id]?.content.length ?? 0),
            0,
          );
          logEvent('tengu_paste_text', { pastedTextCount, pastedTextBytes });
          logEvent('tengu_immediate_command_executed', {
            commandName: matchingCommand.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            fromKeybinding: options?.fromKeybinding ?? false,
          });

          // 直接执行命令
          const executeImmediateCommand = async (): Promise<void> => {
            let doneWasCalled = false;
            const onDone = (
              result?: string,
              doneOptions?: {
                display?: CommandResultDisplay;
                metaMessages?: string[];
                displayArgs?: string;
              },
            ): void => {
              doneWasCalled = true;
              setToolJSX({
                jsx: null,
                shouldHidePromptInput: false,
                clearLocalJSX: true,
              });
              const newMessages: MessageType[] = [];
              if (result && doneOptions?.display !== 'skip') {
                addNotification({
                  key: `immediate-${matchingCommand.name}`,
                  text: result,
                  priority: 'immediate',
                });
                // 全屏中命令刚作为居中模态窗格显示 — 上面的通知已足够反馈。
                // 再添加 "❯ /config" + "⎿ dismissed" 到 transcript 是杂乱
                // （这些消息是 type:system subtype:local_command —
                // 对用户可见但不发送给模型，所以跳过它们不改变模型上下文）。
                // 非全屏时 transcript 条目保留，使回滚显示运行了什么。
                if (!isFullscreenEnvEnabled()) {
                  const breadcrumbArgs = doneOptions?.displayArgs ?? commandArgs;
                  newMessages.push(
                    createCommandInputMessage(formatCommandInputTags(getCommandName(matchingCommand), breadcrumbArgs)),
                    createCommandInputMessage(
                      `<${LOCAL_COMMAND_STDOUT_TAG}>${escapeXml(result)}</${LOCAL_COMMAND_STDOUT_TAG}>`,
                    ),
                  );
                }
              }
              // 将 meta 消息（模型可见，用户隐藏）注入 transcript
              if (doneOptions?.metaMessages?.length) {
                newMessages.push(
                  ...doneOptions.metaMessages.map(content => createUserMessage({ content, isMeta: true })),
                );
              }
              if (newMessages.length) {
                setMessages(prev => [...prev, ...newMessages]);
              }
              // local-jsx 命令完成后恢复暂存的 prompt。
              // 正常的暂存恢复路径（下面）被跳过，因为 local-jsx 命令
              // 从 onSubmit 提前返回。
              if (stashedPrompt !== undefined) {
                setInputValue(stashedPrompt.text);
                helpers.setCursorOffset(stashedPrompt.cursorOffset);
                setPastedContents(stashedPrompt.pastedContents);
                setStashedPrompt(undefined);
              }
            };

            // 为命令构建上下文（复用现有 getToolUseContext）。
            // 通过 ref 读取消息以保持 onSubmit 在消息更新间稳定 —
            // 匹配 L2384/L2400/L2662 的模式，避免在下游闭包中钉住陈旧
            // REPL 渲染作用域。
            const context = getToolUseContext(messagesRef.current, [], createAbortController(), mainLoopModel);

            const mod = await matchingCommand.load();
            const jsx = await mod.call(onDone, context, commandArgs);

            // 如果 onDone 已触发则跳过 — 防止 isLocalJSXCommand 卡住
            //（完整机制见 processSlashCommand.tsx 的 local-jsx 分支）。
            if (jsx && !doneWasCalled) {
              // shouldHidePromptInput: false 保持 Notifications 挂载，
              // 使 onDone 结果不丢失
              setToolJSX({
                jsx,
                shouldHidePromptInput: false,
                isLocalJSXCommand: true,
              });
            }
          };
          void executeImmediateCommand();
          return; // 总是提前返回 - 不要加入历史或队列
        }
      }

      // 远程模式：在任何状态变更之前早跳过空输入
      if (activeRemote.isRemoteMode && !input.trim()) {
        return;
      }

      // Idle-return：当会话大且缓存冷时提示用户重新开始。
      // tengu_willow_mode 控制处理方式："dialog"（阻塞）、"hint"（通知）、"off"。
      {
        const willowMode = getFeatureValue_CACHED_MAY_BE_STALE('tengu_willow_mode', 'off');
        const idleThresholdMin = Number(process.env.CLAUDE_CODE_IDLE_THRESHOLD_MINUTES ?? 75);
        const tokenThreshold = Number(process.env.CLAUDE_CODE_IDLE_TOKEN_THRESHOLD ?? 100_000);
        if (
          willowMode !== 'off' &&
          !getGlobalConfig().idleReturnDismissed &&
          !skipIdleCheckRef.current &&
          !speculationAccept &&
          !input.trim().startsWith('/') &&
          lastQueryCompletionTimeRef.current > 0 &&
          getTotalInputTokens() >= tokenThreshold
        ) {
          const idleMs = Date.now() - lastQueryCompletionTimeRef.current;
          const idleMinutes = idleMs / 60_000;
          if (idleMinutes >= idleThresholdMin && willowMode === 'dialog') {
            setIdleReturnPending({ input, idleMinutes });
            setInputValue('');
            helpers.setCursorOffset(0);
            helpers.clearBuffer();
            return;
          }
        }
      }

      // 为直接用户提交添加到历史。
      // 排队命令处理（executeQueuedInput）不调用 onSubmit，所以通知和已排队
      // 的用户输入不会在此添加到历史。
      // 为 keybinding 触发的命令跳过历史（用户未输入命令）。
      if (!options?.fromKeybinding) {
        addToHistory({
          display: speculationAccept ? input : prependModeCharacterToInput(input, inputMode),
          pastedContents: speculationAccept ? {} : pastedContents,
        });
        // 将刚提交的命令添加到 ghost-text 缓存前面，使其立即被建议
        // （而非等待 60s TTL）。
        if (inputMode === 'bash') {
          prependToShellHistoryCache(input.trim());
        }
      }

      // 如果存在则恢复暂存，但对 slash 命令或 loading 时不恢复。
      // - Slash 命令（尤其是交互式如 /model、/context）隐藏 prompt 并显示
      //   picker UI。命令期间恢复暂存会将文本放入隐藏输入，用户输入下一个
      //   命令时会丢失。改为保留暂存，使其跨命令运行保留。
      // - loading 时，提交的输入会入队，handlePromptSubmit 会清除输入字段
      //   （onInputChange('')），会覆盖恢复的暂存。推迟恢复到 handlePromptSubmit
      //   之后（下面）。
      //   远程模式例外：它通过 WebSocket 发送并提前返回，不调用
      //   handlePromptSubmit，所以无覆盖风险 — 立即恢复。
      // 在两种延迟情况下，暂存在 await handlePromptSubmit 之后恢复。
      const isSlashCommand = !speculationAccept && input.trim().startsWith('/');
      // 提交在未 loading、或接受 speculation、或远程模式（通过 WS 发送并
      // 提前返回不调用 handlePromptSubmit）时"立即"运行（不入队）。
      const submitsNow = !isLoading || speculationAccept || activeRemote.isRemoteMode;
      if (stashedPrompt !== undefined && !isSlashCommand && submitsNow) {
        setInputValue(stashedPrompt.text);
        helpers.setCursorOffset(stashedPrompt.cursorOffset);
        setPastedContents(stashedPrompt.pastedContents);
        setStashedPrompt(undefined);
      } else if (submitsNow) {
        if (!options?.fromKeybinding) {
          // 未 loading 或接受 speculation 时清除输入。
          // 为 keybinding 触发的命令保留输入。
          setInputValue('');
          helpers.setCursorOffset(0);
        }
        setPastedContents({});
      }

      if (submitsNow) {
        setInputMode('prompt');
        setIDESelection(undefined);
        setSubmitCount(_ => _ + 1);
        helpers.clearBuffer();
        tipPickedThisTurnRef.current = false;

        // 在与 setInputValue('') 相同的 React 批次中显示占位符。
        // 对 slash/bash 跳过（它们有自己的回显），speculation 和远程模式
        // 跳过（两者直接 setMessages 无需桥接的间隙）。
        if (!isSlashCommand && inputMode === 'prompt' && !speculationAccept && !activeRemote.isRemoteMode) {
          setUserInputOnProcessing(input);
          // showSpinner 包含 userInputOnProcessing，所以 spinner 在此次渲染
          // 出现。立即重置计时 ref（在 queryGuard.reserve() 之前），使经过时间
          // 不读为 Date.now() - 0。上面的 isQueryActive 转换做相同重置 — 幂等。
          resetTimingRefs();
        }

        // 为 attribution 跟踪递增 prompt 计数并保存快照
        // 快照持久化 promptCount，使其能在 compaction 后存活
        if (feature('COMMIT_ATTRIBUTION')) {
          setAppState(prev => ({
            ...prev,
            attribution: incrementPromptCount(prev.attribution, snapshot => {
              void recordAttributionSnapshot(snapshot).catch(error => {
                logForDebugging(`Attribution: Failed to save snapshot: ${error}`);
              });
            }),
          }));
        }
      }

      // 处理 speculation 接受
      if (speculationAccept) {
        const { queryRequired } = await handleSpeculationAccept(
          speculationAccept.state,
          speculationAccept.speculationSessionTimeSavedMs,
          speculationAccept.setAppState,
          input,
          {
            setMessages,
            readFileState,
            cwd: getOriginalCwd(),
          },
        );
        if (queryRequired) {
          const newAbortController = createAbortController();
          setAbortController(newAbortController);
          void onQuery([], newAbortController, true, [], mainLoopModel);
        }
        return;
      }

      // 远程模式：通过 stream-json 发送输入，而非本地 query。
      // 来自远程的权限请求被桥接到 toolUseConfirmQueue 并使用标准
      // PermissionRequest 组件渲染。
      //
      // local-jsx slash 命令（如 /agents、/config）在当前进程渲染 UI —
      // 它们没有远程等价物。让它们落入 handlePromptSubmit 以在本地执行。
      // Prompt 命令和纯文本发往远程。
      if (
        activeRemote.isRemoteMode &&
        !(
          isSlashCommand &&
          commands.find(c => {
            const name = input.trim().slice(1).split(/\s/)[0];
            return isCommandEnabled(c) && (c.name === name || c.aliases?.includes(name!) || getCommandName(c) === name);
          })?.type === 'local-jsx'
        )
      ) {
        // 当有粘贴附件（图像）时构建内容块
        const pastedValues = Object.values(pastedContents);
        const imageContents = pastedValues.filter(c => c.type === 'image');
        const imagePasteIds = imageContents.length > 0 ? imageContents.map(c => c.id) : undefined;

        let messageContent: string | ContentBlockParam[] = input.trim();
        let remoteContent: RemoteMessageContent = input.trim();
        if (pastedValues.length > 0) {
          const contentBlocks: ContentBlockParam[] = [];
          const remoteBlocks: Array<{ type: string; [key: string]: unknown }> = [];

          const trimmedInput = input.trim();
          if (trimmedInput) {
            contentBlocks.push({ type: 'text', text: trimmedInput });
            remoteBlocks.push({ type: 'text', text: trimmedInput });
          }

          for (const pasted of pastedValues) {
            if (pasted.type === 'image') {
              const source = {
                type: 'base64' as const,
                media_type: (pasted.mediaType ?? 'image/png') as
                  | 'image/jpeg'
                  | 'image/png'
                  | 'image/gif'
                  | 'image/webp',
                data: pasted.content,
              };
              contentBlocks.push({ type: 'image', source });
              remoteBlocks.push({ type: 'image', source });
            } else {
              contentBlocks.push({ type: 'text', text: pasted.content });
              remoteBlocks.push({ type: 'text', text: pasted.content });
            }
          }

          messageContent = contentBlocks;
          remoteContent = remoteBlocks;
        }

        // 创建并添加用户消息到 UI
        // 注意：空输入已由上面的早返回处理
        const userMessage = createUserMessage({
          content: messageContent,
          imagePasteIds,
        });
        setMessages(prev => [...prev, userMessage]);

        // 发送到远程会话
        await activeRemote.sendMessage(remoteContent, {
          uuid: userMessage.uuid,
        });
        return;
      }

      // 确保第一次 API 调用前 SessionStart hook 上下文可用。
      await awaitPendingHooks();

      logForDebugging(
        `[Hapii] REPL.onSubmit 正常提交路径 handlePromptSubmit inputMode=${inputMode} msgs=${messagesRef.current.length}`,
        { level: 'info' },
      );

      await handlePromptSubmit({
        input,
        helpers,
        queryGuard,
        isExternalLoading,
        mode: inputMode,
        commands,
        onInputChange: setInputValue,
        setPastedContents,
        setToolJSX,
        getToolUseContext,
        messages: messagesRef.current,
        mainLoopModel,
        pastedContents,
        ideSelection,
        setUserInputOnProcessing,
        setAbortController,
        abortController,
        onQuery,
        setAppState,
        querySource: getQuerySourceForREPL(),
        onBeforeQuery,
        canUseTool,
        addNotification,
        setMessages,
        // 通过 ref 读取以使 streamMode 可从 onSubmit 依赖中移除 —
        // handlePromptSubmit 只将其用于调试日志 + telemetry 事件。
        streamMode: streamModeRef.current,
        hasInterruptibleToolInProgress: hasInterruptibleToolInProgressRef.current,
      });

      // 恢复上面延迟的暂存。两种情况：
      // - Slash 命令：handlePromptSubmit 等待了完整命令执行（包括交互式
      //   picker）。现在恢复将暂存放回可见输入。
      // - Loading（已排队）：handlePromptSubmit 入队 + 清除输入，然后快速
      //   返回。现在恢复将暂存放回清除后的位置。
      if ((isSlashCommand || isLoading) && stashedPrompt !== undefined) {
        setInputValue(stashedPrompt.text);
        helpers.setCursorOffset(stashedPrompt.cursorOffset);
        setPastedContents(stashedPrompt.pastedContents);
        setStashedPrompt(undefined);
      }
    },
    [
      queryGuard,
      // isLoading 在上面 !isLoading 检查处被读取用于输入清除和 submitCount 门控。
      // 它派生自 isQueryActive || isExternalLoading，所以在此包含它确保闭包
      // 捕获新鲜值。
      isLoading,
      isExternalLoading,
      inputMode,
      commands,
      setInputValue,
      setInputMode,
      setPastedContents,
      setSubmitCount,
      setIDESelection,
      setToolJSX,
      getToolUseContext,
      // messages 在回调内通过 messagesRef.current 读取，使 onSubmit 在
      // 消息更新间保持稳定（见 L2384/L2400/L2662）。
      // 否则，每次 setMessages 调用（每 turn 约 30 次）都会重建 onSubmit，
      // 将 REPL 渲染作用域（1776B）+ 该渲染的 messages 数组钉在下游闭包中
      // （PromptInput、handleAutoRunIssue）。
      // 堆分析显示 #20174/#20175 之后约 9 个 REPL 作用域和约 15 个 messages
      // 数组版本累积，全部追溯到这个依赖。
      mainLoopModel,
      pastedContents,
      ideSelection,
      setUserInputOnProcessing,
      setAbortController,
      addNotification,
      onQuery,
      stashedPrompt,
      setStashedPrompt,
      setAppState,
      onBeforeQuery,
      canUseTool,
      remoteSession,
      setMessages,
      awaitPendingHooks,
      repinScroll,
    ],
  );

  // 查看 teammate transcript 时用户提交输入的回调
  const onAgentSubmit = useCallback(
    async (input: string, task: InProcessTeammateTaskState | LocalAgentTaskState, helpers: PromptInputHelpers) => {
      if (isLocalAgentTask(task)) {
        appendMessageToLocalAgent(task.id, createUserMessage({ content: input }), setAppState);
        if (task.status === 'running') {
          queuePendingMessage(task.id, input, setAppState);
        } else {
          void resumeAgentBackground({
            agentId: task.id,
            prompt: input,
            toolUseContext: getToolUseContext(messagesRef.current, [], new AbortController(), mainLoopModel),
            canUseTool,
          }).catch(err => {
            logForDebugging(`resumeAgentBackground failed: ${errorMessage(err)}`);
            addNotification({
              key: `resume-agent-failed-${task.id}`,
              jsx: <Text color="error">Failed to resume agent: {errorMessage(err)}</Text>,
              priority: 'low',
            });
          });
        }
      } else {
        injectUserMessageToTeammate(task.id, input, undefined, setAppState);
      }
      setInputValue('');
      helpers.setCursorOffset(0);
      helpers.clearBuffer();
    },
    [setAppState, setInputValue, getToolUseContext, canUseTool, mainLoopModel, addNotification],
  );

  // auto-run /issue 或 /good-claude 的处理器（在 onSubmit 之后定义）
  const handleAutoRunIssue = useCallback(() => {
    const command = autoRunIssueReason ? getAutoRunCommand(autoRunIssueReason) : '/issue';
    setAutoRunIssueReason(null); // 清除状态
    onSubmit(command, {
      setCursorOffset: () => {},
      clearBuffer: () => {},
      resetHistory: () => {},
    }).catch(err => {
      logForDebugging(`Auto-run ${command} failed: ${errorMessage(err)}`);
    });
  }, [onSubmit, autoRunIssueReason]);

  const handleCancelAutoRunIssue = useCallback(() => {
    setAutoRunIssueReason(null);
  }, []);

  // 用户在 survey 感谢屏幕按 1 分享详情的处理器
  const handleSurveyRequestFeedback = useCallback(() => {
    const command = process.env.USER_TYPE === 'ant' ? '/issue' : '/feedback';
    onSubmit(command, {
      setCursorOffset: () => {},
      clearBuffer: () => {},
      resetHistory: () => {},
    }).catch(err => {
      logForDebugging(`Survey feedback request failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, [onSubmit]);

  // onSubmit 不稳定（依赖包括每个 turn 都变化的 `messages`）。
  // `handleOpenRateLimitOptions` 通过 prop 传递到每个 MessageRow，每个
  // MessageRow fiber 在挂载时钉住闭包（以及传递性上的整个 REPL 渲染作用域，
  // 约 1.8KB）。使用 ref 保持此回调稳定，使旧 REPL 作用域能被 GC —
  // 1000 turn 会话节省约 35MB。
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const handleOpenRateLimitOptions = useCallback(() => {
    void onSubmitRef.current('/rate-limit-options', {
      setCursorOffset: () => {},
      clearBuffer: () => {},
      resetHistory: () => {},
    });
  }, []);

  const handleExit = useCallback(async () => {
    setIsExiting(true);
    // 后台会话中，始终 detach 而非 kill — 即使 worktree 活跃时也是。
    // 没有此守卫，下面的 worktree 分支会短路到 ExitFlow（调用
    // gracefulShutdown）在 exit.tsx 加载之前。
    if (feature('BG_SESSIONS') && isBgSession()) {
      spawnSync('tmux', ['detach-client'], { stdio: 'ignore' });
      setIsExiting(false);
      return;
    }
    const showWorktree = getCurrentWorktreeSession() !== null;
    if (showWorktree) {
      setExitFlow(
        <ExitFlow
          showWorktree
          onDone={() => {}}
          onCancel={() => {
            setExitFlow(null);
            setIsExiting(false);
          }}
        />,
      );
      return;
    }
    const exitMod = await exit.load();
    const exitFlowResult = await exitMod.call(() => {});
    setExitFlow(exitFlowResult);
    // 如果 call() 返回但未杀死进程（bg session detach），
    // 清除 isExiting 使 UI 在重新附加时可用。正常路径下为 no-op —
    // gracefulShutdown 的 process.exit() 意味着我们永远到不了这里。
    if (exitFlowResult === null) {
      setIsExiting(false);
    }
  }, []);

  const handleShowMessageSelector = useCallback(() => {
    setIsMessageSelectorVisible(prev => !prev);
  }, []);

  // 将会话状态回退到 `message` 之前：切片消息，重置会话 ID、microcompact
  // 状态、权限模式、prompt 建议。不触碰 prompt 输入。索引从 messagesRef
  // 计算（通过 setMessages 包装器始终新鲜），所以调用方无需担心陈旧闭包。
  const rewindConversationTo = useCallback(
    (message: UserMessage) => {
      const prev = messagesRef.current;
      const messageIndex = prev.lastIndexOf(message);
      if (messageIndex === -1) return;

      logEvent('tengu_conversation_rewind', {
        preRewindMessageCount: prev.length,
        postRewindMessageCount: messageIndex,
        messagesRemoved: prev.length - messageIndex,
        rewindToMessageIndex: messageIndex,
      });
      setMessages(prev.slice(0, messageIndex));
      // 注意，这必须在 setMessages 之后发生
      setConversationId(randomUUID());
      // 重置缓存的 microcompact 状态，使陈旧的固定缓存编辑
      // 不引用被截断消息的 tool_use_ids
      resetMicrocompactState();
      if (feature('CONTEXT_COLLAPSE')) {
        // 回退截断 REPL 数组。archived span 超过回退点的 commit 无法再投影
        // （projectView 静默跳过它们），但暂存队列和 ID 映射引用陈旧 uuid。
        // 最简单的安全重置：丢弃一切。ctx-agent 会在下次阈值跨越时重新暂存。
        /* eslint-disable @typescript-eslint/no-require-imports */
        (
          require('../services/contextCollapse/index.js') as typeof import('../services/contextCollapse/index.js')
        ).resetContextCollapse();
        /* eslint-enable @typescript-eslint/no-require-imports */
      }

      // 从我们正在回退到的消息恢复状态
      const permMode = message.permissionMode as InternalPermissionMode | undefined;
      setAppState(prev => ({
        ...prev,
        // 从消息恢复权限模式
        toolPermissionContext:
          permMode && prev.toolPermissionContext.mode !== permMode
            ? {
                ...prev.toolPermissionContext,
                mode: permMode,
              }
            : prev.toolPermissionContext,
        // 清除上一个会话状态的陈旧 prompt 建议
        promptSuggestion: {
          text: null,
          promptId: null,
          shownAt: 0,
          acceptedAt: 0,
          generationRequestId: null,
        },
      }));
    },
    [setMessages, setAppState],
  );

  // 同步回退 + 输入填充。直接被中断时的 auto-restore 使用（使 React 与
  // abort 的 setMessages 一起批处理 → 单次渲染，无闪烁）。MessageSelector
  // 通过 handleRestoreMessage 用 setImmediate 包装此函数。
  const restoreMessageSync = useCallback(
    (message: UserMessage) => {
      rewindConversationTo(message);

      const r = textForResubmit(message);
      if (r) {
        setInputValue(r.text);
        setInputMode(r.mode);
      }

      // 恢复粘贴的图像
      if (Array.isArray(message.message.content) && message.message.content.some(block => block.type === 'image')) {
        const imageBlocks: Array<ImageBlockParam> = message.message.content.filter(block => block.type === 'image');
        if (imageBlocks.length > 0) {
          const newPastedContents: Record<number, PastedContent> = {};
          imageBlocks.forEach((block, index) => {
            if (block.source.type === 'base64') {
              const id = (message.imagePasteIds as number[] | undefined)?.[index] ?? index + 1;
              newPastedContents[id] = {
                id,
                type: 'image',
                content: block.source.data,
                mediaType: block.source.media_type,
              };
            }
          });
          setPastedContents(newPastedContents);
        }
      }
    },
    [rewindConversationTo, setInputValue],
  );
  restoreMessageSyncRef.current = restoreMessageSync;

  // MessageSelector 路径：通过 setImmediate 延迟，使 "Interrupted" 消息在
  // 回退前渲染为静态输出 — 否则它会残留为屏幕顶部的无用内容。
  const handleRestoreMessage = useCallback(
    async (message: UserMessage) => {
      setImmediate((restore, message) => restore(message), restoreMessageSync, message);
    },
    [restoreMessageSync],
  );

  // 未 memoize — hook 通过 ref 存储 caps，在 dispatch 时读取最新闭包。
  // 24 字符前缀：deriveUUID 保留前 24 个字符，可渲染的 uuid 前缀匹配原始 source。
  const findRawIndex = (uuid: string) => {
    const prefix = uuid.slice(0, 24);
    return messages.findIndex(m => m.uuid.slice(0, 24) === prefix);
  };
  const messageActionCaps: MessageActionCaps = {
    copy: text =>
      // setClipboard 返回 OSC 52 — 调用方必须 stdout.write（tmux 副作用是 load-buffer，但那是 tmux 特有的）。
      void setClipboard(text).then(raw => {
        if (raw) process.stdout.write(raw);
        addNotification({
          // 与文本选择复制相同的 key — 重复复制替换 toast，不入队。
          key: 'selection-copied',
          text: 'copied',
          color: 'success',
          priority: 'immediate',
          timeoutMs: 2000,
        });
      }),
    edit: async msg => {
      // 与 /rewind 相同的跳过确认检查：无损 → 直接，否则确认对话框。
      const rawIdx = findRawIndex(msg.uuid);
      const raw = rawIdx >= 0 ? messages[rawIdx] : undefined;
      if (!raw || !selectableUserMessagesFilter(raw)) return;
      const noFileChanges = !(await fileHistoryHasAnyChanges(fileHistory, raw.uuid));
      const onlySynthetic = messagesAfterAreOnlySynthetic(messages, rawIdx);
      if (noFileChanges && onlySynthetic) {
        // rewindConversationTo 的 setMessages 与 stream 追加竞态 — 先取消（幂等）。
        onCancel();
        // handleRestoreMessage 也恢复粘贴的图像。
        void handleRestoreMessage(raw);
      } else {
        // 对话框路径：onPreRestore（= onCancel）在用户确认时触发，而非 nevermind。
        setMessageSelectorPreselect(raw);
        setIsMessageSelectorVisible(true);
      }
    },
  };
  const { enter: enterMessageActions, handlers: messageActionHandlers } = useMessageActions(
    cursor,
    setCursor,
    cursorNavRef,
    messageActionCaps,
  );

  async function onInit() {
    // 启动时始终验证 API key，使我们在 API key 无效时能在屏幕右下角
    // 向用户显示错误。
    void reverify();

    // 启动时用 CLAUDE.md 文件填充 readFileState
    const memoryFiles = await getMemoryFiles();
    if (memoryFiles.length > 0) {
      const fileList = memoryFiles
        .map(f => `  [${f.type}] ${f.path} (${f.content.length} chars)${f.parent ? ` (included by ${f.parent})` : ''}`)
        .join('\n');
      logForDebugging(`Loaded ${memoryFiles.length} CLAUDE.md/rules files:\n${fileList}`);
    } else {
      logForDebugging('No CLAUDE.md/rules files found');
    }
    for (const file of memoryFiles) {
      // 当注入内容与磁盘不匹配（剥离 HTML 注释、剥离 frontmatter、
      // MEMORY.md 截断）时，用 isPartialView 缓存原始磁盘字节，
      // 使 Edit/Write 需要先真正 Read，同时 getChangedFiles + nested_memory
      // 去重仍能工作。
      readFileState.current.set(file.path, {
        content: file.contentDiffersFromDisk ? (file.rawContent ?? file.content) : file.content,
        timestamp: Date.now(),
        offset: undefined,
        limit: undefined,
        isPartialView: file.contentDiffersFromDisk,
      });
    }

    // 初始消息处理通过 initialMessage effect 完成
  }

  // 注册成本汇总跟踪器
  useCostSummary(useFpsMetrics());

  // 本地记录 transcript，用于调试和会话恢复
  // 如果只有初始消息则不记录会话；优化用户恢复会话后未做任何事就退出的情况
  useLogMessages(messages, messages.length === initialMessages?.length);

  // REPL Bridge：将用户/assistant 消息复制到 bridge 会话，用于通过
  // claude.ai 远程访问。外部构建或未启用时为 no-op。
  const { sendBridgeResult } = useReplBridge(messages, setMessages, abortControllerRef, commands, mainLoopModel);
  sendBridgeResultRef.current = sendBridgeResult;

  useAfterFirstRender();

  // 为 analytics 跟踪 prompt 队列使用。每次从空到非空的转换触发一次，
  // 而非每次长度变化都触发 -- 否则渲染循环
  // （并发 onQuery 抖动等）会垃圾刷 saveGlobalConfig，它在并发会话下命中
  // ELOCKED 并回退到无锁写入。该写入风暴是 ~/.hclaude.json 损坏的主要触发器
  // （GH #3117）。
  const hasCountedQueueUseRef = useRef(false);
  useEffect(() => {
    if (queuedCommands.length < 1) {
      hasCountedQueueUseRef.current = false;
      return;
    }
    if (hasCountedQueueUseRef.current) return;
    hasCountedQueueUseRef.current = true;
    saveGlobalConfig(current => ({
      ...current,
      promptQueueUseCount: (current.promptQueueUseCount ?? 0) + 1,
    }));
  }, [queuedCommands.length]);

  // query 完成且队列有项时处理排队命令

  const executeQueuedInput = useCallback(
    async (queuedCommands: QueuedCommand[]) => {
      await handlePromptSubmit({
        helpers: {
          setCursorOffset: () => {},
          clearBuffer: () => {},
          resetHistory: () => {},
        },
        queryGuard,
        commands,
        onInputChange: () => {},
        setPastedContents: () => {},
        setToolJSX,
        getToolUseContext,
        messages,
        mainLoopModel,
        ideSelection,
        setUserInputOnProcessing,
        setAbortController,
        onQuery,
        setAppState,
        querySource: getQuerySourceForREPL(),
        onBeforeQuery,
        canUseTool,
        addNotification,
        setMessages,
        queuedCommands,
      });
    },
    [
      queryGuard,
      commands,
      setToolJSX,
      getToolUseContext,
      messages,
      mainLoopModel,
      ideSelection,
      setUserInputOnProcessing,
      canUseTool,
      setAbortController,
      onQuery,
      addNotification,
      setAppState,
      onBeforeQuery,
    ],
  );

  useQueueProcessor({
    executeQueuedInput,
    hasActiveLocalJsxUI: isShowingLocalJSXCommand,
    queryGuard,
  });

  // 我们将使用 state.ts 中的全局 lastInteractionTime

  // 输入变化时更新最后交互时间。
  // 必须立即，因为 useEffect 在 Ink 渲染周期刷新之后运行。
  useEffect(() => {
    activityManager.recordUserActivity();
    updateLastInteractionTime(true);
  }, [inputValue, submitCount]);

  useEffect(() => {
    if (submitCount === 1) {
      startBackgroundHousekeeping();
    }
  }, [submitCount]);

  // Claude 完成响应且用户空闲时显示通知
  useEffect(() => {
    // Claude 忙时不设置通知
    if (isLoading) return;

    // 仅在本会话第一次新交互后启用通知
    if (submitCount === 0) return;

    // 还没有 query 完成
    if (lastQueryCompletionTime === 0) return;

    // 设置 timeout 检查空闲状态
    const timer = setTimeout(
      (lastQueryCompletionTime, isLoading, toolJSX, focusedInputDialogRef, terminal) => {
        // 检查响应结束后用户是否交互过
        const lastUserInteraction = getLastInteractionTime();

        if (lastUserInteraction > lastQueryCompletionTime) {
          // 用户在 Claude 完成后已交互 - 他们不空闲，不通知
          return;
        }

        // 用户在响应结束后未交互，检查其他条件
        const idleTimeSinceResponse = Date.now() - lastQueryCompletionTime;
        if (
          !isLoading &&
          !toolJSX &&
          // 使用 ref 获取当前 dialog 状态，避免陈旧闭包
          focusedInputDialogRef.current === undefined &&
          idleTimeSinceResponse >= getGlobalConfig().messageIdleNotifThresholdMs
        ) {
          void sendNotification(
            {
              message: 'Claude is waiting for your input',
              notificationType: 'idle_prompt',
            },
            terminal,
          );
        }
      },
      getGlobalConfig().messageIdleNotifThresholdMs,
      lastQueryCompletionTime,
      isLoading,
      toolJSX,
      focusedInputDialogRef,
      terminal,
    );

    return () => clearTimeout(timer);
  }, [isLoading, toolJSX, submitCount, lastQueryCompletionTime, terminal]);

  // 空闲返回提示：超过空闲阈值时显示通知。
  // 定时器在配置的空闲周期后触发；通知持续到被关闭或用户提交。
  useEffect(() => {
    if (lastQueryCompletionTime === 0) return;
    if (isLoading) return;
    const willowMode: string = getFeatureValue_CACHED_MAY_BE_STALE('tengu_willow_mode', 'off');
    if (willowMode !== 'hint' && willowMode !== 'hint_v2') return;
    if (getGlobalConfig().idleReturnDismissed) return;

    const tokenThreshold = Number(process.env.CLAUDE_CODE_IDLE_TOKEN_THRESHOLD ?? 100_000);
    if (getTotalInputTokens() < tokenThreshold) return;

    const idleThresholdMs = Number(process.env.CLAUDE_CODE_IDLE_THRESHOLD_MINUTES ?? 75) * 60_000;
    const elapsed = Date.now() - lastQueryCompletionTime;
    const remaining = idleThresholdMs - elapsed;

    const timer = setTimeout(
      (lqct, addNotif, msgsRef, mode, hintRef) => {
        if (msgsRef.current.length === 0) return;
        const totalTokens = getTotalInputTokens();
        const formattedTokens = formatTokens(totalTokens);
        const idleMinutes = (Date.now() - lqct) / 60_000;
        addNotif({
          key: 'idle-return-hint',
          jsx:
            mode === 'hint_v2' ? (
              <>
                <Text dimColor>new task? </Text>
                <Text color="suggestion">/clear</Text>
                <Text dimColor> to save </Text>
                <Text color="suggestion">{formattedTokens} tokens</Text>
              </>
            ) : (
              <Text color="warning">new task? /clear to save {formattedTokens} tokens</Text>
            ),
          priority: 'medium',
          // 持续到提交 — 提示在空闲 T+75 分钟时触发，用户可能数小时不返回。
          // useEffect 清理中的 removeNotification 处理关闭。
          // 0x7FFFFFFF = setTimeout 最大值（约 24.8 天）。
          timeoutMs: 0x7fffffff,
        });
        hintRef.current = mode;
        logEvent('tengu_idle_return_action', {
          action: 'hint_shown' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          variant: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          idleMinutes: Math.round(idleMinutes),
          messageCount: msgsRef.current.length,
          totalInputTokens: totalTokens,
        });
      },
      Math.max(0, remaining),
      lastQueryCompletionTime,
      addNotification,
      messagesRef,
      willowMode,
      idleHintShownRef,
    );

    return () => {
      clearTimeout(timer);
      removeNotification('idle-return-hint');
      idleHintShownRef.current = false;
    };
  }, [lastQueryCompletionTime, isLoading, addNotification, removeNotification]);

  // 将来自 teammate 消息或 tasks 模式的传入 prompt 作为新 turn 提交
  // 如果提交成功返回 true，如果 query 已在运行返回 false
  const handleIncomingPrompt = useCallback(
    (input: string | QueuedCommand, options?: { isMeta?: boolean }): boolean => {
      if (queryGuard.isActive) return false;

      // 让位给用户排队命令 — 用户输入始终优先于系统消息
      // （teammate 消息、任务列表项等）。
      // 在调用时从模块级 store 读取（而非渲染时快照）以避免陈旧闭包 —
      // 此回调的依赖不包括队列。
      if (getCommandQueue().some(cmd => cmd.mode === 'prompt' || cmd.mode === 'bash')) {
        return false;
      }

      const queuedCommand =
        typeof input === 'string'
          ? ({
              value: input,
              mode: 'prompt',
              isMeta: options?.isMeta ? true : undefined,
            } satisfies QueuedCommand)
          : input;

      void (async () => {
        const claim = await claimConsumableQueuedAutonomyCommands([queuedCommand]);
        const command = claim.attachmentCommands[0];
        if (!command) return;

        const newAbortController = createAbortController();
        setAbortController(newAbortController);

        // 创建带格式化内容的用户消息（包含 XML 包装）
        const userMessage = createUserMessage({
          content: command.value,
          isMeta: command.isMeta ? true : undefined,
          origin: command.origin,
        });

        let executed = false;
        try {
          executed = (await onQuery([userMessage], newAbortController, true, [], mainLoopModel)) !== false;
        } catch (error: unknown) {
          try {
            await finalizeAutonomyCommandsForTurn({
              commands: claim.claimedCommands,
              outcome: { type: 'failed', error },
              currentDir: getCwd(),
              priority: 'later',
            });
          } catch (finalizeError: unknown) {
            logError(toError(finalizeError));
          }
          logError(toError(error));
          return;
        }

        // 仅当 onQuery 实际执行了 turn 时才标记为已完成
        //（它在 concurrent-guard 路径上未运行就返回 false）。
        // 将此 finalize 保留在独立的 try/catch 中，使此处的失败不会
        // 为相同命令触发第二次 `failed` finalize。
        if (!executed) {
          return;
        }
        try {
          const nextCommands = await finalizeAutonomyCommandsForTurn({
            commands: claim.claimedCommands,
            outcome: { type: 'completed' },
            currentDir: getCwd(),
            priority: 'later',
          });
          for (const nextCommand of nextCommands) {
            enqueue(nextCommand);
          }
        } catch (finalizeError: unknown) {
          logError(toError(finalizeError));
        }
      })().catch((error: unknown) => {
        logError(toError(error));
      });
      return true;
    },
    [onQuery, mainLoopModel, store],
  );

  const { relayPipeMessage, pipeReturnHadErrorRef } = usePipeRelay();

  // 语音输入集成（仅 VOICE_MODE 构建）
  const voiceIntegrationResult = useVoiceIntegration({ setInputValueRaw, inputValueRef, insertTextRef });
  const voice = feature('VOICE_MODE')
    ? voiceIntegrationResult
    : {
        stripTrailing: () => 0,
        handleKeyEvent: () => {},
        resetAnchor: () => {},
        interimRange: null,
      };

  useInboxPoller({
    enabled: isAgentSwarmsEnabled(),
    isLoading,
    focusedInputDialog,
    onSubmitMessage: handleIncomingPrompt,
  });

  useMailboxBridge({ isLoading, onSubmitMessage: handleIncomingPrompt });
  useMasterMonitor();
  useSlaveNotifications();
  const _pipeIpcState = useAppState(s => getPipeIpc(s));

  usePipePermissionForward({ store, tools, setMessages, setToolUseConfirmQueue, getToolUseContext, mainLoopModel });
  usePipeMuteSync({ setToolUseConfirmQueue });

  // Pipe IPC 生命周期 — 抽取到 usePipeIpc hook
  usePipeIpc({ store, handleIncomingPrompt });
  const { routeToSelectedPipes } = usePipeRouter({ store, setAppState, addNotification });

  // 来自 .hclaude/scheduled_tasks.json 的计划任务（CronCreate/Delete/List）
  if (feature('AGENT_TRIGGERS')) {
    // Assistant 模式绕过 isLoading 门控（否则 proactive tick → Sleep →
    // tick 循环会使调度器饥饿）。
    // kairosEnabled 在 initialState（main.tsx）中设置一次且从不修改 — 无需
    // 订阅。tengu_kairos_cron 运行时门控在 useScheduledTasks 的 effect
    // （不在此处）中检查，因为将 hook 调用包装在动态条件中会破坏
    // rules-of-hooks。
    const assistantMode = store.getState().kairosEnabled;
    useScheduledTasks!({ isLoading, assistantMode, setMessages });
  }

  // 注意：权限轮询现在由 useInboxPoller 处理
  // - Worker 通过 mailbox 消息接收权限响应
  // - Leader 通过 mailbox 消息接收权限请求

  if (process.env.USER_TYPE === 'ant') {
    // Tasks 模式：监听任务并自动处理
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useTaskListWatcher({
      taskListId,
      isLoading,
      onSubmitTask: handleIncomingPrompt,
    });
  }

  // Proactive 模式：启用时自动 tick（通过 /proactive 命令）
  // 从 USER_TYPE === 'ant' 块移出，使外部用户也能使用。
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useProactive?.({
    // 初始消息待处理时抑制 tick — 初始消息会异步处理，过早的 tick 会
    // 与之竞态，导致展开的 skill 文本被并发 query 入队。
    isLoading: isLoading || initialMessage !== null,
    queuedCommandsLength: queuedCommands.length,
    hasActiveLocalJsxUI: isShowingLocalJSXCommand,
    isInPlanMode: toolPermissionContext.mode === 'plan',
    onQueueTick: (command: QueuedCommand) => enqueue(command),
  });

  // Goal 自动 continuation：空闲 + 活跃 goal 时入队一个 steering prompt
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useGoalContinuation?.({
    isLoading: isLoading || initialMessage !== null,
    wasAborted,
    queuedCommandsLength: queuedCommands.length,
    hasActiveLocalJsxUI: isShowingLocalJSXCommand,
    isInPlanMode: toolPermissionContext.mode === 'plan',
    isQueryActiveNow: queryGuard.getSnapshot,
    onContinuationEnqueued: ({ turn, objective }) => {
      const visibleGoalTurnInput = `Goal auto-continue (${turn}/1): continue advancing "${objective}".`;
      setMessages(oldMessages => [
        ...oldMessages,
        createUserMessage({
          content: visibleGoalTurnInput,
          isVisibleInTranscriptOnly: true,
        }),
      ]);
    },
    onMaxTurnsReached: () => {
      addNotification({
        key: 'goal-max-turns-reached',
        text: 'Goal reached max continuation turns (1). Run /goal continue to reset turn counter and continue.',
        priority: 'immediate',
      });
    },
  });

  useEffect(() => {
    if (!proactiveActive) {
      notifyAutomationStateChanged(null);
      return;
    }

    if (isLoading) {
      return;
    }

    if (
      proactiveNextTickAt !== null &&
      queuedCommands.length === 0 &&
      !isShowingLocalJSXCommand &&
      toolPermissionContext.mode !== 'plan' &&
      initialMessage === null
    ) {
      notifyAutomationStateChanged({
        enabled: true,
        phase: 'standby',
        next_tick_at: proactiveNextTickAt,
        sleep_until: null,
      });
      return;
    }

    notifyAutomationStateChanged({
      enabled: true,
      phase: null,
      next_tick_at: null,
      sleep_until: null,
    });
  }, [
    initialMessage,
    isLoading,
    isShowingLocalJSXCommand,
    proactiveActive,
    proactiveNextTickAt,
    queuedCommands.length,
    toolPermissionContext.mode,
  ]);

  // 当 'now' 优先级消息到达时中止当前操作
  //（例如来自 chat UI 客户端通过 UDS）。
  useEffect(() => {
    if (queuedCommands.some(cmd => cmd.priority === 'now')) {
      abortControllerRef.current?.abort('interrupt');
    }
  }, [queuedCommands]);

  const onInitRef = useRef(onInit);
  onInitRef.current = onInit;
  const diagnosticTrackerRef = useRef(diagnosticTracker);
  diagnosticTrackerRef.current = diagnosticTracker;

  // 初始加载
  useEffect(() => {
    void onInitRef.current();

    // 卸载时清理
    return () => {
      void diagnosticTrackerRef.current.shutdown();
    };
  }, []);

  // 监听 suspend/resume 事件
  const { internal_eventEmitter } = useStdin();
  const [remountKey, setRemountKey] = useState(0);
  useEffect(() => {
    const handleSuspend = () => {
      // 打印挂起说明
      process.stdout.write(
        `\nClaude Code has been suspended. Run \`fg\` to bring Claude Code back.\nNote: ctrl + z now suspends Claude Code, ctrl + _ undoes input.\n`,
      );
    };

    const handleResume = () => {
      // 强制替换完整组件树，而非终端清除
      // Ink 现在在 SIGCONT 上内部处理行数重置
      setRemountKey(prev => prev + 1);
    };

    internal_eventEmitter?.on('suspend', handleSuspend);
    internal_eventEmitter?.on('resume', handleResume);
    return () => {
      internal_eventEmitter?.off('suspend', handleSuspend);
      internal_eventEmitter?.off('resume', handleResume);
    };
  }, [internal_eventEmitter]);

  // 从消息状态派生 stop hook spinner 后缀
  const stopHookSpinnerSuffix = useMemo(() => {
    if (!isLoading) return null;

    // 查找 stop hook 进度消息
    const progressMsgs = messages.filter((m): m is ProgressMessage<HookProgress> => {
      if (m.type !== 'progress') return false;
      const data = m.data as Record<string, unknown>;
      return data.type === 'hook_progress' && (data.hookEvent === 'Stop' || data.hookEvent === 'SubagentStop');
    });
    if (progressMsgs.length === 0) return null;

    // 获取最近的 stop hook 执行
    const currentToolUseID = progressMsgs.at(-1)?.toolUseID;
    if (!currentToolUseID) return null;

    // 检查此执行是否已有汇总消息（hooks 已完成）
    const hasSummaryForCurrentExecution = messages.some(
      m => m.type === 'system' && m.subtype === 'stop_hook_summary' && m.toolUseID === currentToolUseID,
    );
    if (hasSummaryForCurrentExecution) return null;

    const currentHooks = progressMsgs.filter(p => p.toolUseID === currentToolUseID);
    const total = currentHooks.length;

    // 统计已完成的 hooks
    const completedCount = count(messages, m => {
      if (m.type !== 'attachment') return false;
      const attachment = m.attachment!;
      return (
        'hookEvent' in attachment &&
        (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') &&
        'toolUseID' in attachment &&
        attachment.toolUseID === currentToolUseID
      );
    });

    // 检查是否有 hook 带有自定义状态消息
    const customMessage = currentHooks.find(p => p.data.statusMessage)?.data.statusMessage;

    if (customMessage) {
      // 如果有多个 hooks 则使用带进度计数器的自定义消息
      return total === 1 ? `${customMessage}…` : `${customMessage}… ${completedCount}/${total}`;
    }

    // 回退到默认行为
    const hookType = currentHooks[0]?.data.hookEvent === 'SubagentStop' ? 'subagent stop' : 'stop';

    if (process.env.USER_TYPE === 'ant') {
      const cmd = currentHooks[completedCount]?.data.command;
      const label = cmd ? ` '${truncateToWidth(cmd, 40)}'` : '';
      return total === 1
        ? `running ${hookType} hook${label}`
        : `running ${hookType} hook${label}\u2026 ${completedCount}/${total}`;
    }

    return total === 1 ? `running ${hookType} hook` : `running stop hooks… ${completedCount}/${total}`;
  }, [messages, isLoading]);

  // 进入 transcript 模式时捕获冻结状态的回调
  const handleEnterTranscript = useCallback(() => {
    setFrozenTranscriptState({
      messagesLength: messages.length,
      streamingToolUsesLength: streamingToolUses.length,
    });
  }, [messages.length, streamingToolUses.length]);

  // 退出 transcript 模式时清除冻结状态的回调
  const handleExitTranscript = useCallback(() => {
    setFrozenTranscriptState(null);
  }, []);

  // GlobalKeybindingHandlers 组件的 props（在 KeybindingSetup 内渲染）
  const virtualScrollActive = isFullscreenEnvEnabled() && !disableVirtualScroll;

  // Transcript 搜索状态。Hooks 必须无条件，所以放在这里
  //（不在下方 `if (screen === 'transcript')` 分支内）；isActive
  // 门控 useInput。Query 在栏打开/关闭之间持久化，使 n/N 在 Enter
  // 关闭栏后仍能工作（less 语义）。
  const jumpRef = useRef<JumpHandle | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCount, setSearchCount] = useState(0);
  const [searchCurrent, setSearchCurrent] = useState(0);
  const onSearchMatchesChange = useCallback((count: number, current: number) => {
    setSearchCount(count);
    setSearchCurrent(current);
  }, []);

  useInput(
    (input, key, event) => {
      if (key.ctrl || key.meta) return;
      // 此处不处理 Esc — less 没有 navigating 模式。搜索状态
      //（高亮、n/N）只是状态。Esc/q/ctrl+c → transcript:exit
      //（未门控）。退出时通过屏幕切换 effect 清除高亮。
      if (input === '/') {
        // 立即捕获 scrollTop — 输入是预览，0 匹配会回到这里。
        // 同步 ref 写入，在栏的挂载 effect 调用 setSearchQuery 之前触发。
        jumpRef.current?.setAnchor();
        setSearchOpen(true);
        event.stopImmediatePropagation();
        return;
      }
      // 按住键批处理：tokenizer 合并为 'nnn'。与 ScrollKeybindingHandler.tsx
      // 中 modalPagerAction 相同的统一批处理模式。每个重复是一步
      // （n 不像 g 那样幂等）。
      const c = input[0];
      if ((c === 'n' || c === 'N') && input === c.repeat(input.length) && searchCount > 0) {
        const fn = c === 'n' ? jumpRef.current?.nextMatch : jumpRef.current?.prevMatch;
        if (fn) for (let i = 0; i < input.length; i++) fn();
        event.stopImmediatePropagation();
      }
    },
    // 搜索需要虚拟滚动（jumpRef 驱动 VirtualMessageList）。[
    // 会杀死它，所以 !dumpMode — [ 之后没有可跳转的内容。
    {
      isActive: screen === 'transcript' && virtualScrollActive && !searchOpen && !dumpMode,
    },
  );
  const { setQuery: setHighlight, scanElement, setPositions } = useSearchHighlight();

  // 调整大小 → 中止搜索。位置以 (msg, query, WIDTH) 为键 —
  // 宽度变化后缓存位置过期（新布局，新换行）。清除 searchQuery 触发 VML 的
  // setSearchQuery('')，清除 positionsCache + setPositions(null)。栏关闭。
  // 用户再次按 / → 全新开始。
  const transcriptCols = useTerminalSize().columns;
  const prevColsRef = React.useRef(transcriptCols);
  React.useEffect(() => {
    if (prevColsRef.current !== transcriptCols) {
      prevColsRef.current = transcriptCols;
      if (searchQuery || searchOpen) {
        setSearchOpen(false);
        setSearchQuery('');
        setSearchCount(0);
        setSearchCurrent(0);
        jumpRef.current?.disarmSearch();
        setHighlight('');
      }
    }
  }, [transcriptCols, searchQuery, searchOpen, setHighlight]);

  // Transcript 逃生通道。模态上下文中的裸字母（无 prompt 争抢输入）—
  // 与 ScrollKeybindingHandler 中 g/G/j/k 同类。
  useInput(
    (input, key, event) => {
      if (key.ctrl || key.meta) return;
      if (input === 'q') {
        // less：q 退出 pager。ctrl+o 切换；q 是血脉退出。
        handleExitTranscript();
        event.stopImmediatePropagation();
        return;
      }
      if (input === '[' && !dumpMode) {
        // 强制 dump-to-scrollback。也展开 + 解除上限 — dump 子集无意义。
        // Terminal/tmux cmd-F 现在能找到任何内容。此处守卫
        //（不在 isActive 内），所以 v 在 [ 之后仍然有效 —— dump 模式页脚
        // 在 ~4898 行接了 editorStatus，确认 v 仍应保持活跃。
        setDumpMode(true);
        setShowAllInTranscript(true);
        event.stopImmediatePropagation();
      } else if (input === 'v') {
        // less 风格：v 在 $VISUAL/$EDITOR 中打开文件。渲染完整 transcript
        // （与 /export 相同路径），写入 tmp，移交。
        // openFileInExternalEditor 处理终端编辑器的 alt-screen 挂起/恢复；
        // GUI 编辑器分离生成。
        event.stopImmediatePropagation();
        // 丢弃双击：渲染是异步的，完成前的第二次按下会运行第二次并行渲染
        // （双倍内存，两个临时文件，两个编辑器生成）。editorGenRef 仅守卫
        // transcript 退出陈旧性，不守卫同会话并发。
        if (editorRenderingRef.current) return;
        editorRenderingRef.current = true;
        // 捕获 generation + 创建陈旧感知的 setter。每次写入检查 gen
        // （transcript 退出会提升它 → 异步渲染的延迟写入静默）。
        const gen = editorGenRef.current;
        const setStatus = (s: string): void => {
          if (gen !== editorGenRef.current) return;
          clearTimeout(editorTimerRef.current);
          setEditorStatus(s);
        };
        setStatus(`rendering ${deferredMessages.length} messages…`);
        void (async () => {
          try {
            // 宽度 = 终端减去 vim 的行号边距（4 位数字 + 空格 + 余量）。
            // 下限 80。PassThrough 无 .columns，否则 Ink 默认为 80。
            // 尾部空格剥离：右对齐时间戳仍会在 EOL 留下 flexbox 间隔。
            // eslint-disable-next-line custom-rules/prefer-use-terminal-size -- 在按键时一次性求值，不是响应式渲染依赖
            const w = Math.max(80, (process.stdout.columns ?? 80) - 6);
            const raw = await renderMessagesToPlainText(deferredMessages, tools, w);
            const text = raw.replace(/[ \t]+$/gm, '');
            const path = join(tmpdir(), `cc-transcript-${Date.now()}.txt`);
            await writeFile(path, text);
            const opened = openFileInExternalEditor(path);
            setStatus(opened ? `opening ${path}` : `wrote ${path} · no $VISUAL/$EDITOR set`);
          } catch (e) {
            setStatus(`render failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          editorRenderingRef.current = false;
          if (gen !== editorGenRef.current) return;
          editorTimerRef.current = setTimeout(s => s(''), 4000, setEditorStatus);
        })();
      }
    },
    // !searchOpen：在搜索栏中输入 'v' 或 '[' 是搜索输入，而不是
    // 一个命令。此处无 !dumpMode — v 应该在 [ 之后工作（[ 处理器
    // 内联自守卫）。
    { isActive: screen === 'transcript' && virtualScrollActive && !searchOpen },
  );

  // 每次 transcript 进入都用全新 `less`。防止陈旧高亮匹配无关的 normal-mode
  // 文本（覆盖层是 alt-screen 全局的），避免重新进入时意外的 n/N。
  // 相同退出重置 [ dump 模式 — 每次 ctrl+o 进入都是全新实例。
  const inTranscript = screen === 'transcript' && virtualScrollActive;
  useEffect(() => {
    if (!inTranscript) {
      setSearchQuery('');
      setSearchCount(0);
      setSearchCurrent(0);
      setSearchOpen(false);
      editorGenRef.current++;
      clearTimeout(editorTimerRef.current);
      setDumpMode(false);
      setEditorStatus('');
    }
  }, [inTranscript]);
  useEffect(() => {
    setHighlight(inTranscript ? searchQuery : '');
    // 也清除基于位置的 CURRENT（黄色）覆盖层。setHighlight
    // 只清除基于扫描的反色。否则，ctrl-c 退出 transcript 后黄色框
    // 会保留在其最后的屏幕坐标。
    if (!inTranscript) setPositions(null);
  }, [inTranscript, searchQuery, setHighlight, setPositions]);

  const globalKeybindingProps = {
    screen,
    setScreen,
    showAllInTranscript,
    setShowAllInTranscript,
    messageCount: messages.length,
    onEnterTranscript: handleEnterTranscript,
    onExitTranscript: handleExitTranscript,
    virtualScrollActive,
    // 栏打开是模式（拥有按键 — j/k 输入，Esc 取消）。
    // 导航（query 已设置，栏关闭）不是 — Esc 退出 transcript，
    // 与 less q（高亮仍可见）相同。useSearchInput
    // 不 stopPropagation，所以没有此门控 transcript:exit
    // 会在取消栏的同一 Esc 上触发（子级先注册，先触发，冒泡）。
    searchBarOpen: searchOpen,
  };

  // 使用冻结长度切片数组，避免克隆的内存开销
  const transcriptMessages = frozenTranscriptState
    ? deferredMessages.slice(0, frozenTranscriptState.messagesLength)
    : deferredMessages;
  const transcriptStreamingToolUses = frozenTranscriptState
    ? streamingToolUses.slice(0, frozenTranscriptState.streamingToolUsesLength)
    : streamingToolUses;

  // 处理 shift+down 用于 teammate 导航和后台任务管理。
  // 当 local-jsx 对话框（如 /mcp）打开时守卫 onOpenBackgroundTasks —
  // 否则 Shift+Down 会在顶部堆叠 BackgroundTasksDialog 并死锁输入。
  // 第三种情况：pipes 活跃时 Shift+Down 切换 pipe IPC 选择器面板。
  useBackgroundTaskNavigation({
    onOpenBackgroundTasks: isShowingLocalJSXCommand ? undefined : () => setShowBashesDialog(true),
    onTogglePipeSelector: () => {
      setAppState((prev: any) => {
        const pIpc = prev.pipeIpc ?? {};
        return { ...prev, pipeIpc: { ...pIpc, selectorOpen: !pIpc.selectorOpen } };
      });
    },
  });
  // teammate 完成或出错时自动退出查看模式
  useTeammateViewAutoExit();

  // 获取查看的 agent 任务（从 selectors 内联以显式数据流）。
  // viewedAgentTask：teammate 或 local_agent — 驱动下面的布尔检查。
  // viewedTeammateTask：仅 teammate 收窄，用于 teammate 特定字段访问
  // （inProgressToolUseIDs）。
  const viewedTask = viewingAgentTaskId ? tasks[viewingAgentTaskId] : undefined;
  const viewedTeammateTask = viewedTask && isInProcessTeammateTask(viewedTask) ? viewedTask : undefined;
  const viewedAgentTask = viewedTeammateTask ?? (viewedTask && isLocalAgentTask(viewedTask) ? viewedTask : undefined);

  // streaming 文本显示时绕过 useDeferredValue，使 Messages 在 streaming 文本
  // 清除的同一帧渲染最终消息。非 loading 时也绕过 — deferredMessages 只在
  // streaming 期间重要（保持输入响应）；turn 结束后立即显示消息可防止
  // spinner 消失但答案尚未出现的抖动间隙。
  // 只有 reducedMotion 用户在 loading 期间保留延迟路径。
  const usesSyncMessages = showStreamingText || !isLoading;
  // 查看 agent 时，永不落入 leader — 在 bootstrap/stream 填充前为空。
  // 关闭 see-leader-type-agent 陷阱。
  const rawAgentMessages = viewedAgentTask?.messages;
  // Fork sidechain 将用户 prompt 编码在混合用户消息中，与 tool_result 块并列；
  // 将 prompt 作为独立气泡呈现，并从原始载体剥离样板文本，同时保留 tool_results。
  const displayedAgentMessages = useMemo(() => {
    if (!viewedAgentTask) return undefined;
    const agentMessages = rawAgentMessages ?? [];
    if (
      !isLocalAgentTask(viewedAgentTask) ||
      viewedAgentTask.agentType !== FORK_SUBAGENT_TYPE ||
      !viewedAgentTask.prompt
    ) {
      return agentMessages;
    }
    // 单次扫描：定位样板载体，检查 prompt 文本是否已存在于其他位置，
    // 并找到回退插入点（在最后一个父级 assistant tool_use 之后）。
    const trimmedPrompt = viewedAgentTask.prompt.trim();
    let boilerplateIndex = -1;
    let lastAssistantToolUseIndex = -1;
    let promptAlreadyRendered = false;
    for (let i = 0; i < agentMessages.length; i++) {
      const m = agentMessages[i]!;
      if (m.type === 'user' && Array.isArray(m.message?.content)) {
        const hasBoilerplate = m.message.content.some(isForkBoilerplateTextBlock);
        if (hasBoilerplate) {
          boilerplateIndex = i;
        } else if (!promptAlreadyRendered) {
          const firstText = m.message.content.find(b => b.type === 'text' && typeof b.text === 'string') as
            | { type: 'text'; text: string }
            | undefined;
          if (firstText && firstText.text.trim() === trimmedPrompt) promptAlreadyRendered = true;
        }
        continue;
      }
      if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
        if (m.message.content.some(b => b.type === 'tool_use')) lastAssistantToolUseIndex = i;
      }
    }

    const stripped =
      boilerplateIndex === -1
        ? agentMessages
        : agentMessages.map((m, i) => {
            if (i !== boilerplateIndex) return m;
            if (!Array.isArray(m.message?.content)) return m;
            return {
              ...m,
              message: {
                ...m.message,
                content: m.message.content.filter(b => !isForkBoilerplateTextBlock(b)),
              },
            };
          });

    if (promptAlreadyRendered) return stripped;

    const insertAt = boilerplateIndex !== -1 ? boilerplateIndex + 1 : lastAssistantToolUseIndex + 1;
    const synthetic = createUserMessage({
      content: viewedAgentTask.prompt,
      timestamp: new Date(viewedAgentTask.startTime).toISOString(),
    });
    return [...stripped.slice(0, insertAt), synthetic, ...stripped.slice(insertAt)];
  }, [viewedAgentTask, rawAgentMessages]);
  const displayedMessages = viewedAgentTask
    ? (displayedAgentMessages ?? [])
    : usesSyncMessages
      ? messages
      : deferredMessages;

  if (screen === 'transcript') {
    // 虚拟滚动取代了 30 条消息上限：一切都可滚动，内存由视口限制。
    // 没有它，将 transcript 包装在 ScrollBox 中会挂载所有消息（长会话约 250 MB —
    // 正是要解决的问题），所以 kill switch 和非全屏路径必须回退到传统渲染：
    // 无 alt screen，dump 到终端回滚，30 上限 + Ctrl+E。复用 scrollRef 是安全的
    // — normal-mode 和 transcript-mode 互斥（此早返回），所以同时只挂载一个
    // ScrollBox。
    const transcriptScrollRef = isFullscreenEnvEnabled() && !disableVirtualScroll && !dumpMode ? scrollRef : undefined;
    const transcriptMessagesElement = (
      <Messages
        messages={transcriptMessages}
        tools={tools}
        commands={commands}
        verbose={true}
        toolJSX={null}
        toolUseConfirmQueue={[]}
        inProgressToolUseIDs={inProgressToolUseIDs}
        isMessageSelectorVisible={false}
        conversationId={conversationId}
        screen={screen}
        agentDefinitions={agentDefinitions}
        streamingToolUses={transcriptStreamingToolUses}
        showAllInTranscript={showAllInTranscript}
        onOpenRateLimitOptions={handleOpenRateLimitOptions}
        isLoading={isLoading}
        hidePastThinking={true}
        streamingThinking={streamingThinking}
        scrollRef={transcriptScrollRef}
        jumpRef={jumpRef}
        onSearchMatchesChange={onSearchMatchesChange}
        scanElement={scanElement}
        setPositions={setPositions}
        disableRenderCap={dumpMode}
      />
    );
    const transcriptToolJSX = toolJSX && (
      <Box flexDirection="column" width="100%">
        {toolJSX.jsx}
      </Box>
    );
    const transcriptReturn = (
      <KeybindingSetup>
        <AnimatedTerminalTitle
          isAnimating={titleIsAnimating}
          title={terminalTitle}
          disabled={titleDisabled}
          noPrefix={showStatusInTerminalTab}
        />
        <GlobalKeybindingHandlers {...globalKeybindingProps} />
        {feature('VOICE_MODE') ? (
          <VoiceKeybindingHandler
            voiceHandleKeyEvent={voice.handleKeyEvent}
            stripTrailing={voice.stripTrailing}
            resetAnchor={voice.resetAnchor}
            isActive={!toolJSX?.isLocalJSXCommand}
          />
        ) : null}
        <CommandKeybindingHandlers onSubmit={onSubmit} isActive={!toolJSX?.isLocalJSXCommand} />
        {transcriptScrollRef ? (
          // ScrollKeybindingHandler 必须在 CancelRequestHandler 之前挂载，
          // 使 ctrl+c-with-selection 复制而非取消活跃任务。
          // 其原始 useInput 处理器仅在选择存在时 stopPropagation —
          // 没有选择时，ctrl+c 落入 CancelRequestHandler。
          <ScrollKeybindingHandler
            scrollRef={scrollRef}
            // modal 显示时将 wheel/ctrl+u/d 让给 UltraplanChoiceDialog 自己的
            // 滚动处理器。
            isActive={focusedInputDialog !== 'ultraplan-choice'}
            // g/G/j/k/ctrl+u/ctrl+d 会吞掉搜索栏想要的按键。
            // 搜索时关闭。
            isModal={!searchOpen}
            // 手动滚动退出搜索上下文 — 清除黄色当前匹配标记。
            // 位置以 (msg, rowOffset) 为键；j/k 改变 scrollTop 使
            // rowOffset 过期 → 错误的行变黄。下一次 n/N 通过 step()→jump()
            // 重新建立。
            onScroll={() => jumpRef.current?.disarmSearch()}
          />
        ) : null}
        <CancelRequestHandler {...cancelRequestProps} />
        {transcriptScrollRef ? (
          <FullscreenLayout
            scrollRef={scrollRef}
            scrollable={
              <>
                {transcriptMessagesElement}
                {transcriptToolJSX}
                <SandboxViolationExpandedView />
              </>
            }
            bottom={
              searchOpen ? (
                <TranscriptSearchBar
                  jumpRef={jumpRef}
                  // 尝试过 seed（c01578c8）— 破坏了 /hello 肌肉记忆
                  // （光标落在 'foo' 之后，/hello → foohello）。
                  // Cancel-restore 以不同方式处理 '不要丢失先前搜索'
                  // 的关注（onCancel 重新应用 searchQuery）。
                  initialQuery=""
                  count={searchCount}
                  current={searchCurrent}
                  onClose={q => {
                    // Enter — 提交。0 匹配守卫：垃圾 query 不应持久化
                    // （badge 隐藏，n/N 反正失效）。
                    setSearchQuery(searchCount > 0 ? q : '');
                    setSearchOpen(false);
                    // onCancel 路径：栏在其 useEffect([query]) 用 '' 触发之前
                    // 卸载。否则，searchCount 保持陈旧
                    //（:4956 的 n 守卫通过），VML 的 matches[] 也会
                    //（nextMatch 遍历旧数组）。幻影导航，无
                    // 高亮。onExit（Enter，q 非空）仍提交。
                    if (!q) {
                      setSearchCount(0);
                      setSearchCurrent(0);
                      jumpRef.current?.setSearchQuery('');
                    }
                  }}
                  onCancel={() => {
                    // Esc/ctrl+c/ctrl+g — 撤销。栏的 effect 最后一次以
                    // 输入的内容触发。searchQuery（REPL state）自 / 以来未变
                    // （onClose = 提交，未运行）。
                    // 两次 VML 调用：'' 恢复锚点（0 匹配 else 分支），
                    // 然后 searchQuery 从锚点的 nearest 重新扫描。两者同步 —
                    // 一次 React 批处理。
                    // 显式 setHighlight：REPL 的同步 effect 依赖是 searchQuery
                    // （未变），不会重新触发。
                    setSearchOpen(false);
                    jumpRef.current?.setSearchQuery('');
                    jumpRef.current?.setSearchQuery(searchQuery);
                    setHighlight(searchQuery);
                  }}
                  setHighlight={setHighlight}
                />
              ) : (
                <TranscriptModeFooter
                  showAllInTranscript={showAllInTranscript}
                  virtualScroll={true}
                  status={editorStatus || undefined}
                  searchBadge={
                    searchQuery && searchCount > 0 ? { current: searchCurrent, count: searchCount } : undefined
                  }
                />
              )
            }
          />
        ) : (
          <>
            {transcriptMessagesElement}
            {transcriptToolJSX}
            <SandboxViolationExpandedView />
            <TranscriptModeFooter
              showAllInTranscript={showAllInTranscript}
              virtualScroll={false}
              suppressShowAll={dumpMode}
              status={editorStatus || undefined}
            />
          </>
        )}
      </KeybindingSetup>
    );
    // 虚拟滚动分支（上面的 FullscreenLayout）需要
    // <AlternateScreen> 的 <Box height={rows}> 约束 — 没有它，
    // ScrollBox 的 flexGrow 无上限，视口 = 内容高度，
    // scrollTop 固定在 0，Ink 的屏幕缓冲区大小为完整间隔
    // （长会话 200×5k+ 行）。与下面 normal mode 的包装相同的根类型 + props，
    // 使 React 协调且 alt 缓冲区在切换时保持进入。
    // 30 上限 dump 分支保持不包装 — 它想要原生终端回滚。
    if (transcriptScrollRef) {
      return <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>{transcriptReturn}</AlternateScreen>;
    }
    return transcriptReturn;
  }

  // 在真实用户消息出现在 displayedMessages 之前显示占位符。
  // userInputOnProcessing 在整个 turn 期间保持设置
  // （在 resetLoadingState 中清除）；此长度检查在 displayedMessages
  // 增长超过提交时捕获的 baseline 后隐藏占位符。
  // 覆盖两个间隙：setMessages 被调用之前（processUserInput），以及
  // deferredMessages 落后于 messages 时。查看 agent 时抑制 —
  // 那里 displayedMessages 是不同的数组，且 onAgentSubmit 反正不用占位符。
  const placeholderText =
    userInputOnProcessing && !viewedAgentTask && displayedMessages.length <= userInputBaselineRef.current
      ? userInputOnProcessing
      : undefined;

  const toolPermissionOverlay =
    focusedInputDialog === 'tool-permission' ? (
      <PermissionRequest
        key={toolUseConfirmQueue[0]?.toolUseID}
        onDone={() => setToolUseConfirmQueue(([_, ...tail]) => tail)}
        onReject={handleQueuedCommandOnCancel}
        toolUseConfirm={toolUseConfirmQueue[0]!}
        toolUseContext={getToolUseContext(
          messages,
          messages,
          abortController ?? createAbortController(),
          mainLoopModel,
        )}
        verbose={verbose}
        workerBadge={toolUseConfirmQueue[0]?.workerBadge}
        setStickyFooter={isFullscreenEnvEnabled() ? setPermissionStickyFooter : undefined}
      />
    ) : null;

  // 窄终端：companion 折叠为单行，REPL 在自己的行上堆叠
  // （全屏中在输入上方，回滚中在下方），而非并排。
  // 宽终端保持行布局，sprite 在右侧。
  const companionNarrow = transcriptCols < MIN_COLS_FOR_FULL_SPRITE;
  // PromptInput 早返回 BackgroundTasksDialog 时隐藏 sprite。
  // sprite 作为 PromptInput 的行兄弟，所以对话框的 Pane 分隔线以
  // useTerminalSize() 宽度绘制但只得到 terminalWidth - spriteWidth —
  // 分隔线提前停止，对话框文本提前换行。
  // 不检查 footerSelection：pill FOCUS（下箭头到 tasks pill）必须保持
  // sprite 可见，使右箭头能导航到它。
  const companionVisible = !toolJSX?.shouldHidePromptInput && !focusedInputDialog && !showBashesDialog;

  // 全屏中，所有 local-jsx slash 命令浮动在 modal 槽位 —
  // FullscreenLayout 将它们包装在绝对定位的底部锚定窗格中
  // （▔ 分隔线，ModalContext）。内部的 Pane/Dialog 检测上下文并跳过自己的
  // 顶级框架。非全屏保留下面的内联渲染路径。过去通过底部路由的命令
  //（immediate：/model、/mcp、/btw……）和 scrollable（非 immediate：
  // /config、/theme、/diff……）现在都走这里。
  const toolJsxCentered = isFullscreenEnvEnabled() && toolJSX?.isLocalJSXCommand === true;
  const centeredModal: React.ReactNode = toolJsxCentered ? toolJSX!.jsx : null;
  // 根节点 <AlternateScreen>：下方所有内容都在其
  // <Box height={rows}> 内。Handlers/contexts 高度为零，所以 ScrollBox 的
  // FullscreenLayout 中的 flexGrow 针对此 Box 解析。上面 transcript
  // 早返回以相同方式包装其虚拟滚动分支；只有 30 上限 dump 分支保持不包装
  // 用于原生终端回滚。

  const mainReturn = (
    <KeybindingSetup>
      <AnimatedTerminalTitle
        isAnimating={titleIsAnimating}
        title={terminalTitle}
        disabled={titleDisabled}
        noPrefix={showStatusInTerminalTab}
      />
      <GlobalKeybindingHandlers {...globalKeybindingProps} />
      {feature('VOICE_MODE') ? (
        <VoiceKeybindingHandler
          voiceHandleKeyEvent={voice.handleKeyEvent}
          stripTrailing={voice.stripTrailing}
          resetAnchor={voice.resetAnchor}
          isActive={!toolJSX?.isLocalJSXCommand}
        />
      ) : null}
      <CommandKeybindingHandlers onSubmit={onSubmit} isActive={!toolJSX?.isLocalJSXCommand} />
      {/* ScrollKeybindingHandler 必须在 CancelRequestHandler 之前挂载，
          使 ctrl+c-with-selection 复制而非取消活跃任务。
          其原始 useInput 处理器仅在选择存在时 stopPropagation —
          没有选择时，ctrl+c 落入 CancelRequestHandler。
          PgUp/PgDn/wheel 始终滚动 modal 后面的 transcript —
          modal 的内部 ScrollBox 不是键盘驱动的。modal 显示时
          onScroll 保持抑制，使滚动不盖戳分隔线/pill 状态。 */}
      <ScrollKeybindingHandler
        scrollRef={scrollRef}
        isActive={
          isFullscreenEnvEnabled() &&
          (centeredModal != null || !focusedInputDialog || focusedInputDialog === 'tool-permission')
        }
        onScroll={composedOnScroll}
      />
      {feature('MESSAGE_ACTIONS') && isFullscreenEnvEnabled() && !disableMessageActions ? (
        <MessageActionsKeybindings handlers={messageActionHandlers} isActive={cursor !== null} />
      ) : null}
      <CancelRequestHandler {...cancelRequestProps} />
      <MCPConnectionManager key={remountKey} dynamicMcpConfig={dynamicMcpConfig} isStrictMcpConfig={strictMcpConfig}>
        <FullscreenLayout
          scrollRef={scrollRef}
          overlay={toolPermissionOverlay}
          bottomFloat={
            feature('BUDDY') && companionVisible && !companionNarrow ? <CompanionFloatingBubble /> : undefined
          }
          modal={centeredModal}
          modalScrollRef={modalScrollRef}
          dividerYRef={dividerYRef}
          hidePill={!!viewedAgentTask}
          hideSticky={!!viewedTeammateTask}
          newMessageCount={unseenDivider?.count ?? 0}
          onPillClick={() => {
            setCursor(null);
            jumpToNew(scrollRef.current);
          }}
          scrollable={
            <>
              <TeammateViewHeader />
              <Messages
                messages={displayedMessages}
                tools={tools}
                commands={commands}
                verbose={verbose}
                toolJSX={toolJSX}
                toolUseConfirmQueue={toolUseConfirmQueue}
                inProgressToolUseIDs={
                  viewedTeammateTask ? (viewedTeammateTask.inProgressToolUseIDs ?? new Set()) : inProgressToolUseIDs
                }
                isMessageSelectorVisible={isMessageSelectorVisible}
                conversationId={conversationId}
                screen={screen}
                streamingToolUses={streamingToolUses}
                showAllInTranscript={showAllInTranscript}
                agentDefinitions={agentDefinitions}
                onOpenRateLimitOptions={handleOpenRateLimitOptions}
                isLoading={isLoading}
                streamingText={isLoading && !viewedAgentTask ? visibleStreamingText : null}
                isBriefOnly={viewedAgentTask ? false : isBriefOnly}
                unseenDivider={viewedAgentTask ? undefined : unseenDivider}
                scrollRef={isFullscreenEnvEnabled() ? scrollRef : undefined}
                trackStickyPrompt={isFullscreenEnvEnabled() ? true : undefined}
                cursor={cursor}
                setCursor={setCursor}
                cursorNavRef={cursorNavRef}
              />
              <AwsAuthStatusBox />
              {/* modal 显示时隐藏处理中占位符 —
                  否则它会位于 ▔ 分隔线上方最后一个可见 transcript 行，
                  显示 "❯ /config" 作为冗余杂乱（modal 就是 /config UI）。
                  modal 外保持，使用户在 Claude 处理时看到其输入回显。 */}
              {!disabled && placeholderText && !centeredModal && (
                <UserTextMessage param={{ text: placeholderText, type: 'text' }} addMargin={true} verbose={verbose} />
              )}
              {toolJSX && !(toolJSX.isLocalJSXCommand && toolJSX.isImmediate) && !toolJsxCentered && (
                <Box flexDirection="column" width="100%">
                  {toolJSX.jsx}
                </Box>
              )}
              {process.env.USER_TYPE === 'ant' && <TungstenLiveMonitor />}
              {/* WebBrowserPanel 已移除 — browser-lite，无面板 */}
              <Box flexGrow={1} />
              {showSpinner && (
                <SpinnerWithVerb
                  mode={streamMode}
                  spinnerTip={spinnerTip}
                  responseLengthRef={responseLengthRef}
                  apiMetricsRef={apiMetricsRef}
                  overrideMessage={spinnerMessage}
                  spinnerSuffix={stopHookSpinnerSuffix}
                  verbose={verbose}
                  loadingStartTimeRef={loadingStartTimeRef}
                  totalPausedMsRef={totalPausedMsRef}
                  pauseStartTimeRef={pauseStartTimeRef}
                  overrideColor={spinnerColor}
                  overrideShimmerColor={spinnerShimmerColor}
                  hasActiveTools={inProgressToolUseIDs.size > 0}
                  leaderIsIdle={!isLoading}
                />
              )}
              {!showSpinner &&
                !isLoading &&
                !userInputOnProcessing &&
                !hasRunningTeammates &&
                isBriefOnly &&
                !viewedAgentTask && <BriefIdleStatus />}
            </>
          }
          bottom={
            <Box
              flexDirection={feature('BUDDY') && companionNarrow ? 'column' : 'row'}
              width="100%"
              alignItems={feature('BUDDY') && companionNarrow ? undefined : 'flex-end'}
            >
              {feature('BUDDY') && companionNarrow && isFullscreenEnvEnabled() && companionVisible ? (
                <CompanionSprite />
              ) : null}
              <Box flexDirection="column" flexGrow={1}>
                {isFullscreenEnvEnabled() && <PromptInputQueuedCommands />}
                {permissionStickyFooter}
                {/* 立即 local-jsx 命令（/btw、/sandbox、/assistant、
                  /issue）在此渲染，不在 scrollable 内。它们在主会话流式传输
                  到后面时保持挂载，所以 ScrollBox 在每条新消息上重新布局会拖动它们。
                  bottom 是 ScrollBox 外的 flexShrink={0} — 它永不移动。
                  非立即 local-jsx（/diff、/status、/theme，约 40 个）保持在
                  scrollable 中：主循环暂停所以无抖动，且其高内容
                  （DiffDetailView 渲染最多 400 行无内部滚动）需要外部 ScrollBox。 */}
                {toolJSX?.isLocalJSXCommand && toolJSX.isImmediate && !toolJsxCentered && (
                  <Box flexDirection="column" width="100%">
                    {toolJSX.jsx}
                  </Box>
                )}
                {!showSpinner && !toolJSX?.isLocalJSXCommand && showExpandedTodos && tasksV2 && tasksV2.length > 0 && (
                  <Box width="100%" flexDirection="column">
                    <TaskListV2 tasks={tasksV2} isStandalone={true} />
                  </Box>
                )}
                {focusedInputDialog === 'sandbox-permission' && (
                  <SandboxPermissionRequest
                    key={sandboxPermissionRequestQueue[0]!.hostPattern.host}
                    hostPattern={sandboxPermissionRequestQueue[0]!.hostPattern}
                    onUserResponse={(response: { allow: boolean; persistToSettings: boolean }) => {
                      const { allow, persistToSettings } = response;
                      const currentRequest = sandboxPermissionRequestQueue[0];
                      if (!currentRequest) return;

                      const approvedHost = currentRequest.hostPattern.host;

                      if (persistToSettings) {
                        const update = {
                          type: 'addRules' as const,
                          rules: [
                            {
                              toolName: WEB_FETCH_TOOL_NAME,
                              ruleContent: `domain:${approvedHost}`,
                            },
                          ],
                          behavior: (allow ? 'allow' : 'deny') as 'allow' | 'deny',
                          destination: 'localSettings' as const,
                        };

                        setAppState(prev => ({
                          ...prev,
                          toolPermissionContext: applyPermissionUpdate(prev.toolPermissionContext, update),
                        }));

                        persistPermissionUpdate(update);

                        // 立即更新 sandbox 内存配置以防止竞态条件，
                        // 即待处理请求在检测到设置变化之前溜过
                        SandboxManager.refreshConfig();
                      }

                      // 解决同一 host 的所有挂起请求（不仅仅是第一个）
                      // 这处理了同一 domain 收到多个并行请求的情况
                      setSandboxPermissionRequestQueue(queue => {
                        queue
                          .filter(item => item.hostPattern.host === approvedHost)
                          .forEach(item => item.resolvePromise(allow));
                        return queue.filter(item => item.hostPattern.host !== approvedHost);
                      });

                      // 清理 bridge 订阅并取消此 host 的远程提示，
                      // 因为本地用户已响应。
                      const cleanups = sandboxBridgeCleanupRef.current.get(approvedHost);
                      if (cleanups) {
                        for (const fn of cleanups) {
                          fn();
                        }
                        sandboxBridgeCleanupRef.current.delete(approvedHost);
                      }
                    }}
                  />
                )}
                {focusedInputDialog === 'prompt' && (
                  <PromptDialog
                    key={promptQueue[0]!.request.prompt}
                    title={promptQueue[0]!.title}
                    toolInputSummary={promptQueue[0]!.toolInputSummary}
                    request={promptQueue[0]!.request}
                    onRespond={selectedKey => {
                      const item = promptQueue[0];
                      if (!item) return;
                      item.resolve({
                        prompt_response: item.request.prompt,
                        selected: selectedKey,
                      });
                      setPromptQueue(([, ...tail]) => tail);
                    }}
                    onAbort={() => {
                      const item = promptQueue[0];
                      if (!item) return;
                      item.reject(new Error('Prompt cancelled by user'));
                      setPromptQueue(([, ...tail]) => tail);
                    }}
                  />
                )}
                {/* 等待 leader 审批时在 worker 上显示待处理指示器 */}
                {pendingWorkerRequest && (
                  <WorkerPendingPermission
                    toolName={pendingWorkerRequest.toolName}
                    description={pendingWorkerRequest.description}
                  />
                )}
                {/* 在 worker 侧为 sandbox 权限显示待处理指示器 */}
                {pendingSandboxRequest && (
                  <WorkerPendingPermission
                    toolName="Network Access"
                    description={`Waiting for leader to approve network access to ${pendingSandboxRequest.host}`}
                  />
                )}
                {/* 来自 swarm worker 的 worker sandbox 权限请求 */}
                {focusedInputDialog === 'worker-sandbox-permission' && (
                  <SandboxPermissionRequest
                    key={workerSandboxPermissions.queue[0]!.requestId}
                    hostPattern={
                      {
                        host: workerSandboxPermissions.queue[0]!.host,
                        port: undefined,
                      } as NetworkHostPattern
                    }
                    onUserResponse={(response: { allow: boolean; persistToSettings: boolean }) => {
                      const { allow, persistToSettings } = response;
                      const currentRequest = workerSandboxPermissions.queue[0];
                      if (!currentRequest) return;

                      const approvedHost = currentRequest.host;

                      // 通过 mailbox 向 worker 发送响应
                      void sendSandboxPermissionResponseViaMailbox(
                        currentRequest.workerName,
                        currentRequest.requestId,
                        approvedHost,
                        allow,
                        teamContext?.teamName,
                      );

                      if (persistToSettings && allow) {
                        const update = {
                          type: 'addRules' as const,
                          rules: [
                            {
                              toolName: WEB_FETCH_TOOL_NAME,
                              ruleContent: `domain:${approvedHost}`,
                            },
                          ],
                          behavior: 'allow' as const,
                          destination: 'localSettings' as const,
                        };

                        setAppState(prev => ({
                          ...prev,
                          toolPermissionContext: applyPermissionUpdate(prev.toolPermissionContext, update),
                        }));

                        persistPermissionUpdate(update);
                        SandboxManager.refreshConfig();
                      }

                      // 从队列移除
                      setAppState(prev => ({
                        ...prev,
                        workerSandboxPermissions: {
                          ...prev.workerSandboxPermissions,
                          queue: prev.workerSandboxPermissions.queue.slice(1),
                        },
                      }));
                    }}
                  />
                )}
                {focusedInputDialog === 'elicitation' && (
                  <ElicitationDialog
                    key={elicitation.queue[0]!.serverName + ':' + String(elicitation.queue[0]!.requestId)}
                    event={elicitation.queue[0]!}
                    onResponse={(action, content) => {
                      const currentRequest = elicitation.queue[0];
                      if (!currentRequest) return;
                      // 调用 respond 回调解决 Promise
                      currentRequest.respond({ action, content });
                      // URL 接受，保留在队列中等第二阶段
                      const isUrlAccept = currentRequest.params.mode === 'url' && action === 'accept';
                      if (!isUrlAccept) {
                        setAppState(prev => ({
                          ...prev,
                          elicitation: {
                            queue: prev.elicitation.queue.slice(1),
                          },
                        }));
                      }
                    }}
                    onWaitingDismiss={action => {
                      const currentRequest = elicitation.queue[0];
                      // 从队列移除
                      setAppState(prev => ({
                        ...prev,
                        elicitation: {
                          queue: prev.elicitation.queue.slice(1),
                        },
                      }));
                      currentRequest?.onWaitingDismiss?.(action);
                    }}
                  />
                )}
                {focusedInputDialog === 'cost' && (
                  <CostThresholdDialog
                    onDone={() => {
                      setShowCostDialog(false);
                      setHaveShownCostDialog(true);
                      saveGlobalConfig(current => ({
                        ...current,
                        hasAcknowledgedCostThreshold: true,
                      }));
                      logEvent('tengu_cost_threshold_acknowledged', {});
                    }}
                  />
                )}
                {focusedInputDialog === 'idle-return' && idleReturnPending && (
                  <IdleReturnDialog
                    idleMinutes={idleReturnPending.idleMinutes}
                    totalInputTokens={getTotalInputTokens()}
                    onDone={async action => {
                      const pending = idleReturnPending;
                      setIdleReturnPending(null);
                      logEvent('tengu_idle_return_action', {
                        action: action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                        idleMinutes: Math.round(pending.idleMinutes),
                        messageCount: messagesRef.current.length,
                        totalInputTokens: getTotalInputTokens(),
                      });
                      if (action === 'dismiss') {
                        setInputValue(pending.input);
                        return;
                      }
                      if (action === 'never') {
                        saveGlobalConfig(current => {
                          if (current.idleReturnDismissed) return current;
                          return { ...current, idleReturnDismissed: true };
                        });
                      }
                      if (action === 'clear') {
                        const { clearConversation } = await import('../commands/clear/conversation.js');
                        await clearConversation({
                          setMessages,
                          readFileState: readFileState.current,
                          discoveredSkillNames: discoveredSkillNamesRef.current,
                          loadedNestedMemoryPaths: loadedNestedMemoryPathsRef.current,
                          getAppState: () => store.getState(),
                          setAppState,
                          setConversationId,
                        });
                        haikuTitleAttemptedRef.current = false;
                        setHaikuTitle(undefined);
                        bashTools.current.clear();
                        bashToolsProcessedIdx.current = 0;
                      }
                      skipIdleCheckRef.current = true;
                      void onSubmitRef.current(pending.input, {
                        setCursorOffset: () => {},
                        clearBuffer: () => {},
                        resetHistory: () => {},
                      });
                    }}
                  />
                )}
                {focusedInputDialog === 'ide-onboarding' && (
                  <IdeOnboardingDialog
                    onDone={() => setShowIdeOnboarding(false)}
                    installationStatus={ideInstallationStatus}
                  />
                )}
                {process.env.USER_TYPE === 'ant' && focusedInputDialog === 'model-switch' && AntModelSwitchCallout && (
                  <AntModelSwitchCallout
                    onDone={(selection: string, modelAlias?: string) => {
                      setShowModelSwitchCallout(false);
                      if (selection === 'switch' && modelAlias) {
                        setAppState(prev => ({
                          ...prev,
                          mainLoopModel: modelAlias,
                          mainLoopModelForSession: null,
                        }));
                      }
                    }}
                  />
                )}
                {process.env.USER_TYPE === 'ant' &&
                  focusedInputDialog === 'undercover-callout' &&
                  UndercoverAutoCallout && <UndercoverAutoCallout onDone={() => setShowUndercoverCallout(false)} />}
                {focusedInputDialog === 'effort-callout' && (
                  <EffortCallout
                    model={mainLoopModel}
                    onDone={selection => {
                      setShowEffortCallout(false);
                      if (selection !== 'dismiss') {
                        setAppState(prev => ({
                          ...prev,
                          effortValue: selection,
                        }));
                      }
                    }}
                  />
                )}
                {focusedInputDialog === 'remote-callout' && (
                  <RemoteCallout
                    onDone={selection => {
                      setAppState(prev => {
                        if (!prev.showRemoteCallout) return prev;
                        return {
                          ...prev,
                          showRemoteCallout: false,
                          ...(selection === 'enable' && {
                            replBridgeEnabled: true,
                            replBridgeExplicit: true,
                            replBridgeOutboundOnly: false,
                          }),
                        };
                      });
                    }}
                  />
                )}

                {exitFlow}

                {focusedInputDialog === 'plugin-hint' && hintRecommendation && (
                  <PluginHintMenu
                    pluginName={hintRecommendation.pluginName}
                    pluginDescription={hintRecommendation.pluginDescription}
                    marketplaceName={hintRecommendation.marketplaceName}
                    sourceCommand={hintRecommendation.sourceCommand}
                    onResponse={handleHintResponse}
                  />
                )}

                {focusedInputDialog === 'search-extra-tools-hint' && searchExtraToolsHint.visible && (
                  <SearchExtraToolsHint
                    tools={searchExtraToolsHint.tools}
                    onSelect={searchExtraToolsHint.handleSelect}
                    onDismiss={searchExtraToolsHint.handleDismiss}
                  />
                )}

                {focusedInputDialog === 'lsp-recommendation' && lspRecommendation && (
                  <LspRecommendationMenu
                    pluginName={lspRecommendation.pluginName}
                    pluginDescription={lspRecommendation.pluginDescription}
                    fileExtension={lspRecommendation.fileExtension}
                    onResponse={handleLspResponse}
                  />
                )}

                {focusedInputDialog === 'desktop-upsell' && (
                  <DesktopUpsellStartup onDone={() => setShowDesktopUpsellStartup(false)} />
                )}

                {feature('ULTRAPLAN')
                  ? focusedInputDialog === 'ultraplan-choice' &&
                    ultraplanPendingChoice && (
                      <UltraplanChoiceDialog
                        plan={ultraplanPendingChoice.plan}
                        sessionId={ultraplanPendingChoice.sessionId}
                        taskId={ultraplanPendingChoice.taskId}
                        setMessages={setMessages}
                        readFileState={readFileState.current}
                        getAppState={() => store.getState()}
                        setConversationId={setConversationId}
                      />
                    )
                  : null}

                {feature('ULTRAPLAN')
                  ? focusedInputDialog === 'ultraplan-launch' &&
                    ultraplanLaunchPending && (
                      <UltraplanLaunchDialog
                        onChoice={(choice, opts) => {
                          const blurb = ultraplanLaunchPending.blurb;
                          setAppState(prev =>
                            prev.ultraplanLaunchPending ? { ...prev, ultraplanLaunchPending: undefined } : prev,
                          );
                          if (choice === 'cancel') return;
                          // 命令的 onDone 使用了 display:'skip'，所以在此
                          // 添加回显 — 在异步之前提供即时反馈
                          // （约 5s teleportToRemote 解决）。
                          setMessages(prev => [
                            ...prev,
                            createCommandInputMessage(formatCommandInputTags('ultraplan', blurb)),
                          ]);
                          const appendStdout = (msg: string) =>
                            setMessages(prev => [
                              ...prev,
                              createCommandInputMessage(
                                `<${LOCAL_COMMAND_STDOUT_TAG}>${escapeXml(msg)}</${LOCAL_COMMAND_STDOUT_TAG}>`,
                              ),
                            ]);
                          // 如果 query 正在进行，延迟第二条消息，
                          // 使它在 assistant 回复之后落地，而非
                          // 在用户 prompt 和回复之间。
                          const appendWhenIdle = (msg: string) => {
                            if (!queryGuard.isActive) {
                              appendStdout(msg);
                              return;
                            }
                            const unsub = queryGuard.subscribe(() => {
                              if (queryGuard.isActive) return;
                              unsub();
                              // 如果用户在我们等待时停止了 ultraplan 则跳过 —
                              // 避免为已消失的会话显示陈旧的 "Monitoring
                              // <url>" 消息。
                              if (!store.getState().ultraplanSessionUrl) return;
                              appendStdout(msg);
                            });
                          };
                          void launchUltraplan({
                            blurb,
                            promptIdentifier: opts?.promptIdentifier,
                            getAppState: () => store.getState(),
                            setAppState,
                            signal: createAbortController().signal,
                            disconnectedBridge: opts?.disconnectedBridge,
                            onSessionReady: appendWhenIdle,
                          })
                            .then(appendStdout)
                            .catch(logError);
                        }}
                      />
                    )
                  : null}

                {mrRender()}

                {!toolJSX?.shouldHidePromptInput && !focusedInputDialog && !isExiting && !disabled && !cursor && (
                  <>
                    {autoRunIssueReason && (
                      <AutoRunIssueNotification
                        onRun={handleAutoRunIssue}
                        onCancel={handleCancelAutoRunIssue}
                        reason={getAutoRunIssueReasonText(autoRunIssueReason)}
                      />
                    )}
                    {postCompactSurvey.state !== 'closed' ? (
                      <FeedbackSurvey
                        state={postCompactSurvey.state}
                        lastResponse={postCompactSurvey.lastResponse}
                        handleSelect={postCompactSurvey.handleSelect}
                        inputValue={inputValue}
                        setInputValue={setInputValue}
                        onRequestFeedback={handleSurveyRequestFeedback}
                      />
                    ) : memorySurvey.state !== 'closed' ? (
                      <FeedbackSurvey
                        state={memorySurvey.state}
                        lastResponse={memorySurvey.lastResponse}
                        handleSelect={memorySurvey.handleSelect}
                        handleTranscriptSelect={memorySurvey.handleTranscriptSelect}
                        inputValue={inputValue}
                        setInputValue={setInputValue}
                        onRequestFeedback={handleSurveyRequestFeedback}
                        message="How well did Claude use its memory? (optional)"
                      />
                    ) : (
                      <FeedbackSurvey
                        state={feedbackSurvey.state}
                        lastResponse={feedbackSurvey.lastResponse}
                        handleSelect={feedbackSurvey.handleSelect}
                        handleTranscriptSelect={feedbackSurvey.handleTranscriptSelect}
                        inputValue={inputValue}
                        setInputValue={setInputValue}
                        onRequestFeedback={didAutoRunIssueRef.current ? undefined : handleSurveyRequestFeedback}
                      />
                    )}
                    {/* 挫败感触发的 transcript 分享 prompt */}
                    {frustrationDetection.state !== 'closed' && (
                      <FeedbackSurvey
                        state={frustrationDetection.state}
                        lastResponse={null}
                        handleSelect={() => {}}
                        handleTranscriptSelect={frustrationDetection.handleTranscriptSelect}
                        inputValue={inputValue}
                        setInputValue={setInputValue}
                      />
                    )}
                    {/* Skill 改进调查 - 检测到改进时出现 */}
                    {skillImprovementSurvey.suggestion && (
                      <SkillImprovementSurvey
                        isOpen={skillImprovementSurvey.isOpen}
                        skillName={skillImprovementSurvey.suggestion.skillName}
                        updates={skillImprovementSurvey.suggestion.updates}
                        handleSelect={skillImprovementSurvey.handleSelect}
                        inputValue={inputValue}
                        setInputValue={setInputValue}
                      />
                    )}
                    {showIssueFlagBanner && <IssueFlagBanner />}
                    {}
                    <PromptInput
                      debug={debug}
                      ideSelection={ideSelection}
                      hasSuppressedDialogs={!!hasSuppressedDialogs}
                      isLocalJSXCommandActive={isShowingLocalJSXCommand}
                      getToolUseContext={getToolUseContext}
                      toolPermissionContext={toolPermissionContext}
                      setToolPermissionContext={setToolPermissionContext}
                      apiKeyStatus={apiKeyStatus}
                      commands={commands}
                      agents={agentDefinitions.activeAgents}
                      isLoading={isLoading}
                      onExit={handleExit}
                      verbose={verbose}
                      messages={messages}
                      onAutoUpdaterResult={setAutoUpdaterResult}
                      autoUpdaterResult={autoUpdaterResult}
                      input={inputValue}
                      onInputChange={setInputValue}
                      mode={inputMode}
                      onModeChange={setInputMode}
                      stashedPrompt={stashedPrompt}
                      setStashedPrompt={setStashedPrompt}
                      submitCount={submitCount}
                      onShowMessageSelector={handleShowMessageSelector}
                      onMessageActionsEnter={
                        // 在 isLoading 期间也生效 — edit 会先取消；uuid 选择在 append 后依然存活。
                        feature('MESSAGE_ACTIONS') && isFullscreenEnvEnabled() && !disableMessageActions
                          ? enterMessageActions
                          : undefined
                      }
                      mcpClients={mcpClients}
                      pastedContents={pastedContents}
                      setPastedContents={setPastedContents}
                      vimMode={vimMode}
                      setVimMode={setVimMode}
                      showBashesDialog={showBashesDialog}
                      setShowBashesDialog={setShowBashesDialog}
                      onSubmit={onSubmit}
                      onAgentSubmit={onAgentSubmit}
                      isSearchingHistory={isSearchingHistory}
                      setIsSearchingHistory={setIsSearchingHistory}
                      helpOpen={isHelpOpen}
                      setHelpOpen={setIsHelpOpen}
                      insertTextRef={feature('VOICE_MODE') ? insertTextRef : undefined}
                      voiceInterimRange={voice.interimRange}
                    />
                    <SessionBackgroundHint onBackgroundSession={handleBackgroundSession} isLoading={isLoading} />
                    <BackgroundAgentSelector />
                  </>
                )}
                {cursor && (
                  // inputValue 是 REPL 状态；已输入文本在往返后仍然保留。
                  <MessageActionsBar cursor={cursor} />
                )}
                {focusedInputDialog === 'message-selector' && (
                  <MessageSelector
                    messages={messages}
                    preselectedMessage={messageSelectorPreselect}
                    onPreRestore={onCancel}
                    onRestoreCode={async (message: UserMessage) => {
                      await fileHistoryRewind((updater: (prev: FileHistoryState) => FileHistoryState) => {
                        setAppState(prev => ({
                          ...prev,
                          fileHistory: updater(prev.fileHistory),
                        }));
                      }, message.uuid);
                    }}
                    onSummarize={async (
                      message: UserMessage,
                      feedback?: string,
                      direction: PartialCompactDirection = 'from',
                    ) => {
                      // 投射被 snip 的消息，这样 compact 模型
                      // 就不会总结那些被刻意移除的内容。
                      const compactMessages = getMessagesAfterCompactBoundary(messages);

                      const messageIndex = compactMessages.indexOf(message);
                      if (messageIndex === -1) {
                        // 选中了一条被 snip 或 compact 之前的消息，
                        // 而选择器仍然显示它（REPL 保留完整历史用于
                        // 滚动回看）。说明为什么没有发生任何事情，
                        // 而不是静默地什么也不做。
                        setMessages(prev => [
                          ...prev,
                          createSystemMessage(
                            'That message is no longer in the active context (snipped or pre-compact). Choose a more recent message.',
                            'warning',
                          ),
                        ]);
                        return;
                      }

                      const newAbortController = createAbortController();
                      const context = getToolUseContext(compactMessages, [], newAbortController, mainLoopModel);

                      const appState = context.getAppState();
                      const defaultSysPrompt = await getSystemPrompt(
                        context.options.tools,
                        context.options.mainLoopModel,
                        Array.from(appState.toolPermissionContext.additionalWorkingDirectories.keys()),
                        context.options.mcpClients,
                      );
                      const systemPrompt = buildEffectiveSystemPrompt({
                        mainThreadAgentDefinition: undefined,
                        toolUseContext: context,
                        customSystemPrompt: context.options.customSystemPrompt,
                        defaultSystemPrompt: defaultSysPrompt,
                        appendSystemPrompt: context.options.appendSystemPrompt,
                      });
                      const [userContext, systemContext] = await Promise.all([getUserContext(), getSystemContext()]);

                      const result = await partialCompactConversation(
                        compactMessages,
                        messageIndex,
                        context,
                        {
                          systemPrompt,
                          userContext,
                          systemContext,
                          toolUseContext: context,
                          forkContextMessages: compactMessages,
                        },
                        feedback,
                        direction,
                      );

                      const kept = result.messagesToKeep ?? [];
                      const ordered =
                        direction === 'up_to'
                          ? [...result.summaryMessages, ...kept]
                          : [...kept, ...result.summaryMessages];
                      const postCompact = [
                        result.boundaryMarker,
                        ...ordered,
                        ...result.attachments,
                        ...result.hookResults,
                      ];
                      // 全屏 'from' 保留 scrollback；'up_to' 不能保留
                      // （old[0] 未改变 + 数组增长意味着走增量
                      // useLogMessages 路径，所以边界从未持久化）。
                      // 通过 uuid 查找，因为 old 是原始 REPL 历史，被 snip 的
                      // 条目可能使投射出的 messageIndex 发生偏移。
                      if (isFullscreenEnvEnabled() && direction === 'from') {
                        setMessages(old => {
                          const rawIdx = old.findIndex(m => m.uuid === message.uuid);
                          return [...old.slice(0, rawIdx === -1 ? 0 : rawIdx), ...postCompact];
                        });
                      } else {
                        setMessages(postCompact);
                      }
                      // 部分压缩绕过了 handleMessageFromStream —— 清除
                      // context-blocked 标志，让 proactive tick 继续运行。
                      if (feature('PROACTIVE') || feature('KAIROS')) {
                        proactiveModule?.setContextBlocked(false);
                      }
                      setConversationId(randomUUID());
                      runPostCompactCleanup(context.options.querySource);

                      if (direction === 'from') {
                        const r = textForResubmit(message);
                        if (r) {
                          setInputValue(r.text);
                          setInputMode(r.mode);
                        }
                      }

                      // 显示带 ctrl+o 提示的通知
                      const historyShortcut = getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o');
                      addNotification({
                        key: 'summarize-ctrl-o-hint',
                        text: `Conversation summarized (${historyShortcut} for history)`,
                        priority: 'medium',
                        timeoutMs: 8000,
                      });
                    }}
                    onRestoreMessage={handleRestoreMessage}
                    onClose={() => {
                      setIsMessageSelectorVisible(false);
                      setMessageSelectorPreselect(undefined);
                    }}
                  />
                )}
                {process.env.USER_TYPE === 'ant' && <DevBar />}
              </Box>
              {feature('BUDDY') && !(companionNarrow && isFullscreenEnvEnabled()) && companionVisible ? (
                <CompanionSprite />
              ) : null}
            </Box>
          }
        />
      </MCPConnectionManager>
    </KeybindingSetup>
  );
  if (isFullscreenEnvEnabled()) {
    return <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>{mainReturn}</AlternateScreen>;
  }
  return mainReturn;
}
