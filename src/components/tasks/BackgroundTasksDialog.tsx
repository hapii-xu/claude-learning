import { feature } from 'bun:bundle';
import figures from 'figures';
import React, { type ReactNode, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { isCoordinatorMode } from 'src/coordinator/coordinatorMode.js';
import { useTerminalSize } from 'src/hooks/useTerminalSize.js';
import { useAppState, useSetAppState } from 'src/state/AppState.js';
import { enterTeammateView, exitTeammateView } from 'src/state/teammateViewHelpers.js';
import type { ToolUseContext } from 'src/Tool.js';
import { DreamTask, type DreamTaskState } from 'src/tasks/DreamTask/DreamTask.js';
import { InProcessTeammateTask } from 'src/tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import type { InProcessTeammateTaskState } from 'src/tasks/InProcessTeammateTask/types.js';
import type { LocalAgentTaskState } from 'src/tasks/LocalAgentTask/LocalAgentTask.js';
import { LocalAgentTask } from 'src/tasks/LocalAgentTask/LocalAgentTask.js';
import type { LocalShellTaskState } from 'src/tasks/LocalShellTask/guards.js';
import { LocalShellTask } from 'src/tasks/LocalShellTask/LocalShellTask.js';
// Type import 在构建期会被擦除 — 即使模块受 ant 门控，也是安全的。
import type { LocalWorkflowTaskState } from 'src/tasks/LocalWorkflowTask/LocalWorkflowTask.js';
import type { MonitorMcpTaskState } from 'src/tasks/MonitorMcpTask/MonitorMcpTask.js';
import { RemoteAgentTask, type RemoteAgentTaskState } from 'src/tasks/RemoteAgentTask/RemoteAgentTask.js';
import { type BackgroundTaskState, isBackgroundTask, type TaskState } from 'src/tasks/types.js';
import type { DeepImmutable } from 'src/types/utils.js';
import { intersperse } from 'src/utils/array.js';
import { TEAM_LEAD_NAME } from 'src/utils/swarm/constants.js';
import { stopUltraplan } from '../../commands/ultraplan.js';
import type { CommandResultDisplay } from '../../commands.js';
import { useRegisterOverlay } from '../../context/overlayContext.js';
import type { ExitState } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { type KeyboardEvent, Box, Text } from '@anthropic/ink';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import { count } from '../../utils/array.js';
import { Byline, Dialog, KeyboardShortcutHint } from '@anthropic/ink';
import { AsyncAgentDetailDialog } from './AsyncAgentDetailDialog.js';
import { BackgroundTask as BackgroundTaskComponent } from './BackgroundTask.js';
import { DreamDetailDialog } from './DreamDetailDialog.js';
import { InProcessTeammateDetailDialog } from './InProcessTeammateDetailDialog.js';
import { RemoteSessionDetailDialog } from './RemoteSessionDetailDialog.js';
import { ShellDetailDialog } from './ShellDetailDialog.js';

type ViewState = { mode: 'list' } | { mode: 'detail'; itemId: string };

type Props = {
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void;
  toolUseContext: ToolUseContext;
  initialDetailTaskId?: string;
};

type ListItem =
  | {
      id: string;
      type: 'local_bash';
      label: string;
      status: string;
      task: DeepImmutable<LocalShellTaskState>;
    }
  | {
      id: string;
      type: 'remote_agent';
      label: string;
      status: string;
      task: DeepImmutable<RemoteAgentTaskState>;
    }
  | {
      id: string;
      type: 'local_agent';
      label: string;
      status: string;
      task: DeepImmutable<LocalAgentTaskState>;
    }
  | {
      id: string;
      type: 'in_process_teammate';
      label: string;
      status: string;
      task: DeepImmutable<InProcessTeammateTaskState>;
    }
  | {
      id: string;
      type: 'local_workflow';
      label: string;
      status: string;
      task: DeepImmutable<LocalWorkflowTaskState>;
    }
  | {
      id: string;
      type: 'monitor_mcp';
      label: string;
      status: string;
      task: DeepImmutable<MonitorMcpTaskState>;
    }
  | {
      id: string;
      type: 'dream';
      label: string;
      status: string;
      task: DeepImmutable<DreamTaskState>;
    }
  | {
      id: string;
      type: 'leader';
      label: string;
      status: 'running';
    };

// WORKFLOW_SCRIPTS 仅 ant 可用（build_flags.yaml）。静态 import 会把约 1.3K 行
// 泄漏到外部构建中。使用 feature() + require 门控，让打包器可以对该分支做死代码消除。
/* eslint-disable @typescript-eslint/no-require-imports */
// WorkflowDetailDialog 已移除：workflow 详情改由 /workflows 面板展示。
const workflowTaskModule = feature('WORKFLOW_SCRIPTS')
  ? (require('src/tasks/LocalWorkflowTask/LocalWorkflowTask.js') as typeof import('src/tasks/LocalWorkflowTask/LocalWorkflowTask.js'))
  : null;
const killWorkflowTask = workflowTaskModule?.killWorkflowTask ?? null;
// skipWorkflowAgent / retryWorkflowAgent 仅由 /workflows 面板调用（原详情对话框已移除）。
// 相对路径，不是 `src/...` 路径映射 — Bun 的 DCE 可以静态解析并消除
// `./` require，但路径映射字符串会保持不透明并作为死字面量留在 bundle 中。
// 与 tasks.ts 的模式一致。
const monitorMcpModule = feature('MONITOR_TOOL')
  ? (require('../../tasks/MonitorMcpTask/MonitorMcpTask.js') as typeof import('../../tasks/MonitorMcpTask/MonitorMcpTask.js'))
  : null;
const killMonitorMcp = monitorMcpModule?.killMonitorMcp ?? null;
const MonitorMcpDetailDialog = feature('MONITOR_TOOL')
  ? (require('./MonitorMcpDetailDialog.js') as typeof import('./MonitorMcpDetailDialog.js')).MonitorMcpDetailDialog
  : null;
/* eslint-enable @typescript-eslint/no-require-imports */

// 辅助函数：获取过滤后的后台 task（排除前台化的 local_agent）
function getSelectableBackgroundTasks(
  tasks: Record<string, TaskState> | undefined,
  foregroundedTaskId: string | undefined,
): TaskState[] {
  const backgroundTasks = Object.values(tasks ?? {}).filter(isBackgroundTask);
  return backgroundTasks.filter(task => !(task.type === 'local_agent' && task.id === foregroundedTaskId));
}

export function BackgroundTasksDialog({ onDone, toolUseContext, initialDetailTaskId }: Props): React.ReactNode {
  const tasks = useAppState(s => s.tasks);
  const foregroundedTaskId = useAppState(s => s.foregroundedTaskId);
  const showSpinnerTree = useAppState(s => s.expandedView) === 'teammates';
  const setAppState = useSetAppState();
  const killAgentsShortcut = useShortcutDisplay('chat:killAgents', 'Chat', 'ctrl+x ctrl+k');
  const typedTasks = tasks as Record<string, TaskState> | undefined;

  // 跟踪挂载时是否跳过了列表视图（用于返回按钮的行为）
  const skippedListOnMount = useRef(false);

  // 计算初始视图状态 — 如果调用方提供了具体 task，或只有一个 task，则跳过列表
  const [viewState, setViewState] = useState<ViewState>(() => {
    if (initialDetailTaskId) {
      skippedListOnMount.current = true;
      return { mode: 'detail', itemId: initialDetailTaskId };
    }
    const allItems = getSelectableBackgroundTasks(typedTasks, foregroundedTaskId);
    if (allItems.length === 1) {
      skippedListOnMount.current = true;
      return { mode: 'detail', itemId: allItems[0]!.id };
    }
    return { mode: 'list' };
  });
  const [selectedIndex, setSelectedIndex] = useState<number>(0);

  // 注册为 modal overlay，以便此对话框打开期间父级 Chat 的快捷键
  // （up/down 用于历史）被停用
  useRegisterOverlay('background-tasks-dialog');

  // 把排序和分类后的项一起 memoize，以保证引用稳定
  const {
    bashTasks,
    remoteSessions,
    agentTasks,
    teammateTasks,
    workflowTasks,
    mcpMonitors,
    dreamTasks,
    allSelectableItems,
  } = useMemo(() => {
    // 只展示 running/pending 的后台 task，与状态栏计数一致
    const backgroundTasks = Object.values(typedTasks ?? {}).filter(isBackgroundTask);
    const allItems = backgroundTasks.map(toListItem);
    const sorted = allItems.sort((a, b) => {
      const aStatus = a.status;
      const bStatus = b.status;
      if (aStatus === 'running' && bStatus !== 'running') return -1;
      if (aStatus !== 'running' && bStatus === 'running') return 1;
      const aTime = 'task' in a ? a.task.startTime : 0;
      const bTime = 'task' in b ? b.task.startTime : 0;
      return bTime - aTime;
    });
    const bash = sorted.filter(item => item.type === 'local_bash');
    const remote = sorted.filter(item => item.type === 'remote_agent');
    // 排除前台化的 task — 它正在主 UI 中被查看，不是后台 task
    const agent = sorted.filter(item => item.type === 'local_agent' && item.id !== foregroundedTaskId);
    const workflows = sorted.filter(item => item.type === 'local_workflow');
    const monitorMcp = sorted.filter(item => item.type === 'monitor_mcp');
    const dreamTasks = sorted.filter(item => item.type === 'dream');
    // 在 spinner-tree 模式下，从对话框中排除 teammate（它们出现在 tree 中）
    const teammates = showSpinnerTree ? [] : sorted.filter(item => item.type === 'in_process_teammate');
    // 当有 teammate 时加入 leader 条目，让用户可以切回 leader 前台
    const leaderItem: ListItem[] =
      teammates.length > 0
        ? [
            {
              id: '__leader__',
              type: 'leader',
              label: `@${TEAM_LEAD_NAME}`,
              status: 'running',
            },
          ]
        : [];
    return {
      bashTasks: bash,
      remoteSessions: remote,
      agentTasks: agent,
      workflowTasks: workflows,
      mcpMonitors: monitorMcp,
      dreamTasks,
      teammateTasks: [...leaderItem, ...teammates],
      // 顺序必须与 JSX 渲染顺序一致（teammates → bash → monitorMcp →
      // remote → agent → workflows → dream），这样 ↓/↑ 导航时光标在视觉上向下移动。
      allSelectableItems: [
        ...leaderItem,
        ...teammates,
        ...bash,
        ...monitorMcp,
        ...remote,
        ...agent,
        ...workflows,
        ...dreamTasks,
      ],
    };
  }, [typedTasks, foregroundedTaskId, showSpinnerTree]);

  const currentSelection = allSelectableItems[selectedIndex] ?? null;

  // 使用可配置的快捷键处理标准导航和 confirm/cancel。
  // confirm:no 由 Dialog 的 onCancel prop 处理。
  useKeybindings(
    {
      'confirm:previous': () => setSelectedIndex(prev => Math.max(0, prev - 1)),
      'confirm:next': () => setSelectedIndex(prev => Math.min(allSelectableItems.length - 1, prev + 1)),
      'confirm:yes': () => {
        const current = allSelectableItems[selectedIndex];
        if (current) {
          if (current.type === 'leader') {
            exitTeammateView(setAppState);
            onDone('Viewing leader', { display: 'system' });
          } else {
            setViewState({ mode: 'detail', itemId: current.id });
          }
        }
      },
    },
    { context: 'Confirmation', isActive: viewState.mode === 'list' },
  );

  // 组件专属快捷键（x=停止、f=前台、right=放大）显示在 UI 中。
  // 这些是依赖 task 类型和状态的快捷键，不是标准对话框快捷键。
  const handleKeyDown = (e: KeyboardEvent) => {
    // 仅在 list 模式下处理输入
    if (viewState.mode !== 'list') return;

    if (e.key === 'left') {
      e.preventDefault();
      onDone('Background tasks dialog dismissed', { display: 'system' });
      return;
    }

    // 在按键时计算当前选中项
    const currentSelection = allSelectableItems[selectedIndex];
    if (!currentSelection) return; // 下方所有操作都需要有选中项

    if (e.key === 'x') {
      e.preventDefault();
      if (currentSelection.type === 'local_bash' && currentSelection.status === 'running') {
        void killShellTask(currentSelection.id);
      } else if (currentSelection.type === 'local_agent' && currentSelection.status === 'running') {
        void killAgentTask(currentSelection.id);
      } else if (currentSelection.type === 'in_process_teammate' && currentSelection.status === 'running') {
        void killTeammateTask(currentSelection.id);
      } else if (
        currentSelection.type === 'local_workflow' &&
        currentSelection.status === 'running' &&
        killWorkflowTask
      ) {
        killWorkflowTask(currentSelection.id, setAppState);
      } else if (currentSelection.type === 'monitor_mcp' && currentSelection.status === 'running' && killMonitorMcp) {
        killMonitorMcp(currentSelection.id, setAppState);
      } else if (currentSelection.type === 'dream' && currentSelection.status === 'running') {
        void killDreamTask(currentSelection.id);
      } else if (currentSelection.type === 'remote_agent' && currentSelection.status === 'running') {
        if (currentSelection.task.isUltraplan) {
          void stopUltraplan(currentSelection.id, currentSelection.task.sessionId, setAppState);
        } else {
          void killRemoteAgentTask(currentSelection.id);
        }
      }
    }

    if (e.key === 'f') {
      if (currentSelection.type === 'in_process_teammate' && currentSelection.status === 'running') {
        e.preventDefault();
        enterTeammateView(currentSelection.id, setAppState);
        onDone('Viewing teammate', { display: 'system' });
      } else if (currentSelection.type === 'leader') {
        e.preventDefault();
        exitTeammateView(setAppState);
        onDone('Viewing leader', { display: 'system' });
      }
    }
  };

  async function killShellTask(taskId: string): Promise<void> {
    await LocalShellTask.kill(taskId, setAppState);
  }

  async function killAgentTask(taskId: string): Promise<void> {
    await LocalAgentTask.kill(taskId, setAppState);
  }

  async function killTeammateTask(taskId: string): Promise<void> {
    await InProcessTeammateTask.kill(taskId, setAppState);
  }

  async function killDreamTask(taskId: string): Promise<void> {
    await DreamTask.kill(taskId, setAppState);
  }

  async function killRemoteAgentTask(taskId: string): Promise<void> {
    await RemoteAgentTask.kill(taskId, setAppState);
  }

  // 用 useEffectEvent 包裹 onDone 以获得稳定引用，始终调用当前的 onDone 回调，
  // 而不会导致 effect 重新触发。
  const onDoneEvent = useEffectEvent(onDone);

  useEffect(() => {
    if (viewState.mode !== 'list') {
      const task = (typedTasks ?? {})[viewState.itemId];
      // Workflow task 有宽限：其详情视图在完成前保持打开，
      // 以便用户在被清除前看到最终状态。
      if (!task || (task.type !== 'local_workflow' && !isBackgroundTask(task))) {
        // task 已被移除或不再是后台 task（例如被 kill）。
        // 如果挂载时跳过了列表，就关闭整个对话框。
        if (skippedListOnMount.current) {
          onDoneEvent('Background tasks dialog dismissed', {
            display: 'system',
          });
        } else {
          setViewState({ mode: 'list' });
        }
      }
    }

    const totalItems = allSelectableItems.length;
    if (selectedIndex >= totalItems && totalItems > 0) {
      setSelectedIndex(totalItems - 1);
    }
  }, [viewState, typedTasks, selectedIndex, allSelectableItems, onDoneEvent]);

  // 返回列表视图的辅助函数（或：如果挂载时跳过了列表且当前仍只有 ≤1 个项，则关闭对话框）。
  // 检查当前计数可避免陈旧状态陷阱：如果你在只有 1 个 task 时打开（自动跳到详情），
  // 随后第二个 task 启动，"返回" 应展示列表 — 而不是关闭。
  const goBackToList = () => {
    if (skippedListOnMount.current && allSelectableItems.length <= 1) {
      onDone('Background tasks dialog dismissed', { display: 'system' });
    } else {
      skippedListOnMount.current = false;
      setViewState({ mode: 'list' });
    }
  };

  // 如果选中了某项，则展示对应视图
  if (viewState.mode !== 'list' && typedTasks) {
    const task = typedTasks[viewState.itemId];
    if (!task) {
      return null;
    }

    // 详情模式 — 展示对应的详情对话框
    switch (task.type) {
      case 'local_bash':
        return (
          <ShellDetailDialog
            shell={task}
            onDone={onDone}
            onKillShell={() => void killShellTask(task.id)}
            onBack={goBackToList}
            key={`shell-${task.id}`}
          />
        );
      case 'local_agent':
        return (
          <AsyncAgentDetailDialog
            agent={task}
            onDone={onDone}
            onKillAgent={() => void killAgentTask(task.id)}
            onBack={goBackToList}
            key={`agent-${task.id}`}
          />
        );
      case 'remote_agent':
        return (
          <RemoteSessionDetailDialog
            session={task}
            onDone={onDone}
            toolUseContext={toolUseContext}
            onBack={goBackToList}
            onKill={
              task.status !== 'running'
                ? undefined
                : task.isUltraplan
                  ? () => void stopUltraplan(task.id, task.sessionId, setAppState)
                  : () => void killRemoteAgentTask(task.id)
            }
            key={`session-${task.id}`}
          />
        );
      case 'in_process_teammate':
        return (
          <InProcessTeammateDetailDialog
            teammate={task}
            onDone={onDone}
            onKill={task.status === 'running' ? () => void killTeammateTask(task.id) : undefined}
            onBack={goBackToList}
            onForeground={
              task.status === 'running'
                ? () => {
                    enterTeammateView(task.id, setAppState);
                    onDone('Viewing teammate', { display: 'system' });
                  }
                : undefined
            }
            key={`teammate-${task.id}`}
          />
        );
      case 'local_workflow': {
        // shift+下/Enter 进入的 workflow 详情。原 WorkflowDetailDialog 已移除，
        // 详情改由 /workflows 面板展示，但此处仍需一个能退出的占位视图——
        // 否则用户进入后 Esc/←/q 全无效，卡死。照 MonitorMcpDetailDialog 模式：
        // ←/Esc 返回（goBackToList：单任务关闭、多任务回列表），x kill（running）。
        const onKill =
          task.status === 'running' && killWorkflowTask ? () => killWorkflowTask(task.id, setAppState) : undefined;
        return (
          <Box
            key={`workflow-${task.id}`}
            flexDirection="column"
            tabIndex={0}
            borderStyle="round"
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'left') {
                e.preventDefault();
                goBackToList();
              } else if (e.key === 'x' && onKill) {
                e.preventDefault();
                onKill();
              }
            }}
          >
            <Dialog
              title={task.workflowName}
              subtitle={
                <Text dimColor>
                  {task.status}
                  {task.summary ? ` · ${task.summary}` : ''}
                </Text>
              }
              onCancel={goBackToList}
              inputGuide={() => (
                <Byline>
                  <KeyboardShortcutHint shortcut="←" action="返回" />
                  <KeyboardShortcutHint shortcut="Esc" action="关闭" />
                  {onKill && <KeyboardShortcutHint shortcut="x" action="停止" />}
                </Byline>
              )}
            >
              {task.status === 'failed' && task.error ? (
                <Box flexDirection="column">
                  <Text color="error">失败原因：{task.error}</Text>
                  <Text color="subtle">用 /workflows 查看阶段与 agent 实时进度</Text>
                </Box>
              ) : (
                <Text color="subtle">用 /workflows 查看阶段与 agent 实时进度</Text>
              )}
            </Dialog>
          </Box>
        );
      }
      case 'monitor_mcp':
        if (!MonitorMcpDetailDialog) return null;
        return (
          <MonitorMcpDetailDialog
            task={task}
            onKill={
              task.status === 'running' && killMonitorMcp ? () => killMonitorMcp(task.id, setAppState) : undefined
            }
            onBack={goBackToList}
            key={`monitor-mcp-${task.id}`}
          />
        );
      case 'dream':
        return (
          <DreamDetailDialog
            task={task}
            onDone={() =>
              onDone('Background tasks dialog dismissed', {
                display: 'system',
              })
            }
            onBack={goBackToList}
            onKill={task.status === 'running' ? () => void killDreamTask(task.id) : undefined}
            key={`dream-${task.id}`}
          />
        );
    }
  }

  const runningBashCount = count(bashTasks, _ => _.status === 'running');
  const runningAgentCount =
    count(remoteSessions, _ => _.status === 'running' || _.status === 'pending') +
    count(agentTasks, _ => _.status === 'running');
  const runningTeammateCount = count(teammateTasks, _ => _.status === 'running');
  const subtitle = intersperse(
    [
      ...(runningTeammateCount > 0 ? [<Text key="teammates">{runningTeammateCount} 个 Agent</Text>] : []),
      ...(runningBashCount > 0 ? [<Text key="shells">{runningBashCount} 个活跃 Shell</Text>] : []),
      ...(runningAgentCount > 0 ? [<Text key="agents">{runningAgentCount} 个活跃 Agent</Text>] : []),
    ],
    index => <Text key={`separator-${index}`}> · </Text>,
  );

  const actions = [
    <KeyboardShortcutHint key="upDown" shortcut="↑/↓" action="选择" />,
    <KeyboardShortcutHint key="enter" shortcut="Enter" action="查看" />,
    ...(currentSelection?.type === 'in_process_teammate' && currentSelection.status === 'running'
      ? [<KeyboardShortcutHint key="foreground" shortcut="f" action="前台" />]
      : []),
    ...((currentSelection?.type === 'local_bash' ||
      currentSelection?.type === 'local_agent' ||
      currentSelection?.type === 'in_process_teammate' ||
      currentSelection?.type === 'local_workflow' ||
      currentSelection?.type === 'monitor_mcp' ||
      currentSelection?.type === 'dream' ||
      currentSelection?.type === 'remote_agent') &&
    currentSelection.status === 'running'
      ? [<KeyboardShortcutHint key="kill" shortcut="x" action="停止" />]
      : []),
    ...(agentTasks.some(t => t.status === 'running')
      ? [<KeyboardShortcutHint key="kill-all" shortcut={killAgentsShortcut} action="停止所有 Agent" />]
      : []),
    <KeyboardShortcutHint key="esc" shortcut="←/Esc" action="关闭" />,
  ];

  const handleCancel = () => onDone('Background tasks dialog dismissed', { display: 'system' });

  function renderInputGuide(exitState: ExitState): React.ReactNode {
    if (exitState.pending) {
      return <Text>再次按 {exitState.keyName} 退出</Text>;
    }
    return <Byline>{actions}</Byline>;
  }

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title="后台任务"
        subtitle={<>{subtitle}</>}
        onCancel={handleCancel}
        color="background"
        inputGuide={renderInputGuide}
      >
        {allSelectableItems.length === 0 ? (
          <Text dimColor>当前没有运行中的任务</Text>
        ) : (
          <Box flexDirection="column">
            {teammateTasks.length > 0 && (
              <Box flexDirection="column">
                {(bashTasks.length > 0 || remoteSessions.length > 0 || agentTasks.length > 0) && (
                  <Text dimColor>
                    <Text bold>{'  '}Agent</Text> ({count(teammateTasks, i => i.type !== 'leader')})
                  </Text>
                )}
                <Box flexDirection="column">
                  <TeammateTaskGroups teammateTasks={teammateTasks} currentSelectionId={currentSelection?.id} />
                </Box>
              </Box>
            )}

            {bashTasks.length > 0 && (
              <Box flexDirection="column" marginTop={teammateTasks.length > 0 ? 1 : 0}>
                {(teammateTasks.length > 0 || remoteSessions.length > 0 || agentTasks.length > 0) && (
                  <Text dimColor>
                    <Text bold>{'  '}Shell</Text> ({bashTasks.length})
                  </Text>
                )}
                <Box flexDirection="column">
                  {bashTasks.map(item => (
                    <Item key={item.id} item={item} isSelected={item.id === currentSelection?.id} />
                  ))}
                </Box>
              </Box>
            )}

            {mcpMonitors.length > 0 && (
              <Box flexDirection="column" marginTop={teammateTasks.length > 0 || bashTasks.length > 0 ? 1 : 0}>
                <Text dimColor>
                  <Text bold>{'  '}监控</Text> ({mcpMonitors.length})
                </Text>
                <Box flexDirection="column">
                  {mcpMonitors.map(item => (
                    <Item key={item.id} item={item} isSelected={item.id === currentSelection?.id} />
                  ))}
                </Box>
              </Box>
            )}

            {remoteSessions.length > 0 && (
              <Box
                flexDirection="column"
                marginTop={teammateTasks.length > 0 || bashTasks.length > 0 || mcpMonitors.length > 0 ? 1 : 0}
              >
                <Text dimColor>
                  <Text bold>{'  '}远程 Agent</Text> ({remoteSessions.length})
                </Text>
                <Box flexDirection="column">
                  {remoteSessions.map(item => (
                    <Item key={item.id} item={item} isSelected={item.id === currentSelection?.id} />
                  ))}
                </Box>
              </Box>
            )}

            {agentTasks.length > 0 && (
              <Box
                flexDirection="column"
                marginTop={
                  teammateTasks.length > 0 ||
                  bashTasks.length > 0 ||
                  mcpMonitors.length > 0 ||
                  remoteSessions.length > 0
                    ? 1
                    : 0
                }
              >
                <Text dimColor>
                  <Text bold>{'  '}本地 Agent</Text> ({agentTasks.length})
                </Text>
                <Box flexDirection="column">
                  {agentTasks.map(item => (
                    <Item key={item.id} item={item} isSelected={item.id === currentSelection?.id} />
                  ))}
                </Box>
              </Box>
            )}

            {workflowTasks.length > 0 && (
              <Box
                flexDirection="column"
                marginTop={
                  teammateTasks.length > 0 ||
                  bashTasks.length > 0 ||
                  mcpMonitors.length > 0 ||
                  remoteSessions.length > 0 ||
                  agentTasks.length > 0
                    ? 1
                    : 0
                }
              >
                <Text dimColor>
                  <Text bold>{'  '}工作流</Text> ({workflowTasks.length})
                </Text>
                <Box flexDirection="column">
                  {workflowTasks.map(item => (
                    <Item key={item.id} item={item} isSelected={item.id === currentSelection?.id} />
                  ))}
                </Box>
              </Box>
            )}

            {dreamTasks.length > 0 && (
              <Box
                flexDirection="column"
                marginTop={
                  teammateTasks.length > 0 ||
                  bashTasks.length > 0 ||
                  mcpMonitors.length > 0 ||
                  remoteSessions.length > 0 ||
                  agentTasks.length > 0 ||
                  workflowTasks.length > 0
                    ? 1
                    : 0
                }
              >
                <Box flexDirection="column">
                  {dreamTasks.map(item => (
                    <Item key={item.id} item={item} isSelected={item.id === currentSelection?.id} />
                  ))}
                </Box>
              </Box>
            )}
          </Box>
        )}
      </Dialog>
    </Box>
  );
}

