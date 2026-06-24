import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { type NetworkHostPattern, shouldAllowManagedSandboxDomainsOnly } from 'src/utils/sandbox/sandbox-adapter.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js';
import { Select } from '../CustomSelect/select.js';
import { PermissionDialog } from './PermissionDialog.js';

export type SandboxPermissionRequestProps = {
  hostPattern: NetworkHostPattern;
  onUserResponse: (response: { allow: boolean; persistToSettings: boolean }) => void;
};

export function SandboxPermissionRequest({
  hostPattern: { host },
  onUserResponse,
}: SandboxPermissionRequestProps): React.ReactNode {
  function onSelect(value: string) {
    // 我们可能希望将此对话框与其他权限对话框更好地统一，
    // 并复用它们的日志记录，但这里略有不同——我们没有
    // 工具上下文。目前只对基础数据使用基础日志记录。
    if (process.env.USER_TYPE === 'ant') {
      logEvent('tengu_sandbox_network_dialog_result', {
        host: host as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        result: value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
    }

    switch (value) {
      case 'yes':
        onUserResponse({ allow: true, persistToSettings: false });
        break;
      case 'yes-dont-ask-again':
        onUserResponse({ allow: true, persistToSettings: true });
        break;
      case 'no':
        onUserResponse({ allow: false, persistToSettings: false });
        break;
    }
  }

  const managedDomainsOnly = shouldAllowManagedSandboxDomainsOnly();

  const options = [
    { label: '是', value: 'yes' },
    ...(!managedDomainsOnly
      ? [
          {
            label: (
              <Text>
                是，且不再询问 <Text bold>{host}</Text>
              </Text>
            ),
            value: 'yes-dont-ask-again',
          },
        ]
      : []),
    {
      label: (
        <Text>
          否，告诉 Claude 要做什么改变 <Text bold>(esc)</Text>
        </Text>
      ),
      value: 'no',
    },
  ];

  return (
    <PermissionDialog title="沙盒外的网络请求">
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box>
          <Text dimColor>主机：</Text>
          <Text> {host}</Text>
        </Box>
        <Box marginTop={1}>
          <Text>是否允许此连接？</Text>
        </Box>
        <Box>
          <Select
            options={options}
            onChange={onSelect}
            onCancel={() => {
              if (process.env.USER_TYPE === 'ant') {
                logEvent('tengu_sandbox_network_dialog_result', {
                  host: host as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  result: 'cancel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                });
              }
              onUserResponse({ allow: false, persistToSettings: false });
            }}
          />
        </Box>
      </Box>
    </PermissionDialog>
  );
}
