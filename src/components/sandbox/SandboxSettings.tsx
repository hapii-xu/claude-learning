import React from 'react';
import { Box, color, Link, Text, useTheme, Pane, Tab, Tabs, useTabHeaderFocus } from '@anthropic/ink';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import type { CommandResultDisplay } from '../../types/command.js';
import type { SandboxDependencyCheck } from '../../utils/sandbox/sandbox-adapter.js';
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js';
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js';
import { Select } from '../CustomSelect/select.js';
import { SandboxConfigTab } from './SandboxConfigTab.js';
import { SandboxDependenciesTab } from './SandboxDependenciesTab.js';
import { SandboxOverridesTab } from './SandboxOverridesTab.js';

type Props = {
  onComplete: (result?: string, options?: { display?: CommandResultDisplay }) => void;
  depCheck: SandboxDependencyCheck;
};

type SandboxMode = 'auto-allow' | 'regular' | 'disabled';

export function SandboxSettings({ onComplete, depCheck }: Props): React.ReactNode {
  const [theme] = useTheme();
  const currentEnabled = SandboxManager.isSandboxingEnabled();
  const currentAutoAllow = SandboxManager.isAutoAllowBashIfSandboxedEnabled();
  const hasWarnings = depCheck.warnings.length > 0;
  const settings = getSettings_DEPRECATED();
  const allowAllUnixSockets = settings.sandbox?.network?.allowAllUnixSockets;
  // 当 seccomp 缺失且用户未允许所有 unix sockets 时显示警告
  const showSocketWarning = hasWarnings && !allowAllUnixSockets;

  // 确定当前模式
  const getCurrentMode = (): SandboxMode => {
    if (!currentEnabled) return 'disabled';
    if (currentAutoAllow) return 'auto-allow';
    return 'regular';
  };

  const currentMode = getCurrentMode();
  const currentIndicator = color('success', theme)(`(当前)`);

  const options = [
    {
      label:
        currentMode === 'auto-allow' ? `Sandbox BashTool，自动允许 ${currentIndicator}` : 'Sandbox BashTool，自动允许',
      value: 'auto-allow',
    },
    {
      label:
        currentMode === 'regular' ? `Sandbox BashTool，常规权限 ${currentIndicator}` : 'Sandbox BashTool，常规权限',
      value: 'regular',
    },
    {
      label: currentMode === 'disabled' ? `无 Sandbox ${currentIndicator}` : '无 Sandbox',
      value: 'disabled',
    },
  ];

  async function handleSelect(value: string) {
    const mode = value as SandboxMode;

    switch (mode) {
      case 'auto-allow':
        await SandboxManager.setSandboxSettings({
          enabled: true,
          autoAllowBashIfSandboxed: true,
        });
        onComplete('✓ Sandbox 已启用，bash 命令自动允许');
        break;
      case 'regular':
        await SandboxManager.setSandboxSettings({
          enabled: true,
          autoAllowBashIfSandboxed: false,
        });
        onComplete('✓ Sandbox 已启用，使用常规 bash 权限');
        break;
      case 'disabled':
        await SandboxManager.setSandboxSettings({
          enabled: false,
          autoAllowBashIfSandboxed: false,
        });
        onComplete('○ Sandbox 已禁用');
        break;
    }
  }

  useKeybindings(
    {
      'confirm:no': () => onComplete(undefined, { display: 'skip' }),
    },
    { context: 'Settings' },
  );

  const modeTab = (
    <Tab key="mode" title="模式">
      <SandboxModeTab
        showSocketWarning={showSocketWarning}
        options={options}
        onSelect={handleSelect}
        onComplete={onComplete}
      />
    </Tab>
  );

  const overridesTab = (
    <Tab key="overrides" title="Overrides">
      <SandboxOverridesTab onComplete={onComplete} />
    </Tab>
  );

  const configTab = (
    <Tab key="config" title="配置">
      <SandboxConfigTab />
    </Tab>
  );

  const hasErrors = depCheck.errors.length > 0;

  // 如果缺少必需依赖，仅显示依赖标签页
  // 如果仅缺少可选依赖，显示所有标签页
  const tabs = hasErrors
    ? [
        <Tab key="dependencies" title="依赖">
          <SandboxDependenciesTab depCheck={depCheck} />
        </Tab>,
      ]
    : [
        modeTab,
        ...(hasWarnings
          ? [
              <Tab key="dependencies" title="依赖">
                <SandboxDependenciesTab depCheck={depCheck} />
              </Tab>,
            ]
          : []),
        overridesTab,
        configTab,
      ];

  return (
    <Pane color="permission">
      <Tabs title="Sandbox：" color="permission" defaultTab="Mode">
        {tabs}
      </Tabs>
    </Pane>
  );
}

function SandboxModeTab({
  showSocketWarning,
  options,
  onSelect,
  onComplete,
}: {
  showSocketWarning: boolean;
  options: Array<{ label: string; value: string }>;
  onSelect: (value: string) => void;
  onComplete: Props['onComplete'];
}): React.ReactNode {
  const { headerFocused, focusHeader } = useTabHeaderFocus();
  return (
    <Box flexDirection="column" paddingY={1}>
      {showSocketWarning && (
        <Box marginBottom={1}>
          <Text color="warning">无法拦截 unix domain sockets（见"依赖"标签页）</Text>
        </Box>
      )}
      <Box marginBottom={1}>
        <Text bold>配置模式：</Text>
      </Box>
      <Select
        options={options}
        onChange={onSelect}
        onCancel={() => onComplete(undefined, { display: 'skip' })}
        onUpFromFirstItem={focusHeader}
        isDisabled={headerFocused}
      />
      <Box flexDirection="column" marginTop={1} gap={1}>
        <Text dimColor>
          <Text bold dimColor>
            自动允许模式：
          </Text>{' '}
          命令会自动尝试在 sandbox 中运行，尝试在 sandbox
          之外运行的情况会回退到常规权限。显式的允许/拒绝规则始终受尊重。
        </Text>
        <Text dimColor>
          了解更多：<Link url="https://code.claude.com/docs/en/sandboxing">code.claude.com/docs/en/sandboxing</Link>
        </Text>
      </Box>
    </Box>
  );
}
