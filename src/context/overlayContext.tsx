/**
 * 覆盖层跟踪，用于 Escape 键协调。
 *
 * 这解决了当覆盖层（如带有 onCancel 的 Select）打开时的 escape 键
 * 处理问题。CancelRequestHandler 需要知道覆盖层何时处于活跃状态，
 * 这样就不会在用户只想关闭覆盖层时取消请求。
 *
 * 用法：
 * 1. 在任何覆盖层组件中调用 useRegisterOverlay() 以自动注册
 * 2. 调用 useIsOverlayActive() 以检查是否有任何覆盖层当前处于活跃状态
 *
 * 此钩子在挂载时自动注册，在卸载时自动注销，
 * 因此不需要手动清理或状态管理。
 */
import { useContext, useEffect, useLayoutEffect } from 'react';
import { instances } from '@anthropic/ink';
import { AppStoreContext, useAppState } from '../state/AppState.js';

// 不应禁用 TextInput 焦点的非模态覆盖层
const NON_MODAL_OVERLAYS = new Set(['autocomplete']);

/**
 * 将组件注册为活跃覆盖层的钩子。
 * 在挂载时自动注册，在卸载时自动注销。
 *
 * @param id - 此覆盖层的唯一标识符（例如，'select'、'multi-select'）
 * @param enabled - 是否注册（默认：true）。使用此参数根据组件 props
 *                  有条件地注册，例如，仅在提供 onCancel 时注册。
 *
 * @example
 * // 基于是否支持取消进行条件注册
 * function useSelectInput({ state }) {
 *   useRegisterOverlay('select', !!state.onCancel)
 *   // ...
 * }
 */
export function useRegisterOverlay(id: string, enabled = true): void {
  // 直接使用上下文，以便在 AppStateProvider 外部渲染时为无操作
  // （例如，不需要完整应用状态树的独立组件测试中）。
  const store = useContext(AppStoreContext);
  const setAppState = store?.setState;
  useEffect(() => {
    if (!enabled || !setAppState) return;
    setAppState(prev => {
      if (prev.activeOverlays.has(id)) return prev;
      const next = new Set(prev.activeOverlays);
      next.add(id);
      return { ...prev, activeOverlays: next };
    });
    return () => {
      setAppState(prev => {
        if (!prev.activeOverlays.has(id)) return prev;
        const next = new Set(prev.activeOverlays);
        next.delete(id);
        return { ...prev, activeOverlays: next };
      });
    };
  }, [id, enabled, setAppState]);

  // 覆盖层关闭时，强制下一次渲染使用完整脏差异
  // 而不是 blit。较高的覆盖层（例如带有 20 行预览的 FuzzyPicker）
  // 在卸载时会缩小 Ink 管理的区域；blit 快速路径可能会
  // 将覆盖层上一帧的陈旧单元格复制到较短布局
  // 不再覆盖的行中，留下幽灵标题/分隔线。
  // 使用 useLayoutEffect 以便清理在微任务延迟的 onRender 之前
  // 同步运行（scheduleRender 从 resetAfterCommit 中
  // 排队一个微任务；被动效果清理会在其后执行）。
  useLayoutEffect(() => {
    if (!enabled) return;
    return () => instances.get(process.stdout)?.invalidatePrevFrame();
  }, [enabled]);
}

/**
 * 检查是否有任何覆盖层当前处于活跃状态的钩子。
 * 这是响应式的——当覆盖层状态改变时，组件会重新渲染。
 *
 * @returns 如果有任何覆盖层当前处于活跃状态则返回 true
 *
 * @example
 * function CancelRequestHandler() {
 *   const isOverlayActive = useIsOverlayActive()
 *   const isActive = !isOverlayActive && canCancelRunningTask
 *   useKeybinding('chat:cancel', handleCancel, { isActive })
 * }
 */
export function useIsOverlayActive(): boolean {
  return useAppState(s => s.activeOverlays.size > 0);
}

/**
 * 检查是否有任何模态覆盖层当前处于活跃状态的钩子。
 * 模态覆盖层是指应该捕获所有输入的覆盖层（例如 Select 对话框）。
 * 非模态覆盖层（例如 autocomplete）不会禁用 TextInput 焦点。
 *
 * @returns 如果有任何模态覆盖层当前处于活跃状态则返回 true
 *
 * @example
 * // 用于 TextInput 焦点——允许在自动补全期间输入
 * focus: !isSearchingHistory && !isModalOverlayActive
 */
export function useIsModalOverlayActive(): boolean {
  return useAppState(s => {
    for (const id of s.activeOverlays) {
      if (!NON_MODAL_OVERLAYS.has(id)) return true;
    }
    return false;
  });
}
