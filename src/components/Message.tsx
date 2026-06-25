import { feature } from 'bun:bundle';
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs';
import type {
  ImageBlockParam,
  TextBlockParam,
  ThinkingBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import type { Command } from '../commands.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box } from '@anthropic/ink';
import type { Tools } from '../Tool.js';
import { type ConnectorTextBlock, isConnectorTextBlock } from '../types/connectorText.js';
import type {
  AssistantMessage,
  AttachmentMessage as AttachmentMessageType,
  CollapsedReadSearchGroup as CollapsedReadSearchGroupType,
  GroupedToolUseMessage as GroupedToolUseMessageType,
  NormalizedUserMessage,
  ProgressMessage,
  SystemMessage,
} from '../types/message.js';
import { type AdvisorBlock, isAdvisorBlock } from '../utils/advisor.js';
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js';
import { logError } from '../utils/log.js';
import type { buildMessageLookups } from '../utils/messages.js';
import { CompactSummary } from './CompactSummary.js';
import { AdvisorMessage } from './messages/AdvisorMessage.js';
import { AssistantRedactedThinkingMessage } from './messages/AssistantRedactedThinkingMessage.js';
import { AssistantTextMessage } from './messages/AssistantTextMessage.js';
import { AssistantThinkingMessage } from './messages/AssistantThinkingMessage.js';
import { AssistantToolUseMessage } from './messages/AssistantToolUseMessage.js';
import { AttachmentMessage } from './messages/AttachmentMessage.js';
import { CollapsedReadSearchContent } from './messages/CollapsedReadSearchContent.js';
import { CompactBoundaryMessage } from './messages/CompactBoundaryMessage.js';
import { GroupedToolUseContent } from './messages/GroupedToolUseContent.js';
import { SystemTextMessage } from './messages/SystemTextMessage.js';
import { UserImageMessage } from './messages/UserImageMessage.js';
import { UserTextMessage } from './messages/UserTextMessage.js';
import { UserToolResultMessage } from './messages/UserToolResultMessage/UserToolResultMessage.js';
import { OffscreenFreeze } from './OffscreenFreeze.js';
import { ExpandShellOutputProvider } from './shell/ExpandShellOutputContext.js';

export type Props = {
  message:
    | NormalizedUserMessage
    | AssistantMessage
    | AttachmentMessageType
    | SystemMessage
    | GroupedToolUseMessageType
    | CollapsedReadSearchGroupType;
  lookups: ReturnType<typeof buildMessageLookups>;
  // TODO: 找到办法移除它，把间距处理交给调用方
  /** 容器 Box 的绝对宽度。提供时，可消除调用方中的一个包装 Box。 */
  containerWidth?: number;
  addMargin: boolean;
  tools: Tools;
  commands: Command[];
  verbose: boolean;
  inProgressToolUseIDs: Set<string>;
  progressMessagesForMessage: ProgressMessage[];
  shouldAnimate: boolean;
  shouldShowDot: boolean;
  style?: 'condensed';
  width?: number | string;
  isTranscriptMode: boolean;
  isStatic: boolean;
  onOpenRateLimitOptions?: () => void;
  isActiveCollapsedGroup?: boolean;
  isUserContinuation?: boolean;
  /** 要显示的最后一个 thinking block 的 ID（uuid:index），用于在 transcript 模式下隐藏历史 thinking */
  lastThinkingBlockId?: string | null;
  /** 最新一条用户 bash 输出消息的 UUID（用于自动展开） */
  latestBashOutputUUID?: string | null;
  /** 是否折叠此消息的 diff 显示 */
  shouldCollapseDiffs?: boolean;
};

function MessageImpl({
  message,
  lookups,
  containerWidth,
  addMargin,
  tools,
  commands,
  verbose,
  inProgressToolUseIDs,
  progressMessagesForMessage,
  shouldAnimate,
  shouldShowDot,
  style,
  width,
  isTranscriptMode,
  onOpenRateLimitOptions,
  isActiveCollapsedGroup,
  isUserContinuation = false,
  lastThinkingBlockId,
  latestBashOutputUUID,
  shouldCollapseDiffs,
}: Props): React.ReactNode {
  switch (message.type) {
    case 'attachment':
      return (
        <AttachmentMessage
          addMargin={addMargin}
          attachment={message.attachment as import('../utils/attachments.js').Attachment}
          verbose={verbose}
          isTranscriptMode={isTranscriptMode}
        />
      );
    case 'assistant':
      return (
        <Box flexDirection="column" width={containerWidth ?? '100%'}>
          {(message.message.content as BetaContentBlock[]).map((_, index) => (
            <AssistantMessageBlock
              key={index}
              param={_}
              addMargin={addMargin}
              tools={tools}
              commands={commands}
              verbose={verbose}
              inProgressToolUseIDs={inProgressToolUseIDs}
              progressMessagesForMessage={progressMessagesForMessage}
              shouldAnimate={shouldAnimate}
              shouldShowDot={shouldShowDot}
              width={width}
              inProgressToolCallCount={inProgressToolUseIDs.size}
              isTranscriptMode={isTranscriptMode}
              lookups={lookups}
              onOpenRateLimitOptions={onOpenRateLimitOptions}
              thinkingBlockId={`${message.uuid}:${index}`}
              lastThinkingBlockId={lastThinkingBlockId}
              advisorModel={message.advisorModel as string | undefined}
            />
          ))}
        </Box>
      );
    case 'user': {
      if (message.isCompactSummary) {
        return <CompactSummary message={message} screen={isTranscriptMode ? 'transcript' : 'prompt'} />;
      }
      // 预计算每个 content block 的 imageIndex prop。之前的版本在 .map()
      // 回调里递增计数器，这会让 React Compiler 放弃优化（"对 lambda 内
      // 捕获的变量执行 UpdateExpression"）。使用普通 for 循环把变量修改
      // 移出闭包，编译器才能对 MessageImpl 做记忆化。
      const imageIndices: number[] = [];
      let imagePosition = 0;
      for (const param of message.message.content as Array<{ type: string }>) {
        if (param.type === 'image') {
          const id = message.imagePasteIds?.[imagePosition];
          imagePosition++;
          imageIndices.push(id ?? imagePosition);
        } else {
          imageIndices.push(imagePosition);
        }
      }
      // 检查这条消息是否是最新 bash 输出 —— 如果是，用 provider 包装内容，
      // 这样 OutputLine 就能通过 context 展示完整输出
      const isLatestBashOutput = latestBashOutputUUID === message.uuid;
      const content = (
        <Box flexDirection="column" width={containerWidth ?? '100%'}>
          {(
            message.message.content as Array<
              TextBlockParam | ImageBlockParam | ToolUseBlockParam | ToolResultBlockParam
            >
          ).map((param, index) => (
            <UserMessage
              key={index}
              message={message}
              addMargin={addMargin}
              tools={tools}
              progressMessagesForMessage={progressMessagesForMessage}
              param={param}
              style={style}
              verbose={verbose}
              imageIndex={imageIndices[index]!}
              isUserContinuation={isUserContinuation}
              lookups={lookups}
              isTranscriptMode={isTranscriptMode}
              shouldCollapseDiffs={shouldCollapseDiffs}
            />
          ))}
        </Box>
      );
      return isLatestBashOutput ? <ExpandShellOutputProvider>{content}</ExpandShellOutputProvider> : content;
    }
    case 'system':
      if (message.subtype === 'compact_boundary') {
        // 全屏模式会在 ScrollBox 中保留 compact 之前的消息（REPL.tsx 采用
        // 追加而非重置，Messages.tsx 跳过边界过滤）—— 向上滚动即可查看历史，
        // 无需 ctrl+o 提示。
        if (isFullscreenEnvEnabled()) {
          return null;
        }
        return <CompactBoundaryMessage />;
      }
      if (message.subtype === 'microcompact_boundary') {
        // 在 createMicrocompactBoundaryMessage 中已记录日志
        return null;
      }
      if (feature('HISTORY_SNIP')) {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { isSnipBoundaryMessage } =
          require('../services/compact/snipProjection.js') as typeof import('../services/compact/snipProjection.js');
        const { isSnipMarkerMessage } =
          require('../services/compact/snipCompact.js') as typeof import('../services/compact/snipCompact.js');
        /* eslint-enable @typescript-eslint/no-require-imports */
        if (isSnipBoundaryMessage(message)) {
          /* eslint-disable @typescript-eslint/no-require-imports */
          const { SnipBoundaryMessage } =
            require('./messages/SnipBoundaryMessage.js') as typeof import('./messages/SnipBoundaryMessage.js');
          /* eslint-enable @typescript-eslint/no-require-imports */
          return <SnipBoundaryMessage message={message} />;
        }
        if (isSnipMarkerMessage(message)) {
          // 内部注册标记 —— 不向用户展示。上方的边界消息（boundary message）
          // 才是 snip 实际执行时显示的内容。
          return null;
        }
      }
      if (message.subtype === 'local_command') {
        return (
          <UserTextMessage
            addMargin={addMargin}
            param={{ type: 'text', text: String(message.content ?? '') }}
            verbose={verbose}
            isTranscriptMode={isTranscriptMode}
          />
        );
      }
      return (
        <SystemTextMessage
          message={message}
          addMargin={addMargin}
          verbose={verbose}
          isTranscriptMode={isTranscriptMode}
        />
      );
    case 'grouped_tool_use':
      return (
        <GroupedToolUseContent
          message={message}
          tools={tools}
          lookups={lookups}
          inProgressToolUseIDs={inProgressToolUseIDs}
          shouldAnimate={shouldAnimate}
        />
      );
    case 'collapsed_read_search':
      // OffscreenFreeze：工具完成时动词会从 "Reading…" 翻转为 "Read"。
      // 如果此时该分组已滚入 scrollback，这次更新会触发整个终端重置
      // （CC-1155）。这个组件在 prompt 模式下永远不会被标记为静态
      // （shouldRenderStatically 返回 false 以允许 API 轮次间的实时更新），
      // 因此 memo 也帮不上忙。在离屏时冻结 —— scrollback 中展示它离开时
      // 可见的状态即可。
      return (
        <OffscreenFreeze>
          <CollapsedReadSearchContent
            message={message}
            inProgressToolUseIDs={inProgressToolUseIDs}
            shouldAnimate={shouldAnimate}
            // ctrl+o transcript 模式应像 --verbose 一样展开该分组，
            // 这样被唤回的记忆 + 工具细节才能可见。
            // AttachmentMessage.tsx 中独立的 relevant_memories 分支
            // 已经检查了 (verbose || isTranscriptMode)；这里让折叠分组
            // 路径与之保持一致。
            verbose={verbose || isTranscriptMode}
            tools={tools}
            lookups={lookups}
            isActiveGroup={isActiveCollapsedGroup}
          />
        </OffscreenFreeze>
      );
  }
}

function UserMessage({
  message,
  addMargin,
  tools,
  progressMessagesForMessage,
  param,
  style,
  verbose,
  imageIndex,
  isUserContinuation,
  lookups,
  isTranscriptMode,
  shouldCollapseDiffs,
}: {
  message: NormalizedUserMessage;
  addMargin: boolean;
  tools: Tools;
  progressMessagesForMessage: ProgressMessage[];
  param: TextBlockParam | ImageBlockParam | ToolUseBlockParam | ToolResultBlockParam;
  style?: 'condensed';
  verbose: boolean;
  imageIndex?: number;
  isUserContinuation: boolean;
  lookups: ReturnType<typeof buildMessageLookups>;
  isTranscriptMode: boolean;
  shouldCollapseDiffs?: boolean;
}): React.ReactNode {
  const { columns } = useTerminalSize();
  switch (param.type) {
    case 'text':
      return (
        <UserTextMessage
          addMargin={addMargin}
          param={param}
          verbose={verbose}
          planContent={message.planContent as string | undefined}
          isTranscriptMode={isTranscriptMode}
          timestamp={message.timestamp as string | undefined}
        />
      );
    case 'image':
      // 如果上一条消息是用户消息（文本或图片），这是延续 —— 使用 connector
      // 否则这张图片开启一个新的用户轮次 —— 使用 margin
      return <UserImageMessage imageId={imageIndex} addMargin={addMargin && !isUserContinuation} />;
    case 'tool_result':
      return (
        <UserToolResultMessage
          param={param}
          message={message}
          lookups={lookups}
          progressMessagesForMessage={progressMessagesForMessage}
          style={style}
          tools={tools}
          verbose={verbose}
          width={columns - 5}
          isTranscriptMode={isTranscriptMode}
          shouldCollapseDiffs={shouldCollapseDiffs}
        />
      );
    default:
      return undefined;
  }
}

function AssistantMessageBlock({
  param,
  addMargin,
  tools,
  commands,
  verbose,
  inProgressToolUseIDs,
  progressMessagesForMessage,
  shouldAnimate,
  shouldShowDot,
  width,
  inProgressToolCallCount,
  isTranscriptMode,
  lookups,
  onOpenRateLimitOptions,
  thinkingBlockId,
  lastThinkingBlockId,
  advisorModel,
}: {
  param:
    | BetaContentBlock
    | ConnectorTextBlock
    | AdvisorBlock
    | TextBlockParam
    | ImageBlockParam
    | ThinkingBlockParam
    | ToolUseBlockParam
    | ToolResultBlockParam;
  addMargin: boolean;
  tools: Tools;
  commands: Command[];
  verbose: boolean;
  inProgressToolUseIDs: Set<string>;
  progressMessagesForMessage: ProgressMessage[];
  shouldAnimate: boolean;
  shouldShowDot: boolean;
  width?: number | string;
  inProgressToolCallCount?: number;
  isTranscriptMode: boolean;
  lookups: ReturnType<typeof buildMessageLookups>;
  onOpenRateLimitOptions?: () => void;
  /** 此 content block 的 message:index ID，用于 thinking block 比较 */
  thinkingBlockId: string;
  /** 要显示的最后一个 thinking block 的 ID，null 表示全部显示 */
  lastThinkingBlockId?: string | null;
  advisorModel?: string;
}): React.ReactNode {
  if (feature('CONNECTOR_TEXT')) {
    if (isConnectorTextBlock(param)) {
      return (
        <AssistantTextMessage
          param={{ type: 'text', text: param.connector_text }}
          addMargin={addMargin}
          shouldShowDot={shouldShowDot}
          verbose={verbose}
          width={width}
          onOpenRateLimitOptions={onOpenRateLimitOptions}
        />
      );
    }
  }
  switch (param.type) {
    case 'tool_use':
      return (
        <AssistantToolUseMessage
          param={param as ToolUseBlockParam}
          addMargin={addMargin}
          tools={tools}
          commands={commands}
          verbose={verbose}
          inProgressToolUseIDs={inProgressToolUseIDs}
          progressMessagesForMessage={progressMessagesForMessage}
          shouldAnimate={shouldAnimate}
          shouldShowDot={shouldShowDot}
          inProgressToolCallCount={inProgressToolCallCount}
          lookups={lookups}
          isTranscriptMode={isTranscriptMode}
        />
      );
    case 'text':
      return (
        <AssistantTextMessage
          param={param as TextBlockParam}
          addMargin={addMargin}
          shouldShowDot={shouldShowDot}
          verbose={verbose}
          width={width}
          onOpenRateLimitOptions={onOpenRateLimitOptions}
        />
      );
    case 'redacted_thinking':
      if (!isTranscriptMode && !verbose) {
        return null;
      }
      return <AssistantRedactedThinkingMessage addMargin={addMargin} />;
    case 'thinking': {
      if (!isTranscriptMode && !verbose) {
        return null;
      }
      // 在开启 hidePastThinking 的 transcript 模式下，只显示最后一个 thinking block
      const isLastThinking = !lastThinkingBlockId || thinkingBlockId === lastThinkingBlockId;
      return (
        <AssistantThinkingMessage
          addMargin={addMargin}
          param={param as ThinkingBlockParam | { type: 'thinking'; thinking: string }}
          isTranscriptMode={isTranscriptMode}
          verbose={verbose}
          hideInTranscript={isTranscriptMode && !isLastThinking}
        />
      );
    }
    case 'server_tool_use':
    case 'advisor_tool_result':
      if (isAdvisorBlock(param)) {
        return (
          <AdvisorMessage
            block={param}
            addMargin={addMargin}
            resolvedToolUseIDs={lookups.resolvedToolUseIDs}
            erroredToolUseIDs={lookups.erroredToolUseIDs}
            shouldAnimate={shouldAnimate}
            verbose={verbose || isTranscriptMode}
            advisorModel={advisorModel}
          />
        );
      }
      logError(new Error(`无法渲染 server tool block: ${param.type}`));
      return null;
    default:
      logError(new Error(`无法渲染消息类型: ${param.type}`));
      return null;
  }
}

export function hasThinkingContent(m: { type: string; message?: { content: Array<{ type: string }> } }): boolean {
  if (m.type !== 'assistant' || !m.message) return false;
  return m.message.content.some(b => b.type === 'thinking' || b.type === 'redacted_thinking');
}

/** 导出供测试使用 */
export function areMessagePropsEqual(prev: Props, next: Props): boolean {
  if (prev.message.uuid !== next.message.uuid) return false;
  // 仅当这条消息确实包含 thinking 内容时，才在 lastThinkingBlockId 变化时
  // 重新渲染 —— 否则每当流式 thinking 开始/停止时，scrollback 中的每条消息
  // 都会重新渲染（CC-941）。
  if (
    prev.lastThinkingBlockId !== next.lastThinkingBlockId &&
    hasThinkingContent(next.message as Parameters<typeof hasThinkingContent>[0])
  ) {
    return false;
  }
  // Verbose 开关会改变 thinking block 的可见性/展开状态
  if (prev.verbose !== next.verbose) return false;
  // 仅当这条消息的"是否为最新 bash 输出"状态发生变化时才重新渲染，
  // 而不是当全局 latestBashOutputUUID 变成另一条消息时
  const prevIsLatest = prev.latestBashOutputUUID === prev.message.uuid;
  const nextIsLatest = next.latestBashOutputUUID === next.message.uuid;
  if (prevIsLatest !== nextIsLatest) return false;
  if (prev.isTranscriptMode !== next.isTranscriptMode) return false;
  // containerWidth 在无 metadata 路径下是一个绝对数值（会跳过包装 Box）。
  // 静态消息必须在终端尺寸变化时重新渲染。
  if (prev.containerWidth !== next.containerWidth) return false;
  if (prev.isStatic && next.isStatic) return true;
  return false;
}

export const Message = React.memo(MessageImpl, areMessagePropsEqual);
