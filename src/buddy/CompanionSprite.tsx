import { feature } from 'bun:bundle';
import figures from 'figures';
import React, { useEffect, useRef, useState } from 'react';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box, Text, stringWidth } from '@anthropic/ink';
import { useAppState, useSetAppState } from '../state/AppState.js';
import type { AppState } from '../state/AppStateStore.js';
import { getGlobalConfig } from '../utils/config.js';
import { isFullscreenActive } from '../utils/fullscreen.js';
import type { Theme } from '../utils/theme.js';
import { getCompanion } from './companion.js';
import { renderFace, renderSprite, spriteFrameCount } from './sprites.js';
import { RARITY_COLORS } from './types.js';

const TICK_MS = 1000;
const BUBBLE_SHOW = 10; // tick 数 → 1000ms 时约 10 秒
const FADE_WINDOW = 3; // 最后约 3 秒气泡会变暗，提示即将消失
const PET_BURST_MS = 2500; // /buddy pet 之后爱心飘动的持续时间

// 空闲序列：大部分时间休息（第 0 帧），偶尔小动作（第 1-2 帧），罕见眨眼。
// 序列索引映射到 sprite 帧；-1 表示“在第 0 帧上眨眼”。
const IDLE_SEQUENCE = [0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 2, 0, 0, 0];

// 爱心会在 5 个 tick（约 2.5 秒）内向上飘出。前置在 sprite 上方。
const H = figures.heart;
const PET_HEARTS = [
  `   ${H}    ${H}   `,
  `  ${H}  ${H}   ${H}  `,
  ` ${H}   ${H}  ${H}   `,
  `${H}  ${H}      ${H} `,
  '·    ·   ·  ',
];

