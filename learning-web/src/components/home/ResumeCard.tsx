import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LEARNING_PATHS } from '@/data/learningPaths';
import type { Activity, PathProgressEntry } from '@/data/types';
import { cn } from '@/lib/cn';
import { Clock, BookOpen, ChevronRight, MapPin } from 'lucide-react';

interface ResumeData {
  recentFiles: Activity[];
  pathProgresses: { path: (typeof LEARNING_PATHS)[number]; progress: PathProgressEntry }[];
}

export function ResumeCard() {
  const [data, setData] = useState<ResumeData | null>(null);

  useEffect(() => {
    const load = async () => {
      const [actRes, ...pathRess] = await Promise.all([
        fetch('/api/activity/recent?limit=4')
          .then(r => r.json())
          .catch(() => ({ activities: [] })),
        ...LEARNING_PATHS.map(p =>
          fetch(`/api/paths/progress?pathId=${encodeURIComponent(p.id)}`)
            .then(r => r.json())
            .catch((): PathProgressEntry => ({ currentStation: 0, completedStations: {} })),
        ),
      ]);

      const pathProgresses = LEARNING_PATHS.map((p, i) => ({
        path: p,
        progress: pathRess[i] as PathProgressEntry,
      })).filter(({ path, progress }) => {
        const stationsDone = Object.keys(progress.completedStations).length;
        return stationsDone > 0 && stationsDone < path.stations.length;
      });

      setData({ recentFiles: actRes.activities || [], pathProgresses });
    };
    load();
  }, []);

  if (!data) return null;
  const { recentFiles, pathProgresses } = data;
  if (recentFiles.length === 0 && pathProgresses.length === 0) return null;

  return (
    <div className="rounded-xl border bg-card p-5 mb-8 space-y-4">
      <div className="flex items-center gap-2">
        <Clock className="size-4 text-brand" />
        <h2 className="text-sm font-semibold text-foreground">续上次</h2>
      </div>

      {/* In-progress learning paths */}
      {pathProgresses.length > 0 && (
        <div className="space-y-2">
          {pathProgresses.map(({ path, progress }) => {
            const done = Object.keys(progress.completedStations).length;
            const total = path.stations.length;
            const currentStation = path.stations[progress.currentStation];
            return (
              <Link
                key={path.id}
                to={`/path/${path.id}`}
                className="flex items-center gap-3 rounded-lg bg-brand/5 border border-brand/20 px-3 py-2.5 hover:bg-brand/10 transition-colors"
              >
                <MapPin className="size-4 text-brand shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{path.title}</p>
                  <p className="text-xs text-muted-foreground">
                    第 {done + 1}/{total} 站 · {currentStation?.title}
                  </p>
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  <div className="w-16 h-1.5 rounded-full bg-surface-2 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-brand"
                      style={{ width: `${Math.round((done / total) * 100)}%` }}
                    />
                  </div>
                  <ChevronRight className="size-3.5 text-muted-foreground" />
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {/* Recent files */}
      {recentFiles.length > 0 && (
        <div>
          <p className="text-[11px] text-muted-foreground mb-1.5 flex items-center gap-1">
            <BookOpen className="size-3" />
            最近查看
          </p>
          <div className="flex flex-wrap gap-1.5">
            {recentFiles.map(a => (
              <Link
                key={a.filePath + (a.symbol || '')}
                to={`/file/${a.filePath}`}
                className={cn(
                  'text-xs font-mono px-2 py-1 rounded-md border hover:border-brand/40 hover:text-brand transition-colors truncate max-w-[240px]',
                  'bg-surface-1 text-muted-foreground',
                )}
                title={a.filePath}
              >
                {a.filePath.split('/').slice(-2).join('/')}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
