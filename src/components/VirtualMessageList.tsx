import type { RefObject } from 'react';
import * as React from 'react';
import { useCallback, useContext, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react';
import { useVirtualScroll } from '../hooks/useVirtualScroll.js';
import { Box, type DOMElement, type ScrollBoxHandle, type MatchPosition } from '@anthropic/ink';
import { TextHoverColorContext } from './design-system/ThemedText.js';
import { ScrollChromeContext } from './FullscreenLayout.js';

// scrollTo 时目标上方的留白行数。
const HEADROOM = 3;

import { logForDebugging } from '../utils/debug.js';
import { sleep } from '../utils/sleep.js';
import { renderableSearchText } from '../utils/transcriptSearch.js';
import type { RenderableMessage } from '../types/message.js';
import {
  isNavigableMessage,
  type MessageActionsNav,
  type MessageActionsState,
  type NavigableMessage,
  stripSystemReminders,
  toolCallOf,
} from './messageActions.js';

// 兜底提取器：为没有 Messages.tsx 工具查找路径的调用方（测试、静态
// 上下文）在这里做小写化 + 缓存。Messages.tsx 提供了自己的小写化缓存，
// 还会处理工具的 extractSearchText。
const fallbackLowerCache = new WeakMap<RenderableMessage, string>();
function defaultExtractSearchText(msg: RenderableMessage): string {
  const cached = fallbackLowerCache.get(msg);
  if (cached !== undefined) return cached;
  const lowered = renderableSearchText(msg);
  fallbackLowerCache.set(msg, lowered);
  return lowered;
}

export type StickyPrompt =
  | { text: string; scrollTo: () => void }
  // 点击时设置此项 —— header 隐藏，但 padding 保持折叠（0），让内容 ❯
  // 落在屏幕第 0 行而不是第 1 行。在下一次 sticky-prompt 计算时清除
  // （用户再次滚动时）。
  | 'clicked';

/** 巨大的粘贴 prompt（cat file | claude）可能达到 MB 级。Header 通过
 *  overflow:hidden 折成 2 行 —— 这里只是限制 React prop 的大小。 */
const STICKY_TEXT_CAP = 500;

/** 用于 transcript 导航的命令式 handle。方法在这里计算匹配
 *  （renderableMessages 的索引只在本组件内有效 —— Messages.tsx 会过滤
 *  和重排，REPL 无法在外部计算）。 */
export type JumpHandle = {
  jumpToIndex: (i: number) => void;
  setSearchQuery: (q: string) => void;
  nextMatch: () => void;
  prevMatch: () => void;
  /** 把当前 scrollTop 记为 incsearch 锚点。输入时以此为预览四处跳转；
   *  0 匹配时回到这里。Enter/n/N 从不恢复（它们不会以空调用
   *  setSearchQuery）。下一次 / 调用会覆盖。 */
  setAnchor: () => void;
  /** 预热搜索文本缓存，提取每条消息的文本。返回耗时毫秒，如果已经
   *  预热过（同一 transcript 会话的后续 /）则返回 0。在工作前先让出，
   *  以便调用方先绘制"正在索引…"。完成后调用方显示"已索引，耗时
   *  Xms"。 */
  warmSearchIndex: () => Promise<number>;
  /** 手动滚动（j/k/PgUp/滚轮）退出了搜索上下文。清空位置（黄色消失，
   *  反相高亮保留）。下一次 n/N 通过 step()→jump() 重新建立。从
   *  ScrollKeybindingHandler 的 onScroll 接入 —— 只对键盘/滚轮触发，
   *  不对程序化 scrollTo 触发。 */
  disarmSearch: () => void;
};

type Props = {
  messages: RenderableMessage[];
  scrollRef: RefObject<ScrollBoxHandle | null>;
  /** 变化时使 heightCache 失效 —— 不同宽度下的缓存高度是错的
   *  （文本重排 → 变宽后向上滚动会黑屏）。 */
  columns: number;
  itemKey: (msg: RenderableMessage) => string;
  renderItem: (msg: RenderableMessage, index: number) => React.ReactNode;
  /** 点击某条消息 Box 时触发（切换每条消息的详细模式）。 */
  onItemClick?: (msg: RenderableMessage) => void;
  /** 逐项过滤器 —— 对详细切换无效的消息（文本、文件编辑等）抑制
   *  hover/click。默认全部可点击。 */
  isItemClickable?: (msg: RenderableMessage) => boolean;
  /** 展开项获得持久的灰色背景（不仅是 hover 时）。 */
  isItemExpanded?: (msg: RenderableMessage) => boolean;
  /** 已小写化的搜索文本。Messages.tsx 在预热时缓存小写结果一次，这样
   *  setSearchQuery 每次按键的循环只做 indexOf（零 toLowerCase 分配）。
   *  对没有缓存的调用方回退到对 renderableSearchText 的小写包装。 */
  extractSearchText?: (msg: RenderableMessage) => string;
  /** 启用 sticky-prompt 跟踪器。StickyTracker 通过 ScrollChromeContext
   *  写入（不是回调 prop），所以状态放在 FullscreenLayout 而不是
   *  REPL。 */
  trackStickyPrompt?: boolean;
  selectedIndex?: number;
  /** 导航 handle 放在这里，因为高度测量在这里。 */
  cursorNavRef?: React.Ref<MessageActionsNav>;
  setCursor?: (c: MessageActionsState | null) => void;
  jumpRef?: RefObject<JumpHandle | null>;
  /** 搜索匹配变化时触发（编辑查询、n/N）。current 是 1 起的，用于
   *  "3/47" 显示；0 表示无匹配。 */
  onSearchMatchesChange?: (count: number, current: number) => void;
  /** 把现有 DOM 子树绘制到新 Screen 上扫描。元素来自主树（含全部
   *  provider）。位置相对于消息（第 0 行 = 元素顶部）。适用于任意
   *  高度 —— 填补了长消息的缺口。 */
  scanElement?: (el: DOMElement) => MatchPosition[];
  /** 基于位置的当前高亮。位置事先已知（来自 scanElement），导航 =
   *  索引运算 + scrollTo。rowOffset = 消息当前在屏幕顶部位置；位置
   *  保持稳定。 */
  setPositions?: (
    state: {
      positions: MatchPosition[];
      rowOffset: number;
      currentIdx: number;
    } | null,
  ) => void;
};

/**
 * 返回真实用户 prompt 的文本，其他情况返回 null。
 * "真实" = 人类输入的内容：不是工具结果，不是 XML 包裹的载荷
 * （<bash-stdout>、<command-message>、<teammate-message> 等），不是 meta。
 *
 * 两种形态会到这里：NormalizedUserMessage（普通 prompt）和
 * type==='queued_command' 的 AttachmentMessage（工具执行期间发送的
 * prompt —— 它们在下一轮作为附件被排干，见 query.ts:1410）。两者在
 * UI 中都渲染为 ❯ 前缀的 UserTextMessage，所以都应当 stick。
 *
 * 开头的 <system-reminder> 块在检查前被剥离 —— 它们被前置到存储的
 * 文本里用于 Claude 的 context（记忆更新、自动模式提醒），但不是用户
 * 输入的内容。不剥离的话，任何恰好带提醒的 prompt 都会被
 * startsWith('<') 检查拒绝。在 `cc -c` 恢复时常见，那里记忆更新提醒
 * 很密集。
 */
const promptTextCache = new WeakMap<RenderableMessage, string | null>();

function stickyPromptText(msg: RenderableMessage): string | null {
  // 以消息对象为键的缓存 —— 消息是只追加不修改的，所以 WeakMap 命中
  // 永远有效。遍历（StickyTracker，每个滚动 tick）每个 tick 都用相同
  // 的消息调用 5-50+ 次；system-reminder 剥离在每次解析时分配新字符串。
  // WeakMap 在压缩/清空（messages[] 被替换）时自动 GC。
  const cached = promptTextCache.get(msg);
  if (cached !== undefined) return cached;
  const result = computeStickyPromptText(msg);
  promptTextCache.set(msg, result);
  return result;
}

function computeStickyPromptText(msg: RenderableMessage): string | null {
  let raw: string | null = null;
  if (msg.type === 'user') {
    if (msg.isMeta || msg.isVisibleInTranscriptOnly) return null;
    const block = (msg.message.content as Array<{ type: string; text?: string }>)[0];
    if (block?.type !== 'text') return null;
    raw = block.text ?? null;
  } else if (
    msg.type === 'attachment' &&
    msg.attachment.type === 'queued_command' &&
    msg.attachment.commandMode !== 'task-notification' &&
    !msg.attachment.isMeta
  ) {
    const p = msg.attachment.prompt;
    raw =
      typeof p === 'string'
        ? p
        : (p as Array<{ type: string; text?: string }>)
            .flatMap(b => (b.type === 'text' ? [b.text ?? ''] : []))
            .join('\n');
  }
  if (raw === null) return null;

  const t = stripSystemReminders(raw);
  if (t.startsWith('<') || t === '') return null;
  return t;
}

/**
 * 全屏模式的虚拟化消息列表。从 Messages.tsx 拆出，以便
 * useVirtualScroll 被无条件调用（rules-of-hooks）—— Messages.tsx
 * 条件渲染本组件或普通 .map() 之一。
 *
 * 外层 <Box ref> 是测量锚点 —— MessageRow 不接 ref。单子节点列 Box
 * 把 Yoga 高度原样透传。
 */
type VirtualItemProps = {
  itemKey: string;
  msg: RenderableMessage;
  idx: number;
  measureRef: (key: string) => (el: DOMElement | null) => void;
  expanded: boolean | undefined;
  hovered: boolean;
  clickable: boolean;
  onClickK: (msg: RenderableMessage, cellIsBlank: boolean) => void;
  onEnterK: (k: string) => void;
  onLeaveK: (k: string) => void;
  renderItem: (msg: RenderableMessage, idx: number) => React.ReactNode;
};

// 带稳定 click handler 的 item 包装。每项闭包曾是
// `operationNewArrowFunction` 叶子 → `FunctionExecutable::finalizeUnconditionally`
// GC 清理（快速滚动时占 GC 时间 16%）。3 个闭包 × 60 个挂载 × 10 次
// commit/秒 = 1800 个闭包/秒。用通过 itemKey 串起来的稳定
// onClickK/onEnterK/onLeaveK，这里的闭包是每项每次渲染一份，但很便宜
// （只是把稳定回调绑上 k），并且不闭包 msg/idx，这让 JIT 能内联它们。
// 更大的收益在内部：MessageRow.memo 对未变化的消息直接跳过，省掉了
// marked.lexer + formatToken。
//
// 不用 React.memo —— renderItem 捕获了变化的状态（cursor、selectedIdx、
// verbose）。用忽略 renderItem 的比较器做 memo 会在跳过时使用过期闭包
// （选区高亮错误、verbose 过期）。把 renderItem 放进比较器又会让 memo
// 失效，因为它每次渲染都是新的。
function VirtualItem({
  itemKey: k,
  msg,
  idx,
  measureRef,
  expanded,
  hovered,
  clickable,
  onClickK,
  onEnterK,
  onLeaveK,
  renderItem,
}: VirtualItemProps): React.ReactNode {
  return (
    <Box
      ref={measureRef(k)}
      flexDirection="column"
      backgroundColor={expanded ? 'userMessageBackgroundHover' : undefined}
      // 这里的 bg 掩盖了 useVirtualScroll 在展开时的一帧偏移滞后 ——
      // 不要移到内部带 margin 的 Box 上。paddingBottom 与带色的
      // marginTop 对称。
      paddingBottom={expanded ? 1 : undefined}
      onClick={clickable ? e => onClickK(msg, e.cellIsBlank) : undefined}
      onMouseEnter={clickable ? () => onEnterK(k) : undefined}
      onMouseLeave={clickable ? () => onLeaveK(k) : undefined}
    >
      <TextHoverColorContext.Provider value={hovered && !expanded ? 'text' : undefined}>
        {renderItem(msg, idx)}
      </TextHoverColorContext.Provider>
    </Box>
  );
}

export function VirtualMessageList({
  messages,
  scrollRef,
  columns,
  itemKey,
  renderItem,
  onItemClick,
  isItemClickable,
  isItemExpanded,
  extractSearchText = defaultExtractSearchText,
  trackStickyPrompt,
  selectedIndex,
  cursorNavRef,
  setCursor,
  jumpRef,
  onSearchMatchesChange,
  scanElement,
  setPositions,
}: Props): React.ReactNode {
  // 增量 key 数组。流式输出每次追加一条消息；每次 commit 重建整个
  // 字符串数组会每条消息分配 O(n)（27k 条消息时约 1MB 抖动）。前缀匹配
  // 时做只追加的增量推送；在压缩、/clear 或 itemKey 变化时回退到完整
  // 重建。
  const keysRef = useRef<string[]>([]);
  const prevMessagesRef = useRef<typeof messages>(messages);
  const prevItemKeyRef = useRef(itemKey);
  if (
    prevItemKeyRef.current !== itemKey ||
    messages.length < keysRef.current.length ||
    messages[0] !== prevMessagesRef.current[0]
  ) {
    keysRef.current = messages.map(m => itemKey(m));
  } else {
    for (let i = keysRef.current.length; i < messages.length; i++) {
      keysRef.current.push(itemKey(messages[i]!));
    }
  }
  prevMessagesRef.current = messages;
  prevItemKeyRef.current = itemKey;
  const keys = keysRef.current;
  const {
    range,
    topSpacer,
    bottomSpacer,
    measureRef,
    spacerRef,
    offsets,
    getItemTop,
    getItemElement,
    getItemHeight,
    scrollToIndex,
  } = useVirtualScroll(scrollRef, keys, columns);
  const [start, end] = range;

  // 未测量（高度 undefined）的视为可见。
  const isVisible = useCallback(
    (i: number) => {
      const h = getItemHeight(i);
      if (h === 0) return false;
      return isNavigableMessage(messages[i]!);
    },
    [getItemHeight, messages],
  );
  useImperativeHandle(cursorNavRef, (): MessageActionsNav => {
    const select = (m: NavigableMessage) =>
      setCursor?.({
        uuid: m.uuid,
        msgType: m.type as import('./messageActions.js').NavigableType,
        expanded: false,
        toolName: toolCallOf(m)?.name,
      });
    const selIdx = selectedIndex ?? -1;
    const scan = (from: number, dir: 1 | -1, pred: (i: number) => boolean = isVisible) => {
      for (let i = from; i >= 0 && i < messages.length; i += dir) {
        if (pred(i)) {
          select(messages[i]!);
          return true;
        }
      }
      return false;
    };
    const isUser = (i: number) => isVisible(i) && messages[i]!.type === 'user';
    return {
      // 通过 shift+↑ 进入 = 与光标内 shift+↑（prevUser）语义相同。
      enterCursor: () => scan(messages.length - 1, -1, isUser),
      navigatePrev: () => scan(selIdx - 1, -1),
      navigateNext: () => {
        if (scan(selIdx + 1, 1)) return;
        // 越过最后一条可见消息 → 退出 + 重新钉住。最后一条消息的 TOP
        // 在视口顶部（选区滚动效应）；它的 BOTTOM 可能在折叠线以下。
        scrollRef.current?.scrollToBottom();
        setCursor?.(null);
      },
      // 仅 type:'user' —— queued_command 附件看起来像 prompt，但没有
      // 可回溯的原始 UserMessage。
      navigatePrevUser: () => scan(selIdx - 1, -1, isUser),
      navigateNextUser: () => scan(selIdx + 1, 1, isUser),
      navigateTop: () => scan(0, 1),
      navigateBottom: () => scan(messages.length - 1, -1),
      getSelected: () => (selIdx >= 0 ? (messages[selIdx] ?? null) : null),
    };
  }, [messages, selectedIndex, setCursor, isVisible]);
  // 两阶段跳转 + 搜索引擎。通过 ref 读取，让 handle 在渲染间保持稳定
  // —— offsets/messages 身份每次渲染都变，放进 useImperativeHandle 依赖
  // 会重建 handle。
  const jumpState = useRef({
    offsets,
    start,
    getItemElement,
    getItemTop,
    messages,
    scrollToIndex,
  });
  jumpState.current = {
    offsets,
    start,
    getItemElement,
    getItemTop,
    messages,
    scrollToIndex,
  };

  // 保持光标选中的消息可见。offsets 每次渲染都重建 —— 作为裸依赖，
  // 每次滚轮 tick 都会重新钉住。改为通过 jumpState 读取；越过 overscan
  // 的跳转通过 scrollToIndex 落地，下一次导航是精确的。
  useEffect(() => {
    if (selectedIndex === undefined) return;
    const s = jumpState.current;
    const el = s.getItemElement(selectedIndex);
    if (el) {
      scrollRef.current?.scrollToElement(el, 1);
    } else {
      s.scrollToIndex(selectedIndex);
    }
  }, [selectedIndex, scrollRef]);

  // 待处理的 seek 请求。jump() 设置它 + 递增 seekGen。seek effect 在
  // 绘制后触发（被动 effect —— 在 resetAfterCommit 之后），检查目标是否
  // 已挂载。是 → 扫描 + 高亮。否 → 用更新的锚点（start 向 idx 移动）
  // 重新估算并再次 scrollTo。
  const scanRequestRef = useRef<{
    idx: number;
    wantLast: boolean;
    tries: number;
  } | null>(null);
  // 来自 scanElement 的消息相对位置。第 0 行 = 消息顶部。
  // 跨滚动稳定 —— 高亮实时计算 rowOffset。msgIdx 用于计算
  // rowOffset = getItemTop(msgIdx) - scrollTop。
  const elementPositions = useRef<{
    msgIdx: number;
    positions: MatchPosition[];
  }>({ msgIdx: -1, positions: [] });
  // 回绕守卫。如果 ptr 回绕到这里，自动前进就停止。
  const startPtrRef = useRef(-1);
  // 幻影突发上限。扫描成功时重置。
  const phantomBurstRef = useRef(0);
  // 一深度队列：seek 进行中到达的 n/N 会被存储（不丢弃），在 seek 完成后
  // 触发。按住 n 不排队 30 次跳转也能保持流畅。最新按下覆盖 —— 我们要的
  // 是用户当前前进的方向，而不是 10 次按键前所在的位置。
  const pendingStepRef = useRef<1 | -1 | 0>(0);
  // step + highlight 通过 ref，让 seek effect 读取最新值而无需闭包捕获
  // 或依赖抖动。
  const stepRef = useRef<(d: 1 | -1) => void>(() => {});
  const highlightRef = useRef<(ord: number) => void>(() => {});
  const searchState = useRef({
    matches: [] as number[], // 去重后的消息索引
    ptr: 0,
    screenOrd: 0,
    // 每个 matches[k] 之前的累计引擎出现次数。用于计算全局当前索引：
    // prefixSum[ptr] + screenOrd + 1。
    // 引擎计数（对 extractSearchText 做 indexOf），不是渲染计数 ——
    // 对徽标够用；精确计数需要对每条匹配消息做 scanElement（~1-3ms × N）。
    // total = prefixSum[matches.length]。
    prefixSum: [] as number[],
  });
  // 按下 / 那一刻的 scrollTop。匹配降到 0 时，incsearch 预览跳转回到这里。
  // -1 = 无锚点（第一次 / 之前）。
  const searchAnchor = useRef(-1);
  const indexWarmed = useRef(false);

  // 消息 i 的滚动目标：落在消息顶部。est = top - HEADROOM，这样
  // lo = top - est = HEADROOM ≥ 0（或当 est 被 clamp 到 0 时 lo = top）。
  // jump() 中 clamp 后的读回处理 scrollHeight 边界。
  // 无 frac（渲染变换不遵守它），无单调 clamp（曾是 frac 垃圾值的兜底
  // —— 没有 frac 时，est 就是下一条消息的顶部，狂按 n/N 会收敛，因为
  // 消息顶部是有序的）。
  function targetFor(i: number): number {
    const top = jumpState.current.getItemTop(i);
    return Math.max(0, top - HEADROOM);
  }

  // 高亮 positions[ord]。位置是消息相对的（第 0 行 = 元素顶部，来自
  // scanElement）。实时计算 rowOffset = getItemTop - scrollTop。如果 ord
  // 的位置在视口外，滚动把它带入，重新计算 rowOffset。setPositions 触发
  // 覆盖层写入。
  function highlight(ord: number): void {
    const s = scrollRef.current;
    const { msgIdx, positions } = elementPositions.current;
    if (!s || positions.length === 0 || msgIdx < 0) {
      setPositions?.(null);
      return;
    }
    const idx = Math.max(0, Math.min(ord, positions.length - 1));
    const p = positions[idx]!;
    const top = jumpState.current.getItemTop(msgIdx);
    // lo = 元素在滚动内容中的位置（相对于 wrapper）。
    // viewportTop = 滚动内容在屏幕上的起始位置（在 ScrollBox padding/
    // border + 上方任何 chrome 之后）。高亮写入的是屏幕绝对坐标，所以
    // rowOffset = viewportTop + lo。观察到：不带 viewportTop 会差 1+
    // （FullscreenLayout 的 ScrollBox 有 paddingTop=1，再加上上方任何
    // header）。
    const vpTop = s.getViewportTop();
    let lo = top - s.getScrollTop();
    const vp = s.getViewportHeight();
    let screenRow = vpTop + lo + p.row;
    // 在视口外 → 滚动把它带入（距顶部 HEADROOM）。
    // scrollTo 同步提交；之后的读回给出最新的 lo。
    if (screenRow < vpTop || screenRow >= vpTop + vp) {
      s.scrollTo(Math.max(0, top + p.row - HEADROOM));
      lo = top - s.getScrollTop();
      screenRow = vpTop + lo + p.row;
    }
    setPositions?.({ positions, rowOffset: vpTop + lo, currentIdx: idx });
    // 徽标：全局当前 = 此消息之前的出现次数之和 + ord+1。
    // prefixSum[ptr] 是引擎计数（对 extractSearchText 做 indexOf）；
    // 对幽灵消息可能与渲染计数有偏移，但够用 —— 徽标只是粗略的位置
    // 提示，不是证明。
    const st = searchState.current;
    const total = st.prefixSum.at(-1) ?? 0;
    const current = (st.prefixSum[st.ptr] ?? 0) + idx + 1;
    onSearchMatchesChange?.(total, current);
    logForDebugging(
      `highlight(i=${msgIdx}, ord=${idx}/${positions.length}): ` +
        `pos={row:${p.row},col:${p.col}} lo=${lo} screenRow=${screenRow} ` +
        `badge=${current}/${total}`,
    );
  }
  highlightRef.current = highlight;

  // Seek effect。jump() 设置 scanRequestRef + scrollToIndex + bump。
  // bump → 重渲染 → useVirtualScroll 挂载目标（scrollToIndex 保证这一点
  // —— scrollTop 和 topSpacer 通过同一个 offsets 值一致）→
  // resetAfterCommit 绘制 → 这个被动 effect 在绘制之后触发，此时元素已
  // 挂载。精确 scrollTo + 扫描。
  //
  // 依赖只有 seekGen —— effect 不会在随机渲染上重新运行（incsearch 期间
  // onSearchMatchesChange 的抖动）。
  const [seekGen, setSeekGen] = useState(0);
  const bumpSeek = useCallback(() => setSeekGen(g => g + 1), []);

  useEffect(() => {
    const req = scanRequestRef.current;
    if (!req) return;
    const { idx, wantLast, tries } = req;
    const s = scrollRef.current;
    if (!s) return;
    const { getItemElement, getItemTop, scrollToIndex } = jumpState.current;
    const el = getItemElement(idx);
    const h = el?.yogaNode?.getComputedHeight() ?? 0;

    if (!el || h === 0) {
      // scrollToIndex 之后仍未挂载。不应发生 —— scrollToIndex 由构造保证
      // 挂载（scrollTop 和 topSpacer 通过同一个 offsets 值一致）。
      // 兜底：重试一次，然后跳过。
      if (tries > 1) {
        scanRequestRef.current = null;
        logForDebugging(`seek(i=${idx}): no mount after scrollToIndex, skip`);
        stepRef.current(wantLast ? -1 : 1);
        return;
      }
      scanRequestRef.current = { idx, wantLast, tries: tries + 1 };
      scrollToIndex(idx);
      bumpSeek();
      return;
    }

    scanRequestRef.current = null;
    // 精确 scrollTo —— scrollToIndex 把我们带到了附近（元素已挂载，可能
    // 因为 overscan 估算偏移而差几十行）。现在让它落在 top-HEADROOM。
    s.scrollTo(Math.max(0, getItemTop(idx) - HEADROOM));
    const positions = scanElement?.(el) ?? [];
    elementPositions.current = { msgIdx: idx, positions };
    logForDebugging(`seek(i=${idx} t=${tries}): ${positions.length} positions`);
    if (positions.length === 0) {
      // 幻影 —— 引擎匹配了，渲染没匹配。自动前进。
      if (++phantomBurstRef.current > 20) {
        phantomBurstRef.current = 0;
        return;
      }
      stepRef.current(wantLast ? -1 : 1);
      return;
    }
    phantomBurstRef.current = 0;
    const ord = wantLast ? positions.length - 1 : 0;
    searchState.current.screenOrd = ord;
    startPtrRef.current = -1;
    highlightRef.current(ord);
    const pending = pendingStepRef.current;
    if (pending) {
      pendingStepRef.current = 0;
      stepRef.current(pending);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekGen]);

  // 滚动到消息 i 的顶部，装备 scanPending。scan effect 在下一个 tick
  // 读取新屏幕。wantLast：N 进入消息 —— screenOrd = length-1。
  function jump(i: number, wantLast: boolean): void {
    const s = scrollRef.current;
    if (!s) return;
    const js = jumpState.current;
    const { getItemElement, scrollToIndex } = js;
    // offsets 是一个 Float64Array，其 .length 是已分配缓冲区的大小（只
    // 增长）—— messages.length 才是逻辑条目数。
    if (i < 0 || i >= js.messages.length) return;
    // 滚动前清除过期高亮。从现在到 seek effect 的高亮之间，只显示
    // scan-highlight 的反相部分。
    setPositions?.(null);
    elementPositions.current = { msgIdx: -1, positions: [] };
    scanRequestRef.current = { idx: i, wantLast, tries: 0 };
    const el = getItemElement(i);
    const h = el?.yogaNode?.getComputedHeight() ?? 0;
    // 已挂载 → 精确 scrollTo。未挂载 → scrollToIndex 挂载它
    // （scrollTop 和 topSpacer 通过同一个 offsets 值一致 —— 构造上精确，
    // 无估算）。两种情况下 seek effect 都在绘制后做精确 scrollTo。
    if (el && h > 0) {
      s.scrollTo(targetFor(i));
    } else {
      scrollToIndex(i);
    }
    bumpSeek();
  }

  // 在 elementPositions 内推进 screenOrd。耗尽 → ptr 前进，跳转到下一个
  // matches[ptr]，重新扫描。幻影（跳转后扫描到 0）从 scan-effect 触发
  // 自动前进。回绕守卫在每条消息都是幻影时停止。
  function step(delta: 1 | -1): void {
    const st = searchState.current;
    const { matches, prefixSum } = st;
    const total = prefixSum.at(-1) ?? 0;
    if (matches.length === 0) return;

    // Seek 进行中 —— 把这次按下排队（一深度，最新覆盖）。seek effect 在
    // 高亮后触发它。
    if (scanRequestRef.current) {
      pendingStepRef.current = delta;
      return;
    }

    if (startPtrRef.current < 0) startPtrRef.current = st.ptr;

    const { positions } = elementPositions.current;
    const newOrd = st.screenOrd + delta;
    if (newOrd >= 0 && newOrd < positions.length) {
      st.screenOrd = newOrd;
      highlight(newOrd); // 内部更新徽标
      startPtrRef.current = -1;
      return;
    }

    // 可见的耗尽。推进 ptr → 跳转 → 重新扫描。
    const ptr = (st.ptr + delta + matches.length) % matches.length;
    if (ptr === startPtrRef.current) {
      setPositions?.(null);
      startPtrRef.current = -1;
      logForDebugging(`step: wraparound at ptr=${ptr}, all ${matches.length} msgs phantoms`);
      return;
    }
    st.ptr = ptr;
    st.screenOrd = 0; // 在扫描后解析（wantLast → length-1）
    jump(matches[ptr]!, delta < 0);
    // screenOrd 将在扫描后解析。尽力而为：n 用 prefixSum[ptr] + 0（第一个
    // 位置），N 用 prefixSum[ptr+1]（最后一个位置 = count-1）。
    // scan-effect 的 highlight 会是真实值；这只是扫描前的占位，让徽标
    // 立即更新。
    const placeholder = delta < 0 ? (prefixSum[ptr + 1] ?? total) : prefixSum[ptr]! + 1;
    onSearchMatchesChange?.(total, placeholder);
  }
  stepRef.current = step;

  useImperativeHandle(
    jumpRef,
    () => ({
      // 非搜索跳转（sticky header 点击等）。无扫描，无位置。
      jumpToIndex: (i: number) => {
        const s = scrollRef.current;
        if (s) s.scrollTo(targetFor(i));
      },
      setSearchQuery: (q: string) => {
        // 新搜索使一切失效。
        scanRequestRef.current = null;
        elementPositions.current = { msgIdx: -1, positions: [] };
        startPtrRef.current = -1;
        setPositions?.(null);
        const lq = q.toLowerCase();
        // 每条消息一个条目（去重）。布尔"这条消息是否包含查询"。缓存
        // 了小写化的情况下 9k 条消息约 10ms。
        const matches: number[] = [];
        // 每条消息的出现次数 → prefixSum 用于全局当前索引。引擎计数
        // （便宜的 indexOf 循环）；对幽灵/幻影消息可能与渲染计数
        // （scanElement）不同，但对徽标够用。徽标只是粗略位置提示。
        const prefixSum: number[] = [0];
        if (lq) {
          const msgs = jumpState.current.messages;
          for (let i = 0; i < msgs.length; i++) {
            const text = extractSearchText(msgs[i]!);
            let pos = text.indexOf(lq);
            let cnt = 0;
            while (pos >= 0) {
              cnt++;
              pos = text.indexOf(lq, pos + lq.length);
            }
            if (cnt > 0) {
              matches.push(i);
              prefixSum.push(prefixSum.at(-1)! + cnt);
            }
          }
        }
        const total = prefixSum.at(-1)!;
        // 距锚点最近的消息。<= 让平局归到后面。
        let ptr = 0;
        const s = scrollRef.current;
        const { offsets, start, getItemTop } = jumpState.current;
        const firstTop = getItemTop(start);
        const origin = firstTop >= 0 ? firstTop - offsets[start]! : 0;
        if (matches.length > 0 && s) {
          const curTop = searchAnchor.current >= 0 ? searchAnchor.current : s.getScrollTop();
          let best = Infinity;
          for (let k = 0; k < matches.length; k++) {
            const d = Math.abs(origin + offsets[matches[k]!]! - curTop);
            if (d <= best) {
              best = d;
              ptr = k;
            }
          }
          logForDebugging(
            `setSearchQuery('${q}'): ${matches.length} msgs · ptr=${ptr} ` +
              `msgIdx=${matches[ptr]} curTop=${curTop} origin=${origin}`,
          );
        }
        searchState.current = { matches, ptr, screenOrd: 0, prefixSum };
        if (matches.length > 0) {
          // wantLast=true：预览最近消息中的最后一次出现。在 sticky-bottom
          // （常见 / 入口）时，最近的是最后一条消息；它的最后一次出现最
          // 接近用户原来所在位置 —— 视图移动最小。n 从那里向前推进。
          jump(matches[ptr]!, true);
        } else if (searchAnchor.current >= 0 && s) {
          // /foob → 0 匹配 → 回到锚点。less/vim incsearch 行为。
          s.scrollTo(searchAnchor.current);
        }
        // 全局出现次数 + 1 起的当前。wantLast=true，所以扫描会落在
        // matches[ptr] 的最后一次出现。占位 = prefixSum[ptr+1]（到此消息
        // 为止的计数）。扫描完成后 highlight() 更新为精确值。
        onSearchMatchesChange?.(total, matches.length > 0 ? (prefixSum[ptr + 1] ?? total) : 0);
      },
      nextMatch: () => step(1),
      prevMatch: () => step(-1),
      setAnchor: () => {
        const s = scrollRef.current;
        if (s) searchAnchor.current = s.getScrollTop();
      },
      disarmSearch: () => {
        // 手动滚动使屏幕绝对位置失效。
        setPositions?.(null);
        scanRequestRef.current = null;
        elementPositions.current = { msgIdx: -1, positions: [] };
        startPtrRef.current = -1;
      },
      warmSearchIndex: async () => {
        if (indexWarmed.current) return 0;
        const msgs = jumpState.current.messages;
        const CHUNK = 500;
        let workMs = 0;
        const wallStart = performance.now();
        for (let i = 0; i < msgs.length; i += CHUNK) {
          await sleep(0);
          const t0 = performance.now();
          const end = Math.min(i + CHUNK, msgs.length);
          for (let j = i; j < end; j++) {
            extractSearchText(msgs[j]!);
          }
          workMs += performance.now() - t0;
        }
        const wallMs = Math.round(performance.now() - wallStart);
        logForDebugging(
          `warmSearchIndex: ${msgs.length} msgs · work=${Math.round(workMs)}ms wall=${wallMs}ms chunks=${Math.ceil(msgs.length / CHUNK)}`,
        );
        indexWarmed.current = true;
        return Math.round(workMs);
      },
    }),
    // 闭包捕获的是 ref + 回调。scrollRef 稳定；其他是 useCallback([])
    // 或从 REPL 逐层传入 prop（稳定）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scrollRef],
  );

  // StickyTracker 放在列表内容之后。它返回 null（无 DOM 节点），所以顺序
  // 对布局无所谓 —— 但放在第一个意味着它自己滚动订阅的每次细粒度 commit
  // 都会穿过兄弟 item 进行协调（React 按顺序遍历子节点）。放在 item 之后
  // 就是叶子协调。防御性：也避免 Ink 协调器如果为 null 返回物化占位符时
  // 的任何 Yoga 子索引怪问题。
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  // 稳定的 click/hover handler —— 用 k 调用，从 ref 分发，这样闭包身份
  // 不会每次渲染都变。每项 handler 闭包（`e => ...`、`() => setHoveredKey(k)`）
  // 曾是滚动 CPU profile 中的 `operationNewArrowFunction` 叶子；它们的清理
  // 占 GC 时间的 16%（`FunctionExecutable::finalizeUnconditionally`）。
  // 快速滚动时 3 个闭包 × 60 个挂载 × 10 次 commit/秒 = 1800 个短命闭包/秒。
  // 用稳定的 ref 后，item 包装的 prop 不变 → VirtualItem.memo 对约 35 个
  // 未变化的 item 跳过，只有约 25 个新 item 付出 createElement 成本。
  const handlersRef = useRef({ onItemClick, setHoveredKey });
  handlersRef.current = { onItemClick, setHoveredKey };
  const onClickK = useCallback((msg: RenderableMessage, cellIsBlank: boolean) => {
    const h = handlersRef.current;
    if (!cellIsBlank && h.onItemClick) h.onItemClick(msg);
  }, []);
  const onEnterK = useCallback((k: string) => {
    handlersRef.current.setHoveredKey(k);
  }, []);
  const onLeaveK = useCallback((k: string) => {
    handlersRef.current.setHoveredKey(prev => (prev === k ? null : prev));
  }, []);

  return (
    <>
      <Box ref={spacerRef} height={topSpacer} flexShrink={0} />
      {messages.slice(start, end).map((msg, i) => {
        const idx = start + i;
        const k = keys[idx]!;
        const clickable = !!onItemClick && (isItemClickable?.(msg) ?? true);
        const hovered = clickable && hoveredKey === k;
        const expanded = isItemExpanded?.(msg);
        return (
          <VirtualItem
            key={k}
            itemKey={k}
            msg={msg}
            idx={idx}
            measureRef={measureRef}
            expanded={expanded}
            hovered={hovered}
            clickable={clickable}
            onClickK={onClickK}
            onEnterK={onEnterK}
            onLeaveK={onLeaveK}
            renderItem={renderItem}
          />
        );
      })}
      {bottomSpacer > 0 && <Box height={bottomSpacer} flexShrink={0} />}
      {trackStickyPrompt && (
        <StickyTracker
          messages={messages}
          start={start}
          end={end}
          offsets={offsets}
          getItemTop={getItemTop}
          getItemElement={getItemElement}
          scrollRef={scrollRef}
        />
      )}
    </>
  );
}

const NOOP_UNSUB = () => {};

/**
 * 只做副作用的子组件，跟踪滚动到视口顶部之上的最后一条用户 prompt，
 * 在它变化时触发 onChange。
 *
 * 作为独立组件渲染（不是 VirtualMessageList 里的 hook），这样它可以
 * 以比 SCROLL_QUANTUM=40 更细的粒度订阅滚动。列表需要粗粒度量子以避免
 * 每个滚轮 tick 的 Yoga 重排；这个跟踪器只是一次遍历 + 比较，每个 tick
 * 都跑得起。当它单独重渲染时，列表的协调输出不变（来自父组件上一次
 * commit 的相同 prop）—— 无 Yoga 工作。不拆分的话，header 会滞后约一
 * 个对话回合（40 行 ≈ 一个 prompt + 回复）。
 *
 * firstVisible 推导：item Box 是 ScrollBox 内容 wrapper 的直接 Yoga 子节点
 * （片段在 Ink DOM 中折叠），所以 yoga.getComputedTop 是相对于内容
 * wrapper 的 —— 与 scrollTop 同坐标系。与 scrollTop + pendingDelta
 * （滚动目标 —— scrollBy 只设置 pendingDelta，已提交的 scrollTop 滞后）
 * 比较。从挂载范围末尾向前遍历；当某 item 的顶部在目标之上时 break。
 */
function StickyTracker({
  messages,
  start,
  end,
  offsets,
  getItemTop,
  getItemElement,
  scrollRef,
}: {
  messages: RenderableMessage[];
  start: number;
  end: number;
  offsets: ArrayLike<number>;
  getItemTop: (index: number) => number;
  getItemElement: (index: number) => DOMElement | null;
  scrollRef: RefObject<ScrollBoxHandle | null>;
}): null {
  const { setStickyPrompt } = useContext(ScrollChromeContext);
  // 细粒度订阅 —— 快照是未量子化的 scrollTop+delta，所以每个滚动动作
  // （滚轮 tick、PgUp、拖拽）都触发本组件重渲染。sticky 位折叠进符号，
  // 这样 sticky→broken 也触发（scrollToBottom 设置 sticky 但不移动
  // scrollTop）。
  const subscribe = useCallback(
    (listener: () => void) => scrollRef.current?.subscribe(listener) ?? NOOP_UNSUB,
    [scrollRef],
  );
  useSyncExternalStore(subscribe, () => {
    const s = scrollRef.current;
    if (!s) return NaN;
    const t = s.getScrollTop() + s.getPendingDelta();
    return s.isSticky() ? -1 - t : t;
  });

  // 每次渲染读取实时滚动状态。
  const isSticky = scrollRef.current?.isSticky() ?? true;
  const target = Math.max(0, (scrollRef.current?.getScrollTop() ?? 0) + (scrollRef.current?.getPendingDelta() ?? 0));

  // 遍历挂载范围，找到第一个位于视口顶部或以下的 item。`range` 来自父
  // 组件的粗粒子渲染（可能略有过期），但 overscan 保证它在两个方向上都
  // 远超视口。还没有 Yoga 布局的 item（本帧新挂载）视为位于顶部或以下
  // —— 它们在视图中的某处，假设相反会为实际在屏幕上的 prompt 显示
  // sticky。
  let firstVisible = start;
  let firstVisibleTop = -1;
  for (let i = end - 1; i >= start; i--) {
    const top = getItemTop(i);
    if (top >= 0) {
      if (top < target) break;
      firstVisibleTop = top;
    }
    firstVisible = i;
  }

  let idx = -1;
  let text: string | null = null;
  if (firstVisible > 0 && !isSticky) {
    for (let i = firstVisible - 1; i >= 0; i--) {
      const t = stickyPromptText(messages[i]!);
      if (t === null) continue;
      // prompt 的外层 Box 顶部在目标之上（这就是它在 [0, firstVisible)
      // 范围内的原因），但它的 ❯ 在 top+1（marginTop=1）。如果 ❯ 位于
      // 目标或以下，它就显示在视口顶部 —— 在 header 里显示同样的文本会
      // 重复。发生在 Box 顶部滚过和 ❯ 滚过之间的 1 行空隙。跳到下一个
      // 更早的 prompt（它的 ❯ 肯定在上面）。
      const top = getItemTop(i);
      if (top >= 0 && top + 1 >= target) continue;
      idx = i;
      text = t;
      break;
    }
  }

  const baseOffset = firstVisibleTop >= 0 ? firstVisibleTop - offsets[firstVisible]! : 0;
  const estimate = idx >= 0 ? Math.max(0, baseOffset + offsets[idx]!) : -1;

  // 对于跳转到尚未挂载 item 的点击（用户滚到了很远以外，prompt 在
  // topSpacer 里）。Click handler 滚动到估算值以挂载它；这里在元素出现
  // 后按元素锚定。scrollToElement 把 Yoga 位置读取推迟到渲染时
  // （render-node-to-output 在产生 scrollHeight 的同一次 calculateLayout
  // 中读取 el.yogaNode.getComputedTop()）—— 无节流竞争。限制重试次数：
  // /clear 竞争可能在序列中途卸载 item。
  const pending = useRef({ idx: -1, tries: 0 });
  // 抑制状态机。Click handler 装备；onChange effect 消费（armed→force），
  // 然后在之后的渲染上触发并清空（force→none）。force 步骤毒化去重：
  // 点击后 idx 经常重新计算到同一个 prompt（它的顶部仍在目标之上），
  // 没有 force 的话 last.idx===idx 守卫会一直保持 'clicked' 直到用户跨过
  // prompt 边界。之前编码在 last.idx 里为 -1/-2/-3，与真实索引重叠 ——
  // 太巧妙了。
  type Suppress = 'none' | 'armed' | 'force';
  const suppress = useRef<Suppress>('none');
  // 只对 idx 去重 —— estimate 派生自 firstVisibleTop，它每个滚动 tick 都
  // 移动，所以把它放进键会让守卫失效（setStickyPrompt 每帧触发一个全新
  // 的 {text,scrollTo}）。scrollTo 闭包仍然捕获当前 estimate；只是当只有
  // estimate 移动时不需要重新触发。
  const lastIdx = useRef(-1);

  // setStickyPrompt effect 在前 —— 必须在下面的纠正 effect 清空 pending
  // 之前看到 pending.idx。在估算兜底路径上，挂载 item 的渲染也是纠正清空
  // pending 的渲染；如果这个 effect 在后面运行，pending 门槛会失效，
  // setStickyPrompt(prevPrompt) 会在跳转中途触发，把 header 重新挂载到
  // 'clicked' 之上。
  useEffect(() => {
    // 两阶段纠正进行中时保持。
    if (pending.current.idx >= 0) return;
    if (suppress.current === 'armed') {
      suppress.current = 'force';
      return;
    }
    const force = suppress.current === 'force';
    suppress.current = 'none';
    if (!force && lastIdx.current === idx) return;
    lastIdx.current = idx;
    if (text === null) {
      setStickyPrompt(null);
      return;
    }
    // 只取第一段（按空行分割）—— 像 "still seeing bugs:\n\n1. foo\n2. bar"
    // 这样的 prompt 只预览开头。trimStart 让开头的空行（queued_command
    // 中途消息有时会有一个）不会在第 0 位找到 paraEnd。
    const trimmed = text.trimStart();
    const paraEnd = trimmed.search(/\n\s*\n/);
    const collapsed = (paraEnd >= 0 ? trimmed.slice(0, paraEnd) : trimmed)
      .slice(0, STICKY_TEXT_CAP)
      .replace(/\s+/g, ' ')
      .trim();
    if (collapsed === '') {
      setStickyPrompt(null);
      return;
    }
    const capturedIdx = idx;
    const capturedEstimate = estimate;
    setStickyPrompt({
      text: collapsed,
      scrollTo: () => {
        // 隐藏 header，保持 padding 折叠 —— FullscreenLayout 的 'clicked'
        // 哨兵 → scrollBox_y=0 + pad=0 → viewportTop=0。
        setStickyPrompt('clicked');
        suppress.current = 'armed';
        // scrollToElement 按 DOMElement ref 锚定，不是数字：
        // render-node-to-output 在绘制时读取 el.yogaNode.getComputedTop()
        // （与 scrollHeight 同一次 Yoga 传递）。节流渲染不会带来过期 ——
        // ref 是稳定的，位置读取被推迟。offset=1 = UserPromptMessage 的
        // marginTop。
        const el = getItemElement(capturedIdx);
        if (el) {
          scrollRef.current?.scrollToElement(el, 1);
        } else {
          // 未挂载（滚到了很远以外 —— 在 topSpacer 里）。跳到估算值以挂载
          // 它；纠正 effect 在它出现后重新锚定。估算基于
          // DEFAULT_ESTIMATE —— 会落在偏前的位置。
          scrollRef.current?.scrollTo(capturedEstimate);
          pending.current = { idx: capturedIdx, tries: 0 };
        }
      },
    });
    // 无依赖 —— 每次渲染都必须运行。抑制状态在 ref 里（不是 idx/estimate），
    // 所以依赖门控的 effect 永远看不到它变化。函数体自己的守卫在无变化时
    // 短路。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  // 纠正：针对跳转到未挂载 item 的点击。Click handler 滚动到估算值；
  // 这里在 item 出现后按元素重新锚定。scrollToElement 把 Yoga 读取推迟
  // 到绘制时 —— 确定性。放在第二个，这样它在上面的 onChange 门槛看到
  // pending 之后再清空 pending。
  useEffect(() => {
    if (pending.current.idx < 0) return;
    const el = getItemElement(pending.current.idx);
    if (el) {
      scrollRef.current?.scrollToElement(el, 1);
      pending.current = { idx: -1, tries: 0 };
    } else if (++pending.current.tries > 5) {
      pending.current = { idx: -1, tries: 0 };
    }
  });

  return null;
}
