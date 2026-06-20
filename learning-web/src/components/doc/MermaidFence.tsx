import { useEffect, useState } from 'react';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/cn';
import { fetchFileTree } from '@/lib/api';
import { flattenFileTree } from '@/lib/resolveParticipantFile';
import { SequenceCanvas } from '@/components/diagram/SequenceCanvas';
import { AlertCircle, Loader2 } from 'lucide-react';

interface MermaidFenceProps {
  code: string;
  className?: string;
}

/**
 * Markdown 中的 mermaid 代码块渲染：
 * - sequenceDiagram → 自定义 React-SVG 交互画布 (SequenceCanvas)
 * - 其他类型（flowchart/gantt 等） → 退化为原生 mermaid 渲染（无交互）
 */
export function MermaidFence({ code, className }: MermaidFenceProps) {
  const isSequence = /^\s*sequenceDiagram\b/m.test(code.trim());

  if (isSequence) {
    return <SequenceFence code={code} className={className} />;
  }
  return <PlainMermaidFence code={code} className={className} />;
}

// ─── Sequence diagram path ─────────────────────────────────────────

function SequenceFence({ code, className }: MermaidFenceProps) {
  const [knownFiles, setKnownFiles] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchFileTree()
      .then(tree => {
        if (!cancelled) setKnownFiles(flattenFileTree(tree));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return <SequenceCanvas source={code} knownFiles={knownFiles} className={className} />;
}

// ─── Plain mermaid fallback (flowchart/gantt/etc.) ─────────────────

function PlainMermaidFence({ code, className }: MermaidFenceProps) {
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function render() {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: resolvedTheme === 'dark' ? 'dark' : 'default',
          securityLevel: 'loose',
        });
        const id = `mermaid-fence-${Math.random().toString(36).slice(2, 8)}`;
        const { svg: rendered } = await mermaid.render(id, code.trim());
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Mermaid render failed');
          setSvg(null);
        }
      }
    }
    render();
    return () => {
      cancelled = true;
    };
  }, [code, resolvedTheme]);

  if (error) {
    return (
      <div className={cn('my-4 p-3 rounded-lg border bg-surface-1', className)}>
        <div className="flex items-center gap-2 text-status-error mb-2">
          <AlertCircle className="size-4" />
          <span className="text-xs font-medium">Mermaid 渲染失败</span>
        </div>
        <pre className="text-xs font-mono overflow-x-auto text-muted-foreground">{code}</pre>
      </div>
    );
  }
  if (!svg) {
    return (
      <div className={cn('my-4 p-4 rounded-lg border bg-surface-1 text-center', className)}>
        <Loader2 className="size-4 animate-spin inline-block mr-2 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Mermaid 图表加载中...</span>
      </div>
    );
  }
  return (
    <div
      className={cn('my-4 p-4 rounded-lg border bg-surface-1 overflow-x-auto', className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid svg
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
