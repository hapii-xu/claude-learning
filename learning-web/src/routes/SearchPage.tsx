import { useSearchParams, Link } from 'react-router-dom';
import { useMemo, useState, useEffect } from 'react';
import { searchSync, type SearchResult } from '@/hooks/useSearch';
import { searchCodeApi } from '@/lib/api';
import type { CodeSearchMatch } from '@/data/types';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import {
  FileCode,
  Layers,
  BookOpen,
  Search,
  ArrowRight,
  Code2,
  Filter,
  Loader2,
  AlertCircle,
  ChevronRight,
} from 'lucide-react';

const typeIcons: Record<string, typeof FileCode> = {
  module: Layers,
  file: FileCode,
  doc: BookOpen,
};

const typeLabels: Record<string, string> = {
  module: '模块',
  file: '文件',
  doc: '文档',
};

const typeBadgeVariant: Record<string, 'brand' | 'secondary' | 'outline'> = {
  module: 'brand',
  file: 'secondary',
  doc: 'outline',
};

type Tab = 'index' | 'code';

/** Highlight matched terms in text */
function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;

  // Escape regex special chars
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));

  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} className="bg-brand/20 text-brand rounded px-0.5">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q') || '';
  const [tab, setTab] = useState<Tab>('index');

  const handleInput = (value: string) => {
    setSearchParams(value ? { q: value } : {}, { replace: true });
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 animate-fade-up">
      <Breadcrumbs />

      <div className="flex items-center gap-3 mb-6">
        <div className="size-10 rounded-lg bg-brand/10 flex items-center justify-center shrink-0">
          <Search className="size-5 text-brand" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-foreground">搜索</h1>
          <p className="text-sm text-muted-foreground">搜索模块、文件、文档、代码内容</p>
        </div>
      </div>

      {/* Search input */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input
          defaultValue={query}
          onChange={e => handleInput(e.target.value)}
          placeholder="输入关键词搜索..."
          className="pl-10 font-mono"
          autoFocus
        />
      </div>

      {/* Tab switcher */}
      <div className="flex items-center gap-1 mb-6 rounded-lg bg-surface-2/60 p-1 w-fit">
        <button
          onClick={() => setTab('index')}
          className={cn(
            'flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md transition-colors',
            tab === 'index' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Layers className="size-3" />
          文件 / 模块
        </button>
        <button
          onClick={() => setTab('code')}
          className={cn(
            'flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md transition-colors',
            tab === 'code' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Code2 className="size-3" />
          代码内容
        </button>
      </div>

      {tab === 'index' ? <IndexTab query={query} /> : <CodeTab query={query} />}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Tab 1: 文件 / 模块（fuse 索引）
   ───────────────────────────────────────────────────────────── */

function IndexTab({ query }: { query: string }) {
  const results = useMemo(() => {
    if (!query.trim()) return [];
    return searchSync(query);
  }, [query]);

  const grouped = useMemo(() => {
    const groups: Record<string, SearchResult[]> = { module: [], file: [], doc: [] };
    for (const r of results) {
      groups[r.type]?.push(r);
    }
    return groups;
  }, [results]);

  if (!query) {
    return (
      <div className="text-center py-12">
        <Search className="size-12 text-muted-foreground mx-auto mb-4 opacity-50" />
        <p className="text-muted-foreground">输入关键词开始搜索</p>
        <p className="text-xs text-muted-foreground mt-2">支持搜索 13 个学习模块、1900+ 源文件和 41 篇文档</p>
      </div>
    );
  }

  return (
    <>
      {/* Results summary */}
      <div className="flex items-center gap-2 mb-4 text-sm text-muted-foreground">
        <span>
          {results.length === 0 ? (
            <>
              未找到匹配 "<strong className="text-foreground">{query}</strong>" 的结果
            </>
          ) : (
            <>
              找到 <strong className="text-foreground">{results.length}</strong> 个结果
            </>
          )}
        </span>
      </div>

      {/* Grouped results */}
      {results.length > 0 && (
        <div className="space-y-6">
          {(['module', 'file', 'doc'] as const).map(type => {
            const typeResults = grouped[type];
            if (typeResults.length === 0) return null;
            const Icon = typeIcons[type];

            return (
              <section key={type}>
                <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                  <Icon className="size-4 text-brand" />
                  {typeLabels[type]}s
                  <Badge variant={typeBadgeVariant[type]} className="text-[10px]">
                    {typeResults.length}
                  </Badge>
                </h2>
                <div className="space-y-1.5">
                  {typeResults.map(result => (
                    <Link
                      key={result.path}
                      to={result.path}
                      className="flex items-center gap-3 rounded-lg border p-3 hover:border-brand/40 hover:bg-accent/50 transition-all group"
                    >
                      <Icon className="size-4 text-muted-foreground group-hover:text-brand transition-colors shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-foreground group-hover:text-brand transition-colors truncate">
                          <HighlightText text={result.title} query={query} />
                        </div>
                        {result.description && (
                          <div className="text-xs text-muted-foreground truncate mt-0.5">
                            <HighlightText text={result.description} query={query} />
                          </div>
                        )}
                      </div>
                      <span className="text-[10px] text-muted-foreground font-mono truncate max-w-40 shrink-0">
                        {result.subtitle}
                      </span>
                      <ArrowRight className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                    </Link>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

/* ─────────────────────────────────────────────────────────────
   Tab 2: 代码内容（ripgrep）
   ───────────────────────────────────────────────────────────── */

function CodeTab({ query }: { query: string }) {
  const [matches, setMatches] = useState<CodeSearchMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  // Filters (advanced)
  const [showFilters, setShowFilters] = useState(false);
  const [pathFilter, setPathFilter] = useState('');
  const [globFilter, setGlobFilter] = useState('');

  // Collapsed files
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // 防抖 300ms
  useEffect(() => {
    if (!query.trim()) {
      setMatches([]);
      setError(null);
      setTruncated(false);
      return;
    }
    setLoading(true);
    setError(null);
    const t = setTimeout(async () => {
      try {
        const res = await searchCodeApi({
          q: query,
          path: pathFilter.trim() || undefined,
          glob: globFilter.trim() || undefined,
        });
        setMatches(res.results);
        setTruncated(res.truncated);
        setElapsedMs(res.elapsed_ms);
      } catch (err) {
        setError(err instanceof Error ? err.message : '搜索失败');
        setMatches([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
    // 只在 query 变化时触发；filters 变化时希望用户主动"应用"
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // 按文件分组
  const grouped = useMemo(() => {
    const map = new Map<string, CodeSearchMatch[]>();
    for (const m of matches) {
      const arr = map.get(m.file) || [];
      arr.push(m);
      map.set(m.file, arr);
    }
    return Array.from(map.entries()).map(([file, ms]) => ({ file, matches: ms }));
  }, [matches]);

  const toggleCollapse = (file: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  };

  const handleApplyFilters = () => {
    // 触发一次 effect：通过改变 query 引用的"触发点"重跑搜索
    // 简单做法：把当前 query 重新写一遍触发 useEffect
    if (query.trim()) {
      setLoading(true);
      setError(null);
      searchCodeApi({
        q: query,
        path: pathFilter.trim() || undefined,
        glob: globFilter.trim() || undefined,
      })
        .then(res => {
          setMatches(res.results);
          setTruncated(res.truncated);
          setElapsedMs(res.elapsed_ms);
        })
        .catch(err => {
          setError(err instanceof Error ? err.message : '搜索失败');
          setMatches([]);
        })
        .finally(() => setLoading(false));
    }
  };

  // Empty state
  if (!query) {
    return (
      <div className="text-center py-12">
        <Code2 className="size-12 text-muted-foreground mx-auto mb-4 opacity-50" />
        <p className="text-muted-foreground">输入关键词搜索代码内容</p>
        <p className="text-xs text-muted-foreground mt-2">基于 ripgrep 全文检索，支持字面量和正则匹配</p>
      </div>
    );
  }

  return (
    <>
      {/* Filter bar */}
      <div className="flex items-center gap-2 mb-4">
        <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => setShowFilters(v => !v)}>
          <Filter className="size-3" />
          过滤
        </Button>

        {loading && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            搜索中...
          </span>
        )}
        {!loading && !error && (
          <span className="text-xs text-muted-foreground">
            {matches.length === 0 ? (
              <>
                未找到匹配 "<strong className="text-foreground">{query}</strong>" 的代码
              </>
            ) : (
              <>
                <strong className="text-foreground">{matches.length}</strong> 处匹配
                {grouped.length > 0 && (
                  <>
                    {' '}
                    分布于 <strong className="text-foreground">{grouped.length}</strong> 个文件
                  </>
                )}
                {elapsedMs > 0 && <span className="ml-1 opacity-60">({elapsedMs}ms)</span>}
              </>
            )}
          </span>
        )}
        {truncated && (
          <Badge variant="outline" className="text-[10px] text-status-running border-status-running/40">
            结果已截断
          </Badge>
        )}
      </div>

      {showFilters && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border bg-surface-1/50 p-3">
          <div className="flex-1">
            <label className="text-[10px] text-muted-foreground block mb-1">子目录</label>
            <Input
              value={pathFilter}
              onChange={e => setPathFilter(e.target.value)}
              placeholder="例：src/query"
              className="h-7 text-xs font-mono"
            />
          </div>
          <div className="flex-1">
            <label className="text-[10px] text-muted-foreground block mb-1">文件类型</label>
            <Input
              value={globFilter}
              onChange={e => setGlobFilter(e.target.value)}
              placeholder="例：*.ts"
              className="h-7 text-xs font-mono"
            />
          </div>
          <Button size="sm" className="h-7 text-xs mt-4" onClick={handleApplyFilters} disabled={loading}>
            应用
          </Button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-status-error/30 bg-status-error/5 p-4 flex items-start gap-2">
          <AlertCircle className="size-4 text-status-error shrink-0 mt-0.5" />
          <div className="text-xs">
            <p className="text-status-error font-medium">搜索失败</p>
            <p className="text-muted-foreground mt-1">{error}</p>
          </div>
        </div>
      )}

      {/* Results grouped by file */}
      {!error && grouped.length > 0 && (
        <div className="space-y-2">
          {grouped.map(({ file, matches: fileMatches }) => {
            const isCollapsed = collapsed.has(file);
            return (
              <div key={file} className="rounded-lg border overflow-hidden">
                <button
                  onClick={() => toggleCollapse(file)}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent/50 transition-colors text-left"
                >
                  <ChevronRight
                    className={cn('size-3.5 text-muted-foreground transition-transform', !isCollapsed && 'rotate-90')}
                  />
                  <FileCode className="size-3.5 text-brand shrink-0" />
                  <span className="text-xs font-mono text-foreground truncate flex-1">{file}</span>
                  <Badge variant="secondary" className="text-[10px] shrink-0">
                    {fileMatches.length}
                  </Badge>
                </button>

                {!isCollapsed && (
                  <div className="border-t bg-surface-1/30">
                    {fileMatches.map((m, i) => (
                      <Link
                        key={`${m.line}-${i}`}
                        to={`/file/${m.file}#L${m.line}`}
                        className="flex items-start gap-2 px-3 py-1.5 hover:bg-accent/40 transition-colors group border-b last:border-b-0"
                      >
                        <span className="text-[10px] font-mono text-muted-foreground shrink-0 w-10 text-right pt-0.5">
                          L{m.line}
                        </span>
                        <code className="text-[11px] font-mono text-foreground/90 truncate flex-1 whitespace-pre">
                          <HighlightText text={m.match.replace(/^\s+/, '')} query={query} />
                        </code>
                        <ArrowRight className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5" />
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* No results */}
      {!error && !loading && query && matches.length === 0 && (
        <div className="text-center py-12">
          <Code2 className="size-10 text-muted-foreground mx-auto mb-3 opacity-40" />
          <p className="text-sm text-muted-foreground">
            未找到包含 "<strong className="text-foreground">{query}</strong>" 的代码
          </p>
          <p className="text-xs text-muted-foreground mt-2">提示：可尝试切换"过滤"限定文件类型或子目录</p>
        </div>
      )}
    </>
  );
}
