import { feature } from 'bun:bundle';
import figures from 'figures';
import * as React from 'react';
import { SentryErrorBoundary } from 'src/components/SentryErrorBoundary.js';
import { Box, Text, useTheme } from '@anthropic/ink';
import { useAppState } from '../../../state/AppState.js';
import { filterToolProgressMessages, type Tool, type Tools } from '../../../Tool.js';
import type { NormalizedUserMessage, ProgressMessage } from '../../../types/message.js';
import {
  deleteClassifierApproval,
  getClassifierApproval,
  getYoloClassifierApproval,
} from '../../../utils/classifierApprovals.js';
import type { buildMessageLookups } from '../../../utils/messages.js';
import { MessageResponse } from '../../MessageResponse.js';
import { HookProgressMessage } from '../HookProgressMessage.js';

type Props = {
  message: NormalizedUserMessage;
  lookups: ReturnType<typeof buildMessageLookups>;
  toolUseID: string;
  progressMessagesForMessage: ProgressMessage[];
  style?: 'condensed';
  tool?: Tool;
  tools: Tools;
  verbose: boolean;
  width: number | string;
  isTranscriptMode?: boolean;
  shouldCollapseDiffs?: boolean;
};

export function UserToolSuccessMessage({
  message,
  lookups,
  toolUseID,
  progressMessagesForMessage,
  style,
  tool,
  tools,
  verbose,
  width,
  isTranscriptMode,
  shouldCollapseDiffs,
}: Props): React.ReactNode {
  const [theme] = useTheme();
  // 始终无条件调用 hook；feature gate 应用于值。
  const isBriefOnlyState = useAppState(s => s.isBriefOnly);
  const isBriefOnly = feature('KAIROS') || feature('KAIROS_BRIEF') ? isBriefOnlyState : false;

  // 在挂载时捕获一次 classifier approval，然后从 Map 中删除以防止线性增长。
  // useState 的 lazy initializer 确保值在重新渲染之间持久化。
  const [classifierRule] = React.useState(() => getClassifierApproval(toolUseID));
  const [yoloReason] = React.useState(() => getYoloClassifierApproval(toolUseID));
  React.useEffect(() => {
    deleteClassifierApproval(toolUseID);
  }, [toolUseID]);

  if (!message.toolUseResult || !tool) {
    return null;
  }

  // Resumed transcript 通过原始 JSON.parse 反序列化 toolUseResult，无
  // 校验（parseJSONL）。部分/损坏/旧格式的 result 会在首次字段访问时使
  // renderToolResultMessage 崩溃（anthropics/claude-code#39817）。
  // 渲染前根据 outputSchema 校验 —— 与 CollapsedReadSearchContent 一致。
  const parsedOutput = tool.outputSchema?.safeParse(message.toolUseResult);
  if (parsedOutput && !parsedOutput.success) {
    return null;
  }
  const toolResult = parsedOutput?.data ?? message.toolUseResult;

  // 折叠旧消息的 diff 显示（verbose/ctrl+o 覆盖）
  const effectiveStyle = shouldCollapseDiffs && !verbose ? 'condensed' : style;

  const renderedMessage =
    tool.renderToolResultMessage?.(toolResult as never, filterToolProgressMessages(progressMessagesForMessage), {
      style: effectiveStyle,
      theme,
      tools,
      verbose,
      isTranscriptMode,
      isBriefOnly,
      input: lookups.toolUseByToolUseID.get(toolUseID)?.input,
    }) ?? null;

  // 如果 tool result 消息为 null，则不渲染任何内容
  if (renderedMessage === null) {
    return null;
  }

  // 从 userFacingName 返回 '' 的 tool 会 opt out tool chrome 并
  // 像普通 assistant 文本一样渲染。跳过 tool-result 的宽度约束，
  // 使 MarkdownTable 的 SAFETY_MARGIN=4（为 assistant-text 的 2-col
  // dot gutter 调优）保持有效 —— 否则表格会换行其 box-drawing 字符。
  const rendersAsAssistantText = tool.userFacingName(undefined) === '';

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" width={rendersAsAssistantText ? undefined : width}>
        {renderedMessage}
        {feature('BASH_CLASSIFIER')
          ? classifierRule && (
              <MessageResponse height={1}>
                <Text dimColor>
                  <Text color="success">{figures.tick}</Text>
                  {' Auto-approved \u00b7 matched '}
                  {`"${classifierRule}"`}
                </Text>
              </MessageResponse>
            )
          : null}
        {feature('TRANSCRIPT_CLASSIFIER')
          ? yoloReason && (
              <MessageResponse height={1}>
                <Text dimColor>Allowed by auto mode classifier</Text>
              </MessageResponse>
            )
          : null}
      </Box>
      <SentryErrorBoundary>
        <HookProgressMessage
          hookEvent="PostToolUse"
          lookups={lookups}
          toolUseID={toolUseID}
          verbose={verbose}
          isTranscriptMode={isTranscriptMode}
        />
      </SentryErrorBoundary>
    </Box>
  );
}
