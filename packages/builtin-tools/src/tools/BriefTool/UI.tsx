import figures from 'figures';
import React from 'react';
import { Markdown } from 'src/components/Markdown.js';
import { BLACK_CIRCLE } from 'src/constants/figures.js';
import { Box, Text } from '@anthropic/ink';
import type { ProgressMessage } from 'src/types/message.js';
import { getDisplayPath } from 'src/utils/file.js';
import { formatFileSize } from 'src/utils/format.js';
import { formatBriefTimestamp } from 'src/utils/formatBriefTimestamp.js';
import type { Output } from './BriefTool.js';

export function renderToolUseMessage(): React.ReactNode {
  return '';
}

export function renderToolResultMessage(
  output: Output,
  _progressMessages: ProgressMessage[],
  options?: {
    isTranscriptMode?: boolean;
    isBriefOnly?: boolean;
  },
): React.ReactNode {
  const hasAttachments = (output.attachments?.length ?? 0) > 0;
  if (!output.message && !hasAttachments) {
    return null;
  }

  // 在 transcript 模式下（ctrl+o），模型文本不会被过滤——保留 ⏺ 标记，使
  // SendUserMessage 在周围的文本块中视觉上保持区分。
  if (options?.isTranscriptMode) {
    return (
      <Box flexDirection="row" marginTop={1}>
        <Box minWidth={2}>
          <Text color="text">{BLACK_CIRCLE}</Text>
        </Box>
        <Box flexDirection="column">
          {output.message ? <Markdown>{output.message}</Markdown> : null}
          <AttachmentList attachments={output.attachments} />
        </Box>
      </Box>
    );
  }

  // Brief-only（chat）视图："Claude" 标签 + 2 列缩进，与 UserPromptMessage
  // 给用户输入应用的 "You" 标签风格一致（#20889）。"N in background" 的
  // spinner 状态位于 BriefSpinner（Spinner.tsx）中——这里的标签是无状态的。
  if (options?.isBriefOnly) {
    const ts = output.sentAt ? formatBriefTimestamp(output.sentAt) : '';
    return (
      <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        <Box flexDirection="row">
          <Text color="briefLabelClaude">Claude</Text>
          {ts ? <Text dimColor> {ts}</Text> : null}
        </Box>
        <Box flexDirection="column">
          {output.message ? <Markdown>{output.message}</Markdown> : null}
          <AttachmentList attachments={output.attachments} />
        </Box>
      </Box>
    );
  }

  // 默认视图：dropTextInBriefTurns（Messages.tsx）会隐藏原本出现在此之前的
  // 冗余 assistant 文本——SendUserMessage 是该轮次中唯一的类文本内容。
  // 不显示 gutter 标记；以纯文本方式阅读。
  // userFacingName() 返回 ''，使 UserToolSuccessMessage 放弃其 columns-5
  // 宽度约束，且 AssistantToolUseMessage 渲染为 null（无工具外壳）。
  // 空的 minWidth={2} box 对应 AssistantTextMessage 中 ⏺ gutter 的间距。
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box minWidth={2} />
      <Box flexDirection="column">
        {output.message ? <Markdown>{output.message}</Markdown> : null}
        <AttachmentList attachments={output.attachments} />
      </Box>
    </Box>
  );
}

type AttachmentListProps = {
  attachments: Output['attachments'];
};

export function AttachmentList({ attachments }: AttachmentListProps): React.ReactNode {
  if (!attachments || attachments.length === 0) {
    return null;
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      {attachments.map(att => (
        <Box key={att.path} flexDirection="row">
          <Text dimColor>
            {figures.pointerSmall} {att.isImage ? '[image]' : '[file]'}{' '}
          </Text>
          <Text>{getDisplayPath(att.path)}</Text>
          <Text dimColor> ({formatFileSize(att.size)})</Text>
        </Box>
      ))}
    </Box>
  );
}