function toListItem(task: BackgroundTaskState): ListItem {
  switch (task.type) {
    case 'local_bash':
      return {
        id: task.id,
        type: 'local_bash',
        label: task.kind === 'monitor' ? task.description : task.command,
        status: task.status,
        task,
      };
    case 'remote_agent':
      return {
        id: task.id,
        type: 'remote_agent',
        label: task.title,
        status: task.status,
        task,
      };
    case 'local_agent':
      return {
        id: task.id,
        type: 'local_agent',
        label: task.description,
        status: task.status,
        task,
      };
    case 'in_process_teammate':
      return {
        id: task.id,
        type: 'in_process_teammate',
        label: `@${task.identity.agentName}`,
        status: task.status,
        task,
      };
    case 'local_workflow':
      return {
        id: task.id,
        type: 'local_workflow',
        label: task.summary ?? task.description,
        status: task.status,
        task,
      };
    case 'monitor_mcp':
      return {
        id: task.id,
        type: 'monitor_mcp',
        label: task.description,
        status: task.status,
        task,
      };
    case 'dream':
      return {
        id: task.id,
        type: 'dream',
        label: task.description,
        status: task.status,
        task,
      };
  }
}

function Item({ item, isSelected }: { item: ListItem; isSelected: boolean }): ReactNode {
  const { columns } = useTerminalSize();
  // Dialog 边框（2）+ 内边距（2）+ 指针前缀（2）+ 名字/状态开销（~20）
  const maxActivityWidth = Math.max(30, columns - 26);
  // 在 coordinator 模式下，使用灰色指针而非蓝色
  const useGreyPointer = isCoordinatorMode();

  return (
    <Box flexDirection="row">
      <Text dimColor={useGreyPointer && isSelected}>{isSelected ? figures.pointer + ' ' : '  '}</Text>
      <Text color={isSelected && !useGreyPointer ? 'suggestion' : undefined}>
        {item.type === 'leader' ? (
          <Text>@{TEAM_LEAD_NAME}</Text>
        ) : (
          <BackgroundTaskComponent task={item.task} maxActivityWidth={maxActivityWidth} />
        )}
      </Text>
    </Box>
  );
}

