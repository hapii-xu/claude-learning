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
    // If the agent's current model is a full ID (e.g. 'claude-opus-4-5') not
    // in the alias list, inject it as an option so it can round-trip through
    // confirm without being overwritten.
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
        <Text dimColor>模型决定了 Agent 的推理能力和速度。</Text>
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
