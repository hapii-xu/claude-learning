import figures from 'figures';
import React, { useEffect, useState } from 'react';
import { Box, Text, Dialog } from '@anthropic/ink';
import { logForDebugging } from '../utils/debug.js';
import type { GitFileStatus } from '../utils/git.js';
import { getFileStatus, stashToCleanState } from '../utils/git.js';
import { Select } from './CustomSelect/index.js';
import { Spinner } from './Spinner.js';

type TeleportStashProps = {
  onStashAndContinue: () => void;
  onCancel: () => void;
};

export function TeleportStash({ onStashAndContinue, onCancel }: TeleportStashProps): React.ReactNode {
  const [gitFileStatus, setGitFileStatus] = useState<GitFileStatus | null>(null);
  const changedFiles = gitFileStatus !== null ? [...gitFileStatus.tracked, ...gitFileStatus.untracked] : [];
  const [loading, setLoading] = useState(true);
  const [stashing, setStashing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 挂载时加载已更改的文件
  useEffect(() => {
    const loadChangedFiles = async () => {
      try {
        const fileStatus = await getFileStatus();
        setGitFileStatus(fileStatus);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logForDebugging(`Error getting changed files: ${errorMessage}`, {
          level: 'error',
        });
        setError('获取已更改文件失败');
      } finally {
        setLoading(false);
      }
    };

    void loadChangedFiles();
  }, []);

  const handleStash = async () => {
    setStashing(true);
    try {
      logForDebugging('Stashing changes before teleport...');
      const success = await stashToCleanState('Teleport auto-stash');

      if (success) {
        logForDebugging('Successfully stashed changes');
        onStashAndContinue();
      } else {
        setError('暂存更改失败');
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logForDebugging(`Error stashing changes: ${errorMessage}`, {
        level: 'error',
      });
      setError('暂存更改失败');
    } finally {
      setStashing(false);
    }
  };

  const handleSelectChange = (value: string) => {
    if (value === 'stash') {
      void handleStash();
    } else {
      onCancel();
    }
  };

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Spinner />
          <Text> 正在检查 git 状态{figures.ellipsis}</Text>
        </Box>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="error">
          错误：{error}
        </Text>
        <Box marginTop={1}>
          <Text dimColor>按 </Text>
          <Text bold>Escape</Text>
          <Text dimColor> 取消</Text>
        </Box>
      </Box>
    );
  }

  const showFileCount = changedFiles.length > 8;

  return (
    <Dialog title="工作目录有未提交的更改" onCancel={onCancel}>
      <Text>Teleport 会切换 git 分支。检测到以下更改：</Text>

      <Box flexDirection="column" paddingLeft={2}>
        {changedFiles.length > 0 ? (
          showFileCount ? (
            <Text>{changedFiles.length} 个文件已更改</Text>
          ) : (
            changedFiles.map((file: string, index: number) => <Text key={index}>{file}</Text>)
          )
        ) : (
          <Text dimColor>未检测到更改</Text>
        )}
      </Box>

      <Text>是否要暂存这些更改并继续 teleport？</Text>

      {stashing ? (
        <Box>
          <Spinner />
          <Text> 正在暂存更改...</Text>
        </Box>
      ) : (
        <Select
          options={[
            { label: '暂存更改并继续', value: 'stash' },
            { label: '退出', value: 'exit' },
          ]}
          onChange={handleSelectChange}
        />
      )}
    </Dialog>
  );
}
