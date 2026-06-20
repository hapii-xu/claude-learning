import { Link } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { modules, moduleGroups, getModuleById } from '@/data/modules';
import { cn } from '@/lib/cn';
import { estimateReadingTime } from '@/lib/readingTime';
import { LearningPathPanel } from '@/components/module/LearningPathPanel';
import { ResumeCard } from '@/components/home/ResumeCard';
import { ModuleDependencyGraph } from '@/components/module/ModuleDependencyGraph';
import { useProgress } from '@/hooks/useProgress';
import {
  Rocket,
  RefreshCw,
  Brain,
  Cloud,
  Wrench,
  Monitor,
  Database,
  Users,
  Puzzle,
  Shield,
  Terminal,
  Flag,
  Hammer,
  ArrowRight,
  BookOpen,
  FileCode,
  Layers,
  Clock,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const iconMap: Record<string, LucideIcon> = {
  Rocket,
  RefreshCw,
  Brain,
  Cloud,
  Wrench,
  Monitor,
  Database,
  Users,
  Puzzle,
  Shield,
  Terminal,
  Flag,
  Hammer,
};

export function HomePage() {
  const { progress, isCompleted } = useProgress();

  // Get recently visited modules (last 6, sorted by timestamp desc)
  const recentModules = Object.entries(progress.lastVisited)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6)
    .map(([moduleId]) => getModuleById(moduleId))
    .filter(Boolean);

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 animate-fade-up">
      <ResumeCard />
      {/* Hero */}
      <div className="mb-10">
        <h1 className="text-3xl font-bold text-foreground mb-3">Claude Code 架构学习</h1>
        <p className="text-muted-foreground text-lg max-w-2xl">
          深入理解 Claude Code 的代码库架构。从入口启动到核心循环，从工具系统到安全模型，
          系统性学习每个模块的设计思路和文件链路。
        </p>

        {/* Stats */}
        <div className="flex gap-6 flex-wrap mt-6">
          <StatCard icon={Layers} label="学习模块" value={modules.length} />
          <StatCard icon={FileCode} label="核心文件" value={modules.reduce((acc, m) => acc + m.files.length, 0)} />
          <StatCard
            icon={BookOpen}
            label="文档页面"
            value={modules.reduce((acc, m) => acc + (m.docPaths?.length || 0), 0)}
          />
          <StatCard
            icon={Clock}
            label="已学完"
            value={Object.values(progress.lastVisited).length > 0 ? modules.filter(m => isCompleted(m.id)).length : 0}
          />
        </div>
      </div>

      {/* Learning Path + Dependency Graph */}
      <div className="grid gap-6 lg:grid-cols-2 mb-10">
        <LearningPathPanel />
        <ModuleDependencyGraph />
      </div>

      {/* Recently Visited */}
      {recentModules.length > 0 && (
        <section className="mb-10">
          <h2 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
            <Clock className="size-4.5 text-brand" />
            最近访问
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {recentModules.map(mod => mod && <ModuleCard key={mod.id} module={mod} highlight={isCompleted(mod.id)} />)}
          </div>
        </section>
      )}

      {/* Module Groups */}
      {moduleGroups.map(group => {
        const groupModules = modules.filter(m => m.group.id === group.id);
        if (groupModules.length === 0) return null;

        return (
          <section key={group.id} className="mb-8">
            <h2 className="text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-brand" />
              {group.title}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {groupModules.map(mod => (
                <ModuleCard key={mod.id} module={mod} highlight={isCompleted(mod.id)} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function StatCard({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: number }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3">
      <div className="size-9 rounded-lg bg-brand/10 flex items-center justify-center">
        <Icon className="size-4.5 text-brand" />
      </div>
      <div>
        <div className="text-xl font-bold text-foreground">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

function ModuleCard({ module, highlight }: { module: (typeof modules)[number]; highlight?: boolean }) {
  const Icon = iconMap[module.icon] || FileCode;

  return (
    <Link to={`/module/${module.id}`}>
      <Card
        className={cn(
          'h-full hover:border-brand/50 hover:shadow-md transition-all cursor-pointer group',
          highlight && 'border-brand/30 bg-brand/[0.02]',
        )}
      >
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between">
            <div className="size-9 rounded-lg bg-brand/10 flex items-center justify-center group-hover:bg-brand/20 transition-colors">
              <Icon className="size-4.5 text-brand" />
            </div>
            <div className="flex items-center gap-1.5">
              {highlight && (
                <Badge variant="brand" className="text-[10px]">
                  ✓ 已学
                </Badge>
              )}
              <ArrowRight className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>
          <CardTitle className="text-base mt-2">{module.title}</CardTitle>
          <CardDescription className="text-xs">{module.titleEn}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground line-clamp-2 mb-3">{module.description}</p>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="secondary" className="text-[10px]">
              {module.files.length} 文件
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              ⏱ {estimateReadingTime(module)} 分钟
            </Badge>
            {module.keyConcepts?.slice(0, 1).map(concept => (
              <Badge key={concept} variant="outline" className="text-[10px]">
                {concept}
              </Badge>
            ))}
            {module.prerequisites && (
              <Badge variant="brand" className="text-[10px]">
                有前置
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
