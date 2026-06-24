import { feature } from 'bun:bundle';
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import { BULLET_OPERATOR } from '../../../constants/figures.js';
import { Text } from '@anthropic/ink';
import { filterToolProgressMessages, type Tool, type Tools } from '../../../Tool.js';
import type { ProgressMessage } from '../../../types/message.js';
import {
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  isClassifierDenial,
  PLAN_REJECTION_PREFIX,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
} from '../../../utils/messages.js';
import { FallbackToolUseErrorMessage } from '../../FallbackToolUseErrorMessage.js';
import { InterruptedByUser } from '../../InterruptedByUser.js';
import { MessageResponse } from '../../MessageResponse.js';
import { RejectedPlanMessage } from './RejectedPlanMessage.js';
import { RejectedToolUseMessage } from './RejectedToolUseMessage.js';

type Props = {
  progressMessagesForMessage: ProgressMessage[];
  tool?: Tool; // 恢复使用旧 tool 的旧会话时为 undefined
  tools: Tools;
  param: ToolResultBlockParam;
  verbose: boolean;
  isTranscriptMode?: boolean;
};

export function UserToolErrorMessage({
  progressMessagesForMessage,
  tool,
  tools,
  param,
  verbose,
  isTranscriptMode,
}: Props): React.ReactNode {
  if (typeof param.content === 'string' && param.content.includes(INTERRUPT_MESSAGE_FOR_TOOL_USE)) {
    return (
      <MessageResponse height={1}>
        <InterruptedByUser />
      </MessageResponse>
    );
  }

  if (typeof param.content === 'string' && param.content.startsWith(PLAN_REJECTION_PREFIX)) {
    // 从错误消息中提取 plan 内容
    const planContent = param.content.substring(PLAN_REJECTION_PREFIX.length);
    return <RejectedPlanMessage plan={planContent} />;
  }

  if (typeof param.content === 'string' && param.content.startsWith(REJECT_MESSAGE_WITH_REASON_PREFIX)) {
    return <RejectedToolUseMessage />;
  }

  if (feature('TRANSCRIPT_CLASSIFIER') && typeof param.content === 'string' && isClassifierDenial(param.content)) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>被自动模式分类器拒绝 {BULLET_OPERATOR} 如有误请使用 /feedback</Text>
      </MessageResponse>
    );
  }

  return (
    tool?.renderToolUseErrorMessage?.(param.content, {
      progressMessagesForMessage: filterToolProgressMessages(progressMessagesForMessage),
      tools,
      verbose,
      isTranscriptMode,
    }) ?? <FallbackToolUseErrorMessage result={param.content} verbose={verbose} />
  );
}
