import { feature } from 'bun:bundle';
import * as React from 'react';
import { useSyncExternalStore } from 'react';
import { Box, Text } from '@anthropic/ink';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js';
import {
  calculateTokenWarningState,
  getEffectiveContextWindowSize,
  isAutoCompactEnabled,
} from '../services/compact/autoCompact.js';
import { useCompactWarningSuppression } from '../services/compact/compactWarningHook.js';
import { getUpgradeMessage } from '../utils/model/contextWindowUpgradeCheck.js';

type Props = {
  tokenUsage: number;
  model: string;
};

/**
 * 实时折叠进度："x / y summarized"。作为子组件，以便
 * useSyncExternalStore 可以无条件订阅 store 变化
 * （在条件语句中调用 hooks 会违反 React 规则）。父组件只在
 * feature('CONTEXT_COLLAPSE') + isContextCollapseEnabled() 为真时才渲染此组件。
 */
function CollapseLabel({ upgradeMessage }: { upgradeMessage: string | null }): React.ReactNode {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { getStats, subscribe } =
    require('../services/contextCollapse/index.js') as typeof import('../services/contextCollapse/index.js');
  /* eslint-enable @typescript-eslint/no-require-imports */

  // 当底层的计数值未变化时，snapshot 必须在多次调用间保持引用稳定 ——
  // 每次都返回一个新对象会让 useSyncExternalStore 陷入无限循环。所以编码为字符串。
  const snapshot = useSyncExternalStore(subscribe, () => {
    const s = getStats();
    const idleWarn = s.health.emptySpawnWarningEmitted ? 1 : 0;
    return `${s.collapsedSpans}|${s.stagedSpans}|${s.health.totalErrors}|${s.health.totalEmptySpawns}|${idleWarn}`;
  });

  const [collapsed, staged, errors, emptySpawns, idleWarn] = snapshot.split('|').map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const total = collapsed + staged;

  // 当 ctx-agent 静默失败时显示错误指示器
  if (errors > 0 || idleWarn) {
    const problem = errors > 0 ? `折叠错误：${errors}` : `折叠空闲（${emptySpawns} 次空运行）`;
    return (
      <Text color="warning" wrap="truncate">
        {total > 0 ? `${collapsed} / ${total} summarized \u00b7 ${problem}` : problem}
      </Text>
    );
  }

  if (total === 0) return null;

  const label = `${collapsed} / ${total} 已摘要`;
  return (
    <Text dimColor wrap="truncate">
      {upgradeMessage ? `${label} \u00b7 ${upgradeMessage}` : label}
    </Text>
  );
}

export function TokenWarning({ tokenUsage, model }: Props): React.ReactNode {
  const { percentLeft, isAboveWarningThreshold, isAboveErrorThreshold } = calculateTokenWarningState(tokenUsage, model);

  // 使用响应式 hook 检查是否应该抑制警告
  const suppressWarning = useCompactWarningSuppression();

  if (!isAboveWarningThreshold || suppressWarning) {
    return null;
  }

  const showAutoCompactWarning = isAutoCompactEnabled();
  const upgradeMessage = getUpgradeMessage('warning');

  // 仅响应式或 context-collapse 模式：主动 autocompact 永不触发，
  // 所以 percentLeft 的常规计算（基于 autocompact 阈值）会倒数到一个
  // 不会发生的事件。基于有效窗口重新计算，让百分比反映真实情况。
  //
  // 每个 feature() 块都独立存在，以便 flag 字符串在外部构建中
  // 各自独立地进行死代码消除（DCE）。
  let displayPercentLeft = percentLeft;
  let reactiveOnlyMode = false;
  let collapseMode = false;
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
      reactiveOnlyMode = true;
    }
  }
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isContextCollapseEnabled } =
      require('../services/contextCollapse/index.js') as typeof import('../services/contextCollapse/index.js');
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) {
      collapseMode = true;
    }
  }
  if (reactiveOnlyMode || collapseMode) {
    const effectiveWindow = getEffectiveContextWindowSize(model);
    displayPercentLeft = Math.max(0, Math.round(((effectiveWindow - tokenUsage) / effectiveWindow) * 100));
  }

  // Collapse 模式：委托给订阅 store 的子组件，使指示器随着 ctx-agent
  // 的 stage 和 commit 实时更新，而不仅仅是在下一次 API response
  // 重新渲染 TokenWarning 时才更新。
  if (collapseMode && feature('CONTEXT_COLLAPSE')) {
    return (
      <Box flexDirection="row">
        <CollapseLabel upgradeMessage={upgradeMessage} />
      </Box>
    );
  }

  const autocompactLabel = reactiveOnlyMode
    ? `已使用 ${100 - displayPercentLeft}% context`
    : `距离自动 compact 还有 ${displayPercentLeft}%`;

  return (
    <Box flexDirection="row">
      {showAutoCompactWarning ? (
        <Text dimColor wrap="truncate">
          {upgradeMessage ? `${autocompactLabel} \u00b7 ${upgradeMessage}` : autocompactLabel}
        </Text>
      ) : (
        <Text color={isAboveErrorThreshold ? 'error' : 'warning'} wrap="truncate">
          {upgradeMessage
            ? `Context \u4e0d\u8db3\uff08\u5269\u4f59 ${percentLeft}%\uff09\u00b7 ${upgradeMessage}`
            : `Context \u4e0d\u8db3\uff08\u5269\u4f59 ${percentLeft}%\uff09\u00b7 \u8fd0\u884c /compact \u8fdb\u884c\u538b\u7f29\u5e76\u7ee7\u7eed`}
        </Text>
      )}
    </Box>
  );
}
