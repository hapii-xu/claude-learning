/**
 * SelectHookMode 显示给定 event+matcher 对的所有已配置 hooks。
 *
 * /hooks 菜单是只读的：此视图不再提供"添加新 hook"，
 * 选择一个 hook 会显示其只读详情而非删除确认。
 */
import * as React from 'react';
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js';
import type { HookEventMetadata } from 'src/utils/hooks/hooksConfigManager.js';
import { Box, Text } from '@anthropic/ink';
import {
  getHookDisplayText,
  hookSourceHeaderDisplayString,
  type IndividualHookConfig,
} from '../../utils/hooks/hooksSettings.js';
import { Select } from '../CustomSelect/select.js';
import { Dialog } from '@anthropic/ink';

type Props = {
  selectedEvent: HookEvent;
  selectedMatcher: string | null;
  hooksForSelectedMatcher: IndividualHookConfig[];
  hookEventMetadata: HookEventMetadata;
  onSelect: (hook: IndividualHookConfig) => void;
  onCancel: () => void;
};

export function SelectHookMode({
  selectedEvent,
  selectedMatcher,
  hooksForSelectedMatcher,
  hookEventMetadata,
  onSelect,
  onCancel,
}: Props): React.ReactNode {
  const title =
    hookEventMetadata.matcherMetadata !== undefined
      ? `${selectedEvent} - 匹配器：${selectedMatcher || '（全部）'}`
      : selectedEvent;

  if (hooksForSelectedMatcher.length === 0) {
    return (
      <Dialog
        title={title}
        subtitle={hookEventMetadata.description}
        onCancel={onCancel}
        inputGuide={() => <Text>Esc 返回</Text>}
      >
        <Box flexDirection="column" gap={1}>
          <Text dimColor>此事件未配置任何钩子。</Text>
          <Text dimColor>要添加钩子，请直接编辑 settings.json 或询问 Claude。</Text>
        </Box>
      </Dialog>
    );
  }

  return (
    <Dialog title={title} subtitle={hookEventMetadata.description} onCancel={onCancel}>
      <Box flexDirection="column">
        <Select
          options={hooksForSelectedMatcher.map((hook, index) => ({
            label: `[${hook.config.type}] ${getHookDisplayText(hook.config)}`,
            value: index.toString(),
            description:
              hook.source === 'pluginHook' && hook.pluginName
                ? `${hookSourceHeaderDisplayString(hook.source)} (${hook.pluginName})`
                : hookSourceHeaderDisplayString(hook.source),
          }))}
          onChange={value => {
            const index = parseInt(value, 10);
            const hook = hooksForSelectedMatcher[index];
            if (hook) {
              onSelect(hook);
            }
          }}
          onCancel={onCancel}
        />
      </Box>
    </Dialog>
  );
}
