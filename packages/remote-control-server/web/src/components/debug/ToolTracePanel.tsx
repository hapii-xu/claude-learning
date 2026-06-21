/**
 * Tool Trace Panel - 显示工具执行轨迹
 */

import { useMemo, useState } from 'react';
import type { DebugEvent } from '../../api/debugStream';
import { cn } from '../../lib/utils';

interface ToolTracePanelProps {
  events: DebugEvent[];
}

interface ToolCallRecord {
  toolUseId: string;
  toolName: string;
  input: unknown;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  isError: boolean;
}

export function ToolTracePanel({ events }: ToolTracePanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('');

  const toolCalls = useMemo(() => {
    const toolEvents = events.filter(e => e.type === 'tool_trace');
    const calls = new Map<string, ToolCallRecord>();

    for (const event of toolEvents) {
      const payload = event.payload as {
        phase: 'start' | 'end';
        toolName: string;
        toolUseId: string;
        input?: unknown;
        durationMs?: number;
        isError?: boolean;
      };

      if (payload.phase === 'start') {
        calls.set(payload.toolUseId, {
          toolUseId: payload.toolUseId,
          toolName: payload.toolName,
          input: payload.input,
          startTime: event.timestamp,
          isError: false,
        });
      } else if (payload.phase === 'end') {
        const existing = calls.get(payload.toolUseId);
        if (existing) {
          existing.endTime = event.timestamp;
          existing.durationMs = payload.durationMs;
          existing.isError = payload.isError || false;
        }
      }
    }

    return Array.from(calls.values())
      .filter(c => !filter || c.toolName.toLowerCase().includes(filter.toLowerCase()))
      .sort((a, b) => b.startTime - a.startTime);
  }, [events, filter]);

  const formatDuration = (ms?: number) => {
    if (ms === undefined) return '运行中...';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  return (
    <div className="flex flex-col h-full">
      {/* Filter */}
      <div className="flex gap-2 p-2 border-b bg-surface-2">
        <input
          type="text"
          placeholder="过滤工具名称..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="flex-1 px-2 py-1 text-sm border rounded bg-white dark:bg-gray-800 dark:border-gray-700"
        />
      </div>

      {/* Tool calls */}
      <div className="flex-1 overflow-y-auto text-sm">
        {toolCalls.length === 0 ? (
          <div className="p-4 text-center text-text-muted">暂无工具调用</div>
        ) : (
          toolCalls.map(call => {
            const isExpanded = expandedId === call.toolUseId;
            return (
              <div key={call.toolUseId} className="border-b border-gray-200 dark:border-gray-800">
                <div
                  className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface-2"
                  onClick={() => setExpandedId(isExpanded ? null : call.toolUseId)}
                >
                  <span
                    className={cn(
                      'w-2 h-2 rounded-full',
                      call.endTime ? (call.isError ? 'bg-red-500' : 'bg-green-500') : 'bg-yellow-500 animate-pulse',
                    )}
                  />
                  <span className="font-mono font-semibold text-text-primary">{call.toolName}</span>
                  <span className="text-text-muted text-xs">{formatDuration(call.durationMs)}</span>
                  <span className="flex-1" />
                  <span className="text-xs text-text-muted font-mono">{call.toolUseId.slice(0, 8)}</span>
                </div>
                {isExpanded && (
                  <div className="px-3 py-2 bg-surface-2 space-y-2">
                    <div>
                      <div className="text-xs font-semibold text-text-secondary mb-1">输入:</div>
                      <pre className="text-xs overflow-x-auto whitespace-pre-wrap break-all bg-white dark:bg-gray-900 p-2 rounded">
                        {JSON.stringify(call.input, null, 2)}
                      </pre>
                    </div>
                    <div className="text-xs text-text-muted">
                      开始时间: {new Date(call.startTime).toLocaleString()}
                      {call.endTime && <> | 结束时间: {new Date(call.endTime).toLocaleString()}</>}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Stats */}
      <div className="px-2 py-1 text-xs text-text-muted border-t bg-surface-2 flex gap-4">
        <span>总计: {toolCalls.length} 次调用</span>
        <span>运行中: {toolCalls.filter(c => !c.endTime).length}</span>
        <span>错误: {toolCalls.filter(c => c.isError).length}</span>
      </div>
    </div>
  );
}
