import figures from 'figures';
import React, {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { fileURLToPath } from 'url';
import { ModalContext } from '../context/modalContext.js';
import { PromptOverlayProvider, usePromptOverlay, usePromptOverlayDialog } from '../context/promptOverlayContext.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box, ScrollBox, type ScrollBoxHandle, Text, instances } from '@anthropic/ink';
import type { Message } from '../types/message.js';
import { openBrowser, openPath } from '../utils/browser.js';
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js';
import { plural } from '../utils/stringUtils.js';
import { isNullRenderingAttachment } from './messages/nullRenderingAttachments.js';
import PromptInputFooterSuggestions from './PromptInput/PromptInputFooterSuggestions.js';
import type { StickyPrompt } from './VirtualMessageList.js';

/** 在 modal 面板的 ▔ 分隔线之上保留可见的 transcript 上下文行数。 */
const MODAL_TRANSCRIPT_PEEK = 2;

/** 用于滚动派生 chrome（sticky header、pill）的 context。VirtualMessageList
 *  中的 StickyTracker 通过它写入，而不是把回调层层穿透
 *  Messages → REPL → FullscreenLayout。setter 是稳定的，因此消费此 context
 *  永远不会引发重新渲染。 */
export const ScrollChromeContext = createContext<{
  setStickyPrompt: (p: StickyPrompt | null) => void;
}>({ setStickyPrompt: () => {} });

type Props = {
  /** 可滚动的内容（消息、工具输出） */
  scrollable: ReactNode;
  /** 固定在底部的内容（spinner、prompt、权限） */
  bottom: ReactNode;
  /** 在消息之后渲染于 ScrollBox 内部的内容 —— 用户可以向上滚动，
   *  在它显示时查看上下文（由 PermissionRequest 使用）。 */
  overlay?: ReactNode;
  /** 绝对定位、锚定在 ScrollBox 区域右下角的内容，浮在 scrollback 之上。
   *  渲染在 flexGrow 区域内（不是 bottom slot），这样 overflowY:hidden
   *  的上限不会裁剪它。仅全屏模式 —— 用于 companion 气泡。 */
  bottomFloat?: ReactNode;
  /** 斜杠命令对话框内容。渲染在一个绝对定位、底部锚定的 pane 中
   *  （▔ 分隔线，paddingX=2），覆盖 ScrollBox 和 bottom slot。提供
   *  ModalContext，使内部的 Pane/Dialog 跳过自己的边框。仅全屏模式；
   *  其他情况下内联在 overlay 之后。 */
  modal?: ReactNode;
  /** 通过 ModalContext 传入的 ref，使 Tabs（或任何拥有滚动的后代）
   *  能把它挂到自己的 ScrollBox 上以处理高内容。 */
  modalScrollRef?: React.RefObject<ScrollBoxHandle | null>;
  /** 用于键盘滚动的 scroll box ref。用 RefObject（不是 Ref），这样
   *  pillVisible 的 useSyncExternalStore 可以订阅滚动变化。 */
  scrollRef?: RefObject<ScrollBoxHandle | null>;
  /** 未读分隔线的 Y 位置（快照时的 scrollHeight）。当视口底部尚未
   *  到达此位置时显示 pill。用 ref，这样 REPL 不会因一次性快照写入
   *  而重新渲染。 */
  dividerYRef?: RefObject<number | null>;
  /** 强制隐藏 pill（例如查看子 agent 任务时）。 */
  hidePill?: boolean;
  /** 强制隐藏 sticky prompt header（例如查看 teammate 任务时）。 */
  hideSticky?: boolean;
  /** pill 文本的计数。0 → "跳转到底部"，>0 → "N 条新消息"。 */
  newMessageCount?: number;
  /** 用户点击 "N new" pill 时调用。 */
  onPillClick?: () => void;
};

/**
 * 在用户向上滚动时追踪 transcript 内 "N 条新消息" 分隔线的位置。
 * 首次 sticky 断开时对消息计数和 scrollHeight 做快照。scrollHeight ≈
 * 分隔线在滚动内容中的 y 位置（它渲染在快照时刻存在的最后一条消息之后）。
 *
 * `pillVisible` 存在于 FullscreenLayout（不在这里）—— 它通过
 * useSyncExternalStore 直接订阅 ScrollBox，以 `dividerYRef` 做布尔快照，
 * 因此逐帧滚动永远不会让 REPL 重新渲染。
 * `dividerIndex` 留在这里，因为 REPL 需要它用于 computeUnseenDivider
 * → Messages 的分隔线；它每个滚动会话只变化约两次
 * （首次滚离 + 重新固定），可接受的 REPL 重新渲染开销。
 *
 * `onScrollAway` 必须由每个滚离动作带上 handle 调用；
 * `onRepin` 由提交/滚动到底部调用。
 */
export function useUnseenDivider(messageCount: number): {
  /** messages[] 中分隔线渲染位置的索引。在 sticky 恢复（滚回底部）时
   *  清除，这样一旦全部可见，"N new" 行就不会残留。 */
  dividerIndex: number | null;
  /** 首次滚离时的 scrollHeight 快照 —— 分隔线的 y 位置。
   *  FullscreenLayout 订阅 ScrollBox 并把视口底部与之比较以决定
   *  pillVisible。用 ref，这样写入不会让 REPL 重新渲染。 */
  dividerYRef: RefObject<number | null>;
  onScrollAway: (handle: ScrollBoxHandle) => void;
  onRepin: () => void;
  /** 滚动 handle，使分隔线位于视口顶部。 */
  jumpToNew: (handle: ScrollBoxHandle | null) => void;
  /** 当消息被前置（无限向上滚动）时平移 dividerIndex 和 dividerYRef。
   *  indexDelta = 前置的消息数；heightDelta = 内容高度增长的行数。 */
  shiftDivider: (indexDelta: number, heightDelta: number) => void;
} {
  const [dividerIndex, setDividerIndex] = useState<number | null>(null);
  // ref 保存当前计数供 onScrollAway 快照使用。在渲染体中写入
  // （不是 useEffect），这样在消息追加渲染与其 effect 刷新之间到达的
  // 滚轮事件不会捕获到过期计数（基线中的 off-by-one）。React Compiler
  // 在这里会放弃优化 —— 对一个仅在 REPL 中实例化一次的 hook 可接受。
  const countRef = useRef(messageCount);
  countRef.current = messageCount;
  // scrollHeight 快照 —— 分隔线在内容坐标中的 y。仅 ref：
  // 在 onScrollAway 中同步读取（setState 是批处理的，无法在同一回调中
  // 先读后写），也由 FullscreenLayout 的 pillVisible 订阅读取。null = 固定在底部。
  const dividerYRef = useRef<number | null>(null);

  const onRepin = useCallback(() => {
    // 不要在这里清除 dividerYRef —— 一个触控板惯性滚轮事件如果竞争
    // 在同一 stdin 批次中到达，会看到 null 并重新快照，覆盖下面的
    // setDividerIndex(null)。下面的 useEffect 会在 React 提交 null
    // dividerIndex 之后清除 ref，这样 ref 保持非 null 直到状态稳定。
    setDividerIndex(null);
  }, []);

  const onScrollAway = useCallback((handle: ScrollBoxHandle) => {
    // 视口下方没有内容 → 没有可跳转的目标。覆盖两种情况：
    // • 空/短会话：scrollUp 调用 scrollTo(0)，即便 scrollTop=0 也会
    //   断开 sticky（新会话上滚曾导致 pill 显示）
    // • 底部点击选中：useDragToScroll.check() 调用
    //   scrollTo(current) 断开 sticky，使流式内容不在选区下移动，
    //   随后 onScroll(false, …) —— 但 scrollTop 仍在最大值
    //   （Sarah Deaton, #claude-code-feedback 2026-03-15）
    // pendingDelta：scrollBy 会累加但不更新 scrollTop。不加它的话，
    // 从最大值上滚会看到 scrollTop==max 并抑制 pill。
    const max = Math.max(0, handle.getScrollHeight() - handle.getViewportHeight());
    if (handle.getScrollTop() + handle.getPendingDelta() >= max) return;
    // 仅在首次滚离时快照。onScrollAway 在每次滚动动作时都会触发
    // （不只是首次断开 sticky）—— 这个保护保留了原始基线，使计数不会
    // 在第二次 PageUp 时重置。后续调用是仅 ref 的空操作（无 REPL 重新渲染）。
    if (dividerYRef.current === null) {
      dividerYRef.current = handle.getScrollHeight();
      // 新的滚离会话 → 把分隔线移到这里（替换旧的）
      setDividerIndex(countRef.current);
    }
  }, []);

  const jumpToNew = useCallback((handle: ScrollBoxHandle | null) => {
    if (!handle) return;
    // 用 scrollToBottom（不是 scrollTo(dividerY)）：设置 stickyScroll=true，
    // 这样 useVirtualScroll 挂载尾部，render-node-to-output 把
    // scrollTop 钉在 maxScroll。scrollTo 会设置 stickyScroll=false →
    // 钳制（在 React 重新渲染前仍处于顶部区间边界）会把 scrollTop
    // 钉回去，提前停下。分隔线保持渲染（dividerIndex 不变），用户能看到
    // 新消息从哪里开始；下一次提交/显式滚动到底部时再做清理。
    handle.scrollToBottom();
  }, []);

  // 把 dividerYRef 与 dividerIndex 同步。当 onRepin 触发（提交、
  // 滚动到底部）时，它把 dividerIndex 设为 null 但让 ref 保持非 null ——
  // 否则一个竞争在同一 stdin 批次中的滚轮事件会看到 null 并重新快照。
  // 把 ref 清除推迟到 useEffect，保证 ref 保持非 null 直到 React 提交了
  // null dividerIndex，阻断 onScrollAway 中的 if-null 守卫。
  //
  // 也处理 /clear、rewind、teammate 视图切换 —— 如果计数降到分隔线索引
  // 之下，分隔线会指向空。
  useEffect(() => {
    if (dividerIndex === null) {
      dividerYRef.current = null;
    } else if (messageCount < dividerIndex) {
      dividerYRef.current = null;
      setDividerIndex(null);
    }
  }, [messageCount, dividerIndex]);

  const shiftDivider = useCallback((indexDelta: number, heightDelta: number) => {
    setDividerIndex(idx => (idx === null ? null : idx + indexDelta));
    if (dividerYRef.current !== null) {
      dividerYRef.current += heightDelta;
    }
  }, []);

  return {
    dividerIndex,
    dividerYRef,
    onScrollAway,
    onRepin,
    jumpToNew,
    shiftDivider,
  };
}

/**
 * 统计 messages[dividerIndex..end) 中的 assistant 轮次。一个"轮次"是
 * 用户眼中的"一条来自 Claude 的新消息" —— 不是原始的 assistant 条目
 * （一个轮次会产生多个条目：tool_use block + text block）。我们统计
 * non-assistant→assistant 的转换，但仅对实际携带文本的条目 ——
 * 纯工具调用条目被跳过（如同 progress 消息），这样
 * "⏺ 搜索了 13 个模式，读取了 6 个文件" 就不会让 pill 跳动。
 */
export function countUnseenAssistantTurns(messages: readonly Message[], dividerIndex: number): number {
  let count = 0;
  let prevWasAssistant = false;
  for (let i = dividerIndex; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.type === 'progress') continue;
    // 纯工具调用的 assistant 条目对用户而言不是"新消息" ——
    // 像跳过 progress 一样跳过它们。prevWasAssistant 不更新，
    // 所以紧随其后的 text block 仍算作同一轮次
    // （来自一次 API 响应的 tool_use + text = 1）。
    if (m.type === 'assistant' && !assistantHasVisibleText(m)) continue;
    const isAssistant = m.type === 'assistant';
    if (isAssistant && !prevWasAssistant) count++;
    prevWasAssistant = isAssistant;
  }
  return count;
}

