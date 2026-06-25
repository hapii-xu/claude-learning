import * as path from 'path';
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useRegisterOverlay } from '../context/overlayContext.js';
import { generateFileSuggestions } from '../hooks/fileSuggestions.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Text } from '@anthropic/ink';
import { logEvent } from '../services/analytics/index.js';
import { getCwd } from '../utils/cwd.js';
import { openFileInExternalEditor } from '../utils/editor.js';
import { truncatePathMiddle, truncateToWidth } from '../utils/format.js';
import { highlightMatch } from '../utils/highlightMatch.js';
import { readFileInRange } from '../utils/readFileInRange.js';
import { FuzzyPicker, LoadingState } from '@anthropic/ink';

type Props = {
  onDone: () => void;
  onInsert: (text: string) => void;
};

const VISIBLE_RESULTS = 8;
const PREVIEW_LINES = 20;

/**
 * Quick Open 对话框（ctrl+shift+p / cmd+shift+p）。
 * 模糊文件查找器，带有聚焦文件的语法高亮预览。
 */
export function QuickOpenDialog({ onDone, onInsert }: Props): React.ReactNode {
  useRegisterOverlay('quick-open');
  const { columns, rows } = useTerminalSize();
  // 外框（标题 + 搜索 + 提示 + 面板边框 + 间隙）会占用约 14 行。
  // 在较矮的终端上缩小列表，以免对话框被截断。
  const visibleResults = Math.min(VISIBLE_RESULTS, Math.max(4, rows - 14));

  const [results, setResults] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [focusedPath, setFocusedPath] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<{
    path: string;
    content: string;
  } | null>(null);
  const queryGenRef = useRef(0);
  useEffect(() => () => void queryGenRef.current++, []);

  const previewOnRight = columns >= 120;
  // 侧边预览位于列表（visibleCount 行）旁边的固定高度行中，
  // 超出该高度会打乱布局 —— 因此要做上限裁剪以适应，再减去一行留给路径标题。
  const effectivePreviewLines = previewOnRight ? VISIBLE_RESULTS - 1 : PREVIEW_LINES;

  // 用 generation 计数器使过期结果失效，以防用户输入比索引响应还快。
  const handleQueryChange = (q: string) => {
    setQuery(q);
    const gen = ++queryGenRef.current;
    if (!q.trim()) {
      // generateFileSuggestions('') 返回 cwd 的原始 readdir() 结果（为
      // @-mentions 设计）。对 Quick Open 来说只是噪音 —— 显示空状态。
      setResults([]);
      return;
    }
    void generateFileSuggestions(q, true).then(items => {
      if (gen !== queryGenRef.current) return;
      // 过滤掉目录项 —— 它们从 getTopLevelPaths() 返回时带有结尾的 path.sep，
      // 会导致 readFileInRange 抛出 EISDIR，让预览面板卡在"正在加载预览…"。
      // 将分隔符归一化为 '/'，以便 truncatePathMiddle（使用
      // lastIndexOf('/')）在 Windows 上也能找到文件名。
      const paths = items
        .filter(i => i.id.startsWith('file-'))
        .map(i => i.displayText)
        .filter(p => !p.endsWith(path.sep))
        .map(p => p.split(path.sep).join('/'));
      setResults(paths);
    });
  };

  // 加载聚焦文件的简短预览。每次导航都会中止上一次读取，
  // 这样长按 ↓ 不会堆积整文件读取，也不会让早期的慢读取覆盖后来的快读取。
  // 过期预览会一直可见，直到新预览到达 —— renderPreview 会叠加一个暗色
  // 加载指示器，而不是让面板空白。
  useEffect(() => {
    if (!focusedPath) {
      // 无结果 —— 清空以渲染空状态，而不是显示上一次查询的过期预览。
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    const absolute = path.resolve(getCwd(), focusedPath);
    void readFileInRange(absolute, 0, effectivePreviewLines, undefined, controller.signal)
      .then(r => {
        if (controller.signal.aborted) return;
        setPreview({ path: focusedPath, content: r.content });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setPreview({ path: focusedPath, content: '（预览不可用）' });
      });
    return () => controller.abort();
  }, [focusedPath, effectivePreviewLines]);

  const maxPathWidth = previewOnRight ? Math.max(20, Math.floor((columns - 10) * 0.4)) : Math.max(20, columns - 8);
  const previewWidth = previewOnRight ? Math.max(40, columns - maxPathWidth - 14) : columns - 6;

  const handleOpen = (p: string) => {
    const opened = openFileInExternalEditor(path.resolve(getCwd(), p));
    logEvent('tengu_quick_open_select', {
      result_count: results.length,
      opened_editor: opened,
    });
    onDone();
  };

  const handleInsert = (p: string, mention: boolean) => {
    onInsert(mention ? `@${p} ` : `${p} `);
    logEvent('tengu_quick_open_insert', {
      result_count: results.length,
      mention,
    });
    onDone();
  };

  return (
    <FuzzyPicker
      title="Quick Open"
      placeholder="输入以搜索文件…"
      items={results}
      getKey={p => p}
      visibleCount={visibleResults}
      direction="up"
      previewPosition={previewOnRight ? 'right' : 'bottom'}
      onQueryChange={handleQueryChange}
      onFocus={p => setFocusedPath(p)}
      onSelect={handleOpen}
      onTab={{ action: 'mention', handler: p => handleInsert(p, true) }}
      onShiftTab={{
        action: '插入路径',
        handler: p => handleInsert(p, false),
      }}
      onCancel={onDone}
      emptyMessage={q => (q ? '没有匹配的文件' : '开始输入以搜索…')}
      selectAction="在编辑器中打开"
      renderItem={(p, isFocused) => (
        <Text color={isFocused ? 'suggestion' : undefined}>{truncatePathMiddle(p, maxPathWidth)}</Text>
      )}
      renderPreview={p =>
        preview ? (
          <>
            <Text dimColor>
              {truncatePathMiddle(p, previewWidth)}
              {preview.path !== p ? ' · 加载中…' : ''}
            </Text>
            {preview.content.split('\n').map((line, i) => (
              <Text key={i}>{highlightMatch(truncateToWidth(line, previewWidth), query)}</Text>
            ))}
          </>
        ) : (
          <LoadingState message="正在加载预览…" dimColor />
        )
      }
    />
  );
}
