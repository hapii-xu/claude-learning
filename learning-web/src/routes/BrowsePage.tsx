import { useState, useEffect } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import { fetchFileTree } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PageSkeleton } from '@/components/ui/skeleton';
import { fileDescriptions } from '@/data/fileDescriptions';
import { directoryDescriptions, getDirectoryDescription } from '@/data/directoryDescriptions';
import { FolderTree, ChevronRight, ChevronDown, FileCode, Folder, FolderOpen, AlertCircle, Search } from 'lucide-react';
import type { FileTreeNode } from '@/data/types';

export function BrowsePage() {
  const { '*': browsePath } = useParams<{ '*': string }>();
  const [tree, setTree] = useState<FileTreeNode[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    setLoading(true);
    fetchFileTree()
      .then(setTree)
      .catch(() => setTree([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <PageSkeleton />;
  if (!tree) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-12 text-center">
        <AlertCircle className="size-12 text-muted-foreground mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">文件树加载失败</h2>
      </div>
    );
  }

  // Navigate to the requested path in the tree
  const pathParts = (browsePath || '').split('/').filter(Boolean);
  let currentNodes = tree;
  let currentPath = '';

  for (const part of pathParts) {
    currentPath += (currentPath ? '/' : '') + part;
    const found = currentNodes?.find(n => n.type === 'directory' && n.path === currentPath);
    if (found?.children) {
      currentNodes = found.children;
    } else {
      currentNodes = [];
      break;
    }
  }

  const currentDirDesc = browsePath ? getDirectoryDescription(currentPath) : null;

  // Filter nodes
  const filtered = filter
    ? currentNodes?.filter(n => n.name.toLowerCase().includes(filter.toLowerCase()))
    : currentNodes;

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 animate-fade-up">
      <Breadcrumbs />

      <div className="flex items-center gap-3 mb-6">
        <div className="size-10 rounded-lg bg-brand/10 flex items-center justify-center shrink-0">
          <FolderTree className="size-5 text-brand" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-foreground">目录浏览</h1>
          <p className="text-sm text-muted-foreground">{browsePath ? `/${browsePath}` : '项目根目录'}</p>
        </div>
      </div>

      {currentDirDesc && (
        <div className="mb-4 rounded-xl border bg-card/80 px-5 py-4">
          <h2 className="text-sm font-semibold text-foreground mb-1">{currentDirDesc.title}</h2>
          <p className="text-xs text-muted-foreground leading-relaxed">{currentDirDesc.summary}</p>
          {currentDirDesc.keyPoints && currentDirDesc.keyPoints.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {currentDirDesc.keyPoints.map(pt => (
                <li key={pt} className="text-[10px] bg-brand/10 text-brand px-2 py-0.5 rounded-full">
                  {pt}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Search filter */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <input
          type="text"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="过滤文件名..."
          className="w-full pl-9 pr-4 py-2 text-sm rounded-lg border bg-background"
        />
      </div>

      {/* File tree */}
      {filtered && filtered.length > 0 ? (
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="divide-y">
            {filtered
              .sort((a, b) => {
                if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
                return a.name.localeCompare(b.name);
              })
              .map(node => (
                <FileTreeItem key={node.path} node={node} depth={pathParts.length} />
              ))}
          </div>
        </div>
      ) : (
        <div className="text-center py-12 text-muted-foreground">{filter ? '没有匹配的文件' : '空目录'}</div>
      )}
    </div>
  );
}

function FileTreeItem({ node, depth }: { node: FileTreeNode; depth: number }) {
  const [expanded, setExpanded] = useState(false);
  const isDir = node.type === 'directory';

  // Get description for files or directories
  const description = isDir ? directoryDescriptions[node.path]?.summary : fileDescriptions[node.path];

  if (isDir) {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 w-full px-4 py-2.5 hover:bg-accent transition-colors text-left"
          style={{ paddingLeft: `${depth * 1.5 + 1}rem` }}
        >
          {expanded ? (
            <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
          )}
          {expanded ? (
            <FolderOpen className="size-4 text-brand shrink-0" />
          ) : (
            <Folder className="size-4 text-brand/70 shrink-0" />
          )}
          <span className="text-sm font-medium">{node.name}</span>
          {description && (
            <span className="ml-2 text-xs text-muted-foreground truncate max-w-xs hidden sm:inline">{description}</span>
          )}
          {node.children && (
            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">{node.children.length} 项</span>
          )}
        </button>

        {expanded && node.children && (
          <div className="divide-y border-t">
            {node.children
              .sort((a, b) => {
                if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
                return a.name.localeCompare(b.name);
              })
              .map(child => (
                <FileTreeItem key={child.path} node={child} depth={depth + 1} />
              ))}
          </div>
        )}
      </div>
    );
  }

  // File item
  const ext = node.name.split('.').pop()?.toLowerCase() || '';
  const isTS = ['ts', 'tsx'].includes(ext);
  const isDoc = ['md', 'mdx'].includes(ext);

  return (
    <Link
      to={isDoc ? `/doc/${node.path}` : `/file/${node.path}`}
      className="flex items-center gap-2 px-4 py-2 hover:bg-accent transition-colors group"
      style={{ paddingLeft: `${depth * 1.5 + 2.5}rem` }}
    >
      <FileCode
        className={cn('size-3.5 shrink-0', isTS ? 'text-blue-500' : isDoc ? 'text-green-500' : 'text-muted-foreground')}
      />
      <div className="flex-1 min-w-0">
        <span className="text-sm">{node.name}</span>
        {description && <span className="ml-2 text-xs text-muted-foreground truncate">{description}</span>}
      </div>
      <Badge
        variant="secondary"
        className="text-[9px] px-1.5 h-4 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        {ext}
      </Badge>
    </Link>
  );
}
