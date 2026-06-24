import { type ReactNode } from 'react';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import { Byline, KeyboardShortcutHint } from '@anthropic/ink';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import { ModelSelector } from '../../ModelSelector.js';
import type { AgentWizardData } from '../types.js';

export function ModelStep(): ReactNode {
  const { goNext, goBack, updateWizardData, wizardData } = useWizard<AgentWizardData>();

  const handleComplete = (model?: string): void => {
    updateWizardData({ selectedModel: model });
    goNext();
  };

  return (
    <WizardDialogLayout
      subtitle="选择模型"
      footerText={
        <Byline>
          <KeyboardShortcutHint shortcut="↑↓" action="导航" />
          <KeyboardShortcutHint shortcut="Enter" action="选择" />
          <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="返回" />
        </Byline>
      }
    >
      <ModelSelector initialModel={wizardData.selectedModel} onComplete={handleComplete} onCancel={goBack} />
    </WizardDialogLayout>
  );
}
