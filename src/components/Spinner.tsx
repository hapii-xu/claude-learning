// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { Box, Text, stringWidth } from '@anthropic/ink';
import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { computeGlimmerIndex, computeShimmerSegments, SHIMMER_INTERVAL_MS } from '../bridge/bridgeStatusUtil.js';
import { feature } from 'bun:bundle';
import { getKairosActive, getUserMsgOptIn } from '../bootstrap/state.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import { count } from '../utils/array.js';
import sample from 'lodash-es/sample.js';
import { formatDuration, formatNumber } from '../utils/format.js';
import type { Theme } from 'src/utils/theme.js';
import { activityManager } from '../utils/activityManager.js';
import { getSpinnerVerbs } from '../constants/spinnerVerbs.js';
import { MessageResponse } from './MessageResponse.js';
import { TaskListV2 } from './TaskListV2.js';
import { useTasksV2 } from '../hooks/useTasksV2.js';
import type { Task } from '../utils/tasks.js';
import { useAppState } from '../state/AppState.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { getDefaultCharacters, type SpinnerMode } from './Spinner/index.js';
import { SpinnerAnimationRow } from './Spinner/SpinnerAnimationRow.js';
import { useSettings } from '../hooks/useSettings.js';
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js';
import { isLocalAgentTask } from '../tasks/LocalAgentTask/LocalAgentTask.js';
import { isBackgroundTask } from '../tasks/types.js';
import { getAllInProcessTeammateTasks } from '../tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import { getEffortSuffix } from '../utils/effort.js';
import { getMainLoopModel } from '../utils/model/model.js';
import { getViewedTeammateTask } from '../state/selectors.js';
import { TEARDROP_ASTERISK } from '../constants/figures.js';
import figures from 'figures';
import { getCurrentTurnTokenBudget, getTurnOutputTokens } from '../bootstrap/state.js';

import { TeammateSpinnerTree } from './Spinner/TeammateSpinnerTree.js';
import { useAnimationFrame } from '@anthropic/ink';
import { getGlobalConfig } from '../utils/config.js';
export type { SpinnerMode } from './Spinner/index.js';

const DEFAULT_CHARACTERS = getDefaultCharacters();

const SPINNER_FRAMES = [...DEFAULT_CHARACTERS, ...[...DEFAULT_CHARACTERS].reverse()];

type Props = {
  mode: SpinnerMode;
  loadingStartTimeRef: React.RefObject<number>;
  totalPausedMsRef: React.RefObject<number>;
  pauseStartTimeRef: React.RefObject<number | null>;
  spinnerTip?: string;
  responseLengthRef: React.RefObject<number>;
  apiMetricsRef?: React.RefObject<
    Array<{
      ttftMs: number;
      firstTokenTime: number;
      lastTokenTime: number;
      responseLengthBaseline: number;
      endResponseLength: number;
    }>
  >;
  overrideColor?: keyof Theme | null;
  overrideShimmerColor?: keyof Theme | null;
  overrideMessage?: string | null;
  spinnerSuffix?: string | null;
  verbose: boolean;
  hasActiveTools?: boolean;
  /** Leader 的 turn 已完成（无活动的 query）。用于在只有 teammates 运行时抑制 stall-red spinner。 */
  leaderIsIdle?: boolean;
};

// 薄包装器：基于 isBriefOnly 分支，使两个变体有独立的
// hook 调用链。没有此拆分，在渲染中途切换 /brief 会
// 违反 Rules of Hooks（内部变体多调用了约 10 个 hooks）。
export function SpinnerWithVerb(props: Props): React.ReactNode {
  const isBriefOnly = useAppState(s => s.isBriefOnly);
  // REPL 在查看 teammate transcript 时将 isBriefOnly→false 覆盖
  // （见 isBriefOnly={viewedTeammateTask ? false : isBriefOnly}）。该
  // prop 未传递到这里，所以从 store 复刻 gate ——
  // teammate 视图需要真实的 spinner（显示 teammate 状态）。
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId);
  // 提升到挂载时 —— 此组件以动画帧率重新渲染。
  const briefEnvEnabledRaw = useMemo(() => isEnvTruthy(process.env.CLAUDE_CODE_BRIEF), []);
  const briefEnvEnabled = feature('KAIROS') || feature('KAIROS_BRIEF') ? briefEnvEnabledRaw : false;

  // Runtime gate 映射 isBriefEnabled() 但内联 —— 从
  // BriefTool.ts 导入会将 tool-name 字符串泄露到外部构建中。单个
  // spinner 实例 → hooks 保持无条件（两个 sub，可忽略）。
  if (
    (feature('KAIROS') || feature('KAIROS_BRIEF')) &&
    (getKairosActive() ||
      (getUserMsgOptIn() && (briefEnvEnabled || getFeatureValue_CACHED_MAY_BE_STALE('tengu_kairos_brief', false)))) &&
    isBriefOnly &&
    !viewingAgentTaskId
  ) {
    return <BriefSpinner mode={props.mode} overrideMessage={props.overrideMessage} />;
  }

  return <SpinnerWithVerbInner {...props} />;
}

