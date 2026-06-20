import * as React from 'react';
import { clearTrustedDeviceTokenCache } from '../../bridge/trustedDevice.js';
import { Text } from '@anthropic/ink';
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js';
import { getGroveNoticeConfig, getGroveSettings } from '../../services/api/grove.js';
import { clearPolicyLimitsCache } from '../../services/policyLimits/index.js';
// flushTelemetry 采用懒加载，避免启动时引入约 1.1MB 的 OpenTelemetry
import { clearRemoteManagedSettingsCache } from '../../services/remoteManagedSettings/index.js';
import { removeChatGPTAuth } from '../../services/api/openai/chatgptAuth.js';
import { getClaudeAIOAuthTokens, removeApiKey } from '../../utils/auth.js';
import { clearBetasCaches } from '../../utils/betas.js';
import { saveGlobalConfig } from '../../utils/config.js';
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js';
import { getSecureStorage } from '../../utils/secureStorage/index.js';
import { getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js';
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js';
import { resetUserCache } from '../../utils/user.js';

export async function performLogout({ clearOnboarding = false }): Promise<void> {
  // 在清除凭证之前刷新 telemetry，以防止组织数据泄露
  const { flushTelemetry } = await import('../../utils/telemetry/instrumentation.js');
  await flushTelemetry();

  await removeApiKey();
  await removeChatGPTAuth();
  clearChatGPTSettingsAuthMode();

  // 登出时清除所有安全存储数据
  const secureStorage = getSecureStorage();
  secureStorage.delete();

  await clearAuthRelatedCaches();
  saveGlobalConfig(current => {
    const updated = { ...current };
    if (clearOnboarding) {
      updated.hasCompletedOnboarding = false;
      updated.subscriptionNoticeCount = 0;
      updated.hasAvailableSubscription = false;
      if (updated.customApiKeyResponses?.approved) {
        updated.customApiKeyResponses = {
          ...updated.customApiKeyResponses,
          approved: [],
        };
      }
    }
    updated.oauthAccount = undefined;
    return updated;
  });
}

function clearChatGPTSettingsAuthMode(): void {
  delete process.env.OPENAI_AUTH_MODE;
  const userSettings = getSettingsForSource('userSettings') ?? {};
  const env = userSettings.env ?? {};
  const hasOpenAICompatibleConfig =
    Boolean(env.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY) &&
    Boolean(env.OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL);
  const settingsUpdate: Parameters<typeof updateSettingsForSource>[1] = {
    ...(userSettings.modelType === 'openai' && !hasOpenAICompatibleConfig ? { modelType: undefined } : {}),
    env: {
      OPENAI_AUTH_MODE: undefined,
    } as unknown as Record<string, string>,
  };
  updateSettingsForSource('userSettings', settingsUpdate);
}

// 清除当 user/session/auth 变更时必须失效的所有 memoized 内容
export async function clearAuthRelatedCaches(): Promise<void> {
  // 清除 OAuth token 缓存
  getClaudeAIOAuthTokens.cache?.clear?.();
  clearTrustedDeviceTokenCache();
  clearBetasCaches();
  clearToolSchemaCache();

  // 在 GrowthBook 刷新前清除用户数据缓存，使其能拿到最新凭证
  resetUserCache();
  refreshGrowthBookAfterAuthChange();

  // 清除 Grove config 缓存
  getGroveNoticeConfig.cache?.clear?.();
  getGroveSettings.cache?.clear?.();

  // 清除远程托管的设置缓存
  await clearRemoteManagedSettingsCache();

  // 清除策略限制缓存
  await clearPolicyLimitsCache();
}

export async function call(): Promise<React.ReactNode> {
  await performLogout({ clearOnboarding: true });

  const message = <Text>Successfully logged out.</Text>;

  setTimeout(() => {
    gracefulShutdownSync(0, 'logout');
  }, 200);

  return message;
}
