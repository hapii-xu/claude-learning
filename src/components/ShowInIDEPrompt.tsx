import { basename, relative } from 'path';
import React from 'react';
import { Box, Text, Pane } from '@anthropic/ink';
import { getCwd } from '../utils/cwd.js';
import { isSupportedVSCodeTerminal } from '../utils/ide.js';
import { Select } from './CustomSelect/index.js';
import type {
  PermissionOption,
  PermissionOptionWithLabel,
} from './permissions/FilePermissionDialog/permissionOptions.js';

type Props<A> = {
  filePath: string;
  input: A;
  onChange: (option: PermissionOption, args: A, feedback?: string) => void;
  options: PermissionOptionWithLabel[];
  ideName: string;
  symlinkTarget?: string | null;
  rejectFeedback: string;
  acceptFeedback: string;
  setFocusedOption: (value: string) => void;
  onInputModeToggle: (value: string) => void;
  focusedOption: string;
  yesInputMode: boolean;
  noInputMode: boolean;
};

export function ShowInIDEPrompt<A>({
  onChange,
  options,
  input,
  filePath,
  ideName,
  symlinkTarget,
  rejectFeedback,
  acceptFeedback,
  setFocusedOption,
  onInputModeToggle,
  focusedOption,
  yesInputMode,
  noInputMode,
}: Props<A>): React.ReactNode {
  return (
    <Pane color="permission">
      <Box flexDirection="column" gap={1}>
        <Text bold color="permission">
          已在 {ideName} 中打开更改 ⧉
        </Text>
        {symlinkTarget && (
          <Text color="warning">
            {relative(getCwd(), symlinkTarget).startsWith('..')
              ? `这将通过 symlink 修改 ${symlinkTarget}（工作目录之外）`
              : `Symlink 目标：${symlinkTarget}`}
          </Text>
        )}
        {isSupportedVSCodeTerminal() && <Text dimColor>保存文件以继续…</Text>}
        <Box flexDirection="column">
          <Text>
            是否要对 <Text bold>{basename(filePath)}</Text> 进行此编辑？
          </Text>
          <Select
            options={options}
            inlineDescriptions
            onChange={value => {
              const selected = options.find(opt => opt.value === value);
              if (selected) {
                // 对于拒绝选项
                if (selected.option.type === 'reject') {
                  const trimmedFeedback = rejectFeedback.trim();
                  onChange(selected.option, input, trimmedFeedback || undefined);
                  return;
                }
                // 对于"接受一次"选项，如有则传入 accept feedback
                if (selected.option.type === 'accept-once') {
                  const trimmedFeedback = acceptFeedback.trim();
                  onChange(selected.option, input, trimmedFeedback || undefined);
                  return;
                }
                onChange(selected.option, input);
              }
            }}
            onCancel={() => onChange({ type: 'reject' }, input)}
            onFocus={value => setFocusedOption(value)}
            onInputModeToggle={onInputModeToggle}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            Esc 取消
            {((focusedOption === 'yes' && !yesInputMode) || (focusedOption === 'no' && !noInputMode)) && ' · Tab 修改'}
          </Text>
        </Box>
      </Box>
    </Pane>
  );
}
