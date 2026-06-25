import type { Token, Tokens } from 'marked';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Ansi, stringWidth, useTheme, wrapAnsi } from '@anthropic/ink';
import type { CliHighlight } from '../utils/cliHighlight.js';
import { formatToken, padAligned } from '../utils/markdown.js';

/** 用于抵消父级缩进（例如消息圆点前缀）和终端尺寸调整竞态。没有足够余量时，
 *  表格会溢出其布局框，Ink 的裁剪在不同帧上交替截断，导致 scrollback 中
 *  出现无限闪烁循环。 */
const SAFETY_MARGIN = 4;

/** 最小列宽，防止退化布局 */
const MIN_COLUMN_WIDTH = 3;

/**
 * 切换到竖排格式前每行的最大行数。
 * 当换行会让行高超过此值时，竖排（键值对）格式可提供更好的可读性。
 */
const MAX_ROW_LINES = 4;

/** 用于文本格式的 ANSI 转义码 */
const ANSI_BOLD_START = '\x1b[1m';
const ANSI_BOLD_END = '\x1b[22m';

type Props = {
  token: Tokens.Table;
  highlight: CliHighlight | null;
  /** 覆盖终端宽度（测试时有用） */
  forceWidth?: number;
};

/**
 * 将文本换行到给定宽度内，返回行数组。
 * ANSI 感知：跨换行保留样式。
 *
 * @param hard - 为 true 时，截断超过宽度的单词（当列宽窄于最长单词时需要）。
 *               默认 false。
 */
function wrapText(text: string, width: number, options?: { hard?: boolean }): string[] {
  if (width <= 0) return [text];
  // 换行前去除尾部空白/换行。
  // formatToken() 会给段落和其他 token 类型添加 EOL，
  // 否则会在表格单元格中产生多余空行。
  const trimmedText = text.trimEnd();
  const wrapped = wrapAnsi(trimmedText, width, {
    hard: options?.hard ?? false,
    trim: false,
    wordWrap: true,
  });
  // 过滤掉由尾部换行或源内容中多个连续换行产生的空行。
  const lines = wrapped.split('\n').filter(line => line.length > 0);
  // 确保至少返回一行（空单元格返回空字符串）
  return lines.length > 0 ? lines : [''];
}

/**
 * 使用 Ink 的 Box 布局渲染 markdown 表格。
 * 通过以下方式处理终端宽度：
 * 1. 基于最长单词计算最小列宽
 * 2. 按比例分配可用空间
 * 3. 在单元格内换行（不截断）
 * 4. 正确对齐带边框的多行行
 *
 * 性能：使用每次渲染的缓存（formatCache、plainTextCache、wrapCache）
 * 来避免在多个阶段（宽度计算、行行数统计、渲染）中重复调用
 * formatCell/wrapText。用 React.memo 包裹以在 props 未变时跳过重新渲染。
 */
