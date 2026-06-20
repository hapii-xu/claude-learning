import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { LEARNING_PATHS } from '@/data/learningPaths';
import type { PathProgressEntry } from '@/data/types';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Map, Route, ChevronRight, Trophy, Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

interface PathWithProgress {
  path: (typeof LEARNING_PATHS)[number];
  progress: PathProgressEntry | null;
  loading: boolean;
}

export function PathsPage() {
  const [pathsData, setPathsData] = useState<PathWithProgress[]>(
    LEARNING_PATHS.map(p => ({ path: p, progress: null, loading: true })),
  );

  useEffect(() => {
    LEARNING_PATHS.forEach((p, i) => {
      fetch(`/api/paths/progress?pathId=${encodeURIComponent(p.id)}`)
        .then(r => r.json())
        .then((d: PathProgressEntry) => {
          setPathsData(prev => prev.map((x, j) => (j === i ? { ...x, progress: d, loading: false } : x)));
        })
        .catch(() => {
          setPathsData(prev => prev.map((x, j) => (j === i ? { ...x, progress: null, loading: false } : x)));
        });
    });
  }, []);

  return (
    <div className="max-w-5xl mx-auto px-6 py-6 space-y-6 animate-fade-up">
      <Breadcrumbs />

      <div className="flex items-center gap-3">
        <Route className="size-6 text-brand" />
        <h1 className="text-2xl font-semibold">学习路径</h1>
        <Badge variant="secondary" className="ml-1">
          {LEARNING_PATHS.length} 条
        </Badge>
      </div>

      <p className="text-sm text-muted-foreground">
        按照设计好的路径逐步学习 claude-code 代码库，每站都有引导问题和源码定位。
      </p>

      <Separator />

      <div className="grid gap-4 md:grid-cols-2">
        {pathsData.map(({ path, progress, loading }) => {
          const totalStations = path.stations.length;
          const completedCount = progress ? Object.keys(progress.completedStations).length : 0;
          const percent = totalStations > 0 ? Math.round((completedCount / totalStations) * 100) : 0;
          const isComplete = completedCount === totalStations && totalStations > 0;

          return (
            <Link key={path.id} to={`/path/${path.id}`}>
              <Card className="group hover:border-brand/40 transition-all h-full">
                <CardContent className="p-5 flex flex-col h-full">
                  {/* Header */}
                  <div className="flex items-start gap-3 mb-3">
                    <div
                      className={cn(
                        'size-9 rounded-lg flex items-center justify-center shrink-0',
                        isComplete ? 'bg-status-active/10' : 'bg-brand/10',
                      )}
                    >
                      {isComplete ? (
                        <Trophy className="size-4 text-status-active" />
                      ) : (
                        <Map className="size-4 text-brand" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-semibold text-foreground group-hover:text-brand transition-colors">
                        {path.title}
                      </h3>
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{path.description}</p>
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-3">
                    <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                      {totalStations} 站
                    </Badge>
                    {loading ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : completedCount > 0 ? (
                      <Badge variant={isComplete ? 'brand' : 'secondary'} className="text-[10px] h-4 px-1.5">
                        {completedCount}/{totalStations} 完成
                      </Badge>
                    ) : null}
                  </div>

                  {/* Progress bar */}
                  <div className="mt-auto">
                    <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all duration-500',
                          isComplete ? 'bg-status-active' : 'bg-brand',
                        )}
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between mt-2">
                      <span className="text-[10px] text-muted-foreground">
                        {isComplete ? '已完成' : percent > 0 ? `${percent}% 进度` : '尚未开始'}
                      </span>
                      <span className="text-[10px] text-brand flex items-center gap-0.5 group-hover:gap-1 transition-all">
                        {completedCount > 0 ? '继续' : '开始'}
                        <ChevronRight className="size-3" />
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
