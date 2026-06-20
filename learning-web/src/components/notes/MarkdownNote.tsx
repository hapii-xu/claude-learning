import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/cn';
import { injectGlossary } from '@/components/glossary/replaceGlossaryTerms';

interface MarkdownNoteProps {
  content: string;
  className?: string;
  /** 用于紧凑场景（笔记卡片摘要），减少 vertical spacing */
  compact?: boolean;
}

/**
 * 共享 Markdown 渲染组件 — 支持 GFM（表格、删除线、任务列表）。
 * 代码块用 muted 背景；不引入 shiki 高亮，避免拉大 chunk。
 *
 * 术语表注入：在 p / li / td 节点里检测已知术语并加 HoverCard。
 * 代码块（code / pre）里不做术语检测。
 */
export function MarkdownNote({ content, className, compact = false }: MarkdownNoteProps) {
  if (!content.trim()) return null;

  return (
    <div
      className={cn(
        'text-sm text-foreground/90 leading-relaxed',
        compact ? 'space-y-1.5' : 'space-y-2',
        '[&_p]:m-0',
        '[&_h1]:text-base [&_h1]:font-semibold [&_h1]:mt-3 [&_h1]:mb-1',
        '[&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1',
        '[&_h3]:text-xs [&_h3]:font-semibold [&_h3]:uppercase [&_h3]:tracking-wider [&_h3]:text-muted-foreground [&_h3]:mt-2 [&_h3]:mb-1',
        '[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-0.5',
        '[&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:space-y-0.5',
        '[&_li>p]:m-0',
        '[&_code]:font-mono [&_code]:text-[0.85em] [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded',
        '[&_pre]:bg-muted [&_pre]:border [&_pre]:rounded-md [&_pre]:p-2.5 [&_pre]:my-2 [&_pre]:overflow-x-auto',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[0.85em] [&_pre_code]:leading-relaxed',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-brand/40 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_blockquote]:italic',
        '[&_a]:text-brand [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:opacity-80',
        '[&_table]:border-collapse [&_table]:text-xs',
        '[&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-muted [&_th]:font-medium',
        '[&_td]:border [&_td]:px-2 [&_td]:py-1',
        '[&_hr]:border-border [&_hr]:my-3',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p>{injectGlossary(children)}</p>,
          li: ({ children }) => <li>{injectGlossary(children)}</li>,
          td: ({ children }) => <td>{injectGlossary(children)}</td>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
