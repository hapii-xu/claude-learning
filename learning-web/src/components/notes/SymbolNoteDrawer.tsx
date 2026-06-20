import { useRef, useCallback, useEffect } from 'react';
import { cn } from '@/lib/cn';
import { useSymbolNoteDrawer } from '@/hooks/useSymbolNoteDrawer';
import { useLearningProgress } from '@/hooks/useLearningProgress';
import { SymbolNoteEditor } from '@/components/symbols/SymbolNoteEditor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { X, StickyNote, CheckCircle2, Circle } from 'lucide-react';
import type { SymbolKind } from '@/data/types';

const KIND_BADGE: Record<SymbolKind, { label: string; color: string }> = {
  function: { label: '函数', color: 'text-blue-500' },
  method: { label: '方法', color: 'text-purple-500' },
  class: { label: '类', color: 'text-amber-500' },
  interface: { label: '接口', color: 'text-green-500' },
  type: { label: '类型', color: 'text-teal-500' },
  enum: { label: '枚举', color: 'text-orange-500' },
  const: { label: '常量', color: 'text-cyan-500' },
  variable: { label: '变量', color: 'text-slate-500' },
};

export function SymbolNoteDrawer() {
  const { open, filePath, symbol, height, close, setHeight } = useSymbolNoteDrawer();
  const progress = useLearningProgress(filePath);
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

  // Keyboard shortcuts
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, close]);

  if (!symbol || !filePath) return null;

  const status = progress.getStatus(symbol.name);
  const note = progress.getNote(symbol.name);
  const completed = progress.getCompleted(symbol.name);
  const kindInfo = KIND_BADGE[symbol.kind];

  return (
    <div
      className={cn(
        'fixed bottom-0 left-0 right-0 z-40 border-t bg-card shadow-lg transition-transform duration-200',
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
      <div className="flex items-center justify-between px-4 py-2 border-b">
        <div className="flex items-center gap-2 min-w-0">
          <StickyNote className="size-4 text-brand shrink-0" />
          <span className="text-sm font-mono font-semibold text-foreground truncate">{symbol.name}</span>
          <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0 h-5', kindInfo.color)}>
            {kindInfo.label}
          </Badge>
          <span className="text-[10px] text-muted-foreground">L{symbol.line}</span>
        </div>

        <div className="flex items-center gap-1">
          {/* Completed toggle */}
          <button
            onClick={() => progress.toggleCompleted(symbol.name)}
            className={cn(
              'flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors',
              completed ? 'bg-brand/10 text-brand' : 'text-muted-foreground hover:text-foreground hover:bg-accent',
            )}
            title={completed ? '已标记为完成 — 点击取消' : '标记方法已完成'}
          >
            {completed ? <CheckCircle2 className="size-3.5 fill-brand/20" /> : <Circle className="size-3.5" />}
            <span>{completed ? '已完成' : '标记完成'}</span>
          </button>

          {/* Status cycle */}
          <button
            onClick={() => progress.toggleStatus(symbol.name)}
            className={cn(
              'flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors',
              status === 'studied'
                ? 'bg-status-active/10 text-status-active'
                : status === 'studying'
                  ? 'bg-status-running/10 text-status-running'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent',
            )}
            title={`${status === 'unstudied' ? '未学习' : status === 'studying' ? '学习中' : '已学'} — 点击切换状态`}
          >
            <span>{status === 'unstudied' ? '☐' : status === 'studying' ? '🔵' : '✅'}</span>
            <span>{status === 'unstudied' ? '未学习' : status === 'studying' ? '学习中' : '已学'}</span>
          </button>

          <div className="w-px h-4 bg-border mx-1" />

          <button
            onClick={close}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title="关闭 (Esc)"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden" style={{ height: `calc(100% - 3rem)` }}>
        <div className="h-full p-4 overflow-y-auto">
          <SymbolNoteEditor
            symbolName={symbol.name}
            note={note}
            onSave={newNote => {
              progress.setNote(symbol.name, newNote);
            }}
            onClose={close}
          />
        </div>
      </div>
    </div>
  );
}
