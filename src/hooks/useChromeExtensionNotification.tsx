import { Text } from '@anthropic/ink';
import { isClaudeAISubscriber } from '../utils/auth.js';
import { isChromeExtensionInstalled, shouldEnableClaudeInChrome } from '../utils/claudeInChrome/setup.js';
import { isRunningOnHomespace } from '../utils/envUtils.js';
import { useStartupNotification } from './notifs/useStartupNotification.js';

function getChromeFlag(): boolean | undefined {
  if (process.argv.includes('--chrome')) {
    return true;
  }
  if (process.argv.includes('--no-chrome')) {
    return false;
  }
  return undefined;
}

export function useChromeExtensionNotification(): void {
  useStartupNotification(async () => {
    const chromeFlag = getChromeFlag();
    if (!shouldEnableClaudeInChrome(chromeFlag)) return null;

    // Claude in Chrome 仅支持 claude.ai 订阅者（除非用户是 ant）
    if (process.env.USER_TYPE !== 'ant' && !isClaudeAISubscriber()) {
      return {
        key: 'chrome-requires-subscription',
        jsx: <Text color="error">Claude in Chrome requires a claude.ai subscription</Text>,
        priority: 'immediate',
        timeoutMs: 5000,
      };
    }

    const installed = await isChromeExtensionInstalled();
    if (!installed && !isRunningOnHomespace()) {
      // 在 Homespace 上跳过通知，因为 Chrome 设置需要不同步骤（见 go/hsproxy）
      return {
        key: 'chrome-extension-not-detected',
        jsx: <Text color="warning">Chrome extension not detected · https://claude.ai/chrome to install</Text>,
        // TODO(hackyon)：如果 claude-in-chrome 集成不再是 opt-in，则降低优先级
        priority: 'immediate',
        timeoutMs: 3000,
      };
    }
    if (chromeFlag === undefined) {
      // 仅当 Chrome 默认启用时显示低优先级通知
      // （未用 --chrome 显式启用或 --no-chrome 禁用）
      return {
        key: 'claude-in-chrome-default-enabled',
        text: `Claude in Chrome enabled · /chrome`,
        priority: 'low',
      };
    }
    return null;
  });
}
