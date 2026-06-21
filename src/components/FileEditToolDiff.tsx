import type { StructuredPatchHunk } from 'diff';
import * as React from 'react';
import { Suspense, use, useState } from 'react';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box, Text } from '@anthropic/ink';
import type { FileEdit } from '@claude-code-best/builtin-tools/tools/FileEditTool/types.js';
import { findActualString } from '@claude-code-best/builtin-tools/tools/FileEditTool/utils.js';
import { adjustHunkLineNumbers, CONTEXT_LINES, getPatchForDisplay } from '../utils/diff.js';
import { logError } from '../utils/log.js';
import { CHUNK_SIZE, openForScan, readCapped, scanForContext } from '../utils/readEditContext.js';
import { firstLineOf } from '../utils/stringUtils.js';
import { StructuredDiffList } from './StructuredDiffList.js';

type Props = {
  file_path: string;
  edits: FileEdit[];
};

type DiffData = {
  patch: StructuredPatchHunk[];
  firstLine: string | null;
  fileContent: string | undefined;
};

export function FileEditToolDiff(props: Props): React.ReactNode {
  // 在挂载时快照 —— 即使文件在对话框打开期间发生变化，diff 也必须保持一致。
  // 在 props.edits 上使用 useMemo 会在每次渲染时重新读取文件，因为
  // 调用方传入的是全新的数组字面量。
  const [dataPromise] = useState(() => loadDiffData(props.file_path, props.edits));
  return (
    <Suspense fallback={<DiffFrame placeholder />}>
      <DiffBody promise={dataPromise} file_path={props.file_path} />
    </Suspense>
  );
}

function DiffBody({ promise, file_path }: { promise: Promise<DiffData>; file_path: string }): React.ReactNode {
  const { patch, firstLine, fileContent } = use(promise);
  const { columns } = useTerminalSize();
  return (
    <DiffFrame>
      <StructuredDiffList
        hunks={patch}
        dim={false}
        width={columns}
        filePath={file_path}
        firstLine={firstLine}
        fileContent={fileContent}
      />
    </DiffFrame>
  );
}

function DiffFrame({ children, placeholder }: { children?: React.ReactNode; placeholder?: boolean }): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Box borderColor="subtle" borderStyle="dashed" flexDirection="column" borderLeft={false} borderRight={false}>
        {placeholder ? <Text dimColor>…</Text> : children}
      </Box>
    </Box>
  );
}

async function loadDiffData(file_path: string, edits: FileEdit[]): Promise<DiffData> {
  const valid = edits.filter(e => e.old_string != null && e.new_string != null);
  const single = valid.length === 1 ? valid[0]! : undefined;

  // SedEditPermissionRequest 将整个文件作为 old_string 传入。扫描
  // 大于等于 CHUNK_SIZE 的 needle 会为 overlap buffer 分配 O(needle) 内存 —— 完全跳过
  // 文件读取，直接 diff 我们已有的输入。
  if (single && single.old_string.length >= CHUNK_SIZE) {
    return diffToolInputsOnly(file_path, [single]);
  }

  try {
    const handle = await openForScan(file_path);
    if (handle === null) return diffToolInputsOnly(file_path, valid);
    try {
      // Multi-edit 和空的 old_string 确实需要 full-file 来进行顺序
      // 替换 —— structuredPatch 需要 before/after 字符串。replace_all
      // 走下方的分块路径（显示首次出现的窗口；
      // slice 内的匹配仍然通过 edit.replace_all 替换）。
      if (!single || single.old_string === '') {
        const file = await readCapped(handle);
        if (file === null) return diffToolInputsOnly(file_path, valid);
        const normalized = valid.map(e => normalizeEdit(file, e));
        return {
          patch: getPatchForDisplay({
            filePath: file_path,
            fileContents: file,
            edits: normalized,
          }),
          firstLine: firstLineOf(file),
          fileContent: file,
        };
      }

      const ctx = await scanForContext(handle, single.old_string, CONTEXT_LINES);
      if (ctx.truncated || ctx.content === '') {
        return diffToolInputsOnly(file_path, [single]);
      }
      const normalized = normalizeEdit(ctx.content, single);
      const hunks = getPatchForDisplay({
        filePath: file_path,
        fileContents: ctx.content,
        edits: [normalized],
      });
      return {
        patch: adjustHunkLineNumbers(hunks, ctx.lineOffset - 1),
        firstLine: ctx.lineOffset === 1 ? firstLineOf(ctx.content) : null,
        fileContent: ctx.content,
      };
    } finally {
      await handle.close();
    }
  } catch (e) {
    logError(e as Error);
    return diffToolInputsOnly(file_path, valid);
  }
}

function diffToolInputsOnly(filePath: string, edits: FileEdit[]): DiffData {
  return {
    patch: edits.flatMap(e =>
      getPatchForDisplay({
        filePath,
        fileContents: e.old_string,
        edits: [e],
      }),
    ),
    firstLine: null,
    fileContent: undefined,
  };
}

function normalizeEdit(fileContent: string, edit: FileEdit): FileEdit {
  const actualOld = findActualString(fileContent, edit.old_string) || edit.old_string;
  return { ...edit, old_string: actualOld };
}
