import { useMemo } from 'react';
import { useSymbols } from '@/hooks/useSymbols';
import { useLearningProgress } from '@/hooks/useLearningProgress';
import { useSymbolFilter } from '@/hooks/useSymbolFilter';
import { useSymbolNoteDrawer } from '@/hooks/useSymbolNoteDrawer';
import { cn } from '@/lib/cn';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { SymbolFilterInput } from './SymbolFilterInput';
import { SymbolFlatItem } from './SymbolFlatItem';
import { Loader2, AlertCircle } from 'lucide-react';
import type { SymbolInfo } from '@/data/types';
import type { SymbolStatus } from '@/hooks/useLearningProgress';

interface SymbolListProps {
  filePath: string | null;
  onSelectSymbol?: (symbol: SymbolInfo) => void;
  selectedSymbol?: string | null;
  onExplainSymbol?: (symbol: SymbolInfo) => void;
}

export function SymbolList({ filePath, onSelectSymbol, selectedSymbol, onExplainSymbol }: SymbolListProps) {
  const { symbols, loading, error } = useSymbols(filePath);
  const progress = useLearningProgress(filePath);
  const symbolNoteDrawer = useSymbolNoteDrawer();

  // Build progress map for filtering
  const progressMap = useMemo(() => {
    const map = new Map<string, { status: SymbolStatus; completed: boolean }>();
    for (const sym of symbols) {
      map.set(sym.name, {
        status: progress.getStatus(sym.name),
        completed: progress.getCompleted(sym.name),
      });
    }
    return map;
  }, [symbols, progress]);

  // Symbol filtering
  const { query, setQuery, kinds, toggleKind, statuses, toggleStatus, filtered, clearAll, hasActiveFilters } =
    useSymbolFilter(symbols, progressMap);

  if (loading) {
    return (
      <Card className="flex-1 min-h-0 overflow-hidden">
        <CardContent className="pt-4 flex-1 min-h-0 flex flex-col">
          <div className="flex items-center gap-2 mb-3">
            <Loader2 className="size-4 animate-spin text-brand" />
            <span className="text-sm font-semibold">解析符号中...</span>
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="flex-1 min-h-0 overflow-hidden">
        <CardContent className="pt-4 flex-1 min-h-0 flex flex-col">
          <div className="flex items-center gap-2 text-status-error">
            <AlertCircle className="size-4" />
            <span className="text-sm">{error}</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (symbols.length === 0) {
    return (
      <Card className="flex-1 min-h-0 overflow-hidden">
        <CardContent className="pt-4 flex-1 min-h-0 flex flex-col">
          <p className="text-sm text-muted-foreground">未检测到符号</p>
        </CardContent>
      </Card>
    );
  }

  // File-level progress stats
  const allStats = progress.stats();

  return (
    <Card className="flex-1 min-h-0 overflow-hidden">
      <CardContent className="pt-4 flex-1 min-h-0 flex flex-col">
        {/* Header with overall progress */}
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1.5">
            <h3 className="text-sm font-semibold text-foreground">符号列表</h3>
            <Badge variant="secondary" className="text-[10px]">
              {symbols.length}
            </Badge>
          </div>

          {/* File progress bar */}
          {allStats.total > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>
                  学习进度 <span className="text-status-active font-medium">{allStats.studied}</span>/{allStats.total}
                  {allStats.studying > 0 && (
                    <span className="ml-1 text-status-running">({allStats.studying} 学习中)</span>
                  )}
                  {allStats.completed > 0 && (
                    <span className="ml-1 text-brand font-medium">· {allStats.completed} 已完成</span>
                  )}
                </span>
                <span className="font-mono">{Math.round((allStats.studied / allStats.total) * 100)}%</span>
              </div>
              <div className="h-1 rounded-full bg-surface-2 overflow-hidden flex">
                <div
                  className="bg-status-active transition-all duration-300"
                  style={{ width: `${(allStats.studied / allStats.total) * 100}%` }}
                />
                <div
                  className="bg-status-running transition-all duration-300"
                  style={{ width: `${(allStats.studying / allStats.total) * 100}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Filter input */}
        <SymbolFilterInput
          query={query}
          onQueryChange={setQuery}
          kinds={kinds}
          onToggleKind={toggleKind}
          statuses={statuses}
          onToggleStatus={toggleStatus}
          onClearAll={clearAll}
          hasActiveFilters={hasActiveFilters}
          totalCount={symbols.length}
          filteredCount={filtered.length}
        />

        {/* Flat symbol list */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-0">
            {filtered.map((sym, i) => {
              const status = progress.getStatus(sym.name);
              const note = progress.getNote(sym.name);
              const completed = progress.getCompleted(sym.name);

              return (
                <SymbolFlatItem
                  key={`${sym.name}-${sym.line}-${i}`}
                  symbol={sym}
                  status={status}
                  completed={completed}
                  note={note}
                  isSelected={selectedSymbol === sym.name}
                  onClick={() => {
                    onSelectSymbol?.(sym);
                    // Open note drawer when clicking symbol
                    if (filePath) {
                      symbolNoteDrawer.openForSymbol(filePath, sym);
                    }
                  }}
                  onStatusToggle={() => progress.toggleStatus(sym.name)}
                  onCompletedToggle={() => progress.toggleCompleted(sym.name)}
                  onNoteClick={() => {
                    // Open note drawer when clicking note icon
                    if (filePath) {
                      symbolNoteDrawer.openForSymbol(filePath, sym);
                    }
                  }}
                  onExplain={onExplainSymbol ? () => onExplainSymbol(sym) : undefined}
                />
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
