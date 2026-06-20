import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { searchNotesApi, fetchAllFileNotes } from '@/lib/api';
import type { NoteSearchResult, LineAnnotation, FileNoteEntry } from '@/data/types';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { MarkdownNote } from '@/components/notes/MarkdownNote';
import {
  StickyNote,
  FileCode,
  Search,
  ExternalLink,
  Calendar,
  Highlighter,
  FileCheck,
  CheckCircle2,
} from 'lucide-react';

const ANNOTATION_COLOR_CLASSES: Record<string, string> = {
  yellow: 'bg-yellow-400/20 border-yellow-400/40',
  red: 'bg-red-400/20 border-red-400/40',
  blue: 'bg-blue-400/20 border-blue-400/40',
  green: 'bg-green-400/20 border-green-400/40',
};

const STATUS_LABELS: Record<string, { label: string; variant: 'secondary' | 'brand' | 'outline' }> = {
  studied: { label: '已学', variant: 'brand' },
  studying: { label: '在学', variant: 'outline' },
  unstudied: { label: '未学', variant: 'secondary' },
};

export function NotesPage() {
  const [results, setResults] = useState<NoteSearchResult[]>([]);
  const [annotations, setAnnotations] = useState<LineAnnotation[]>([]);
  const [fileNotes, setFileNotes] = useState<FileNoteEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'studied' | 'studying' | 'unstudied'>('all');
  const [sortBy, setSortBy] = useState<'updated' | 'created'>('updated');
  const [activeTab, setActiveTab] = useState<'notes' | 'file-notes' | 'annotations'>('notes');

  const doSearch = useCallback(async () => {
    setLoading(true);
    try {
      const data = await searchNotesApi(query, 'symbol');
      setResults(data);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    const t = setTimeout(doSearch, 300);
    return () => clearTimeout(t);
  }, [doSearch]);

  useEffect(() => {
    fetch('/api/annotations')
      .then(r => r.json())
      .then(d => setAnnotations(d.annotations || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchAllFileNotes()
      .then(data => setFileNotes(data))
      .catch(() => {});
  }, []);

  const filtered = results.filter(r => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'created') {
      return (b.firstSeenAt || '').localeCompare(a.firstSeenAt || '');
    }
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });

  const stats = {
    total: filtered.length,
    studied: filtered.filter(r => r.status === 'studied').length,
    studying: filtered.filter(r => r.status === 'studying').length,
  };

  const filteredAnnotations = annotations
    .filter(
      a =>
        !query ||
        a.comment.toLowerCase().includes(query.toLowerCase()) ||
        a.filePath.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <div className="max-w-5xl mx-auto px-6 py-6 space-y-4">
      <Breadcrumbs />

      <div className="flex items-center gap-3">
        <StickyNote className="size-6 text-brand" />
        <h1 className="text-2xl font-semibold">笔记中心</h1>
        <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="secondary">{stats.total} 符号笔记</Badge>
          <Badge variant="secondary">{fileNotes.filter(f => f.note).length} 文件笔记</Badge>
          <Badge variant="secondary">{annotations.length} 行标注</Badge>
        </div>
      </div>

      <Separator />

      {/* Tab switcher */}
      <div className="flex gap-1 bg-surface-1 p-1 rounded-lg w-fit">
        <button
          onClick={() => setActiveTab('notes')}
          className={`text-xs px-3 py-1.5 rounded-md transition-colors font-medium ${activeTab === 'notes' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          <span className="flex items-center gap-1.5">
            <StickyNote className="size-3" />
            符号笔记 ({stats.total})
          </span>
        </button>
        <button
          onClick={() => setActiveTab('file-notes')}
          className={`text-xs px-3 py-1.5 rounded-md transition-colors font-medium ${activeTab === 'file-notes' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          <span className="flex items-center gap-1.5">
            <FileCheck className="size-3" />
            文件笔记 ({fileNotes.filter(f => f.note).length})
          </span>
        </button>
        <button
          onClick={() => setActiveTab('annotations')}
          className={`text-xs px-3 py-1.5 rounded-md transition-colors font-medium ${activeTab === 'annotations' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          <span className="flex items-center gap-1.5">
            <Highlighter className="size-3" />
            行标注 ({annotations.length})
          </span>
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder={
              activeTab === 'notes'
                ? '搜索笔记内容或符号名...'
                : activeTab === 'file-notes'
                  ? '搜索文件笔记内容或路径...'
                  : '搜索标注内容或文件路径...'
            }
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="pl-8"
          />
        </div>
        {activeTab === 'notes' && (
          <>
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}
              className="h-9 px-3 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
            >
              <option value="all">全部状态</option>
              <option value="studied">已学</option>
              <option value="studying">在学</option>
              <option value="unstudied">未学</option>
            </select>
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value as typeof sortBy)}
              className="h-9 px-3 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
            >
              <option value="updated">最近更新</option>
              <option value="created">最早记录</option>
            </select>
          </>
        )}
        {activeTab === 'file-notes' && (
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value as typeof sortBy)}
            className="h-9 px-3 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
          >
            <option value="updated">最近更新</option>
            <option value="created">最早记录</option>
          </select>
        )}
      </div>

      {/* Results */}
      {activeTab === 'notes' ? (
        loading ? (
          <div className="text-center text-muted-foreground py-8">加载中...</div>
        ) : sorted.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <StickyNote className="size-10 mx-auto mb-3 opacity-40" />
              <p>{query ? '没有找到匹配的笔记' : '还没有任何笔记。在文件查看页面为符号添加笔记吧！'}</p>
            </CardContent>
          </Card>
        ) : (
          <ScrollArea className="h-[calc(100vh-22rem)]">
            <div className="space-y-2">
              {sorted.map(r => (
                <NoteCard key={r.key} result={r} />
              ))}
            </div>
          </ScrollArea>
        )
      ) : activeTab === 'file-notes' ? (
        (() => {
          const lower = query.toLowerCase();
          const filteredFileNotes = fileNotes
            .filter(
              f =>
                f.note && (!lower || f.filePath.toLowerCase().includes(lower) || f.note.toLowerCase().includes(lower)),
            )
            .sort((a, b) =>
              sortBy === 'created'
                ? (a.firstSeenAt || '').localeCompare(b.firstSeenAt || '')
                : (b.updatedAt || '').localeCompare(a.updatedAt || ''),
            );
          return filteredFileNotes.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <FileCheck className="size-10 mx-auto mb-3 opacity-40" />
                <p>{query ? '没有匹配的文件笔记' : '还没有文件笔记。在文件查看页面顶部添加文件笔记吧！'}</p>
              </CardContent>
            </Card>
          ) : (
            <ScrollArea className="h-[calc(100vh-22rem)]">
              <div className="space-y-2">
                {filteredFileNotes.map(f => (
                  <FileNoteCard key={f.filePath} entry={f} />
                ))}
              </div>
            </ScrollArea>
          );
        })()
      ) : filteredAnnotations.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Highlighter className="size-10 mx-auto mb-3 opacity-40" />
            <p>{query ? '没有匹配的行标注' : '还没有行标注。在文件查看页面点击行号旁的 + 按钮添加标注。'}</p>
          </CardContent>
        </Card>
      ) : (
        <ScrollArea className="h-[calc(100vh-22rem)]">
          <div className="space-y-2">
            {filteredAnnotations.map(a => (
              <AnnotationCard key={a.id} annotation={a} />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function AnnotationCard({ annotation }: { annotation: LineAnnotation }) {
  const colorClass = ANNOTATION_COLOR_CLASSES[annotation.color] || '';
  const date = new Date(annotation.updatedAt).toLocaleDateString('zh-CN');
  return (
    <Card className={`hover:border-brand/40 transition-colors border ${colorClass}`}>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-start gap-2">
          <Highlighter className="size-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <Link
              to={`/file/${annotation.filePath}#L${annotation.startLine}`}
              className="text-sm font-mono text-brand hover:underline truncate block"
            >
              {annotation.filePath}
            </Link>
            <div className="text-xs text-muted-foreground font-mono">
              L{annotation.startLine}
              {annotation.endLine !== annotation.startLine ? `–${annotation.endLine}` : ''}
            </div>
          </div>
          <Link
            to={`/file/${annotation.filePath}#L${annotation.startLine}`}
            className="size-7 shrink-0 flex items-center justify-center rounded-md hover:bg-accent transition-colors"
          >
            <ExternalLink className="size-3.5" />
          </Link>
        </div>
        <p className="text-sm text-foreground pl-6">{annotation.comment}</p>
        <div className="flex items-center gap-1 pl-6 text-[11px] text-muted-foreground">
          <Calendar className="size-3" />
          {date}
        </div>
      </CardContent>
    </Card>
  );
}

function FileNoteCard({ entry }: { entry: FileNoteEntry }) {
  const fileUrl = `/file/${entry.filePath}`;
  const updatedDate = entry.updatedAt ? new Date(entry.updatedAt).toLocaleDateString('zh-CN') : '';
  return (
    <Card className="hover:border-brand/40 transition-colors">
      <CardContent className="p-4 space-y-2">
        <div className="flex items-start gap-2">
          <FileCheck className="size-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <Link to={fileUrl} className="text-sm font-mono text-brand hover:underline truncate block">
              {entry.filePath}
            </Link>
          </div>
          {entry.completed && (
            <span className="shrink-0 flex items-center gap-1 text-[10px] text-brand bg-brand/10 rounded-full px-2 py-0.5">
              <CheckCircle2 className="size-3" />
              已完成
            </span>
          )}
          <Link
            to={fileUrl}
            className="size-7 shrink-0 flex items-center justify-center rounded-md hover:bg-accent transition-colors"
          >
            <ExternalLink className="size-3.5" />
          </Link>
        </div>
        <MarkdownNote content={entry.note} compact />
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Calendar className="size-3" />
          更新: {updatedDate}
        </div>
      </CardContent>
    </Card>
  );
}

function NoteCard({ result }: { result: NoteSearchResult }) {
  const statusCfg = STATUS_LABELS[result.status] || STATUS_LABELS.unstudied;
  const fileUrl = `/file/${result.filePath}${result.symbolName ? `#L${result.symbolName}` : ''}`;
  const updatedDate = result.updatedAt ? new Date(result.updatedAt).toLocaleDateString('zh-CN') : '';
  const createdDate = result.firstSeenAt ? new Date(result.firstSeenAt).toLocaleDateString('zh-CN') : '';

  return (
    <Card className="hover:border-brand/40 transition-colors">
      <CardContent className="p-4 space-y-2">
        <div className="flex items-start gap-2">
          <FileCode className="size-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <Link to={fileUrl} className="text-sm font-mono text-brand hover:underline truncate block">
              {result.filePath}
            </Link>
            <div className="text-xs text-muted-foreground font-mono">{result.symbolName || '(module)'}</div>
          </div>
          <Badge variant={statusCfg.variant} className="shrink-0 text-[10px]">
            {statusCfg.label}
          </Badge>
          <Link
            to={fileUrl}
            target="_blank"
            className="size-7 shrink-0 flex items-center justify-center rounded-md hover:bg-accent transition-colors"
          >
            <ExternalLink className="size-3.5" />
          </Link>
        </div>
        <MarkdownNote content={result.note} compact />

        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Calendar className="size-3" />
            更新: {updatedDate}
          </span>
          {createdDate && <span className="flex items-center gap-1">记录: {createdDate}</span>}
        </div>
      </CardContent>
    </Card>
  );
}
