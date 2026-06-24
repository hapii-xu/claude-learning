import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js';

export function SandboxPromptFooterHint(): ReactNode {
  const [recentViolationCount, setRecentViolationCount] = useState(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const detailsShortcut = useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o');

  useEffect(() => {
    if (!SandboxManager.isSandboxingEnabled()) {
      return;
    }

    const store = SandboxManager.getSandboxViolationStore();
    let lastCount = store.getTotalCount();

    const unsubscribe = store.subscribe(() => {
      const currentCount = store.getTotalCount();
      const newViolations = currentCount - lastCount;

      if (newViolations > 0) {
        setRecentViolationCount(newViolations);
        lastCount = currentCount;

        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }

        timerRef.current = setTimeout(setRecentViolationCount, 5000, 0);
      }
    });

    return () => {
      unsubscribe();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  if (!SandboxManager.isSandboxingEnabled() || recentViolationCount === 0) {
    return null;
  }

  return (
    <Box paddingX={0} paddingY={0}>
      <Text color="inactive" wrap="truncate">
        ⧈ 沙盒已拦截 {recentViolationCount} 个操作 · {detailsShortcut} 查看详情 · /sandbox 禁用沙盒
      </Text>
    </Box>
  );
}
