import * as React from 'react';
import { useContext } from 'react';

/**
 * 用于指示 shell 输出应完整显示（不截断）的 Context。
 * 用于自动展开最近的用户 `!` 命令输出。
 *
 * 这遵循与 MessageResponseContext 和 SubAgentContext 相同的模式 ——
 * 一个布尔 Context，子组件可以检查它来修改自身行为。
 */
const ExpandShellOutputContext = React.createContext(false);

export function ExpandShellOutputProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  return <ExpandShellOutputContext.Provider value={true}>{children}</ExpandShellOutputContext.Provider>;
}

/**
 * 如果此组件渲染在 ExpandShellOutputProvider 内部则返回 true，
 * 表示 shell 输出应完整显示而非被截断。
 */
export function useExpandShellOutput(): boolean {
  return useContext(ExpandShellOutputContext);
}
