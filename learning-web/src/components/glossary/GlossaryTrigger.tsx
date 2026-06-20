import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card';
import { Link } from 'react-router-dom';
import { findModuleByFilePath } from '@/data/modules';
import { BookMarked, FileCode, Package, ArrowRight } from 'lucide-react';
import type { GlossaryTerm } from '@/data/glossary';

interface GlossaryTriggerProps {
  term: GlossaryTerm;
  children?: React.ReactNode;
}

/**
 * 术语触发器 — hover 时显示定义卡片
 * 复用了 FileRefLink 的 HoverCard 模式
 */
export function GlossaryTrigger({ term, children }: GlossaryTriggerProps) {
  const mod = term.primaryFile ? findModuleByFilePath(term.primaryFile) : undefined;

  return (
    <HoverCard openDelay={250} closeDelay={120}>
      <HoverCardTrigger asChild>
        <span className="glossary-term">{children || term.term}</span>
      </HoverCardTrigger>
      <HoverCardContent>
        <div className="space-y-2">
          {/* Term header */}
          <div className="flex items-center gap-2">
            <BookMarked className="size-4 text-brand shrink-0" />
            <span className="text-sm font-semibold text-foreground">{term.term}</span>
            {term.tags && term.tags.length > 0 && (
              <span className="ml-auto text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                {term.tags[0]}
              </span>
            )}
          </div>

          {/* Definition */}
          <p className="text-sm text-muted-foreground leading-relaxed">{term.definition}</p>

          {/* Primary file link */}
          {term.primaryFile && (
            <>
              <div className="flex items-center gap-2 pt-1 border-t">
                <FileCode className="size-3.5 text-muted-foreground shrink-0" />
                <code className="text-xs font-mono text-foreground/80 truncate">{term.primaryFile}</code>
              </div>
              {mod && (
                <div className="flex items-center gap-2">
                  <Package className="size-3.5 text-muted-foreground shrink-0" />
                  <Link
                    to={`/module/${mod.id}`}
                    className="text-xs text-brand hover:underline flex items-center gap-1"
                    onClick={e => e.stopPropagation()}
                  >
                    {mod.title}
                    <ArrowRight className="size-3" />
                  </Link>
                </div>
              )}
              <Link
                to={`/file/${term.primaryFile}`}
                className="text-[10px] text-muted-foreground hover:text-brand block pt-0.5"
              >
                查看源码 →
              </Link>
            </>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