function TeammateTaskGroups({
  teammateTasks,
  currentSelectionId,
}: {
  teammateTasks: ListItem[];
  currentSelectionId: string | undefined;
}): ReactNode {
  // 把 leader 从 teammate 中分离出来，按 team 分组 teammate
  const leaderItems = teammateTasks.filter(i => i.type === 'leader');
  const teammateItems = teammateTasks.filter(i => i.type === 'in_process_teammate');
  const teams = new Map<string, typeof teammateItems>();
  for (const item of teammateItems) {
    const teamName = item.task.identity.teamName;
    const group = teams.get(teamName);
    if (group) {
      group.push(item);
    } else {
      teams.set(teamName, [item]);
    }
  }
  const teamEntries = [...teams.entries()];
  return (
    <>
      {teamEntries.map(([teamName, items]) => {
        const memberCount = items.length + leaderItems.length;
        return (
          <Box key={teamName} flexDirection="column">
            <Text dimColor>
              {'  '}团队: {teamName} ({memberCount})
            </Text>
            {/* Render leader first within each team */}
            {leaderItems.map(item => (
              <Item key={`${item.id}-${teamName}`} item={item} isSelected={item.id === currentSelectionId} />
            ))}
            {items.map(item => (
              <Item key={item.id} item={item} isSelected={item.id === currentSelectionId} />
            ))}
          </Box>
        );
      })}
    </>
  );
}
