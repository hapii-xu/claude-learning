// 这些副作用必须先于所有其他 import 运行：
// 1. profileCheckpoint 在重量级模块求值开始前标记入口
// 2. startMdmRawRead 触发 MDM 子进程（plutil/reg query），让它们与
//    下面剩余约 ~135ms 的 import 并行运行
// 3. startKeychainPrefetch 同时触发两次 macOS keychain 读取（OAuth + 旧版 API
//    key）—— 否则 isRemoteManagedSettingsEligible() 会在
//    applySafeConfigEnvironmentVariables() 内部通过同步 spawn 顺序读取
//    （每次 macOS 启动约 ~65ms）
import { profileCheckpoint, profileReport } from './utils/startupProfiler.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
profileCheckpoint('main_tsx_entry');

import { startMdmRawRead } from './utils/settings/mdm/rawRead.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
startMdmRawRead();

import { ensureKeychainPrefetchCompleted, startKeychainPrefetch } from './utils/secureStorage/keychainPrefetch.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
startKeychainPrefetch();

import { feature } from 'bun:bundle';
import { Command as CommanderCommand, InvalidArgumentError, Option } from '@commander-js/extra-typings';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import mapValues from 'lodash-es/mapValues.js';
import pickBy from 'lodash-es/pickBy.js';
import uniqBy from 'lodash-es/uniqBy.js';
import { getOauthConfig } from './constants/oauth.js';
import { getRemoteSessionUrl } from './constants/product.js';
import { getSystemContext, getUserContext } from './context.js';
import { init, initializeTelemetryAfterTrust } from './entrypoints/init.js';
import { addToHistory } from './history.js';
import type { Root } from '@anthropic/ink';
import { launchRepl } from './replLauncher.js';
import {
  hasGrowthBookEnvOverride,
  initializeGrowthBook,
  refreshGrowthBookAfterAuthChange,
} from './services/analytics/growthbook.js';
import { fetchBootstrapData } from './services/api/bootstrap.js';
import {
  type DownloadResult,
  downloadSessionFiles,
  type FilesApiConfig,
  parseFileSpecs,
} from './services/api/filesApi.js';
import { prefetchPassesEligibility } from './services/api/referral.js';
import type { McpSdkServerConfig, McpServerConfig, ScopedMcpServerConfig } from './services/mcp/types.js';
import {
  isPolicyAllowed,
  loadPolicyLimits,
  refreshPolicyLimits,
  waitForPolicyLimitsToLoad,
} from './services/policyLimits/index.js';
import { loadRemoteManagedSettings, refreshRemoteManagedSettings } from './services/remoteManagedSettings/index.js';
import type { ToolInputJSONSchema } from './Tool.js';
import {
  createSyntheticOutputTool,
  isSyntheticOutputToolEnabled,
} from '@claude-code-best/builtin-tools/tools/SyntheticOutputTool/SyntheticOutputTool.js';
import { getTools } from './tools.js';
import {
  canUserConfigureAdvisor,
  getInitialAdvisorSetting,
  isAdvisorEnabled,
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from './utils/advisor.js';
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js';
import { count, uniq } from './utils/array.js';
import { installAsciicastRecorder } from './utils/asciicast.js';
import {
  getSubscriptionType,
  isClaudeAISubscriber,
  prefetchAwsCredentialsAndBedRockInfoIfSafe,
  prefetchGcpCredentialsIfSafe,
  validateForceLoginOrg,
} from './utils/auth.js';
import {
  checkHasTrustDialogAccepted,
  getGlobalConfig,
  getRemoteControlAtStartup,
  isAutoUpdaterDisabled,
  saveGlobalConfig,
} from './utils/config.js';
import { seedEarlyInput, stopCapturingEarlyInput } from './utils/earlyInput.js';
import { getInitialEffortSetting, parseEffortValue } from './utils/effort.js';
import {
  getInitialFastModeSetting,
  isFastModeEnabled,
  prefetchFastModeStatus,
  resolveFastModeStatusFromCache,
} from './utils/fastMode.js';
import { applyConfigEnvironmentVariables } from './utils/managedEnv.js';
import { createSystemMessage, createUserMessage } from './utils/messages.js';
import { getPlatform } from './utils/platform.js';
import { getBaseRenderOptions } from './utils/renderOptions.js';
import { getSessionIngressAuthToken } from './utils/sessionIngressAuth.js';
import { settingsChangeDetector } from './utils/settings/changeDetector.js';
import { skillChangeDetector } from './utils/skills/skillChangeDetector.js';
import { jsonParse, writeFileSync_DEPRECATED } from './utils/slowOperations.js';
import { computeInitialTeamContext } from './utils/swarm/reconnection.js';
import { initializeWarningHandler } from './utils/warningHandler.js';
import { isWorktreeModeEnabled } from './utils/worktreeModeEnabled.js';

// 懒 require 以避免循环依赖：teammate.ts -> AppState.tsx -> ... -> main.tsx
/* eslint-disable @typescript-eslint/no-require-imports */
const getTeammateUtils = () => require('./utils/teammate.js') as typeof import('./utils/teammate.js');
const getTeammatePromptAddendum = () =>
  require('./utils/swarm/teammatePromptAddendum.js') as typeof import('./utils/swarm/teammatePromptAddendum.js');
const getTeammateModeSnapshot = () =>
  require('./utils/swarm/backends/teammateModeSnapshot.js') as typeof import('./utils/swarm/backends/teammateModeSnapshot.js');
/* eslint-enable @typescript-eslint/no-require-imports */
// 死代码消除：COORDINATOR_MODE 的条件 import
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('./coordinator/coordinatorMode.js') as typeof import('./coordinator/coordinatorMode.js'))
  : null;
/* eslint-enable @typescript-eslint/no-require-imports */
// 死代码消除：KAIROS（assistant 模式）的条件 import
/* eslint-disable @typescript-eslint/no-require-imports */
const assistantModule = feature('KAIROS')
  ? (require('./assistant/index.js') as typeof import('./assistant/index.js'))
  : null;
const kairosGate = feature('KAIROS') ? (require('./assistant/gate.js') as typeof import('./assistant/gate.js')) : null;

import { relative, resolve } from 'path';
import { isAnalyticsDisabled } from 'src/services/analytics/config.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import { initializeAnalyticsGates } from 'src/services/analytics/sink.js';
import {
  getOriginalCwd,
  setAdditionalDirectoriesForClaudeMd,
  setIsRemoteMode,
  setMainLoopModelOverride,
  setMainThreadAgentType,
  setTeleportedSessionInfo,
} from './bootstrap/state.js';
import { filterCommandsForRemoteMode, getCommands } from './commands.js';
import type { StatsStore } from './context/stats.js';
import {
  launchAssistantInstallWizard,
  launchAssistantSessionChooser,
  launchInvalidSettingsDialog,
  launchResumeChooser,
  launchSnapshotUpdateDialog,
  launchTeleportRepoMismatchDialog,
  launchTeleportResumeWrapper,
} from './dialogLaunchers.js';
import { SHOW_CURSOR } from '@anthropic/ink';
import {
  exitWithError,
  exitWithMessage,
  getRenderContext,
  renderAndRun,
  showSetupScreens,
} from './interactiveHelpers.js';
import { initBuiltinPlugins } from './plugins/bundled/index.js';
/* eslint-enable @typescript-eslint/no-require-imports */
import { checkQuotaStatus } from './services/claudeAiLimits.js';
import { getMcpToolsCommandsAndResources, prefetchAllMcpResources } from './services/mcp/client.js';
import { VALID_INSTALLABLE_SCOPES, VALID_UPDATE_SCOPES } from './services/plugins/pluginCliCommands.js';
import { initBundledSkills } from './skills/bundled/index.js';
import type { AgentColorName } from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js';
import {
  getActiveAgentsFromList,
  getAgentDefinitionsWithOverrides,
  isBuiltInAgent,
  isCustomAgent,
  parseAgentsFromJson,
} from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js';
import type { LogOption } from './types/logs.js';
import type { Message as MessageType } from './types/message.js';
import {
  CLAUDE_IN_CHROME_SKILL_HINT,
  CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER,
} from './utils/claudeInChrome/prompt.js';
import {
  setupClaudeInChrome,
  shouldAutoEnableClaudeInChrome,
  shouldEnableClaudeInChrome,
} from './utils/claudeInChrome/setup.js';
import { getContextWindowForModel } from './utils/context.js';
import { loadConversationForResume } from './utils/conversationRecovery.js';
import { buildDeepLinkBanner } from './utils/deepLink/banner.js';
import { hasNodeOption, isBareMode, isEnvTruthy, isInProtectedNamespace } from './utils/envUtils.js';
import { refreshExampleCommands } from './utils/exampleCommands.js';
import type { FpsMetrics } from './utils/fpsTracker.js';
import { getWorktreePaths } from './utils/getWorktreePaths.js';
import { findGitRoot, getBranch, getIsGit, getWorktreeCount } from './utils/git.js';
import { getGhAuthStatus } from './utils/github/ghAuthStatus.js';
import { safeParseJSON } from './utils/json.js';
import { logError } from './utils/log.js';
import { getModelDeprecationWarning } from './utils/model/deprecation.js';
import {
  getDefaultMainLoopModel,
  getUserSpecifiedModelSetting,
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from './utils/model/model.js';
import { ensureModelStringsInitialized } from './utils/model/modelStrings.js';
import { PERMISSION_MODES } from './utils/permissions/PermissionMode.js';
import {
  getAutoModeEnabledStateIfCached,
  initializeToolPermissionContext,
  initialPermissionModeFromCLI,
  isDefaultPermissionModeAuto,
  parseToolListFromCLI,
  removeDangerousPermissions,
  stripDangerousPermissionsForAutoMode,
  verifyAutoModeGateAccess,
} from './utils/permissions/permissionSetup.js';
import { cleanupOrphanedPluginVersionsInBackground } from './utils/plugins/cacheUtils.js';
import { initializeVersionedPlugins } from './utils/plugins/installedPluginsManager.js';
import { getManagedPluginNames } from './utils/plugins/managedPlugins.js';
import { getGlobExclusionsForPluginCache } from './utils/plugins/orphanedPluginFilter.js';
import { getPluginSeedDirs } from './utils/plugins/pluginDirectories.js';
import { countFilesRoundedRg } from './utils/ripgrep.js';
import { processSessionStartHooks, processSetupHooks } from './utils/sessionStart.js';
import {
  cacheSessionTitle,
  getSessionIdFromLog,
  loadTranscriptFromFile,
  saveAgentSetting,
  saveMode,
  searchSessionsByCustomTitle,
  sessionIdExists,
} from './utils/sessionStorage.js';
import { ensureMdmSettingsLoaded } from './utils/settings/mdm/settings.js';
import {
  getInitialSettings,
  getManagedSettingsKeysForLogging,
  getSettingsForSource,
  getSettingsWithErrors,
} from './utils/settings/settings.js';
import { resetSettingsCache } from './utils/settings/settingsCache.js';
import type { ValidationError } from './utils/settings/validation.js';
import { DEFAULT_TASKS_MODE_TASK_LIST_ID, TASK_STATUSES } from './utils/tasks.js';
import { logPluginLoadErrors, logPluginsEnabledForSession } from './utils/telemetry/pluginTelemetry.js';
import { logSkillsLoaded } from './utils/telemetry/skillLoadedEvent.js';
import { generateTempFilePath } from './utils/tempfile.js';
import { validateUuid } from './utils/uuid.js';
// Plugin 启动检查现在改为在 REPL.tsx 中非阻塞地处理

import { registerMcpAddCommand } from 'src/commands/mcp/addCommand.js';
import { registerMcpXaaIdpCommand } from 'src/commands/mcp/xaaIdpCommand.js';
import { logPermissionContextForAnts } from 'src/services/internalLogging.js';
import { fetchClaudeAIMcpConfigsIfEligible } from 'src/services/mcp/claudeai.js';
import { clearServerCache } from 'src/services/mcp/client.js';
import {
  areMcpConfigsAllowedWithEnterpriseMcpConfig,
  dedupClaudeAiMcpServers,
  doesEnterpriseMcpConfigExist,
  filterMcpServersByPolicy,
  getClaudeCodeMcpConfigs,
  getMcpServerSignature,
  parseMcpConfig,
  parseMcpConfigFromFilePath,
} from 'src/services/mcp/config.js';
import { excludeCommandsByServer, excludeResourcesByServer } from 'src/services/mcp/utils.js';
import { isXaaEnabled } from 'src/services/mcp/xaaIdpLogin.js';
import { getRelevantTips } from 'src/services/tips/tipRegistry.js';
import { logContextMetrics } from 'src/utils/api.js';
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME, isClaudeInChromeMCPServer } from 'src/utils/claudeInChrome/common.js';
import { registerCleanup } from 'src/utils/cleanupRegistry.js';
import { eagerParseCliFlag } from 'src/utils/cliArgs.js';
import { createEmptyAttributionState } from 'src/utils/commitAttribution.js';
import { countConcurrentSessions, registerSession, updateSessionName } from 'src/utils/concurrentSessions.js';
import { getCwd } from 'src/utils/cwd.js';
import { logForDebugging, setHasFormattedOutput } from 'src/utils/debug.js';
import { errorMessage, getErrnoCode, isENOENT, TeleportOperationError, toError } from 'src/utils/errors.js';
import { getFsImplementation, safeResolvePath } from 'src/utils/fsOperations.js';
import { gracefulShutdown, gracefulShutdownSync } from 'src/utils/gracefulShutdown.js';
import { setAllHookEventsEnabled } from 'src/utils/hooks/hookEvents.js';
import { refreshModelCapabilities } from 'src/utils/model/modelCapabilities.js';
import { peekForStdinData, writeToStderr } from 'src/utils/process.js';
import { setCwd } from 'src/utils/Shell.js';
import { type ProcessedResume, processResumedConversation } from 'src/utils/sessionRestore.js';
import { parseSettingSourcesFlag } from 'src/utils/settings/constants.js';
import { plural } from 'src/utils/stringUtils.js';
import {
  type ChannelEntry,
  getInitialMainLoopModel,
  getIsNonInteractiveSession,
  getSdkBetas,
  getSessionId,
  getUserMsgOptIn,
  setAllowedChannels,
  setAllowedSettingSources,
  setChromeFlagOverride,
  setClientType,
  setCwdState,
  setDirectConnectServerUrl,
  setFlagSettingsPath,
  setInitialMainLoopModel,
  setInlinePlugins,
  setIsInteractive,
  setKairosActive,
  setOriginalCwd,
  setQuestionPreviewFormat,
  setSdkBetas,
  setSessionBypassPermissionsMode,
  setSessionPersistenceDisabled,
  setSessionSource,
  setUserMsgOptIn,
  switchSession,
} from './bootstrap/state.js';

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('./utils/permissions/autoModeState.js') as typeof import('./utils/permissions/autoModeState.js'))
  : null;

// TeleportRepoMismatchDialog、TeleportResumeWrapper 在调用处动态导入
import { migrateBypassPermissionsAcceptedToSettings } from './migrations/migrateBypassPermissionsAcceptedToSettings.js';
import { migrateEnableAllProjectMcpServersToSettings } from './migrations/migrateEnableAllProjectMcpServersToSettings.js';
import { migrateFennecToOpus } from './migrations/migrateFennecToOpus.js';
import { migrateLegacyOpusToCurrent } from './migrations/migrateLegacyOpusToCurrent.js';
import { migrateOpusToOpus1m } from './migrations/migrateOpusToOpus1m.js';
import { migrateReplBridgeEnabledToRemoteControlAtStartup } from './migrations/migrateReplBridgeEnabledToRemoteControlAtStartup.js';
import { migrateSonnet1mToSonnet45 } from './migrations/migrateSonnet1mToSonnet45.js';
import { migrateSonnet45ToSonnet46 } from './migrations/migrateSonnet45ToSonnet46.js';
import { resetAutoModeOptInForDefaultOffer } from './migrations/resetAutoModeOptInForDefaultOffer.js';
import { resetProToOpusDefault } from './migrations/resetProToOpusDefault.js';
import { createRemoteSessionConfig } from './remote/RemoteSessionManager.js';
/* eslint-enable @typescript-eslint/no-require-imports */
// teleportWithProgress 在调用处动态导入
import { createDirectConnectSession, DirectConnectError } from './server/createDirectConnectSession.js';
import { initializeLspServerManager } from './services/lsp/manager.js';
import { shouldEnablePromptSuggestion } from './services/PromptSuggestion/promptSuggestion.js';
import { type AppState, getDefaultAppState, IDLE_SPECULATION_STATE } from './state/AppStateStore.js';
import { onChangeAppState } from './state/onChangeAppState.js';
import { createStore } from './state/store.js';
import { asSessionId } from './types/ids.js';
import { filterAllowedSdkBetas } from './utils/betas.js';
import { isInBundledMode, isRunningWithBun } from './utils/bundledMode.js';
import { logForDiagnosticsNoPII } from './utils/diagLogs.js';
import { filterExistingPaths, getKnownPathsForRepo } from './utils/githubRepoPathMapping.js';
import { clearPluginCache, loadAllPluginsCacheOnly } from './utils/plugins/pluginLoader.js';
import { migrateChangelogFromConfig } from './utils/releaseNotes.js';
import { SandboxManager } from './utils/sandbox/sandbox-adapter.js';
import { fetchSession, prepareApiRequest } from './utils/teleport/api.js';
import {
  checkOutTeleportedSessionBranch,
  processMessagesForTeleportResume,
  teleportToRemoteWithErrorHandling,
  validateGitState,
  validateSessionRepository,
} from './utils/teleport.js';
import { shouldEnableThinkingByDefault, type ThinkingConfig } from './utils/thinking.js';
import { initUser, resetUserCache } from './utils/user.js';
import { getTmuxInstallInstructions, isTmuxAvailable, parsePRReference } from './utils/worktree.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
profileCheckpoint('main_tsx_imports_loaded');

/**
 * 将托管设置的 keys 记录到 Statsig 以供分析。
 * 这在 init() 完成后调用，以确保设置已加载
 * 且环境变量已应用，然后再做模型解析。
 */
function logManagedSettings(): void {
  try {
    const policySettings = getSettingsForSource('policySettings');
    if (policySettings) {
      const allKeys = getManagedSettingsKeysForLogging(policySettings);
      logEvent('tengu_managed_settings_loaded', {
        keyCount: allKeys.length,
        keys: allKeys.join(',') as unknown as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
    }
  } catch {
    // 静默忽略错误 —— 这只是用于分析
  }
}

// 检查是否运行在调试/检查模式
function _isBeingDebugged() {
  const isBun = isRunningWithBun();

  // 检查 process 参数中是否包含 inspect 标志（包括所有变体）
  const hasInspectArg = process.execArgv.some(arg => {
    if (isBun) {
      // 注意：Bun 在单文件可执行程序中存在一个问题：来自 process.argv 的应用参数
      // 会泄漏进 process.execArgv（类似 https://github.com/oven-sh/bun/issues/11673）
      // 如果省略这个分支会破坏 --debug 模式的使用
      // 这里跳过该检查没问题，因为 Bun 不支持 Node.js 旧版 --debug 或 --debug-brk 标志
      return /--inspect(-brk)?/.test(arg);
    } else {
      // 在 Node.js 中，同时检查 --inspect 和旧版 --debug 标志
      return /--inspect(-brk)?|--debug(-brk)?/.test(arg);
    }
  });

  // 检查 NODE_OPTIONS 是否包含 inspect 标志
  const hasInspectEnv = process.env.NODE_OPTIONS && /--inspect(-brk)?|--debug(-brk)?/.test(process.env.NODE_OPTIONS);

  // 检查 inspector 是否可用且处于活动状态（表示正在调试）
  try {
    // 动态 import 会更好但它是异步的 —— 改用全局对象
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inspector = (global as any).require('inspector');
    const hasInspectorUrl = !!inspector.url();
    return hasInspectorUrl || hasInspectArg || hasInspectEnv;
  } catch {
    // 忽略错误，回退到参数检测
    return hasInspectArg || hasInspectEnv;
  }
}

/**
 * 每会话 skill/plugin 遥测。从交互式路径和无头 -p 路径
 * （runHeadless 之前）都会调用 —— 两者都经过 main.tsx，
 * 但在交互式启动路径之前分叉，因此需要两个调用点，
 * 而不是一个这里 + 一个在 QueryEngine。
 */
function logSessionTelemetry(): void {
  const model = parseUserSpecifiedModel(getInitialMainLoopModel() ?? getDefaultMainLoopModel());
  void logSkillsLoaded(getCwd(), getContextWindowForModel(model, getSdkBetas()));
  void loadAllPluginsCacheOnly()
    .then(({ enabled, errors }) => {
      const managedNames = getManagedPluginNames();
      logPluginsEnabledForSession(enabled, managedNames, getPluginSeedDirs());
      logPluginLoadErrors(errors, managedNames);
    })
    .catch(err => logError(err));
}

function getCertEnvVarTelemetry(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  if (process.env.NODE_EXTRA_CA_CERTS) {
    result.has_node_extra_ca_certs = true;
  }
  if (process.env.CLAUDE_CODE_CLIENT_CERT) {
    result.has_client_cert = true;
  }
  if (hasNodeOption('--use-system-ca')) {
    result.has_use_system_ca = true;
  }
  if (hasNodeOption('--use-openssl-ca')) {
    result.has_use_openssl_ca = true;
  }
  return result;
}

async function logStartupTelemetry(): Promise<void> {
  if (isAnalyticsDisabled()) return;
  const [isGit, worktreeCount, ghAuthStatus] = await Promise.all([getIsGit(), getWorktreeCount(), getGhAuthStatus()]);

  logEvent('tengu_startup_telemetry', {
    is_git: isGit,
    worktree_count: worktreeCount,
    gh_auth_status: ghAuthStatus as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    sandbox_enabled: SandboxManager.isSandboxingEnabled(),
    are_unsandboxed_commands_allowed: SandboxManager.areUnsandboxedCommandsAllowed(),
    is_auto_bash_allowed_if_sandbox_enabled: SandboxManager.isAutoAllowBashIfSandboxedEnabled(),
    auto_updater_disabled: isAutoUpdaterDisabled(),
    prefers_reduced_motion: getInitialSettings().prefersReducedMotion ?? false,
    ...getCertEnvVarTelemetry(),
  });
}

/**
 * 执行配置迁移，将旧版配置格式升级到最新版。
 *
 * 迁移是同步执行的（CURRENT_MIGRATION_VERSION 控制），每次升级版本号后，
 * 已迁移的用户不会重复执行。异步迁移（如 changelog）fire-and-forget。
 *
 * 迁移内容包括：
 *   - 权限配置迁移到 settings.json
 *   - MCP 服务器启用状态迁移
 *   - 模型字符串升级（Sonnet 1M → Sonnet 4.5 → Sonnet 4.6，Opus → Opus 1M 等）
 *   - bridge 配置迁移到 remoteControlAtStartup
 *   - auto mode 选项重置（当 TRANSCRIPT_CLASSIFIER 启用时）
 */
const CURRENT_MIGRATION_VERSION = 11;
function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    migrateBypassPermissionsAcceptedToSettings();
    migrateEnableAllProjectMcpServersToSettings();
    resetProToOpusDefault();
    migrateSonnet1mToSonnet45();
    migrateLegacyOpusToCurrent();
    migrateSonnet45ToSonnet46();
    migrateOpusToOpus1m();
    migrateReplBridgeEnabledToRemoteControlAtStartup();
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      resetAutoModeOptInForDefaultOffer();
    }
    if (process.env.USER_TYPE === 'ant') {
      migrateFennecToOpus();
    }
    saveGlobalConfig(prev =>
      prev.migrationVersion === CURRENT_MIGRATION_VERSION
        ? prev
        : { ...prev, migrationVersion: CURRENT_MIGRATION_VERSION },
    );
  }
  // 异步迁移 —— 非阻塞，fire-and-forget
  migrateChangelogFromConfig().catch(() => {
    // 静默忽略迁移错误 —— 下次启动时重试
  });
}

/**
 * 仅在安全时预取系统上下文（包括 git 状态）。
 * Git 命令可以通过 hooks 和 config（例如 core.fsmonitor、
 * diff.external）执行任意代码，因此我们必须只在 trust 已确立
 * 或在非交互模式（trust 是隐式的）下运行它们。
 */
function prefetchSystemContextIfSafe(): void {
  const isNonInteractiveSession = getIsNonInteractiveSession();

  // 在非交互模式（--print）下，trust dialog 被跳过，
  // 执行被视为受信任（如帮助文本中所述）
  if (isNonInteractiveSession) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_non_interactive');
    void getSystemContext();
    return;
  }

  // 在交互模式下，仅在 trust 已确立时预取
  const hasTrust = checkHasTrustDialogAccepted();
  if (hasTrust) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_has_trust');
    void getSystemContext();
  } else {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_skipped_no_trust');
  }
  // 否则不预取 —— 等 trust 确立后再说
}

/**
 * 启动延迟预取任务 —— 在 REPL 首次渲染完成后调用，不阻塞首屏。
 * 这些任务在用户输入第一个问题时才会用到，因此可以在 REPL 渲染后再执行，
 * 利用"用户正在打字"的时间窗口完成预取，减少首次 API 调用的延迟。
 *
 * 预取内容包括：
 *   - initUser()：用户信息（用于 Langfuse 等遥测）
 *   - getUserContext()：用户上下文（CLAUDE.md 等）
 *   - getSystemContext()：系统上下文（git 状态等，需先确认 trust）
 *   - getRelevantTips()：使用提示
 *   - AWS/GCP 凭证预取（Bedrock/Vertex 模式下）
 *   - countFilesRoundedRg()：文件数量统计
 *   - initializeAnalyticsGates()：GrowthBook 功能门控
 *   - refreshModelCapabilities()：模型能力缓存
 *   - settingsChangeDetector / skillChangeDetector：文件变更监听器
 *
 * --bare 模式下全部跳过（脚本调用无需这些预热）。
 */
export function startDeferredPrefetches(): void {
  // 本函数在首次渲染后运行，因此不会阻塞首屏绘制。
  // 然而，派生的子进程和异步工作仍然会争抢 CPU 和事件
  // 循环时间，这会扭曲启动基准测试（CPU profiles、time-to-first-render
  // 测量）。仅测量启动性能时全部跳过。
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER) ||
    // --bare：跳过所有预取。这些是为 REPL 首轮流式响应
    // 而做的缓存预热（initUser、getUserContext、tips、countFiles、
    // modelCapabilities、变更检测器）。脚本化 -p 调用没有
    // "用户正在打字"的时间窗口可以隐藏这些工作 —— 在关键路径上纯属额外开销。
    isBareMode()
  ) {
    return;
  }

  // 派生子进程的预取（首次 API 调用时消费，此时用户仍在打字）
  void initUser();
  void getUserContext();
  prefetchSystemContextIfSafe();
  void getRelevantTips();
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) && !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)) {
    void prefetchAwsCredentialsAndBedRockInfoIfSafe();
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) && !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)) {
    void prefetchGcpCredentialsIfSafe();
  }
  void countFilesRoundedRg(getCwd(), AbortSignal.timeout(3000), []);

  // 分析与 feature flag 初始化
  void initializeAnalyticsGates();

  void refreshModelCapabilities();

  // 文件变更检测器从 init() 推迟到这里，以解除首次渲染的阻塞
  void settingsChangeDetector.initialize();
  if (!isBareMode()) {
    void skillChangeDetector.initialize();
  }

  // 事件循环卡顿检测器 —— 主线程被阻塞 >500ms 时记录日志
  if (process.env.USER_TYPE === 'ant') {
    void import('./utils/eventLoopStallDetector.js').then(m => m.startEventLoopStallDetector());
  }
}

function loadSettingsFromFlag(settingsFile: string): void {
  try {
    const trimmedSettings = settingsFile.trim();
    const looksLikeJson = trimmedSettings.startsWith('{') && trimmedSettings.endsWith('}');

    let settingsPath: string;

    if (looksLikeJson) {
      // 是 JSON 字符串 —— 校验并创建临时文件
      const parsedJson = safeParseJSON(trimmedSettings);
      if (!parsedJson) {
        process.stderr.write(chalk.red('Error: Invalid JSON provided to --settings\n'));
        process.exit(1);
      }

      // 创建一个临时文件并将 JSON 写入其中。
      // 使用基于内容哈希的路径而非随机 UUID，以避免
      // 破坏 Anthropic API 的 prompt 缓存。settings 路径最终会进入
      // Bash 工具的 sandbox denyWithinAllow 列表，这是发送给 API 的
      // 工具描述的一部分。每个子进程一个随机 UUID 会
      // 在每次 query() 调用时改变工具描述，使
      // 缓存前缀失效，导致 input token 成本增加 12 倍。
      // 内容哈希确保相同的 settings 在跨进程边界时生成相同路径
      // （每个 SDK query() 都会派生一个新进程）。
      settingsPath = generateTempFilePath('claude-settings', '.json', {
        contentHash: trimmedSettings,
      });
      writeFileSync_DEPRECATED(settingsPath, trimmedSettings, 'utf8');
    } else {
      // 是文件路径 —— 通过尝试读取来解析并校验
      const { resolvedPath: resolvedSettingsPath } = safeResolvePath(getFsImplementation(), settingsFile);
      try {
        readFileSync(resolvedSettingsPath, 'utf8');
      } catch (e) {
        if (isENOENT(e)) {
          process.stderr.write(chalk.red(`Error: Settings file not found: ${resolvedSettingsPath}\n`));
          process.exit(1);
        }
        throw e;
      }
      settingsPath = resolvedSettingsPath;
    }

    setFlagSettingsPath(settingsPath);
    resetSettingsCache();
  } catch (error) {
    if (error instanceof Error) {
      logError(error);
    }
    process.stderr.write(chalk.red(`Error processing settings: ${errorMessage(error)}\n`));
    process.exit(1);
  }
}

