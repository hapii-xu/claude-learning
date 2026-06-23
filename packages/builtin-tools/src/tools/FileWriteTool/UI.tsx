import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import type { StructuredPatchHunk } from 'diff';
import { isAbsolute, relative, resolve } from 'path';
import * as React from 'react';
import { Suspense, use, useState } from 'react';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { extractTag } from 'src/utils/messages.js';
import { CtrlOToExpand } from 'src/components/CtrlOToExpand.js';
import { FallbackToolUseErrorMessage } from 'src/components/FallbackToolUseErrorMessage.js';
import { FileEditToolUpdatedMessage } from 'src/components/FileEditToolUpdatedMessage.js';
import { FileEditToolUseRejectedMessage } from 'src/components/FileEditToolUseRejectedMessage.js';

import { HighlightedCode } from 'src/components/HighlightedCode.js';
import { useTerminalSize } from 'src/hooks/useTerminalSize.js';
import { Box, Text } from '@anthropic/ink';
import { FilePathLink } from 'src/components/FilePathLink.js';
import type { ToolProgressData } from 'src/Tool.js';
import type { ProgressMessage } from 'src/types/message.js';
import { getCwd } from 'src/utils/cwd.js';
import { getPatchForDisplay } from 'src/utils/diff.js';
import { getDisplayPath } from 'src/utils/file.js';
import { logError } from 'src/utils/log.js';
import { getPlansDirectory } from 'src/utils/plans.js';
import { openForScan, readCapped } from 'src/utils/readEditContext.js';
import type { Output } from './FileWriteTool.js';

const MAX_LINES_TO_RENDER = 10;
// 模型输出无论平台都使用 \n，因此始终按 \n 分割。
// os.EOL 在 Windows 上是 \r\n，会让所有文件的 numLines 都为 1。
const EOL = '\n';

/**
 * 统计文件内容的可见行数。结尾换行符被视为行终止符
 * （而不是新的空行），与编辑器的行号编号保持一致。
 */
export function countLines(content: string): number {
  const parts = content.split(EOL);
  return content.endsWith(EOL) ? parts.length - 1 : parts.length;
}

function FileWriteToolCreatedMessage({
  filePath,
  content,
  verbose,
}: {
  filePath: string;
  content: string;
  verbose: boolean;
}): React.ReactNode {
  const { columns } = useTerminalSize();
  const contentWithFallback = content || '（无内容）';
  const numLines = countLines(content);
  const plusLines = numLines - MAX_LINES_TO_RENDER;

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text>
          已写入 <Text bold>{numLines}</Text> 行至 <Text bold>{verbose ? filePath : relative(getCwd(), filePath)}</Text>
        </Text>
        <Box flexDirection="column">
          <HighlightedCode
            code={
              verbose ? contentWithFallback : contentWithFallback.split('\n').slice(0, MAX_LINES_TO_RENDER).join('\n')
            }
            filePath={filePath}
            width={columns - 12}
          />
        </Box>
        {!verbose && plusLines > 0 && (
          <Text dimColor>
            … +{plusLines} {plusLines === 1 ? '行' : '行'} {numLines > 0 && <CtrlOToExpand />}
          </Text>
        )}
      </Box>
    </MessageResponse>
  );
}

export function userFacingName(input: Partial<{ file_path: string; content: string }> | undefined): string {
  if (input?.file_path?.startsWith(getPlansDirectory())) {
    return '已更新的计划';
  }
  return 'Write';
}

/** 控制全屏点击展开行为。只有 `create` 会被截断（截断到
 *  MAX_LINES_TO_RENDER）；`update` 无论 verbose 与否都渲染完整 diff。
 *  每条可见消息在 hover/滚动时都会调用，因此找到第 (MAX+1) 行即提前退出，
 *  而不是把整段（可能非常大的）内容全部切分。 */
export function isResultTruncated({ type, content }: Output): boolean {
  if (type !== 'create') return false;
  let pos = 0;
  for (let i = 0; i < MAX_LINES_TO_RENDER; i++) {
    pos = content.indexOf(EOL, pos);
    if (pos === -1) return false;
    pos++;
  }
  // countLines 将结尾的 EOL 视为终止符，而非新行
  return pos < content.length;
}

export function getToolUseSummary(input: Partial<{ file_path: string; content: string }> | undefined): string | null {
  if (!input?.file_path) {
    return null;
  }
  return getDisplayPath(input.file_path);
}

export function renderToolUseMessage(
  input: Partial<{ file_path: string; content: string }>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!input.file_path) {
    return null;
  }
  // 对于计划文件，路径已展示在 userFacingName 中
  if (input.file_path.startsWith(getPlansDirectory())) {
    return '';
  }
  return (
    <FilePathLink filePath={input.file_path}>
      {verbose ? input.file_path : getDisplayPath(input.file_path)}
    </FilePathLink>
  );
}

