import { feature } from 'bun:bundle';
import * as React from 'react';
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box, Text, usePreviewTheme, useTheme, useThemeSetting } from '@anthropic/ink';
import { useRegisterKeybindingContext } from '../keybindings/KeybindingContext.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js';
import { useAppState, useSetAppState } from '../state/AppState.js';
import { gracefulShutdown } from '../utils/gracefulShutdown.js';
import { updateSettingsForSource } from '../utils/settings/settings.js';
import type { ThemeSetting } from '../utils/theme.js';
import { Select } from './CustomSelect/index.js';
import { Byline, KeyboardShortcutHint } from '@anthropic/ink';
import { getColorModuleUnavailableReason, getSyntaxTheme } from './StructuredDiff/colorDiff.js';
import { StructuredDiff } from './StructuredDiff.js';

export type ThemePickerProps = {
  onThemeSelect: (setting: ThemeSetting) => void;
  showIntroText?: boolean;
  helpText?: string;
  showHelpTextBelow?: boolean;
  hideEscToCancel?: boolean;
  /** 在已经自带退出处理的环境中（例如 onboarding）运行时，跳过退出处理 */
  skipExitHandling?: boolean;
  /** 当用户取消（按下 Escape）时调用。如果 skipExitHandling 为 true 且提供了此回调，则会调用它而不是仅保存预览。 */
  onCancel?: () => void;
};

export function ThemePicker({
  onThemeSelect,
  showIntroText = false,
  helpText = '',
  showHelpTextBelow = false,
  hideEscToCancel = false,
  skipExitHandling = false,
  onCancel: onCancelProp,
}: ThemePickerProps): React.ReactNode {
  const [theme] = useTheme();
  const themeSetting = useThemeSetting();
  const { columns } = useTerminalSize();
  const colorModuleUnavailableReason = getColorModuleUnavailableReason();
  const syntaxTheme = colorModuleUnavailableReason === null ? getSyntaxTheme(theme) : null;
  const { setPreviewTheme, savePreview, cancelPreview } = usePreviewTheme();
  const syntaxHighlightingDisabled = useAppState(s => s.settings.syntaxHighlightingDisabled) ?? false;
  const setAppState = useSetAppState();

  // 注册 ThemePicker context，使其 keybindings 优先级高于 Global
  useRegisterKeybindingContext('ThemePicker');

  const syntaxToggleShortcut = useShortcutDisplay('theme:toggleSyntaxHighlighting', 'ThemePicker', 'ctrl+t');

  useKeybinding(
    'theme:toggleSyntaxHighlighting',
    () => {
      if (colorModuleUnavailableReason === null) {
        const newValue = !syntaxHighlightingDisabled;
        updateSettingsForSource('userSettings', {
          syntaxHighlightingDisabled: newValue,
        });
        setAppState(prev => ({
          ...prev,
          settings: { ...prev.settings, syntaxHighlightingDisabled: newValue },
        }));
      }
    },
    { context: 'ThemePicker' },
  );
  // 始终调用该 hook 以遵守 React 规则，但条件性地赋值退出处理器
  const exitState = useExitOnCtrlCDWithKeybindings(skipExitHandling ? () => {} : undefined);

  const themeOptions: { label: string; value: ThemeSetting }[] = [
    ...(feature('AUTO_THEME') ? [{ label: '自动（跟随终端）', value: 'auto' as const }] : []),
    { label: '深色模式', value: 'dark' },
    { label: '浅色模式', value: 'light' },
    {
      label: '深色模式（色盲友好）',
      value: 'dark-daltonized',
    },
    {
      label: '浅色模式（色盲友好）',
      value: 'light-daltonized',
    },
    {
      label: '深色模式（仅 ANSI 颜色）',
      value: 'dark-ansi',
    },
    {
      label: '浅色模式（仅 ANSI 颜色）',
      value: 'light-ansi',
    },
  ];

  const content = (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column" gap={1}>
        {showIntroText ? (
          <Text>让我们开始吧。</Text>
        ) : (
          <Text bold color="permission">
            主题
          </Text>
        )}
        <Box flexDirection="column">
          <Text bold>选择在你的终端中看起来最舒服的文本样式</Text>
          {helpText && !showHelpTextBelow && <Text dimColor>{helpText}</Text>}
        </Box>
        <Select
          options={themeOptions}
          onFocus={setting => {
            setPreviewTheme(setting as ThemeSetting);
          }}
          onChange={(setting: string) => {
            savePreview();
            onThemeSelect(setting as ThemeSetting);
          }}
          onCancel={
            skipExitHandling
              ? () => {
                  cancelPreview();
                  onCancelProp?.();
                }
              : async () => {
                  cancelPreview();
                  await gracefulShutdown(0);
                }
          }
          visibleOptionCount={themeOptions.length}
          defaultValue={themeSetting}
          defaultFocusValue={themeSetting}
        />
      </Box>
      <Box flexDirection="column" width="100%">
        <Box
          flexDirection="column"
          borderTop
          borderBottom
          borderLeft={false}
          borderRight={false}
          borderStyle="dashed"
          borderColor="subtle"
        >
          <StructuredDiff
            patch={{
              oldStart: 1,
              newStart: 1,
              oldLines: 3,
              newLines: 3,
              lines: [
                ' function greet() {',
                '-  console.log("Hello, World!");',
                '+  console.log("Hello, Claude!");',
                ' }',
              ],
            }}
            dim={false}
            filePath="demo.js"
            firstLine={null}
            width={columns}
          />
        </Box>
        <Text dimColor>
          {' '}
          {colorModuleUnavailableReason === 'env'
            ? `语法高亮已禁用（通过 CLAUDE_CODE_SYNTAX_HIGHLIGHT=${process.env.CLAUDE_CODE_SYNTAX_HIGHLIGHT}）`
            : syntaxHighlightingDisabled
              ? `语法高亮已禁用（${syntaxToggleShortcut} 启用）`
              : syntaxTheme
                ? `语法主题：${syntaxTheme.theme}${syntaxTheme.source ? `（来自 ${syntaxTheme.source}）` : ''}（${syntaxToggleShortcut} 禁用）`
                : `语法高亮已启用（${syntaxToggleShortcut} 禁用）`}
        </Text>
      </Box>
    </Box>
  );

  // 仅在不处于 onboarding 时才包裹一层 Box
  if (!showIntroText) {
    return (
      <>
        <Box flexDirection="column">{content}</Box>
        <Box marginTop={1}>
          {showHelpTextBelow && helpText && (
            <Box marginLeft={3}>
              <Text dimColor>{helpText}</Text>
            </Box>
          )}
          {!hideEscToCancel && (
            <Box>
              <Text dimColor italic>
                {exitState.pending ? (
                  <>再按一次 {exitState.keyName} 退出</>
                ) : (
                  <Byline>
                    <KeyboardShortcutHint shortcut="Enter" action="select" />
                    <KeyboardShortcutHint shortcut="Esc" action="cancel" />
                  </Byline>
                )}
              </Text>
            </Box>
          )}
        </Box>
      </>
    );
  }

  return content;
}
