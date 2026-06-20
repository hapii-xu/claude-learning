/**
 * WorkspaceKeyInput —— 用于输入 workspace API key 的 Ink 表单组件。
 *
 * 安全特性：
 * - 输入会被遮蔽：显示为 sk-ant-api03-****...****
 * - 在 key 拥有正确前缀且达到最小长度之前，回车被禁用
 * - 前缀校验在用户输入时即时展示 —— 无需提交
 * - 原始 key 值永不出现在渲染输出中
 *
 * UX：
 * - 按 Enter 保存（用校验过的 key 调用 onSave）
 * - 按 Esc 取消（调用 onCancel）
 */

import * as React from 'react';
import { Box, Text, useInput } from '@anthropic/ink';
import { saveWorkspaceKey } from '../../services/auth/saveWorkspaceKey.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const PREFIX = 'sk-ant-api03-';
const MIN_KEY_LENGTH = 20;
const MAX_KEY_LENGTH = 256;

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * 返回当前输入的遮蔽显示字符串。
 * 永不暴露前缀之外的原始 key 字符。
 *
 * 示例：
 *   ''                        → ''
 *   'sk-ant-api03-'           → 'sk-ant-api03-'
 *   'sk-ant-api03-ABCDE...'   → 'sk-ant-api03-****...****'
 */
function maskKeyInput(value: string): string {
  if (value.length === 0) return '';
  if (!value.startsWith(PREFIX)) {
    // 仅显示前 4 个字符
    return value.slice(0, 4) + (value.length > 4 ? '...' : '');
  }
  const suffix = value.slice(PREFIX.length);
  if (suffix.length === 0) return PREFIX;
  // 显示 suffix 的最后 4 个字符（已遮蔽）；其余隐藏
  const stars = '****';
  return `${PREFIX}${stars}...${suffix.slice(-Math.min(4, suffix.length)).replace(/./g, '*')}`;
}

/**
 * 校验当前输入值。
 * 返回行内错误字符串，校验通过时返回 null。
 */
function validateKey(value: string): string | null {
  if (value.length === 0) return null; // 尚无输入 —— 不显示错误
  if (!value.startsWith(PREFIX)) {
    return `Key must start with "${PREFIX}"`;
  }
  if (value.length < MIN_KEY_LENGTH) {
    return `Key too short (${value.length}/${MIN_KEY_LENGTH} chars minimum)`;
  }
  if (value.length > MAX_KEY_LENGTH) {
    return `Key too long (${value.length}/${MAX_KEY_LENGTH} chars maximum)`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface WorkspaceKeyInputProps {
  /** 在用户按 Enter 后用校验通过的 key 调用 */
  onSave: (key: string) => void;
  /** 用户按 Esc 时调用 */
  onCancel: () => void;
  /** 若为 true，表示保存操作正在进行中 */
  saving?: boolean;
  /** 来自保存操作本身的错误（fs 写入错误等） */
  saveError?: string | null;
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export function WorkspaceKeyInput({
  onSave,
  onCancel,
  saving = false,
  saveError = null,
}: WorkspaceKeyInputProps): React.ReactNode {
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const inlineError = validateKey(value);
  const canSubmit = !saving && value.length >= MIN_KEY_LENGTH && inlineError === null;

  useInput(
    (input: string, key: { escape: boolean; return: boolean; backspace: boolean; delete: boolean }) => {
      if (key.escape) {
        onCancel();
        return;
      }

      if (key.return) {
        if (!canSubmit) return;
        // 清除之前的错误并交给父组件处理
        setError(null);
        onSave(value);
        return;
      }

      if (key.backspace || key.delete) {
        setValue(prev => prev.slice(0, -1));
        return;
      }

      // 追加可打印字符（忽略控制字符）
      if (input && input.length > 0) {
        const char = input;
        // 只接受可打印 ASCII（32–126）—— 避免粘贴转义序列
        if (char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126) {
          setValue(prev => {
            const next = prev + char;
            // 静默限制为 MAX_KEY_LENGTH —— 若已超出则用户会看到错误
            return next.length <= MAX_KEY_LENGTH ? next : prev;
          });
        }
      }
    },
    { isActive: !saving },
  );

  const masked = maskKeyInput(value);
  const displayError = error ?? saveError ?? inlineError;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box marginBottom={0}>
        <Text bold>Enter workspace API key (sk-ant-api03-*):</Text>
      </Box>

      <Box marginTop={0} marginBottom={0}>
        <Text dimColor>{'  Obtain from: https://console.anthropic.com/settings/keys'}</Text>
      </Box>

      <Box marginTop={1} marginBottom={0}>
        <Text>{'  > '}</Text>
        {value.length > 0 ? <Text>{masked}</Text> : <Text dimColor>{'[paste key here]'}</Text>}
      </Box>

      {displayError !== null && (
        <Box marginTop={0}>
          <Text color="warning">
            {'  ✗ '}
            {displayError}
          </Text>
        </Box>
      )}

      {saving && (
        <Box marginTop={0}>
          <Text dimColor>{'  Saving...'}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {canSubmit
            ? 'Press Enter to save · Esc to cancel'
            : 'Esc to cancel' + (value.length === 0 ? ' · start typing your key' : '')}
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// 带异步保存逻辑的 Container
// ---------------------------------------------------------------------------

export interface WorkspaceKeyInputContainerProps {
  /** key 成功保存后调用 */
  onSaved: () => void;
  /** 用户取消时调用 */
  onCancel: () => void;
}

export function WorkspaceKeyInputContainer({ onSaved, onCancel }: WorkspaceKeyInputContainerProps): React.ReactNode {
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const handleSave = React.useCallback(
    async (key: string) => {
      setSaving(true);
      setSaveError(null);
      try {
        await saveWorkspaceKey(key);
        onSaved();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to save key — unknown error';
        setSaveError(msg);
        setSaving(false);
      }
    },
    [onSaved],
  );

  return (
    <WorkspaceKeyInput
      onSave={key => {
        void handleSave(key);
      }}
      onCancel={onCancel}
      saving={saving}
      saveError={saveError}
    />
  );
}
