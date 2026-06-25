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

  // 处理 Esc 键 - 返回 MethodStep
  // 使用 Settings 上下文，这样按 'n' 键不会触发取消（允许在输入中输入字母 'n'）
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
          <KeyboardShortcutHint shortcut="Type" action="enter text" />
          <KeyboardShortcutHint shortcut="Enter" action="continue" />
          <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="go back" />
        </Byline>
      }
    >
      <Box flexDirection="column">
        <Text>请为你的 agent 输入唯一的标识符：</Text>
        <Box marginTop={1}>
          <TextInput
            value={agentType}
            onChange={setAgentType}
            onSubmit={handleSubmit}
            placeholder="例如，test-runner、tech-lead 等"
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
