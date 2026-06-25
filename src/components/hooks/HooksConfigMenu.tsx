/**
 * HooksConfigMenu 是一个只读的已配置 hooks 浏览器。
 *
 * 用户可以下钻每个 hook 事件，查看已配置的 matchers 和 hooks
 * （任意类型：command、prompt、agent、http），以及查看单个 hook 详情。
 * 要添加或修改 hooks，用户应直接编辑 settings.json 或让 Claude 帮忙 ——
 * 菜单会引导用户前往。
 *
 * 菜单是只读的，因为旧的编辑 UI 只支持 command 类型的 hooks，
 * 在菜单中为所有四种类型复制 settings.json 的编辑界面会是维护负担。
 */
import * as React from 'react';
import { useCallback, useMemo, useState } from 'react';
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js';
import { useAppState, useAppStateStore } from 'src/state/AppState.js';
import type { CommandResultDisplay } from '../../commands.js';
import { useSettingsChange } from '../../hooks/useSettingsChange.js';
import { Box, Text } from '@anthropic/ink';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import {
  getHookEventMetadata,
  getHooksForMatcher,
  getMatcherMetadata,
  getSortedMatchersForEvent,
  groupHooksByEventAndMatcher,
} from '../../utils/hooks/hooksConfigManager.js';
import type { IndividualHookConfig } from '../../utils/hooks/hooksSettings.js';
import { getSettings_DEPRECATED, getSettingsForSource } from '../../utils/settings/settings.js';
import { plural } from '../../utils/stringUtils.js';
import { Dialog } from '@anthropic/ink';
import { SelectEventMode } from './SelectEventMode.js';
import { SelectHookMode } from './SelectHookMode.js';
import { SelectMatcherMode } from './SelectMatcherMode.js';
import { ViewHookMode } from './ViewHookMode.js';

type Props = {
  toolNames: string[];
  onExit: (result?: string, options?: { display?: CommandResultDisplay }) => void;
};

type ModeState =
  | { mode: 'select-event' }
  | { mode: 'select-matcher'; event: HookEvent }
  | { mode: 'select-hook'; event: HookEvent; matcher: string }
  | { mode: 'view-hook'; event: HookEvent; hook: IndividualHookConfig };

