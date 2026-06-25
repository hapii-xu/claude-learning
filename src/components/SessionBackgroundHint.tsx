import * as React from 'react';
import { useCallback, useState } from 'react';
import { useDoublePress } from '../hooks/useDoublePress.js';
import { Box, Text } from '@anthropic/ink';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js';
import { useAppState, useAppStateStore, useSetAppState } from '../state/AppState.js';
import { backgroundAll, hasForegroundTasks } from '../tasks/LocalShellTask/LocalShellTask.js';
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js';
import { env } from '../utils/env.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import { KeyboardShortcutHint } from '@anthropic/ink';

type Props = {
  onBackgroundSession: () => void;
  isLoading: boolean;
};

/**
 * 当用户按 Ctrl+B 将当前会话转入后台时显示提示。
 * 采用双击模式：第一次按下显示提示，800ms 内第二次按下则转入后台。
 *
 * 仅在以下条件满足时激活：
 * 1. isLoading 为 true（有 query 正在进行）
 * 2. 没有正在运行的前台任务（bash/agent）（它们对 Ctrl+B 有更高优先级）
 */
export function SessionBackgroundHint({ onBackgroundSession, isLoading }: Props): React.ReactElement | null {
  const setAppState = useSetAppState();
  const appStateStore = useAppStateStore();

  const [showSessionHint, setShowSessionHint] = useState(false);

  const handleDoublePress = useDoublePress(
    setShowSessionHint,
    onBackgroundSession,
    () => {}, // 第一次按下仅显示提示
  );

  // task:background 的处理器 —— 优先处理前台任务，回退到会话后台化
  // 如果禁用了后台任务，则跳过所有后台功能
  const handleBackground = useCallback(() => {
    if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) {
      return;
    }
    const state = appStateStore.getState();
    if (hasForegroundTasks(state)) {
      // 现有行为 —— 将正在运行的 bash/agent 任务转入后台
      backgroundAll(() => appStateStore.getState(), setAppState);
      if (!getGlobalConfig().hasUsedBackgroundTask) {
        saveGlobalConfig(c => (c.hasUsedBackgroundTask ? c : { ...c, hasUsedBackgroundTask: true }));
      }
    } else if (isEnvTruthy('false') && isLoading) {
      // 新行为 —— 双击将会话转入后台（受开关控制）
      handleDoublePress();
    }
  }, [setAppState, appStateStore, isLoading, handleDoublePress]);

  // 只在有东西可以转入后台时才吞掉 ctrl+b。如果没有这道门槛，
  // 绑定会与 readline 的 backward-char 在空闲 prompt 下重复触发。
  const hasForeground = useAppState(hasForegroundTasks);
  const sessionBgEnabled = isEnvTruthy('false');
  useKeybinding('task:background', handleBackground, {
    context: 'Task',
    isActive: hasForeground || (sessionBgEnabled && isLoading),
  });

  // 获取 task:background 的已配置快捷键
  const baseShortcut = useShortcutDisplay('task:background', 'Task', 'ctrl+b');
  // 在 tmux 中，ctrl+b 是前缀键，所以用户需要按两次才能发送 ctrl+b
  const shortcut = env.terminal === 'tmux' && baseShortcut === 'ctrl+b' ? 'ctrl+b ctrl+b' : baseShortcut;

  if (!isLoading || !showSessionHint) {
    return null;
  }

  return (
    <Box paddingLeft={2}>
      <Text dimColor>
        <KeyboardShortcutHint shortcut={shortcut} action="background" />
      </Text>
    </Box>
  );
}
