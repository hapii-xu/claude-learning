import React, { Suspense, use, useMemo } from 'react';
import { useSettings } from '../../../hooks/useSettings.js';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
import { Ansi, Box, Text, stringWidth, useTheme } from '@anthropic/ink';
import { type CliHighlight, getCliHighlightPromise } from '../../../utils/cliHighlight.js';
import { applyMarkdown } from '../../../utils/markdown.js';
import sliceAnsi from '../../../utils/sliceAnsi.js';

type PreviewBoxProps = {
  /** 要显示的预览内容。Markdown 会为代码块（```ts、```py 等）渲染语法高亮。
   * 也支持纯多行文本。 */
  content: string;
  /** 截断前显示的最大行数。 @default 20 */
  maxLines?: number;
  /** 预览框的最小高度（行数）。内容较短时会填充。 */
  minHeight?: number;
  /** 预览框的最小宽度。 @default 40 */
  minWidth?: number;
  /** 此框可用的最大宽度（例如容器宽度）。 */
  maxWidth?: number;
};

const BOX_CHARS = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  teeLeft: '├',
  teeRight: '┤',
};

/**
 * 带边框的等宽框，用于显示预览内容。
 * 超过 maxLines 的内容会带指示器截断。
 * 父组件应根据其可用高度预算传入 maxLines。
 */
export function PreviewBox(props: PreviewBoxProps): React.ReactNode {
  const settings = useSettings();
  if (settings.syntaxHighlightingDisabled) {
    return <PreviewBoxBody {...props} highlight={null} />;
  }
  return (
    <Suspense fallback={<PreviewBoxBody {...props} highlight={null} />}>
      <PreviewBoxWithHighlight {...props} />
    </Suspense>
  );
}

function PreviewBoxWithHighlight(props: PreviewBoxProps): React.ReactNode {
  const highlight = use(getCliHighlightPromise());
  return <PreviewBoxBody {...props} highlight={highlight} />;
}

function PreviewBoxBody({
  content,
  maxLines,
  minHeight,
  minWidth = 40,
  maxWidth,
  highlight,
}: PreviewBoxProps & { highlight: CliHighlight | null }): React.ReactNode {
  const { columns: terminalWidth } = useTerminalSize();
  const [theme] = useTheme();
  const effectiveMaxWidth = maxWidth ?? terminalWidth - 4;

  // 使用提供的 maxLines，否则取合理默认值
  const effectiveMaxLines = maxLines ?? 20;

  // 为代码块渲染带语法高亮的 markdown。applyMarkdown 返回带 ANSI 样式
  // （粗体、颜色等）的字符串，我们按行拆分。下方的 stringWidth 和
  // sliceAnsi 能正确处理 ANSI 转义码。
  const rendered = useMemo(() => applyMarkdown(content, theme, highlight), [content, theme, highlight]);
  const contentLines = rendered.split('\n');
  const isTruncated = contentLines.length > effectiveMaxLines;

  // 截断到 effectiveMaxLines
  const truncatedLines = isTruncated ? contentLines.slice(0, effectiveMaxLines) : contentLines;

  // 若短于 minHeight 则用空行填充，但绝不超过截断限制——
  // 否则填充会抵消截断
  const effectiveMinHeight = Math.min(minHeight ?? 0, effectiveMaxLines);
  const paddingNeeded = Math.max(0, effectiveMinHeight - truncatedLines.length - (isTruncated ? 1 : 0));
  const lines = paddingNeeded > 0 ? [...truncatedLines, ...Array<string>(paddingNeeded).fill('')] : truncatedLines;

  // 计算内容宽度（最大可视行宽，处理 unicode/emoji/CJK）
  const contentWidth = Math.max(minWidth, ...lines.map(line => stringWidth(line)));
  // 加 2 用于边框填充，上限为容器宽度以防止换行
  const boxWidth = Math.min(contentWidth + 4, effectiveMaxWidth);
  const innerWidth = boxWidth - 4; // 计入边框和填充

  // 渲染顶部边框
  const topBorder = `${BOX_CHARS.topLeft}${BOX_CHARS.horizontal.repeat(boxWidth - 2)}${BOX_CHARS.topRight}`;

  // 渲染底部边框
  const bottomBorder = `${BOX_CHARS.bottomLeft}${BOX_CHARS.horizontal.repeat(boxWidth - 2)}${BOX_CHARS.bottomRight}`;

  // 构建截断分隔条（例如 ├─── ✂ ─── 42 lines hidden ──────┤）
  const truncationBar = isTruncated
    ? (() => {
        const hiddenCount = contentLines.length - effectiveMaxLines;
        const label = `${BOX_CHARS.horizontal.repeat(3)} \u2702 ${BOX_CHARS.horizontal.repeat(3)} ${hiddenCount} lines hidden `;
        const labelWidth = stringWidth(label);
        const fillWidth = Math.max(0, boxWidth - 2 - labelWidth);
        return `${BOX_CHARS.teeLeft}${label}${BOX_CHARS.horizontal.repeat(fillWidth)}${BOX_CHARS.teeRight}`;
      })()
    : null;

  return (
    <Box flexDirection="column">
      <Text dimColor>{topBorder}</Text>

      {lines.map((line, index) => {
        // 填充或截断行以适应内部宽度（使用 unicode/emoji/CJK 的可视宽度）。
        // sliceAnsi 正确处理 ANSI 转义码；stringWidth 在测量前去除它们。
        const lineWidth = stringWidth(line);
        const displayLine = lineWidth > innerWidth ? sliceAnsi(line, 0, innerWidth) : line;
        const padding = ' '.repeat(Math.max(0, innerWidth - stringWidth(displayLine)));

        return (
          <Box key={index} flexDirection="row">
            <Text dimColor>{BOX_CHARS.vertical} </Text>
            <Ansi>{displayLine}</Ansi>
            <Text dimColor>
              {padding} {BOX_CHARS.vertical}
            </Text>
          </Box>
        );
      })}

      {truncationBar && <Text color="warning">{truncationBar}</Text>}

      <Text dimColor>{bottomBorder}</Text>
    </Box>
  );
}
