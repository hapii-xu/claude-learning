import type { Notification } from '../context/notifications.js';
import { Text } from '@anthropic/ink';
import { logForDebugging } from '../utils/debug.js';
import { checkAndInstallOfficialMarketplace } from '../utils/plugins/officialMarketplaceStartupCheck.js';
import { useStartupNotification } from './notifs/useStartupNotification.js';

/**
 * 处理官方 marketplace 自动安装并在 REPL 右下角显示
 * 成功/失败通知的 Hook。
 */
export function useOfficialMarketplaceNotification(): void {
  useStartupNotification(async () => {
    const result = await checkAndInstallOfficialMarketplace();
    const notifs: Notification[] = [];

    // 首先检查配置保存失败 - 这是关键问题
    if (result.configSaveFailed) {
      logForDebugging('Showing marketplace config save failure notification');
      notifs.push({
        key: 'marketplace-config-save-failed',
        jsx: <Text color="error">Failed to save marketplace retry info · Check ~/.claude.json permissions</Text>,
        priority: 'immediate',
        timeoutMs: 10000,
      });
    }

    if (result.installed) {
      logForDebugging('Showing marketplace installation success notification');
      notifs.push({
        key: 'marketplace-installed',
        jsx: <Text color="success">✓ Anthropic marketplace installed · /plugin to see available plugins</Text>,
        priority: 'immediate',
        timeoutMs: 7000,
      });
    } else if (result.skipped && result.reason === 'unknown') {
      logForDebugging('Showing marketplace installation failure notification');
      notifs.push({
        key: 'marketplace-install-failed',
        jsx: <Text color="warning">Failed to install Anthropic marketplace · Will retry on next startup</Text>,
        priority: 'immediate',
        timeoutMs: 8000,
      });
    }
    // 不为以下情况显示通知：
    // - already_installed（用户已拥有）
    // - policy_blocked（企业策略，不烦扰）
    // - already_attempted（现在由重试逻辑处理）
    // - git_unavailable（marketplace 是锦上添花；如果 git 缺失
    //   或是非功能性的 macOS xcrun shim，在退避时静默重试
    //   而不是烦扰 —— 用户会因为其他原因解决 git 问题）
    return notifs;
  });
}
