import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { Select } from '../CustomSelect/select.js';
import { PermissionDialog } from '../permissions/PermissionDialog.js';

type Props = {
  pluginName: string;
  pluginDescription?: string;
  marketplaceName: string;
  sourceCommand: string;
  onResponse: (response: 'yes' | 'no' | 'disable') => void;
};

const AUTO_DISMISS_MS = 30_000;

export function PluginHintMenu({
  pluginName,
  pluginDescription,
  marketplaceName,
  sourceCommand,
  onResponse,
}: Props): React.ReactNode {
  const onResponseRef = React.useRef(onResponse);
  onResponseRef.current = onResponse;

  React.useEffect(() => {
    const timeoutId = setTimeout(ref => ref.current('no'), AUTO_DISMISS_MS, onResponseRef);
    return () => clearTimeout(timeoutId);
  }, []);

  function onSelect(value: string): void {
    switch (value) {
      case 'yes':
        onResponse('yes');
        break;
      case 'disable':
        onResponse('disable');
        break;
      default:
        onResponse('no');
    }
  }

  const options = [
    {
      label: (
        <Text>
          是的，安装 <Text bold>{pluginName}</Text>
        </Text>
      ),
      value: 'yes',
    },
    {
      label: '否',
      value: 'no',
    },
    {
      label: '否，并且不再显示插件安装提示',
      value: 'disable',
    },
  ];

  return (
    <PermissionDialog title="插件推荐">
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1}>
          <Text dimColor>
            <Text bold>{sourceCommand}</Text> 命令建议安装一个插件。
          </Text>
        </Box>
        <Box>
          <Text dimColor>插件：</Text>
          <Text> {pluginName}</Text>
        </Box>
        <Box>
          <Text dimColor>Marketplace：</Text>
          <Text> {marketplaceName}</Text>
        </Box>
        {pluginDescription && (
          <Box>
            <Text dimColor>{pluginDescription}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text>是否安装？</Text>
        </Box>
        <Box>
          <Select options={options} onChange={onSelect} onCancel={() => onResponse('no')} />
        </Box>
      </Box>
    </PermissionDialog>
  );
}
