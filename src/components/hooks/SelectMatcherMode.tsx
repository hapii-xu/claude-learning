/**
 * SelectMatcherMode 显示所选 hook 事件的已配置 matchers。
 *
 * /hooks 菜单是只读的：此视图不再提供"添加新 matcher"，
 * 仅允许用户下钻每个 matcher 以查看其 hooks。
 */
import * as React from 'react';
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js';
import { Box, Text } from '@anthropic/ink';
import {
  type HookSource,
  hookSourceInlineDisplayString,
  type IndividualHookConfig,
} from '../../utils/hooks/hooksSettings.js';
import { plural } from '../../utils/stringUtils.js';
import { Select } from '../CustomSelect/select.js';
import { Dialog } from '@anthropic/ink';

type MatcherWithSource = {
  matcher: string;
  sources: HookSource[];
  hookCount: number;
};

type Props = {
  selectedEvent: HookEvent;
  matchersForSelectedEvent: string[];
  hooksByEventAndMatcher: Record<HookEvent, Record<string, IndividualHookConfig[]>>;
  eventDescription: string;
  onSelect: (matcher: string) => void;
  onCancel: () => void;
};

export function SelectMatcherMode({
  selectedEvent,
  matchersForSelectedEvent,
  hooksByEventAndMatcher,
  eventDescription,
  onSelect,
  onCancel,
}: Props): React.ReactNode {
  // 将 matchers 与它们的来源分组（已在父组件中按优先级排序）
  const matchersWithSources: MatcherWithSource[] = React.useMemo(() => {
    return matchersForSelectedEvent.map(matcher => {
      const hooks = hooksByEventAndMatcher[selectedEvent]?.[matcher] || [];
      const sources = Array.from(new Set(hooks.map(h => h.source)));
      return {
        matcher,
        sources,
        hookCount: hooks.length,
      };
    });
  }, [matchersForSelectedEvent, hooksByEventAndMatcher, selectedEvent]);

  if (matchersForSelectedEvent.length === 0) {
    return (
      <Dialog
        title={`${selectedEvent} - 匹配器`}
        subtitle={eventDescription}
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
    <Dialog title={`${selectedEvent} - 匹配器`} subtitle={eventDescription} onCancel={onCancel}>
      <Box flexDirection="column">
        <Select
          options={matchersWithSources.map(item => {
            const sourceText = item.sources.map(hookSourceInlineDisplayString).join(', ');
            const matcherLabel = item.matcher || '（全部）';
            return {
              label: `[${sourceText}] ${matcherLabel}`,
              value: item.matcher,
              description: `${item.hookCount} 个${plural(item.hookCount, '钩子')}`,
            };
          })}
          onChange={value => {
            onSelect(value);
          }}
          onCancel={onCancel}
        />
      </Box>
    </Dialog>
  );
}