function SpinnerWithVerbInner({
  mode,
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
  spinnerTip,
  responseLengthRef,
  overrideColor,
  overrideShimmerColor,
  overrideMessage,
  spinnerSuffix,
  verbose,
  hasActiveTools = false,
  leaderIsIdle = false,
}: Props): React.ReactNode {
  const settings = useSettings();
  const reducedMotion = settings.prefersReducedMotion ?? false;

  // 注意：useAnimationFrame(50) 位于 SpinnerAnimationRow 中，不在这里。
  // 此组件仅在 props 或 app state 变化时重新渲染 ——
  // 它不再在 50ms 时钟上。所有 `time` 派生的值
  // （frame、glimmer、stalled intensity、token counter、thinking shimmer、
  // elapsed-time timer）都在子组件内计算。

  const tasks = useAppState(s => s.tasks);
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId);
  const expandedView = useAppState(s => s.expandedView);
  const showExpandedTodos = expandedView === 'tasks';
  const showSpinnerTree = expandedView === 'teammates';
  const selectedIPAgentIndex = useAppState(s => s.selectedIPAgentIndex);
  const viewSelectionMode = useAppState(s => s.viewSelectionMode);
  // 获取前台化的 teammate（如果正在查看 teammate 的 transcript）
  const foregroundedTeammate = viewingAgentTaskId ? getViewedTeammateTask({ viewingAgentTaskId, tasks }) : undefined;
  const { columns } = useTerminalSize();
  const tasksV2 = useTasksV2();

  // 跟踪 thinking 状态：'thinking' | number（持续时间，毫秒）| null
  // 每个状态至少显示 2 秒以避免 UI 抖动
  const [thinkingStatus, setThinkingStatus] = useState<'thinking' | number | null>(null);
  const thinkingStartRef = useRef<number | null>(null);

  useEffect(() => {
    let showDurationTimer: ReturnType<typeof setTimeout> | null = null;
    let clearStatusTimer: ReturnType<typeof setTimeout> | null = null;

    if (mode === 'thinking') {
      // 开始 thinking
      if (thinkingStartRef.current === null) {
        thinkingStartRef.current = Date.now();
        setThinkingStatus('thinking');
      }
    } else if (thinkingStartRef.current !== null) {
      // 停止 thinking - 计算持续时间并确保至少显示 2 秒
      const duration = Date.now() - thinkingStartRef.current;
      const elapsed = Date.now() - thinkingStartRef.current;
      const remainingThinkingTime = Math.max(0, 2000 - elapsed);

      thinkingStartRef.current = null;

      // 如果经过时间 < 2 秒，则显示 "thinking..." 剩余时间，然后显示持续时间
      const showDuration = (): void => {
        setThinkingStatus(duration);
        // 2 秒后清除
        clearStatusTimer = setTimeout(setThinkingStatus, 2000, null);
      };

      if (remainingThinkingTime > 0) {
        showDurationTimer = setTimeout(showDuration, remainingThinkingTime);
      } else {
        showDuration();
      }
    }

    return () => {
      if (showDurationTimer) clearTimeout(showDurationTimer);
      if (clearStatusTimer) clearTimeout(clearStatusTimer);
    };
  }, [mode]);

  // 查找当前 in-progress 任务和下一个 pending 任务
  const currentTodo = tasksV2?.find(task => task.status !== 'pending' && task.status !== 'completed');
  const nextTask = findNextPendingTask(tasksV2);

  // 使用带 initializer 的 useState 在挂载时一次性选取随机 verb
  const [randomVerb] = useState(() => sample(getSpinnerVerbs()));

  // Leader 自己的 verb（永远是 leader 的，无论谁前台化）
  const leaderVerb = overrideMessage ?? currentTodo?.activeForm ?? currentTodo?.subject ?? randomVerb;

  const effectiveVerb =
    foregroundedTeammate && !foregroundedTeammate.isIdle
      ? (foregroundedTeammate.spinnerVerb ?? randomVerb)
      : leaderVerb;
  const message = effectiveVerb + '…';

  // 当 spinner 活动时跟踪 CLI 活动
  useEffect(() => {
    const operationId = 'spinner-' + mode;
    activityManager.startCLIActivity(operationId);
    return () => {
      activityManager.endCLIActivity(operationId);
    };
  }, [mode]);

  const effortValue = useAppState(s => s.effortValue);
  const effortSuffix = getEffortSuffix(getMainLoopModel(), effortValue);

  // 检查是否存在任何正在运行的 in-process teammates（两种模式都需要）
  const runningTeammates = getAllInProcessTeammateTasks(tasks).filter(t => t.status === 'running');
  const hasRunningTeammates = runningTeammates.length > 0;
  const allIdle = hasRunningTeammates && runningTeammates.every(t => t.isIdle);

  // 从所有正在运行的 agent 收集聚合的 token 统计。
  // 在 spinner-tree 模式下，跳过 in-process teammates（它们在 tree 中
  // 有自己的 per-teammate 行），但仍计算 local-agent 任务
  // （后台 agent），它们没有专属的 tree 行。
  let teammateTokens = 0;
  for (const task of Object.values(tasks)) {
    if (task.status !== 'running') continue;
    if (isInProcessTeammateTask(task)) {
      if (!showSpinnerTree && task.progress?.tokenCount) {
        teammateTokens += task.progress.tokenCount;
      }
      continue;
    }
    if (isLocalAgentTask(task)) {
      if (task.progress?.tokenCount) {
        teammateTokens += task.progress.tokenCount;
      }
    }
  }

  // 对 refs 的 stale 读取用于下方的 showBtwTip —— 我们脱离了 50ms 时钟，
  // 所以这仅在 props/app state 变化时更新，对于
  // 粗粒度 30 秒阈值已经足够。
  const elapsedSnapshot =
    pauseStartTimeRef.current !== null
      ? pauseStartTimeRef.current - loadingStartTimeRef.current - totalPausedMsRef.current
      : Date.now() - loadingStartTimeRef.current - totalPausedMsRef.current;

  // 用于 TeammateSpinnerTree 的 Leader token 计数 —— 从
  // ref 读取原始值（非动画）。tree 仅在 teammates 运行时显示；teammate
  // 进度更新到 s.tasks 会触发重新渲染以保持此值新鲜。
  const leaderTokenCount = Math.round(responseLengthRef.current / 4);

  const defaultColor: keyof Theme = 'claude';
  const defaultShimmerColor = 'claudeShimmer';
  const messageColor = overrideColor ?? defaultColor;
  const shimmerColor = overrideShimmerColor ?? defaultShimmerColor;

  // TTFT 显示仅限内部构建 —— apiMetricsRef 在重构期间从
  // props 中移除，所以在重新传递之前跳过此项。
  const _ttftText: string | null = null;

  // 当 leader 空闲但 teammates 运行（且我们正在查看 leader）时，
  // 显示静态 dim idle 显示而不是动画 spinner —— 否则
  // useStalledAnimation 会在 3 秒后检测到无新 token 并将 spinner 变红。
  if (leaderIsIdle && hasRunningTeammates && !foregroundedTeammate) {
    return (
      <Box flexDirection="column" width="100%" alignItems="flex-start">
        <Box flexDirection="row" flexWrap="wrap" marginTop={1} width="100%">
          <Text dimColor>
            {TEARDROP_ASTERISK} Idle
            {!allIdle && ' · teammates running'}
          </Text>
        </Box>
        {showSpinnerTree && (
          <TeammateSpinnerTree
            selectedIndex={selectedIPAgentIndex}
            isInSelectionMode={viewSelectionMode === 'selecting-agent'}
            allIdle={allIdle}
            leaderTokenCount={leaderTokenCount}
            leaderIdleText="Idle"
          />
        )}
      </Box>
    );
  }

  // 当查看空闲 teammate 时，显示静态 idle 显示而不是动画 spinner
  if (foregroundedTeammate?.isIdle) {
    const idleText = allIdle
      ? `${TEARDROP_ASTERISK} Worked for ${formatDuration(Date.now() - foregroundedTeammate.startTime)}`
      : `${TEARDROP_ASTERISK} Idle`;
    return (
      <Box flexDirection="column" width="100%" alignItems="flex-start">
        <Box flexDirection="row" flexWrap="wrap" marginTop={1} width="100%">
          <Text dimColor>{idleText}</Text>
        </Box>
        {showSpinnerTree && hasRunningTeammates && (
          <TeammateSpinnerTree
            selectedIndex={selectedIPAgentIndex}
            isInSelectionMode={viewSelectionMode === 'selecting-agent'}
            allIdle={allIdle}
            leaderVerb={leaderIsIdle ? undefined : leaderVerb}
            leaderIdleText={leaderIsIdle ? 'Idle' : undefined}
            leaderTokenCount={leaderTokenCount}
          />
        )}
      </Box>
    );
  }

  // 基于时间的 tip 覆盖：粗粒度阈值，所以 stale ref 读取（我们
  // 脱离了 50ms 时钟）没问题。其他触发器（mode 变化、setMessages）
  // 实际上会触发重新渲染以刷新此项。
  let contextTipsActive = false;
  const tipsEnabled = settings.spinnerTipsEnabled !== false;
  const showClearTip = tipsEnabled && elapsedSnapshot > 1_800_000;
  const showBtwTip = tipsEnabled && elapsedSnapshot > 30_000 && !getGlobalConfig().btwUseCount;

  const effectiveTip = contextTipsActive
    ? undefined
    : showClearTip && !nextTask
      ? 'Use /clear to start fresh when switching topics and free up context'
      : showBtwTip && !nextTask
        ? "Use /btw to ask a quick side question without interrupting Claude's current work"
        : spinnerTip;

  // Budget 文本（仅 ant）—— 显示在 tip 行上方
  let budgetText: string | null = null;
  if (feature('TOKEN_BUDGET')) {
    const budget = getCurrentTurnTokenBudget();
    if (budget !== null && budget > 0) {
      const tokens = getTurnOutputTokens();
      if (tokens >= budget) {
        budgetText = `Target: ${formatNumber(tokens)} used (${formatNumber(budget)} min ${figures.tick})`;
      } else {
        const pct = Math.round((tokens / budget) * 100);
        const remaining = budget - tokens;
        const rate = elapsedSnapshot > 5000 && tokens >= 2000 ? tokens / elapsedSnapshot : 0;
        const eta = rate > 0 ? ` \u00B7 ~${formatDuration(remaining / rate, { mostSignificantOnly: true })}` : '';
        budgetText = `Target: ${formatNumber(tokens)} / ${formatNumber(budget)} (${pct}%)${eta}`;
      }
    }
  }

  return (
    <Box flexDirection="column" width="100%" alignItems="flex-start">
      <SpinnerAnimationRow
        mode={mode}
        reducedMotion={reducedMotion}
        hasActiveTools={hasActiveTools}
        responseLengthRef={responseLengthRef}
        message={message}
        messageColor={messageColor}
        shimmerColor={shimmerColor}
        overrideColor={overrideColor}
        loadingStartTimeRef={loadingStartTimeRef}
        totalPausedMsRef={totalPausedMsRef}
        pauseStartTimeRef={pauseStartTimeRef}
        spinnerSuffix={spinnerSuffix}
        verbose={verbose}
        columns={columns}
        hasRunningTeammates={hasRunningTeammates}
        teammateTokens={teammateTokens}
        foregroundedTeammate={foregroundedTeammate}
        leaderIsIdle={leaderIsIdle}
        thinkingStatus={thinkingStatus}
        effortSuffix={effortSuffix}
      />
      {showSpinnerTree && hasRunningTeammates ? (
        <TeammateSpinnerTree
          selectedIndex={selectedIPAgentIndex}
          isInSelectionMode={viewSelectionMode === 'selecting-agent'}
          allIdle={allIdle}
          leaderVerb={leaderIsIdle ? undefined : leaderVerb}
          leaderIdleText={leaderIsIdle ? 'Idle' : undefined}
          leaderTokenCount={leaderTokenCount}
        />
      ) : showExpandedTodos && tasksV2 && tasksV2.length > 0 ? (
        <Box width="100%" flexDirection="column">
          <MessageResponse>
            <TaskListV2 tasks={tasksV2} />
          </MessageResponse>
        </Box>
      ) : nextTask || effectiveTip || budgetText ? (
        // 重要：我们需要此 width="100%" 以避免 Ink bug ——
        // 当终端非常小时，tip 会在 spinner 运行期间一遍又一遍地重复。
        // TODO：在 Ink 中修复此问题。
        <Box width="100%" flexDirection="column">
          {budgetText && (
            <MessageResponse>
              <Text dimColor>{budgetText}</Text>
            </MessageResponse>
          )}
          {(nextTask || effectiveTip) && (
            <MessageResponse>
              <Text dimColor>{nextTask ? `Next: ${nextTask.subject}` : `Tip: ${effectiveTip}`}</Text>
            </MessageResponse>
          )}
        </Box>
      ) : null}
    </Box>
  );
}

