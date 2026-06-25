import { resolve as resolvePath } from 'path';
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useRegisterOverlay } from '../context/overlayContext.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Text } from '@anthropic/ink';
import { logEvent } from '../services/analytics/index.js';
import { getCwd } from '../utils/cwd.js';
import { openFileInExternalEditor } from '../utils/editor.js';
import { truncatePathMiddle, truncateToWidth } from '../utils/format.js';
import { highlightMatch } from '../utils/highlightMatch.js';
import { relativePath } from '../utils/permissions/filesystem.js';
import { readFileInRange } from '../utils/readFileInRange.js';
import { ripGrepStream } from '../utils/ripgrep.js';
import { FuzzyPicker, LoadingState } from '@anthropic/ink';

type Props = {
  onDone: () => void;
  onInsert: (text: string) => void;
};

type Match = {
  file: string;
  line: number;
  text: string;
};

const VISIBLE_RESULTS = 12;
const DEBOUNCE_MS = 100;
const PREVIEW_CONTEXT_LINES = 4;
// rg -m 是按文件计的；我们也对解析后的数组设上限以限制内存。
const MAX_MATCHES_PER_FILE = 10;
const MAX_TOTAL_MATCHES = 500;

/**
 * Global Search 对话框（ctrl+shift+f / cmd+shift+f）。
 * 对工作区进行防抖的 ripgrep 搜索。
 */
