import { feature } from 'bun:bundle';
import chalk from 'chalk';
import { SentryErrorBoundary } from './SentryErrorBoundary.js';
import type { UUID } from 'crypto';
import type { RefObject } from 'react';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { every } from 'src/utils/set.js';
import { getIsRemoteMode } from '../bootstrap/state.js';
import type { Command } from '../commands.js';
import { BLACK_CIRCLE } from '../constants/figures.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import type { ScrollBoxHandle } from '@anthropic/ink';
import { useTerminalNotification } from '@anthropic/ink';
import { Box, Text } from '@anthropic/ink';
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js';
import type { Screen } from '../screens/REPL.js';
import type { Tools } from '../Tool.js';
import { findToolByName } from '../Tool.js';
import type { AgentDefinitionsResult } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js';
import type {
  AssistantMessage,
  Message as MessageType,
  NormalizedMessage,
  ProgressMessage as ProgressMessageType,
  RenderableMessage,
} from '../types/message.js';
import { type AdvisorBlock, isAdvisorBlock } from '../utils/advisor.js';
import { collapseBackgroundBashNotifications } from '../utils/collapseBackgroundBashNotifications.js';
import { collapseHookSummaries } from '../utils/collapseHookSummaries.js';
import { collapseReadSearchGroups } from '../utils/collapseReadSearch.js';
import { collapseTeammateShutdowns } from '../utils/collapseTeammateShutdowns.js';
import { getGlobalConfig } from '../utils/config.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js';
import { applyGrouping } from '../utils/groupToolUses.js';
import {
  buildMessageLookups,
  computeMessageStructureKey,
  type MessageLookups,
  updateMessageLookupsIncremental,
  createAssistantMessage,
  deriveUUID,
  getMessagesAfterCompactBoundary,
  getToolUseID,
  getToolUseIDs,
  hasUnresolvedHooksFromLookup,
  isNotEmptyMessage,
  normalizeMessages,
  reorderMessagesInUI,
  type StreamingThinking,
  type StreamingToolUse,
  shouldShowUserMessage,
} from '../utils/messages.js';
import { renderableSearchText } from '../utils/transcriptSearch.js';
import { Divider } from '@anthropic/ink';
import type { UnseenDivider } from './FullscreenLayout.js';
import { LogoV2 } from './LogoV2/LogoV2.js';
import { StreamingMarkdown } from './Markdown.js';
import { hasContentAfterIndex, MessageRow } from './MessageRow.js';
import {
  InVirtualListContext,
  type MessageActionsNav,
  MessageActionsSelectedContext,
  type MessageActionsState,
} from './messageActions.js';
import { AssistantThinkingMessage } from './messages/AssistantThinkingMessage.js';
import { isNullRenderingAttachment } from './messages/nullRenderingAttachments.js';
import { OffscreenFreeze } from './OffscreenFreeze.js';
import type { ToolUseConfirm } from './permissions/PermissionRequest.js';
import { StatusNotices } from './StatusNotices.js';
import type { JumpHandle } from './VirtualMessageList.js';

// 已 memo 的 logo 头部：在主屏模式下，这个 Box 是所有 MessageRows 之前的第一个兄弟节点。
// 如果它在每次 Messages 重新渲染时都变脏，renderChildren 的 seenDirtyChild 级联
// 会为所有后续兄弟节点禁用 prevScreen（blit）—— 每个 MessageRow 都会从零重写
// 而不是 blit。在长 session（约 2800 条消息）下，这会达到 15 万+ 次/帧的写入，
// CPU 占用 100%。对 agentDefinitions 做 memo，这样新的 messages 数组
// 不会让 logo 子树失效。LogoV2/StatusNotices 内部自行
// 订阅 useAppState/useSettings 以完成各自更新。
const LogoHeader = React.memo(function LogoHeader({
  agentDefinitions,
}: {
  agentDefinitions: AgentDefinitionsResult | undefined;
}): React.ReactNode {
  // LogoV2 自带内部 OffscreenFreeze（捕获其 useAppState
  // 重新渲染）。这层外层 freeze 捕获 agentDefinitions 变化，以及
  // 头部处于 scrollback 中时任何未来的 StatusNotices 订阅。
  return (
    <OffscreenFreeze>
      <Box flexDirection="column" gap={1}>
        <LogoV2 />
        <React.Suspense fallback={null}>
          <StatusNotices agentDefinitions={agentDefinitions} />
        </React.Suspense>
      </Box>
    </OffscreenFreeze>
  );
});

// 死代码消除：proactive 模式的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule = feature('PROACTIVE') || feature('KAIROS') ? require('../proactive/index.js') : null;
const BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('@claude-code-best/builtin-tools/tools/BriefTool/prompt.js') as typeof import('@claude-code-best/builtin-tools/tools/BriefTool/prompt.js')
      ).BRIEF_TOOL_NAME
    : null;
const SEND_USER_FILE_TOOL_NAME: string | null = feature('KAIROS')
  ? (
      require('@claude-code-best/builtin-tools/tools/SendUserFileTool/prompt.js') as typeof import('@claude-code-best/builtin-tools/tools/SendUserFileTool/prompt.js')
    ).SEND_USER_FILE_TOOL_NAME
  : null;

/* eslint-enable @typescript-eslint/no-require-imports */
import { VirtualMessageList } from './VirtualMessageList.js';

/**
 * 在 brief-only 模式下，过滤消息只显示 Brief tool_use block、
 * 其对应的 tool_result，以及真实的用户输入。所有 assistant 文本都被丢弃 ——
 * 如果模型忘记调用 Brief，用户在该轮将看不到任何内容。
 * 这由模型自己保证正确；过滤器不会替它做二次判断。
 */
export function filterForBriefTool<
  T extends {
    type: string;
    subtype?: string;
    isMeta?: boolean;
    isApiErrorMessage?: boolean;
    message?: {
      content: Array<{
        type: string;
        name?: string;
        tool_use_id?: string;
      }>;
    };
    attachment?: {
      type: string;
      isMeta?: boolean;
      origin?: unknown;
      commandMode?: string;
    };
  },
