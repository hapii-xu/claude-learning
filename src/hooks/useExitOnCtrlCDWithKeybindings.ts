import { useKeybindings } from '../keybindings/useKeybinding.js'
import { type ExitState, useExitOnCtrlCD } from './useExitOnCtrlCD.js'

export type { ExitState }

/**
 * 便捷 hook，将 useExitOnCtrlCD 与 useKeybindings 连接。
 *
 * 这是在组件中使用 useExitOnCtrlCD 的标准方式。
 * 分离的存在是为了避免导入循环 - useExitOnCtrlCD.ts
 * 不直接从 keybindings 模块导入。
 *
 * @param onExit - 可选自定义退出处理程序
 * @param onInterrupt - 可选回调，让功能处理中断 (ctrl+c)。
 *                      返回 true 表示已处理，false 则回退到双击退出。
 * @param isActive - 快捷键是否活跃（默认 true）。
 */
export function useExitOnCtrlCDWithKeybindings(
  onExit?: () => void,
  onInterrupt?: () => boolean,
  isActive?: boolean,
): ExitState {
  return useExitOnCtrlCD(useKeybindings, onInterrupt, onExit, isActive)
}
