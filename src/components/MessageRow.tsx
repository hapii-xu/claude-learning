import * as React from 'react';
import type { Command } from '../commands.js';
import { Box } from '@anthropic/ink';
import type { Screen } from '../screens/REPL.js';
import type { Tools } from '../Tool.js';
import type { RenderableMessage } from '../types/message.js';
import {
  getDisplayMessageFromCollapsed,
  getSearchExtraToolsOrReadInfo,
  getToolUseIdsFromCollapsedGroup,
  hasAnyToolInProgress,
} from '../utils/collapseReadSearch.js';
import {
  type buildMessageLookups,
  EMPTY_STRING_SET,
  getProgressMessagesFromLookup,
  getSiblingToolUseIDsFromLookup,
  getToolUseID,
} from '../utils/messages.js';
import { hasThinkingContent, Message } from './Message.js';

// 把 MessageContent 的第一个元素收窄为具有已知结构的 block。
type ContentBlock = {
  type: string;
  name?: string;
  input?: unknown;
  id?: string;
  text?: string;
  [key: string]: unknown;
};
const firstBlock = (content: unknown): ContentBlock | undefined => {
  if (!Array.isArray(content)) return undefined;
  const b = content[0];
  if (b == null || typeof b === 'string') return undefined;
  return b as ContentBlock;
};
import { MessageModel } from './MessageModel.js';
import { shouldRenderStatically } from './Messages.js';
import { MessageTimestamp } from './MessageTimestamp.js';
import { OffscreenFreeze } from './OffscreenFreeze.js';

export type Props = {
  message: RenderableMessage;
  /** renderableMessages 中上一条消息是否也是用户消息。 */
  isUserContinuation: boolean;
  /**
   * 此消息之后在 renderableMessages 中是否还有不可跳过的内容。
   * 只需对 `collapsed_read_search` 消息保证准确 —— 用于决定折叠分组的
   * spinner 是否应保持活动状态。其他情况传 `false` 即可。
   */
  hasContentAfter: boolean;
  tools: Tools;
  commands: Command[];
  verbose: boolean;
  inProgressToolUseIDs: Set<string>;
  streamingToolUseIDs: Set<string>;
  screen: Screen;
  canAnimate: boolean;
  onOpenRateLimitOptions?: () => void;
  lastThinkingBlockId: string | null;
  latestBashOutputUUID: string | null;
  columns: number;
  isLoading: boolean;
  lookups: ReturnType<typeof buildMessageLookups>;
  shouldCollapseDiffs?: boolean;
};

/**
 * 从 `index+1` 向前扫描，检查后面是否还有"真正的"内容。用于决定
 * 一个折叠的读/搜索分组是否应在其活动状态（灰点、现在时 "Reading…"）
 * 下保持，而查询仍在加载中。
 *
 * 导出供 Messages.tsx 对每条消息计算一次并以布尔 prop 传入 —— 避免把
 * 完整的 `renderableMessages` 数组传给每个 MessageRow（React Compiler 会
 * 把它钉在 fiber 的 memoCache 里，在 7 轮会话中累积约 1-2MB 的历史版本）。
 */
export function hasContentAfterIndex(
  messages: RenderableMessage[],
  index: number,
  tools: Tools,
  streamingToolUseIDs: Set<string>,
): boolean {
  for (let i = index + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.type === 'assistant') {
      const content = firstBlock(msg.message.content);
      if (content?.type === 'thinking' || content?.type === 'redacted_thinking') {
        continue;
      }
      if (content?.type === 'tool_use') {
        if (getSearchExtraToolsOrReadInfo(content.name!, content.input, tools).isCollapsible) {
          continue;
        }
        // 不可折叠的工具调用会先出现在 syntheticStreamingToolUseMessages 中，
        // 之后其 ID 才会被加入 inProgressToolUseIDs。在流式过程中跳过，
        // 以避免读分组被短暂地最终化。
        if (streamingToolUseIDs.has(content.id!)) {
          continue;
        }
      }
      return true;
    }
    if (msg?.type === 'system' || msg?.type === 'attachment') {
      continue;
    }
    // 工具结果在折叠分组仍在构建时到达
    if (msg?.type === 'user') {
      const content = firstBlock(msg.message.content);
      if (content?.type === 'tool_result') {
        continue;
      }
    }
    // 可折叠的 grouped_tool_use 消息会短暂出现，随后在下一个渲染周期
    // 被合并进当前的折叠分组
    if (msg?.type === 'grouped_tool_use') {
      const firstInput = firstBlock(msg.messages[0]?.message.content)?.input;
      if (getSearchExtraToolsOrReadInfo(msg.toolName, firstInput, tools).isCollapsible) {
        continue;
      }
    }
    return true;
  }
  return false;
}

