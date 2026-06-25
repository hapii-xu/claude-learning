import React from 'react';
import { Box, color, Link, Text, useTheme, useTabHeaderFocus } from '@anthropic/ink';
import type { CommandResultDisplay } from '../../types/command.js';
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js';
import { Select } from '../CustomSelect/select.js';

type Props = {
  onComplete: (result?: string, options?: { display?: CommandResultDisplay }) => void;
};

type OverrideMode = 'open' | 'closed';

export function SandboxOverridesTab({ onComplete }: Props): React.ReactNode {
  const isEnabled = SandboxManager.isSandboxingEnabled();
  const isLocked = SandboxManager.areSandboxSettingsLockedByPolicy();
  const currentAllowUnsandboxed = SandboxManager.areUnsandboxedCommandsAllowed();

  if (!isEnabled) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color="subtle">Sandbox 未启用。启用 sandbox 以配置 override 设置。</Text>
      </Box>
    );
  }

  if (isLocked) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color="subtle">Override 设置由更高优先级的配置管理，无法在本地修改。</Text>
        <Box marginTop={1}>
          <Text dimColor>当前设置：{currentAllowUnsandboxed ? '允许 unsandboxed fallback' : '严格 sandbox 模式'}</Text>
        </Box>
      </Box>
    );
  }

  return <OverridesSelect onComplete={onComplete} currentMode={currentAllowUnsandboxed ? 'open' : 'closed'} />;
}

// 拆分以便 useTabHeaderFocus() 仅在 Select 渲染时运行。在上面提前 return
// 之前调用它会注册一个下方向键 opt-in，即使我们返回的是静态文本 —— 按下 ↓
// 会让标题失焦且无法返回。
function OverridesSelect({ onComplete, currentMode }: Props & { currentMode: OverrideMode }): React.ReactNode {
  const [theme] = useTheme();
  const { headerFocused, focusHeader } = useTabHeaderFocus();
  const currentIndicator = color('success', theme)(`(当前)`);

  const options = [
    {
      label: currentMode === 'open' ? `允许 unsandboxed fallback ${currentIndicator}` : '允许 unsandboxed fallback',
      value: 'open',
    },
    {
      label: currentMode === 'closed' ? `严格 sandbox 模式 ${currentIndicator}` : '严格 sandbox 模式',
      value: 'closed',
    },
  ];

  async function handleSelect(value: string) {
    const mode = value as OverrideMode;

    await SandboxManager.setSandboxSettings({
      allowUnsandboxedCommands: mode === 'open',
    });

    const message =
      mode === 'open'
        ? '✓ 已允许 unsandboxed fallback - 命令在需要时可运行在 sandbox 之外'
        : '✓ 严格 sandbox 模式 - 所有命令必须运行在 sandbox 中，或通过 `excludedCommands` 选项排除';

    onComplete(message);
  }

  return (
    <Box flexDirection="column" paddingY={1}>
      <Box marginBottom={1}>
        <Text bold>配置 Overrides：</Text>
      </Box>
      <Select
        options={options}
        onChange={handleSelect}
        onCancel={() => onComplete(undefined, { display: 'skip' })}
        onUpFromFirstItem={focusHeader}
        isDisabled={headerFocused}
      />
      <Box flexDirection="column" marginTop={1} gap={1}>
        <Text dimColor>
          <Text bold dimColor>
            允许 unsandboxed fallback：
          </Text>{' '}
          当命令因 sandbox 限制失败时，Claude 可以使用 dangerouslyDisableSandbox 重试，运行在 sandbox 之外
          （回退到默认权限）。
        </Text>
        <Text dimColor>
          <Text bold dimColor>
            严格 sandbox 模式：
          </Text>{' '}
          模型调用的所有 bash 命令必须运行在 sandbox 中，除非显式列在 excludedCommands 中。
        </Text>
        <Text dimColor>
          了解更多：{' '}
          <Link url="https://code.claude.com/docs/en/sandboxing#configure-sandboxing">
            code.claude.com/docs/en/sandboxing#configure-sandboxing
          </Link>
        </Text>
      </Box>
    </Box>
  );
}
