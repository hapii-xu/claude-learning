import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import figures from 'figures';
import * as React from 'react';
import { TEAMMATE_MESSAGE_TAG } from '../../constants/xml.js';
import { Ansi, Box, Text, type TextProps } from '@anthropic/ink';
import { toInkColor } from '../../utils/ink.js';

import { jsonParse } from '../../utils/slowOperations.js';
import { isShutdownApproved } from '../../utils/teammateMailbox.js';
import { MessageResponse } from '../MessageResponse.js';
import { tryRenderPlanApprovalMessage } from './PlanApprovalMessage.js';
import { tryRenderShutdownMessage } from './ShutdownMessage.js';
import { tryRenderTaskAssignmentMessage } from './TaskAssignmentMessage.js';

type Props = {
  addMargin: boolean;
  param: TextBlockParam;
  isTranscriptMode?: boolean;
};

type ParsedMessage = {
  teammateId: string;
  content: string;
  color?: string;
  summary?: string;
};

const TEAMMATE_MSG_REGEX = new RegExp(
  `<${TEAMMATE_MESSAGE_TAG}\\s+teammate_id="([^"]+)"(?:\\s+color="([^"]+)")?(?:\\s+summary="([^"]+)")?>\\n?([\\s\\S]*?)\\n?<\\/${TEAMMATE_MESSAGE_TAG}>`,
  'g',
);

/**
 * 从 XML 格式解析所有 teammate 消息：
 * <teammate-message teammate_id="alice" color="red" summary="Brief update">message content</teammate-message>
 * 支持在单个 text block 中有多条消息。
 */
function parseTeammateMessages(text: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  // 使用 matchAll 查找所有匹配项（这是 RegExp 方法，不是 child_process）
  for (const match of text.matchAll(TEAMMATE_MSG_REGEX)) {
    if (match[1] && match[4]) {
      messages.push({
        teammateId: match[1],
        color: match[2], // 可能为 undefined
        summary: match[3], // 可能为 undefined
        content: match[4].trim(),
      });
    }
  }

  return messages;
}

function getDisplayName(teammateId: string): string {
  if (teammateId === 'leader') {
    return 'leader';
  }
  return teammateId;
}

export function UserTeammateMessage({ addMargin, param: { text }, isTranscriptMode }: Props): React.ReactNode {
  const messages = parseTeammateMessages(text).filter(msg => {
    // 预过滤 shutdown lifecycle 消息以避免空的 wrapper
    // Box 元素在 model turn 之间创建空行
    if (isShutdownApproved(msg.content)) {
      return false;
    }
    try {
      const parsed = jsonParse(msg.content);
      if (parsed?.type === 'teammate_terminated') return false;
    } catch {
      // 不是 JSON，保留消息
    }
    return true;
  });
  if (messages.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0} width="100%">
      {messages.map((msg, index) => {
        const inkColor = toInkColor(msg.color);
        const displayName = getDisplayName(msg.teammateId);

        // 尝试渲染为 plan approval 消息（请求或响应）
        const planApprovalElement = tryRenderPlanApprovalMessage(msg.content, displayName);
        if (planApprovalElement) {
          return <React.Fragment key={index}>{planApprovalElement}</React.Fragment>;
        }

        // 尝试渲染为 shutdown 消息（请求或被拒绝）
        const shutdownElement = tryRenderShutdownMessage(msg.content);
        if (shutdownElement) {
          return <React.Fragment key={index}>{shutdownElement}</React.Fragment>;
        }

        // 尝试渲染为 task assignment 消息
        const taskAssignmentElement = tryRenderTaskAssignmentMessage(msg.content);
        if (taskAssignmentElement) {
          return <React.Fragment key={index}>{taskAssignmentElement}</React.Fragment>;
        }

        // 尝试解析为结构化 JSON 消息
        let parsedIdleNotification: { type?: string } | null = null;
        try {
          parsedIdleNotification = jsonParse(msg.content);
        } catch {
          // 不是 JSON
        }

        // 隐藏 idle 通知 - 它们被静默处理
        if (parsedIdleNotification?.type === 'idle_notification') {
          return null;
        }

        // Task 完成通知 - 显示哪个 task 已完成
        if (parsedIdleNotification?.type === 'task_completed') {
          const taskCompleted = parsedIdleNotification as {
            type: string;
            from: string;
            taskId: string;
            taskSubject?: string;
          };
          return (
            <Box key={index} flexDirection="column" marginTop={1}>
              <Text color={inkColor}>{`@${displayName}${figures.pointer}`}</Text>
              <MessageResponse>
                <Text color="success">✓</Text>
                <Text>
                  {' '}
                  Completed task #{taskCompleted.taskId}
                  {taskCompleted.taskSubject && <Text dimColor> ({taskCompleted.taskSubject})</Text>}
                </Text>
              </MessageResponse>
            </Box>
          );
        }

        // 默认：纯文本消息（截断）
        return (
          <TeammateMessageContent
            key={index}
            displayName={displayName}
            inkColor={inkColor}
            content={msg.content}
            summary={msg.summary}
            isTranscriptMode={isTranscriptMode}
          />
        );
      })}
    </Box>
  );
}

type TeammateMessageContentProps = {
  displayName: string;
  inkColor: TextProps['color'];
  content: string;
  summary?: string;
  isTranscriptMode?: boolean;
};

export function TeammateMessageContent({
  displayName,
  inkColor,
  content,
  summary,
  isTranscriptMode,
}: TeammateMessageContentProps): React.ReactNode {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={inkColor}>{`@${displayName}${figures.pointer}`}</Text>
        {summary && <Text> {summary}</Text>}
      </Box>
      {isTranscriptMode && (
        <Box paddingLeft={2}>
          <Text>
            <Ansi>{content}</Ansi>
          </Text>
        </Box>
      )}
    </Box>
  );
}