export function renderToolUseRejectedMessage(
  { file_path, content }: { file_path: string; content: string },
  { style, verbose }: { style?: 'condensed'; verbose: boolean },
): React.ReactNode {
  return <WriteRejectionDiff filePath={file_path} content={content} style={style} verbose={verbose} />;
}

type RejectionDiffData =
  | { type: 'create' }
  | { type: 'update'; patch: StructuredPatchHunk[]; oldContent: string }
  | { type: 'error' };

function WriteRejectionDiff({
  filePath,
  content,
  style,
  verbose,
}: {
  filePath: string;
  content: string;
  style?: 'condensed';
  verbose: boolean;
}): React.ReactNode {
  const [dataPromise] = useState(() => loadRejectionDiff(filePath, content));
  const firstLine = content.split('\n')[0] ?? null;
  const createFallback = (
    <FileEditToolUseRejectedMessage
      file_path={filePath}
      operation="write"
      content={content}
      firstLine={firstLine}
      verbose={verbose}
    />
  );
  return (
    <Suspense fallback={createFallback}>
      <WriteRejectionBody
        promise={dataPromise}
        filePath={filePath}
        firstLine={firstLine}
        createFallback={createFallback}
        style={style}
        verbose={verbose}
      />
    </Suspense>
  );
}

function WriteRejectionBody({
  promise,
  filePath,
  firstLine,
  createFallback,
  style,
  verbose,
}: {
  promise: Promise<RejectionDiffData>;
  filePath: string;
  firstLine: string | null;
  createFallback: React.ReactNode;
  style?: 'condensed';
  verbose: boolean;
}): React.ReactNode {
  const data = use(promise);
  if (data.type === 'create') return createFallback;
  if (data.type === 'error') {
    return (
      <MessageResponse>
        <Text>（无变更）</Text>
      </MessageResponse>
    );
  }
  return (
    <FileEditToolUseRejectedMessage
      file_path={filePath}
      operation="update"
      patch={data.patch}
      firstLine={firstLine}
      fileContent={data.oldContent}
      style={style}
      verbose={verbose}
    />
  );
}

async function loadRejectionDiff(filePath: string, content: string): Promise<RejectionDiffData> {
  try {
    const fullFilePath = isAbsolute(filePath) ? filePath : resolve(getCwd(), filePath);
    const handle = await openForScan(fullFilePath);
    if (handle === null) return { type: 'create' };
    let oldContent: string | null;
    try {
      oldContent = await readCapped(handle);
    } finally {
      await handle.close();
    }
    // 文件超过 MAX_SCAN_BYTES —— 回退到 create 视图，而不是
    // 对一个数 GB 的大文件做 diff 导致 OOM。
    if (oldContent === null) return { type: 'create' };
    const patch = getPatchForDisplay({
      filePath,
      fileContents: oldContent,
      edits: [{ old_string: oldContent, new_string: content, replace_all: false }],
    });
    return { type: 'update', patch, oldContent };
  } catch (e) {
    // 用户可能在 diff 展示期间手动应用了该变更。
    logError(e as Error);
    return { type: 'error' };
  }
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!verbose && typeof result === 'string' && extractTag(result, 'tool_use_error')) {
    return (
      <MessageResponse>
        <Text color="error">写入文件时出错</Text>
      </MessageResponse>
    );
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />;
}

export function renderToolResultMessage(
  { filePath, content, structuredPatch, type, originalFile }: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  { style, verbose }: { style?: 'condensed'; verbose: boolean },
): React.ReactNode {
  switch (type) {
    case 'create': {
      const isPlanFile = filePath.startsWith(getPlansDirectory());

      // 计划文件：反转 condensed 行为
      // - 常规模式：仅展示提示（用户可输入 /plan 查看完整内容）
      // - Condensed 模式（子 agent 视图）：展示完整内容
      if (isPlanFile && !verbose) {
        if (style !== 'condensed') {
          return (
            <MessageResponse>
              <Text dimColor>/plan 预览</Text>
            </MessageResponse>
          );
        }
      } else if (style === 'condensed' && !verbose) {
        const numLines = countLines(content);
        return (
          <Text>
            已写入 <Text bold>{numLines}</Text> 行至 <Text bold>{relative(getCwd(), filePath)}</Text>
          </Text>
        );
      }

      return <FileWriteToolCreatedMessage filePath={filePath} content={content} verbose={verbose} />;
    }
    case 'update': {
      const isPlanFile = filePath.startsWith(getPlansDirectory());
      return (
        <FileEditToolUpdatedMessage
          filePath={filePath}
          structuredPatch={structuredPatch}
          firstLine={content.split('\n')[0] ?? null}
          fileContent={originalFile ?? undefined}
          style={style}
          verbose={verbose}
          previewHint={isPlanFile ? '/plan 预览' : undefined}
        />
      );
    }
  }
}
