import React from 'react';
import type { StatsStore } from './context/stats.js';
import type { Root } from '@anthropic/ink';
import type { Props as REPLProps } from './screens/REPL.js';
import type { AppState } from './state/AppStateStore.js';
import type { FpsMetrics } from './utils/fpsTracker.js';

type AppWrapperProps = {
  getFpsMetrics: () => FpsMetrics | undefined;
  stats?: StatsStore;
  initialState: AppState;
};

/**
 * 启动交互式 REPL 界面 —— 渲染 React/Ink 组件树并阻塞直到会话结束。
 * Launches the interactive REPL screen — renders the React/Ink component tree
 * and blocks until the session ends.
 *
 * 调用时机：main.tsx 的默认 action 中，setup() 完成后调用。
 *
 * 组件树结构：
 *   <SentryErrorBoundary>   ← 错误边界，捕获未处理异常
 *     <App>                 ← 根 Provider（AppState、Stats、FpsMetrics）
 *       <REPL />            ← 主交互界面（消息列表、输入框、状态栏）
 *     </App>
 *   </SentryErrorBoundary>
 *
 * renderAndRun 会启动 Ink 渲染循环，并将 stdin 切换到 raw mode（键盘输入）。
 */
export async function launchRepl(
  root: Root,
  appProps: AppWrapperProps,
  replProps: REPLProps,
  renderAndRun: (root: Root, element: React.ReactNode) => Promise<void>,
): Promise<void> {
  const { App } = await import('./components/App.js');
  const { SentryErrorBoundary } = await import('./components/SentryErrorBoundary.js');
  const { REPL } = await import('./screens/REPL.js');
  await renderAndRun(
    root,
    <SentryErrorBoundary name="RootREPLBoundary">
      <App {...appProps}>
        <REPL {...replProps} />
      </App>
    </SentryErrorBoundary>,
  );
}
