/**
 * 显示由 `<claude-code-hint />` 标签驱动的插件安装提示，
 * CLI/SDK 将其输出到 stderr。见 docs/claude-code-hints.md。
 *
 * 单次显示语义：每个插件最多提示一次，
 * 无论 yes/no 都记录在配置中。maybeRecordPluginHint 中的
 * 预存储门控已丢弃已安装/已显示/达到上限的提示，所以
 * 到达此 hook 的任何内容都值得解析。
 */

import * as React from 'react';
import { useNotifications } from '../context/notifications.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../services/analytics/index.js';
import {
  clearPendingHint,
  getPendingHintSnapshot,
  markShownThisSession,
  subscribeToPendingHint,
} from '../utils/claudeCodeHints.js';
import { logForDebugging } from '../utils/debug.js';
import {
  disableHintRecommendations,
  markHintPluginShown,
  type PluginHintRecommendation,
  resolvePluginHint,
} from '../utils/plugins/hintRecommendation.js';
import { installPluginFromMarketplace } from '../utils/plugins/pluginInstallationHelpers.js';
import { installPluginAndNotify, usePluginRecommendationBase } from './usePluginRecommendationBase.js';

type UseClaudeCodeHintRecommendationResult = {
  recommendation: PluginHintRecommendation | null;
  handleResponse: (response: 'yes' | 'no' | 'disable') => void;
};

export function useClaudeCodeHintRecommendation(): UseClaudeCodeHintRecommendationResult {
  const pendingHint = React.useSyncExternalStore(subscribeToPendingHint, getPendingHintSnapshot);
  const { addNotification } = useNotifications();
  const { recommendation, clearRecommendation, tryResolve } = usePluginRecommendationBase<PluginHintRecommendation>();

  React.useEffect(() => {
    if (!pendingHint) return;
    tryResolve(async () => {
      const resolved = await resolvePluginHint(pendingHint);
      if (resolved) {
        logForDebugging(
          `[useClaudeCodeHintRecommendation] surfacing ${resolved.pluginId} from ${resolved.sourceCommand}`,
        );
        markShownThisSession();
      }
      // 丢弃该槽位 —— 但仅当它仍然持有我们刚刚
      // 解析的提示时。在异步查找期间，更新的提示
      // 可能已覆盖它；不要覆盖那个。
      if (getPendingHintSnapshot() === pendingHint) {
        clearPendingHint();
      }
      return resolved;
    });
  }, [pendingHint, tryResolve]);

  const handleResponse = React.useCallback(
    (response: 'yes' | 'no' | 'disable') => {
      if (!recommendation) return;

      // 在此处记录单次显示，而不是在解析时 —— 对话框可能
      // 被更高优先级的 focusedInputDialog 阻塞且从未渲染。
      // 自动关闭通过 onResponse('no') 到达这里。
      markHintPluginShown(recommendation.pluginId);
      logEvent('tengu_plugin_hint_response', {
        _PROTO_plugin_name: recommendation.pluginName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
        _PROTO_marketplace_name: recommendation.marketplaceName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
        response: response as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });

      switch (response) {
        case 'yes': {
          const { pluginId, pluginName, marketplaceName } = recommendation;
          void installPluginAndNotify(pluginId, pluginName, 'hint-plugin', addNotification, async pluginData => {
            const result = await installPluginFromMarketplace({
              pluginId,
              entry: pluginData.entry,
              marketplaceName,
              scope: 'user',
              trigger: 'hint',
            });
            if (!result.success) {
              throw new Error(!result.success ? (result as { error: string }).error : 'Unknown error');
            }
          });
          break;
        }
        case 'disable':
          disableHintRecommendations();
          break;
        case 'no':
          break;
      }

      clearRecommendation();
    },
    [recommendation, addNotification, clearRecommendation],
  );

  return { recommendation, handleResponse };
}
