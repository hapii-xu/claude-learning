/**
 * SDK Raw Event Panel - 显示原始 Anthropic SDK 流式事件
 */

import { useMemo, useState } from 'react';
import type { DebugEvent } from '../../api/debugStream';
import { cn } from '../../lib/utils';

interface SdkStreamPanelProps {
  events: DebugEvent[];
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  message_start: 'text-blue-600',
  content_block_start: 'text-green-600',
  content_block_delta: 'text-green-700',
  content_block_stop: 'text-green-800',
  message_delta: 'text-purple-600',
  message_stop: 'text-blue-800',
  ping: 'text-gray-500',
};

export function SdkStreamPanel({ events }: SdkStreamPanelProps) {
  const [filter, setFilter] = useState<string>('');
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const sdkEvents = useMemo(() => {
    return events.filter(e => e.type === 'sdk_raw');
  }, [events]);

  const filteredEvents = useMemo(() => {
    if (!filter) return sdkEvents;
    return sdkEvents.filter(e => {
      const payload = e.payload as { type?: string };
      return payload.type?.toLowerCase().includes(filter.toLowerCase());
    });
  }, [sdkEvents, filter]);

  const exportJsonL = () => {
    const lines = filteredEvents.map(e => JSON.stringify(e.payload)).join('\n');
    const blob = new Blob([lines], { type: 'application/jsonl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sdk-events-${Date.now()}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Controls */}
      <div className="flex gap-2 p-2 border-b bg-surface-2">
        <input
          type="text"
          placeholder="过滤事件类型..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="flex-1 px-2 py-1 text-sm border rounded bg-white dark:bg-gray-800 dark:border-gray-700"
        />
        <label className="flex items-center gap-1 text-xs text-text-muted">
          <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
          自动滚动
        </label>
        <button onClick={exportJsonL} className="px-2 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700">
          导出 JSONL
        </button>
      </div>

      {/* Event list */}
      <div className="flex-1 overflow-y-auto font-mono text-xs">
        {filteredEvents.length === 0 ? (
          <div className="p-4 text-center text-text-muted">暂无 SDK 事件</div>
        ) : (
          filteredEvents.map((event, idx) => {
            const payload = event.payload as { type?: string };
            const isExpanded = expandedIdx === idx;
            return (
              <div
                key={idx}
                className="border-b border-gray-200 dark:border-gray-800 hover:bg-surface-2 cursor-pointer"
                onClick={() => setExpandedIdx(isExpanded ? null : idx)}
              >
                <div className="flex items-center gap-2 px-2 py-1">
                  <span className="text-text-muted">{new Date(event.timestamp).toLocaleTimeString()}</span>
                  <span className={cn('font-semibold', EVENT_TYPE_COLORS[payload.type || ''] || 'text-gray-600')}>
                    {payload.type || 'unknown'}
                  </span>
                  {payload.type === 'content_block_delta' && (
                    <span className="text-text-muted truncate">
                      {String(
                        ((payload as Record<string, unknown>).delta as Record<string, unknown> | undefined)?.type ?? '',
                      )}
                    </span>
                  )}
                </div>
                {isExpanded && (
                  <pre className="px-2 py-2 bg-surface-2 overflow-x-auto text-xs whitespace-pre-wrap break-all">
                    {JSON.stringify(payload, null, 2)}
                  </pre>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Stats */}
      <div className="px-2 py-1 text-xs text-text-muted border-t bg-surface-2">
        共 {filteredEvents.length} 个事件（总计 {sdkEvents.length} 个）
      </div>
    </div>
  );
}
