import * as React from 'react';
import { Markdown } from '../../components/Markdown.js';
import { Box, Text } from '@anthropic/ink';
import { jsonParse } from '../../utils/slowOperations.js';
import {
  type IdleNotificationMessage,
  isIdleNotification,
  isPlanApprovalRequest,
  isPlanApprovalResponse,
  type PlanApprovalRequestMessage,
  type PlanApprovalResponseMessage,
} from '../../utils/teammateMailbox.js';
import { getShutdownMessageSummary } from './ShutdownMessage.js';
import { getTaskAssignmentSummary } from './TaskAssignmentMessage.js';

type PlanApprovalRequestProps = {
  request: PlanApprovalRequestMessage;
};

/**
 * 渲染一个带有 planMode 颜色边框的 plan approval 请求，
 * 显示 plan 内容和批准/拒绝的说明。
 */
export function PlanApprovalRequestDisplay({ request }: PlanApprovalRequestProps): React.ReactNode {
  return (
    <Box flexDirection="column" marginY={1}>
      <Box borderStyle="round" borderColor="planMode" flexDirection="column" paddingX={1}>
        <Box marginBottom={1}>
          <Text color="planMode" bold>
            Plan Approval Request from {request.from}
          </Text>
        </Box>
        <Box
          borderStyle="dashed"
          borderColor="subtle"
          borderLeft={false}
          borderRight={false}
          flexDirection="column"
          paddingX={1}
          marginBottom={1}
        >
          <Markdown>{request.planContent}</Markdown>
        </Box>
        <Text dimColor>Plan file: {request.planFilePath}</Text>
      </Box>
    </Box>
  );
}

type PlanApprovalResponseProps = {
  response: PlanApprovalResponseMessage;
  senderName: string;
};

/**
 * 渲染一个带有 success（绿色）或 error（红色）边框的 plan approval 响应。
 */
export function PlanApprovalResponseDisplay({ response, senderName }: PlanApprovalResponseProps): React.ReactNode {
  if (response.approved) {
    return (
      <Box flexDirection="column" marginY={1}>
        <Box borderStyle="round" borderColor="success" flexDirection="column" paddingX={1} paddingY={1}>
          <Box>
            <Text color="success" bold>
              ✓ Plan Approved by {senderName}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text>You can now proceed with implementation. Your plan mode restrictions have been lifted.</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginY={1}>
      <Box borderStyle="round" borderColor="error" flexDirection="column" paddingX={1} paddingY={1}>
        <Box>
          <Text color="error" bold>
            ✗ Plan Rejected by {senderName}
          </Text>
        </Box>
        {response.feedback && (
          <Box
            marginTop={1}
            borderStyle="dashed"
            borderColor="subtle"
            borderLeft={false}
            borderRight={false}
            paddingX={1}
          >
            <Text>Feedback: {response.feedback}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>Please revise your plan based on the feedback and call ExitPlanMode again.</Text>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * 尝试从原始内容解析并渲染 plan approval 消息。
 * 如果是 plan approval 消息则返回渲染的组件，否则返回 null。
 */
export function tryRenderPlanApprovalMessage(content: string, senderName: string): React.ReactNode | null {
  const request = isPlanApprovalRequest(content);
  if (request) {
    return <PlanApprovalRequestDisplay request={request} />;
  }

  const response = isPlanApprovalResponse(content);
  if (response) {
    return <PlanApprovalResponseDisplay response={response} senderName={senderName} />;
  }

  return null;
}

/**
 * 获取 plan approval 消息的简要摘要文本。
 * 用于 inbox queue 等需要简短描述的场景。
 * 如果内容不是 plan approval 消息，则返回 null。
 */
function getPlanApprovalSummary(content: string): string | null {
  const request = isPlanApprovalRequest(content);
  if (request) {
    return `[Plan Approval Request from ${request.from}]`;
  }

  const response = isPlanApprovalResponse(content);
  if (response) {
    if (response.approved) {
      return '[Plan Approved] You can now proceed with implementation';
    } else {
      return `[Plan Rejected] ${response.feedback || 'Please revise your plan'}`;
    }
  }

  return null;
}

/**
 * 获取 idle notification 的简要摘要文本。
 */
function getIdleNotificationSummary(msg: IdleNotificationMessage): string {
  const parts: string[] = ['Agent idle'];
  if (msg.completedTaskId) {
    const status = msg.completedStatus || 'completed';
    parts.push(`Task ${msg.completedTaskId} ${status}`);
  }
  if (msg.summary) {
    parts.push(`Last DM: ${msg.summary}`);
  }
  return parts.join(' · ');
}

/**
 * 格式化 teammate 消息内容以供显示。
 * 如果是结构化消息（plan approval、shutdown 或 idle），返回格式化的摘要。
 * 否则返回原始内容。
 */
export function formatTeammateMessageContent(content: string): string {
  const planSummary = getPlanApprovalSummary(content);
  if (planSummary) {
    return planSummary;
  }

  const shutdownSummary = getShutdownMessageSummary(content);
  if (shutdownSummary) {
    return shutdownSummary;
  }

  const idleMsg = isIdleNotification(content);
  if (idleMsg) {
    return getIdleNotificationSummary(idleMsg);
  }

  const taskAssignmentSummary = getTaskAssignmentSummary(content);
  if (taskAssignmentSummary) {
    return taskAssignmentSummary;
  }

  // 检查 teammate_terminated 消息
  try {
    const parsed = jsonParse(content) as { type?: string; message?: string };
    if (parsed?.type === 'teammate_terminated' && parsed.message) {
      return parsed.message;
    }
  } catch {
    // 不是 JSON
  }

  return content;
}
