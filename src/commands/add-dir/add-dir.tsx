import chalk from 'chalk';
import figures from 'figures';
import React, { useEffect } from 'react';
import { getAdditionalDirectoriesForClaudeMd, setAdditionalDirectoriesForClaudeMd } from '../../bootstrap/state.js';
import type { LocalJSXCommandContext } from '../../commands.js';
import { MessageResponse } from '../../components/MessageResponse.js';
import { AddWorkspaceDirectory } from '../../components/permissions/rules/AddWorkspaceDirectory.js';
import { Box, Text } from '@anthropic/ink';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { applyPermissionUpdate, persistPermissionUpdate } from '../../utils/permissions/PermissionUpdate.js';
import type { PermissionUpdateDestination } from '../../utils/permissions/PermissionUpdateSchema.js';
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js';
import { addDirHelpMessage, validateDirectoryForWorkspace } from './validation.js';

function AddDirError({
  message,
  args,
  onDone,
}: {
  message: string;
  args: string;
  onDone: () => void;
}): React.ReactNode {
  useEffect(() => {
    // 需要延迟调用 onDone，以避免「return null」导致的 bug ——
    // 组件在 React 渲染错误消息之前就被卸载。
    // 使用 setTimeout 保证错误先显示再退出命令。
    const timer = setTimeout(onDone, 0);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {figures.pointer} /add-dir {args}
      </Text>
      <MessageResponse>
        <Text>{message}</Text>
      </MessageResponse>
    </Box>
  );
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const directoryPath = (args ?? '').trim();
  const appState = context.getAppState();

  // 处理添加目录的辅助函数（带路径与不带路径两种情况共用）
  const handleAddDirectory = async (path: string, remember = false) => {
    const destination: PermissionUpdateDestination = remember ? 'localSettings' : 'session';

    const permissionUpdate = {
      type: 'addDirectories' as const,
      directories: [path],
      destination,
    };

    // 应用到会话上下文
    const latestAppState = context.getAppState();
    const updatedContext = applyPermissionUpdate(latestAppState.toolPermissionContext, permissionUpdate);
    context.setAppState(prev => ({
      ...prev,
      toolPermissionContext: updatedContext,
    }));

    // 更新 sandbox 配置，使 Bash 命令能够访问新目录。
    // bootstrap state 是仅会话级目录的事实来源；持久化的目录会通过 settings 订阅被感知，
    // 但这里主动刷新一次，避免用户立即操作时出现竞态。
    const currentDirs = getAdditionalDirectoriesForClaudeMd();
    if (!currentDirs.includes(path)) {
      setAdditionalDirectoriesForClaudeMd([...currentDirs, path]);
    }
    SandboxManager.refreshConfig();

    let message: string;

    if (remember) {
      try {
        persistPermissionUpdate(permissionUpdate);
        message = `Added ${chalk.bold(path)} as a working directory and saved to local settings`;
      } catch (error) {
        message = `Added ${chalk.bold(path)} as a working directory. Failed to save to local settings: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }
    } else {
      message = `Added ${chalk.bold(path)} as a working directory for this session`;
    }

    const messageWithHint = `${message} ${chalk.dim('· /permissions to manage')}`;
    onDone(messageWithHint);
  };

  // 未提供路径时，直接展示 AddWorkspaceDirectory 输入表单，
  // 并在确认后返回 REPL
  if (!directoryPath) {
    return (
      <AddWorkspaceDirectory
        permissionContext={appState.toolPermissionContext}
        onAddDirectory={handleAddDirectory}
        onCancel={() => {
          onDone('Did not add a working directory.');
        }}
      />
    );
  }

  const result = await validateDirectoryForWorkspace(directoryPath, appState.toolPermissionContext);

  if (result.resultType !== 'success') {
    const message = addDirHelpMessage(result);

    return <AddDirError message={message} args={args ?? ''} onDone={() => onDone(message)} />;
  }

  return (
    <AddWorkspaceDirectory
      directoryPath={result.absolutePath}
      permissionContext={appState.toolPermissionContext}
      onAddDirectory={handleAddDirectory}
      onCancel={() => {
        onDone(`Did not add ${chalk.bold(result.absolutePath)} as a working directory.`);
      }}
    />
  );
}
