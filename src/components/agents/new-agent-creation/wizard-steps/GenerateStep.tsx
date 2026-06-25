import { APIUserAbortError } from '@anthropic-ai/sdk';
import { type ReactNode, useCallback, useRef, useState } from 'react';
import { useMainLoopModel } from '../../../../hooks/useMainLoopModel.js';
import { Box, Byline, Text } from '@anthropic/ink';
import { useKeybinding } from '../../../../keybindings/useKeybinding.js';
import { createAbortController } from '../../../../utils/abortController.js';
import { editPromptInEditor } from '../../../../utils/promptEditor.js';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import { Spinner } from '../../../Spinner.js';
import TextInput from '../../../TextInput.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import { generateAgent } from '../../generateAgent.js';
import type { AgentWizardData } from '../types.js';

export function GenerateStep(): ReactNode {
  const { updateWizardData, goBack, goToStep, wizardData } = useWizard<AgentWizardData>();
  const [prompt, setPrompt] = useState(wizardData.generationPrompt || '');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursorOffset, setCursorOffset] = useState(prompt.length);
  const model = useMainLoopModel();
  const abortControllerRef = useRef<AbortController | null>(null);

  // 在生成过程中按 Esc 时取消生成
  const handleCancelGeneration = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsGenerating(false);
      setError('已取消生成');
    }
  }, []);

  // 使用 Settings 上下文，这样按 'n' 键不会触发取消（允许在提示输入中输入字母 'n'）
  useKeybinding('confirm:no', handleCancelGeneration, {
    context: 'Settings',
    isActive: isGenerating,
  });

  const handleExternalEditor = useCallback(async () => {
    const result = await editPromptInEditor(prompt);
    if (result.content !== null) {
      setPrompt(result.content);
      setCursorOffset(result.content.length);
    }
  }, [prompt]);

  useKeybinding('chat:externalEditor', handleExternalEditor, {
    context: 'Chat',
    isActive: !isGenerating,
  });

  // 非生成状态下按 Esc 时返回上一步
  const handleGoBack = useCallback(() => {
    updateWizardData({
      generationPrompt: '',
      agentType: '',
      systemPrompt: '',
      whenToUse: '',
      generatedAgent: undefined,
      wasGenerated: false,
    });
    setPrompt('');
    setError(null);
    goBack();
  }, [updateWizardData, goBack]);

  // 使用 Settings 上下文，这样按 'n' 键不会触发取消（允许在提示输入中输入字母 'n'）
  useKeybinding('confirm:no', handleGoBack, {
    context: 'Settings',
    isActive: !isGenerating,
  });

  const handleGenerate = async (): Promise<void> => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setError('请描述此 agent 应执行的任务');
      return;
    }

    setError(null);
    setIsGenerating(true);
    updateWizardData({
      generationPrompt: trimmedPrompt,
      isGenerating: true,
    });

    // 为本次生成创建 abort controller
    const controller = createAbortController();
    abortControllerRef.current = controller;

    try {
      const generated = await generateAgent(trimmedPrompt, model, [], controller.signal);

      updateWizardData({
        agentType: generated.identifier,
        whenToUse: generated.whenToUse,
        systemPrompt: generated.systemPrompt,
        generatedAgent: generated,
        isGenerating: false,
        wasGenerated: true,
      });

      // 直接跳转到 ToolsStep（索引 6）- 与原有流程保持一致
      goToStep(6);
    } catch (err) {
      // 如果是用户取消，不显示错误（已在 Esc 处理函数中设置）
      if (err instanceof APIUserAbortError) {
        // 用户取消 - 无需显示错误
      } else if (err instanceof Error && !err.message.includes('No assistant message found')) {
        setError(err.message || '生成 agent 失败');
      }
      updateWizardData({ isGenerating: false });
    } finally {
      setIsGenerating(false);
      abortControllerRef.current = null;
    }
  };

  const subtitle = '描述此 agent 应执行的任务以及何时使用它（描述越详细，效果越好）';

  if (isGenerating) {
    return (
      <WizardDialogLayout
        subtitle={subtitle}
        footerText={
          <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="cancel" />
        }
      >
        <Box flexDirection="row" alignItems="center">
          <Spinner />
          <Text color="suggestion"> 正在根据描述生成 agent...</Text>
        </Box>
      </WizardDialogLayout>
    );
  }

  return (
    <WizardDialogLayout
      subtitle={subtitle}
      footerText={
        <Byline>
          <ConfigurableShortcutHint action="confirm:yes" context="Confirmation" fallback="Enter" description="submit" />
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
        {error && (
          <Box marginBottom={1}>
            <Text color="error">{error}</Text>
          </Box>
        )}
        <TextInput
          value={prompt}
          onChange={setPrompt}
          onSubmit={handleGenerate}
          placeholder="例如，帮我为代码编写单元测试..."
          columns={80}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
          focus
          showCursor
        />
      </Box>
    </WizardDialogLayout>
  );
}
