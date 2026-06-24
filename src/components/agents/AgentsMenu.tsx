import chalk from 'chalk';
import * as React from 'react';
import { useCallback, useMemo, useState } from 'react';
import type { SettingSource } from 'src/utils/settings/constants.js';
import type { CommandResultDisplay } from '../../commands.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { useMergedTools } from '../../hooks/useMergedTools.js';
import { Box, Text } from '@anthropic/ink';
import { useAppState, useSetAppState } from '../../state/AppState.js';
import type { Tools } from '../../Tool.js';
import {
  type ResolvedAgent,
  resolveAgentOverrides,
} from '@claude-code-best/builtin-tools/tools/AgentTool/agentDisplay.js';
import {
  type AgentDefinition,
  getActiveAgentsFromList,
} from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js';
import { toError } from '../../utils/errors.js';
import { logError } from '../../utils/log.js';
import { Select } from '../CustomSelect/select.js';
import { Dialog } from '@anthropic/ink';
import { AgentDetail } from './AgentDetail.js';
import { AgentEditor } from './AgentEditor.js';
import { AgentNavigationFooter } from './AgentNavigationFooter.js';
import { AgentsList } from './AgentsList.js';
import { deleteAgentFromFile } from './agentFileUtils.js';
import { CreateAgentWizard } from './new-agent-creation/CreateAgentWizard.js';
import type { ModeState } from './types.js';

type Props = {
  tools: Tools;
  onExit: (result?: string, options?: { display?: CommandResultDisplay }) => void;
};

