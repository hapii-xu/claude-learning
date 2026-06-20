import { feature } from 'bun:bundle';
import React, { useEffect } from 'react';
import { useNotifications } from '../context/notifications.js';
import { Text } from '@anthropic/ink';
import { getGlobalConfig } from '../utils/config.js';
import { getRainbowColor } from '../utils/thinking.js';

// 使用本地日期而非 UTC — 在不同时区形成 24 小时滚动的浪潮。
// 相比单一的 UTC 午夜高峰，能维持更持续的 Twitter 热度，对 soul 生成负载也更温和。
// 预热窗口：仅在 2026 年 4 月 1-7 日。之后命令永久可用。
export function isBuddyTeaserWindow(): boolean {
  if (process.env.USER_TYPE === 'ant') return true;
  const d = new Date();
  return d.getFullYear() === 2026 && d.getMonth() === 3 && d.getDate() <= 7;
}

export function isBuddyLive(): boolean {
  if (process.env.USER_TYPE === 'ant') return true;
  const d = new Date();
  return d.getFullYear() > 2026 || (d.getFullYear() === 2026 && d.getMonth() >= 3);
}

function RainbowText({ text }: { text: string }): React.ReactNode {
  return (
    <>
      {[...text].map((ch, i) => (
        <Text key={i} color={getRainbowColor(i)}>
          {ch}
        </Text>
      ))}
    </>
  );
}

// 启动时展示的彩虹版 /buddy 预热提示，仅在尚未孵化 companion 时出现。
// 空闲状态的展示和反应由 CompanionSprite 直接处理。
export function useBuddyNotification(): void {
  const { addNotification, removeNotification } = useNotifications();

  useEffect(() => {
    if (!feature('BUDDY')) return;
    const config = getGlobalConfig();
    if (config.companion || !isBuddyTeaserWindow()) return;
    addNotification({
      key: 'buddy-teaser',
      jsx: <RainbowText text="/buddy" />,
      priority: 'immediate',
      timeoutMs: 15_000,
    });
    return () => removeNotification('buddy-teaser');
  }, [addNotification, removeNotification]);
}

export function findBuddyTriggerPositions(text: string): Array<{ start: number; end: number }> {
  if (!feature('BUDDY')) return [];
  const triggers: Array<{ start: number; end: number }> = [];
  const re = /\/buddy\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    triggers.push({ start: m.index, end: m.index + m[0].length });
  }
  return triggers;
}
