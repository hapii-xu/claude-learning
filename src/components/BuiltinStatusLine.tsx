import React, { useEffect, useState } from 'react';
import { formatCost } from '../cost-tracker.js';
import { Box, Text } from '@anthropic/ink';
import { formatTokens } from '../utils/format.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';

type RateLimitBucket = {
  utilization: number;
  resets_at: number;
};

type BuiltinStatusLineProps = {
  modelName: string;
  contextUsedPct: number;
  usedTokens: number;
  contextWindowSize: number;
  totalCostUsd: number;
  rateLimits: {
    five_hour?: RateLimitBucket;
    seven_day?: RateLimitBucket;
  };
};

/**
 * 格式化从当前到给定 epoch 时间（秒）的倒计时。
 * 返回紧凑的人类可读字符串，如 "3h12m"、"5d20h"、"45m" 或 "now"。
 */
export function formatCountdown(epochSeconds: number): string {
  const diff = epochSeconds - Date.now() / 1000;
  if (diff <= 0) return 'now';

  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const minutes = Math.floor((diff % 3600) / 60);

  if (days >= 1) return `${days}d${hours}h`;
  if (hours >= 1) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

function Separator() {
  return <Text dimColor>{' \u2502 '}</Text>;
}

function BuiltinStatusLineInner({
  modelName,
  contextUsedPct,
  usedTokens,
  contextWindowSize,
  totalCostUsd,
  rateLimits,
}: BuiltinStatusLineProps) {
  const { columns } = useTerminalSize();

  // 每 60 秒强制重新渲染，以保持倒计时时新
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const hasResetTime = (rateLimits.five_hour?.resets_at ?? 0) || (rateLimits.seven_day?.resets_at ?? 0);
    if (!hasResetTime) return;
    const id = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, [rateLimits.five_hour?.resets_at, rateLimits.seven_day?.resets_at]);

  // 抑制未使用变量的 lint（tick 仅用于触发重新渲染）
  void tick;

  // 模型显示：使用前两个词（例如 "Opus 4.6"）而非仅第一个词
  const modelParts = modelName.split(' ');
  const shortModel = modelParts.length >= 2 ? `${modelParts[0]} ${modelParts[1]}` : modelName;

  const narrow = columns < 60;

  const hasFiveHour = rateLimits.five_hour != null;
  const hasSevenDay = rateLimits.seven_day != null;

  const fiveHourPct = hasFiveHour ? Math.round(rateLimits.five_hour!.utilization * 100) : 0;
  const sevenDayPct = hasSevenDay ? Math.round(rateLimits.seven_day!.utilization * 100) : 0;

  // Token 显示："50k/1M"
  const tokenDisplay = `${formatTokens(usedTokens)}/${formatTokens(contextWindowSize)}`;

  return (
    <Box>
      {/* 模型名称 */}
      <Text>{shortModel}</Text>

      {/* 上下文使用率与 token 计数 */}
      <Separator />
      <Text dimColor>Context </Text>
      <Text>{contextUsedPct}%</Text>
      {!narrow && <Text dimColor> ({tokenDisplay})</Text>}

      {/* 5 小时会话速率限制 */}
      {hasFiveHour && (
        <>
          <Separator />
          <Text dimColor>Session </Text>
          <Text>{fiveHourPct}%</Text>
          {!narrow && rateLimits.five_hour!.resets_at > 0 && (
            <Text dimColor> {formatCountdown(rateLimits.five_hour!.resets_at)}</Text>
          )}
        </>
      )}

      {/* 7 天每周速率限制 */}
      {hasSevenDay && (
        <>
          <Separator />
          <Text dimColor>Weekly </Text>
          <Text>{sevenDayPct}%</Text>
          {!narrow && rateLimits.seven_day!.resets_at > 0 && (
            <Text dimColor> {formatCountdown(rateLimits.seven_day!.resets_at)}</Text>
          )}
        </>
      )}

      {/* 成本 */}
      {totalCostUsd > 0 && (
        <>
          <Separator />
          <Text>{formatCost(totalCostUsd)}</Text>
        </>
      )}
    </Box>
  );
}

export const BuiltinStatusLine = React.memo(BuiltinStatusLineInner);