// Brief/assistant 模式 spinner：单行状态。PromptInput 在 isBriefOnly
// 活动时丢弃其自身的 marginTop，所以此组件拥有
// messages 和 input 之间的 2 行 footprint。Footprint 为 [blank, content]
// —— 上方一个空行（在消息列表下方留出呼吸空间），spinner
// 紧贴 input bar。PromptInput 的 absolute-positioned
// Notifications 覆盖在 brief 模式下通过 marginTop=-2 补偿
// （PromptInput.tsx:~2928），使其浮动到 spinner
// 上方的空行中，而不是覆盖 spinner 内容。与 BriefIdleStatus 配对，
// 后者在空闲时保持相同的 footprint。
type BriefSpinnerProps = {
  mode: SpinnerMode;
  overrideMessage?: string | null;
};

function BriefSpinner({ mode, overrideMessage }: BriefSpinnerProps): React.ReactNode {
  const settings = useSettings();
  const reducedMotion = settings.prefersReducedMotion ?? false;
  const [randomVerb] = useState(() => sample(getSpinnerVerbs()) ?? 'Working');
  const verb = overrideMessage ?? randomVerb;
  const connStatus = useAppState(s => s.remoteConnectionStatus);

  // 跟踪 CLI 活动，使 OS/IDE "busy" 指示器在 brief 模式下也触发
  useEffect(() => {
    const operationId = 'spinner-' + mode;
    activityManager.startCLIActivity(operationId);
    return () => {
      activityManager.endCLIActivity(operationId);
    };
  }, [mode]);

  // 从共享时钟驱动 dot cycle 和 shimmer。viewport
  // ref 未使用 —— spinner 在 turn 结束时卸载，所以基于 viewport 的
  // 暂停不需要。
  const [, time] = useAnimationFrame(reducedMotion ? null : 120);

  // Local tasks + remote tasks 是互斥的（viewer 模式有
  // 空的 local AppState.tasks；local 模式有 remoteBackgroundTaskCount=0）。
  // 相加可避免 mode 分支。
  const runningCount = useAppState(s => count(Object.values(s.tasks), isBackgroundTask) + s.remoteBackgroundTaskCount);

  // 连接问题覆盖 verb —— `claude assistant` 是纯 viewer，
  // WS 宕机时没有有用的操作发生。
  const showConnWarning = connStatus === 'reconnecting' || connStatus === 'disconnected';
  const connText = connStatus === 'reconnecting' ? 'Reconnecting' : 'Disconnected';

  // Dots 填充到固定 3 列，使右对齐的计数在 cycle 推进时
  // 不抖动。
  const dotFrame = Math.floor(time / 300) % 3;
  const dots = reducedMotion ? '…  ' : '.'.repeat(dotFrame + 1).padEnd(3);

  // Shimmer：在 verb 上做反向扫描高亮。跳过连接
  // 警告（shimmer 读作 "working"；Reconnecting/Disconnected 不是）。
  const verbWidth = useMemo(() => stringWidth(verb), [verb]);
  const glimmerIndex =
    reducedMotion || showConnWarning ? -100 : computeGlimmerIndex(Math.floor(time / SHIMMER_INTERVAL_MS), verbWidth);
  const { before, shimmer, after } = computeShimmerSegments(verb, glimmerIndex);

  const { columns } = useTerminalSize();
  const rightText = runningCount > 0 ? `${runningCount} in background` : '';
  // 通过 space padding 手动右对齐 —— FullscreenLayout
  // `main` slot 内的 flexGrow spacer 无法解析宽度，并导致
  // diff engine 遗漏 dot-frame 更新。
  const leftWidth = (showConnWarning ? stringWidth(connText) : verbWidth) + 3;
  const pad = Math.max(1, columns - 2 - leftWidth - stringWidth(rightText));

  return (
    <Box flexDirection="row" width="100%" marginTop={1} paddingLeft={2}>
      {showConnWarning ? (
        <Text color="error">{connText + dots}</Text>
      ) : (
        <>
          {before ? <Text dimColor>{before}</Text> : null}
          {shimmer ? <Text>{shimmer}</Text> : null}
          {after ? <Text dimColor>{after}</Text> : null}
          <Text dimColor>{dots}</Text>
        </>
      )}
      {rightText ? (
        <>
          <Text>{' '.repeat(pad)}</Text>
          <Text color="subtle">{rightText}</Text>
        </>
      ) : null}
    </Box>
  );
}

