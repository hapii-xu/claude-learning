import { useReferences } from '@/hooks/useReferences';
import { cn } from '@/lib/cn';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ArrowUpRight, ArrowDownRight, Loader2, AlertCircle, FileCode, ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ReferenceLocation, CalleeInfo } from '@/data/types';

interface ReferencesPanelProps {
  filePath: string | null;
  selectedSymbol: string | null;
  onSelectSymbol: (symbol: string) => void;
  availableSymbols: Array<{ name: string; kind: string; line: number }>;
}

export function ReferencesPanel({ filePath, selectedSymbol, onSelectSymbol, availableSymbols }: ReferencesPanelProps) {
  const { callers, callees, loading, error, loadReferences } = useReferences();

  const handleSymbolSelect = (symbolName: string) => {
    if (filePath) {
      loadReferences(filePath, symbolName);
      onSelectSymbol(symbolName);
    }
  };

  return (
    <Card className="flex-1 min-h-0 overflow-hidden">
      <CardContent className="pt-5 flex-1 min-h-0 flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">引用关系</h3>
          {selectedSymbol && (
            <Badge variant="secondary" className="text-[10px] font-mono">
              {selectedSymbol}
            </Badge>
          )}
        </div>

        {/* Symbol selector */}
        {availableSymbols.length > 0 && (
          <div className="mb-3">
            <select
              value={selectedSymbol || ''}
              onChange={e => handleSymbolSelect(e.target.value)}
              className="w-full text-xs rounded-md border bg-background px-2 py-1.5 font-mono"
            >
              <option value="">选择函数/方法...</option>
              {availableSymbols
                .filter(s => s.kind === 'function' || s.kind === 'method')
                .map(s => (
                  <option key={`${s.name}-${s.line}`} value={s.name}>
                    {s.name} (L{s.line})
                  </option>
                ))}
            </select>
          </div>
        )}

        {!selectedSymbol && <p className="text-xs text-muted-foreground">选择一个函数来查看调用关系</p>}

        {selectedSymbol && (
          <Tabs defaultValue="callers" className="flex-1 min-h-0">
            <TabsList className="w-full h-7">
              <TabsTrigger value="callers" className="flex-1 text-xs gap-1">
                <ArrowDownRight className="size-3" />
                调用方 ({callers.length})
              </TabsTrigger>
              <TabsTrigger value="callees" className="flex-1 text-xs gap-1">
                <ArrowUpRight className="size-3" />
                被调方 ({callees.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="callers" className="mt-0 flex-1 min-h-0">
              {loading ? (
                <div className="flex items-center gap-2 py-4 justify-center">
                  <Loader2 className="size-4 animate-spin text-brand" />
                  <span className="text-xs text-muted-foreground">搜索中...</span>
                </div>
              ) : error ? (
                <div className="flex items-center gap-2 py-2 text-status-error">
                  <AlertCircle className="size-3.5" />
                  <span className="text-xs">{error}</span>
                </div>
              ) : callers.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">未找到外部调用</p>
              ) : (
                <ScrollArea className="flex-1 min-h-0">
                  <div className="space-y-1">
                    {callers.map((caller, i) => (
                      <CallerItem key={`${caller.file}-${caller.line}-${i}`} caller={caller} />
                    ))}
                  </div>
                </ScrollArea>
              )}
            </TabsContent>

            <TabsContent value="callees" className="mt-0 flex-1 min-h-0">
              {loading ? (
                <div className="flex items-center gap-2 py-4 justify-center">
                  <Loader2 className="size-4 animate-spin text-brand" />
                  <span className="text-xs text-muted-foreground">分析中...</span>
                </div>
              ) : callees.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">未检测到函数调用</p>
              ) : (
                <ScrollArea className="flex-1 min-h-0">
                  <div className="space-y-1">
                    {callees.map((callee, i) => (
                      <CalleeItem key={`${callee.name}-${callee.line}-${i}`} callee={callee} />
                    ))}
                  </div>
                </ScrollArea>
              )}
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
    </Card>
  );
}

function CallerItem({ caller }: { caller: ReferenceLocation }) {
  return (
    <Link
      to={`/file/${caller.file}#L${caller.line}`}
      className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent transition-colors group"
    >
      <FileCode className="size-3 shrink-0 text-muted-foreground mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-mono text-foreground truncate">{caller.file.split('/').pop()}</span>
          <span className="text-[10px] text-muted-foreground">L{caller.line}</span>
        </div>
        {caller.enclosingSymbol && (
          <span className="text-[10px] text-muted-foreground">
            in <span className="text-brand">{caller.enclosingSymbol}</span>
          </span>
        )}
        <p className="text-[10px] text-muted-foreground truncate mt-0.5 font-mono">{caller.snippet}</p>
      </div>
      <ExternalLink className="size-3 shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground transition-opacity mt-0.5" />
    </Link>
  );
}

function CalleeItem({ callee }: { callee: CalleeInfo }) {
  const content = (
    <div className="flex items-center gap-2">
      <ArrowUpRight className="size-3 shrink-0 text-purple-500" />
      <span className="text-xs font-mono text-foreground truncate">{callee.name}</span>
      {callee.file && (
        <span className="text-[10px] text-muted-foreground truncate">
          {callee.file === '' ? '本文件' : callee.file.split('/').pop()}
        </span>
      )}
      <span className="text-[10px] text-muted-foreground ml-auto">L{callee.line}</span>
    </div>
  );

  if (callee.file && callee.file !== '') {
    return (
      <Link to={`/file/${callee.file}`} className="block rounded-md px-2 py-1.5 hover:bg-accent transition-colors">
        {content}
      </Link>
    );
  }

  return <div className="rounded-md px-2 py-1.5 text-muted-foreground">{content}</div>;
}