export function GlobalSearchDialog({ onDone, onInsert }: Props): React.ReactNode {
  useRegisterOverlay('global-search');
  const { columns, rows } = useTerminalSize();
  const previewOnRight = columns >= 140;
  // 外壳（标题 + 搜索 + matchLabel + 提示 + 面板边框 + 间距）会占用
  // 约 14 行。在矮终端上缩小列表，避免对话框被裁剪。
  const visibleResults = Math.min(VISIBLE_RESULTS, Math.max(4, rows - 14));

  const [matches, setMatches] = useState<Match[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState<Match | undefined>(undefined);
  const [preview, setPreview] = useState<{
    file: string;
    line: number;
    content: string;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      abortRef.current?.abort();
    };
  }, []);

  // 加载聚焦匹配项周围的上下文行。AbortController 防止
  // 长按 ↓ 时堆积过多读取请求。
  useEffect(() => {
    if (!focused) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    const absolute = resolvePath(getCwd(), focused.file);
    const start = Math.max(0, focused.line - PREVIEW_CONTEXT_LINES - 1);
    void readFileInRange(absolute, start, PREVIEW_CONTEXT_LINES * 2 + 1, undefined, controller.signal)
      .then(r => {
        if (controller.signal.aborted) return;
        setPreview({
          file: focused.file,
          line: focused.line,
          content: r.content,
        });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setPreview({
          file: focused.file,
          line: focused.line,
          content: '（预览不可用）',
        });
      });
    return () => controller.abort();
  }, [focused]);

  const handleQueryChange = (q: string) => {
    setQuery(q);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    abortRef.current?.abort();

    if (!q.trim()) {
      setMatches(m => (m.length ? [] : m));
      setIsSearching(false);
      setTruncated(false);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setIsSearching(true);
    setTruncated(false);
    // 在 rg 遍历时客户端过滤已有结果 —— 让屏幕上保持有内容，
    // 而不是闪白屏。rg 结果是合并进来的（按 file:line 去重）而非替换，
    // 所以在一次查询内计数是单调的：只随 rg 流式输出增长，绝不会跌回
    // 第一个 chunk 的大小。缩小范围（新查询是旧查询的扩展）：过滤是精确的 ——
    // 任何匹配旧 -F -i 字面量的行，当且仅当其文本包含新查询的小写形式时
    // 也匹配新查询。非缩小范围（扩大/不同）：过滤是尽力而为 ——
    // 可能短暂显示一个子集，直到 rg 填充其余结果。
    const queryLower = q.toLowerCase();
    setMatches(m => {
      const filtered = m.filter(match => match.text.toLowerCase().includes(queryLower));
      return filtered.length === m.length ? m : filtered;
    });

    timeoutRef.current = setTimeout(
      (query, controller, setMatches, setTruncated, setIsSearching) => {
        // 当给定绝对路径目标时，ripgrep 会输出绝对路径，
        // 因此需要相对于 cwd 进行转换，以在截断显示中保留目录上下文
        // （否则 cwd 前缀会占用宽度预算）。
        // relativePath() 返回 POSIX 规范化的输出，所以 truncatePathMiddle
        // （它使用 lastIndexOf('/')）在 Windows 上也能正常工作。
        const cwd = getCwd();
        let collected = 0;
        void ripGrepStream(
          // 当查询以 '-' 开头时，-e 用于区分模式与选项
          // （例如搜索 "--verbose" 或 "-rf"）。参见 GrepTool.ts 中
          // 相同的预防措施。
          ['-n', '--no-heading', '-i', '-m', String(MAX_MATCHES_PER_FILE), '-F', '-e', query],
          cwd,
          controller.signal,
          lines => {
            if (controller.signal.aborted) return;
            const parsed: Match[] = [];
            for (const line of lines) {
              const m = parseRipgrepLine(line);
              if (!m) continue;
              const rel = relativePath(cwd, m.file);
              parsed.push({ ...m, file: rel.startsWith('..') ? m.file : rel });
            }
            if (!parsed.length) return;
            collected += parsed.length;
            setMatches(prev => {
              // 追加 + 去重而非替换：prev 中可能持有客户端过滤后的、
              // 对当前查询仍然有效的匹配结果。替换会把计数降到
              // 当前 chunk 的大小再涨回来 —— 表现为闪烁。
              const seen = new Set(prev.map(matchKey));
              const fresh = parsed.filter(p => !seen.has(matchKey(p)));
              if (!fresh.length) return prev;
              const next = prev.concat(fresh);
              return next.length > MAX_TOTAL_MATCHES ? next.slice(0, MAX_TOTAL_MATCHES) : next;
            });
            if (collected >= MAX_TOTAL_MATCHES) {
              controller.abort();
              setTruncated(true);
              setIsSearching(false);
            }
          },
        )
          .catch(() => {})
          // 流关闭且零 chunk —— 清除过期结果，
          // 以便渲染"无匹配"而不是上一个查询的列表。
          .finally(() => {
            if (controller.signal.aborted) return;
            if (collected === 0) setMatches(m => (m.length ? [] : m));
            setIsSearching(false);
          });
      },
      DEBOUNCE_MS,
      q,
      controller,
      setMatches,
      setTruncated,
      setIsSearching,
    );
  };

  const listWidth = previewOnRight ? Math.floor((columns - 10) * 0.5) : columns - 8;
  const maxPathWidth = Math.max(20, Math.floor(listWidth * 0.4));
  const maxTextWidth = Math.max(20, listWidth - maxPathWidth - 4);
  const previewWidth = previewOnRight ? Math.max(40, columns - listWidth - 14) : columns - 6;

  const handleOpen = (m: Match) => {
    const opened = openFileInExternalEditor(resolvePath(getCwd(), m.file), m.line);
    logEvent('tengu_global_search_select', {
      result_count: matches.length,
      opened_editor: opened,
    });
    onDone();
  };

  const handleInsert = (m: Match, mention: boolean) => {
    onInsert(mention ? `@${m.file}#L${m.line} ` : `${m.file}:${m.line} `);
    logEvent('tengu_global_search_insert', {
      result_count: matches.length,
      mention,
    });
    onDone();
  };

  // 始终传入非空字符串以保留该行 —— 避免计数出现/消失时
  // searchBox 上下跳动。
  const matchLabel =
    matches.length > 0 ? `${matches.length}${truncated ? '+' : ''} 个匹配${isSearching ? '…' : ''}` : ' ';

  return (
    <FuzzyPicker
      title="全局搜索"
      placeholder="输入以搜索…"
      items={matches}
      getKey={matchKey}
      visibleCount={visibleResults}
      direction="up"
      previewPosition={previewOnRight ? 'right' : 'bottom'}
      onQueryChange={handleQueryChange}
      onFocus={m => setFocused(m)}
      onSelect={handleOpen}
      onTab={{ action: 'mention', handler: m => handleInsert(m, true) }}
      onShiftTab={{
        action: 'insert path',
        handler: m => handleInsert(m, false),
      }}
      onCancel={onDone}
      emptyMessage={q => (isSearching ? '搜索中…' : q ? '无匹配' : '输入以搜索…')}
      matchLabel={matchLabel}
      selectAction="在编辑器中打开"
      renderItem={(m, isFocused) => (
        <Text color={isFocused ? 'suggestion' : undefined}>
          <Text dimColor>
            {truncatePathMiddle(m.file, maxPathWidth)}:{m.line}
          </Text>{' '}
          {highlightMatch(truncateToWidth(m.text.trimStart(), maxTextWidth), query)}
        </Text>
      )}
      renderPreview={m =>
        preview?.file === m.file && preview.line === m.line ? (
          <>
            <Text dimColor>
              {truncatePathMiddle(m.file, previewWidth)}:{m.line}
            </Text>
            {preview.content.split('\n').map((line, i) => (
              <Text key={i}>{highlightMatch(truncateToWidth(line, previewWidth), query)}</Text>
            ))}
          </>
        ) : (
          <LoadingState message="加载中…" dimColor />
        )
      }
    />
  );
}

function matchKey(m: Match): string {
  return `${m.file}:${m.line}`;
}

/**
 * 解析 ripgrep -n --no-heading 的输出行："path:line:text"。
 * Windows 路径可能包含盘符（"C:\..."），所以简单地按第一个冒号分割
 * 会破坏路径 —— 改用正则捕获到第一个 :<数字>: 为止。
 * @internal 导出用于测试
 */
export function parseRipgrepLine(line: string): Match | null {
  const m = /^(.*?):(\d+):(.*)$/.exec(line);
  if (!m) return null;
  const [, file, lineStr, text] = m;
  const lineNum = Number(lineStr);
  if (!file || !Number.isFinite(lineNum)) return null;
  return { file, line: lineNum, text: text ?? '' };
}
