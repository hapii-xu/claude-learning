import { marked, type Token, type Tokens } from 'marked';
import React, { Suspense, use, useMemo, useRef } from 'react';
import { LRUCache } from 'lru-cache';
import { useSettings } from '../hooks/useSettings.js';
import { Ansi, Box, useTheme } from '@anthropic/ink';
import { type CliHighlight, getCliHighlightPromise } from '../utils/cliHighlight.js';
import { hashContent } from '../utils/hash.js';
import { configureMarked, formatToken } from '../utils/markdown.js';
import { stripPromptXMLTags } from '../utils/messages.js';
import { MarkdownTable } from './MarkdownTable.js';

type Props = {
  children: string;
  /** 为 true 时，所有文本内容以 dim（暗色）渲染 */
  dimColor?: boolean;
};

// 模块级 token 缓存 — marked.lexer 是虚拟滚动重新挂载时的热点开销
//（每条约 ~3ms）。useMemo 在 unmount→remount 间无法存活，因此回滚到之前
// 可见的消息会重新解析。历史中的消息是不可变的；相同内容 → 相同 token。
// 用 hash 作为键以避免保留完整内容字符串（turn50→turn99 RSS 回退，#24180）。
const tokenCache = new LRUCache<string, Token[]>({ max: 500 });

// 表示 markdown 语法的字符。若不存在这些字符，则完全跳过约 ~3ms 的
// marked.lexer 调用 — 直接渲染为单个段落。覆盖了大多数纯句子的简短
// 助手回复和用户输入。用 indexOf（而非正则）检查以提升速度。
// 单个正则：匹配任意 MD 标记或有序列表起始（行首的 N. ）。
// 一次扫描替代 10× includes 扫描。
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /;
function hasMarkdownSyntax(s: string): boolean {
  // 取前 500 字符采样 — 若存在 markdown，通常出现在靠前位置（标题、
  // 代码围栏、列表）。长工具输出大多是纯文本尾部。
  return MD_SYNTAX_RE.test(s.length > 500 ? s.slice(0, 500) : s);
}

function cachedLexer(content: string): Token[] {
  // 快速路径：无 markdown 语法的纯文本 → 单个段落 token。
  // 跳过 marked.lexer 的完整 GFM 解析（长内容约 ~3ms）。不缓存 —
  // 重建只是一个对象分配，而缓存会保留 4× 内容（raw/text 字段）
  // 加上 hash 键，毫无收益。
  if (!hasMarkdownSyntax(content)) {
    return [
      {
        type: 'paragraph',
        raw: content,
        text: content,
        tokens: [{ type: 'text', raw: content, text: content }],
      } as Token,
    ];
  }
  const key = hashContent(content);
  const hit = tokenCache.get(key);
  if (hit) return hit;
  const tokens = marked.lexer(content);
  tokenCache.set(key, tokens);
  return tokens;
}

/**
 * 使用混合方式渲染 markdown 内容：
 * - 表格作为 React 组件渲染，采用合适的 flexbox 布局
 * - 其他内容通过 formatToken 渲染为 ANSI 字符串
 */
export function Markdown(props: Props): React.ReactNode {
  const settings = useSettings();
  if (settings.syntaxHighlightingDisabled) {
    return <MarkdownBody {...props} highlight={null} />;
  }
  // Suspense fallback 以 highlight=null 渲染 — 首次渲染时 cli-highlight
  // 加载期间约 ~50ms 显示纯 markdown。
  return (
    <Suspense fallback={<MarkdownBody {...props} highlight={null} />}>
      <MarkdownWithHighlight {...props} />
    </Suspense>
  );
}

function MarkdownWithHighlight(props: Props): React.ReactNode {
  const highlight = use(getCliHighlightPromise());
  return <MarkdownBody {...props} highlight={highlight} />;
}

