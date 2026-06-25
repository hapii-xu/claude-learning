import { diffWordsWithSpace, type StructuredPatchHunk } from 'diff';
import * as React from 'react';
import { useMemo } from 'react';
import type { ThemeName } from 'src/utils/theme.js';
import { Box, NoSelect, Text, stringWidth, useTheme, wrapText } from '@anthropic/ink';

/*
 * StructuredDiffFallback 组件：词级 Diff 高亮示例
 *
 * 此组件以词级高亮方式显示 diff 变更。下面是走查说明：
 *
 * 示例：
 * ```
 * // 原始代码
 * function oldName(param) {
 *   return param.oldProperty;
 * }
 *
 * // 修改后的代码
 * function newName(param) {
 *   return param.newProperty;
 * }
 * ```
 *
 * 处理流程：
 * 1. 组件接收一个包含带 '+' 和 '-' 前缀的行的 patch
 * 2. 行被转换为带有 type（add/remove/nochange）的对象
 * 3. 相关的 add/remove 行被配对（例如 oldName 与 newName 配对）
 * 4. 词级 diffing 识别具体变更部分：
 *    [
 *      { value: 'function ', added: undefined, removed: undefined },  // 公共
 *      { value: 'oldName', removed: true },                           // 已删除
 *      { value: 'newName', added: true },                             // 已添加
 *      { value: '(param) {', added: undefined, removed: undefined }   // 公共
 *    ]
 * 5. 以增强高亮渲染：
 *    - 公共部分正常显示
 *    - 删除的词使用更深的红色背景
 *    - 添加的词使用更深的绿色背景
 *
 * 这会生成视觉清晰的 diff，用户可以准确看到哪些词发生变化，
 * 而不仅仅是哪些行被修改。
 */

// 定义 DiffLine 接口，全文件使用
interface DiffLine {
  code: string;
  type: 'add' | 'remove' | 'nochange';
  i: number;
  originalCode: string;
  wordDiff?: boolean; // 词级 diffing 标志
  matchedLine?: DiffLine;
}

// 内部函数使用的行对象类型
export interface LineObject {
  code: string;
  i: number;
  type: 'add' | 'remove' | 'nochange';
  originalCode: string;
  wordDiff?: boolean;
  matchedLine?: LineObject;
}

// 词级 diff 部分的类型
interface DiffPart {
  added?: boolean;
  removed?: boolean;
  value: string;
}

type Props = {
  patch: StructuredPatchHunk;
  dim: boolean;
  width: number;
};

// 阈值：当变更比例超过此值时显示整行 diff 而非词级 diffing
const CHANGE_THRESHOLD = 0.4;

export function StructuredDiffFallback({ patch, dim, width }: Props): React.ReactNode {
  const [theme] = useTheme();
  const diff = useMemo(
    () => formatDiff(patch.lines, patch.oldStart, width, dim, theme),
    [patch.lines, patch.oldStart, width, dim, theme],
  );

  return (
    <Box flexDirection="column" flexGrow={1}>
      {diff.map((node, i) => (
        <Box key={i}>{node}</Box>
      ))}
    </Box>
  );
}

// 将行转换为带类型信息的行对象
export function transformLinesToObjects(lines: string[]): LineObject[] {
  return lines.map(code => {
    if (code.startsWith('+')) {
      return {
        code: code.slice(1),
        i: 0,
        type: 'add',
        originalCode: code.slice(1),
      };
    }
    if (code.startsWith('-')) {
      return {
        code: code.slice(1),
        i: 0,
        type: 'remove',
        originalCode: code.slice(1),
      };
    }
    return {
      code: code.slice(1),
      i: 0,
      type: 'nochange',
      originalCode: code.slice(1),
    };
  });
}

