import { randomUUID } from 'crypto';
import figures from 'figures';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInterval } from 'usehooks-ts';
import { useRegisterOverlay } from '../../context/overlayContext.js';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- raw j/k/arrow dialog navigation
import { Box, Text, useInput, stringWidth } from '@anthropic/ink';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import { type AppState, useAppState, useSetAppState } from '../../state/AppState.js';
import { getEmptyToolPermissionContext } from '../../Tool.js';
import { AGENT_COLOR_TO_THEME_COLOR } from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js';
import { logForDebugging } from '../../utils/debug.js';
import { execFileNoThrow } from '../../utils/execFileNoThrow.js';
import { truncateToWidth } from '../../utils/format.js';
import { getNextPermissionMode } from '../../utils/permissions/getNextPermissionMode.js';
import {
  getModeColor,
  type PermissionMode,
  permissionModeFromString,
  permissionModeSymbol,
} from '../../utils/permissions/PermissionMode.js';
import { jsonStringify } from '../../utils/slowOperations.js';
import { IT2_COMMAND, isInsideTmuxSync } from '../../utils/swarm/backends/detection.js';
import { ensureBackendsRegistered, getBackendByType, getCachedBackend } from '../../utils/swarm/backends/registry.js';
import { isPaneBackend, type PaneBackendType } from '../../utils/swarm/backends/types.js';
import { getSwarmSocketName, TMUX_COMMAND } from '../../utils/swarm/constants.js';
import { removeMemberFromTeam, setMemberMode, setMultipleMemberModes } from '../../utils/swarm/teamHelpers.js';
import { listTasks, type Task, unassignTeammateTasks } from '../../utils/tasks.js';
import { getTeammateStatuses, type TeammateStatus, type TeamSummary } from '../../utils/teamDiscovery.js';
import {
  createModeSetRequestMessage,
  sendShutdownRequestToMailbox,
  writeToMailbox,
} from '../../utils/teammateMailbox.js';
import { Dialog } from '@anthropic/ink';
import ThemedText from '../design-system/ThemedText.js';

type Props = {
  initialTeams?: TeamSummary[];
  onDone: () => void;
};

type DialogLevel =
  | { type: 'teammateList'; teamName: string }
  | { type: 'teammateDetail'; teamName: string; memberName: string };

/**
 * 用于查看当前团队中队友的对话框
 */