function MessageRowImpl({
  message: msg,
  isUserContinuation,
  hasContentAfter,
  tools,
  commands,
  verbose,
  inProgressToolUseIDs,
  streamingToolUseIDs,
  screen,
  canAnimate,
  onOpenRateLimitOptions,
  lastThinkingBlockId,
  latestBashOutputUUID,
  columns,
  isLoading,
  lookups,
  shouldCollapseDiffs,
}: Props): React.ReactNode {
  const isTranscriptMode = screen === 'transcript';
  const isGrouped = msg.type === 'grouped_tool_use';
  const isCollapsed = msg.type === 'collapsed_read_search';

  // 一个折叠分组是"活动的"（灰点、现在时 "Reading…"）—— 当其工具仍在执行，
  // 或整体查询仍在运行且其后没有内容时。hasAnyToolInProgress 优先级最高：
  // 如果有工具在跑，无论消息列表中还有什么，都始终显示为活动状态
  // （避免并行执行时被误判为已最终化）。
  const isActiveCollapsedGroup =
    isCollapsed && (hasAnyToolInProgress(msg, inProgressToolUseIDs) || (isLoading && !hasContentAfter));

  const displayMsg = isGrouped ? msg.displayMessage : isCollapsed ? getDisplayMessageFromCollapsed(msg) : msg;

  const progressMessagesForMessage = isGrouped || isCollapsed ? [] : getProgressMessagesFromLookup(msg, lookups);

  const siblingToolUseIDs = isGrouped || isCollapsed ? EMPTY_STRING_SET : getSiblingToolUseIDsFromLookup(msg, lookups);

  const isStatic = shouldRenderStatically(
    msg,
    streamingToolUseIDs,
    inProgressToolUseIDs,
    siblingToolUseIDs,
    screen,
    lookups,
  );

  let shouldAnimate = false;
  if (canAnimate) {
    if (isGrouped) {
      shouldAnimate = msg.messages.some(m => {
        const content = firstBlock(m.message.content);
        return content?.type === 'tool_use' && inProgressToolUseIDs.has(content.id!);
      });
    } else if (isCollapsed) {
      shouldAnimate = hasAnyToolInProgress(msg, inProgressToolUseIDs);
    } else {
      const toolUseID = getToolUseID(msg);
      shouldAnimate = !toolUseID || inProgressToolUseIDs.has(toolUseID);
    }
  }

  const hasMetadata =
    isTranscriptMode &&
    displayMsg.type === 'assistant' &&
    Array.isArray(displayMsg.message.content) &&
    (displayMsg.message.content as Array<{ type: string }>).some(c => c.type === 'text') &&
    (displayMsg.timestamp || displayMsg.message.model);

  const messageEl = (
    <Message
      message={msg as Parameters<typeof Message>[0]['message']}
      lookups={lookups}
      addMargin={!hasMetadata}
      containerWidth={hasMetadata ? undefined : columns}
      tools={tools}
      commands={commands}
      verbose={verbose}
      inProgressToolUseIDs={inProgressToolUseIDs}
      progressMessagesForMessage={progressMessagesForMessage}
      shouldAnimate={shouldAnimate}
      shouldShowDot={true}
      isTranscriptMode={isTranscriptMode}
      isStatic={isStatic}
      onOpenRateLimitOptions={onOpenRateLimitOptions}
      isActiveCollapsedGroup={isActiveCollapsedGroup}
      isUserContinuation={isUserContinuation}
      lastThinkingBlockId={lastThinkingBlockId}
      latestBashOutputUUID={latestBashOutputUUID}
      shouldCollapseDiffs={shouldCollapseDiffs}
    />
  );
  // OffscreenFreeze：外层的 React.memo 对静态消息已经会跳过，
  // 所以这里只包装那些会重新渲染的行 —— 进行中的工具、折叠的
  // 读/搜索 spinner、bash 计时器。当这些行已滚入终端 scrollback
  // （非全屏的外部构建版本）时，任何内容变化都会迫使 log-update.ts
  // 每个时钟周期做一次完整终端重置。冻结后返回缓存的 element ref，
  // 让 React 跳过并产出零 diff。
  if (!hasMetadata) {
    return <OffscreenFreeze>{messageEl}</OffscreenFreeze>;
  }
  // margin 放在子元素上，而不是这里 —— 否则 null 项（hook_success 等）会出现幽灵式的 1 行间距。
  return (
    <OffscreenFreeze>
      <Box width={columns} flexDirection="column">
        <Box flexDirection="row" justifyContent="flex-end" gap={1} marginTop={1}>
          <MessageTimestamp message={displayMsg} isTranscriptMode={isTranscriptMode} />
          <MessageModel message={displayMsg} isTranscriptMode={isTranscriptMode} />
        </Box>
        {messageEl}
      </Box>
    </OffscreenFreeze>
  );
}