// 将相邻的 add/remove 行分组以便进行词级 diffing
export function processAdjacentLines(lineObjects: LineObject[]): LineObject[] {
  const processedLines: LineObject[] = [];
  let i = 0;

  while (i < lineObjects.length) {
    const current = lineObjects[i];
    if (!current) {
      i++;
      continue;
    }

    // 寻找 remove 后跟 add 的序列（可能的词级 diff 候选）
    if (current.type === 'remove') {
      const removeLines: LineObject[] = [current];
      let j = i + 1;

      // 收集连续的 remove 行
      while (j < lineObjects.length && lineObjects[j]?.type === 'remove') {
        const line = lineObjects[j];
        if (line) {
          removeLines.push(line);
        }
        j++;
      }

      // 检查 remove 行之后是否有 add 行
      const addLines: LineObject[] = [];
      while (j < lineObjects.length && lineObjects[j]?.type === 'add') {
        const line = lineObjects[j];
        if (line) {
          addLines.push(line);
        }
        j++;
      }

      // 如果同时有 remove 行和 add 行，执行词级 diffing
      if (removeLines.length > 0 && addLines.length > 0) {
        // 对于词级 diffing，我们比较每对行或最接近的匹配
        const pairCount = Math.min(removeLines.length, addLines.length);

        // 添加配对行并附带词级 diff 信息
        for (let k = 0; k < pairCount; k++) {
          const removeLine = removeLines[k];
          const addLine = addLines[k];

          if (removeLine && addLine) {
            removeLine.wordDiff = true;
            addLine.wordDiff = true;

            // 存储配对以供稍后词级 diffing 使用
            removeLine.matchedLine = addLine;
            addLine.matchedLine = removeLine;
          }
        }

        // 添加所有 remove 行（已配对和未配对）
        processedLines.push(...removeLines.filter(Boolean));

        // 然后添加所有 add 行（已配对和未配对）
        processedLines.push(...addLines.filter(Boolean));

        i = j; // 跳过我们已处理的所有行
      } else {
        // 没有匹配的 add 行，仅添加当前 remove 行
        processedLines.push(current);
        i++;
      }
    } else {
      // 非 remove 行，直接添加
      processedLines.push(current);
      i++;
    }
  }

  return processedLines;
}

// 计算两个文本字符串之间的词级 diff
export function calculateWordDiffs(oldText: string, newText: string): DiffPart[] {
  // 使用 diffWordsWithSpace 而非 diffWords 以保留空白
  // 这确保 > 和 { 之间等 token 之间的空格被保留
  const result = diffWordsWithSpace(oldText, newText, { ignoreCase: false });

  return result;
}

