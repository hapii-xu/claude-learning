/**
 * Usage Panel - 显示 token/cache 统计
 */

import { useMemo, useState } from 'react';
import type { DebugEvent } from '../../api/debugStream';

interface UsagePanelProps {
  events: DebugEvent[];
}

interface UsageRecord {
  timestamp: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  model: string;
}

export function UsagePanel({ events }: UsagePanelProps) {
  const [timeRange, setTimeRange] = useState<'all' | '5m' | '1h'>('all');

  const usageRecords = useMemo(() => {
    return events
      .filter(e => e.type === 'usage')
      .map(
        e =>
          ({
            timestamp: e.timestamp,
            usage: e.payload as UsageRecord['usage'],
            model: (e.payload as UsageRecord).model,
          }) as UsageRecord,
      );
  }, [events]);

  const filteredRecords = useMemo(() => {
    const now = Date.now();
    if (timeRange === 'all') return usageRecords;
    if (timeRange === '5m') return usageRecords.filter(r => now - r.timestamp < 5 * 60 * 1000);
    if (timeRange === '1h') return usageRecords.filter(r => now - r.timestamp < 60 * 60 * 1000);
    return usageRecords;
  }, [usageRecords, timeRange]);

  const latestUsage = filteredRecords[filteredRecords.length - 1];
  const totalInput = filteredRecords.reduce((sum, r) => sum + (r.usage.input_tokens || 0), 0);
  const totalOutput = filteredRecords.reduce((sum, r) => sum + (r.usage.output_tokens || 0), 0);
  const totalCacheCreate = filteredRecords.reduce((sum, r) => sum + (r.usage.cache_creation_input_tokens || 0), 0);
  const totalCacheRead = filteredRecords.reduce((sum, r) => sum + (r.usage.cache_read_input_tokens || 0), 0);

  return (
    <div className="flex flex-col h-full">
      {/* Time range selector */}
      <div className="flex gap-2 p-2 border-b bg-surface-2">
        <button
          onClick={() => setTimeRange('all')}
          className={`px-2 py-1 text-xs rounded ${timeRange === 'all' ? 'bg-blue-600 text-white' : 'bg-white dark:bg-gray-800 text-text-secondary'}`}
        >
          全部
        </button>
        <button
          onClick={() => setTimeRange('5m')}
          className={`px-2 py-1 text-xs rounded ${timeRange === '5m' ? 'bg-blue-600 text-white' : 'bg-white dark:bg-gray-800 text-text-secondary'}`}
        >
          5分钟
        </button>
        <button
          onClick={() => setTimeRange('1h')}
          className={`px-2 py-1 text-xs rounded ${timeRange === '1h' ? 'bg-blue-600 text-white' : 'bg-white dark:bg-gray-800 text-text-secondary'}`}
        >
          1小时
        </button>
      </div>

      {/* Summary stats */}
      <div className="p-4 border-b bg-surface-1">
        {latestUsage ? (
          <>
            <div className="text-xs text-text-muted mb-2">
              最新模型: <span className="font-mono text-text-primary">{latestUsage.model}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white dark:bg-gray-800 rounded p-2">
                <div className="text-xs text-text-muted">输入 tokens</div>
                <div className="text-lg font-bold text-blue-600">{totalInput.toLocaleString()}</div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded p-2">
                <div className="text-xs text-text-muted">输出 tokens</div>
                <div className="text-lg font-bold text-green-600">{totalOutput.toLocaleString()}</div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded p-2">
                <div className="text-xs text-text-muted">Cache 创建</div>
                <div className="text-lg font-bold text-purple-600">{totalCacheCreate.toLocaleString()}</div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded p-2">
                <div className="text-xs text-text-muted">Cache 读取</div>
                <div className="text-lg font-bold text-yellow-600">{totalCacheRead.toLocaleString()}</div>
              </div>
            </div>
          </>
        ) : (
          <div className="text-center text-text-muted py-4">暂无使用数据</div>
        )}
      </div>

      {/* History */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-2 py-1 text-xs font-semibold text-text-secondary bg-surface-2">历史记录</div>
        {filteredRecords.length === 0 ? (
          <div className="p-4 text-center text-text-muted">暂无记录</div>
        ) : (
          filteredRecords.map((record, idx) => (
            <div key={idx} className="px-3 py-2 border-b border-gray-200 dark:border-gray-800 text-xs">
              <div className="flex items-center justify-between mb-1">
                <span className="text-text-muted">{new Date(record.timestamp).toLocaleTimeString()}</span>
                <span className="font-mono text-text-secondary">{record.model}</span>
              </div>
              <div className="flex gap-3 text-text-secondary">
                <span>输入: {record.usage.input_tokens}</span>
                <span>输出: {record.usage.output_tokens}</span>
                {record.usage.cache_read_input_tokens !== undefined && (
                  <span>Cache读: {record.usage.cache_read_input_tokens}</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Stats */}
      <div className="px-2 py-1 text-xs text-text-muted border-t bg-surface-2">共 {filteredRecords.length} 条记录</div>
    </div>
  );
}
