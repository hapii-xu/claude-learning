import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ARCHITECTURE_MAP,
  computeCoverage,
  expandPanelFiles,
  type ArchPanel,
  type ArchTone,
} from '@/data/architectureMap';
import { fileDescriptions } from '@/data/fileDescriptions';
import { cn } from '@/lib/cn';
import { Network, AlertCircle } from 'lucide-react';

const TONE_STYLE: Record<ArchTone, { wrap: string; title: string; chip: string; badge: string }> = {
  orange: {
    wrap: 'border-orange-300/70 dark:border-orange-800/60 bg-orange-50/60 dark:bg-orange-950/20',
    title: 'text-orange-700 dark:text-orange-300',
    chip: 'bg-orange-100/60 dark:bg-orange-900/30 hover:bg-orange-200/70 dark:hover:bg-orange-900/50 text-orange-900 dark:text-orange-100 border-orange-200/60 dark:border-orange-800/50',
    badge: 'bg-orange-200/60 dark:bg-orange-900/40 text-orange-800 dark:text-orange-200',
  },
  amber: {
    wrap: 'border-amber-300/70 dark:border-amber-800/60 bg-amber-50/60 dark:bg-amber-950/20',
    title: 'text-amber-700 dark:text-amber-300',
    chip: 'bg-amber-100/60 dark:bg-amber-900/30 hover:bg-amber-200/70 dark:hover:bg-amber-900/50 text-amber-900 dark:text-amber-100 border-amber-200/60 dark:border-amber-800/50',
    badge: 'bg-amber-200/60 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200',
  },
  teal: {
    wrap: 'border-teal-300/70 dark:border-teal-800/60 bg-teal-50/60 dark:bg-teal-950/20',
    title: 'text-teal-700 dark:text-teal-300',
    chip: 'bg-teal-100/60 dark:bg-teal-900/30 hover:bg-teal-200/70 dark:hover:bg-teal-900/50 text-teal-900 dark:text-teal-100 border-teal-200/60 dark:border-teal-800/50',
    badge: 'bg-teal-200/60 dark:bg-teal-900/40 text-teal-800 dark:text-teal-200',
  },
  sky: {
    wrap: 'border-sky-300/70 dark:border-sky-800/60 bg-sky-50/60 dark:bg-sky-950/20',
    title: 'text-sky-700 dark:text-sky-300',
    chip: 'bg-sky-100/60 dark:bg-sky-900/30 hover:bg-sky-200/70 dark:hover:bg-sky-900/50 text-sky-900 dark:text-sky-100 border-sky-200/60 dark:border-sky-800/50',
    badge: 'bg-sky-200/60 dark:bg-sky-900/40 text-sky-800 dark:text-sky-200',
  },
  violet: {
    wrap: 'border-violet-300/70 dark:border-violet-800/60 bg-violet-50/60 dark:bg-violet-950/20',
    title: 'text-violet-700 dark:text-violet-300',
    chip: 'bg-violet-100/60 dark:bg-violet-900/30 hover:bg-violet-200/70 dark:hover:bg-violet-900/50 text-violet-900 dark:text-violet-100 border-violet-200/60 dark:border-violet-800/50',
    badge: 'bg-violet-200/60 dark:bg-violet-900/40 text-violet-800 dark:text-violet-200',
  },
  rose: {
    wrap: 'border-rose-300/70 dark:border-rose-800/60 bg-rose-50/60 dark:bg-rose-950/20',
    title: 'text-rose-700 dark:text-rose-300',
    chip: 'bg-rose-100/60 dark:bg-rose-900/30 hover:bg-rose-200/70 dark:hover:bg-rose-900/50 text-rose-900 dark:text-rose-100 border-rose-200/60 dark:border-rose-800/50',
    badge: 'bg-rose-200/60 dark:bg-rose-900/40 text-rose-800 dark:text-rose-200',
  },
  green: {
    wrap: 'border-emerald-300/70 dark:border-emerald-800/60 bg-emerald-50/60 dark:bg-emerald-950/20',
    title: 'text-emerald-700 dark:text-emerald-300',
    chip: 'bg-emerald-100/60 dark:bg-emerald-900/30 hover:bg-emerald-200/70 dark:hover:bg-emerald-900/50 text-emerald-900 dark:text-emerald-100 border-emerald-200/60 dark:border-emerald-800/50',
    badge: 'bg-emerald-200/60 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200',
  },
};

function shortenPath(path: string, panel: ArchPanel): string {
  for (const prefix of panel.pathPrefixes) {
    if (path.startsWith(prefix) && prefix.endsWith('/')) {
      return path.slice(prefix.length);
    }
    if (path === prefix) {
      const parts = prefix.split('/');
      return parts[parts.length - 1];
    }
  }
  for (const pin of panel.pinnedFiles ?? []) {
    if (path === pin && pin.endsWith('/')) {
      const parts = pin.slice(0, -1).split('/');
      return `${parts[parts.length - 1]}/`;
    }
  }
  return path;
}

