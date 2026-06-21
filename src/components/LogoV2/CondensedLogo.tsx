import { type ReactNode, useEffect } from 'react';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Text, stringWidth } from '@anthropic/ink';
import { useAppState } from '../../state/AppState.js';
import { getEffortSuffix } from '../../utils/effort.js';
import { truncate } from '../../utils/format.js';
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js';
import { formatModelAndBilling, getLogoDisplayData, truncatePath } from '../../utils/logoV2Utils.js';
import { renderModelSetting } from '../../utils/model/model.js';
import { OffscreenFreeze } from '../OffscreenFreeze.js';
import { AnimatedClawd } from './AnimatedClawd.js';
import { Clawd } from './Clawd.js';
import { GuestPassesUpsell, incrementGuestPassesSeenCount, useShowGuestPassesUpsell } from './GuestPassesUpsell.js';
import {
  incrementOverageCreditUpsellSeenCount,
  OverageCreditUpsell,
  useShowOverageCreditUpsell,
} from './OverageCreditUpsell.js';

export function CondensedLogo(): ReactNode {
  const { columns } = useTerminalSize();
  const agent = useAppState(s => s.agent);
  const effortValue = useAppState(s => s.effortValue);
  const model = useMainLoopModel();
  const modelDisplayName = renderModelSetting(model);
  const { version, cwd, billingType, agentName: agentNameFromSettings } = getLogoDisplayData();

  // 优先使用 AppState.agent（由 --agent CLI flag 设置）而非 settings
  const agentName = agent ?? agentNameFromSettings;
  const showGuestPassesUpsell = useShowGuestPassesUpsell();
  const showOverageCreditUpsell = useShowOverageCreditUpsell();

  useEffect(() => {
    if (showGuestPassesUpsell) {
      incrementGuestPassesSeenCount();
    }
  }, [showGuestPassesUpsell]);

  useEffect(() => {
    if (showOverageCreditUpsell && !showGuestPassesUpsell) {
      incrementOverageCreditUpsellSeenCount();
    }
  }, [showOverageCreditUpsell, showGuestPassesUpsell]);

  // 计算文本内容的可用宽度
  // 需要扣除：condensed clawd 宽度（11 字符）+ 间距（2）+ 内边距（2）= 15 字符
  const textWidth = Math.max(columns - 15, 20);

  // 截断 version 以适配可用宽度，需要考虑 "Claude Code v" 前缀
  const versionPrefix = 'Claude Code v';
  const truncatedVersion = truncate(version, Math.max(textWidth - versionPrefix.length, 6));

  const effortSuffix = getEffortSuffix(model, effortValue);
  const { shouldSplit, truncatedModel, truncatedBilling } = formatModelAndBilling(
    modelDisplayName + effortSuffix,
    billingType,
    textWidth,
  );

  // 截断路径，若存在 agent 名则需预留空间
  const separator = ' · ';
  const atPrefix = '@';
  const cwdAvailableWidth = agentName
    ? textWidth - atPrefix.length - stringWidth(agentName) - separator.length
    : textWidth;
  const truncatedCwd = truncatePath(cwd, Math.max(cwdAvailableWidth, 10));

  // OffscreenFreeze：logo 位于消息列表顶部，是最先进入 scrollback 的内容。
  // useMainLoopModel() 订阅了 model 变化，getLogoDisplayData() 会读取
  // getCwd()/subscription 状态 — 在 scrollback 期间其中任何变化都会强制完全终端重置。
  return (
    <OffscreenFreeze>
      <Box flexDirection="row" gap={2} alignItems="center">
        {isFullscreenEnvEnabled() ? <AnimatedClawd /> : <Clawd />}

        {/* 信息 */}
        <Box flexDirection="column">
          <Text>
            <Text bold>Claude Code</Text> <Text dimColor>v{truncatedVersion}</Text>
          </Text>
          {shouldSplit ? (
            <>
              <Text dimColor>{truncatedModel}</Text>
              <Text dimColor>{truncatedBilling}</Text>
            </>
          ) : (
            <Text dimColor>
              {truncatedModel} · {truncatedBilling}
            </Text>
          )}
          <Text dimColor>{agentName ? `@${agentName} · ${truncatedCwd}` : truncatedCwd}</Text>
          {showGuestPassesUpsell && <GuestPassesUpsell />}
          {!showGuestPassesUpsell && showOverageCreditUpsell && <OverageCreditUpsell maxWidth={textWidth} twoLine />}
        </Box>
      </Box>
    </OffscreenFreeze>
  );
}
