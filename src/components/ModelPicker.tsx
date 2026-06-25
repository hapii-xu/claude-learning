import capitalize from 'lodash-es/capitalize.js';
import * as React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { has1mContext } from '../utils/context.js';
import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import {
  FAST_MODE_MODEL_DISPLAY,
  isFastModeAvailable,
  isFastModeCooldown,
  isFastModeEnabled,
} from 'src/utils/fastMode.js';
import { Box, Text } from '@anthropic/ink';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { useAppState, useSetAppState } from '../state/AppState.js';
import {
  convertEffortValueToLevel,
  type EffortLevel,
  getDefaultEffortForModel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXhighEffort,
  resolvePickerEffortPersistence,
  toPersistableEffort,
} from '../utils/effort.js';
import {
  getDefaultMainLoopModel,
  type ModelSetting,
  modelDisplayString,
  parseUserSpecifiedModel,
} from '../utils/model/model.js';
import { getModelOptions } from '../utils/model/modelOptions.js';
import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Select } from './CustomSelect/index.js';
import { Byline, KeyboardShortcutHint, Pane } from '@anthropic/ink';
import { effortLevelToSymbol } from './EffortIndicator.js';

export type Props = {
  initial: string | null;
  sessionModel?: ModelSetting;
  onSelect: (model: string | null, effort: EffortLevel | undefined) => void;
  onCancel?: () => void;
  isStandaloneCommand?: boolean;
  showFastModeNotice?: boolean;
  /** 覆盖 "Select model" 下方的灰色标题行。 */
  headerText?: string;
  /**
   * 为 true 时，选择时跳过把 effortLevel 写入 userSettings。
   * 用于 assistant 安装向导 —— 那里的模型选择是项目级作用域（通过
   * install.ts 写入 assistant 的 .hclaude/settings.json），不应泄漏到
   * 用户全局的 ~/.hclaude/settings。
   */
  skipSettingsWrite?: boolean;
};

const NO_PREFERENCE = '__NO_PREFERENCE__';