function assistantHasVisibleText(m: Message): boolean {
  if (m.type !== 'assistant') return false;
  if (!Array.isArray(m.message!.content)) return false;
  for (const b of m.message!.content) {
    if (typeof b !== 'string' && b.type === 'text' && b.text.trim() !== '') return true;
  }
  return false;
}

export type UnseenDivider = { firstUnseenUuid: Message['uuid']; count: number };

/**
 * 构建 REPL 传给 Messages + pill 的 unseenDivider 对象。
 * 仅当分隔线之后还没有任何内容到达时（messages[dividerIndex] 不存在）
 * 返回 undefined。一旦有任何消息到达 —— 包括被 countUnseenAssistantTurns
 * 跳过的纯 tool_use assistant 条目和 tool_result user 条目 —— 计数
 * 下限为 1，使 pill 从 "跳转到底部" 翻转为 "1 条新消息"。没有这个下限，
 * pill 会在整个工具调用序列期间一直保持 "跳转到底部"，直到 Claude 的
 * 文本响应落地。
 */
export function computeUnseenDivider(
  messages: readonly Message[],
  dividerIndex: number | null,
): UnseenDivider | undefined {
  if (dividerIndex === null) return undefined;
  // 选取分隔线锚点时跳过 progress 和 null 渲染的 attachment ——
  // Messages.tsx 在 dividerBeforeIndex 搜索之前就把这些从
  // renderableMessages 中过滤掉了，所以它们的 UUID 找不到（CC-724）。
  // Hook attachment 使用 randomUUID()，所以没有东西会共享其 24 字符前缀。
  let anchorIdx = dividerIndex;
  while (
    anchorIdx < messages.length &&
    (messages[anchorIdx]?.type === 'progress' || isNullRenderingAttachment(messages[anchorIdx]!))
  ) {
    anchorIdx++;
  }
  const uuid = messages[anchorIdx]?.uuid;
  if (!uuid) return undefined;
  const count = countUnseenAssistantTurns(messages, dividerIndex);
  return { firstUnseenUuid: uuid, count: Math.max(1, count) };
}

