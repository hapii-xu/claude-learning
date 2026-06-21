import type { RefObject } from 'react'
import {
  useCallback,
  useDeferredValue,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { ScrollBoxHandle, DOMElement } from '@anthropic/ink'

/**
 * Estimated height (rows) for items not yet measured. Intentionally LOW:
 * overestimating causes blank space (we stop mounting too early and the
 * viewport bottom shows empty spacer), while underestimating just mounts
 * a few extra items into overscan. The asymmetry means we'd rather err low.
 */
const DEFAULT_ESTIMATE = 3
/**
 * Extra rows rendered above and below the viewport. Generous because real
 * heights can be 10x the estimate for long tool results.
 */
const OVERSCAN_ROWS = 40
/** Items rendered before the ScrollBox has laid out (viewportHeight=0). */
const COLD_START_COUNT = 30
/**
 * scrollTop quantization for the useSyncExternalStore snapshot. Without
 * this, every wheel tick (3-5 per notch) triggers a full React commit +
 * Yoga calculateLayout() + Ink diff cycle — the CPU spike. Visual scroll
 * stays smooth regardless: ScrollBox.forceRender fires on every scrollBy
 * and Ink reads the REAL scrollTop from the DOM node, independent of what
 * React thinks. React only needs to re-render when the mounted range must
 * shift; half of OVERSCAN_ROWS is the tightest safe bin (guarantees ≥40
 * rows of overscan remain before the new range is needed).
 */
const SCROLL_QUANTUM = OVERSCAN_ROWS >> 1
/**
 * Worst-case height assumed for unmeasured items when computing coverage.
 * A MessageRow can be as small as 1 row (single-line tool call). Using 1
 * here guarantees the mounted span physically reaches the viewport bottom
 * regardless of how small items actually are — at the cost of over-mounting
 * when items are larger (which is fine, overscan absorbs it).
 */
const PESSIMISTIC_HEIGHT = 1
/** Cap on mounted items to bound fiber allocation even in degenerate cases. */
const MAX_MOUNTED_ITEMS = 200
/**
 * Max NEW items to mount in a single commit. Scrolling into a fresh range
 * with PESSIMISTIC_HEIGHT=1 would mount 194 items at once (OVERSCAN_ROWS*2+
 * viewportH = 194); each fresh MessageRow render costs ~1.5ms (marked lexer
 * + formatToken + ~11 createInstance) = ~290ms sync block. Sliding the range
 * toward the target over multiple commits keeps per-commit mount cost
 * bounded. The render-time clamp (scrollClampMin/Max) holds the viewport at
 * the edge of mounted content so there's no blank during catch-up.
 */
const SLIDE_STEP = 25

const NOOP_UNSUB = () => {}

export type VirtualScrollResult = {
  /** [startIndex, endIndex) half-open slice of items to render. */
  range: readonly [number, number]
  /** Height (rows) of spacer before the first rendered item. */
  topSpacer: number
  /** Height (rows) of spacer after the last rendered item. */
  bottomSpacer: number
  /**
   * Callback ref factory. Attach `measureRef(itemKey)` to each rendered
   * item's root Box; after Yoga layout, the computed height is cached.
   */
  measureRef: (key: string) => (el: DOMElement | null) => void
  /**
   * Attach to the topSpacer Box. Its Yoga computedTop IS listOrigin
   * (first child of the virtualized region, so its top = cumulative
   * height of everything rendered before the list in the ScrollBox).
   * Drift-free: no subtraction of offsets, no dependence on item
   * heights that change between renders (tmux resize).
   */
  spacerRef: RefObject<DOMElement | null>
  /**
   * Cumulative y-offset of each item in list-wrapper coords (NOT scrollbox
   * coords — logo/siblings before this list shift the origin).
   * offsets[i] = rows above item i; offsets[n] = totalHeight.
   * Recomputed every render — don't memo on identity.
   */
  offsets: ArrayLike<number>
  /**
   * Read Yoga computedTop for item at index. Returns -1 if the item isn't
   * mounted or hasn't been laid out. Item Boxes are direct Yoga children
   * of the ScrollBox content wrapper (fragments collapse in the Ink DOM),
   * so this is content-wrapper-relative — same coordinate space as
   * scrollTop. Yoga layout is scroll-independent (translation happens
   * later in renderNodeToOutput), so positions stay valid across scrolls
   * without waiting for Ink to re-render. StickyTracker walks the mount
   * range with this to find the viewport boundary at per-scroll-tick
   * granularity (finer than the 40-row quantum this hook re-renders at).
   */
  getItemTop: (index: number) => number
  /**
   * Get the mounted DOMElement for item at index, or null. For
   * ScrollBox.scrollToElement — anchoring by element ref defers the
   * Yoga-position read to render time (deterministic; no throttle race).
   */
  getItemElement: (index: number) => DOMElement | null
  /** Measured Yoga height. undefined = not yet measured; 0 = rendered nothing. */
  getItemHeight: (index: number) => number | undefined
  /**
   * Scroll so item `i` is in the mounted range. Sets scrollTop =
   * offsets[i] + listOrigin. The range logic finds start from
   * scrollTop vs offsets[] — BOTH use the same offsets value, so they
   * agree by construction regardless of whether offsets[i] is the
   * "true" position. Item i mounts; its screen position may be off by
   * a few-dozen rows (overscan-worth of estimate drift), but it's in
   * the DOM. Follow with getItemTop(i) for the precise position.
   */
  scrollToIndex: (i: number) => void
}

/**
 * React-level virtualization for items inside a ScrollBox.
 *
 * The ScrollBox already does Ink-output-level viewport culling
 * (render-node-to-output.ts:617 skips children outside the visible window),
 * but all React fibers + Yoga nodes are still allocated. At ~250 KB RSS per
 * MessageRow, a 1000-message session costs ~250 MB of grow-only memory
 * (Ink screen buffer, WASM linear memory, JSC page retention all grow-only).
 *
 * This hook mounts only items in viewport + overscan. Spacer boxes hold the
 * scroll height constant for the rest at O(1) fiber cost each.
 *
 * Height estimation: fixed DEFAULT_ESTIMATE for unmeasured items, replaced
 * by real Yoga heights after first layout. No scroll anchoring — overscan
 * absorbs estimate errors. If drift is noticeable in practice, anchoring
 * (scrollBy(delta) when topSpacer changes) is a straightforward followup.
 *
 * stickyScroll caveat: render-node-to-output.ts:450 sets scrollTop=maxScroll
 * during Ink's render phase, which does NOT fire ScrollBox.subscribe. The
 * at-bottom check below handles this — when pinned to the bottom, we render
 * the last N items regardless of what scrollTop claims.
 */
export function useVirtualScroll(
  scrollRef: RefObject<ScrollBoxHandle | null>,
  itemKeys: readonly string[],
  /**
   * Terminal column count. On change, cached heights are stale (text
   * rewraps) — SCALED by oldCols/newCols rather than cleared. Clearing
   * made the pessimistic coverage back-walk mount ~190 items (every
   * uncached item → PESSIMISTIC_HEIGHT=1 → walk 190 to reach
   * viewport+2×overscan). Each fresh mount runs marked.lexer + syntax
   * highlighting ≈ 3ms; ~600ms React reconcile on first resize with a
   * long conversation. Scaling keeps heightCache populated → back-walk
   * uses real-ish heights → mount range stays tight. Scaled estimates
   * are overwritten by real Yoga heights on next useLayoutEffect.
   *
   * Scaled heights are close enough that the black-screen-on-widen bug
   * (inflated pre-resize offsets overshoot post-resize scrollTop → end
   * loop stops short of tail) doesn't trigger: ratio<1 on widen scales
   * heights DOWN, keeping offsets roughly aligned with post-resize Yoga.
   */
  columns: number,
): VirtualScrollResult {
  const heightCache = useRef(new Map<string, number>())
  // 每当 heightCache 变化时递增，以便 offsets 在下次读取时重建。Ref
  //（不是 state）—— 在渲染阶段检查，零额外提交。
  const offsetVersionRef = useRef(0)
  // 上次提交时的 scrollTop，用于检测快速滚动模式（滑动上限门控）。
  const lastScrollTopRef = useRef(0)
  const offsetsRef = useRef<{ arr: Float64Array; version: number; n: number }>({
    arr: new Float64Array(0),
    version: -1,
    n: -1,
  })
  const itemRefs = useRef(new Map<string, DOMElement>())
  const refCache = useRef(new Map<string, (el: DOMElement | null) => void>())
  // 内联 ref 比较：必须在下方 offsets 计算之前运行。
  // skip 标志保护 useLayoutEffect 不被重新填充
  // 调整大小之前的 Yoga 高度（useLayoutEffect 从此渲染的
  // calculateLayout 之前的帧读取 Yoga —— 那个帧有旧宽度）。
  // 下次渲染的 useLayoutEffect 读取调整大小后的 Yoga → 正确。
  const prevColumns = useRef(columns)
  const skipMeasurementRef = useRef(false)
  // 为调整大小稳定周期冻结挂载范围。已挂载的
  // 项有温暖的 useMemo（marked.lexer、高亮）；从缩放/悲观估计重新计算范围
  // 会导致挂载/卸载抖动（每个新挂载约 3ms
  // = 约 150ms 表现为第二次闪烁）。调整大小前的范围与
  // 任何范围一样好 —— 在旧宽度下可见的项就是用户在新
  // 宽度下想要的。冻结 2 次渲染：渲染 #1 有 skipMeasurement（Yoga
  // 仍为调整前），渲染 #2 的 useLayoutEffect 读取调整后的 Yoga
  // 到 heightCache。渲染 #3 有准确高度 → 正常重新计算。
  const prevRangeRef = useRef<readonly [number, number] | null>(null)
  const freezeRendersRef = useRef(0)
  if (prevColumns.current !== columns) {
    const ratio = prevColumns.current / columns
    prevColumns.current = columns
    for (const [k, h] of heightCache.current) {
      heightCache.current.set(k, Math.max(1, Math.round(h * ratio)))
    }
    offsetVersionRef.current++
    skipMeasurementRef.current = true
    freezeRendersRef.current = 2
  }
  const frozenRange = freezeRendersRef.current > 0 ? prevRangeRef.current : null
  // content-wrapper 坐标中的列表原点。scrollTop 是 content-wrapper
  // 相对的，但 offsets[] 是列表局部的（0 = 第一个虚拟化项）。
  // 在 ScrollBox 内此列表之前渲染的兄弟元素 —— Logo、
  // StatusNotices、Messages.tsx 中的截断分隔符 —— 通过其累积高度
  // 偏移项的 Yoga 位置。不扣除这个的话，
  // 非 sticky 分支的 effLo/effHi 会被夸大，并且 start 推进
  // 超过实际在视图中的项（当 scrollTop 接近最大值时 sticky
  // 断裂，点击/滚动时会出现空白视口）。从 topSpacer 的
  // Yoga computedTop 读取 —— 它是虚拟化区域的第一个子元素，所以
  // 它的 top 就是 listOrigin。不扣除 offsets → 当项高度在渲染之间
  // 变化时不会漂移（tmux 调整大小：列变化 → 重新换行
  // → 高度缩小 → 旧的项采样扣除变为负数 →
  // effLo 夸大 → 黑屏）。像 heightCache 一样有一帧延迟。
  const listOriginRef = useRef(0)
  const spacerRef = useRef<DOMElement | null>(null)

  // useSyncExternalStore 将重新渲染与命令式滚动绑定。快照是
  // 量化到 SCROLL_QUANTUM bin 的 scrollTop —— 对于小滚动
  //（大多数滚轮滴答）Object.is 看不到变化，所以 React 完全
  // 跳过提交 + Yoga + Ink 周期，直到累积增量越过 bin。
  // Sticky 被折叠进快照（符号位），所以 sticky→broken 也
  // 触发：scrollToBottom 设置 sticky=true 而不移动 scrollTop
  //（Ink 稍后移动它），之后的第一次 scrollBy 可能落在
  // 同一个 bin。NaN 哨兵 = ref 未附加。
  const subscribe = useCallback(
    (listener: () => void) =>
      scrollRef.current?.subscribe(listener) ?? NOOP_UNSUB,
    [scrollRef],
  )
  useSyncExternalStore(subscribe, () => {
    const s = scrollRef.current
    if (!s) return NaN
    // 快照使用 TARGET（scrollTop + pendingDelta），而不是已提交的
    // scrollTop。scrollBy 只修改 pendingDelta（渲染器跨帧
    // 排空它）；已提交的 scrollTop 滞后。使用 target 意味着
    // scrollBy 上的 notify() 实际改变了快照 → React 在 Ink 的排空帧
    // 需要它们之前为目的地重新挂载子元素。
    const target = s.getScrollTop() + s.getPendingDelta()
    const bin = Math.floor(target / SCROLL_QUANTUM)
    return s.isSticky() ? ~bin : bin
  })
  // 为范围计算读取真实的已提交 scrollTop（未量化）——
  // 量化只是重新渲染门控，不是位置。
  const scrollTop = scrollRef.current?.getScrollTop() ?? -1
  // 范围必须跨越已提交的 scrollTop（Ink 当前正在渲染的位置）
  // 和 target（pending 将排空到的位置）。在排空期间，中间
  // 帧在两者之间的 scrollTop 渲染 —— 如果我们只为
  // target 挂载，那些帧找不到子元素（空白行）。
  const pendingDelta = scrollRef.current?.getPendingDelta() ?? 0
  const viewportH = scrollRef.current?.getViewportHeight() ?? 0
  // true 表示 ScrollBox 固定在底部。这是唯一稳定的
  // "在底部"信号：scrollTop/scrollHeight 都反映
  // 上一次渲染的布局，这取决于我们渲染了什么（topSpacer +
  // items），创建了反馈循环（范围 → 布局 → atBottom → 范围）。
  // stickyScroll 由用户动作（scrollToBottom/scrollBy）、初始
  // 属性设置，以及 render-node-to-output 在其位置跟随触发时
  //（scrollTop>=prevMax → 固定到新最大值 → 设置标志）。渲染器写入是
  // 反馈安全的：它只在 false→true 翻转，仅当已经在
  // 位置底部时，并且此处标志为 true 只意味着"尾部行走、
  // 清除钳制" —— 与我们直接读取 scrollTop==maxScroll
  // 相同的行为，减去不稳定性。默认为 true：在 ref 附加之前，
  // 假设在底部（sticky 会在第一次 Ink 渲染时将我们固定在那里）。
  const isSticky = scrollRef.current?.isSticky() ?? true

  // GC 陈旧的缓存条目（压缩、/clear、screenToggleId 更新）。仅在
  // itemKeys 标识变化时运行 —— 滚动不会触及键。
  // itemRefs 通过卸载时的 ref(null) 自我清理。
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable
  useMemo(() => {
    const live = new Set(itemKeys)
    let dirty = false
    for (const k of heightCache.current.keys()) {
      if (!live.has(k)) {
        heightCache.current.delete(k)
        dirty = true
      }
    }
    for (const k of refCache.current.keys()) {
      if (!live.has(k)) refCache.current.delete(k)
    }
    if (dirty) offsetVersionRef.current++
  }, [itemKeys])

  // 跨渲染缓存的 offsets，通过 offsetVersion ref 递增失效。
  // 之前的方法分配了新的 Array(n+1) 并在每次渲染时运行 n 次 Map.get；
  // 对于按键重复滚动速率（约 11 次提交/秒）下 n≈27k，那是
  // 在新分配数组上的约 30 万次查找/秒 → GC 抖动 + 约 2ms/渲染。
  // 版本由 heightCache 写入器递增（measureRef、resize-scale、GC）。
  // 没有 setState —— 重建通过渲染期间的 ref 版本检查
  // 在读取侧延迟进行（同一提交，零额外调度）。强制
  // 内联重新计算的闪烁来自 setState 驱动的失效。
  const n = itemKeys.length
  if (
    offsetsRef.current.version !== offsetVersionRef.current ||
    offsetsRef.current.n !== n
  ) {
    const arr =
      offsetsRef.current.arr.length >= n + 1
        ? offsetsRef.current.arr
        : new Float64Array(n + 1)
    arr[0] = 0
    for (let i = 0; i < n; i++) {
      arr[i + 1] =
        arr[i]! + (heightCache.current.get(itemKeys[i]!) ?? DEFAULT_ESTIMATE)
    }
    offsetsRef.current = { arr, version: offsetVersionRef.current, n }
  }
  const offsets = offsetsRef.current.arr
  const totalHeight = offsets[n]!

  let start: number
  let end: number

  if (frozenRange) {
    // 列刚变化。保持调整大小前的范围以避免挂载抖动。
    // 钳制到 n，以防消息被移除（/clear、压缩）。
    ;[start, end] = frozenRange
    start = Math.min(start, n)
    end = Math.min(end, n)
  } else if (viewportH === 0 || scrollTop < 0) {
    // 冷启动：ScrollBox 尚未布局。渲染尾部 —— sticky
    // scroll 在第一次 Ink 渲染时固定到底部，所以这些是用户
    // 实际看到的项。之后的任何向上滚动通过
    // scrollBy → subscribe 触发 → 我们用真实值重新渲染。
    start = Math.max(0, n - COLD_START_COUNT)
    end = n
  } else {
    if (isSticky) {
      // Sticky-scroll 回退。render-node-to-output 可能在没有通知我们的情况下
      // 移动了 scrollTop，所以信任"在底部"而不是陈旧的快照。
      // 从尾部向后走，直到覆盖视口 + overscan。
      const budget = viewportH + OVERSCAN_ROWS
      start = n
      while (start > 0 && totalHeight - offsets[start - 1]! < budget) {
        start--
      }
      end = n
    } else {
      // 用户已向上滚动。从 offsets 计算 start（基于估计：
      // 可能下溢，这没关系 —— 我们只是提前一点开始挂载）。
      // 然后按累计的最佳已知高度扩展 end，而不是估计的
      // offsets。不变量是：
      //   topSpacer + sum(real_heights[start..end]) >= scrollTop + viewportH + overscan
      // 由于 topSpacer = offsets[start] ≤ scrollTop - overscan，我们需要：
      //   sum(real_heights) >= viewportH + 2*overscan
      // 对于未测量的项，假设 PESSIMISTIC_HEIGHT=1 —— MessageRow 可以
      // 是的最小值。这在项很大时会过度挂载，但永远不会
      // 让视口在通过未测量区域快速滚动时显示空白的 spacer。
      // 一旦高度被缓存（下一次渲染），覆盖率用真实值
      // 计算并且范围收紧。
      // 仅当 K 可以安全折叠到 topSpacer 而不会可见跳变时
      // 才推进 start 越过项 K。两种情况是安全的：
      //   (a) K 当前未挂载（itemRefs 没有条目）。它对
      //       offsets 的贡献始终是估计值 ——
      //       spacer 已经匹配了那里曾经有的东西。没有布局变化。
      //   (b) K 已挂载且其高度已缓存。offsets[start+1] 使用
      //       真实高度，所以 topSpacer = offsets[start+1] 恰好
      //       等于 K 占据的 Yoga 跨度。无缝卸载。
      // 不安全的情况 —— K 已挂载但未缓存 —— 是挂载和
      // useLayoutEffect 测量之间的一渲染窗口。让 K
      // 多挂载一渲染可以让测量落地。
      // 挂载范围跨越 [committed, target]，以便每个排空帧都被
      // 覆盖。在 0 处钳制：激进向上滚轮可以将 pendingDelta
      // 推过零（MX Master 自由旋转），但 scrollTop 永远不会
      // 变为负数。没有钳制的话，effLo 将 start 拖到 0，而 effHi
      // 停留在当前（高）scrollTop —— 跨度超过 MAX_MOUNTED_ITEMS
      // 可以覆盖的范围，早期排空帧看到空白。
      // listOrigin 在与 offsets[] 比较之前将 scrollTop（content-wrapper 坐标）
      // 转换为列表局部坐标。没有
      // 这个，列表前的兄弟元素（Messages.tsx 中的 Logo+notices）通过其
      // 高度夸大 scrollTop 并且 start 过度推进 —— 先吃掉 overscan，
      // 然后一旦夸大超过 OVERSCAN_ROWS 就吃掉可见行。
      const listOrigin = listOriginRef.current
      // 钳制 [committed..target] 跨度。当输入超过渲染时，
      // pendingDelta 无界增长 → effLo..effHi 覆盖数百个
      // 未挂载的行 → 一次提交挂载 194 个新的 MessageRows → 3 秒+
      // 同步块 → 更多输入排队 → 下次增量更大。死亡
      // 螺旋。钳制跨度限制每次提交的新挂载；
      // clamp（setClampBounds）在追赶期间显示挂载边缘，所以
      // 没有空白屏幕 —— 滚动在几帧内到达 target，
      // 而不是一次冻结数秒。
      const MAX_SPAN_ROWS = viewportH * 3
      const rawLo = Math.min(scrollTop, scrollTop + pendingDelta)
      const rawHi = Math.max(scrollTop, scrollTop + pendingDelta)
      const span = rawHi - rawLo
      const clampedLo =
        span > MAX_SPAN_ROWS
          ? pendingDelta < 0
            ? rawHi - MAX_SPAN_ROWS // scrolling up: keep near target (low end)
            : rawLo // scrolling down: keep near committed
          : rawLo
      const clampedHi = clampedLo + Math.min(span, MAX_SPAN_ROWS)
      const effLo = Math.max(0, clampedLo - listOrigin)
      const effHi = clampedHi - listOrigin
      const lo = effLo - OVERSCAN_ROWS
      // 对 start 进行二分搜索 —— offsets 是单调递增的。
      // 线性 while(start++) 扫描对 27k 消息会话
      //（从底部滚动，start≈27200）每次渲染迭代约 27k 次。O(log n)。
      {
        let l = 0
        let r = n
        while (l < r) {
          const m = (l + r) >> 1
          if (offsets[m + 1]! <= lo) l = m + 1
          else r = m
        }
        start = l
      }
      // 守卫：不要推进超过已挂载但未测量的项。在
      // 挂载和 useLayoutEffect 测量之间的一渲染窗口期间，
      // 卸载此类项会在 topSpacer 中使用 DEFAULT_ESTIMATE，
      // 这不匹配它们的（未知）真实跨度 → 闪烁。已挂载
      // 的项在 [prevStart, prevEnd) 中；扫描那个，而不是全部 n。
      {
        const p = prevRangeRef.current
        if (p && p[0] < start) {
          for (let i = p[0]; i < Math.min(start, p[1]); i++) {
            const k = itemKeys[i]!
            if (itemRefs.current.has(k) && !heightCache.current.has(k)) {
              start = i
              break
            }
          }
        }
      }

      const needed = viewportH + 2 * OVERSCAN_ROWS
      const maxEnd = Math.min(n, start + MAX_MOUNTED_ITEMS)
      let coverage = 0
      end = start
      while (
        end < maxEnd &&
        (coverage < needed || offsets[end]! < effHi + viewportH + OVERSCAN_ROWS)
      ) {
        coverage +=
          heightCache.current.get(itemKeys[end]!) ?? PESSIMISTIC_HEIGHT
        end++
      }
    }
    // 对 atBottom 路径的相同覆盖保证（它通过估计的
    // offsets 向后走了 start，如果项很小可能会下溢）。
    const needed = viewportH + 2 * OVERSCAN_ROWS
    const minStart = Math.max(0, end - MAX_MOUNTED_ITEMS)
    let coverage = 0
    for (let i = start; i < end; i++) {
      coverage += heightCache.current.get(itemKeys[i]!) ?? PESSIMISTIC_HEIGHT
    }
    while (start > minStart && coverage < needed) {
      start--
      coverage +=
        heightCache.current.get(itemKeys[start]!) ?? PESSIMISTIC_HEIGHT
    }
    // 滑动上限：限制此提交挂载多少新项。滚动进入
    // 新范围否则会以 PESSIMISTIC_HEIGHT=1 覆盖挂载 194 个项
    // —— 约 290ms React 渲染块。门控滚动速度
    //（|自上次提交以来的 scrollTop 增量| > 2×viewportH —— 按键重复 PageUp
    // 每次按下移动约 viewportH/2，3+ 次批量按下 = 快速模式）。覆盖
    // scrollBy（pendingDelta）和 scrollTo（直接写入）。普通
    // 单 PageUp 或 sticky-break 跳跃跳过这个。clamp
    //（setClampBounds）在追赶期间将视口保持在挂载边缘。
    // 只钳制范围增长；收缩是无界的。
    const prev = prevRangeRef.current
    const scrollVelocity =
      Math.abs(scrollTop - lastScrollTopRef.current) + Math.abs(pendingDelta)
    if (prev && scrollVelocity > viewportH * 2) {
      const [pS, pE] = prev
      if (start < pS - SLIDE_STEP) start = pS - SLIDE_STEP
      if (end > pE + SLIDE_STEP) end = pE + SLIDE_STEP
      // 大向前跳跃可以将 start 推过钳制的 end（start
      // 通过二分搜索推进，而 end 钳制在 pE + SLIDE_STEP）。
      // 从新 start 挂载 SLIDE_STEP 个项，以便视口在
      // 追赶期间不是空白。
      if (start > end) end = Math.min(start + SLIDE_STEP, n)
    }
    lastScrollTopRef.current = scrollTop
  }

  // 在范围计算后递减 freeze。冻结期间不要更新 prevRangeRef，
  // 以便两个冻结渲染都重用原始的调整大小前
  // 范围（而不是如果消息在冻结期间变化的钳制到 n 的版本）。
  if (freezeRendersRef.current > 0) {
    freezeRendersRef.current--
  } else {
    prevRangeRef.current = [start, end]
  }
  // useDeferredValue 让 React 先用 OLD 范围渲染（便宜 ——
  // 全部 memo 命中）然后过渡到 NEW 范围（昂贵 —— 带 marked.lexer
  // + formatToken 的新挂载）。紧急渲染让 Ink
  // 以输入速率绘制；新挂载在非阻塞的
  // 后台渲染中发生。这是 React 原生的时间切片：62ms 的
  // 新挂载块变为可中断。clamp（setClampBounds）
  // 已经处理了视口固定，所以延迟范围
  // 短暂滞后于 scrollTop 不会有视觉伪影。
  //
  // 只延迟范围增长（start 更早移动 / end 更晚移动会增加
  // 新挂载）。收缩是便宜的（卸载 = 移除 fiber，无解析），
  // 延迟值滞后收缩导致陈旧 overscan 保持
  // 挂载一个额外的 tick —— 无害但会失败检查测量驱动收紧后
  // 精确范围的测试。
  const dStart = useDeferredValue(start)
  const dEnd = useDeferredValue(end)
  let effStart = start < dStart ? dStart : start
  let effEnd = end > dEnd ? dEnd : end
  // 大跳跃可以使 effStart > effEnd（start 向前跳，而 dEnd
  // 仍然保持旧范围的 end）。跳过延迟以避免倒置
  // 范围。sticky 时也跳过 —— scrollToBottom 需要尾部立即
  // 挂载，以便 scrollTop=maxScroll 落在内容上，而不是 bottomSpacer。
  // 延迟的 dEnd（仍在旧范围）会渲染不完整的尾部，
  // maxScroll 保持在旧的内容高度，"跳到底部"提前
  // 停止。Sticky 吸附是单帧，不是连续滚动 ——
  // 时间切片的好处不适用。
  if (effStart > effEnd || isSticky) {
    effStart = start
    effEnd = end
  }
  // 向下滚动（pendingDelta > 0）：绕过 effEnd 延迟以便尾部
  // 立即挂载。没有这个，clamp（基于 effEnd）将
  // scrollTop 保持在真实底部之前 —— 用户向下滚动，撞到 clampMax，
  // 停止，React 追上 effEnd，clampMax 扩大，但用户已经
  // 释放了。感觉卡在底部之前。effStart 保持延迟以便
  // 向上滚动保留时间切片（较旧的消息在挂载时解析 ——
  // 昂贵的方向）。
  if (pendingDelta > 0) {
    effEnd = end
  }
  // 最终的 O(viewport) 强制。中间的上限（maxEnd=start+
  // MAX_MOUNTED_ITEMS、滑动上限、deferred-intersection）限制 [start,end]，
  // 但上方的延迟+绕过组合可以让 [effStart,effEnd]
  // 滑动：例如，在持续 PageUp 期间，当并发模式在提交间
  // 交错 dStart 更新与 effEnd=end 绕过时，有效
  // 窗口可以漂移得比单独立即或延迟更宽。在
  // 10K 行的恢复会话上，这在 PageUp 垃圾滚动期间表现为 +270MB RSS
  //（yoga Node 构造函数 + createWorkInProgress fiber 分配与
  // 滚动距离成比例）。修剪远端边缘 —— 按视口位置 —— 以保持
  // fiber 计数 O(viewport)，无论延迟值调度如何。
  if (effEnd - effStart > MAX_MOUNTED_ITEMS) {
    // 修剪哪一端由视口位置决定，而不是 pendingDelta 方向。
    // pendingDelta 在帧之间排空到 0，而 dStart/dEnd 在
    // 并发调度下滞后；基于方向的修剪然后在稳定中途从"修剪
    // 尾部"翻转到"修剪头部"，颠簸 effStart → effTopSpacer →
    // clampMin → setClampBounds 将 scrollTop 往下拉 → 回滚消失。
    // 基于位置：保留视口更接近的任何一端。
    const mid = (offsets[effStart]! + offsets[effEnd]!) / 2
    if (scrollTop - listOriginRef.current < mid) {
      effEnd = effStart + MAX_MOUNTED_ITEMS
    } else {
      effStart = effEnd - MAX_MOUNTED_ITEMS
    }
  }

  // 在 layout effect 中写入渲染时 clamp 边界（而不是在渲染期间 ——
  // 在 React 渲染期间修改 DOM 违反纯度）。render-node-to-output
  // 将 scrollTop 钳制到此跨度，以便超过 React 异步重新渲染的
  // 突发 scrollTo 调用显示挂载内容的边缘（最后一个/第一个
  // 可见消息），而不是空白 spacer。
  //
  // Clamp 必须使用 EFFECTIVE（延迟）范围，而不是立即范围。
  // 在快速滚动期间，立即 [start,end] 可能已经覆盖了新的
  // scrollTop 位置，但子元素仍在延迟的
  //（较旧）范围渲染。如果 clamp 使用立即边界，render-node-to-output 中的
  // 排空门控看到 scrollTop 在 clamp 内 → 排空超过
  // 延迟子元素的跨度 → 视口落在 spacer 中 → 白色闪烁。
  // 使用 effStart/effEnd 保持 clamp 与实际挂载的内容同步。
  //
  // sticky 时跳过 clamp —— render-node-to-output 权威地固定 scrollTop=maxScroll。
  // 在冷启动/加载期间钳制会导致闪烁：第一次
  // 渲染使用基于估计的 offsets，clamp 设置，sticky-follow 移动
  // scrollTop，测量触发，offsets 用真实高度重建，第二次
  // 渲染的 clamp 不同 → scrollTop clamp 调整 → 内容偏移。
  const listOrigin = listOriginRef.current
  const effTopSpacer = offsets[effStart]!
  // 在 effStart=0 时，上方没有未挂载的内容 —— clamp 必须允许
  // 滚动越过 listOrigin 以查看位于 ScrollBox 中但
  // VirtualMessageList 之外的列表前内容（logo、header）。只在
  // topSpacer 非零时（上方确实有未挂载项）钳制。
  const clampMin = effStart === 0 ? 0 : effTopSpacer + listOrigin
  // 在 effEnd=n 时没有 bottomSpacer —— 没有什么需要避免越过的。在此处
  // 使用 offsets[n] 会把 heightCache 固化（比 Yoga 落后一渲染），并且
  // 当尾部项正在 STREAMING 时，其缓存高度比真实高度滞后自上次
  // 测量以来到达的量。Sticky-break 然后将
  // scrollTop 钳制在真实最大值之下，将流式文本推到视口之外
  //（"向上滚动，响应消失"bug）。Infinity = 无界：
  // render-node-to-output 自己的 Math.min(cur, maxScroll) 取代管理。
  const clampMax =
    effEnd === n
      ? Infinity
      : Math.max(effTopSpacer, offsets[effEnd]! - viewportH) + listOrigin
  useLayoutEffect(() => {
    if (isSticky) {
      scrollRef.current?.setClampBounds(undefined, undefined)
    } else {
      scrollRef.current?.setClampBounds(clampMin, clampMax)
    }
  })

  // 从上一次 Ink 渲染测量高度。每次提交都运行（无
  // 依赖），因为 Yoga 在 React 不知道的情况下重新计算布局。
  // 已挂载 ≥1 帧的项的 yogaNode 高度是有效的；全新的项
  // 尚未布局（那发生在 resetAfterCommit → onRender，
  // 在此 effect 之后）。
  //
  // 区分"h=0：Yoga 尚未运行"（瞬态，跳过）和"h=0：
  // MessageRow 渲染了 null"（永久，缓存它）：getComputedWidth() > 0
  // 证明 Yoga 已布局此节点（宽度来自容器，
  // 对于列中的 Box 始终非零）。如果宽度已设置且高度为
  // 0，则该项确实为空 —— 缓存 0 以便 start 推进门控
  // 不会永远阻塞在它上面。没有这个，在 start 边界处的
  // null 渲染消息会冻结范围（表现为
  // 向上滚动后向下滚动时的空白视口）。
  //
  // 没有 setState。此处的 setState 会用偏移的 offsets 调度第二次提交，
  // 并且由于 Ink 在每次提交时写入 stdout
  //（reconciler.resetAfterCommit → onRender），那是两次具有
  // 不同 spacer 高度的写入 → 可见闪烁。高度在
  // 下一次自然渲染时传播到 offsets。一帧延迟，由 overscan 吸收。
  useLayoutEffect(() => {
    const spacerYoga = spacerRef.current?.yogaNode
    if (spacerYoga && spacerYoga.getComputedWidth() > 0) {
      listOriginRef.current = spacerYoga.getComputedTop()
    }
    if (skipMeasurementRef.current) {
      skipMeasurementRef.current = false
      return
    }
    let anyChanged = false
    for (const [key, el] of itemRefs.current) {
      const yoga = el.yogaNode
      if (!yoga) continue
      const h = yoga.getComputedHeight()
      const prev = heightCache.current.get(key)
      if (h > 0) {
        if (prev !== h) {
          heightCache.current.set(key, h)
          anyChanged = true
        }
      } else if (yoga.getComputedWidth() > 0 && prev !== 0) {
        heightCache.current.set(key, 0)
        anyChanged = true
      }
    }
    if (anyChanged) offsetVersionRef.current++
  })

  // 每个 key 的稳定回调 ref。React 的 ref 交换舞蹈（old(null) 然后
  // new(el)）在回调身份稳定时是无操作的，避免
  // 每次渲染时的 itemRefs 抖动。随上方的 heightCache 一起 GC。
  // ref(null) 路径也在卸载时捕获高度 —— yogaNode
  // 在那时仍然有效（reconciler 在 removeChild →
  // freeRecursive 之前调用 ref(null)），所以我们在 WASM 释放之前获得最终测量。
  const measureRef = useCallback((key: string) => {
    let fn = refCache.current.get(key)
    if (!fn) {
      fn = (el: DOMElement | null) => {
        if (el) {
          itemRefs.current.set(key, el)
        } else {
          const yoga = itemRefs.current.get(key)?.yogaNode
          if (yoga && !skipMeasurementRef.current) {
            const h = yoga.getComputedHeight()
            if (
              (h > 0 || yoga.getComputedWidth() > 0) &&
              heightCache.current.get(key) !== h
            ) {
              heightCache.current.set(key, h)
              offsetVersionRef.current++
            }
          }
          itemRefs.current.delete(key)
        }
      }
      refCache.current.set(key, fn)
    }
    return fn
  }, [])

  const getItemTop = useCallback(
    (index: number) => {
      const yoga = itemRefs.current.get(itemKeys[index]!)?.yogaNode
      if (!yoga || yoga.getComputedWidth() === 0) return -1
      return yoga.getComputedTop()
    },
    [itemKeys],
  )

  const getItemElement = useCallback(
    (index: number) => itemRefs.current.get(itemKeys[index]!) ?? null,
    [itemKeys],
  )
  const getItemHeight = useCallback(
    (index: number) => heightCache.current.get(itemKeys[index]!),
    [itemKeys],
  )
  const scrollToIndex = useCallback(
    (i: number) => {
      // offsetsRef.current 保存最新的缓存 offsets（事件处理程序在
      // 渲染之间运行；渲染时闭包会陈旧）。
      const o = offsetsRef.current
      if (i < 0 || i >= o.n) return
      scrollRef.current?.scrollTo(o.arr[i]! + listOriginRef.current)
    },
    [scrollRef],
  )

  const effBottomSpacer = totalHeight - offsets[effEnd]!

  return {
    range: [effStart, effEnd],
    topSpacer: effTopSpacer,
    bottomSpacer: effBottomSpacer,
    measureRef,
    spacerRef,
    offsets,
    getItemTop,
    getItemElement,
    getItemHeight,
    scrollToIndex,
  }
}
