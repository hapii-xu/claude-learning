import * as React from 'react';
import { Box, Pane, Text, useTheme } from '@anthropic/ink';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import { ThemePicker } from '../../components/ThemePicker.js';
import { getGlobalConfig, saveCurrentProjectConfig, saveGlobalConfig } from '../../utils/config.js';
import type { ThemeSetting } from '../../utils/theme.js';

/**
 * /onboarding [子命令]
 *
 * 面向用户的 slash 命令，用于重新运行首次启动配置流程。官方
 * v2.1.123 二进制文件会广播 `/onboarding` 并发送
 * `tengu_onboarding_step` 遥测事件；此命令提供了一个干净的入口，
 * 方便在初始配置完成后重新运行单个步骤。
 *
 * 子命令：
 *   (无) | full | reset  — 清除 `hasCompletedOnboarding`，使下次
 *                            REPL 启动时重新运行完整流程，然后退出
 *                            并给出指引。
 *   theme                  — 内联渲染主题选择器。
 *   trust                  — 清除工作区信任接受状态，
 *                            并提示用户重启。
 *   model                  — 委托给 /model（无法在调用过程中挂起进入
 *                            另一个命令的 Ink 选择器；改为打印指引）。
 *   mcp                    — 打印 MCP 配置提示（委托给 /mcp）。
 *   status                 — 显示当前 onboarding 状态（主题、
 *                            完成标志、信任、最近版本）。
 */
export type OnboardingSubcommand = 'full' | 'theme' | 'trust' | 'model' | 'mcp' | 'status';

const SUBCOMMANDS: ReadonlySet<OnboardingSubcommand> = new Set(['full', 'theme', 'trust', 'model', 'mcp', 'status']);

function meta(s: string): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return s as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
}

export function parseSubcommand(args: string): {
  sub: OnboardingSubcommand;
  unknownArg?: string;
} {
  const trimmed = args.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'reset') {
    return { sub: 'full' };
  }
  if (SUBCOMMANDS.has(trimmed as OnboardingSubcommand)) {
    return { sub: trimmed as OnboardingSubcommand };
  }
  return { sub: 'full', unknownArg: trimmed };
}

function ThemeSubcommand({ onDone }: { onDone: (msg: string) => void }): React.ReactNode {
  const [, setTheme] = useTheme();
  return (
    <Pane color="permission">
      <ThemePicker
        onThemeSelect={(setting: ThemeSetting) => {
          setTheme(setting);
          logEvent('tengu_onboarding_step', { stepId: meta('theme') });
          onDone(`Theme set to ${setting}.`);
        }}
        onCancel={() => onDone('Theme picker dismissed.')}
        skipExitHandling={true}
      />
    </Pane>
  );
}

function StatusView({
  theme,
  hasCompletedOnboarding,
  lastOnboardingVersion,
}: {
  theme: string;
  hasCompletedOnboarding: boolean;
  lastOnboardingVersion: string;
}): React.ReactNode {
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>Onboarding status</Text>
      <Text>
        - Theme: <Text bold>{theme}</Text>
      </Text>
      <Text>
        - Onboarding completed:{' '}
        <Text bold color={hasCompletedOnboarding ? 'success' : 'warning'}>
          {hasCompletedOnboarding ? 'yes' : 'no'}
        </Text>
      </Text>
      <Text>
        - Last onboarding version: <Text bold>{lastOnboardingVersion}</Text>
      </Text>
      <Text dimColor>
        Run /onboarding (no args) to re-run the full flow, or /onboarding theme | trust | model | mcp for a specific
        step.
      </Text>
    </Box>
  );
}

export const callOnboarding: LocalJSXCommandCall = async (onDone, _context, args) => {
  const { sub, unknownArg } = parseSubcommand(args);
  logEvent('tengu_onboarding_step', { stepId: meta(`slash_${sub}`) });

  if (unknownArg !== undefined) {
    onDone(
      `Unknown /onboarding subcommand: \`${unknownArg}\`.\n` + `Valid: full | theme | trust | model | mcp | status`,
      { display: 'system' },
    );
    return null;
  }

  if (sub === 'theme') {
    return <ThemeSubcommand onDone={msg => onDone(msg)} />;
  }

  if (sub === 'trust') {
    saveCurrentProjectConfig(current => ({
      ...current,
      hasTrustDialogAccepted: false,
    }));
    onDone(
      'Workspace trust cleared for the current project. ' + 'The trust dialog will appear on the next `claude` launch.',
      { display: 'system' },
    );
    return null;
  }

  if (sub === 'model') {
    onDone(
      'Run `/model` to pick the AI model. ' +
        'Onboarding does not own the model picker; this entry exists for ' +
        'discoverability only.',
      { display: 'system' },
    );
    return null;
  }

  if (sub === 'mcp') {
    onDone(
      'MCP server setup:\n' +
        '  - `/mcp` — list configured MCP servers\n' +
        '  - `claude mcp add <name> <command>` — add a server (in your shell)\n' +
        '  - `claude mcp remove <name>` — remove a server\n' +
        'Servers also load from `.mcp.json` in the workspace and from ' +
        '`~/.hclaude.json` globally.',
      { display: 'system' },
    );
    return null;
  }

  if (sub === 'status') {
    const cfg = getGlobalConfig();
    return (
      <StatusView
        theme={cfg.theme ?? '(unset)'}
        hasCompletedOnboarding={cfg.hasCompletedOnboarding === true}
        lastOnboardingVersion={cfg.lastOnboardingVersion ?? '(unset)'}
      />
    );
  }

  // sub === 'full'
  // 清除 `hasCompletedOnboarding` 会让 `showSetupScreens()`（位于
  // src/interactiveHelpers.tsx）在下次启动时渲染完整的 Onboarding 组件。
  // 我们无法在 REPL 运行过程中渲染 <Onboarding />，因为它接管了
  // 终端配置检测、OAuth 流程以及到提示符的最终跳转——在活跃的 REPL
  // 会话中挂载并不安全。
  saveGlobalConfig(current => ({
    ...current,
    hasCompletedOnboarding: false,
  }));
  onDone(
    'Onboarding flag cleared. The full first-run setup ' +
      '(theme, OAuth/API key, security notes, terminal-setup) ' +
      'will run on the next `claude` launch.\n\n' +
      'For individual steps in this session, use:\n' +
      '  /onboarding theme   — re-pick theme inline\n' +
      '  /onboarding trust   — re-confirm workspace trust on next launch\n' +
      '  /onboarding model   — open /model picker\n' +
      '  /onboarding mcp     — show MCP setup hints\n' +
      '  /onboarding status  — show current onboarding state',
    { display: 'system' },
  );
  return null;
};
