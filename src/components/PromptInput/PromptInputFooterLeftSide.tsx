// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { feature } from 'bun:bundle';
// 死代码消除：针对 COORDINATOR_MODE 的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModule = feature('COORDINATOR_MODE')
  ? (require('../../coordinator/coordinatorMode.js') as typeof import('../../coordinator/coordinatorMode.js'))
  : undefined;
/* eslint-enable @typescript-eslint/no-require-imports */
import { Box, Text, Link } from '@anthropic/ink';
import * as React from 'react';
import figures from 'figures';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { VimMode, PromptInputMode } from '../../types/textInputTypes.js';
import type { ToolPermissionContext } from '../../Tool.js';
import { isVimModeEnabled } from './utils.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import {
  isDefaultMode,
  permissionModeSymbol,
  permissionModeTitle,
  getModeColor,
} from '../../utils/permissions/PermissionMode.js';
import { BackgroundTaskStatus } from '../tasks/BackgroundTaskStatus.js';
import { isBackgroundTask } from '../../tasks/types.js';
import { isPanelAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js';
import { getVisibleAgentTasks } from '../CoordinatorAgentStatus.js';
import { count } from '../../utils/array.js';
import { shouldHideTasksFooter } from '../tasks/taskStatusUtils.js';
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js';
import { TeamStatus } from '../teams/TeamStatus.js';
import { isInProcessEnabled } from '../../utils/swarm/backends/registry.js';
import { useAppState, useAppStateStore } from 'src/state/AppState.js';
import { getIsRemoteMode } from '../../bootstrap/state.js';
import HistorySearchInput from './HistorySearchInput.js';
import { usePrStatus } from '../../hooks/usePrStatus.js';
import { Byline, KeyboardShortcutHint } from '@anthropic/ink';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useTasksV2 } from '../../hooks/useTasksV2.js';
import { formatDuration, formatFileSize } from '../../utils/format.js';
import { VoiceWarmupHint } from './VoiceIndicator.js';
import { useVoiceEnabled } from '../../hooks/useVoiceEnabled.js';
import { useVoiceState } from '../../context/voice.js';
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js';
import { isXtermJs, useHasSelection, useSelection } from '@anthropic/ink';
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js';
import { getPlatform } from '../../utils/platform.js';
import { PrBadge } from '../PrBadge.js';

// 死代码消除：针对主动模式的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule = feature('PROACTIVE') || feature('KAIROS') ? require('../../proactive/index.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */
const NO_OP_SUBSCRIBE = (_cb: () => void) => () => {};
const NULL = () => null;
const MAX_VOICE_HINT_SHOWS = 3;

const RSS_UPDATE_INTERVAL_MS = 5_000;
const GOAL_TICK_INTERVAL_MS = 1_000;

type RssState = { text: string; level: 'normal' | 'warning' | 'error' };

