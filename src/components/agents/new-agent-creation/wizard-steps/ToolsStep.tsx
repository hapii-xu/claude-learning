import { type ReactNode } from 'react';
import type { Tools } from '../../../../Tool.js';
import { Byline, KeyboardShortcutHint } from '@anthropic/ink';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import { ToolSelector } from '../../ToolSelector.js';
import type { AgentWizardData } from '../types.js';

type Props = {
  tools: Tools;
};

export function ToolsStep({ tools }: Props): ReactNode {
  const { goNext, goBack, updateWizardData, wizardData } = useWizard<AgentWizardData>();

  const handleComplete = (selectedTools: string[] | undefined): void => {
    updateWizardData({ selectedTools });
    goNext();
  };

  // 透传 undefined 以保留「全部工具」的语义
  // ToolSelector 会在内部将其展开以供展示
  const initialTools = wizardData.selectedTools;

  return (
    <WizardDialogLayout
      subtitle="选择工具"
      footerText={
        <Byline>
          <KeyboardShortcutHint shortcut="Enter" action="toggle selection" />
          <KeyboardShortcutHint shortcut="↑↓" action="navigate" />
          <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" />
        </Byline>
      }
    >
      <ToolSelector tools={tools} initialTools={initialTools} onComplete={handleComplete} onCancel={goBack} />
    </WizardDialogLayout>
  );
}
