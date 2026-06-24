import React from 'react';
import type { DeepImmutable } from 'src/types/utils.js';
import { useElapsedTime } from '../../hooks/useElapsedTime.js';
import { Box, Text, type KeyboardEvent } from '@anthropic/ink';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import type { MonitorMcpTaskState } from '../../tasks/MonitorMcpTask/MonitorMcpTask.js';
import { Byline } from '../design-system/Byline.js';
import { Dialog } from '../design-system/Dialog.js';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js';

type Props = {
  task: DeepImmutable<MonitorMcpTaskState>;
  onBack?: () => void;
  onKill?: () => void;
};

/**
 * Shift+Down 后台 task 叠层中展示的 MCP monitor task 详情对话框。
 * 展示服务器名称、resource URI 和当前状态。
 * 沿用 DreamDetailDialog/ShellDetailDialog 模式。
 */
export function MonitorMcpDetailDialog({ task, onBack, onKill }: Props): React.ReactNode {
  const elapsedTime = useElapsedTime(task.startTime, task.status === 'running', 1000, 0);

  useKeybindings({}, { context: 'MonitorMcpDetail' });

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'left' && onBack) {
      e.preventDefault();
      onBack();
    } else if (e.key === 'x' && task.status === 'running' && onKill) {
      e.preventDefault();
      onKill();
    }
  };

  return (
    <Box flexDirection="column" tabIndex={0} borderStyle="round" onKeyDown={handleKeyDown}>
      <Dialog
        title="MCP 监控"
        subtitle={
          <Text dimColor>
            {elapsedTime} · {task.serverName}:{task.resourceUri}
          </Text>
        }
        onCancel={onBack ?? (() => {})}
        inputGuide={() => (
          <Byline>
            {onBack && <KeyboardShortcutHint shortcut="←" action="返回" />}
            <KeyboardShortcutHint shortcut="Esc" action="关闭" />
            {task.status === 'running' && onKill && <KeyboardShortcutHint shortcut="x" action="停止" />}
          </Byline>
        )}
      >
        <Box flexDirection="column" gap={1}>
          <Text>
            <Text bold>状态：</Text>{' '}
            {task.status === 'running' ? (
              <Text color="ansi:green">运行中</Text>
            ) : task.status === 'completed' ? (
              <Text color="ansi:green">已完成</Text>
            ) : (
              <Text color="ansi:red">{task.status}</Text>
            )}
          </Text>
          <Text>
            <Text bold>描述：</Text> {task.description}
          </Text>
          <Text>
            <Text bold>服务器：</Text> {task.serverName}
          </Text>
          <Text>
            <Text bold>资源：</Text> {task.resourceUri}
          </Text>
          {task.command && (
            <Text>
              <Text bold>命令：</Text> {task.command}
            </Text>
          )}
        </Box>
      </Dialog>
    </Box>
  );
}
