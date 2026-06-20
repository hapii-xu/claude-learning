import { useState, useEffect, useRef } from 'react';
import { useSse } from '@/hooks/useSse';
import { cn } from '@/lib/cn';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { RefreshCw, Trash2, Pause, Play, AlertCircle, Loader2 } from 'lucide-react';
import { fetchLogSources } from '@/lib/api';
import type { LogSource } from '@/data/types';

export function LogViewer() {
  const [sources, setSources] = useState<(LogSource & { exists?: boolean })[]>([]);
  const [selectedSource, setSelectedSource] = useState<string>('');
  const [paused, setPaused] = useState(false);
  const { lines, connected, connect, disconnect, clear } = useSse();
  const scrollRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Load sources
  useEffect(() => {
    fetchLogSources()
      .then(s => {
        setSources(s);
        // Auto-select first available
        const firstAvailable = s.find(src => 'exists' in src && (src as { exists: boolean }).exists);
        if (firstAvailable) setSelectedSource(firstAvailable.id);
      })
      .catch(() => {});
  }, []);

  // Connect when source changes
  useEffect(() => {
    if (selectedSource) {
      disconnect();
      clear();
      connect(`/api/logs/tail?source=${encodeURIComponent(selectedSource)}`);
    }
    return () => disconnect();
  }, [selectedSource]);

  // Auto-scroll (unless paused)
  useEffect(() => {
    if (!pausedRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b bg-surface-1/50">
        <select
          value={selectedSource}
          onChange={e => setSelectedSource(e.target.value)}
          className="h-7 text-xs rounded-md border bg-background px-2 flex-1"
        >
          {sources.length === 0 && <option value="">加载中...</option>}
          {sources.map(s => (
            <option key={s.id} value={s.id}>
              {s.label}
              {'exists' in s && !s.exists ? ' (不存在)' : ''}
            </option>
          ))}
        </select>

        <button
          onClick={() => setPaused(!paused)}
          className={cn(
            'p-1 rounded text-xs transition-colors',
            paused ? 'text-brand bg-brand/10' : 'text-muted-foreground hover:text-foreground hover:bg-accent',
          )}
          title={paused ? '恢复滚动' : '暂停滚动'}
        >
          {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
        </button>

        <button
          onClick={() => {
            disconnect();
            clear();
            if (selectedSource) connect(`/api/logs/tail?source=${encodeURIComponent(selectedSource)}`);
          }}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
          title="刷新"
        >
          <RefreshCw className="size-3.5" />
        </button>

        <button
          onClick={clear}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
          title="清空"
        >
          <Trash2 className="size-3.5" />
        </button>

        <div className="flex items-center gap-1.5 ml-auto">
          <div className={cn('size-2 rounded-full', connected ? 'bg-status-active' : 'bg-muted')} />
          <span className="text-[10px] text-muted-foreground">{connected ? '已连接' : '未连接'}</span>
          {paused && <span className="text-[10px] text-brand font-medium">已暂停</span>}
        </div>
      </div>

      {/* Log output */}
      <ScrollArea className="flex-1">
        <div ref={scrollRef} className="p-3 font-mono text-xs leading-relaxed">
          {lines.length === 0 ? (
            <div className="text-muted-foreground text-center py-8">
              {connected ? (
                <div className="flex items-center gap-2 justify-center">
                  <Loader2 className="size-4 animate-spin" />
                  <span>等待日志输入...</span>
                </div>
              ) : (
                <p>选择日志源开始查看</p>
              )}
            </div>
          ) : (
            lines.map((line, i) => (
              <div
                key={i}
                className={cn(
                  'whitespace-pre-wrap break-all',
                  line.type === 'error' && 'text-status-error',
                  line.type === 'rotated' && 'text-status-warning italic',
                  /\berror\b/i.test(line.data) && 'text-status-error',
                  /\bwarn\b/i.test(line.data) && 'text-status-warning',
                )}
              >
                {line.data}
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
