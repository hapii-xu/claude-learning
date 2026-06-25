import * as React from 'react';
import { useState } from 'react';
import { Text } from '@anthropic/ink';
import { logEvent } from '../../services/analytics/index.js';
import {
  checkCachedPassesEligibility,
  formatCreditAmount,
  getCachedReferrerReward,
  getCachedRemainingPasses,
} from '../../services/api/referral.js';
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js';

function resetIfPassesRefreshed(): void {
  const remaining = getCachedRemainingPasses();
  if (remaining == null || remaining <= 0) return;
  const config = getGlobalConfig();
  const lastSeen = config.passesLastSeenRemaining ?? 0;
  if (remaining > lastSeen) {
    saveGlobalConfig(prev => ({
      ...prev,
      passesUpsellSeenCount: 0,
      hasVisitedPasses: false,
      passesLastSeenRemaining: remaining,
    }));
  }
}

function shouldShowGuestPassesUpsell(): boolean {
  const { eligible, hasCache } = checkCachedPassesEligibility();
  // 仅在符合条件且缓存存在时展示（不要因 fetch 而阻塞）
  if (!eligible || !hasCache) return false;
  // 如果 passes 已刷新则重置 upsell 计数器（同时覆盖 campaign 变更和 pass 刷新两种情况）
  resetIfPassesRefreshed();

  const config = getGlobalConfig();
  if ((config.passesUpsellSeenCount ?? 0) >= 3) return false;
  if (config.hasVisitedPasses) return false;

  return true;
}

export function useShowGuestPassesUpsell(): boolean {
  const [show] = useState(() => shouldShowGuestPassesUpsell());
  return show;
}

export function incrementGuestPassesSeenCount(): void {
  let newCount = 0;
  saveGlobalConfig(prev => {
    newCount = (prev.passesUpsellSeenCount ?? 0) + 1;
    return {
      ...prev,
      passesUpsellSeenCount: newCount,
    };
  });
  logEvent('tengu_guest_passes_upsell_shown', {
    seen_count: newCount,
  });
}

// 迷你欢迎屏幕的 condensed 布局
export function GuestPassesUpsell(): React.ReactNode {
  const reward = getCachedReferrerReward();
  return (
    <Text dimColor>
      <Text color="claude">[✻]</Text> <Text color="claude">[✻]</Text> <Text color="claude">[✻]</Text> ·{' '}
      {reward
        ? `分享 Claude Code，赚取 ${formatCreditAmount(reward)} 额外用量 · /passes`
        : '3 张 guest pass，见 /passes'}
    </Text>
  );
}
