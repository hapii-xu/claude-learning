import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StickyNote, Sparkles, CheckCircle2, Circle } from 'lucide-react';
import type { SymbolInfo, SymbolKind } from '@/data/types';
import type { SymbolStatus } from '@/hooks/useLearningProgress';

const KIND_CONFIG: Record<SymbolKind, { label: string; color: string }> = {
  function: { label: '函数', color: 'text-blue-500' },
  method: { label: '方法', color: 'text-purple-500' },
  class: { label: '类', color: 'text-amber-500' },
  interface: { label: '接口', color: 'text-green-500' },
  type: { label: '类型', color: 'text-teal-500' },
  enum: { label: '枚举', color: 'text-orange-500' },
  const: { label: '常量', color: 'text-cyan-500' },
  variable: { label: '变量', color: 'text-slate-500' },
};

interface SymbolHoverTooltipProps {
  symbol: SymbolInfo;
  status: SymbolStatus;
  completed: boolean;
  note: string;
  position: { x: number; y: number };
  onStatusToggle: () => void;
  onOpenNoteDrawer: () => void;
  onExplain?: () => void;
}

export function SymbolHoverTooltip({
  symbol,
  status,
  completed,
  note,
  position,
  onStatusToggle,
  onOpenNoteDrawer,
  onExplain,
}: SymbolHoverTooltipProps) {
  const kindInfo = KIND_CONFIG[symbol.kind];

  // Truncate note for display
  const noteExcerpt = note ? (note.length > 60 ? note.slice(0, 60) + '…' : note) : '';

  return (
    <div
      className="fixed z-50 animate-in fade-in zoom-in-95 duration-150"
      style={{
        left: `${position.x}px`,
        top: `${position.y - 8}px`,
        transform: 'translate(-50%, -100%)',
      }}
    >
      <div className="bg-popover border border-border rounded-lg shadow-lg p-3 min-w-[240px] max-w-[320px]">
        {/* Header */}
        <div className="flex items-start gap-2 mb-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-sm font-mono font-semibold text-foreground truncate">{symbol.name}</span>
              <Badge variant="outline" className={cn('text-[9px] px-1 py-0 h-4', kindInfo.color)}>
                {kindInfo.label}
              </Badge>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span>L{symbol.line}</span>
              {symbol.exported && <span>导出</span>}
              {symbol.isAsync && <span>异步</span>}
            </div>
          </div>
        </div>

        {/* Status and completed */}
        <div className="flex items-center gap-2 mb-2">
          <button
            onClick={onStatusToggle}
            className={cn(
              'flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors',
              status === 'studied'
                ? 'bg-status-active/10 text-status-active'
                : status === 'studying'
                  ? 'bg-status-running/10 text-status-running'
                  : 'bg-muted hover:bg-accent text-muted-foreground',
            )}
            title={`${status === 'unstudied' ? '未学习' : status === 'studying' ? '学习中' : '已学'} — 点击切换状态`}
          >
            <span>{status === 'unstudied' ? '☐' : status === 'studying' ? '🔵' : '✅'}</span>
            <span>{status === 'unstudied' ? '未学习' : status === 'studying' ? '学习中' : '已学'}</span>
          </button>

          <button
            onClick={onOpenNoteDrawer}
            className={cn(
              'flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors',
              completed ? 'bg-brand/10 text-brand' : 'bg-muted hover:bg-accent text-muted-foreground',
            )}
            title={completed ? '已完成 — 点击取消' : '标记为已完成'}
          >
            {completed ? <CheckCircle2 className="size-3 fill-brand/20" /> : <Circle className="size-3" />}
            <span>{completed ? '已完成' : '完成'}</span>
          </button>
        </div>

        {/* Note excerpt */}
        {noteExcerpt && (
          <div className="mb-2 p-2 bg-muted/50 rounded-md">
            <p className="text-xs text-muted-foreground italic line-clamp-2">{noteExcerpt}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={onOpenNoteDrawer} className="flex-1 h-7 text-xs">
            <StickyNote className="size-3 mr-1" />
            备注
          </Button>
          {onExplain && (
            <Button variant="outline" size="sm" onClick={onExplain} className="flex-1 h-7 text-xs">
              <Sparkles className="size-3 mr-1" />
              AI 讲解
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
