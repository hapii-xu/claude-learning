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
      label: '由 Claude 生成（推荐）',
      value: 'generate',
    },
    {
      label: '手动配置',
      value: 'manual',
    },
  ];

  return (
    <WizardDialogLayout
      subtitle="选择创建方式"
      footerText={
        <Byline>
          <KeyboardShortcutHint shortcut="↑↓" action="navigate" />
          <KeyboardShortcutHint shortcut="Enter" action="select" />
          <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" />
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

            // 根据选择的方式进行动态导航
            if (method === 'generate') {
              goNext(); // 前往 GenerateStep（索引 2）
            } else {
              goToStep(3); // 跳转到 TypeStep（索引 3）
            }
          }}
          onCancel={() => goBack()}
        />
      </Box>
    </WizardDialogLayout>
  );
}
