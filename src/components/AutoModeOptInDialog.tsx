import React from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { Box, Dialog, Link, Text } from '@anthropic/ink';
import { updateSettingsForSource } from '../utils/settings/settings.js';
import { Select } from './CustomSelect/index.js';

// 注意：此文案已经过法务审核 —— 未经法务团队批准请勿修改。
export const AUTO_MODE_DESCRIPTION =
  'Auto 模式让 Claude 自动处理权限提示 —— Claude 在执行每个工具调用前会检查是否存在风险操作和提示注入。Claude 认定安全的操作会被执行，而 Claude 认定有风险的操作将被阻止，并可能改用其他方式。适合长时间运行的任务，会话开销略高。Claude 可能出错而导致有害命令运行，建议仅在隔离环境中使用。按 Shift+Tab 切换模式。';

type Props = {
  onAccept(): void;
  onDecline(): void;
  // 启动门控：选择拒绝会退出进程，因此按钮文案需相应调整。
  declineExits?: boolean;
};

export function AutoModeOptInDialog({ onAccept, onDecline, declineExits }: Props): React.ReactNode {
  React.useEffect(() => {
    logEvent('tengu_auto_mode_opt_in_dialog_shown', {});
  }, []);

  function onChange(value: 'accept' | 'accept-default' | 'decline') {
    switch (value) {
      case 'accept': {
        logEvent('tengu_auto_mode_opt_in_dialog_accept', {});
        updateSettingsForSource('userSettings', {
          skipAutoPermissionPrompt: true,
        });
        onAccept();
        break;
      }
      case 'accept-default': {
        logEvent('tengu_auto_mode_opt_in_dialog_accept_default', {});
        updateSettingsForSource('userSettings', {
          skipAutoPermissionPrompt: true,
          permissions: { defaultMode: 'auto' },
        });
        onAccept();
        break;
      }
      case 'decline': {
        logEvent('tengu_auto_mode_opt_in_dialog_decline', {});
        onDecline();
        break;
      }
    }
  }

  return (
    <Dialog title="启用 auto 模式？" color="warning" onCancel={onDecline}>
      <Box flexDirection="column" gap={1}>
        <Text>{AUTO_MODE_DESCRIPTION}</Text>

        <Link url="https://code.claude.com/docs/en/security" />
      </Box>

      <Select
        options={[
          ...((process.env.USER_TYPE as string) !== 'ant'
            ? [
                {
                  label: '是，并设为默认模式',
                  value: 'accept-default' as const,
                },
              ]
            : []),
          { label: '是，启用 auto 模式', value: 'accept' as const },
          {
            label: declineExits ? '否，退出' : '否，返回',
            value: 'decline' as const,
          },
        ]}
        onChange={value => onChange(value as 'accept' | 'accept-default' | 'decline')}
        onCancel={onDecline}
      />
    </Dialog>
  );
}