// 处理词级 diff，支持手动换行
function generateWordDiffElements(
  item: DiffLine,
  width: number,
  maxWidth: number,
  dim: boolean,
  overrideTheme?: ThemeName,
): React.ReactNode[] | null {
  const { type, i, wordDiff, matchedLine, originalCode } = item;

  if (!wordDiff || !matchedLine) {
    return null; // 此函数仅处理词级 diff 渲染
  }

  const removedLineText = type === 'remove' ? originalCode : matchedLine.originalCode;
  const addedLineText = type === 'remove' ? matchedLine.originalCode : originalCode;

  const wordDiffs = calculateWordDiffs(removedLineText, addedLineText);

  // 检查是否应使用词级 diffing
  const totalLength = removedLineText.length + addedLineText.length;
  const changedLength = wordDiffs
    .filter(part => part.added || part.removed)
    .reduce((sum, part) => sum + part.value.length, 0);
  const changeRatio = changedLength / totalLength;

  if (changeRatio > CHANGE_THRESHOLD || dim) {
    return null; // 对于重大变更回退到标准渲染
  }

  // 计算内容的可用宽度
  const diffPrefix = type === 'add' ? '+' : '-';
  const diffPrefixWidth = diffPrefix.length;
  const availableContentWidth = Math.max(1, width - maxWidth - 1 - diffPrefixWidth);

  // 手动换行词级 diff 部分，以获得更好的空间利用率
  const wrappedLines: { content: React.ReactNode[]; contentWidth: number }[] = [];
  let currentLine: React.ReactNode[] = [];
  let currentLineWidth = 0;

  wordDiffs.forEach((part, partIndex) => {
    // 决定该部分是否应在此行类型上显示
    let shouldShow = false;
    let partBgColor: 'diffAddedWord' | 'diffRemovedWord' | undefined;

    if (type === 'add') {
      if (part.added) {
        shouldShow = true;
        partBgColor = 'diffAddedWord';
      } else if (!part.removed) {
        shouldShow = true;
      }
    } else if (type === 'remove') {
      if (part.removed) {
        shouldShow = true;
        partBgColor = 'diffRemovedWord';
      } else if (!part.added) {
        shouldShow = true;
      }
    }

    if (!shouldShow) return;

    // 使用 wrapText 对单个过长部分换行
    const partWrapped = wrapText(part.value, availableContentWidth, 'wrap');
    const partLines = partWrapped.split('\n');

    partLines.forEach((partLine, lineIdx) => {
      if (!partLine) return;

      // 检查是否需要开始新行
      if (lineIdx > 0 || currentLineWidth + stringWidth(partLine) > availableContentWidth) {
        if (currentLine.length > 0) {
          wrappedLines.push({
            content: [...currentLine],
            contentWidth: currentLineWidth,
          });
          currentLine = [];
          currentLineWidth = 0;
        }
      }

      currentLine.push(
        <Text key={`part-${partIndex}-${lineIdx}`} backgroundColor={partBgColor}>
          {partLine}
        </Text>,
      );

      currentLineWidth += stringWidth(partLine);
    });
  });

  if (currentLine.length > 0) {
    wrappedLines.push({ content: currentLine, contentWidth: currentLineWidth });
  }

  // 将每个换行后的行渲染为单独的 Text 元素
  return wrappedLines.map(({ content, contentWidth }, lineIndex) => {
    const key = `${type}-${i}-${lineIndex}`;
    const lineBgColor =
      type === 'add' ? (dim ? 'diffAddedDimmed' : 'diffAdded') : dim ? 'diffRemovedDimmed' : 'diffRemoved';
    const lineNum = lineIndex === 0 ? i : undefined;
    const lineNumStr = (lineNum !== undefined ? lineNum.toString().padStart(maxWidth) : ' '.repeat(maxWidth)) + ' ';
    // 计算填充以铺满整个终端宽度
    const usedWidth = lineNumStr.length + diffPrefixWidth + contentWidth;
    const padding = Math.max(0, width - usedWidth);

    return (
      <Box key={key} flexDirection="row">
        <NoSelect fromLeftEdge>
          <Text color={overrideTheme ? 'text' : undefined} backgroundColor={lineBgColor} dimColor={dim}>
            {lineNumStr}
            {diffPrefix}
          </Text>
        </NoSelect>
        <Text color={overrideTheme ? 'text' : undefined} backgroundColor={lineBgColor} dimColor={dim}>
          {content}
          {' '.repeat(padding)}
        </Text>
      </Box>
    );
  });
}

