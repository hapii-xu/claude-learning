import type { LocalJSXCommandCall } from '../../types/command.js';
import { SentryErrorBoundary } from '../../components/SentryErrorBoundary.js';
import { WorkflowsPanel } from './WorkflowsPanel.js';

/**
 * /workflows 的 local-jsx call：构建面板元素并返回给 Ink 渲染。
 *
 * 包在 SentryErrorBoundary 里：当 useSyncExternalStore / listNamed / 子组件
 * 抛错时，异常不能穿透到 REPL 顶层导致整个 session 崩溃；boundary 兜底为本地错误卡片。
 * onDone/context 由 command 运行时注入；args 未使用（面板没有参数化行为）。
 */
export const call: LocalJSXCommandCall = async (onDone, context, _args) => (
  <SentryErrorBoundary name="WorkflowsPanel">
    <WorkflowsPanel onDone={onDone} context={context} />
  </SentryErrorBoundary>
);
