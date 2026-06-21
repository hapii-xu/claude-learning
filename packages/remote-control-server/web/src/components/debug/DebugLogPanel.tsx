/**
 * Debug Log Panel - 显示实时调试日志
 */

import { useMemo } from 'react';
import { useState } from 'react';
import type { DebugEvent } from '../../api/debugStream';
import { cn } from '../../lib/utils';

interface DebugLogPanelProps {
  events: DebugEvent[];
}

type LogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error';

const LEVEL_COLORS: Record<LogLevel, string> = {
  verbose: 'text-gray-500',
  debug: 'text-gray-600',
  info: 'text-blue-600',
  warn: 'text-yellow-600',
  error: 'text-red-600',
};

export function DebugLogPanel({ events }: DebugLogPanelProps) {
  const [filter, setFilter] = useState<string>('');
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');

  const logEvents = useMemo(() => {
    return events.filter(e => e.type === 'debug_log');
  }, [events]);

  const filteredEvents = useMemo(() => {
    return logEvents.filter(e => {
      const payload = e.payload as { level: LogLevel; message: string };
      if (levelFilter !== 'all' && payload.level !== levelFilter) return false;
      if (filter && !payload.message.toLowerCase().includes(filter.toLowerCase())) return false;
      return true;
    });
  }, [logEvents, filter, levelFilter]);

  return (
    <div className="flex flex-col h-full">
      {/* Filter controls */}
      <div className="flex gap-2 p-2 border-b bg-surface-2">
        <input
          type="text"
          placeholder="搜索日志..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="flex-1 px-2 py-1 text-sm border rounded bg-white dark:bg-gray-800 dark:border-gray-700"
        />
        <select
          value={levelFilter}
          onChange={e => setLevelFilter(e.target.value as LogLevel | 'all')}
          className="px-2 py-1 text-sm border rounded bg-white dark:bg-gray-800 dark:border-gray-700"
        >
          <option value="all">所有级别</option>
          <option value="verbose">Verbose</option>
          <option value="debug">Debug</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </select>
      </div>

      {/* Log entries */}
      <div className="flex-1 overflow-y-auto font-mono text-xs">
        {filteredEvents.length === 0 ? (
          <div className="p-4 text-center text-text-muted">暂无日志</div>
        ) : (
          filteredEvents.map((event, idx) => {
            const payload = event.payload as { level: LogLevel; message: string; timestamp: string };
            return (
              <div key={idx} className="px-2 py-1 border-b border-gray-200 dark:border-gray-800 hover:bg-surface-2">
                <div className="flex gap-2">
                  <span className="text-text-muted">{new Date(payload.timestamp).toLocaleTimeString()}</span>
                  <span className={cn('font-semibold uppercase', LEVEL_COLORS[payload.level])}>{payload.level}</span>
                  <span className="flex-1 whitespace-pre-wrap break-all">{payload.message}</span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Stats */}
      <div className="px-2 py-1 text-xs text-text-muted border-t bg-surface-2">
        共 {filteredEvents.length} 条日志（总计 {logEvents.length} 条）
      </div>
    </div>
  );
}
