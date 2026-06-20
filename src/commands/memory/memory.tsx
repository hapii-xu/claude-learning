import { mkdir, writeFile } from 'fs/promises';
import * as React from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { Dialog } from '@anthropic/ink';
import { MemoryFileSelector } from '../../components/memory/MemoryFileSelector.js';
import { getRelativeMemoryPath } from '../../components/memory/MemoryUpdateNotification.js';
import { Box, Link, Text } from '@anthropic/ink';
import type { LocalJSXCommandCall } from '../../types/command.js';
import { clearMemoryFileCaches, getMemoryFiles } from '../../utils/claudemd.js';
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js';
import { getErrnoCode } from '../../utils/errors.js';
import { logError } from '../../utils/log.js';
import { editFileInEditor } from '../../utils/promptEditor.js';

function MemoryCommand({
  onDone,
}: {
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void;
}): React.ReactNode {
  const handleSelectMemoryFile = async (memoryPath: string) => {
    try {
      // 若 claude 目录不存在则创建（recursive 使其幂等）
      if (memoryPath.includes(getClaudeConfigHomeDir())) {
        await mkdir(getClaudeConfigHomeDir(), { recursive: true });
      }

      // 若文件不存在则创建（wx flag 在文件已存在时会失败，
      // 我们捕获该异常以保留已有内容）
      try {
        await writeFile(memoryPath, '', { encoding: 'utf8', flag: 'wx' });
      } catch (e: unknown) {
        if (getErrnoCode(e) !== 'EEXIST') {
          throw e;
        }
      }

      await editFileInEditor(memoryPath);

      // 判断是哪个环境变量控制编辑器
      let editorSource = 'default';
      let editorValue = '';
      if (process.env.VISUAL) {
        editorSource = '$VISUAL';
        editorValue = process.env.VISUAL;
      } else if (process.env.EDITOR) {
        editorSource = '$EDITOR';
        editorValue = process.env.EDITOR;
      }

      const editorInfo = editorSource !== 'default' ? `Using ${editorSource}="${editorValue}".` : '';

      const editorHint = editorInfo
        ? `> ${editorInfo} To change editor, set $EDITOR or $VISUAL environment variable.`
        : `> To use a different editor, set the $EDITOR or $VISUAL environment variable.`;

      onDone(`Opened memory file at ${getRelativeMemoryPath(memoryPath)}\n\n${editorHint}`, { display: 'system' });
    } catch (error) {
      logError(error);
      onDone(`Error opening memory file: ${error}`);
    }
  };

  const handleCancel = () => {
    onDone('Cancelled memory editing', { display: 'system' });
  };

  return (
    <Dialog title="Memory" onCancel={handleCancel} color="remember">
      <Box flexDirection="column">
        <React.Suspense fallback={null}>
          <MemoryFileSelector onSelect={handleSelectMemoryFile} onCancel={handleCancel} />
        </React.Suspense>

        <Box marginTop={1}>
          <Text dimColor>
            Learn more: <Link url="https://code.claude.com/docs/en/memory" />
          </Text>
        </Box>
      </Box>
    </Dialog>
  );
}

export const call: LocalJSXCommandCall = async onDone => {
  // 渲染前先清除并预热 —— Suspense 能处理未预热的情况，
  // 但在此处 await 可避免初次打开时出现 fallback 闪烁。
  clearMemoryFileCaches();
  await getMemoryFiles();
  return <MemoryCommand onDone={onDone} />;
};
