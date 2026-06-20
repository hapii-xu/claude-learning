import { useParams } from 'react-router-dom';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { fetchDoc } from '@/lib/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowRight, ArrowLeft, FileText, List, Link as LinkIcon, Check } from 'lucide-react';
import { FileRefLink } from '@/components/code/FileRefLink';
import { CodeBlockWithCopy } from '@/components/code/CodeBlockWithCopy';
import { PageSkeleton } from '@/components/ui/skeleton';
import { MermaidFence } from '@/components/doc/MermaidFence';
import { modules } from '@/data/modules';
import { cn } from '@/lib/cn';

interface TocEntry {
  id: string;
  text: string;
  level: number;
}

function extractToc(content: string): TocEntry[] {
  const entries: TocEntry[] = [];
  const headingRegex = /^(#{2,3})\s+(.+)$/gm;
  let match;
  while ((match = headingRegex.exec(content)) !== null) {
    const level = match[1].length;
    const text = match[2].trim();
    const id = text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-');
    entries.push({ id, text, level });
  }
  return entries;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

/**
 * 收集所有模块的 docPaths，按模块顺序排列，提供 prev/next 导航
 */
function getAllDocPaths(): string[] {
  const paths: string[] = [];
  for (const mod of modules) {
    if (mod.docPaths) {
      for (const dp of mod.docPaths) {
        if (!paths.includes(dp)) paths.push(dp);
      }
    }
  }
  return paths;
}

function getDocNav(currentPath: string): { prev?: string; next?: string } {
  const allPaths = getAllDocPaths();
  const idx = allPaths.indexOf(currentPath);
  if (idx === -1) return {};
  return {
    prev: idx > 0 ? allPaths[idx - 1] : undefined,
    next: idx < allPaths.length - 1 ? allPaths[idx + 1] : undefined,
  };
}

export function DocPage() {
  const { '*': docPath } = useParams<{ '*': string }>();
  const [content, setContent] = useState<string | null>(null);
  const [frontmatter, setFrontmatter] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!docPath) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetchDoc(docPath!);
        if (!cancelled) {
          setContent(res.content);
          setFrontmatter((res.frontmatter as Record<string, unknown>) || null);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '加载失败');
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [docPath]);

  if (!docPath) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-12 text-center">
        <AlertCircle className="size-12 text-muted-foreground mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">未指定文档路径</h2>
        <Link to="/" className="text-brand hover:underline">
          返回首页
        </Link>
      </div>
    );
  }

  if (loading) {
    return <PageSkeleton />;
  }

  if (error || !content) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-12 text-center">
        <AlertCircle className="size-12 text-muted-foreground mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">文档加载失败</h2>
        <p className="text-muted-foreground">{error || '文档未找到'}</p>
      </div>
    );
  }

  const title =
    (frontmatter?.title as string) ||
    docPath
      .split('/')
      .pop()
      ?.replace(/\.\w+$/, '') ||
    docPath;
  const toc = extractToc(content);
  const docNav = getDocNav(docPath);

  // Mermaid-first pages (callgraph docs): use full-width canvas mode, hide TOC
  const isMermaidFirst = /^\s*```mermaid/m.test(content);

  return (
    <div className="animate-fade-up" style={{ padding: '5px' }}>
      <Breadcrumbs />

      <div className="flex items-start gap-3 mb-6">
        <div className="size-10 rounded-lg bg-brand/10 flex items-center justify-center shrink-0 mt-0.5">
          <FileText className="size-5 text-brand" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">{title}</h1>
          {frontmatter?.description ? (
            <p className="text-muted-foreground mt-1">{String(frontmatter.description)}</p>
          ) : null}
        </div>
      </div>

      <div className={cn('grid gap-6', !isMermaidFirst && 'lg:grid-cols-4')}>
        {/* Main content */}
        <div className={cn('markdown-content min-w-0', !isMermaidFirst && 'lg:col-span-3')}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              // Add IDs + anchor links to headings
              h1({ children, ...props }) {
                const text = extractText(children);
                const id = slugify(text);
                return (
                  <HeadingWithAnchor level={1} id={id}>
                    {children}
                  </HeadingWithAnchor>
                );
              },
              h2({ children, ...props }) {
                const text = extractText(children);
                const id = slugify(text);
                return (
                  <HeadingWithAnchor level={2} id={id}>
                    {children}
                  </HeadingWithAnchor>
                );
              },
              h3({ children, ...props }) {
                const text = extractText(children);
                const id = slugify(text);
                return (
                  <HeadingWithAnchor level={3} id={id}>
                    {children}
                  </HeadingWithAnchor>
                );
              },
              h4({ children, ...props }) {
                const text = extractText(children);
                const id = slugify(text);
                return (
                  <HeadingWithAnchor level={4} id={id}>
                    {children}
                  </HeadingWithAnchor>
                );
              },
              // Wrap block code with copy button + shiki highlight
              pre({ children, ...props }) {
                const codeEl = (children as { props?: { children?: string; className?: string } })?.props;
                const codeText = typeof codeEl?.children === 'string' ? codeEl.children : '';
                const langMatch = /language-(\w+)/.exec(codeEl?.className || '');
                const lang = langMatch?.[1] || '';

                // Mermaid code fence
                if (lang === 'mermaid' && codeText) {
                  return <MermaidFence code={codeText} />;
                }

                if (codeText) {
                  return (
                    <CodeBlockWithCopy code={codeText}>
                      <pre {...props}>{children}</pre>
                    </CodeBlockWithCopy>
                  );
                }
                return <pre {...props}>{children}</pre>;
              },
              code({ className, children, ...props }) {
                const text = String(children);

                // File path reference
                if (/^(src|packages|scripts|analysis)\//.test(text)) {
                  return <FileRefLink path={text}>{text}</FileRefLink>;
                }

                return (
                  <code className={className} {...props}>
                    {children}
                  </code>
                );
              },
              a({ href, children, ...props }) {
                if (href && !href.startsWith('http') && !href.startsWith('#')) {
                  const docMatch = href.match(/docs\/(.+)/);
                  if (docMatch) {
                    return (
                      <Link to={`/doc/docs/${docMatch[1]}`} {...props}>
                        {children} <ArrowRight className="inline size-3" />
                      </Link>
                    );
                  }
                  if (/^(src|packages)\//.test(href)) {
                    return (
                      <FileRefLink path={href} {...props}>
                        {children}
                      </FileRefLink>
                    );
                  }
                }
                return (
                  <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                    {children}
                  </a>
                );
              },
            }}
          >
            {content}
          </ReactMarkdown>

          {/* Prev / Next navigation */}
          <div className="mt-12 pt-6 border-t flex items-center justify-between">
            {docNav.prev ? (
              <Link
                to={`/doc/${docNav.prev}`}
                className="flex items-center gap-2 text-sm text-muted-foreground hover:text-brand transition-colors group"
              >
                <ArrowLeft className="size-4 group-hover:-translate-x-0.5 transition-transform" />
                <span className="truncate max-w-[200px]">
                  {docNav.prev
                    .split('/')
                    .pop()
                    ?.replace(/\.\w+$/, '')}
                </span>
              </Link>
            ) : (
              <div />
            )}
            {docNav.next ? (
              <Link
                to={`/doc/${docNav.next}`}
                className="flex items-center gap-2 text-sm text-muted-foreground hover:text-brand transition-colors group"
              >
                <span className="truncate max-w-[200px]">
                  {docNav.next
                    .split('/')
                    .pop()
                    ?.replace(/\.\w+$/, '')}
                </span>
                <ArrowRight className="size-4 group-hover:translate-x-0.5 transition-transform" />
              </Link>
            ) : (
              <div />
            )}
          </div>
        </div>

        {/* Table of Contents — hidden for mermaid-first (callgraph) pages */}
        {!isMermaidFirst && toc.length > 1 && <TocSidebar toc={toc} />}
      </div>
    </div>
  );
}

// ─── Heading with anchor ───

function HeadingWithAnchor({ level, id, children }: { level: 1 | 2 | 3 | 4; children: React.ReactNode; id: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      const url = `${window.location.origin}${window.location.pathname}#${id}`;
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        /* ignore */
      }
      window.history.replaceState(null, '', `#${id}`);
    },
    [id],
  );

  const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4';

  return (
    <Tag id={id} className="group/heading scroll-mt-20">
      {children}
      <button
        onClick={handleCopy}
        className="inline-block ml-2 opacity-0 group-hover/heading:opacity-100 transition-opacity text-muted-foreground hover:text-brand"
        title="复制锚链"
      >
        {copied ? <Check className="size-3.5 text-status-active" /> : <LinkIcon className="size-3.5" />}
      </button>
    </Tag>
  );
}

