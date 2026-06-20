import figures from 'figures';
import React, { useCallback, useState } from 'react';
import { Dialog } from '@anthropic/ink';
// eslint-disable-next-line custom-rules/prefer-use-keybindings —— 配置对话框需要原始文本输入
import { Box, Text, useInput, stringWidth } from '@anthropic/ink';
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import type { PluginOptionSchema, PluginOptionValues } from '../../utils/plugins/pluginOptionsStorage.js';

/**
 * 根据收集到的字符串输入构建 onSave 的负载。
 *
 * 出于安全考虑，敏感字段不会预填到文本缓冲区，因此当用户走到最后一个
 * 字段时，他们经过的每个敏感字段在 collected 中都是 ''。为避免在重新
 * 配置时悄悄清空已保存的密钥：如果某个敏感字段为 '' 且 initialValues
 * 中存在该字段的值，则完全省略该 key。savePluginOptions 只写入它收到
 * 的 key，因此省略 = 保留现有值。
 *
 * 导出用于单元测试。
 */
export function buildFinalValues(
  fields: string[],
  collected: Record<string, string>,
  configSchema: PluginOptionSchema,
  initialValues: PluginOptionValues | undefined,
): PluginOptionValues {
  const finalValues: PluginOptionValues = {};
  for (const fieldKey of fields) {
    const schema = configSchema[fieldKey];
    const value = collected[fieldKey] ?? '';

    if (schema?.sensitive === true && value === '' && initialValues?.[fieldKey] !== undefined) {
      continue;
    }

    if (schema?.type === 'number') {
      // Number('') 返回 0 而不是 NaN —— 省略空白数字输入，
      // 让 validateUserConfig 的必填校验能真正捕获它们。
      if (value.trim() === '') continue;
      const num = Number(value);
      finalValues[fieldKey] = Number.isNaN(num) ? value : num;
    } else if (schema?.type === 'boolean') {
      finalValues[fieldKey] = isEnvTruthy(value);
    } else {
      finalValues[fieldKey] = value;
    }
  }
  return finalValues;
}

type Props = {
  title: string;
  subtitle: string;
  configSchema: PluginOptionSchema;
  /** 重新配置时预填字段。敏感字段不会预填。 */
  initialValues?: PluginOptionValues;
  onSave: (config: PluginOptionValues) => void;
  onCancel: () => void;
};

export function PluginOptionsDialog({
  title,
  subtitle,
  configSchema,
  initialValues,
  onSave,
  onCancel,
}: Props): React.ReactNode {
  const fields = Object.keys(configSchema);

  // 从 initialValues 预填，但跳过敏感字段 —— 我们不想把密钥
  // 再回显到文本缓冲区。
  const initialFor = useCallback(
    (key: string): string => {
      if (configSchema[key]?.sensitive === true) return '';
      const v = initialValues?.[key];
      return v === undefined ? '' : String(v);
    },
    [configSchema, initialValues],
  );

  const [currentFieldIndex, setCurrentFieldIndex] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [currentInput, setCurrentInput] = useState(() => (fields[0] ? initialFor(fields[0]) : ''));

  const currentField = fields[currentFieldIndex];
  const fieldSchema = currentField ? configSchema[currentField] : null;

  // 使用 Settings 上下文，这样 'n' 键不会触发取消（允许在输入中输入 'n'）。
  // Dialog 上设置 isCancelActive={false} 让它自己的 confirm:no 不干扰。
  useKeybinding('confirm:no', onCancel, { context: 'Settings' });

  // Tab 切换到下一个字段
  const handleNextField = useCallback(() => {
    if (currentFieldIndex < fields.length - 1 && currentField) {
      setValues(prev => ({ ...prev, [currentField]: currentInput }));
      setCurrentFieldIndex(prev => prev + 1);
      const nextKey = fields[currentFieldIndex + 1];
      setCurrentInput(nextKey ? initialFor(nextKey) : '');
    }
  }, [currentFieldIndex, fields, currentField, currentInput, initialFor]);

  // Enter 保存当前字段并移动到下一个，若已是最后一个则全部保存
  const handleConfirm = useCallback(() => {
    if (!currentField) return;

    const newValues = { ...values, [currentField]: currentInput };

    if (currentFieldIndex === fields.length - 1) {
      onSave(buildFinalValues(fields, newValues, configSchema, initialValues));
    } else {
      // 移动到下一个字段
      setValues(newValues);
      setCurrentFieldIndex(prev => prev + 1);
      const nextKey = fields[currentFieldIndex + 1];
      setCurrentInput(nextKey ? initialFor(nextKey) : '');
    }
  }, [currentField, values, currentInput, currentFieldIndex, fields, configSchema, onSave, initialFor, initialValues]);

  useKeybindings(
    {
      'confirm:nextField': handleNextField,
      'confirm:yes': handleConfirm,
    },
    { context: 'Confirmation' },
  );

  // 字符输入处理（退格、输入）
  useInput((char, key) => {
    // 退格
    if (key.backspace || key.delete) {
      setCurrentInput(prev => prev.slice(0, -1));
      return;
    }

    // 常规字符输入
    if (char && !key.ctrl && !key.meta && !key.tab && !key.return) {
      setCurrentInput(prev => prev + char);
    }
  });

  if (!fieldSchema || !currentField) {
    return null;
  }

  const isSensitive = fieldSchema.sensitive === true;
  const isRequired = fieldSchema.required === true;
  const displayValue = isSensitive ? '*'.repeat(stringWidth(currentInput)) : currentInput;

  return (
    <Dialog title={title} subtitle={subtitle} onCancel={onCancel} isCancelActive={false}>
      <Box flexDirection="column">
        <Text bold={true}>
          {fieldSchema.title || currentField}
          {isRequired && <Text color="error"> *</Text>}
        </Text>
        {fieldSchema.description && <Text dimColor={true}>{fieldSchema.description}</Text>}

        <Box marginTop={1}>
          <Text>{figures.pointerSmall} </Text>
          <Text>{displayValue}</Text>
          <Text>█</Text>
        </Box>
      </Box>

      <Box flexDirection="column">
        <Text dimColor={true}>
          Field {currentFieldIndex + 1} of {fields.length}
        </Text>
        {currentFieldIndex < fields.length - 1 && (
          <Text dimColor={true}>Tab: Next field · Enter: Save and continue</Text>
        )}
        {currentFieldIndex === fields.length - 1 && <Text dimColor={true}>Enter: Save configuration</Text>}
      </Box>
    </Dialog>
  );
}
