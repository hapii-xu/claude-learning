import * as React from 'react';
import { useState } from 'react';
import { Text } from '@anthropic/ink';
import { logEvent } from '../../services/analytics/index.js';
import {
  formatGrantAmount,
  getCachedOverageCreditGrant,
  refreshOverageCreditGrantCache,
} from '../../services/api/overageCreditGrant.js';
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js';
import { truncate } from '../../utils/format.js';
import type { FeedConfig } from './Feed.js';

const MAX_IMPRESSIONS = 3;

/**
 * 是否在任何界面上展示 overage credit upsell。
 *
 * 资格完全来自后端 GET /overage_credit_grant 响应 —
 * CLI 不复制 tier/threshold/role 检查。后端对非 admin 的 Team 成员
 * 返回 available: false，这样他们就不会看到无法操作的 upsell。
 *
 * isEligibleForOverageCreditGrant — 仅为后端资格。用于持久参考界面
 *   （/usage），在这些界面上只要符合条件就应展示信息，没有展示次数上限。
 * shouldShowOverageCreditUpsell — 增加 3 次展示上限和
 *   hasVisitedExtraUsage 关闭行为。用于推广类界面
 *   （欢迎 feed、tips）。
 */
export function isEligibleForOverageCreditGrant(): boolean {
  const info = getCachedOverageCreditGrant();
  if (!info || !info.available || info.granted) return false;
  return formatGrantAmount(info) !== null;
}

export function shouldShowOverageCreditUpsell(): boolean {
  if (!isEligibleForOverageCreditGrant()) return false;

  const config = getGlobalConfig();
  if (config.hasVisitedExtraUsage) return false;
  if ((config.overageCreditUpsellSeenCount ?? 0) >= MAX_IMPRESSIONS) return false;

  return true;
}

/**
 * 如果缓存为空，则发起后台 fetch。可以在挂载时无条件调用 —
 * 如果缓存是最新的就 no-op。
 */
export function maybeRefreshOverageCreditCache(): void {
  if (getCachedOverageCreditGrant() !== null) return;
  void refreshOverageCreditGrantCache();
}

export function useShowOverageCreditUpsell(): boolean {
  const [show] = useState(() => {
    maybeRefreshOverageCreditCache();
    return shouldShowOverageCreditUpsell();
  });
  return show;
}

export function incrementOverageCreditUpsellSeenCount(): void {
  let newCount = 0;
  saveGlobalConfig(prev => {
    newCount = (prev.overageCreditUpsellSeenCount ?? 0) + 1;
    return {
      ...prev,
      overageCreditUpsellSeenCount: newCount,
    };
  });
  logEvent('tengu_overage_credit_upsell_shown', { seen_count: newCount });
}

// 文案来自 "OC & Bulk Overages copy" 文档（#6 — CLI /usage）
function getUsageText(amount: string): string {
  return `${amount} in extra usage for third-party apps · /extra-usage`;
}

// 文案来自 "OC & Bulk Overages copy" 文档（#4 — CLI Welcome 屏幕）。
// 字符预算：title ≤19，subtitle ≤48。
const FEED_SUBTITLE = 'On us. Works on third-party apps · /extra-usage';

function getFeedTitle(amount: string): string {
  return `${amount} in extra usage`;
}

type Props = { maxWidth?: number; twoLine?: boolean };

export function OverageCreditUpsell({ maxWidth, twoLine }: Props): React.ReactNode {
  const info = getCachedOverageCreditGrant();
  if (!info) return null;
  const amount = formatGrantAmount(info);
  if (!amount) return null;

  if (twoLine) {
    const title = getFeedTitle(amount);
    return (
      <>
        <Text color="claude">{maxWidth ? truncate(title, maxWidth) : title}</Text>
        <Text dimColor>{maxWidth ? truncate(FEED_SUBTITLE, maxWidth) : FEED_SUBTITLE}</Text>
      </>
    );
  }

  const text = getUsageText(amount);
  const display = maxWidth ? truncate(text, maxWidth) : text;
  const highlightLen = Math.min(getFeedTitle(amount).length, display.length);

  return (
    <Text dimColor>
      <Text color="claude">{display.slice(0, highlightLen)}</Text>
      {display.slice(highlightLen)}
    </Text>
  );
}

/**
 * 主屏轮播 feed 的 feed 配置。与 feedConfigs.tsx 中的
 * createGuestPassesFeed 对应。
 *
 * 文案来自 "OC & Bulk Overages copy" 文档（#4 — CLI Welcome 屏幕）。
 * 字符预算：title ≤19，subtitle ≤48。
 */
export function createOverageCreditFeed(): FeedConfig {
  const info = getCachedOverageCreditGrant();
  const amount = info ? formatGrantAmount(info) : null;
  const title = amount ? getFeedTitle(amount) : 'extra usage credit';
  return {
    title,
    lines: [],
    customContent: {
      content: <Text dimColor>{FEED_SUBTITLE}</Text>,
      width: Math.max(title.length, FEED_SUBTITLE.length),
    },
  };
}
