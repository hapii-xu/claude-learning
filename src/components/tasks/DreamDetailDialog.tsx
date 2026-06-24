import React from 'react';
import type { DeepImmutable } from 'src/types/utils.js';
import { useElapsedTime } from '../../hooks/useElapsedTime.js';
import { type KeyboardEvent, Box, Text } from '@anthropic/ink';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import type { DreamTaskState } from '../../tasks/DreamTask/DreamTask.js';
import { plural } from '../../utils/stringUtils.js';
import { Byline, Dialog, KeyboardShortcutHint } from '@anthropic/ink';

type Props = {
  task: DeepImmutable<DreamTaskState>;
  onDone: () => void;
  onBack?: () => void;
  onKill?: () => void;
};

// How many recent turns to render. Earlier turns collapse to a count.
const VISIBLE_TURNS = 6;

export function DreamDetailDialog({ task, onDone, onBack, onKill }: Props): React.ReactNode {
  const elapsedTime = useElapsedTime(task.startTime, task.status === 'running', 1000, 0);

  // Dialog handles confirm:no (Esc) → onCancel. Wire confirm:yes (Enter/y) too.
  useKeybindings({ 'confirm:yes': onDone }, { context: 'Confirmation' });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault();
      onDone();
    } else if (e.key === 'left' && onBack) {
      e.preventDefault();
      onBack();
    } else if (e.key === 'x' && task.status === 'running' && onKill) {
      e.preventDefault();
      onKill();
    }
  };

  // Turns with text to show. Tool-only turns (text='') are dropped entirely —
  // the per-turn toolUseCount already captures that work.
  const visibleTurns = task.turns.filter(t => t.text !== '');
  const shown = visibleTurns.slice(-VISIBLE_TURNS);
  const hidden = visibleTurns.length - shown.length;

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title="记忆整合"
        subtitle={
          <Text dimColor>
            {elapsedTime} · 正在回顾 {task.sessionsReviewing} 个会话
            {task.filesTouched.length > 0 && <> · {task.filesTouched.length} 个文件已修改</>}
          </Text>
        }
        onCancel={onDone}
        color="background"
        inputGuide={exitState =>
          exitState.pending ? (
            <Text>再次按 {exitState.keyName} 退出</Text>
          ) : (
            <Byline>
              {onBack && <KeyboardShortcutHint shortcut="←" action="返回" />}
              <KeyboardShortcutHint shortcut="Esc/Enter/Space" action="关闭" />
              {task.status === 'running' && onKill && <KeyboardShortcutHint shortcut="x" action="停止" />}
            </Byline>
          )
        }
      >
        <Box flexDirection="column" gap={1}>
          <Text>
            <Text bold>状态：</Text>{' '}
            {task.status === 'running' ? (
              <Text color="background">运行中</Text>
            ) : task.status === 'completed' ? (
              <Text color="success">已完成</Text>
            ) : (
              <Text color="error">{task.status}</Text>
            )}
          </Text>

          {shown.length === 0 ? (
            <Text dimColor>{task.status === 'running' ? '启动中…' : '（无文本输出）'}</Text>
          ) : (
            <>
              {hidden > 0 && <Text dimColor>（还有更早的 {hidden} 轮对话）</Text>}
              {shown.map((turn, i) => (
                <Box key={i} flexDirection="column">
                  <Text wrap="wrap">{turn.text}</Text>
                  {turn.toolUseCount > 0 && (
                    <Text dimColor>
                      {'  '}（{turn.toolUseCount} 个工具）
                    </Text>
                  )}
                </Box>
              ))}
            </>
          )}
        </Box>
      </Dialog>
    </Box>
  );
}
