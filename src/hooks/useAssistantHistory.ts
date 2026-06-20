import { randomUUID } from 'crypto'
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react'
import {
  createHistoryAuthCtx,
  fetchLatestEvents,
  fetchOlderEvents,
  type HistoryAuthCtx,
  type HistoryPage,
} from '../assistant/sessionHistory.js'
import type { ScrollBoxHandle } from '@anthropic/ink'
import type { RemoteSessionConfig } from '../remote/RemoteSessionManager.js'
import { convertSDKMessage } from '../remote/sdkMessageAdapter.js'
import type { Message, SystemInformationalMessage } from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'

type Props = {
  /** 受限于 viewerOnly —— 非查看器会话没有远程历史可翻页。 */
  config: RemoteSessionConfig | undefined
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
  scrollRef: RefObject<ScrollBoxHandle | null>
  /** 在布局效果的预置后调用，带有消息数量 + 高度
   *  增量。让 useUnseenDivider 移动 dividerIndex + dividerYRef。 */
  onPrepend?: (indexDelta: number, heightDelta: number) => void
}

type Result = {
  /** 触发 ScrollKeybindingHandler 的 onScroll 组合。 */
  maybeLoadOlder: (handle: ScrollBoxHandle) => void
}

/** 当滚动到距离顶部此行数内时触发 loadOlder。 */
const PREFETCH_THRESHOLD_ROWS = 40

/** 挂载时填充视口的最大链式页面加载数。限制当事件转换为
 *  零可见消息（全部被过滤）时的循环。 */
const MAX_FILL_PAGES = 10

const SENTINEL_LOADING = 'loading older messages…'
const SENTINEL_LOADING_FAILED =
  'failed to load older messages — scroll up to retry'
const SENTINEL_START = 'start of session'

/** 使用与查看器模式相同的选项将 HistoryPage 转换为 REPL Message[]。 */
function pageToMessages(page: HistoryPage): Message[] {
  const out: Message[] = []
  for (const ev of page.events) {
    const c = convertSDKMessage(ev, {
      convertUserTextMessages: true,
      convertToolResults: true,
    })
    if (c.type === 'message') out.push(c.message)
  }
  return out
}

/**
 * 在向上滚动时延迟加载 `claude assistant` 历史。
 *
 * 挂载时：通过 anchor_to_latest 获取最新页面，预置到消息。
 * 在接近顶部向上滚动时：通过 before_id 获取下一页更旧的内容，
 * 使用滚动锚定预置（视口保持不变）。
 *
 * 除非 config.viewerOnly 否则为无操作。REPL 仅在
 * feature('KAIROS') 门控内调用此 hook，因此构建时消除在那里处理。
 */
