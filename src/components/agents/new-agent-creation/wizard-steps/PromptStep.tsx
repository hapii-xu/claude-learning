import { type ReactNode, useCallback, useState } from 'react';
import { Box, Byline, KeyboardShortcutHint, Text } from '@anthropic/ink';
import { useKeybinding } from '../../../../keybindings/useKeybinding.js';
import { editPromptInEditor } from '../../../../utils/promptEditor.js';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import TextInput from '../../../TextInput.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import type { AgentWizardData } from '../types.js';

export function PromptStep(): ReactNode {
  const { goNext, goBack, updateWizardData, wizardData } = useWizard<AgentWizardData>();
  const [systemPrompt, setSystemPrompt] = useState(wizardData.systemPrompt || '');
  const [cursorOffset, setCursorOffset] = useState(systemPrompt.length);
  const [error, setError] = useState<string | null>(null);

  // 处理 Esc 键 - 使用 Settings 上下文，这样按 'n' 键不会触发取消（允许在输入中输入字母 'n'）
  useKeybinding('confirm:no', goBack, { context: 'Settings' });

  const handleExternalEditor = useCallback(async () => {
    const result = await editPromptInEditor(systemPrompt);
    if (result.content !== null) {
      setSystemPrompt(result.content);
      setCursorOffset(result.content.length);
    }
  }, [systemPrompt]);

  useKeybinding('chat:externalEditor', handleExternalEditor, {
    context: 'Chat',
  });

  const handleSubmit = (): void => {
    const trimmedPrompt = systemPrompt.trim();
    if (!trimmedPrompt) {
      setError('系统提示词为必填项');
      return;
    }

    setError(null);
    updateWizardData({ systemPrompt: trimmedPrompt });
    goNext();
  };

  return (
    <WizardDialogLayout
      subtitle="系统提示词"
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
        <Text>请输入你的 agent 的系统提示词：</Text>
        <Text dimColor>描述越详细，效果越好</Text>

        <Box marginTop={1}>
          <TextInput
            value={systemPrompt}
            onChange={setSystemPrompt}
            onSubmit={handleSubmit}
            placeholder="你是一位乐于助人的代码审查员，会..."
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
