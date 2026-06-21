import * as React from 'react';
import { useEffect, useMemo } from 'react';
import { Box, Text } from '@anthropic/ink';
import { getDynamicConfig_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js';
import { getGlobalConfig, saveGlobalConfig } from 'src/utils/config.js';

const CONFIG_NAME = 'tengu-top-of-feed-tip';

export function EmergencyTip(): React.ReactNode {
  const tip = useMemo(getTipOfFeed, []);
  // memoize 以防止我们在保存后再次读取 — 我们要的是挂载时的值
  const lastShownTip = useMemo(() => getGlobalConfig().lastShownEmergencyTip, []);

  // 仅当是新的/不同的 tip 时才展示
  const shouldShow = tip.tip && tip.tip !== lastShownTip;

  // 保存当前展示的 tip，这样不会再次展示
  useEffect(() => {
    if (shouldShow) {
      saveGlobalConfig(current => {
        if (current.lastShownEmergencyTip === tip.tip) return current;
        return { ...current, lastShownEmergencyTip: tip.tip };
      });
    }
  }, [shouldShow, tip.tip]);

  if (!shouldShow) {
    return null;
  }

  return (
    <Box paddingLeft={2} flexDirection="column">
      <Text
        {...(tip.color === 'warning'
          ? { color: 'warning' }
          : tip.color === 'error'
            ? { color: 'error' }
            : { dimColor: true })}
      >
        {tip.tip}
      </Text>
    </Box>
  );
}

type TipOfFeed = {
  tip: string;
  color?: 'dim' | 'warning' | 'error';
};

const DEFAULT_TIP: TipOfFeed = { tip: '', color: 'dim' };

/**
 * 从 dynamic config 中获取 tip of the feed，带缓存。
 * 立即返回缓存值，后台更新。
 */
function getTipOfFeed(): TipOfFeed {
  return getDynamicConfig_CACHED_MAY_BE_STALE<TipOfFeed>(CONFIG_NAME, DEFAULT_TIP);
}