export const MarkdownTable = React.memo(function MarkdownTable({
  token,
  highlight,
  forceWidth,
}: Props): React.ReactNode {
  const [theme] = useTheme();
  const { columns: actualTerminalWidth } = useTerminalSize();
  const terminalWidth = forceWidth ?? actualTerminalWidth;

  // 每次渲染的缓存 — Token[] 引用在单个 token prop 内是稳定的
  //（来自 Markdown.tsx 中的 LRU 缓存），因此引用相等性即可判断。
  const formatCache = new Map<Token[] | undefined, string>();
  const plainTextCache = new Map<Token[] | undefined, string>();

  function formatCell(tokens: Token[] | undefined): string {
    const cached = formatCache.get(tokens);
    if (cached !== undefined) return cached;
    const result = tokens?.map(_ => formatToken(_, theme, 0, null, null, highlight)).join('') ?? '';
    formatCache.set(tokens, result);
    return result;
  }

  function getPlainText(tokens: Token[] | undefined): string {
    const cached = plainTextCache.get(tokens);
    if (cached !== undefined) return cached;
    const result = stripAnsi(formatCell(tokens));
    plainTextCache.set(tokens, result);
    return result;
  }

  // 获取单元格中最长单词的宽度（避免断词所需的最小宽度）
  function getMinWidth(tokens: Token[] | undefined): number {
    const text = getPlainText(tokens);
    const words = text.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return MIN_COLUMN_WIDTH;
    return Math.max(...words.map(w => stringWidth(w)), MIN_COLUMN_WIDTH);
  }

  // 获取理想宽度（不换行时的完整内容）
  function getIdealWidth(tokens: Token[] | undefined): number {
    return Math.max(stringWidth(getPlainText(tokens)), MIN_COLUMN_WIDTH);
  }

  // 计算列宽
  // 步骤 1：获取最小宽度（最长单词）和理想宽度（完整内容）
  const minWidths = token.header.map((header, colIndex) => {
    let maxMinWidth = getMinWidth(header.tokens);
    for (const row of token.rows) {
      maxMinWidth = Math.max(maxMinWidth, getMinWidth(row[colIndex]?.tokens));
    }
    return maxMinWidth;
  });

  const idealWidths = token.header.map((header, colIndex) => {
    let maxIdeal = getIdealWidth(header.tokens);
    for (const row of token.rows) {
      maxIdeal = Math.max(maxIdeal, getIdealWidth(row[colIndex]?.tokens));
    }
    return maxIdeal;
  });

  // 步骤 2：计算可用空间
  // 边框开销：│ content │ content │ = 每列 1 + (width + 3)
  const numCols = token.header.length;
  const borderOverhead = 1 + numCols * 3; // │ + 每列 (2 填充 + 1 边框)
  // 计入 SAFETY_MARGIN 以避免触发后备安全检查
  const availableWidth = Math.max(terminalWidth - borderOverhead - SAFETY_MARGIN, numCols * MIN_COLUMN_WIDTH);

  // 步骤 3：计算适配可用空间的列宽
  const totalMin = minWidths.reduce((sum, w) => sum + w, 0);
  const totalIdeal = idealWidths.reduce((sum, w) => sum + w, 0);

  // 跟踪列是否窄于最长单词（需要硬换行）
  let needsHardWrap = false;

  let columnWidths: number[];
  if (totalIdeal <= availableWidth) {
    // 全部放得下 - 使用理想宽度
    columnWidths = idealWidths;
  } else if (totalMin <= availableWidth) {
    // 需要收缩 - 给每列其最小宽度，再分配剩余空间
    const extraSpace = availableWidth - totalMin;
    const overflows = idealWidths.map((ideal, i) => ideal - minWidths[i]!);
    const totalOverflow = overflows.reduce((sum, o) => sum + o, 0);

    columnWidths = minWidths.map((min, i) => {
      if (totalOverflow === 0) return min;
      const extra = Math.floor((overflows[i]! / totalOverflow) * extraSpace);
      return min + extra;
    });
  } else {
    // 在最小宽度下表格仍宽于终端
    // 按比例收缩列以适配，允许断词
    needsHardWrap = true;
    const scaleFactor = availableWidth / totalMin;
    columnWidths = minWidths.map(w => Math.max(Math.floor(w * scaleFactor), MIN_COLUMN_WIDTH));
  }

  // 步骤 4：单趟单元格预处理 — 每个单元格只换行一次，缓存结果
  // 供行行数统计和渲染复用。
  const wrapCache = new Map<Token[] | undefined, string[]>();

  function getWrappedLines(tokens: Token[] | undefined, colIndex: number): string[] {
    const cached = wrapCache.get(tokens);
    if (cached !== undefined) return cached;
    const formatted = formatCell(tokens);
    const lines = wrapText(formatted, columnWidths[colIndex]!, {
      hard: needsHardWrap,
    });
    wrapCache.set(tokens, lines);
    return lines;
  }

  // 步骤 5：使用缓存的换行结果计算最大行行数
  let maxRowLines = 1;
  for (let i = 0; i < token.header.length; i++) {
    maxRowLines = Math.max(maxRowLines, getWrappedLines(token.header[i]!.tokens, i).length);
  }
  for (const row of token.rows) {
    for (let i = 0; i < row.length; i++) {
      maxRowLines = Math.max(maxRowLines, getWrappedLines(row[i]?.tokens, i).length);
    }
  }

  const useVerticalFormat = maxRowLines > MAX_ROW_LINES;

  // 渲染单个行，单元格可能跨多行
  // 返回字符串数组，每行对应一行
  function renderRowLines(cells: Array<{ tokens?: Token[] }>, isHeader: boolean): string[] {
    // 复用缓存的换行结果 — 无冗余 formatCell/wrapText
    const cellLines = cells.map((cell, colIndex) => getWrappedLines(cell.tokens, colIndex));

    // 找到此行的最大行数
    const maxLines = Math.max(...cellLines.map(lines => lines.length), 1);

    // 计算每个单元格的垂直偏移（用于垂直居中）
    const verticalOffsets = cellLines.map(lines => Math.floor((maxLines - lines.length) / 2));

    // 将该行的每一行构建为单个字符串
    const result: string[] = [];
    for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
      let line = '│';
      for (let colIndex = 0; colIndex < cells.length; colIndex++) {
        const lines = cellLines[colIndex]!;
        const offset = verticalOffsets[colIndex]!;
        const contentLineIdx = lineIdx - offset;
        const lineText = contentLineIdx >= 0 && contentLineIdx < lines.length ? lines[contentLineIdx]! : '';
        const width = columnWidths[colIndex]!;
        // 表头始终居中；数据使用表格对齐方式
        const align = isHeader ? 'center' : (token.align?.[colIndex] ?? 'left');

        line += ' ' + padAligned(lineText, stringWidth(lineText), width, align) + ' │';
      }
      result.push(line);
    }

    return result;
  }

  // 将水平边框渲染为单个字符串
  function renderBorderLine(type: 'top' | 'middle' | 'bottom'): string {
    const [left, mid, cross, right] = {
      top: ['┌', '─', '┬', '┐'],
      middle: ['├', '─', '┼', '┤'],
      bottom: ['└', '─', '┴', '┘'],
    }[type] as [string, string, string, string];

    let line = left;
    columnWidths.forEach((width, colIndex) => {
      line += mid.repeat(width + 2);
      line += colIndex < columnWidths.length - 1 ? cross : right;
    });
    return line;
  }

  // 为极窄终端渲染竖排格式（键值对）
  // 使用 formatCell 缓存；换行使用终端宽度参数（而非列宽）
  function renderVerticalFormat(): string {
    const lines: string[] = [];
    const headers = token.header.map(h => getPlainText(h.tokens));
    const separatorWidth = Math.min(terminalWidth - 1, 40);
    const separator = '─'.repeat(separatorWidth);
    // 换行行的小缩进（仅 2 个空格）
    const wrapIndent = '  ';

    token.rows.forEach((row, rowIndex) => {
      if (rowIndex > 0) {
        lines.push(separator);
      }

      row.forEach((cell, colIndex) => {
        const label = headers[colIndex] || `第 ${colIndex + 1} 列`;
        // 清理值：去首尾空白，移除多余内部空白/换行
        const rawValue = formatCell(cell.tokens).trimEnd();
        const value = rawValue.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();

        // 将值换行以适配终端，第一行需扣除 label 占用的空间
        const firstLineWidth = terminalWidth - stringWidth(label) - 3;
        const subsequentLineWidth = terminalWidth - wrapIndent.length - 1;

        // 两趟换行：第一行较窄（label 占用空间），
        // 续行获得完整宽度（减去缩进）。
        const firstPassLines = wrapText(value, Math.max(firstLineWidth, 10));
        const firstLine = firstPassLines[0] || '';

        let wrappedValue: string[];
        if (firstPassLines.length <= 1 || subsequentLineWidth <= firstLineWidth) {
          wrappedValue = firstPassLines;
        } else {
          // 重新拼接剩余文本并按更宽的续行宽度重新换行
          const remainingText = firstPassLines
            .slice(1)
            .map(l => l.trim())
            .join(' ');
          const rewrapped = wrapText(remainingText, subsequentLineWidth);
          wrappedValue = [firstLine, ...rewrapped];
        }

        // 第一行：加粗 label + 值
        lines.push(`${ANSI_BOLD_START}${label}:${ANSI_BOLD_END} ${wrappedValue[0] || ''}`);

        // 带小缩进的续行（跳过空行）
        for (let i = 1; i < wrappedValue.length; i++) {
          const line = wrappedValue[i]!;
          if (!line.trim()) continue;
          lines.push(`${wrapIndent}${line}`);
        }
      });
    });

    return lines.join('\n');
  }

  // 根据可用宽度选择格式
  if (useVerticalFormat) {
    return <Ansi>{renderVerticalFormat()}</Ansi>;
  }

  // 将完整的水平表格构建为字符串数组
  const tableLines: string[] = [];
  tableLines.push(renderBorderLine('top'));
  tableLines.push(...renderRowLines(token.header, true));
  tableLines.push(renderBorderLine('middle'));
  token.rows.forEach((row, rowIndex) => {
    tableLines.push(...renderRowLines(row, false));
    if (rowIndex < token.rows.length - 1) {
      tableLines.push(renderBorderLine('middle'));
    }
  });
  tableLines.push(renderBorderLine('bottom'));

  // 安全检查：确认没有行超过终端宽度。
  // 这用于捕获终端尺寸调整时的边缘情况 —— 计算所基于的宽度
  // 与当前渲染目标不一致。
  const maxLineWidth = Math.max(...tableLines.map(line => stringWidth(stripAnsi(line))));

  // 若距边缘不足 SAFETY_MARGIN 个字符，则改用竖排格式
  // 以应对终端尺寸调整的竞态条件。
  if (maxLineWidth > terminalWidth - SAFETY_MARGIN) {
    return <Ansi>{renderVerticalFormat()}</Ansi>;
  }

  // 作为单个 Ansi 块渲染，防止 Ink 在行中间换行
  return <Ansi>{tableLines.join('\n')}</Ansi>;
});
