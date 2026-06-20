import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Home, Search, FileCode } from 'lucide-react';
import { modules } from '@/data/modules';

export function NotFoundPage() {
  return (
    <div className="max-w-lg mx-auto px-6 py-20 text-center animate-fade-up">
      <div className="size-16 rounded-2xl bg-brand/10 flex items-center justify-center mx-auto mb-6">
        <FileCode className="size-8 text-brand" />
      </div>
      <h1 className="text-4xl font-bold text-foreground mb-2">404</h1>
      <p className="text-muted-foreground mb-8">页面未找到，可能已被移除或路径有误</p>
      <div className="flex items-center justify-center gap-3 mb-10">
        <Button variant="brand" asChild>
          <Link to="/">
            <Home className="size-3.5" />
            返回首页
          </Link>
        </Button>
      </div>

      {/* Quick links */}
      <div className="text-left">
        <p className="text-xs text-muted-foreground mb-2 uppercase tracking-wider">热门模块</p>
        <div className="flex flex-wrap gap-2">
          {modules.slice(0, 6).map(mod => (
            <Link
              key={mod.id}
              to={`/module/${mod.id}`}
              className="text-sm rounded-md border bg-card px-3 py-1.5 hover:border-brand/40 hover:bg-accent transition-all text-foreground"
            >
              {mod.title}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
