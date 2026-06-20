import { useEffect, useRef, useState, useCallback } from 'react';
import { cn } from '@/lib/cn';
import { Loader2, Copy, Check, Pencil, CheckCircle2 } from 'lucide-react';
import type { LineAnnotation, SymbolInfo } from '@/data/types';
import type { SymbolStatus } from '@/hooks/useLearningProgress';
import { useGlossaryHighlight } from '@/hooks/useGlossaryHighlight';
import { useSymbolHighlight } from '@/hooks/useSymbolHighlight';
import { useAnnotationHighlight } from '@/hooks/useAnnotationHighlight';
import { useTextSelection } from '@/hooks/useTextSelection';
import { rangeToAnnotationCoords, type AnnotationCoords } from '@/components/code/selectionUtils';

const ANNOTATION_DOT_COLORS: Record<string, string> = {
  yellow: 'bg-yellow-400',
  red: 'bg-red-400',
  blue: 'bg-blue-400',
  green: 'bg-green-400',
};

const SYMBOL_STATUS_COLORS: Record<SymbolStatus, string> = {
  unstudied: '',
  studying: 'bg-status-running',
  studied: 'bg-status-active',
};

interface CodeViewerProps {
  code: string;
  language?: string;
  filePath?: string;
  className?: string;
  /** 高亮行号（1-based） */
  highlightLine?: number | null;
  /** 行点击回调 */
  onLineClick?: (line: number) => void;
  /** 切换到编辑模式 */
  onEdit?: () => void;
  /** 行级标注列表 */
  annotations?: LineAnnotation[];
  /** 点击"+"按钮添加标注 */
  onAddAnnotation?: (line: number) => void;
  /** 点击已有标注圆点（整行标注） */
  onAnnotationClick?: (annotation: LineAnnotation) => void;
  /** 点击已有区间标注高亮 */
  onRangeAnnotationClick?: (annotation: LineAnnotation, rect: DOMRect) => void;
  /** 文本选区变化（在代码容器内） */
  onTextSelection?: (coords: AnnotationCoords, rect: DOMRect, range: Range) => void;
  /** 选区清除 */
  onSelectionClear?: () => void;
  /** 符号列表 */
  symbols?: SymbolInfo[];
  /** 符号状态映射 */
  symbolStatusMap?: Map<string, SymbolStatus>;
  /** 符号完成状态映射 */
  symbolCompletedMap?: Map<string, boolean>;
  /** 点击符号回调 */
  onSymbolClick?: (symbol: SymbolInfo) => void;
  /** 悬停符号回调 */
  onSymbolHover?: (symbol: SymbolInfo, rect: DOMRect) => void;
  /** 离开符号回调 */
  onSymbolLeave?: () => void;
}

