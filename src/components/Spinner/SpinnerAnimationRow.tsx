import figures from 'figures';
import * as React from 'react';
import { useMemo, useRef } from 'react';
import { Box, Text, useAnimationFrame, stringWidth, Byline } from '@anthropic/ink';
import { toInkColor } from '../../utils/ink.js';
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js';
import { formatDuration, formatNumber } from '../../utils/format.js';

import type { Theme } from '../../utils/theme.js';

import { GlimmerMessage } from './GlimmerMessage.js';
import { SpinnerGlyph } from './SpinnerGlyph.js';
import type { SpinnerMode } from './types.js';
import { useStalledAnimation } from './useStalledAnimation.js';
import { interpolateColor, toRGBColor } from './utils.js';

const SEP_WIDTH = stringWidth(' · ');
const THINKING_BARE_WIDTH = stringWidth('thinking');
const SHOW_TOKENS_AFTER_MS = 30_000;

// 思考微光常量。此前位于独立的 ThinkingShimmerText 组件中，并有自己的
// useAnimationFrame(50) — 此处内联以复用我们现有的 50ms 时钟，并消除冗余的订阅者。
const THINKING_INACTIVE = { r: 153, g: 153, b: 153 };
const THINKING_INACTIVE_SHIMMER = { r: 185, g: 185, b: 185 };
const THINKING_DELAY_MS = 3000;
const THINKING_GLOW_PERIOD_S = 2;

export type SpinnerAnimationRowProps = {
  // 动画输入
  mode: SpinnerMode;
  reducedMotion: boolean;
  hasActiveTools: boolean;
  responseLengthRef: React.RefObject<number>;

  // 消息（在一轮对话内稳定）
  message: string;
  messageColor: keyof Theme;
  shimmerColor: keyof Theme;
  overrideColor?: keyof Theme | null;

  // 计时器 ref（稳定引用）
  loadingStartTimeRef: React.RefObject<number>;
  totalPausedMsRef: React.RefObject<number>;
  pauseStartTimeRef: React.RefObject<number | null>;

  // 显示标志
  spinnerSuffix?: string | null;
  verbose: boolean;
  columns: number;

  // Teammate 派生（由父组件从 tasks 计算）
  hasRunningTeammates: boolean;
  teammateTokens: number;
  foregroundedTeammate: InProcessTeammateTaskState | undefined;
  /** Leader 的一轮对话已完成。抑制 stall-red，因为 responseLengthRef/hasActiveTools 仅跟踪 leader 状态。*/
  leaderIsIdle?: boolean;

  // 思考（由父组件拥有的状态，取决于 mode）
  thinkingStatus: 'thinking' | number | null;
  effortSuffix: string;
};

/**
 * SpinnerWithVerb 中以 50ms 动画驱动的部分。拥有 useAnimationFrame(50)
 * 以及所有从动画时钟派生的值（帧、微光、token 计数器动画、已耗时、
 * 停滞强度、思考微光）。
 *
 * 父组件 SpinnerWithVerb 从 50ms 渲染循环中解放出来，只在它的
 * props/app state 变化时重新渲染（每轮约 25 次而非约 383 次）。
 * 这让外层 Box 壳、useAppState 选择器、task 过滤以及
 * tip/tree 子树都不再处于热点动画路径上。
 */
