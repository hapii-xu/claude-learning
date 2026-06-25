import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { getAgentModelOptions } from '../../utils/model/agent.js';
import { Select } from '../CustomSelect/select.js';

interface ModelSelectorProps {
  initialModel?: string;
  onComplete: (model?: string) => void;
  onCancel?: () => void;
}

export function ModelSelector({ initialModel, onComplete, onCancel }: ModelSelectorProps): React.ReactNode {
  const modelOptions = React.useMemo(() => {
    const base = getAgentModelOptions();
    // 如果 agent 当前模型是一个完整的 ID（例如 'claude-opus-4-5'），
    // 且不在别名列表中，则将其作为一个选项注入，以便在确认步骤中能够往返，
    // 而不会被覆盖。
    if (initialModel && !base.some(o => o.value === initialModel)) {
      return [
        {
          value: initialModel,
          label: initialModel,
          description: '当前模型（自定义 ID）',
        },
        ...base,
      ];
    }
    return base;
  }, [initialModel]);

  const defaultModel = initialModel ?? 'sonnet';

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text dimColor>模型决定 agent 的推理能力和速度。</Text>
      </Box>
      <Select
        options={modelOptions}
        defaultValue={defaultModel}
        onChange={onComplete}
        onCancel={() => (onCancel ? onCancel() : onComplete(undefined))}
      />
    </Box>
  );
}
