import figures from 'figures';
import * as React from 'react';
import type { SettingSource } from 'src/utils/settings/constants.js';
import { type KeyboardEvent, Box, Text } from '@anthropic/ink';
import type { ResolvedAgent } from '@claude-code-best/builtin-tools/tools/AgentTool/agentDisplay.js';
import {
  AGENT_SOURCE_GROUPS,
  compareAgentsByName,
  getOverrideSourceLabel,
  resolveAgentModelDisplay,
} from '@claude-code-best/builtin-tools/tools/AgentTool/agentDisplay.js';
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js';
import { count } from '../../utils/array.js';
import { Dialog, Divider } from '@anthropic/ink';
import { getAgentSourceDisplayName } from './utils.js';

type Props = {
  source: SettingSource | 'all' | 'built-in' | 'plugin';
  agents: ResolvedAgent[];
  onBack: () => void;
  onSelect: (agent: AgentDefinition) => void;
  onCreateNew?: () => void;
  changes?: string[];
};

export function AgentsList({ source, agents, onBack, onSelect, onCreateNew, changes }: Props): React.ReactNode {
  const [selectedAgent, setSelectedAgent] = React.useState<ResolvedAgent | null>(null);
  const [isCreateNewSelected, setIsCreateNewSelected] = React.useState(true);

  // 在每个来源分组内按名称字母序排序
  const sortedAgents = React.useMemo(() => [...agents].sort(compareAgentsByName), [agents]);

  const getOverrideInfo = (agent: ResolvedAgent) => {
    return {
      isOverridden: !!agent.overriddenBy,
      overriddenBy: agent.overriddenBy || null,
    };
  };

  const renderCreateNewOption = () => {
    return (
      <Box>
        <Text color={isCreateNewSelected ? 'suggestion' : undefined}>
          {isCreateNewSelected ? `${figures.pointer} ` : '  '}
        </Text>
        <Text color={isCreateNewSelected ? 'suggestion' : undefined}>创建新 agent</Text>
      </Box>
    );
  };

  const renderAgent = (agent: ResolvedAgent) => {
    const isBuiltIn = agent.source === 'built-in';
    const isSelected =
      !isBuiltIn &&
      !isCreateNewSelected &&
      selectedAgent?.agentType === agent.agentType &&
      selectedAgent?.source === agent.source;

    const { isOverridden, overriddenBy } = getOverrideInfo(agent);
    const dimmed = isBuiltIn || isOverridden;
    const textColor = !isBuiltIn && isSelected ? 'suggestion' : undefined;

    const resolvedModel = resolveAgentModelDisplay(agent);

    return (
      <Box key={`${agent.agentType}-${agent.source}`}>
        <Text dimColor={dimmed && !isSelected} color={textColor}>
          {isBuiltIn ? '' : isSelected ? `${figures.pointer} ` : '  '}
        </Text>
        <Text dimColor={dimmed && !isSelected} color={textColor}>
          {agent.agentType}
        </Text>
        {resolvedModel && (
          <Text dimColor={true} color={textColor}>
            {' · '}
            {resolvedModel}
          </Text>
        )}
        {agent.memory && (
          <Text dimColor={true} color={textColor}>
            {' · '}
            {agent.memory} 记忆
          </Text>
        )}
        {overriddenBy && (
          <Text dimColor={!isSelected} color={isSelected ? 'warning' : undefined}>
            {' '}
            {figures.warning} 被 {getOverrideSourceLabel(overriddenBy)} 覆盖
          </Text>
        )}
      </Box>
    );
  };

  const selectableAgentsInOrder = React.useMemo(() => {
    const nonBuiltIn = sortedAgents.filter(a => a.source !== 'built-in');
    if (source === 'all') {
      return AGENT_SOURCE_GROUPS.filter(g => g.source !== 'built-in').flatMap(({ source: groupSource }) =>
        nonBuiltIn.filter(a => a.source === groupSource),
      );
    }
    return nonBuiltIn;
  }, [sortedAgents, source]);

  // 设置初始选中项
  React.useEffect(() => {
    if (!selectedAgent && !isCreateNewSelected && selectableAgentsInOrder.length > 0) {
      if (onCreateNew) {
        setIsCreateNewSelected(true);
      } else {
        setSelectedAgent(selectableAgentsInOrder[0] || null);
      }
    }
  }, [selectableAgentsInOrder, selectedAgent, isCreateNewSelected, onCreateNew]);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'return') {
      e.preventDefault();
      if (isCreateNewSelected && onCreateNew) {
        onCreateNew();
      } else if (selectedAgent) {
        onSelect(selectedAgent);
      }
      return;
    }

    if (e.key !== 'up' && e.key !== 'down') return;
    e.preventDefault();

    // 处理带「创建新 agent」选项的导航
    const hasCreateOption = !!onCreateNew;
    const totalItems = selectableAgentsInOrder.length + (hasCreateOption ? 1 : 0);

    if (totalItems === 0) return;

    // 计算在列表中的当前位置（0 = 创建新，1+ = 各 agent）
    let currentPosition = 0;
    if (!isCreateNewSelected && selectedAgent) {
      const agentIndex = selectableAgentsInOrder.findIndex(
        a => a.agentType === selectedAgent.agentType && a.source === selectedAgent.source,
      );
      if (agentIndex >= 0) {
        currentPosition = hasCreateOption ? agentIndex + 1 : agentIndex;
      }
    }

    // 计算新位置（循环切换）
    const newPosition =
      e.key === 'up'
        ? currentPosition === 0
          ? totalItems - 1
          : currentPosition - 1
        : currentPosition === totalItems - 1
          ? 0
          : currentPosition + 1;

    // 根据新位置更新选中项
    if (hasCreateOption && newPosition === 0) {
      setIsCreateNewSelected(true);
      setSelectedAgent(null);
    } else {
      const agentIndex = hasCreateOption ? newPosition - 1 : newPosition;
      const newAgent = selectableAgentsInOrder[agentIndex];
      if (newAgent) {
        setIsCreateNewSelected(false);
        setSelectedAgent(newAgent);
      }
    }
  };

  const renderBuiltInAgentsSection = (title = '内置（始终可用）：') => {
    const builtInAgents = sortedAgents.filter(a => a.source === 'built-in');
    return (
      <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
        <Text bold dimColor>
          {title}
        </Text>
        {builtInAgents.map(renderAgent)}
      </Box>
    );
  };

  const renderAgentGroup = (title: string, groupAgents: ResolvedAgent[]) => {
    if (!groupAgents.length) return null;

    const folderPath = groupAgents[0]?.baseDir;

    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box paddingLeft={2}>
          <Text bold dimColor>
            {title}
          </Text>
          {folderPath && <Text dimColor> ({folderPath})</Text>}
        </Box>
        {groupAgents.map(agent => renderAgent(agent))}
      </Box>
    );
  };

  const sourceTitle = getAgentSourceDisplayName(source);

  const builtInAgents = sortedAgents.filter(a => a.source === 'built-in');

  const hasNoAgents =
    !sortedAgents.length || (source !== 'built-in' && !sortedAgents.some(a => a.source !== 'built-in'));

  if (hasNoAgents) {
    return (
      <Dialog title={sourceTitle} subtitle="未找到 agent" onCancel={onBack} hideInputGuide>
        <Box flexDirection="column" gap={1} tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
          {onCreateNew && <Box>{renderCreateNewOption()}</Box>}
          <Text dimColor>未找到 agent。可以创建 Claude 可委派任务的专用子 agent。</Text>
          <Text dimColor>每个子 agent 都拥有独立的上下文窗口、自定义系统提示词和专用工具。</Text>
          <Text dimColor>试试创建：代码审查员、代码简化员、安全审查员、技术负责人或 UX 审查员。</Text>
          {source !== 'built-in' && sortedAgents.some(a => a.source === 'built-in') && (
            <>
              <Divider />
              {renderBuiltInAgentsSection()}
            </>
          )}
        </Box>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={sourceTitle}
      subtitle={`${count(sortedAgents, a => !a.overriddenBy)} 个 agent`}
      onCancel={onBack}
      hideInputGuide
    >
      {changes && changes.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor>{changes[changes.length - 1]}</Text>
        </Box>
      )}
      <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
        {onCreateNew && <Box marginBottom={1}>{renderCreateNewOption()}</Box>}
        {source === 'all' ? (
          <>
            {AGENT_SOURCE_GROUPS.filter(g => g.source !== 'built-in').map(({ label, source: groupSource }) => (
              <React.Fragment key={groupSource}>
                {renderAgentGroup(
                  label,
                  sortedAgents.filter(a => a.source === groupSource),
                )}
              </React.Fragment>
            ))}
            {builtInAgents.length > 0 && (
              <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
                <Text dimColor>
                  <Text bold>内置 agent</Text>（始终可用）
                </Text>
                {builtInAgents.map(renderAgent)}
              </Box>
            )}
          </>
        ) : source === 'built-in' ? (
          <>
            <Text dimColor italic>
              内置 agent 为默认提供，无法修改。
            </Text>
            <Box marginTop={1} flexDirection="column">
              {sortedAgents.map(agent => renderAgent(agent))}
            </Box>
          </>
        ) : (
          <>
            {sortedAgents.filter(a => a.source !== 'built-in').map(agent => renderAgent(agent))}
            {sortedAgents.some(a => a.source === 'built-in') && (
              <>
                <Divider />
                {renderBuiltInAgentsSection()}
              </>
            )}
          </>
        )}
      </Box>
    </Dialog>
  );
}
