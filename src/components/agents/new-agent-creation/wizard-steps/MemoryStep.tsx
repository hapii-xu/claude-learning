import { type ReactNode } from 'react';
import { Box, Byline, KeyboardShortcutHint } from '@anthropic/ink';
import { useKeybinding } from '../../../../keybindings/useKeybinding.js';
import { isAutoMemoryEnabled } from '../../../../memdir/paths.js';
import {
  type AgentMemoryScope,
  loadAgentMemoryPrompt,
} from '@claude-code-best/builtin-tools/tools/AgentTool/agentMemory.js';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import { Select } from '../../../CustomSelect/select.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import type { AgentWizardData } from '../types.js';

type MemoryOption = {
  label: string;
  value: AgentMemoryScope | 'none';
};

export function MemoryStep(): ReactNode {
  const { goNext, goBack, updateWizardData, wizardData } = useWizard<AgentWizardData>();

  useKeybinding('confirm:no', goBack, { context: 'Confirmation' });

  const isUserScope = wizardData.location === 'userSettings';

  // Build options with the recommended default first, then alternatives
  // The recommended scope matches the agent's location (project agent → project memory, user agent → user memory)
  const memoryOptions: MemoryOption[] = isUserScope
    ? [
        {
          label: '用户级别 (~/.hclaude/agent-memory/)（推荐）',
          value: 'user',
        },
        { label: '无（不使用持久化记忆）', value: 'none' },
        { label: '项目级别 (.hclaude/agent-memory/)', value: 'project' },
        { label: '本地级别 (.hclaude/agent-memory-local/)', value: 'local' },
      ]
    : [
        {
          label: '项目级别 (.hclaude/agent-memory/)（推荐）',
          value: 'project',
        },
        { label: '无（不使用持久化记忆）', value: 'none' },
        { label: '用户级别 (~/.hclaude/agent-memory/)', value: 'user' },
        { label: '本地级别 (.hclaude/agent-memory-local/)', value: 'local' },
      ];

  const handleSelect = (value: string): void => {
    const memory = value === 'none' ? undefined : (value as AgentMemoryScope);
    const agentType = wizardData.finalAgent?.agentType;
    updateWizardData({
      selectedMemory: memory,
      // Update finalAgent with memory and rewire getSystemPrompt to include memory loading.
      // Explicitly set memory (not conditional spread) so selecting 'none' after going back clears it.
      finalAgent: wizardData.finalAgent
        ? {
            ...wizardData.finalAgent,
            memory,
            getSystemPrompt:
              isAutoMemoryEnabled() && memory && agentType
                ? () => wizardData.systemPrompt! + '\n\n' + loadAgentMemoryPrompt(agentType, memory)
                : () => wizardData.systemPrompt!,
          }
        : undefined,
    });
    goNext();
  };

  return (
    <WizardDialogLayout
      subtitle="配置 Agent 记忆"
      footerText={
        <Byline>
          <KeyboardShortcutHint shortcut="↑↓" action="导航" />
          <KeyboardShortcutHint shortcut="Enter" action="选择" />
          <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="返回" />
        </Byline>
      }
    >
      <Box>
        <Select key="memory-select" options={memoryOptions} onChange={handleSelect} onCancel={goBack} />
      </Box>
    </WizardDialogLayout>
  );
}
