import { GLOSSARY, buildGlossaryRegex, findTermByMatch, type GlossaryTerm } from '@/data/glossary';
import { GlossaryTrigger } from './GlossaryTrigger';

export type GlossaryPart = { type: 'text'; content: string } | { type: 'term'; term: GlossaryTerm };

/**
 * 将文本中的术语替换为 GlossaryPart 序列
 * 镜像 FileRefLink.tsx 中的 replaceFilePaths 模式
 */
export function replaceGlossaryTerms(text: string, terms: GlossaryTerm[] = GLOSSARY): GlossaryPart[] {
  const parts: GlossaryPart[] = [];
  let lastIndex = 0;

  const regex = buildGlossaryRegex(terms);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const matched = match[0];
    const term = findTermByMatch(matched, terms);

    if (!term) continue;

    // 添加匹配前的文本
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }

    parts.push({ type: 'term', term });
    lastIndex = match.index + matched.length;
  }

  // 添加剩余文本
  if (lastIndex < text.length) {
    parts.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return parts;
}

/**
 * 递归遍历 React children，对 string 类型注入术语检测（带 HoverCard）
 * 用于 MarkdownNote 注入
 */
export function injectGlossary(children: React.ReactNode, terms: GlossaryTerm[] = GLOSSARY): React.ReactNode {
  if (typeof children === 'string') {
    return processString(children, terms);
  }

  if (Array.isArray(children)) {
    return children.map((child, i) => {
      if (typeof child === 'string') {
        return <span key={i}>{processString(child, terms)}</span>;
      }
      return child;
    });
  }

  // 其他 React 元素保持不变
  return children;
}

function processString(text: string, terms: GlossaryTerm[]): React.ReactNode {
  const parts = replaceGlossaryTerms(text, terms);
  // 无术语命中时直接返回原文
  if (parts.length === 1 && parts[0].type === 'text') return text;
  return parts.map((p, i) =>
    p.type === 'text' ? (
      p.content
    ) : (
      <GlossaryTrigger key={i} term={p.term}>
        {p.term.term}
      </GlossaryTrigger>
    ),
  );
}
