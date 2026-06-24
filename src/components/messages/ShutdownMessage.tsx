import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import {
  isShutdownApproved,
  isShutdownRejected,
  isShutdownRequest,
  type ShutdownRejectedMessage,
  type ShutdownRequestMessage,
} from '../../utils/teammateMailbox.js';

type ShutdownRequestProps = {
  request: ShutdownRequestMessage;
};

/**
 * 渲染一个带有 warning 颜色边框的 shutdown 请求。
 */
export function ShutdownRequestDisplay({ request }: ShutdownRequestProps): React.ReactNode {
  return (
    <Box flexDirection="column" marginY={1}>
      <Box borderStyle="round" borderColor="warning" flexDirection="column" paddingX={1} paddingY={1}>
        <Box marginBottom={1}>
          <Text color="warning" bold>
            来自 {request.from} 的关闭请求
          </Text>
        </Box>
        {request.reason && (
          <Box>
            <Text>原因：{request.reason}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

type ShutdownRejectedProps = {
  response: ShutdownRejectedMessage;
};

/**
 * 渲染一个带有 subtle（灰色）边框的 shutdown rejected 消息。
 */
export function ShutdownRejectedDisplay({ response }: ShutdownRejectedProps): React.ReactNode {
  return (
    <Box flexDirection="column" marginY={1}>
      <Box borderStyle="round" borderColor="subtle" flexDirection="column" paddingX={1} paddingY={1}>
        <Text color="subtle" bold>
          来自 {response.from} 的关闭请求已被拒绝
        </Text>
        <Box
          marginTop={1}
          borderStyle="dashed"
          borderColor="subtle"
          borderLeft={false}
          borderRight={false}
          paddingX={1}
        >
          <Text>原因：{response.reason}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>团队成员继续工作中。您可以稍后再次发送关闭请求。</Text>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * 尝试从原始内容解析并渲染 shutdown 消息。
 * 如果是 shutdown 消息则返回渲染的组件，否则返回 null。
 */
export function tryRenderShutdownMessage(content: string): React.ReactNode | null {
  const request = isShutdownRequest(content);
  if (request) {
    return <ShutdownRequestDisplay request={request} />;
  }

  // Shutdown approved 由调用方内联处理 —— 此处跳过
  if (isShutdownApproved(content)) {
    return null;
  }

  const rejected = isShutdownRejected(content);
  if (rejected) {
    return <ShutdownRejectedDisplay response={rejected} />;
  }

  return null;
}

/**
 * 获取 shutdown 消息的简要摘要文本。
 * 用于 inbox queue 等需要简短描述的场景。
 * 如果内容不是 shutdown 消息，则返回 null。
 */
export function getShutdownMessageSummary(content: string): string | null {
  const request = isShutdownRequest(content);
  if (request) {
    return `[来自 ${request.from} 的关闭请求]${request.reason ? ` ${request.reason}` : ''}`;
  }

  const approved = isShutdownApproved(content);
  if (approved) {
    return `[关闭已批准] ${approved.from} 正在退出`;
  }

  const rejected = isShutdownRejected(content);
  if (rejected) {
    return `[关闭已拒绝] ${rejected.from}：${rejected.reason}`;
  }

  return null;
}