export function TeamsDialog({ initialTeams, onDone }: Props): React.ReactNode {
  // 注册为 overlay，以免 CancelRequestHandler 拦截 escape
  useRegisterOverlay('teams-dialog');

  // initialTeams 派生自 PromptInput 中的 teamContext（无文件系统 I/O）
  const setAppState = useSetAppState();

  // 如果可用，用第一个团队名称初始化 dialogLevel
  const firstTeamName = initialTeams?.[0]?.name ?? '';
  const [dialogLevel, setDialogLevel] = useState<DialogLevel>({
    type: 'teammateList',
    teamName: firstTeamName,
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  // initialTeams 现在总是从 PromptInput 提供（派生自 teamContext）
  // 这里不需要文件系统 I/O

  const teammateStatuses = useMemo(() => {
    return getTeammateStatuses(dialogLevel.teamName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogLevel.teamName, refreshKey]);

  // 定期刷新以获取队友的模式变更
  useInterval(() => {
    setRefreshKey(k => k + 1);
  }, 1000);

  const currentTeammate = useMemo(() => {
    if (dialogLevel.type !== 'teammateDetail') return null;
    return teammateStatuses.find(t => t.name === dialogLevel.memberName) ?? null;
  }, [dialogLevel, teammateStatuses]);

  // 从 AppState 获取 isBypassPermissionsModeAvailable
  const isBypassAvailable = useAppState(s => s.toolPermissionContext.isBypassPermissionsModeAvailable);

  const goBackToList = (): void => {
    setDialogLevel({ type: 'teammateList', teamName: dialogLevel.teamName });
    setSelectedIndex(0);
  };

  // confirm:cycleMode 处理器 - 循环队友权限模式
  const handleCycleMode = useCallback(() => {
    if (dialogLevel.type === 'teammateDetail' && currentTeammate) {
      // 详情视图：仅循环此队友
      cycleTeammateMode(currentTeammate, dialogLevel.teamName, isBypassAvailable);
      setRefreshKey(k => k + 1);
    } else if (dialogLevel.type === 'teammateList' && teammateStatuses.length > 0) {
      // 列表视图：同步循环所有队友
      cycleAllTeammateModes(teammateStatuses, dialogLevel.teamName, isBypassAvailable);
      setRefreshKey(k => k + 1);
    }
  }, [dialogLevel, currentTeammate, teammateStatuses, isBypassAvailable]);

  // 使用键位绑定进行模式循环
  useKeybindings({ 'confirm:cycleMode': handleCycleMode }, { context: 'Confirmation' });

  useInput((input, key) => {
    // 处理左方向键返回
    if (key.leftArrow) {
      if (dialogLevel.type === 'teammateDetail') {
        goBackToList();
      }
      return;
    }

    // 处理上/下导航
    if (key.upArrow || key.downArrow) {
      const maxIndex = getMaxIndex();
      if (key.upArrow) {
        setSelectedIndex(prev => Math.max(0, prev - 1));
      } else {
        setSelectedIndex(prev => Math.min(maxIndex, prev + 1));
      }
      return;
    }

    // 处理 Enter 以下钻或查看输出
    if (key.return) {
      if (dialogLevel.type === 'teammateList' && teammateStatuses[selectedIndex]) {
        setDialogLevel({
          type: 'teammateDetail',
          teamName: dialogLevel.teamName,
          memberName: teammateStatuses[selectedIndex].name,
        });
      } else if (dialogLevel.type === 'teammateDetail' && currentTeammate) {
        // 查看输出 - 切换到 tmux pane
        void viewTeammateOutput(
          currentTeammate.tmuxPaneId,
          currentTeammate.backendType && isPaneBackend(currentTeammate.backendType)
            ? currentTeammate.backendType
            : undefined,
        );
        onDone();
      }
      return;
    }

    // 处理 'k' 杀死队友
    if (input === 'k') {
      if (dialogLevel.type === 'teammateList' && teammateStatuses[selectedIndex]) {
        void killTeammate(
          teammateStatuses[selectedIndex].tmuxPaneId,
          teammateStatuses[selectedIndex].backendType && isPaneBackend(teammateStatuses[selectedIndex].backendType)
            ? teammateStatuses[selectedIndex].backendType
            : undefined,
          dialogLevel.teamName,
          teammateStatuses[selectedIndex].agentId,
          teammateStatuses[selectedIndex].name,
          setAppState,
        ).then(() => {
          setRefreshKey(k => k + 1);
          // 如有需要调整选中索引
          setSelectedIndex(prev => Math.max(0, Math.min(prev, teammateStatuses.length - 2)));
        });
      } else if (dialogLevel.type === 'teammateDetail' && currentTeammate) {
        void killTeammate(
          currentTeammate.tmuxPaneId,
          currentTeammate.backendType && isPaneBackend(currentTeammate.backendType)
            ? currentTeammate.backendType
            : undefined,
          dialogLevel.teamName,
          currentTeammate.agentId,
          currentTeammate.name,
          setAppState,
        );
        goBackToList();
      }
      return;
    }

    // 处理 's' 关闭所选队友
    if (input === 's') {
      if (dialogLevel.type === 'teammateList' && teammateStatuses[selectedIndex]) {
        const teammate = teammateStatuses[selectedIndex];
        void sendShutdownRequestToMailbox(
          teammate.name,
          dialogLevel.teamName,
          'Graceful shutdown requested by team lead',
        );
      } else if (dialogLevel.type === 'teammateDetail' && currentTeammate) {
        void sendShutdownRequestToMailbox(
          currentTeammate.name,
          dialogLevel.teamName,
          'Graceful shutdown requested by team lead',
        );
        goBackToList();
      }
      return;
    }

    // 处理 'h' 隐藏/显示单个队友（仅对支持的后端）
    if (input === 'h') {
      const backend = getCachedBackend();
      const teammate =
        dialogLevel.type === 'teammateList'
          ? teammateStatuses[selectedIndex]
          : dialogLevel.type === 'teammateDetail'
            ? currentTeammate
            : null;

      if (teammate && backend?.supportsHideShow) {
        void toggleTeammateVisibility(teammate, dialogLevel.teamName).then(() => {
          // 强制刷新队友状态
          setRefreshKey(k => k + 1);
        });
        if (dialogLevel.type === 'teammateDetail') {
          goBackToList();
        }
      }
      return;
    }

    // 处理 'H' 隐藏/显示所有队友（仅对支持的后端）
    if (input === 'H' && dialogLevel.type === 'teammateList') {
      const backend = getCachedBackend();
      if (backend?.supportsHideShow && teammateStatuses.length > 0) {
        // 如果有任何一个可见，则隐藏全部。否则显示全部。
        const anyVisible = teammateStatuses.some(t => !t.isHidden);
        void Promise.all(
          teammateStatuses.map(t =>
            anyVisible ? hideTeammate(t, dialogLevel.teamName) : showTeammate(t, dialogLevel.teamName),
          ),
        ).then(() => {
          // 强制刷新队友状态
          setRefreshKey(k => k + 1);
        });
      }
      return;
    }

    // 处理 'p' 清理（杀死）所有空闲队友
    if (input === 'p' && dialogLevel.type === 'teammateList') {
      const idleTeammates = teammateStatuses.filter(t => t.status === 'idle');
      if (idleTeammates.length > 0) {
        void Promise.all(
          idleTeammates.map(t =>
            killTeammate(
              t.tmuxPaneId,
              t.backendType && isPaneBackend(t.backendType) ? t.backendType : undefined,
              dialogLevel.teamName,
              t.agentId,
              t.name,
              setAppState,
            ),
          ),
        ).then(() => {
          setRefreshKey(k => k + 1);
          setSelectedIndex(prev => Math.max(0, Math.min(prev, teammateStatuses.length - idleTeammates.length - 1)));
        });
      }
      return;
    }

    // 注意：模式循环（shift+tab）通过 useKeybindings 的 confirm:cycleMode 动作处理
  });

  function getMaxIndex(): number {
    if (dialogLevel.type === 'teammateList') {
      return Math.max(0, teammateStatuses.length - 1);
    }
    return 0;
  }

  // 根据对话框级别渲染
  if (dialogLevel.type === 'teammateList') {
    return (
      <TeamDetailView
        teamName={dialogLevel.teamName}
        teammates={teammateStatuses}
        selectedIndex={selectedIndex}
        onCancel={onDone}
      />
    );
  }

  if (dialogLevel.type === 'teammateDetail' && currentTeammate) {
    return <TeammateDetailView teammate={currentTeammate} teamName={dialogLevel.teamName} onCancel={goBackToList} />;
  }

  return null;
}

type TeamDetailViewProps = {
  teamName: string;
  teammates: TeammateStatus[];
  selectedIndex: number;
  onCancel: () => void;
};

function TeamDetailView({ teamName, teammates, selectedIndex, onCancel }: TeamDetailViewProps): React.ReactNode {
  const subtitle = `${teammates.length} ${teammates.length === 1 ? 'teammate' : 'teammates'}`;
  // 检查后端是否支持 hide/show
  const supportsHideShow = getCachedBackend()?.supportsHideShow ?? false;
  // 获取循环模式快捷键的显示文本
  const cycleModeShortcut = useShortcutDisplay('confirm:cycleMode', 'Confirmation', 'shift+tab');

  return (
    <>
      <Dialog title={`Team ${teamName}`} subtitle={subtitle} onCancel={onCancel} color="background" hideInputGuide>
        {teammates.length === 0 ? (
          <Text dimColor>No teammates</Text>
        ) : (
          <Box flexDirection="column">
            {teammates.map((teammate, index) => (
              <TeammateListItem key={teammate.agentId} teammate={teammate} isSelected={index === selectedIndex} />
            ))}
          </Box>
        )}
      </Dialog>
      <Box marginLeft={1}>
        <Text dimColor>
          {figures.arrowUp}/{figures.arrowDown} select · Enter view · k kill · s shutdown · p prune idle
          {supportsHideShow && ' · h hide/show · H hide/show all'}
          {' · '}
          {cycleModeShortcut} sync cycle modes for all · Esc close
        </Text>
      </Box>
    </>
  );
}

type TeammateListItemProps = {
  teammate: TeammateStatus;
  isSelected: boolean;
};

function TeammateListItem({ teammate, isSelected }: TeammateListItemProps): React.ReactNode {
  const isIdle = teammate.status === 'idle';
  // 仅在空闲且未选中时变暗 - 选中高亮优先
  const shouldDim = isIdle && !isSelected;

  // 获取模式显示
  const mode = teammate.mode ? permissionModeFromString(teammate.mode) : 'default';
  const modeSymbol = permissionModeSymbol(mode);
  const modeColor = getModeColor(mode);

  return (
    <Text color={isSelected ? 'suggestion' : undefined} dimColor={shouldDim}>
      {isSelected ? figures.pointer + ' ' : '  '}
      {teammate.isHidden && <Text dimColor>[hidden] </Text>}
      {isIdle && <Text dimColor>[idle] </Text>}
      {modeSymbol && <Text color={modeColor}>{modeSymbol} </Text>}@{teammate.name}
      {teammate.model && <Text dimColor> ({teammate.model})</Text>}
    </Text>
  );
}

type TeammateDetailViewProps = {
  teammate: TeammateStatus;
  teamName: string;
  onCancel: () => void;
};

function TeammateDetailView({ teammate, teamName, onCancel }: TeammateDetailViewProps): React.ReactNode {
  const [promptExpanded, setPromptExpanded] = useState(false);
  // 获取循环模式快捷键的显示文本
  const cycleModeShortcut = useShortcutDisplay('confirm:cycleMode', 'Confirmation', 'shift+tab');
  const themeColor = teammate.color
    ? AGENT_COLOR_TO_THEME_COLOR[teammate.color as keyof typeof AGENT_COLOR_TO_THEME_COLOR]
    : undefined;

  // 获取分配给此队友的任务
  const [teammateTasks, setTeammateTasks] = useState<Task[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listTasks(teamName).then(allTasks => {
      if (cancelled) return;
      // 过滤属于此队友的任务（按 agentId 或 name）
      setTeammateTasks(allTasks.filter(task => task.owner === teammate.agentId || task.owner === teammate.name));
    });
    return () => {
      cancelled = true;
    };
  }, [teamName, teammate.agentId, teammate.name]);

  useInput(input => {
    // 处理 'p' 展开/折叠 prompt
    if (input === 'p') {
      setPromptExpanded(prev => !prev);
    }
  });

  // 决定工作目录显示
  const workingPath = teammate.worktreePath || teammate.cwd;

  // 构建带有元数据的副标题
  const subtitleParts: string[] = [];
  if (teammate.model) subtitleParts.push(teammate.model);
  if (workingPath) {
    subtitleParts.push(teammate.worktreePath ? `worktree: ${workingPath}` : workingPath);
  }
  const subtitle = subtitleParts.join(' · ') || undefined;

  // 获取用于标题的模式显示
  const mode = teammate.mode ? permissionModeFromString(teammate.mode) : 'default';
  const modeSymbol = permissionModeSymbol(mode);
  const modeColor = getModeColor(mode);

  // 构建带有模式符号和彩色名称（如适用）的标题
  const title = (
    <>
      {modeSymbol && <Text color={modeColor}>{modeSymbol} </Text>}
      {themeColor ? <ThemedText color={themeColor}>{`@${teammate.name}`}</ThemedText> : `@${teammate.name}`}
    </>
  );

  return (
    <>
      <Dialog title={title} subtitle={subtitle} onCancel={onCancel} color="background" hideInputGuide>
        {/* 任务区域 */}
        {teammateTasks.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Tasks</Text>
            {teammateTasks.map(task => (
              <Text key={task.id} color={task.status === 'completed' ? 'success' : undefined}>
                {task.status === 'completed' ? figures.tick : '◼'} {task.subject}
              </Text>
            ))}
          </Box>
        )}

        {/* Prompt 区域 */}
        {teammate.prompt && (
          <Box flexDirection="column">
            <Text bold>Prompt</Text>
            <Text>
              {promptExpanded ? teammate.prompt : truncateToWidth(teammate.prompt, 80)}
              {stringWidth(teammate.prompt) > 80 && !promptExpanded && <Text dimColor> (p to expand)</Text>}
            </Text>
          </Box>
        )}
      </Dialog>
      <Box marginLeft={1}>
        <Text dimColor>
          {figures.arrowLeft} back · Esc close · k kill · s shutdown
          {getCachedBackend()?.supportsHideShow && ' · h hide/show'}
          {' · '}
          {cycleModeShortcut} cycle mode
        </Text>
      </Box>
    </>
  );
}

async function killTeammate(
  paneId: string,
  backendType: PaneBackendType | undefined,
  teamName: string,
  teammateId: string,
  teammateName: string,
  setAppState: (f: (prev: AppState) => AppState) => void,
): Promise<void> {
  // 使用创建它的后端杀死 pane（正确处理 -s / -L 标志）。
  // 包装在 try/catch 中以便清理（removeMemberFromTeam、unassignTeammateTasks、
  // setAppState）总是运行 —— 与 useInboxPoller.ts 的错误隔离一致。
  if (backendType) {
    try {
      // 使用 ensureBackendsRegistered（而非 detectAndGetBackend）—— 此进程可能
      // 是从未运行检测的队友，但这里只需要类导入，不需要可能在不同环境中
      // 抛出异常的子进程探测。
      await ensureBackendsRegistered();
      await getBackendByType(backendType).killPane(paneId, !isInsideTmuxSync());
    } catch (error) {
      logForDebugging(`[TeamsDialog] Failed to kill pane ${paneId}: ${error}`);
    }
  } else {
    // backendType 未定义：早于此字段的旧团队文件，或进程内模式。
    // 旧的 tmux 文件场景是迁移缺口 —— pane 被孤立。进程内队友没有 pane 可杀，
    // 所以对它们而言这是正确的。
    logForDebugging(`[TeamsDialog] Skipping pane kill for ${paneId}: no backendType recorded`);
  }
  // 从团队配置文件中移除
  removeMemberFromTeam(teamName, paneId);

  // 取消分配任务并构建通知消息
  const { notificationMessage } = await unassignTeammateTasks(teamName, teammateId, teammateName, 'terminated');

  // 更新 AppState 以保持状态行同步并通知 lead
  setAppState(prev => {
    if (!prev.teamContext?.teammates) return prev;
    if (!(teammateId in prev.teamContext.teammates)) return prev;
    const { [teammateId]: _, ...remainingTeammates } = prev.teamContext.teammates;
    return {
      ...prev,
      teamContext: {
        ...prev.teamContext,
        teammates: remainingTeammates,
      },
      inbox: {
        messages: [
          ...prev.inbox.messages,
          {
            id: randomUUID(),
            from: 'system',
            text: jsonStringify({
              type: 'teammate_terminated',
              message: notificationMessage,
            }),
            timestamp: new Date().toISOString(),
            status: 'pending' as const,
          },
        ],
      },
    };
  });
  logForDebugging(`[TeamsDialog] Removed ${teammateId} from teamContext`);
}

async function viewTeammateOutput(paneId: string, backendType: PaneBackendType | undefined): Promise<void> {
  if (backendType === 'iterm2') {
    // 必须使用 -s 才能针对特定会话（ITermBackend.ts:216-217）
    await execFileNoThrow(IT2_COMMAND, ['session', 'focus', '-s', paneId]);
  } else if (backendType === 'windows-terminal') {
    // Windows Terminal 将每个队友作为单独的窗口/标签启动；wt.exe
    // 没有暴露按名称聚焦预存在标签的 API。用户手动切换标签
    // （Ctrl+Tab）—— 这里关闭对话框就足够了。
    logForDebugging(`[TeamsDialog] viewTeammateOutput: Windows Terminal pane ${paneId} — manual tab switch required`);
  } else {
    // 外部 tmux 队友位于 swarm socket 上 —— 如果不带 -L，
    // 会针对默认服务器并静默无操作。对应 TmuxBackend.ts:85-89 的
    // runTmuxInSwarm。
    const args = isInsideTmuxSync()
      ? ['select-pane', '-t', paneId]
      : ['-L', getSwarmSocketName(), 'select-pane', '-t', paneId];
    await execFileNoThrow(TMUX_COMMAND, args);
  }
}

/**
 * 切换队友 pane 的可见性（可见时隐藏，隐藏时显示）
 */
async function toggleTeammateVisibility(teammate: TeammateStatus, teamName: string): Promise<void> {
  if (teammate.isHidden) {
    await showTeammate(teammate, teamName);
  } else {
    await hideTeammate(teammate, teamName);
  }
}

/**
 * 使用后端抽象隐藏队友 pane。
 * 仅对 ant 用户可用（在外部构建中通过 gating 消除死代码）
 */
async function hideTeammate(_teammate: TeammateStatus, _teamName: string): Promise<void> {}

/**
 * 使用后端抽象显示之前隐藏的队友 pane。
 * 仅对 ant 用户可用（在外部构建中通过 gating 消除死代码）
 */
async function showTeammate(_teammate: TeammateStatus, _teamName: string): Promise<void> {}

/**
 * 向单个队友发送模式变更消息
 * 也会直接更新 config.json，以便 UI 立即反映变更
 */
function sendModeChangeToTeammate(teammateName: string, teamName: string, targetMode: PermissionMode): void {
  // 直接更新 config.json，以便 UI 立即显示变更
  setMemberMode(teamName, teammateName, targetMode);

  // 同时发送消息以便队友更新其本地权限上下文
  const message = createModeSetRequestMessage({
    mode: targetMode,
    from: 'team-lead',
  });
  void writeToMailbox(
    teammateName,
    {
      from: 'team-lead',
      text: jsonStringify(message),
      timestamp: new Date().toISOString(),
    },
    teamName,
  );
  logForDebugging(`[TeamsDialog] Sent mode change to ${teammateName}: ${targetMode}`);
}

/**
 * 循环单个队友的模式
 */
function cycleTeammateMode(teammate: TeammateStatus, teamName: string, isBypassAvailable: boolean): void {
  const currentMode = teammate.mode ? permissionModeFromString(teammate.mode) : 'default';
  const context = {
    ...getEmptyToolPermissionContext(),
    mode: currentMode,
    isBypassPermissionsModeAvailable: isBypassAvailable,
  };
  const nextMode = getNextPermissionMode(context);
  sendModeChangeToTeammate(teammate.name, teamName, nextMode);
}

/**
 * 同步循环所有队友的模式
 * 如果模式不一致，先把全部重置为 default
 * 如果一致，则将全部循环到下一个模式
 * 使用批量更新以避免竞态条件
 */
function cycleAllTeammateModes(teammates: TeammateStatus[], teamName: string, isBypassAvailable: boolean): void {
  if (teammates.length === 0) return;

  const modes = teammates.map(t => (t.mode ? permissionModeFromString(t.mode) : 'default'));
  const allSame = modes.every(m => m === modes[0]);

  // 决定所有队友的目标模式
  const targetMode = !allSame
    ? 'default'
    : getNextPermissionMode({
        ...getEmptyToolPermissionContext(),
        mode: modes[0] ?? 'default',
        isBypassPermissionsModeAvailable: isBypassAvailable,
      });

  // 在单个原子操作中批量更新 config.json
  const modeUpdates = teammates.map(t => ({
    memberName: t.name,
    mode: targetMode,
  }));
  setMultipleMemberModes(teamName, modeUpdates);

  // 向每个队友发送 mailbox 消息
  for (const teammate of teammates) {
    const message = createModeSetRequestMessage({
      mode: targetMode,
      from: 'team-lead',
    });
    void writeToMailbox(
      teammate.name,
      {
        from: 'team-lead',
        text: jsonStringify(message),
        timestamp: new Date().toISOString(),
      },
      teamName,
    );
  }
  logForDebugging(`[TeamsDialog] Sent mode change to all ${teammates.length} teammates: ${targetMode}`);
}
