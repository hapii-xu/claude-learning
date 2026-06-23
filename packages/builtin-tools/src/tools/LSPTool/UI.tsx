import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import React from 'react';
import { CtrlOToExpand } from 'src/components/CtrlOToExpand.js';
import { FallbackToolUseErrorMessage } from 'src/components/FallbackToolUseErrorMessage.js';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { Box, Text } from '@anthropic/ink';
import { getDisplayPath } from 'src/utils/file.js';
import { extractTag } from 'src/utils/messages.js';
import type { Input, Output } from './LSPTool.js';
import { getSymbolAtPosition } from './symbolContext.js';

// 各操作的专用标签查找表
const OPERATION_LABELS: Record<Input['operation'], { singular: string; plural: string; special?: string }> = {
  goToDefinition: { singular: 'definition', plural: 'definitions' },
  findReferences: { singular: 'reference', plural: 'references' },
  documentSymbol: { singular: 'symbol', plural: 'symbols' },
  workspaceSymbol: { singular: 'symbol', plural: 'symbols' },
  hover: { singular: 'hover info', plural: 'hover info', special: 'available' },
  goToImplementation: { singular: 'implementation', plural: 'implementations' },
  prepareCallHierarchy: { singular: 'call item', plural: 'call items' },
  incomingCalls: { singular: 'caller', plural: 'callers' },
  outgoingCalls: { singular: 'callee', plural: 'callees' },
};

/**
 * 可复用的 LSP 结果摘要组件，支持折叠/展开视图
 */
function LSPResultSummary({
  operation,
  resultCount,
  fileCount,
  content,
  verbose,
}: {
  operation: Input['operation'];
  resultCount: number;
  fileCount: number;
  content: string;
  verbose: boolean;
}): React.ReactNode {
  // 获取该操作的标签配置
  const labelConfig = OPERATION_LABELS[operation] || {
    singular: 'result',
    plural: 'results',
  };
  const countLabel = resultCount === 1 ? labelConfig.singular : labelConfig.plural;

  const primaryText =
    operation === 'hover' && resultCount > 0 && labelConfig.special ? (
      <Text>悬停信息 {labelConfig.special}</Text>
    ) : (
      <Text>
        找到 <Text bold>{resultCount} </Text>
        {countLabel}
      </Text>
    );

  const secondaryText =
    fileCount > 1 ? (
      <Text>
        {' '}
        跨 <Text bold>{fileCount} </Text>
        个文件
      </Text>
    ) : null;

  if (verbose) {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text>
            <Text dimColor>&nbsp;&nbsp;⎿ &nbsp;</Text>
            {primaryText}
            {secondaryText}
          </Text>
        </Box>
        <Box marginLeft={5}>
          <Text>{content}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <MessageResponse height={1}>
      <Text>
        {primaryText}
        {secondaryText} {resultCount > 0 && <CtrlOToExpand />}
      </Text>
    </MessageResponse>
  );
}

export function userFacingName(): string {
  return 'LSP';
}

export function renderToolUseMessage(input: Partial<Input>, { verbose }: { verbose: boolean }): React.ReactNode {
  if (!input.operation) {
    return null;
  }

  const parts: string[] = [];

  // 对于基于位置的操作（goToDefinition、findReferences、hover、goToImplementation），
  // 显示该位置的符号以提供更好的上下文
  if (
    (input.operation === 'goToDefinition' ||
      input.operation === 'findReferences' ||
      input.operation === 'hover' ||
      input.operation === 'goToImplementation') &&
    input.filePath &&
    input.line !== undefined &&
    input.character !== undefined
  ) {
    // 从 1-based（用户输入）转为 0-based（内部文件读取）
    const symbol = getSymbolAtPosition(input.filePath, input.line - 1, input.character - 1);
    const displayPath = verbose ? input.filePath : getDisplayPath(input.filePath);

    if (symbol) {
      parts.push(`操作："${input.operation}"`);
      parts.push(`符号："${symbol}"`);
      parts.push(`位于："${displayPath}"`);
    } else {
      parts.push(`操作："${input.operation}"`);
      parts.push(`文件："${displayPath}"`);
      parts.push(`位置：${input.line}:${input.character}`);
    }

    return parts.join('，');
  }

  // 对于其他操作（documentSymbol、workspaceSymbol），
  // 只显示操作和文件，不显示位置细节
  parts.push(`操作："${input.operation}"`);

  if (input.filePath) {
    const displayPath = verbose ? input.filePath : getDisplayPath(input.filePath);
    parts.push(`文件："${displayPath}"`);
  }

  return parts.join('，');
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!verbose && typeof result === 'string' && extractTag(result, 'tool_use_error')) {
    return (
      <MessageResponse>
        <Text color="error">LSP 操作失败</Text>
      </MessageResponse>
    );
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />;
}

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  // 若有计数信息则使用折叠/展开视图
  if (output.resultCount !== undefined && output.fileCount !== undefined) {
    return (
      <LSPResultSummary
        operation={output.operation}
        resultCount={output.resultCount}
        fileCount={output.fileCount}
        content={output.result}
        verbose={verbose}
      />
    );
  }

  // 计数不可用时的错误回退
  //（例如 LSP server 初始化失败、请求错误）
  return (
    <MessageResponse>
      <Text>{output.result}</Text>
    </MessageResponse>
  );
}
