import * as React from 'react';
import type { KeybindingAction, KeybindingContextName } from '../keybindings/types.js';
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js';
import { KeyboardShortcutHint } from '@anthropic/ink';

type Props = {
  /** keybinding 动作（例如 'app:toggleTranscript'） */
  action: KeybindingAction;
  /** keybinding 上下文（例如 'Global'） */
  context: KeybindingContextName;
  /** 未配置 keybinding 时的默认快捷键 */
  fallback: string;
  /** 动作描述文本（例如 'expand'） */
  description: string;
  /** 是否用括号包裹 */
  parens?: boolean;
  /** 是否加粗显示 */
  bold?: boolean;
};

/**
 * 显示用户配置快捷键的 KeyboardShortcutHint。
 * 当 keybinding 上下文不可用时回退到默认值。
 *
 * @example
 * <ConfigurableShortcutHint
 *   action="app:toggleTranscript"
 *   context="Global"
 *   fallback="ctrl+o"
 *   description="expand"
 * />
 */
export function ConfigurableShortcutHint({
  action,
  context,
  fallback,
  description,
  parens,
  bold,
}: Props): React.ReactNode {
  const shortcut = useShortcutDisplay(action, context, fallback);
  return <KeyboardShortcutHint shortcut={shortcut} action={description} parens={parens} bold={bold} />;
}
