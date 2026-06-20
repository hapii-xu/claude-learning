/**
 * Companion 展示卡片 — 由 /buddy（无参数）触发。
 * 对齐官方 vc8 组件：带边框的盒子，包含 sprite、属性和最近一条反应。
 */
import { Box, Text } from '@anthropic/ink';
import { useInput } from '@anthropic/ink';
import { renderSprite } from './sprites.js';
import { RARITY_COLORS, RARITY_STARS, STAT_NAMES, type Companion } from './types.js';

const CARD_WIDTH = 40;
const CARD_PADDING_X = 2;

function StatBar({ name, value }: { name: string; value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  const filled = Math.round(clamped / 10);
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
  return (
    <Text>
      {name.padEnd(10)} {bar} {String(value).padStart(3)}
    </Text>
  );
}

export function CompanionCard({
  companion,
  lastReaction,
  onDone,
}: {
  companion: Companion;
  lastReaction?: string;
  onDone?: (result?: string, options?: { display?: string }) => void;
}) {
  const color = RARITY_COLORS[companion.rarity];
  const stars = RARITY_STARS[companion.rarity];
  const sprite = renderSprite(companion, 0);

  // 按任意键关闭
  useInput(
    () => {
      onDone?.(undefined, { display: 'skip' });
    },
    { isActive: onDone !== undefined },
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={CARD_PADDING_X}
      paddingY={1}
      width={CARD_WIDTH}
      flexShrink={0}
    >
      {/* 头部：稀有度 + 物种 */}
      <Box justifyContent="space-between">
        <Text bold color={color}>
          {stars} {companion.rarity.toUpperCase()}
        </Text>
        <Text color={color}>{companion.species.toUpperCase()}</Text>
      </Box>

      {/* 闪光（Shiny）标识 */}
      {companion.shiny && (
        <Text color="warning" bold>
          {'\u2728'} SHINY {'\u2728'}
        </Text>
      )}

      {/* 精灵图（Sprite） */}
      <Box flexDirection="column" marginY={1}>
        {sprite.map((line, i) => (
          <Text key={i} color={color}>
            {line}
          </Text>
        ))}
      </Box>

      {/* 名字 */}
      <Text bold>{companion.name}</Text>

      {/* 性格描述 */}
      <Box marginY={1}>
        <Text dimColor italic>
          &quot;{companion.personality}&quot;
        </Text>
      </Box>

      {/* 属性 */}
      <Box flexDirection="column">
        {STAT_NAMES.map(name => (
          <StatBar key={name} name={name} value={companion.stats[name] ?? 0} />
        ))}
      </Box>

      {/* 最近一条反应 */}
      {lastReaction && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>last said</Text>
          <Box borderStyle="round" borderColor="inactive" paddingX={1}>
            <Text dimColor italic>
              {lastReaction}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