// brief 模式的 idle 占位符。与 BriefSpinner 相同的 2 行 [blank, content] footprint，
// 使 input bar 在 working/idle/disconnected 之间切换时永不跳动。
// 关于 Notifications overlay 耦合，请参阅 BriefSpinner 的注释。
export function BriefIdleStatus(): React.ReactNode {
  const connStatus = useAppState(s => s.remoteConnectionStatus);
  const runningCount = useAppState(s => count(Object.values(s.tasks), isBackgroundTask) + s.remoteBackgroundTaskCount);
  const { columns } = useTerminalSize();

  const showConnWarning = connStatus === 'reconnecting' || connStatus === 'disconnected';
  const connText = connStatus === 'reconnecting' ? 'Reconnecting…' : 'Disconnected';
  const leftText = showConnWarning ? connText : '';
  const rightText = runningCount > 0 ? `${runningCount} in background` : '';

  if (!leftText && !rightText) return <Box height={2} />;

  const pad = Math.max(1, columns - 2 - stringWidth(leftText) - stringWidth(rightText));
  return (
    <Box marginTop={1} paddingLeft={2}>
      <Text>
        {leftText ? <Text color="error">{leftText}</Text> : null}
        {rightText ? (
          <>
            <Text>{' '.repeat(pad)}</Text>
            <Text color="subtle">{rightText}</Text>
          </>
        ) : null}
      </Text>
    </Box>
  );
}

