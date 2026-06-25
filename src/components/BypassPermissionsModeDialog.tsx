import React, { useCallback } from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { Box, Link, Newline, Text } from '@anthropic/ink';
import { gracefulShutdownSync } from '../utils/gracefulShutdown.js';
import { updateSettingsForSource } from '../utils/settings/settings.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from '@anthropic/ink';

type Props = {
  onAccept(): void;
};

export function BypassPermissionsModeDialog({ onAccept }: Props): React.ReactNode {
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

  React.useEffect(() => {
    logEvent('tengu_bypass_permissions_mode_dialog_shown', {});
  }, []);

  function onChange(value: 'accept' | 'decline') {
    switch (value) {
      case 'accept': {
        logEvent('tengu_bypass_permissions_mode_dialog_accept', {});

        updateSettingsForSource('userSettings', {
          skipDangerousModePermissionPrompt: true,
        });
        onAccept();
        break;
      }
      case 'decline': {
        setPendingExitCode(1);
        break;
      }
    }
  }

  const handleEscape = useCallback(() => {
    setPendingExitCode(0);
  }, []);

  if (pendingExitCode !== null) {
    return null;
  }

  return (
    <Dialog title="警告：Claude Code 正运行于 Bypass Permissions 模式" color="error" onCancel={handleEscape}>
      <Box flexDirection="column" gap={1}>
        <Text>
          在 Bypass Permissions 模式下，Claude Code 在运行潜在危险命令前不会征求您的批准。
          <Newline />
          此模式仅应在受限网络访问、且易于恢复的沙箱容器/虚拟机中使用。
        </Text>
        <Text>继续即表示您对在 Bypass Permissions 模式下执行的所有操作承担责任。</Text>

        <Link url="https://code.claude.com/docs/en/security" />
      </Box>

      <Select
        options={[
          { label: '否，退出', value: 'decline' },
          { label: '是，我接受', value: 'accept' },
        ]}
        onChange={value => onChange(value as 'accept' | 'decline')}
      />
    </Dialog>
  );
}
