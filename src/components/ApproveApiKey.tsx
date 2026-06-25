import React from 'react';
import { Text, Dialog } from '@anthropic/ink';
import { saveGlobalConfig } from '../utils/config.js';
import { Select } from './CustomSelect/index.js';

type Props = {
  customApiKeyTruncated: string;
  onDone(approved: boolean): void;
};

export function ApproveApiKey({ customApiKeyTruncated, onDone }: Props): React.ReactNode {
  function onChange(value: 'yes' | 'no') {
    switch (value) {
      case 'yes': {
        saveGlobalConfig(current => ({
          ...current,
          customApiKeyResponses: {
            ...current.customApiKeyResponses,
            approved: [...(current.customApiKeyResponses?.approved ?? []), customApiKeyTruncated],
          },
        }));
        onDone(true);
        break;
      }
      case 'no': {
        saveGlobalConfig(current => ({
          ...current,
          customApiKeyResponses: {
            ...current.customApiKeyResponses,
            rejected: [...(current.customApiKeyResponses?.rejected ?? []), customApiKeyTruncated],
          },
        }));
        onDone(false);
        break;
      }
    }
  }

  return (
    <Dialog title="检测到您的环境中存在自定义 API key" color="warning" onCancel={() => onChange('no')}>
      <Text>
        <Text bold>ANTHROPIC_API_KEY</Text>
        <Text>: sk-ant-...{customApiKeyTruncated}</Text>
      </Text>
      <Text>是否要使用此 API key？</Text>
      <Select
        defaultValue="no"
        defaultFocusValue="no"
        options={[
          { label: '是', value: 'yes' },
          {
            label: (
              <Text>
                否（<Text bold>推荐</Text>）
              </Text>
            ),
            value: 'no',
          },
        ]}
        onChange={value => onChange(value as 'yes' | 'no')}
        onCancel={() => onChange('no')}
      />
    </Dialog>
  );
}
