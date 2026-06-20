import { useImports } from '@/hooks/useImports';
import { cn } from '@/lib/cn';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  ArrowRight,
  ArrowLeft,
  Loader2,
  AlertCircle,
  Package,
  FileCode,
  ExternalLink,
  Globe,
  Boxes,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ImportEntry, ImportedByEntry, ImportKind } from '@/data/types';

const kindConfig: Record<ImportKind, { icon: typeof FileCode; label: string; color: string }> = {
  relative: { icon: FileCode, label: '相对路径', color: 'text-blue-500' },
  alias: { icon: ArrowRight, label: '路径别名', color: 'text-purple-500' },
  package: { icon: Package, label: 'NPM 包', color: 'text-green-500' },
  node: { icon: Boxes, label: 'Node 内置', color: 'text-amber-500' },
};

interface ImportsPanelProps {
  filePath: string | null;
}

export function ImportsPanel({ filePath }: ImportsPanelProps) {
  const { imports, importedBy, loading, error } = useImports(filePath);

  return (
    <Card className="flex-1 min-h-0 overflow-hidden">
      <CardContent className="pt-5 flex-1 min-h-0 flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">导入关系</h3>
          {loading && <Loader2 className="size-3.5 animate-spin text-brand" />}
        </div>

        {error && (
          <div className="flex items-center gap-2 text-status-error mb-2">
            <AlertCircle className="size-3.5" />
            <span className="text-xs">{error}</span>
          </div>
        )}

        <Tabs defaultValue="imports" className="flex-1 min-h-0">
          <TabsList className="w-full h-7">
            <TabsTrigger value="imports" className="flex-1 text-xs gap-1">
              <ArrowRight className="size-3" />
              导入 ({imports.length})
            </TabsTrigger>
            <TabsTrigger value="importedBy" className="flex-1 text-xs gap-1">
              <ArrowLeft className="size-3" />
              被导入 ({importedBy.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="imports" className="mt-0 flex-1 min-h-0">
            {imports.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">无导入</p>
            ) : (
              <ScrollArea className="flex-1 min-h-0">
                <div className="space-y-0.5">
                  {imports.map((imp, i) => (
                    <ImportItem key={`${imp.file}-${i}`} entry={imp} />
                  ))}
                </div>
              </ScrollArea>
            )}
          </TabsContent>

          <TabsContent value="importedBy" className="mt-0 flex-1 min-h-0">
            {importedBy.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">无文件导入此文件</p>
            ) : (
              <ScrollArea className="flex-1 min-h-0">
                <div className="space-y-0.5">
                  {importedBy.map((entry, i) => (
                    <ImportedByItem key={`${entry.file}-${i}`} entry={entry} />
                  ))}
                </div>
              </ScrollArea>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function ImportItem({ entry }: { entry: ImportEntry }) {
  const config = kindConfig[entry.kind];
  const Icon = config.icon;
  const isLocalFile = entry.kind === 'relative' || entry.kind === 'alias';

  const content = (
    <div className="flex items-start gap-2">
      <Icon className={cn('size-3 shrink-0 mt-0.5', config.color)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-mono text-foreground truncate">
            {entry.file.split('/').pop() || entry.file}
          </span>
          <Badge variant="secondary" className="text-[9px] px-1 h-3.5 shrink-0">
            {config.label}
          </Badge>
        </div>
        <p className="text-[10px] text-muted-foreground truncate font-mono">{entry.file}</p>
        {entry.symbols.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {entry.symbols.slice(0, 6).map(s => (
              <span key={s} className="text-[9px] bg-surface-2 px-1 rounded font-mono text-muted-foreground">
                {s}
              </span>
            ))}
            {entry.symbols.length > 6 && (
              <span className="text-[9px] text-muted-foreground">+{entry.symbols.length - 6}</span>
            )}
          </div>
        )}
      </div>
      {isLocalFile && (
        <ExternalLink className="size-3 shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground transition-opacity mt-0.5" />
      )}
    </div>
  );

  if (isLocalFile) {
    return (
      <Link to={`/file/${entry.file}`} className="block rounded-md px-2 py-1.5 hover:bg-accent transition-colors group">
        {content}
      </Link>
    );
  }

  return <div className="rounded-md px-2 py-1.5">{content}</div>;
}

function ImportedByItem({ entry }: { entry: ImportedByEntry }) {
  return (
    <Link
      to={`/file/${entry.file}`}
      className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent transition-colors group"
    >
      <ArrowLeft className="size-3 shrink-0 text-green-500 mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-mono text-foreground truncate">{entry.file.split('/').pop()}</span>
          <span className="text-[10px] text-muted-foreground">L{entry.line}</span>
        </div>
        <p className="text-[10px] text-muted-foreground truncate font-mono">{entry.file}</p>
        {entry.symbols.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {entry.symbols.slice(0, 6).map(s => (
              <span key={s} className="text-[9px] bg-surface-2 px-1 rounded font-mono text-muted-foreground">
                {s}
              </span>
            ))}
          </div>
        )}
      </div>
      <ExternalLink className="size-3 shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground transition-opacity mt-0.5" />
    </Link>
  );
}
