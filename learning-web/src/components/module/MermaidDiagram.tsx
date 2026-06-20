import { useEffect, useRef, useState } from 'react';
import { useTheme } from '@/lib/theme';
import { fetchFile, fetchFileTree } from '@/lib/api';
import { flattenFileTree } from '@/lib/resolveParticipantFile';
import { useMermaidInteractivity } from '@/hooks/useMermaidInteractivity';
import { CallChainPanel } from '@/components/diagram/CallChainPanel';
import { Loader2, AlertCircle, Network, Info } from 'lucide-react';
import { Link } from 'react-router-dom';

interface MermaidDiagramProps {
  /** Path to the .mmd.md file, e.g. "analysis/callgraphs/03-micro/query-loop-sequence.mmd.md" */
  src: string;
  /** Display title */
  title?: string;
  className?: string;
}

/**
 * Mermaid 调用图渲染组件
 * 从 analysis/callgraphs/ 读取 .mmd.md 文件并渲染为交互式 SVG
 * 支持点击参与者和消息箭头查看调用链详情
 */
export function MermaidDiagram({ src, title, className }: MermaidDiagramProps) {
  const { resolvedTheme } = useTheme();
  const [svgContent, setSvgContent] = useState<string | null>(null);
  const [mermaidCode, setMermaidCode] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [knownFiles, setKnownFiles] = useState<string[]>([]);
  const [fileTreeLoaded, setFileTreeLoaded] = useState(false);
  const svgVersion = useRef(0);
  const [svgVer, setSvgVer] = useState(0);

  // 获取项目文件列表
  useEffect(() => {
    let cancelled = false;
    fetchFileTree()
      .then(tree => {
        if (!cancelled) {
          setKnownFiles(flattenFileTree(tree));
          setFileTreeLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFileTreeLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 交互 hook
  const { containerRef, parsed, participantMap, selection, clearSelection, fileMap } = useMermaidInteractivity(
    mermaidCode,
    knownFiles,
    svgVer,
  );

  // 加载并渲染 mermaid
  useEffect(() => {
    let cancelled = false;

    async function render() {
      setLoading(true);
      setError(null);

      try {
        // 1. 读取 mermaid 源文件
        const res = await fetchFile(src);
        let rawCode = res.content;

        // .mmd.md 文件可能包含 markdown 包裹的 mermaid 代码块
        const codeBlockMatch = rawCode.match(/```mermaid\s*\n([\s\S]*?)```/);
        if (codeBlockMatch) {
          rawCode = codeBlockMatch[1].trim();
        }

        if (!rawCode.trim()) {
          throw new Error('Empty mermaid content');
        }

        setMermaidCode(rawCode);

        // 2. 动态加载 mermaid 并渲染
        const mermaid = (await import('mermaid')).default;

        mermaid.initialize({
          startOnLoad: false,
          theme: resolvedTheme === 'dark' ? 'dark' : 'default',
          securityLevel: 'loose',
          flowchart: {
            useMaxWidth: true,
            htmlLabels: true,
          },
          sequence: {
            useMaxWidth: true,
            wrap: true,
          },
        });

        const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
        const { svg } = await mermaid.render(id, rawCode);

        if (!cancelled) {
          svgVersion.current++;
          setSvgContent(svg);
          setSvgVer(svgVersion.current);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '渲染失败');
          setLoading(false);
        }
      }
    }

    render();
    return () => {
      cancelled = true;
    };
  }, [src, resolvedTheme]);

  const hasParticipants = parsed.participants.length > 0;

  return (
    <div className={`mermaid-container ${className || ''}`}>
      {/* Header */}
      {title && (
        <div className="flex items-center gap-2 mb-3">
          <Network className="size-4 text-brand" />
          <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">渲染图表中...</span>
        </div>
      )}

      {/* Rendered SVG + 交互面板 */}
      {svgContent && !loading && (
        <>
          {/* 交互提示 */}
          {hasParticipants && fileTreeLoaded && (
            <div className="flex items-center gap-1.5 mb-2 text-[10px] text-muted-foreground">
              <Info className="size-3" />
              <span>点击参与者或消息箭头查看调用链</span>
            </div>
          )}

          <div className="flex">
            {/* SVG 容器 */}
            <div
              ref={containerRef}
              className="flex-1 min-w-0 overflow-x-auto flex justify-center"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid 本地生成的可信 SVG
              dangerouslySetInnerHTML={{ __html: svgContent }}
            />

            {/* 调用链详情面板 */}
            {selection && (
              <CallChainPanel
                selection={selection}
                participants={parsed.participants}
                messages={parsed.messages}
                participantMap={participantMap}
                fileMap={fileMap}
                onClose={clearSelection}
              />
            )}
          </div>
        </>
      )}

      {/* Error with fallback link */}
      {error && !loading && (
        <div className="text-center py-8">
          <AlertCircle className="size-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground mb-2">图表渲染失败: {error}</p>
          <Link to={`/doc/${src}`} className="text-sm text-brand hover:underline">
            查看源文件 →
          </Link>
        </div>
      )}

      {/* Source link */}
      {!loading && (
        <div className="mt-3 pt-2 border-t text-[10px] text-muted-foreground flex items-center justify-between">
          <code className="font-mono">{src.split('/').pop()}</code>
          <Link to={`/doc/${src}`} className="hover:text-foreground transition-colors">
            查看源码 →
          </Link>
        </div>
      )}
    </div>
  );
}
