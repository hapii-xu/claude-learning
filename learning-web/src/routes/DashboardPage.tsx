import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { fetchProgressStats } from '@/lib/api';
import { useProgress } from '@/hooks/useProgress';
import { modules } from '@/data/modules';
import type { ProgressStats } from '@/data/types';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  LayoutDashboard,
  FileCode,
  Braces,
  StickyNote,
  CheckCircle2,
  Loader2,
  BookOpen,
  TrendingUp,
  Target,
  Database,
  FileCheck,
} from 'lucide-react';
import { cn } from '@/lib/cn';

type StatsWithTotal = ProgressStats & { totalSymbolCount?: number };

export function DashboardPage() {
  const [stats, setStats] = useState<StatsWithTotal | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(60);
  const { completedCount, isCompleted, progress } = useProgress();

  useEffect(() => {
    setLoading(true);
    fetchProgressStats(days)
      .then(data => setStats(data as StatsWithTotal))
      .catch(() => setStats(null))
      .finally(() => setLoading(false));
  }, [days]);

  const moduleProgress = modules.map(m => ({
    id: m.id,
    title: m.title,
    completed: isCompleted(m.id),
    group: m.group.title,
  }));

  const recentlyVisited = Object.entries(progress.lastVisited)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8)
    .map(([id, ts]) => ({
      id,
      module: modules.find(m => m.id === id),
      visitedAt: new Date(ts).toLocaleDateString('zh-CN'),
    }))
    .filter(x => x.module);

  return (
    <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
      <Breadcrumbs />

      <div className="flex items-center gap-3">
        <LayoutDashboard className="size-6 text-brand" />
        <h1 className="text-2xl font-semibold">学习仪表盘</h1>
      </div>

      <Separator />

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : stats ? (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              icon={Braces}
              label="已学符号"
              value={stats.studied}
              accent="text-green-600"
              sub={(() => {
                const denom = stats.totalSymbolCount ?? stats.symbolCount;
                if (denom <= 0) return '';
                const pct = Math.round((stats.studied / denom) * 100);
                return stats.totalSymbolCount
                  ? `${stats.studied} / ${stats.totalSymbolCount}（${pct}%）`
                  : `${pct}% 总符号`;
              })()}
            />
            <StatCard icon={Loader2} label="在学符号" value={stats.studying} accent="text-amber-600" />
            <StatCard icon={FileCode} label="覆盖文件" value={stats.fileCount} accent="text-blue-600" />
            <StatCard icon={StickyNote} label="笔记总数" value={stats.notedCount} accent="text-purple-600" />
          </div>

          {/* Total symbol count card */}
          {stats.totalSymbolCount !== undefined && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard
                icon={Database}
                label="总符号数"
                value={stats.totalSymbolCount}
                accent="text-slate-600"
                sub="src/ + packages/ 全量扫描"
              />
              <StatCard
                icon={Braces}
                label="未学符号"
                value={stats.unstudied}
                accent="text-rose-600"
                sub={
                  stats.totalSymbolCount > 0
                    ? `${Math.round((stats.unstudied / stats.totalSymbolCount) * 100)}% 待学习`
                    : ''
                }
              />
            </div>
          )}

          {/* Secondary stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              icon={BookOpen}
              label="已完成模块"
              value={completedCount}
              sub={`共 ${modules.length} 个`}
              accent="text-brand"
            />
            <StatCard
              icon={Target}
              label="模块完成率"
              value={`${Math.round((completedCount / modules.length) * 100)}%`}
              accent="text-brand"
            />
            <StatCard
              icon={TrendingUp}
              label="今日活动"
              value={stats.recentDays[stats.recentDays.length - 1]?.count || 0}
              accent="text-teal-600"
            />
            <StatCard icon={StickyNote} label="有笔记的符号" value={stats.notedCount} accent="text-violet-600" />
          </div>

          {/* Learning completion stats */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <StatCard
              icon={CheckCircle2}
              label="已完成方法数"
              value={stats.methodCompletedCount ?? 0}
              sub="标记为「方法已完成」"
              accent="text-emerald-600"
            />
            <StatCard
              icon={FileCheck}
              label="已完成文件数"
              value={stats.fileCompletedCount ?? 0}
              sub="标记为「文件已完成」"
              accent="text-blue-600"
            />
            <StatCard
              icon={BookOpen}
              label="文件笔记数"
              value={stats.fileNoteCount ?? 0}
              sub="有笔记的文件"
              accent="text-violet-600"
            />
          </div>

          {/* Heatmap + modules side by side */}
          <div className="grid md:grid-cols-3 gap-4">
            <Card className="md:col-span-2">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium">学习热力图</CardTitle>
                  <div className="flex items-center gap-1">
                    {[30, 60, 90].map(d => (
                      <button
                        key={d}
                        onClick={() => setDays(d)}
                        className={cn(
                          'text-[11px] px-2 py-0.5 rounded',
                          days === d ? 'bg-brand/10 text-brand' : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {d}天
                      </button>
                    ))}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Heatmap data={stats.recentDays} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">最近访问</CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-48">
                  {recentlyVisited.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">还没有访问过任何模块</p>
                  ) : (
                    <div className="space-y-1.5">
                      {recentlyVisited.map(({ id, module: m, visitedAt }) => (
                        <Link
                          key={id}
                          to={`/module/${id}`}
                          className="flex items-center gap-2 text-sm rounded px-2 py-1 hover:bg-accent transition-colors"
                        >
                          <span className="truncate flex-1">{m!.title}</span>
                          <span className="text-[10px] text-muted-foreground shrink-0">{visitedAt}</span>
                        </Link>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </div>

          {/* Module list */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">模块完成度</CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-72">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {moduleProgress.map(m => (
                    <Link
                      key={m.id}
                      to={`/module/${m.id}`}
                      className={cn(
                        'flex items-center gap-2 text-sm rounded-md px-3 py-2 transition-colors',
                        m.completed
                          ? 'bg-green-50 dark:bg-green-950/20 hover:bg-green-100 dark:hover:bg-green-950/30'
                          : 'hover:bg-accent',
                      )}
                    >
                      {m.completed ? (
                        <CheckCircle2 className="size-4 text-green-600 shrink-0" />
                      ) : (
                        <div className="size-4 rounded-full border-2 border-muted-foreground/30 shrink-0" />
                      )}
                      <span className="truncate flex-1">{m.title}</span>
                      <Badge variant={m.completed ? 'brand' : 'secondary'} className="text-[10px]">
                        {m.group}
                      </Badge>
                    </Link>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">加载统计数据失败</CardContent>
        </Card>
      )}
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: typeof FileCode;
  label: string;
  value: string | number;
  sub?: string;
  accent: string;
}) {
  return (
    <Card>
      <CardContent className="p-4 flex items-start gap-3">
        <div className={cn('p-2 rounded-lg bg-muted', accent)}>
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</div>
          <div className="text-xl font-semibold leading-tight mt-0.5">{value}</div>
          {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

function Heatmap({ data }: { data: { date: string; count: number }[] }) {
  const max = Math.max(1, ...data.map(d => d.count));

  // Organize into weeks (columns), going top-to-bottom then left-to-right
  const weeks: { date: string; count: number }[][] = [];
  let currentWeek: { date: string; count: number }[] = [];

  // Start from the first day of the week containing the first date
  for (const d of data) {
    const dateObj = new Date(d.date);
    const dayOfWeek = dateObj.getDay();
    if (dayOfWeek === 0 && currentWeek.length > 0) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
    currentWeek.push(d);
  }
  if (currentWeek.length > 0) weeks.push(currentWeek);

  const dayNames = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
  const getColor = (count: number) => {
    if (count === 0) return 'bg-muted/30';
    const intensity = count / max;
    if (intensity < 0.25) return 'bg-brand/20';
    if (intensity < 0.5) return 'bg-brand/40';
    if (intensity < 0.75) return 'bg-brand/65';
    return 'bg-brand';
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-[3px] items-start">
        {/* Day labels */}
        <div className="flex flex-col gap-[3px] pr-1 pt-0">
          {dayNames.map((name, i) => (
            <div key={i} className="h-3 w-6 text-[9px] text-muted-foreground flex items-center">
              {name}
            </div>
          ))}
        </div>
        {/* Weeks */}
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {/* Pad first week if it doesn't start on Sunday */}
            {wi === 0 &&
              Array.from({ length: new Date(week[0].date).getDay() }).map((_, i) => (
                <div key={`pad-${i}`} className="w-3 h-3" />
              ))}
            {week.map(d => (
              <div
                key={d.date}
                title={`${d.date}: ${d.count} 条活动`}
                className={cn('w-3 h-3 rounded-sm transition-colors', getColor(d.count))}
              />
            ))}
            {/* Pad last week if needed */}
            {wi === weeks.length - 1 &&
              Array.from({ length: 6 - new Date(week[week.length - 1].date).getDay() }).map((_, i) => (
                <div key={`pad-end-${i}`} className="w-3 h-3" />
              ))}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>Less</span>
        {['bg-muted/30', 'bg-brand/20', 'bg-brand/40', 'bg-brand/65', 'bg-brand'].map((c, i) => (
          <div key={i} className={cn('w-3 h-3 rounded-sm', c)} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}
