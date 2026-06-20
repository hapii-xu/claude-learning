/**
 * 用于浮在提示上方内容的门户，使其可以逃脱
 * FullscreenLayout 的底部插槽 `overflowY:hidden` 裁剪。
 *
 * 该裁剪是必要的（CC-668：没有它时，较高的粘贴内容会挤压 ScrollBox），
 * 但浮动的覆盖层使用 `position:absolute bottom="100%"` 浮在提示上方——
 * 而 Ink 的裁剪堆栈会影响所有后代元素，所以它们会被裁剪到约 1 行。
 *
 * 两个通道：
 * - `useSetPromptOverlay` — 斜杠命令建议数据（结构化，
 *   由 PromptInputFooter 写入）
 * - `useSetPromptOverlayDialog` — 任意对话框节点（例如
 *   AutoModeOptInDialog，由 PromptInput 写入）
 *
 * FullscreenLayout 读取两者并将它们渲染在裁剪插槽之外。
 *
 * 分为数据/设置器上下文对，这样写入者永远不会因自己的写入
 * 而重新渲染——设置器上下文是稳定的。
 */
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js';

export type PromptOverlayData = {
  suggestions: SuggestionItem[];
  selectedSuggestion: number;
  maxColumnWidth?: number;
};

type Setter<T> = (d: T | null) => void;

const DataContext = createContext<PromptOverlayData | null>(null);
const SetContext = createContext<Setter<PromptOverlayData> | null>(null);
const DialogContext = createContext<ReactNode>(null);
const SetDialogContext = createContext<Setter<ReactNode> | null>(null);

export function PromptOverlayProvider({ children }: { children: ReactNode }): ReactNode {
  const [data, setData] = useState<PromptOverlayData | null>(null);
  const [dialog, setDialog] = useState<ReactNode>(null);
  return (
    <SetContext.Provider value={setData}>
      <SetDialogContext.Provider value={setDialog}>
        <DataContext.Provider value={data}>
          <DialogContext.Provider value={dialog}>{children}</DialogContext.Provider>
        </DataContext.Provider>
      </SetDialogContext.Provider>
    </SetContext.Provider>
  );
}

export function usePromptOverlay(): PromptOverlayData | null {
  return useContext(DataContext);
}

export function usePromptOverlayDialog(): ReactNode {
  return useContext(DialogContext);
}

/**
 * 为浮动覆盖层注册建议数据。卸载时清除。
 * 在 provider 外部为无操作（非全屏时改为内联渲染）。
 */
export function useSetPromptOverlay(data: PromptOverlayData | null): void {
  const set = useContext(SetContext);
  useEffect(() => {
    if (!set) return;
    set(data);
    return () => set(null);
  }, [set, data]);
}

/**
 * 注册一个浮在提示上方的对话框节点。卸载时清除。
 * 在 provider 外部为无操作（非全屏时改为内联渲染）。
 */
export function useSetPromptOverlayDialog(node: ReactNode): void {
  const set = useContext(SetDialogContext);
  useEffect(() => {
    if (!set) return;
    set(node);
    return () => set(null);
  }, [set, node]);
}
