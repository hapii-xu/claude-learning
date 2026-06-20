import { createContext, type RefObject, useContext } from 'react';
import type { ScrollBoxHandle } from '@anthropic/ink';

/**
 * 在 FullscreenLayout 的 `modal` 插槽中渲染内容时设置——
 * 用于斜杠命令对话框的绝对定位底部锚定窗格。
 * 消费者使用此功能来：
 *
 * - 抑制顶级框架——`Pane` 跳过其全终端宽度的
 *   `Divider`（FullscreenLayout 已经绘制了 ▔ 分隔线）。
 * - 将 Select 分页大小调整为可用行数——模态的内部
 *   区域小于终端（行数减去转录预览再减去
 *   分隔线），因此根据其可见选项数量上限来自
 *   `useTerminalSize().rows` 的组件在没有此上下文时会溢出。
 * - 在标签切换时重置滚动——Tabs 通过 `selectedTabIndex`
 *   为其 ScrollBox 设置键，在标签切换时重新挂载，
 *   这样 scrollTop 无需 scrollTo() 的时序处理即可重置为 0。
 *
 * null = 不在模态插槽内部。
 */
type ModalCtx = {
  rows: number;
  columns: number;
  scrollRef: RefObject<ScrollBoxHandle | null> | null;
};
export const ModalContext = createContext<ModalCtx | null>(null);

export function useIsInsideModal(): boolean {
  return useContext(ModalContext) !== null;
}

/**
 * 在 Modal 内部时可用的内容行/列数，否则回退到
 * 提供的终端大小。当组件限制其可见内容高度时，
 * 应使用此函数而非 `useTerminalSize()`——模态的内部
 * 区域小于终端。
 */
export function useModalOrTerminalSize(fallback: { rows: number; columns: number }): { rows: number; columns: number } {
  const ctx = useContext(ModalContext);
  return ctx ? { rows: ctx.rows, columns: ctx.columns } : fallback;
}

export function useModalScrollRef(): RefObject<ScrollBoxHandle | null> | null {
  return useContext(ModalContext)?.scrollRef ?? null;
}
