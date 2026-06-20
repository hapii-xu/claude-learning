import { useRef, useCallback } from 'react';
import { cn } from '@/lib/cn';
import { useConsole } from '@/hooks/useConsole';
import { TestRunner } from './TestRunner';
import { LogViewer } from './LogViewer';
import { ExecPanel } from './ExecPanel';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { X, Terminal, Minus, MessageSquare } from 'lucide-react';

export function ConsoleDrawer() {
  const { open, tab, height, toggle, setOpen, setTab, setHeight } = useConsole();
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startH: height };

      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const delta = dragRef.current.startY - ev.clientY;
        setHeight(dragRef.current.startH + delta);
      };

      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [height, setHeight],
  );

  return (
    <div
      className={cn(
        'fixed bottom-0 left-0 right-0 z-50 border-t bg-card shadow-lg transition-transform duration-200',
        open ? 'translate-y-0' : 'translate-y-full',
      )}
      style={{ height: open ? `${height}px` : undefined }}
    >
      {/* Drag handle */}
      <div
        className="h-2 cursor-ns-resize hover:bg-brand/20 active:bg-brand/30 transition-colors flex items-center justify-center"
        onMouseDown={onDragStart}
      >
        <div className="w-12 h-0.5 rounded-full bg-muted-foreground/30" />
      </div>

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b">
        <div className="flex items-center gap-1">
          <Terminal className="size-3.5 text-brand" />
          <span className="text-xs font-semibold text-foreground">控制台</span>
        </div>

        <div className="flex items-center gap-0.5">
          {/* Tab buttons */}
          {(['test', 'log', 'exec', 'chat'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'flex items-center gap-1 text-xs px-3 py-1 rounded-md transition-colors',
                tab === t
                  ? 'bg-brand/10 text-brand font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent',
              )}
            >
              {t === 'chat' && <MessageSquare className="size-3" />}
              {t === 'test' ? '测试' : t === 'log' ? '日志' : t === 'exec' ? '执行' : '问 AI'}
            </button>
          ))}

          <div className="w-px h-4 bg-border mx-1" />

          <button
            onClick={() => setOpen(false)}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title="最小化"
          >
            <Minus className="size-3.5" />
          </button>
          <button
            onClick={toggle}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title="关闭"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden" style={{ height: `calc(100% - 2.75rem)` }}>
        {tab === 'test' && <TestRunner />}
        {tab === 'log' && <LogViewer />}
        {tab === 'exec' && <ExecPanel />}
        {tab === 'chat' && <ChatPanel />}
      </div>
    </div>
  );
}