export function HooksConfigMenu({ toolNames, onExit }: Props): React.ReactNode {
  const [modeState, setModeState] = useState<ModeState>({
    mode: 'select-event',
  });
  // 缓存 hooks 是否被 policy 设置禁用。
  // getSettingsForSource() 开销较大（文件读取 + JSON 解析 + 校验），
  // 所以我们在挂载时计算一次，仅在 policy 设置变更时重新计算。
  // 短路求值确保当 hooks 未被禁用时跳过昂贵的检查。
  const [disabledByPolicy, setDisabledByPolicy] = useState(() => {
    const settings = getSettings_DEPRECATED();
    const hooksDisabled = settings?.disableAllHooks === true;
    return hooksDisabled && getSettingsForSource('policySettings')?.disableAllHooks === true;
  });

  // 检查 hooks 是否被 policy 限制为仅 managed
  const [restrictedByPolicy, setRestrictedByPolicy] = useState(() => {
    return getSettingsForSource('policySettings')?.allowManagedHooksOnly === true;
  });

  // 当 policy 设置变更时更新缓存的值
  useSettingsChange(source => {
    if (source === 'policySettings') {
      const settings = getSettings_DEPRECATED();
      const hooksDisabled = settings?.disableAllHooks === true;
      setDisabledByPolicy(hooksDisabled && getSettingsForSource('policySettings')?.disableAllHooks === true);
      setRestrictedByPolicy(getSettingsForSource('policySettings')?.allowManagedHooksOnly === true);
    }
  });

  // 从 modeState 中提取常用值以便使用
  const mode = modeState.mode;
  const selectedEvent = 'event' in modeState ? modeState.event : 'PreToolUse';
  const selectedMatcher = 'matcher' in modeState ? modeState.matcher : null;

  const mcp = useAppState(s => s.mcp);
  const appStateStore = useAppStateStore();
  const combinedToolNames = useMemo(() => [...toolNames, ...mcp.tools.map(tool => tool.name)], [toolNames, mcp.tools]);

  const hooksByEventAndMatcher = useMemo(
    () => groupHooksByEventAndMatcher(appStateStore.getState(), combinedToolNames),
    [combinedToolNames, appStateStore],
  );

  const sortedMatchersForSelectedEvent = useMemo(
    () => getSortedMatchersForEvent(hooksByEventAndMatcher, selectedEvent),
    [hooksByEventAndMatcher, selectedEvent],
  );

  const hooksForSelectedMatcher = useMemo(
    () => getHooksForMatcher(hooksByEventAndMatcher, selectedEvent, selectedMatcher),
    [hooksByEventAndMatcher, selectedEvent, selectedMatcher],
  );

  // 退出对话框的处理器
  const handleExit = useCallback(() => {
    onExit('已关闭 Hooks 对话框', { display: 'system' });
  }, [onExit]);

  // select-event 模式下的 Escape 处理 - 退出菜单
  useKeybinding('confirm:no', handleExit, {
    context: 'Confirmation',
    isActive: mode === 'select-event',
  });

  // select-matcher 模式下的 Escape 处理 - 跳转到 select-event
  useKeybinding(
    'confirm:no',
    () => {
      setModeState({ mode: 'select-event' });
    },
    {
      context: 'Confirmation',
      isActive: mode === 'select-matcher',
    },
  );

  // select-hook 模式下的 Escape 处理 - 跳转到 select-matcher 或 select-event
  useKeybinding(
    'confirm:no',
    () => {
      if ('event' in modeState) {
        if (getMatcherMetadata(modeState.event, combinedToolNames) !== undefined) {
          setModeState({ mode: 'select-matcher', event: modeState.event });
        } else {
          setModeState({ mode: 'select-event' });
        }
      }
    },
    {
      context: 'Confirmation',
      isActive: mode === 'select-hook',
    },
  );

  // view-hook 模式下的 Escape 处理 - 跳转到 select-hook
  useKeybinding(
    'confirm:no',
    () => {
      if (modeState.mode === 'view-hook') {
        const { event, hook } = modeState;
        setModeState({
          mode: 'select-hook',
          event,
          matcher: hook.matcher || '',
        });
      }
    },
    {
      context: 'Confirmation',
      isActive: mode === 'view-hook',
    },
  );

  const hookEventMetadata = getHookEventMetadata(combinedToolNames);

  // 检查 hooks 是否被禁用
  const settings = getSettings_DEPRECATED();
  const hooksDisabled = settings?.disableAllHooks === true;

  // 为事件选择视图按事件统计 hooks，并统计总数。
  const { hooksByEvent, totalHooksCount } = useMemo(() => {
    const byEvent: Partial<Record<HookEvent, number>> = {};
    let total = 0;
    for (const [event, matchers] of Object.entries(hooksByEventAndMatcher)) {
      const eventCount = Object.values(matchers).reduce((sum, hooks) => sum + hooks.length, 0);
      byEvent[event as HookEvent] = eventCount;
      total += eventCount;
    }
    return { hooksByEvent: byEvent, totalHooksCount: total };
  }, [hooksByEventAndMatcher]);

  // 如果 hooks 被禁用，显示信息屏幕。
  // 菜单是只读的，所以我们不提供重新启用按钮 ——
  // 用户可以编辑 settings.json 或让 Claude 帮忙。
  if (hooksDisabled) {
    return (
      <Dialog title="Hook 配置 - 已禁用" onCancel={handleExit} inputGuide={() => <Text>按 Esc 关闭</Text>}>
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text>
              当前所有 hook 均已 <Text bold>禁用</Text>
              {disabledByPolicy && '（由托管设置文件设定）'}。你有 <Text bold>{totalHooksCount}</Text> 个已配置的 hook
              未运行。
            </Text>
            <Box marginTop={1}>
              <Text dimColor>hook 被禁用时：</Text>
            </Box>
            <Text dimColor>· 不会执行任何 hook 命令</Text>
            <Text dimColor>· StatusLine 不会显示</Text>
            <Text dimColor>· 工具操作将跳过 hook 校验直接执行</Text>
          </Box>
          {!disabledByPolicy && (
            <Text dimColor>
              如需重新启用 hook，请从 settings.json 中移除 &quot;disableAllHooks&quot;，或让 Claude 帮忙处理。
            </Text>
          )}
        </Box>
      </Dialog>
    );
  }

  switch (modeState.mode) {
    case 'select-event':
      return (
        <SelectEventMode
          hookEventMetadata={hookEventMetadata}
          hooksByEvent={hooksByEvent}
          totalHooksCount={totalHooksCount}
          restrictedByPolicy={restrictedByPolicy}
          onSelectEvent={event => {
            if (getMatcherMetadata(event, combinedToolNames) !== undefined) {
              setModeState({ mode: 'select-matcher', event });
            } else {
              setModeState({ mode: 'select-hook', event, matcher: '' });
            }
          }}
          onCancel={handleExit}
        />
      );
    case 'select-matcher':
      return (
        <SelectMatcherMode
          selectedEvent={modeState.event}
          matchersForSelectedEvent={sortedMatchersForSelectedEvent}
          hooksByEventAndMatcher={hooksByEventAndMatcher}
          eventDescription={hookEventMetadata[modeState.event].description}
          onSelect={matcher => {
            setModeState({
              mode: 'select-hook',
              event: modeState.event,
              matcher,
            });
          }}
          onCancel={() => {
            setModeState({ mode: 'select-event' });
          }}
        />
      );
    case 'select-hook':
      return (
        <SelectHookMode
          selectedEvent={modeState.event}
          selectedMatcher={modeState.matcher}
          hooksForSelectedMatcher={hooksForSelectedMatcher}
          hookEventMetadata={hookEventMetadata[modeState.event]}
          onSelect={hook => {
            setModeState({
              mode: 'view-hook',
              event: modeState.event,
              hook,
            });
          }}
          onCancel={() => {
            // 返回到 matcher 选择或事件选择
            if (getMatcherMetadata(modeState.event, combinedToolNames) !== undefined) {
              setModeState({
                mode: 'select-matcher',
                event: modeState.event,
              });
            } else {
              setModeState({ mode: 'select-event' });
            }
          }}
        />
      );
    case 'view-hook':
      return (
        <ViewHookMode
          selectedHook={modeState.hook}
          eventSupportsMatcher={getMatcherMetadata(modeState.event, combinedToolNames) !== undefined}
          onCancel={() => {
            const { event, hook } = modeState;
            setModeState({
              mode: 'select-hook',
              event,
              matcher: hook.matcher || '',
            });
          }}
        />
      );
  }
}
