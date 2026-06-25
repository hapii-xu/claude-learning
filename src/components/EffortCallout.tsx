import React, { useCallback, useEffect, useRef } from 'react';
import { Box, Text } from '@anthropic/ink';
import { isMaxSubscriber, isProSubscriber, isTeamSubscriber } from '../utils/auth.js';
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js';
import type { EffortLevel } from '../utils/effort.js';
import {
  convertEffortValueToLevel,
  getDefaultEffortForModel,
  getOpusDefaultEffortConfig,
  toPersistableEffort,
} from '../utils/effort.js';
import { parseUserSpecifiedModel } from '../utils/model/model.js';
import { updateSettingsForSource } from '../utils/settings/settings.js';
import type { OptionWithDescription } from './CustomSelect/select.js';
import { Select } from './CustomSelect/select.js';
import { effortLevelToSymbol } from './EffortIndicator.js';
import { PermissionDialog } from './permissions/PermissionDialog.js';

type EffortCalloutSelection = EffortLevel | undefined | 'dismiss';

type Props = {
  model: string;
  onDone: (selection: EffortCalloutSelection) => void;
};

const AUTO_DISMISS_MS = 30_000;

export function EffortCallout({ model, onDone }: Props): React.ReactNode {
  const defaultEffortConfig = getOpusDefaultEffortConfig();
  // Latest-ref 模式 —— 通过 effect 写入，以便 React Compiler 能做记忆化。
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  const handleCancel = useCallback((): void => {
    onDoneRef.current('dismiss');
  }, []);

  // 挂载时永久关闭，使其只显示一次
  useEffect(() => {
    markV2Dismissed();
  }, []);

  // 30 秒自动关闭计时器
  useEffect(() => {
    const timeoutId = setTimeout(handleCancel, AUTO_DISMISS_MS);
    return () => clearTimeout(timeoutId);
  }, [handleCancel]);

  const defaultEffort = getDefaultEffortForModel(model);
  const defaultLevel = defaultEffort ? convertEffortValueToLevel(defaultEffort) : 'high';

  const handleSelect = useCallback(
    (value: EffortLevel): void => {
      const effortLevel = value === defaultLevel ? undefined : value;
      updateSettingsForSource('userSettings', {
        effortLevel: toPersistableEffort(effortLevel),
      });
      onDoneRef.current(value);
    },
    [defaultLevel],
  );

  const options: OptionWithDescription<EffortLevel>[] = [
    {
      label: <EffortOptionLabel level="medium" text="中等（推荐）" />,
      value: 'medium',
    },
    { label: <EffortOptionLabel level="high" text="高" />, value: 'high' },
    { label: <EffortOptionLabel level="low" text="低" />, value: 'low' },
  ];

  return (
    <PermissionDialog title={defaultEffortConfig.dialogTitle}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1} flexDirection="column">
          <Text>{defaultEffortConfig.dialogDescription}</Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>
            <EffortIndicatorSymbol level="low" /> 低 {'·'} <EffortIndicatorSymbol level="medium" /> 中等 {'·'}{' '}
            <EffortIndicatorSymbol level="high" /> 高
          </Text>
        </Box>
        <Select options={options} onChange={handleSelect} onCancel={handleCancel} />
      </Box>
    </PermissionDialog>
  );
}

function EffortIndicatorSymbol({ level }: { level: EffortLevel }): React.ReactNode {
  return <Text color="suggestion">{effortLevelToSymbol(level)}</Text>;
}

function EffortOptionLabel({ level, text }: { level: EffortLevel; text: string }): React.ReactNode {
  return (
    <>
      <EffortIndicatorSymbol level={level} /> {text}
    </>
  );
}

/**
 * 检查是否应显示 effort 提示弹窗。
 *
 * 受众：
 * - Pro：此前默认就是 medium；除非见过 v1（effortCalloutDismissed）否则显示
 * - Max/Team：通过 tengu_grey_step2 配置获得 medium；启用时显示
 * - 其他所有人：标记为已关闭，使其永不显示
 */
export function shouldShowEffortCallout(model: string): boolean {
  // 目前仅对 Opus 4.6 显示
  const parsed = parseUserSpecifiedModel(model);
  if (!parsed.toLowerCase().includes('opus-4-6')) {
    return false;
  }

  const config = getGlobalConfig();
  if (config.effortCalloutV2Dismissed) return false;

  // 不向全新用户显示 —— 他们从不知道旧默认值，因此对他们而言这不算变更。
  // 标记为已关闭以保持抑制状态。
  if (config.numStartups <= 1) {
    markV2Dismissed();
    return false;
  }

  // Pro 用户在本 PR 之前默认就是 medium。显示新文案，
  // 但若已看过 v1 对话框则跳过 —— 没必要重复打扰。
  if (isProSubscriber()) {
    if (config.effortCalloutDismissed) {
      markV2Dismissed();
      return false;
    }
    return getOpusDefaultEffortConfig().enabled;
  }

  // Max/Team 是 tengu_grey_step2 配置的目标受众。
  // 配置关闭时不标记为已关闭 —— 他们应在启用后看到对话框。
  if (isMaxSubscriber() || isTeamSubscriber()) {
    return getOpusDefaultEffortConfig().enabled;
  }

  // 其他所有人（免费层、API key、非订阅者）：不在范围内。
  markV2Dismissed();
  return false;
}

function markV2Dismissed(): void {
  saveGlobalConfig(current => {
    if (current.effortCalloutV2Dismissed) return current;
    return { ...current, effortCalloutV2Dismissed: true };
  });
}
