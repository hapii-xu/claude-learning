import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import {
  FunctionSquare,
  Boxes,
  Type,
  Braces,
  Variable,
  StickyNote,
  Sparkles,
  CheckCircle2,
  Circle,
} from 'lucide-react';
import type { SymbolInfo, SymbolKind } from '@/data/types';
import type { SymbolStatus } from '@/hooks/useLearningProgress';

const KIND_CONFIG: Record<SymbolKind, { icon: typeof FunctionSquare; color: string; label: string; badge: string }> = {
  function: { icon: FunctionSquare, color: 'text-blue-500', label: '函数', badge: 'fn' },
  method: { icon: FunctionSquare, color: 'text-purple-500', label: '方法', badge: 'meth' },
  class: { icon: Boxes, color: 'text-amber-500', label: '类', badge: 'cls' },
  interface: { icon: Type, color: 'text-green-500', label: '接口', badge: 'intf' },
  type: { icon: Type, color: 'text-teal-500', label: '类型', badge: 'type' },
  enum: { icon: Braces, color: 'text-orange-500', label: '枚举', badge: 'enum' },
  const: { icon: Variable, color: 'text-cyan-500', label: '常量', badge: 'const' },
  variable: { icon: Variable, color: 'text-slate-500', label: '变量', badge: 'var' },
};

const STATUS_DOT_COLORS: Record<SymbolStatus, string> = {
  unstudied: 'border-muted-foreground/40',
  studying: 'bg-status-running border-status-running',
  studied: 'bg-status-active border-status-active',
};

interface SymbolFlatItemProps {
  symbol: SymbolInfo;
  status: SymbolStatus;
  completed: boolean;
  note: string;
  isSelected: boolean;
  onClick: () => void;
  onStatusToggle: () => void;
  onCompletedToggle: () => void;
  onNoteClick: () => void;
  onExplain?: () => void;
}

export function SymbolFlatItem({
  symbol,
  status,
  completed,
  note,
  isSelected,
  onClick,
  onStatusToggle,
  onCompletedToggle,
  onNoteClick,
  onExplain,
}: SymbolFlatItemProps) {
  const config = KIND_CONFIG[symbol.kind];
  const Icon = config.icon;

  // Truncate note for display
  const noteExcerpt = note ? (note.length > 28 ? note.slice(0, 28) + '…' : note) : '';

  return (
    <div
      className={cn(
        'group rounded-md transition-colors cursor-pointer',
        isSelected ? 'bg-brand/10 border-l-2 border-brand' : 'hover:bg-accent border-l-2 border-transparent',
      )}
      onClick={onClick}
    >
      <div className="flex items-center gap-1.5 px-2 py-1.5 min-h-[28px]">
        {/* Status dot — click to cycle unstudied → studying → studied */}
        <button
          onClick={e => {
            e.stopPropagation();
            onStatusToggle();
          }}
          className={cn(
            'size-2.5 rounded-full border shrink-0 transition-transform hover:scale-125',
            STATUS_DOT_COLORS[status],
          )}
          title={`${status === 'unstudied' ? '未学习' : status === 'studying' ? '学习中' : '已学'} — 点击切换状态`}
        />

        {/* Completed toggle — independent boolean "I fully mastered this" */}
        <button
          onClick={e => {
            e.stopPropagation();
            onCompletedToggle();
          }}
          className={cn(
            'size-3.5 flex items-center justify-center shrink-0 transition-all hover:scale-110',
            completed ? 'text-brand' : 'text-muted-foreground/30 opacity-0 group-hover:opacity-100',
          )}
          title={completed ? '已标记为完成 — 点击取消' : '标记方法已完成'}
        >
          {completed ? <CheckCircle2 className="size-3.5 fill-brand/20" /> : <Circle className="size-3.5" />}
        </button>

        {/* Symbol kind icon */}
        <Icon className={cn('size-3 shrink-0', config.color)} />

        {/* Symbol name */}
        <span
          className={cn(
            'truncate font-mono text-xs text-left min-w-0 flex-1',
            isSelected ? 'text-brand' : 'text-foreground/80',
          )}
          title={symbol.jsdoc || symbol.signature || symbol.name}
        >
          {symbol.name}
        </span>

        {/* Kind badge */}
        <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 shrink-0 font-normal">
          {config.badge}
        </Badge>

        {/* Note indicator */}
        {note && (
          <button
            onClick={e => {
              e.stopPropagation();
              onNoteClick();
            }}
            className="shrink-0 text-brand/60 hover:text-brand transition-colors"
            title="查看/编辑笔记"
          >
            <StickyNote className="size-3" />
          </button>
        )}

        {/* Add note button (when no note yet) */}
        {!note && (
          <button
            onClick={e => {
              e.stopPropagation();
              onNoteClick();
            }}
            className="shrink-0 text-muted-foreground/30 hover:text-brand opacity-0 group-hover:opacity-100 transition-all"
            title="添加笔记"
          >
            <StickyNote className="size-3" />
          </button>
        )}

        {/* AI explain trigger */}
        {onExplain && (
          <button
            onClick={e => {
              e.stopPropagation();
              onExplain();
            }}
            className="shrink-0 text-muted-foreground/30 hover:text-brand opacity-0 group-hover:opacity-100 transition-all"
            title="让 AI 讲解这个符号"
          >
            <Sparkles className="size-3" />
          </button>
        )}

        {/* Line number */}
        <span className="ml-auto text-[10px] text-muted-foreground shrink-0">L{symbol.line}</span>
      </div>

      {/* Note excerpt line */}
      {noteExcerpt && (
        <div className="px-7 pb-1.5 -mt-0.5">
          <span
            className="text-[10px] text-muted-foreground/70 italic cursor-pointer hover:text-brand/70 transition-colors"
            onClick={e => {
              e.stopPropagation();
              onNoteClick();
            }}
          >
            {noteExcerpt}
          </span>
        </div>
      )}
    </div>
  );
}