export function Spinner(): React.ReactNode {
  const settings = useSettings();
  const reducedMotion = settings.prefersReducedMotion ?? false;
  const [ref, time] = useAnimationFrame(reducedMotion ? null : 120);

  // 减少动画：静态 dot 而非动画 spinner
  if (reducedMotion) {
    return (
      <Box ref={ref} flexWrap="wrap" height={1} width={2}>
        <Text color="text">●</Text>
      </Box>
    );
  }

  // 从同步时间派生 frame —— 所有 spinner 一起动画
  const frame = Math.floor(time / 120) % SPINNER_FRAMES.length;

  return (
    <Box ref={ref} flexWrap="wrap" height={1} width={2}>
      <Text color="text">{SPINNER_FRAMES[frame]}</Text>
    </Box>
  );
}

function findNextPendingTask(tasks: Task[] | undefined): Task | undefined {
  if (!tasks) {
    return undefined;
  }
  const pendingTasks = tasks.filter(t => t.status === 'pending');
  if (pendingTasks.length === 0) {
    return undefined;
  }
  const unresolvedIds = new Set(tasks.filter(t => t.status !== 'completed').map(t => t.id));
  return pendingTasks.find(t => !t.blockedBy.some(id => unresolvedIds.has(id))) ?? pendingTasks[0];
}
