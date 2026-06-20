import { Search, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import type { SymbolKind } from '@/data/types';
import type { SymbolStatus } from '@/hooks/useLearningProgress';
import { FunctionSquare, Boxes, Type, Braces, Variable } from 'lucide-react';

const KIND_CONFIG: Record<SymbolKind, { icon: typeof FunctionSquare; color: string; label: string }> = {
  function: { icon: FunctionSquare, color: 'text-blue-500', label: '函数' },
  method: { icon: FunctionSquare, color: 'text-purple-500', label: '方法' },
  class: { icon: Boxes, color: 'text-amber-500', label: '类' },
  interface: { icon: Type, color: 'text-green-500', label: '接口' },
  type: { icon: Type, color: 'text-teal-500', label: '类型' },
  enum: { icon: Braces, color: 'text-orange-500', label: '枚举' },
  const: { icon: Variable, color: 'text-cyan-500', label: '常量' },
  variable: { icon: Variable, color: 'text-slate-500', label: '变量' },
};

const STATUS_CONFIG: Record<SymbolStatus, { label: string; color: string }> = {
  unstudied: { label: '未学习', color: 'text-muted-foreground' },
  studying: { label: '学习中', color: 'text-status-running' },
  studied: { label: '已学', color: 'text-status-active' },
};

interface SymbolFilterInputProps {
  query: string;
  onQueryChange: (query: string) => void;
  kinds: Set<SymbolKind>;
  onToggleKind: (kind: SymbolKind) => void;
  statuses: Set<SymbolStatus>;
  onToggleStatus: (status: SymbolStatus) => void;
  onClearAll: () => void;
  hasActiveFilters: boolean;
  totalCount: number;
  filteredCount: number;
}

export function SymbolFilterInput({
  query,
  onQueryChange,
  kinds,
  onToggleKind,
  statuses,
  onToggleStatus,
  onClearAll,
  hasActiveFilters,
  totalCount,
  filteredCount,
}: SymbolFilterInputProps) {
  return (
    <div className="space-y-2 mb-3">
      {/* Search input */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={e => onQueryChange(e.target.value)}
          placeholder="过滤符号..."
          className="w-full h-8 pl-8 pr-8 text-xs rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-brand/40 transition-all"
        />
        {hasActiveFilters && (
          <button
            onClick={onClearAll}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            title="清除所有过滤"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {/* Kind filter chips */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1 scrollbar-thin">
        {(Object.keys(KIND_CONFIG) as SymbolKind[]).map(kind => {
          const config = KIND_CONFIG[kind];
          const Icon = config.icon;
          const isActive = kinds.has(kind);
          return (
            <button
              key={kind}
              onClick={() => onToggleKind(kind)}
              className={cn(
                'inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded-md border transition-all shrink-0',
                isActive
                  ? 'bg-brand/10 border-brand/40 text-brand'
                  : 'bg-background border-border/40 text-muted-foreground hover:border-brand/30 hover:text-foreground',
              )}
              role="checkbox"
              aria-checked={isActive}
            >
              <Icon className={cn('size-2.5', config.color)} />
              <span>{config.label}</span>
            </button>
          );
        })}
      </div>

      {/* Status filter chips */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1 scrollbar-thin">
        {(Object.keys(STATUS_CONFIG) as SymbolStatus[]).map(status => {
          const config = STATUS_CONFIG[status];
          const isActive = statuses.has(status);
          return (
            <button
              key={status}
              onClick={() => onToggleStatus(status)}
              className={cn(
                'inline-flex items-center px-2 py-0.5 text-[10px] rounded-md border transition-all shrink-0',
                isActive
                  ? 'bg-brand/10 border-brand/40 text-brand'
                  : 'bg-background border-border/40 text-muted-foreground hover:border-brand/30 hover:text-foreground',
              )}
              role="checkbox"
              aria-checked={isActive}
            >
              <span className={config.color}>{config.label}</span>
            </button>
          );
        })}
      </div>

      {/* Filter results count */}
      {hasActiveFilters && (
        <div className="text-[10px] text-muted-foreground">
          显示 {filteredCount} / {totalCount} 个符号
        </div>
      )}
    </div>
  );
}
