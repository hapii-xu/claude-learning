import { type ReactNode, useState } from 'react';
import { Box, Byline, KeyboardShortcutHint, Text } from '@anthropic/ink';
import { useKeybinding } from '../../../../keybindings/useKeybinding.js';
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import TextInput from '../../../TextInput.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import { validateAgentType } from '../../validateAgent.js';
import type { AgentWizardData } from '../types.js';

type Props = {
  existingAgents: AgentDefinition[];
};

export function TypeStep(_props: Props): ReactNode {
  const { goNext, goBack, updateWizardData, wizardData } = useWizard<AgentWizardData>();
  const [agentType, setAgentType] = useState(wizardData.agentType || '');
  const [error, setError] = useState<string | null>(null);
  const [cursorOffset, setCursorOffset] = useState(agentType.length);

  // Handle escape key - Go back to MethodStep
  // Use Settings context so 'n' key doesn't cancel (allows typing 'n' in input)
  useKeybinding('confirm:no', goBack, { context: 'Settings' });

  const handleSubmit = (value: string): void => {
    const trimmedValue = value.trim();
    const validationError = validateAgentType(trimmedValue);

    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    updateWizardData({ agentType: trimmedValue });
    goNext();
  };

  return (
    <WizardDialogLayout
      subtitle="Agent 类型（标识符）"
      footerText={
        <Byline>
          <KeyboardShortcutHint shortcut="输入" action="输入文字" />
          <KeyboardShortcutHint shortcut="Enter" action="继续" />
          <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="返回" />
        </Byline>
      }
    >
      <Box flexDirection="column">
        <Text>为您的 Agent 输入唯一标识符：</Text>
        <Box marginTop={1}>
          <TextInput
            value={agentType}
            onChange={setAgentType}
            onSubmit={handleSubmit}
            placeholder="例如：test-runner、tech-lead 等"
            columns={60}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            focus
            showCursor
          />
        </Box>

        {error && (
          <Box marginTop={1}>
            <Text color="error">{error}</Text>
          </Box>
        )}
      </Box>
    </WizardDialogLayout>
  );
}
