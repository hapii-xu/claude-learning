/**
 * SelectEventMode 是 Hooks 配置菜单的入口，用户在此看到可用的 hook 事件列表。
 *
 * /hooks 菜单是只读的：选择一个事件可浏览其已配置的 hooks，但不能修改。
 * 要添加或更改 hooks，用户应直接编辑 settings.json 或让 Claude 帮忙。
 */

import figures from 'figures';
import * as React from 'react';
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js';
import type { HookEventMetadata } from 'src/utils/hooks/hooksConfigManager.js';
import { Box, Link, Text } from '@anthropic/ink';
import { plural } from '../../utils/stringUtils.js';
import { Select } from '../CustomSelect/select.js';
import { Dialog } from '@anthropic/ink';

type Props = {
  hookEventMetadata: Record<HookEvent, HookEventMetadata>;
  hooksByEvent: Partial<Record<HookEvent, number>>;
  totalHooksCount: number;
  restrictedByPolicy: boolean;
  onSelectEvent: (event: HookEvent) => void;
  onCancel: () => void;
};

export function SelectEventMode({
  hookEventMetadata,
  hooksByEvent,
  totalHooksCount,
  restrictedByPolicy,
  onSelectEvent,
  onCancel,
}: Props): React.ReactNode {
  const subtitle = `已配置 ${totalHooksCount} 个 hook`;

  return (
    <Dialog title="Hooks" subtitle={subtitle} onCancel={onCancel}>
      <Box flexDirection="column" gap={1}>
        {restrictedByPolicy && (
          <Box flexDirection="column">
            <Text color="suggestion">{figures.info} Hook 被策略限制</Text>
            <Text dimColor>
              仅允许运行来自托管设置的 hook。来自 ~/.hclaude/settings.json、.hclaude/settings.json 和
              .hclaude/settings.local.json 的用户自定义 hook 均被阻止。
            </Text>
          </Box>
        )}

        <Box flexDirection="column">
          <Text dimColor>
            {figures.info} 此菜单为只读。要添加或修改 hook，请直接编辑 settings.json 或让 Claude 帮忙。{' '}
            <Link url="https://code.claude.com/docs/en/hooks">了解更多</Link>
          </Text>
        </Box>

        <Box flexDirection="column">
          <Select
            onChange={value => {
              onSelectEvent(value as HookEvent);
            }}
            onCancel={onCancel}
            options={Object.entries(hookEventMetadata).map(([name, metadata]) => {
              const count = hooksByEvent[name as HookEvent] || 0;
              return {
                label:
                  count > 0 ? (
                    <Text>
                      {name} <Text color="suggestion">({count})</Text>
                    </Text>
                  ) : (
                    name
                  ),
                value: name,
                description: metadata.summary,
              };
            })}
          />
        </Box>
      </Box>
    </Dialog>
  );
}
