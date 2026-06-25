import * as React from 'react';
import { join } from 'path';
import { stat, writeFile } from 'fs/promises';
import figures from 'figures';
import { Box, Text, useInput, wrapText } from '@anthropic/ink';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Select } from '../CustomSelect/select.js';
import { Dialog } from '../design-system/Dialog.js';
import { useSetAppState } from '../../state/AppState.js';
import type { AppState } from '../../state/AppStateStore.js';
import type { Message } from '../../types/message.js';
import { getSessionId } from '../../bootstrap/state.js';
import { clearConversation } from '../../commands/clear/conversation.js';
import { createSystemMessage } from '../../utils/messages.js';
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js';
import { updateTaskState } from '../../utils/task/framework.js';
import { archiveRemoteSession } from '../../utils/teleport.js';
import { getCwd } from '../../utils/cwd.js';
import { toRelativePath } from '../../utils/path.js';
import type { UUID } from 'crypto';
import type { FileStateCache } from '../../utils/fileStateCache.js';
import { getTranscriptPath } from 'src/utils/sessionStorage.js';
import { useRegisterOverlay } from 'src/context/overlayContext.js';

/** 计划预览的最大可见行数。 */
const MAX_VISIBLE_LINES = 24;
/** 预览周围预留的边框行数（标题栏、选项等）。 */
const CHROME_LINES = 11;

type ChoiceValue = 'here' | 'fresh' | 'cancel';

interface UltraplanChoiceDialogProps {
  plan: string;
  sessionId: string;
  taskId: string;
  setMessages: (updater: (prev: Message[]) => Message[]) => void;
  readFileState: FileStateCache;
  memorySelector?: unknown;
  getAppState: () => AppState;
  setConversationId?: (id: UUID) => void;
  resultDedupState?: unknown;
}

function getDateStamp(): string {
  return new Date().toISOString().split('T')[0]!;
}

