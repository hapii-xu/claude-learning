import chalk from 'chalk';
import figures from 'figures';
import * as React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { useSetAppState } from 'src/state/AppState.js';
import { type KeyboardEvent, Box, Text } from '@anthropic/ink';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import type { Tools } from '../../Tool.js';
import {
  type AgentColorName,
  setAgentColor,
} from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js';
import {
  type AgentDefinition,
  getActiveAgentsFromList,
  isCustomAgent,
  isPluginAgent,
} from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js';
import { editFileInEditor } from '../../utils/promptEditor.js';
import { getActualAgentFilePath, updateAgentFile } from './agentFileUtils.js';
import { ColorPicker } from './ColorPicker.js';
import { ModelSelector } from './ModelSelector.js';
import { ToolSelector } from './ToolSelector.js';
import { getAgentSourceDisplayName } from './utils.js';

type Props = {
  agent: AgentDefinition;
  tools: Tools;
  onSaved: (message: string) => void;
  onBack: () => void;
};

type EditMode = 'menu' | 'edit-tools' | 'edit-color' | 'edit-model';

type SaveChanges = {
  tools?: string[];
  color?: AgentColorName;
  model?: string;
};

export function AgentEditor({ agent, tools, onSaved, onBack }: Props): React.ReactNode {
  const setAppState = useSetAppState();
  const [editMode, setEditMode] = useState<EditMode>('menu');
  const [selectedMenuIndex, setSelectedMenuIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selectedColor, setSelectedColor] = useState<AgentColorName | undefined>(
    agent.color as AgentColorName | undefined,
  );

  const handleOpenInEditor = useCallback(async () => {
    const filePath = getActualAgentFilePath(agent);
    const result = await editFileInEditor(filePath);

    if (result.error) {
      setError(result.error);
    } else {
      onSaved(`已在编辑器中打开 ${agent.agentType}。如果你做了修改，请重启以加载最新版本。`);
    }
  }, [agent, onSaved]);

  const handleSave = useCallback(
    async (changes: SaveChanges = {}) => {
      const { tools: newTools, color: newColor, model: newModel } = changes;
      const finalColor = newColor ?? selectedColor;
      const hasToolsChanged = newTools !== undefined;
      const hasModelChanged = newModel !== undefined;
      const hasColorChanged = finalColor !== agent.color;

      if (!hasToolsChanged && !hasModelChanged && !hasColorChanged) {
        return false;
      }

      try {
        // 只有自定义/插件 agent 才能被编辑
        // 这是为了类型安全；UI 本身不应允许其他情况下的编辑
        if (!isCustomAgent(agent) && !isPluginAgent(agent)) {
          return false;
        }

        await updateAgentFile(
          agent,
          agent.whenToUse,
          newTools ?? agent.tools,
          agent.getSystemPrompt(),
          finalColor,
          newModel ?? agent.model,
        );

        if (hasColorChanged && finalColor) {
          setAgentColor(agent.agentType, finalColor);
        }

        setAppState(state => {
          const allAgents = state.agentDefinitions.allAgents.map(a =>
            a.agentType === agent.agentType
              ? {
                  ...a,
                  tools: newTools ?? a.tools,
                  color: finalColor,
                  model: newModel ?? a.model,
                }
              : a,
          );
          return {
            ...state,
            agentDefinitions: {
              ...state.agentDefinitions,
              activeAgents: getActiveAgentsFromList(allAgents),
              allAgents,
            },
          };
        });

        onSaved(`已更新 agent：${chalk.bold(agent.agentType)}`);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : '保存 agent 失败');
        return false;
      }
    },
    [agent, selectedColor, onSaved, setAppState],
  );

  const menuItems = useMemo(
    () => [
      { label: '在编辑器中打开', action: handleOpenInEditor },
      { label: '编辑工具', action: () => setEditMode('edit-tools') },
      { label: '编辑模型', action: () => setEditMode('edit-model') },
      { label: '编辑颜色', action: () => setEditMode('edit-color') },
    ],
    [handleOpenInEditor],
  );

  const handleEscape = useCallback(() => {
    setError(null);
    if (editMode === 'menu') {
      onBack();
    } else {
      setEditMode('menu');
    }
  }, [editMode, onBack]);

  const handleMenuKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'up') {
        e.preventDefault();
        setSelectedMenuIndex(index => Math.max(0, index - 1));
      } else if (e.key === 'down') {
        e.preventDefault();
        setSelectedMenuIndex(index => Math.min(menuItems.length - 1, index + 1));
      } else if (e.key === 'return') {
        e.preventDefault();
        const selectedItem = menuItems[selectedMenuIndex];
        if (selectedItem) {
          void selectedItem.action();
        }
      }
    },
    [menuItems, selectedMenuIndex],
  );

  useKeybinding('confirm:no', handleEscape, { context: 'Confirmation' });

  const renderMenu = (): React.ReactNode => (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleMenuKeyDown}>
      <Text dimColor>来源：{getAgentSourceDisplayName(agent.source)}</Text>

      <Box marginTop={1} flexDirection="column">
        {menuItems.map((item, index) => (
          <Text key={item.label} color={index === selectedMenuIndex ? 'suggestion' : undefined}>
            {index === selectedMenuIndex ? `${figures.pointer} ` : '  '}
            {item.label}
          </Text>
        ))}
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="error">{error}</Text>
        </Box>
      )}
    </Box>
  );

  switch (editMode) {
    case 'menu':
      return renderMenu();

    case 'edit-tools':
      return (
        <ToolSelector
          tools={tools}
          initialTools={agent.tools}
          onComplete={async finalTools => {
            setEditMode('menu');
            await handleSave({ tools: finalTools });
          }}
        />
      );

    case 'edit-color':
      return (
        <ColorPicker
          agentName={agent.agentType}
          currentColor={selectedColor || (agent.color as AgentColorName) || 'automatic'}
          onConfirm={async color => {
            setSelectedColor(color);
            setEditMode('menu');
            await handleSave({ color });
          }}
        />
      );

    case 'edit-model':
      return (
        <ModelSelector
          initialModel={agent.model}
          onComplete={async model => {
            setEditMode('menu');
            await handleSave({ model });
          }}
        />
      );

    default:
      return null;
  }
}
