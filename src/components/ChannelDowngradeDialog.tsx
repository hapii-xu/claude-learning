import React from 'react';
import { Text } from '@anthropic/ink';
import { Select } from './CustomSelect/index.js';
import { Dialog } from '@anthropic/ink';

export type ChannelDowngradeChoice = 'downgrade' | 'stay' | 'cancel';

type Props = {
  currentVersion: string;
  onChoice: (choice: ChannelDowngradeChoice) => void;
};

/**
 * 从 latest 渠道切换到 stable 渠道时显示的对话框。
 * 让用户选择是否降级或保持当前版本。
 */
export function ChannelDowngradeDialog({ currentVersion, onChoice }: Props): React.ReactNode {
  function handleSelect(value: ChannelDowngradeChoice): void {
    onChoice(value);
  }

  function handleCancel(): void {
    onChoice('cancel');
  }

  return (
    <Dialog title="切换到 Stable 渠道" onCancel={handleCancel} color="permission" hideBorder hideInputGuide>
      <Text>stable 渠道的版本可能比您当前运行的版本（{currentVersion}）更旧。</Text>
      <Text dimColor>您希望如何处理？</Text>
      <Select
        options={[
          {
            label: '允许可能降级到 stable 版本',
            value: 'downgrade' as ChannelDowngradeChoice,
          },
          {
            label: `保持当前版本（${currentVersion}）直到 stable 追赶上`,
            value: 'stay' as ChannelDowngradeChoice,
          },
        ]}
        onChange={handleSelect}
      />
    </Dialog>
  );
}