function MarkdownBody({ children, dimColor, highlight }: Props & { highlight: CliHighlight | null }): React.ReactNode {
  const [theme] = useTheme();
  configureMarked();

  const elements = useMemo(() => {
    const tokens = cachedLexer(stripPromptXMLTags(children));
    const elements: React.ReactNode[] = [];
    let nonTableContent = '';

    function flushNonTableContent(): void {
      if (nonTableContent) {
        elements.push(
          <Ansi key={elements.length} dimColor={dimColor}>
            {nonTableContent.trim()}
          </Ansi>,
        );
        nonTableContent = '';
      }
    }

    for (const token of tokens) {
      if (token.type === 'table') {
        flushNonTableContent();
        elements.push(<MarkdownTable key={elements.length} token={token as Tokens.Table} highlight={highlight} />);
      } else {
        nonTableContent += formatToken(token, theme, 0, null, null, highlight);
      }
    }

    flushNonTableContent();
    return elements;
  }, [children, dimColor, highlight, theme]);

  return (
    <Box flexDirection="column" gap={1}>
      {elements}
    </Box>
  );
}

type StreamingProps = {
  children: string;
};

/**
 * 在流式输出期间渲染 markdown，按最后一个顶层块边界切分：之前的所有内容
 * 都是稳定的（memoized，永不重新解析），只有最后一个块按每个 delta 重新
 * 解析。marked.lexer() 会将未闭合的代码围栏正确处理为单个 token，因此块
 * 边界始终是安全的。
 *
 * 稳定边界只会前进（单调），因此渲染期间的 ref 变更是幂等的，在 StrictMode
 * 双重渲染下也是安全的。组件在轮次之间会卸载（streamingText → null），
 * 重置 ref。
 */
export function StreamingMarkdown({ children }: StreamingProps): React.ReactNode {
  // React Compiler：此组件按设计在渲染期间读写 stablePrefixRef.current。
  // 边界只会前进（单调），因此 ref 变更在 StrictMode 双重渲染下是幂等的 —
  // 但编译器无法证明这一点，而在 ref 读取周围加 memo 会破坏算法
  //（导致边界过期）。因此主动 opt out。
  'use no memo';
  configureMarked();

  // 在边界跟踪之前先剥离，使其与 <Markdown> 的剥离（第 29 行）一致。
  // 当闭合标签到达时，stripped(N+1) 不是 stripped(N) 的前缀，但下方的
  // startsWith 重置会处理这种情况 — 对较小的 stripped 字符串做一次重新词法分析。
  const stripped = stripPromptXMLTags(children);

  const stablePrefixRef = useRef('');

  // 若文本被替换则重置（防御性处理；通常由卸载处理）
  if (!stripped.startsWith(stablePrefixRef.current)) {
    stablePrefixRef.current = '';
  }

  // 仅从当前边界开始词法分析 — O(不稳定部分长度)，而非 O(全文长度)
  const boundary = stablePrefixRef.current.length;
  const tokens = marked.lexer(stripped.substring(boundary));

  // 最后一个非空白 token 是正在增长的块；之前的所有内容都是最终的
  let lastContentIdx = tokens.length - 1;
  while (lastContentIdx >= 0 && tokens[lastContentIdx]!.type === 'space') {
    lastContentIdx--;
  }
  let advance = 0;
  for (let i = 0; i < lastContentIdx; i++) {
    advance += tokens[i]!.raw.length;
  }
  if (advance > 0) {
    stablePrefixRef.current = stripped.substring(0, boundary + advance);
  }

  const stablePrefix = stablePrefixRef.current;
  const unstableSuffix = stripped.substring(stablePrefix.length);

  // stablePrefix 在 <Markdown> 内部通过 useMemo([children, ...]) 被 memo，
  // 因此随着不稳定后缀增长，它永不重新解析
  return (
    <Box flexDirection="column" gap={1}>
      {stablePrefix && <Markdown>{stablePrefix}</Markdown>}
      {unstableSuffix && <Markdown>{unstableSuffix}</Markdown>}
    </Box>
  );
}
