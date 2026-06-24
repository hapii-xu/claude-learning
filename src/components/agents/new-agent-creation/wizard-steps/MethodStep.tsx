import { type ReactNode } from 'react';
import { Box, Byline, KeyboardShortcutHint } from '@anthropic/ink';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import { Select } from '../../../CustomSelect/select.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import type { AgentWizardData } from '../types.js';

export function MethodStep(): ReactNode {
  const { goNext, goBack, updateWizardData, goToStep } = useWizard<AgentWizardData>();

  const methodOptions = [
    {
      label: '使用 Claude 生成（推荐）',
      value: 'generate',
    },
    {
      label: '手动配置',
      value: 'manual',
    },
  ];

  return (
    <WizardDialogLayout
      subtitle="创建方式"
      footerText={
        <Byline>
          <KeyboardShortcutHint shortcut="↑↓" action="导航" />
          <KeyboardShortcutHint shortcut="Enter" action="选择" />
          <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="返回" />
        </Byline>
      }
    >
      <Box>
        <Select
          key="method-select"
          options={methodOptions}
          onChange={(value: string) => {
            const method = value as 'generate' | 'manual';
            updateWizardData({
              method,
              wasGenerated: method === 'generate',
            });

            // Dynamic navigation based on method
            if (method === 'generate') {
              goNext(); // Go to GenerateStep (index 2)
            } else {
              goToStep(3); // Skip to TypeStep (index 3)
            }
          }}
          onCancel={() => goBack()}
        />
      </Box>
    </WizardDialogLayout>
  );
}