// ─── TOC Sidebar with scroll-spy ───

function TocSidebar({ toc }: { toc: TocEntry[] }) {
  const [activeId, setActiveId] = useState<string>('');

  useEffect(() => {
    if (toc.length === 0) return;

    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      { rootMargin: '-80px 0px -80% 0px' },
    );

    for (const { id } of toc) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [toc]);

  return (
    <aside className="hidden lg:block">
      <div className="sticky top-20">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
          <List className="size-3.5" />
          目录
        </h4>
        <nav className="space-y-0.5 border-l pl-3">
          {toc.map(entry => (
            <a
              key={entry.id}
              href={`#${entry.id}`}
              onClick={e => {
                e.preventDefault();
                document.getElementById(entry.id)?.scrollIntoView({ behavior: 'smooth' });
              }}
              className={cn(
                'block text-xs py-1 transition-colors truncate',
                entry.level === 3 ? 'pl-2' : '',
                activeId === entry.id
                  ? 'text-brand font-medium border-l-2 border-brand -ml-3 pl-[calc(0.75rem)]'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {entry.text}
            </a>
          ))}
        </nav>
      </div>
    </aside>
  );
}

function extractText(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(extractText).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    return extractText((children as { props?: { children?: React.ReactNode } }).props?.children);
  }
  return '';
}