function loadSettingSourcesFromFlag(settingSourcesArg: string): void {
  try {
    const sources = parseSettingSourcesFlag(settingSourcesArg);
    setAllowedSettingSources(sources);
    resetSettingsCache();
  } catch (error) {
    if (error instanceof Error) {
      logError(error);
    }
    process.stderr.write(chalk.red(`Error processing --setting-sources: ${errorMessage(error)}\n`));
    process.exit(1);
  }
}

/**
 * 在 init() 之前提前解析并加载 settings 标志
 * 这确保 settings 从初始化开始就被过滤
 */
function eagerLoadSettings(): void {
  profileCheckpoint('eagerLoadSettings_start');
  // 提前解析 --settings 标志，确保 settings 在 init() 之前加载
  const settingsFile = eagerParseCliFlag('--settings');
  if (settingsFile) {
    loadSettingsFromFlag(settingsFile);
  }

  // 提前解析 --setting-sources 标志，控制要加载哪些来源
  const settingSourcesArg = eagerParseCliFlag('--setting-sources');
  if (settingSourcesArg !== undefined) {
    loadSettingSourcesFromFlag(settingSourcesArg);
  }
  profileCheckpoint('eagerLoadSettings_end');
}

function initializeEntrypoint(isNonInteractive: boolean): void {
  // 若已设置则跳过（例如由 SDK 或其他入口设置）
  if (process.env.CLAUDE_CODE_ENTRYPOINT) {
    return;
  }

  const cliArgs = process.argv.slice(2);

  // 检查 MCP serve 命令（处理 mcp serve 之前的标志，例如 --debug mcp serve）
  const mcpIndex = cliArgs.indexOf('mcp');
  if (mcpIndex !== -1 && cliArgs[mcpIndex + 1] === 'serve') {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'mcp';
    return;
  }

  if (isEnvTruthy(process.env.CLAUDE_CODE_ACTION)) {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-code-github-action';
    return;
  }

  // 注意：'local-agent' 入口由 local agent 模式启动器
  // 通过 CLAUDE_CODE_ENTRYPOINT 环境变量设置（由上方的提前 return 处理）

  // 根据交互/非交互状态设置
  process.env.CLAUDE_CODE_ENTRYPOINT = isNonInteractive ? 'sdk-cli' : 'cli';
}

// 当检测到 `claude open <url>` 时由早期 argv 处理设置（仅交互模式）
type PendingConnect = {
  url: string | undefined;
  authToken: string | undefined;
  dangerouslySkipPermissions: boolean;
};
const _pendingConnect: PendingConnect | undefined = feature('DIRECT_CONNECT')
  ? {
      url: undefined,
      authToken: undefined,
      dangerouslySkipPermissions: false,
    }
  : undefined;

// 当检测到 `claude assistant [sessionId]` 时由早期 argv 处理设置
type PendingAssistantChat = { sessionId?: string; discover: boolean };
const _pendingAssistantChat: PendingAssistantChat | undefined = feature('KAIROS')
  ? { sessionId: undefined, discover: false }
  : undefined;

// `claude ssh <host> [dir]` —— 从 argv 中提前解析（与上面的
// DIRECT_CONNECT 相同的模式），以便主命令路径能拾取它并
// 将基于 SSH 的会话而非本地会话交给 REPL。
type PendingSSH = {
  host: string | undefined;
  cwd: string | undefined;
  permissionMode: string | undefined;
  dangerouslySkipPermissions: boolean;
  /** --local：直接派生子 CLI，跳过 ssh/probe/deploy。e2e 测试模式。 */
  local: boolean;
  /** 额外的 CLI 参数，转发给首次派生远程 CLI（--resume、-c）。 */
  extraCliArgs: string[];
  remoteBin: string | undefined;
};
const _pendingSSH: PendingSSH | undefined = feature('SSH_REMOTE')
  ? {
      host: undefined,
      cwd: undefined,
      permissionMode: undefined,
      dangerouslySkipPermissions: false,
      local: false,
      extraCliArgs: [],
      remoteBin: undefined,
    }
  : undefined;

/**
 * 完整 CLI 应用入口函数（由 cli.tsx 的默认路径动态导入后调用）。
 *
 * 职责：
 *   1. 设置安全环境变量（防 PATH 劫持）
 *   2. 初始化 warning handler 和进程退出清理
 *   3. 处理特殊 URL 协议（cc://、--handle-uri）
 *   4. 处理 ssh/assistant 子命令的 argv 重写
 *   5. 判断会话类型（交互/非交互）和客户端类型（cli/sdk/remote...）
 *   6. 提前加载 settings
 *   7. 调用 run() 启动 Commander.js 命令分发
 */
export async function main() {
  profileCheckpoint('main_function_start');
  logForDebugging(`[Hapii] Main.main 入口 argv=${JSON.stringify(process.argv.slice(2).slice(0, 5))}...`, {
    level: 'info',
  });

  // 安全：阻止 Windows 从当前目录执行命令
  // 这必须在任何命令执行之前设置，以防 PATH 劫持攻击
  // 参见：https://docs.microsoft.com/en-us/windows/win32/api/processenv/nf-processenv-searchpathw
  process.env.NoDefaultCurrentDirectoryInExePath = '1';

  // 尽早初始化 warning handler 以捕获警告
  initializeWarningHandler();

  process.on('exit', () => {
    resetCursor();
    // 杀掉所有 running workflow，避免孤儿 task 留在 AppState 里
    try {
      const { peekWorkflowService } = require('./workflow/service.js') as {
        peekWorkflowService: () => { shutdown: () => void } | null;
      };
      peekWorkflowService()?.shutdown();
    } catch {
      // workflow 未启用或已卸载——忽略
    }
  });
  process.on('SIGINT', () => {
    // 在 print 模式下，print.ts 会注册自己的 SIGINT handler 来中止
    // 进行中的 query 并调用 gracefulShutdown；这里跳过以避免
    // 用同步的 process.exit() 抢占它。
    if (process.argv.includes('-p') || process.argv.includes('--print')) {
      return;
    }
    process.exit(0);
  });
  profileCheckpoint('main_warning_handler_initialized');

  // 检查 argv 中的 cc:// 或 cc+unix:// URL —— 改写为主命令
  // 处理，这样能给完整的交互式 TUI，而不是精简的子命令。
  // 对于无头模式（-p），改写为内部 `open` 子命令。
  if (feature('DIRECT_CONNECT')) {
    const rawCliArgs = process.argv.slice(2);
    const ccIdx = rawCliArgs.findIndex(a => a.startsWith('cc://') || a.startsWith('cc+unix://'));
    if (ccIdx !== -1 && _pendingConnect) {
      const ccUrl = rawCliArgs[ccIdx]!;
      const { parseConnectUrl } = await import('./server/parseConnectUrl.js');
      const parsed = parseConnectUrl(ccUrl);
      _pendingConnect.dangerouslySkipPermissions = rawCliArgs.includes('--dangerously-skip-permissions');

      if (rawCliArgs.includes('-p') || rawCliArgs.includes('--print')) {
        // 无头模式：改写为内部 `open` 子命令
        const stripped = rawCliArgs.filter((_, i) => i !== ccIdx);
        const dspIdx = stripped.indexOf('--dangerously-skip-permissions');
        if (dspIdx !== -1) {
          stripped.splice(dspIdx, 1);
        }
        process.argv = [process.argv[0]!, process.argv[1]!, 'open', ccUrl, ...stripped];
      } else {
        // 交互模式：剥离 cc:// URL 和标志，运行主命令
        _pendingConnect.url = parsed.serverUrl;
        _pendingConnect.authToken = parsed.authToken;
        const stripped = rawCliArgs.filter((_, i) => i !== ccIdx);
        const dspIdx = stripped.indexOf('--dangerously-skip-permissions');
        if (dspIdx !== -1) {
          stripped.splice(dspIdx, 1);
        }
        process.argv = [process.argv[0]!, process.argv[1]!, ...stripped];
      }
    }
  }

  // 尽早处理 deep link URI —— 这是 OS 协议处理器调用的入口，
  // 应该在完整 init 之前退出，因为它只需要解析 URI
  // 并打开一个终端。
  if (feature('LODESTONE')) {
    const handleUriIdx = process.argv.indexOf('--handle-uri');
    if (handleUriIdx !== -1 && process.argv[handleUriIdx + 1]) {
      const { enableConfigs } = await import('./utils/config.js');
      enableConfigs();
      const uri = process.argv[handleUriIdx + 1]!;
      const { handleDeepLinkUri } = await import('./utils/deepLink/protocolHandler.js');
      const exitCode = await handleDeepLinkUri(uri);
      process.exit(exitCode);
    }

    // macOS URL 处理器：当 LaunchServices 启动我们的 .app bundle 时，
    // URL 通过 Apple Event（而非 argv）到达。LaunchServices 会将
    // __CFBundleIdentifier 覆盖为启动 bundle 的 ID，这是一个精确的
    // 正向信号 —— 比导入并用启发式猜测更便宜。
    if (process.platform === 'darwin' && process.env.__CFBundleIdentifier === 'com.anthropic.claude-code-url-handler') {
      const { enableConfigs } = await import('./utils/config.js');
      enableConfigs();
      const { handleUrlSchemeLaunch } = await import('./utils/deepLink/protocolHandler.js');
      const urlSchemeResult = await handleUrlSchemeLaunch();
      process.exit(urlSchemeResult ?? 1);
    }
  }

  // `claude assistant [sessionId]` —— 暂存并剥离，让主命令
  // 处理它，从而给完整的交互式 TUI。仅限位置 0
  // （与下方 ssh 模式匹配）—— indexOf 会在
  // `claude -p "explain assistant"` 上误判。子命令之前的根标志
  // （例如 `--debug assistant`）会落入 stub，由其
  // 打印用法。
  if (feature('KAIROS') && _pendingAssistantChat) {
    const rawArgs = process.argv.slice(2);
    if (rawArgs[0] === 'assistant') {
      const nextArg = rawArgs[1];
      if (nextArg && !nextArg.startsWith('-')) {
        _pendingAssistantChat.sessionId = nextArg;
        rawArgs.splice(0, 2); // 去掉 'assistant' 和 sessionId
        process.argv = [process.argv[0]!, process.argv[1]!, ...rawArgs];
      } else if (!nextArg) {
        _pendingAssistantChat.discover = true;
        rawArgs.splice(0, 1); // 去掉 'assistant'
        process.argv = [process.argv[0]!, process.argv[1]!, ...rawArgs];
      }
      // 否则：`claude assistant --help` → 落入 stub
    }
  }

  // `claude ssh <host> [dir]` —— 从 argv 中剥离，让主命令 handler
  // 运行（完整交互式 TUI），暂存 host/dir 供大约 ~line 3720 处的
  // REPL 分支拾取。v1 不支持无头（-p）模式：SSH
  // 会话需要本地 REPL 驱动（中断、权限）。
  if (feature('SSH_REMOTE') && _pendingSSH) {
    const rawCliArgs = process.argv.slice(2);
    // SSH 专用标志可能出现在 host 位置参数之前（例如
    // `ssh --permission-mode auto host /tmp` —— 标准的 POSIX
    // 标志在位置参数之前）。在检查是否给定 host 之前
    // 全部抽出，这样 `claude ssh --permission-mode auto host` 和
    // `claude ssh host --permission-mode auto` 是等价的。下面的
    // host 检查只需要防范 `-h`/`--help`（commander 会处理）。
    if (rawCliArgs[0] === 'ssh') {
      const localIdx = rawCliArgs.indexOf('--local');
      if (localIdx !== -1) {
        _pendingSSH.local = true;
        rawCliArgs.splice(localIdx, 1);
      }
      const dspIdx = rawCliArgs.indexOf('--dangerously-skip-permissions');
      if (dspIdx !== -1) {
        _pendingSSH.dangerouslySkipPermissions = true;
        rawCliArgs.splice(dspIdx, 1);
      }
      const pmIdx = rawCliArgs.indexOf('--permission-mode');
      if (pmIdx !== -1 && rawCliArgs[pmIdx + 1] && !rawCliArgs[pmIdx + 1]!.startsWith('-')) {
        _pendingSSH.permissionMode = rawCliArgs[pmIdx + 1];
        rawCliArgs.splice(pmIdx, 2);
      }
      const pmEqIdx = rawCliArgs.findIndex(a => a.startsWith('--permission-mode='));
      if (pmEqIdx !== -1) {
        _pendingSSH.permissionMode = rawCliArgs[pmEqIdx]!.split('=')[1];
        rawCliArgs.splice(pmEqIdx, 1);
      }
      // 将 session-resume + model 标志转发给远程 CLI 的首次派生。
      // --continue/-c 和 --resume <uuid> 操作的是 REMOTE 会话历史
      // （持久化在远程的 ~/.claude/projects/<cwd>/ 下）。
      // --model 控制远程使用哪个模型。
      const extractFlag = (flag: string, opts: { hasValue?: boolean; as?: string } = {}) => {
        const i = rawCliArgs.indexOf(flag);
        if (i !== -1) {
          _pendingSSH.extraCliArgs.push(opts.as ?? flag);
          const val = rawCliArgs[i + 1];
          if (opts.hasValue && val && !val.startsWith('-')) {
            _pendingSSH.extraCliArgs.push(val);
            rawCliArgs.splice(i, 2);
          } else {
            rawCliArgs.splice(i, 1);
          }
        }
        const eqI = rawCliArgs.findIndex(a => a.startsWith(`${flag}=`));
        if (eqI !== -1) {
          _pendingSSH.extraCliArgs.push(opts.as ?? flag, rawCliArgs[eqI]!.slice(flag.length + 1));
          rawCliArgs.splice(eqI, 1);
        }
      };
      const rbIdx = rawCliArgs.indexOf('--remote-bin');
      if (rbIdx !== -1 && rawCliArgs[rbIdx + 1] && !rawCliArgs[rbIdx + 1]!.startsWith('-')) {
        _pendingSSH.remoteBin = rawCliArgs[rbIdx + 1];
        rawCliArgs.splice(rbIdx, 2);
      }
      const rbEqIdx = rawCliArgs.findIndex(a => a.startsWith('--remote-bin='));
      if (rbEqIdx !== -1) {
        _pendingSSH.remoteBin = rawCliArgs[rbEqIdx]!.split('=').slice(1).join('=');
        rawCliArgs.splice(rbEqIdx, 1);
      }

      extractFlag('-c', { as: '--continue' });
      extractFlag('--continue');
      extractFlag('--resume', { hasValue: true });
      extractFlag('--model', { hasValue: true });
    }
    // 预抽取之后，[1] 处任何剩余的 dash 参数要么是 -h/--help
    // （由 commander 处理），要么是 ssh 未知的标志（落入 commander
    // 让它给出正确的错误）。只有非 dash 参数才是 host。
    if (rawCliArgs[0] === 'ssh' && rawCliArgs[1] && !rawCliArgs[1].startsWith('-')) {
      _pendingSSH.host = rawCliArgs[1];
      // 可选的位置参数 cwd。
      let consumed = 2;
      if (rawCliArgs[2] && !rawCliArgs[2].startsWith('-')) {
        _pendingSSH.cwd = rawCliArgs[2];
        consumed = 3;
      }
      const rest = rawCliArgs.slice(consumed);

      // v1 中无头（-p）模式与 SSH 不兼容 —— 提前拒绝，
      // 以免该标志静默导致本地执行。
      if (rest.includes('-p') || rest.includes('--print')) {
        process.stderr.write('Error: headless (-p/--print) mode is not supported with claude ssh\n');
        gracefulShutdownSync(1);
        return;
      }

      // 改写 argv，让主命令看到剩余标志但看不到 `ssh`。
      process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
    }
  }

  // 提前检查 -p/--print 和 --init-only 标志，以在 init() 之前设置 isInteractiveSession
  // 这很必要，因为遥测初始化会调用依赖此标志的 auth 函数
  const cliArgs = process.argv.slice(2);
  const hasPrintFlag = cliArgs.includes('-p') || cliArgs.includes('--print');
  const hasInitOnlyFlag = cliArgs.includes('--init-only');
  const hasSdkUrl = cliArgs.some(arg => arg.startsWith('--sdk-url'));
  const forceInteractive = isEnvTruthy(process.env.CLAUDE_CODE_FORCE_INTERACTIVE);
  const isNonInteractive = hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || (!forceInteractive && !process.stdout.isTTY);

  logForDebugging(
    `[Hapii] Main.main 交互性判定 isNonInteractive=${isNonInteractive} hasPrintFlag=${hasPrintFlag} hasInitOnlyFlag=${hasInitOnlyFlag} hasSdkUrl=${hasSdkUrl} isTTY=${process.stdout.isTTY}`,
    { level: 'info' },
  );

  // 为非交互模式停止捕获早期输入
  if (isNonInteractive) {
    stopCapturingEarlyInput();
  }

  // 设置简化的跟踪字段
  const isInteractive = !isNonInteractive;
  setIsInteractive(isInteractive);

  // 根据模式初始化入口 —— 需要在记录任何事件之前设置
  initializeEntrypoint(isNonInteractive);

  // 确定 client 类型
  const clientType = (() => {
    if (isEnvTruthy(process.env.GITHUB_ACTIONS)) return 'github-action';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-ts') return 'sdk-typescript';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-py') return 'sdk-python';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-cli') return 'sdk-cli';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-vscode') return 'claude-vscode';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'local-agent') return 'local-agent';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop') return 'claude-desktop';

    // 检查是否提供了 session-ingress token（表示远程会话）
    const hasSessionIngressToken =
      process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN || process.env.CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR;
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'remote' || hasSessionIngressToken) {
      return 'remote';
    }

    return 'cli';
  })();
  setClientType(clientType);
  logForDebugging(`[Hapii] Main.main clientType=${clientType}`, { level: 'info' });

  const previewFormat = process.env.CLAUDE_CODE_QUESTION_PREVIEW_FORMAT;
  if (previewFormat === 'markdown' || previewFormat === 'html') {
    setQuestionPreviewFormat(previewFormat);
  } else if (
    !clientType.startsWith('sdk-') &&
    // Desktop 和 CCR 通过 toolConfig 传递 previewFormat；当功能被
    // 关闭时它们传 undefined —— 不要用 markdown 覆盖它。
    clientType !== 'claude-desktop' &&
    clientType !== 'local-agent' &&
    clientType !== 'remote'
  ) {
    setQuestionPreviewFormat('markdown');
  }

  // 为通过 `claude remote-control` 创建的会话打标，以便后端识别
  if (process.env.CLAUDE_CODE_ENVIRONMENT_KIND === 'bridge') {
    setSessionSource('remote-control');
  }

  profileCheckpoint('main_client_type_determined');

  // 在 init() 之前提前解析并加载 settings 标志
  eagerLoadSettings();

  profileCheckpoint('main_before_run');

  logForDebugging('[Hapii] Main.main 即将调用 run() 启动 Commander 分发', { level: 'info' });
  await run();
  profileCheckpoint('main_after_run');
}

async function getInputPrompt(
  prompt: string,
  inputFormat: 'text' | 'stream-json',
): Promise<string | AsyncIterable<string>> {
  if (
    !process.stdin.isTTY &&
    // 输入劫持会破坏 MCP。
    !process.argv.includes('mcp')
  ) {
    if (inputFormat === 'stream-json') {
      return process.stdin;
    }
    process.stdin.setEncoding('utf8');
    let data = '';
    const onData = (chunk: string) => {
      data += chunk;
    };
    process.stdin.on('data', onData);
    // 如果 3 秒内没有数据到达，停止等待并警告。Stdin 很可能是
    // 从不写入的父进程继承的管道（派生子进程时未显式处理 stdin）。
    // 3 秒覆盖了像 curl、对大文件的 jq、带 import 开销的 python 这样
    // 较慢的生产者。该警告使得对更慢的生产者造成的数据丢失可见。
    const timedOut = await peekForStdinData(process.stdin, 3000);
    process.stdin.off('data', onData);
    if (timedOut) {
      process.stderr.write(
        'Warning: no stdin data received in 3s, proceeding without it. ' +
          'If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.\n',
      );
    }
    return [prompt, data].filter(Boolean).join('\n');
  }
  return prompt;
}

/**
 * 创建 Commander.js 程序并注册所有子命令，然后解析命令行参数。
 *
 * 主要流程：
 *   1. 创建 CommanderCommand，配置帮助信息排序
 *   2. 注册 preAction hook（在每个命令执行前统一做初始化：init()、migrations、远程设置等）
 *   3. 注册所有子命令（mcp、server、ssh、open、auth、plugin、agents、doctor、update 等）
 *   4. 注册默认 action（即不带子命令时的交互模式入口）：
 *      - setup() 环境准备
 *      - 加载工具列表、MCP 配置、权限模式
 *      - 处理会话恢复（--resume / --continue）
 *      - 创建 Ink root 并调用 launchRepl() 进入交互界面
 */
