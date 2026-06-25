import { type ReactNode } from 'react';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Text } from '@anthropic/ink';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { Byline, KeyboardShortcutHint } from '@anthropic/ink';

type Props = {
  instructions?: ReactNode;
};

export function WizardNavigationFooter({
  instructions = (
    <Byline>
      <KeyboardShortcutHint shortcut="↑↓" action="导航" />
      <KeyboardShortcutHint shortcut="Enter" action="选择" />
      <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="返回" />
    </Byline>
  ),
}: Props): ReactNode {
  const exitState = useExitOnCtrlCDWithKeybindings();

  return (
    <Box marginLeft={3} marginTop={1}>
      <Text dimColor>{exitState.pending ? `再按一次 ${exitState.keyName} 退出` : instructions}</Text>
    </Box>
  );
}