export function CodeViewer({
  code,
  language = 'typescript',
  filePath,
  className,
  highlightLine,
  onLineClick,
  onEdit,
  annotations = [],
  onAddAnnotation,
  onAnnotationClick,
  symbols = [],
  symbolStatusMap = new Map(),
  symbolCompletedMap = new Map(),
  onSymbolClick,
  onSymbolHover,
  onSymbolLeave,
  onRangeAnnotationClick,
  onTextSelection,
  onSelectionClear,
}: CodeViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const highlightGlossary = useGlossaryHighlight();
  const highlightSymbols = useSymbolHighlight();
  const highlightAnnotations = useAnnotationHighlight();
  // Wire selection callbacks directly — avoids stale-active-state miss when user re-selects
  const onSelectStable = useCallback(
    (rect: DOMRect, range: Range) => {
      const codeEl = scrollRef.current?.querySelector('.code-viewer.shiki-themes') as HTMLElement | null;
      if (!codeEl) return;
      const coords = rangeToAnnotationCoords(range, codeEl);
      if (coords) onTextSelection?.(coords, rect, range);
    },
    [onTextSelection],
  );
  const onClearStable = useCallback(() => onSelectionClear?.(), [onSelectionClear]);
  useTextSelection(scrollRef, onSelectStable, onClearStable);

  useEffect(() => {
    let cancelled = false;

    async function highlight() {
      setLoading(true);
      try {
        const { codeToHtml } = await import('shiki');
        const html = await codeToHtml(code, {
          lang: language,
          themes: {
            light: 'github-light',
            dark: 'github-dark',
          },
        });
        if (!cancelled) {
          setHighlighted(html);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setHighlighted(null);
          setLoading(false);
        }
      }
    }

    highlight();
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  // Scroll to highlighted line
  useEffect(() => {
    if (highlightLine && scrollRef.current) {
      const lineEl = scrollRef.current.querySelector(`[data-line="${highlightLine}"]`);
      if (lineEl) {
        lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [highlightLine]);

  // Glossary term highlighting — runs after Shiki HTML is rendered
  useEffect(() => {
    if (!highlighted || !scrollRef.current) return;
    const codeEl = scrollRef.current.querySelector('.code-viewer.shiki-themes');
    highlightGlossary(codeEl as HTMLElement);
  }, [highlighted, highlightGlossary]);

  // Symbol highlighting — runs after Shiki HTML is rendered
  useEffect(() => {
    if (!highlighted || !scrollRef.current || symbols.length === 0) return;
    const codeEl = scrollRef.current.querySelector('.code-viewer.shiki-themes');
    highlightSymbols(codeEl as HTMLElement, symbols, symbolStatusMap);
  }, [highlighted, symbols, symbolStatusMap, highlightSymbols]);

  // Range annotation highlighting — runs after Shiki HTML is rendered
  useEffect(() => {
    if (!highlighted || !scrollRef.current) return;
    const codeEl = scrollRef.current.querySelector('.code-viewer.shiki-themes') as HTMLElement;
    highlightAnnotations(codeEl, annotations ?? []);
  }, [highlighted, annotations, highlightAnnotations]);

  const lines = code.split('\n');

  // Build a map: lineNum → annotations that cover it
  const annotationsByLine = useCallback(
    (lineNum: number): LineAnnotation[] => annotations.filter(a => lineNum >= a.startLine && lineNum <= a.endLine),
    [annotations],
  );

  // Build a map: lineNum → symbols that start at this line
  const symbolsByLine = useCallback(
    (lineNum: number): SymbolInfo[] => symbols.filter(s => s.line === lineNum),
    [symbols],
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  }, [code]);

  // Event delegation for symbol hover/click
  const handleCodeMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!onSymbolHover || symbols.length === 0) return;

      const target = e.target as HTMLElement;
      const symbolSpan = target.closest('[data-symbol-name]') as HTMLElement;

      if (symbolSpan) {
        const symbolName = symbolSpan.getAttribute('data-symbol-name');
        const symbol = symbols.find(s => s.name === symbolName);
        if (symbol) {
          const rect = symbolSpan.getBoundingClientRect();
          onSymbolHover(symbol, rect);
        }
      } else {
        onSymbolLeave?.();
      }
    },
    [onSymbolHover, onSymbolLeave, symbols],
  );

  const handleCodeClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;

      // Check for range annotation click first
      const annotSpan = target.closest('[data-annotation-id]') as HTMLElement | null;
      if (annotSpan && onRangeAnnotationClick) {
        const id = annotSpan.getAttribute('data-annotation-id');
        const ann = (annotations ?? []).find(a => a.id === id);
        if (ann) {
          e.preventDefault();
          e.stopPropagation();
          onRangeAnnotationClick(ann, annotSpan.getBoundingClientRect());
          return;
        }
      }

      if (!onSymbolClick || symbols.length === 0) return;

      const symbolSpan = target.closest('[data-symbol-name]') as HTMLElement;

      if (symbolSpan) {
        e.preventDefault();
        e.stopPropagation();
        const symbolName = symbolSpan.getAttribute('data-symbol-name');
        const symbol = symbols.find(s => s.name === symbolName);
        if (symbol) {
          onSymbolClick(symbol);
        }
      }
    },
    [onSymbolClick, symbols, onRangeAnnotationClick, annotations],
  );

  return (
    <div className={cn('relative rounded-xl border bg-code-bg overflow-hidden', className)}>
      {/* Header bar */}
      {filePath && (
        <div className="flex items-center justify-between px-4 py-2 border-b bg-surface-1/50">
          <span className="text-xs font-mono text-muted-foreground truncate">{filePath}</span>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">{lines.length} lines</span>
            <button
              onClick={handleCopy}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="复制代码"
            >
              {copied ? <Check className="size-3.5 text-status-active" /> : <Copy className="size-3.5" />}
            </button>
            {onEdit && (
              <button
                onClick={onEdit}
                className="text-muted-foreground hover:text-brand transition-colors"
                title="编辑文件"
              >
                <Pencil className="size-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Highlighted code with gutter */}
      {highlighted && !loading && (
        <div ref={scrollRef} className="overflow-x-auto overflow-y-hidden">
          <div className="flex min-w-fit">
            {/* Line number gutter — sticky left */}
            <div className="sticky left-0 z-10 bg-code-bg shrink-0 select-none border-r border-border/10">
              {lines.map((_, i) => {
                const lineNum = i + 1;
                const isHighlighted = highlightLine === lineNum;
                const lineAnnotations = annotationsByLine(lineNum);
                const lineSymbols = symbolsByLine(lineNum);
                return (
                  <div
                    key={i}
                    data-line={lineNum}
                    className={cn(
                      'code-viewer text-right pr-3 group relative flex items-center justify-end gap-1',
                      isHighlighted && 'bg-code-line-active',
                    )}
                  >
                    {/* Symbol status indicators */}
                    {lineSymbols.length > 0 && (
                      <span className="flex items-center gap-0.5 mr-1">
                        {lineSymbols.map(sym => {
                          const status = symbolStatusMap.get(sym.name) || 'unstudied';
                          const completed = symbolCompletedMap.get(sym.name) || false;
                          return (
                            <span
                              key={sym.name}
                              className="relative"
                              title={`${sym.name} — ${status === 'unstudied' ? '未学习' : status === 'studying' ? '学习中' : '已学'}${completed ? ' (已完成)' : ''}`}
                            >
                              {completed ? (
                                <CheckCircle2 className="size-2.5 text-brand fill-brand/20" />
                              ) : status === 'studying' ? (
                                <span className="inline-block size-2 rounded-full bg-status-running" />
                              ) : status === 'studied' ? (
                                <span className="inline-block size-2 rounded-full bg-status-active" />
                              ) : null}
                            </span>
                          );
                        })}
                      </span>
                    )}
                    {/* Annotation dots */}
                    {lineAnnotations.length > 0 && (
                      <span className="flex items-center gap-0.5 mr-1">
                        {lineAnnotations.map(ann => (
                          <span
                            key={ann.id}
                            className={cn(
                              'inline-block size-2 rounded-full cursor-pointer',
                              ANNOTATION_DOT_COLORS[ann.color] ?? 'bg-gray-400',
                            )}
                            onClick={() => onAnnotationClick?.(ann)}
                            title={ann.comment}
                          />
                        ))}
                      </span>
                    )}
                    {/* Add annotation "+" button */}
                    {onAddAnnotation && (
                      <button
                        className="absolute left-0.5 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-brand opacity-0 group-hover:opacity-100 transition-opacity text-[10px] leading-none"
                        onClick={() => onAddAnnotation(lineNum)}
                        title={`在 L${lineNum} 添加标注`}
                      >
                        +
                      </button>
                    )}
                    <span
                      className={cn(
                        'tabular-nums cursor-pointer transition-colors',
                        isHighlighted ? 'text-brand font-medium' : 'text-muted-foreground/50 hover:text-brand',
                      )}
                      onClick={() => onLineClick?.(lineNum)}
                    >
                      {lineNum}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Shiki rendered code */}
            <div className="flex-1 min-w-0">
              <div
                className="code-viewer shiki-themes"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki 本地生成的可信高亮 HTML
                dangerouslySetInnerHTML={{ __html: highlighted }}
                onMouseMove={handleCodeMouseMove}
                onClick={handleCodeClick}
                onMouseLeave={onSymbolLeave}
              />
            </div>
          </div>
        </div>
      )}

      {/* Fallback: plain code with gutter */}
      {!highlighted && !loading && (
        <div ref={scrollRef} className="overflow-x-auto">
          <div className="flex min-w-fit">
            {/* Line number gutter */}
            <div className="sticky left-0 z-10 bg-code-bg shrink-0 select-none border-r border-border/10">
              {lines.map((_, i) => {
                const lineNum = i + 1;
                const isHighlighted = highlightLine === lineNum;
                const lineAnnotations = annotationsByLine(lineNum);
                return (
                  <div
                    key={i}
                    data-line={lineNum}
                    className={cn(
                      'code-viewer text-right pr-3 group relative flex items-center justify-end gap-1',
                      isHighlighted && 'bg-code-line-active',
                    )}
                  >
                    {/* Annotation dots */}
                    {lineAnnotations.length > 0 && (
                      <span className="flex items-center gap-0.5 mr-1">
                        {lineAnnotations.map(ann => (
                          <span
                            key={ann.id}
                            className={cn(
                              'inline-block size-2 rounded-full cursor-pointer',
                              ANNOTATION_DOT_COLORS[ann.color] ?? 'bg-gray-400',
                            )}
                            onClick={() => onAnnotationClick?.(ann)}
                            title={ann.comment}
                          />
                        ))}
                      </span>
                    )}
                    {/* Add annotation "+" button */}
                    {onAddAnnotation && (
                      <button
                        className="absolute left-0.5 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-brand opacity-0 group-hover:opacity-100 transition-opacity text-[10px] leading-none"
                        onClick={() => onAddAnnotation(lineNum)}
                        title={`在 L${lineNum} 添加标注`}
                      >
                        +
                      </button>
                    )}
                    <span
                      className={cn(
                        'tabular-nums cursor-pointer transition-colors',
                        isHighlighted ? 'text-brand font-medium' : 'text-muted-foreground/50 hover:text-brand',
                      )}
                      onClick={() => onLineClick?.(lineNum)}
                    >
                      {lineNum}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Plain code */}
            <div className="flex-1 min-w-0">
              <pre className="code-viewer whitespace-pre">
                {lines.map((line, i) => {
                  const lineNum = i + 1;
                  const isHighlighted = highlightLine === lineNum;
                  return (
                    <div
                      key={i}
                      data-line={lineNum}
                      className={cn('code-viewer', isHighlighted && 'bg-code-line-active')}
                    >
                      {line || '\u00A0'}
                    </div>
                  );
                })}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