async function run(): Promise<CommanderCommand> {
  profileCheckpoint('run_function_start');

  // 创建按 long option 名排序的帮助配置。
  // Commander 运行时支持 compareOptions，但 @commander-js/extra-typings
  // 没有把它包含在类型定义中，因此我们用 Object.assign 来添加。
  function createSortedHelpConfig(): {
    sortSubcommands: true;
    sortOptions: true;
  } {
    const getOptionSortKey = (opt: Option): string =>
      opt.long?.replace(/^--/, '') ?? opt.short?.replace(/^-/, '') ?? '';
    return Object.assign({ sortSubcommands: true, sortOptions: true } as const, {
      compareOptions: (a: Option, b: Option) => getOptionSortKey(a).localeCompare(getOptionSortKey(b)),
    });
  }
  const program = new CommanderCommand().configureHelp(createSortedHelpConfig()).enablePositionalOptions();
  profileCheckpoint('run_commander_initialized');

  // ── Commander preAction hook ─────────────────────────────────────────────
  // 在每个子命令（或默认命令）执行前统一运行，负责全局初始化。
  // 这样设计的好处：显示 --help 时不会触发这些初始化（只有真正执行命令才会）。
  // 使用 preAction hook 只在执行命令时运行初始化，
  // 而不是在显示帮助时运行。这避免了使用环境变量信号的需要。
  program.hook('preAction', async thisCommand => {
    profileCheckpoint('preAction_start');
    logForDebugging(`[Hapii] Main.preAction 触发 command=${thisCommand.name()}`, { level: 'info' });
    // await 模块求值时启动的异步子进程加载（12-20 行）。
    // 基本免费 —— 子进程在上面约 ~135ms 的 import 期间就完成了。
    // 必须在 init() 之前 resolve，因为 init() 会触发首次 settings 读取
    // （applySafeConfigEnvironmentVariables → getSettingsForSource('policySettings')
    // → isRemoteManagedSettingsEligible → 否则同步读取 keychain 约 ~65ms）。
    await Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()]);
    profileCheckpoint('preAction_after_mdm');
    await init();
    profileCheckpoint('preAction_after_init');
    logForDebugging('[Hapii] Main.preAction init() 完成', { level: 'info' });

    // process.title 在 Windows 上直接设置控制台标题；在 POSIX 上，
    // 终端 shell 集成可能会把进程名镜像到标签页。
    // 放在 init() 之后，以便 settings.json 环境变量也能控制它（gh-4765）。
    if (!isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE)) {
      process.title = 'claude';
    }

    // 挂载日志 sink，让子命令 handler 可以使用 logEvent/logError。
    // PR #11106 之前 logEvent 直接派发；之后事件会排队直到
    // sink 挂载。setup() 为默认命令挂载 sink，但
    // 子命令（doctor、mcp、plugin、auth）从不调用 setup()，会
    // 在 process.exit() 时静默丢弃事件。两个 init 都是幂等的。
    const { initSinks } = await import('./utils/sinks.js');
    initSinks();
    profileCheckpoint('preAction_after_sinks');

    // gh-33508：--plugin-dir 是顶层 program option。默认
    // action 从自己的 options 解构中读取它，但子命令
    // （plugin list、plugin install、mcp *）有自己的 action，
    // 永远看不到它。这里把它接上，让 getInlinePlugins() 在任何地方都能工作。
    // 这里 thisCommand.opts() 的类型是 {}，因为这个 hook 在
    // 链中的 .option('--plugin-dir', ...) 之前附加 —— extra-typings
    // 随 options 的添加而构建类型。用运行时守卫收窄；
    // collect 累加器 + [] 默认值在实践中保证是 string[]。
    const pluginDir = thisCommand.getOptionValue('pluginDir');
    if (Array.isArray(pluginDir) && pluginDir.length > 0 && pluginDir.every(p => typeof p === 'string')) {
      setInlinePlugins(pluginDir);
      clearPluginCache('preAction: --plugin-dir inline plugins');
    }

    runMigrations();
    profileCheckpoint('preAction_after_migrations');

    // 为企业客户加载远程托管设置（非阻塞）
    // Fail-open —— 如果拉取失败，继续运行不带远程设置
    // 设置到达时通过 hot-reload 应用
    // 必须在 init() 之后，以确保允许读取配置
    void loadRemoteManagedSettings();
    void loadPolicyLimits();

    profileCheckpoint('preAction_after_remote_settings');

    // 加载设置同步（非阻塞，fail-open）
    // CLI：上传本地设置到远程（CCR 下载由 print.ts 处理）
    if (feature('UPLOAD_USER_SETTINGS')) {
      void import('./services/settingsSync/index.js').then(m => m.uploadUserSettingsInBackground());
    }

    profileCheckpoint('preAction_after_settings_sync');
  });

  program
    .name('claude')
    .description(`Claude Code - starts an interactive session by default, use -p/--print for non-interactive output`)
    .argument('[prompt]', 'Your prompt', String)
    // 子命令通过 commander 的 copyInheritedSettings 继承 helpOption ——
    // 在这里设置一次即可覆盖 mcp、plugin、auth 及所有其他子命令。
    .helpOption('-h, --help', 'Display help for command')
    .option(
      '-d, --debug [filter]',
      'Enable debug mode with optional category filtering (e.g., "api,hooks" or "!1p,!file")',
      (_value: string | true) => {
        // 如果提供了 value，它将是过滤字符串
        // 如果未提供但标志存在，value 将为 true
        // 实际过滤在 debug.ts 中通过解析 process.argv 处理
        return true;
      },
    )
    .addOption(new Option('--debug-to-stderr', 'Enable debug mode (to stderr)').argParser(Boolean).hideHelp())
    .option(
      '--debug-file <path>',
      'Write debug logs to a specific file path (implicitly enables debug mode)',
      () => true,
    )
    .option('--verbose', 'Override verbose mode setting from config', () => true)
    .option(
      '-p, --print',
      'Print response and exit (useful for pipes). Note: The workspace trust dialog is skipped when Claude is run with the -p mode. Only use this flag in directories you trust.',
      () => true,
    )
    .option(
      '--bare',
      'Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, and CLAUDE.md auto-discovery. Sets CLAUDE_CODE_SIMPLE=1. Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read). 3P providers (Bedrock/Vertex/Foundry) use their own credentials. Skills still resolve via /skill-name. Explicitly provide context via: --system-prompt[-file], --append-system-prompt[-file], --add-dir (CLAUDE.md dirs), --mcp-config, --settings, --agents, --plugin-dir.',
      () => true,
    )
    .addOption(new Option('--init', 'Run Setup hooks with init trigger, then continue').hideHelp())
    .addOption(new Option('--init-only', 'Run Setup and SessionStart:startup hooks, then exit').hideHelp())
    .addOption(new Option('--maintenance', 'Run Setup hooks with maintenance trigger, then continue').hideHelp())
    .addOption(
      new Option(
        '--output-format <format>',
        'Output format (only works with --print): "text" (default), "json" (single result), or "stream-json" (realtime streaming)',
      ).choices(['text', 'json', 'stream-json']),
    )
    .addOption(
      new Option(
        '--json-schema <schema>',
        'JSON Schema for structured output validation. ' +
          'Example: {"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}',
      ).argParser(String),
    )
    .option(
      '--include-hook-events',
      'Include all hook lifecycle events in the output stream (only works with --output-format=stream-json)',
      () => true,
    )
    .option(
      '--include-partial-messages',
      'Include partial message chunks as they arrive (only works with --print and --output-format=stream-json)',
      () => true,
    )
    .addOption(
      new Option(
        '--input-format <format>',
        'Input format (only works with --print): "text" (default), or "stream-json" (realtime streaming input)',
      ).choices(['text', 'stream-json']),
    )
    .option(
      '--mcp-debug',
      '[DEPRECATED. Use --debug instead] Enable MCP debug mode (shows MCP server errors)',
      () => true,
    )
    .option(
      '--dangerously-skip-permissions',
      'Bypass all permission checks. Recommended only for sandboxes with no internet access.',
      () => true,
    )
    .option(
      '--allow-dangerously-skip-permissions',
      'Enable bypassing all permission checks as an option, without it being enabled by default. Recommended only for sandboxes with no internet access.',
      () => true,
    )
    .addOption(
      new Option('--thinking <mode>', 'Thinking mode: enabled (equivalent to adaptive), disabled')
        .choices(['enabled', 'adaptive', 'disabled'])
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--max-thinking-tokens <tokens>',
        '[DEPRECATED. Use --thinking instead for newer models] Maximum number of thinking tokens (only works with --print)',
      )
        .argParser(Number)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--max-turns <turns>',
        'Maximum number of agentic turns in non-interactive mode. This will early exit the conversation after the specified number of turns. (only works with --print)',
      )
        .argParser(Number)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--max-budget-usd <amount>',
        'Maximum dollar amount to spend on API calls (only works with --print)',
      ).argParser(value => {
        const amount = Number(value);
        if (isNaN(amount) || amount <= 0) {
          throw new Error('--max-budget-usd must be a positive number greater than 0');
        }
        return amount;
      }),
    )
    .addOption(
      new Option('--task-budget <tokens>', 'API-side task budget in tokens (output_config.task_budget)')
        .argParser(value => {
          const tokens = Number(value);
          if (isNaN(tokens) || tokens <= 0 || !Number.isInteger(tokens)) {
            throw new Error('--task-budget must be a positive integer');
          }
          return tokens;
        })
        .hideHelp(),
    )
    .option(
      '--replay-user-messages',
      'Re-emit user messages from stdin back on stdout for acknowledgment (only works with --input-format=stream-json and --output-format=stream-json)',
      () => true,
    )
    .addOption(new Option('--enable-auth-status', 'Enable auth status messages in SDK mode').default(false).hideHelp())
    .option(
      '--allowedTools, --allowed-tools <tools...>',
      'Comma or space-separated list of tool names to allow (e.g. "Bash(git:*) Edit")',
    )
    .option(
      '--tools <tools...>',
      'Specify the list of available tools from the built-in set. Use "" to disable all tools, "default" to use all tools, or specify tool names (e.g. "Bash,Edit,Read").',
    )
    .option(
      '--disallowedTools, --disallowed-tools <tools...>',
      'Comma or space-separated list of tool names to deny (e.g. "Bash(git:*) Edit")',
    )
    .option('--mcp-config <configs...>', 'Load MCP servers from JSON files or strings (space-separated)')
    .addOption(
      new Option('--permission-prompt-tool <tool>', 'MCP tool to use for permission prompts (only works with --print)')
        .argParser(String)
        .hideHelp(),
    )
    .addOption(new Option('--system-prompt <prompt>', 'System prompt to use for the session').argParser(String))
    .addOption(new Option('--system-prompt-file <file>', 'Read system prompt from a file').argParser(String).hideHelp())
    .addOption(
      new Option('--append-system-prompt <prompt>', 'Append a system prompt to the default system prompt').argParser(
        String,
      ),
    )
    .addOption(
      new Option(
        '--append-system-prompt-file <file>',
        'Read system prompt from a file and append to the default system prompt',
      )
        .argParser(String)
        .hideHelp(),
    )
    .addOption(
      new Option('--permission-mode <mode>', 'Permission mode to use for the session')
        .argParser(String)
        .choices(PERMISSION_MODES),
    )
    .option('-c, --continue', 'Continue the most recent conversation in the current directory', () => true)
    .option(
      '-r, --resume [value]',
      'Resume a conversation by session ID, or open interactive picker with optional search term',
      value => value || true,
    )
    .option(
      '--fork-session',
      'When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)',
      () => true,
    )
    .addOption(new Option('--prefill <text>', 'Pre-fill the prompt input with text without submitting it').hideHelp())
    .addOption(new Option('--deep-link-origin', 'Signal that this session was launched from a deep link').hideHelp())
    .addOption(
      new Option(
        '--deep-link-repo <slug>',
        'Repo slug the deep link ?repo= parameter resolved to the current cwd',
      ).hideHelp(),
    )
    .addOption(
      new Option('--deep-link-last-fetch <ms>', 'FETCH_HEAD mtime in epoch ms, precomputed by the deep link trampoline')
        .argParser(v => {
          const n = Number(v);
          return Number.isFinite(n) ? n : undefined;
        })
        .hideHelp(),
    )
    .option(
      '--from-pr [value]',
      'Resume a session linked to a PR by PR number/URL, or open interactive picker with optional search term',
      value => value || true,
    )
    .option(
      '--no-session-persistence',
      'Disable session persistence - sessions will not be saved to disk and cannot be resumed (only works with --print)',
    )
    .addOption(
      new Option(
        '--resume-session-at <message id>',
        'When resuming, only messages up to and including the assistant message with <message.id> (use with --resume in print mode)',
      )
        .argParser(String)
        .hideHelp(),
    )
    .addOption(
      new Option(
        '--rewind-files <user-message-id>',
        'Restore files to state at the specified user message and exit (requires --resume)',
      ).hideHelp(),
    )
    // @[MODEL LAUNCH]：更新 --model 帮助文本中的示例 model ID。
    .option(
      '--model <model>',
      `Model for the current session. Provide an alias for the latest model (e.g. 'sonnet' or 'opus') or a model's full name (e.g. 'claude-sonnet-4-6').`,
    )
    .addOption(
      new Option('--effort <level>', `Effort level for the current session (low, medium, high, max)`).argParser(
        (rawValue: string) => {
          const value = rawValue.toLowerCase();
          const allowed = ['low', 'medium', 'high', 'max'];
          if (!allowed.includes(value)) {
            throw new InvalidArgumentError(`It must be one of: ${allowed.join(', ')}`);
          }
          return value;
        },
      ),
    )
    .option('--agent <agent>', `Agent for the current session. Overrides the 'agent' setting.`)
    .option('--betas <betas...>', 'Beta headers to include in API requests (API key users only)')
    .option(
      '--fallback-model <model>',
      'Enable automatic fallback to specified model when default model is overloaded (only works with --print)',
    )
    .addOption(
      new Option(
        '--workload <tag>',
        'Workload tag for billing-header attribution (cc_workload). Process-scoped; set by SDK daemon callers that spawn subprocesses for cron work. (only works with --print)',
      ).hideHelp(),
    )
    .option(
      '--settings <file-or-json>',
      'Path to a settings JSON file or a JSON string to load additional settings from',
    )
    .option('--add-dir <directories...>', 'Additional directories to allow tool access to')
    .option('--ide', 'Automatically connect to IDE on startup if exactly one valid IDE is available', () => true)
    .option(
      '--strict-mcp-config',
      'Only use MCP servers from --mcp-config, ignoring all other MCP configurations',
      () => true,
    )
    .option('--session-id <uuid>', 'Use a specific session ID for the conversation (must be a valid UUID)')
    .option('-n, --name <name>', 'Set a display name for this session (shown in /resume and terminal title)')
    .option(
      '--agents <json>',
      'JSON object defining custom agents (e.g. \'{"reviewer": {"description": "Reviews code", "prompt": "You are a code reviewer"}}\')',
    )
    .option('--setting-sources <sources>', 'Comma-separated list of setting sources to load (user, project, local).')
    // gh-33508：<paths...>（可变参数）会吞噬直到下一个
    // --flag 之前的所有内容。`claude --plugin-dir /path mcp add --transport http` 会把
    // `mcp` 和 `add` 当作路径吞噬，然后在 --transport 上作为未知
    // 顶层 option 卡住。单值 + collect 累加器意味着每个
    // --plugin-dir 只取一个参数；多个目录时重复该标志。
    .option(
      '--plugin-dir <path>',
      'Load plugins from a directory for this session only (repeatable: --plugin-dir A --plugin-dir B)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option('--disable-slash-commands', 'Disable all skills', () => true)
    .option('--chrome', 'Enable Claude in Chrome integration')
    .option('--no-chrome', 'Disable Claude in Chrome integration')
    .option(
      '--file <specs...>',
      'File resources to download at startup. Format: file_id:relative_path (e.g., --file file_abc:doc.txt file_def:img.png)',
    )
    .action(async (prompt, options) => {
      profileCheckpoint('action_handler_start');
      logForDebugging(
        `[Hapii] Main.action 启动 hasPrompt=${!!prompt} options=${JSON.stringify(Object.keys(options as object))}`,
        { level: 'info' },
      );

      // --bare = 一键切换的最小模式。设置 SIMPLE，让所有现有的
      // gate 触发（CLAUDE.md、skills、executeHooks 内的 hooks、agent
      // 目录遍历）。必须在 setup() / 任何被 gate 的工作运行之前设置。
      if ((options as { bare?: boolean }).bare) {
        process.env.CLAUDE_CODE_SIMPLE = '1';
      }

      // 忽略作为 prompt 的 "code" —— 视同无 prompt
      if (prompt === 'code') {
        logEvent('tengu_code_prompt_ignored', {});
        console.warn(chalk.yellow('Tip: You can launch Claude Code with just `claude`'));
        prompt = undefined;
      }

      // 为任何单词 prompt 记录事件
      if (prompt && typeof prompt === 'string' && !/\s/.test(prompt) && prompt.length > 0) {
        logEvent('tengu_single_word_prompt', { length: prompt.length });
      }

      // Assistant 模式：当 .claude/settings.json 中 assistant: true 且
      // tengu_kairos GrowthBook 开关开启时，强制打开 brief。权限
      // 模式交给用户 —— settings defaultMode 或 --permission-mode
      // 照常应用。REPL 输入的消息默认就是 'next'
      // 优先级（messageQueueManager.enqueue），因此它们在回合中 tool 调用之间
      // 排空。SendUserMessage（BriefTool）通过 brief 环境
      // 变量启用。SleepTool 保持禁用（其 isEnabled() 以 proactive 为门控）。
      // kairosEnabled 在此处计算一次，并在下方
      // getAssistantSystemPromptAddendum() 调用处复用。
      //
      // Trust gate：.claude/settings.json 在不受信任的
      // 克隆中可被攻击者控制。我们在 showSetupScreens() 显示
      // trust dialog 之前运行约 1000 行，而那时我们早已把
      // .claude/agents/assistant.md 追加到系统 prompt。拒绝激活，
      // 直到目录被显式信任。
      let kairosEnabled = false;
      let assistantTeamContext:
        | Awaited<ReturnType<NonNullable<typeof assistantModule>['initializeAssistantTeam']>>
        | undefined;
      if (feature('KAIROS') && (options as { assistant?: boolean }).assistant && assistantModule) {
        // --assistant（Agent SDK daemon 模式）：在
        // 下面的 isAssistantMode() 运行之前强制 latch。daemon 已经检查过
        // entitlement —— 不要让子进程重复检查 tengu_kairos。
        assistantModule.markAssistantForced();
      }
      if (
        feature('KAIROS') &&
        assistantModule &&
        (assistantModule.isAssistantForced() || (options as Record<string, unknown>).assistant === true) &&
        // 派生的 teammates 共享 leader 的 cwd + settings.json，所以
        // 对它们而言该标志也为 true。--agent-id 被设置
        // 意味着我们 IS 一个被派生的 teammate（extractTeammateOptions 在
        // 约 170 行之后运行，因此这里检查原始 commander option）—— 不要
        // 重新初始化 team 或覆盖 teammateMode/proactive/brief。
        !(options as { agentId?: unknown }).agentId &&
        kairosGate
      ) {
        if (!checkHasTrustDialogAccepted()) {
          console.warn(
            chalk.yellow('Assistant mode disabled: directory is not trusted. Accept the trust dialog and restart.'),
          );
        } else {
          // 阻塞式 gate 检查 —— 命中缓存时立即返回 `true`；如果磁盘
          // 缓存为 false/缺失，懒初始化 GrowthBook 并拉取新鲜值
          // （最多 ~5s）。--assistant 完全跳过该 gate（daemon 已
          // 预授权）。
          kairosEnabled = assistantModule.isAssistantForced() || (await kairosGate.isKairosEnabled());
          if (kairosEnabled) {
            const opts = options as { brief?: boolean };
            opts.brief = true;
            setKairosActive(true);
            // 预种一个进程内 team，让 Agent(name: "foo") 无需
            // TeamCreate 即可派生 teammates。必须在 setup() 捕获
            // teammateMode 快照之前运行（initializeAssistantTeam 内部调用
            // setCliTeammateModeOverride）。
            assistantTeamContext = await assistantModule.initializeAssistantTeam();
          }
        }
      }

      const {
        debug = false,
        debugToStderr = false,
        dangerouslySkipPermissions,
        allowDangerouslySkipPermissions = false,
        tools: baseTools = [],
        allowedTools = [],
        disallowedTools = [],
        mcpConfig = [],
        permissionMode: permissionModeCli,
        addDir = [],
        fallbackModel,
        betas = [],
        ide = false,
        sessionId,
        includeHookEvents,
        includePartialMessages,
      } = options;

      if (options.prefill) {
        seedEarlyInput(options.prefill);
      }

      // 文件下载的 Promise —— 尽早启动，在 REPL 渲染前 await
      let fileDownloadPromise: Promise<DownloadResult[]> | undefined;

      const agentsJson = options.agents;
      const agentCli = options.agent;
      if (feature('BG_SESSIONS') && agentCli) {
        process.env.CLAUDE_CODE_AGENT = agentCli;
      }

      // NOTE：LSP manager 初始化被有意推迟到
      // trust dialog 被接受之后。这可以防止 plugin LSP 服务器在
      // 用户同意之前在不受信任的目录中执行代码。

      // 单独解构，以便需要时可以修改
      let outputFormat = options.outputFormat;
      let inputFormat = options.inputFormat;
      let verbose = options.verbose ?? getGlobalConfig().verbose;
      let print = options.print;
      const init = options.init ?? false;
      const initOnly = options.initOnly ?? false;
      const maintenance = options.maintenance ?? false;

      // 提取 disable slash commands 标志
      const disableSlashCommands = options.disableSlashCommands || false;

      // 提取 tasks 模式选项（仅 ant）
      const tasksOption = process.env.USER_TYPE === 'ant' && (options as { tasks?: boolean | string }).tasks;
      const taskListId = tasksOption
        ? typeof tasksOption === 'string'
          ? tasksOption
          : DEFAULT_TASKS_MODE_TASK_LIST_ID
        : undefined;
      if (process.env.USER_TYPE === 'ant' && taskListId) {
        process.env.CLAUDE_CODE_TASK_LIST_ID = taskListId;
      }

      // 提取 worktree 选项
      // worktree 可以为 true（无值的标志）或字符串（自定义名称或 PR 引用）
      const worktreeOption = isWorktreeModeEnabled()
        ? (options as { worktree?: boolean | string }).worktree
        : undefined;
      let worktreeName = typeof worktreeOption === 'string' ? worktreeOption : undefined;
      const worktreeEnabled = worktreeOption !== undefined;

      // 检查 worktree 名称是否为 PR 引用（#N 或 GitHub PR URL）
      let worktreePRNumber: number | undefined;
      if (worktreeName) {
        const prNum = parsePRReference(worktreeName);
        if (prNum !== null) {
          worktreePRNumber = prNum;
          worktreeName = undefined; // slug 将在 setup() 中生成
        }
      }

      // 提取 tmux 选项（需要 --worktree）
      const tmuxEnabled = isWorktreeModeEnabled() && (options as { tmux?: boolean }).tmux === true;

      // 校验 tmux 选项
      if (tmuxEnabled) {
        if (!worktreeEnabled) {
          process.stderr.write(chalk.red('Error: --tmux requires --worktree\n'));
          process.exit(1);
        }
        if (getPlatform() === 'windows') {
          process.stderr.write(chalk.red('Error: --tmux is not supported on Windows\n'));
          process.exit(1);
        }
        if (!(await isTmuxAvailable())) {
          process.stderr.write(chalk.red(`Error: tmux is not installed.\n${getTmuxInstallInstructions()}\n`));
          process.exit(1);
        }
      }

      // 提取 teammate 选项（用于 tmux 派生的 agent）
      // 在 if 块外声明，以便后续 system prompt addendum 处可访问
      let storedTeammateOpts: TeammateOptions | undefined;
      if (isAgentSwarmsEnabled()) {
        // 提取 agent 身份选项（用于 tmux 派生的 agent）
        // 这些替代了 CLAUDE_CODE_* 环境变量
        const teammateOpts = extractTeammateOptions(options);
        storedTeammateOpts = teammateOpts;

        // 如果提供了任何 teammate 身份选项，则三个必需项必须全部存在
        const hasAnyTeammateOpt = teammateOpts.agentId || teammateOpts.agentName || teammateOpts.teamName;
        const hasAllRequiredTeammateOpts = teammateOpts.agentId && teammateOpts.agentName && teammateOpts.teamName;

        if (hasAnyTeammateOpt && !hasAllRequiredTeammateOpts) {
          process.stderr.write(
            chalk.red('Error: --agent-id, --agent-name, and --team-name must all be provided together\n'),
          );
          process.exit(1);
        }

        // 如果通过 CLI 提供了 teammate 身份，设置 dynamicTeamContext
        if (teammateOpts.agentId && teammateOpts.agentName && teammateOpts.teamName) {
          getTeammateUtils().setDynamicTeamContext?.({
            agentId: teammateOpts.agentId,
            agentName: teammateOpts.agentName,
            teamName: teammateOpts.teamName,
            color: teammateOpts.agentColor,
            planModeRequired: teammateOpts.planModeRequired ?? false,
            parentSessionId: teammateOpts.parentSessionId,
          });
        }

        // 如提供则设置 teammate 模式 CLI 覆盖
        // 必须在 setup() 捕获快照之前完成
        if (teammateOpts.teammateMode) {
          getTeammateModeSnapshot().setCliTeammateModeOverride?.(teammateOpts.teammateMode);
        }
      }

      // 提取远程 sdk 选项
      const sdkUrl = (options as { sdkUrl?: string }).sdkUrl ?? undefined;

      // 允许通过环境变量启用 partial messages（供 baku 的 sandbox gateway 使用）
      const effectiveIncludePartialMessages =
        includePartialMessages || isEnvTruthy(process.env.CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES);

      // 当通过 SDK 选项显式请求或运行在 CLAUDE_CODE_REMOTE 模式（CCR 需要）时
      // 启用所有 hook 事件类型。
      // 否则只会发射 SessionStart 和 Setup 事件。
      if (includeHookEvents || isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
        setAllHookEventsEnabled(true);
      }

      // 提供 SDK URL 时自动设置 input/output 格式、verbose 模式和 print 模式
      if (sdkUrl) {
        // 如果提供了 SDK URL，除非显式设置，否则自动使用 stream-json 格式
        if (!inputFormat) {
          inputFormat = 'stream-json';
        }
        if (!outputFormat) {
          outputFormat = 'stream-json';
        }
        // 除非显式禁用或已设置，否则自动启用 verbose 模式
        if (options.verbose === undefined) {
          verbose = true;
        }
        // 除非显式禁用，否则自动启用 print 模式
        if (!options.print) {
          print = true;
        }
      }

      // 提取 teleport 选项
      const teleport = (options as { teleport?: string | true }).teleport ?? null;

      // 提取 remote 选项（无描述时可为 true，或为字符串）
      const remoteOption = (options as { remote?: string | true }).remote;
      const remote = remoteOption === true ? '' : (remoteOption ?? null);

      // 提取 --remote-control / --rc 标志（在交互式会话中启用 bridge）
      const remoteControlOption =
        (options as { remoteControl?: string | true }).remoteControl ?? (options as { rc?: string | true }).rc;
      // 真正的 bridge 检查推迟到 showSetupScreens() 之后，以便
      // trust 已确立且 GrowthBook 拥有 auth 头。
      let remoteControl = false;
      const remoteControlName =
        typeof remoteControlOption === 'string' && remoteControlOption.length > 0 ? remoteControlOption : undefined;

      // 如果提供了 session ID，校验
      if (sessionId) {
        // 检查冲突标志
        // 当同时提供 --fork-session 时，--session-id 可与 --continue 或 --resume 一起使用
        // （用于为 fork 的会话指定自定义 ID）
        if ((options.continue || options.resume) && !options.forkSession) {
          process.stderr.write(
            chalk.red(
              'Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.\n',
            ),
          );
          process.exit(1);
        }

        // 当提供 --sdk-url（bridge/remote 模式）时，session ID 是
        // 服务器分配的带 tag 的 ID（例如 "session_local_01..."），而非
        // UUID。此时跳过 UUID 校验和本地存在性检查。
        if (!sdkUrl) {
          const validatedSessionId = validateUuid(sessionId);
          if (!validatedSessionId) {
            process.stderr.write(chalk.red('Error: Invalid session ID. Must be a valid UUID.\n'));
            process.exit(1);
          }

          // 检查 session ID 是否已存在
          if (sessionIdExists(validatedSessionId)) {
            process.stderr.write(chalk.red(`Error: Session ID ${validatedSessionId} is already in use.\n`));
            process.exit(1);
          }
        }
      }

      // 下载通过 --file 标志指定的文件资源
      const fileSpecs = (options as { file?: string[] }).file;
      if (fileSpecs && fileSpecs.length > 0) {
        // 获取 session ingress token（由 EnvManager 通过 CLAUDE_CODE_SESSION_ACCESS_TOKEN 提供）
        const sessionToken = getSessionIngressAuthToken();
        if (!sessionToken) {
          process.stderr.write(
            chalk.red(
              'Error: Session token required for file downloads. CLAUDE_CODE_SESSION_ACCESS_TOKEN must be set.\n',
            ),
          );
          process.exit(1);
        }

        // 解析 session ID：优先使用远程 session ID，回退到内部 session ID
        const fileSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID || getSessionId();

        const files = parseFileSpecs(fileSpecs);
        if (files.length > 0) {
          // 若设置了 ANTHROPIC_BASE_URL（由 EnvManager 设置）则使用它，否则使用 OAuth 配置
          // 这确保在所有环境中与 session ingress API 保持一致
          const config: FilesApiConfig = {
            baseUrl: process.env.ANTHROPIC_BASE_URL || getOauthConfig().BASE_API_URL,
            oauthToken: sessionToken,
            sessionId: fileSessionId,
          };

          // 不阻塞启动开始下载 —— 在 REPL 渲染前 await
          fileDownloadPromise = downloadSessionFiles(files, config);
        }
      }

      // 从 state 获取 isNonInteractiveSession（在 init() 之前已设置）
      const isNonInteractiveSession = getIsNonInteractiveSession();

      // 校验 fallback 模型不同于主模型
      if (fallbackModel && options.model && fallbackModel === options.model) {
        process.stderr.write(
          chalk.red(
            'Error: Fallback model cannot be the same as the main model. Please specify a different model for --fallback-model.\n',
          ),
        );
        process.exit(1);
      }

      // 处理 system prompt 选项
      let systemPrompt = options.systemPrompt;
      if (options.systemPromptFile) {
        if (options.systemPrompt) {
          process.stderr.write(
            chalk.red('Error: Cannot use both --system-prompt and --system-prompt-file. Please use only one.\n'),
          );
          process.exit(1);
        }

        try {
          const filePath = resolve(options.systemPromptFile);
          systemPrompt = readFileSync(filePath, 'utf8');
        } catch (error) {
          const code = getErrnoCode(error);
          if (code === 'ENOENT') {
            process.stderr.write(
              chalk.red(`Error: System prompt file not found: ${resolve(options.systemPromptFile)}\n`),
            );
            process.exit(1);
          }
          process.stderr.write(chalk.red(`Error reading system prompt file: ${errorMessage(error)}\n`));
          process.exit(1);
        }
      }

      // 处理 append system prompt 选项
      let appendSystemPrompt = options.appendSystemPrompt;
      if (options.appendSystemPromptFile) {
        if (options.appendSystemPrompt) {
          process.stderr.write(
            chalk.red(
              'Error: Cannot use both --append-system-prompt and --append-system-prompt-file. Please use only one.\n',
            ),
          );
          process.exit(1);
        }

        try {
          const filePath = resolve(options.appendSystemPromptFile);
          appendSystemPrompt = readFileSync(filePath, 'utf8');
        } catch (error) {
          const code = getErrnoCode(error);
          if (code === 'ENOENT') {
            process.stderr.write(
              chalk.red(`Error: Append system prompt file not found: ${resolve(options.appendSystemPromptFile)}\n`),
            );
            process.exit(1);
          }
          process.stderr.write(chalk.red(`Error reading append system prompt file: ${errorMessage(error)}\n`));
          process.exit(1);
        }
      }

      // 为 tmux teammates 追加 teammate 专属 system prompt addendum
      if (
        isAgentSwarmsEnabled() &&
        storedTeammateOpts?.agentId &&
        storedTeammateOpts?.agentName &&
        storedTeammateOpts?.teamName
      ) {
        const addendum = getTeammatePromptAddendum().TEAMMATE_SYSTEM_PROMPT_ADDENDUM;
        appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${addendum}` : addendum;
      }

      const { mode: permissionMode, notification: permissionModeNotification } = initialPermissionModeFromCLI({
        permissionModeCli,
        dangerouslySkipPermissions,
      });

      // 存储 session bypass permissions mode，供 trust dialog 检查
      setSessionBypassPermissionsMode(permissionMode === 'bypassPermissions');
      if (feature('TRANSCRIPT_CLASSIFIER')) {
        // autoModeFlagCli 是"用户本会话是否想要 auto"的信号。
        // 在以下情况下设置：--enable-auto-mode、--permission-mode auto、解析后的模式
        // 为 auto，或 settings defaultMode 为 auto 但 gate 拒绝了它
        // （permissionMode 解析为 default 且没有显式 CLI 覆盖）。
        // verifyAutoModeGateAccess 用它来决定是否在 auto 不可用时通知，
        // tengu_auto_mode_config opt-in carousel 也会用它。
        if (
          (options as { enableAutoMode?: boolean }).enableAutoMode ||
          permissionModeCli === 'auto' ||
          permissionMode === 'auto' ||
          (!permissionModeCli && isDefaultPermissionModeAuto())
        ) {
          autoModeStateModule?.setAutoModeFlagCli(true);
        }
      }

      // 解析 MCP 配置文件/字符串（如提供）
      let dynamicMcpConfig: Record<string, ScopedMcpServerConfig> = {
        // 内置 MCP 服务器（默认禁用，用户通过 /mcp 启用）
        'mcp-chrome': {
          type: 'http',
          url: 'http://127.0.0.1:12306/mcp',
          scope: 'dynamic',
          headers: {
            Authorization: 'Bearer my-static-token',
          },
        },
      };

      if (mcpConfig && mcpConfig.length > 0) {
        // 处理 mcpConfig 数组
        const processedConfigs = mcpConfig.map(config => config.trim()).filter(config => config.length > 0);

        let allConfigs: Record<string, McpServerConfig> = {};
        const allErrors: ValidationError[] = [];

        for (const configItem of processedConfigs) {
          let configs: Record<string, McpServerConfig> | null = null;
          let errors: ValidationError[] = [];

          // 首先尝试作为 JSON 字符串解析
          const parsedJson = safeParseJSON(configItem);
          if (parsedJson) {
            const result = parseMcpConfig({
              configObject: parsedJson,
              filePath: 'command line',
              expandVars: true,
              scope: 'dynamic',
            });
            if (result.config) {
              configs = result.config.mcpServers;
            } else {
              errors = result.errors;
            }
          } else {
            // 尝试作为文件路径
            const configPath = resolve(configItem);
            const result = parseMcpConfigFromFilePath({
              filePath: configPath,
              expandVars: true,
              scope: 'dynamic',
            });
            if (result.config) {
              configs = result.config.mcpServers;
            } else {
              errors = result.errors;
            }
          }

          if (errors.length > 0) {
            allErrors.push(...errors);
          } else if (configs) {
            // 合并配置，后者覆盖前者
            allConfigs = { ...allConfigs, ...configs };
          }
        }

        if (allErrors.length > 0) {
          const formattedErrors = allErrors.map(err => `${err.path ? err.path + ': ' : ''}${err.message}`).join('\n');
          logForDebugging(`--mcp-config validation failed (${allErrors.length} errors): ${formattedErrors}`, {
            level: 'error',
          });
          process.stderr.write(`Error: Invalid MCP configuration:\n${formattedErrors}\n`);
          process.exit(1);
        }

        if (Object.keys(allConfigs).length > 0) {
          // SDK hosts（Nest/Desktop）拥有自己的服务器命名，可能复用
          // 内置名称 —— 对 type:'sdk' 跳过保留名称检查。
          const nonSdkConfigNames = Object.entries(allConfigs)
            .filter(([, config]) => config.type !== 'sdk')
            .map(([name]) => name);

          let reservedNameError: string | null = null;
          if (nonSdkConfigNames.some(isClaudeInChromeMCPServer)) {
            reservedNameError = `Invalid MCP configuration: "${CLAUDE_IN_CHROME_MCP_SERVER_NAME}" is a reserved MCP name.`;
          } else if (feature('CHICAGO_MCP')) {
            const { isComputerUseMCPServer, COMPUTER_USE_MCP_SERVER_NAME } = await import(
              'src/utils/computerUse/common.js'
            );
            if (nonSdkConfigNames.some(isComputerUseMCPServer)) {
              reservedNameError = `Invalid MCP configuration: "${COMPUTER_USE_MCP_SERVER_NAME}" is a reserved MCP name.`;
            }
          }
          if (reservedNameError) {
            // stderr+exit(1) —— 这里的 throw 在 stream-json 模式下
            // （cli.tsx 中的 void main()）会变成静默的未处理 rejection。
            process.stderr.write(`Error: ${reservedNameError}\n`);
            process.exit(1);
          }

          // 为所有配置添加 dynamic scope。type:'sdk' 条目原样透传
          // —— 它们在下游被抽取到 sdkMcpConfigs 并
          // 传给 print.ts。Python SDK 依赖此路径（它的 initialize
          // 消息不发送 sdkMcpServers）。在这里丢弃它们会
          // 破坏 Coworker（inc-5122）。下方的 policy 过滤已豁免
          // type:'sdk'，且 stdin 上没有 SDK transport 时这些条目
          // 是惰性的，放行不会有绕过风险。
          const scopedConfigs = mapValues(allConfigs, config => ({
            ...config,
            scope: 'dynamic' as const,
          }));

          // 对 --mcp-config 服务器强制执行托管策略
          // （allowedMcpServers / deniedMcpServers）。否则 CLI 标志会绕过
          // getClaudeCodeMcpConfigs 中 user/project/local 配置所走的
          // 企业 allowlist —— 调用方会把 dynamicMcpConfig 反向覆盖
          // 到过滤后的结果上。这里在源头过滤，让所有
          // 下游消费者看到的是 policy 过滤后的集合。
          const { allowed, blocked } = filterMcpServersByPolicy(scopedConfigs);
          if (blocked.length > 0) {
            process.stderr.write(
              `Warning: MCP ${plural(blocked.length, 'server')} blocked by enterprise policy: ${blocked.join(', ')}\n`,
            );
          }
          dynamicMcpConfig = { ...dynamicMcpConfig, ...(allowed as Record<string, ScopedMcpServerConfig>) };
        }
      }

      // 提取 Claude in Chrome 选项并强制 claude.ai 订阅者检查（ant 用户除外）
      const chromeOpts = options as { chrome?: boolean };
      // 存储显式 CLI 标志，以便 teammates 继承它
      setChromeFlagOverride(chromeOpts.chrome);
      const enableClaudeInChrome =
        shouldEnableClaudeInChrome(chromeOpts.chrome) && (process.env.USER_TYPE === 'ant' || isClaudeAISubscriber());
      const autoEnableClaudeInChrome = !enableClaudeInChrome && shouldAutoEnableClaudeInChrome();

      if (enableClaudeInChrome) {
        const platform = getPlatform();
        try {
          logEvent('tengu_claude_in_chrome_setup', {
            platform: platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          });

          const {
            mcpConfig: chromeMcpConfig,
            allowedTools: chromeMcpTools,
            systemPrompt: chromeSystemPrompt,
          } = setupClaudeInChrome();
          dynamicMcpConfig = {
            ...dynamicMcpConfig,
            ...chromeMcpConfig,
          };
          allowedTools.push(...chromeMcpTools);
          if (chromeSystemPrompt) {
            appendSystemPrompt = appendSystemPrompt
              ? `${chromeSystemPrompt}\n\n${appendSystemPrompt}`
              : chromeSystemPrompt;
          }
        } catch (error) {
          logEvent('tengu_claude_in_chrome_setup_failed', {
            platform: platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          });
          logForDebugging(`[Claude in Chrome] Error: ${error}`);
          logError(error);
          console.error(`Error: Failed to run with Claude in Chrome.`);
          process.exit(1);
        }
      } else if (autoEnableClaudeInChrome) {
        try {
          const { mcpConfig: chromeMcpConfig } = setupClaudeInChrome();
          dynamicMcpConfig = {
            ...dynamicMcpConfig,
            ...chromeMcpConfig,
          };

          const hint =
            feature('WEB_BROWSER_TOOL') && typeof Bun !== 'undefined' && 'WebView' in Bun
              ? CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER
              : CLAUDE_IN_CHROME_SKILL_HINT;
          appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${hint}` : hint;
        } catch (error) {
          // 自动启用时静默跳过任何错误
          logForDebugging(`[Claude in Chrome] Error (auto-enable): ${error}`);
        }
      }

      // 提取 strict MCP config 标志
      const strictMcpConfig = options.strictMcpConfig || false;

      // 检查是否存在企业 MCP 配置。如果存在，仅允许包含
      // 特殊服务器类型（sdk）的动态 MCP 配置
      if (doesEnterpriseMcpConfigExist()) {
        if (strictMcpConfig) {
          process.stderr.write(
            chalk.red('You cannot use --strict-mcp-config when an enterprise MCP config is present'),
          );
          process.exit(1);
        }

        // 对于 --mcp-config，只有当所有服务器都是内部类型（sdk）时才允许
        if (dynamicMcpConfig && !areMcpConfigsAllowedWithEnterpriseMcpConfig(dynamicMcpConfig)) {
          process.stderr.write(
            chalk.red('You cannot dynamically configure MCP servers when an enterprise MCP config is present'),
          );
          process.exit(1);
        }
      }

      // chicago MCP：受保护的 Computer Use（app allowlist + frontmost gate +
      // SCContentFilter 截图）。仅限 Ant，GrowthBook 门控 —— 失败
      // 是静默的（这是内部 dogfooding）。Platform + interactive 检查内联，
      // 以便非 macOS / print 模式的 ant 跳过重量级的 @ant/computer-use-mcp
      // import。gates.js 很轻（仅类型 package import）。
      //
      // 放在 enterprise-MCP-config 检查之后：那个检查会拒绝任何
      // `type !== 'sdk'` 的 dynamicMcpConfig 条目，而我们的配置是
      // `type: 'stdio'`。否则一个开启 GB gate 的 enterprise-config ant 会
      // process.exit(1)。Chrome 也有同样的潜在问题，但
      // 一直没出过事故；chicago 把自己摆在正确的位置。
      if (feature('CHICAGO_MCP') && getPlatform() !== 'unknown' && !getIsNonInteractiveSession()) {
        try {
          const { getChicagoEnabled } = await import('src/utils/computerUse/gates.js');
          if (getChicagoEnabled()) {
            const { setupComputerUseMCP } = await import('src/utils/computerUse/setup.js');
            const { mcpConfig, allowedTools: cuTools } = setupComputerUseMCP();
            dynamicMcpConfig = {
              ...dynamicMcpConfig,
              ...mcpConfig,
            };
            allowedTools.push(...cuTools);
          }
        } catch (error) {
          logForDebugging(`[Computer Use MCP] Setup failed: ${errorMessage(error)}`);
        }
      }

      // 为 CLAUDE.md 加载存储额外目录（由环境变量控制）
      setAdditionalDirectoriesForClaudeMd(addDir);

      // 来自 --channels 标志的 channel server allowlist —— 这些服务器的
      // 入站 push notification 应注册本会话。该选项
      // 位于 feature() 块内，因此 TS 在 options 类型上
      // 不知道它 —— 与 main.tsx:1824 的 --assistant 是同样的模式。
      // devChannels 是延迟的：showSetupScreens 会显示确认对话框，
      // 只有在接受时才追加到 allowedChannels。
      let devChannels: ChannelEntry[] | undefined;
      // 将 plugin:name@marketplace / server:Y 标签解析为类型化条目。
      // 标签决定下游的信任模型：plugin 类型走 marketplace
      // 校验 + GrowthBook allowlist，server 类型总是
      // allowlist 失败（schema 是 plugin-only），除非设置了 dev 标志。
      // 未打标签或无 marketplace 的 plugin 条目是硬错误 ——
      // 在 gate 中静默不匹配会让 channels 看起来
      // "已开"但永远不会触发。
      const parseChannelEntries = (raw: string[], flag: string): ChannelEntry[] => {
        const entries: ChannelEntry[] = [];
        const bad: string[] = [];
        for (const c of raw) {
          if (c.startsWith('plugin:')) {
            const rest = c.slice(7);
            const at = rest.indexOf('@');
            if (at <= 0 || at === rest.length - 1) {
              bad.push(c);
            } else {
              entries.push({
                kind: 'plugin',
                name: rest.slice(0, at),
                marketplace: rest.slice(at + 1),
              });
            }
          } else if (c.startsWith('server:') && c.length > 7) {
            entries.push({ kind: 'server', name: c.slice(7) });
          } else {
            bad.push(c);
          }
        }
        if (bad.length > 0) {
          process.stderr.write(
            chalk.red(
              `${flag} entries must be tagged: ${bad.join(', ')}\n` +
                `  plugin:<name>@<marketplace>  — plugin-provided channel (allowlist enforced)\n` +
                `  server:<name>                — manually configured MCP server\n`,
            ),
          );
          process.exit(1);
        }
        return entries;
      };

      const channelOpts = options as {
        channels?: string[];
        dangerouslyLoadDevelopmentChannels?: string[];
      };
      const rawChannels = channelOpts.channels;
      const rawDev = channelOpts.dangerouslyLoadDevelopmentChannels;
      // 始终解析 + 设置。ChannelsNotice 读取 getAllowedChannels() 并
      // 在启动屏幕渲染合适的分支（disabled/noAuth/policyBlocked/
      // listening）。gateChannelServer() 负责强制执行。
      // --channels 在交互和 print/SDK 模式下都工作；dev-channels
      // 仅限交互（需要确认对话框）。
      let channelEntries: ChannelEntry[] = [];
      if (rawChannels && rawChannels.length > 0) {
        channelEntries = parseChannelEntries(rawChannels, '--channels');
        setAllowedChannels(channelEntries);
      }
      if (!isNonInteractiveSession) {
        if (rawDev && rawDev.length > 0) {
          devChannels = parseChannelEntries(rawDev, '--dangerously-load-development-channels');
        }
      }
      // 标志使用遥测。Plugin 标识符被记录（与
      // tengu_plugin_installed 同 tier —— 公共 registry 式名称）；server 类型
      // 名称不记录（MCP-server-name tier，其他地方仅 opt-in）。
      // 每个 server 的 gate 结果在 server 连接后
      // 进入 tengu_mcp_channel_gate。Dev 条目在此之后
      // 会经过确认对话框 —— dev_plugins 捕获的是所输入的，而非所接受的。
      if (channelEntries.length > 0 || (devChannels?.length ?? 0) > 0) {
        const joinPluginIds = (entries: ChannelEntry[]) => {
          const ids = entries.flatMap(e => (e.kind === 'plugin' ? [`${e.name}@${e.marketplace}`] : []));
          return ids.length > 0
            ? (ids.sort().join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
            : undefined;
        };
        logEvent('tengu_mcp_channel_flags', {
          channels_count: channelEntries.length,
          dev_count: devChannels?.length ?? 0,
          plugins: joinPluginIds(channelEntries),
          dev_plugins: joinPluginIds(devChannels ?? []),
        });
      }

      // 通过 --tools 为 SendUserMessage 做 SDK opt-in。所有会话都需要
      // 显式 opt-in；在 --tools 中列出它表示意图。运行在
      // initializeToolPermissionContext 之前，以便 getToolsForDefaultPreset() 在
      // 计算 base-tools disallow 过滤器时看到该工具已启用。
      // 条件 require 避免把 tool-name 字符串泄漏到
      // 外部构建中。
      if ((feature('KAIROS') || feature('KAIROS_BRIEF')) && baseTools.length > 0) {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { BRIEF_TOOL_NAME, LEGACY_BRIEF_TOOL_NAME } =
          require('@claude-code-best/builtin-tools/tools/BriefTool/prompt.js') as typeof import('@claude-code-best/builtin-tools/tools/BriefTool/prompt.js');
        const { isBriefEntitled } =
          require('@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js') as typeof import('@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js');
        /* eslint-enable @typescript-eslint/no-require-imports */
        const parsed = parseToolListFromCLI(baseTools);
        if ((parsed.includes(BRIEF_TOOL_NAME) || parsed.includes(LEGACY_BRIEF_TOOL_NAME)) && isBriefEntitled()) {
          setUserMsgOptIn(true);
        }
      }

      // 这个 await 替换了启动路径中原本存在的阻塞式 existsSync/statSync 调用。
      // Wall-clock 时间不变；我们只是在 fs I/O 期间
      // 让出事件循环而不是阻塞它。参见 #19661。
      const initResult = await initializeToolPermissionContext({
        allowedToolsCli: allowedTools,
        disallowedToolsCli: disallowedTools,
        baseToolsCli: baseTools,
        permissionMode,
        allowDangerouslySkipPermissions,
        addDirs: addDir,
      });
      let toolPermissionContext = initResult.toolPermissionContext;
      const { warnings, dangerousPermissions, overlyBroadBashPermissions } = initResult;

      // 处理 ant 用户过于宽泛的 shell 允许规则（Bash(*)、PowerShell(*)）
      if (process.env.USER_TYPE === 'ant' && overlyBroadBashPermissions.length > 0) {
        for (const permission of overlyBroadBashPermissions) {
          logForDebugging(
            `Ignoring overly broad shell permission ${permission.ruleDisplay} from ${permission.sourceDisplay}`,
          );
        }
        toolPermissionContext = removeDangerousPermissions(toolPermissionContext, overlyBroadBashPermissions);
      }

      if (feature('TRANSCRIPT_CLASSIFIER') && dangerousPermissions.length > 0) {
        toolPermissionContext = stripDangerousPermissionsForAutoMode(toolPermissionContext);
      }

      // 打印初始化期间的任何警告
      warnings.forEach(warning => {
        console.error(warning);
      });

      // claude.ai config 拉取：仅 -p 模式（交互模式使用 useManageMCPConnections
      // 两阶段加载）。这里启动以便与 setup() 重叠；在
      // runHeadless 之前 await，这样单轮 -p 能看到 connectors。在
      // enterprise/strict MCP 下跳过，以保持策略边界。
      const claudeaiConfigPromise: Promise<Record<string, ScopedMcpServerConfig>> =
        isNonInteractiveSession &&
        !strictMcpConfig &&
        !doesEnterpriseMcpConfigExist() &&
        // --bare / SIMPLE：跳过 claude.ai proxy servers（datadog、Gmail、
        // Slack、BigQuery、PubMed —— 每个连接 6-14s）。需要 MCP 的脚本调用
        // 请显式传 --mcp-config。
        !isBareMode()
          ? fetchClaudeAIMcpConfigsIfEligible().then(configs => {
              const { allowed, blocked } = filterMcpServersByPolicy(configs);
              if (blocked.length > 0) {
                process.stderr.write(
                  `Warning: claude.ai MCP ${plural(blocked.length, 'server')} blocked by enterprise policy: ${blocked.join(', ')}\n`,
                );
              }
              return allowed;
            })
          : Promise.resolve({});

      // 尽早启动 MCP 配置加载（安全 —— 仅读文件，无执行）。
      // 交互和 -p 都使用 getClaudeCodeMcpConfigs（仅本地文件读取）。
      // 该本地 promise 会在稍后（prefetchAllMcpResources 之前）await，以便
      // 与 setup()、commands 加载和 trust dialog 重叠 config I/O。
      logForDebugging('[STARTUP] Loading MCP configs...');
      const mcpConfigStart = Date.now();
      let mcpConfigResolvedMs: number | undefined;
      // --bare 跳过自动发现的 MCP（.mcp.json、user settings、plugins）——
      // 只有显式的 --mcp-config 生效。dynamicMcpConfig 会被 spread 到
      // 下游的 allMcpConfigs，因此能在该跳过中存活。
      const mcpConfigPromise = (
        strictMcpConfig || isBareMode()
          ? Promise.resolve({
              servers: {} as Record<string, ScopedMcpServerConfig>,
            })
          : getClaudeCodeMcpConfigs(dynamicMcpConfig)
      ).then(result => {
        mcpConfigResolvedMs = Date.now() - mcpConfigStart;
        return result;
      });

      // 注意：我们不在此时调用 prefetchAllMcpResources —— 它被推迟到 trust dialog 之后

      if (inputFormat && inputFormat !== 'text' && inputFormat !== 'stream-json') {
        console.error(`Error: Invalid input format "${inputFormat}".`);
        process.exit(1);
      }
      if (inputFormat === 'stream-json' && outputFormat !== 'stream-json') {
        console.error(`Error: --input-format=stream-json requires output-format=stream-json.`);
        process.exit(1);
      }

      // 校验 sdkUrl 仅与合适的格式一起使用（格式已在上方自动设置）
      if (sdkUrl) {
        if (inputFormat !== 'stream-json' || outputFormat !== 'stream-json') {
          console.error(`Error: --sdk-url requires both --input-format=stream-json and --output-format=stream-json.`);
          process.exit(1);
        }
      }

      // 校验 replayUserMessages 仅与 stream-json 格式一起使用
      if (options.replayUserMessages) {
        if (inputFormat !== 'stream-json' || outputFormat !== 'stream-json') {
          console.error(
            `Error: --replay-user-messages requires both --input-format=stream-json and --output-format=stream-json.`,
          );
          process.exit(1);
        }
      }

      // 校验 includePartialMessages 仅与 print 模式和 stream-json 输出一起使用
      if (effectiveIncludePartialMessages) {
        if (!isNonInteractiveSession || outputFormat !== 'stream-json') {
          writeToStderr(`Error: --include-partial-messages requires --print and --output-format=stream-json.`);
          process.exit(1);
        }
      }

      // 校验 --no-session-persistence 仅与 print 模式一起使用
      if (options.sessionPersistence === false && !isNonInteractiveSession) {
        writeToStderr(`Error: --no-session-persistence can only be used with --print mode.`);
        process.exit(1);
      }

      const effectivePrompt = prompt || '';
      let inputPrompt = await getInputPrompt(effectivePrompt, (inputFormat ?? 'text') as 'text' | 'stream-json');
      profileCheckpoint('action_after_input_prompt');

      // 在 getTools() 之前激活 proactive 模式，以便 SleepTool.isEnabled()
      // （返回 isProactiveActive()）通过并且 Sleep 被包含。
      // 后续 REPL 路径的 maybeActivateProactive() 调用是幂等的。
      maybeActivateProactive(options);

      let tools = getTools(toolPermissionContext);

      // 为无头路径应用 coordinator 模式工具过滤
      // （镜像 REPL/interactive 路径下 useMergedTools.ts 的过滤）
      if (feature('COORDINATOR_MODE') && isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)) {
        const { applyCoordinatorToolFilter } = await import('./utils/toolPool.js');
        tools = applyCoordinatorToolFilter(tools);
      }

      profileCheckpoint('action_tools_loaded');

      let jsonSchema: ToolInputJSONSchema | undefined;
      if (isSyntheticOutputToolEnabled({ isNonInteractiveSession }) && options.jsonSchema) {
        jsonSchema = jsonParse(options.jsonSchema) as ToolInputJSONSchema;
      }

      if (jsonSchema) {
        const syntheticOutputResult = createSyntheticOutputTool(jsonSchema);
        if ('tool' in syntheticOutputResult) {
          // 在 getTools() 过滤之后将 SyntheticOutputTool 添加到 tools 数组。
          // 该工具被正常过滤排除（见 tools.ts），因为它是
          // 结构化输出的实现细节，而非用户控制的工具。
          tools = [...tools, syntheticOutputResult.tool];

          logEvent('tengu_structured_output_enabled', {
            schema_property_count: Object.keys((jsonSchema.properties as Record<string, unknown>) || {})
              .length as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            has_required_fields: Boolean(
              jsonSchema.required,
            ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          });
        } else {
          logEvent('tengu_structured_output_failure', {
            error: 'Invalid JSON schema' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          });
        }
      }

      // 重要：setup() 必须先于任何依赖 cwd 或 worktree setup 的代码运行
      profileCheckpoint('action_before_setup');
      logForDebugging('[STARTUP] Running setup()...');
      const setupStart = Date.now();
      const { setup } = await import('./setup.js');
      const messagingSocketPath = feature('UDS_INBOX')
        ? (options as { messagingSocketPath?: string }).messagingSocketPath
        : undefined;
      // setup() 与 commands+agents 加载并行执行。setup() 的 ~28ms 主要
      // 花在 startUdsMessaging（socket bind，~20ms）—— 不是磁盘 I/O，因此
      // 不会与 getCommands 的文件读取竞争。用 !worktreeEnabled gate，因为
      // --worktree 会让 setup() 执行 process.chdir()（setup.ts:203），而
      // commands/agents 需要 chdir 之后的 cwd。
      const preSetupCwd = getCwd();
      // 在启动 getCommands() 之前注册 bundled skills/plugins —— 它们是
      // 纯内存数组 push（<1ms，零 I/O），而 getBundledSkills() 会同步读取。
      // 之前在 setup() 内部 ~20ms 的 await 点之后才执行，导致并行的
      // getCommands() memoize 了一个空列表。
      if (process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent') {
        initBuiltinPlugins();
        initBundledSkills();
      }
      const setupPromise = setup(
        preSetupCwd,
        permissionMode,
        allowDangerouslySkipPermissions,
        worktreeEnabled,
        worktreeName,
        tmuxEnabled,
        sessionId ? validateUuid(sessionId) : undefined,
        worktreePRNumber,
        messagingSocketPath,
      );
      const commandsPromise = worktreeEnabled ? null : getCommands(preSetupCwd);
      const agentDefsPromise = worktreeEnabled ? null : getAgentDefinitionsWithOverrides(preSetupCwd);
      // 抑制瞬态 unhandledRejection：在下面的 Promise.all join 之前，
      // 它们可能在 ~28ms 的 setupPromise await 期间 reject。
      commandsPromise?.catch(() => {});
      agentDefsPromise?.catch(() => {});
      await setupPromise;
      logForDebugging(`[STARTUP] setup() completed in ${Date.now() - setupStart}ms`);
      profileCheckpoint('action_after_setup');

      // 只有显式请求 socket 时，才把 user message 回放到 stream-json。
      // 自动生成的 socket 是被动的 —— 允许工具按需注入，但默认开启
      // 不应改变那些从不触碰它的 SDK 消费者的 stream-json 行为。
      // 既注入又希望注入内容出现在 stream 中的调用方，需要显式传
      // --messaging-socket-path（或 --replay-user-messages）。
      let effectiveReplayUserMessages = !!options.replayUserMessages;
      if (feature('UDS_INBOX')) {
        if (!effectiveReplayUserMessages && outputFormat === 'stream-json') {
          effectiveReplayUserMessages = !!(options as { messagingSocketPath?: string }).messagingSocketPath;
        }
      }

      if (getIsNonInteractiveSession()) {
        // 现在应用完整合并后的 settings env（含 project 范围
        // .claude/settings.json 的 PATH/GIT_DIR/GIT_WORK_TREE），让下面的
        // gitExe() 和 git spawn 能看到它。-p 模式下 trust 是隐式的；
        // managedEnv.ts:96-97 的 docstring 说明这里会应用 "潜在危险的
        // 环境变量，如 LD_PRELOAD、PATH"（来自所有来源）。下面
        // isNonInteractiveSession 分支里的后续调用是幂等的（Object.assign、
        // configureGlobalAgents 会弹出之前的 interceptor），并且会拾取
        // plugin 初始化之后 plugin 贡献的 env。project settings 此处已加载：
        // init() 里的 applySafeConfigEnvironmentVariables 调用了
        // managedEnv.ts:86 的 getSettings_DEPRECATED，它合并了所有启用的
        // 来源（含 projectSettings/localSettings）。
        applyConfigEnvironmentVariables();

        // 现在就派生 git status/log/branch，让子进程执行与下面的
        // getCommands await 以及 startDeferredPrefetches 并行。放在
        // setup() 之后以使用最终的 cwd（setup.ts:254 在 --worktree 时会
        // process.chdir(worktreePath)），也放在上面的
        // applyConfigEnvironmentVariables 之后，确保来自所有来源（trusted +
        // project）的 PATH/GIT_DIR/GIT_WORK_TREE 都已应用。getSystemContext
        // 已 memoize；startDeferredPrefetches 中的
        // prefetchSystemContextIfSafe 调用会命中缓存。await getIsGit()
        // 产生的 microtask 会在下面 getCommands 的 Promise.all await 处排空。
        // -p 模式下 trust 隐式成立（与 prefetchSystemContextIfSafe 同一 gate）。
        void getSystemContext();
        // getUserContext 也现在启动 —— 它的第一个 await（getMemoryFiles
        // 中的 fs.readFile）会自然让出，CLAUDE.md 的目录遍历就在 print.ts
        // 里 context Promise.all join 之前 ~280ms 的重叠窗口内完成。
        // startDeferredPrefetches 中的 void getUserContext() 则会命中
        // memoize 缓存。
        void getUserContext();
        // ensureModelStringsInitialized 也现在启动 —— 对 Bedrock 会触发
        // 100-200ms 的 profile 拉取，之前在 print.ts:739 被串行 await。
        // updateBedrockModelStrings 被 sequential() 包裹，await 会并入
        // 正在进行的 fetch。非 Bedrock 是同步 early-return（零成本）。
        void ensureModelStringsInitialized();
      }

      // 应用 --name：仅写缓存，避免在 --continue/--resume 最终确定
      // session ID 之前产生孤儿文件。materializeSessionFile 会在第一条
      // user message 时持久化它；REPL 的 useTerminalTitle 通过
      // getCurrentSessionTitle 读取。
      const sessionNameArg = options.name?.trim();
      if (sessionNameArg) {
        cacheSessionTitle(sessionNameArg);
      }

      // Ant 模型别名（capybara-fast 等）通过 tengu_ant_model_override
      // GrowthBook flag 解析。_CACHED_MAY_BE_STALE 同步读磁盘；磁盘由
      // fire-and-forget 写入填充。缓存冷启动时 parseUserSpecifiedModel
      // 返回未解析的别名，API 404，-p 在异步写入落地前退出 —— 新 pod
      // 上反复崩溃。这里 await init 可以填充内存中的 payload map，
      // _CACHED_MAY_BE_STALE 现在会优先检查它。加 gate 让热路径保持
      // 非阻塞：
      //  - 通过 --model 或 ANTHROPIC_MODEL 显式指定模型（两者都参与别名解析）
      //  - 没有 env override（它会在读磁盘前短路 _CACHED_MAY_BE_STALE）
      //  - 磁盘上没有该 flag（== null 也覆盖 #22279 之前被污染的 null）
      const explicitModel = options.model || process.env.ANTHROPIC_MODEL;
      if (
        process.env.USER_TYPE === 'ant' &&
        explicitModel &&
        explicitModel !== 'default' &&
        !hasGrowthBookEnvOverride('tengu_ant_model_override') &&
        getGlobalConfig().cachedGrowthBookFeatures?.['tengu_ant_model_override'] == null
      ) {
        await initializeGrowthBook();
      }

      // 对带 null 关键字的默认模型做特判
      // 注意：模型解析放在 setup() 之后，确保 AWS auth 之前 trust 已建立
      const userSpecifiedModel = options.model === 'default' ? getDefaultMainLoopModel() : options.model;
      const userSpecifiedFallbackModel = fallbackModel === 'default' ? getDefaultMainLoopModel() : fallbackModel;

      // 除非 setup() 执行了 chdir（worktreeEnabled），否则复用 preSetupCwd。
      // 省掉常见路径下的 getCwd() 系统调用。
      const currentCwd = worktreeEnabled ? getCwd() : preSetupCwd;
      logForDebugging('[STARTUP] Loading commands and agents...');
      const commandsStart = Date.now();
      // join setup() 之前启动的 promise（若被 worktreeEnabled gate 住
      // 则新启动）。两者都按 cwd memoize。
      const [commands, agentDefinitionsResult] = await Promise.all([
        commandsPromise ?? getCommands(currentCwd),
        agentDefsPromise ?? getAgentDefinitionsWithOverrides(currentCwd),
      ]);
      logForDebugging(`[STARTUP] Commands and agents loaded in ${Date.now() - commandsStart}ms`);
      profileCheckpoint('action_commands_loaded');

      // 解析通过 --agents flag 提供的 CLI agents
      let cliAgents: typeof agentDefinitionsResult.activeAgents = [];
      if (agentsJson) {
        try {
          const parsedAgents = safeParseJSON(agentsJson);
          if (parsedAgents) {
            cliAgents = parseAgentsFromJson(parsedAgents, 'flagSettings');
          }
        } catch (error) {
          logError(error);
        }
      }

      // 把 CLI agents 与现有的合并
      const allAgents = [...agentDefinitionsResult.allAgents, ...cliAgents];
      const agentDefinitions = {
        ...agentDefinitionsResult,
        allAgents,
        activeAgents: getActiveAgentsFromList(allAgents),
      };

      // 从 CLI flag 或 settings 中查找主线程 agent
      const agentSetting = agentCli ?? getInitialSettings().agent;
      let mainThreadAgentDefinition: (typeof agentDefinitions.activeAgents)[number] | undefined;
      if (agentSetting) {
        mainThreadAgentDefinition = agentDefinitions.activeAgents.find(agent => agent.agentType === agentSetting);
        if (!mainThreadAgentDefinition) {
          logForDebugging(
            `Warning: agent "${agentSetting}" not found. ` +
              `Available agents: ${agentDefinitions.activeAgents.map(a => a.agentType).join(', ')}. ` +
              `Using default behavior.`,
          );
        }
      }

      // 把主线程 agent 类型存入 bootstrap state，让 hooks 能访问
      setMainThreadAgentType(mainThreadAgentDefinition?.agentType);

      // 记录 agent flag 使用情况 —— 仅记录内置 agent 的名字，避免泄漏自定义 agent 名
      if (mainThreadAgentDefinition) {
        logEvent('tengu_agent_flag', {
          agentType: isBuiltInAgent(mainThreadAgentDefinition)
            ? (mainThreadAgentDefinition.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
            : ('custom' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          ...(agentCli && {
            source: 'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          }),
        });
      }

      // 把 agent 设置持久化到 session transcript，供 resume 视图展示和恢复
      if (mainThreadAgentDefinition?.agentType) {
        saveAgentSetting(mainThreadAgentDefinition.agentType);
      }

      // 在非交互式会话下应用 agent 的 system prompt
      // （交互式模式改用 buildEffectiveSystemPrompt）
      if (
        isNonInteractiveSession &&
        mainThreadAgentDefinition &&
        !systemPrompt &&
        !isBuiltInAgent(mainThreadAgentDefinition)
      ) {
        const agentSystemPrompt = mainThreadAgentDefinition.getSystemPrompt();
        if (agentSystemPrompt) {
          systemPrompt = agentSystemPrompt;
        }
      }

      // initialPrompt 放在最前，这样它的 slash 命令（若有）会先被处理；
      // 用户输入的文本作为尾部 context。
      // 仅当 inputPrompt 是字符串时才拼接。若是 AsyncIterable
      // （SDK stream-json 模式），模板插值会调用 .toString() 得到
      // "[object Object]"。AsyncIterable 的情况由 print.ts 中的
      // structuredIO.prependUserMessage() 处理。
      if (mainThreadAgentDefinition?.initialPrompt) {
        if (typeof inputPrompt === 'string') {
          inputPrompt = inputPrompt
            ? `${mainThreadAgentDefinition.initialPrompt}\n\n${inputPrompt}`
            : mainThreadAgentDefinition.initialPrompt;
        } else if (!inputPrompt) {
          inputPrompt = mainThreadAgentDefinition.initialPrompt;
        }
      }

      // 尽早计算 effective model，让 hooks 能与 MCP 并行
      // 若用户未指定 model 但 agent 有，则用 agent 的 model
      let effectiveModel = userSpecifiedModel;
      if (!effectiveModel && mainThreadAgentDefinition?.model && mainThreadAgentDefinition.model !== 'inherit') {
        effectiveModel = parseUserSpecifiedModel(mainThreadAgentDefinition.model);
      }

      setMainLoopModelOverride(effectiveModel);

      // 为 hooks 计算 resolved model（使用启动时用户指定的 model）
      setInitialMainLoopModel(getUserSpecifiedModelSetting() || null);
      const initialMainLoopModel = getInitialMainLoopModel();
      const resolvedInitialModel = parseUserSpecifiedModel(initialMainLoopModel ?? getDefaultMainLoopModel());

      let advisorModel: string | undefined;
      if (isAdvisorEnabled()) {
        const advisorOption = canUserConfigureAdvisor() ? (options as { advisor?: string }).advisor : undefined;
        if (advisorOption) {
          logForDebugging(`[AdvisorTool] --advisor ${advisorOption}`);
          if (!modelSupportsAdvisor(resolvedInitialModel)) {
            process.stderr.write(
              chalk.red(`Error: The model "${resolvedInitialModel}" does not support the advisor tool.\n`),
            );
            process.exit(1);
          }
          const normalizedAdvisorModel = normalizeModelStringForAPI(parseUserSpecifiedModel(advisorOption));
          if (!isValidAdvisorModel(normalizedAdvisorModel)) {
            process.stderr.write(chalk.red(`Error: The model "${advisorOption}" cannot be used as an advisor.\n`));
            process.exit(1);
          }
        }
        advisorModel = canUserConfigureAdvisor() ? (advisorOption ?? getInitialAdvisorSetting()) : advisorOption;
        if (advisorModel) {
          logForDebugging(`[AdvisorTool] Advisor model: ${advisorModel}`);
        }
      }

      // 对带 --agent-type 的 tmux teammate，追加自定义 agent 的 prompt
      if (
        isAgentSwarmsEnabled() &&
        storedTeammateOpts?.agentId &&
        storedTeammateOpts?.agentName &&
        storedTeammateOpts?.teamName &&
        storedTeammateOpts?.agentType
      ) {
        // 查找自定义 agent 定义
        const customAgent = agentDefinitions.activeAgents.find(a => a.agentType === storedTeammateOpts.agentType);
        if (customAgent) {
          // 获取 prompt —— 需要同时处理内置和自定义 agent
          let customPrompt: string | undefined;
          if (customAgent.source === 'built-in') {
            // 内置 agent 的 getSystemPrompt 接收 toolUseContext
            // 这里拿不到完整 toolUseContext，暂时跳过
            logForDebugging(
              `[teammate] Built-in agent ${storedTeammateOpts.agentType} - skipping custom prompt (not supported)`,
            );
          } else {
            // 自定义 agent 的 getSystemPrompt 无参数
            customPrompt = customAgent.getSystemPrompt();
          }

          // 为 tmux teammate 记录 agent memory 加载事件
          if (customAgent.memory) {
            logEvent('tengu_agent_memory_loaded', {
              ...(process.env.USER_TYPE === 'ant' && {
                agent_type: customAgent.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              }),
              scope: customAgent.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              source: 'teammate' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            });
          }

          if (customPrompt) {
            const customInstructions = `\n# Custom Agent Instructions\n${customPrompt}`;
            appendSystemPrompt = appendSystemPrompt
              ? `${appendSystemPrompt}\n\n${customInstructions}`
              : customInstructions;
          }
        } else {
          logForDebugging(`[teammate] Custom agent ${storedTeammateOpts.agentType} not found in available agents`);
        }
      }

      maybeActivateBrief(options);
      // defaultView: 'chat' 是持久化的 opt-in —— 检查 entitlement 并设置
      // userMsgOptIn，让工具 + prompt 段被激活。仅交互式模式：
      // defaultView 是显示偏好；SDK 会话没有显示，而 assistant 安装器
      // 会把 defaultView:'chat' 写到 settings.local.json，否则会泄漏到
      // 同目录下的 --print 会话。紧跟在 maybeActivateBrief() 之后执行，
      // 确保所有启动 opt-in 路径在下方任何 isBriefEnabled() 读取之前
      // （proactive prompt 的 briefVisibility）触发。GB kill-switch 之后
      // 残留的 'chat' 会因 entitlement 失败而落空。
      if (
        (feature('KAIROS') || feature('KAIROS_BRIEF')) &&
        !getIsNonInteractiveSession() &&
        !getUserMsgOptIn() &&
        getInitialSettings().defaultView === 'chat'
      ) {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { isBriefEntitled } =
          require('@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js') as typeof import('@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js');
        /* eslint-enable @typescript-eslint/no-require-imports */
        if (isBriefEntitled()) {
          setUserMsgOptIn(true);
        }
      }
      // Coordinator 模式有自己的 system prompt 且过滤掉了 Sleep，因此
      // 通用 proactive prompt 会让它调用一个用不了的工具，并与委派指令冲突。
      if (
        (feature('PROACTIVE') || feature('KAIROS')) &&
        ((options as { proactive?: boolean }).proactive || isEnvTruthy(process.env.CLAUDE_CODE_PROACTIVE)) &&
        !coordinatorModeModule?.isCoordinatorMode()
      ) {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const briefVisibility =
          feature('KAIROS') || feature('KAIROS_BRIEF')
            ? (
                require('@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js') as typeof import('@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js')
              ).isBriefEnabled()
              ? 'Call SendUserMessage at checkpoints to mark where things stand.'
              : 'The user will see any text you output.'
            : 'The user will see any text you output.';
        /* eslint-enable @typescript-eslint/no-require-imports */
        const proactivePrompt = `\n# Proactive Mode\n\nYou are in proactive mode. Take initiative — explore, act, and make progress without waiting for instructions.\n\nStart by briefly greeting the user.\n\nYou will receive periodic <tick> prompts. These are check-ins. Do whatever seems most useful, or call Sleep if there's nothing to do. ${briefVisibility}`;
        appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${proactivePrompt}` : proactivePrompt;
      }

      if (feature('KAIROS') && kairosEnabled && assistantModule) {
        const assistantAddendum = assistantModule.getAssistantSystemPromptAddendum();
        appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${assistantAddendum}` : assistantAddendum;
      }

      // Ink root 仅交互式会话需要 —— Ink 构造函数中的 patchConsole
      // 会在 headless 模式下吞掉 console 输出。
      let root!: Root;
      let getFpsMetrics!: () => FpsMetrics | undefined;
      let stats!: StatsStore;

      // 在命令加载完成后展示 setup 屏幕
      if (!isNonInteractiveSession) {
        const ctx = getRenderContext(false);
        getFpsMetrics = ctx.getFpsMetrics;
        stats = ctx.stats;
        // 在 Ink 挂载之前安装 asciicast 录制器（仅 ant 内部，通过 CLAUDE_CODE_TERMINAL_RECORDING=1 开启）
        if (process.env.USER_TYPE === 'ant') {
          installAsciicastRecorder();
        }

        const { createRoot } = await import('@anthropic/ink');
        root = await createRoot(ctx.renderOptions);

        // 在任何阻塞对话框渲染之前记录启动耗时。从 REPL 首次渲染
        // （旧位置）记录会包含用户在 trust/OAuth/onboarding/resume-picker
        // 上等待的时间 —— p99 约 70s 主要被对话框等待占据，而非代码路径启动。
        logEvent('tengu_timer', {
          event: 'startup' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          durationMs: Math.round(process.uptime() * 1000),
        });

        logForDebugging('[STARTUP] Running showSetupScreens()...');
        const setupScreensStart = Date.now();
        const onboardingShown = await showSetupScreens(
          root,
          permissionMode,
          allowDangerouslySkipPermissions,
          commands,
          enableClaudeInChrome,
          devChannels,
        );
        logForDebugging(`[STARTUP] showSetupScreens() completed in ${Date.now() - setupScreensStart}ms`);

        // 既然 trust 已建立且 GrowthBook 拿到了 auth headers，
        // 解析 --remote-control / --rc 的授权门槛。
        if (feature('BRIDGE_MODE') && remoteControlOption !== undefined) {
          const { getBridgeDisabledReason } = await import('./bridge/bridgeEnabled.js');
          const disabledReason = await getBridgeDisabledReason();
          remoteControl = disabledReason === null;
          if (disabledReason) {
            process.stderr.write(chalk.yellow(`${disabledReason}\n--rc flag ignored.\n`));
          }
        }

        // 检查待处理的 agent memory snapshot 更新（仅限 --agent 模式，ant 内部）
        if (
          feature('AGENT_MEMORY_SNAPSHOT') &&
          mainThreadAgentDefinition &&
          isCustomAgent(mainThreadAgentDefinition) &&
          mainThreadAgentDefinition.memory &&
          mainThreadAgentDefinition.pendingSnapshotUpdate
        ) {
          const agentDef = mainThreadAgentDefinition;
          const choice = await launchSnapshotUpdateDialog(root, {
            agentType: agentDef.agentType,
            scope: agentDef.memory!,
            snapshotTimestamp: agentDef.pendingSnapshotUpdate!.snapshotTimestamp,
          });
          if (choice === 'merge') {
            const { buildMergePrompt } = await import('./components/agents/SnapshotUpdateDialog.js');
            const mergePrompt = buildMergePrompt(agentDef.agentType, agentDef.memory!);
            inputPrompt = inputPrompt ? `${mergePrompt}\n\n${inputPrompt}` : mergePrompt;
          }
          agentDef.pendingSnapshotUpdate = undefined;
        }

        // 如果刚刚完成 onboarding，跳过执行 /login
        if (onboardingShown && prompt?.trim().toLowerCase() === '/login') {
          prompt = '';
        }

        if (onboardingShown) {
          // 用户在 onboarding 中登录后立即刷新依赖 auth 的服务。
          // 与 src/commands/login.tsx 中的登录后逻辑保持同步。
          void refreshRemoteManagedSettings();
          void refreshPolicyLimits();
          // 在 GrowthBook 刷新之前清理用户数据缓存，让它能读取到新凭证
          resetUserCache();
          // 登录后刷新 GrowthBook 以获取最新的 feature flags（例如 claude.ai MCPs）
          refreshGrowthBookAfterAuthChange();
          // 清理任何过期的 trusted device token，然后注册 Remote Control。
          // 两者都内部 self-gate 到 tengu_sessions_elevated_auth_enforcement
          // —— enrollTrustedDevice() 通过 checkGate_CACHED_OR_BLOCKING（会 await
          // 上面的 GrowthBook 重新初始化），clearTrustedDeviceToken() 通过同步
          // 缓存检查（可接受，因为 clear 是幂等的）。
          void import('./bridge/trustedDevice.js').then(m => {
            m.clearTrustedDeviceToken();
            return m.enrollTrustedDevice();
          });
        }

        // 校验当前 token 的 org 与 forceLoginOrgUUID 是否匹配（若 managed
        // settings 中设置了的话）。放在 onboarding 之后执行，确保 managed
        // settings 和登录状态都已完整加载。
        const orgValidation = await validateForceLoginOrg();
        if (!orgValidation.valid) {
          await exitWithError(root, (orgValidation as { valid: false; message: string }).message);
        }
      }

      // 如果已触发 gracefulShutdown（例如用户拒绝了 trust dialog），
      // process.exitCode 会被设置。跳过所有可能在进程退出前触发
      // 代码执行的后续操作（例如 trust 未建立时不应运行 apiKeyHelper）。
      if (process.exitCode !== undefined) {
        logForDebugging('Graceful shutdown initiated, skipping further initialization');
        return;
      }

      // 在 trust 建立之后（或在隐式信任的非交互模式下）初始化 LSP manager。
      // 防止 plugin LSP server 在用户同意之前就在不可信目录中执行代码。
      // 必须在内联 plugin 设置完成（如有）之后，以便包含 --plugin-dir 的 LSP server。
      initializeLspServerManager();

      // trust 建立后展示 settings 校验错误
      // MCP 配置错误不会阻塞 settings 加载，因此排除
      if (!isNonInteractiveSession) {
        const { errors } = getSettingsWithErrors();
        const nonMcpErrors = errors.filter(e => !e.mcpErrorMetadata);
        if (nonMcpErrors.length > 0) {
          await launchInvalidSettingsDialog(root, {
            settingsErrors: nonMcpErrors,
            onExit: () => gracefulShutdownSync(1),
          });
        }
      }

      // trust 建立后检查配额状态、fast mode、passes eligibility 和 bootstrap 数据。
      // 这些会发起 API 调用，可能触发 apiKeyHelper 执行。
      // --bare / SIMPLE：跳过 —— 这些是为了 REPL 首轮响应速度而做的缓存预热
      // （quota、passes、fastMode、bootstrap 数据）。Fast mode 本来就不适用于
      // Agent SDK（见 getFastModeUnavailableReason）。
      const bgRefreshThrottleMs = getFeatureValue_CACHED_MAY_BE_STALE('tengu_cicada_nap_ms', 0);
      const lastPrefetched = getGlobalConfig().startupPrefetchedAt ?? 0;
      const skipStartupPrefetches =
        isBareMode() || (bgRefreshThrottleMs > 0 && Date.now() - lastPrefetched < bgRefreshThrottleMs);

      if (!skipStartupPrefetches) {
        const lastPrefetchedInfo =
          lastPrefetched > 0 ? ` last ran ${Math.round((Date.now() - lastPrefetched) / 1000)}s ago` : '';
        logForDebugging(`Starting background startup prefetches${lastPrefetchedInfo}`);

        checkQuotaStatus().catch(error => logError(error));

        // 从服务端拉取 bootstrap 数据并更新所有缓存值。
        void fetchBootstrapData();

        // TODO：将其他 prefetch 合并到一次 bootstrap 请求中。
        void prefetchPassesEligibility();
        if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_miraculo_the_bard', false)) {
          void prefetchFastModeStatus();
        } else {
          // Kill switch 只跳过网络调用，不跳过组织策略执行。
          // 从缓存解析，避免 orgStatus 留在 'pending' 状态
          // （getFastModeUnavailableReason 会把 'pending' 当作放行）。
          resolveFastModeStatusFromCache();
        }
        if (bgRefreshThrottleMs > 0) {
          saveGlobalConfig(current => ({
            ...current,
            startupPrefetchedAt: Date.now(),
          }));
        }
      } else {
        logForDebugging(
          `Skipping startup prefetches, last ran ${Math.round((Date.now() - lastPrefetched) / 1000)}s ago`,
        );
        // 从缓存解析 fast mode 的 org 状态（不发网络请求）
        resolveFastModeStatusFromCache();
      }

      if (!isNonInteractiveSession) {
        void refreshExampleCommands(); // 预取 example commands（会跑 git log，无 API 调用）
      }

      // 解析 MCP 配置（早期启动，与 setup/trust dialog 工作并行）
      const { servers: existingMcpConfigs } = await mcpConfigPromise;
      logForDebugging(
        `[STARTUP] MCP configs resolved in ${mcpConfigResolvedMs}ms (awaited at +${Date.now() - mcpConfigStart}ms)`,
      );
      // CLI 标志（--mcp-config）应覆盖基于文件的配置，与 settings 优先级一致
      const allMcpConfigs = {
        ...existingMcpConfigs,
        ...dynamicMcpConfig,
      };

      // 把 SDK 配置与普通 MCP 配置分开
      const sdkMcpConfigs: Record<string, McpSdkServerConfig> = {};
      const regularMcpConfigs: Record<string, ScopedMcpServerConfig> = {};

      for (const [name, config] of Object.entries(allMcpConfigs)) {
        const typedConfig = config as ScopedMcpServerConfig | McpSdkServerConfig;
        if (typedConfig.type === 'sdk') {
          sdkMcpConfigs[name] = typedConfig as McpSdkServerConfig;
        } else {
          regularMcpConfigs[name] = typedConfig as ScopedMcpServerConfig;
        }
      }

      profileCheckpoint('action_mcp_configs_loaded');

      // trust dialog 之后预取 MCP 资源（实际执行发生在这里）。
      // 仅交互式模式：print 模式会延迟到 headlessStore 存在后才连接，
      // 并按 server 推送（见下方），这样 SearchExtraTools 的 pending-client
      // 处理才能正常工作，单个慢 server 也不会阻塞整批。
      const localMcpPromise = isNonInteractiveSession
        ? Promise.resolve({ clients: [], tools: [], commands: [] })
        : prefetchAllMcpResources(regularMcpConfigs);
      const claudeaiMcpPromise = isNonInteractiveSession
        ? Promise.resolve({ clients: [], tools: [], commands: [] })
        : claudeaiConfigPromise.then(configs =>
            Object.keys(configs).length > 0
              ? prefetchAllMcpResources(configs)
              : { clients: [], tools: [], commands: [] },
          );
      // 按 name 去重合并：每次 prefetchAllMcpResources 调用都会通过
      // 本地 dedup flag 独立地添加 helper tool（ListMcpResourcesTool、
      // ReadMcpResourceTool），因此合并两次调用可能出现重复。print.ts
      // 已经对最终的 tool pool 做了 uniqBy，但这里再 dedup 可保持 appState 整洁。
      const mcpPromise = Promise.all([localMcpPromise, claudeaiMcpPromise]).then(([local, claudeai]) => ({
        clients: [...local.clients, ...claudeai.clients],
        tools: uniqBy([...local.tools, ...claudeai.tools], 'name'),
        commands: uniqBy([...local.commands, ...claudeai.commands], 'name'),
      }));

      // 尽早启动 hooks，让它与 MCP 连接并行执行。
      // initOnly/init/maintenance 跳过（单独处理）、非交互式跳过
      // （通过 setupTrigger 处理）、resume/continue 跳过
      // （conversationRecovery.ts 会触发 'resume' —— 没有这个守卫，
      // /resume 时 hooks 会触发两次，第二次的 systemMessage 会覆盖第一次。
      // gh-30825）
      const hooksPromise =
        initOnly || init || maintenance || isNonInteractiveSession || options.continue || options.resume
          ? null
          : processSessionStartHooks('startup', {
              agentType: mainThreadAgentDefinition?.agentType,
              model: resolvedInitialModel,
            });

      // MCP 不会阻塞 REPL 渲染或第 1 轮的 TTFT。useManageMCPConnections
      // 会在 server 连接时异步填充 appState.mcp（connectToServer 已 memoize
      // —— 上面的 prefetch 和 hook 最终汇聚到同一批连接）。getToolUseContext
      // 通过 computeTools() 每次读取最新的 store.getState()，因此第 1 轮
      // 看到的是 query 时点已连接的 server。慢 server 在第 2 轮后才出现。
      // 与 interactive-no-prompt 行为一致。Print 模式：按 server 推送
      // 到 headlessStore（见下方）。
      const hookMessages: Awaited<NonNullable<typeof hooksPromise>> = [];
      // 抑制瞬态 unhandledRejection —— prefetch 只是预热 memoized 的
      // connectToServer 缓存，交互式下没人 await 它。
      mcpPromise.catch(() => {});

      const mcpClients: Awaited<typeof mcpPromise>['clients'] = [];
      const mcpTools: Awaited<typeof mcpPromise>['tools'] = [];
      const mcpCommands: Awaited<typeof mcpPromise>['commands'] = [];

      let thinkingEnabled = shouldEnableThinkingByDefault();
      let thinkingConfig: ThinkingConfig = thinkingEnabled !== false ? { type: 'adaptive' } : { type: 'disabled' };

      if (options.thinking === 'adaptive' || options.thinking === 'enabled') {
        thinkingEnabled = true;
        thinkingConfig = { type: 'adaptive' };
      } else if (options.thinking === 'disabled') {
        thinkingEnabled = false;
        thinkingConfig = { type: 'disabled' };
      } else {
        const maxThinkingTokens = process.env.MAX_THINKING_TOKENS
          ? parseInt(process.env.MAX_THINKING_TOKENS, 10)
          : options.maxThinkingTokens;
        if (maxThinkingTokens !== undefined) {
          if (maxThinkingTokens > 0) {
            thinkingEnabled = true;
            thinkingConfig = {
              type: 'enabled',
              budgetTokens: maxThinkingTokens,
            };
          } else if (maxThinkingTokens === 0) {
            thinkingEnabled = false;
            thinkingConfig = { type: 'disabled' };
          }
        }
      }

      logForDiagnosticsNoPII('info', 'started', {
        version: MACRO.VERSION,
        is_native_binary: isInBundledMode(),
      });

      registerCleanup(async () => {
        logForDiagnosticsNoPII('info', 'exited');
      });

      void logTenguInit({
        hasInitialPrompt: Boolean(prompt),
        hasStdin: Boolean(inputPrompt),
        verbose,
        debug,
        debugToStderr,
        print: print ?? false,
        outputFormat: outputFormat ?? 'text',
        inputFormat: inputFormat ?? 'text',
        numAllowedTools: allowedTools.length,
        numDisallowedTools: disallowedTools.length,
        mcpClientCount: Object.keys(allMcpConfigs).length,
        worktreeEnabled,
        skipWebFetchPreflight: getInitialSettings().skipWebFetchPreflight,
        githubActionInputs: process.env.GITHUB_ACTION_INPUTS,
        dangerouslySkipPermissionsPassed: dangerouslySkipPermissions ?? false,
        permissionMode,
        modeIsBypass: permissionMode === 'bypassPermissions',
        allowDangerouslySkipPermissionsPassed: allowDangerouslySkipPermissions,
        systemPromptFlag: systemPrompt ? (options.systemPromptFile ? 'file' : 'flag') : undefined,
        appendSystemPromptFlag: appendSystemPrompt ? (options.appendSystemPromptFile ? 'file' : 'flag') : undefined,
        thinkingConfig,
        assistantActivationPath:
          feature('KAIROS') && kairosEnabled ? assistantModule?.getAssistantActivationPath() : undefined,
      });

      // 初始化时记录一次 context metrics
      void logContextMetrics(regularMcpConfigs, toolPermissionContext);

      void logPermissionContextForAnts(null, 'initialization');

      logManagedSettings();

      // 注册 PID 文件用于并发会话检测（~/.claude/sessions/）
      // 并触发 multi-clauding 遥测。放在这里（而不是 init.ts），这样只有
      // REPL 路径会注册 —— `claude doctor` 这类子命令不会注册。链式：
      // count 必须在 register 写完成后执行，否则会漏掉自己的文件。
      void registerSession().then(registered => {
        if (!registered) return;
        if (sessionNameArg) {
          void updateSessionName(sessionNameArg);
        }
        void countConcurrentSessions().then(count => {
          if (count >= 2) {
            logEvent('tengu_concurrent_sessions', {
              num_sessions: count,
            });
          }
        });
      });

      // 初始化版本化 plugin 系统（必要时触发 V1→V2 迁移）。然后跑 orphan GC，
      // 再预热 Grep/Glob 排除缓存。顺序很关键：预热会扫描磁盘上的
      // .orphaned_at 标记，因此必须先看到 GC 的 Pass 1（从已重装的版本上
      // 移除标记）和 Pass 2（给未标记的 orphan 打标）都已生效。预热还要
      // 早于 autoupdate（REPL 首次 submit 时触发），避免它在我们当前
      // 活跃版本之下把它 orphan 掉。
      // --bare / SIMPLE：跳过 plugin 版本同步 + orphan 清理。这些属于
      // 安装/升级的簿记工作，脚本化调用不需要 —— 下一次交互式会话会自动
      // 对账。这里的 await 之前会让 -p 阻塞在 marketplace 往返上。
      if (isBareMode()) {
        // 跳过 —— 无操作
      } else if (isNonInteractiveSession) {
        // headless 模式下 await，确保 plugin 同步在 CLI 退出前完成
        await initializeVersionedPlugins();
        profileCheckpoint('action_after_plugins_init');
        void cleanupOrphanedPluginVersionsInBackground().then(() => getGlobExclusionsForPluginCache());
      } else {
        // 交互式模式下 fire-and-forget —— 这只是纯粹的簿记工作，
        // 不影响当前会话的运行时行为
        void initializeVersionedPlugins().then(async () => {
          profileCheckpoint('action_after_plugins_init');
          await cleanupOrphanedPluginVersionsInBackground();
          void getGlobExclusionsForPluginCache();
        });
      }

      const setupTrigger = initOnly || init ? 'init' : maintenance ? 'maintenance' : null;
      if (initOnly) {
        applyConfigEnvironmentVariables();
        await processSetupHooks('init', { forceSyncExecution: true });
        await processSessionStartHooks('startup', {
          forceSyncExecution: true,
        });
        gracefulShutdownSync(0);
        return;
      }

      // --print 模式
      if (isNonInteractiveSession) {
        logForDebugging(`[Hapii] Main.action 进入非交互模式 outputFormat=${outputFormat}`, { level: 'info' });
        if (outputFormat === 'stream-json' || outputFormat === 'json') {
          setHasFormattedOutput(true);
        }

        // print 模式下应用完整的环境变量，因为 trust dialog 被跳过
        // 这包括来自不可信来源的潜在危险环境变量，
        // 但 print 模式被视为可信（见帮助文本说明）
        applyConfigEnvironmentVariables();

        // 应用环境变量后初始化遥测，确保 OTEL endpoint 环境变量和
        // otelHeadersHelper（需要 trust 才能执行）都可用。
        initializeTelemetryAfterTrust();

        // 现在就触发 SessionStart hooks，让子进程派生与 MCP 连接、
        // plugin 初始化、下面的 print.ts import 并行。loadInitialMessages
        // 会在 print.ts:4397 处 join 这个 promise。守卫条件与
        // loadInitialMessages 一致 —— continue/resume/teleport 路径不触发
        // startup hook（或在 resume 分支内部有条件触发，此时该 promise 为
        // undefined，会走 ?? fallback）。setupTrigger 被设置时也跳过 ——
        // 这些路径会先跑 setup hooks（print.ts:544），session start hooks
        // 必须等 setup 完成。
        const sessionStartHooksPromise =
          options.continue || options.resume || teleport || setupTrigger
            ? undefined
            : processSessionStartHooks('startup');
        // 抑制瞬态 unhandledRejection：若此 promise 在 loadInitialMessages
        // await 之前就 reject 了会触发。下游的 await 仍能看到 rejection
        // —— 这里只是防止虚假的全局 handler 触发。
        sessionStartHooksPromise?.catch(() => {});

        profileCheckpoint('before_validateForceLoginOrg');
        // 对非交互式会话校验组织限制
        const orgValidation = await validateForceLoginOrg();
        if (!orgValidation.valid) {
          process.stderr.write((orgValidation as { valid: false; message: string }).message + '\n');
          process.exit(1);
        }

        // Headless 模式支持所有 prompt 命令和部分 local 命令
        // 若 disableSlashCommands 为 true，返回空数组
        const commandsHeadless = disableSlashCommands
          ? []
          : commands.filter(
              command =>
                (command.type === 'prompt' && !command.disableNonInteractive) ||
                (command.type === 'local' && command.supportsNonInteractive),
            );

        const defaultState = getDefaultAppState();
        const headlessInitialState: AppState = {
          ...defaultState,
          mcp: {
            ...defaultState.mcp,
            clients: mcpClients,
            commands: mcpCommands,
            tools: mcpTools,
          },
          toolPermissionContext,
          effortValue: parseEffortValue(options.effort) ?? getInitialEffortSetting(),
          ...(isFastModeEnabled() && {
            fastMode: getInitialFastModeSetting(effectiveModel ?? null),
          }),
          ...(isAdvisorEnabled() && advisorModel && { advisorModel }),
          // kairosEnabled 用于 gate executeForkedSlashCommand
          // （processSlashCommand.tsx:132）和 AgentTool 的 shouldRunAsync
          // 中的 async fire-and-forget 路径。REPL initialState 在约 3459 行
          // 设置它；headless 之前默认为 false，导致 daemon 子进程的定时
          // 任务和 Agent 工具调用都是同步执行 —— N 个派生时未完成的 cron
          // 任务 = N 个串行 subagent 轮次阻塞用户输入。
          // 在 :1620 处计算，远早于此分支。
          ...(feature('KAIROS') ? { kairosEnabled } : {}),
        };

        // 初始化 app state
        const headlessStore = createStore(headlessInitialState, onChangeAppState);

        // 异步检查 auto mode 门槛 —— 必要时校正状态并禁用 auto。
        if (feature('TRANSCRIPT_CLASSIFIER')) {
          void verifyAutoModeGateAccess(toolPermissionContext, headlessStore.getState().fastMode).then(
            ({ updateContext }) => {
              headlessStore.setState(prev => {
                const nextCtx = updateContext(prev.toolPermissionContext);
                if (nextCtx === prev.toolPermissionContext) return prev;
                return { ...prev, toolPermissionContext: nextCtx };
              });
            },
          );
        }

        // 设置会话持久化的全局状态
        if (options.sessionPersistence === false) {
          setSessionPersistenceDisabled(true);
        }

        // 把 SDK betas 存入全局状态，用于 context window 计算
        // 只保存允许的 betas（按 allowlist 和订阅状态过滤）
        setSdkBetas(filterAllowedSdkBetas(betas));

        // Print 模式 MCP：按 server 增量推送到 headlessStore。
        // 与 useManageMCPConnections 对齐 —— 先推 pending（让 SearchExtraToolsTool.ts:334
        // 的 pending 检查能看到它们），然后在每个 server 就绪时用
        // connected/failed 替换。
        const connectMcpBatch = (configs: Record<string, ScopedMcpServerConfig>, label: string): Promise<void> => {
          if (Object.keys(configs).length === 0) return Promise.resolve();
          headlessStore.setState(prev => ({
            ...prev,
            mcp: {
              ...prev.mcp,
              clients: [
                ...prev.mcp.clients,
                ...Object.entries(configs).map(([name, config]) => ({
                  name,
                  type: 'pending' as const,
                  config,
                })),
              ],
            },
          }));
          return getMcpToolsCommandsAndResources(({ client, tools, commands }) => {
            headlessStore.setState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                clients: prev.mcp.clients.some(c => c.name === client.name)
                  ? prev.mcp.clients.map(c => (c.name === client.name ? client : c))
                  : [...prev.mcp.clients, client],
                tools: uniqBy([...prev.mcp.tools, ...tools], 'name'),
                commands: uniqBy([...prev.mcp.commands, ...commands], 'name'),
              },
            }));
          }, configs).catch(err => logForDebugging(`[MCP] ${label} connect error: ${err}`));
        };
        // await 所有 MCP 配置 —— print 模式通常只跑一轮，因此
        // "晚连接的 server 在下一轮才能看到" 没意义。SDK init 消息和
        // 第 1 轮的 tool list 都需要已配置的 MCP tool 就位。
        // 零 server 的情况下，connectMcpBatch 会提前 return，零成本。
        // Connector 在 getMcpToolsCommandsAndResources 内部并行化
        // （processBatched 配合 Promise.all）。claude.ai 也会被 await —— 它的
        // fetch 早就启动了（约第 2558 行），此处只剩残余耗时。--bare 为
        // 性能敏感的脚本完全跳过 claude.ai。
        profileCheckpoint('before_connectMcp');
        await connectMcpBatch(regularMcpConfigs, 'regular');
        profileCheckpoint('after_connectMcp');
        // 去重：抑制与 claude.ai connector 重复的 plugin MCP server
        // （connector 胜出），然后再连接 claude.ai server。
        // 有界等待 —— #23725 将其改为阻塞，以便单轮 -p 能看到 connector，
        // 但有 40+ 个慢 connector 时 tengu_startup_perf p99 攀升到 76s。
        // 若 fetch+connect 没在规定时间内完成，直接继续；promise 仍在运行，
        // 会在后台更新 headlessStore，第 2 轮及以后仍能看到 connector。
        const CLAUDE_AI_MCP_TIMEOUT_MS = 5_000;
        const claudeaiConnect = claudeaiConfigPromise.then(claudeaiConfigs => {
          if (Object.keys(claudeaiConfigs).length > 0) {
            const claudeaiSigs = new Set<string>();
            for (const config of Object.values(claudeaiConfigs)) {
              const sig = getMcpServerSignature(config);
              if (sig) claudeaiSigs.add(sig);
            }
            const suppressed = new Set<string>();
            for (const [name, config] of Object.entries(regularMcpConfigs)) {
              if (!name.startsWith('plugin:')) continue;
              const sig = getMcpServerSignature(config);
              if (sig && claudeaiSigs.has(sig)) suppressed.add(name);
            }
            if (suppressed.size > 0) {
              logForDebugging(
                `[MCP] Lazy dedup: suppressing ${suppressed.size} plugin server(s) that duplicate claude.ai connectors: ${[...suppressed].join(', ')}`,
              );
              // 从 state 过滤之前先断开连接。只有已连接的 server
              // 需要清理 —— 对从未连过的 server 调 clearServerCache 会触发
              // 一次真实连接只是为了 kill 掉它（memoize 缓存未命中路径，
              // 见 useManageMCPConnections.ts:870）。
              for (const c of headlessStore.getState().mcp.clients) {
                if (!suppressed.has(c.name) || c.type !== 'connected') continue;
                c.client.onclose = undefined;
                void clearServerCache(c.name, c.config).catch(() => {});
              }
              headlessStore.setState(prev => {
                let { clients, tools, commands, resources } = prev.mcp;
                clients = clients.filter(c => !suppressed.has(c.name));
                tools = tools.filter(t => !t.mcpInfo || !suppressed.has(t.mcpInfo.serverName));
                for (const name of suppressed) {
                  commands = excludeCommandsByServer(commands, name);
                  resources = excludeResourcesByServer(resources, name);
                }
                return {
                  ...prev,
                  mcp: {
                    ...prev.mcp,
                    clients,
                    tools,
                    commands,
                    resources,
                  },
                };
              });
            }
          }
          // 抑制与已启用手动 server 重复的 claude.ai connector
          // （URL 签名匹配）。上面的 plugin 去重只处理 `plugin:*` 键；
          // 这里处理手动 `.mcp.json` 中的条目。
          // plugin:* 必须在这里排除 —— 步骤 1 已经抑制了它们
          // （claude.ai 胜出）；留着它们会把 connector 也抑制掉，
          // 结果两边都活不成（gh-39974）。
          const nonPluginConfigs = pickBy(regularMcpConfigs, (_, n) => !n.startsWith('plugin:'));
          const { servers: dedupedClaudeAi } = dedupClaudeAiMcpServers(claudeaiConfigs, nonPluginConfigs);
          return connectMcpBatch(dedupedClaudeAi, 'claudeai');
        });
        let claudeaiTimer: ReturnType<typeof setTimeout> | undefined;
        const claudeaiTimedOut = await Promise.race([
          claudeaiConnect.then(() => false),
          new Promise<boolean>(resolve => {
            claudeaiTimer = setTimeout(r => r(true), CLAUDE_AI_MCP_TIMEOUT_MS, resolve);
          }),
        ]);
        if (claudeaiTimer) clearTimeout(claudeaiTimer);
        if (claudeaiTimedOut) {
          logForDebugging(
            `[MCP] claude.ai connectors not ready after ${CLAUDE_AI_MCP_TIMEOUT_MS}ms — proceeding; background connection continues`,
          );
        }
        profileCheckpoint('after_connectMcp_claudeai');

        // headless 模式下，立即启动延迟 prefetch（没有用户输入延迟）
        // --bare / SIMPLE：startDeferredPrefetches 内部会提前 return。
        // backgroundHousekeeping（initExtractMemories、pruneShellSnapshots、
        // cleanupOldMessageFiles）和 sdkHeapDumpMonitor 都是簿记工作，
        // 脚本化调用不需要 —— 下一次交互式会话会自动对账。
        if (!isBareMode()) {
          startDeferredPrefetches();
          void import('./utils/backgroundHousekeeping.js').then(m => m.startBackgroundHousekeeping());
          if (process.env.USER_TYPE === 'ant') {
            void import('./utils/sdkHeapDumpMonitor.js').then(m => m.startSdkMemoryMonitor());
          }
        }

        logSessionTelemetry();
        profileCheckpoint('before_print_import');
        const { runHeadless } = await import('src/cli/print.js');
        profileCheckpoint('after_print_import');
        void runHeadless(
          inputPrompt,
          () => headlessStore.getState(),
          headlessStore.setState,
          commandsHeadless,
          tools,
          sdkMcpConfigs,
          agentDefinitions.activeAgents,
          {
            continue: options.continue,
            resume: options.resume,
            verbose: verbose,
            outputFormat: outputFormat,
            jsonSchema,
            permissionPromptToolName: options.permissionPromptTool,
            allowedTools,
            thinkingConfig,
            maxTurns: options.maxTurns,
            maxBudgetUsd: options.maxBudgetUsd,
            taskBudget: options.taskBudget ? { total: options.taskBudget } : undefined,
            systemPrompt,
            appendSystemPrompt,
            userSpecifiedModel: effectiveModel,
            fallbackModel: userSpecifiedFallbackModel,
            teleport,
            sdkUrl,
            replayUserMessages: effectiveReplayUserMessages,
            includePartialMessages: effectiveIncludePartialMessages,
            forkSession: options.forkSession || false,
            resumeSessionAt: options.resumeSessionAt || undefined,
            rewindFiles: options.rewindFiles,
            enableAuthStatus: options.enableAuthStatus,
            agent: agentCli,
            workload: options.workload,
            setupTrigger: setupTrigger ?? undefined,
            sessionStartHooksPromise,
          },
        );
        return;
      }

      // 启动时记录模型配置
      logEvent('tengu_startup_manual_model_config', {
        cli_flag: options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        env_var: process.env.ANTHROPIC_MODEL as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        settings_file: (getInitialSettings() || {}).model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        subscriptionType: getSubscriptionType() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        agent: agentSetting as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });

      // 获取初始模型的废弃警告（resolvedInitialModel 之前已为 hooks 并行化计算好）
      const deprecationWarning = getModelDeprecationWarning(resolvedInitialModel);

      // 构建初始通知队列
      const initialNotifications: Array<{
        key: string;
        text: string;
        color?: 'warning';
        priority: 'high';
      }> = [];
      if (permissionModeNotification) {
        initialNotifications.push({
          key: 'permission-mode-notification',
          text: permissionModeNotification,
          priority: 'high',
        });
      }
      if (deprecationWarning) {
        initialNotifications.push({
          key: 'model-deprecation-warning',
          text: deprecationWarning,
          color: 'warning',
          priority: 'high',
        });
      }
      if (overlyBroadBashPermissions.length > 0) {
        const displayList = uniq(overlyBroadBashPermissions.map(p => p.ruleDisplay));
        const displays = displayList.join(', ');
        const sources = uniq(overlyBroadBashPermissions.map(p => p.sourceDisplay)).join(', ');
        const n = displayList.length;
        initialNotifications.push({
          key: 'overly-broad-bash-notification',
          text: `${displays} allow ${plural(n, 'rule')} from ${sources} ${plural(n, 'was', 'were')} ignored \u2014 not available for Ants, please use auto-mode instead`,
          color: 'warning',
          priority: 'high',
        });
      }

      const teammateUtils = getTeammateUtils();
      const effectiveToolPermissionContext = {
        ...toolPermissionContext,
        mode:
          isAgentSwarmsEnabled() && teammateUtils?.isPlanModeRequired?.()
            ? ('plan' as const)
            : toolPermissionContext.mode,
      };
      // 所有启动时的 opt-in 路径（--tools、--brief、defaultView）都已在上面触发；
      // initialIsBriefOnly 只是读取结果状态。
      const initialIsBriefOnly = feature('KAIROS') || feature('KAIROS_BRIEF') ? getUserMsgOptIn() : false;
      const fullRemoteControl = remoteControl || getRemoteControlAtStartup() || kairosEnabled;
      let ccrMirrorEnabled = false;
      if (feature('CCR_MIRROR') && !fullRemoteControl) {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { isCcrMirrorEnabled } =
          require('./bridge/bridgeEnabled.js') as typeof import('./bridge/bridgeEnabled.js');
        /* eslint-enable @typescript-eslint/no-require-imports */
        ccrMirrorEnabled = isCcrMirrorEnabled();
      }

      const initialState: AppState = {
        settings: getInitialSettings(),
        tasks: {},
        agentNameRegistry: new Map(),
        verbose: verbose ?? getGlobalConfig().verbose ?? false,
        mainLoopModel: initialMainLoopModel,
        mainLoopModelForSession: null,
        isBriefOnly: initialIsBriefOnly,
        expandedView: getGlobalConfig().showSpinnerTree
          ? 'teammates'
          : getGlobalConfig().showExpandedTodos
            ? 'tasks'
            : 'none',
        showTeammateMessagePreview: isAgentSwarmsEnabled() ? false : undefined,
        selectedIPAgentIndex: -1,
        selectedBgAgentIndex: -1,
        coordinatorTaskIndex: -1,
        viewSelectionMode: 'none',
        footerSelection: null,
        toolPermissionContext: effectiveToolPermissionContext,
        agent: mainThreadAgentDefinition?.agentType,
        agentDefinitions,
        mcp: {
          clients: [],
          tools: [],
          commands: [],
          resources: {},
          pluginReconnectKey: 0,
        },
        plugins: {
          enabled: [],
          disabled: [],
          commands: [],
          errors: [],
          installationStatus: {
            marketplaces: [],
            plugins: [],
          },
          needsRefresh: false,
        },
        statusLineText: undefined,
        kairosEnabled,
        remoteSessionUrl: undefined,
        remoteConnectionStatus: 'connecting',
        remoteBackgroundTaskCount: 0,
        replBridgeEnabled: fullRemoteControl || ccrMirrorEnabled,
        replBridgeExplicit: remoteControl,
        replBridgeOutboundOnly: ccrMirrorEnabled,
        replBridgeConnected: false,
        replBridgeSessionActive: false,
        replBridgeReconnecting: false,
        replBridgeConnectUrl: undefined,
        replBridgeSessionUrl: undefined,
        replBridgeEnvironmentId: undefined,
        replBridgeSessionId: undefined,
        replBridgeError: undefined,
        replBridgeInitialName: remoteControlName,
        showRemoteCallout: false,
        notifications: {
          current: null,
          queue: initialNotifications,
        },
        elicitation: {
          queue: [],
        },
        todos: {},
        remoteAgentTaskSuggestions: [],
        fileHistory: {
          snapshots: [],
          trackedFiles: new Set(),
          snapshotSequence: 0,
        },
        attribution: createEmptyAttributionState(),
        thinkingEnabled,
        promptSuggestionEnabled: shouldEnablePromptSuggestion(),
        sessionHooks: new Map(),
        inbox: {
          messages: [],
        },
        promptSuggestion: {
          text: null,
          promptId: null,
          shownAt: 0,
          acceptedAt: 0,
          generationRequestId: null,
        },
        speculation: IDLE_SPECULATION_STATE,
        speculationSessionTimeSavedMs: 0,
        skillImprovement: {
          suggestion: null,
        },
        workerSandboxPermissions: {
          queue: [],
          selectedIndex: 0,
        },
        pendingWorkerRequest: null,
        pendingSandboxRequest: null,
        authVersion: 0,
        initialMessage: inputPrompt
          ? {
              message: createUserMessage({
                content: String(inputPrompt),
              }),
            }
          : null,
        effortValue: parseEffortValue(options.effort) ?? getInitialEffortSetting(),
        activeOverlays: new Set<string>(),
        fastMode: getInitialFastModeSetting(resolvedInitialModel),
        ...(isAdvisorEnabled() && advisorModel && { advisorModel }),
        // 同步计算 teamContext，避免渲染过程中 useEffect 触发 setState。
        // KAIROS：assistantTeamContext 优先 —— 在上面的 KAIROS 代码块中已设置，
        // 这样 Agent(name: "foo") 可以不依赖 TeamCreate 直接派生进程内 teammate。
        // computeInitialTeamContext() 用于 tmux 派生的 teammate 读取自身身份，
        // 不是 assistant 模式的 leader。
        teamContext: (feature('KAIROS')
          ? (assistantTeamContext ?? computeInitialTeamContext())
          : computeInitialTeamContext()) as AppState['teamContext'],
      };

      // 将 CLI 初始 prompt 加入历史
      if (inputPrompt) {
        addToHistory(String(inputPrompt));
      }

      const initialTools = mcpTools;

      // 同步自增 numStartups —— 首次渲染的读取方（如 shouldShowEffortCallout
      // 通过 useState 初始化器）需要在 setImmediate 触发前拿到更新值。
      // 只把遥测推迟。
      saveGlobalConfig(current => ({
        ...current,
        numStartups: (current.numStartups ?? 0) + 1,
      }));
      setImmediate(() => {
        void logStartupTelemetry();
        logSessionTelemetry();
      });

      // 设置按轮次的 session 环境数据上传器（仅 ant 内部构建）。
      // 对所有在 Anthropic 自有仓库工作的 ant 用户默认启用。每轮捕获
      // git/文件系统状态（不包含 transcript），这样可以在任意用户消息
      // 索引处重建环境。Gate 条件：
      //   - 构建时：外部构建中此 import 被 stub。
      //   - 运行时：uploader 会检查 github.com/anthropics/* 远程 + gcloud auth。
      //   - 安全：CLAUDE_CODE_DISABLE_SESSION_DATA_UPLOAD=1 可绕过（测试用它）。
      // import 是动态 + 异步的，避免增加启动延迟。
      const sessionUploaderPromise = process.env.USER_TYPE === 'ant' ? import('./utils/sessionDataUploader.js') : null;

      // 把 session uploader 的解析推迟到 onTurnComplete 回调，避免在
      // main.tsx 这个性能关键路径上再加一个顶层 await。
      // sessionDataUploader.ts 中的按轮次 auth 逻辑能优雅处理未认证状态
      // （每轮重新检查，会话中途 auth 恢复也能用）。
      const uploaderReady = sessionUploaderPromise
        ? sessionUploaderPromise.then(mod => mod.createSessionTurnUploader()).catch(() => null)
        : null;

      const sessionConfig = {
        debug: debug || debugToStderr,
        commands: [...commands, ...mcpCommands],
        initialTools,
        mcpClients,
        autoConnectIdeFlag: ide,
        mainThreadAgentDefinition,
        disableSlashCommands,
        dynamicMcpConfig,
        strictMcpConfig,
        systemPrompt,
        appendSystemPrompt,
        taskListId,
        thinkingConfig,
        ...(uploaderReady && {
          onTurnComplete: (messages: MessageType[]) => {
            void uploaderReady.then(uploader => (uploader as ((msgs: MessageType[]) => void) | null)?.(messages));
          },
        }),
      };

      // processResumedConversation 调用共享的 context
      const resumeContext = {
        modeApi: coordinatorModeModule,
        mainThreadAgentDefinition,
        agentDefinitions,
        currentCwd,
        cliAgents,
        initialState,
      };

      if (options.continue) {
        // 直接继续最近一次会话
        let resumeSucceeded = false;
        try {
          const resumeStart = performance.now();

          // resume 之前清理过期缓存，确保文件/skill 发现是新鲜的
          const { clearSessionCaches } = await import('./commands/clear/caches.js');
          clearSessionCaches();

          const result = await loadConversationForResume(undefined /* sessionId */, undefined /* sourceFile */);
          if (!result) {
            logEvent('tengu_continue', {
              success: false,
            });
            return await exitWithError(root, 'No conversation found to continue');
          }

          const loaded = await processResumedConversation(
            result,
            {
              forkSession: !!options.forkSession,
              includeAttribution: true,
              transcriptPath: result.fullPath,
            },
            resumeContext,
          );

          if (loaded.restoredAgentDef) {
            mainThreadAgentDefinition = loaded.restoredAgentDef;
          }

          maybeActivateProactive(options);
          maybeActivateBrief(options);

          logEvent('tengu_continue', {
            success: true,
            resume_duration_ms: Math.round(performance.now() - resumeStart),
          });
          resumeSucceeded = true;

          await launchRepl(
            root,
            {
              getFpsMetrics,
              stats,
              initialState: loaded.initialState,
            },
            {
              ...sessionConfig,
              mainThreadAgentDefinition: loaded.restoredAgentDef ?? mainThreadAgentDefinition,
              initialMessages: loaded.messages,
              initialFileHistorySnapshots: loaded.fileHistorySnapshots,
              initialContentReplacements: loaded.contentReplacements,
              initialAgentName: loaded.agentName,
              initialAgentColor: loaded.agentColor,
            },
            renderAndRun,
          );
        } catch (error) {
          if (!resumeSucceeded) {
            logEvent('tengu_continue', {
              success: false,
            });
          }
          logError(error);
          process.exit(1);
        }
      } else if (feature('DIRECT_CONNECT') && _pendingConnect?.url) {
        logForDebugging(`[Hapii] Main.action 进入 direct-connect 模式 url=${_pendingConnect.url}`, { level: 'info' });
        // `claude connect <url>` —— 连接到远程 server 的完整交互式 TUI
        let directConnectConfig;
        try {
          const session = await createDirectConnectSession({
            serverUrl: _pendingConnect.url,
            authToken: _pendingConnect.authToken,
            cwd: getOriginalCwd(),
            dangerouslySkipPermissions: _pendingConnect.dangerouslySkipPermissions,
          });
          if (session.workDir) {
            setOriginalCwd(session.workDir);
            setCwdState(session.workDir);
          }
          setDirectConnectServerUrl(_pendingConnect.url);
          directConnectConfig = session.config;
        } catch (err) {
          return await exitWithError(root, err instanceof DirectConnectError ? err.message : String(err), () =>
            gracefulShutdown(1),
          );
        }

        const connectInfoMessage = createSystemMessage(
          `Connected to server at ${_pendingConnect.url}\nSession: ${directConnectConfig.sessionId}`,
          'info',
        );

        await launchRepl(
          root,
          { getFpsMetrics, stats, initialState },
          {
            debug: debug || debugToStderr,
            commands,
            initialTools: [],
            initialMessages: [connectInfoMessage],
            mcpClients: [],
            autoConnectIdeFlag: ide,
            mainThreadAgentDefinition,
            disableSlashCommands,
            directConnectConfig,
            thinkingConfig,
          },
          renderAndRun,
        );
        return;
      } else if (feature('SSH_REMOTE') && _pendingSSH?.host) {
        logForDebugging(`[Hapii] Main.action 进入 SSH 模式 host=${_pendingSSH.host} local=${!!_pendingSSH.local}`, {
          level: 'info',
        });
        // `claude ssh <host> [dir]` —— 探测远端、必要时部署二进制、
        // 启动 ssh 并通过 unix-socket -R 转发到本地 auth proxy，
        // 把 SSHSession 交给 REPL。工具在远端运行，UI 在本地渲染。
        // `--local` 跳过探测/部署/ssh，直接用相同环境派生当前二进制
        // —— 用于 e2e 测试 proxy/auth 相关管线。
        const { createSSHSession, createLocalSSHSession, SSHSessionError } = await import('./ssh/createSSHSession.js');
        let sshSession: import('./ssh/createSSHSession.js').SSHSession | undefined;
        try {
          if (_pendingSSH.local) {
            process.stderr.write('Starting local ssh-proxy test session...\n');
            sshSession = await createLocalSSHSession({
              cwd: _pendingSSH.cwd,
              permissionMode: _pendingSSH.permissionMode,
              dangerouslySkipPermissions: _pendingSSH.dangerouslySkipPermissions,
            });
          } else {
            process.stderr.write(`Connecting to ${_pendingSSH.host}…\n`);
            // 原地进度输出：\r + EL0（擦到行尾）。成功时最后的 \n 让下一条
            // 消息落在新行。stderr 不是 TTY（被 pipe/重定向）时是 no-op
            // —— \r 只会产生垃圾字符。
            const isTTY = process.stderr.isTTY;
            let hadProgress = false;
            sshSession = await createSSHSession(
              {
                host: _pendingSSH.host,
                cwd: _pendingSSH.cwd,
                localVersion: MACRO.VERSION,
                permissionMode: _pendingSSH.permissionMode,
                dangerouslySkipPermissions: _pendingSSH.dangerouslySkipPermissions,
                extraCliArgs: _pendingSSH.extraCliArgs,
                remoteBin: _pendingSSH.remoteBin,
              },
              isTTY
                ? {
                    onProgress: (msg: string) => {
                      hadProgress = true;
                      process.stderr.write(`\r  ${msg}\x1b[K`);
                    },
                  }
                : {},
            );
            if (hadProgress) process.stderr.write('\n');
          }
          setOriginalCwd(sshSession.remoteCwd);
          setCwdState(sshSession.remoteCwd);
          setDirectConnectServerUrl(_pendingSSH.local ? 'local' : _pendingSSH.host);
        } catch (err) {
          return await exitWithError(root, err instanceof SSHSessionError ? err.message : String(err), () =>
            gracefulShutdown(1),
          );
        }

        const sshInfoMessage = createSystemMessage(
          _pendingSSH.local
            ? `Local ssh-proxy test session\ncwd: ${sshSession.remoteCwd}\nAuth: unix socket → local proxy`
            : `SSH session to ${_pendingSSH.host}\nRemote cwd: ${sshSession.remoteCwd}\nAuth: unix socket -R → local proxy`,
          'info',
        );

        await launchRepl(
          root,
          { getFpsMetrics, stats, initialState },
          {
            debug: debug || debugToStderr,
            commands,
            initialTools: [],
            initialMessages: [sshInfoMessage],
            mcpClients: [],
            autoConnectIdeFlag: ide,
            mainThreadAgentDefinition,
            disableSlashCommands,
            sshSession,
            thinkingConfig,
          },
          renderAndRun,
        );
        return;
      } else if (
        feature('KAIROS') &&
        _pendingAssistantChat &&
        (_pendingAssistantChat.sessionId || _pendingAssistantChat.discover)
      ) {
        // `claude assistant [sessionId]` —— REPL 作为远程 assistant 会话的
        // 纯查看客户端。agentic loop 在远端运行；本进程流式接收 live event
        // 并 POST 消息。历史记录由 useAssistantHistory 在向上滚动时懒加载
        // （此处不做阻塞式拉取）。
        const { discoverAssistantSessions } = await import('./assistant/sessionDiscovery.js');

        let targetSessionId = _pendingAssistantChat.sessionId;

        // 发现流程 —— 列出 bridge 环境，过滤会话
        if (!targetSessionId) {
          let sessions;
          try {
            sessions = await discoverAssistantSessions();
          } catch (e) {
            return await exitWithError(root, `Failed to discover sessions: ${e instanceof Error ? e.message : e}`, () =>
              gracefulShutdown(1),
            );
          }
          if (sessions.length === 0) {
            let installedDir: string | null;
            try {
              installedDir = await launchAssistantInstallWizard(root);
            } catch (e) {
              return await exitWithError(
                root,
                `Assistant installation failed: ${e instanceof Error ? e.message : e}`,
                () => gracefulShutdown(1),
              );
            }
            if (installedDir === null) {
              await gracefulShutdown(0);
              process.exit(0);
            }
            // daemon 需要几秒钟启动它的 worker 并建立 bridge session，
            // 之后发现流程才能找到它。
            return await exitWithMessage(
              root,
              `Assistant installed in ${installedDir}. The daemon is starting up — run \`claude assistant\` again in a few seconds to connect.`,
              {
                exitCode: 0,
                beforeExit: () => gracefulShutdown(0),
              },
            );
          }
          if (sessions.length === 1) {
            targetSessionId = sessions[0]!.id;
          } else {
            const picked = await launchAssistantSessionChooser(root, {
              sessions,
            });
            if (!picked) {
              await gracefulShutdown(0);
              process.exit(0);
            }
            targetSessionId = picked;
          }
        }

        // 认证 —— 调用一次 prepareApiRequest() 拿到 orgUUID，但 token
        // 通过 getAccessToken 闭包获取，这样重连时能拿到新鲜 token。
        const { checkAndRefreshOAuthTokenIfNeeded, getClaudeAIOAuthTokens } = await import('./utils/auth.js');
        await checkAndRefreshOAuthTokenIfNeeded();
        let apiCreds;
        try {
          apiCreds = await prepareApiRequest();
        } catch (e) {
          return await exitWithError(root, `Error: ${e instanceof Error ? e.message : 'Failed to authenticate'}`, () =>
            gracefulShutdown(1),
          );
        }
        const getAccessToken = (): string => getClaudeAIOAuthTokens()?.accessToken ?? apiCreds.accessToken;

        // Brief 模式激活：setKairosActive(true) 同时满足 isBriefEnabled()
        // 的 opt-in 和 entitlement 条件（BriefTool.ts:124-132）。
        setKairosActive(true);
        setUserMsgOptIn(true);
        setIsRemoteMode(true);

        const remoteSessionConfig = createRemoteSessionConfig(
          targetSessionId,
          getAccessToken,
          apiCreds.orgUUID,
          /* hasInitialPrompt */ false,
          /* viewerOnly */ true,
        );

        const infoMessage = createSystemMessage(
          `Attached to assistant session ${targetSessionId.slice(0, 8)}…`,
          'info',
        );

        const assistantInitialState: AppState = {
          ...initialState,
          isBriefOnly: true,
          kairosEnabled: false,
          replBridgeEnabled: false,
        };

        const remoteCommands = filterCommandsForRemoteMode(commands);
        await launchRepl(
          root,
          {
            getFpsMetrics,
            stats,
            initialState: assistantInitialState,
          },
          {
            debug: debug || debugToStderr,
            commands: remoteCommands,
            initialTools: [],
            initialMessages: [infoMessage],
            mcpClients: [],
            autoConnectIdeFlag: ide,
            mainThreadAgentDefinition,
            disableSlashCommands,
            remoteSessionConfig,
            thinkingConfig,
          },
          renderAndRun,
        );
        return;
      } else if (options.resume || options.fromPr || teleport || remote !== null) {
        logForDebugging(
          `[Hapii] Main.action 进入 resume 模式 resume=${options.resume} fromPr=${options.fromPr} teleport=${!!teleport} remote=${remote}`,
          { level: 'info' },
        );
        // 处理 resume 流程 —— 来自文件（仅 ant）、session ID 或交互式选择器

        // resume 之前清理过期缓存，确保文件/skill 发现是新鲜的
        const { clearSessionCaches } = await import('./commands/clear/caches.js');
        clearSessionCaches();

        let messages: MessageType[] | null = null;
        let processedResume: ProcessedResume | undefined;

        let maybeSessionId = validateUuid(options.resume);
        let searchTerm: string | undefined;
        // 按自定义标题命中时保存完整的 LogOption（用于跨 worktree 的 resume）
        let matchedLog: LogOption | null = null;
        // --from-pr 标志的 PR 过滤条件
        let filterByPr: boolean | number | string | undefined;

        // 处理 --from-pr 标志
        if (options.fromPr) {
          if (options.fromPr === true) {
            // 展示所有带关联 PR 的会话
            filterByPr = true;
          } else if (typeof options.fromPr === 'string') {
            // 可能是 PR 编号或 URL
            filterByPr = options.fromPr;
          }
        }

        // 若 resume 值不是 UUID，先尝试按自定义标题精确匹配
        if (options.resume && typeof options.resume === 'string' && !maybeSessionId) {
          const trimmedValue = options.resume.trim();
          if (trimmedValue) {
            const matches = await searchSessionsByCustomTitle(trimmedValue, {
              exact: true,
            });

            if (matches.length === 1) {
              // 精确命中 —— 保存完整 LogOption 用于跨 worktree resume
              matchedLog = matches[0]!;
              maybeSessionId = getSessionIdFromLog(matchedLog) ?? null;
            } else {
              // 未命中或多个命中 —— 作为 picker 的搜索词
              searchTerm = trimmedValue;
            }
          }
        }

        // --remote 和 --teleport 都会创建/恢复 Claude Code Web (CCR) 会话。
        // Remote Control (--rc) 是独立特性，在 initReplBridge.ts 中 gate。
        if (remote !== null || teleport) {
          await waitForPolicyLimitsToLoad();
          if (!isPolicyAllowed('allow_remote_sessions')) {
            return await exitWithError(root, "Error: Remote sessions are disabled by your organization's policy.", () =>
              gracefulShutdown(1),
            );
          }
        }

        if (remote !== null) {
          // 创建远程会话（可选带初始 prompt）
          const hasInitialPrompt = remote.length > 0;

          // 检查是否启用 TUI 模式 —— 描述只在 TUI 模式下才是可选的
          const isRemoteTuiEnabled = getFeatureValue_CACHED_MAY_BE_STALE('tengu_remote_backend', false);
          if (!isRemoteTuiEnabled && !hasInitialPrompt) {
            return await exitWithError(
              root,
              'Error: --remote requires a description.\nUsage: claude --remote "your task description"',
              () => gracefulShutdown(1),
            );
          }

          logEvent('tengu_remote_create_session', {
            has_initial_prompt: String(hasInitialPrompt) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          });

          // 传入当前分支，以便 CCR 在正确的 revision 上克隆仓库
          const currentBranch = await getBranch();
          const createdSession = await teleportToRemoteWithErrorHandling(
            root,
            hasInitialPrompt ? remote : null,
            new AbortController().signal,
            currentBranch || undefined,
          );
          if (!createdSession) {
            logEvent('tengu_remote_create_session_error', {
              error: 'unable_to_create_session' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            });
            return await exitWithError(root, 'Error: Unable to create remote session', () => gracefulShutdown(1));
          }
          logEvent('tengu_remote_create_session_success', {
            session_id: createdSession.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          });

          // 检查是否通过 feature gate 启用了新的 remote TUI 模式
          if (!isRemoteTuiEnabled) {
            // 原始行为：打印会话信息并退出
            process.stdout.write(`Created remote session: ${createdSession.title}\n`);
            process.stdout.write(`View: ${getRemoteSessionUrl(createdSession.id)}?m=0\n`);
            process.stdout.write(`Resume with: claude --teleport ${createdSession.id}\n`);
            await gracefulShutdown(0);
            process.exit(0);
          }

          // 新行为：用 CCR engine 启动本地 TUI
          // 标记当前处于 remote 模式，用于命令可见性
          setIsRemoteMode(true);
          switchSession(asSessionId(createdSession.id));

          // 获取远程会话的 OAuth 凭证
          let apiCreds: { accessToken: string; orgUUID: string };
          try {
            apiCreds = await prepareApiRequest();
          } catch (error) {
            logError(toError(error));
            return await exitWithError(root, `Error: ${errorMessage(error) || 'Failed to authenticate'}`, () =>
              gracefulShutdown(1),
            );
          }

          // 为 REPL 创建 remote session config
          const { getClaudeAIOAuthTokens: getTokensForRemote } = await import('./utils/auth.js');
          const getAccessTokenForRemote = (): string => getTokensForRemote()?.accessToken ?? apiCreds.accessToken;
          const remoteSessionConfig = createRemoteSessionConfig(
            createdSession.id,
            getAccessTokenForRemote,
            apiCreds.orgUUID,
            hasInitialPrompt,
          );

          // 添加 remote session 信息作为初始系统消息
          const remoteSessionUrl = `${getRemoteSessionUrl(createdSession.id)}?m=0`;
          const remoteInfoMessage = createSystemMessage(
            `/remote-control is active. Code in CLI or at ${remoteSessionUrl}`,
            'info',
          );

          // 若提供了 prompt 则创建初始 user message（CCR 会回显它，但我们忽略）
          const initialUserMessage = hasInitialPrompt ? createUserMessage({ content: remote }) : null;

          // 把 remote session URL 设置到 app state，用于底栏指示器
          const remoteInitialState = {
            ...initialState,
            remoteSessionUrl,
          };

          // 预先过滤命令，只保留 remote-safe 的命令。
          // CCR 的 init 响应可能进一步精简列表（在 REPL 的 handleRemoteInit 中）。
          const remoteCommands = filterCommandsForRemoteMode(commands);
          await launchRepl(
            root,
            {
              getFpsMetrics,
              stats,
              initialState: remoteInitialState,
            },
            {
              debug: debug || debugToStderr,
              commands: remoteCommands,
              initialTools: [],
              initialMessages: initialUserMessage ? [remoteInfoMessage, initialUserMessage] : [remoteInfoMessage],
              mcpClients: [],
              autoConnectIdeFlag: ide,
              mainThreadAgentDefinition,
              disableSlashCommands,
              remoteSessionConfig,
              thinkingConfig,
            },
            renderAndRun,
          );
          return;
        } else if (teleport) {
          if (teleport === true || teleport === '') {
            // 交互模式：展示任务选择器并处理 resume
            logEvent('tengu_teleport_interactive_mode', {});
            logForDebugging('selectAndResumeTeleportTask: Starting teleport flow...');
            const teleportResult = await launchTeleportResumeWrapper(root);
            if (!teleportResult) {
              // 用户取消或发生错误
              await gracefulShutdown(0);
              process.exit(0);
            }
            const { branchError } = await checkOutTeleportedSessionBranch(teleportResult.branch);
            messages = processMessagesForTeleportResume(teleportResult.log, branchError);
          } else if (typeof teleport === 'string') {
            logEvent('tengu_teleport_resume_session', {
              mode: 'direct' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            });
            try {
              // 先拉取会话、校验仓库，再去检查 git 状态
              const sessionData = await fetchSession(teleport);
              const repoValidation = await validateSessionRepository(sessionData);

              // 处理仓库不匹配或不在仓库内的情况
              if (repoValidation.status === 'mismatch' || repoValidation.status === 'not_in_repo') {
                const sessionRepo = repoValidation.sessionRepo;
                if (sessionRepo) {
                  // 检查是否有已知路径
                  const knownPaths = getKnownPathsForRepo(sessionRepo);
                  const existingPaths = await filterExistingPaths(knownPaths);

                  if (existingPaths.length > 0) {
                    // 展示目录切换对话框
                    const selectedPath = await launchTeleportRepoMismatchDialog(root, {
                      targetRepo: sessionRepo,
                      initialPaths: existingPaths,
                    });

                    if (selectedPath) {
                      // 切到所选目录
                      process.chdir(selectedPath);
                      setCwd(selectedPath);
                      setOriginalCwd(selectedPath);
                    } else {
                      // 用户取消
                      await gracefulShutdown(0);
                    }
                  } else {
                    // 没有已知路径 —— 展示原始错误
                    throw new TeleportOperationError(
                      `You must run claude --teleport ${teleport} from a checkout of ${sessionRepo}.`,
                      chalk.red(
                        `You must run claude --teleport ${teleport} from a checkout of ${chalk.bold(sessionRepo)}.\n`,
                      ),
                    );
                  }
                }
              } else if (repoValidation.status === 'error') {
                throw new TeleportOperationError(
                  repoValidation.errorMessage || 'Failed to validate session',
                  chalk.red(`Error: ${repoValidation.errorMessage || 'Failed to validate session'}\n`),
                );
              }

              await validateGitState();

              // teleport 使用进度 UI
              const { teleportWithProgress } = await import('./components/TeleportProgress.js');
              const result = await teleportWithProgress(root, teleport);
              // 记录 teleported session 以便可靠性日志使用
              setTeleportedSessionInfo({ sessionId: teleport });
              messages = result.messages;
            } catch (error) {
              if (error instanceof TeleportOperationError) {
                process.stderr.write(error.formattedMessage + '\n');
              } else {
                logError(error);
                process.stderr.write(chalk.red(`Error: ${errorMessage(error)}\n`));
              }
              await gracefulShutdown(1);
            }
          }
        }
        if (process.env.USER_TYPE === 'ant') {
          if (options.resume && typeof options.resume === 'string' && !maybeSessionId) {
            // 检查是否为 ccshare URL（例如 https://go/ccshare/boris-20260311-211036）
            const { parseCcshareId, loadCcshare } = await import('./utils/ccshareResume.js');
            const ccshareId = parseCcshareId(options.resume);
            if (ccshareId) {
              try {
                const resumeStart = performance.now();
                const logOption = await loadCcshare(ccshareId);
                const result = await loadConversationForResume(logOption, undefined);
                if (result) {
                  processedResume = await processResumedConversation(
                    result,
                    {
                      forkSession: true,
                      transcriptPath: result.fullPath,
                    },
                    resumeContext,
                  );
                  if (processedResume.restoredAgentDef) {
                    mainThreadAgentDefinition = processedResume.restoredAgentDef;
                  }
                  logEvent('tengu_session_resumed', {
                    entrypoint: 'ccshare' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    success: true,
                    resume_duration_ms: Math.round(performance.now() - resumeStart),
                  });
                } else {
                  logEvent('tengu_session_resumed', {
                    entrypoint: 'ccshare' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    success: false,
                  });
                }
              } catch (error) {
                logEvent('tengu_session_resumed', {
                  entrypoint: 'ccshare' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  success: false,
                });
                logError(error);
                await exitWithError(root, `Unable to resume from ccshare: ${errorMessage(error)}`, () =>
                  gracefulShutdown(1),
                );
              }
            } else {
              const resolvedPath = resolve(options.resume);
              try {
                const resumeStart = performance.now();
                let logOption;
                try {
                  // 尝试作为 transcript 文件加载；ENOENT 会落到 session-ID 处理分支
                  logOption = await loadTranscriptFromFile(resolvedPath);
                } catch (error) {
                  if (!isENOENT(error)) throw error;
                  // ENOENT：不是文件路径 —— 落到 session-ID 处理分支
                }
                if (logOption) {
                  const result = await loadConversationForResume(logOption, undefined /* sourceFile */);
                  if (result) {
                    processedResume = await processResumedConversation(
                      result,
                      {
                        forkSession: !!options.forkSession,
                        transcriptPath: result.fullPath,
                      },
                      resumeContext,
                    );
                    if (processedResume.restoredAgentDef) {
                      mainThreadAgentDefinition = processedResume.restoredAgentDef;
                    }
                    logEvent('tengu_session_resumed', {
                      entrypoint: 'file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      success: true,
                      resume_duration_ms: Math.round(performance.now() - resumeStart),
                    });
                  } else {
                    logEvent('tengu_session_resumed', {
                      entrypoint: 'file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      success: false,
                    });
                  }
                }
              } catch (error) {
                logEvent('tengu_session_resumed', {
                  entrypoint: 'file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  success: false,
                });
                logError(error);
                await exitWithError(root, `Unable to load transcript from file: ${options.resume}`, () =>
                  gracefulShutdown(1),
                );
              }
            }
          }
        }

        // 若未作为文件加载，尝试作为 session ID 加载
        if (maybeSessionId) {
          // 按 ID 恢复特定会话
          const sessionId = maybeSessionId;
          try {
            const resumeStart = performance.now();
            // 有 matchedLog 就用它（用于按自定义标题跨 worktree resume）
            // 否则回退到 sessionId 字符串（用于直接 UUID resume）
            const result = await loadConversationForResume(matchedLog ?? sessionId, undefined);

            if (!result) {
              logEvent('tengu_session_resumed', {
                entrypoint: 'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                success: false,
              });
              return await exitWithError(root, `No conversation found with session ID: ${sessionId}`);
            }

            const fullPath = matchedLog?.fullPath ?? result.fullPath;
            processedResume = await processResumedConversation(
              result,
              {
                forkSession: !!options.forkSession,
                sessionIdOverride: sessionId,
                transcriptPath: fullPath,
              },
              resumeContext,
            );

            if (processedResume.restoredAgentDef) {
              mainThreadAgentDefinition = processedResume.restoredAgentDef;
            }
            logEvent('tengu_session_resumed', {
              entrypoint: 'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              success: true,
              resume_duration_ms: Math.round(performance.now() - resumeStart),
            });
          } catch (error) {
            logEvent('tengu_session_resumed', {
              entrypoint: 'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              success: false,
            });
            logError(error);
            await exitWithError(root, `Failed to resume session ${sessionId}`);
          }
        }

        // 渲染 REPL 前 await 文件下载（文件必须可用）
        if (fileDownloadPromise) {
          try {
            const results = await fileDownloadPromise;
            const failedCount = count(results, r => !r.success);
            if (failedCount > 0) {
              process.stderr.write(
                chalk.yellow(`Warning: ${failedCount}/${results.length} file(s) failed to download.\n`),
              );
            }
          } catch (error) {
            return await exitWithError(root, `Error downloading files: ${errorMessage(error)}`);
          }
        }

        // 若已有处理过的 resume 或 teleport 消息，渲染 REPL
        logForDebugging('[Hapii] Main.action 即将挂载 REPL', { level: 'info' });
        const resumeData =
          processedResume ??
          (Array.isArray(messages)
            ? {
                messages,
                fileHistorySnapshots: undefined,
                agentName: undefined,
                agentColor: undefined as AgentColorName | undefined,
                restoredAgentDef: mainThreadAgentDefinition,
                initialState,
                contentReplacements: undefined,
              }
            : undefined);
        if (resumeData) {
          maybeActivateProactive(options);
          maybeActivateBrief(options);

          await launchRepl(
            root,
            {
              getFpsMetrics,
              stats,
              initialState: resumeData.initialState,
            },
            {
              ...sessionConfig,
              mainThreadAgentDefinition: resumeData.restoredAgentDef ?? mainThreadAgentDefinition,
              initialMessages: resumeData.messages,
              initialFileHistorySnapshots: resumeData.fileHistorySnapshots,
              initialContentReplacements: resumeData.contentReplacements,
              initialAgentName: resumeData.agentName,
              initialAgentColor: resumeData.agentColor,
            },
            renderAndRun,
          );
        } else {
          // 展示交互式选择器（含同仓库的 worktree）
          // 注意：ResumeConversation 内部加载日志，以确保选择后正确的 GC
          await launchResumeChooser(root, { getFpsMetrics, stats, initialState }, getWorktreePaths(getOriginalCwd()), {
            ...sessionConfig,
            initialSearchQuery: searchTerm,
            forkSession: options.forkSession,
            filterByPr,
          });
        }
      } else {
        logForDebugging('[Hapii] Main.action 进入全新会话模式（非 resume/connect/SSH）', { level: 'info' });
        // 把未解析的 hooks promise 传给 REPL，让它能立即渲染，
        // 而不是阻塞 ~500ms 等 SessionStart hooks 跑完。
        // REPL 会在 hooks resolve 后注入 hook 消息，并在首次 API 调用前
        // await 它们，确保模型总能看到 hook context。
        const pendingHookMessages = hooksPromise && hookMessages.length === 0 ? hooksPromise : undefined;

        profileCheckpoint('action_after_hooks');
        maybeActivateProactive(options);
        maybeActivateBrief(options);
        // 对新会话持久化当前 mode，未来 resume 时能知道当时用的是什么模式
        if (feature('COORDINATOR_MODE')) {
          saveMode(coordinatorModeModule?.isCoordinatorMode() ? 'coordinator' : 'normal');
        }

        // 若通过 deep link 启动，展示来源 banner，让用户知道会话来自外部。
        // Linux xdg-open 和设置了 "always allow" 的浏览器在派发链接时
        // 没有任何 OS 级确认，因此这是用户能看到的唯一信号，表明
        // 该 prompt —— 以及它隐含的工作目录 / CLAUDE.md —— 来自外部
        // 而不是用户自己输入的。
        let deepLinkBanner: ReturnType<typeof createSystemMessage> | null = null;
        if (feature('LODESTONE')) {
          if (options.deepLinkOrigin) {
            logEvent('tengu_deep_link_opened', {
              has_prefill: Boolean(options.prefill),
              has_repo: Boolean(options.deepLinkRepo),
            });
            deepLinkBanner = createSystemMessage(
              buildDeepLinkBanner({
                cwd: getCwd(),
                prefillLength: options.prefill?.length,
                repo: options.deepLinkRepo,
                lastFetch: options.deepLinkLastFetch !== undefined ? new Date(options.deepLinkLastFetch) : undefined,
              }),
              'warning',
            );
          } else if (options.prefill) {
            deepLinkBanner = createSystemMessage(
              'Launched with a pre-filled prompt — review it before pressing Enter.',
              'warning',
            );
          }
        }
        const initialMessages = deepLinkBanner
          ? [deepLinkBanner, ...hookMessages]
          : hookMessages.length > 0
            ? hookMessages
            : undefined;

        await launchRepl(
          root,
          { getFpsMetrics, stats, initialState },
          {
            ...sessionConfig,
            initialMessages,
            pendingHookMessages,
          },
          renderAndRun,
        );
      }
    })
    .version(`${MACRO.VERSION} (Claude Code)`, '-v, --version', 'Output the version number');

  // Worktree 相关标志
  program.option('-w, --worktree [name]', 'Create a new git worktree for this session (optionally specify a name)');
  program.option(
    '--tmux',
    'Create a tmux session for the worktree (requires --worktree). Uses iTerm2 native panes when available; use --tmux=classic for traditional tmux.',
  );

  if (canUserConfigureAdvisor()) {
    program.addOption(
      new Option(
        '--advisor <model>',
        'Enable the server-side advisor tool with the specified model (alias or full ID).',
      ).hideHelp(),
    );
  }

  if (process.env.USER_TYPE === 'ant') {
    program.addOption(
      new Option('--delegate-permissions', '[ANT-ONLY] Alias for --permission-mode auto.').implies({
        permissionMode: 'auto',
      }),
    );
    program.addOption(
      new Option(
        '--dangerously-skip-permissions-with-classifiers',
        '[ANT-ONLY] Deprecated alias for --permission-mode auto.',
      )
        .hideHelp()
        .implies({ permissionMode: 'auto' }),
    );
    program.addOption(
      new Option('--afk', '[ANT-ONLY] Deprecated alias for --permission-mode auto.')
        .hideHelp()
        .implies({ permissionMode: 'auto' }),
    );
    program.addOption(
      new Option(
        '--tasks [id]',
        '[ANT-ONLY] Tasks mode: watch for tasks and auto-process them. Optional id is used as both the task list ID and agent ID (defaults to "tasklist").',
      )
        .argParser(String)
        .hideHelp(),
    );
    program.option('--agent-teams', '[ANT-ONLY] Force Claude to use multi-agent mode for solving problems', () => true);
  }

  if (feature('TRANSCRIPT_CLASSIFIER')) {
    program.addOption(new Option('--enable-auto-mode', 'Opt in to auto mode').hideHelp());
  }

  if (feature('PROACTIVE') || feature('KAIROS')) {
    program.addOption(new Option('--proactive', 'Start in proactive autonomous mode'));
  }

  if (feature('UDS_INBOX')) {
    program.addOption(
      new Option(
        '--messaging-socket-path <path>',
        'Unix domain socket path for the UDS messaging server (defaults to a tmp path)',
      ),
    );
  }

  if (feature('KAIROS') || feature('KAIROS_BRIEF')) {
    program.addOption(new Option('--brief', 'Enable SendUserMessage tool for agent-to-user communication'));
  }
  if (feature('KAIROS')) {
    program.addOption(new Option('--assistant', 'Force assistant mode (Agent SDK daemon use)').hideHelp());
  }
  program.addOption(
    new Option(
      '--channels <servers...>',
      'MCP servers whose channel notifications (inbound push) should register this session. Space-separated server names.',
    ).hideHelp(),
  );
  program.addOption(
    new Option(
      '--dangerously-load-development-channels <servers...>',
      'Load channel servers not on the approved allowlist. For local channel development only. Shows a confirmation dialog at startup.',
    ).hideHelp(),
  );

  // Teammate 身份选项（leader 派生 tmux teammate 时设置）
  // 这些取代了 CLAUDE_CODE_* 环境变量
  program.addOption(new Option('--agent-id <id>', 'Teammate agent ID').hideHelp());
  program.addOption(new Option('--agent-name <name>', 'Teammate display name').hideHelp());
  program.addOption(new Option('--team-name <name>', 'Team name for swarm coordination').hideHelp());
  program.addOption(new Option('--agent-color <color>', 'Teammate UI color').hideHelp());
  program.addOption(new Option('--plan-mode-required', 'Require plan mode before implementation').hideHelp());
  program.addOption(new Option('--parent-session-id <id>', 'Parent session ID for analytics correlation').hideHelp());
  program.addOption(
    new Option('--teammate-mode <mode>', 'How to spawn teammates: "tmux", "in-process", or "auto"')
      .choices(['auto', 'tmux', 'in-process'])
      .hideHelp(),
  );
  program.addOption(new Option('--agent-type <type>', 'Custom agent type for this teammate').hideHelp());

  // 对所有构建启用 SDK URL，但帮助文本中隐藏
  program.addOption(
    new Option(
      '--sdk-url <url>',
      'Use remote WebSocket endpoint for SDK I/O streaming (only with -p and stream-json format)',
    ).hideHelp(),
  );

  // 对所有构建启用 teleport/remote 标志，但在 GA 前保持未文档化
  program.addOption(
    new Option('--teleport [session]', 'Resume a teleport session, optionally specify session ID').hideHelp(),
  );
  program.addOption(
    new Option('--remote [description]', 'Create a remote session with the given description').hideHelp(),
  );
  if (feature('BRIDGE_MODE')) {
    program.addOption(
      new Option(
        '--remote-control [name]',
        'Start an interactive session with Remote Control enabled (optionally named)',
      )
        .argParser(value => value || true)
        .hideHelp(),
    );
    program.addOption(
      new Option('--rc [name]', 'Alias for --remote-control').argParser(value => value || true).hideHelp(),
    );
  }

  if (feature('HARD_FAIL')) {
    program.addOption(new Option('--hard-fail', 'Crash on logError calls instead of silently logging').hideHelp());
  }

  profileCheckpoint('run_main_options_built');

  // -p/--print 模式：跳过子命令注册。这 52 个子命令
  // （mcp、auth、plugin、skill、task、config、doctor、update 等）
  // 在 print 模式下永远不会被派发 —— commander 会把 prompt 路由到
  // 默认 action。子命令注册路径基线耗时 ~65ms —— 主要是 isBridgeEnabled()
  // 调用（25ms settings Zod 解析 + 40ms 同步 keychain 子进程），
  // 两者都被 try/catch 屏蔽（在 enableConfigs() 之前永远返回 false）。
  // cc:// URL 在 main() 的约 851 行被改写为 `open`，早于此处运行，
  // 因此 argv 检查在这里是安全的。
  const isPrintMode = process.argv.includes('-p') || process.argv.includes('--print');
  const isCcUrl = process.argv.some(a => a.startsWith('cc://') || a.startsWith('cc+unix://'));
  if (isPrintMode && !isCcUrl) {
    profileCheckpoint('run_before_parse');
    await program.parseAsync(process.argv);
    profileCheckpoint('run_after_parse');
    return program;
  }

  // claude mcp 子命令

  const mcp = program
    .command('mcp')
    .description('Configure and manage MCP servers')
    .configureHelp(createSortedHelpConfig())
    .enablePositionalOptions();

  mcp
    .command('serve')
    .description(`Start the Claude Code MCP server`)
    .option('-d, --debug', 'Enable debug mode', () => true)
    .option('--verbose', 'Override verbose mode setting from config', () => true)
    .action(async ({ debug, verbose }: { debug?: boolean; verbose?: boolean }) => {
      const { mcpServeHandler } = await import('./cli/handlers/mcp.js');
      await mcpServeHandler({ debug, verbose });
    });

  // 注册 mcp add 子命令（为可测试性抽出）
  registerMcpAddCommand(mcp);

  if (isXaaEnabled()) {
    registerMcpXaaIdpCommand(mcp);
  }

  mcp
    .command('remove <name>')
    .description('Remove an MCP server')
    .option(
      '-s, --scope <scope>',
      'Configuration scope (local, user, or project) - if not specified, removes from whichever scope it exists in',
    )
    .action(async (name: string, options: { scope?: string }) => {
      const { mcpRemoveHandler } = await import('./cli/handlers/mcp.js');
      await mcpRemoveHandler(name, options);
    });

  mcp
    .command('list')
    .description(
      'List configured MCP servers. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.',
    )
    .action(async () => {
      const { mcpListHandler } = await import('./cli/handlers/mcp.js');
      await mcpListHandler();
    });

  mcp
    .command('get <name>')
    .description(
      'Get details about an MCP server. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.',
    )
    .action(async (name: string) => {
      const { mcpGetHandler } = await import('./cli/handlers/mcp.js');
      await mcpGetHandler(name);
    });

  mcp
    .command('add-json <name> <json>')
    .description('Add an MCP server (stdio or SSE) with a JSON string')
    .option('-s, --scope <scope>', 'Configuration scope (local, user, or project)', 'local')
    .option('--client-secret', 'Prompt for OAuth client secret (or set MCP_CLIENT_SECRET env var)')
    .action(async (name: string, json: string, options: { scope?: string; clientSecret?: true }) => {
      const { mcpAddJsonHandler } = await import('./cli/handlers/mcp.js');
      await mcpAddJsonHandler(name, json, options);
    });

  mcp
    .command('add-from-claude-desktop')
    .description('Import MCP servers from Claude Desktop (Mac and WSL only)')
    .option('-s, --scope <scope>', 'Configuration scope (local, user, or project)', 'local')
    .action(async (options: { scope?: string }) => {
      const { mcpAddFromDesktopHandler } = await import('./cli/handlers/mcp.js');
      await mcpAddFromDesktopHandler(options);
    });

  mcp
    .command('reset-project-choices')
    .description('Reset all approved and rejected project-scoped (.mcp.json) servers within this project')
    .action(async () => {
      const { mcpResetChoicesHandler } = await import('./cli/handlers/mcp.js');
      await mcpResetChoicesHandler();
    });

  // claude server 子命令
  if (feature('DIRECT_CONNECT')) {
    program
      .command('server')
      .description('Start a Claude Code session server')
      .option('--port <number>', 'HTTP port', '0')
      .option('--host <string>', 'Bind address', '0.0.0.0')
      .option('--auth-token <token>', 'Bearer token for auth')
      .option('--unix <path>', 'Listen on a unix domain socket')
      .option('--workspace <dir>', 'Default working directory for sessions that do not specify cwd')
      .option('--idle-timeout <ms>', 'Idle timeout for detached sessions in ms (0 = never expire)', '600000')
      .option('--max-sessions <n>', 'Maximum concurrent sessions (0 = unlimited)', '32')
      .action(
        async (opts: {
          port: string;
          host: string;
          authToken?: string;
          unix?: string;
          workspace?: string;
          idleTimeout: string;
          maxSessions: string;
        }) => {
          const { randomBytes } = await import('crypto');
          const { startServer } = await import('./server/server.js');
          const { SessionManager } = await import('./server/sessionManager.js');
          const { DangerousBackend } = await import('./server/backends/dangerousBackend.js');
          const { printBanner } = await import('./server/serverBanner.js');
          const { createServerLogger } = await import('./server/serverLog.js');
          const { writeServerLock, removeServerLock, probeRunningServer } = await import('./server/lockfile.js');

          const existing = await probeRunningServer();
          if (existing) {
            process.stderr.write(`A claude server is already running (pid ${existing.pid}) at ${existing.httpUrl}\n`);
            process.exit(1);
          }

          const authToken = opts.authToken ?? `sk-ant-cc-${randomBytes(16).toString('base64url')}`;

          const config = {
            port: parseInt(opts.port, 10),
            host: opts.host,
            authToken,
            unix: opts.unix,
            workspace: opts.workspace,
            idleTimeoutMs: parseInt(opts.idleTimeout, 10),
            maxSessions: parseInt(opts.maxSessions, 10),
          };

          const backend = new DangerousBackend();
          const sessionManager = new SessionManager(backend, {
            idleTimeoutMs: config.idleTimeoutMs,
            maxSessions: config.maxSessions,
          });
          const logger = createServerLogger();

          const server = startServer(config, sessionManager, logger);
          const actualPort = server.port ?? config.port;
          printBanner(config, authToken, actualPort);

          await writeServerLock({
            pid: process.pid,
            port: actualPort,
            host: config.host,
            httpUrl: config.unix ? `unix:${config.unix}` : `http://${config.host}:${actualPort}`,
            startedAt: Date.now(),
          });

          let shuttingDown = false;
          const shutdown = async () => {
            if (shuttingDown) return;
            shuttingDown = true;
            // 在拆解会话之前停止接收新连接。
            server.stop(true);
            await sessionManager.destroyAll();
            await removeServerLock();
            process.exit(0);
          };
          process.once('SIGINT', () => void shutdown());
          process.once('SIGTERM', () => void shutdown());
        },
      );
  }

  // `claude ssh <host> [dir]` —— 这里注册只是为了让 --help 能显示它。
  // 实际的交互式流程由 main() 中早期的 argv 改写处理（与上面的
  // DIRECT_CONNECT/cc:// 模式一致）。如果 commander 走到了这个 action，
  // 说明 argv 改写没触发（例如用户执行 `claude ssh` 没带 host）——
  // 此时只打印用法。
  if (feature('SSH_REMOTE')) {
    program
      .command('ssh <host> [dir]')
      .description(
        'Run Claude Code on a remote host over SSH. Deploys the binary and ' +
          'tunnels API auth back through your local machine — no remote setup needed.',
      )
      .option('--permission-mode <mode>', 'Permission mode for the remote session')
      .option('--dangerously-skip-permissions', 'Skip all permission prompts on the remote (dangerous)')
      .option(
        '--remote-bin <command>',
        'Custom remote binary command (skips probe/deploy). ' +
          "Example: --remote-bin 'bun /path/to/project/dist/cli.js'",
      )
      .option(
        '--local',
        'e2e test mode — spawn the child CLI locally (skip ssh/deploy). ' +
          'Exercises the auth proxy and unix-socket plumbing without a remote host.',
      )
      .action(async () => {
        // main() 中的 argv 改写应该在 commander 运行前消费掉 `ssh <host>`。
        // 走到这里说明 host 缺失或改写谓词没匹配。
        process.stderr.write(
          'Usage: claude ssh <user@host | ssh-config-alias> [dir]\n\n' +
            "Runs Claude Code on a remote Linux host. You don't need to install\n" +
            'anything on the remote or run `claude auth login` there — the binary is\n' +
            'deployed over SSH and API auth tunnels back through your local machine.\n',
        );
        process.exit(1);
      });
  }

  // claude connect —— 子命令只处理 -p（headless）模式。
  // 交互式模式（不带 -p）由 main() 中早期的 argv 改写处理，
  // 重定向到主命令以获得完整 TUI 支持。
  if (feature('DIRECT_CONNECT')) {
    program
      .command('open <cc-url>')
      .description('Connect to a Claude Code server (internal — use cc:// URLs)')
      .option('-p, --print [prompt]', 'Print mode (headless)')
      .option('--output-format <format>', 'Output format: text, json, stream-json', 'text')
      .action(
        async (
          ccUrl: string,
          opts: {
            print?: string | true;
            outputFormat?: string;
          },
        ) => {
          const { parseConnectUrl } = await import('./server/parseConnectUrl.js');
          const { serverUrl, authToken } = parseConnectUrl(ccUrl);

          let connectConfig;
          try {
            const session = await createDirectConnectSession({
              serverUrl,
              authToken,
              cwd: getOriginalCwd(),
              dangerouslySkipPermissions: _pendingConnect?.dangerouslySkipPermissions,
            });
            if (session.workDir) {
              setOriginalCwd(session.workDir);
              setCwdState(session.workDir);
            }
            setDirectConnectServerUrl(serverUrl);
            connectConfig = session.config;
          } catch (err) {
            console.error(err instanceof DirectConnectError ? err.message : String(err));
            process.exit(1);
          }

          const { runConnectHeadless } = await import('./server/connectHeadless.js');

          const prompt = typeof opts.print === 'string' ? opts.print : '';
          const interactive = opts.print === true;
          await runConnectHeadless(connectConfig, prompt, opts.outputFormat, interactive);
        },
      );
  }

  // claude auth 子命令

  const auth = program.command('auth').description('Manage authentication').configureHelp(createSortedHelpConfig());

  auth
    .command('login')
    .description('Sign in to your Anthropic account')
    .option('--email <email>', 'Pre-populate email address on the login page')
    .option('--sso', 'Force SSO login flow')
    .option('--console', 'Use Anthropic Console (API usage billing) instead of Claude subscription')
    .option('--claudeai', 'Use Claude subscription (default)')
    .action(
      async ({
        email,
        sso,
        console: useConsole,
        claudeai,
      }: {
        email?: string;
        sso?: boolean;
        console?: boolean;
        claudeai?: boolean;
      }) => {
        const { authLogin } = await import('./cli/handlers/auth.js');
        await authLogin({ email, sso, console: useConsole, claudeai });
      },
    );

  auth
    .command('status')
    .description('Show authentication status')
    .option('--json', 'Output as JSON (default)')
    .option('--text', 'Output as human-readable text')
    .action(async (opts: { json?: boolean; text?: boolean }) => {
      const { authStatus } = await import('./cli/handlers/auth.js');
      await authStatus(opts);
    });

  auth
    .command('logout')
    .description('Log out from your Anthropic account')
    .action(async () => {
      const { authLogout } = await import('./cli/handlers/auth.js');
      await authLogout();
    });

  /**
   * 统一处理 marketplace 命令错误的 helper 函数。
   * 记录错误并以状态码 1 退出进程。
   * @param error 发生的错误
   * @param action 失败操作的描述
   */
  // 所有 plugin/marketplace 子命令都有的隐藏 flag，用于指向 cowork_plugins。
  const coworkOption = () => new Option('--cowork', 'Use cowork_plugins directory').hideHelp();

  // plugin validate 子命令
  const pluginCmd = program
    .command('plugin')
    .alias('plugins')
    .description('Manage Claude Code plugins')
    .configureHelp(createSortedHelpConfig());

  pluginCmd
    .command('validate <path>')
    .description('Validate a plugin or marketplace manifest')
    .addOption(coworkOption())
    .action(async (manifestPath: string, options: { cowork?: boolean }) => {
      const { pluginValidateHandler } = await import('./cli/handlers/plugins.js');
      await pluginValidateHandler(manifestPath, options);
    });

  // plugin list 子命令
  pluginCmd
    .command('list')
    .description('List installed plugins')
    .option('--json', 'Output as JSON')
    .option('--available', 'Include available plugins from marketplaces (requires --json)')
    .addOption(coworkOption())
    .action(async (options: { json?: boolean; available?: boolean; cowork?: boolean }) => {
      const { pluginListHandler } = await import('./cli/handlers/plugins.js');
      await pluginListHandler(options);
    });

  // marketplace 子命令
  const marketplaceCmd = pluginCmd
    .command('marketplace')
    .description('Manage Claude Code marketplaces')
    .configureHelp(createSortedHelpConfig());

  marketplaceCmd
    .command('add <source>')
    .description('Add a marketplace from a URL, path, or GitHub repo')
    .addOption(coworkOption())
    .option(
      '--sparse <paths...>',
      'Limit checkout to specific directories via git sparse-checkout (for monorepos). Example: --sparse .claude-plugin plugins',
    )
    .option('--scope <scope>', 'Where to declare the marketplace: user (default), project, or local')
    .action(
      async (
        source: string,
        options: {
          cowork?: boolean;
          sparse?: string[];
          scope?: string;
        },
      ) => {
        const { marketplaceAddHandler } = await import('./cli/handlers/plugins.js');
        await marketplaceAddHandler(source, options);
      },
    );

  marketplaceCmd
    .command('list')
    .description('List all configured marketplaces')
    .option('--json', 'Output as JSON')
    .addOption(coworkOption())
    .action(async (options: { json?: boolean; cowork?: boolean }) => {
      const { marketplaceListHandler } = await import('./cli/handlers/plugins.js');
      await marketplaceListHandler(options);
    });

  marketplaceCmd
    .command('remove <name>')
    .alias('rm')
    .description('Remove a configured marketplace')
    .addOption(coworkOption())
    .action(async (name: string, options: { cowork?: boolean }) => {
      const { marketplaceRemoveHandler } = await import('./cli/handlers/plugins.js');
      await marketplaceRemoveHandler(name, options);
    });

  marketplaceCmd
    .command('update [name]')
    .description('Update marketplace(s) from their source - updates all if no name specified')
    .addOption(coworkOption())
    .action(async (name: string | undefined, options: { cowork?: boolean }) => {
      const { marketplaceUpdateHandler } = await import('./cli/handlers/plugins.js');
      await marketplaceUpdateHandler(name, options);
    });

  // plugin install 子命令
  pluginCmd
    .command('install <plugin>')
    .alias('i')
    .description('Install a plugin from available marketplaces (use plugin@marketplace for specific marketplace)')
    .option('-s, --scope <scope>', 'Installation scope: user, project, or local', 'user')
    .addOption(coworkOption())
    .action(async (plugin: string, options: { scope?: string; cowork?: boolean }) => {
      const { pluginInstallHandler } = await import('./cli/handlers/plugins.js');
      await pluginInstallHandler(plugin, options);
    });

  // plugin uninstall 子命令
  pluginCmd
    .command('uninstall <plugin>')
    .alias('remove')
    .alias('rm')
    .description('Uninstall an installed plugin')
    .option('-s, --scope <scope>', 'Uninstall from scope: user, project, or local', 'user')
    .option('--keep-data', "Preserve the plugin's persistent data directory (~/.claude/plugins/data/{id}/)")
    .addOption(coworkOption())
    .action(
      async (
        plugin: string,
        options: {
          scope?: string;
          cowork?: boolean;
          keepData?: boolean;
        },
      ) => {
        const { pluginUninstallHandler } = await import('./cli/handlers/plugins.js');
        await pluginUninstallHandler(plugin, options);
      },
    );

  // plugin enable 子命令
  pluginCmd
    .command('enable <plugin>')
    .description('Enable a disabled plugin')
    .option('-s, --scope <scope>', `Installation scope: ${VALID_INSTALLABLE_SCOPES.join(', ')} (default: auto-detect)`)
    .addOption(coworkOption())
    .action(async (plugin: string, options: { scope?: string; cowork?: boolean }) => {
      const { pluginEnableHandler } = await import('./cli/handlers/plugins.js');
      await pluginEnableHandler(plugin, options);
    });

  // plugin disable 子命令
  pluginCmd
    .command('disable [plugin]')
    .description('Disable an enabled plugin')
    .option('-a, --all', 'Disable all enabled plugins')
    .option('-s, --scope <scope>', `Installation scope: ${VALID_INSTALLABLE_SCOPES.join(', ')} (default: auto-detect)`)
    .addOption(coworkOption())
    .action(async (plugin: string | undefined, options: { scope?: string; cowork?: boolean; all?: boolean }) => {
      const { pluginDisableHandler } = await import('./cli/handlers/plugins.js');
      await pluginDisableHandler(plugin, options);
    });

  // plugin update 子命令
  pluginCmd
    .command('update <plugin>')
    .description('Update a plugin to the latest version (restart required to apply)')
    .option('-s, --scope <scope>', `Installation scope: ${VALID_UPDATE_SCOPES.join(', ')} (default: user)`)
    .addOption(coworkOption())
    .action(async (plugin: string, options: { scope?: string; cowork?: boolean }) => {
      const { pluginUpdateHandler } = await import('./cli/handlers/plugins.js');
      await pluginUpdateHandler(plugin, options);
    });
  // END ANT-ONLY —— 仅 ant 内部结束标记

  // setup-token 子命令
  program
    .command('setup-token')
    .description('Set up a long-lived authentication token (requires Claude subscription)')
    .action(async () => {
      const [{ setupTokenHandler }, { createRoot }] = await Promise.all([
        import('./cli/handlers/util.js'),
        import('@anthropic/ink'),
      ]);
      const root = await createRoot(getBaseRenderOptions(false));
      await setupTokenHandler(root);
    });

  // agents 子命令 —— 列出已配置的 agents
  program
    .command('agents')
    .description('List configured agents')
    .option('--setting-sources <sources>', 'Comma-separated list of setting sources to load (user, project, local).')
    .action(async () => {
      const { agentsHandler } = await import('./cli/handlers/agents.js');
      await agentsHandler();
      process.exit(0);
    });

  if (feature('TRANSCRIPT_CLASSIFIER')) {
    // 当 tengu_auto_mode_config.enabled === 'disabled' 时跳过（熔断器）。
    // 从磁盘缓存读取 —— 注册时 GrowthBook 还没初始化。
    if (getAutoModeEnabledStateIfCached() !== 'disabled') {
      const autoModeCmd = program.command('auto-mode').description('Inspect auto mode classifier configuration');

      autoModeCmd
        .command('defaults')
        .description('Print the default auto mode environment, allow, and deny rules as JSON')
        .action(async () => {
          const { autoModeDefaultsHandler } = await import('./cli/handlers/autoMode.js');
          autoModeDefaultsHandler();
          process.exit(0);
        });

      autoModeCmd
        .command('config')
        .description('Print the effective auto mode config as JSON: your settings where set, defaults otherwise')
        .action(async () => {
          const { autoModeConfigHandler } = await import('./cli/handlers/autoMode.js');
          autoModeConfigHandler();
          process.exit(0);
        });

      autoModeCmd
        .command('critique')
        .description('Get AI feedback on your custom auto mode rules')
        .option('--model <model>', 'Override which model is used')
        .action(async options => {
          const { autoModeCritiqueHandler } = await import('./cli/handlers/autoMode.js');
          await autoModeCritiqueHandler(options);
          process.exit();
        });
    }
  }

  // claude autonomy —— 镜像 /autonomy slash 命令的 CLI 子命令
  {
    const autonomyCmd = program.command('autonomy').description('Inspect and manage automatic autonomy runs and flows');

    autonomyCmd
      .command('status')
      .description('Print autonomy run, flow, team, pipe, and remote-control status')
      .option('--deep', 'Include teams, pipes, daemon, and remote-control sections')
      .action(async (options: { deep?: boolean }) => {
        const { autonomyStatusHandler } = await import('./cli/handlers/autonomy.js');
        await autonomyStatusHandler(options);
        process.exit(0);
      });

    autonomyCmd
      .command('runs [limit]')
      .description('List recent autonomy runs')
      .action(async (limit?: string) => {
        const { autonomyRunsHandler } = await import('./cli/handlers/autonomy.js');
        await autonomyRunsHandler(limit);
        process.exit(0);
      });

    autonomyCmd
      .command('flows [limit]')
      .description('List recent autonomy flows')
      .action(async (limit?: string) => {
        const { autonomyFlowsHandler } = await import('./cli/handlers/autonomy.js');
        await autonomyFlowsHandler(limit);
        process.exit(0);
      });

    const flowCmd = autonomyCmd
      .command('flow <flowId>')
      .description('Inspect a single autonomy flow')
      .action(async (flowId: string) => {
        const { autonomyFlowHandler } = await import('./cli/handlers/autonomy.js');
        await autonomyFlowHandler(flowId);
        process.exit(0);
      });

    flowCmd
      .command('cancel <flowId>')
      .description('Cancel a queued, waiting, or running autonomy flow')
      .action(async (flowId: string) => {
        const { autonomyFlowCancelHandler } = await import('./cli/handlers/autonomy.js');
        await autonomyFlowCancelHandler(flowId);
        process.exit(0);
      });

    flowCmd
      .command('resume <flowId>')
      .description('Resume a waiting autonomy flow')
      .action(async (flowId: string) => {
        const { autonomyFlowResumeHandler } = await import('./cli/handlers/autonomy.js');
        await autonomyFlowResumeHandler(flowId);
        process.exit(0);
      });
  }

  // Remote Control 命令 —— 把本地环境连接到 claude.ai/code。
  // 实际命令会被 cli.tsx 中的 fast-path 在 Commander.js 运行前拦截，
  // 因此这个注册只为帮助输出而存在。始终隐藏：此处的 isBridgeEnabled()
  // （在 enableConfigs 之前）会在 isClaudeAISubscriber → getGlobalConfig
  // 内部抛错，并经 try/catch 返回 false —— 但已经付出了 ~65ms 副作用
  // （25ms settings Zod 解析 + 40ms 同步 `security` keychain 子进程）。
  // 动态可见性从未生效；命令一直都是隐藏的。
  if (feature('BRIDGE_MODE')) {
    program
      .command('remote-control', { hidden: true })
      .alias('rc')
      .description('Connect your local environment for remote-control sessions via claude.ai/code')
      .action(async () => {
        // 不可达 —— cli.tsx 的 fast-path 会在 main.tsx 加载前处理此命令。
        // 万一真的走到了，委托给 bridgeMain。
        const { bridgeMain } = await import('./bridge/bridgeMain.js');
        await bridgeMain(process.argv.slice(3));
      });
  }

  if (feature('KAIROS')) {
    program
      .command('assistant [sessionId]')
      .description(
        'Attach the REPL as a client to a running bridge session. Discovers sessions via API if no sessionId given.',
      )
      .action(() => {
        // 上面的 argv 改写应该在 commander 运行前消费掉 `assistant [id]`。
        // 走到这里说明先出现了根级 flag（例如 `--debug assistant`），
        // 导致 position-0 谓词没匹配。像 ssh stub 一样打印用法。
        process.stderr.write(
          'Usage: claude assistant [sessionId]\n\n' +
            'Attach the REPL as a viewer client to a running bridge session.\n' +
            'Omit sessionId to discover and pick from available sessions.\n',
        );
        process.exit(1);
      });
  }

  // doctor 子命令 —— 检查安装健康度
  program
    .command('doctor')
    .description(
      'Check the health of your Claude Code auto-updater. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.',
    )
    .action(async () => {
      const [{ doctorHandler }, { createRoot }] = await Promise.all([
        import('./cli/handlers/util.js'),
        import('@anthropic/ink'),
      ]);
      const root = await createRoot(getBaseRenderOptions(false));
      await doctorHandler(root);
    });

  // claude up —— 执行项目 CLAUDE.md 中 "# claude up" 部分的初始化指引。
  if (process.env.USER_TYPE === 'ant') {
    program
      .command('up')
      .description(
        '[ANT-ONLY] Initialize or upgrade the local dev environment using the "# claude up" section of the nearest CLAUDE.md',
      )
      .action(async () => {
        const { up } = await import('src/cli/up.js');
        await up();
      });
  }

  // claude rollback（仅 ant）
  // 回滚到之前的版本
  if (process.env.USER_TYPE === 'ant') {
    program
      .command('rollback [target]')
      .description(
        '[ANT-ONLY] Roll back to a previous release\n\nExamples:\n  claude rollback                                    Go 1 version back from current\n  claude rollback 3                                  Go 3 versions back from current\n  claude rollback 2.0.73-dev.20251217.t190658        Roll back to a specific version',
      )
      .option('-l, --list', 'List recent published versions with ages')
      .option('--dry-run', 'Show what would be installed without installing')
      .option('--safe', 'Roll back to the server-pinned safe version (set by oncall during incidents)')
      .action(
        async (
          target?: string,
          options?: {
            list?: boolean;
            dryRun?: boolean;
            safe?: boolean;
          },
        ) => {
          const { rollback } = await import('src/cli/rollback.js');
          await rollback(target, options);
        },
      );
  }

  // claude install 子命令
  program
    .command('install [target]')
    .description(
      'Install Claude Code native build. Use [target] to specify version (stable, latest, or specific version)',
    )
    .option('--force', 'Force installation even if already installed')
    .action(async (target: string | undefined, options: { force?: boolean }) => {
      const { installHandler } = await import('./cli/handlers/util.js');
      await installHandler(target, options);
    });

  // claude update —— 通过 npm 或 bun 把 ccb 升级到最新版本
  program
    .command('update')
    .description('Update claude-code-best (ccb) to the latest version')
    .action(async () => {
      const { updateCCB } = await import('./cli/updateCCB.js');
      await updateCCB();
    });

  // ant 内部专属命令
  if (process.env.USER_TYPE === 'ant') {
    const validateLogId = (value: string) => {
      const maybeSessionId = validateUuid(value);
      if (maybeSessionId) return maybeSessionId;
      return Number(value);
    };
    // claude log 子命令
    program
      .command('log')
      .description('[ANT-ONLY] Manage conversation logs.')
      .argument(
        '[number|sessionId]',
        'A number (0, 1, 2, etc.) to display a specific log, or the sesssion ID (uuid) of a log',
        validateLogId,
      )
      .action(async (logId: string | number | undefined) => {
        const { logHandler } = await import('./cli/handlers/ant.js');
        await logHandler(logId);
      });

    // claude error 子命令
    program
      .command('error')
      .description(
        '[ANT-ONLY] View error logs. Optionally provide a number (0, -1, -2, etc.) to display a specific log.',
      )
      .argument('[number]', 'A number (0, 1, 2, etc.) to display a specific log', parseInt)
      .action(async (number: number | undefined) => {
        const { errorHandler } = await import('./cli/handlers/ant.js');
        await errorHandler(number);
      });

    // claude export 子命令
    program
      .command('export')
      .description('[ANT-ONLY] Export a conversation to a text file.')
      .usage('<source> <outputFile>')
      .argument('<source>', 'Session ID, log index (0, 1, 2...), or path to a .json/.jsonl log file')
      .argument('<outputFile>', 'Output file path for the exported text')
      .addHelpText(
        'after',
        `
Examples:
  $ claude export 0 conversation.txt                Export conversation at log index 0
  $ claude export <uuid> conversation.txt           Export conversation by session ID
  $ claude export input.json output.txt             Render JSON log file to text
  $ claude export <uuid>.jsonl output.txt           Render JSONL session file to text`,
      )
      .action(async (source: string, outputFile: string) => {
        const { exportHandler } = await import('./cli/handlers/ant.js');
        await exportHandler(source, outputFile);
      });

    if (process.env.USER_TYPE === 'ant') {
      const taskCmd = program.command('task').description('[ANT-ONLY] Manage task list tasks');

      taskCmd
        .command('create <subject>')
        .description('Create a new task')
        .option('-d, --description <text>', 'Task description')
        .option('-l, --list <id>', 'Task list ID (defaults to "tasklist")')
        .action(async (subject: string, opts: { description?: string; list?: string }) => {
          const { taskCreateHandler } = await import('./cli/handlers/ant.js');
          await taskCreateHandler(subject, opts);
        });

      taskCmd
        .command('list')
        .description('List all tasks')
        .option('-l, --list <id>', 'Task list ID (defaults to "tasklist")')
        .option('--pending', 'Show only pending tasks')
        .option('--json', 'Output as JSON')
        .action(async (opts: { list?: string; pending?: boolean; json?: boolean }) => {
          const { taskListHandler } = await import('./cli/handlers/ant.js');
          await taskListHandler(opts);
        });

      taskCmd
        .command('get <id>')
        .description('Get details of a task')
        .option('-l, --list <id>', 'Task list ID (defaults to "tasklist")')
        .action(async (id: string, opts: { list?: string }) => {
          const { taskGetHandler } = await import('./cli/handlers/ant.js');
          await taskGetHandler(id, opts);
        });

      taskCmd
        .command('update <id>')
        .description('Update a task')
        .option('-l, --list <id>', 'Task list ID (defaults to "tasklist")')
        .option('-s, --status <status>', `Set status (${TASK_STATUSES.join(', ')})`)
        .option('--subject <text>', 'Update subject')
        .option('-d, --description <text>', 'Update description')
        .option('--owner <agentId>', 'Set owner')
        .option('--clear-owner', 'Clear owner')
        .action(
          async (
            id: string,
            opts: {
              list?: string;
              status?: string;
              subject?: string;
              description?: string;
              owner?: string;
              clearOwner?: boolean;
            },
          ) => {
            const { taskUpdateHandler } = await import('./cli/handlers/ant.js');
            await taskUpdateHandler(id, opts);
          },
        );

      taskCmd
        .command('dir')
        .description('Show the tasks directory path')
        .option('-l, --list <id>', 'Task list ID (defaults to "tasklist")')
        .action(async (opts: { list?: string }) => {
          const { taskDirHandler } = await import('./cli/handlers/ant.js');
          await taskDirHandler(opts);
        });
    }

    // claude completion <shell> 子命令
    program
      .command('completion <shell>', { hidden: true })
      .description('Generate shell completion script (bash, zsh, or fish)')
      .option('--output <file>', 'Write completion script directly to a file instead of stdout')
      .action(async (shell: string, opts: { output?: string }) => {
        const { completionHandler } = await import('./cli/handlers/ant.js');
        await completionHandler(shell, opts, program);
      });
  }

  profileCheckpoint('run_before_parse');
  await program.parseAsync(process.argv);
  profileCheckpoint('run_after_parse');

  // 记录 total_time 计算所需的最终 checkpoint
  profileCheckpoint('main_after_run');

  // 把启动性能上报到 Statsig（采样），并在启用时输出详细报告
  profileReport();

  return program;
}

