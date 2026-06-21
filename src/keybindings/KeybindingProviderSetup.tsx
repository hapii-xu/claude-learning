/**
 * 针对 ink 的 KeybindingSetup 的应用专用包装器。
 *
 * 连接应用专用依赖（通知系统、绑定加载、文件监视、调试日志），
 * 并以 KeybindingSetup 名义重新导出。
 */
import { useCallback } from 'react';
import { useNotifications } from '../context/notifications.js';
import { count } from '../utils/array.js';
import { logForDebugging } from '../utils/debug.js';
import { plural } from '../utils/stringUtils.js';
import { KeybindingSetup as InkKeybindingSetup } from '@anthropic/ink';
import type { KeybindingWarning } from '@anthropic/ink';
import {
  initializeKeybindingWatcher,
  loadKeybindingsSyncWithWarnings,
  subscribeToKeybindingChanges,
} from './loadUserBindings.js';

type Props = {
  children: React.ReactNode;
};

/**
 * 带有默认 + 用户绑定以及热重载支持的 Keybinding provider。
 *
 * 用法：用此 provider 包裹你的应用以启用键绑定支持。
 *
 * ```tsx
 * <AppStateProvider>
 *   <KeybindingSetup>
 *     <REPL ... />
 *   </KeybindingSetup>
 * </AppStateProvider>
 * ```
 *
 * 特性：
 * - 从代码加载默认绑定
 * - 与来自 ~/.claude/keybindings.json 的用户绑定合并
 * - 监视文件变更并自动重载（热重载）
 * - 用户绑定覆盖默认值（后出现的条目优先）
 * - 支持和弦及自动超时
 */
export function KeybindingSetup({ children }: Props): React.ReactNode {
  const { addNotification, removeNotification } = useNotifications();

  const handleWarnings = useCallback(
    (warnings: KeybindingWarning[], _isReload: boolean) => {
      const notificationKey = 'keybinding-config-warning';

      if (warnings.length === 0) {
        removeNotification(notificationKey);
        return;
      }

      const errorCount = count(warnings, w => w.severity === 'error');
      const warnCount = count(warnings, w => w.severity === 'warning');

      let message: string;
      if (errorCount > 0 && warnCount > 0) {
        message = `Found ${errorCount} keybinding ${plural(errorCount, 'error')} and ${warnCount} ${plural(warnCount, 'warning')}`;
      } else if (errorCount > 0) {
        message = `Found ${errorCount} keybinding ${plural(errorCount, 'error')}`;
      } else {
        message = `Found ${warnCount} keybinding ${plural(warnCount, 'warning')}`;
      }
      message += ' · /doctor for details';

      addNotification({
        key: notificationKey,
        text: message,
        color: errorCount > 0 ? 'error' : 'warning',
        priority: errorCount > 0 ? 'immediate' : 'high',
        timeoutMs: 60000,
      });
    },
    [addNotification, removeNotification],
  );

  return (
    <InkKeybindingSetup
      loadBindings={loadKeybindingsSyncWithWarnings}
      subscribeToChanges={subscribeToKeybindingChanges}
      initWatcher={initializeKeybindingWatcher}
      onWarnings={handleWarnings}
      onDebugLog={logForDebugging}
    >
      {children}
    </InkKeybindingSetup>
  );
}
