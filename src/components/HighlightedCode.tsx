import * as React from 'react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useSettings } from '../hooks/useSettings.js';
import { Ansi, Box, type DOMElement, measureElement, NoSelect, Text, useTheme } from '@anthropic/ink';
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js';
import sliceAnsi from '../utils/sliceAnsi.js';
import { countCharInString } from '../utils/stringUtils.js';
import { HighlightedCodeFallback } from './HighlightedCode/Fallback.js';
import { expectColorFile } from './StructuredDiff/colorDiff.js';
import type { ColorFile as ColorFileType } from 'color-diff-napi';

// 模块级 LRU 缓存，用于 ColorFile 实例，避免在不同组件实例间
// 为相同的 (filePath, code) 重复创建。
const colorFileCache = new Map<string, { colorFile: ColorFileType; code: string }>();
const COLOR_FILE_CACHE_MAX = 50;

type Props = {
  code: string;
  filePath: string;
  width?: number;
  dim?: boolean;
};

const DEFAULT_WIDTH = 80;

export const HighlightedCode = memo(function HighlightedCode({
  code,
  filePath,
  width,
  dim = false,
}: Props): React.ReactElement {
  const ref = useRef<DOMElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState(width || DEFAULT_WIDTH);
  const [theme] = useTheme();
  const settings = useSettings();
  const syntaxHighlightingDisabled = settings.syntaxHighlightingDisabled ?? false;

  const colorFile = useMemo(() => {
    if (syntaxHighlightingDisabled) {
      return null;
    }
    const ColorFile = expectColorFile();
    if (!ColorFile) {
      return null;
    }
    const cacheKey = `${filePath}\0${code.length}`;
    const cached = colorFileCache.get(cacheKey);
    if (cached && cached.code === code) {
      // 移到末尾（最近使用）
      colorFileCache.delete(cacheKey);
      colorFileCache.set(cacheKey, cached);
      return cached.colorFile;
    }
    const instance = new ColorFile(code, filePath);
    // 缓存已满时淘汰最旧条目
    if (colorFileCache.size >= COLOR_FILE_CACHE_MAX) {
      const oldest = colorFileCache.keys().next().value;
      if (oldest !== undefined) colorFileCache.delete(oldest);
    }
    colorFileCache.set(cacheKey, { colorFile: instance, code });
    return instance;
  }, [code, filePath, syntaxHighlightingDisabled]);

  useEffect(() => {
    if (!width && ref.current) {
      const { width: elementWidth } = measureElement(ref.current);
      if (elementWidth > 0) {
        setMeasuredWidth(elementWidth - 2);
      }
    }
  }, [width]);

  const lines = useMemo(() => {
    if (colorFile === null) {
      return null;
    }
    return colorFile.render(theme, measuredWidth, dim);
  }, [colorFile, theme, measuredWidth, dim]);

  // gutter 宽度与 ColorFile 在 lib.rs 中的布局一致：空格 + 右对齐的
  // 行号（max_digits = lineCount.toString().length）+ 空格。没有 diff 路径中
  // 那样的标记符列。用 <NoSelect> 包裹，使全屏选区得到不含行号的干净代码。
  // 仅在全屏模式下切分（约 4× DOM 节点 + sliceAnsi 开销）；非全屏使用终端
  // 原生选区，noSelect 无意义。
  const gutterWidth = useMemo(() => {
    if (!isFullscreenEnvEnabled()) return 0;
    const lineCount = countCharInString(code, '\n') + 1;
    return lineCount.toString().length + 2;
  }, [code]);

  return (
    <Box ref={ref}>
      {lines ? (
        <Box flexDirection="column">
          {lines.map((line, i) =>
            gutterWidth > 0 ? (
              <CodeLine key={i} line={line} gutterWidth={gutterWidth} />
            ) : (
              <Text key={i}>
                <Ansi>{line}</Ansi>
              </Text>
            ),
          )}
        </Box>
      ) : (
        <HighlightedCodeFallback code={code} filePath={filePath} dim={dim} skipColoring={syntaxHighlightingDisabled} />
      )}
    </Box>
  );
});

function CodeLine({ line, gutterWidth }: { line: string; gutterWidth: number }): React.ReactNode {
  const gutter = sliceAnsi(line, 0, gutterWidth);
  const content = sliceAnsi(line, gutterWidth);
  return (
    <Box flexDirection="row">
      <NoSelect fromLeftEdge>
        <Text>
          <Ansi>{gutter}</Ansi>
        </Text>
      </NoSelect>
      <Text>
        <Ansi>{content}</Ansi>
      </Text>
    </Box>
  );
}
