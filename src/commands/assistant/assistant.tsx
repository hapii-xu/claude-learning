import * as React from 'react';
import { useState } from 'react';
import { resolve } from 'path';
import { Box, Text } from '@anthropic/ink';
import { Dialog } from '../../components/design-system/Dialog.js';
import { ListItem } from '../../components/design-system/ListItem.js';
import { useRegisterOverlay } from '../../context/overlayContext.js';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import { findGitRoot } from '../../utils/git.js';
import { buildCliLaunch, spawnCli } from '../../utils/cliLaunch.js';
import { getKairosActive, setKairosActive } from '../../bootstrap/state.js';
import type { LocalJSXCommandContext } from '../../commands.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import type { AppState } from '../../state/AppState.js';

/**
 * 计算 assistant daemon 安装的默认目录。
 * 优先使用 cwd 的 git 根目录；否则回退到 cwd 本身。
 */
export async function computeDefaultInstallDir(): Promise<string> {
  const cwd = process.cwd();
  const gitRoot = findGitRoot(cwd);
  return gitRoot || resolve(cwd);
}

interface WizardProps {
  defaultDir: string;
  onInstalled: (dir: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}

/**
 * assistant 模式的安装向导。当 `claude assistant` 找不到任何 CCR 会话时显示。
 * 引导用户启动一个 daemon，由它注册 bridge → CCR 云端会话。
 *
 * 安装完成后，main.tsx 会提示用户几秒后再次运行 `claude assistant`
 * （daemon 需要一点时间来注册 bridge 会话）。
 */
export function NewInstallWizard({ defaultDir, onInstalled, onCancel, onError }: WizardProps): React.ReactNode {
  useRegisterOverlay('assistant-install-wizard');
  const [focusIndex, setFocusIndex] = useState(0);
  const [starting, setStarting] = useState(false);

  useKeybindings(
    {
      'select:next': () => setFocusIndex(i => (i + 1) % 2),
      'select:previous': () => setFocusIndex(i => (i - 1 + 2) % 2),
      'select:accept': () => {
        if (focusIndex === 0) {
          startDaemon();
        } else {
          onCancel();
        }
      },
    },
    { context: 'Select' },
  );

  function startDaemon(): void {
    if (starting) return;
    setStarting(true);

    const dir = defaultDir || resolve('.');

    try {
      const launch = buildCliLaunch(['daemon', 'start', `--dir=${dir}`]);

      const child = spawnCli(launch, {
        cwd: dir,
        stdio: 'ignore',
        detached: true,
      });

      child.unref();

      child.on('error', err => {
        onError(`Failed to start daemon: ${err.message}`);
      });

      // 给 daemon 一点初始化时间，然后上报成功。
      // daemon 还需要几秒来注册 bridge 并创建 CCR 会话 ——
      // main.tsx 会提示用户重新连接。
      setTimeout(() => {
        onInstalled(dir);
      }, 1500);
    } catch (err) {
      onError(`Failed to start daemon: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (starting) {
    return (
      <Dialog title="Assistant Setup" onCancel={onCancel} hideInputGuide>
        <Text>Starting daemon in {defaultDir}...</Text>
      </Dialog>
    );
  }

  return (
    <Dialog title="Assistant Setup" onCancel={onCancel} hideInputGuide>
      <Box flexDirection="column" gap={1}>
        <Text>No active assistant sessions found.</Text>
        <Text>
          Start a daemon in <Text bold>{defaultDir || '.'}</Text> to create a cloud session?
        </Text>
        <Box flexDirection="column">
          <ListItem isFocused={focusIndex === 0}>
            <Text>Start assistant daemon</Text>
          </ListItem>
          <ListItem isFocused={focusIndex === 1}>
            <Text>Cancel</Text>
          </ListItem>
        </Box>
        <Text dimColor>Enter to select · Esc to cancel</Text>
      </Box>
    </Dialog>
  );
}

/**
 * /assistant 命令实现。
 *
 * 首次调用会激活 KAIROS（设置 kairosActive，启用 brief 与 proactive 工具）。
 * 后续调用切换 assistant 面板的可见性。
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  _args: string,
): Promise<React.ReactNode> {
  const { setAppState, getAppState } = context;

  // 首次调用：激活 KAIROS
  if (!getKairosActive()) {
    setKairosActive(true);
    setAppState(
      (prev: AppState) =>
        ({
          ...prev,
          kairosEnabled: true,
          assistantPanelVisible: true,
        }) as AppState,
    );
    onDone('KAIROS assistant mode activated.', { display: 'system' });
    return null;
  }

  // 后续调用：切换面板可见性
  const current = getAppState();
  const isVisible = (current as Record<string, unknown>).assistantPanelVisible;

  if (isVisible) {
    setAppState(
      (prev: AppState) =>
        ({
          ...prev,
          assistantPanelVisible: false,
        }) as AppState,
    );
    onDone('Assistant panel hidden.', { display: 'system' });
  } else {
    setAppState(
      (prev: AppState) =>
        ({
          ...prev,
          assistantPanelVisible: true,
        }) as AppState,
    );
    onDone('Assistant panel opened.', { display: 'system' });
  }

  return null;
}
