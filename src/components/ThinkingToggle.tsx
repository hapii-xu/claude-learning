import * as React from 'react';
import { useState } from 'react';
import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Text } from '@anthropic/ink';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Select } from './CustomSelect/index.js';
import { Byline, KeyboardShortcutHint, Pane } from '@anthropic/ink';

export type Props = {
  currentValue: boolean;
  onSelect: (enabled: boolean) => void;
  onCancel?: () => void;
  isMidConversation?: boolean;
};

export function ThinkingToggle({ currentValue, onSelect, onCancel, isMidConversation }: Props): React.ReactNode {
  const exitState = useExitOnCtrlCDWithKeybindings();
  const [confirmationPending, setConfirmationPending] = useState<boolean | null>(null);

  const options = [
    {
      value: 'true',
      label: '已启用',
      description: 'Claude 在回复前会先思考',
    },
    {
      value: 'false',
      label: '已禁用',
      description: 'Claude 不使用扩展思考直接回复',
    },
  ];

  // 为 ESC 使用可配置的 keybinding，用于取消/返回
  useKeybinding(
    'confirm:no',
    () => {
      if (confirmationPending !== null) {
        setConfirmationPending(null);
      } else {
        onCancel?.();
      }
    },
    { context: 'Confirmation' },
  );

  // 为确认模式下的 Enter 使用可配置的 keybinding
  useKeybinding(
    'confirm:yes',
    () => {
      if (confirmationPending !== null) {
        onSelect(confirmationPending);
      }
    },
    { context: 'Confirmation', isActive: confirmationPending !== null },
  );

  function handleSelectChange(value: string): void {
    const selected = value === 'true';
    if (isMidConversation && selected !== currentValue) {
      setConfirmationPending(selected);
    } else {
      onSelect(selected);
    }
  }

  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text color="remember" bold>
            切换思考模式
          </Text>
          <Text dimColor>为此会话启用或禁用思考。</Text>
        </Box>

        {confirmationPending !== null ? (
          <Box flexDirection="column" marginBottom={1} gap={1}>
            <Text color="warning">
              在对话过程中切换思考模式会增加延迟，并可能降低质量。为获得最佳效果， 请在会话开始时设置。
            </Text>
            <Text color="warning">是否要继续？</Text>
          </Box>
        ) : (
          <Box flexDirection="column" marginBottom={1}>
            <Select
              defaultValue={currentValue ? 'true' : 'false'}
              defaultFocusValue={currentValue ? 'true' : 'false'}
              options={options}
              onChange={handleSelectChange}
              onCancel={onCancel ?? (() => {})}
              visibleOptionCount={2}
            />
          </Box>
        )}
      </Box>
      <Text dimColor italic>
        {exitState.pending ? (
          <>再按一次 {exitState.keyName} 退出</>
        ) : confirmationPending !== null ? (
          <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="confirm" />
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />
          </Byline>
        ) : (
          <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="confirm" />
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="exit" />
          </Byline>
        )}
      </Text>
    </Pane>
  );
}
