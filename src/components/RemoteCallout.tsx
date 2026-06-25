import React, { useCallback, useEffect, useRef } from 'react';
import { isBridgeEnabled } from '../bridge/bridgeEnabled.js';
import { Box, Text } from '@anthropic/ink';
import { getClaudeAIOAuthTokens } from '../utils/auth.js';
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js';
import type { OptionWithDescription } from './CustomSelect/select.js';
import { Select } from './CustomSelect/select.js';
import { PermissionDialog } from './permissions/PermissionDialog.js';

type RemoteCalloutSelection = 'enable' | 'dismiss';

type Props = {
  onDone: (selection: RemoteCalloutSelection) => void;
};

export function RemoteCallout({ onDone }: Props): React.ReactNode {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const handleCancel = useCallback((): void => {
    onDoneRef.current('dismiss');
  }, []);

  // 在挂载时永久标记为已查看，这样它只会显示一次
  useEffect(() => {
    saveGlobalConfig(current => {
      if (current.remoteDialogSeen) return current;
      return { ...current, remoteDialogSeen: true };
    });
  }, []);

  const handleSelect = useCallback((value: RemoteCalloutSelection): void => {
    onDoneRef.current(value);
  }, []);

  const options: OptionWithDescription<RemoteCalloutSelection>[] = [
    {
      label: '为此会话启用 Remote Control',
      description: '打开到 claude.ai 的安全连接。',
      value: 'enable',
    },
    {
      label: '不了',
      description: '你可以稍后随时通过 /remote-control 启用。',
      value: 'dismiss',
    },
  ];

  return (
    <PermissionDialog title="Remote Control">
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1} flexDirection="column">
          <Text>
            Remote Control 让你可以从网页（claude.ai/code）或 Claude 应用访问此 CLI 会话，从而
            在任意设备上从上次离开的地方继续。
          </Text>
          <Text> </Text>
          <Text>你可以随时再次运行 /remote-control 断开远程访问。</Text>
        </Box>
        <Box>
          <Select options={options} onChange={handleSelect} onCancel={handleCancel} />
        </Box>
      </Box>
    </PermissionDialog>
  );
}

/**
 * 检查是否显示 remote callout（首次对话框）。
 */
export function shouldShowRemoteCallout(): boolean {
  const config = getGlobalConfig();
  if (config.remoteDialogSeen) return false;
  if (!isBridgeEnabled()) return false;
  const tokens = getClaudeAIOAuthTokens();
  if (!tokens?.accessToken) return false;
  return true;
}