async function logTenguInit({
  hasInitialPrompt,
  hasStdin,
  verbose,
  debug,
  debugToStderr,
  print,
  outputFormat,
  inputFormat,
  numAllowedTools,
  numDisallowedTools,
  mcpClientCount,
  worktreeEnabled,
  skipWebFetchPreflight,
  githubActionInputs,
  dangerouslySkipPermissionsPassed,
  permissionMode,
  modeIsBypass,
  allowDangerouslySkipPermissionsPassed,
  systemPromptFlag,
  appendSystemPromptFlag,
  thinkingConfig,
  assistantActivationPath,
}: {
  hasInitialPrompt: boolean;
  hasStdin: boolean;
  verbose: boolean;
  debug: boolean;
  debugToStderr: boolean;
  print: boolean;
  outputFormat: string;
  inputFormat: string;
  numAllowedTools: number;
  numDisallowedTools: number;
  mcpClientCount: number;
  worktreeEnabled: boolean;
  skipWebFetchPreflight: boolean | undefined;
  githubActionInputs: string | undefined;
  dangerouslySkipPermissionsPassed: boolean;
  permissionMode: string;
  modeIsBypass: boolean;
  allowDangerouslySkipPermissionsPassed: boolean;
  systemPromptFlag: 'file' | 'flag' | undefined;
  appendSystemPromptFlag: 'file' | 'flag' | undefined;
  thinkingConfig: ThinkingConfig;
  assistantActivationPath: string | undefined;
}): Promise<void> {
  try {
    logEvent('tengu_init', {
      entrypoint: 'claude' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      hasInitialPrompt,
      hasStdin,
      verbose,
      debug,
      debugToStderr,
      print,
      outputFormat: outputFormat as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      inputFormat: inputFormat as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      numAllowedTools,
      numDisallowedTools,
      mcpClientCount,
      worktree: worktreeEnabled,
      skipWebFetchPreflight,
      ...(githubActionInputs && {
        githubActionInputs: githubActionInputs as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      dangerouslySkipPermissionsPassed,
      permissionMode: permissionMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      modeIsBypass,
      inProtectedNamespace: isInProtectedNamespace(),
      allowDangerouslySkipPermissionsPassed,
      thinkingType: thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(thinkingConfig.type === 'enabled' && {
        thinkingBudgetTokens: thinkingConfig.budgetTokens,
      }),
      ...(systemPromptFlag && {
        systemPromptFlag: systemPromptFlag as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(appendSystemPromptFlag && {
        appendSystemPromptFlag: appendSystemPromptFlag as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      is_simple: isBareMode() || undefined,
      is_coordinator: feature('COORDINATOR_MODE') && coordinatorModeModule?.isCoordinatorMode() ? true : undefined,
      ...(assistantActivationPath && {
        assistantActivationPath: assistantActivationPath as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      autoUpdatesChannel: (getInitialSettings().autoUpdatesChannel ??
        'latest') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(process.env.USER_TYPE === 'ant'
        ? (() => {
            const cwd = getCwd();
            const gitRoot = findGitRoot(cwd);
            const rp = gitRoot ? relative(gitRoot, cwd) || '.' : undefined;
            return rp
              ? {
                  relativeProjectPath: rp as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                }
              : {};
          })()
        : {}),
    });
  } catch (error) {
    logError(error);
  }
}

function maybeActivateProactive(options: unknown): void {
  if (
    (feature('PROACTIVE') || feature('KAIROS')) &&
    ((options as { proactive?: boolean }).proactive || isEnvTruthy(process.env.CLAUDE_CODE_PROACTIVE))
  ) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const proactiveModule = require('./proactive/index.js');
    if (!proactiveModule.isProactiveActive()) {
      proactiveModule.activateProactive('command');
    }
  }
}

function maybeActivateBrief(options: unknown): void {
  if (!(feature('KAIROS') || feature('KAIROS_BRIEF'))) return;
  const briefFlag = (options as { brief?: boolean }).brief;
  const briefEnv = isEnvTruthy(process.env.CLAUDE_CODE_BRIEF);
  if (!briefFlag && !briefEnv) return;
  // --brief / CLAUDE_CODE_BRIEF 是显式 opt-in：先查 entitlement，
  // 再设置 userMsgOptIn 激活工具 + prompt 段。该环境变量也会赋予
  // entitlement（isBriefEntitled() 会读取它），所以单设
  // CLAUDE_CODE_BRIEF=1 就能在开发/测试下强制启用 —— 不需要 GB gate。
  // initialIsBriefOnly 直接读取 getUserMsgOptIn()。
  // 条件 require：静态 import 会通过 BriefTool.ts → prompt.ts
  // 把工具名字符串泄漏到外部构建产物中。
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { isBriefEntitled } =
    require('@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js') as typeof import('@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const entitled = isBriefEntitled();
  if (entitled) {
    setUserMsgOptIn(true);
  }
  // 意图一经发现就无条件触发：enabled=false 能把
  // "用户尝试但被 gate 拦截" 的失败模式记录到 Datadog。
  logEvent('tengu_brief_mode_enabled', {
    enabled: entitled,
    gated: !entitled,
    source: (briefEnv ? 'env' : 'flag') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  });
}

function resetCursor() {
  const terminal = process.stderr.isTTY ? process.stderr : process.stdout.isTTY ? process.stdout : undefined;
  terminal?.write(SHOW_CURSOR);
}

type TeammateOptions = {
  agentId?: string;
  agentName?: string;
  teamName?: string;
  agentColor?: string;
  planModeRequired?: boolean;
  parentSessionId?: string;
  teammateMode?: 'auto' | 'tmux' | 'in-process';
  agentType?: string;
};

function extractTeammateOptions(options: unknown): TeammateOptions {
  if (typeof options !== 'object' || options === null) {
    return {};
  }
  const opts = options as Record<string, unknown>;
  const teammateMode = opts.teammateMode;
  return {
    agentId: typeof opts.agentId === 'string' ? opts.agentId : undefined,
    agentName: typeof opts.agentName === 'string' ? opts.agentName : undefined,
    teamName: typeof opts.teamName === 'string' ? opts.teamName : undefined,
    agentColor: typeof opts.agentColor === 'string' ? opts.agentColor : undefined,
    planModeRequired: typeof opts.planModeRequired === 'boolean' ? opts.planModeRequired : undefined,
    parentSessionId: typeof opts.parentSessionId === 'string' ? opts.parentSessionId : undefined,
    teammateMode:
      teammateMode === 'auto' || teammateMode === 'tmux' || teammateMode === 'in-process' ? teammateMode : undefined,
    agentType: typeof opts.agentType === 'string' ? opts.agentType : undefined,
  };
}
