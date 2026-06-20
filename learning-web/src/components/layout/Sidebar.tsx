import { NavLink, useLocation } from 'react-router-dom';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { modules, moduleGroups } from '@/data/modules';
import { cn } from '@/lib/cn';
import { useState } from 'react';
import { FileTreeExplorer } from './FileTreeExplorer';
import {
  ChevronRight,
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
  FileCode,
  GitCompare,
  Search,
  FolderTree,
  Map,
  StickyNote,
  LayoutDashboard,
  MessageCircle,
  Bookmark,
  Route,
  Home,
  Plug,
  BookOpen,
  Webhook,
  Package,
  Network,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { LEARNING_PATHS } from '@/data/learningPaths';

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
  Plug,
  BookOpen,
  Webhook,
};

const navLinkClass = (isActive: boolean) =>
  cn(
    'flex items-center gap-2 text-xs transition-colors rounded-md px-2 py-1.5',
    isActive ? 'text-brand bg-brand/10 font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-accent',
  );

export function Sidebar() {
  const location = useLocation();

  return (
    <aside className="w-64 border-r bg-card/50 flex flex-col h-full overflow-hidden">
      {/* ─── 学习模块 (top, scrollable) ─── */}
      <SectionHeader label="学习模块" />
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
        <div className="space-y-0.5">
          <NavLink to="/" className={({ isActive }) => navLinkClass(isActive)}>
            <Home className="size-3.5" />
            <span>首页</span>
          </NavLink>
          <NavLink to="/dashboard" className={({ isActive }) => navLinkClass(isActive)}>
            <LayoutDashboard className="size-3.5" />
            <span>学习仪表盘</span>
          </NavLink>
          <NavLink to="/graph" className={({ isActive }) => navLinkClass(isActive)}>
            <Map className="size-3.5" />
            <span>知识图谱</span>
          </NavLink>
          <NavLink to="/notes" className={({ isActive }) => navLinkClass(isActive)}>
            <StickyNote className="size-3.5" />
            <span>笔记中心</span>
          </NavLink>
          <NavLink to="/bookmarks" className={({ isActive }) => navLinkClass(isActive)}>
            <Bookmark className="size-3.5" />
            <span>书签</span>
          </NavLink>
          <NavLink to="/architecture" className={({ isActive }) => navLinkClass(isActive)}>
            <Network className="size-3.5" />
            <span>架构总览</span>
          </NavLink>
          <LearningPathsSection />
          <NavLink to="/chat" className={({ isActive }) => navLinkClass(isActive)}>
            <MessageCircle className="size-3.5" />
            <span>学习对话</span>
          </NavLink>

          <Separator className="my-2" />

          {moduleGroups.map(group => {
            const groupModules = modules.filter(m => m.group.id === group.id);
            if (groupModules.length === 0) return null;
            const isActive = groupModules.some(m => location.pathname.startsWith(`/module/${m.id}`));
            return <ModuleGroup key={group.id} group={group} modules={groupModules} defaultOpen={isActive} />;
          })}
        </div>
      </div>

      {/* ─── 源码浏览 (bottom, independently scrollable) ─── */}
      <Separator />
      <SectionHeader label="源码浏览" />
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
        <div className="space-y-0.5">
          <NavLink to="/browse" className={({ isActive }) => navLinkClass(isActive)}>
            <FolderTree className="size-3.5" />
            <span>目录浏览</span>
          </NavLink>
          <NavLink to="/packages" className={({ isActive }) => navLinkClass(isActive)}>
            <Package className="size-3.5" />
            <span>Packages 地图</span>
          </NavLink>
          <NavLink to="/search" className={({ isActive }) => navLinkClass(isActive)}>
            <Search className="size-3.5" />
            <span>搜索</span>
          </NavLink>
          <NavLink
            to="/file/src/entrypoints/cli.tsx"
            className={({ isActive }) => navLinkClass(isActive && location.pathname.startsWith('/file/'))}
          >
            <FileCode className="size-3.5" />
            <span>浏览源码文件</span>
          </NavLink>
          <NavLink
            to="/compare/src/query.ts__compare__src/QueryEngine.ts"
            className={({ isActive }) => navLinkClass(isActive && location.pathname.startsWith('/compare/'))}
          >
            <GitCompare className="size-3.5" />
            <span>文件对比</span>
          </NavLink>

          <Separator className="my-2" />

          <FileTreeExplorer />
        </div>
      </div>
    </aside>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-4 pt-3 pb-1 shrink-0">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</h2>
    </div>
  );
}

function ModuleGroup({
  group,
  modules: mods,
  defaultOpen,
}: {
  group: (typeof moduleGroups)[number];
  modules: typeof modules;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-0.5">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer">
        <ChevronRight className={cn('size-3.5 transition-transform duration-200', open && 'rotate-90')} />
        <span>{group.title}</span>
        <span className="ml-auto text-[10px] opacity-50">{mods.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-2 border-l pl-1 mt-0.5">
          {mods.map(mod => (
            <ModuleLink key={mod.id} module={mod} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ModuleLink({ module }: { module: (typeof modules)[number] }) {
  const Icon = iconMap[module.icon] || FileCode;
  const location = useLocation();
  const isActive = location.pathname === `/module/${module.id}`;

  return (
    <NavLink
      to={`/module/${module.id}`}
      className={cn(
        'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[11px] transition-colors',
        isActive ? 'bg-brand/10 text-brand font-medium' : 'text-foreground/70 hover:text-foreground hover:bg-accent',
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{module.title}</span>
      <Badge variant={isActive ? 'brand' : 'secondary'} className="ml-auto text-[10px] px-1.5 h-4">
        {module.files.length}
      </Badge>
    </NavLink>
  );
}

function LearningPathsSection() {
  const location = useLocation();
  const isPathsActive = location.pathname.startsWith('/path') || location.pathname === '/paths';
  const [open, setOpen] = useState(isPathsActive);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center">
        <CollapsibleTrigger className="flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer">
          <ChevronRight className={cn('size-3 transition-transform duration-200', open && 'rotate-90')} />
          <Route className="size-3.5" />
          <span>学习路径</span>
          <span className="ml-auto text-[10px] opacity-50">{LEARNING_PATHS.length}</span>
        </CollapsibleTrigger>
        <NavLink
          to="/paths"
          className="text-[10px] text-muted-foreground hover:text-brand px-1.5 py-0.5 rounded hover:bg-accent transition-colors"
          title="查看所有路径"
        >
          全部
        </NavLink>
      </div>
      <CollapsibleContent>
        <div className="ml-4 border-l pl-1 mt-0.5 space-y-0.5">
          {LEARNING_PATHS.map(path => {
            const isActive = location.pathname === `/path/${path.id}`;
            return (
              <NavLink
                key={path.id}
                to={`/path/${path.id}`}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors',
                  isActive
                    ? 'text-brand bg-brand/10 font-medium'
                    : 'text-foreground/60 hover:text-foreground hover:bg-accent',
                )}
              >
                <span className="truncate">{path.title}</span>
                <span className="ml-auto text-[9px] opacity-40">{path.stations.length}站</span>
              </NavLink>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
