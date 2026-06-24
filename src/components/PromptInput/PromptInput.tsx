import { feature } from 'bun:bundle';
import chalk from 'chalk';
import * as path from 'path';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNotifications } from 'src/context/notifications.js';
import { useCommandQueue } from 'src/hooks/useCommandQueue.js';
import { type IDEAtMentioned, useIdeAtMentioned } from 'src/hooks/useIdeAtMentioned.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import { type AppState, useAppState, useAppStateStore, useSetAppState } from 'src/state/AppState.js';
import type { FooterItem } from 'src/state/AppStateStore.js';
import { getCwd } from 'src/utils/cwd.js';
import { isQueuedCommandEditable, popAllEditable } from 'src/utils/messageQueueManager.js';
import stripAnsi from 'strip-ansi';
import { companionReservedColumns } from '../../buddy/CompanionSprite.js';
import { findBuddyTriggerPositions, useBuddyNotification } from '../../buddy/useBuddyNotification.js';
import { FastModePicker } from '../../commands/fast/fast.js';
import { isUltrareviewEnabled } from '../../commands/review/ultrareviewEnabled.js';
import { getNativeCSIuTerminalDisplayName } from '../../commands/terminalSetup/terminalSetup.js';
import { type Command, hasCommand } from '../../commands.js';
import { useIsModalOverlayActive } from '../../context/overlayContext.js';
import { useSetPromptOverlayDialog } from '../../context/promptOverlayContext.js';
import { formatImageRef, formatPastedTextRef, getPastedTextRefNumLines, parseReferences } from '../../history.js';
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js';
import { type HistoryMode, useArrowKeyHistory } from '../../hooks/useArrowKeyHistory.js';
import { useBackgroundAgentTasks } from '../../hooks/useBackgroundAgentTasks.js';
import { useDoublePress } from '../../hooks/useDoublePress.js';
import { useHistorySearch } from '../../hooks/useHistorySearch.js';
import type { IDESelection } from '../../hooks/useIdeSelection.js';
import { useInputBuffer } from '../../hooks/useInputBuffer.js';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { usePromptSuggestion } from '../../hooks/usePromptSuggestion.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useTypeahead } from '../../hooks/useTypeahead.js';
import { Box, type BorderTextOptions, type ClickEvent, type Key, stringWidth, Text, useInput } from '@anthropic/ink';
import { useOptionalKeybindingContext } from '../../keybindings/KeybindingContext.js';
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js';
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js';
import type { MCPServerConnection } from '../../services/mcp/types.js';
import { abortPromptSuggestion, logSuggestionSuppressed } from '../../services/PromptSuggestion/promptSuggestion.js';
import { type ActiveSpeculationState, abortSpeculation } from '../../services/PromptSuggestion/speculation.js';
import { getActiveAgentForInput, getViewedTeammateTask } from '../../state/selectors.js';
import { enterTeammateView, exitTeammateView, stopOrDismissAgent } from '../../state/teammateViewHelpers.js';
import type { ToolPermissionContext } from '../../Tool.js';
import { getRunningTeammatesSorted } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js';
import { isPanelAgentTask, type LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js';
import { isBackgroundTask } from '../../tasks/types.js';
import {
  AGENT_COLOR_TO_THEME_COLOR,
  AGENT_COLORS,
  type AgentColorName,
} from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js';
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js';
import type { Message } from '../../types/message.js';
import type { BaseTextInputProps, PromptInputMode, VimMode } from '../../types/textInputTypes.js';
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js';
import { count } from '../../utils/array.js';
import type { AutoUpdaterResult } from '../../utils/autoUpdater.js';
import { Cursor } from '../../utils/Cursor.js';
import { getGlobalConfig, type PastedContent, saveGlobalConfig } from '../../utils/config.js';
import { logForDebugging } from '../../utils/debug.js';
import { parseDirectMemberMessage, sendDirectMemberMessage } from '../../utils/directMemberMessage.js';
import type { EffortLevel } from '../../utils/effort.js';
import { env } from '../../utils/env.js';
import { errorMessage } from '../../utils/errors.js';
import { isBilledAsExtraUsage } from '../../utils/extraUsage.js';
import {
  getFastModeUnavailableReason,
  isFastModeAvailable,
  isFastModeCooldown,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from '../../utils/fastMode.js';
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js';
import type { PromptInputHelpers } from '../../utils/handlePromptSubmit.js';
import { getImageFromClipboard, PASTE_THRESHOLD } from '../../utils/imagePaste.js';
import type { ImageDimensions } from '../../utils/imageResizer.js';
import { cacheImagePath, storeImage } from '../../utils/imageStore.js';
import { isMacosOptionChar, MACOS_OPTION_SPECIAL_CHARS } from '../../utils/keyboardShortcuts.js';
import { logError } from '../../utils/log.js';
import { isOpus1mMergeEnabled, modelDisplayString } from '../../utils/model/model.js';
import { cyclePermissionMode, getNextPermissionMode } from '../../utils/permissions/getNextPermissionMode.js';
import { getPlatform } from '../../utils/platform.js';
import type { ProcessUserInputContext } from '../../utils/processUserInput/processUserInput.js';
import { editPromptInEditor } from '../../utils/promptEditor.js';
// hasAutoModeOptIn 已移除 —— 自动模式对所有用户开放
import { findBtwTriggerPositions } from '../../utils/sideQuestion.js';
import { findSlashCommandPositions } from '../../utils/suggestions/commandSuggestions.js';
import {
  findSlackChannelPositions,
  getKnownChannelsVersion,
  hasSlackMcpServer,
  subscribeKnownChannels,
} from '../../utils/suggestions/slackChannelSuggestions.js';
import { isInProcessEnabled } from '../../utils/swarm/backends/registry.js';
import { syncTeammateMode } from '../../utils/swarm/teamHelpers.js';
import type { TeamSummary } from '../../utils/teamDiscovery.js';
import { getTeammateColor } from '../../utils/teammate.js';
import { isInProcessTeammate } from '../../utils/teammateContext.js';
import { writeToMailbox } from '../../utils/teammateMailbox.js';
import type { TextHighlight } from '../../utils/textHighlighting.js';
import type { Theme } from '../../utils/theme.js';
import { findThinkingTriggerPositions, getRainbowColor, isUltrathinkEnabled } from '../../utils/thinking.js';
import { findTokenBudgetPositions } from '../../utils/tokenBudget.js';
import { findUltraplanTriggerPositions, findUltrareviewTriggerPositions } from '../../utils/ultraplan/keyword.js';
// AutoModeOptInDialog 已移除 —— 自动模式对所有用户开放
import { BridgeDialog } from '../BridgeDialog.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { getVisibleAgentTasks, useCoordinatorTaskCount } from '../CoordinatorAgentStatus.js';
import { getEffortNotificationText } from '../EffortIndicator.js';
import { getFastIconString } from '../FastIcon.js';
import { GlobalSearchDialog } from '../GlobalSearchDialog.js';
import { HistorySearchDialog } from '../HistorySearchDialog.js';
import { ModelPicker } from '../ModelPicker.js';
import { QuickOpenDialog } from '../QuickOpenDialog.js';
import TextInput from '../TextInput.js';
import { ThinkingToggle } from '../ThinkingToggle.js';
import { BackgroundTasksDialog } from '../tasks/BackgroundTasksDialog.js';
import { shouldHideTasksFooter } from '../tasks/taskStatusUtils.js';
import { TeamsDialog } from '../teams/TeamsDialog.js';
import VimTextInput from '../VimTextInput.js';
import { getModeFromInput, getValueFromInput } from './inputModes.js';
import { FOOTER_TEMPORARY_STATUS_TIMEOUT, Notifications } from './Notifications.js';
import PromptInputFooter from './PromptInputFooter.js';
import type { SuggestionItem } from './PromptInputFooterSuggestions.js';
import { PromptInputModeIndicator } from './PromptInputModeIndicator.js';
import { PromptInputQueuedCommands } from './PromptInputQueuedCommands.js';
import { PromptInputStashNotice } from './PromptInputStashNotice.js';
import { useMaybeTruncateInput } from './useMaybeTruncateInput.js';
import { usePromptInputPlaceholder } from './usePromptInputPlaceholder.js';
import { useShowFastIconHint } from './useShowFastIconHint.js';
import { useSwarmBanner } from './useSwarmBanner.js';
import { isNonSpacePrintable, isVimModeEnabled } from './utils.js';

type Props = {
  debug: boolean;
  ideSelection: IDESelection | undefined;
  toolPermissionContext: ToolPermissionContext;
  setToolPermissionContext: (ctx: ToolPermissionContext) => void;
  apiKeyStatus: VerificationStatus;
  commands: Command[];
  agents: AgentDefinition[];
  isLoading: boolean;
  verbose: boolean;
  messages: Message[];
  onAutoUpdaterResult: (result: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  input: string;
  onInputChange: (value: string) => void;
  mode: PromptInputMode;
  onModeChange: (mode: PromptInputMode) => void;
  stashedPrompt:
    | {
        text: string;
        cursorOffset: number;
        pastedContents: Record<number, PastedContent>;
      }
    | undefined;
  setStashedPrompt: (
    value:
      | {
          text: string;
          cursorOffset: number;
          pastedContents: Record<number, PastedContent>;
        }
      | undefined,
  ) => void;
  submitCount: number;
  onShowMessageSelector: () => void;
  /** 全屏消息操作：shift+↑ 进入光标。 */
  onMessageActionsEnter?: () => void;
  mcpClients: MCPServerConnection[];
  pastedContents: Record<number, PastedContent>;
  setPastedContents: React.Dispatch<React.SetStateAction<Record<number, PastedContent>>>;
  vimMode: VimMode;
  setVimMode: (mode: VimMode) => void;
  showBashesDialog: string | boolean;
  setShowBashesDialog: (show: string | boolean) => void;
  onExit: () => void;
  getToolUseContext: (
    messages: Message[],
    newMessages: Message[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => ProcessUserInputContext;
  onSubmit: (
    input: string,
    helpers: PromptInputHelpers,
    speculationAccept?: {
      state: ActiveSpeculationState;
      speculationSessionTimeSavedMs: number;
      setAppState: (f: (prev: AppState) => AppState) => void;
    },
    options?: { fromKeybinding?: boolean },
  ) => Promise<void>;
  onAgentSubmit?: (
    input: string,
    task: InProcessTeammateTaskState | LocalAgentTaskState,
    helpers: PromptInputHelpers,
  ) => Promise<void>;
  isSearchingHistory: boolean;
  setIsSearchingHistory: (isSearching: boolean) => void;
  onDismissSideQuestion?: () => void;
  isSideQuestionVisible?: boolean;
  helpOpen: boolean;
  setHelpOpen: React.Dispatch<React.SetStateAction<boolean>>;
  hasSuppressedDialogs?: boolean;
  isLocalJSXCommandActive?: boolean;
  insertTextRef?: React.MutableRefObject<{
    insert: (text: string) => void;
    setInputWithCursor: (value: string, cursor: number) => void;
    cursorOffset: number;
  } | null>;
  voiceInterimRange?: { start: number; end: number } | null;
};

// 底部插槽最大高度为 50%；为 footer、边框、状态栏预留行数。
const PROMPT_FOOTER_LINES = 5;
const MIN_INPUT_VIEWPORT_LINES = 3;

function PromptInput({
  debug,
  ideSelection,
  toolPermissionContext,
  setToolPermissionContext,
  apiKeyStatus,
  commands,
  agents,
  isLoading,
  verbose,
  messages,
  onAutoUpdaterResult,
  autoUpdaterResult,
  input,
  onInputChange,
  mode,
  onModeChange,
  stashedPrompt,
  setStashedPrompt,
  submitCount,
  onShowMessageSelector,
  onMessageActionsEnter,
  mcpClients,
  pastedContents,
  setPastedContents,
  vimMode,
  setVimMode,
  showBashesDialog,
  setShowBashesDialog,
  onExit,
  getToolUseContext,
  onSubmit: onSubmitProp,
  onAgentSubmit,
  isSearchingHistory,
  setIsSearchingHistory,
  onDismissSideQuestion,
  isSideQuestionVisible,
  helpOpen,
  setHelpOpen,
  hasSuppressedDialogs,
  isLocalJSXCommandActive = false,
  insertTextRef,
  voiceInterimRange,
}: Props): React.ReactNode {
  const mainLoopModel = useMainLoopModel();
  // 本地 JSX 命令（例如 agent 运行时的 /mcp）通过 shouldHidePromptInput: false
  // 的即时命令路径在 PromptInput 上方渲染全屏对话框。
  // 这些对话框不在叠加层系统中注册，因此在此处将其视为模态叠加层，
  // 以防止导航键泄漏到 TextInput/footer 处理器中并堆叠第二个对话框。
  const isModalOverlayActive = useIsModalOverlayActive() || isLocalJSXCommandActive;
  const [isAutoUpdating, setIsAutoUpdating] = useState(false);
  const [exitMessage, setExitMessage] = useState<{
    show: boolean;
    key?: string;
  }>({ show: false });
  const [cursorOffset, setCursorOffset] = useState<number>(input.length);
  // 追踪通过内部处理器设置的最后一个输入值，以便检测
  // 外部输入变化（例如语音转文字注入）并将光标移到末尾。
  const lastInternalInputRef = React.useRef(input);
  if (input !== lastInternalInputRef.current) {
    // 输入被外部修改（非通过任何内部处理器） —— 将光标移到末尾
    setCursorOffset(input.length);
    lastInternalInputRef.current = input;
  }
  // 包装 onInputChange 以在触发重渲染前追踪内部变化
  const trackAndSetInput = React.useCallback(
    (value: string) => {
      lastInternalInputRef.current = value;
      onInputChange(value);
    },
    [onInputChange],
  );
  // 暴露 insertText 函数，使调用者（如 STT）可以在当前光标位置插入文本，
  // 而不是替换整个输入。
  if (insertTextRef) {
    insertTextRef.current = {
      cursorOffset,
      insert: (text: string) => {
        const needsSpace = cursorOffset === input.length && input.length > 0 && !/\s$/.test(input);
        const insertText = needsSpace ? ' ' + text : text;
        const newValue = input.slice(0, cursorOffset) + insertText + input.slice(cursorOffset);
        lastInternalInputRef.current = newValue;
        onInputChange(newValue);
        setCursorOffset(cursorOffset + insertText.length);
      },
      setInputWithCursor: (value: string, cursor: number) => {
        lastInternalInputRef.current = value;
        onInputChange(value);
        setCursorOffset(cursor);
      },
    };
  }
  const store = useAppStateStore();
  const setAppState = useSetAppState();
  const tasks = useAppState(s => s.tasks);
  const replBridgeConnected = useAppState(s => s.replBridgeConnected);
  const replBridgeExplicit = useAppState(s => s.replBridgeExplicit);
  const replBridgeReconnecting = useAppState(s => s.replBridgeReconnecting);
  // 必须与 BridgeStatusIndicator 的渲染条件（PromptInputFooter.tsx）一致 ——
  // 对于隐式且非重连状态，徽章返回 null，导航也必须如此，
  // 否则 bridge 会成为不可见的选择停止点。
  const bridgeFooterVisible = replBridgeConnected && (replBridgeExplicit || replBridgeReconnecting);
  // Tmux 徽章（仅限 ant）—— 当存在活跃的 tungsten 会话时可见
  const hasTungstenSession = useAppState(s => process.env.USER_TYPE === 'ant' && s.tungstenActiveSession !== undefined);
  const tmuxFooterVisible = process.env.USER_TYPE === 'ant' && hasTungstenSession;
  // WebBrowser 徽章 —— 当浏览器打开时可见
  const bagelFooterVisible = useAppState(_s => false);
  const teamContext = useAppState(s => s.teamContext);
  const queuedCommands = useCommandQueue();
  const promptSuggestionState = useAppState(s => s.promptSuggestion);
  const speculation = useAppState(s => s.speculation);
  const speculationSessionTimeSavedMs = useAppState(s => s.speculationSessionTimeSavedMs);
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId);
  const viewSelectionMode = useAppState(s => s.viewSelectionMode);
  const showSpinnerTree = useAppState(s => s.expandedView) === 'teammates';
  const { companion: _companion, companionMuted } = feature('BUDDY')
    ? getGlobalConfig()
    : { companion: undefined, companionMuted: undefined };
  const companionFooterVisible = !!_companion && !companionMuted;
  // 简报模式：BriefSpinner/BriefIdleStatus 占据输入框上方 2 行的空间。
  // 在此处去掉 marginTop 让 spinner 紧贴输入框。
  // viewingAgentTaskId 同步两者的门控（Spinner.tsx、REPL.tsx） ——
  // 团队成员视图回退到有自己 marginTop 的 SpinnerWithVerbInner，
  // 因此即使没有我们的 marginTop 间距也保持不变。
  const isBriefOnlyState = useAppState(s => s.isBriefOnly);
  const briefOwnsGap = feature('KAIROS') || feature('KAIROS_BRIEF') ? isBriefOnlyState && !viewingAgentTaskId : false;
  const mainLoopModel_ = useAppState(s => s.mainLoopModel);
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession);
  const thinkingEnabled = useAppState(s => s.thinkingEnabled);
  const isFastMode = useAppState(s => (isFastModeEnabled() ? s.fastMode : false));
  const effortValue = useAppState(s => s.effortValue);
  const viewedTeammate = getViewedTeammateTask(store.getState());
  const viewingAgentName = viewedTeammate?.identity.agentName;
  // identity.color 的类型为 `string | undefined`（而非 AgentColorName），因为
  // 团队成员身份来自基于文件的配置。在转型前进行验证，
  // 确保只使用有效的颜色名称（无效时回退到 cyan）。
  const viewingAgentColor =
    viewedTeammate?.identity.color && AGENT_COLORS.includes(viewedTeammate.identity.color as AgentColorName)
      ? (viewedTeammate.identity.color as AgentColorName)
      : undefined;
  // 进程内团队成员按字母排序，用于 footer 团队选择器
  const inProcessTeammates = useMemo(() => getRunningTeammatesSorted(tasks), [tasks]);

  // 团队模式：所有后台任务均为进程内团队成员
  const isTeammateMode = inProcessTeammates.length > 0 || viewedTeammate !== undefined;

  // 查看团队成员时，在 footer 中显示其权限模式，而非 leader 的
  const effectiveToolPermissionContext = useMemo((): ToolPermissionContext => {
    if (viewedTeammate) {
      return {
        ...toolPermissionContext,
        mode: viewedTeammate.permissionMode,
      };
    }
    return toolPermissionContext;
  }, [viewedTeammate, toolPermissionContext]);
  const { historyQuery, setHistoryQuery, historyMatch, historyFailedMatch } = useHistorySearch(
    entry => {
      setPastedContents(entry.pastedContents);
      void onSubmit(entry.display);
    },
    input,
    trackAndSetInput,
    setCursorOffset,
    cursorOffset,
    onModeChange,
    mode,
    isSearchingHistory,
    setIsSearchingHistory,
    setPastedContents,
    pastedContents,
  );
  // 粘贴 ID 计数器（图片和文本共享）。
  // 从现有消息中一次性计算初始值（用于 --continue/--resume）。
  // useRef(fn()) 会在每次渲染时执行 fn() 并在挂载后丢弃结果 ——
  // getInitialPasteId 会遍历所有消息并正则扫描文本块，
  // 因此用惰性初始化模式确保只运行一次。
  const nextPasteIdRef = useRef(-1);
  if (nextPasteIdRef.current === -1) {
    nextPasteIdRef.current = getInitialPasteId(messages);
  }
  // 由 onImagePaste 触发；如果下一次按键是非空格可打印字符，
  // inputFilter 会在其前面插入一个空格。任何其他输入
  // （方向键、escape、退格、粘贴、空格）会取消触发而不插入。
  const pendingSpaceAfterPillRef = useRef(false);

  const [showTeamsDialog, setShowTeamsDialog] = useState(false);
  const [showBridgeDialog, setShowBridgeDialog] = useState(false);
  const [teammateFooterIndex, setTeammateFooterIndex] = useState(0);
  // -1 哨兵值：任务徽章已选中但尚未选中具体的 agent 行。
  // 第一次 ↓ 选中徽章，第二次 ↓ 移到第 0 行。
  // 防止在后台任务（徽章）和分叉 agent（行）都可见时双重选中徽章 + 行。
  const coordinatorTaskIndex = useAppState(s => s.coordinatorTaskIndex);
  const selectedBgAgentIndex = useAppState(s => s.selectedBgAgentIndex);
  const setSelectedBgAgentIndex = useCallback(
    (v: number | ((prev: number) => number)) =>
      setAppState(prev => {
        const next = typeof v === 'function' ? v(prev.selectedBgAgentIndex) : v;
        if (next === prev.selectedBgAgentIndex) return prev;
        return { ...prev, selectedBgAgentIndex: next };
      }),
    [setAppState],
  );
  const setCoordinatorTaskIndex = useCallback(
    (v: number | ((prev: number) => number)) =>
      setAppState(prev => {
        const next = typeof v === 'function' ? v(prev.coordinatorTaskIndex) : v;
        if (next === prev.coordinatorTaskIndex) return prev;
        return { ...prev, coordinatorTaskIndex: next };
      }),
    [setAppState],
  );
  const coordinatorTaskCount = useCoordinatorTaskCount();
  // 徽章（BackgroundTaskStatus）仅在存在非 local_agent 后台任务时渲染。
  // 当只有 local_agent 任务运行时（协调者/分叉模式），
  // 徽章不存在，-1 哨兵值会导致视觉上没有选中项。
  // 此时跳过 -1，将 0 作为最小可选索引。
  const hasBgTaskPill = useMemo(
    () =>
      Object.values(tasks).some(t => isBackgroundTask(t) && !(process.env.USER_TYPE === 'ant' && isPanelAgentTask(t))),
    [tasks],
  );
  const minCoordinatorIndex = hasBgTaskPill ? -1 : 0;
  // 当任务完成且列表缩小到光标以下时钳位索引
  useEffect(() => {
    if (coordinatorTaskIndex >= coordinatorTaskCount) {
      setCoordinatorTaskIndex(Math.max(minCoordinatorIndex, coordinatorTaskCount - 1));
    } else if (coordinatorTaskIndex < minCoordinatorIndex) {
      setCoordinatorTaskIndex(minCoordinatorIndex);
    }
  }, [coordinatorTaskCount, coordinatorTaskIndex, minCoordinatorIndex]);
  const [isPasting, setIsPasting] = useState(false);
  const [isExternalEditorActive, setIsExternalEditorActive] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showQuickOpen, setShowQuickOpen] = useState(false);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  const [showHistoryPicker, setShowHistoryPicker] = useState(false);
  const [showFastModePicker, setShowFastModePicker] = useState(false);
  const [showThinkingToggle, setShowThinkingToggle] = useState(false);

  // 检查光标是否在输入的第一行
  const isCursorOnFirstLine = useMemo(() => {
    const firstNewlineIndex = input.indexOf('\n');
    if (firstNewlineIndex === -1) {
      return true; // 没有换行符，光标始终在第一行
    }
    return cursorOffset <= firstNewlineIndex;
  }, [input, cursorOffset]);

  const isCursorOnLastLine = useMemo(() => {
    const lastNewlineIndex = input.lastIndexOf('\n');
    if (lastNewlineIndex === -1) {
      return true; // 没有换行符，光标始终在最后一行
    }
    return cursorOffset > lastNewlineIndex;
  }, [input, cursorOffset]);

  // 从 teamContext 派生团队信息（无需文件系统 I/O）
  // 一个会话一次只能领导一个团队
  const cachedTeams: TeamSummary[] = useMemo(() => {
    if (!isAgentSwarmsEnabled()) return [];
    // 进程内模式使用 Shift+Down/Up 导航，而非 footer 菜单
    if (isInProcessEnabled()) return [];
    if (!teamContext) {
      return [];
    }
    const teammateCount = count(Object.values(teamContext.teammates), t => t.name !== 'team-lead');
    return [
      {
        name: teamContext.teamName,
        memberCount: teammateCount,
        runningCount: 0,
        idleCount: 0,
      },
    ];
  }, [teamContext]);

  // ─── Footer 徽章导航 ─────────────────────────────────────────────
  // 哪些徽章渲染在输入框下方。此处的顺序即为导航顺序
  // （down/right = 前进，up/left = 后退）。选中状态存储在 AppState 中，
  // 以便在 PromptInput 外部渲染的徽章（CompanionSprite）可以读取焦点。
  const runningTaskCount = useMemo(() => count(Object.values(tasks), t => t.status === 'running'), [tasks]);
  // 面板还显示已保留的已完成 agent（getVisibleAgentTasks），因此
  // 只要面板有行，徽章就必须保持可导航 —— 不仅限于有任务运行时。
  const tasksFooterVisible =
    (runningTaskCount > 0 || (process.env.USER_TYPE === 'ant' && coordinatorTaskCount > 0)) &&
    !shouldHideTasksFooter(tasks, showSpinnerTree);
  const teamsFooterVisible = cachedTeams.length > 0;
  const bgAgentList = useBackgroundAgentTasks();
  const bgAgentFooterVisible = bgAgentList.length > 0;

  const footerItems = useMemo(
    () =>
      [
        bgAgentFooterVisible && 'bg_agent',
        tasksFooterVisible && 'tasks',
        tmuxFooterVisible && 'tmux',
        bagelFooterVisible && 'bagel',
        teamsFooterVisible && 'teams',
        bridgeFooterVisible && 'bridge',
        companionFooterVisible && 'companion',
      ].filter(Boolean) as FooterItem[],
    [
      bgAgentFooterVisible,
      tasksFooterVisible,
      tmuxFooterVisible,
      bagelFooterVisible,
      teamsFooterVisible,
      bridgeFooterVisible,
      companionFooterVisible,
    ],
  );

  // 有效选中：如果选中的徽章停止渲染（bridge 断开、任务完成），则为 null。
  // 该派生使 UI 立即正确；下方的 useEffect 清除原始状态，
  // 防止同一徽章再次出现时（新任务启动 → 焦点被抢占）复活。
  const rawFooterSelection = useAppState(s => s.footerSelection);
  const footerItemSelected = rawFooterSelection && footerItems.includes(rawFooterSelection) ? rawFooterSelection : null;

  useEffect(() => {
    if (rawFooterSelection && !footerItemSelected) {
      setAppState(prev => (prev.footerSelection === null ? prev : { ...prev, footerSelection: null }));
    }
  }, [rawFooterSelection, footerItemSelected, setAppState]);

  const tasksSelected = footerItemSelected === 'tasks';
  const tmuxSelected = footerItemSelected === 'tmux';
  const _bagelSelected = footerItemSelected === 'bagel';
  const teamsSelected = footerItemSelected === 'teams';
  const bridgeSelected = footerItemSelected === 'bridge';
  const bgAgentSelected = footerItemSelected === 'bg_agent';

  function selectFooterItem(item: FooterItem | null): void {
    setAppState(prev => (prev.footerSelection === item ? prev : { ...prev, footerSelection: item }));
    if (item === 'tasks') {
      setTeammateFooterIndex(0);
      setCoordinatorTaskIndex(minCoordinatorIndex);
    }
    if (item === 'bg_agent') {
      setSelectedBgAgentIndex(-1);
    }
  }

  // delta：+1 = 下/右，-1 = 上/左。导航发生时返回 true
  // （包括在起始处取消选中），到达边界时返回 false。
  function navigateFooter(delta: 1 | -1, exitAtStart = false): boolean {
    const idx = footerItemSelected ? footerItems.indexOf(footerItemSelected) : -1;
    const next = footerItems[idx + delta];
    if (next) {
      selectFooterItem(next);
      return true;
    }
    if (delta < 0 && exitAtStart) {
      selectFooterItem(null);
      return true;
    }
    return false;
  }

  // Prompt 建议 hook —— 读取查询循环中分叉 agent 生成的建议
  const {
    suggestion: promptSuggestion,
    markAccepted,
    logOutcomeAtSubmission,
    markShown,
  } = usePromptSuggestion({
    inputValue: input,
    isAssistantResponding: isLoading,
  });

  const displayedValue = useMemo(
    () =>
      isSearchingHistory && historyMatch
        ? getValueFromInput(typeof historyMatch === 'string' ? historyMatch : historyMatch.display)
        : input,
    [isSearchingHistory, historyMatch, input],
  );

  const thinkTriggers = useMemo(() => findThinkingTriggerPositions(displayedValue), [displayedValue]);

  const ultraplanSessionUrl = useAppState(s => s.ultraplanSessionUrl);
  const ultraplanLaunching = useAppState(s => s.ultraplanLaunching);
  const ultraplanTriggers = useMemo(
    () =>
      feature('ULTRAPLAN') && !ultraplanSessionUrl && !ultraplanLaunching
        ? findUltraplanTriggerPositions(displayedValue)
        : [],
    [displayedValue, ultraplanSessionUrl, ultraplanLaunching],
  );

  const ultrareviewTriggers = useMemo(
    () => (isUltrareviewEnabled() ? findUltrareviewTriggerPositions(displayedValue) : []),
    [displayedValue],
  );

  const btwTriggers = useMemo(() => findBtwTriggerPositions(displayedValue), [displayedValue]);

  const buddyTriggers = useMemo(() => findBuddyTriggerPositions(displayedValue), [displayedValue]);

  const slashCommandTriggers = useMemo(() => {
    const positions = findSlashCommandPositions(displayedValue);
    // 只高亮有效命令
    return positions.filter(pos => {
      const commandName = displayedValue.slice(pos.start + 1, pos.end); // +1 跳过 "/"
      return hasCommand(commandName, commands);
    });
  }, [displayedValue, commands]);

  const tokenBudgetTriggers = useMemo(
    () => (feature('TOKEN_BUDGET') ? findTokenBudgetPositions(displayedValue) : []),
    [displayedValue],
  );

  const knownChannelsVersion = useSyncExternalStore(subscribeKnownChannels, getKnownChannelsVersion);
  const slackChannelTriggers = useMemo(
    () => (hasSlackMcpServer(store.getState().mcp.clients) ? findSlackChannelPositions(displayedValue) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store 是稳定的 ref
    [displayedValue, knownChannelsVersion],
  );

  // 查找 @name 提及并用团队成员的颜色高亮显示
  const memberMentionHighlights = useMemo((): Array<{
    start: number;
    end: number;
    themeColor: keyof Theme;
  }> => {
    if (!isAgentSwarmsEnabled()) return [];
    if (!teamContext?.teammates) return [];

    const highlights: Array<{
      start: number;
      end: number;
      themeColor: keyof Theme;
    }> = [];
    const members = teamContext.teammates;
    if (!members) return highlights;

    // 在输入中查找所有 @name 模式
    const regex = /(^|\s)@([\w-]+)/g;
    const memberValues = Object.values(members);
    let match;
    while ((match = regex.exec(displayedValue)) !== null) {
      const leadingSpace = match[1] ?? '';
      const nameStart = match.index + leadingSpace.length;
      const fullMatch = match[0].trimStart();
      const name = match[2];

      // 检查该名称是否与团队成员匹配
      const member = memberValues.find(t => t.name === name);
      if (member?.color) {
        const themeColor = AGENT_COLOR_TO_THEME_COLOR[member.color as AgentColorName];
        if (themeColor) {
          highlights.push({
            start: nameStart,
            end: nameStart + fullMatch.length,
            themeColor,
          });
        }
      }
    }
    return highlights;
  }, [displayedValue, teamContext]);

  const imageRefPositions = useMemo(
    () =>
      parseReferences(displayedValue)
        .filter(r => r.match.startsWith('[Image'))
        .map(r => ({ start: r.index, end: r.index + r.match.length })),
    [displayedValue],
  );

  // chip.start 是「已选中」状态：反色的 chip 就是光标。
  // chip.end 保持普通位置，可以像其他字符一样将光标停在 `]` 之后。
  const cursorAtImageChip = imageRefPositions.some(r => r.start === cursorOffset);

  // 上/下移动或全屏点击可能将光标落在 chip 内部；
  // 吸附到较近的边界，使其永远无法逐字符编辑。
  useEffect(() => {
    const inside = imageRefPositions.find(r => cursorOffset > r.start && cursorOffset < r.end);
    if (inside) {
      const mid = (inside.start + inside.end) / 2;
      setCursorOffset(cursorOffset < mid ? inside.start : inside.end);
    }
  }, [cursorOffset, imageRefPositions, setCursorOffset]);

  const combinedHighlights = useMemo((): TextHighlight[] => {
    const highlights: TextHighlight[] = [];

    // 当光标位于 chip.start（「已选中」状态）时反色 [Image #N] chip，
    // 使退格删除操作在视觉上更直观。
    for (const ref of imageRefPositions) {
      if (cursorOffset === ref.start) {
        highlights.push({
          start: ref.start,
          end: ref.end,
          color: undefined,
          inverse: true,
          priority: 8,
        });
      }
    }

    if (isSearchingHistory && historyMatch && !historyFailedMatch) {
      highlights.push({
        start: cursorOffset,
        end: cursorOffset + historyQuery.length,
        color: 'warning',
        priority: 20,
      });
    }

    // 添加「btw」高亮（纯黄色）
    for (const trigger of btwTriggers) {
      highlights.push({
        start: trigger.start,
        end: trigger.end,
        color: 'warning',
        priority: 15,
      });
    }

    // 添加 /command 高亮（蓝色）
    for (const trigger of slashCommandTriggers) {
      highlights.push({
        start: trigger.start,
        end: trigger.end,
        color: 'suggestion',
        priority: 5,
      });
    }

    // 添加 token 预算高亮（蓝色）
    for (const trigger of tokenBudgetTriggers) {
      highlights.push({
        start: trigger.start,
        end: trigger.end,
        color: 'suggestion',
        priority: 5,
      });
    }

    for (const trigger of slackChannelTriggers) {
      highlights.push({
        start: trigger.start,
        end: trigger.end,
        color: 'suggestion',
        priority: 5,
      });
    }

    // 添加 @name 高亮，使用团队成员的颜色
    for (const mention of memberMentionHighlights) {
      highlights.push({
        start: mention.start,
        end: mention.end,
        color: mention.themeColor,
        priority: 5,
      });
    }

    // 使临时语音听写文本变暗
    if (voiceInterimRange) {
      highlights.push({
        start: voiceInterimRange.start,
        end: voiceInterimRange.end,
        color: undefined,
        dimColor: true,
        priority: 1,
      });
    }

    // 为 ultrathink 关键词添加彩虹高亮（逐字符循环颜色）
    if (isUltrathinkEnabled()) {
      for (const trigger of thinkTriggers) {
        for (let i = trigger.start; i < trigger.end; i++) {
          highlights.push({
            start: i,
            end: i + 1,
            color: getRainbowColor(i - trigger.start),
            shimmerColor: getRainbowColor(i - trigger.start, true),
            priority: 10,
          });
        }
      }
    }

    // 对 ultraplan 关键词应用相同的彩虹处理
    if (feature('ULTRAPLAN')) {
      for (const trigger of ultraplanTriggers) {
        for (let i = trigger.start; i < trigger.end; i++) {
          highlights.push({
            start: i,
            end: i + 1,
            color: getRainbowColor(i - trigger.start),
            shimmerColor: getRainbowColor(i - trigger.start, true),
            priority: 10,
          });
        }
      }
    }

    // 对 ultrareview 关键词应用相同的彩虹处理
    for (const trigger of ultrareviewTriggers) {
      for (let i = trigger.start; i < trigger.end; i++) {
        highlights.push({
          start: i,
          end: i + 1,
          color: getRainbowColor(i - trigger.start),
          shimmerColor: getRainbowColor(i - trigger.start, true),
          priority: 10,
        });
      }
    }

    // 为 /buddy 添加彩虹高亮
    for (const trigger of buddyTriggers) {
      for (let i = trigger.start; i < trigger.end; i++) {
        highlights.push({
          start: i,
          end: i + 1,
          color: getRainbowColor(i - trigger.start),
          shimmerColor: getRainbowColor(i - trigger.start, true),
          priority: 10,
        });
      }
    }

    return highlights;
  }, [
    isSearchingHistory,
    historyQuery,
    historyMatch,
    historyFailedMatch,
    cursorOffset,
    btwTriggers,
    imageRefPositions,
    memberMentionHighlights,
    slashCommandTriggers,
    tokenBudgetTriggers,
    slackChannelTriggers,
    displayedValue,
    voiceInterimRange,
    thinkTriggers,
    ultraplanTriggers,
    ultrareviewTriggers,
    buddyTriggers,
  ]);

  const { addNotification, removeNotification } = useNotifications();

  // 显示 ultrathink 通知
  useEffect(() => {
    if (thinkTriggers.length && isUltrathinkEnabled()) {
      addNotification({
        key: 'ultrathink-active',
        text: '本轮推理力度已设为最高',
        priority: 'immediate',
        timeoutMs: 5000,
      });
    } else {
      removeNotification('ultrathink-active');
    }
  }, [addNotification, removeNotification, thinkTriggers.length]);

  useEffect(() => {
    if (feature('ULTRAPLAN') && ultraplanTriggers.length) {
      addNotification({
        key: 'ultraplan-active',
        text: '此提示将在网页版 Claude Code 中启动 ultraplan 会话',
        priority: 'immediate',
        timeoutMs: 5000,
      });
    } else {
      removeNotification('ultraplan-active');
    }
  }, [addNotification, removeNotification, ultraplanTriggers.length]);

  useEffect(() => {
    if (isUltrareviewEnabled() && ultrareviewTriggers.length) {
      addNotification({
        key: 'ultrareview-active',
        text: 'Claude 完成后运行 /ultrareview，在云端审查这些变更',
        priority: 'immediate',
        timeoutMs: 5000,
      });
    }
  }, [addNotification, ultrareviewTriggers.length]);

  // 追踪输入长度，用于 stash 提示
  const prevInputLengthRef = useRef(input.length);
  const peakInputLengthRef = useRef(input.length);

  // 当用户进行任何输入变更时关闭 stash 提示
  const dismissStashHint = useCallback(() => {
    removeNotification('stash-hint');
  }, [removeNotification]);

  // 当用户逐渐清除大量输入时显示 stash 提示
  useEffect(() => {
    const prevLength = prevInputLengthRef.current;
    const peakLength = peakInputLengthRef.current;
    const currentLength = input.length;
    prevInputLengthRef.current = currentLength;

    // 输入增长时更新峰值
    if (currentLength > peakLength) {
      peakInputLengthRef.current = currentLength;
      return;
    }

    // 输入为空时重置状态
    if (currentLength === 0) {
      peakInputLengthRef.current = 0;
      return;
    }

    // 检测逐渐清除：峰值高，当前值低，但不是一次性大跳
    // （快速清除如 esc-esc 一步从 20+ 降到 0）
    const clearedSubstantialInput = peakLength >= 20 && currentLength <= 5;
    const wasRapidClear = prevLength >= 20 && currentLength <= 5;

    if (clearedSubstantialInput && !wasRapidClear) {
      const config = getGlobalConfig();
      if (!config.hasUsedStash) {
        addNotification({
          key: 'stash-hint',
          jsx: (
            <Text dimColor>
              提示：
              <ConfigurableShortcutHint action="chat:stash" context="Chat" fallback="ctrl+s" description="stash" />
            </Text>
          ),
          priority: 'immediate',
          timeoutMs: FOOTER_TEMPORARY_STATUS_TIMEOUT,
        });
      }
      peakInputLengthRef.current = currentLength;
    }
  }, [input.length, addNotification]);

  // 初始化输入缓冲区以实现撤销功能
  const { pushToBuffer, undo, canUndo, clearBuffer } = useInputBuffer({
    maxBufferSize: 50,
    debounceMs: 1000,
  });

  useMaybeTruncateInput({
    input,
    pastedContents,
    onInputChange: trackAndSetInput,
    setCursorOffset,
    setPastedContents,
  });

  const defaultPlaceholder = usePromptInputPlaceholder({
    input,
    submitCount,
    viewingAgentName,
  });

  const onChange = useCallback(
    (value: string) => {
      if (value === '?') {
        logEvent('tengu_help_toggled', {});
        setHelpOpen(v => !v);
        return;
      }
      setHelpOpen(false);

      // 当用户进行任何输入变更时关闭 stash 提示
      dismissStashHint();

      // 当用户输入时取消任何待处理的 prompt 建议和推测
      abortPromptSuggestion();
      abortSpeculation(setAppState);

      // 检查是否是在开头插入单个字符
      const isSingleCharInsertion = value.length === input.length + 1;
      const insertedAtStart = cursorOffset === 0;
      const mode = getModeFromInput(value);

      if (insertedAtStart && mode !== 'prompt') {
        if (isSingleCharInsertion) {
          onModeChange(mode);
          return;
        }
        // 向空输入插入多个字符（例如 tab 接受「! gcloud auth login」）
        if (input.length === 0) {
          onModeChange(mode);
          const valueWithoutMode = getValueFromInput(value).replaceAll('\t', '    ');
          pushToBuffer(input, cursorOffset, pastedContents);
          trackAndSetInput(valueWithoutMode);
          setCursorOffset(valueWithoutMode.length);
          return;
        }
      }

      const processedValue = value.replaceAll('\t', '    ');

      // 在进行更改之前将当前状态推入缓冲区
      if (input !== processedValue) {
        pushToBuffer(input, cursorOffset, pastedContents);
      }

      // 当用户输入时取消 footer 项的选中
      setAppState(prev => (prev.footerSelection === null ? prev : { ...prev, footerSelection: null }));

      trackAndSetInput(processedValue);
    },
    [trackAndSetInput, onModeChange, input, cursorOffset, pushToBuffer, pastedContents, dismissStashHint, setAppState],
  );

  const { resetHistory, onHistoryUp, onHistoryDown, dismissSearchHint, historyIndex } = useArrowKeyHistory(
    (value: string, historyMode: HistoryMode, pastedContents: Record<number, PastedContent>) => {
      onChange(value);
      onModeChange(historyMode);
      setPastedContents(pastedContents);
    },
    input,
    pastedContents,
    setCursorOffset,
    mode,
  );

  // 当用户开始搜索时关闭搜索提示
  useEffect(() => {
    if (isSearchingHistory) {
      dismissSearchHint();
    }
  }, [isSearchingHistory, dismissSearchHint]);

  // 仅在有 0 或 1 个斜杠命令建议时使用历史导航。
  // Footer 导航不在此处 —— 当徽章被选中时，TextInput focus=false，
  // 因此这些永远不会触发。Footer 快捷键上下文会处理 ↑/↓。
  function handleHistoryUp() {
    if (suggestions.length > 1) {
      return;
    }

    // 仅当光标在第一行时导航历史。
    // 在多行输入中，上箭头应移动光标（由 TextInput 处理），
    // 只有在输入顶部时才触发历史。
    if (!isCursorOnFirstLine) {
      return;
    }

    // 如果有可编辑的排队命令，按 UP 时将其移入输入框进行编辑
    const hasEditableCommand = queuedCommands.some(isQueuedCommandEditable);
    if (hasEditableCommand) {
      void popAllCommandsFromQueue();
      return;
    }

    onHistoryUp();
  }

  function handleHistoryDown() {
    if (suggestions.length > 1) {
      return;
    }

    // 仅当光标在最后一行时导航历史/footer。
    // 在多行输入中，下箭头应移动光标（由 TextInput 处理），
    // 只有在输入底部时才触发导航。
    if (!isCursorOnLastLine) {
      return;
    }

    // 到达历史底部 → 从第一个可见徽章进入 footer
    if (onHistoryDown() && footerItems.length > 0) {
      const first = footerItems[0]!;
      selectFooterItem(first);
      if (first === 'tasks' && !getGlobalConfig().hasSeenTasksHint) {
        saveGlobalConfig(c => (c.hasSeenTasksHint ? c : { ...c, hasSeenTasksHint: true }));
      }
    }
  }

  // 直接创建建议状态 —— 稍后与 useTypeahead 同步
  const [suggestionsState, setSuggestionsStateRaw] = useState<{
    suggestions: SuggestionItem[];
    selectedSuggestion: number;
    commandArgumentHint?: string;
  }>({
    suggestions: [],
    selectedSuggestion: -1,
    commandArgumentHint: undefined,
  });

  // 建议状态的 setter
  const setSuggestionsState = useCallback(
    (updater: typeof suggestionsState | ((prev: typeof suggestionsState) => typeof suggestionsState)) => {
      setSuggestionsStateRaw(prev => (typeof updater === 'function' ? updater(prev) : updater));
    },
    [],
  );

  const onSubmit = useCallback(
    async (inputParam: string, isSubmittingSlashCommand = false) => {
      inputParam = inputParam.trimEnd();

      // 如果 footer 指示器正在打开则不提交。从 store 读取最新值 ——
      // footer:openSelected 在同一 tick 中先调用 selectFooterItem(null) 再调用 onSubmit，
      // 此时闭包值尚未更新。应用与 footerItemSelected 相同的「仍然可见？」派生，
      // 避免过期选中（徽章消失）吞掉 Enter。
      const state = store.getState();
      if (state.footerSelection && footerItems.includes(state.footerSelection)) {
        return;
      }

      // 在选择模式中按 Enter 确认选择（useBackgroundTaskNavigation）。
      // BaseTextInput 的 useInput 在该 hook 之前注册（子 effects 先触发），
      // 因此没有此保护，Enter 会双重触发并自动提交建议。
      if (state.viewSelectionMode === 'selecting-agent') {
        return;
      }

      // 尽早检查图片 —— 下方的建议逻辑需要此信息
      const hasImages = Object.values(pastedContents).some(c => c.type === 'image');

      // 如果输入为空或与建议匹配，则提交它
      // 但如果附有图片，不要自动接受建议 ——
      // 用户希望只提交图片。
      // 仅在 leader 视图中 —— promptSuggestion 是 leader 上下文，而非团队成员。
      const suggestionText = promptSuggestionState.text;
      const inputMatchesSuggestion = inputParam.trim() === '' || inputParam === suggestionText;
      if (inputMatchesSuggestion && suggestionText && !hasImages && !state.viewingAgentTaskId) {
        // 如果推测处于活跃状态，在消息流式传输时立即注入
        if (speculation.status === 'active') {
          markAccepted();
          // skipReset：resetSuggestion 会在我们接受之前中止推测
          logOutcomeAtSubmission(suggestionText, { skipReset: true });

          void onSubmitProp(
            suggestionText,
            {
              setCursorOffset,
              clearBuffer,
              resetHistory,
            },
            {
              state: speculation,
              speculationSessionTimeSavedMs: speculationSessionTimeSavedMs,
              setAppState,
            },
          );
          return; // 跳过普通查询 —— 推测已处理
        }

        // 常规建议接受（要求 shownAt > 0）
        if (promptSuggestionState.shownAt > 0) {
          markAccepted();
          inputParam = suggestionText;
        }
      }

      // 处理 @name 直接消息
      if (isAgentSwarmsEnabled()) {
        const directMessage = parseDirectMemberMessage(inputParam);
        if (directMessage) {
          const result = await sendDirectMemberMessage(
            directMessage.recipientName,
            directMessage.message,
            teamContext,
            writeToMailbox,
          );

          if (result.success) {
            addNotification({
              key: 'direct-message-sent',
              text: `已发送给 @${result.recipientName}`,
              priority: 'immediate',
              timeoutMs: 3000,
            });
            trackAndSetInput('');
            setCursorOffset(0);
            clearBuffer();
            resetHistory();
            return;
          } else if (!result.success && (result as { error: string }).error === 'no_team_context') {
            // 没有团队上下文 —— 跳过，进行普通 prompt 提交
          } else {
            // 未知接收者 —— 跳过，进行普通 prompt 提交
            // 例如允许「@utils 解释这段代码」作为 prompt 发送
          }
        }
      }

      // 如果附有图片，即使没有文字也允许提交
      if (inputParam.trim() === '' && !hasImages) {
        return;
      }

      // PromptInput UX：检查建议下拉框是否显示
      // 对于目录建议，允许提交（Tab 用于补全）
      const hasDirectorySuggestions =
        suggestionsState.suggestions.length > 0 &&
        suggestionsState.suggestions.every(s => s.description === 'directory');

      if (suggestionsState.suggestions.length > 0 && !isSubmittingSlashCommand && !hasDirectorySuggestions) {
        logForDebugging(`[onSubmit] early return: suggestions showing (count=${suggestionsState.suggestions.length})`);
        return; // 不提交，用户需要先清除建议
      }

      // 如果存在建议，记录其结果
      if (promptSuggestionState.text && promptSuggestionState.shownAt > 0) {
        logOutcomeAtSubmission(inputParam);
      }

      // 提交时清除 stash 提示通知
      removeNotification('stash-hint');

      // 将输入路由到当前查看的 agent（进程内团队成员或命名的 local_agent）。
      const activeAgent = getActiveAgentForInput(store.getState());
      if (activeAgent.type !== 'leader' && onAgentSubmit) {
        logEvent('tengu_transcript_input_to_teammate', {});
        await onAgentSubmit(inputParam, activeAgent.task, {
          setCursorOffset,
          clearBuffer,
          resetHistory,
        });
        return;
      }

      // 普通 leader 提交
      await onSubmitProp(inputParam, {
        setCursorOffset,
        clearBuffer,
        resetHistory,
      });
    },
    [
      promptSuggestionState,
      speculation,
      speculationSessionTimeSavedMs,
      teamContext,
      store,
      footerItems,
      suggestionsState.suggestions,
      onSubmitProp,
      onAgentSubmit,
      clearBuffer,
      resetHistory,
      logOutcomeAtSubmission,
      setAppState,
      markAccepted,
      pastedContents,
      removeNotification,
    ],
  );

  const { suggestions, selectedSuggestion, commandArgumentHint, inlineGhostText, maxColumnWidth } = useTypeahead({
    commands,
    onInputChange: trackAndSetInput,
    onSubmit,
    setCursorOffset,
    input,
    cursorOffset,
    mode,
    agents,
    setSuggestionsState,
    suggestionsState,
    suppressSuggestions: isSearchingHistory || historyIndex > 0,
    markAccepted,
    onModeChange,
  });

  // 追踪是否应显示 prompt 建议（稍后根据终端宽度计算）。
  // 在团队成员视图中隐藏 —— 建议仅属于 leader 上下文。
  const showPromptSuggestion = mode === 'prompt' && suggestions.length === 0 && promptSuggestion && !viewingAgentTaskId;
  if (showPromptSuggestion) {
    markShown();
  }

  // 如果建议已生成但因时机原因无法显示，记录抑制。
  // 排除团队成员视图：markShown() 在上方受控，因此那里 shownAt 保持为 0 ——
  // 但这不是时机失败，返回 leader 时建议仍然有效。
  if (promptSuggestionState.text && !promptSuggestion && promptSuggestionState.shownAt === 0 && !viewingAgentTaskId) {
    logSuggestionSuppressed('timing', promptSuggestionState.text);
    setAppState(prev => ({
      ...prev,
      promptSuggestion: {
        text: null,
        promptId: null,
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: null,
      },
    }));
  }

  function onImagePaste(
    image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) {
    logEvent('tengu_paste_image', {});
    onModeChange('prompt');

    const pasteId = nextPasteIdRef.current++;

    const newContent: PastedContent = {
      id: pasteId,
      type: 'image',
      content: image,
      mediaType: mediaType || 'image/png', // 未提供时默认为 PNG
      filename: filename || 'Pasted image',
      dimensions,
      sourcePath,
    };

    // 立即缓存路径（快速）以便渲染时链接有效
    cacheImagePath(newContent);

    // 在后台将图片存储到磁盘
    void storeImage(newContent);

    // 更新 UI
    setPastedContents(prev => ({ ...prev, [pasteId]: newContent }));
    // 多图粘贴在循环中调用 onImagePaste。如果 ref 已触发，
    // 前一个徽章的懒空格会在此时（在本徽章之前）触发，而不是丢失。
    const prefix = pendingSpaceAfterPillRef.current ? ' ' : '';
    insertTextAtCursor(prefix + formatImageRef(pasteId));
    pendingSpaceAfterPillRef.current = true;
  }

  // 清理 [Image #N] 占位符不再出现在输入文本中的图片。
  // 涵盖徽章退格、Ctrl+U、逐字符删除 —— 任何删除引用的编辑。
  // onImagePaste 在同一事件中批量处理 setPastedContents + insertTextAtCursor，
  // 因此此 effect 看到占位符已存在。
  useEffect(() => {
    const referencedIds = new Set(parseReferences(input).map(r => r.id));
    setPastedContents(prev => {
      const orphaned = Object.values(prev).filter(c => c.type === 'image' && !referencedIds.has(c.id));
      if (orphaned.length === 0) return prev;
      const next = { ...prev };
      for (const img of orphaned) delete next[img.id];
      return next;
    });
  }, [input, setPastedContents]);

  function onTextPaste(rawText: string) {
    pendingSpaceAfterPillRef.current = false;
    // 清理粘贴的文本 —— 去除 ANSI 转义码，规范化行尾和制表符
    let text = stripAnsi(rawText).replace(/\r/g, '\n').replaceAll('\t', '    ');

    // 匹配手动输入/自动建议：将 `!cmd` 粘贴到空输入中时进入 bash 模式。
    if (input.length === 0) {
      const pastedMode = getModeFromInput(text);
      if (pastedMode !== 'prompt') {
        onModeChange(pastedMode);
        text = getValueFromInput(text);
      }
    }

    const numLines = getPastedTextRefNumLines(text);
    // 限制输入中显示的行数
    // 如果整体布局过高，Ink 会重绘整个终端。
    // 实际所需高度取决于内容，这只是估算值。
    const maxLines = Math.min(rows - 10, 2);

    // 对较长的粘贴文本（>PASTE_THRESHOLD 字符）或超过显示行数的文本使用特殊处理
    if (text.length > PASTE_THRESHOLD || numLines > maxLines) {
      const pasteId = nextPasteIdRef.current++;

      const newContent: PastedContent = {
        id: pasteId,
        type: 'text',
        content: text,
      };

      setPastedContents(prev => ({ ...prev, [pasteId]: newContent }));

      insertTextAtCursor(formatPastedTextRef(pasteId, numLines));
    } else {
      // 对较短的粘贴内容，直接正常插入文本
      insertTextAtCursor(text);
    }
  }

  const lazySpaceInputFilter = useCallback((input: string, key: Key): string => {
    if (!pendingSpaceAfterPillRef.current) return input;
    pendingSpaceAfterPillRef.current = false;
    if (isNonSpacePrintable(input, key)) return ' ' + input;
    return input;
  }, []);

  function insertTextAtCursor(text: string) {
    // 插入前将当前状态推入缓冲区
    pushToBuffer(input, cursorOffset, pastedContents);

    const newInput = input.slice(0, cursorOffset) + text + input.slice(cursorOffset);
    trackAndSetInput(newInput);
    setCursorOffset(cursorOffset + text.length);
  }

  const doublePressEscFromEmpty = useDoublePress(
    () => {},
    () => onShowMessageSelector(),
  );

  // 获取排队命令以供编辑的函数。如果命令被弹出则返回 true。
  const popAllCommandsFromQueue = useCallback((): boolean => {
    const result = popAllEditable(input, cursorOffset);
    if (!result) {
      return false;
    }

    trackAndSetInput(result.text);
    onModeChange('prompt'); // 排队命令始终使用 prompt 模式
    setCursorOffset(result.cursorOffset);

    // 将排队命令中的图片恢复到 pastedContents
    if (result.images.length > 0) {
      setPastedContents(prev => {
        const newContents = { ...prev };
        for (const image of result.images) {
          newContents[image.id] = image;
        }
        return newContents;
      });
    }

    return true;
  }, [trackAndSetInput, onModeChange, input, cursorOffset, setPastedContents]);

  // 当收到 IDE 的 at-mention 通知时，插入 at-mention 引用（文件及可选的行范围）。
  const onIdeAtMentioned = function (atMentioned: IDEAtMentioned) {
    logEvent('tengu_ext_at_mentioned', {});
    let atMentionedText: string;
    const relativePath = path.relative(getCwd(), atMentioned.filePath);
    if (atMentioned.lineStart && atMentioned.lineEnd) {
      atMentionedText =
        atMentioned.lineStart === atMentioned.lineEnd
          ? `@${relativePath}#L${atMentioned.lineStart} `
          : `@${relativePath}#L${atMentioned.lineStart}-${atMentioned.lineEnd} `;
    } else {
      atMentionedText = `@${relativePath} `;
    }
    const cursorChar = input[cursorOffset - 1] ?? ' ';
    if (!/\s/.test(cursorChar)) {
      atMentionedText = ` ${atMentionedText}`;
    }
    insertTextAtCursor(atMentionedText);
  };
  useIdeAtMentioned(mcpClients, onIdeAtMentioned);

  // chat:undo 的处理器 —— 撤销最后一次编辑
  const handleUndo = useCallback(() => {
    if (canUndo) {
      const previousState = undo();
      if (previousState) {
        trackAndSetInput(previousState.text);
        setCursorOffset(previousState.cursorOffset);
        setPastedContents(previousState.pastedContents);
      }
    }
  }, [canUndo, undo, trackAndSetInput, setPastedContents]);

  // chat:newline 的处理器 —— 在光标位置插入换行符
  const handleNewline = useCallback(() => {
    pushToBuffer(input, cursorOffset, pastedContents);
    const newInput = input.slice(0, cursorOffset) + '\n' + input.slice(cursorOffset);
    trackAndSetInput(newInput);
    setCursorOffset(cursorOffset + 1);
  }, [input, cursorOffset, trackAndSetInput, setCursorOffset, pushToBuffer, pastedContents]);

  // chat:externalEditor 的处理器 —— 在 $EDITOR 中编辑
  const handleExternalEditor = useCallback(async () => {
    logEvent('tengu_external_editor_used', {});
    setIsExternalEditorActive(true);

    try {
      // 传递 pastedContents 以展开折叠的文本引用
      const result = await editPromptInEditor(input, pastedContents);

      if (result.error) {
        addNotification({
          key: 'external-editor-error',
          text: result.error,
          color: 'warning',
          priority: 'high',
        });
      }

      if (result.content !== null && result.content !== input) {
        // 在进行更改之前将当前状态推入缓冲区
        pushToBuffer(input, cursorOffset, pastedContents);

        trackAndSetInput(result.content);
        setCursorOffset(result.content.length);
      }
    } catch (err) {
      if (err instanceof Error) {
        logError(err);
      }
      addNotification({
        key: 'external-editor-error',
        text: `外部编辑器失败：${errorMessage(err)}`,
        color: 'warning',
        priority: 'high',
      });
    } finally {
      setIsExternalEditorActive(false);
    }
  }, [input, cursorOffset, pastedContents, pushToBuffer, trackAndSetInput, addNotification]);

  // chat:stash 的处理器 —— 储藏/取出 prompt
  const handleStash = useCallback(() => {
    if (input.trim() === '' && stashedPrompt !== undefined) {
      // 输入为空时取出储藏
      trackAndSetInput(stashedPrompt.text);
      setCursorOffset(stashedPrompt.cursorOffset);
      setPastedContents(stashedPrompt.pastedContents);
      setStashedPrompt(undefined);
    } else if (input.trim() !== '') {
      // 推入储藏（保存文本、光标位置和粘贴内容）
      setStashedPrompt({ text: input, cursorOffset, pastedContents });
      trackAndSetInput('');
      setCursorOffset(0);
      setPastedContents({});
      // 为 /discover 追踪使用情况并停止显示提示
      saveGlobalConfig(c => {
        if (c.hasUsedStash) return c;
        return { ...c, hasUsedStash: true };
      });
    }
  }, [input, cursorOffset, stashedPrompt, trackAndSetInput, setStashedPrompt, pastedContents, setPastedContents]);

  // chat:modelPicker 的处理器 —— 切换模型选择器
  const handleModelPicker = useCallback(() => {
    setShowModelPicker(prev => !prev);
    if (helpOpen) {
      setHelpOpen(false);
    }
  }, [helpOpen]);

  // chat:fastMode 的处理器 —— 切换快速模式选择器
  const handleFastModePicker = useCallback(() => {
    setShowFastModePicker(prev => !prev);
    if (helpOpen) {
      setHelpOpen(false);
    }
  }, [helpOpen]);

  // chat:thinkingToggle 的处理器 —— 切换思考模式
  const handleThinkingToggle = useCallback(() => {
    setShowThinkingToggle(prev => !prev);
    if (helpOpen) {
      setHelpOpen(false);
    }
  }, [helpOpen]);

  // chat:cycleMode 的处理器 —— 循环切换权限模式
  const handleCycleMode = useCallback(() => {
    // 查看团队成员时，循环其模式而非 leader 的
    if (isAgentSwarmsEnabled() && viewedTeammate && viewingAgentTaskId) {
      const teammateContext: ToolPermissionContext = {
        ...toolPermissionContext,
        mode: viewedTeammate.permissionMode,
      };
      // 传递 undefined 给 teamContext（未使用但保留以兼容 API）
      const nextMode = getNextPermissionMode(teammateContext, undefined);

      logEvent('tengu_mode_cycle', {
        to: nextMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });

      const teammateTaskId = viewingAgentTaskId;
      setAppState(prev => {
        const task = prev.tasks[teammateTaskId];
        if (!task || task.type !== 'in_process_teammate') {
          return prev;
        }
        if (task.permissionMode === nextMode) {
          return prev;
        }
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [teammateTaskId]: {
              ...task,
              permissionMode: nextMode,
            },
          },
        };
      });

      if (helpOpen) {
        setHelpOpen(false);
      }
      return;
    }

    // 先计算下一个模式而不触发副作用
    logForDebugging(`[auto-mode] handleCycleMode: currentMode=${toolPermissionContext.mode}`);
    const nextMode = getNextPermissionMode(toolPermissionContext, teamContext);

    // 调用 cyclePermissionMode 以应用副作用（如剥离危险权限、激活分类器）
    const { context: preparedContext } = cyclePermissionMode(toolPermissionContext, teamContext);

    logEvent('tengu_mode_cycle', {
      to: nextMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });

    // 追踪用户进入计划模式的时间
    if (nextMode === 'plan') {
      saveGlobalConfig(current => ({
        ...current,
        lastPlanModeUse: Date.now(),
      }));
    }

    // 直接通过 setAppState 设置模式，因为 setToolPermissionContext
    // 刻意保留现有模式（防止 worker 导致协调者模式损坏）。
    // 然后调用 setToolPermissionContext 触发排队权限提示的重新检查。
    setAppState(prev => ({
      ...prev,
      toolPermissionContext: {
        ...preparedContext,
        mode: nextMode,
      },
    }));
    setToolPermissionContext({
      ...preparedContext,
      mode: nextMode,
    });

    // 如果这是团队成员，更新 config.json 让团队 leader 看到变更
    syncTeammateMode(nextMode, teamContext?.teamName);

    // 循环切换模式时若帮助提示开着则关闭
    if (helpOpen) {
      setHelpOpen(false);
    }
  }, [toolPermissionContext, teamContext, viewedTeammate, setAppState, setToolPermissionContext, helpOpen]);

  // chat:imagePaste 的处理器 —— 从剪贴板粘贴图片
  const handleImagePaste = useCallback(() => {
    void getImageFromClipboard().then(imageData => {
      if (imageData) {
        onImagePaste(imageData.base64, imageData.mediaType);
      } else {
        const shortcutDisplay = getShortcutDisplay('chat:imagePaste', 'Chat', 'ctrl+v');
        const message = env.isSSH()
          ? '剪贴板中没有找到图片。您正在使用 SSH，请尝试 scp？'
          : `剪贴板中没有找到图片。请使用 ${shortcutDisplay} 粘贴图片。`;
        addNotification({
          key: 'no-image-in-clipboard',
          text: message,
          priority: 'immediate',
          timeoutMs: 1000,
        });
      }
    });
  }, [addNotification, onImagePaste]);

  // 直接在处理器注册表中注册 chat:submit（而非通过 useKeybindings），
  // 使只有 ChordInterceptor 可以在和弦补全（如 "ctrl+e s"）时调用它。
  // 提交的默认 Enter 绑定由 TextInput 直接处理（通过 onSubmit prop），
  // 以及 useTypeahead（用于自动补全接受）。
  // 若使用 useKeybindings 会导致 Enter 触发 stopImmediatePropagation，
  // 阻止自动补全看到该按键。
  const keybindingContext = useOptionalKeybindingContext();
  useEffect(() => {
    if (!keybindingContext || isModalOverlayActive) return;
    return keybindingContext.registerHandler({
      action: 'chat:submit',
      context: 'Chat',
      handler: () => {
        void onSubmit(input);
      },
    });
  }, [keybindingContext, isModalOverlayActive, onSubmit, input]);

  // Chat 上下文的编辑快捷键绑定
  // 注意：history:previous/history:next 不在此处处理。它们作为
  // onHistoryUp/onHistoryDown prop 传递给 TextInput，使 useTextInput 的
  // upOrHistoryUp/downOrHistoryDown 可以先尝试移动光标，
  // 仅当光标无法继续移动时才回退到历史导航。
  const chatHandlers = useMemo(
    () => ({
      'chat:undo': handleUndo,
      'chat:newline': handleNewline,
      'chat:externalEditor': handleExternalEditor,
      'chat:stash': handleStash,
      'chat:modelPicker': handleModelPicker,
      'chat:thinkingToggle': handleThinkingToggle,
      'chat:cycleMode': handleCycleMode,
      'chat:imagePaste': handleImagePaste,
    }),
    [
      handleUndo,
      handleNewline,
      handleExternalEditor,
      handleStash,
      handleModelPicker,
      handleThinkingToggle,
      handleCycleMode,
      handleImagePaste,
    ],
  );

  useKeybindings(chatHandlers, {
    context: 'Chat',
    isActive: !isModalOverlayActive,
  });

  // Shift+↑ 进入消息操作光标。单独设置 isActive，使 ctrl+r 搜索
  // 不会在光标退出重挂载时留下过期的 isSearchingHistory。
  useKeybinding('chat:messageActions', () => onMessageActionsEnter?.(), {
    context: 'Chat',
    isActive: !isModalOverlayActive && !isSearchingHistory,
  });

  // 快速模式快捷键仅在快速模式已启用且可用时激活
  useKeybinding('chat:fastMode', handleFastModePicker, {
    context: 'Chat',
    isActive: !isModalOverlayActive && isFastModeEnabled() && isFastModeAvailable(),
  });

  // 处理 help:dismiss 快捷键（ESC 关闭帮助菜单）
  // 独立于 Chat 上下文注册，使其在帮助菜单打开时优先于 CancelRequestHandler
  useKeybinding(
    'help:dismiss',
    () => {
      setHelpOpen(false);
    },
    { context: 'Help', isActive: helpOpen },
  );

  // 快速打开 / 全局搜索。Hook 调用无条件执行（Hooks 规则）；
  // 处理器主体由 feature() 门控，使 setState 调用和组件引用
  // 在外部构建中被 tree-shake 掉。
  const quickSearchActive = feature('QUICK_SEARCH') ? !isModalOverlayActive : false;
  useKeybinding(
    'app:quickOpen',
    () => {
      if (feature('QUICK_SEARCH')) {
        setShowQuickOpen(true);
        setHelpOpen(false);
      }
    },
    { context: 'Global', isActive: quickSearchActive },
  );
  useKeybinding(
    'app:globalSearch',
    () => {
      if (feature('QUICK_SEARCH')) {
        setShowGlobalSearch(true);
        setHelpOpen(false);
      }
    },
    { context: 'Global', isActive: quickSearchActive },
  );

  useKeybinding(
    'history:search',
    () => {
      if (feature('HISTORY_PICKER')) {
        setShowHistoryPicker(true);
        setHelpOpen(false);
      }
    },
    {
      context: 'Global',
      isActive: feature('HISTORY_PICKER') ? !isModalOverlayActive : false,
    },
  );

  // 处理空闲时（非加载中）Ctrl+C 中止推测
  // CancelRequestHandler 仅在有活跃任务时处理 Ctrl+C
  useKeybinding(
    'app:interrupt',
    () => {
      abortSpeculation(setAppState);
    },
    {
      context: 'Global',
      isActive: !isLoading && speculation.status === 'active',
    },
  );

  // Footer 徽章导航快捷键。↑/↓ 在此处（而非 handleHistoryUp/Down）处理，
  // 因为徽章被选中时 TextInput focus=false，其 useInput 不活跃，
  // 所以这是唯一的路径。
  useKeybindings(
    {
      'footer:up': () => {
        // ↑ 在 bg_agent 徽章中：向上移动选中（-1 = 主视图）。在 -1 时离开徽章。
        if (bgAgentSelected) {
          if (selectedBgAgentIndex > -1) {
            setSelectedBgAgentIndex(prev => prev - 1);
          } else {
            selectFooterItem(null);
          }
          return;
        }
        // ↑ 在离开徽章之前在协调者任务列表中向上滚动
        if (
          tasksSelected &&
          process.env.USER_TYPE === 'ant' &&
          coordinatorTaskCount > 0 &&
          coordinatorTaskIndex > minCoordinatorIndex
        ) {
          setCoordinatorTaskIndex(prev => prev - 1);
          return;
        }
        navigateFooter(-1, true);
      },
      'footer:down': () => {
        // ↓ 在 bg_agent 徽章中：向下移动选中遍历 agent 列表，钳位到最后一个。
        if (bgAgentSelected) {
          if (selectedBgAgentIndex < bgAgentList.length - 1) {
            setSelectedBgAgentIndex(prev => prev + 1);
          }
          return;
        }
        // ↓ 在协调者任务列表中向下滚动，永远不会离开徽章
        if (tasksSelected && process.env.USER_TYPE === 'ant' && coordinatorTaskCount > 0) {
          if (coordinatorTaskIndex < coordinatorTaskCount - 1) {
            setCoordinatorTaskIndex(prev => prev + 1);
          }
          return;
        }
        if (tasksSelected && !isTeammateMode) {
          setShowBashesDialog(true);
          selectFooterItem(null);
          return;
        }
        navigateFooter(1);
      },
      'footer:next': () => {
        // 团队成员模式：←/→ 在团队成员列表中循环
        if (tasksSelected && isTeammateMode) {
          const totalAgents = 1 + inProcessTeammates.length;
          setTeammateFooterIndex(prev => (prev + 1) % totalAgents);
          return;
        }
        navigateFooter(1);
      },
      'footer:previous': () => {
        if (tasksSelected && isTeammateMode) {
          const totalAgents = 1 + inProcessTeammates.length;
          setTeammateFooterIndex(prev => (prev - 1 + totalAgents) % totalAgents);
          return;
        }
        navigateFooter(-1);
      },
      'footer:openSelected': () => {
        if (viewSelectionMode === 'selecting-agent') {
          return;
        }
        switch (footerItemSelected) {
          case 'companion':
            if (feature('BUDDY')) {
              selectFooterItem(null);
              void onSubmit('/buddy');
            }
            break;
          case 'tasks':
            if (isTeammateMode) {
              // Enter 切换到选中 agent 的视图
              if (teammateFooterIndex === 0) {
                exitTeammateView(setAppState);
              } else {
                const teammate = inProcessTeammates[teammateFooterIndex - 1];
                if (teammate) enterTeammateView(teammate.id, setAppState);
              }
            } else if (coordinatorTaskIndex === 0 && coordinatorTaskCount > 0) {
              exitTeammateView(setAppState);
            } else {
              const selectedTaskId = getVisibleAgentTasks(tasks)[coordinatorTaskIndex - 1]?.id;
              if (selectedTaskId) {
                enterTeammateView(selectedTaskId, setAppState);
              } else {
                setShowBashesDialog(true);
                selectFooterItem(null);
              }
            }
            break;
          case 'tmux':
            if (process.env.USER_TYPE === 'ant') {
              setAppState(prev =>
                prev.tungstenPanelAutoHidden
                  ? { ...prev, tungstenPanelAutoHidden: false }
                  : {
                      ...prev,
                      tungstenPanelVisible: !(prev.tungstenPanelVisible ?? true),
                    },
              );
            }
            break;
          case 'bagel':
            break;
          case 'teams':
            setShowTeamsDialog(true);
            selectFooterItem(null);
            break;
          case 'bridge':
            setShowBridgeDialog(true);
            selectFooterItem(null);
            break;
          case 'bg_agent':
            if (selectedBgAgentIndex === -1) {
              exitTeammateView(setAppState);
            } else {
              const picked = bgAgentList[selectedBgAgentIndex];
              if (picked) enterTeammateView(picked.agentId, setAppState);
            }
            // 保持徽章聚焦，使 Enter 之后 ↑/↓ 继续有效。
            break;
        }
      },
      'footer:clearSelection': () => {
        selectFooterItem(null);
      },
      'footer:close': () => {
        if (tasksSelected && coordinatorTaskIndex >= 1) {
          const task = getVisibleAgentTasks(tasks)[coordinatorTaskIndex - 1];
          if (!task) return false;
          // 当选中行就是当前查看的 agent 时，'x' 输入到引导输入框中。
          // 任何其他行 —— 关闭它。
          if (viewSelectionMode === 'viewing-agent' && task.id === viewingAgentTaskId) {
            onChange(input.slice(0, cursorOffset) + 'x' + input.slice(cursorOffset));
            setCursorOffset(cursorOffset + 1);
            return;
          }
          stopOrDismissAgent(task.id, setAppState);
          if (task.status !== 'running') {
            setCoordinatorTaskIndex(i => Math.max(minCoordinatorIndex, i - 1));
          }
          return;
        }
        // 未处理 —— 让 'x' 透传到「输入字符退出 footer」逻辑
        return false;
      },
    },
    {
      context: 'Footer',
      isActive: !!footerItemSelected && !isModalOverlayActive,
    },
  );

  useInput((char, key) => {
    // 全屏对话框打开时跳过所有输入处理。这些对话框通过 early return 渲染，
    // 但 hook 无条件运行 —— 没有此保护，对话框内的 Escape 会泄漏到
    // 双击消息选择器。
    if (showTeamsDialog || showQuickOpen || showGlobalSearch || showHistoryPicker) {
      return;
    }

    // 检测 macOS 上失败的 Alt 快捷键（Option 键会产生特殊字符）
    if (getPlatform() === 'macos' && isMacosOptionChar(char)) {
      const shortcut = MACOS_OPTION_SPECIAL_CHARS[char];
      const terminalName = getNativeCSIuTerminalDisplayName();
      const jsx = terminalName ? (
        <Text dimColor>
          要启用 {shortcut}，请在 {terminalName} 偏好设置 (⌘,) 中设置 <Text bold>Option as Meta</Text>
        </Text>
      ) : (
        <Text dimColor>要启用 {shortcut}，请运行 /terminal-setup</Text>
      );
      addNotification({
        key: 'option-meta-hint',
        jsx,
        priority: 'immediate',
        timeoutMs: 5000,
      });
      // 不要 return —— 让字符被输入，使用户能看到问题所在
    }

    // Footer 导航由上方的 useKeybindings（Footer 上下文）处理

    // 注意：ctrl+_、ctrl+g、ctrl+s 由上方 Chat 上下文快捷键处理

    // 输入字符退出 footer：徽章被选中时输入可打印字符会重新聚焦
    // 输入框并输入该字符。导航键已被上方 useKeybindings 捕获，
    // 到达此处的都确实不是 footer 操作。
    // onChange 会清除 footerSelection，无需显式取消选中。
    if (footerItemSelected && char && !key.ctrl && !key.meta && !key.escape && !key.return) {
      onChange(input.slice(0, cursorOffset) + char + input.slice(cursorOffset));
      setCursorOffset(cursorOffset + char.length);
      return;
    }

    // 在光标位置 0 按下 backspace/escape/delete/ctrl+u 时退出特殊模式
    if (cursorOffset === 0 && (key.escape || key.backspace || key.delete || (key.ctrl && char === 'u'))) {
      onModeChange('prompt');
      setHelpOpen(false);
    }

    // 输入为空时按下 backspace 退出帮助模式
    if (helpOpen && input === '' && (key.backspace || key.delete)) {
      setHelpOpen(false);
    }

    // esc 键有多种用途：
    // - 正在加载响应时：取消请求
    // - 其他情况：显示消息选择器
    // - 双击时：清除输入
    // - 输入为空时：从命令队列弹出

    // 处理 ESC 按键
    if (key.escape) {
      // 中止活跃的推测
      if (speculation.status === 'active') {
        abortSpeculation(setAppState);
        return;
      }

      // 若侧边问题响应可见则关闭它
      if (isSideQuestionVisible && onDismissSideQuestion) {
        onDismissSideQuestion();
        return;
      }

      // 若帮助菜单开着则关闭
      if (helpOpen) {
        setHelpOpen(false);
        return;
      }

      // Footer 选中清除现在由 Footer 上下文快捷键处理
      // （footer:clearSelection 操作绑定到 escape）
      // 如果有 footer 项被选中，让 Footer 快捷键处理它
      if (footerItemSelected) {
        return;
      }

      // 如果存在可编辑的排队命令，按 ESC 时将其移入输入框进行编辑
      const hasEditableCommand = queuedCommands.some(isQueuedCommandEditable);
      if (hasEditableCommand) {
        void popAllCommandsFromQueue();
        return;
      }

      if (messages.length > 0 && !input && !isLoading) {
        doublePressEscFromEmpty();
      }
    }

    if (key.return && helpOpen) {
      setHelpOpen(false);
    }
  });

  const swarmBanner = useSwarmBanner();

  const fastModeCooldown = isFastModeEnabled() ? isFastModeCooldown() : false;
  const showFastIcon = isFastModeEnabled() ? isFastMode && (isFastModeAvailable() || fastModeCooldown) : false;

  const showFastIconHint = useShowFastIconHint(showFastIcon ?? false);

  // 启动时及 effort 变更时显示通知。
  // 在简报/助手模式下抑制 —— 该值反映的是本地客户端的 effort，
  // 而非连接的 agent 的。
  const effortNotificationText = briefOwnsGap ? undefined : getEffortNotificationText(effortValue, mainLoopModel);
  useEffect(() => {
    if (!effortNotificationText) {
      removeNotification('effort-level');
      return;
    }
    addNotification({
      key: 'effort-level',
      text: effortNotificationText,
      priority: 'high',
      timeoutMs: 12_000,
    });
  }, [effortNotificationText, addNotification, removeNotification]);

  useBuddyNotification();

  const companionReactionState = useAppState(s => s.companionReaction);
  const companionSpeaking = feature('BUDDY') ? companionReactionState !== undefined : false;
  const { columns, rows } = useTerminalSize();
  const textInputColumns = columns - 3 - companionReservedColumns(columns, companionSpeaking);

  // POC：点击定位光标。鼠标追踪仅在 <AlternateScreen> 内启用，
  // 因此在普通主屏幕 REPL 中此功能处于休眠状态。
  // localCol/localRow 相对于 onClick Box 的左上角；Box 紧贴文本输入，
  // 因此它们直接映射到 Cursor 换行模型中的（列, 行）。
  // MeasuredText.getOffsetFromPosition 处理宽字符、换行，
  // 并将超出末尾的点击钳位到行尾。
  const maxVisibleLines = isFullscreenEnvEnabled()
    ? Math.max(MIN_INPUT_VIEWPORT_LINES, Math.floor(rows / 2) - PROMPT_FOOTER_LINES)
    : undefined;

  const handleInputClick = useCallback(
    (e: ClickEvent) => {
      // 历史搜索期间显示的是 historyMatch 而非 input，
      // 且 showCursor 本就是 false —— 跳过，不要针对错误字符串计算偏移量。
      if (!input || isSearchingHistory) return;
      const c = Cursor.fromText(input, textInputColumns, cursorOffset);
      const viewportStart = c.getViewportStartLine(maxVisibleLines);
      const offset = c.measuredText.getOffsetFromPosition({
        line: e.localRow + viewportStart,
        column: e.localCol,
      });
      setCursorOffset(offset);
    },
    [input, textInputColumns, isSearchingHistory, cursorOffset, maxVisibleLines],
  );

  const handleOpenTasksDialog = useCallback(
    (taskId?: string) => setShowBashesDialog(taskId ?? true),
    [setShowBashesDialog],
  );

  const placeholder = showPromptSuggestion && promptSuggestion ? promptSuggestion : defaultPlaceholder;

  // 计算输入是否包含多行
  const isInputWrapped = useMemo(() => input.includes('\n'), [input]);

  // 模型选择器的 memoized 回调，防止无关状态（如通知）变更时触发重渲染，
  // 避免内联模型选择器在通知到来时视觉上「跳动」。
  const handleModelSelect = useCallback(
    (model: string | null, _effort: EffortLevel | undefined) => {
      let wasFastModeDisabled = false;
      setAppState(prev => {
        wasFastModeDisabled = isFastModeEnabled() && !isFastModeSupportedByModel(model) && !!prev.fastMode;
        return {
          ...prev,
          mainLoopModel: model,
          mainLoopModelForSession: null,
          // Turn off fast mode if switching to a model that doesn't support it
          ...(wasFastModeDisabled && { fastMode: false }),
        };
      });
      setShowModelPicker(false);
      const effectiveFastMode = (isFastMode ?? false) && !wasFastModeDisabled;
      let message = `模型已切换为 ${modelDisplayString(model)}`;
      if (isBilledAsExtraUsage(model, effectiveFastMode, isOpus1mMergeEnabled())) {
        message += ' · 按额外用量计费';
      }
      if (wasFastModeDisabled) {
        message += ' · 快速模式已关闭';
      }
      addNotification({
        key: 'model-switched',
        jsx: <Text>{message}</Text>,
        priority: 'immediate',
        timeoutMs: 3000,
      });
      logEvent('tengu_model_picker_hotkey', {
        model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
    },
    [setAppState, addNotification, isFastMode],
  );

  const handleModelCancel = useCallback(() => {
    setShowModelPicker(false);
  }, []);

  // memoize 模型选择器元素，防止 AppState 因无关原因（如通知到来）变更时触发不必要的重渲染
  const modelPickerElement = useMemo(() => {
    if (!showModelPicker) return null;
    return (
      <Box flexDirection="column" marginTop={1}>
        <ModelPicker
          initial={mainLoopModel_}
          sessionModel={mainLoopModelForSession}
          onSelect={handleModelSelect}
          onCancel={handleModelCancel}
          isStandaloneCommand
          showFastModeNotice={
            isFastModeEnabled() && isFastMode && isFastModeSupportedByModel(mainLoopModel_) && isFastModeAvailable()
          }
        />
      </Box>
    );
  }, [showModelPicker, mainLoopModel_, mainLoopModelForSession, handleModelSelect, handleModelCancel]);

  const handleFastModeSelect = useCallback(
    (result?: string) => {
      setShowFastModePicker(false);
      if (result) {
        addNotification({
          key: 'fast-mode-toggled',
          jsx: <Text>{result}</Text>,
          priority: 'immediate',
          timeoutMs: 3000,
        });
      }
    },
    [addNotification],
  );

  // memoize 快速模式选择器元素
  const fastModePickerElement = useMemo(() => {
    if (!showFastModePicker) return null;
    return (
      <Box flexDirection="column" marginTop={1}>
        <FastModePicker onDone={handleFastModeSelect} unavailableReason={getFastModeUnavailableReason()} />
      </Box>
    );
  }, [showFastModePicker, handleFastModeSelect]);

  // 思考开关的 memoized 回调
  const handleThinkingSelect = useCallback(
    (enabled: boolean) => {
      setAppState(prev => ({
        ...prev,
        thinkingEnabled: enabled,
      }));
      setShowThinkingToggle(false);
      logEvent('tengu_thinking_toggled_hotkey', { enabled });
      addNotification({
        key: 'thinking-toggled-hotkey',
        jsx: (
          <Text color={enabled ? 'suggestion' : undefined} dimColor={!enabled}>
            思考模式{enabled ? '已开启' : '已关闭'}
          </Text>
        ),
        priority: 'immediate',
        timeoutMs: 3000,
      });
    },
    [setAppState, addNotification],
  );

  const handleThinkingCancel = useCallback(() => {
    setShowThinkingToggle(false);
  }, []);

  // memoize 思考开关元素
  const thinkingToggleElement = useMemo(() => {
    if (!showThinkingToggle) return null;
    return (
      <Box flexDirection="column" marginTop={1}>
        <ThinkingToggle
          currentValue={thinkingEnabled ?? true}
          onSelect={handleThinkingSelect}
          onCancel={handleThinkingCancel}
          isMidConversation={messages.some(m => m.type === 'assistant')}
        />
      </Box>
    );
  }, [showThinkingToggle, thinkingEnabled, handleThinkingSelect, handleThinkingCancel, messages.length]);

  // 全屏模式下将对话框 portal 到 DialogOverlay，使其脱离底部插槽的
  // overflowY:hidden 裁剪（与 SuggestionsOverlay 相同模式）。
  // 必须在下方的 early return 之前调用，以满足 rules-of-hooks。
  useSetPromptOverlayDialog(null);

  if (showBashesDialog) {
    return (
      <BackgroundTasksDialog
        onDone={() => setShowBashesDialog(false)}
        toolUseContext={getToolUseContext(messages, [], new AbortController(), mainLoopModel)}
        initialDetailTaskId={typeof showBashesDialog === 'string' ? showBashesDialog : undefined}
      />
    );
  }

  if (isAgentSwarmsEnabled() && showTeamsDialog) {
    return (
      <TeamsDialog
        initialTeams={cachedTeams}
        onDone={() => {
          setShowTeamsDialog(false);
        }}
      />
    );
  }

  if (feature('QUICK_SEARCH')) {
    const insertWithSpacing = (text: string) => {
      const cursorChar = input[cursorOffset - 1] ?? ' ';
      insertTextAtCursor(/\s/.test(cursorChar) ? text : ` ${text}`);
    };
    if (showQuickOpen) {
      return <QuickOpenDialog onDone={() => setShowQuickOpen(false)} onInsert={insertWithSpacing} />;
    }
    if (showGlobalSearch) {
      return <GlobalSearchDialog onDone={() => setShowGlobalSearch(false)} onInsert={insertWithSpacing} />;
    }
  }

  if (feature('HISTORY_PICKER') && showHistoryPicker) {
    return (
      <HistorySearchDialog
        initialQuery={input}
        onSelect={entry => {
          const entryMode = getModeFromInput(entry.display);
          const value = getValueFromInput(entry.display);
          onModeChange(entryMode);
          trackAndSetInput(value);
          setPastedContents(entry.pastedContents);
          setCursorOffset(value.length);
          setShowHistoryPicker(false);
        }}
        onCancel={() => setShowHistoryPicker(false)}
      />
    );
  }

  // 按需显示循环模式菜单（仅限 ant，在外部构建中已消除）
  if (modelPickerElement) {
    return modelPickerElement;
  }

  if (fastModePickerElement) {
    return fastModePickerElement;
  }

  if (thinkingToggleElement) {
    return thinkingToggleElement;
  }

  if (showBridgeDialog) {
    return (
      <BridgeDialog
        onDone={() => {
          setShowBridgeDialog(false);
          selectFooterItem(null);
        }}
      />
    );
  }

  const baseProps: BaseTextInputProps = {
    multiline: true,
    onSubmit,
    onChange,
    value: historyMatch
      ? getValueFromInput(typeof historyMatch === 'string' ? historyMatch : historyMatch.display)
      : input,
    // 历史导航通过 TextInput props（onHistoryUp/onHistoryDown）处理，
    // 而非 useKeybindings。这使 useTextInput 的 upOrHistoryUp/downOrHistoryDown
    // 先尝试移动光标，仅当光标无法继续移动时才回退到历史导航
    // （对于换行文本和多行输入非常重要）。
    onHistoryUp: handleHistoryUp,
    onHistoryDown: handleHistoryDown,
    onHistoryReset: resetHistory,
    placeholder,
    onExit,
    onExitMessage: (show, key) => setExitMessage({ show, key }),
    onImagePaste,
    columns: textInputColumns,
    maxVisibleLines,
    disableCursorMovementForUpDownKeys: suggestions.length > 0 || !!footerItemSelected,
    disableEscapeDoublePress: suggestions.length > 0,
    cursorOffset,
    onChangeCursorOffset: setCursorOffset,
    onPaste: onTextPaste,
    onIsPastingChange: setIsPasting,
    focus: !isSearchingHistory && !isModalOverlayActive && !footerItemSelected,
    showCursor: !footerItemSelected && !isSearchingHistory && !cursorAtImageChip,
    argumentHint: commandArgumentHint,
    onUndo: canUndo
      ? () => {
          const previousState = undo();
          if (previousState) {
            trackAndSetInput(previousState.text);
            setCursorOffset(previousState.cursorOffset);
            setPastedContents(previousState.pastedContents);
          }
        }
      : undefined,
    highlights: combinedHighlights,
    inlineGhostText,
    inputFilter: lazySpaceInputFilter,
  };

  const getBorderColor = (): keyof Theme => {
    const modeColors: Record<string, keyof Theme> = {
      bash: 'bashBorder',
    };

    // 模式颜色优先，其次是团队成员颜色，最后是默认颜色
    if (modeColors[mode]) {
      return modeColors[mode];
    }

    // 进程内团队成员以无头模式运行 —— 不将团队成员颜色应用到 leader UI
    if (isInProcessTeammate()) {
      return 'promptBorder';
    }

    // 从环境变量中检查团队成员颜色
    const teammateColorName = getTeammateColor();
    if (teammateColorName && AGENT_COLORS.includes(teammateColorName as AgentColorName)) {
      return AGENT_COLOR_TO_THEME_COLOR[teammateColorName as AgentColorName];
    }

    return 'promptBorder';
  };

  if (isExternalEditorActive) {
    return (
      <Box
        flexDirection="row"
        alignItems="center"
        justifyContent="center"
        borderColor={getBorderColor()}
        borderStyle="round"
        borderLeft={false}
        borderRight={false}
        borderBottom
        width="100%"
      >
        <Text dimColor italic>
          保存并关闭编辑器以继续...
        </Text>
      </Box>
    );
  }

  const textInputElement = isVimModeEnabled() ? (
    <VimTextInput {...baseProps} initialMode={vimMode} onModeChange={setVimMode} />
  ) : (
    <TextInput {...baseProps} />
  );

  return (
    <Box flexDirection="column" marginTop={briefOwnsGap ? 0 : 1}>
      {!isFullscreenEnvEnabled() && <PromptInputQueuedCommands />}
      {hasSuppressedDialogs && (
        <Box marginTop={1} marginLeft={2}>
          <Text dimColor>等待权限确认…</Text>
        </Box>
      )}
      <PromptInputStashNotice hasStash={stashedPrompt !== undefined} />
      {swarmBanner ? (
        <>
          <Text color={swarmBanner.bgColor}>
            {swarmBanner.text ? (
              <>
                {'─'.repeat(Math.max(0, columns - stringWidth(swarmBanner.text) - 4))}
                <Text backgroundColor={swarmBanner.bgColor} color="inverseText">
                  {' '}
                  {swarmBanner.text}{' '}
                </Text>
                {'──'}
              </>
            ) : (
              '─'.repeat(columns)
            )}
          </Text>
          <Box flexDirection="row" width="100%">
            <PromptInputModeIndicator
              mode={mode}
              isLoading={isLoading}
              viewingAgentName={viewingAgentName}
              viewingAgentColor={viewingAgentColor}
            />
            <Box flexGrow={1} flexShrink={1} onClick={handleInputClick}>
              {textInputElement}
            </Box>
          </Box>
          <Text color={swarmBanner.bgColor}>{'─'.repeat(columns)}</Text>
        </>
      ) : (
        <Box
          flexDirection="row"
          alignItems="flex-start"
          justifyContent="flex-start"
          borderColor={getBorderColor()}
          borderStyle="round"
          borderLeft={false}
          borderRight={false}
          borderBottom
          width="100%"
          borderText={buildBorderText(showFastIcon ?? false, showFastIconHint, fastModeCooldown)}
        >
          <PromptInputModeIndicator
            mode={mode}
            isLoading={isLoading}
            viewingAgentName={viewingAgentName}
            viewingAgentColor={viewingAgentColor}
          />
          <Box flexGrow={1} flexShrink={1} onClick={handleInputClick}>
            {textInputElement}
          </Box>
        </Box>
      )}
      <PromptInputFooter
        apiKeyStatus={apiKeyStatus}
        debug={debug}
        exitMessage={exitMessage}
        vimMode={isVimModeEnabled() ? vimMode : undefined}
        mode={mode}
        autoUpdaterResult={autoUpdaterResult}
        isAutoUpdating={isAutoUpdating}
        verbose={verbose}
        onAutoUpdaterResult={onAutoUpdaterResult}
        onChangeIsUpdating={setIsAutoUpdating}
        suggestions={suggestions}
        selectedSuggestion={selectedSuggestion}
        maxColumnWidth={maxColumnWidth}
        toolPermissionContext={effectiveToolPermissionContext}
        helpOpen={helpOpen}
        suppressHint={input.length > 0}
        isLoading={isLoading}
        tasksSelected={tasksSelected}
        teamsSelected={teamsSelected}
        bridgeSelected={bridgeSelected}
        tmuxSelected={tmuxSelected}
        teammateFooterIndex={teammateFooterIndex}
        ideSelection={ideSelection}
        mcpClients={mcpClients}
        isPasting={isPasting}
        isInputWrapped={isInputWrapped}
        messages={messages}
        isSearching={isSearchingHistory}
        historyQuery={historyQuery}
        setHistoryQuery={setHistoryQuery}
        historyFailedMatch={historyFailedMatch}
        onOpenTasksDialog={isFullscreenEnvEnabled() ? handleOpenTasksDialog : undefined}
      />
      {isFullscreenEnvEnabled() ? (
        // position=absolute 使布局高度为零，通知出现/消失时 spinner 不会移位。
        // Yoga 将绝对定位子元素锚定到父元素内容框原点；
        // marginTop=-1 将其拉入 prompt 边框上方的 marginTop=1 间隙行。
        // 简报模式下没有此间隙（briefOwnsGap 会去掉我们的 marginTop），
        // BriefSpinner 紧贴边框 —— marginTop=-2 跳过 spinner 内容进入
        // BriefSpinner 自身的 marginTop=1 空白行。
        // height=1 + overflow=hidden 将多行通知裁剪为单行。
        // flex-end 锚定底部行，使可见行始终是最新的。
        // 斜杠叠加层或自动模式确认对话框显示时通过 height=0（非卸载）抑制 ——
        // 此 Box 在树中靠后渲染，否则会覆盖它们的底部行。
        // 保持 Notifications 挂载防止 AutoUpdater 的初始检查 effect
        // 在每次斜杠补全切换时重新触发（PR#22413）。
        <Box
          position="absolute"
          marginTop={briefOwnsGap ? -2 : -1}
          height={suggestions.length === 0 ? 1 : 0}
          width="100%"
          paddingLeft={2}
          paddingRight={1}
          flexDirection="column"
          justifyContent="flex-end"
          overflow="hidden"
        >
          <Notifications
            apiKeyStatus={apiKeyStatus}
            autoUpdaterResult={autoUpdaterResult}
            debug={debug}
            isAutoUpdating={isAutoUpdating}
            verbose={verbose}
            messages={messages}
            onAutoUpdaterResult={onAutoUpdaterResult}
            onChangeIsUpdating={setIsAutoUpdating}
            ideSelection={ideSelection}
            mcpClients={mcpClients}
            isInputWrapped={isInputWrapped}
          />
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * 通过查找现有消息中使用的最大 ID 来计算初始粘贴 ID。
 * 处理 --continue/--resume 场景，避免 ID 冲突。
 */
function getInitialPasteId(messages: Message[]): number {
  let maxId = 0;
  for (const message of messages) {
    if (message.type === 'user') {
      // 检查图片粘贴 ID
      if (message.imagePasteIds) {
        for (const id of message.imagePasteIds as number[]) {
          if (id > maxId) maxId = id;
        }
      }
      // 检查消息内容中的文本粘贴引用
      if (Array.isArray(message.message!.content)) {
        for (const block of message.message!.content) {
          if (block.type === 'text') {
            const refs = parseReferences(block.text);
            for (const ref of refs) {
              if (ref.id > maxId) maxId = ref.id;
            }
          }
        }
      }
    }
  }
  return maxId + 1;
}

function buildBorderText(
  showFastIcon: boolean,
  showFastIconHint: boolean,
  fastModeCooldown: boolean,
): BorderTextOptions | undefined {
  if (!showFastIcon) return undefined;
  const fastSeg = showFastIconHint
    ? `${getFastIconString(true, fastModeCooldown)} ${chalk.dim('/fast')}`
    : getFastIconString(true, fastModeCooldown);
  return {
    content: ` ${fastSeg} `,
    position: 'top',
    align: 'end',
    offset: 0,
  };
}

export default React.memo(PromptInput);
