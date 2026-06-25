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

  // 构建选项，将推荐的默认值放在最前，然后是其他备选项
  // 推荐的作用域与 agent 位置对应（项目 agent → 项目记忆，用户 agent → 用户记忆）
  const memoryOptions: MemoryOption[] = isUserScope
    ? [
        {
          label: '用户作用域（~/.hclaude/agent-memory/）（推荐）',
          value: 'user',
        },
        { label: '无（不使用持久化记忆）', value: 'none' },
        { label: '项目作用域（.hclaude/agent-memory/）', value: 'project' },
        { label: '本地作用域（.hclaude/agent-memory-local/）', value: 'local' },
      ]
    : [
        {
          label: '项目作用域（.hclaude/agent-memory/）（推荐）',
          value: 'project',
        },
        { label: '无（不使用持久化记忆）', value: 'none' },
        { label: '用户作用域（~/.hclaude/agent-memory/）', value: 'user' },
        { label: '本地作用域（.hclaude/agent-memory-local/）', value: 'local' },
      ];

  const handleSelect = (value: string): void => {
    const memory = value === 'none' ? undefined : (value as AgentMemoryScope);
    const agentType = wizardData.finalAgent?.agentType;
    updateWizardData({
      selectedMemory: memory,
      // 更新 finalAgent 中的 memory，并重写 getSystemPrompt 以包含记忆加载逻辑。
      // 显式设置 memory（不使用条件展开），这样在返回后选择「无」即可清空记忆。
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
      subtitle="配置 agent 记忆"
      footerText={
        <Byline>
          <KeyboardShortcutHint shortcut="↑↓" action="navigate" />
          <KeyboardShortcutHint shortcut="Enter" action="select" />
          <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" />
        </Byline>
      }
    >
      <Box>
        <Select key="memory-select" options={memoryOptions} onChange={handleSelect} onCancel={goBack} />
      </Box>
    </WizardDialogLayout>
  );
}
