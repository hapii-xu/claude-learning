import * as React from 'react';
import { useState } from 'react';
import { getSlowOperations } from '../bootstrap/state.js';
import { Text, useInterval } from '@anthropic/ink';

// 开发构建或所有 ant 用户都显示 DevBar
function shouldShowDevBar(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.USER_TYPE === 'ant';
}

export function DevBar(): React.ReactNode {
  const [slowOps, setSlowOps] =
    useState<
      ReadonlyArray<{
        operation: string;
        durationMs: number;
        timestamp: number;
      }>
    >(getSlowOperations);

  useInterval(
    () => {
      setSlowOps(getSlowOperations());
    },
    shouldShowDevBar() ? 500 : null,
  );

  // 仅当有内容可展示时才显示
  if (!shouldShowDevBar() || slowOps.length === 0) {
    return null;
  }

  // 单行格式，避免矮终端被 dev 噪音挤占行数。
  const recentOps = slowOps
    .slice(-3)
    .map(op => `${op.operation} (${Math.round(op.durationMs)}ms)`)
    .join(' · ');

  return (
    <Text wrap="truncate-end" color="warning">
      [ANT-ONLY] 慢速同步：{recentOps}
    </Text>
  );
}