function useRssDisplay(): RssState | null {
  const [state, setState] = useState<RssState | null>(null);
  useEffect(() => {
    function update(): void {
      const mb = process.memoryUsage().rss / (1024 * 1024);
      const level = mb >= 1024 ? 'error' : mb >= 512 ? 'warning' : 'normal';
      const text = formatFileSize(mb * 1024 * 1024);
      setState(prev => (prev?.text === text ? prev : { text, level }));
    }
    update();
    const timer = setInterval(update, RSS_UPDATE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
  return state;
}

type Props = {
  exitMessage: {
    show: boolean;
    key?: string;
  };
  vimMode: VimMode | undefined;
  mode: PromptInputMode;
  toolPermissionContext: ToolPermissionContext;
  suppressHint: boolean;
  isLoading: boolean;
  showMemoryTypeSelector?: boolean;
  tasksSelected: boolean;
  teamsSelected: boolean;
  tmuxSelected: boolean;
  teammateFooterIndex?: number;
  isPasting?: boolean;
  isSearching: boolean;
  historyQuery: string;
  setHistoryQuery: (query: string) => void;
  historyFailedMatch: boolean;
  onOpenTasksDialog?: (taskId?: string) => void;
};

function ProactiveCountdown(): React.ReactNode {
  const nextTickAt = useSyncExternalStore(
    proactiveModule?.subscribeToProactiveChanges ?? NO_OP_SUBSCRIBE,
    proactiveModule?.getNextTickAt ?? NULL,
    NULL,
  );

  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (nextTickAt === null) {
      setRemainingSeconds(null);
      return;
    }

    function update(): void {
      const remaining = Math.max(0, Math.ceil((nextTickAt! - Date.now()) / 1000));
      setRemainingSeconds(remaining);
    }

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [nextTickAt]);

  if (remainingSeconds === null) return null;

  return <Text dimColor>waiting {formatDuration(remainingSeconds * 1000, { mostSignificantOnly: true })}</Text>;
}

/** footer 中紧凑的「goal (1h22min)」徽章 —— 按状态着色。 */
function GoalElapsedIndicator(): React.ReactNode {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), GOAL_TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
  void tick;

  const goalModule = require('../../services/goal/goalState.js') as typeof import('../../services/goal/goalState');
  const goal = goalModule.getGoal();
  if (!goal) return null;

  const elapsedMs = goalModule.getActiveElapsedMs(goal);
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  let timeStr: string;
  if (hours >= 1) {
    timeStr = `${hours}h${minutes}min`;
  } else if (minutes >= 1) {
    timeStr = `${minutes}min`;
  } else {
    timeStr = `${seconds}s`;
  }

  let color: string | undefined;
  switch (goal.status) {
    case 'active':
      color = 'ansi:green';
      break;
    case 'paused':
    case 'budget_limited':
    case 'usage_limited':
      color = 'ansi:yellow';
      break;
    case 'blocked':
      color = 'ansi:red';
      break;
    case 'complete':
      color = 'ansi:cyan';
      break;
  }

  return <Text color={color as 'ansi:green'}>goal ({timeStr})</Text>;
}

export function PromptInputFooterLeftSide({
  exitMessage,
  vimMode,
  mode,
  toolPermissionContext,
  suppressHint,
  isLoading,
  tasksSelected,
  teamsSelected,
  tmuxSelected,
  teammateFooterIndex,
  isPasting,
  isSearching,
  historyQuery,
  setHistoryQuery,
  historyFailedMatch,
  onOpenTasksDialog,
}: Props): React.ReactNode {
  if (exitMessage.show) {
    return (
      <Text dimColor key="exit-message">
        再次按 {exitMessage.key} 退出
      </Text>
    );
  }
  if (isPasting) {
    return (
      <Text dimColor key="pasting-message">
        正在粘贴文本…
      </Text>
    );
  }

  const showVim = isVimModeEnabled() && vimMode === 'INSERT' && !isSearching;

  return (
    <Box justifyContent="flex-start" gap={1}>
      {isSearching && (
        <HistorySearchInput value={historyQuery} onChange={setHistoryQuery} historyFailedMatch={historyFailedMatch} />
      )}
      {showVim ? (
        <Text dimColor key="vim-insert">
          -- INSERT --
        </Text>
      ) : null}
      <ModeIndicator
        mode={mode}
        toolPermissionContext={toolPermissionContext}
        showHint={!suppressHint && !showVim}
        isLoading={isLoading}
        tasksSelected={tasksSelected}
        teamsSelected={teamsSelected}
        teammateFooterIndex={teammateFooterIndex}
        tmuxSelected={tmuxSelected}
        onOpenTasksDialog={onOpenTasksDialog}
      />
    </Box>
  );
}

type ModeIndicatorProps = {
  mode: PromptInputMode;
  toolPermissionContext: ToolPermissionContext;
  showHint: boolean;
  isLoading: boolean;
  tasksSelected: boolean;
  teamsSelected: boolean;
  tmuxSelected: boolean;
  teammateFooterIndex?: number;
  onOpenTasksDialog?: (taskId?: string) => void;
};

function ModeIndicator({
  mode,
  toolPermissionContext,
  showHint,
  isLoading,
  tasksSelected,
  teamsSelected,
  tmuxSelected,
  teammateFooterIndex,
  onOpenTasksDialog,
}: ModeIndicatorProps): React.ReactNode {
  const { columns } = useTerminalSize();
  const modeCycleShortcut = useShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab');
  const tasks = useAppState(s => s.tasks);
  const teamContext = useAppState(s => s.teamContext);
  // 在 initialState 中设置一次（main.tsx --remote 模式），之后不再修改 ——
  // 惰性初始化无需订阅即可捕获不可变值。
  const store = useAppStateStore();
  const [remoteSessionUrl] = useState(() => store.getState().remoteSessionUrl);
  const viewSelectionMode = useAppState(s => s.viewSelectionMode);
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId);
  const expandedView = useAppState(s => s.expandedView);
  const showSpinnerTree = expandedView === 'teammates';
  const prStatus = usePrStatus(isLoading, isPrStatusEnabled());
  const hasTmuxSession = useAppState(s => process.env.USER_TYPE === 'ant' && s.tungstenActiveSession !== undefined);

  const nextTickAt = useSyncExternalStore(
    proactiveModule?.subscribeToProactiveChanges ?? NO_OP_SUBSCRIBE,
    proactiveModule?.getNextTickAt ?? NULL,
    NULL,
  );
  const voiceEnabledRaw = useVoiceEnabled();
  const voiceEnabled = feature('VOICE_MODE') ? voiceEnabledRaw : false;
  const voiceStateRaw = useVoiceState(s => s.voiceState);
  const voiceState = feature('VOICE_MODE') ? voiceStateRaw : ('idle' as const);
  const voiceWarmingUpRaw = useVoiceState(s => s.voiceWarmingUp);
  const voiceWarmingUp = feature('VOICE_MODE') ? voiceWarmingUpRaw : false;
  const hasSelection = useHasSelection();
  const selGetState = useSelection().getState;
  const hasNextTick = nextTickAt !== null;
  const isCoordinator = feature('COORDINATOR_MODE') ? coordinatorModule?.isCoordinatorMode() === true : false;
  const runningTaskCount = useMemo(
    () =>
      count(
        Object.values(tasks),
        t => isBackgroundTask(t) && !(process.env.USER_TYPE === 'ant' && isPanelAgentTask(t)),
      ),
    [tasks],
  );
  const tasksV2 = useTasksV2();
  const hasTaskItems = tasksV2 !== undefined && tasksV2.length > 0;
  const escShortcut = useShortcutDisplay('chat:cancel', 'Chat', 'esc').toLowerCase();
  const todosShortcut = useShortcutDisplay('app:toggleTodos', 'Global', 'ctrl+t');
  const killAgentsShortcut = useShortcutDisplay('chat:killAgents', 'Chat', 'ctrl+x ctrl+k');
  const voiceKeyShortcutRaw = useShortcutDisplay('voice:pushToTalk', 'Chat', 'Space');
  const voiceKeyShortcut = feature('VOICE_MODE') ? voiceKeyShortcutRaw : '';
  // 在挂载时捕获，防止另一个 CC 实例递增计数器时提示在会话中途闪烁。
  // 在本会话第一次启用语音时通过 useEffect 递增一次 ——
  // 近似于「提示已显示」，无需追踪精确的渲染时条件
  // （该条件依赖于提前返回 hook 边界之后计算的 parts/hintParts）。
  const [voiceHintUnderCapRaw] = useState(
    () => (getGlobalConfig().voiceFooterHintSeenCount ?? 0) < MAX_VOICE_HINT_SHOWS,
  );
  const voiceHintUnderCap = feature('VOICE_MODE') ? voiceHintUnderCapRaw : false;
  const voiceHintIncrementedRefRaw = useRef(false);
  const voiceHintIncrementedRef = feature('VOICE_MODE') ? voiceHintIncrementedRefRaw : null;
  useEffect(() => {
    if (feature('VOICE_MODE')) {
      if (!voiceEnabled || !voiceHintUnderCap) return;
      if (voiceHintIncrementedRef?.current) return;
      if (voiceHintIncrementedRef) voiceHintIncrementedRef.current = true;
      const newCount = (getGlobalConfig().voiceFooterHintSeenCount ?? 0) + 1;
      saveGlobalConfig(prev => {
        if ((prev.voiceFooterHintSeenCount ?? 0) >= newCount) return prev;
        return { ...prev, voiceFooterHintSeenCount: newCount };
      });
    }
  }, [voiceEnabled, voiceHintUnderCap]);
  const isKillAgentsConfirmShowing = useAppState(s => s.notifications.current?.key === 'kill-agents-confirm');
  const rssState = useRssDisplay();

  // 从 teamContext 派生团队信息（无需文件系统 I/O）
  // 与 TeamStatus 使用相同逻辑以避免尾部分隔符
  // 进程内模式使用 Shift+Down/Up 导航，而非 footer 团队菜单
  const hasTeams =
    isAgentSwarmsEnabled() &&
    !isInProcessEnabled() &&
    teamContext !== undefined &&
    count(Object.values(teamContext.teammates), t => t.name !== 'team-lead') > 0;

  if (mode === 'bash') {
    return <Text color="bashBorder">! 进入 bash 模式</Text>;
  }

  const currentMode = toolPermissionContext?.mode;
  const hasActiveMode = !isDefaultMode(currentMode);
  const viewedTask = viewingAgentTaskId ? tasks[viewingAgentTaskId] : undefined;
  const isViewingTeammate = viewSelectionMode === 'viewing-agent' && viewedTask?.type === 'in_process_teammate';
  const isViewingCompletedTeammate = isViewingTeammate && viewedTask != null && viewedTask.status !== 'running';
  const hasBackgroundTasks = runningTaskCount > 0 || isViewingTeammate;

  // 计算主要项数量（权限模式或协调者模式、后台任务和团队）
  const primaryItemCount = (isCoordinator || hasActiveMode ? 1 : 0) + (hasBackgroundTasks ? 1 : 0) + (hasTeams ? 1 : 0);

  // PR 指示器很短（约 10 个字符）—— 与旧版差异指示器的 >=100 阈值不同。
  // 由于自动模式实际上已成为基准，大多数会话中 primaryItemCount ≥1；
  // 保持阈值足够低，以便在标准 80 列终端上显示 PR 状态。
  const shouldShowPrStatus =
    isPrStatusEnabled() &&
    prStatus.number !== null &&
    prStatus.reviewState !== null &&
    prStatus.url !== null &&
    primaryItemCount < 2 &&
    (primaryItemCount === 0 || columns >= 80);

  // 当有 2 个主要项时隐藏 shift+tab 提示
  const shouldShowModeHint = primaryItemCount < 2;

  // 检查是否有进程内团队成员（显示徽章）
  // 在 spinner-tree 模式下，徽章被禁用 —— 团队成员改为显示在 spinner 树中
  const hasInProcessTeammates =
    !showSpinnerTree && hasBackgroundTasks && Object.values(tasks).some(t => t.type === 'in_process_teammate');
  const hasTeammatePills = hasInProcessTeammates || (!showSpinnerTree && isViewingTeammate);

  // 在远程模式（`claude assistant`、--teleport）下，agent 在别处运行；
  // 此处显示的本地权限模式不反映 agent 的状态。
  // 在任务徽章之前渲染，防止较长的徽章标签（如 ultraplan URL）
  // 将模式指示器推出屏幕。
  const modePart =
    currentMode && hasActiveMode && !getIsRemoteMode() ? (
      <Text color={getModeColor(currentMode)} key="mode">
        {permissionModeSymbol(currentMode)} {permissionModeTitle(currentMode).toLowerCase()} 已开启
        {shouldShowModeHint && (
          <Text dimColor>
            {' '}
            <KeyboardShortcutHint shortcut={modeCycleShortcut} action="切换" parens />
          </Text>
        )}
      </Text>
    ) : null;

  // 构建 parts 数组 —— 当有团队成员徽章时排除 BackgroundTaskStatus
  // （团队成员徽章有自己的行）
  const parts = [
    // 远程会话指示器
    ...(remoteSessionUrl
      ? [
          <Link url={remoteSessionUrl} key="remote">
            <Text color="ide">{figures.circleDouble} 远程</Text>
          </Link>,
        ]
      : []),
    // BackgroundTaskStatus 不在 parts 中 —— 它作为 Box 兄弟元素渲染，
    // 避免其点击目标 Box 嵌套在 <Text wrap="truncate"> 包装器内
    // （reconciler 在 Box-in-Text 时会抛出异常）。
    // Tmux 徽章（仅限 ant）—— 在导航顺序中紧接任务之后显示
    ...(process.env.USER_TYPE === 'ant' && hasTmuxSession ? [<TungstenPill key="tmux" selected={tmuxSelected} />] : []),
    ...(isAgentSwarmsEnabled() && hasTeams
      ? [<TeamStatus key="teams" teamsSelected={teamsSelected} showHint={showHint && !hasBackgroundTasks} />]
      : []),
    ...(shouldShowPrStatus
      ? [<PrBadge key="pr-status" number={prStatus.number!} url={prStatus.url!} reviewState={prStatus.reviewState!} />]
      : []),
    // RSS 内存指示器 —— 始终可见
    ...(rssState
      ? [
          <Text
            key="rss"
            dimColor={rssState.level === 'normal'}
            color={rssState.level === 'error' ? 'error' : rssState.level === 'warning' ? 'warning' : undefined}
          >
            {rssState.text} · pid:{process.pid}
          </Text>,
        ]
      : []),
    // 目标耗时指示器 —— PID 后面紧凑的「goal (XhYmin)」
    ...(feature('GOAL') &&
    (require('../../services/goal/goalState.js') as typeof import('../../services/goal/goalState')).getGoal()
      ? [<GoalElapsedIndicator key="goal-elapsed" />]
      : []),
  ];

  // 检查是否存在进程内团队成员（用于提示文字循环）
  const hasAnyInProcessTeammates = Object.values(tasks).some(
    t => t.type === 'in_process_teammate' && t.status === 'running',
  );
  const hasRunningAgentTasks = Object.values(tasks).some(t => t.type === 'local_agent' && t.status === 'running');

  // 单独获取提示部分，以便潜在的第二行渲染
  const hintParts = showHint
    ? getSpinnerHintParts(
        isLoading,
        escShortcut,
        todosShortcut,
        killAgentsShortcut,
        hasTaskItems,
        expandedView,
        hasAnyInProcessTeammates,
        hasRunningAgentTasks,
        isKillAgentsConfirmShowing,
      )
    : [];

  if (isViewingCompletedTeammate) {
    parts.push(
      <Text dimColor key="esc-return">
        <KeyboardShortcutHint shortcut={escShortcut} action="返回 team lead" />
      </Text>,
    );
  } else if ((feature('PROACTIVE') || feature('KAIROS')) && hasNextTick) {
    parts.push(<ProactiveCountdown key="proactive" />);
  } else if (!hasTeammatePills && showHint) {
    parts.push(...hintParts);
  }

  // 当有团队成员徽章时，始终在其他部分之上单独渲染一行
  if (hasTeammatePills) {
    // 查看已完成的团队成员时不追加 spinner 提示 ——
    // 「esc 返回 team lead」提示已取代「esc 中断」
    const otherParts = [...(modePart ? [modePart] : []), ...parts, ...(isViewingCompletedTeammate ? [] : hintParts)];
    return (
      <Box flexDirection="column">
        <Box>
          <BackgroundTaskStatus
            tasksSelected={tasksSelected}
            isViewingTeammate={isViewingTeammate}
            teammateFooterIndex={teammateFooterIndex}
            isLeaderIdle={!isLoading}
            onOpenDialog={onOpenTasksDialog}
          />
        </Box>
        {otherParts.length > 0 && (
          <Box>
            <Byline>{otherParts}</Byline>
          </Box>
        )}
      </Box>
    );
  }

  // 当面板有可见行时添加「↓ 管理任务」提示
  const hasCoordinatorTasks = process.env.USER_TYPE === 'ant' && getVisibleAgentTasks(tasks).length > 0;

  // 任务徽章作为 Box 兄弟元素渲染（不是 parts 条目），
  // 避免其点击目标 Box 嵌套在 <Text wrap="truncate"> 内 ——
  // reconciler 在 Box-in-Text 时会抛出异常。
  // 在此处计算，以便下方的空检查仍将「徽章存在」视为非空。
  const tasksPart =
    hasBackgroundTasks && !hasTeammatePills && !shouldHideTasksFooter(tasks, showSpinnerTree) ? (
      <BackgroundTaskStatus
        tasksSelected={tasksSelected}
        isViewingTeammate={isViewingTeammate}
        teammateFooterIndex={teammateFooterIndex}
        isLeaderIdle={!isLoading}
        onOpenDialog={onOpenTasksDialog}
      />
    ) : null;

  if (parts.length === 0 && !tasksPart && !modePart && showHint) {
    parts.push(
      <Text dimColor key="shortcuts-hint">
        ? 查看快捷键
      </Text>,
    );
  }

  // 仅在有内容可说时替换空闲语音提示 —— 否则直接跳过，
  // 而不是显示空的 Byline。「esc 清除」已移除
  // （空闲时看起来像「esc 中断」；esc 清除选区是标准 UX），
  // 仅保留 ctrl+c（copyOnSelect 关闭）和 xterm.js 原生选择提示。
  const copyOnSelect = getGlobalConfig().copyOnSelect ?? true;
  const selectionHintHasContent = hasSelection && (!copyOnSelect || isXtermJs());

  // 预热提示优先 —— 当用户主动按住激活键时，
  // 无论其他提示如何，均显示反馈。
  if (feature('VOICE_MODE') && voiceEnabled && voiceWarmingUp) {
    parts.push(<VoiceWarmupHint key="voice-warmup" />);
  } else if (isFullscreenEnvEnabled() && selectionHintHasContent) {
    // xterm.js（VS Code/Cursor/Windsurf）强制选择修饰键因平台而异，
    // 在 macOS 上受 SelectionService.shouldForceSelection 控制：
    //   macOS：altKey && macOptionClickForcesSelection（VS Code 默认：false）
    //   非 macOS：shiftKey
    // 在 macOS 上，如果我们收到了 alt+click（lastPressHadAlt），则 VS Code
    // 设置是关闭的 —— 否则 xterm.js 会消耗该事件。
    // 告诉用户需要切换的确切设置，而不是重复他们刚刚尝试过的 option+click 提示。
    // 非响应式 getState() 读取是安全的：lastPressHadAlt 在 hasSelection 为 true 时
    // 是不可变的（拖动前设置，随选区一起清除）。
    const isMac = getPlatform() === 'macos';
    const altClickFailed = isMac && (selGetState()?.lastPressHadAlt ?? false);
    parts.push(
      <Text dimColor key="selection-copy">
        <Byline>
          {!copyOnSelect && <KeyboardShortcutHint shortcut="ctrl+c" action="复制" />}
          {isXtermJs() &&
            (altClickFailed ? (
              <Text>在 VS Code 设置中开启 macOptionClickForcesSelection</Text>
            ) : (
              <KeyboardShortcutHint shortcut={isMac ? 'option+click' : 'shift+click'} action="原生选择" />
            ))}
        </Byline>
      </Text>,
    );
  } else if (
    feature('VOICE_MODE') &&
    parts.length > 0 &&
    showHint &&
    voiceEnabled &&
    voiceState === 'idle' &&
    hintParts.length === 0 &&
    voiceHintUnderCap
  ) {
    parts.push(
      <Text dimColor key="voice-hint">
        长按 {voiceKeyShortcut} 说话
      </Text>,
    );
  }

  if ((tasksPart || hasCoordinatorTasks) && showHint && !hasTeams) {
    parts.push(
      <Text dimColor key="manage-tasks">
        {tasksSelected ? (
          <KeyboardShortcutHint shortcut="Enter" action="查看任务" />
        ) : (
          <KeyboardShortcutHint shortcut="↓" action="管理" />
        )}
      </Text>,
    );
  }

  // 全屏模式下底部区域为 flexShrink:0 —— 此处每一行都会从 ScrollBox 中抢占一行。
  // 此组件必须保持稳定高度，防止 footer 增长/收缩并导致滚动内容偏移。
  // 当 parts 为空时返回 null（例如 StatusLine 开启 → suppressHint
  // → showHint=false → 无「? for shortcuts」）会让后续添加的部分
  // （如选区复制/原生选择提示）将列从 0 行增长到 1 行。
  // 全屏时始终渲染 1 行；parts 为空时返回空格，
  // 让 Yoga 保留该行而不绘制任何可见内容。
  if (parts.length === 0 && !tasksPart && !modePart) {
    return isFullscreenEnvEnabled() ? <Text> </Text> : null;
  }

  // flexShrink=0 使模式 + 徽章保持自然宽度；其余部分
  // 在 Text 包装器内作为单个字符串从末尾截断。
  return (
    <Box height={1} overflow="hidden">
      {modePart && (
        <Box flexShrink={0}>
          {modePart}
          {(tasksPart || parts.length > 0) && <Text dimColor> · </Text>}
        </Box>
      )}
      {tasksPart && (
        <Box flexShrink={0}>
          {tasksPart}
          {parts.length > 0 && <Text dimColor> · </Text>}
        </Box>
      )}
      {parts.length > 0 && (
        <Text wrap="truncate">
          <Byline>{parts}</Byline>
        </Text>
      )}
    </Box>
  );
}

