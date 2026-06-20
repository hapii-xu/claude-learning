import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { fetchFileTree } from '@/lib/api';
import { useFileCoverage } from '@/hooks/useFileCoverage';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { FileTreeNode, FileCoverageEntry } from '@/data/types';
import { cn } from '@/lib/cn';
import { ChevronRight, FileCode, Folder, FolderOpen, Loader2, AlertCircle } from 'lucide-react';

export function FileTreeExplorer() {
  const [open, setOpen] = useState(false);
  const [tree, setTree] = useState<FileTreeNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const coverage = useFileCoverage();

  const handleOpen = async (isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen && !tree && !loading) {
      setLoading(true);
      try {
        const data = await fetchFileTree();
        setTree(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败');
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <Collapsible open={open} onOpenChange={handleOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer mt-2">
        <ChevronRight className={cn('size-3.5 transition-transform duration-200', open && 'rotate-90')} />
        <span>源码浏览</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-2 mt-1 border-l pl-1 max-h-[50vh] overflow-y-auto">
          {loading && (
            <div className="flex items-center gap-2 px-2.5 py-3 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              <span>加载中...</span>
            </div>
          )}
          {error && (
            <div className="flex items-center gap-2 px-2.5 py-3 text-xs text-muted-foreground">
              <AlertCircle className="size-3.5" />
              <span>{error}</span>
            </div>
          )}
          {tree && tree.map(node => <TreeNode key={node.path} node={node} depth={0} coverage={coverage} />)}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

type Coverage = Record<string, FileCoverageEntry>;

function getCoverageColor(
  path: string,
  type: 'file' | 'directory',
  nodes: FileTreeNode[] | undefined,
  coverage: Coverage,
): string {
  if (type === 'file') {
    const c = coverage[path];
    if (!c || c.total === 0) return '';
    if (c.studied >= c.total) return 'text-emerald-500';
    if (c.studied > 0) return 'text-amber-500';
    return '';
  }
  // directory: recursive avg
  if (!nodes) return '';
  let total = 0,
    studied = 0;
  const walk = (n: FileTreeNode) => {
    if (n.type === 'file') {
      const c = coverage[n.path];
      if (c && c.total > 0) {
        total += c.total;
        studied += c.studied;
      }
    } else n.children?.forEach(walk);
  };
  nodes.forEach(walk);
  if (total === 0) return '';
  const ratio = studied / total;
  if (ratio >= 1) return 'text-emerald-500';
  if (ratio > 0) return 'text-amber-500';
  return '';
}

function TreeNode({ node, depth, coverage }: { node: FileTreeNode; depth: number; coverage: Coverage }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const isActive = location.pathname === `/file/${node.path}`;
  const colorClass = getCoverageColor(node.path, node.type, node.children, coverage);

  if (node.type === 'directory') {
    return (
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-foreground/70 hover:text-foreground hover:bg-accent transition-colors cursor-pointer">
          <ChevronRight className={cn('size-3 transition-transform duration-200', open && 'rotate-90')} />
          {open ? (
            <FolderOpen className={cn('size-3.5 shrink-0', colorClass || 'text-brand')} />
          ) : (
            <Folder className={cn('size-3.5 shrink-0', colorClass || 'text-muted-foreground')} />
          )}
          <span className={cn('truncate', colorClass)}>{node.name}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ml-3 border-l pl-1">
            {node.children?.map(child => (
              <TreeNode key={child.path} node={child} depth={depth + 1} coverage={coverage} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  return (
    <Link
      to={`/file/${node.path}`}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
        isActive ? 'bg-brand/10 text-brand font-medium' : 'text-foreground/60 hover:text-foreground hover:bg-accent',
      )}
      style={{ paddingLeft: `${0.5 + depth * 0.25}rem` }}
    >
      <FileCode className={cn('size-3.5 shrink-0', !isActive && colorClass)} />
      <span className={cn('truncate', !isActive && colorClass)}>{node.name}</span>
    </Link>
  );
}