function formatDiff(
  lines: string[],
  startingLineNumber: number,
  width: number,
  dim: boolean,
  overrideTheme?: ThemeName,
): React.ReactNode[] {
  // 确保 width 至少为 1，以防止在非常窄的终端上出现渲染问题
  const safeWidth = Math.max(1, Math.floor(width));

  // 步骤 1：将行转换为带类型信息的行对象
  const lineObjects = transformLinesToObjects(lines);

  // 步骤 2：将相邻 add/remove 行分组以便词级 diffing
  const processedLines = processAdjacentLines(lineObjects);

  // 步骤 3：为 diff 行编号
  const ls = numberDiffLines(processedLines, startingLineNumber);

  // 找到用于对齐的最大行号宽度
  const maxLineNumber = Math.max(...ls.map(({ i }) => i), 0);
  const maxWidth = Math.max(maxLineNumber.toString().length + 1, 0);

  // 步骤 4：渲染格式化
  return ls.flatMap((item): React.ReactNode[] => {
    const { type, code, i, wordDiff, matchedLine } = item;

    // 为 add/remove 对处理词级 diffing
    if (wordDiff && matchedLine) {
      const wordDiffElements = generateWordDiffElements(item, safeWidth, maxWidth, dim, overrideTheme);

      // word-diff 可能拒绝（例如由于行差异过大），此时
      // 我们会落到下方的正常渲染
      if (wordDiffElements !== null) {
        return wordDiffElements;
      }
    }

    // 不带词级 diffing 的行的标准渲染，或作为回退
    // 计算可用宽度，考虑行号 + 空格 + diff 前缀
    const diffPrefixWidth = 2; // 未变更时为 "  "，变更时为 "+ " 或 "- "
    const availableContentWidth = Math.max(1, safeWidth - maxWidth - 1 - diffPrefixWidth); // -1 用于行号后的空格
    const wrappedText = wrapText(code, availableContentWidth, 'wrap');
    const wrappedLines = wrappedText.split('\n');

    return wrappedLines.map((line, lineIndex) => {
      const key = `${type}-${i}-${lineIndex}`;
      const lineNum = lineIndex === 0 ? i : undefined;
      const lineNumStr = (lineNum !== undefined ? lineNum.toString().padStart(maxWidth) : ' '.repeat(maxWidth)) + ' ';
      const sigil = type === 'add' ? '+' : type === 'remove' ? '-' : ' ';
      // 计算填充以铺满整个终端宽度
      const contentWidth = lineNumStr.length + 1 + stringWidth(line); // lineNum + sigil + code
      const padding = Math.max(0, safeWidth - contentWidth);

      const bgColor =
        type === 'add'
          ? dim
            ? 'diffAddedDimmed'
            : 'diffAdded'
          : type === 'remove'
            ? dim
              ? 'diffRemovedDimmed'
              : 'diffRemoved'
            : undefined;

      // 装饰区（行号 + 符号）用 <NoSelect> 包裹，这样全屏文本选择
      // 时得到干净的代码。bgColor 在两个 box 上保持一致，
      // 视觉连续性（实心红/绿条）不变。
      return (
        <Box key={key} flexDirection="row">
          <NoSelect fromLeftEdge>
            <Text
              color={overrideTheme ? 'text' : undefined}
              backgroundColor={bgColor}
              dimColor={dim || type === 'nochange'}
            >
              {lineNumStr}
              {sigil}
            </Text>
          </NoSelect>
          <Text color={overrideTheme ? 'text' : undefined} backgroundColor={bgColor} dimColor={dim}>
            {line}
            {' '.repeat(padding)}
          </Text>
        </Box>
      );
    });
  });
}

export function numberDiffLines(diff: LineObject[], startLine: number): DiffLine[] {
  let i = startLine;
  const result: DiffLine[] = [];
  const queue = [...diff];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const { code, type, originalCode, wordDiff, matchedLine } = current;
    const line = {
      code,
      type,
      i,
      originalCode,
      wordDiff,
      matchedLine,
    };

    // 根据变更类型更新计数器
    switch (type) {
      case 'nochange':
        i++;
        result.push(line);
        break;
      case 'add':
        i++;
        result.push(line);
        break;
      case 'remove': {
        result.push(line);
        let numRemoved = 0;
        while (queue[0]?.type === 'remove') {
          i++;
          const current = queue.shift()!;
          const { code, type, originalCode, wordDiff, matchedLine } = current;
          const line = {
            code,
            type,
            i,
            originalCode,
            wordDiff,
            matchedLine,
          };
          result.push(line);
          numRemoved++;
        }
        i -= numRemoved;
        break;
      }
    }
  }

  return result;
}
