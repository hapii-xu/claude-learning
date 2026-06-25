import React, { useCallback, useState } from 'react';
import type { Workflow } from '../commands/install-github-app/types.js';
import type { ExitState } from '../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Link, Text, Byline, Dialog, KeyboardShortcutHint } from '@anthropic/ink';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { SelectMulti } from './CustomSelect/SelectMulti.js';

type WorkflowOption = {
  value: Workflow;
  label: string;
};

type Props = {
  onSubmit: (selectedWorkflows: Workflow[]) => void;
  defaultSelections: Workflow[];
};

const WORKFLOWS: WorkflowOption[] = [
  {
    value: 'claude' as const,
    label: '@Claude Code —— 在 issue 和 PR 评论中 @claude',
  },
  {
    value: 'claude-review' as const,
    label: 'Claude Code Review —— 对新 PR 进行自动化代码审查',
  },
];

function renderInputGuide(exitState: ExitState): React.ReactNode {
  if (exitState.pending) {
    return <Text>再按一次 {exitState.keyName} 退出</Text>;
  }
  return (
    <Byline>
      <KeyboardShortcutHint shortcut="↑↓" action="navigate" />
      <KeyboardShortcutHint shortcut="Space" action="toggle" />
      <KeyboardShortcutHint shortcut="Enter" action="confirm" />
      <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />
    </Byline>
  );
}

export function WorkflowMultiselectDialog({ onSubmit, defaultSelections }: Props): React.ReactNode {
  const [showError, setShowError] = useState(false);

  const handleSubmit = useCallback(
    (selectedValues: Workflow[]) => {
      if (selectedValues.length === 0) {
        setShowError(true);
        return;
      }
      setShowError(false);
      onSubmit(selectedValues);
    },
    [onSubmit],
  );

  const handleChange = useCallback(() => {
    setShowError(false);
  }, []);

  // 取消时仅显示错误 —— 用户必须至少选择一个 workflow
  const handleCancel = useCallback(() => {
    setShowError(true);
  }, []);

  return (
    <Dialog
      title="选择要安装的 GitHub workflow"
      subtitle="我们会为你选择的每一个 workflow 在你的仓库中创建一个 workflow 文件。"
      onCancel={handleCancel}
      inputGuide={renderInputGuide}
    >
      <Box>
        <Text dimColor>
          更多 workflow 示例（issue 分诊、CI 修复等）请见：{' '}
          <Link url="https://github.com/anthropics/claude-code-action/blob/main/examples/">
            https://github.com/anthropics/claude-code-action/blob/main/examples/
          </Link>
        </Text>
      </Box>

      <SelectMulti
        options={WORKFLOWS.map(workflow => ({
          label: workflow.label,
          value: workflow.value,
        }))}
        defaultValue={defaultSelections}
        onSubmit={handleSubmit}
        onChange={handleChange}
        onCancel={handleCancel}
        hideIndexes
      />

      {showError && (
        <Box>
          <Text color="error">必须至少选择一个 workflow 才能继续</Text>
        </Box>
      )}
    </Dialog>
  );
}
