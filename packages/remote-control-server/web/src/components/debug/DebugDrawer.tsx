/**
 * Debug Drawer - 调试面板主容器
 */

import { useState } from 'react';
import { useDebugEvents } from '../../api/debugStream';
import { DebugLogPanel } from './DebugLogPanel';
import { SdkStreamPanel } from './SdkStreamPanel';
import { ToolTracePanel } from './ToolTracePanel';
import { UsagePanel } from './UsagePanel';
import { AppStatePanel } from './AppStatePanel';
import { cn } from '../../lib/utils';

interface DebugDrawerProps {
  sessionId: string;
  isOpen: boolean;
  onClose: () => void;
}

type TabId = 'logs' | 'sdk' | 'tools' | 'usage' | 'state';

interface Tab {
  id: TabId;
  label: string;
  icon: string;
}

const TABS: Tab[] = [
  { id: 'logs', label: '日志', icon: '📋' },
  { id: 'sdk', label: 'SDK 流', icon: '🔄' },
  { id: 'tools', label: '工具', icon: '🔧' },
  { id: 'usage', label: 'Token', icon: '📊' },
  { id: 'state', label: '状态', icon: '📦' },
];

export function DebugDrawer({ sessionId, isOpen, onClose }: DebugDrawerProps) {
  const [activeTab, setActiveTab] = useState<TabId>('logs');
  const debugEvents = useDebugEvents(sessionId);

  const eventCounts = {
    debug_log: debugEvents.filter(e => e.type === 'debug_log').length,
    sdk_raw: debugEvents.filter(e => e.type === 'sdk_raw').length,
    tool_trace: debugEvents.filter(e => e.type === 'tool_trace').length,
    usage: debugEvents.filter(e => e.type === 'usage').length,
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-y-0 right-0 w-[600px] bg-white dark:bg-gray-900 border-l border-gray-300 dark:border-gray-700 shadow-2xl flex flex-col z-50">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-900/20 dark:to-purple-900/20">
        <div className="flex items-center gap-2">
          <span className="text-xl">🐞</span>
          <h2 className="text-lg font-semibold text-text-primary">调试面板</h2>
          <span className="text-xs text-text-muted bg-white dark:bg-gray-800 px-2 py-0.5 rounded">
            {debugEvents.length} 事件
          </span>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-surface-2 rounded transition-colors" title="关闭调试面板">
          <svg className="w-5 h-5 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b bg-surface-1">
        {TABS.map(tab => {
          const count =
            tab.id === 'logs'
              ? eventCounts.debug_log
              : tab.id === 'sdk'
                ? eventCounts.sdk_raw
                : tab.id === 'tools'
                  ? eventCounts.tool_trace
                  : tab.id === 'usage'
                    ? eventCounts.usage
                    : 0;

          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex-1 px-3 py-2 text-sm font-medium transition-colors border-b-2',
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-600 bg-blue-50 dark:bg-blue-900/20'
                  : 'border-transparent text-text-secondary hover:text-text-primary hover:bg-surface-2',
              )}
            >
              <div className="flex items-center justify-center gap-1">
                <span>{tab.icon}</span>
                <span>{tab.label}</span>
                {count > 0 && (
                  <span className="ml-1 px-1.5 py-0.5 text-xs bg-blue-100 dark:bg-blue-800 text-blue-700 dark:text-blue-300 rounded-full">
                    {count > 999 ? '999+' : count}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'logs' && <DebugLogPanel events={debugEvents} />}
        {activeTab === 'sdk' && <SdkStreamPanel events={debugEvents} />}
        {activeTab === 'tools' && <ToolTracePanel events={debugEvents} />}
        {activeTab === 'usage' && <UsagePanel events={debugEvents} />}
        {activeTab === 'state' && <AppStatePanel sessionId={sessionId} />}
      </div>
    </div>
  );
}
