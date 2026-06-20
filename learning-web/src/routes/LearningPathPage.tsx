import { useParams, Link } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { LEARNING_PATHS } from '@/data/learningPaths';
import type { PathProgressEntry } from '@/data/types';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { cn } from '@/lib/cn';
import { CheckCircle2, Circle, ChevronRight, ExternalLink, Trophy, Loader2 } from 'lucide-react';

export function LearningPathPage() {
  const { pathId } = useParams<{ pathId: string }>();
  const path = LEARNING_PATHS.find(p => p.id === pathId);

  const [progress, setProgress] = useState<PathProgressEntry>({
    currentStation: 0,
    completedStations: {},
  });
  const [loading, setLoading] = useState(true);
  const [showSummaryFor, setShowSummaryFor] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [summaryError, setSummaryError] = useState('');

  useEffect(() => {
    if (!pathId) return;
    setLoading(true);
    fetch(`/api/paths/progress?pathId=${encodeURIComponent(pathId)}`)
      .then(r => r.json())
      .then((d: PathProgressEntry) => setProgress(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [pathId]);

  if (!path) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12 text-center">
        <p className="text-muted-foreground">找不到路径：{pathId}</p>
        <Link to="/" className="text-brand hover:underline text-sm mt-4 inline-block">
          返回首页
        </Link>
      </div>
    );
  }

  const allDone = path.stations.every(s => s.id in progress.completedStations);

  const handleCompleteStation = async (stationId: string, idx: number) => {
    if (summary.trim().length < 10) {
      setSummaryError('总结至少 10 个字');
      return;
    }
    setSubmitting(true);
    setSummaryError('');
    try {
      await fetch('/api/paths/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pathId,
          stationId,
          summary: summary.trim(),
          nextStationIndex: idx + 1,
        }),
      });
      setProgress(prev => ({
        currentStation: idx + 1,
        completedStations: {
          ...prev.completedStations,
          [stationId]: { summary: summary.trim(), completedAt: new Date().toISOString() },
        },
      }));
      setShowSummaryFor(null);
      setSummary('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-6 animate-fade-up">
      <Breadcrumbs />

      {/* Path header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground mb-1">{path.title}</h1>
        <p className="text-muted-foreground">{path.description}</p>
      </div>

      {/* All done banner */}
      {allDone && (
        <div className="mb-6 rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-4 flex items-center gap-3">
          <Trophy className="size-6 text-emerald-500" />
          <div>
            <p className="font-semibold text-emerald-600 dark:text-emerald-400">🎉 路径完成！</p>
            <p className="text-sm text-muted-foreground">
              你已完成 {path.stations.length} 个学习站，继续探索其他路径吧。
            </p>
          </div>
        </div>
      )}

      {/* Stepper */}
      <div className="flex items-center gap-1 mb-8 overflow-x-auto pb-2">
        {path.stations.map((station, idx) => {
          const done = station.id in progress.completedStations;
          const isCurrent = idx === progress.currentStation && !allDone;
          return (
            <div key={station.id} className="flex items-center gap-1 shrink-0">
              <div
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
                  done
                    ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : isCurrent
                      ? 'bg-brand/10 text-brand'
                      : 'bg-surface-1 text-muted-foreground',
                )}
              >
                {done ? <CheckCircle2 className="size-3.5" /> : <Circle className="size-3.5" />}
                {idx + 1}. {station.title}
              </div>
              {idx < path.stations.length - 1 && <ChevronRight className="size-3 text-muted-foreground/40 shrink-0" />}
            </div>
          );
        })}
      </div>

      {/* Stations */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-4">
          {path.stations.map((station, idx) => {
            const done = station.id in progress.completedStations;
            const isCurrent = idx === progress.currentStation && !allDone;
            const isLocked = idx > progress.currentStation && !done;

            return (
              <div
                key={station.id}
                className={cn(
                  'rounded-xl border p-5 transition-all',
                  done && 'bg-emerald-500/5 border-emerald-500/20',
                  isCurrent && 'bg-brand/5 border-brand/30',
                  isLocked && 'opacity-50',
                )}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={cn(
                      'shrink-0 size-7 rounded-full flex items-center justify-center text-xs font-bold',
                      done
                        ? 'bg-emerald-500 text-white'
                        : isCurrent
                          ? 'bg-brand text-white'
                          : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {done ? <CheckCircle2 className="size-4" /> : idx + 1}
                  </div>

                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-foreground mb-0.5">{station.title}</h3>
                    <p className="text-sm text-muted-foreground mb-3">{station.description}</p>

                    {/* Target file link */}
                    <Link
                      to={`/file/${station.target.path}`}
                      className="inline-flex items-center gap-1.5 text-xs text-brand hover:underline font-mono mb-3"
                    >
                      <ExternalLink className="size-3" />
                      {station.target.path}
                    </Link>

                    {/* Prompt */}
                    <div className="rounded-lg bg-surface-2 border-l-2 border-brand/40 px-3 py-2 text-sm text-muted-foreground italic mb-3">
                      {station.prompt}
                    </div>

                    {/* Completed summary */}
                    {done && (
                      <div className="rounded-lg bg-emerald-500/10 px-3 py-2">
                        <p className="text-xs text-muted-foreground mb-0.5">你的总结：</p>
                        <p className="text-sm text-foreground">{progress.completedStations[station.id]?.summary}</p>
                      </div>
                    )}

                    {/* Complete button for current station */}
                    {isCurrent && (
                      <div className="mt-3">
                        {showSummaryFor === station.id ? (
                          <div className="space-y-2">
                            <textarea
                              className="w-full text-sm rounded-md border bg-surface-1 px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-brand/50 placeholder:text-muted-foreground/60"
                              rows={3}
                              placeholder="用一两句话总结你的理解（至少 10 个字）..."
                              value={summary}
                              onChange={e => {
                                setSummary(e.target.value);
                                if (summaryError) setSummaryError('');
                              }}
                              autoFocus
                            />
                            {summaryError && <p className="text-xs text-red-500">{summaryError}</p>}
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleCompleteStation(station.id, idx)}
                                disabled={submitting}
                                className="text-sm bg-brand text-white rounded-md px-4 py-1.5 font-medium disabled:opacity-40 hover:bg-brand/90 transition-colors"
                              >
                                {submitting ? '提交中…' : '确认完成'}
                              </button>
                              <button
                                onClick={() => {
                                  setShowSummaryFor(null);
                                  setSummary('');
                                  setSummaryError('');
                                }}
                                className="text-sm text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5"
                              >
                                取消
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            onClick={() => setShowSummaryFor(station.id)}
                            className="text-sm bg-brand/10 text-brand rounded-md px-4 py-1.5 font-medium hover:bg-brand/20 transition-colors"
                          >
                            我学完了 ✓
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