>(messages: T[], briefToolNames: string[]): T[] {
  const nameSet = new Set(briefToolNames);
  // tool_use 在数组中总是位于其 tool_result 之前，因此可以在一次遍历中
  // 收集 ID 并与之匹配。
  const briefToolUseIDs = new Set<string>();
  return messages.filter(msg => {
    // 系统消息（附件确认、远端错误、compact 边界）
    // 必须保持可见 —— 丢弃它们会让查看者得不到任何反馈。
    // 例外：api_metrics 是每轮的调试噪声（TTFT、config 写入、
    // hook 耗时），会破坏 brief 模式的初衷。在 transcript 模式
    // （ctrl+o）下仍然可见，该模式会绕过此过滤器。
    if (msg.type === 'system') return msg.subtype !== 'api_metrics';
    const block = msg.message?.content[0];
    if (msg.type === 'assistant') {
      // API 错误消息（鉴权失败、限流等）必须保持可见
      if (msg.isApiErrorMessage) return true;
      // 保留 Brief tool_use block（以标准工具调用样式渲染，
      // 且必须留在列表中以便 buildMessageLookups 解析工具结果）
      if (block?.type === 'tool_use' && block.name && nameSet.has(block.name)) {
        if ('id' in block) {
          briefToolUseIDs.add((block as { id: string }).id);
        }
        return true;
      }
      return false;
    }
    if (msg.type === 'user') {
      if (block?.type === 'tool_result') {
        return block.tool_use_id !== undefined && briefToolUseIDs.has(block.tool_use_id);
      }
      // 仅保留真实用户输入 —— 丢弃 meta/tick 消息。
      return !msg.isMeta;
    }
    if (msg.type === 'attachment') {
      // 用户在轮次中途输入的内容会作为 queued_command 附件到达
      // （query.ts 的 mid-chain drain → getQueuedCommandAttachments）。保留它 ——
      // 这正是用户输入的内容。commandMode === 'prompt' 能正向
      // 识别人工输入；task-notification 调用方会设置
      // mode: 'task-notification' 但不设置 origin/isMeta，因此必须用正向
      // commandMode 检查来排除它们。
      const att = msg.attachment;
      return att?.type === 'queued_command' && att.commandMode === 'prompt' && !att.isMeta && att.origin === undefined;
    }
    return false;
  });
}

/**
 * filterForBriefTool 的完整 transcript 配套函数。当 Brief 工具
 * 在使用时，模型的文本输出与其紧接着写的 SendUserMessage
 * 内容重复 —— 丢弃这些文本，只展示 SendUserMessage block。
 * 工具调用及其结果保持可见。
 *
 * 按轮次处理：仅在真正调用了 Brief 的轮次中丢弃文本。如果
 * 模型忘了调用，文本仍然展示 —— 否则用户将什么都看不到。
 */
export function dropTextInBriefTurns<
  T extends {
    type: string;
    isMeta?: boolean;
    message?: { content: Array<{ type: string; name?: string }> };
  },
>(messages: T[], briefToolNames: string[]): T[] {
  const nameSet = new Set(briefToolNames);
  // 第一遍：找出哪些轮次（以非 meta 的 user 消息为界）包含
  // Brief tool_use。为每个 assistant 文本 block 打上其轮次索引。
  const turnsWithBrief = new Set<number>();
  const textIndexToTurn: number[] = [];
  let turn = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const block = msg.message?.content[0];
    if (msg.type === 'user' && block?.type !== 'tool_result' && !msg.isMeta) {
      turn++;
      continue;
    }
    if (msg.type === 'assistant') {
      if (block?.type === 'text') {
        textIndexToTurn[i] = turn;
      } else if (block?.type === 'tool_use' && block.name && nameSet.has(block.name)) {
        turnsWithBrief.add(turn);
      }
    }
  }
  if (turnsWithBrief.size === 0) return messages;
  // 第二遍：丢弃其轮次调用了 Brief 的文本 block。
  return messages.filter((_, i) => {
    const t = textIndexToTurn[i];
    return t === undefined || !turnsWithBrief.has(t);
  });
}

type Props = {
  messages: MessageType[];
  tools: Tools;
  commands: Command[];
  verbose: boolean;
  toolJSX: {
    jsx: React.ReactNode | null;
    shouldHidePromptInput: boolean;
    shouldContinueAnimation?: true;
  } | null;
  toolUseConfirmQueue: ToolUseConfirm[];
  inProgressToolUseIDs: Set<string>;
  isMessageSelectorVisible: boolean;
  conversationId: string;
  screen: Screen;
  streamingToolUses: StreamingToolUse[];
  showAllInTranscript?: boolean;
  agentDefinitions?: AgentDefinitionsResult;
  onOpenRateLimitOptions?: () => void;
  /** 隐藏 logo/头部 —— 用于 subagent 缩放视图 */
  hideLogo?: boolean;
  isLoading: boolean;
  /** 在 transcript 模式下，除最后一条外隐藏所有 thinking block */
  hidePastThinking?: boolean;
  /** 流式 thinking 内容（实时更新，未冻结） */
  streamingThinking?: StreamingThinking | null;
  /** 流式文本预览（作为最后一项渲染，使过渡到最终消息时位置无缝衔接） */
  streamingText?: string | null;
  /** 为 true 时仅显示 Brief 工具输出（隐藏其他所有内容） */
  isBriefOnly?: boolean;
  /** 全屏模式的「─── N 条新消息 ───」分割线。渲染在第一个
   *  由 firstUnseenUuid 派生的 renderableMessage 之前（通过 deriveUUID
   *  保留的 24 字符前缀进行匹配）。 */
  unseenDivider?: UnseenDivider;
  /** 全屏模式的 ScrollBox handle。存在时启用 React 层虚拟化。 */
  scrollRef?: RefObject<ScrollBoxHandle | null>;
  /** 全屏模式：启用 sticky-prompt 跟踪（通过 ScrollChromeContext 写入）。 */
  trackStickyPrompt?: boolean;
  /** Transcript 搜索：jump-to-index + setSearchQuery/nextMatch/prevMatch。 */
  jumpRef?: RefObject<JumpHandle | null>;
  /** Transcript 搜索：匹配数量/位置变化时触发。 */
  onSearchMatchesChange?: (count: number, current: number) => void;
  /** 将既有 DOM 子树绘制到新的 Screen 并扫描。元素来自
   *  主树（所有真实 provider）。位置相对于 message。 */
  scanElement?: (el: import('@anthropic/ink').DOMElement) => import('@anthropic/ink').MatchPosition[];
  /** 基于位置的 CURRENT 高亮。positions 稳定（相对于 message），
   *  rowOffset 跟踪滚动。传 null 清除。 */
  setPositions?: (
    state: {
      positions: import('@anthropic/ink').MatchPosition[];
      rowOffset: number;
      currentIdx: number;
    } | null,
  ) => void;
  /** 绕过 MAX_MESSAGES_WITHOUT_VIRTUALIZATION。用于一次性 headless 渲染
   *  （例如 /export 通过 renderToString），此时内存担忧不适用，
   *  且「已在 scrollback 中」这一理由也不成立。 */
  disableRenderCap?: boolean;
  /** Transcript 内的光标；expanded 会覆盖所选消息的 verbose 设置。 */
  cursor?: MessageActionsState | null;
  setCursor?: (cursor: MessageActionsState | null) => void;
  /** 透传给 VirtualMessageList（heightCache 拥有可见性）。 */
  cursorNavRef?: React.Ref<MessageActionsNav>;
  /** 仅渲染 collapsed.slice(start, end)。用于分块 headless 导出
   *  （exportRenderer.tsx 中的 streamRenderedMessages）：prep 在完整的
   *  messages 数组上运行以保证 grouping/lookups 正确，但只输出这个切片
   *  而非整个 session。logo 仅在 chunk 0（start === 0）时渲染；
   *  后续 chunk 是流中延续。
   *  2026 年 3 月实测：538 条消息的 session，20 个切片 → 平台 RSS 降低 55%。 */
  renderRange?: readonly [start: number, end: number];
};

