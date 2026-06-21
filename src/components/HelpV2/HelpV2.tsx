import * as React from 'react';
import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js';
import { useShortcutDisplay } from 'src/keybindings/useShortcutDisplay.js';
import {
  builtInCommandNames,
  type Command,
  type CommandResultDisplay,
  INTERNAL_ONLY_COMMANDS,
} from '../../commands.js';
import { useIsInsideModal } from '../../context/modalContext.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Link, Text, Tab, Tabs, Pane } from '@anthropic/ink';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { Commands } from './Commands.js';
import { General } from './General.js';

type Props = {
  onClose: (result?: string, options?: { display?: CommandResultDisplay }) => void;
  commands: Command[];
};

export function HelpV2({ onClose, commands }: Props): React.ReactNode {
  const { rows, columns } = useTerminalSize();
  const maxHeight = Math.floor(rows / 2);
  // 在 modal 插槽内，FullscreenLayout 已经限制高度，而 Pane/Tabs
  // 使用 flexShrink=0（见 #23592）—— 我们自己的 height= 约束会裁剪
  // 页脚，因为 Tabs 不会收缩以适配。让 modal 插槽处理尺寸。
  const insideModal = useIsInsideModal();

  const close = () => onClose('Help dialog dismissed', { display: 'system' });
  useKeybinding('help:dismiss', close, { context: 'Help' });
  const exitState = useExitOnCtrlCDWithKeybindings(close);
  const dismissShortcut = useShortcutDisplay('help:dismiss', 'Help', 'esc');

  const builtinNames = builtInCommandNames();
  let builtinCommands = commands.filter(cmd => builtinNames.has(cmd.name) && !cmd.isHidden);
  let antOnlyCommands: Command[] = [];

  // 我们必须在 `if` 中执行此操作以帮助 treeshaking
  if (process.env.USER_TYPE === 'ant') {
    const internalOnlyNames = new Set(INTERNAL_ONLY_COMMANDS.map(_ => _.name));
    builtinCommands = builtinCommands.filter(cmd => !internalOnlyNames.has(cmd.name));
    antOnlyCommands = commands.filter(cmd => internalOnlyNames.has(cmd.name) && !cmd.isHidden);
  }

  const customCommands = commands.filter(cmd => !builtinNames.has(cmd.name) && !cmd.isHidden);

  const tabs = [
    <Tab key="general" title="general">
      <General />
    </Tab>,
  ];

  tabs.push(
    <Tab key="commands" title="commands">
      <Commands
        commands={builtinCommands}
        maxHeight={maxHeight}
        columns={columns}
        title="Browse default commands:"
        onCancel={close}
      />
    </Tab>,
  );

  tabs.push(
    <Tab key="custom" title="custom-commands">
      <Commands
        commands={customCommands}
        maxHeight={maxHeight}
        columns={columns}
        title="Browse custom commands:"
        emptyMessage="No custom commands found"
        onCancel={close}
      />
    </Tab>,
  );

  if (process.env.USER_TYPE === 'ant' && antOnlyCommands.length > 0) {
    tabs.push(
      <Tab key="ant-only" title="[ant-only]">
        <Commands
          commands={antOnlyCommands}
          maxHeight={maxHeight}
          columns={columns}
          title="Browse ant-only commands:"
          onCancel={close}
        />
      </Tab>,
    );
  }

  return (
    <Box flexDirection="column" height={insideModal ? undefined : maxHeight}>
      <Pane color="professionalBlue">
        <Tabs
          title={process.env.USER_TYPE === 'ant' ? '/help' : `Claude Code v${MACRO.VERSION}`}
          color="professionalBlue"
          defaultTab="general"
        >
          {tabs}
        </Tabs>
        <Box marginTop={1}>
          <Text>
            For more help: <Link url="https://code.claude.com/docs/en/overview" />
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            {exitState.pending ? (
              <>Press {exitState.keyName} again to exit</>
            ) : (
              <Text italic>{dismissShortcut} to cancel</Text>
            )}
          </Text>
        </Box>
      </Pane>
    </Box>
  );
}