export function ModelPicker({
  initial,
  sessionModel,
  onSelect,
  onCancel,
  isStandaloneCommand,
  showFastModeNotice,
  headerText,
  skipSettingsWrite,
}: Props): React.ReactNode {
  const setAppState = useSetAppState();
  const exitState = useExitOnCtrlCDWithKeybindings();
  const maxVisible = 10;

  const initialValue = initial === null ? NO_PREFERENCE : initial;
  const [focusedValue, setFocusedValue] = useState<string | undefined>(initialValue);

  const isFastMode = useAppState(s => (isFastModeEnabled() ? s.fastMode : false));

  const [marked1MValues, setMarked1MValues] = useState<Set<string>>(
    () => new Set(has1mContext(initialValue) ? [initialValue.replace(/\[1m\]/i, '')] : []),
  );

  const handleToggle1M = useCallback(() => {
    if (!focusedValue || focusedValue === NO_PREFERENCE) return;
    // 以基础值作为 key，这样 handleSelect / is1MMarked 中的查找能与
    // 初始化器匹配 —— 预定义的 1M 选项在 `focusedValue` 中带有 `[1m]`
    // 后缀，如果直接用它作 key 会与基础值 key 集合不一致。
    const baseKey = focusedValue.replace(/\[1m\]/i, '');
    setMarked1MValues(prev => {
      const next = new Set(prev);
      if (next.has(baseKey)) {
        next.delete(baseKey);
      } else {
        next.add(baseKey);
      }
      return next;
    });
  }, [focusedValue]);

  const [hasToggledEffort, setHasToggledEffort] = useState(false);
  const effortValue = useAppState(s => s.effortValue);
  const [effort, setEffort] = useState<EffortLevel | undefined>(
    effortValue !== undefined ? convertEffortValueToLevel(effortValue) : undefined,
  );

  // 对所有派生值做记忆化以避免重新渲染
  const modelOptions = useMemo(() => getModelOptions(isFastMode ?? false), [isFastMode]);

  // 确保初始值在选项列表中
  // 这处理了用户当前模型（例如第三方用户的 'haiku'）不在基础选项里、
  // 但仍应可选并显示为已选中的边界情况
  const optionsWithInitial = useMemo(() => {
    if (initial !== null && !modelOptions.some(opt => opt.value === initial)) {
      return [
        ...modelOptions,
        {
          value: initial,
          label: modelDisplayString(initial),
          description: '当前模型',
        },
      ];
    }
    return modelOptions;
  }, [modelOptions, initial]);

  const selectOptions = useMemo(
    () =>
      optionsWithInitial.map(opt => ({
        ...opt,
        value: opt.value === null ? NO_PREFERENCE : opt.value,
      })),
    [optionsWithInitial],
  );
  const initialFocusValue = useMemo(
    () => (selectOptions.some(_ => _.value === initialValue) ? initialValue : (selectOptions[0]?.value ?? undefined)),
    [selectOptions, initialValue],
  );
  const visibleCount = Math.min(maxVisible, selectOptions.length);
  const hiddenCount = Math.max(0, selectOptions.length - visibleCount);

  const focusedModelName = selectOptions.find(opt => opt.value === focusedValue)?.label;
  const focusedModel = resolveOptionModel(focusedValue);
  const is1MMarked =
    focusedValue !== undefined &&
    focusedValue !== NO_PREFERENCE &&
    marked1MValues.has(focusedValue.replace(/\[1m\]/i, ''));
  const focusedSupportsEffort = focusedModel ? modelSupportsEffort(focusedModel) : false;
  const focusedSupportsXhigh = focusedModel ? modelSupportsXhighEffort(focusedModel) : false;
  const focusedSupportsMax = focusedModel ? modelSupportsMaxEffort(focusedModel) : false;
  const focusedDefaultEffort = getDefaultEffortLevelForOption(focusedValue);
  // 当选中的 effort 不被聚焦模型支持时，钳制显示值。
  // resolveAppliedEffort() 在 API 发送时也会做同样的降级。
  const displayEffort =
    effort === 'max' && !focusedSupportsMax
      ? focusedSupportsXhigh
        ? 'xhigh'
        : 'high'
      : effort === 'xhigh' && !focusedSupportsXhigh
        ? 'high'
        : effort;

  const handleFocus = useCallback(
    (value: string) => {
      setFocusedValue(value);
      if (!hasToggledEffort && effortValue === undefined) {
        setEffort(getDefaultEffortLevelForOption(value));
      }
    },
    [hasToggledEffort, effortValue],
  );

  // Effort level 循环切换的快捷键
  const handleCycleEffort = useCallback(
    (direction: 'left' | 'right') => {
      if (!focusedSupportsEffort) return;
      setEffort(prev =>
        cycleEffortLevel(prev ?? focusedDefaultEffort, direction, focusedSupportsXhigh, focusedSupportsMax),
      );
      setHasToggledEffort(true);
    },
    [focusedSupportsEffort, focusedSupportsXhigh, focusedSupportsMax, focusedDefaultEffort],
  );

  useKeybindings(
    {
      'modelPicker:decreaseEffort': () => handleCycleEffort('left'),
      'modelPicker:increaseEffort': () => handleCycleEffort('right'),
      'modelPicker:toggle1M': () => handleToggle1M(),
    },
    { context: 'ModelPicker' },
  );

  function handleSelect(value: string): void {
    logEvent('tengu_model_command_menu_effort', {
      effort: effort as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    if (!skipSettingsWrite) {
      // Prior 来自磁盘上的 userSettings —— 不是合并后的 settings（那会包含
      // 不得泄漏到用户全局 ~/.hclaude/settings.json 的 project/policy 层），
      // 也不是 AppState.effortValue（那包含会话临时来源，如 --effort CLI flag）。
      // 参见 resolvePickerEffortPersistence 的 JSDoc。
      const effortLevel = resolvePickerEffortPersistence(
        effort,
        getDefaultEffortLevelForOption(value),
        getSettingsForSource('userSettings')?.effortLevel,
        hasToggledEffort,
      );
      const persistable = toPersistableEffort(effortLevel);
      if (persistable !== undefined) {
        updateSettingsForSource('userSettings', { effortLevel: persistable });
      }
      setAppState(prev => ({ ...prev, effortValue: effortLevel }));
    }

    const selectedModel = resolveOptionModel(value);
    const selectedEffort = hasToggledEffort && selectedModel && modelSupportsEffort(selectedModel) ? effort : undefined;
    if (value === NO_PREFERENCE) {
      onSelect(null, selectedEffort);
      return;
    }
    // 根据用户切换应用或剥离 [1m] 后缀。marked1MValues 以基础值为 key
    // （见初始化器 + handleToggle1M），所以要用基础形式查找 —— 而不是
    // `value`，它可能携带来自预定义 1M 选项的 `[1m]` 后缀，永远匹配不上。
    const baseValue = value.replace(/\[1m\]/i, '');
    const wants1M = marked1MValues.has(baseValue);
    const finalValue = wants1M ? `${baseValue}[1m]` : baseValue;
    onSelect(finalValue, selectedEffort);
  }

  const content = (
    <Box flexDirection="column">
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text color="remember" bold>
            选择模型
          </Text>
          <Text dimColor>{headerText ?? '为本次及后续会话选择模型。用 ← → 调整 effort，Space 切换 1M 上下文。'}</Text>
          {sessionModel && (
            <Text dimColor>
              当前会话正在使用 {modelDisplayString(sessionModel)}（由 plan 模式设置）。选择模型将撤销此设置。
            </Text>
          )}
        </Box>

        <Box flexDirection="column" marginBottom={1}>
          <Box flexDirection="column">
            <Select
              defaultValue={initialValue}
              defaultFocusValue={initialFocusValue}
              options={selectOptions}
              onChange={handleSelect}
              onFocus={handleFocus}
              onCancel={onCancel ?? (() => {})}
              visibleOptionCount={visibleCount}
            />
          </Box>
          {hiddenCount > 0 && (
            <Box paddingLeft={3}>
              <Text dimColor>还有 {hiddenCount} 个…</Text>
            </Box>
          )}
        </Box>

        <Box marginBottom={1} flexDirection="column">
          {focusedSupportsEffort ? (
            <Text dimColor>
              <EffortLevelIndicator effort={displayEffort} /> {capitalize(displayEffort)} effort
              {displayEffort === focusedDefaultEffort ? `（默认）` : ``} <Text color="subtle">← → 调整</Text>
            </Text>
          ) : (
            <Text color="subtle">
              <EffortLevelIndicator effort={undefined} /> 不支持 effort
              {focusedModelName ? `（${focusedModelName}）` : ''}
            </Text>
          )}
          {is1MMarked ? (
            <Text dimColor>
              <EffortLevelIndicator effort={'high'} /> 1M 上下文已开启
              <Text color="subtle"> · Space 切换</Text>
            </Text>
          ) : (
            <Text color="subtle">
              <EffortLevelIndicator effort={undefined} /> 1M 上下文已关闭
              {focusedModelName ? `（${focusedModelName}）` : ''}
              <Text color="subtle"> · Space 切换</Text>
            </Text>
          )}
        </Box>

        {isFastModeEnabled() ? (
          showFastModeNotice ? (
            <Box marginBottom={1}>
              <Text dimColor>
                Fast 模式已 <Text bold>开启</Text>，仅适用于 {FAST_MODE_MODEL_DISPLAY}（/fast）。切换到其他模型会关闭
                Fast 模式。
              </Text>
            </Box>
          ) : isFastModeAvailable() && !isFastModeCooldown() ? (
            <Box marginBottom={1}>
              <Text dimColor>
                使用 <Text bold>/fast</Text> 开启 Fast 模式（仅 {FAST_MODE_MODEL_DISPLAY}）。
              </Text>
            </Box>
          ) : null
        ) : null}
      </Box>

      {isStandaloneCommand && (
        <Text dimColor italic>
          {exitState.pending ? (
            <>再按一次 {exitState.keyName} 退出</>
          ) : (
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="确认" />
              <ConfigurableShortcutHint action="select:cancel" context="Select" fallback="Esc" description="退出" />
            </Byline>
          )}
        </Text>
      )}
    </Box>
  );

  if (!isStandaloneCommand) {
    return content;
  }

  return <Pane color="permission">{content}</Pane>;
}

function resolveOptionModel(value?: string): string | undefined {
  if (!value) return undefined;
  return value === NO_PREFERENCE ? getDefaultMainLoopModel() : parseUserSpecifiedModel(value);
}

function EffortLevelIndicator({ effort }: { effort?: EffortLevel }): React.ReactNode {
  return <Text color={effort ? 'claude' : 'subtle'}>{effortLevelToSymbol(effort ?? 'low')}</Text>;
}

function cycleEffortLevel(
  current: EffortLevel,
  direction: 'left' | 'right',
  includeXhigh: boolean,
  includeMax: boolean,
): EffortLevel {
  const levels: EffortLevel[] = [
    'low',
    'medium',
    'high',
    ...(includeXhigh ? (['xhigh'] as const) : []),
    ...(includeMax ? (['max'] as const) : []),
  ];
  // 如果当前 level 不在循环中（例如切换到非 Opus 模型后的 'max'），
  // 钳制到 'high'。
  const idx = levels.indexOf(current);
  const currentIndex = idx !== -1 ? idx : levels.indexOf('high');
  if (direction === 'right') {
    return levels[(currentIndex + 1) % levels.length]!;
  } else {
    return levels[(currentIndex - 1 + levels.length) % levels.length]!;
  }
}

function getDefaultEffortLevelForOption(value?: string): EffortLevel {
  const resolved = resolveOptionModel(value) ?? getDefaultMainLoopModel();
  const defaultValue = getDefaultEffortForModel(resolved);
  return defaultValue !== undefined ? convertEffortValueToLevel(defaultValue) : 'high';
}