/**
 * REPL 的布局包装器。在全屏模式下，把可滚动内容放入 sticky-scroll box，
 * 并通过 flexbox 把底部内容固定。非全屏模式下，按顺序渲染内容，使现有的
 * 主屏 scrollback 渲染保持不变。
 *
 * 全屏模式对 ants 默认开启（CLAUDE_CODE_NO_FLICKER=0 可关闭），
 * 对外部用户默认关闭（CLAUDE_CODE_NO_FLICKER=1 可开启）。
 * <AlternateScreen> 包装器
 * （alt buffer + 鼠标追踪 + 高度约束）位于 REPL 的根节点，
 * 这样不会有什么东西意外渲染到它之外。
 */
export function FullscreenLayout({
  scrollable,
  bottom,
  overlay,
  bottomFloat,
  modal,
  modalScrollRef,
  scrollRef,
  dividerYRef,
  hidePill = false,
  hideSticky = false,
  newMessageCount = 0,
  onPillClick,
}: Props): React.ReactNode {
  const { rows: terminalRows, columns } = useTerminalSize();
  // 滚动派生的 chrome 状态位于这里，而不是 REPL。StickyTracker 通过
  // ScrollChromeContext 写入；pillVisible 直接订阅 ScrollBox。两者都很少
  // 变化（pill 每次越过阈值翻转一次，sticky 每个 transcript 变化约
  // 5-20 次）—— 在这些时刻重新渲染 FullscreenLayout 没问题；而每滚动
  // 一帧就重新渲染 6966 行的 REPL + 其 22+ 个 useAppState 选择器就不行。
  const [stickyPrompt, setStickyPrompt] = useState<StickyPrompt | null>(null);
  const chromeCtx = useMemo(() => ({ setStickyPrompt }), []);
  // 布尔量化的滚动订阅。快照是"视口底部是否在分隔线 y 之上？" ——
  // 对布尔值做 Object.is → FullscreenLayout 只在 pill 应实际翻转时才
  // 重新渲染，而不是逐帧。
  const subscribe = useCallback(
    (listener: () => void) => scrollRef?.current?.subscribe(listener) ?? (() => {}),
    [scrollRef],
  );
  const pillVisible = useSyncExternalStore(subscribe, () => {
    const s = scrollRef?.current;
    const dividerY = dividerYRef?.current;
    if (!s || dividerY == null) return false;
    return s.getScrollTop() + s.getPendingDelta() + s.getViewportHeight() < dividerY;
  });
  // 接入超链接点击处理 —— 全屏模式下，鼠标追踪会在终端原生打开
  // OSC 8 链接之前拦截点击。
  useLayoutEffect(() => {
    if (!isFullscreenEnvEnabled()) return;
    const ink = instances.get(process.stdout);
    if (!ink) return;
    ink.onHyperlinkClick = url => {
      // Claude Code 发出的大多数 OSC 8 链接是来自 FilePathLink
      // （FileEdit/FileWrite/FileRead 工具输出）的 file:// URL。openBrowser
      // 拒绝非 http(s) 协议 —— 把 file: 路由到 openPath。
      if (url.startsWith('file:')) {
        try {
          void openPath(fileURLToPath(url));
        } catch {
          // 畸形的 file: URL（例如来自纯文本检测的 file://host/path）
          // 会让 fileURLToPath 抛错 —— 静默忽略。
        }
      } else {
        void openBrowser(url);
      }
    };
    return () => {
      ink.onHyperlinkClick = undefined;
    };
  }, []);

  if (isFullscreenEnvEnabled()) {
    // Overlay 渲染在同一个 ScrollBox 内消息的下方 —— 用户可以向上滚动，
    // 在权限对话框显示时查看之前的上下文。ScrollBox 在 overlay 过渡期间
    // 永不卸载，所以滚动位置无需保存/恢复即可保留。stickyScroll 在 overlay
    // 挂载时自动滚动到追加的 overlay（如果用户已在底部）；REPL 在 overlay
    // 出现/消失过渡时重新固定，处理 sticky 已断开的情况。高对话框
    // （FileEdit diff）仍可用 PgUp/PgDn/滚轮 —— 同一个 scrollRef 驱动
    // 同一个 ScrollBox。
    // 三种 sticky 状态：null（在底部）、{text,scrollTo}（已上滚、
    // header 显示）、'clicked'（刚点击了 header —— 隐藏它，让内容 ❯
    // 占据第 0 行）。padCollapsed 覆盖后两种：一旦从底部滚离，padding
    // 降为 0 并保持，直到重新固定。headerVisible 仅是中间状态。点击后：
    // scrollBox_y=0（header 消失）+ padding=0 → viewportTop=0 → ❯ 在
    // 第 0 行。下次滚动时 onChange 以一个新的 {text} 触发，header 回来
    // （viewportTop 0→1，单行 1 行位移 —— 可接受，因为用户是显式滚动）。
    const sticky = hideSticky ? null : stickyPrompt;
    const headerPrompt = sticky != null && sticky !== 'clicked' && overlay == null ? sticky : null;
    const padCollapsed = sticky != null && overlay == null;
    return (
      <PromptOverlayProvider>
        <Box flexDirection="row" flexGrow={1} overflow="hidden" width="100%">
          <Box flexDirection="column" flexGrow={1} width={columns} overflow="hidden">
            <Box flexGrow={1} flexDirection="column" overflow="hidden">
              {headerPrompt && <StickyPromptHeader text={headerPrompt.text} onClick={headerPrompt.scrollTo} />}
              <ScrollBox
                ref={scrollRef}
                flexGrow={1}
                flexDirection="column"
                paddingTop={padCollapsed ? 0 : 1}
                stickyScroll
              >
                <ScrollChromeContext value={chromeCtx}>{scrollable}</ScrollChromeContext>
                {overlay}
              </ScrollBox>
              {!hidePill && pillVisible && overlay == null && (
                <NewMessagesPill count={newMessageCount} onClick={onPillClick} />
              )}
              {bottomFloat != null && (
                <Box position="absolute" bottom={0} right={0} opaque>
                  {bottomFloat}
                </Box>
              )}
            </Box>
            <Box flexDirection="column" flexShrink={0} width="100%" maxHeight="50%">
              <SuggestionsOverlay />
              <DialogOverlay />
              <Box flexDirection="column" width="100%" flexGrow={1} overflowY="hidden">
                {bottom}
              </Box>
            </Box>
          </Box>
        </Box>
        {modal != null && (
          <ModalContext
            value={{
              rows: terminalRows - MODAL_TRANSCRIPT_PEEK - 1,
              columns: columns - 4,
              scrollRef: modalScrollRef ?? null,
            }}
          >
            {/* 底部锚定，向上生长以适应内容。maxHeight 在 ▔ 分隔线上方
                保留几行 transcript 可见。短的 modal（/model）小尺寸坐在
                底部，上方有大量 transcript；高的 modal（/buddy Card）按需
                生长，被 overflow 裁剪。此前是固定高度（顶部+底部锚定）——
                任何固定上限要么裁剪高内容，要么让短内容漂浮在几乎空的
                pane 中。

                内层 Box 的 flexShrink=0 是关键支撑：若 Shrink=1，当内容 >
                maxHeight 时 yoga 会把深层子元素挤压到 h=0，兄弟 Text 落到
                同一行 → 幽灵重叠（"5 serversP servers"）。在外层 Box 的
                maxHeight 处裁剪可让子元素保持自然尺寸。

                分隔线包裹在 flexShrink=0 中：当内层 box 溢出
                （高 /config 选项列表）时，yoga 会把分隔线 Text 收缩到
                h=0 来吸收差额 —— 它是唯一可收缩的兄弟。wrapper 让它保持
                1 行；超过 maxHeight 的溢出改由底部 overflow=hidden 裁剪。 */}
            <Box
              position="absolute"
              bottom={0}
              left={0}
              right={0}
              maxHeight={terminalRows - MODAL_TRANSCRIPT_PEEK}
              flexDirection="column"
              overflow="hidden"
              opaque
            >
              <Box flexShrink={0}>
                <Text color="permission">{'▔'.repeat(columns)}</Text>
              </Box>
              <Box flexDirection="column" paddingX={2} flexShrink={0} overflow="hidden">
                {modal}
              </Box>
            </Box>
          </ModalContext>
        )}
      </PromptOverlayProvider>
    );
  }

  return (
    <>
      {scrollable}
      {bottom}
      {overlay}
      {modal}
    </>
  );
}