export function useAssistantHistory({
  config,
  setMessages,
  scrollRef,
  onPrepend,
}: Props): Result {
  const enabled = config?.viewerOnly === true

  // 游标状态：仅 ref（游标变化时不重新渲染）。`null` = 没有
  // 更旧的页面。`undefined` = 初始页面尚未获取。
  const cursorRef = useRef<string | null | undefined>(undefined)
  const ctxRef = useRef<HistoryAuthCtx | null>(null)
  const inflightRef = useRef(false)

  // 滚动锚：在 setMessages 之前快照高度 + 预置数量；
  // 在 React 提交后在 useLayoutEffect 中补偿。getFreshScrollHeight
  // 直接读取 Yoga，因此提交后的值是正确的。
  const anchorRef = useRef<{ beforeHeight: number; count: number } | null>(null)

  // 填充视口链：初始页面提交后，如果内容尚未
  // 填充视口，加载另一页。通过布局效果自链
  // 直到填充或预算用完。预算在初始加载时设置一次；用户
  // 向上滚动不需要它（maybeLoadOlder 在下一个滚轮事件重新触发）。
  const fillBudgetRef = useRef(0)

  // 稳定的哨兵 UUID —— 在交换时重用，以便虚拟滚动将其视为
  // 一个项目（仅文本变化，而不是移除+插入）。
  const sentinelUuidRef = useRef(randomUUID())

  function mkSentinel(text: string): SystemInformationalMessage {
    return {
      type: 'system',
      subtype: 'informational',
      content: text,
      isMeta: false,
      timestamp: new Date().toISOString(),
      uuid: sentinelUuidRef.current,
      level: 'info',
    }
  }

  /** 在前方预置一页，非初始时带有滚动锚快照。
   *  就地替换哨兵（存在时始终在索引 0）。 */
  const prepend = useCallback(
    (page: HistoryPage, isInitial: boolean) => {
      const msgs = pageToMessages(page)
      cursorRef.current = page.hasMore ? page.firstId : null

      if (!isInitial) {
        const s = scrollRef.current
        anchorRef.current = s
          ? { beforeHeight: s.getFreshScrollHeight(), count: msgs.length }
          : null
      }

      const sentinel = page.hasMore ? null : mkSentinel(SENTINEL_START)
      setMessages(prev => {
        // 丢弃现有哨兵（索引 0，已知稳定 UUID —— O(1)）。
        const base =
          prev[0]?.uuid === sentinelUuidRef.current ? prev.slice(1) : prev
        return sentinel ? [sentinel, ...msgs, ...base] : [...msgs, ...base]
      })

      logForDebugging(
        `[useAssistantHistory] ${isInitial ? 'initial' : 'older'} page: ${msgs.length} msgs (raw ${page.events.length}), hasMore=${page.hasMore}`,
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollRef is a stable ref; mkSentinel reads refs only
    [setMessages],
  )

  // 挂载时的初始获取 —— 尽力而为。
  useEffect(() => {
    if (!enabled || !config) return
    let cancelled = false
    void (async () => {
      const ctx = await createHistoryAuthCtx(config.sessionId).catch(() => null)
      if (!ctx || cancelled) return
      ctxRef.current = ctx
      const page = await fetchLatestEvents(ctx)
      if (cancelled || !page) return
      fillBudgetRef.current = MAX_FILL_PAGES
      prepend(page, true)
    })()
    return () => {
      cancelled = true
    }
    // config identity is stable (created once in main.tsx, never recreated)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  const loadOlder = useCallback(async () => {
    if (!enabled || inflightRef.current) return
    const cursor = cursorRef.current
    const ctx = ctxRef.current
    if (!cursor || !ctx) return // null=exhausted, undefined=initial pending
    inflightRef.current = true
    // 将哨兵交换为"加载中…" —— O(1) 切片因为哨兵在索引 0。
    setMessages(prev => {
      const base =
        prev[0]?.uuid === sentinelUuidRef.current ? prev.slice(1) : prev
      return [mkSentinel(SENTINEL_LOADING), ...base]
    })
    try {
      const page = await fetchOlderEvents(ctx, cursor)
      if (!page) {
        // 获取失败 —— 将哨兵恢复到"开始"占位符，以便用户
        // 可以在下次向上滚动时重试。游标被保留（未被清空）。
        setMessages(prev => {
          const base =
            prev[0]?.uuid === sentinelUuidRef.current ? prev.slice(1) : prev
          return [mkSentinel(SENTINEL_LOADING_FAILED), ...base]
        })
        return
      }
      prepend(page, false)
    } finally {
      inflightRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mkSentinel reads refs only
  }, [enabled, prepend, setMessages])

  // 滚动锚补偿 —— 在 React 提交预置项之后，
  // 将 scrollTop 移动高度增量以保持视口位置不变。同时
  // 在这里触发 onPrepend（而不是在 prepend() 中），以便 dividerIndex + 基线 ref
  // 使用实际高度增量移动，而不是估计值。
  // 无依赖：每次渲染都运行；当 anchorRef 为 null 时是无操作。
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (anchor === null) return
    anchorRef.current = null
    const s = scrollRef.current
    if (!s || s.isSticky()) return // sticky = pinned bottom; prepend is invisible
    const delta = s.getFreshScrollHeight() - anchor.beforeHeight
    if (delta > 0) s.scrollBy(delta)
    onPrepend?.(anchor.count, delta)
  })

  // 填充视口链：绘制后，如果内容未超出视口，
  // 加载另一页。作为 useEffect 运行（而非布局效果），以便 Ink 已
  // 绘制且 scrollViewportHeight 已填充。通过下一渲染的效果自链；
  // 预算限制链。
  //
  // ScrollBox 内容包装器具有 flexGrow:1 flexShrink:0 —— 它被限制
  // 为 ≥ 视口。所以 `content < viewport` 永远不为真；`<=` 正确检测
  // "尚未溢出"。一旦有可滚动的内容就停止。
  useEffect(() => {
    if (
      fillBudgetRef.current <= 0 ||
      !cursorRef.current ||
      inflightRef.current
    ) {
      return
    }
    const s = scrollRef.current
    if (!s) return
    const contentH = s.getFreshScrollHeight()
    const viewH = s.getViewportHeight()
    logForDebugging(
      `[useAssistantHistory] fill-check: content=${contentH} viewport=${viewH} budget=${fillBudgetRef.current}`,
    )
    if (contentH <= viewH) {
      fillBudgetRef.current--
      void loadOlder()
    } else {
      fillBudgetRef.current = 0
    }
  })

  // REPL 中 onScroll 组合的触发包装器。
  const maybeLoadOlder = useCallback(
    (handle: ScrollBoxHandle) => {
      if (handle.getScrollTop() < PREFETCH_THRESHOLD_ROWS) void loadOlder()
    },
    [loadOlder],
  )

  return { maybeLoadOlder }
}