export function ArchitecturePage() {
  const coverage = useMemo(() => computeCoverage(), []);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-8 animate-fade-up">
      <Breadcrumbs />

      <div className="flex items-center gap-3 mb-6">
        <div className="size-10 rounded-lg bg-brand/10 flex items-center justify-center shrink-0">
          <Network className="size-5 text-brand" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-foreground">src/ 架构总览</h1>
          <p className="text-sm text-muted-foreground">
            按职责分组的色块鸟瞰图 · 点击文件跳转详情 · 覆盖 {coverage.total} 个文件
          </p>
        </div>
      </div>

      <div className="space-y-8">
        {ARCHITECTURE_MAP.map(row => (
          <section key={row.id}>
            <div className="flex items-baseline gap-2 mb-3">
              <h2 className="text-base font-semibold text-foreground">{row.title}</h2>
              <span className="text-xs text-muted-foreground">{row.panels.length} 个职责模块</span>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-4">
              {row.panels.map(panel => (
                <PanelCard
                  key={panel.id}
                  panel={panel}
                  expanded={!!expanded[panel.id]}
                  onToggle={() => setExpanded(prev => ({ ...prev, [panel.id]: !prev[panel.id] }))}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      {import.meta.env.DEV && (
        <div className="mt-10 rounded-lg border border-dashed border-muted-foreground/30 bg-muted/30 p-4 text-xs">
          <div className="flex items-center gap-2 mb-1.5 text-muted-foreground">
            <AlertCircle className="size-3.5" />
            <span className="font-medium">DEV · 覆盖率自检</span>
          </div>
          <div className="font-mono text-muted-foreground">
            已归属 <span className="text-foreground">{coverage.assigned}</span> /{' '}
            <span className="text-foreground">{coverage.total}</span> · 未归属{' '}
            <span className={coverage.unassigned > 50 ? 'text-rose-600' : 'text-emerald-600'}>
              {coverage.unassigned}
            </span>
          </div>
          {coverage.unassignedSample.length > 0 && (
            <div className="mt-2 text-[10px] text-muted-foreground/70 leading-relaxed">
              未归属示例：{coverage.unassignedSample.join(' · ')}
              {coverage.unassigned > 12 ? ' ...' : ''}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PanelCard({ panel, expanded, onToggle }: { panel: ArchPanel; expanded: boolean; onToggle: () => void }) {
  const files = useMemo(() => expandPanelFiles(panel), [panel]);
  const style = TONE_STYLE[panel.tone];
  const OVERFLOW_THRESHOLD = 36;
  const isOverflow = files.length > OVERFLOW_THRESHOLD;

  return (
    <div className={cn('rounded-xl border p-4 flex flex-col', style.wrap)}>
      <header className="mb-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className={cn('text-sm font-semibold tracking-wide', style.title)}>{panel.title}</h3>
          <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-mono', style.badge)}>{files.length}</span>
        </div>
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mt-0.5">{panel.titleEn}</p>
      </header>

      <ul className="mb-3 space-y-0.5 text-[11px] text-foreground/75 leading-relaxed">
        {panel.bullets.map((b, i) => (
          <li key={i} className="flex gap-1.5">
            <span className={cn('shrink-0 mt-0.5', style.title)}>·</span>
            <span>{b}</span>
          </li>
        ))}
      </ul>

      <div
        className={cn(
          'grid grid-cols-1 sm:grid-cols-2 gap-1 text-[11px] overflow-y-auto pr-1',
          expanded ? 'max-h-none' : 'max-h-[320px]',
        )}
      >
        {files.map(path => {
          const desc = fileDescriptions[path] ?? '';
          const short = shortenPath(path, panel);
          return (
            <Tooltip key={path}>
              <TooltipTrigger asChild>
                <Link
                  to={`/file/${path.replace(/\/$/, '')}`}
                  className={cn('block font-mono px-1.5 py-0.5 rounded border truncate transition-colors', style.chip)}
                >
                  {short}
                </Link>
              </TooltipTrigger>
              <TooltipContent className="max-w-md">
                <div className="font-mono text-[10px] opacity-80 mb-0.5">{path}</div>
                {desc && <div className="text-xs leading-relaxed">{desc}</div>}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      {isOverflow && (
        <button
          type="button"
          onClick={onToggle}
          className="mt-2 text-[10px] text-muted-foreground hover:text-foreground transition-colors self-start"
        >
          {expanded ? '收起' : `展开全部 ${files.length} 个`}
        </button>
      )}
    </div>
  );
}
