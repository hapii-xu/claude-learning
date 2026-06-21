/**
 * AppState Panel - 显示应用状态快照
 */

import { useState } from 'react';

interface AppStatePanelProps {
  sessionId: string;
}

export function AppStatePanel({ sessionId }: AppStatePanelProps) {
  const [autoRefresh, setAutoRefresh] = useState(false);

  return (
    <div className="flex flex-col h-full">
      {/* Controls */}
      <div className="flex gap-2 p-2 border-b bg-surface-2">
        <label className="flex items-center gap-1 text-xs text-text-muted">
          <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
          自动刷新
        </label>
        <span className="text-xs text-text-muted">
          Session ID: <span className="font-mono">{sessionId}</span>
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded p-4">
          <div className="text-sm font-semibold text-blue-900 dark:text-blue-100 mb-2">关于 AppState 面板</div>
          <div className="text-xs text-blue-800 dark:text-blue-200 space-y-2">
            <p>AppState 包含整个应用的内部状态，包括：</p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>当前消息列表</li>
              <li>可用工具列表</li>
              <li>权限配置</li>
              <li>MCP 连接状态</li>
              <li>模型设置</li>
              <li>Token 使用统计</li>
            </ul>
            <p className="mt-3">
              由于 AppState 存储在 CLI 进程的内存中，需要通过专门的 API 端点来传输。 当前版本正在开发此功能。
            </p>
            <p className="mt-3 text-text-muted">
              提示：您可以通过 Debug Log 面板查看{' '}
              <code className="bg-white dark:bg-gray-800 px-1 rounded">[Hapii]</code> 标记的日志，
              这些日志包含了关键的状态变化信息。
            </p>
          </div>
        </div>

        <div className="mt-4 bg-surface-2 rounded p-4">
          <div className="text-sm font-semibold text-text-primary mb-2">快速状态信息</div>
          <div className="text-xs font-mono space-y-1 text-text-secondary">
            <div>Session: {sessionId}</div>
            <div>时间: {new Date().toLocaleString()}</div>
            <div>状态: 运行中</div>
          </div>
        </div>
      </div>
    </div>
  );
}
