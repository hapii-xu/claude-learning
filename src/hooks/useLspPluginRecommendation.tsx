/**
 * LSP 插件推荐的 Hook
 *
 * 检测文件编辑并在以下情况推荐 LSP 插件：
 * - 文件扩展名匹配 LSP 插件
 * - LSP 二进制文件已安装在系统上
 * - 插件尚未安装
 * - 用户未禁用推荐
 *
 * 每次会话仅显示一次推荐。
 */

import { extname, join } from 'path';
import * as React from 'react';
import { hasShownLspRecommendationThisSession, setLspRecommendationShownThisSession } from '../bootstrap/state.js';
import { useNotifications } from '../context/notifications.js';
import { useAppState } from '../state/AppState.js';
import { saveGlobalConfig } from '../utils/config.js';
import { logForDebugging } from '../utils/debug.js';
import { logError } from '../utils/log.js';
import { addToNeverSuggest, getMatchingLspPlugins, incrementIgnoredCount } from '../utils/plugins/lspRecommendation.js';
import { cacheAndRegisterPlugin } from '../utils/plugins/pluginInstallationHelpers.js';
import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js';
import { installPluginAndNotify, usePluginRecommendationBase } from './usePluginRecommendationBase.js';

// 检测超时 vs 显式关闭的阈值（毫秒）
// 菜单在 30 秒自动关闭，所以超过 28 秒可能是超时
const TIMEOUT_THRESHOLD_MS = 28_000;

export type LspRecommendationState = {
  pluginId: string;
  pluginName: string;
  pluginDescription?: string;
  fileExtension: string;
  shownAt: number; // 用于超时检测的时间戳
} | null;

type UseLspPluginRecommendationResult = {
  recommendation: LspRecommendationState;
  handleResponse: (response: 'yes' | 'no' | 'never' | 'disable') => void;
};

export function useLspPluginRecommendation(): UseLspPluginRecommendationResult {
  const trackedFiles = useAppState(s => s.fileHistory.trackedFiles);
  const { addNotification } = useNotifications();
  const checkedFilesRef = React.useRef<Set<string>>(new Set());
  const { recommendation, clearRecommendation, tryResolve } =
    usePluginRecommendationBase<NonNullable<LspRecommendationState>>();

  React.useEffect(() => {
    tryResolve(async () => {
      if (hasShownLspRecommendationThisSession()) return null;

      const newFiles: string[] = [];
      for (const file of trackedFiles) {
        if (!checkedFilesRef.current.has(file)) {
          checkedFilesRef.current.add(file);
          newFiles.push(file);
        }
      }

      for (const filePath of newFiles) {
        try {
          const matches = await getMatchingLspPlugins(filePath);
          const match = matches[0]; // 官方插件优先
          if (match) {
            logForDebugging(`[useLspPluginRecommendation] Found match: ${match.pluginName} for ${filePath}`);
            setLspRecommendationShownThisSession(true);
            return {
              pluginId: match.pluginId,
              pluginName: match.pluginName,
              pluginDescription: match.description,
              fileExtension: extname(filePath),
              shownAt: Date.now(),
            };
          }
        } catch (error) {
          logError(error);
        }
      }
      return null;
    });
  }, [trackedFiles, tryResolve]);

  const handleResponse = React.useCallback(
    (response: 'yes' | 'no' | 'never' | 'disable') => {
      if (!recommendation) return;

      const { pluginId, pluginName, shownAt } = recommendation;

      logForDebugging(`[useLspPluginRecommendation] User response: ${response} for ${pluginName}`);

      switch (response) {
        case 'yes':
          void installPluginAndNotify(pluginId, pluginName, 'lsp-plugin', addNotification, async pluginData => {
            logForDebugging(`[useLspPluginRecommendation] Installing plugin: ${pluginId}`);
            const localSourcePath =
              typeof pluginData.entry.source === 'string'
                ? join(pluginData.marketplaceInstallLocation, pluginData.entry.source)
                : undefined;
            await cacheAndRegisterPlugin(
              pluginId,
              pluginData.entry,
              'user',
              undefined, // projectPath - 用户作用域不需要
              localSourcePath,
            );
            // 在用户设置中启用以便重启时加载
            const settings = getSettingsForSource('userSettings');
            updateSettingsForSource('userSettings', {
              enabledPlugins: {
                ...settings?.enabledPlugins,
                [pluginId]: true,
              },
            });
            logForDebugging(`[useLspPluginRecommendation] Plugin installed: ${pluginId}`);
          });
          break;

        case 'no': {
          const elapsed = Date.now() - shownAt;
          if (elapsed >= TIMEOUT_THRESHOLD_MS) {
            logForDebugging(`[useLspPluginRecommendation] Timeout detected (${elapsed}ms), incrementing ignored count`);
            incrementIgnoredCount();
          }
          break;
        }

        case 'never':
          addToNeverSuggest(pluginId);
          break;

        case 'disable':
          saveGlobalConfig(current => {
            if (current.lspRecommendationDisabled) return current;
            return { ...current, lspRecommendationDisabled: true };
          });
          break;
      }

      clearRecommendation();
    },
    [recommendation, addNotification, clearRecommendation],
  );

  return { recommendation, handleResponse };
}