function getSpinnerHintParts(
  isLoading: boolean,
  escShortcut: string,
  todosShortcut: string,
  killAgentsShortcut: string,
  hasTaskItems: boolean,
  expandedView: 'none' | 'tasks' | 'teammates',
  hasTeammates: boolean,
  hasRunningAgentTasks: boolean,
  isKillAgentsConfirmShowing: boolean,
): React.ReactElement[] {
  let toggleAction: string;
  if (hasTeammates) {
    // 循环：无 → 任务 → 团队成员 → 无
    switch (expandedView) {
      case 'none':
        toggleAction = '显示任务';
        break;
      case 'tasks':
        toggleAction = '显示团队成员';
        break;
      case 'teammates':
        toggleAction = '隐藏';
        break;
    }
  } else {
    toggleAction = expandedView === 'tasks' ? '隐藏任务' : '显示任务';
  }

  // 仅在有任务项可显示或有团队成员可循环时显示切换提示
  const showToggleHint = hasTaskItems || hasTeammates;

  return [
    ...(isLoading
      ? [
          <Text dimColor key="esc">
            <KeyboardShortcutHint shortcut={escShortcut} action="中断" />
          </Text>,
        ]
      : []),
    ...(!isLoading && hasRunningAgentTasks && !isKillAgentsConfirmShowing
      ? [
          <Text dimColor key="kill-agents">
            <KeyboardShortcutHint shortcut={killAgentsShortcut} action="停止 agents" />
          </Text>,
        ]
      : []),
    ...(showToggleHint
      ? [
          <Text dimColor key="toggle-tasks">
            <KeyboardShortcutHint shortcut={todosShortcut} action={toggleAction} />
          </Text>,
        ]
      : []),
  ];
}

function isPrStatusEnabled(): boolean {
  return getGlobalConfig().prStatusFooterEnabled ?? true;
}
