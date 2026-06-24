import { type ReactNode, useCallback, useState } from 'react';
import { Box, Byline, KeyboardShortcutHint, Text } from '@anthropic/ink';
import { useKeybinding } from '../../../../keybindings/useKeybinding.js';
import { editPromptInEditor } from '../../../../utils/promptEditor.js';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import TextInput from '../../../TextInput.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import type { AgentWizardData } from '../types.js';

export function DescriptionStep(): ReactNode {
  const { goNext, goBack, updateWizardData, wizardData } = useWizard<AgentWizardData>();
  const [whenToUse, setWhenToUse] = useState(wizardData.whenToUse || '');
  const [cursorOffset, setCursorOffset] = useState(whenToUse.length);
  const [error, setError] = useState<string | null>(null);

  // Handle escape key - use Settings context so 'n' key doesn't cancel (allows typing 'n' in input)
  useKeybinding('confirm:no', goBack, { context: 'Settings' });

  const handleExternalEditor = useCallback(async () => {
    const result = await editPromptInEditor(whenToUse);
    if (result.content !== null) {
      setWhenToUse(result.content);
      setCursorOffset(result.content.length);
    }
  }, [whenToUse]);

  useKeybinding('chat:externalEditor', handleExternalEditor, {
    context: 'Chat',
  });

  const handleSubmit = (value: string): void => {
    const trimmedValue = value.trim();
    if (!trimmedValue) {
      setError('描述不能为空');
      return;
    }

    setError(null);
    updateWizardData({ whenToUse: trimmedValue });
    goNext();
  };

  return (
    <WizardDialogLayout
      subtitle="描述（告诉 Claude 何时使用此 Agent）"
      footerText={
        <Byline>
          <KeyboardShortcutHint shortcut="输入" action="输入文字" />
          <KeyboardShortcutHint shortcut="Enter" action="继续" />
          <ConfigurableShortcutHint
            action="chat:externalEditor"
            context="Chat"
            fallback="ctrl+g"
            description="在编辑器中打开"
          />
          <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="返回" />
        </Byline>
      }
    >
      <Box flexDirection="column">
        <Text>Claude 应在什么情况下使用此 Agent？</Text>

        <Box marginTop={1}>
          <TextInput
            value={whenToUse}
            onChange={setWhenToUse}
            onSubmit={handleSubmit}
            placeholder="例如：当你写完代码后使用此 Agent..."
            columns={80}
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
