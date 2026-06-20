import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useProgress } from '@/hooks/useProgress';
import { computeLearningPath, getModuleLearningAdvice } from '@/lib/learningPath';
import { modules, moduleGroups } from '@/data/modules';
import { LEARNING_PATHS } from '@/data/learningPaths';
import type { PathProgressEntry } from '@/data/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import {
  CheckCircle2,
  Circle,
  ArrowRight,
  RotateCcw,
  BookOpen,
  Map,
  Trophy,
  Sparkles,
  Download,
  Upload,
  MapPin,
  ChevronRight,
} from 'lucide-react';

export function LearningPathPanel() {
  const { isCompleted, toggleModule, completedCount, resetProgress, exportProgress, importProgress } = useProgress();
  const [showAll, setShowAll] = useState(false);
  const [pathProgresses, setPathProgresses] = useState<Record<string, PathProgressEntry>>({});
  const learningPath = computeLearningPath();
  const progressPercent = Math.round((completedCount / modules.length) * 100);

  useEffect(() => {
    Promise.all(
      LEARNING_PATHS.map(p =>
        fetch(`/api/paths/progress?pathId=${encodeURIComponent(p.id)}`)
          .then(r => r.json())
          .catch((): PathProgressEntry => ({ currentStation: 0, completedStations: {} }))
          .then(prog => [p.id, prog] as const),
      ),
    ).then(entries => setPathProgresses(Object.fromEntries(entries)));
  }, []);

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      const ok = importProgress(text);
      if (!ok) alert('导入失败：文件格式无效');
    };
    input.click();
  };

  return (
    <div className="space-y-6">
      {/* Guided Learning Paths */}
      <div className="rounded-xl border bg-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <MapPin className="size-5 text-brand" />
          <h3 className="font-semibold text-foreground">引导学习路径</h3>
        </div>
        <div className="space-y-2">
          {LEARNING_PATHS.map(path => {
            const prog = pathProgresses[path.id] ?? { currentStation: 0, completedStations: {} };
            const done = Object.keys(prog.completedStations).length;
            const total = path.stations.length;
            const allDone = done >= total;
            const pct = Math.round((done / total) * 100);
            return (
              <Link
                key={path.id}
                to={`/path/${path.id}`}
                className="flex items-center gap-3 rounded-lg border px-3 py-2.5 hover:border-brand/40 hover:bg-accent transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{path.title}</p>
                  <p className="text-xs text-muted-foreground truncate">{path.description}</p>
                </div>
                <div className="shrink-0 flex items-center gap-2 text-right">
                  <div className="text-xs text-muted-foreground whitespace-nowrap">
                    {allDone ? (
                      <span className="text-emerald-500 font-medium">✓ 完成</span>
                    ) : done > 0 ? (
                      `${done}/${total}`
                    ) : (
                      `${total} 站`
                    )}
                  </div>
                  {!allDone && (
                    <div className="w-12 h-1.5 rounded-full bg-surface-2 overflow-hidden">
                      <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                  <ChevronRight className="size-3.5 text-muted-foreground" />
                </div>
              </Link>
            );
          })}
        </div>
      </div>

      {/* Progress Overview */}
      <div className="rounded-xl border bg-card p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Trophy className="size-5 text-brand" />
            <h3 className="font-semibold text-foreground">学习进度</h3>
          </div>
          {completedCount > 0 && (
            <div className="flex items-center gap-0.5">
              <Button variant="ghost" size="icon-sm" onClick={exportProgress} title="导出进度">
                <Download className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={handleImport} title="导入进度">
                <Upload className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={resetProgress} title="重置进度">
                <RotateCcw className="size-3.5" />
              </Button>
            </div>
          )}
        </div>

        {/* Progress Bar */}
        <div className="mb-3">
          <div className="flex items-center justify-between text-sm mb-1.5">
            <span className="text-muted-foreground">
              已完成 {completedCount} / {modules.length} 模块
            </span>
            <span className="font-semibold text-brand">{progressPercent}%</span>
          </div>
          <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
            <div
              className="h-full rounded-full bg-brand transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        {/* Achievement badges */}
        {completedCount > 0 && (
          <div className="flex gap-2 flex-wrap">
            {completedCount >= 1 && <Badge variant="brand">🌱 初学者</Badge>}
            {completedCount >= 5 && <Badge variant="brand">📚 探索者</Badge>}
            {completedCount >= 10 && <Badge variant="brand">🏗️ 架构师</Badge>}
            {completedCount >= modules.length && <Badge variant="brand">🏆 大师</Badge>}
          </div>
        )}
      </div>

      {/* Learning Path */}
      <div className="rounded-xl border bg-card p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Map className="size-5 text-brand" />
            <h3 className="font-semibold text-foreground">推荐学习路径</h3>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setShowAll(!showAll)} className="text-xs">
            {showAll ? '收起' : '展开全部'}
          </Button>
        </div>

        <div className="space-y-1">
          {(showAll ? learningPath : learningPath.slice(0, 6)).map((mod, i) => {
            const done = isCompleted(mod.id);
            const advice = getModuleLearningAdvice(mod.id);

            return (
              <div key={mod.id} className="relative">
                {/* Connector line */}
                {i > 0 && <div className="absolute left-[13px] -top-1 w-px h-1 bg-border" />}

                <div
                  className={cn(
                    'flex items-start gap-3 rounded-lg p-2.5 transition-colors',
                    done ? 'bg-brand/5' : 'hover:bg-accent',
                  )}
                >
                  {/* Step number / check */}
                  <button
                    onClick={() => toggleModule(mod.id)}
                    className="mt-0.5 shrink-0"
                    title={done ? '标记为未完成' : '标记为已完成'}
                  >
                    {done ? (
                      <CheckCircle2 className="size-[26px] text-brand" />
                    ) : (
                      <Circle className="size-[26px] text-muted-foreground hover:text-brand transition-colors" />
                    )}
                  </button>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <Link
                      to={`/module/${mod.id}`}
                      className="text-sm font-medium text-foreground hover:text-brand transition-colors"
                    >
                      {mod.title}
                    </Link>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-muted-foreground">{mod.group.title}</span>
                      <Badge variant="secondary" className="text-[10px] px-1.5 h-4">
                        {mod.files.length} 文件
                      </Badge>
                      {done && (
                        <Badge variant="brand" className="text-[10px] px-1.5 h-4">
                          ✓ 已学
                        </Badge>
                      )}
                    </div>
                    {advice && (
                      <p className="text-[11px] text-muted-foreground mt-1 flex items-start gap-1">
                        <Sparkles className="size-3 shrink-0 mt-0.5 text-brand" />
                        {advice}
                      </p>
                    )}
                  </div>

                  <ArrowRight className="size-4 text-muted-foreground shrink-0 mt-1" />
                </div>
              </div>
            );
          })}
        </div>

        {!showAll && learningPath.length > 6 && (
          <button
            onClick={() => setShowAll(true)}
            className="w-full text-center text-xs text-muted-foreground hover:text-foreground py-2 mt-2 transition-colors"
          >
            还有 {learningPath.length - 6} 个模块...
          </button>
        )}
      </div>

      {/* Stats by Group */}
      <div className="rounded-xl border bg-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <BookOpen className="size-5 text-brand" />
          <h3 className="font-semibold text-foreground">分组完成度</h3>
        </div>
        <div className="space-y-2">
          {moduleGroups.map(group => {
            const groupModules = modules.filter(m => m.group.id === group.id);
            const groupDone = groupModules.filter(m => isCompleted(m.id)).length;
            const percent = groupModules.length > 0 ? Math.round((groupDone / groupModules.length) * 100) : 0;

            return (
              <div key={group.id} className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground w-20 truncate">{group.title}</span>
                <div className="flex-1 h-1.5 rounded-full bg-surface-2 overflow-hidden">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all duration-300',
                      percent === 100 ? 'bg-status-active' : 'bg-brand',
                    )}
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground w-8 text-right">
                  {groupDone}/{groupModules.length}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
