import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import { KeyboardShortcutHint } from '@anthropic/ink';
import { FallbackToolUseErrorMessage } from 'src/components/FallbackToolUseErrorMessage.js';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { ShellProgressMessage } from 'src/components/shell/ShellProgressMessage.js';
import { Box, Text } from '@anthropic/ink';
import { useKeybinding } from 'src/keybindings/useKeybinding.js';
import { useShortcutDisplay } from 'src/keybindings/useShortcutDisplay.js';
import { useAppStateStore, useSetAppState } from 'src/state/AppState.js';
import type { Tool } from 'src/Tool.js';
import { backgroundAll } from 'src/tasks/LocalShellTask/LocalShellTask.js';
import type { ProgressMessage } from 'src/types/message.js';
import { env } from 'src/utils/env.js';
import { isEnvTruthy } from 'src/utils/envUtils.js';
import { getDisplayPath } from 'src/utils/file.js';
import { isFullscreenEnvEnabled } from 'src/utils/fullscreen.js';
import type { ThemeName } from 'src/utils/theme.js';
import type { BashProgress, BashToolInput, Out } from './BashTool.js';
import BashToolResultMessage from './BashToolResultMessage.js';
import { extractBashCommentLabel } from './commentLabel.js';
import { parseSedEditCommand } from './sedEditParser.js';

// 命令展示相关常量
const MAX_COMMAND_DISPLAY_LINES = 2;
const MAX_COMMAND_DISPLAY_CHARS = 160;

// 用于显示后台提示并处理 ctrl+b 的简单组件
// 按下 ctrl+b 时，会将所有正在运行的前台命令转入后台
export function BackgroundHint({ onBackground }: { onBackground?: () => void } = {}): React.ReactElement | null {
  const store = useAppStateStore();
  const setAppState = useSetAppState();

  // task:background 的处理函数——将所有前台任务转入后台
  const handleBackground = React.useCallback(() => {
    // 将所有前台 bash 任务转入后台
    backgroundAll(() => store.getState(), setAppState);
    // 同时调用可选回调（用于非 bash 任务，例如 agents）
    onBackground?.();
  }, [store, setAppState, onBackground]);

  useKeybinding('task:background', handleBackground, {
    context: 'Task',
  });

  // 获取 task:background 的已配置快捷键
  const baseShortcut = useShortcutDisplay('task:background', 'Task', 'ctrl+b');
  // 在 tmux 中，ctrl+b 是前缀键，用户需要按两次才能发送 ctrl+b
  const shortcut = env.terminal === 'tmux' && baseShortcut === 'ctrl+b' ? 'ctrl+b ctrl+b (twice)' : baseShortcut;

  // 若后台任务被禁用，则不显示后台提示
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) {
    return null;
  }

  return (
    <Box paddingLeft={5}>
      <Text dimColor>
        <KeyboardShortcutHint shortcut={shortcut} action="在后台运行" parens />
      </Text>
    </Box>
  );
}

export function renderToolUseMessage(
  input: Partial<BashToolInput>,
  { verbose, theme: _theme }: { verbose: boolean; theme: ThemeName },
): React.ReactNode {
  const { command } = input;
  if (!command) {
    return null;
  }

  // 将 sed 的就地编辑渲染为文件编辑样式（仅显示文件路径）
  const sedInfo = parseSedEditCommand(command);
  if (sedInfo) {
    return verbose ? sedInfo.filePath : getDisplayPath(sedInfo.filePath);
  }

  if (!verbose) {
    const lines = command.split('\n');

    if (isFullscreenEnvEnabled()) {
      const label = extractBashCommentLabel(command);
      if (label) {
        return label.length > MAX_COMMAND_DISPLAY_CHARS ? label.slice(0, MAX_COMMAND_DISPLAY_CHARS) + '…' : label;
      }
    }

    const needsLineTruncation = lines.length > MAX_COMMAND_DISPLAY_LINES;
    const needsCharTruncation = command.length > MAX_COMMAND_DISPLAY_CHARS;

    if (needsLineTruncation || needsCharTruncation) {
      let truncated = command;

      // 若需要，先按行截断
      if (needsLineTruncation) {
        truncated = lines.slice(0, MAX_COMMAND_DISPLAY_LINES).join('\n');
      }

      // 若仍过长，再按字符截断
      if (truncated.length > MAX_COMMAND_DISPLAY_CHARS) {
        truncated = truncated.slice(0, MAX_COMMAND_DISPLAY_CHARS);
      }

      return <Text>{truncated.trim()}…</Text>;
    }
  }

  return command;
}

export function renderToolUseProgressMessage(
  progressMessagesForMessage: ProgressMessage<BashProgress>[],
  {
    verbose,
    tools: _tools,
    terminalSize: _terminalSize,
    inProgressToolCallCount: _inProgressToolCallCount,
  }: {
    tools: Tool[];
    verbose: boolean;
    terminalSize?: { columns: number; rows: number };
    inProgressToolCallCount?: number;
  },
): React.ReactNode {
  const lastProgress = progressMessagesForMessage.at(-1);

  if (!lastProgress || !lastProgress.data) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>运行中…</Text>
      </MessageResponse>
    );
  }

  const data = lastProgress.data;

  return (
    <ShellProgressMessage
      fullOutput={data.fullOutput}
      output={data.output}
      elapsedTimeSeconds={data.elapsedTimeSeconds}
      totalLines={data.totalLines}
      totalBytes={data.totalBytes}
      timeoutMs={data.timeoutMs}
      taskId={data.taskId}
      verbose={verbose}
    />
  );
}

export function renderToolUseQueuedMessage(): React.ReactNode {
  return (
    <MessageResponse height={1}>
      <Text dimColor>等待中…</Text>
    </MessageResponse>
  );
}

export function renderToolResultMessage(
  content: Out,
  progressMessagesForMessage: ProgressMessage<BashProgress>[],
  {
    verbose,
    theme: _theme,
    tools: _tools,
    style: _style,
  }: {
    verbose: boolean;
    theme: ThemeName;
    tools: Tool[];
    style?: 'condensed';
  },
): React.ReactNode {
  const lastProgress = progressMessagesForMessage.at(-1);
  const timeoutMs = lastProgress?.data?.timeoutMs;
  return <BashToolResultMessage content={content} verbose={verbose} timeoutMs={timeoutMs} />;
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  {
    verbose,
    progressMessagesForMessage: _progressMessagesForMessage,
    tools: _tools,
  }: {
    verbose: boolean;
    progressMessagesForMessage: ProgressMessage<BashProgress>[];
    tools: Tool[];
  },
): React.ReactNode {
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />;
}
