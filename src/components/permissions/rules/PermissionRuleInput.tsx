import figures from 'figures';
import * as React from 'react';
import { useState } from 'react';
import TextInput from '../../../components/TextInput.js';
import { useExitOnCtrlCDWithKeybindings } from '../../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
import { Box, Newline, Text } from '@anthropic/ink';
import { useKeybinding } from '../../../keybindings/useKeybinding.js';
import { BashTool } from '@claude-code-best/builtin-tools/tools/BashTool/BashTool.js';
import { WebFetchTool } from '@claude-code-best/builtin-tools/tools/WebFetchTool/WebFetchTool.js';
import type { PermissionBehavior, PermissionRuleValue } from '../../../utils/permissions/PermissionRule.js';
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from '../../../utils/permissions/permissionRuleParser.js';

export type PermissionRuleInputProps = {
  onCancel: () => void;
  onSubmit: (ruleValue: PermissionRuleValue, ruleBehavior: PermissionBehavior) => void;
  ruleBehavior: PermissionBehavior;
};

export function PermissionRuleInput({ onCancel, onSubmit, ruleBehavior }: PermissionRuleInputProps): React.ReactNode {
  const [inputValue, setInputValue] = useState('');
  const [cursorOffset, setCursorOffset] = useState(0);
  const exitState = useExitOnCtrlCDWithKeybindings();

  // Use configurable keybinding for ESC to cancel
  // Use Settings context so 'n' key doesn't cancel (allows typing 'n' in input)
  useKeybinding('confirm:no', onCancel, { context: 'Settings' });

  const { columns } = useTerminalSize();
  const textInputColumns = columns - 6;

  const handleSubmit = (value: string) => {
    const trimmedValue = value.trim();
    if (trimmedValue.length === 0) {
      return;
    }
    const ruleValue = permissionRuleValueFromString(trimmedValue);
    onSubmit(ruleValue, ruleBehavior);
  };

  return (
    <>
      <Box flexDirection="column" gap={1} borderStyle="round" paddingLeft={1} paddingRight={1} borderColor="permission">
        <Text bold color="permission">
          添加 {ruleBehavior} 权限规则
        </Text>
        <Box flexDirection="column">
          <Text>
            权限规则由工具名称组成，后面可选地跟上括号内的匹配说明符。
            <Newline />
            例如：<Text bold>{permissionRuleValueToString({ toolName: WebFetchTool.name })}</Text>
            <Text bold={false}> 或 </Text>
            <Text bold>
              {permissionRuleValueToString({
                toolName: BashTool.name,
                ruleContent: 'ls:*',
              })}
            </Text>
          </Text>
          <Box borderDimColor borderStyle="round" marginY={1} paddingLeft={1}>
            <TextInput
              showCursor
              value={inputValue}
              onChange={setInputValue}
              onSubmit={handleSubmit}
              placeholder={`输入权限规则${figures.ellipsis}`}
              columns={textInputColumns}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
            />
          </Box>
        </Box>
      </Box>
      <Box marginLeft={3}>
        {exitState.pending ? (
          <Text dimColor>再次按 {exitState.keyName} 退出</Text>
        ) : (
          <Text dimColor>Enter 提交 · Esc 取消</Text>
        )}
      </Box>
    </>
  );
}