function wrap(text: string, width: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur.length + w.length + 1 > width && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function SpeechBubble({
  text,
  color,
  fading,
  tail,
}: {
  text: string;
  color: keyof Theme;
  fading: boolean;
  tail: 'down' | 'right';
}): React.ReactNode {
  const lines = wrap(text, 30);
  const borderColor = fading ? 'inactive' : color;
  const bubble = (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} width={34}>
      {lines.map((l, i) => (
        <Text key={i} italic dimColor={!fading} color={fading ? 'inactive' : undefined}>
          {l}
        </Text>
      ))}
    </Box>
  );
  if (tail === 'right') {
    return (
      <Box flexDirection="row" alignItems="center">
        {bubble}
        <Text color={borderColor}>─</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" alignItems="flex-end" marginRight={1}>
      {bubble}
      <Box flexDirection="column" alignItems="flex-end" paddingRight={6}>
        <Text color={borderColor}>╲ </Text>
        <Text color={borderColor}>╲</Text>
      </Box>
    </Box>
  );
}

export const MIN_COLS_FOR_FULL_SPRITE = 100;
const SPRITE_BODY_WIDTH = 12;
const NAME_ROW_PAD = 2; // 聚焦状态会用空格包裹名字：` name `
const SPRITE_PADDING_X = 2;
const BUBBLE_WIDTH = 36; // SpeechBubble 盒子宽度（34）+ 尾巴列
const NARROW_QUIP_CAP = 24;

function spriteColWidth(nameWidth: number): number {
  return Math.max(SPRITE_BODY_WIDTH, nameWidth + NAME_ROW_PAD);
}

// sprite 区域占用的宽度。PromptInput 会减去该宽度，使文字正确换行。
// 全屏模式下气泡浮在 scrollback 上方（无需额外宽度）；
// 非全屏模式下气泡内联在一侧，需要再多 BUBBLE_WIDTH 宽度。
// 窄终端下为 0 — REPL.tsx 会把单行文本堆叠到单独一行
// （全屏下位于输入框上方，scrollback 下位于下方），因此无需预留宽度。
export function companionReservedColumns(terminalColumns: number, speaking: boolean): number {
  if (!feature('BUDDY')) return 0;
  const companion = getCompanion();
  if (!companion || getGlobalConfig().companionMuted) return 0;
  if (terminalColumns < MIN_COLS_FOR_FULL_SPRITE) return 0;
  const nameWidth = stringWidth(companion.name);
  const bubble = speaking && !isFullscreenActive() ? BUBBLE_WIDTH : 0;
  return spriteColWidth(nameWidth) + SPRITE_PADDING_X + bubble;
}

export function CompanionSprite(): React.ReactNode {
  const reaction = useAppState(s => s.companionReaction);
  const petAt = useAppState(s => s.companionPetAt);
  const focused = useAppState(s => s.footerSelection === 'companion');
  const setAppState = useSetAppState();
  const { columns } = useTerminalSize();
  const [tick, setTick] = useState(0);
  const lastSpokeTick = useRef(0);
  // 在 render 期间同步更新（而不是用 useEffect），确保 pet 之后的首次 render
  // 就能看到 petStartTick=tick 且 petAge=0 — 否则会跳过第 0 帧。
  const [{ petStartTick, forPetAt }, setPetStart] = useState({
    petStartTick: 0,
    forPetAt: petAt,
  });
  if (petAt !== forPetAt) {
    setPetStart({ petStartTick: tick, forPetAt: petAt });
  }

  useEffect(() => {
    const timer = setInterval(setT => setT((t: number) => t + 1), TICK_MS, setTick);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!reaction) return;
    lastSpokeTick.current = tick;
    const timer = setTimeout(
      setA =>
        setA((prev: AppState) =>
          prev.companionReaction === undefined ? prev : { ...prev, companionReaction: undefined },
        ),
      BUBBLE_SHOW * TICK_MS,
      setAppState,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 故意在 reaction 变化时捕获 tick，不持续跟踪
  }, [reaction, setAppState]);

  if (!feature('BUDDY')) return null;
  const companion = getCompanion();
  if (!companion || getGlobalConfig().companionMuted) return null;

  const color = RARITY_COLORS[companion.rarity];
  const colWidth = spriteColWidth(stringWidth(companion.name));

  const bubbleAge = reaction ? tick - lastSpokeTick.current : 0;
  const fading = reaction !== undefined && bubbleAge >= BUBBLE_SHOW - FADE_WINDOW;

  const petAge = petAt ? tick - petStartTick : Infinity;
  const petting = petAge * TICK_MS < PET_BURST_MS;

  // 窄终端：折叠为单行表情。说话时，气泡文本会替换表情旁边的名字
  // （没有空间放下完整气泡）。
  if (columns < MIN_COLS_FOR_FULL_SPRITE) {
    const quip =
      reaction && reaction.length > NARROW_QUIP_CAP ? reaction.slice(0, NARROW_QUIP_CAP - 1) + '…' : reaction;
    const label = quip ? `"${quip}"` : focused ? ` ${companion.name} ` : companion.name;
    return (
      <Box paddingX={1} alignSelf="flex-end">
        <Text>
          {petting && <Text color="autoAccept">{figures.heart} </Text>}
          <Text bold color={color}>
            {renderFace(companion)}
          </Text>{' '}
          <Text
            italic
            dimColor={!focused && !reaction}
            bold={focused}
            inverse={focused && !reaction}
            color={reaction ? (fading ? 'inactive' : color) : focused ? color : undefined}
          >
            {label}
          </Text>
        </Text>
      </Box>
    );
  }
  const frameCount = spriteFrameCount(companion.species);
  const heartFrame = petting ? PET_HEARTS[petAge % PET_HEARTS.length] : null;

  let spriteFrame: number;
  let blink = false;
  if (reaction || petting) {
    // 兴奋状态：快速循环所有小动作帧
    spriteFrame = tick % frameCount;
  } else {
    const step = IDLE_SEQUENCE[tick % IDLE_SEQUENCE.length]!;
    if (step === -1) {
      spriteFrame = 0;
      blink = true;
    } else {
      spriteFrame = step % frameCount;
    }
  }

  const body = renderSprite(companion, spriteFrame).map(line => (blink ? line.replaceAll(companion.eye, '-') : line));
  const sprite = heartFrame ? [heartFrame, ...body] : body;

  // 名字行同时充当提示行 — 未聚焦时显示暗色名字 + ↓ 发现提示，
  // 聚焦时显示反色的名字。回车打开提示位于 PromptInputFooter 的右侧列，
  // 这样该行始终保持单行，sprite 在被选中时也不会向上跳动。
  // flexShrink=0 阻止内联气泡行容器挤压 sprite 的宽度。
  const spriteColumn = (
    <Box flexDirection="column" flexShrink={0} alignItems="center" width={colWidth}>
      {sprite.map((line, i) => (
        <Text key={i} color={i === 0 && heartFrame ? 'autoAccept' : color}>
          {line}
        </Text>
      ))}
      <Text italic bold={focused} dimColor={!focused} color={focused ? color : undefined} inverse={focused}>
        {focused ? ` ${companion.name} ` : companion.name}
      </Text>
    </Box>
  );

  if (!reaction) {
    return <Box paddingX={1}>{spriteColumn}</Box>;
  }

  // 全屏模式：气泡由 CompanionFloatingBubble 在 FullscreenLayout 的
  // bottomFloat 槽位中单独渲染（底部槽位的 overflowY:hidden 会裁剪掉
  // 这里 position:absolute 的浮层）。此处只渲染 sprite 本体。
  // 非全屏模式：气泡内联在 sprite 旁边（输入框会缩窄），
  // 因为浮入 Static scrollback 后无法清除。
  if (isFullscreenActive()) {
    return <Box paddingX={1}>{spriteColumn}</Box>;
  }
  return (
    <Box flexDirection="row" alignItems="flex-end" paddingX={1} flexShrink={0}>
      <SpeechBubble text={reaction} color={color} fading={fading} tail="right" />
      {spriteColumn}
    </Box>
  );
}

// 全屏模式下的浮动气泡浮层。挂载在 FullscreenLayout 的 bottomFloat 槽位
// （在 overflowY:hidden 裁剪之外），因此可以延伸到 ScrollBox 区域。
// CompanionSprite 拥有 10 秒后清除的计时器；本组件只是读取
// companionReaction 并渲染淡入淡出效果。
export function CompanionFloatingBubble(): React.ReactNode {
  const reaction = useAppState(s => s.companionReaction);
  const [{ tick, forReaction }, setTick] = useState({
    tick: 0,
    forReaction: reaction,
  });

  // reaction 变化时同步重置 tick（不放在 useEffect 中，因为 useEffect
  // 在 render 之后执行，会出现一帧陈旧的淡出效果）。把 tick 对应的
  // reaction 一并存储，可以保证淡出计算永远不会读到上一个 reaction 的 tick。
  if (reaction !== forReaction) {
    setTick({ tick: 0, forReaction: reaction });
  }

  useEffect(() => {
    if (!reaction) return;
    const timer = setInterval(set => set(s => ({ ...s, tick: s.tick + 1 })), TICK_MS, setTick);
    return () => clearInterval(timer);
  }, [reaction]);

  if (!feature('BUDDY') || !reaction) return null;
  const companion = getCompanion();
  if (!companion || getGlobalConfig().companionMuted) return null;

  return (
    <SpeechBubble
      text={reaction}
      color={RARITY_COLORS[companion.rarity]}
      fading={tick >= BUBBLE_SHOW - FADE_WINDOW}
      tail="down"
    />
  );
}
