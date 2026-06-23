import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import { extractTag } from 'src/utils/messages.js';
import { FallbackToolUseErrorMessage } from 'src/components/FallbackToolUseErrorMessage.js';

import { MessageResponse } from 'src/components/MessageResponse.js';
import { Text } from '@anthropic/ink';
import { FilePathLink } from 'src/components/FilePathLink.js';
import { FILE_NOT_FOUND_CWD_NOTE, getDisplayPath } from 'src/utils/file.js';
import { formatFileSize } from 'src/utils/format.js';
import { getPlansDirectory } from 'src/utils/plans.js';
import { getTaskOutputDir } from 'src/utils/task/diskOutput.js';
import type { Input, Output } from './FileReadTool.js';

/**
 * 检查文件路径是否为 agent 输出文件，并提取 task ID。
 * Agent 输出文件遵循以下模式：{projectTempDir}/tasks/{taskId}.output
 */
function getAgentOutputTaskId(filePath: string): string | null {
  const prefix = `${getTaskOutputDir()}/`;
  const suffix = '.output';
  if (filePath.startsWith(prefix) && filePath.endsWith(suffix)) {
    const taskId = filePath.slice(prefix.length, -suffix.length);
    // 校验它看起来像 task ID（字母数字、长度合理）
    if (taskId.length > 0 && taskId.length <= 20 && /^[a-zA-Z0-9_-]+$/.test(taskId)) {
      return taskId;
    }
  }
  return null;
}

export function renderToolUseMessage(
  { file_path, offset, limit, pages }: Partial<Input>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!file_path) {
    return null;
  }

  // 对于 agent 输出文件，返回空字符串以避免显示括号
  // task ID 会被 AssistantToolUseMessage 单独展示
  if (getAgentOutputTaskId(file_path)) {
    return '';
  }

  const displayPath = verbose ? file_path : getDisplayPath(file_path);
  if (pages) {
    return (
      <>
        <FilePathLink filePath={file_path}>{displayPath}</FilePathLink>
        {` · 第 ${pages} 页`}
      </>
    );
  }
  if (verbose && (offset || limit)) {
    const startLine = offset ?? 1;
    const lineRange = limit ? `第 ${startLine}-${startLine + limit - 1} 行` : `从第 ${startLine} 行起`;
    return (
      <>
        <FilePathLink filePath={file_path}>{displayPath}</FilePathLink>
        {` · ${lineRange}`}
      </>
    );
  }
  return <FilePathLink filePath={file_path}>{displayPath}</FilePathLink>;
}

export function renderToolUseTag({ file_path }: Partial<Input>): React.ReactNode {
  const agentTaskId = file_path ? getAgentOutputTaskId(file_path) : null;

  // 当 Read 工具读取 agent 输出时，显示 agent task ID
  if (!agentTaskId) {
    return null;
  }
  return <Text dimColor> {agentTaskId}</Text>;
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  // TODO: 递归渲染
  switch (output.type) {
    case 'image': {
      const { originalSize } = output.file;
      const formattedSize = formatFileSize(originalSize);

      return (
        <MessageResponse height={1}>
          <Text>读取图片（{formattedSize}）</Text>
        </MessageResponse>
      );
    }
    case 'notebook': {
      const { cells } = output.file;
      if (!cells || cells.length < 1) {
        return <Text color="error">notebook 中未找到单元格</Text>;
      }
      return (
        <MessageResponse height={1}>
          <Text>
            读取了 <Text bold>{cells.length}</Text> 个单元格
          </Text>
        </MessageResponse>
      );
    }
    case 'pdf': {
      const { originalSize } = output.file;
      const formattedSize = formatFileSize(originalSize);

      return (
        <MessageResponse height={1}>
          <Text>读取 PDF（{formattedSize}）</Text>
        </MessageResponse>
      );
    }
    case 'parts': {
      return (
        <MessageResponse height={1}>
          <Text>
            读取了 <Text bold>{output.file.count}</Text> {output.file.count === 1 ? '页' : '页'}（
            {formatFileSize(output.file.originalSize)}）
          </Text>
        </MessageResponse>
      );
    }
    case 'text': {
      const { numLines } = output.file;

      return (
        <MessageResponse height={1}>
          <Text>
            读取了 <Text bold>{numLines}</Text> {numLines === 1 ? '行' : '行'}
          </Text>
        </MessageResponse>
      );
    }
    case 'file_unchanged': {
      return (
        <MessageResponse height={1}>
          <Text dimColor>自上次读取以来未变化</Text>
        </MessageResponse>
      );
    }
  }
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!verbose && typeof result === 'string') {
    // FileReadTool 从 call() 中抛出，所以错误缺少 <tool_use_error> 包裹 ——
    // 直接检查原始字符串中的 cwd 提示标记。
    if (result.includes(FILE_NOT_FOUND_CWD_NOTE)) {
      return (
        <MessageResponse>
          <Text color="error">文件未找到</Text>
        </MessageResponse>
      );
    }
    if (extractTag(result, 'tool_use_error')) {
      return (
        <MessageResponse>
          <Text color="error">读取文件时出错</Text>
        </MessageResponse>
      );
    }
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />;
}

export function userFacingName(input: Partial<Input> | undefined): string {
  if (input?.file_path?.startsWith(getPlansDirectory())) {
    return '读取 Plan';
  }
  if (input?.file_path && getAgentOutputTaskId(input.file_path)) {
    return '读取 agent 输出';
  }
  return 'Read';
}

export function getToolUseSummary(input: Partial<Input> | undefined): string | null {
  if (!input?.file_path) {
    return null;
  }
  // 对于 agent 输出文件，仅显示 task ID
  const agentTaskId = getAgentOutputTaskId(input.file_path);
  if (agentTaskId) {
    return agentTaskId;
  }
  return getDisplayPath(input.file_path);
}
