import React from 'react';
import { envDynamic } from 'src/utils/envDynamic.js';
import { Box, Text } from '@anthropic/ink';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js';
import { env } from '../utils/env.js';
import {
  getTerminalIdeType,
  type IDEExtensionInstallationStatus,
  isJetBrainsIde,
  toIDEDisplayName,
} from '../utils/ide.js';
import { Dialog } from '@anthropic/ink';

interface Props {
  onDone: () => void;
  installationStatus: IDEExtensionInstallationStatus | null;
}

export function IdeOnboardingDialog({ onDone, installationStatus }: Props): React.ReactNode {
  markDialogAsShown();

  // 处理 Enter/Escape 关闭
  useKeybindings(
    {
      'confirm:yes': onDone,
      'confirm:no': onDone,
    },
    { context: 'Confirmation' },
  );

  const ideType = installationStatus?.ideType ?? getTerminalIdeType();
  const isJetBrains = isJetBrainsIde(ideType);

  const ideName = toIDEDisplayName(ideType);
  const installedVersion = installationStatus?.installedVersion;
  const pluginOrExtension = isJetBrains ? 'plugin' : 'extension';
  const mentionShortcut = env.platform === 'darwin' ? 'Cmd+Option+K' : 'Ctrl+Alt+K';

  return (
    <>
      <Dialog
        title={
          <>
            <Text color="claude">✻ </Text>
            <Text>欢迎使用 Claude Code for {ideName}</Text>
          </>
        }
        subtitle={installedVersion ? `已安装 ${pluginOrExtension} v${installedVersion}` : undefined}
        color="ide"
        onCancel={onDone}
        hideInputGuide
      >
        <Box flexDirection="column" gap={1}>
          <Text>
            • Claude 能感知 <Text color="suggestion">⧉ 打开的文件</Text> 和 <Text color="suggestion">⧉ 选中的行</Text>
          </Text>
          <Text>
            • 在您的 IDE 中舒适地审阅 Claude Code 的改动 <Text color="diffAddedWord">+11</Text>{' '}
            <Text color="diffRemovedWord">-22</Text>
          </Text>
          <Text>
            • Cmd+Esc<Text dimColor> 快速启动</Text>
          </Text>
          <Text>
            • {mentionShortcut}
            <Text dimColor> 在输入中引用文件或行</Text>
          </Text>
        </Box>
      </Dialog>
      <Box paddingX={1}>
        <Text dimColor italic>
          按 Enter 继续
        </Text>
      </Box>
    </>
  );
}

export function hasIdeOnboardingDialogBeenShown(): boolean {
  const config = getGlobalConfig();
  const terminal = envDynamic.terminal || 'unknown';
  return config.hasIdeOnboardingBeenShown?.[terminal] === true;
}

function markDialogAsShown(): void {
  if (hasIdeOnboardingDialogBeenShown()) {
    return;
  }
  const terminal = envDynamic.terminal || 'unknown';
  saveGlobalConfig(current => ({
    ...current,
    hasIdeOnboardingBeenShown: {
      ...current.hasIdeOnboardingBeenShown,
      [terminal]: true,
    },
  }));
}