const MAX_MESSAGES_TO_SHOW_IN_TRANSCRIPT_MODE = 30;

// 非虚拟化渲染路径（全屏关闭或被显式禁用）的安全上限。Ink 为每条
// 消息挂载完整的 fiber 树（每条约 250 KB RSS）；yoga 布局高度无界增长；
// 屏幕缓冲按容纳所有行来分配。在约 2000 条消息时，这会是约 3000 行的
// 屏幕、约 500 MB 的 fiber，以及每帧写入成本把进程推入 GC
// 死亡螺旋（观测到：59 GB RSS，每秒 1.4 万次 mmap/munmap）。从该切片
// 丢弃的内容早已打印到终端 scrollback —— 用户仍可原生向上滚动。
// VirtualMessageList（默认 ant 路径）完全绕过此上限。Headless 一次性
// 渲染（例如 /export）通过 disableRenderCap 主动退出 —— 它们没有
// scrollback，且内存担忧对 renderToString 不适用。
//
// 切片边界以 UUID 锚点跟踪，而非基于计数的索引。基于计数的切片
// （slice(-200)）每次追加都从前面丢弃一条消息，导致 scrollback 内容
// 位移并迫使每轮进行完整终端重置（CC-941）。量化为 50 条消息步长
// （CC-1154）有所改善，但在 compaction 和 collapse 重新分组时仍会位移，
// 因为它们在不增加消息的情况下改变 collapsed.length。UUID
// 锚点仅在渲染计数真正超过 CAP+STEP 时才推进 ——
// 对 grouping/compaction 导致的长度波动免疫（CC-1174）。
//
// 锚点同时存储 uuid 和 index。部分 uuid 在多次渲染间不稳定：
// collapseHookSummaries 从分组中第一条 summary 派生合并后的 uuid，
// 但 reorderMessagesInUI 会在工具结果流入时重新调整 hook 邻接关系，
// 改变哪条 summary 排在第一。当 uuid
// 消失时，回退到存储的 index（经 clamp 处理）使切片大致保持在原位，
// 而不是重置为 0 —— 否则会从约 200 条已渲染消息
// 跳到完整历史，使 scrollback 中进行中的 badge 快照成为孤儿。
const MAX_MESSAGES_WITHOUT_VIRTUALIZATION = 200;
const MESSAGE_CAP_STEP = 50;

export type SliceAnchor = { uuid: string; idx: number } | null;

/** 导出用于测试。当窗口需要推进时修改 anchorRef。 */
export function computeSliceStart(
  collapsed: ReadonlyArray<{ uuid: string }>,
  anchorRef: { current: SliceAnchor },
  cap = MAX_MESSAGES_WITHOUT_VIRTUALIZATION,
  step = MESSAGE_CAP_STEP,
): number {
  const anchor = anchorRef.current;
  const anchorIdx = anchor ? collapsed.findIndex(m => m.uuid === anchor.uuid) : -1;
  // 找到锚点 → 使用之。锚点丢失 → 回退到存储的 index
  // （经 clamp），这样 collapse 重新分组导致的 uuid 抖动不会重置为 0。
  let start = anchorIdx >= 0 ? anchorIdx : anchor ? Math.min(anchor.idx, Math.max(0, collapsed.length - cap)) : 0;
  if (collapsed.length - start > cap + step) {
    start = collapsed.length - cap;
  }
  // 从当前 start 处的内容刷新锚点 —— 在回退后修复
  // 过期的 uuid，并在推进后捕获新 uuid。
  const msgAtStart = collapsed[start];
  if (msgAtStart && (anchor?.uuid !== msgAtStart.uuid || anchor.idx !== start)) {
    anchorRef.current = { uuid: msgAtStart.uuid, idx: start };
  } else if (!msgAtStart && anchor) {
    anchorRef.current = null;
  }
  return start;
}

