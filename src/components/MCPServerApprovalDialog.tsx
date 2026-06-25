import React from 'react';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import { getSettings_DEPRECATED, updateSettingsForSource } from '../utils/settings/settings.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from '@anthropic/ink';
import { MCPServerDialogCopy } from './MCPServerDialogCopy.js';

type Props = {
  serverName: string;
  onDone(): void;
};

export function MCPServerApprovalDialog({ serverName, onDone }: Props): React.ReactNode {
  function onChange(value: 'yes' | 'yes_all' | 'no') {
    logEvent('tengu_mcp_dialog_choice', {
      choice: value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });

    switch (value) {
      case 'yes':
      case 'yes_all': {
        // 从设置中获取当前已启用的服务器
        const currentSettings = getSettings_DEPRECATED() || {};
        const enabledServers = currentSettings.enabledMcpjsonServers || [];

        // 如果服务器尚未启用，则添加
        if (!enabledServers.includes(serverName)) {
          updateSettingsForSource('localSettings', {
            enabledMcpjsonServers: [...enabledServers, serverName],
          });
        }

        if (value === 'yes_all') {
          updateSettingsForSource('localSettings', {
            enableAllProjectMcpServers: true,
          });
        }
        onDone();
        break;
      }
      case 'no': {
        // 从设置中获取当前已禁用的服务器
        const currentSettings = getSettings_DEPRECATED() || {};
        const disabledServers = currentSettings.disabledMcpjsonServers || [];

        // 如果服务器尚未禁用，则添加
        if (!disabledServers.includes(serverName)) {
          updateSettingsForSource('localSettings', {
            disabledMcpjsonServers: [...disabledServers, serverName],
          });
        }
        onDone();
        break;
      }
    }
  }

  return (
    <Dialog title={`在 .mcp.json 中发现新的 MCP 服务器：${serverName}`} color="warning" onCancel={() => onChange('no')}>
      <MCPServerDialogCopy />

      <Select
        options={[
          {
            label: `使用此服务器以及该项目中所有未来的 MCP 服务器`,
            value: 'yes_all',
          },
          { label: `使用此 MCP 服务器`, value: 'yes' },
          { label: `不使用此 MCP 服务器继续`, value: 'no' },
        ]}
        onChange={value => onChange(value as 'yes_all' | 'yes' | 'no')}
        onCancel={() => onChange('no')}
      />
    </Dialog>
  );
}
