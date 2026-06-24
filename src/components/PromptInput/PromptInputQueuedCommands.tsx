import { feature } from 'bun:bundle';
import * as React from 'react';
import { useMemo } from 'react';
import { Box } from '@anthropic/ink';
import { useAppState } from 'src/state/AppState.js';
import { STATUS_TAG, SUMMARY_TAG, TASK_NOTIFICATION_TAG } from '../../constants/xml.js';
import { QueuedMessageProvider } from '../../context/QueuedMessageContext.js';
import { useCommandQueue } from '../../hooks/useCommandQueue.js';
import type { QueuedCommand } from '../../types/textInputTypes.js';
import { isQueuedCommandVisible } from '../../utils/messageQueueManager.js';
import { createUserMessage, EMPTY_LOOKUPS, normalizeMessages } from '../../utils/messages.js';
import { jsonParse } from '../../utils/slowOperations.js';
import { Message } from '../Message.js';

const EMPTY_SET = new Set<string>();

/**
 * 检查命令值是否为应隐藏的空闲通知。
 * 空闲通知会被静默处理，不向用户展示。
 */
function isIdleNotification(value: string): boolean {
  try {
    const parsed = jsonParse(value);
    return parsed?.type === 'idle_notification';
  } catch {
    return false;
  }
}

// 最多显示的任务通知条数
const MAX_VISIBLE_NOTIFICATIONS = 3;

/**
 * 为超出上限的任务通知创建合成的溢出提示消息。
 */
function createOverflowNotificationMessage(count: number): string {
  return `<${TASK_NOTIFICATION_TAG}>
<${SUMMARY_TAG}>+${count} 个任务已完成</${SUMMARY_TAG}>
<${STATUS_TAG}>completed</${STATUS_TAG}>
</${TASK_NOTIFICATION_TAG}>`;
}

/**
 * 处理队列命令，将任务通知条数限制在 MAX_VISIBLE_NOTIFICATIONS 以内。
 * 其他类型的命令始终完整展示。
 * 空闲通知会被完全过滤掉。
 */
function processQueuedCommands(queuedCommands: QueuedCommand[]): QueuedCommand[] {
  // 过滤掉空闲通知 —— 它们会被静默处理
  const filteredCommands = queuedCommands.filter(
    cmd => typeof cmd.value !== 'string' || !isIdleNotification(cmd.value),
  );

  // 将任务通知与其他命令分开
  const taskNotifications = filteredCommands.filter(cmd => cmd.mode === 'task-notification');
  const otherCommands = filteredCommands.filter(cmd => cmd.mode !== 'task-notification');

  // 如果通知数量未超过限制，直接返回所有命令
  if (taskNotifications.length <= MAX_VISIBLE_NOTIFICATIONS) {
    return [...otherCommands, ...taskNotifications];
  }

  // 显示前 (MAX_VISIBLE_NOTIFICATIONS - 1) 条通知，然后显示汇总信息
  const visibleNotifications = taskNotifications.slice(0, MAX_VISIBLE_NOTIFICATIONS - 1);
  const overflowCount = taskNotifications.length - (MAX_VISIBLE_NOTIFICATIONS - 1);

  // 创建合成的溢出消息
  const overflowCommand: QueuedCommand = {
    value: createOverflowNotificationMessage(overflowCount),
    mode: 'task-notification',
  };

  return [...otherCommands, ...visibleNotifications, overflowCommand];
}

function PromptInputQueuedCommandsImpl(): React.ReactNode {
  const queuedCommands = useCommandQueue();
  const viewingAgent = useAppState(s => !!s.viewingAgentTaskId);
  // 简洁布局：队列项目变暗 + 跳过 paddingX（简洁消息自身已带缩进）。
  // 门控逻辑与其他地方的 brief-spinner/message 检查保持一致 ——
  // 查看队友时此组件会提前返回，因此不需要队友视图覆盖。
  const isBriefOnlyState = useAppState(s => s.isBriefOnly);
  const useBriefLayout = feature('KAIROS') || feature('KAIROS_BRIEF') ? isBriefOnlyState : false;

  // createUserMessage 每次调用都会生成新的 UUID；不做 memoize 的话，流式重渲染
  // 会导致 Message 的 areMessagePropsEqual（比较 uuid）失效 → 画面闪烁。
  const messages = useMemo(() => {
    if (queuedCommands.length === 0) return null;
    // task-notification 通过 useInboxNotification 展示；大多数 isMeta 命令
    // （计划任务、主动触发）由系统生成并隐藏。
    // 频道消息是例外 —— 虽然是 isMeta，但仍需展示，让键盘用户看到收到的内容。
    const visibleCommands = queuedCommands.filter(isQueuedCommandVisible);
    if (visibleCommands.length === 0) return null;
    const processedCommands = processQueuedCommands(visibleCommands);
    return normalizeMessages(
      processedCommands.map(cmd => {
        let content = cmd.value;
        if (cmd.mode === 'bash' && typeof content === 'string') {
          content = `<bash-input>${content}</bash-input>`;
        }
        // [Image #N] 占位符内联在文本值中（粘贴时插入），
        // 因此队列预览直接展示，无需额外的占位块。
        return createUserMessage({ content });
      }),
    );
  }, [queuedCommands]);

  // 查看任何 agent 的对话记录时，不显示主节点的队列命令
  if (viewingAgent || messages === null) {
    return null;
  }

  return (
    <Box marginTop={1} flexDirection="column">
      {messages.map((message, i) => (
        <QueuedMessageProvider key={i} isFirst={i === 0} useBriefLayout={useBriefLayout}>
          <Message
            message={message}
            lookups={EMPTY_LOOKUPS}
            addMargin={false}
            tools={[]}
            commands={[]}
            verbose={false}
            inProgressToolUseIDs={EMPTY_SET}
            progressMessagesForMessage={[]}
            shouldAnimate={false}
            shouldShowDot={false}
            isTranscriptMode={false}
            isStatic={true}
          />
        </QueuedMessageProvider>
      ))}
    </Box>
  );
}

export const PromptInputQueuedCommands = React.memo(PromptInputQueuedCommandsImpl);