// Slack 风格的 pill。scrollwrap 的 bottom={0} 处的绝对定位 overlay ——
// 浮在 ScrollBox 最后一行内容之上，仅遮挡居中的 pill 文本（该行其余
// 部分显示 ScrollBox 内容）。DECSTBM 移动 pill 像素造成的滚动涂抹在
// Ink 层修复（render-node-to-output.ts 的 absoluteRectsPrev 第三趟，
// #23939）。当计数为 0 时显示 "跳转到底部"（已滚离但还没有新消息 ——
// 此前用户会以为聊天卡住的死区）。
function NewMessagesPill({ count, onClick }: { count: number; onClick?: () => void }): React.ReactNode {
  const [hover, setHover] = useState(false);
  return (
    <Box position="absolute" bottom={0} left={0} right={0} justifyContent="center">
      <Box onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <Text backgroundColor={hover ? 'userMessageBackgroundHover' : 'userMessageBackground'} dimColor>
          {' '}
          {count > 0 ? `${count} 条${plural(count, '新消息')}` : '跳转到底部'} {figures.arrowDown}{' '}
        </Text>
      </Box>
    </Box>
  );
}

// 上下文面包屑：当向上滚入历史时，把当前对话轮次的 prompt 固定在视口
// 上方，让你知道 Claude 当时在回应什么。是 ScrollBox 之前的正常流
// 兄弟节点（与下方的 pill 对称）—— 通过 flex 把 ScrollBox 正好缩小
// 1 行，位于 DECSTBM 滚动区域之外。点击可跳回该 prompt。
//
// 高度固定为 1 行（长 prompt 用 truncate-end 截断）。可变高度的
// header（短时 1 行、换行时 2 行）会在滚动中每次 sticky prompt 切换时
// 把 ScrollBox 移动 1 行 —— 即便 scrollTop 不变，屏幕上的内容也会跳动
// （DECSTBM 区域顶部随 ScrollBox 移动，diff 引擎看到"所有东西都动了"）。
// 固定高度让 ScrollBox 保持锚定；只有 header 的文本变化，box 不变。
function StickyPromptHeader({ text, onClick }: { text: string; onClick: () => void }): React.ReactNode {
  const [hover, setHover] = useState(false);
  return (
    <Box
      flexShrink={0}
      width="100%"
      height={1}
      paddingRight={1}
      backgroundColor={hover ? 'userMessageBackgroundHover' : 'userMessageBackground'}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Text color="subtle" wrap="truncate-end">
        {figures.pointer} {text}
      </Text>
    </Box>
  );
}

