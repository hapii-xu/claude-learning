import { useCallback, useMemo, useRef } from 'react'

const DEFAULT_MAX_VISIBLE = 5

type UsePaginationOptions = {
  totalItems: number
  maxVisible?: number
  selectedIndex?: number
}

type UsePaginationResult<T> = {
  // 为了与基于页码的术语保持向后兼容
  currentPage: number
  totalPages: number
  startIndex: number
  endIndex: number
  needsPagination: boolean
  pageSize: number
  // 获取可见的项切片
  getVisibleItems: (items: T[]) => T[]
  // 将可见索引转换为实际索引
  toActualIndex: (visibleIndex: number) => number
  // 检查实际索引是否可见
  isOnCurrentPage: (actualIndex: number) => boolean
  // 导航（为了 API 兼容性而保留）
  goToPage: (page: number) => void
  nextPage: () => void
  prevPage: () => void
  // 处理选择 —— 仅更新索引，滚动是自动的
  handleSelectionChange: (
    newIndex: number,
    setSelectedIndex: (index: number) => void,
  ) => void
  // 页面导航 —— 连续滚动时返回 false（不需要）
  handlePageNavigation: (
    direction: 'left' | 'right',
    setSelectedIndex: (index: number) => void,
  ) => boolean
  // 用于 UI 展示的滚动位置信息
  scrollPosition: {
    current: number
    total: number
    canScrollUp: boolean
    canScrollDown: boolean
  }
}

export function usePagination<T>({
  totalItems,
  maxVisible = DEFAULT_MAX_VISIBLE,
  selectedIndex = 0,
}: UsePaginationOptions): UsePaginationResult<T> {
  const needsPagination = totalItems > maxVisible

  // 使用 ref 跟踪上一次的滚动偏移，以实现平滑滚动
  const scrollOffsetRef = useRef(0)

  // 基于 selectedIndex 计算滚动偏移
  // 这确保了被选中的项总是可见
  const scrollOffset = useMemo(() => {
    if (!needsPagination) return 0

    const prevOffset = scrollOffsetRef.current

    // 如果选中项在可见窗口之上，向上滚动
    if (selectedIndex < prevOffset) {
      scrollOffsetRef.current = selectedIndex
      return selectedIndex
    }

    // 如果选中项在可见窗口之下，向下滚动
    if (selectedIndex >= prevOffset + maxVisible) {
      const newOffset = selectedIndex - maxVisible + 1
      scrollOffsetRef.current = newOffset
      return newOffset
    }

    // 选中项在可见窗口内，保持当前偏移
    // 但要确保偏移仍然有效
    const maxOffset = Math.max(0, totalItems - maxVisible)
    const clampedOffset = Math.min(prevOffset, maxOffset)
    scrollOffsetRef.current = clampedOffset
    return clampedOffset
  }, [selectedIndex, maxVisible, needsPagination, totalItems])

  const startIndex = scrollOffset
  const endIndex = Math.min(scrollOffset + maxVisible, totalItems)

  const getVisibleItems = useCallback(
    (items: T[]): T[] => {
      if (!needsPagination) return items
      return items.slice(startIndex, endIndex)
    },
    [needsPagination, startIndex, endIndex],
  )

  const toActualIndex = useCallback(
    (visibleIndex: number): number => {
      return startIndex + visibleIndex
    },
    [startIndex],
  )

  const isOnCurrentPage = useCallback(
    (actualIndex: number): boolean => {
      return actualIndex >= startIndex && actualIndex < endIndex
    },
    [startIndex, endIndex],
  )

  // 这些在连续滚动时基本是 no-op，但为了 API 兼容性而保留
  const goToPage = useCallback((_page: number) => {
    // No-op —— 滚动由 selectedIndex 控制
  }, [])

  const nextPage = useCallback(() => {
    // No-op —— 滚动由 selectedIndex 控制
  }, [])

  const prevPage = useCallback(() => {
    // No-op —— 滚动由 selectedIndex 控制
  }, [])

  // 简单的选择处理器 —— 只更新索引
  // 滚动通过上面的 useMemo 自动发生
  const handleSelectionChange = useCallback(
    (newIndex: number, setSelectedIndex: (index: number) => void) => {
      const clampedIndex = Math.max(0, Math.min(newIndex, totalItems - 1))
      setSelectedIndex(clampedIndex)
    },
    [totalItems],
  )

  // 页面导航 —— 连续滚动时禁用
  const handlePageNavigation = useCallback(
    (
      _direction: 'left' | 'right',
      _setSelectedIndex: (index: number) => void,
    ): boolean => {
      return false
    },
    [],
  )

  // 为向后兼容计算类页码值
  const totalPages = Math.max(1, Math.ceil(totalItems / maxVisible))
  const currentPage = Math.floor(scrollOffset / maxVisible)

  return {
    currentPage,
    totalPages,
    startIndex,
    endIndex,
    needsPagination,
    pageSize: maxVisible,
    getVisibleItems,
    toActualIndex,
    isOnCurrentPage,
    goToPage,
    nextPage,
    prevPage,
    handleSelectionChange,
    handlePageNavigation,
    scrollPosition: {
      current: selectedIndex + 1,
      total: totalItems,
      canScrollUp: scrollOffset > 0,
      canScrollDown: scrollOffset + maxVisible < totalItems,
    },
  }
}
