import { useParams, Link } from 'react-router-dom';
import { useEffect } from 'react';
import { getModuleById, modules } from '@/data/modules';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { MermaidDiagram } from '@/components/module/MermaidDiagram';
import { ModuleNotes } from '@/components/module/ModuleNotes';
import { useProgress } from '@/hooks/useProgress';
import { estimateReadingTime, formatReadingTime } from '@/lib/readingTime';
import {
  FileCode,
  ArrowRight,
  BookOpen,
  Lightbulb,
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  Circle,
  Clock,
  Users,
  Timer,
} from 'lucide-react';
import type { ModuleFile } from '@/data/types';

const roleLabels: Record<string, { label: string; variant: 'entry' | 'core' | 'util' | 'config' | 'test' }> = {
  entry: { label: '入口', variant: 'entry' },
  core: { label: '核心', variant: 'core' },
  util: { label: '工具', variant: 'util' },
  config: { label: '配置', variant: 'config' },
  test: { label: '测试', variant: 'test' },
};

export function ModulePage() {
  const { moduleId } = useParams<{ moduleId: string }>();
  const mod = moduleId ? getModuleById(moduleId) : undefined;
  const { markVisited, toggleModule, isCompleted, progress } = useProgress();

  useEffect(() => {
    if (moduleId) markVisited(moduleId);
  }, [moduleId, markVisited]);

  if (!mod) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-12 text-center">
        <AlertCircle className="size-12 text-muted-foreground mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">模块未找到</h2>
        <p className="text-muted-foreground">
          模块 "{moduleId}" 不存在。
          <Link to="/" className="text-brand hover:underline ml-1">
            返回首页
          </Link>
        </p>
      </div>
    );
  }

  const completed = isCompleted(mod.id);
  const lastVisited = progress.lastVisited[mod.id];
  const dependents = modules.filter(m => m.prerequisites?.includes(mod.id));

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 animate-fade-up">
      <Breadcrumbs />

      {/* Module Header */}
      <div className="mb-8">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
              <span>{mod.group.title}</span>
              <ChevronRight className="size-3.5" />
              <span className="text-foreground">{mod.titleEn}</span>
            </div>
            <h1 className="text-2xl font-bold text-foreground mb-3">{mod.title}</h1>
          </div>
          <Button
            variant={completed ? 'brand' : 'outline'}
            size="sm"
            onClick={() => toggleModule(mod.id)}
            className="shrink-0 gap-1.5"
          >
            {completed ? <CheckCircle2 className="size-4" /> : <Circle className="size-4" />}
            {completed ? '已学完' : '标记学完'}
          </Button>
        </div>
        <p className="text-muted-foreground text-base leading-relaxed max-w-3xl">{mod.description}</p>

        {/* Key Concepts */}
        {mod.keyConcepts && mod.keyConcepts.length > 0 && (
          <div className="flex items-center gap-2 mt-4 flex-wrap">
            <Lightbulb className="size-4 text-brand" />
            {mod.keyConcepts.map(concept => (
              <Badge key={concept} variant="brand">
                {concept}
              </Badge>
            ))}
          </div>
        )}

        {/* Prerequisites */}
        {mod.prerequisites && mod.prerequisites.length > 0 && (
          <div className="flex items-center gap-2 mt-3 text-sm flex-wrap">
            <span className="text-muted-foreground">前置模块：</span>
            {mod.prerequisites.map(preId => {
              const preMod = getModuleById(preId);
              if (!preMod) return null;
              return (
                <Link
                  key={preId}
                  to={`/module/${preId}`}
                  className="flex items-center gap-1 text-brand hover:underline"
                >
                  {preMod.title}
                  <ArrowRight className="size-3" />
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <Separator className="mb-6" />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* File List — Main Content */}
        <div className="lg:col-span-2">
          <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
            <FileCode className="size-5" />
            核心文件
            <Badge variant="secondary">{mod.files.length}</Badge>
          </h2>
          <div className="space-y-2">
            {mod.files.map(file => (
              <FileCard key={file.path} file={file} moduleId={mod.id} />
            ))}
          </div>
        </div>

        {/* Sidebar — Docs + Call Graph + Meta */}
        <div className="space-y-6">
          {/* Module Meta */}
          <Card>
            <CardContent className="pt-5 space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <Timer className="size-4 text-muted-foreground" />
                <span className="text-muted-foreground">预计阅读：{formatReadingTime(estimateReadingTime(mod))}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Clock className="size-4 text-muted-foreground" />
                <span className="text-muted-foreground">
                  {lastVisited ? `上次访问：${new Date(lastVisited).toLocaleString('zh-CN')}` : '首次访问'}
                </span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <FileCode className="size-4 text-muted-foreground" />
                <span className="text-muted-foreground">{mod.files.length} 个核心文件</span>
              </div>
              {mod.docPaths && (
                <div className="flex items-center gap-2 text-sm">
                  <BookOpen className="size-4 text-muted-foreground" />
                  <span className="text-muted-foreground">{mod.docPaths.length} 篇相关文档</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Dependent Modules */}
          {dependents.length > 0 && (
            <Card>
              <CardContent className="pt-5">
                <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                  <Users className="size-4 text-brand" />
                  后续模块
                </h3>
                <div className="space-y-1.5">
                  {dependents.map(dep => (
                    <Link
                      key={dep.id}
                      to={`/module/${dep.id}`}
                      className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-md px-2 py-1.5 transition-colors"
                    >
                      <span className="truncate">{dep.title}</span>
                      <ArrowRight className="size-3 ml-auto shrink-0" />
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Related Docs */}
          {mod.docPaths && mod.docPaths.length > 0 && (
            <Card>
              <CardContent className="pt-5">
                <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                  <BookOpen className="size-4 text-brand" />
                  相关文档
                </h3>
                <div className="space-y-2">
                  {mod.docPaths.map(docPath => {
                    const docName = docPath.split('/').pop()?.replace('.mdx', '').replace(/-/g, ' ') || docPath;
                    return (
                      <Link
                        key={docPath}
                        to={`/doc/${docPath}`}
                        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-md px-2 py-1.5 transition-colors"
                      >
                        <BookOpen className="size-3.5 shrink-0" />
                        <span className="truncate capitalize">{docName}</span>
                        <ArrowRight className="size-3 ml-auto shrink-0 opacity-0 hover:opacity-100" />
                      </Link>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Call Graph */}
          {mod.callGraph && <MermaidDiagram src={mod.callGraph} title="调用链路图" />}
        </div>
      </div>
    </div>
  );
}

function FileCard({ file, moduleId }: { file: ModuleFile; moduleId: string }) {
  const role = roleLabels[file.role] || roleLabels.core;
  const isDirectory = file.path.endsWith('/');

  return (
    <Link to={isDirectory ? '#' : `/file/${file.path}`} className="block">
      <div className="group flex items-start gap-3 rounded-lg border p-3 hover:border-brand/40 hover:bg-accent/50 transition-all">
        <div className="mt-0.5">
          <FileCode className="size-4 text-muted-foreground group-hover:text-brand transition-colors" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <code className="text-sm font-mono text-foreground group-hover:text-brand transition-colors truncate">
              {file.path}
            </code>
            <Badge variant={role.variant} className="text-[10px] shrink-0">
              {role.label}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground line-clamp-2">{file.description}</p>
          {file.keyExports && file.keyExports.length > 0 && (
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              <span className="text-[10px] text-muted-foreground">导出：</span>
              {file.keyExports.map(exp => (
                <code key={exp} className="text-[11px] font-mono bg-surface-2 px-1.5 py-0.5 rounded text-brand">
                  {exp}
                </code>
              ))}
            </div>
          )}
        </div>
        <ArrowRight className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity mt-1 shrink-0" />
      </div>
    </Link>
  );
}
