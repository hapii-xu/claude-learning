import React, { useCallback, useRef, useState } from 'react';
import { Select } from '../../components/CustomSelect/select.js';
import { Box, Dialog, Text } from '@anthropic/ink';

type Props = {
  onProceed: (signal: AbortSignal) => Promise<void>;
  onCancel: () => void;
};

export function UltrareviewOverageDialog({ onProceed, onCancel }: Props): React.ReactNode {
  const [isLaunching, setIsLaunching] = useState(false);
  const abortControllerRef = useRef(new AbortController());

  const handleSelect = useCallback(
    (value: string) => {
      if (value === 'proceed') {
        setIsLaunching(true);
        // 如果 onProceed 抛出异常（例如 launchRemoteReview 抛错），onDone 永远
        // 不会被调用，对话框会一直挂载 — 恢复 Select 以便用户可以重试或取消，
        // 而不是盯着"Launching…"发呆。
        void onProceed(abortControllerRef.current.signal).catch(() => setIsLaunching(false));
      } else {
        onCancel();
      }
    },
    [onProceed, onCancel],
  );

  // 启动期间按 Escape 通过 signal 中断进行中的 onProceed，使
  // 调用方可以跳过副作用（confirmOverage、onDone）— 否则
  // fire-and-forget 的启动会继续运行，即使"已取消"也会计费。
  const handleCancel = useCallback(() => {
    abortControllerRef.current.abort();
    onCancel();
  }, [onCancel]);

  const options = [
    { label: 'Proceed with Extra Usage billing', value: 'proceed' },
    { label: 'Cancel', value: 'cancel' },
  ];

  return (
    <Dialog title="Ultrareview billing" onCancel={handleCancel} color="background">
      <Box flexDirection="column" gap={1}>
        <Text>
          Your free ultrareviews for this organization are used. Further reviews bill as Extra Usage (pay-per-use).
        </Text>
        {isLaunching ? (
          <Text color="background">Launching…</Text>
        ) : (
          <Select options={options} onChange={handleSelect} onCancel={handleCancel} />
        )}
      </Box>
    </Dialog>
  );
}
