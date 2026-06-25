import figures from 'figures';
import React, { useCallback, useMemo, useState } from 'react';
import { mcpInfoFromString } from 'src/services/mcp/mcpStringUtils.js';
import { isMcpTool } from 'src/services/mcp/utils.js';
import type { Tool, Tools } from 'src/Tool.js';
import { filterToolsForAgent } from '@claude-code-best/builtin-tools/tools/AgentTool/agentToolUtils.js';
import { AGENT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/AgentTool/constants.js';
import { BashTool } from '@claude-code-best/builtin-tools/tools/BashTool/BashTool.js';
import { ExitPlanModeV2Tool } from '@claude-code-best/builtin-tools/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js';
import { FileEditTool } from '@claude-code-best/builtin-tools/tools/FileEditTool/FileEditTool.js';
import { FileReadTool } from '@claude-code-best/builtin-tools/tools/FileReadTool/FileReadTool.js';
import { FileWriteTool } from '@claude-code-best/builtin-tools/tools/FileWriteTool/FileWriteTool.js';
import { GlobTool } from '@claude-code-best/builtin-tools/tools/GlobTool/GlobTool.js';
import { GrepTool } from '@claude-code-best/builtin-tools/tools/GrepTool/GrepTool.js';
import { ListMcpResourcesTool } from '@claude-code-best/builtin-tools/tools/ListMcpResourcesTool/ListMcpResourcesTool.js';
import { NotebookEditTool } from '@claude-code-best/builtin-tools/tools/NotebookEditTool/NotebookEditTool.js';
import { ReadMcpResourceTool } from '@claude-code-best/builtin-tools/tools/ReadMcpResourceTool/ReadMcpResourceTool.js';
import { TaskOutputTool } from '@claude-code-best/builtin-tools/tools/TaskOutputTool/TaskOutputTool.js';
import { TaskStopTool } from '@claude-code-best/builtin-tools/tools/TaskStopTool/TaskStopTool.js';
import { TodoWriteTool } from '@claude-code-best/builtin-tools/tools/TodoWriteTool/TodoWriteTool.js';
import { TungstenTool } from '@claude-code-best/builtin-tools/tools/TungstenTool/TungstenTool.js';
import { WebFetchTool } from '@claude-code-best/builtin-tools/tools/WebFetchTool/WebFetchTool.js';
import { WebSearchTool } from '@claude-code-best/builtin-tools/tools/WebSearchTool/WebSearchTool.js';
import { type KeyboardEvent, Box, Text } from '@anthropic/ink';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { count } from '../../utils/array.js';
import { plural } from '../../utils/stringUtils.js';
import { Divider } from '@anthropic/ink';

type Props = {
  tools: Tools;
  initialTools: string[] | undefined;
  onComplete: (selectedTools: string[] | undefined) => void;
  onCancel?: () => void;
};

type ToolBucket = {
  name: string;
  toolNames: Set<string>;
  isMcp?: boolean;
};

type ToolBuckets = {
  READ_ONLY: ToolBucket;
  EDIT: ToolBucket;
  EXECUTION: ToolBucket;
  MCP: ToolBucket;
  OTHER: ToolBucket;
};

function getToolBuckets(): ToolBuckets {
  return {
    READ_ONLY: {
      name: '只读工具',
      toolNames: new Set([
        GlobTool.name,
        GrepTool.name,
        ExitPlanModeV2Tool.name,
        FileReadTool.name,
        WebFetchTool.name,
        TodoWriteTool.name,
        WebSearchTool.name,
        TaskStopTool.name,
        TaskOutputTool.name,
        ListMcpResourcesTool.name,
        ReadMcpResourceTool.name,
      ]),
    },
    EDIT: {
      name: '编辑工具',
      toolNames: new Set([FileEditTool.name, FileWriteTool.name, NotebookEditTool.name]),
    },
    EXECUTION: {
      name: '执行工具',
      toolNames: new Set(
        [BashTool.name, process.env.USER_TYPE === 'ant' ? TungstenTool.name : undefined].filter(n => n !== undefined),
      ),
    },
    MCP: {
      name: 'MCP 工具',
      toolNames: new Set(), // 动态生成 - 无静态列表
      isMcp: true,
    },
    OTHER: {
      name: '其他工具',
      toolNames: new Set(), // 动态生成 - 用于未分类工具的兜底分组
    },
  };
}

// 辅助函数：动态获取 MCP server 分组
function getMcpServerBuckets(tools: Tools): Array<{
  serverName: string;
  tools: Tools;
}> {
  const serverMap = new Map<string, Tool[]>();

  tools.forEach(tool => {
    if (isMcpTool(tool)) {
      const mcpInfo = mcpInfoFromString(tool.name);
      if (mcpInfo?.serverName) {
        const existing = serverMap.get(mcpInfo.serverName) || [];
        existing.push(tool);
        serverMap.set(mcpInfo.serverName, existing);
      }
    }
  });

  return Array.from(serverMap.entries())
    .map(([serverName, tools]) => ({ serverName, tools }))
    .sort((a, b) => a.serverName.localeCompare(b.serverName));
}

export function ToolSelector({ tools, initialTools, onComplete, onCancel }: Props): React.ReactNode {
  // 为自定义 agent 过滤可用工具
  const customAgentTools = useMemo(() => filterToolsForAgent({ tools, isBuiltIn: false, isAsync: false }), [tools]);

  // 将通配符或 undefined 展开为明确的工具列表，用于内部状态
  const expandedInitialTools =
    !initialTools || initialTools.includes('*') ? customAgentTools.map(t => t.name) : initialTools;

  const [selectedTools, setSelectedTools] = useState<string[]>(expandedInitialTools);
  const [focusIndex, setFocusIndex] = useState(0);
  const [showIndividualTools, setShowIndividualTools] = useState(false);

  // 过滤 selectedTools，仅保留当前仍存在的工具
  // 用于处理选中后断开连接的 MCP 工具
  const validSelectedTools = useMemo(() => {
    const toolNames = new Set(customAgentTools.map(t => t.name));
    return selectedTools.filter(name => toolNames.has(name));
  }, [selectedTools, customAgentTools]);

  const selectedSet = new Set(validSelectedTools);
  const isAllSelected = validSelectedTools.length === customAgentTools.length && customAgentTools.length > 0;

  const handleToggleTool = (toolName: string) => {
    if (!toolName) return;

    setSelectedTools(current =>
      current.includes(toolName) ? current.filter(t => t !== toolName) : [...current, toolName],
    );
  };

  const handleToggleTools = (toolNames: string[], select: boolean) => {
    setSelectedTools(current => {
      if (select) {
        const toolsToAdd = toolNames.filter(t => !current.includes(t));
        return [...current, ...toolsToAdd];
      } else {
        return current.filter(t => !toolNames.includes(t));
      }
    });
  };

  const handleConfirm = () => {
    // 如果选中了全部工具，则转换为 undefined（以便生成更简洁的文件格式）
    const allToolNames = customAgentTools.map(t => t.name);
    const areAllToolsSelected =
      validSelectedTools.length === allToolNames.length &&
      allToolNames.every(name => validSelectedTools.includes(name));
    const finalTools = areAllToolsSelected ? undefined : validSelectedTools;

    onComplete(finalTools);
  };

  // 按分组归类工具
  const toolsByBucket = useMemo(() => {
    const toolBuckets = getToolBuckets();
    const buckets = {
      readOnly: [] as Tool[],
      edit: [] as Tool[],
      execution: [] as Tool[],
      mcp: [] as Tool[],
      other: [] as Tool[],
    };

    customAgentTools.forEach(tool => {
      // 先判断是否为 MCP 工具
      if (isMcpTool(tool)) {
        buckets.mcp.push(tool);
      } else if (toolBuckets.READ_ONLY.toolNames.has(tool.name)) {
        buckets.readOnly.push(tool);
      } else if (toolBuckets.EDIT.toolNames.has(tool.name)) {
        buckets.edit.push(tool);
      } else if (toolBuckets.EXECUTION.toolNames.has(tool.name)) {
        buckets.execution.push(tool);
      } else if (tool.name !== AGENT_TOOL_NAME) {
        // 兜底处理未分类工具（排除 Task）
        buckets.other.push(tool);
      }
    });

    return buckets;
  }, [customAgentTools]);

  const createBucketToggleAction = (bucketTools: Tool[]) => {
    const selected = count(bucketTools, t => selectedSet.has(t.name));
    const needsSelection = selected < bucketTools.length;

    return () => {
      const toolNames = bucketTools.map(t => t.name);
      handleToggleTools(toolNames, needsSelection);
    };
  };

  // 构建可导航的条目列表（无分隔线）
  const navigableItems: Array<{
    id: string;
    label: string;
    action: () => void;
    isContinue?: boolean;
    isToggle?: boolean;
    isHeader?: boolean;
  }> = [];

  // 继续按钮
  navigableItems.push({
    id: 'continue',
    label: '继续',
    action: handleConfirm,
    isContinue: true,
  });

  // 全部工具
  navigableItems.push({
    id: 'bucket-all',
    label: `${isAllSelected ? figures.checkboxOn : figures.checkboxOff} 全部工具`,
    action: () => {
      const allToolNames = customAgentTools.map(t => t.name);
      handleToggleTools(allToolNames, !isAllSelected);
    },
  });

  // 创建分组的菜单条目
  const toolBuckets = getToolBuckets();
  const bucketConfigs = [
    {
      id: 'bucket-readonly',
      name: toolBuckets.READ_ONLY.name,
      tools: toolsByBucket.readOnly,
    },
    {
      id: 'bucket-edit',
      name: toolBuckets.EDIT.name,
      tools: toolsByBucket.edit,
    },
    {
      id: 'bucket-execution',
      name: toolBuckets.EXECUTION.name,
      tools: toolsByBucket.execution,
    },
    {
      id: 'bucket-mcp',
      name: toolBuckets.MCP.name,
      tools: toolsByBucket.mcp,
    },
    {
      id: 'bucket-other',
      name: toolBuckets.OTHER.name,
      tools: toolsByBucket.other,
    },
  ];

  bucketConfigs.forEach(({ id, name, tools: bucketTools }) => {
    if (bucketTools.length === 0) return;

    const selected = count(bucketTools, t => selectedSet.has(t.name));
    const isFullySelected = selected === bucketTools.length;

    navigableItems.push({
      id,
      label: `${isFullySelected ? figures.checkboxOn : figures.checkboxOff} ${name}`,
      action: createBucketToggleAction(bucketTools),
    });
  });

  // 用于展开/折叠单个工具的切换按钮
  const toggleButtonIndex = navigableItems.length;
  navigableItems.push({
    id: 'toggle-individual',
    label: showIndividualTools ? '隐藏高级选项' : '显示高级选项',
    action: () => {
      setShowIndividualTools(!showIndividualTools);
      // 若在折叠工具时焦点位于某个单独工具上，则将焦点移到切换按钮
      if (showIndividualTools && focusIndex > toggleButtonIndex) {
        setFocusIndex(toggleButtonIndex);
      }
    },
    isToggle: true,
  });

  // 对 MCP server 分组做 memoize（必须放在条件外，以满足 hooks 规则）
  const mcpServerBuckets = useMemo(() => getMcpServerBuckets(customAgentTools), [customAgentTools]);

  // 单个工具（仅在展开时显示）
  if (showIndividualTools) {
    // 如果存在 MCP server 分组则加入
    if (mcpServerBuckets.length > 0) {
      navigableItems.push({
        id: 'mcp-servers-header',
        label: 'MCP Servers：',
        action: () => {}, // 无操作 - 仅作为标题
        isHeader: true,
      });

      mcpServerBuckets.forEach(({ serverName, tools: serverTools }) => {
        const selected = count(serverTools, t => selectedSet.has(t.name));
        const isFullySelected = selected === serverTools.length;

        navigableItems.push({
          id: `mcp-server-${serverName}`,
          label: `${isFullySelected ? figures.checkboxOn : figures.checkboxOff} ${serverName}（${serverTools.length} 个${plural(serverTools.length, '工具')}）`,
          action: () => {
            const toolNames = serverTools.map(t => t.name);
            handleToggleTools(toolNames, !isFullySelected);
          },
        });
      });

      // 在单个工具前加入分隔标题
      navigableItems.push({
        id: 'tools-header',
        label: '单个工具：',
        action: () => {},
        isHeader: true,
      });
    }

    // 加入单个工具
    customAgentTools.forEach(tool => {
      let displayName = tool.name;
      if (tool.name.startsWith('mcp__')) {
        const mcpInfo = mcpInfoFromString(tool.name);
        displayName = mcpInfo ? `${mcpInfo.toolName} (${mcpInfo.serverName})` : tool.name;
      }

      navigableItems.push({
        id: `tool-${tool.name}`,
        label: `${selectedSet.has(tool.name) ? figures.checkboxOn : figures.checkboxOff} ${displayName}`,
        action: () => handleToggleTool(tool.name),
      });
    });
  }

  const handleCancel = useCallback(() => {
    if (onCancel) {
      onCancel();
    } else {
      onComplete(initialTools);
    }
  }, [onCancel, onComplete, initialTools]);

  useKeybinding('confirm:no', handleCancel, { context: 'Confirmation' });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'return') {
      e.preventDefault();
      const item = navigableItems[focusIndex];
      if (item && !item.isHeader) {
        item.action();
      }
    } else if (e.key === 'up') {
      e.preventDefault();
      let newIndex = focusIndex - 1;
      // 向上导航时跳过标题
      while (newIndex > 0 && navigableItems[newIndex]?.isHeader) {
        newIndex--;
      }
      setFocusIndex(Math.max(0, newIndex));
    } else if (e.key === 'down') {
      e.preventDefault();
      let newIndex = focusIndex + 1;
      // 向下导航时跳过标题
      while (newIndex < navigableItems.length - 1 && navigableItems[newIndex]?.isHeader) {
        newIndex++;
      }
      setFocusIndex(Math.min(navigableItems.length - 1, newIndex));
    }
  };

  return (
    <Box flexDirection="column" marginTop={1} tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      {/* 渲染「继续」按钮 */}
      <Text color={focusIndex === 0 ? 'suggestion' : undefined} bold={focusIndex === 0}>
        {focusIndex === 0 ? `${figures.pointer} ` : '  '}[ 继续 ]
      </Text>

      {/* 分隔线 */}
      <Divider width={40} />

      {/* 渲染除「继续」（位于索引 0）以外的所有可导航条目 */}
      {navigableItems.slice(1).map((item, index) => {
        const isCurrentlyFocused = index + 1 === focusIndex;
        const isToggleButton = item.isToggle;
        const isHeader = item.isHeader;

        return (
          <React.Fragment key={item.id}>
            {/* 在切换按钮前添加分隔线 */}
            {isToggleButton && <Divider width={40} />}

            {/* 在标题前添加外边距 */}
            {isHeader && index > 0 && <Box marginTop={1} />}

            <Text
              color={isHeader ? undefined : isCurrentlyFocused ? 'suggestion' : undefined}
              dimColor={isHeader}
              bold={isToggleButton && isCurrentlyFocused}
            >
              {isHeader ? '' : isCurrentlyFocused ? `${figures.pointer} ` : '  '}
              {isToggleButton ? `[ ${item.label} ]` : item.label}
            </Text>
          </React.Fragment>
        );
      })}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          {isAllSelected ? '已选中全部工具' : `已选中 ${selectedSet.size} / ${customAgentTools.length} 个工具`}
        </Text>
      </Box>
    </Box>
  );
}