export function AgentsMenu({ tools, onExit }: Props): React.ReactNode {
  const [modeState, setModeState] = useState<ModeState>({
    mode: 'list-agents',
    source: 'all',
  });
  const agentDefinitions = useAppState(s => s.agentDefinitions);
  const mcpTools = useAppState(s => s.mcp.tools);
  const toolPermissionContext = useAppState(s => s.toolPermissionContext);
  const setAppState = useSetAppState();
  const { allAgents, activeAgents: agents } = agentDefinitions;
  const [changes, setChanges] = useState<string[]>([]);

  // Get MCP tools from app state and merge with local tools
  const mergedTools = useMergedTools(tools, mcpTools, toolPermissionContext);

  useExitOnCtrlCDWithKeybindings();

  const agentsBySource: Record<SettingSource | 'all' | 'built-in' | 'plugin', AgentDefinition[]> = useMemo(
    () => ({
      'built-in': allAgents.filter(a => a.source === 'built-in'),
      userSettings: allAgents.filter(a => a.source === 'userSettings'),
      projectSettings: allAgents.filter(a => a.source === 'projectSettings'),
      policySettings: allAgents.filter(a => a.source === 'policySettings'),
      localSettings: allAgents.filter(a => a.source === 'localSettings'),
      flagSettings: allAgents.filter(a => a.source === 'flagSettings'),
      plugin: allAgents.filter(a => a.source === 'plugin'),
      all: allAgents,
    }),
    [allAgents],
  );

  const handleAgentCreated = useCallback((message: string) => {
    setChanges(prev => [...prev, message]);
    setModeState({ mode: 'list-agents', source: 'all' });
  }, []);

  const handleAgentDeleted = useCallback(
    async (agent: AgentDefinition) => {
      try {
        await deleteAgentFromFile(agent);
        setAppState(state => {
          const allAgents = state.agentDefinitions.allAgents.filter(
            a => !(a.agentType === agent.agentType && a.source === agent.source),
          );
          return {
            ...state,
            agentDefinitions: {
              ...state.agentDefinitions,
              allAgents,
              activeAgents: getActiveAgentsFromList(allAgents),
            },
          };
        });

        setChanges(prev => [...prev, `已删除 Agent：${chalk.bold(agent.agentType)}`]);
        // Go back to the agents list after deletion
        setModeState({ mode: 'list-agents', source: 'all' });
      } catch (error) {
        logError(toError(error));
      }
    },
    [setAppState],
  );

  // Render based on mode
  switch (modeState.mode) {
    case 'list-agents': {
      const agentsToShow =
        modeState.source === 'all'
          ? [
              ...agentsBySource['built-in'],
              ...agentsBySource['userSettings'],
              ...agentsBySource['projectSettings'],
              ...agentsBySource['localSettings'],
              ...agentsBySource['policySettings'],
              ...agentsBySource['flagSettings'],
              ...agentsBySource['plugin'],
            ]
          : agentsBySource[modeState.source];

      // Resolve overrides and filter to the agents we want to show
      const allResolved = resolveAgentOverrides(agentsToShow, agents);
      const resolvedAgents: ResolvedAgent[] = allResolved;

      return (
        <>
          <AgentsList
            source={modeState.source}
            agents={resolvedAgents}
            onBack={() => {
              const exitMessage = changes.length > 0 ? `Agent changes:\n${changes.join('\n')}` : undefined;
              onExit(exitMessage ?? 'Agents dialog dismissed', {
                display: changes.length === 0 ? 'system' : undefined,
              });
            }}
            onSelect={agent =>
              setModeState({
                mode: 'agent-menu',
                agent,
                previousMode: modeState,
              })
            }
            onCreateNew={() => setModeState({ mode: 'create-agent' })}
            changes={changes}
          />
          <AgentNavigationFooter />
        </>
      );
    }

    case 'create-agent':
      return (
        <CreateAgentWizard
          tools={mergedTools}
          existingAgents={agents}
          onComplete={handleAgentCreated}
          onCancel={() => setModeState({ mode: 'list-agents', source: 'all' })}
        />
      );

    case 'agent-menu': {
      // Always use fresh agent data
      const freshAgent = allAgents.find(
        a => a.agentType === modeState.agent.agentType && a.source === modeState.agent.source,
      );
      const agentToUse = freshAgent || modeState.agent;

      const isEditable =
        agentToUse.source !== 'built-in' && agentToUse.source !== 'plugin' && agentToUse.source !== 'flagSettings';
      const menuItems = [
        { label: '查看 Agent', value: 'view' },
        ...(isEditable
          ? [
              { label: '编辑 Agent', value: 'edit' },
              { label: '删除 Agent', value: 'delete' },
            ]
          : []),
        { label: '返回', value: 'back' },
      ];

      const handleMenuSelect = (value: string): void => {
        switch (value) {
          case 'view':
            setModeState({
              mode: 'view-agent',
              agent: agentToUse,
              previousMode: modeState.previousMode,
            });
            break;
          case 'edit':
            setModeState({
              mode: 'edit-agent',
              agent: agentToUse,
              previousMode: modeState,
            });
            break;
          case 'delete':
            setModeState({
              mode: 'delete-confirm',
              agent: agentToUse,
              previousMode: modeState,
            });
            break;
          case 'back':
            setModeState(modeState.previousMode);
            break;
        }
      };

      return (
        <>
          <Dialog
            title={modeState.agent.agentType}
            onCancel={() => setModeState(modeState.previousMode)}
            hideInputGuide
          >
            <Box flexDirection="column">
              <Select
                options={menuItems}
                onChange={handleMenuSelect}
                onCancel={() => setModeState(modeState.previousMode)}
              />
              {changes.length > 0 && (
                <Box marginTop={1}>
                  <Text dimColor>{changes[changes.length - 1]}</Text>
                </Box>
              )}
            </Box>
          </Dialog>
          <AgentNavigationFooter />
        </>
      );
    }

    case 'view-agent': {
      // Always use fresh agent data from allAgents
      const freshAgent = allAgents.find(
        a => a.agentType === modeState.agent.agentType && a.source === modeState.agent.source,
      );
      const agentToDisplay = freshAgent || modeState.agent;

      return (
        <>
          <Dialog
            title={agentToDisplay.agentType}
            onCancel={() =>
              setModeState({
                mode: 'agent-menu',
                agent: agentToDisplay,
                previousMode: modeState.previousMode,
              })
            }
            hideInputGuide
          >
            <AgentDetail
              agent={agentToDisplay}
              tools={mergedTools}
              allAgents={allAgents}
              onBack={() =>
                setModeState({
                  mode: 'agent-menu',
                  agent: agentToDisplay,
                  previousMode: modeState.previousMode,
                })
              }
            />
          </Dialog>
          <AgentNavigationFooter instructions="按 Enter 或 Esc 返回" />
        </>
      );
    }

    case 'delete-confirm': {
      const deleteOptions = [
        { label: '是，删除', value: 'yes' },
        { label: '否，取消', value: 'no' },
      ];

      return (
        <>
          <Dialog
            title="删除 Agent"
            onCancel={() => {
              if ('previousMode' in modeState) setModeState(modeState.previousMode);
            }}
            color="error"
          >
            <Text>
              确定要删除 Agent <Text bold>{modeState.agent.agentType}</Text> 吗？
            </Text>
            <Box marginTop={1}>
              <Text dimColor>来源：{modeState.agent.source}</Text>
            </Box>
            <Box marginTop={1}>
              <Select
                options={deleteOptions}
                onChange={(value: string) => {
                  if (value === 'yes') {
                    void handleAgentDeleted(modeState.agent);
                  } else {
                    if ('previousMode' in modeState) {
                      setModeState(modeState.previousMode);
                    }
                  }
                }}
                onCancel={() => {
                  if ('previousMode' in modeState) {
                    setModeState(modeState.previousMode);
                  }
                }}
              />
            </Box>
          </Dialog>
          <AgentNavigationFooter instructions="按 ↑↓ 导航 · Enter 选择 · Esc 取消" />
        </>
      );
    }

    case 'edit-agent': {
      // Always use fresh agent data
      const freshAgent = allAgents.find(
        a => a.agentType === modeState.agent.agentType && a.source === modeState.agent.source,
      );
      const agentToEdit = freshAgent || modeState.agent;

      return (
        <>
          <Dialog
            title={`编辑 Agent：${agentToEdit.agentType}`}
            onCancel={() => setModeState(modeState.previousMode)}
            hideInputGuide
          >
            <AgentEditor
              agent={agentToEdit}
              tools={mergedTools}
              onSaved={message => {
                handleAgentCreated(message);
                setModeState(modeState.previousMode);
              }}
              onBack={() => setModeState(modeState.previousMode)}
            />
          </Dialog>
          <AgentNavigationFooter />
        </>
      );
    }

    default:
      return null;
  }
}