export function UltraplanChoiceDialog({
  plan,
  sessionId,
  taskId,
  setMessages,
  readFileState,
  memorySelector: _memorySelector,
  getAppState,
  setConversationId,
  resultDedupState: _resultDedupState,
}: UltraplanChoiceDialogProps): React.ReactNode {
  useRegisterOverlay('ultraplan-choice');

  const setAppState = useSetAppState();
  const { rows, columns } = useTerminalSize();

  // ── 计算可见行数 ──────────────────────────────────────────
  const visibleHeight = React.useMemo(
    () => Math.min(MAX_VISIBLE_LINES, Math.max(1, Math.floor(rows / 2) - CHROME_LINES)),
    [rows],
  );

  const wrappedLines = React.useMemo(
    () => wrapText(plan, Math.max(1, columns - 4), 'wrap').split('\n'),
    [plan, columns],
  );

  const maxOffset = Math.max(0, wrappedLines.length - visibleHeight);
  const [scrollOffset, setScrollOffset] = React.useState(0);

  // 当 maxOffset 缩小时（例如终端调整大小）钳制滚动偏移。
  React.useEffect(() => {
    setScrollOffset(prev => Math.min(prev, maxOffset));
  }, [maxOffset]);

  const isScrollable = wrappedLines.length > visibleHeight;

  // ── 滚动输入处理器 ───────────────────────────────────────────
  useInput((input, key) => {
    if (!isScrollable) return;
    const halfPage = Math.max(1, Math.floor(visibleHeight / 2));

    if ((key.ctrl && input === 'd') || key.wheelDown) {
      const step = key.wheelDown ? 3 : halfPage;
      setScrollOffset(prev => Math.min(prev + step, maxOffset));
    } else if ((key.ctrl && input === 'u') || key.wheelUp) {
      const step = key.wheelUp ? 3 : halfPage;
      setScrollOffset(prev => Math.max(prev - step, 0));
    }
  });

  // ── 可见切片 ──────────────────────────────────────────────────
  const visibleText = wrappedLines.slice(scrollOffset, scrollOffset + visibleHeight).join('\n');

  const canScrollUp = scrollOffset > 0;
  const canScrollDown = scrollOffset < maxOffset;

  // ── 选择处理器 ─────────────────────────────────────────────────
  const handleChoice = React.useCallback(
    async (choice: ChoiceValue) => {
      switch (choice) {
        case 'here':
          enqueuePendingNotification({
            value: [
              'Ultraplan 已在浏览器中批准。以下是计划：',
              '',
              '<ultraplan>',
              plan,
              '</ultraplan>',
              '',
              '用户已在远程会话中批准此计划。先给他们一个简短的总结，然后开始实施。',
            ].join('\n'),
            mode: 'task-notification',
          });
          break;
        case 'fresh':
          const previousSessionId = getSessionId();
          const transcriptSaved = await stat(getTranscriptPath()).then(
            () => true,
            () => false,
          );

          await clearConversation({
            setMessages,
            readFileState,
            getAppState,
            setAppState,
            setConversationId,
          });

          if (transcriptSaved) {
            setMessages(prev => [
              ...prev,
              createSystemMessage(
                `上一个会话已保存 · 使用以下命令恢复：claude --resume ${previousSessionId}`,
                'suggestion',
              ),
            ]);
          }

          enqueuePendingNotification({
            value: `以下是已批准的实施计划：\n\n${plan}\n\n请实施此计划。`,
            mode: 'prompt',
          });
          break;
        case 'cancel': {
          const savePath = join(getCwd(), `${getDateStamp()}-ultraplan.md`);
          await writeFile(savePath, plan, { encoding: 'utf-8' });
          setMessages(prev => [
            ...prev,
            createSystemMessage(`Ultraplan 已被拒绝 · 计划已保存到 ${toRelativePath(savePath)}`, 'suggestion'),
          ]);
          break;
        }
      }

      // 标记远程任务为已完成。
      updateTaskState(taskId, setAppState, task =>
        task.status !== 'running' ? task : { ...task, status: 'completed', endTime: Date.now() },
      );

      // 清除待选择状态，以便对话框卸载。
      setAppState(prev =>
        prev.ultraplanPendingChoice
          ? { ...prev, ultraplanPendingChoice: undefined, ultraplanSessionUrl: undefined }
          : prev,
      );

      // 归档远程 CCR 会话。
      archiveRemoteSession(sessionId);
    },
    [plan, sessionId, taskId, setMessages, getAppState, setAppState, readFileState, setConversationId],
  );

  // ── 菜单选项 ───────────────────────────────────────────────────
  const options: Array<{ label: string; value: ChoiceValue; description: string }> = React.useMemo(
    () => [
      {
        label: '在当前会话实施',
        value: 'here' as const,
        description: '将计划注入当前对话',
      },
      {
        label: '开启新会话',
        value: 'fresh' as const,
        description: '清空对话，仅以计划开始',
      },
      {
        label: '取消',
        value: 'cancel' as const,
        description: '不实施 — 保存计划并返回',
      },
    ],
    [],
  );

  // ── 渲染 ─────────────────────────────────────────────────────────
  return (
    <Dialog title="Ultraplan 已批准" subtitle="计划应如何实施？" onCancel={() => {}} hideInputGuide>
      <Box flexDirection="column" marginBottom={1}>
        {/* 计划预览 */}
        <Box flexDirection="column" marginBottom={1}>
          <Text>{visibleText}</Text>
          {isScrollable && (
            <Text dimColor>
              {canScrollUp ? figures.arrowUp : ' '}
              {canScrollDown ? figures.arrowDown : ' '} {scrollOffset + 1}–
              {Math.min(scrollOffset + visibleHeight, wrappedLines.length)}
              {' / '}
              {wrappedLines.length}
              {' · ctrl+u/ctrl+d 滚动'}
            </Text>
          )}
        </Box>

        {/* 选择菜单 */}
        <Select<ChoiceValue> options={options} onChange={value => void handleChoice(value)} />
      </Box>
    </Dialog>
  );
}
