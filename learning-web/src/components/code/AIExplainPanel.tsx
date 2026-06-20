import { useState, useEffect, useCallback } from 'react';
import { Sparkles, X, Save, RefreshCw, AlertCircle, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MarkdownNote } from '@/components/notes/MarkdownNote';
import { explainCode, updateProgress } from '@/lib/api';
import type { ExplainKind, ExplainResponse } from '@/data/types';
import { cn } from '@/lib/cn';

interface AIExplainPanelProps {
  kind: ExplainKind;
  filePath: string;
  symbolName?: string;
  onClose: () => void;
}

export function AIExplainPanel({ kind, filePath, symbolName, onClose }: AIExplainPanelProps) {
  const [data, setData] = useState<ExplainResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const result = await explainCode({ kind, filePath, symbolName });
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI 调用失败');
    } finally {
      setLoading(false);
    }
  }, [kind, filePath, symbolName]);

  useEffect(() => {
    run();
  }, [run]);

  const handleSaveAsNote = async () => {
    if (!data || !symbolName) return;
    const key = `${filePath}::${symbolName}`;
    const tagged = `> 🤖 AI 解读（${data.model}）\n\n${data.explanation}`;
    try {
      await updateProgress(key, 'studying', tagged);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      // silent
    }
  };

  const title = kind === 'file' ? '文件解读' : `符号 · ${symbolName}`;
  const usage = data?.usage;
  const cacheHitRate =
    usage && usage.cache_read + usage.cache_creation > 0
      ? Math.round((usage.cache_read / (usage.cache_read + usage.cache_creation)) * 100)
      : 0;

  return (
    <Card className="flex-1 min-h-0 overflow-hidden border-brand/30">
      <CardContent className="pt-3 pb-3 px-3 flex-1 min-h-0 flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-1.5 mb-2 shrink-0">
          <Sparkles className="size-3.5 text-brand" />
          <h3 className="text-sm font-semibold truncate flex-1">{title}</h3>
          <Button variant="ghost" size="icon" className="size-6" onClick={run} disabled={loading} title="重新生成">
            <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          </Button>
          <Button variant="ghost" size="icon" className="size-6" onClick={onClose} title="关闭">
            <X className="size-3.5" />
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 flex flex-col">
          {loading && !data ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
              <span className="text-xs">Claude 正在解读…</span>
            </div>
          ) : error ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-3">
              <AlertCircle className="size-5 text-status-error" />
              <p className="text-xs text-status-error">{error}</p>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={run}>
                重试
              </Button>
            </div>
          ) : data ? (
            <>
              <ScrollArea className="flex-1 min-h-0 pr-1">
                <MarkdownNote content={data.explanation} className="text-xs" compact />
                {data.truncated && (
                  <div className="mt-2 text-[10px] text-muted-foreground italic">
                    （文件过大已截断，解读基于前段内容）
                  </div>
                )}
              </ScrollArea>

              {/* Footer */}
              <div className="mt-2 pt-2 border-t flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
                {usage && (
                  <>
                    <Badge variant="secondary" className="text-[9px] h-4 px-1">
                      ↓{usage.input_tokens} ↑{usage.output_tokens}
                    </Badge>
                    {usage.cache_read > 0 && (
                      <Badge variant="outline" className="text-[9px] h-4 px-1 text-status-active">
                        cache {cacheHitRate}%
                      </Badge>
                    )}
                  </>
                )}
                {kind === 'symbol' && symbolName && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn('ml-auto h-6 text-[10px] gap-1', saved && 'text-status-active')}
                    onClick={handleSaveAsNote}
                    disabled={saved}
                  >
                    <Save className="size-2.5" />
                    {saved ? '已保存为笔记' : '保存为笔记'}
                  </Button>
                )}
              </div>
            </>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
