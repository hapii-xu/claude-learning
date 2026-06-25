import React from 'react';
import { Text, Dialog } from '@anthropic/ink';
import type { ValidationError } from '../utils/settings/validation.js';
import { Select } from './CustomSelect/index.js';
import { ValidationErrorsList } from './ValidationErrorsList.js';

type Props = {
  settingsErrors: ValidationError[];
  onContinue: () => void;
  onExit: () => void;
};

/**
 * 当 settings 文件存在校验错误时显示的对话框。
 * 用户必须选择继续（跳过无效文件）或退出以修复它们。
 */
export function InvalidSettingsDialog({ settingsErrors, onContinue, onExit }: Props): React.ReactNode {
  function handleSelect(value: string): void {
    if (value === 'exit') {
      onExit();
    } else {
      onContinue();
    }
  }

  return (
    <Dialog title="设置错误" onCancel={onExit} color="warning">
      <ValidationErrorsList errors={settingsErrors} />
      <Text dimColor>出错的文件会被整体跳过，而非仅跳过无效的设置项。</Text>
      <Select
        options={[
          { label: '退出并手动修复', value: 'exit' },
          {
            label: '不使用这些设置继续',
            value: 'continue',
          },
        ]}
        onChange={handleSelect}
      />
    </Dialog>
  );
}