// 斜杠命令建议 overlay —— 参见 promptOverlayContext.tsx 了解为何它是
// portal 化的。浮在 DECSTBM 区域之上造成的滚动涂抹在 Ink 层修复
// （render-node-to-output.ts 的 absoluteRectsPrev）。渲染器对绝对定位
// 元素会把负 y 钳制到 0（见 render-node-to-output.ts），所以即便 overlay
// 延伸到视口上方，顶部行（最佳匹配）仍保持可见。这里省略 minHeight 和
// flex-end：它们会创建空的 padding 行，当列表项少于最大值时把可见项
// 往下推到 prompt 区域。
function SuggestionsOverlay(): React.ReactNode {
  const data = usePromptOverlay();
  if (!data || data.suggestions.length === 0) return null;
  return (
    <Box position="absolute" bottom="100%" left={0} right={0} paddingX={2} paddingTop={1} flexDirection="column" opaque>
      <PromptInputFooterSuggestions
        suggestions={data.suggestions}
        selectedSuggestion={data.selectedSuggestion}
        maxColumnWidth={data.maxColumnWidth}
        overlay
      />
    </Box>
  );
}

// 从 PromptInput portal 过来的对话框（AutoModeOptInDialog） —— 与
// SuggestionsOverlay 相同的逃逸裁剪模式。在树顺序中渲染更晚，所以如果
// 两者同时出现（不应该如此），它会覆盖在建议之上。
function DialogOverlay(): React.ReactNode {
  const node = usePromptOverlayDialog();
  if (!node) return null;
  return (
    <Box position="absolute" bottom="100%" left={0} right={0} opaque>
      {node}
    </Box>
  );
}
