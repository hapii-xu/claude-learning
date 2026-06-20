import React, { useCallback, useRef, useState } from 'react';
import { Box, Dialog, Text } from '@anthropic/ink';
import { Select } from '../../components/CustomSelect/select.js';

type Props = {
  billingNote: string | null;
  onConfirm: (signal: AbortSignal) => Promise<void>;
  onCancel: () => void;
};

/**
 * 当 /v1/ultrareview/preflight 返回 action='confirm' 时显示的对话框。
 * 展示服务端提供的 billing_note（或通用的兜底文案），并给用户
 * 提供 Proceed / Cancel 选择。
 */
export function UltrareviewPreflightDialog({ billingNote, onConfirm, onCancel }: Props): React.ReactNode {
  const [isLaunching, setIsLaunching] = useState(false);
  const abortControllerRef = useRef(new AbortController());

  const handleSelect = useCallback(
    (value: string) => {
      if (value === 'proceed') {
        setIsLaunching(true);
        void onConfirm(abortControllerRef.current.signal).catch(() => setIsLaunching(false));
      } else {
        onCancel();
      }
    },
    [onConfirm, onCancel],
  );

  const handleCancel = useCallback(() => {
    abortControllerRef.current.abort();
    onCancel();
  }, [onCancel]);

  const options = [
    { label: 'Proceed', value: 'proceed' },
    { label: 'Cancel', value: 'cancel' },
  ];

  const displayNote = billingNote ?? 'This run may incur additional cost.';

  return (
    <Dialog title="Ultrareview — additional cost" onCancel={handleCancel} color="background">
      <Box flexDirection="column" gap={1}>
        <Text>{displayNote}</Text>
        {isLaunching ? (
          <Text color="background">Launching…</Text>
        ) : (
          <Select options={options} onChange={handleSelect} onCancel={handleCancel} />
        )}
      </Box>
    </Dialog>
  );
}
