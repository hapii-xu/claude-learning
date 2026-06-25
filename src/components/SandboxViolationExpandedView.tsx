import { type ReactNode, useEffect, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import type { SandboxViolationEvent } from '../utils/sandbox/sandbox-adapter.js';
import { SandboxManager } from '../utils/sandbox/sandbox-adapter.js';

/**
 * 将时间戳格式化为 "h:mm:ssa"（例如 "1:30:45pm"）。
 * 替代 date-fns format()，避免为了一个调用就引入 39MB 的依赖。
 */
function formatTime(date: Date): string {
  const h = date.getHours() % 12 || 12;
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  const ampm = date.getHours() < 12 ? 'am' : 'pm';
  return `${h}:${m}:${s}${ampm}`;
}

import { getPlatform } from 'src/utils/platform.js';

export function SandboxViolationExpandedView(): ReactNode {
  const [violations, setViolations] = useState<SandboxViolationEvent[]>([]);
  const [totalCount, setTotalCount] = useState(0);

  useEffect(() => {
    // 如果未启用沙盒，这里是安全的无副作用操作
    const store = SandboxManager.getSandboxViolationStore();
    const unsubscribe = store.subscribe((allViolations: SandboxViolationEvent[]) => {
      setViolations(allViolations.slice(-10));
      setTotalCount(store.getTotalCount());
    });
    return unsubscribe;
  }, []);

  if (!SandboxManager.isSandboxingEnabled() || getPlatform() === 'linux') {
    return null;
  }

  if (totalCount === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box marginLeft={0}>
        <Text color="permission">
          ⧈ Sandbox 已拦截 {totalCount} 次{totalCount === 1 ? '操作' : '操作'}
        </Text>
      </Box>
      {violations.map((v, i) => (
        <Box key={`${v.timestamp.getTime()}-${i}`} paddingLeft={2}>
          <Text dimColor>
            {formatTime(v.timestamp)}
            {v.command ? ` ${v.command}:` : ''} {v.line}
          </Text>
        </Box>
      ))}
      <Box paddingLeft={2}>
        <Text dimColor>
          … 显示最近 {Math.min(10, violations.length)} 条，共 {totalCount} 条
        </Text>
      </Box>
    </Box>
  );
}
