import React, { useEffect, useMemo, useState } from 'react';
import { extraUsage } from 'src/commands/extra-usage/index.js';
import { Box, Text } from '@anthropic/ink';
import { useClaudeAiLimits } from 'src/services/claudeAiLimitsHook.js';
import { shouldProcessMockLimits } from 'src/services/rateLimitMocking.js'; // 用于 /mock-limits 命令
import { getRateLimitTier, getSubscriptionType, isClaudeAISubscriber } from 'src/utils/auth.js';
import { hasClaudeAiBillingAccess } from 'src/utils/billing.js';
import { MessageResponse } from '../MessageResponse.js';

type UpsellParams = {
  shouldShowUpsell: boolean;
  isMax20x: boolean;
  isExtraUsageCommandEnabled: boolean;
  shouldAutoOpenRateLimitOptionsMenu: boolean;
  isTeamOrEnterprise: boolean;
  hasBillingAccess: boolean;
};

export function getUpsellMessage({
  shouldShowUpsell,
  isMax20x,
  isExtraUsageCommandEnabled,
  shouldAutoOpenRateLimitOptionsMenu,
  isTeamOrEnterprise,
  hasBillingAccess,
}: UpsellParams): string | null {
  if (!shouldShowUpsell) return null;

  if (isMax20x) {
    if (isExtraUsageCommandEnabled) {
      return '/extra-usage \u7ee7\u7eed\u5b8c\u6210\u60a8\u6b63\u5728\u8fdb\u884c\u7684\u5de5\u4f5c\u3002';
    }
    return '/login \u5207\u6362\u5230\u6309 API \u7528\u91cf\u8ba1\u8d39\u8d26\u6237\u3002';
  }

  if (shouldAutoOpenRateLimitOptionsMenu) {
    return '\u6b63\u5728\u6253\u5f00\u9009\u9879\u2026';
  }

  if (!isTeamOrEnterprise && !isExtraUsageCommandEnabled) {
    return '/upgrade \u63d0\u5347\u60a8\u7684\u7528\u91cf\u9650\u5236\u3002';
  }

  if (isTeamOrEnterprise) {
    if (!isExtraUsageCommandEnabled) return null;

    if (hasBillingAccess) {
      return '/extra-usage \u7ee7\u7eed\u5b8c\u6210\u60a8\u6b63\u5728\u8fdb\u884c\u7684\u5de5\u4f5c\u3002';
    }

    return '/extra-usage \u5411\u7ba1\u7406\u5458\u7533\u8bf7\u66f4\u591a\u7528\u91cf\u3002';
  }

  return '/upgrade \u6216 /extra-usage \u7ee7\u7eed\u5b8c\u6210\u60a8\u6b63\u5728\u8fdb\u884c\u7684\u5de5\u4f5c\u3002';
}

type RateLimitMessageProps = {
  text: string;
  onOpenRateLimitOptions?: () => void;
};

export function RateLimitMessage({ text, onOpenRateLimitOptions }: RateLimitMessageProps): React.ReactNode {
  const subscriptionType = getSubscriptionType();
  const rateLimitTier = getRateLimitTier();
  const isTeamOrEnterprise = subscriptionType === 'team' || subscriptionType === 'enterprise';
  const isMax20x = rateLimitTier === 'default_claude_max_20x';
  // 使用 /mock-limits 命令时总是显示 upsell，否则为 subscribers 显示
  const shouldShowUpsell = shouldProcessMockLimits() || isClaudeAISubscriber();

  const canSeeRateLimitOptionsUpsell = shouldShowUpsell && !isMax20x;

  const [hasOpenedInteractiveMenu, setHasOpenedInteractiveMenu] = useState(false);

  // 检查实际的 rate limit 状态 - 仅在用户当前被 rate limited
  // 并且我们已通过 API 验证（resetsAt 仅在 API 响应后设置）时才自动打开。
  // 这防止了在恢复带有旧 rate limit 消息的会话时出现误报。
  const claudeAiLimits = useClaudeAiLimits();
  const isCurrentlyRateLimited =
    claudeAiLimits.status === 'rejected' && claudeAiLimits.resetsAt !== undefined && !claudeAiLimits.isUsingOverage;

  const shouldAutoOpenRateLimitOptionsMenu =
    canSeeRateLimitOptionsUpsell && !hasOpenedInteractiveMenu && isCurrentlyRateLimited && onOpenRateLimitOptions;

  useEffect(() => {
    if (shouldAutoOpenRateLimitOptionsMenu) {
      setHasOpenedInteractiveMenu(true);
      onOpenRateLimitOptions();
    }
  }, [shouldAutoOpenRateLimitOptionsMenu, onOpenRateLimitOptions]);

  const upsell = useMemo(() => {
    const message = getUpsellMessage({
      shouldShowUpsell,
      isMax20x,
      isExtraUsageCommandEnabled: extraUsage.isEnabled(),
      shouldAutoOpenRateLimitOptionsMenu: !!shouldAutoOpenRateLimitOptionsMenu,
      isTeamOrEnterprise,
      hasBillingAccess: hasClaudeAiBillingAccess(),
    });
    if (!message) return null;
    return <Text dimColor>{message}</Text>;
  }, [shouldShowUpsell, isMax20x, isTeamOrEnterprise, shouldAutoOpenRateLimitOptionsMenu]);

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text color="error">{text}</Text>
        {hasOpenedInteractiveMenu ? null : upsell}
      </Box>
    </MessageResponse>
  );
}
