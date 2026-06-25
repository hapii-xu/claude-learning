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

  // 处理 Esc 键 - 使用 Settings 上下文，这样按 'n' 键不会触发取消（允许在输入中输入字母 'n'）
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
      setError('描述为必填项');
      return;
    }

    setError(null);
    updateWizardData({ whenToUse: trimmedValue });
    goNext();
  };

  return (
    <WizardDialogLayout
      subtitle="描述（告诉 Claude 何时使用此 agent）"
      footerText={
        <Byline>
          <KeyboardShortcutHint shortcut="Type" action="enter text" />
          <KeyboardShortcutHint shortcut="Enter" action="continue" />
          <ConfigurableShortcutHint
            action="chat:externalEditor"
            context="Chat"
            fallback="ctrl+g"
            description="open in editor"
          />
          <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="go back" />
        </Byline>
      }
    >
      <Box flexDirection="column">
        <Text>Claude 应在何时使用此 agent？</Text>

        <Box marginTop={1}>
          <TextInput
            value={whenToUse}
            onChange={setWhenToUse}
            onSubmit={handleSubmit}
            placeholder="例如，在你写完代码后使用此 agent..."
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
