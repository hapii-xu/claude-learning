import React, { useCallback } from 'react';
import type { ChannelEntry } from '../bootstrap/state.js';
import { Box, Text, Dialog } from '@anthropic/ink';
import { gracefulShutdownSync } from '../utils/gracefulShutdown.js';
import { Select } from './CustomSelect/index.js';

type Props = {
  channels: ChannelEntry[];
  onAccept(): void;
};

export function DevChannelsDialog({ channels, onAccept }: Props): React.ReactNode {
  const [pendingExitCode, setPendingExitCode] = React.useState<number | null>(null);

  // 在关闭前清屏，避免残留的对话框内容泄漏到终端。
  // 延迟到下一个 tick 执行，以便 Ink 先刷新 null 渲染。
  React.useEffect(() => {
    if (pendingExitCode !== null) {
      const code = pendingExitCode;
      const timer = setTimeout(() => gracefulShutdownSync(code));
      return () => clearTimeout(timer);
    }
  }, [pendingExitCode]);

  function onChange(value: 'accept' | 'exit') {
    switch (value) {
      case 'accept':
        onAccept();
        break;
      case 'exit':
        setPendingExitCode(1);
        break;
    }
  }

  const handleEscape = useCallback(() => {
    setPendingExitCode(0);
  }, []);

  if (pendingExitCode !== null) {
    return null;
  }

  return (
    <Dialog title="警告：正在加载开发渠道" color="error" onCancel={handleEscape}>
      <Box flexDirection="column" gap={1}>
        <Text>--dangerously-load-development-channels 仅用于本地渠道开发。请勿使用此选项运行从互联网下载的渠道。</Text>
        <Text>请使用 --channels 来运行经过审批的渠道列表。</Text>
        <Text dimColor>
          渠道：{' '}
          {channels
            .map(c => (c.kind === 'plugin' ? `plugin:${c.name}@${c.marketplace}` : `server:${c.name}`))
            .join(', ')}
        </Text>
      </Box>

      <Select
        options={[
          { label: '我正在用于本地开发', value: 'accept' },
          { label: '退出', value: 'exit' },
        ]}
        onChange={value => onChange(value as 'accept' | 'exit')}
      />
    </Dialog>
  );
}
