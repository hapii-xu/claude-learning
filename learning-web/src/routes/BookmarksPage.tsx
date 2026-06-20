import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Bookmark, Trash2, Loader2 } from 'lucide-react';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { BookmarkEntry } from '@/data/types';

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 30) return date.toLocaleDateString('zh-CN');
  if (diffDays > 0) return `${diffDays} 天前`;
  if (diffHours > 0) return `${diffHours} 小时前`;
  if (diffMins > 0) return `${diffMins} 分钟前`;
  return '刚刚';
}

export function BookmarksPage() {
  const [bookmarks, setBookmarks] = useState<BookmarkEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [removingPaths, setRemovingPaths] = useState<Set<string>>(new Set());

  useEffect(() => {
    setLoading(true);
    fetch('/api/bookmarks')
      .then(r => r.json())
      .then((data: { bookmarks: BookmarkEntry[] }) => setBookmarks(data.bookmarks ?? []))
      .catch(() => setBookmarks([]))
      .finally(() => setLoading(false));
  }, []);

  const handleRemove = async (filePath: string) => {
    setRemovingPaths(prev => new Set(prev).add(filePath));
    try {
      const res = await fetch(`/api/bookmarks?filePath=${encodeURIComponent(filePath)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setBookmarks(prev => prev.filter(b => b.filePath !== filePath));
      }
    } finally {
      setRemovingPaths(prev => {
        const next = new Set(prev);
        next.delete(filePath);
        return next;
      });
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
      <Breadcrumbs />

      <div className="flex items-center gap-3">
        <Bookmark className="size-6 text-brand" />
        <h1 className="text-2xl font-semibold">书签</h1>
        {!loading && (
          <Badge variant="secondary" className="ml-1">
            {bookmarks.length}
          </Badge>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : bookmarks.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <Bookmark className="size-10 mx-auto mb-3 opacity-30" />
            <p>还没有书签，在文件页面点击书签图标添加</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {bookmarks.map(bookmark => {
            const isRemoving = removingPaths.has(bookmark.filePath);
            const fileName = bookmark.filePath.split('/').pop() ?? bookmark.filePath;
            return (
              <Card key={bookmark.filePath} className="group">
                <CardContent className="p-4 flex items-center gap-3">
                  <Bookmark className="size-4 text-brand shrink-0" />
                  <div className="flex-1 min-w-0">
                    <Link
                      to={`/file/${bookmark.filePath}`}
                      className="text-sm font-medium hover:text-brand transition-colors truncate block font-mono"
                      title={bookmark.filePath}
                    >
                      {fileName}
                    </Link>
                    <p className="text-[11px] text-muted-foreground font-mono truncate mt-0.5">{bookmark.filePath}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {bookmark.tag && (
                      <Badge variant="secondary" className="text-[10px]">
                        {bookmark.tag}
                      </Badge>
                    )}
                    <span className="text-[11px] text-muted-foreground">{formatRelativeTime(bookmark.addedAt)}</span>
                    <button
                      onClick={() => handleRemove(bookmark.filePath)}
                      disabled={isRemoving}
                      title="移除书签"
                      className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all disabled:opacity-50"
                    >
                      {isRemoving ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                    </button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
