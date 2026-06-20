/**
 * 插件推荐 hook 的共享状态机 + 安装辅助函数
 * （LSP、claude-code-hint）。集中门控链、异步守卫
 * 和成功/失败通知 JSX，以便新源保持精简。
 */

import figures from 'figures';
import * as React from 'react';
import { getIsRemoteMode } from '../bootstrap/state.js';
import type { useNotifications } from '../context/notifications.js';
import { Text } from '@anthropic/ink';
import { logError } from '../utils/log.js';
import { getPluginById } from '../utils/plugins/marketplaceManager.js';

type AddNotification = ReturnType<typeof useNotifications>['addNotification'];
type PluginData = NonNullable<Awaited<ReturnType<typeof getPluginById>>>;

/**
 * 在 useEffect 内调用 tryResolve；它应用标准门控（远程
 * 模式、已显示、进行中）然后运行 resolve()。非空返回
 * 成为推荐。将 tryResolve 包含在 effect 依赖中 —— 它的
 * 身份跟踪推荐，所以清除会重新触发解析。
 */
export function usePluginRecommendationBase<T>(): {
  recommendation: T | null;
  clearRecommendation: () => void;
  tryResolve: (resolve: () => Promise<T | null>) => void;
} {
  const [recommendation, setRecommendation] = React.useState<T | null>(null);
  const isCheckingRef = React.useRef(false);

  const tryResolve = React.useCallback(
    (resolve: () => Promise<T | null>) => {
      if (getIsRemoteMode()) return;
      if (recommendation) return;
      if (isCheckingRef.current) return;

      isCheckingRef.current = true;
      void resolve()
        .then(rec => {
          if (rec) setRecommendation(rec);
        })
        .catch(logError)
        .finally(() => {
          isCheckingRef.current = false;
        });
    },
    [recommendation],
  );

  const clearRecommendation = React.useCallback(() => setRecommendation(null), []);

  return { recommendation, clearRecommendation, tryResolve };
}

/** 查找插件，运行 install()，发出标准成功/失败通知。 */
export async function installPluginAndNotify(
  pluginId: string,
  pluginName: string,
  keyPrefix: string,
  addNotification: AddNotification,
  install: (pluginData: PluginData) => Promise<void>,
): Promise<void> {
  try {
    const pluginData = await getPluginById(pluginId);
    if (!pluginData) {
      throw new Error(`Plugin ${pluginId} not found in marketplace`);
    }
    await install(pluginData);
    addNotification({
      key: `${keyPrefix}-installed`,
      jsx: (
        <Text color="success">
          {figures.tick} {pluginName} installed · restart to apply
        </Text>
      ),
      priority: 'immediate',
      timeoutMs: 5000,
    });
  } catch (error) {
    logError(error);
    addNotification({
      key: `${keyPrefix}-install-failed`,
      jsx: <Text color="error">Failed to install {pluginName}</Text>,
      priority: 'immediate',
      timeoutMs: 5000,
    });
  }
}
