import { useParams } from 'react-router-dom';
import { useEffect, useState, useMemo, useCallback } from 'react';
import { useFileContent } from '@/hooks/useFileContent';
import { useAnnotations } from '@/hooks/useAnnotations';
import { useSymbols } from '@/hooks/useSymbols';
import { useSymbolNoteDrawer } from '@/hooks/useSymbolNoteDrawer';
import { CodeViewer } from '@/components/code/CodeViewer';
import { CodeEditor } from '@/components/code/CodeEditor';
import { AIExplainPanel } from '@/components/code/AIExplainPanel';
import { AnnotationPopover } from '@/components/code/AnnotationPopover';
import { AnnotationToolbar } from '@/components/code/AnnotationToolbar';
import { SelectionOverlay } from '@/components/code/SelectionOverlay';
import { SymbolHoverTooltip } from '@/components/code/SymbolHoverTooltip';
import type { AnnotationCoords } from '@/components/code/selectionUtils';
import { SymbolList } from '@/components/symbols/SymbolList';
import { FileNotePanel } from '@/components/code/FileNotePanel';
import { SymbolNoteDrawer } from '@/components/notes/SymbolNoteDrawer';
import { useLearningProgress } from '@/hooks/useLearningProgress';
import { ReferencesPanel } from '@/components/symbols/ReferencesPanel';
import { ImportsPanel } from '@/components/symbols/ImportsPanel';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { PageSkeleton } from '@/components/ui/skeleton';
import { findModuleByFilePath, modules } from '@/data/modules';
import { Link, useNavigate } from 'react-router-dom';
import { runExec, writeFile } from '@/lib/api';
import { useConsole } from '@/hooks/useConsole';
import type { LineAnnotation, SymbolInfo } from '@/data/types';
import {
  FileCode,
  Folder,
  ArrowRight,
  AlertCircle,
  Package,
  Calendar,
  HardDrive,
  GitCompare,
  Play,
  Pencil,
  Eye,
  Sparkles,
  MessageCircle,
  Bookmark,
} from 'lucide-react';

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    json: 'json',
    md: 'markdown',
    mdx: 'mdx',
    css: 'css',
    html: 'html',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    sh: 'bash',
    bash: 'bash',
    py: 'python',
    rs: 'rust',
    go: 'go',
    sql: 'sql',
    graphql: 'graphql',
    dockerfile: 'dockerfile',
  };
  return langMap[ext] || 'text';
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileViewerPage() {
  const { '*': filePath } = useParams<{ '*': string }>();
  const { data, loading, error } = useFileContent(filePath || null);
  const mod = filePath ? findModuleByFilePath(filePath) : undefined;
  const navigate = useNavigate();
  const { setTab, setOpen, openChat } = useConsole();

  // URL hash → highlightLine
  const [highlightLine, setHighlightLine] = useState<number | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [isBookmarked, setIsBookmarked] = useState(false);
  const [bookmarkLoading, setBookmarkLoading] = useState(false);
  const [annotationTarget, setAnnotationTarget] = useState<number | null>(null);
  // Range annotation toolbar state
  const [selectionDraft, setSelectionDraft] = useState<{
    rect: DOMRect;
    coords: AnnotationCoords;
    range: Range;
    initialRects: DOMRect[];
  } | null>(null);
  const [activeRangeAnnotation, setActiveRangeAnnotation] = useState<{
    annotation: LineAnnotation;
    rect: DOMRect;
  } | null>(null);
  // Comment popover target — self-contained so its lifecycle is decoupled
  // from selectionDraft. When the popover's textarea autoFocuses it would
  // collapse the native selection → selectionchange would clear selectionDraft
  // → popover would unmount mid-typing. Storing the captured data here keeps
  // the popover open until the user explicitly saves/cancels.
  const [commentTarget, setCommentTarget] = useState<
    | { kind: 'new'; rect: DOMRect; coords: AnnotationCoords; range: Range; initialRects: DOMRect[] }
    | { kind: 'existing'; annotation: LineAnnotation; rect: DOMRect }
    | null
  >(null);
  const { annotations, addAnnotation, updateAnnotation, removeAnnotation } = useAnnotations(filePath || null);
  const fileProgress = useLearningProgress(filePath || null);
  const { symbols } = useSymbols(filePath || null);
  const symbolNoteDrawer = useSymbolNoteDrawer();
  const [explainTarget, setExplainTarget] = useState<{ kind: 'file' } | { kind: 'symbol'; symbolName: string } | null>(
    null,
  );
  const [hoveredSymbol, setHoveredSymbol] = useState<SymbolInfo | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  // Parse #L42 from URL
  useEffect(() => {
    const hash = window.location.hash;
    const match = hash.match(/^#L(\d+)$/);
    if (match) {
      setHighlightLine(Number(match[1]));
    }
    // Listen for hash changes
    const onHashChange = () => {
      const h = window.location.hash;
      const m = h.match(/^#L(\d+)$/);
      if (m) setHighlightLine(Number(m[1]));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [filePath]);

  // 当 API 解析到实际路径与请求路径不同时（如 .js → .ts），自动修正 URL
  useEffect(() => {
    if (!loading && data && data.path && filePath && data.path !== filePath) {
      const hash = window.location.hash || '';
      navigate(`/file/${data.path}${hash}`, { replace: true });
    }
  }, [data, filePath, navigate, loading]);

  const handleSelectSymbol = (sym: SymbolInfo) => {
    setHighlightLine(sym.line);
    setSelectedSymbol(sym.name);
    // Update URL hash without reload
    window.history.replaceState(null, '', `/file/${filePath}#L${sym.line}`);
    // Open note drawer
    if (filePath) {
      symbolNoteDrawer.openForSymbol(filePath, sym);
    }
  };

  const handleLineClick = (line: number) => {
    setHighlightLine(line);
    window.history.replaceState(null, '', `/file/${filePath}#L${line}`);
    // Copy link to clipboard
    const url = `${window.location.origin}/file/${filePath}#L${line}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // Build symbol status and completed maps for CodeViewer
  const symbolStatusMap = useMemo(() => {
    const map = new Map<string, 'unstudied' | 'studying' | 'studied'>();
    for (const sym of symbols) {
      map.set(sym.name, fileProgress.getStatus(sym.name));
    }
    return map;
  }, [symbols, fileProgress]);

  const symbolCompletedMap = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const sym of symbols) {
      map.set(sym.name, fileProgress.getCompleted(sym.name));
    }
    return map;
  }, [symbols, fileProgress]);

  const handleSymbolHover = useCallback((symbol: SymbolInfo, rect: DOMRect) => {
    setHoveredSymbol(symbol);
    setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top });
  }, []);

  const handleSymbolLeave = useCallback(() => {
    setHoveredSymbol(null);
    setTooltipPos(null);
  }, []);

  const handleSymbolClick = useCallback(
    (symbol: SymbolInfo) => {
      setHighlightLine(symbol.line);
      setSelectedSymbol(symbol.name);
      if (filePath) {
        symbolNoteDrawer.openForSymbol(filePath, symbol);
      }
    },
    [filePath, symbolNoteDrawer],
  );

  const handleRunTests = async () => {
    if (!filePath) return;
    // Guess test path
    const parts = filePath.split('/');
    const fileName = parts.pop();
    if (!fileName) return;
    const baseName = fileName.replace(/\.(tsx?|jsx?)$/, '');
    const dir = parts.join('/');
    const testPath = `${dir}/__tests__/${baseName}.test.ts`;

    setOpen(true);
    setTab('test');
    try {
      await runExec({ cmd: 'test:file', args: { path: testPath } });
    } catch {
      // Test file might not exist
    }
  };

  const handleSaveFile = useCallback(
    async (content: string) => {
      if (!filePath) return;
      await writeFile(filePath, content);
    },
    [filePath],
  );

  const handleExitEdit = useCallback(() => {
    setEditing(false);
  }, []);

  // Stable callbacks for CodeViewer — must be useCallback to prevent infinite re-render loop
  const handleTextSelection = useCallback(
    (coords: AnnotationCoords, rect: DOMRect, range: Range) => {
      const trimmed = coords.selectedText.trim();
      // Single-line exact symbol match → open SymbolNoteDrawer instead of annotation toolbar
      if (coords.startLine === coords.endLine && trimmed.length > 0 && filePath) {
        const matched = symbols.find(s => s.name === trimmed);
        if (matched) {
          symbolNoteDrawer.openForSymbol(filePath, matched);
          window.getSelection()?.removeAllRanges();
          setSelectionDraft(null);
          return;
        }
      }
      // Capture rects at selection time so SelectionOverlay can use them as
      // initial state (no mount flash) and as fallback if the Range is later
      // invalidated by DOM mutation from useAnnotationHighlight.
      const initialRects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
      setActiveRangeAnnotation(null);
      setSelectionDraft({ rect, coords, range, initialRects });
    },
    [symbols, filePath, symbolNoteDrawer],
  );

  const handleSelectionClear = useCallback(() => setSelectionDraft(null), []);

  const handleRangeAnnotationClick = useCallback((ann: LineAnnotation, rect: DOMRect) => {
    // Don't clear selectionDraft here — the user's current text selection
    // (orange ghost) should persist while they view/edit the clicked annotation.
    // The SelectionOverlay survives via its initialRects fallback even if the
    // native selection collapses after the click.
    if (ann.comment && ann.comment.trim().length > 0) {
      setCommentTarget({ kind: 'existing', annotation: ann, rect });
    } else {
      setActiveRangeAnnotation({ annotation: ann, rect });
    }
  }, []);

  const handleRangeClose = useCallback(() => {
    setSelectionDraft(null);
    setActiveRangeAnnotation(null);
  }, []);

  // Build available symbols for the reference panel selector
  const [symbolData, setSymbolData] = useState<Array<{ name: string; kind: string; line: number }>>([]);

  useEffect(() => {
    if (!filePath) return;
    fetch(`/api/symbols?path=${encodeURIComponent(filePath)}`)
      .then(r => r.json())
      .then(d => {
        if (d.symbols) {
          setSymbolData(d.symbols.map((s: SymbolInfo) => ({ name: s.name, kind: s.kind, line: s.line })));
        }
      })
      .catch(() => {});
  }, [filePath]);

  // Check if current file is bookmarked
  useEffect(() => {
    if (!filePath) return;
    fetch(`/api/bookmarks/check?filePath=${encodeURIComponent(filePath)}`)
      .then(r => r.json())
      .then((d: { bookmarked: boolean }) => setIsBookmarked(d.bookmarked))
      .catch(() => setIsBookmarked(false));
  }, [filePath]);

  const handleToggleBookmark = useCallback(async () => {
    if (!filePath || bookmarkLoading) return;
    setBookmarkLoading(true);
    try {
      if (isBookmarked) {
        const res = await fetch(`/api/bookmarks?filePath=${encodeURIComponent(filePath)}`, {
          method: 'DELETE',
        });
        if (res.ok) setIsBookmarked(false);
      } else {
        const res = await fetch('/api/bookmarks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath }),
        });
        if (res.ok) setIsBookmarked(true);
      }
    } finally {
      setBookmarkLoading(false);
    }
  }, [filePath, isBookmarked, bookmarkLoading]);

  if (!filePath) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-12 text-center">
        <AlertCircle className="size-12 text-muted-foreground mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">未指定文件路径</h2>
        <Link to="/" className="text-brand hover:underline">
          返回首页
        </Link>
      </div>
    );
  }

  if (loading) {
    return <PageSkeleton />;
  }

  if (error || !data) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-12 text-center">
        <AlertCircle className="size-12 text-muted-foreground mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">文件加载失败</h2>
        <p className="text-muted-foreground mb-4">{error || '文件未找到'}</p>
        <code className="text-sm bg-surface-2 px-3 py-1.5 rounded-md font-mono">{filePath}</code>
      </div>
    );
  }

  const language = getLanguage(filePath);
  const lineCount = data.content.split('\n').length;
  const fileDir = filePath.split('/').slice(0, -1).join('/');

  const relatedModules = modules
    .filter(
      m =>
        m.id !== mod?.id &&
        m.files.some(f => f.path.startsWith(fileDir) || fileDir.startsWith(f.path.replace(/\/$/, ''))),
    )
    .slice(0, 4);

  return (
    <div className="animate-fade-up">
      <div className="max-w-[1600px] mx-auto px-4 lg:px-6 py-6">
        <Breadcrumbs />

        {/* File Header */}
        <div className="flex items-start gap-4 mb-4">
          <div className="size-9 rounded-lg bg-brand/10 flex items-center justify-center shrink-0 mt-0.5">
            <FileCode className="size-4.5 text-brand" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-foreground font-mono break-all">{filePath}</h1>
            <div className="flex items-center gap-3 mt-1.5 text-sm text-muted-foreground flex-wrap">
              <span className="flex items-center gap-1">
                <HardDrive className="size-3.5" />
                {formatFileSize(data.size)}
              </span>
              <span className="flex items-center gap-1">
                <Folder className="size-3.5" />
                {lineCount} 行
              </span>
              <span className="flex items-center gap-1">
                <Calendar className="size-3.5" />
                {new Date(data.lastModified).toLocaleDateString('zh-CN')}
              </span>
              <Badge variant="secondary">{language}</Badge>
              {highlightLine && <span className="text-xs text-brand font-mono">L{highlightLine}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setExplainTarget({ kind: 'file' })}
              className="flex items-center gap-1.5 text-sm rounded-md border px-3 py-1.5 text-muted-foreground hover:text-brand hover:border-brand/40 hover:bg-brand/5 transition-all"
              title="让 AI 解读这个文件"
            >
              <Sparkles className="size-3.5" />
              AI 解读
            </button>
            <Link
              to={`/chat?file=${filePath}`}
              className="flex items-center gap-1.5 text-sm rounded-md border px-3 py-1.5 text-muted-foreground hover:text-brand hover:border-brand/40 hover:bg-brand/5 transition-all"
              title="在新对话中讨论这个文件"
            >
              <MessageCircle className="size-3.5" />
              提问
            </Link>
            <button
              onClick={handleRunTests}
              className="flex items-center gap-1.5 text-sm rounded-md border px-3 py-1.5 text-muted-foreground hover:text-status-active hover:border-status-active/40 hover:bg-status-active/5 transition-all"
              title="运行此文件的测试"
            >
              <Play className="size-3.5" />
              测试
            </button>
            <Link
              to={`/compare/${filePath}__compare__`}
              className="flex items-center gap-1.5 text-sm rounded-md border px-3 py-1.5 text-muted-foreground hover:text-foreground hover:border-brand/40 hover:bg-accent transition-all"
              title="以此文件为左侧开始对比"
            >
              <GitCompare className="size-3.5" />
              对比
            </Link>
            <button
              onClick={() => setEditing(!editing)}
              className={`flex items-center gap-1.5 text-sm rounded-md border px-3 py-1.5 transition-all ${
                editing
                  ? 'text-brand border-brand/40 bg-brand/5'
                  : 'text-muted-foreground hover:text-foreground hover:border-brand/40 hover:bg-accent'
              }`}
              title={editing ? '切换为查看模式' : '切换为编辑模式'}
            >
              {editing ? <Eye className="size-3.5" /> : <Pencil className="size-3.5" />}
              {editing ? '查看' : '编辑'}
            </button>
            <button
              onClick={handleToggleBookmark}
              disabled={bookmarkLoading}
              className={`flex items-center gap-1.5 text-sm rounded-md border px-3 py-1.5 transition-all ${
                isBookmarked
                  ? 'text-brand border-brand/40 bg-brand/5'
                  : 'text-muted-foreground hover:text-brand hover:border-brand/40 hover:bg-brand/5'
              }`}
              title={isBookmarked ? '取消收藏' : '收藏此文件'}
            >
              <Bookmark className={`size-3.5 ${isBookmarked ? 'fill-current' : ''}`} />
              {isBookmarked ? '已收藏' : '收藏'}
            </button>
          </div>
        </div>

        {/* File note panel: manual completion + file-level notes */}
        <FileNotePanel
          filePath={filePath}
          allStudied={fileProgress.stats().total > 0 && fileProgress.stats().studied === fileProgress.stats().total}
        />

        {/* Three-column layout */}
        <div className="flex gap-4">
          {/* Left: Code Viewer / Editor (main) */}
          <div className="flex-1 min-w-0">
            {editing ? (
              <CodeEditor
                code={data.content}
                language={language}
                filePath={filePath}
                onSave={handleSaveFile}
                onCancel={handleExitEdit}
              />
            ) : (
              <CodeViewer
                code={data.content}
                language={language}
                filePath={filePath}
                highlightLine={highlightLine}
                onLineClick={handleLineClick}
                onEdit={() => setEditing(true)}
                annotations={annotations}
                onAddAnnotation={setAnnotationTarget}
                onAnnotationClick={ann => setAnnotationTarget(ann.startLine)}
                onRangeAnnotationClick={handleRangeAnnotationClick}
                onTextSelection={handleTextSelection}
                onSelectionClear={handleSelectionClear}
                symbols={symbols}
                symbolStatusMap={symbolStatusMap}
                symbolCompletedMap={symbolCompletedMap}
                onSymbolClick={handleSymbolClick}
                onSymbolHover={handleSymbolHover}
                onSymbolLeave={handleSymbolLeave}
              />
            )}
          </div>

          {/* Right: Symbol + Reference + Import panels — sticky with fixed height */}
          <div className="w-[340px] shrink-0 hidden xl:flex flex-col gap-3 sticky top-[4.5rem] h-[calc(100vh-5.5rem)] overflow-hidden">
            {/* Module membership — 固定高度 */}
            {mod && (
              <Card className="shrink-0">
                <CardContent className="pt-4 pb-3 px-4">
                  <div className="flex items-center gap-2">
                    <Package className="size-3.5 text-brand" />
                    <Link to={`/module/${mod.id}`} className="text-xs text-brand hover:underline font-medium">
                      {mod.title}
                    </Link>
                    <span className="text-[10px] text-muted-foreground ml-auto">{mod.group.title}</span>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* 符号列表面板 — 占满剩余空间 */}
            <div className="flex-1 min-h-0 flex flex-col gap-3">
              {explainTarget ? (
                <AIExplainPanel
                  kind={explainTarget.kind}
                  filePath={filePath}
                  symbolName={explainTarget.kind === 'symbol' ? explainTarget.symbolName : undefined}
                  onClose={() => setExplainTarget(null)}
                />
              ) : (
                <SymbolList
                  filePath={filePath}
                  onSelectSymbol={handleSelectSymbol}
                  selectedSymbol={selectedSymbol}
                  onExplainSymbol={sym => setExplainTarget({ kind: 'symbol', symbolName: sym.name })}
                />
              )}

              {/* References Panel - 暂时隐藏 */}
              {/* <ReferencesPanel
                filePath={filePath}
                selectedSymbol={selectedSymbol}
                onSelectSymbol={setSelectedSymbol}
                availableSymbols={symbolData}
              /> */}

              {/* Imports Panel - 暂时隐藏 */}
              {/* <ImportsPanel filePath={filePath} /> */}
            </div>

            {/* Related Modules — 固定高度 */}
            {relatedModules.length > 0 && (
              <Card className="shrink-0">
                <CardContent className="pt-4 pb-3 px-4">
                  <h3 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
                    <Folder className="size-3 text-brand" />
                    相关模块
                  </h3>
                  <div className="space-y-1">
                    {relatedModules.map(rm => (
                      <Link
                        key={rm.id}
                        to={`/module/${rm.id}`}
                        className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded-md px-2 py-1 transition-colors"
                      >
                        <Package className="size-3 shrink-0" />
                        <span className="truncate">{rm.title}</span>
                        <ArrowRight className="size-3 ml-auto shrink-0 opacity-0" />
                      </Link>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>

      {/* Annotation Popover (whole-line) */}
      {annotationTarget !== null && (
        <AnnotationPopover
          open
          onClose={() => setAnnotationTarget(null)}
          line={annotationTarget}
          filePath={filePath}
          existingAnnotation={annotations.find(a => a.startLine === annotationTarget) ?? null}
          onSave={async data => {
            const existing = annotations.find(a => a.startLine === annotationTarget);
            if (existing) {
              await updateAnnotation({ ...existing, ...data, filePath: filePath || '' });
            } else {
              await addAnnotation({ ...data, filePath: filePath || '' });
            }
            setAnnotationTarget(null);
          }}
          onDelete={
            annotations.find(a => a.startLine === annotationTarget)
              ? async () => {
                  const ann = annotations.find(a => a.startLine === annotationTarget);
                  if (ann) await removeAnnotation(ann.id);
                  setAnnotationTarget(null);
                }
              : undefined
          }
        />
      )}

      {/* Selection ghost overlay — persists the orange highlight even when the
          native selection collapses (e.g. popover autoFocus steals focus). */}
      {selectionDraft && <SelectionOverlay range={selectionDraft.range} initialRects={selectionDraft.initialRects} />}
      {commentTarget?.kind === 'new' && (
        <SelectionOverlay range={commentTarget.range} initialRects={commentTarget.initialRects} />
      )}

      {/* Range annotation toolbar — shows on text selection or clicking an existing highlight */}
      {(selectionDraft || activeRangeAnnotation) && !commentTarget && (
        <AnnotationToolbar
          rect={(selectionDraft?.rect ?? activeRangeAnnotation?.rect)!}
          currentColor={activeRangeAnnotation?.annotation.color}
          currentStyles={activeRangeAnnotation?.annotation.styles}
          isExisting={!!activeRangeAnnotation}
          onApplyColor={async color => {
            if (activeRangeAnnotation) {
              await updateAnnotation({ ...activeRangeAnnotation.annotation, color });
              setActiveRangeAnnotation(null);
            } else if (selectionDraft) {
              await addAnnotation({
                filePath: filePath || '',
                startLine: selectionDraft.coords.startLine,
                endLine: selectionDraft.coords.endLine,
                startCol: selectionDraft.coords.startCol,
                endCol: selectionDraft.coords.endCol,
                selectedText: selectionDraft.coords.selectedText,
                color,
                comment: '',
              });
              setSelectionDraft(null);
            }
          }}
          onToggleStyle={async style => {
            if (activeRangeAnnotation) {
              const ann = activeRangeAnnotation.annotation;
              const newStyles = { ...ann.styles, [style]: !ann.styles?.[style] };
              await updateAnnotation({ ...ann, styles: newStyles });
              setActiveRangeAnnotation(prev => (prev ? { ...prev, annotation: { ...ann, styles: newStyles } } : null));
            } else if (selectionDraft) {
              await addAnnotation({
                filePath: filePath || '',
                startLine: selectionDraft.coords.startLine,
                endLine: selectionDraft.coords.endLine,
                startCol: selectionDraft.coords.startCol,
                endCol: selectionDraft.coords.endCol,
                selectedText: selectionDraft.coords.selectedText,
                color: 'yellow',
                comment: '',
                styles: { [style]: true },
              });
              setSelectionDraft(null);
            }
          }}
          onComment={() => {
            if (activeRangeAnnotation) {
              setCommentTarget({ kind: 'existing', ...activeRangeAnnotation });
            } else if (selectionDraft) {
              setCommentTarget({
                kind: 'new',
                rect: selectionDraft.rect,
                coords: selectionDraft.coords,
                range: selectionDraft.range,
                initialRects: selectionDraft.initialRects,
              });
            }
            setSelectionDraft(null);
            setActiveRangeAnnotation(null);
          }}
          onDelete={
            activeRangeAnnotation
              ? async () => {
                  await removeAnnotation(activeRangeAnnotation.annotation.id);
                  setActiveRangeAnnotation(null);
                }
              : undefined
          }
          onClose={handleRangeClose}
        />
      )}

      {/* Range annotation comment popover — driven by commentTarget so its
          lifecycle does not depend on the volatile native text selection. */}
      {commentTarget && (
        <AnnotationPopover
          open
          onClose={() => setCommentTarget(null)}
          line={commentTarget.kind === 'new' ? commentTarget.coords.startLine : commentTarget.annotation.startLine}
          filePath={filePath}
          existingAnnotation={commentTarget.kind === 'existing' ? commentTarget.annotation : null}
          startCol={commentTarget.kind === 'new' ? commentTarget.coords.startCol : commentTarget.annotation.startCol}
          endCol={commentTarget.kind === 'new' ? commentTarget.coords.endCol : commentTarget.annotation.endCol}
          selectedText={
            commentTarget.kind === 'new' ? commentTarget.coords.selectedText : commentTarget.annotation.selectedText
          }
          anchorRect={commentTarget.rect}
          onSave={async data => {
            if (commentTarget.kind === 'existing') {
              await updateAnnotation({
                ...commentTarget.annotation,
                ...data,
                filePath: filePath || '',
              });
            } else {
              await addAnnotation({
                ...data,
                filePath: filePath || '',
                startCol: commentTarget.coords.startCol,
                endCol: commentTarget.coords.endCol,
                selectedText: commentTarget.coords.selectedText,
              });
            }
            setCommentTarget(null);
          }}
          onDelete={
            commentTarget.kind === 'existing'
              ? async () => {
                  await removeAnnotation(commentTarget.annotation.id);
                  setCommentTarget(null);
                }
              : undefined
          }
        />
      )}

      {/* Symbol Hover Tooltip */}
      {hoveredSymbol && tooltipPos && filePath && (
        <SymbolHoverTooltip
          symbol={hoveredSymbol}
          status={fileProgress.getStatus(hoveredSymbol.name)}
          completed={fileProgress.getCompleted(hoveredSymbol.name)}
          note={fileProgress.getNote(hoveredSymbol.name)}
          position={tooltipPos}
          onStatusToggle={() => fileProgress.toggleStatus(hoveredSymbol.name)}
          onOpenNoteDrawer={() => {
            symbolNoteDrawer.openForSymbol(filePath, hoveredSymbol);
            setHoveredSymbol(null);
            setTooltipPos(null);
          }}
          onExplain={() => {
            setExplainTarget({ kind: 'symbol', symbolName: hoveredSymbol.name });
            setHoveredSymbol(null);
            setTooltipPos(null);
          }}
        />
      )}

      {/* Symbol Note Drawer */}
      <SymbolNoteDrawer />
    </div>
  );
}
