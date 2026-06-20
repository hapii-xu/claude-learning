import { Link } from 'react-router-dom';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card';
import { Badge } from '@/components/ui/badge';
import { getFileDescription } from '@/data/fileDescriptions';
import { findModuleByFilePath } from '@/data/modules';
import { FileCode, Package, ArrowRight } from 'lucide-react';

interface FileRefLinkProps {
  path: string;
  children?: React.ReactNode;
  className?: string;
}

/**
 * 文件引用链接 — 渲染为可点击链接，hover 时显示文件信息卡片
 * 在文档中检测到 src/xxx.ts 或 packages/xxx/ 路径时使用
 */
export function FileRefLink({ path, children, className }: FileRefLinkProps) {
  const description = getFileDescription(path);
  const mod = findModuleByFilePath(path);
  const hasInfo = description || mod;

  if (!hasInfo) {
    // 没有描述信息，只渲染普通链接
    return (
      <Link to={`/file/${path}`} className={`file-ref-link ${className || ''}`}>
        {children || path}
      </Link>
    );
  }

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <Link to={`/file/${path}`} className={`file-ref-link ${className || ''}`}>
          {children || path}
        </Link>
      </HoverCardTrigger>
      <HoverCardContent>
        <div className="space-y-2">
          {/* File path header */}
          <div className="flex items-start gap-2">
            <FileCode className="size-4 text-brand shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <code className="text-sm font-mono text-foreground break-all">{path}</code>
            </div>
          </div>

          {/* Description */}
          {description && <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>}

          {/* Module membership */}
          {mod && (
            <div className="flex items-center gap-2 pt-1 border-t">
              <Package className="size-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">所属模块</span>
              <Link
                to={`/module/${mod.id}`}
                className="text-xs text-brand hover:underline flex items-center gap-1 ml-auto"
                onClick={e => e.stopPropagation()}
              >
                {mod.title}
                <ArrowRight className="size-3" />
              </Link>
            </div>
          )}

          {/* Quick action hint */}
          <div className="text-[10px] text-muted-foreground pt-1">点击查看源码 →</div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * 正则表达式：匹配常见的源码文件路径
 * 匹配 src/xxx.ts, packages/xxx/, scripts/xxx.ts 等
 */
export const FILE_PATH_REGEX = /\b(src|packages|scripts|analysis)\/[\w@\-./]+\.(ts|tsx|js|jsx|md|mdx|json|css|mmd)\b/g;

/**
 * 将文本中的文件路径替换为 FileRefLink 组件
 */
export function replaceFilePaths(
  text: string,
): Array<{ type: 'text'; content: string } | { type: 'fileRef'; path: string }> {
  const parts: Array<{ type: 'text'; content: string } | { type: 'fileRef'; path: string }> = [];
  let lastIndex = 0;

  const regex = new RegExp(FILE_PATH_REGEX.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }

    parts.push({ type: 'fileRef', path: match[0] });
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return parts;
}