export function SpinnerAnimationRow({
  mode,
  reducedMotion,
  hasActiveTools,
  responseLengthRef,
  message,
  messageColor,
  shimmerColor,
  overrideColor,
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
  spinnerSuffix,
  verbose,
  columns,
  hasRunningTeammates,
  teammateTokens,
  foregroundedTeammate,
  leaderIsIdle = false,
  thinkingStatus,
  effortSuffix,
}: SpinnerAnimationRowProps): React.ReactNode {
  const [viewportRef, time] = useAnimationFrame(reducedMotion ? null : 50);

  // === 已耗时（墙上时钟，每帧从 ref 派生） ===
  const now = Date.now();
  const elapsedTimeMs =
    pauseStartTimeRef.current !== null
      ? pauseStartTimeRef.current - loadingStartTimeRef.current - totalPausedMsRef.current
      : now - loadingStartTimeRef.current - totalPausedMsRef.current;

  // 为 teammate 跟踪本轮的墙上时钟开始时间。当 swarm 运行时，
  // leader 的 elapsedTimeMs 可能跳变（新的 API 调用会重置
  // loadingStartTimeRef；暂停会冻结它），所以我们锚定到目前已见的
  // 最早派生开始时间。当没有 teammate 在运行时，这里每帧都跟踪
  // derivedStart，实际上为下一个 swarm 重置。
  const derivedStart = now - elapsedTimeMs;
  const turnStartRef = useRef(derivedStart);
  if (!hasRunningTeammates || derivedStart < turnStartRef.current) {
    turnStartRef.current = derivedStart;
  }

  // === 从 `time` 派生的动画值 ===
  const currentResponseLength = responseLengthRef.current;

  // 当 leader 空闲时抑制停滞检测 — responseLengthRef 和
  // hasActiveTools 都只跟踪 leader 状态。当 leader 空闲时查看活跃 teammate，
  // 否则会在 3 秒后误判为停滞。把 leaderIsIdle 当作
  // hasActiveTools 处理即可重置停滞计时器。
  const { isStalled, stalledIntensity } = useStalledAnimation(
    time,
    currentResponseLength,
    hasActiveTools || leaderIsIdle,
    reducedMotion,
  );

  const frame = reducedMotion ? 0 : Math.floor(time / 120);

  const glimmerSpeed = mode === 'requesting' ? 50 : 200;
  // message 在一轮对话内稳定；stringWidth 开销较大（Bun 每个码位
  // 都要做原生调用），需要在 50ms 循环中显式 memoize。
  const glimmerMessageWidth = useMemo(() => stringWidth(message), [message]);
  const cycleLength = glimmerMessageWidth + 20;
  const cyclePosition = Math.floor(time / glimmerSpeed);
  const glimmerIndex = reducedMotion
    ? -100
    : isStalled
      ? -100
      : mode === 'requesting'
        ? (cyclePosition % cycleLength) - 10
        : glimmerMessageWidth + 10 - (cyclePosition % cycleLength);

  const flashOpacity = reducedMotion ? 0 : mode === 'tool-use' ? (Math.sin((time / 1000) * Math.PI) + 1) / 2 : 0;

  // === Token 计数器动画（平滑递增，由 50ms 时钟驱动） ===
  const tokenCounterRef = useRef(currentResponseLength);
  if (reducedMotion) {
    tokenCounterRef.current = currentResponseLength;
  } else {
    const gap = currentResponseLength - tokenCounterRef.current;
    if (gap > 0) {
      let increment;
      if (gap < 70) {
        increment = 3;
      } else if (gap < 200) {
        increment = Math.max(8, Math.ceil(gap * 0.15));
      } else {
        increment = 50;
      }
      tokenCounterRef.current = Math.min(tokenCounterRef.current + increment, currentResponseLength);
    }
  }
  const displayedResponseLength = tokenCounterRef.current;
  const leaderTokens = Math.round(displayedResponseLength / 4);

  const effectiveElapsedMs = hasRunningTeammates ? Math.max(elapsedTimeMs, now - turnStartRef.current) : elapsedTimeMs;
  const timerText = formatDuration(effectiveElapsedMs);
  const timerWidth = stringWidth(timerText);

  // === Token 计数（leader + teammates，或前台 teammate） ===
  const totalTokens =
    foregroundedTeammate && !foregroundedTeammate.isIdle
      ? (foregroundedTeammate.progress?.tokenCount ?? 0)
      : leaderTokens + teammateTokens;
  const tokenCount = formatNumber(totalTokens);
  const tokensText = hasRunningTeammates ? `${tokenCount} tokens` : `${figures.arrowDown} ${tokenCount} tokens`;
  const tokensWidth = stringWidth(tokensText);

  // === 思考文本（可能为适应宽度而缩短） ===
  let thinkingText =
    thinkingStatus === 'thinking'
      ? `thinking${effortSuffix}`
      : typeof thinkingStatus === 'number'
        ? `thought for ${Math.max(1, Math.round(thinkingStatus / 1000))}s`
        : null;
  let thinkingWidthValue = thinkingText ? stringWidth(thinkingText) : 0;

  // === 渐进式宽度门控 ===
  const messageWidth = glimmerMessageWidth + 2;
  const sep = SEP_WIDTH;

  const wantsThinking = thinkingStatus !== null;
  const wantsTimerAndTokens = verbose || hasRunningTeammates || effectiveElapsedMs > SHOW_TOKENS_AFTER_MS;

  const availableSpace = columns - messageWidth - 5;

  let showThinking = wantsThinking && availableSpace > thinkingWidthValue;
  if (!showThinking && wantsThinking && thinkingStatus === 'thinking' && effortSuffix) {
    if (availableSpace > THINKING_BARE_WIDTH) {
      thinkingText = 'thinking';
      thinkingWidthValue = THINKING_BARE_WIDTH;
      showThinking = true;
    }
  }
  const usedAfterThinking = showThinking ? thinkingWidthValue + sep : 0;

  const showTimer = wantsTimerAndTokens && availableSpace > usedAfterThinking + timerWidth;
  const usedAfterTimer = usedAfterThinking + (showTimer ? timerWidth + sep : 0);

  const showTokens = wantsTimerAndTokens && totalTokens > 0 && availableSpace > usedAfterTimer + tokensWidth;

  const thinkingOnly =
    showThinking && thinkingStatus === 'thinking' && !spinnerSuffix && !showTimer && !showTokens && true;

  // === 思考微光颜色（原为 ThinkingShimmerText 自己的计时器） ===
  // 同样是正弦波透明度，但从我们共享的 `time` 派生，而非第二个
  // useAnimationFrame(50) 订阅。
  const thinkingElapsedSec = (time - THINKING_DELAY_MS) / 1000;
  const thinkingOpacity =
    time < THINKING_DELAY_MS ? 0 : (Math.sin((thinkingElapsedSec * Math.PI * 2) / THINKING_GLOW_PERIOD_S) + 1) / 2;
  const thinkingShimmerColor = toRGBColor(
    interpolateColor(THINKING_INACTIVE, THINKING_INACTIVE_SHIMMER, thinkingOpacity),
  );

  // === 构建状态部分 ===
  const parts = [
    ...(spinnerSuffix
      ? [
          <Text dimColor key="suffix">
            {spinnerSuffix}
          </Text>,
        ]
      : []),
    ...(showTimer
      ? [
          <Text dimColor key="elapsedTime">
            {timerText}
          </Text>,
        ]
      : []),
    ...(showTokens
      ? [
          <Box flexDirection="row" key="tokens">
            {!hasRunningTeammates && <SpinnerModeGlyph mode={mode} />}
            <Text dimColor>{tokenCount} tokens</Text>
          </Box>,
        ]
      : []),
    ...(showThinking && thinkingText
      ? [
          thinkingStatus === 'thinking' && !reducedMotion ? (
            <Text key="thinking" color={thinkingShimmerColor}>
              {thinkingOnly ? `(${thinkingText})` : thinkingText}
            </Text>
          ) : (
            <Text dimColor key="thinking">
              {thinkingText}
            </Text>
          ),
        ]
      : []),
  ];

  const status =
    foregroundedTeammate && !foregroundedTeammate.isIdle ? (
      <>
        <Text dimColor>(esc to interrupt </Text>
        <Text color={toInkColor(foregroundedTeammate.identity.color)}>{foregroundedTeammate.identity.agentName}</Text>
        <Text dimColor>)</Text>
      </>
    ) : !foregroundedTeammate && parts.length > 0 ? (
      thinkingOnly ? (
        <Byline>{parts}</Byline>
      ) : (
        <>
          <Text dimColor>(</Text>
          <Byline>{parts}</Byline>
          <Text dimColor>)</Text>
        </>
      )
    ) : null;

  return (
    <Box ref={viewportRef} flexDirection="row" flexWrap="wrap" marginTop={1} width="100%">
      <SpinnerGlyph
        frame={frame}
        messageColor={messageColor}
        stalledIntensity={overrideColor ? 0 : stalledIntensity}
        reducedMotion={reducedMotion}
        time={time}
      />
      <GlimmerMessage
        message={message}
        mode={mode}
        messageColor={messageColor}
        glimmerIndex={glimmerIndex}
        flashOpacity={flashOpacity}
        shimmerColor={shimmerColor}
        stalledIntensity={overrideColor ? 0 : stalledIntensity}
      />
      {status}
    </Box>
  );
}

function SpinnerModeGlyph({ mode }: { mode: SpinnerMode }): React.ReactNode {
  switch (mode) {
    case 'tool-input':
    case 'tool-use':
    case 'responding':
    case 'thinking':
      return (
        <Box width={2}>
          <Text dimColor>{figures.arrowDown}</Text>
        </Box>
      );
    case 'requesting':
      return (
        <Box width={2}>
          <Text dimColor>{figures.arrowUp}</Text>
        </Box>
      );
  }
}