const MessagesImpl = ({
  messages,
  tools,
  commands,
  verbose,
  toolJSX,
  toolUseConfirmQueue,
  inProgressToolUseIDs,
  isMessageSelectorVisible,
  conversationId,
  screen,
  streamingToolUses,
  showAllInTranscript = false,
  agentDefinitions,
  onOpenRateLimitOptions,
  hideLogo = false,
  isLoading,
  hidePastThinking = false,
  streamingThinking,
  streamingText,
  isBriefOnly = false,
  unseenDivider,
  scrollRef,
  trackStickyPrompt,
  jumpRef,
  onSearchMatchesChange,
  scanElement,
  setPositions,
  disableRenderCap = false,
  cursor = null,
  setCursor,
  cursorNavRef,
  renderRange,
}: Props): React.ReactNode => {
  const { columns } = useTerminalSize();
  const toggleShowAllShortcut = useShortcutDisplay('transcript:toggleShowAll', 'Transcript', 'Ctrl+E');

  const normalizedMessages = useMemo(() => normalizeMessages(messages).filter(isNotEmptyMessage), [messages]);

  // 检查流式 thinking 是否应可见（正在流式输出或处于 30 秒超时窗口内）
  const isStreamingThinkingVisible = useMemo(() => {
    if (!streamingThinking) return false;
    if (streamingThinking.isStreaming) return true;
    if (streamingThinking.streamingEndedAt) {
      return Date.now() - streamingThinking.streamingEndedAt < 30000;
    }
    return false;
  }, [streamingThinking]);

  // 在一次反向遍历中同时找到最后一个 thinking block 和最近的 bash 输出。
  // 由两次独立的反向遍历合并而来，以减少总遍历次数。
  const { lastThinkingBlockId, latestBashOutputUUID } = useMemo(() => {
    let thinkingId: string | null = null;
    let bashUUID: string | null = null;
    const needThinkingScan = hidePastThinking && !isStreamingThinkingVisible;
    if (hidePastThinking && isStreamingThinkingVisible) {
      thinkingId = 'streaming';
    }
    for (let i = normalizedMessages.length - 1; i >= 0; i--) {
      const msg = normalizedMessages[i];
      if (msg?.type === 'user') {
        const content = msg.message!.content as Array<{ type: string; text?: string }>;
        // bash 输出检测
        if (!bashUUID) {
          for (const block of content) {
            if (block.type === 'text') {
              const text = block.text ?? '';
              if (text.startsWith('<bash-stdout') || text.startsWith('<bash-stderr')) {
                bashUUID = msg.uuid;
                break;
              }
            }
          }
        }
        // thinking 停止条件 —— 到达一个不含工具结果的前序 user 轮次
        if (needThinkingScan && !thinkingId) {
          const hasToolResult = content.some(block => block.type === 'tool_result');
          if (!hasToolResult) {
            thinkingId = 'no-thinking';
          }
        }
      } else if (msg?.type === 'assistant') {
        if (needThinkingScan && !thinkingId) {
          const content = msg.message!.content as Array<{ type: string }>;
          for (let j = content.length - 1; j >= 0; j--) {
            if (content[j]?.type === 'thinking') {
              thinkingId = `${msg.uuid}:${j}`;
              break;
            }
          }
        }
      }
      if (thinkingId !== null && bashUUID) break;
    }
    if (!hidePastThinking) {
      thinkingId = null;
    }
    return { lastThinkingBlockId: thinkingId, latestBashOutputUUID: bashUUID };
  }, [normalizedMessages, hidePastThinking, isStreamingThinkingVisible]);

  // streamingToolUses 在每个 input_json_delta 时更新，而 normalizedMessages
  // 保持稳定 —— 预先计算 Set，使过滤器在每个 chunk 上为 O(k) 而非 O(n×k)。
  const normalizedToolUseIDs = useMemo(() => getToolUseIDs(normalizedMessages), [normalizedMessages]);

  const streamingToolUsesWithoutInProgress = useMemo(
    () =>
      streamingToolUses.filter(
        stu => !inProgressToolUseIDs.has(stu.contentBlock.id) && !normalizedToolUseIDs.has(stu.contentBlock.id),
      ),
    [streamingToolUses, inProgressToolUseIDs, normalizedToolUseIDs],
  );

  const syntheticStreamingToolUseMessages = useMemo(
    () =>
      streamingToolUsesWithoutInProgress.flatMap(streamingToolUse => {
        const msg = createAssistantMessage({
          content: [streamingToolUse.contentBlock],
        });
        // 用基于 content block ID 派生的确定性值覆盖 randomUUID，
        // 避免 memo 每次重算时 React key 发生变化。
        // 这与 normalizeMessages 中修复的 bug 同类（commit 383326e613）：
        // 全新 randomUUID → 不稳定的 React key → 组件 remount →
        // Ink 渲染损坏（旧 DOM 节点导致文字重叠）。
        msg.uuid = deriveUUID(streamingToolUse.contentBlock.id as UUID, 0);
        return normalizeMessages([msg]);
      }),
    [streamingToolUsesWithoutInProgress],
  );

  const isTranscriptMode = screen === 'transcript';
  // 提升到挂载时执行 —— 本组件每次滚动都会重渲染。
  const disableVirtualScroll = useMemo(() => isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL), []);
  // 虚拟滚动取代了 transcript cap：所有内容都可滚动，
  // 内存用量由挂载项数量决定，而非总量。scrollRef 仅在
  // isFullscreenEnvEnabled() 为 true 时传入（REPL.tsx 控制），
  // 因此 scrollRef 的存在性即为信号。
  const virtualScrollRuntimeGate = scrollRef != null && !disableVirtualScroll;
  const shouldTruncate = isTranscriptMode && !showAllInTranscript && !virtualScrollRuntimeGate;

  // 非虚拟化 cap 切片中第一个被渲染消息的锚点。
  // 仅单调推进 —— 渲染期间的 mutation 是幂等的（在 StrictMode
  // 双重渲染下安全）。关于它为何取代基于计数的切片，参见上文
  // MAX_MESSAGES_WITHOUT_VIRTUALIZATION 的注释。
  const sliceAnchorRef = useRef<SliceAnchor>(null);

  // buildMessageLookups 的缓存：当流式传输过程中仅有消息内容变化
  // （text/thinking delta）时，避免重建 8 个 Map/Set。缓存 key 只
  // 捕获结构性信息（类型、ID），因此仅内容变化的 delta 会完全跳过重建。
  const lookupsCacheRef = useRef<{
    key: string;
    lookups: MessageLookups;
    normalizedCount: number;
    messageCount: number;
    lastAssistantMsgId: string | undefined;
  } | null>(null);

  // 耗时的消息变换 —— filter、reorder、group、collapse、lookups。
  // 在 27k 条消息上全部为 O(n)。与 renderRange 切片分开，这样滚动
  // （只改变 renderRange）不会重新触发这些。此前本 useMemo 包含
  // renderRange → 每次滚动都重建 6 个 Map + 4 次 filter/map 传递
  // = 每次滚动约 50ms 分配 → GC 压力 → 1GB 堆上出现 100-173ms 的
  // stop-the-world 暂停。
  const { collapsed, lookups, hasTruncatedMessages, hiddenMessageCount } = useMemo(() => {
    // 全屏模式下 alt buffer 没有原生 scrollback，因此 compact-boundary
    // 过滤器只会隐藏 ScrollBox 本可滚动到的历史。主屏模式保留该过滤器
    // —— 在那里，compact 之前的行位于原生 scrollback 中视口上方，
    // 重新渲染它们会触发完整的重置。
    // includeSnipped：UI 渲染时保留 snipped 消息以供 scrollback 使用
    // （本 PR 的核心目标 —— UI 中保留完整历史，过滤器仅用于模型）。
    // 同时避免 UUID 不匹配：normalizeMessages 会派生新的 UUID，
    // 若不这样做，projectSnippedView 对原始 removedUuids 的检查会失败。
    const compactAwareMessages =
      verbose || isFullscreenEnvEnabled()
        ? normalizedMessages
        : getMessagesAfterCompactBoundary(normalizedMessages, {
            includeSnipped: true,
          });

    const messagesToShowNotTruncated = reorderMessagesInUI(
      compactAwareMessages.filter(
        (msg): msg is Exclude<NormalizedMessage, ProgressMessageType> =>
          // CC-724：丢弃被 AttachmentMessage 渲染为 null 的附件消息
          // （hook_success、hook_additional_context、hook_cancelled 等），
          // 在计数/切片之前执行，避免它们虚增 ctrl-o 中的「N 条消息」
          // 计数，或占用 200 条消息渲染上限中的名额。
          msg.type !== 'progress' && !isNullRenderingAttachment(msg) && shouldShowUserMessage(msg, isTranscriptMode),
      ) as Parameters<typeof reorderMessagesInUI>[0],
      syntheticStreamingToolUseMessages,
    );
    // 三级过滤。Transcript 模式（ctrl+o 屏幕）是真正不过滤的。
    // Brief-only：仅 SendUserMessage + 用户输入。默认：在调用了
    // SendUserMessage 的轮次中丢弃冗余的 assistant 文本（模型的文本
    // 属于工作笔记，与 SendUserMessage 内容重复）。
    const briefToolNames = [BRIEF_TOOL_NAME, SEND_USER_FILE_TOOL_NAME].filter((n): n is string => n !== null);
    // dropTextInBriefTurns 应仅在 SendUserMessage 的轮次触发 ——
    // SendUserFile 只投递文件而没有替换文本，若在仅文件的轮次丢弃
    // assistant 文本，用户将得不到任何上下文。
    const dropTextToolNames = [BRIEF_TOOL_NAME].filter((n): n is string => n !== null);
    const briefFiltered =
      briefToolNames.length > 0 && !isTranscriptMode
        ? isBriefOnly
          ? filterForBriefTool(messagesToShowNotTruncated as Parameters<typeof filterForBriefTool>[0], briefToolNames)
          : dropTextToolNames.length > 0
            ? dropTextInBriefTurns(
                messagesToShowNotTruncated as Parameters<typeof dropTextInBriefTurns>[0],
                dropTextToolNames,
              )
            : messagesToShowNotTruncated
        : messagesToShowNotTruncated;

    const messagesToShow = shouldTruncate
      ? briefFiltered.slice(-MAX_MESSAGES_TO_SHOW_IN_TRANSCRIPT_MODE)
      : briefFiltered;

    const hasTruncatedMessages = shouldTruncate && briefFiltered.length > MAX_MESSAGES_TO_SHOW_IN_TRANSCRIPT_MODE;

    const { messages: groupedMessages } = applyGrouping(messagesToShow as MessageType[], tools, verbose);

    const collapsed = collapseBackgroundBashNotifications(
      collapseHookSummaries(collapseTeammateShutdowns(collapseReadSearchGroups(groupedMessages, tools))),
      verbose,
    );

    const lookupsKey = computeMessageStructureKey(normalizedMessages, messagesToShow as MessageType[]);
    const currentLastAssistantMsgId = (() => {
      const lastMsg = (messagesToShow as MessageType[]).at(-1);
      return lastMsg?.type === 'assistant' ? (lastMsg as AssistantMessage).message?.id : undefined;
    })();
    let lookups: MessageLookups;
    if (lookupsCacheRef.current && lookupsCacheRef.current.key === lookupsKey) {
      lookups = lookupsCacheRef.current.lookups;
    } else if (
      lookupsCacheRef.current &&
      normalizedMessages.length >= lookupsCacheRef.current.normalizedCount &&
      (messagesToShow as MessageType[]).length >= lookupsCacheRef.current.messageCount &&
      // 如果 lastAssistantMsgId 发生变化，此前「进行中」的 assistant
      // 可能已变为孤儿 —— 强制完整重建以获取新状态。
      lookupsCacheRef.current.lastAssistantMsgId === currentLastAssistantMsgId
    ) {
      // 仅追加新消息时尝试增量更新
      const updated = updateMessageLookupsIncremental(
        lookupsCacheRef.current.lookups,
        lookupsCacheRef.current.normalizedCount,
        lookupsCacheRef.current.messageCount,
        normalizedMessages,
        messagesToShow as MessageType[],
      );
      if (updated) {
        lookups = updated;
        lookupsCacheRef.current = {
          key: lookupsKey,
          lookups,
          normalizedCount: normalizedMessages.length,
          messageCount: (messagesToShow as MessageType[]).length,
          lastAssistantMsgId: currentLastAssistantMsgId,
        };
      } else {
        lookups = buildMessageLookups(normalizedMessages, messagesToShow as MessageType[]);
        lookupsCacheRef.current = {
          key: lookupsKey,
          lookups,
          normalizedCount: normalizedMessages.length,
          messageCount: (messagesToShow as MessageType[]).length,
          lastAssistantMsgId: currentLastAssistantMsgId,
        };
      }
    } else {
      lookups = buildMessageLookups(normalizedMessages, messagesToShow as MessageType[]);
      lookupsCacheRef.current = {
        key: lookupsKey,
        lookups,
        normalizedCount: normalizedMessages.length,
        messageCount: (messagesToShow as MessageType[]).length,
        lastAssistantMsgId: currentLastAssistantMsgId,
      };
    }

    const hiddenMessageCount = messagesToShowNotTruncated.length - MAX_MESSAGES_TO_SHOW_IN_TRANSCRIPT_MODE;

    return {
      collapsed,
      lookups,
      hasTruncatedMessages,
      hiddenMessageCount,
    };
  }, [
    verbose,
    normalizedMessages,
    isTranscriptMode,
    syntheticStreamingToolUseMessages,
    shouldTruncate,
    tools,
    isBriefOnly,
  ]);

  // 廉价的切片 —— 仅在滚动范围或切片配置变化时执行。
  const renderableMessages = useMemo(() => {
    // 非虚拟化渲染路径的安全上限。在此处（而非 JSX 处）应用，以便
    // renderMessageRow 基于索引的 lookups 和 dividerBeforeIndex
    // 在同一数组上计算。VirtualMessageList 永远不会看到此切片 ——
    // virtualScrollRuntimeGate 在组件生命周期内为常量
    // （scrollRef 要么始终传入，要么始终不传）。
    // renderRange 优先：分块导出路径对分组后的数组进行切片，
    // 以确保每个 chunk 都有正确的工具调用分组。
    const capApplies = !virtualScrollRuntimeGate && !disableRenderCap;
    const sliceStart = capApplies ? computeSliceStart(collapsed, sliceAnchorRef) : 0;
    return renderRange
      ? collapsed.slice(renderRange[0], renderRange[1])
      : sliceStart > 0
        ? collapsed.slice(sliceStart)
        : collapsed;
  }, [collapsed, renderRange, virtualScrollRuntimeGate, disableRenderCap]);

  const streamingToolUseIDs = useMemo(
    () => new Set(streamingToolUses.map(_ => _.contentBlock.id)),
    [streamingToolUses],
  );

  // 分割线插入点和选中索引：合并为对 renderableMessages 的一次遍历，
  // 避免两次独立的 findIndex 遍历。
  const { dividerBeforeIndex, selectedIdx } = useMemo(() => {
    if (!unseenDivider && !cursor) return { dividerBeforeIndex: -1, selectedIdx: -1 };
    let dIdx = -1;
    let sIdx = -1;
    const prefix = unseenDivider?.firstUnseenUuid.slice(0, 24);
    for (let i = 0; i < renderableMessages.length; i++) {
      const m = renderableMessages[i];
      if (dIdx === -1 && prefix && m.uuid.slice(0, 24) === prefix) dIdx = i;
      if (sIdx === -1 && cursor && m.uuid === cursor.uuid) sIdx = i;
      if (dIdx !== -1 && sIdx !== -1) break;
    }
    return { dividerBeforeIndex: dIdx, selectedIdx: sIdx };
  }, [unseenDivider, cursor, renderableMessages]);

  // 全屏：点击消息可切换其 verbose 渲染。以 tool_use_id 为 key（若可用），
  // 使一个 tool_use 与其 tool_result（独立的两行）一起展开；对
  // 分组/thinking 则回退到 uuid。过期 key 无害 —— 它们永远匹配不到
  // renderableMessages 中的任何内容。
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const onItemClick = useCallback((msg: RenderableMessage) => {
    const k = expandKey(msg);
    setExpandedKeys(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);
  const isItemExpanded = useCallback(
    (msg: RenderableMessage) => expandedKeys.size > 0 && expandedKeys.has(expandKey(msg)),
    [expandedKeys],
  );
  // 仅对 verbose 切换后能展示更多内容的消息应用 hover/click：
  // 折叠的 read/search 分组，或通过 isResultTruncated 自报为截断的工具
  // 结果。回调必须在消息更新间保持稳定：如果其身份（或返回值）在流式
  // 传输中翻转，onMouseEnter 会在鼠标已进入之后才挂载 → hover 永不触发。
  // tools 在 session 内稳定；lookups 通过 ref 读取，因此回调不会因每条
  // 新消息而抖动。
  const lookupsRef = useRef(lookups);
  lookupsRef.current = lookups;
  const isItemClickable = useCallback(
    (msg: RenderableMessage): boolean => {
      if (msg.type === 'collapsed_read_search') return true;
      if (msg.type === 'assistant') {
        const content = msg.message!.content;
        const b = (Array.isArray(content) ? content[0] : undefined) as unknown as AdvisorBlock | undefined;
        return (
          b != null && isAdvisorBlock(b) && b.type === 'advisor_tool_result' && b.content.type === 'advisor_result'
        );
      }
      if (msg.type !== 'user') return false;
      const b = (
        msg.message!.content as Array<{
          type: string;
          tool_use_id?: string;
          is_error?: boolean;
          [key: string]: unknown;
        }>
      )[0];
      if (b?.type !== 'tool_result' || b.is_error || !msg.toolUseResult) return false;
      const name = lookupsRef.current.toolUseByToolUseID.get(b.tool_use_id ?? '')?.name;
      const tool = name ? findToolByName(tools, name) : undefined;
      return tool?.isResultTruncated?.(msg.toolUseResult as never) ?? false;
    },
    [tools],
  );

  const canAnimate =
    (!toolJSX || !!toolJSX.shouldContinueAnimation) && !toolUseConfirmQueue.length && !isMessageSelectorVisible;

  const hasToolsInProgress = inProgressToolUseIDs.size > 0;

  // 向终端报告进度（适用于支持 OSC 9;4 的终端）
  const { progress } = useTerminalNotification();
  const prevProgressState = useRef<string | null>(null);
  const progressEnabled =
    getGlobalConfig().terminalProgressBarEnabled &&
    !getIsRemoteMode() &&
    !(proactiveModule?.isProactiveActive() ?? false);
  useEffect(() => {
    const state = progressEnabled ? (hasToolsInProgress ? 'indeterminate' : 'completed') : null;
    if (prevProgressState.current === state) return;
    prevProgressState.current = state;
    progress(state);
  }, [progress, progressEnabled, hasToolsInProgress]);
  useEffect(() => {
    return () => progress(null);
  }, [progress]);

  const messageKey = useCallback((msg: RenderableMessage) => `${msg.uuid}-${conversationId}`, [conversationId]);

  const renderMessageRow = (msg: RenderableMessage, index: number) => {
    const prevType = index > 0 ? renderableMessages[index - 1]?.type : undefined;
    const isUserContinuation = msg.type === 'user' && prevType === 'user';
    // hasContentAfter 仅用于 collapsed_read_search 分组；
    // 其他情况跳过扫描。streamingText 作为本 map 之后的兄弟节点渲染，
    // 因此永远不在 renderableMessages 中 —— 显式地 OR 它进来，使分组
    // 在文本开始流式传输的瞬间翻转为过去时，而无需等待 block 完结。
    const hasContentAfter =
      msg.type === 'collapsed_read_search' &&
      (!!streamingText || hasContentAfterIndex(renderableMessages, index, tools, streamingToolUseIDs));

    // 对超过最新 N 条消息之外的消息折叠 diff。
    // verbose（ctrl+o）会覆盖该行为并始终显示完整 diff。
    const DIFF_COLLAPSE_DISTANCE = 0;
    const shouldCollapseDiffs = renderableMessages.length - 1 - index > DIFF_COLLAPSE_DISTANCE;

    const k = messageKey(msg);
    const row = (
      <MessageRow
        key={k}
        message={msg}
        isUserContinuation={isUserContinuation}
        hasContentAfter={hasContentAfter}
        tools={tools}
        commands={commands}
        verbose={verbose || isItemExpanded(msg) || (cursor?.expanded === true && index === selectedIdx)}
        inProgressToolUseIDs={inProgressToolUseIDs}
        streamingToolUseIDs={streamingToolUseIDs}
        screen={screen}
        canAnimate={canAnimate}
        onOpenRateLimitOptions={onOpenRateLimitOptions}
        lastThinkingBlockId={lastThinkingBlockId}
        latestBashOutputUUID={latestBashOutputUUID}
        columns={columns}
        isLoading={isLoading}
        lookups={lookups}
        shouldCollapseDiffs={shouldCollapseDiffs}
      />
    );

    // 每行一个 Provider —— 选中项变化时只有 2 行重新渲染。
    // 在 divider 分支之前包裹，使两条返回路径都获得该 Provider。
    const wrapped = (
      <MessageActionsSelectedContext.Provider key={k} value={index === selectedIdx}>
        {row}
      </MessageActionsSelectedContext.Provider>
    );

    if (unseenDivider && index === dividerBeforeIndex) {
      return [
        <Box key="unseen-divider" marginTop={1}>
          <Divider title={`${unseenDivider.count} 条新消息`} width={columns} color="inactive" />
        </Box>,
        wrapped,
      ];
    }
    return wrapped;
  };

  // 搜索索引：对于 tool_result 消息，查找对应的 Tool 并使用其
  // extractSearchText —— 由工具拥有、精确、与 renderToolResultMessage
  // 展示的内容一致。对未实现该方法的工具以及所有非 tool_result 的消息
  // 类型，回退到 renderableSearchText（对 toolUseResult 做 duck-typing）。
  // drift-catcher 测试（searchExtraToolsText.test.tsx）会渲染并比较，
  // 以保持两者同步。
  //
  // 曾尝试过基于第二个 React root 的调和方案，但被否决
  // （实测 3.1ms/msg 且持续增长 —— flushSyncWork 处理所有 root；
  // 组件 hook 会修改共享 state → 主 root 累积更新）。
  const searchTextCache = useRef(new WeakMap<RenderableMessage, string>());
  const extractSearchText = useCallback(
    (msg: RenderableMessage): string => {
      const cached = searchTextCache.current.get(msg);
      if (cached !== undefined) return cached;
      let text = renderableSearchText(msg);
      // 如果这是一条 tool_result 消息，且该工具实现了
      // extractSearchText，优先使用它 —— 它是精确的（由工具拥有），
      // 相比 renderableSearchText 的字段名启发式方法。
      if (msg.type === 'user' && msg.toolUseResult && Array.isArray(msg.message.content)) {
        const tr = msg.message.content.find(b => b.type === 'tool_result');
        if (tr && 'tool_use_id' in tr) {
          const tu = lookups.toolUseByToolUseID.get(tr.tool_use_id);
          const tool = tu && findToolByName(tools, tu.name);
          const extracted = tool?.extractSearchText?.(msg.toolUseResult as never);
          // undefined = 工具未实现 → 保留启发式方法。空字符串
          // = 工具表示「无可索引内容」 → 尊重该结果。
          if (extracted !== undefined) text = extracted;
        }
      }
      // 缓存已小写化：setSearchQuery 的热循环中每次按键都会 indexOf。
      // 在此处（预热时一次）转小写 vs 在那里（每次按键）转小写，在
      // 稳态内存几乎相同的情况下换来零每次按键分配。缓存随消息在
      // 退出 transcript 时被 GC。工具方法返回原始内容；
      // renderableSearchText 本身已转小写（冗余但廉价）。
      const lowered = text.toLowerCase();
      searchTextCache.current.set(msg, lowered);
      return lowered;
    },
    [tools, lookups],
  );

  return (
    <SentryErrorBoundary name="MessagesBoundary">
      {/* Logo */}
      {!hideLogo && !(renderRange && renderRange[0] > 0) && <LogoHeader agentDefinitions={agentDefinitions} />}

      {/* 截断指示器 */}
      {hasTruncatedMessages && (
        <Divider title={`${toggleShowAllShortcut} 显示此前 ${chalk.bold(hiddenMessageCount)} 条消息`} width={columns} />
      )}

      {/* 「显示全部」指示器 */}
      {isTranscriptMode &&
        showAllInTranscript &&
        hiddenMessageCount > 0 &&
        // disableRenderCap（例如 [ dump-to-scrollback）意味着我们以一次性
        // 应急通道的方式解除上限，而非可切换的开关 —— 此时 ctrl+e 已失效，
        // 也没有任何被「隐藏」的内容需要恢复。
        !disableRenderCap && (
          <Divider
            title={`${toggleShowAllShortcut} 隐藏此前 ${chalk.bold(hiddenMessageCount)} 条消息`}
            width={columns}
          />
        )}

      {/* 消息 —— 以 memo 化的 MessageRow 组件渲染。
          flatMap 将 unseen-divider 作为独立的带 key 兄弟节点插入，这样
          (a) 非全屏渲染无需为每条消息包裹 Fragment，且
          (b) 全屏下切换 divider 时能按 key 保留所有 MessageRow。
          预先计算派生值，而非把 renderableMessages 传给每一行 ——
          React Compiler 会把 props 钉在 fiber 的 memoCache 中，因此
          传入数组会累积每个历史版本（一个 7 轮 session 约为 1-2MB）。 */}
      {virtualScrollRuntimeGate ? (
        <InVirtualListContext.Provider value={true}>
          <VirtualMessageList
            messages={renderableMessages}
            scrollRef={scrollRef}
            columns={columns}
            itemKey={messageKey}
            renderItem={renderMessageRow}
            onItemClick={onItemClick}
            isItemClickable={isItemClickable}
            isItemExpanded={isItemExpanded}
            trackStickyPrompt={trackStickyPrompt}
            selectedIndex={selectedIdx >= 0 ? selectedIdx : undefined}
            cursorNavRef={cursorNavRef}
            setCursor={setCursor}
            jumpRef={jumpRef}
            onSearchMatchesChange={onSearchMatchesChange}
            scanElement={scanElement}
            setPositions={setPositions}
            extractSearchText={extractSearchText}
          />
        </InVirtualListContext.Provider>
      ) : (
        renderableMessages.flatMap(renderMessageRow)
      )}

      {streamingText && !isBriefOnly && (
        <Box alignItems="flex-start" flexDirection="row" marginTop={1} width="100%">
          <Box flexDirection="row">
            <Box minWidth={2}>
              <Text color="text">{BLACK_CIRCLE}</Text>
            </Box>
            <Box flexDirection="column">
              <StreamingMarkdown>{streamingText}</StreamingMarkdown>
            </Box>
          </Box>
        </Box>
      )}

      {isStreamingThinkingVisible && streamingThinking && !isBriefOnly && (
        <Box marginTop={1}>
          <AssistantThinkingMessage
            param={{
              type: 'thinking',
              thinking: streamingThinking.thinking,
            }}
            addMargin={false}
            isTranscriptMode={true}
            verbose={verbose}
            hideInTranscript={false}
          />
        </Box>
      )}
    </SentryErrorBoundary>
  );
};

/** 点击展开用的 key：优先使用 tool_use_id（使 tool_use 与其
 *  tool_result 一起展开），否则对分组/thinking 使用 uuid。 */
function expandKey(msg: RenderableMessage): string {
  return (msg.type === 'assistant' || msg.type === 'user' ? getToolUseID(msg) : null) ?? msg.uuid;
}

// 自定义比较器，避免流式传输过程中不必要的重渲染。
// 默认 React.memo 做浅比较，在以下情况会失效：
// 1. onOpenRateLimitOptions 回调被重新创建（不影响渲染输出）
// 2. streamingToolUses 数组在每次 delta 时重建，但渲染只关心 contentBlock
// 3. streamingThinking 在每次 delta 时变化 —— 此时确实需要重渲染
function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

export const Messages = React.memo(MessagesImpl, (prev, next) => {
  const keys = Object.keys(prev) as (keyof typeof prev)[];
  for (const key of keys) {
    if (
      key === 'onOpenRateLimitOptions' ||
      key === 'scrollRef' ||
      key === 'trackStickyPrompt' ||
      key === 'setCursor' ||
      key === 'cursorNavRef' ||
      key === 'jumpRef' ||
      key === 'onSearchMatchesChange' ||
      key === 'scanElement' ||
      key === 'setPositions'
    )
      continue;
    if (prev[key] !== next[key]) {
      if (key === 'streamingToolUses') {
        const p = prev.streamingToolUses;
        const n = next.streamingToolUses;
        if (p.length === n.length && p.every((item, i) => item.contentBlock === n[i]?.contentBlock)) {
          continue;
        }
      }
      if (key === 'inProgressToolUseIDs') {
        if (setsEqual(prev.inProgressToolUseIDs, next.inProgressToolUseIDs)) {
          continue;
        }
      }
      if (key === 'unseenDivider') {
        const p = prev.unseenDivider;
        const n = next.unseenDivider;
        if (p?.firstUnseenUuid === n?.firstUnseenUuid && p?.count === n?.count) {
          continue;
        }
      }
      if (key === 'tools') {
        const p = prev.tools;
        const n = next.tools;
        if (p.length === n.length && p.every((tool, i) => tool.name === n[i]?.name)) {
          continue;
        }
      }
      // streamingThinking 频繁变化 —— 变化时总是重渲染
      // （无需特殊处理，默认行为即可）
      return false;
    }
  }
  return true;
});

export function shouldRenderStatically(
  message: RenderableMessage,
  streamingToolUseIDs: Set<string>,
  inProgressToolUseIDs: Set<string>,
  siblingToolUseIDs: ReadonlySet<string>,
  screen: Screen,
  lookups: ReturnType<typeof buildMessageLookups>,
): boolean {
  if (screen === 'transcript') {
    return true;
  }
  switch (message.type) {
    case 'attachment':
    case 'user':
    case 'assistant': {
      if (message.type === 'assistant') {
        const block = (message.message!.content as Array<{ type: string; id?: string }>)[0];
        if (block?.type === 'server_tool_use') {
          return lookups.resolvedToolUseIDs.has(block.id!);
        }
      }
      const toolUseID = getToolUseID(message);
      if (!toolUseID) {
        return true;
      }
      if (streamingToolUseIDs.has(toolUseID)) {
        return false;
      }
      if (inProgressToolUseIDs.has(toolUseID)) {
        return false;
      }

      // 检查该 tool use 是否存在未解析的 PostToolUse hook。
      // 若存在，保持消息为瞬态，以便 HookProgressMessage 能更新。
      if (hasUnresolvedHooksFromLookup(toolUseID, 'PostToolUse', lookups)) {
        return false;
      }

      return every(siblingToolUseIDs, lookups.resolvedToolUseIDs);
    }
    case 'system': {
      // api 错误总是动态渲染，因为一旦看到其他非错误消息就会隐藏它们。
      return message.subtype !== 'api_error';
    }
    case 'grouped_tool_use': {
      const allResolved = message.messages.every(msg => {
        const content = (msg.message!.content as Array<{ type: string; id?: string }>)[0];
        return content?.type === 'tool_use' && lookups.resolvedToolUseIDs.has(content.id!);
      });
      return allResolved;
    }
    case 'collapsed_read_search': {
      // 在 prompt 模式下，永远不要标记为 static，以避免 API 轮次之间的闪烁
      // （在 transcript 模式下，已在函数开头返回 true）
      return false;
    }
    default:
      return true;
  }
}
