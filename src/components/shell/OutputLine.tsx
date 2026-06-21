import * as React from 'react';
import { useMemo } from 'react';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Ansi, Text } from '@anthropic/ink';
import { createHyperlink } from '../../utils/hyperlink.js';

import { jsonParse, jsonStringify } from '../../utils/slowOperations.js';
import { renderTruncatedContent } from '../../utils/terminal.js';
import { MessageResponse } from '../MessageResponse.js';
import { InVirtualListContext } from '../messageActions.js';
import { useExpandShellOutput } from './ExpandShellOutputContext.js';

export function tryFormatJson(line: string): string {
  try {
    const parsed = jsonParse(line);
    const stringified = jsonStringify(parsed);

    // 检查 JSON 往返过程中是否丢失了精度
    // 当大整数超过 Number.MAX_SAFE_INTEGER 时会发生这种情况
    // 我们通过移除空白和不必要的转义（\/ 在 JSON 中合法但可选）
    // 来规范化两个字符串以便比较
    const normalizedOriginal = line.replace(/\\\//g, '/').replace(/\s+/g, '');
    const normalizedStringified = stringified.replace(/\s+/g, '');

    if (normalizedOriginal !== normalizedStringified) {
      // 检测到精度丢失 - 返回未格式化的原始行
      return line;
    }

    return jsonStringify(parsed, null, 2);
  } catch {
    return line;
  }
}

const MAX_JSON_FORMAT_LENGTH = 10_000;

export function tryJsonFormatContent(content: string): string {
  if (content.length > MAX_JSON_FORMAT_LENGTH) {
    return content;
  }
  const allLines = content.split('\n');
  return allLines.map(tryFormatJson).join('\n');
}

// 匹配 JSON 字符串值中的 http(s) URL。保守做法：无引号，
// 无空白，无尾部逗号/大括号（否则就是 JSON 结构了）。
const URL_IN_JSON = /https?:\/\/[^\s"'<>\\]+/g;

export function linkifyUrlsInText(content: string): string {
  return content.replace(URL_IN_JSON, url => createHyperlink(url));
}

export function OutputLine({
  content,
  verbose,
  isError,
  isWarning,
  linkifyUrls,
}: {
  content: string;
  verbose: boolean;
  isError?: boolean;
  isWarning?: boolean;
  linkifyUrls?: boolean;
}): React.ReactNode {
  const { columns } = useTerminalSize();
  // 基于上下文展开最新的用户 shell 输出（来自 ! 命令）
  const expandShellOutput = useExpandShellOutput();
  const inVirtualList = React.useContext(InVirtualListContext);

  // 当处于 verbose 模式或这是最新用户 shell 输出时显示完整输出
  const shouldShowFull = verbose || expandShellOutput;

  const formattedContent = useMemo(() => {
    let formatted = tryJsonFormatContent(content);
    if (linkifyUrls) {
      formatted = linkifyUrlsInText(formatted);
    }
    if (shouldShowFull) {
      return stripUnderlineAnsi(formatted);
    }
    return stripUnderlineAnsi(renderTruncatedContent(formatted, columns, inVirtualList));
  }, [content, shouldShowFull, columns, linkifyUrls, inVirtualList]);

  const color = isError ? 'error' : isWarning ? 'warning' : undefined;

  return (
    <MessageResponse>
      <Text color={color}>
        <Ansi>{formattedContent}</Ansi>
      </Text>
    </MessageResponse>
  );
}

/**
 * 下划线 ANSI 码特别容易泄漏出来，原因不明。我无法弄清楚原因，
 * 也无法弄清楚为什么发出 reset ANSI 码不足以阻止它们泄漏。
 * 我也不想用 stripAnsi() 剥离所有 ANSI 码，因为我们曾经这样做，
 * 人们抱怨失去了所有格式。所以我们只是专门剥离下划线 ANSI 码。
 */
export function stripUnderlineAnsi(content: string): string {
  return content.replace(
    // eslint-disable-next-line no-control-regex
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape code regex
    /\u001b\[([0-9]+;)*4(;[0-9]+)*m|\u001b\[4(;[0-9]+)*m|\u001b\[([0-9]+;)*4m/g,
    '',
  );
}