/**
 * 检查一条消息是否处于"流式"状态 —— 即其内容可能仍在变化。
 * 导出供测试使用。
 */
export function isMessageStreaming(msg: RenderableMessage, streamingToolUseIDs: Set<string>): boolean {
  if (msg.type === 'grouped_tool_use') {
    return msg.messages.some(m => {
      const content = firstBlock(m.message.content);
      return content?.type === 'tool_use' && streamingToolUseIDs.has(content.id!);
    });
  }
  if (msg.type === 'collapsed_read_search') {
    const toolIds = getToolUseIdsFromCollapsedGroup(msg);
    return toolIds.some(id => streamingToolUseIDs.has(id));
  }
  const toolUseID = getToolUseID(msg);
  return !!toolUseID && streamingToolUseIDs.has(toolUseID);
}

/**
 * 检查一条消息中的所有工具是否都已 resolved。
 * 导出供测试使用。
 */
export function allToolsResolved(msg: RenderableMessage, resolvedToolUseIDs: Set<string>): boolean {
  if (msg.type === 'grouped_tool_use') {
    return msg.messages.every(m => {
      const content = firstBlock(m.message.content);
      return content?.type === 'tool_use' && resolvedToolUseIDs.has(content.id!);
    });
  }
  if (msg.type === 'collapsed_read_search') {
    const toolIds = getToolUseIdsFromCollapsedGroup(msg);
    return toolIds.every(id => resolvedToolUseIDs.has(id));
  }
  if (msg.type === 'assistant') {
    const block = firstBlock(msg.message.content);
    if (block?.type === 'server_tool_use') {
      return resolvedToolUseIDs.has(block.id!);
    }
  }
  const toolUseID = getToolUseID(msg);
  return !toolUseID || resolvedToolUseIDs.has(toolUseID);
}

/**
 * 保守的 memo 比较器：仅当我们确定消息不会变化时才跳过重新渲染。
 * 不确定时安全地选择重新渲染。
 *
 * 导出供测试使用。
 */
export function areMessageRowPropsEqual(prev: Props, next: Props): boolean {
  // 不同的消息引用 = 内容可能已变化，必须重新渲染
  if (prev.message !== next.message) return false;

  // Screen 模式变化 = 重新渲染
  if (prev.screen !== next.screen) return false;

  // Verbose 开关会改变 thinking block 的可见性
  if (prev.verbose !== next.verbose) return false;

  // collapsed_read_search 在 prompt 模式下永远不会是静态的（与 shouldRenderStatically 一致）
  if (prev.message.type === 'collapsed_read_search' && next.screen !== 'transcript') {
    return false;
  }

  // 宽度变化会影响 Box 布局
  if (prev.columns !== next.columns) return false;

  // latestBashOutputUUID 影响渲染（完整 vs 截断输出）
  const prevIsLatestBash = prev.latestBashOutputUUID === prev.message.uuid;
  const nextIsLatestBash = next.latestBashOutputUUID === next.message.uuid;
  if (prevIsLatestBash !== nextIsLatestBash) return false;

  // lastThinkingBlockId 影响 thinking block 的可见性 —— 但仅对
  // 确实包含 thinking 内容的消息生效。无条件检查会让每次 thinking
  // 开始/停止时所有 scrollback 消息的 memo 都失效（CC-941）。
  if (
    prev.lastThinkingBlockId !== next.lastThinkingBlockId &&
    hasThinkingContent(next.message as Parameters<typeof hasThinkingContent>[0])
  ) {
    return false;
  }

  // 检查这条消息是否仍"在途"
  const isStreaming = isMessageStreaming(prev.message, prev.streamingToolUseIDs);
  const isResolved = allToolsResolved(prev.message, prev.lookups.resolvedToolUseIDs);

  // 只有真正静态的消息才跳过重新渲染
  if (isStreaming || !isResolved) return false;

  // 静态消息 —— 可安全跳过重新渲染
  return true;
}

export const MessageRow = React.memo(MessageRowImpl, areMessageRowPropsEqual);
