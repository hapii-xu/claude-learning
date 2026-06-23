import figures from 'figures';
import type { Dirent } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js';
import { Byline } from '@anthropic/ink';
import { MCPRemoteServerMenu } from '../../components/mcp/MCPRemoteServerMenu.js';
import { MCPStdioServerMenu } from '../../components/mcp/MCPStdioServerMenu.js';
import { MCPToolDetailView } from '../../components/mcp/MCPToolDetailView.js';
import { MCPToolListView } from '../../components/mcp/MCPToolListView.js';
import type { ClaudeAIServerInfo, HTTPServerInfo, SSEServerInfo, StdioServerInfo } from '../../components/mcp/types.js';
import { SearchBox } from '../../components/SearchBox.js';
import { useSearchInput } from '../../hooks/useSearchInput.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- 搜索模式需要 useInput 来接收原始文本输入
import { Box, Text, useInput, useTerminalFocus } from '@anthropic/ink';
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js';
import { getBuiltinPluginDefinition } from '../../plugins/builtinPlugins.js';
import { useMcpToggleEnabled } from '../../services/mcp/MCPConnectionManager.js';
import type {
  MCPServerConnection,
  McpClaudeAIProxyServerConfig,
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
} from '../../services/mcp/types.js';
import { filterToolsByServer } from '../../services/mcp/utils.js';
import {
  disablePluginOp,
  enablePluginOp,
  getPluginInstallationFromV2,
  isInstallableScope,
  isPluginEnabledAtProjectScope,
  uninstallPluginOp,
  updatePluginOp,
  type InstallableScope,
} from '../../services/plugins/pluginOperations.js';
import { useAppState } from '../../state/AppState.js';
import type { Tool } from '../../Tool.js';
import type { LoadedPlugin, PluginError } from '../../types/plugin.js';
import { count } from '../../utils/array.js';
import { openBrowser } from '../../utils/browser.js';
import { logForDebugging } from '../../utils/debug.js';
import { errorMessage, toError } from '../../utils/errors.js';
import { logError } from '../../utils/log.js';
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js';
import { loadInstalledPluginsV2 } from '../../utils/plugins/installedPluginsManager.js';
import { getMarketplace } from '../../utils/plugins/marketplaceManager.js';
import {
  isMcpbSource,
  loadMcpbFile,
  type McpbNeedsConfigResult,
  type UserConfigValues,
} from '../../utils/plugins/mcpbHandler.js';
import { getPluginDataDirSize, pluginDataDirPath } from '../../utils/plugins/pluginDirectories.js';
import { getFlaggedPlugins, markFlaggedPluginsSeen, removeFlaggedPlugin } from '../../utils/plugins/pluginFlagging.js';
import { type PersistablePluginScope, parsePluginIdentifier } from '../../utils/plugins/pluginIdentifier.js';
import { loadAllPlugins } from '../../utils/plugins/pluginLoader.js';
import {
  loadPluginOptions,
  type PluginOptionSchema,
  savePluginOptions,
} from '../../utils/plugins/pluginOptionsStorage.js';
import { isPluginBlockedByPolicy } from '../../utils/plugins/pluginPolicy.js';
import { getPluginEditableScopes } from '../../utils/plugins/pluginStartupCheck.js';
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js';
import { jsonParse } from '../../utils/slowOperations.js';
import { plural } from '../../utils/stringUtils.js';
import { formatErrorMessage, getErrorGuidance } from './PluginErrors.js';
import { PluginOptionsDialog } from './PluginOptionsDialog.js';
import { PluginOptionsFlow } from './PluginOptionsFlow.js';
import type { ViewState as ParentViewState } from './types.js';
import { UnifiedInstalledCell } from './UnifiedInstalledCell.js';
import type { UnifiedInstalledItem, UnifiedInstalledScope } from './unifiedTypes.js';
import { usePagination } from './usePagination.js';

type Props = {
  setViewState: (state: ParentViewState) => void;
  setResult: (result: string | null) => void;
  onManageComplete?: () => void | Promise<void>;
  onSearchModeChange?: (isActive: boolean) => void;
  targetPlugin?: string;
  targetMarketplace?: string;
  action?: 'enable' | 'disable' | 'uninstall';
};

type FlaggedPluginInfo = {
  id: string;
  name: string;
  marketplace: string;
  reason: string;
  text: string;
  flaggedAt: string;
};

type FailedPluginInfo = {
  id: string;
  name: string;
  marketplace: string;
  errors: PluginError[];
  scope: UnifiedInstalledScope;
};

type ViewState =
  | 'plugin-list'
  | 'plugin-details'
  | 'configuring'
  | { type: 'plugin-options' }
  | { type: 'configuring-options'; schema: PluginOptionSchema }
  | 'confirm-project-uninstall'
  | { type: 'confirm-data-cleanup'; size: { bytes: number; human: string } }
  | { type: 'flagged-detail'; plugin: FlaggedPluginInfo }
  | { type: 'failed-plugin-details'; plugin: FailedPluginInfo }
  | { type: 'mcp-detail'; client: MCPServerConnection }
  | { type: 'mcp-tools'; client: MCPServerConnection }
  | { type: 'mcp-tool-detail'; client: MCPServerConnection; tool: Tool };

type MarketplaceInfo = {
  name: string;
  installedPlugins: LoadedPlugin[];
  enabledCount?: number;
  disabledCount?: number;
};

type PluginState = {
  plugin: LoadedPlugin;
  marketplace: string;
  scope?: 'user' | 'project' | 'local' | 'managed' | 'builtin';
  pendingEnable?: boolean; // 切换启用/禁用
  pendingUpdate?: boolean; // 标记为待更新
};

/**
 * 从目录中获取基本文件名列表（不含 .md 扩展名）
 * @param dirPath 要列出文件的目录路径
 * @returns 不含 .md 扩展名的基本文件名数组
 * @example
 * // 假设目录包含：agent-sdk-verifier-py.md、agent-sdk-verifier-ts.md、README.txt
 * await getBaseFileNames('/path/to/agents')
 * // 返回：['agent-sdk-verifier-py', 'agent-sdk-verifier-ts']
 */
async function getBaseFileNames(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry: Dirent) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry: Dirent) => {
        // 专门移除 .md 扩展名
        const baseName = path.basename(entry.name, '.md');
        return baseName;
      });
  } catch (error) {
    const errorMsg = errorMessage(error);
    logForDebugging(`Failed to read plugin components from ${dirPath}: ${errorMsg}`, { level: 'error' });
    logError(toError(error));
    // 返回空数组以允许优雅降级 —— 插件详情仍可展示
    return [];
  }
}

/**
 * 从 skills 目录中获取 skill 目录名列表
 * Skills 是包含 SKILL.md 文件的目录
 * @param dirPath 要扫描的 skills 目录路径
 * @returns 含 SKILL.md 的 skill 目录名数组
 * @example
 * // 假设目录包含：my-skill/SKILL.md、another-skill/SKILL.md、README.txt
 * await getSkillDirNames('/path/to/skills')
 * // 返回：['my-skill', 'another-skill']
 */
async function getSkillDirNames(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const skillNames: string[] = [];

    for (const entry of entries) {
      // 检查它是否是目录或符号链接（符号链接可能指向 skill 目录）
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        // 检查该目录是否包含 SKILL.md 文件
        const skillFilePath = path.join(dirPath, entry.name, 'SKILL.md');
        try {
          const st = await fs.stat(skillFilePath);
          if (st.isFile()) {
            skillNames.push(entry.name);
          }
        } catch {
          // 该目录中没有 SKILL.md 文件，跳过
        }
      }
    }

    return skillNames;
  } catch (error) {
    const errorMsg = errorMessage(error);
    logForDebugging(`Failed to read skill directories from ${dirPath}: ${errorMsg}`, { level: 'error' });
    logError(toError(error));
    // 返回空数组以允许优雅降级 —— 插件详情仍可展示
    return [];
  }
}

// 展示已安装插件组件的组件
function PluginComponentsDisplay({
  plugin,
  marketplace,
}: {
  plugin: LoadedPlugin;
  marketplace: string;
}): React.ReactNode {
  const [components, setComponents] = useState<{
    commands?: string | string[] | Record<string, unknown> | null;
    agents?: string | string[] | Record<string, unknown> | null;
    skills?: string | string[] | Record<string, unknown> | null;
    hooks?: unknown;
    mcpServers?: unknown;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadComponents() {
      try {
        // 内置插件没有市场条目 —— 直接从注册的定义中读取。
        if (marketplace === 'builtin') {
          const builtinDef = getBuiltinPluginDefinition(plugin.name);
          if (builtinDef) {
            const skillNames = builtinDef.skills?.map(s => s.name) ?? [];
            const hookEvents = builtinDef.hooks ? Object.keys(builtinDef.hooks) : [];
            const mcpServerNames = builtinDef.mcpServers ? Object.keys(builtinDef.mcpServers) : [];
            setComponents({
              commands: null,
              agents: null,
              skills: skillNames.length > 0 ? skillNames : null,
              hooks: hookEvents.length > 0 ? hookEvents : null,
              mcpServers: mcpServerNames.length > 0 ? mcpServerNames : null,
            });
          } else {
            setError(`Built-in plugin ${plugin.name} not found`);
          }
          setLoading(false);
          return;
        }

        const marketplaceData = await getMarketplace(marketplace);
        // 在数组中查找插件条目
        const pluginEntry = marketplaceData.plugins.find(p => p.name === plugin.name);
        if (pluginEntry) {
          // 合并来自两个源的 commands
          const commandPathList = [];
          if (plugin.commandsPath) {
            commandPathList.push(plugin.commandsPath);
          }
          if (plugin.commandsPaths) {
            commandPathList.push(...plugin.commandsPaths);
          }

          // 从所有 command 路径获取基本文件名
          const commandList: string[] = [];
          for (const commandPath of commandPathList) {
            if (typeof commandPath === 'string') {
              // commandPath 已经是完整路径
              const baseNames = await getBaseFileNames(commandPath);
              commandList.push(...baseNames);
            }
          }

          // 合并来自两个源的 agents
          const agentPathList = [];
          if (plugin.agentsPath) {
            agentPathList.push(plugin.agentsPath);
          }
          if (plugin.agentsPaths) {
            agentPathList.push(...plugin.agentsPaths);
          }

          // 从所有 agent 路径获取基本文件名
          const agentList: string[] = [];
          for (const agentPath of agentPathList) {
            if (typeof agentPath === 'string') {
              // agentPath 已经是完整路径
              const baseNames = await getBaseFileNames(agentPath);
              agentList.push(...baseNames);
            }
          }

          // 合并来自两个源的 skills
          const skillPathList = [];
          if (plugin.skillsPath) {
            skillPathList.push(plugin.skillsPath);
          }
          if (plugin.skillsPaths) {
            skillPathList.push(...plugin.skillsPaths);
          }

          // 从所有 skill 路径获取 skill 目录名
          // Skills 是包含 SKILL.md 文件的目录
          const skillList: string[] = [];
          for (const skillPath of skillPathList) {
            if (typeof skillPath === 'string') {
              // skillPath 已经是指向 skills 目录的完整路径
              const skillDirNames = await getSkillDirNames(skillPath);
              skillList.push(...skillDirNames);
            }
          }

          // 合并来自两个源的 hooks
          const hooksList = [];
          if (plugin.hooksConfig) {
            hooksList.push(Object.keys(plugin.hooksConfig));
          }
          if (pluginEntry.hooks) {
            hooksList.push(pluginEntry.hooks);
          }

          // 合并来自两个源的 MCP 服务器
          const mcpServersList = [];
          if (plugin.mcpServers) {
            mcpServersList.push(Object.keys(plugin.mcpServers));
          }
          if (pluginEntry.mcpServers) {
            mcpServersList.push(pluginEntry.mcpServers);
          }

          setComponents({
            commands: commandList.length > 0 ? commandList : null,
            agents: agentList.length > 0 ? agentList : null,
            skills: skillList.length > 0 ? skillList : null,
            hooks: hooksList.length > 0 ? hooksList : null,
            mcpServers: mcpServersList.length > 0 ? mcpServersList : null,
          });
        } else {
          setError(`Plugin ${plugin.name} not found in marketplace`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load components');
      } finally {
        setLoading(false);
      }
    }
    void loadComponents();
  }, [
    plugin.name,
    plugin.commandsPath,
    plugin.commandsPaths,
    plugin.agentsPath,
    plugin.agentsPaths,
    plugin.skillsPath,
    plugin.skillsPaths,
    plugin.hooksConfig,
    plugin.mcpServers,
    marketplace,
  ]);

  if (loading) {
    return null; // 不显示加载状态，保持 UI 干净
  }

  if (error) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Components:</Text>
        <Text dimColor>Error: {error}</Text>
      </Box>
    );
  }

  if (!components) {
    return null; // 无可用的组件信息
  }

  const hasComponents =
    components.commands || components.agents || components.skills || components.hooks || components.mcpServers;

  if (!hasComponents) {
    return null; // 未定义任何组件
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>Installed components:</Text>
      {components.commands ? (
        <Text dimColor>
          • Commands:{' '}
          {typeof components.commands === 'string'
            ? components.commands
            : Array.isArray(components.commands)
              ? components.commands.join(', ')
              : Object.keys(components.commands).join(', ')}
        </Text>
      ) : null}
      {components.agents ? (
        <Text dimColor>
          • Agents:{' '}
          {typeof components.agents === 'string'
            ? components.agents
            : Array.isArray(components.agents)
              ? components.agents.join(', ')
              : Object.keys(components.agents).join(', ')}
        </Text>
      ) : null}
      {components.skills ? (
        <Text dimColor>
          • Skills:{' '}
          {typeof components.skills === 'string'
            ? components.skills
            : Array.isArray(components.skills)
              ? components.skills.join(', ')
              : Object.keys(components.skills).join(', ')}
        </Text>
      ) : null}
      {components.hooks ? (
        <Text dimColor>
          • Hooks:{' '}
          {typeof components.hooks === 'string'
            ? components.hooks
            : Array.isArray(components.hooks)
              ? components.hooks.map(String).join(', ')
              : typeof components.hooks === 'object' && components.hooks !== null
                ? Object.keys(components.hooks).join(', ')
                : String(components.hooks)}
        </Text>
      ) : null}
      {components.mcpServers ? (
        <Text dimColor>
          • MCP Servers:{' '}
          {typeof components.mcpServers === 'string'
            ? components.mcpServers
            : Array.isArray(components.mcpServers)
              ? components.mcpServers.map(String).join(', ')
              : typeof components.mcpServers === 'object' && components.mcpServers !== null
                ? Object.keys(components.mcpServers).join(', ')
                : String(components.mcpServers)}
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * 检查插件是否来自本地源且无法远程更新
 * @returns 若为本地则返回错误信息，若为远程/可更新则返回 null
 */
async function checkIfLocalPlugin(pluginName: string, marketplaceName: string): Promise<string | null> {
  const marketplace = await getMarketplace(marketplaceName);
  const entry = marketplace?.plugins.find(p => p.name === pluginName);

  if (entry && typeof entry.source === 'string') {
    return `Local plugins cannot be updated remotely. To update, modify the source at: ${entry.source}`;
  }

  return null;
}

/**
 * 过滤掉被组织策略（policySettings）强制禁用的插件。
 * 这些被组织阻止，用户无法重新启用。
 * 直接检查 policySettings 而非安装作用域，因为 managed 设置
 * 不会创建 scope 为 'managed' 的安装记录。
 */
export function filterManagedDisabledPlugins(plugins: LoadedPlugin[]): LoadedPlugin[] {
  return plugins.filter(plugin => {
    const marketplace = plugin.source.split('@')[1] || 'local';
    return !isPluginBlockedByPolicy(`${plugin.name}@${marketplace}`);
  });
}

export function ManagePlugins({
  setViewState: setParentViewState,
  setResult,
  onManageComplete,
  onSearchModeChange,
  targetPlugin,
  targetMarketplace,
  action,
}: Props): React.ReactNode {
  // 用于访问 MCP 的 app state
  const mcpClients = useAppState(s => s.mcp.clients);
  const mcpTools = useAppState(s => s.mcp.tools);
  const pluginErrors = useAppState(s => s.plugins.errors);
  const flaggedPlugins = getFlaggedPlugins();

  // 搜索状态
  const [isSearchMode, setIsSearchModeRaw] = useState(false);
  const setIsSearchMode = useCallback(
    (active: boolean) => {
      setIsSearchModeRaw(active);
      onSearchModeChange?.(active);
    },
    [onSearchModeChange],
  );
  const isTerminalFocused = useTerminalFocus();
  const { columns: terminalWidth } = useTerminalSize();

  // 视图状态
  const [viewState, setViewState] = useState<ViewState>('plugin-list');

  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    cursorOffset: searchCursorOffset,
  } = useSearchInput({
    isActive: viewState === 'plugin-list' && isSearchMode,
    onExit: () => {
      setIsSearchMode(false);
    },
  });
  const [selectedPlugin, setSelectedPlugin] = useState<PluginState | null>(null);

  // 数据状态
  const [marketplaces, setMarketplaces] = useState<MarketplaceInfo[]>([]);
  const [pluginStates, setPluginStates] = useState<PluginState[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingToggles, setPendingToggles] = useState<Map<string, 'will-enable' | 'will-disable'>>(new Map());

  // 守卫：防止用户离开后自动导航再次触发（父组件从不清理 targetPlugin）。
  const hasAutoNavigated = useRef(false);
  // 自动导航落点后触发的自动操作（enable/disable/uninstall）。
  // 用 ref 而非 state：它被一个一次性的 effect 消费，该 effect 本身
  // 就在 viewState/selectedPlugin 变化时重新运行，因此会触发渲染的
  // state 变量是多余的。
  const pendingAutoActionRef = useRef<'enable' | 'disable' | 'uninstall' | undefined>(undefined);

  // MCP 切换 hook
  const toggleMcpServer = useMcpToggleEnabled();

  // 处理 Esc 返回 —— 取决于 viewState 的导航
  const handleBack = React.useCallback(() => {
    if (viewState === 'plugin-details') {
      setViewState('plugin-list');
      setSelectedPlugin(null);
      setProcessError(null);
    } else if (typeof viewState === 'object' && viewState.type === 'failed-plugin-details') {
      setViewState('plugin-list');
      setProcessError(null);
    } else if (viewState === 'configuring') {
      setViewState('plugin-details');
      setConfigNeeded(null);
    } else if (
      typeof viewState === 'object' &&
      (viewState.type === 'plugin-options' || viewState.type === 'configuring-options')
    ) {
      // 在序列中途取消 —— 插件已经启用，直接退回到列表。
      // 用户以后可以通过 "Configure options" 菜单配置。
      setViewState('plugin-list');
      setSelectedPlugin(null);
      setResult('Plugin enabled. Configuration skipped — run /reload-plugins to apply.');
      if (onManageComplete) {
        void onManageComplete();
      }
    } else if (typeof viewState === 'object' && viewState.type === 'flagged-detail') {
      setViewState('plugin-list');
      setProcessError(null);
    } else if (typeof viewState === 'object' && viewState.type === 'mcp-detail') {
      setViewState('plugin-list');
      setProcessError(null);
    } else if (typeof viewState === 'object' && viewState.type === 'mcp-tools') {
      setViewState({ type: 'mcp-detail', client: viewState.client });
    } else if (typeof viewState === 'object' && viewState.type === 'mcp-tool-detail') {
      setViewState({ type: 'mcp-tools', client: viewState.client });
    } else {
      if (pendingToggles.size > 0) {
        setResult('Run /reload-plugins to apply plugin changes.');
        return;
      }
      setParentViewState({ type: 'menu' });
    }
  }, [viewState, setParentViewState, pendingToggles, setResult]);

  // 非搜索模式下按 Esc —— 返回。
  // 不包括 confirm-project-uninstall（在 Confirmation 上下文中
  // 有自己的 confirm:no 处理器 —— 让它也触发会产生冲突的处理器）
  // 以及 confirm-data-cleanup（使用原始 useInput，其中 n 和 escape
  // 是不同动作：keep-data 与 cancel）。
  useKeybinding('confirm:no', handleBack, {
    context: 'Confirmation',
    isActive:
      (viewState !== 'plugin-list' || !isSearchMode) &&
      viewState !== 'confirm-project-uninstall' &&
      !(typeof viewState === 'object' && viewState.type === 'confirm-data-cleanup'),
  });

  // 获取 MCP 状态的辅助函数
  const getMcpStatus = (
    client: MCPServerConnection,
  ): 'connected' | 'disabled' | 'pending' | 'needs-auth' | 'failed' => {
    if (client.type === 'connected') return 'connected';
    if (client.type === 'disabled') return 'disabled';
    if (client.type === 'pending') return 'pending';
    if (client.type === 'needs-auth') return 'needs-auth';
    return 'failed';
  };

  // 从插件和 MCP 服务器派生统一项
  const unifiedItems = useMemo(() => {
    const mergedSettings = getSettings_DEPRECATED();

    // 构造 插件名 -> 子 MCP 的 map
    // 插件 MCP 的名字形如 "plugin:pluginName:serverName"
    const pluginMcpMap = new Map<string, Array<{ displayName: string; client: MCPServerConnection }>>();
    for (const client of mcpClients) {
      if (client.name.startsWith('plugin:')) {
        const parts = client.name.split(':');
        if (parts.length >= 3) {
          const pluginName = parts[1]!;
          const serverName = parts.slice(2).join(':');
          const existing = pluginMcpMap.get(pluginName) || [];
          existing.push({ displayName: serverName, client });
          pluginMcpMap.set(pluginName, existing);
        }
      }
    }

    // 构造插件项（暂未排序）
    type PluginWithChildren = {
      item: UnifiedInstalledItem & { type: 'plugin' };
      originalScope: 'user' | 'project' | 'local' | 'managed' | 'builtin';
      childMcps: Array<{ displayName: string; client: MCPServerConnection }>;
    };
    const pluginsWithChildren: PluginWithChildren[] = [];

    for (const state of pluginStates) {
      const pluginId = `${state.plugin.name}@${state.marketplace}`;
      const isEnabled = mergedSettings?.enabledPlugins?.[pluginId] !== false;
      const errors = pluginErrors.filter(
        e =>
          ('plugin' in e && e.plugin === state.plugin.name) ||
          e.source === pluginId ||
          e.source.startsWith(`${state.plugin.name}@`),
      );

      // 内置插件使用 'builtin' 作用域；其他从 V2 数据中查找。
      const originalScope = state.plugin.isBuiltin ? 'builtin' : state.scope || 'user';

      pluginsWithChildren.push({
        item: {
          type: 'plugin',
          id: pluginId,
          name: state.plugin.name,
          description: state.plugin.manifest.description,
          marketplace: state.marketplace,
          scope: originalScope,
          isEnabled,
          errorCount: errors.length,
          errors,
          plugin: state.plugin,
          pendingEnable: state.pendingEnable,
          pendingUpdate: state.pendingUpdate,
          pendingToggle: pendingToggles.get(pluginId),
        },
        originalScope,
        childMcps: pluginMcpMap.get(state.plugin.name) || [],
      });
    }

    // 查找孤立错误（完全加载失败的插件对应的错误）
    const matchedPluginIds = new Set(pluginsWithChildren.map(({ item }) => item.id));
    const matchedPluginNames = new Set(pluginsWithChildren.map(({ item }) => item.name));
    const orphanErrorsBySource = new Map<string, typeof pluginErrors>();
    for (const error of pluginErrors) {
      if (
        matchedPluginIds.has(error.source) ||
        ('plugin' in error && typeof error.plugin === 'string' && matchedPluginNames.has(error.plugin))
      ) {
        continue;
      }
      const existing = orphanErrorsBySource.get(error.source) || [];
      existing.push(error);
      orphanErrorsBySource.set(error.source, existing);
    }
    const pluginScopes = getPluginEditableScopes();
    const failedPluginItems: UnifiedInstalledItem[] = [];
    for (const [pluginId, errors] of orphanErrorsBySource) {
      // 跳过已在 flagged 分组中展示的插件
      if (pluginId in flaggedPlugins) continue;
      const parsed = parsePluginIdentifier(pluginId);
      const pluginName = parsed.name || pluginId;
      const marketplace = parsed.marketplace || 'unknown';
      const rawScope = pluginScopes.get(pluginId);
      // 'flag' 仅限当前会话（来自 --plugin-dir / flagSettings），undefined
      // 表示插件不在任何 settings source 中。两者都默认为 'user'，
      // 因为 UnifiedInstalledItem 没有 'flag' 作用域变体。
      const scope = rawScope === 'flag' || rawScope === undefined ? 'user' : rawScope;
      failedPluginItems.push({
        type: 'failed-plugin',
        id: pluginId,
        name: pluginName,
        marketplace,
        scope,
        errorCount: errors.length,
        errors,
      });
    }

    // 构造独立的 MCP 项
    const standaloneMcps: UnifiedInstalledItem[] = [];
    for (const client of mcpClients) {
      if (client.name === 'ide') continue;
      if (client.name.startsWith('plugin:')) continue;

      standaloneMcps.push({
        type: 'mcp',
        id: `mcp:${client.name}`,
        name: client.name,
        description: undefined,
        scope: client.config.scope,
        status: getMcpStatus(client),
        client,
      });
    }

    // 定义显示时的作用域顺序
    const scopeOrder: Record<string, number> = {
      flagged: -1,
      project: 0,
      local: 1,
      user: 2,
      enterprise: 3,
      managed: 4,
      dynamic: 5,
      builtin: 6,
    };

    // 通过合并插件（及其子 MCP）与独立 MCP 构造最终列表
    // 按作用域分组以避免重复的作用域标题
    const unified: UnifiedInstalledItem[] = [];

    // 创建 作用域 -> 项 的 map 以便正确合并
    const itemsByScope = new Map<string, UnifiedInstalledItem[]>();

    // 添加插件及其子 MCP
    for (const { item, originalScope, childMcps } of pluginsWithChildren) {
      const scope = item.scope;
      if (!itemsByScope.has(scope)) {
        itemsByScope.set(scope, []);
      }
      itemsByScope.get(scope)!.push(item);
      // 在插件之后添加子 MCP 并缩进（使用原始作用域，不是 'flagged'）。
      // 内置插件在显示时映射为 'user'，因为 MCP ConfigScope 不包含 'builtin'。
      for (const { displayName, client } of childMcps) {
        const displayScope = originalScope === 'builtin' ? 'user' : originalScope;
        if (!itemsByScope.has(displayScope)) {
          itemsByScope.set(displayScope, []);
        }
        itemsByScope.get(displayScope)!.push({
          type: 'mcp',
          id: `mcp:${client.name}`,
          name: displayName,
          description: undefined,
          scope: displayScope,
          status: getMcpStatus(client),
          client,
          indented: true,
        });
      }
    }

    // 将独立 MCP 添加到各自的作用域分组中
    for (const mcp of standaloneMcps) {
      const scope = mcp.scope;
      if (!itemsByScope.has(scope)) {
        itemsByScope.set(scope, []);
      }
      itemsByScope.get(scope)!.push(mcp);
    }

    // 将失败插件添加到各自的作用域分组中
    for (const failedPlugin of failedPluginItems) {
      const scope = failedPlugin.scope;
      if (!itemsByScope.has(scope)) {
        itemsByScope.set(scope, []);
      }
      itemsByScope.get(scope)!.push(failedPlugin);
    }

    // 从 user settings 中添加被标记（下架）的插件。
    // Reason/text 从缓存的 security messages 文件中查找。
    for (const [pluginId, entry] of Object.entries(flaggedPlugins)) {
      const parsed = parsePluginIdentifier(pluginId);
      const pluginName = parsed.name || pluginId;
      const marketplace = parsed.marketplace || 'unknown';
      if (!itemsByScope.has('flagged')) {
        itemsByScope.set('flagged', []);
      }
      itemsByScope.get('flagged')!.push({
        type: 'flagged-plugin',
        id: pluginId,
        name: pluginName,
        marketplace,
        scope: 'flagged',
        reason: 'delisted',
        text: 'Removed from marketplace',
        flaggedAt: entry.flaggedAt,
      });
    }

    // 对作用域排序并构造最终列表
    const sortedScopes = [...itemsByScope.keys()].sort((a, b) => (scopeOrder[a] ?? 99) - (scopeOrder[b] ?? 99));

    for (const scope of sortedScopes) {
      const items = itemsByScope.get(scope)!;

      // 将项拆分为插件分组（含其子 MCP）与独立 MCP
      // 这保留了朴素排序会破坏的父子关系
      const pluginGroups: UnifiedInstalledItem[][] = [];
      const standaloneMcpsInScope: UnifiedInstalledItem[] = [];

      let i = 0;
      while (i < items.length) {
        const item = items[i]!;
        if (item.type === 'plugin' || item.type === 'failed-plugin' || item.type === 'flagged-plugin') {
          // 收集插件及其子 MCP 作为一个分组
          const group: UnifiedInstalledItem[] = [item];
          i++;
          // 向前查找缩进的子 MCP
          let nextItem = items[i];
          while (nextItem?.type === 'mcp' && nextItem.indented) {
            group.push(nextItem);
            i++;
            nextItem = items[i];
          }
          pluginGroups.push(group);
        } else if (item.type === 'mcp' && !item.indented) {
          // 独立的 MCP（不是某个插件的子项）
          standaloneMcpsInScope.push(item);
          i++;
        } else {
          // 跳过孤立的缩进 MCP（不应该发生）
          i++;
        }
      }

      // 按插件名（每个分组的第一项）对插件分组排序
      pluginGroups.sort((a, b) => a[0]!.name.localeCompare(b[0]!.name));

      // 按名称排序独立 MCP
      standaloneMcpsInScope.sort((a, b) => a.name.localeCompare(b.name));

      // 构造最终列表：插件（含其子项）在前，然后是独立 MCP
      for (const group of pluginGroups) {
        unified.push(...group);
      }
      unified.push(...standaloneMcpsInScope);
    }

    return unified;
  }, [pluginStates, mcpClients, pluginErrors, pendingToggles, flaggedPlugins]);

  // 当 Installed 视图渲染被标记的插件时，将它们标记为已查看。
  // seenAt 之后 48 小时，它们会在下次加载时自动清除。
  const flaggedIds = useMemo(
    () => unifiedItems.filter(item => item.type === 'flagged-plugin').map(item => item.id),
    [unifiedItems],
  );
  useEffect(() => {
    if (flaggedIds.length > 0) {
      void markFlaggedPluginsSeen(flaggedIds);
    }
  }, [flaggedIds]);

  // 根据搜索查询过滤项（匹配名称或描述）
  const filteredItems = useMemo(() => {
    if (!searchQuery) return unifiedItems;
    const lowerQuery = searchQuery.toLowerCase();
    return unifiedItems.filter(
      item =>
        item.name.toLowerCase().includes(lowerQuery) ||
        ('description' in item && item.description?.toLowerCase().includes(lowerQuery)),
    );
  }, [unifiedItems, searchQuery]);

  // 选择状态
  const [selectedIndex, setSelectedIndex] = useState(0);

  // 统一列表的分页（连续滚动）
  const pagination = usePagination<UnifiedInstalledItem>({
    totalItems: filteredItems.length,
    selectedIndex,
    maxVisible: 8,
  });

  // 详情视图状态
  const [detailsMenuIndex, setDetailsMenuIndex] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);

  // 配置状态
  const [configNeeded, setConfigNeeded] = useState<McpbNeedsConfigResult | null>(null);
  const [_isLoadingConfig, setIsLoadingConfig] = useState(false);
  const [selectedPluginHasMcpb, setSelectedPluginHasMcpb] = useState(false);

  // 检测所选插件是否含有 MCPB
  // 读取原始 marketplace.json 以兼容旧缓存市场
  useEffect(() => {
    if (!selectedPlugin) {
      setSelectedPluginHasMcpb(false);
      return;
    }

    async function detectMcpb() {
      // 先检查插件 manifest
      const mcpServersSpec = selectedPlugin!.plugin.manifest.mcpServers;
      let hasMcpb = false;

      if (mcpServersSpec) {
        hasMcpb =
          (typeof mcpServersSpec === 'string' && isMcpbSource(mcpServersSpec)) ||
          (Array.isArray(mcpServersSpec) && mcpServersSpec.some(s => typeof s === 'string' && isMcpbSource(s)));
      }

      // 如果不在 manifest 中，直接读取原始 marketplace.json（绕过 schema 校验）
      // 即使是 MCPB 支持之前的旧缓存市场也能工作
      if (!hasMcpb) {
        try {
          const marketplaceDir = path.join(selectedPlugin!.plugin.path, '..');
          const marketplaceJsonPath = path.join(marketplaceDir, '.claude-plugin', 'marketplace.json');

          const content = await fs.readFile(marketplaceJsonPath, 'utf-8');
          const marketplace = jsonParse(content);

          const entry = marketplace.plugins?.find((p: { name: string }) => p.name === selectedPlugin!.plugin.name);

          if (entry?.mcpServers) {
            const spec = entry.mcpServers;
            hasMcpb =
              (typeof spec === 'string' && isMcpbSource(spec)) ||
              (Array.isArray(spec) && spec.some((s: unknown) => typeof s === 'string' && isMcpbSource(s)));
          }
        } catch (err) {
          logForDebugging(`Failed to read raw marketplace.json: ${err}`);
        }
      }

      setSelectedPluginHasMcpb(hasMcpb);
    }

    void detectMcpb();
  }, [selectedPlugin]);

  // 按市场分组加载已安装的插件
  useEffect(() => {
    async function loadInstalledPlugins() {
      setLoading(true);
      try {
        const { enabled, disabled } = await loadAllPlugins();
        const mergedSettings = getSettings_DEPRECATED(); // 使用合并后的 settings 以尊重所有层级

        const allPlugins = filterManagedDisabledPlugins([...enabled, ...disabled]);

        // 按市场对插件分组
        const pluginsByMarketplace: Record<string, LoadedPlugin[]> = {};
        for (const plugin of allPlugins) {
          const marketplace = plugin.source.split('@')[1] || 'local';
          if (!pluginsByMarketplace[marketplace]) {
            pluginsByMarketplace[marketplace] = [];
          }
          pluginsByMarketplace[marketplace]!.push(plugin);
        }

        // 创建带启用/禁用计数的市场信息数组
        const marketplaceInfos: MarketplaceInfo[] = [];
        for (const [name, plugins] of Object.entries(pluginsByMarketplace)) {
          const enabledCount = count(plugins, p => {
            const pluginId = `${p.name}@${name}`;
            return mergedSettings?.enabledPlugins?.[pluginId] !== false;
          });
          const disabledCount = plugins.length - enabledCount;

          marketplaceInfos.push({
            name,
            installedPlugins: plugins,
            enabledCount,
            disabledCount,
          });
        }

        // 对市场排序：claude-plugin-directory 优先，再按字母序
        marketplaceInfos.sort((a, b) => {
          if (a.name === 'claude-plugin-directory') return -1;
          if (b.name === 'claude-plugin-directory') return 1;
          return a.name.localeCompare(b.name);
        });

        setMarketplaces(marketplaceInfos);

        // 构造所有插件状态的扁平列表
        const allStates: PluginState[] = [];
        for (const marketplace of marketplaceInfos) {
          for (const plugin of marketplace.installedPlugins) {
            const pluginId = `${plugin.name}@${marketplace.name}`;
            // 内置插件没有 V2 安装记录 —— 跳过查找。
            const scope = plugin.isBuiltin ? 'builtin' : getPluginInstallationFromV2(pluginId).scope;

            allStates.push({
              plugin,
              marketplace: marketplace.name,
              scope,
              pendingEnable: undefined,
              pendingUpdate: false,
            });
          }
        }
        setPluginStates(allStates);
        setSelectedIndex(0);
      } finally {
        setLoading(false);
      }
    }

    void loadInstalledPlugins();
  }, []);

  // 如果指定了目标插件，则自动导航（仅一次）
  useEffect(() => {
    if (hasAutoNavigated.current) return;
    if (targetPlugin && marketplaces.length > 0 && !loading) {
      // targetPlugin 可能是 `name` 或 `name@marketplace`（parseArgs 直接
      // 透传原始参数）。解析它，使 p.name 匹配在两种情况下都能工作。
      const { name: targetName, marketplace: targetMktFromId } = parsePluginIdentifier(targetPlugin);
      const effectiveTargetMarketplace = targetMarketplace ?? targetMktFromId;

      // 如果提供了 targetMarketplace 就用它，否则搜索所有市场
      const marketplacesToSearch = effectiveTargetMarketplace
        ? marketplaces.filter(m => m.name === effectiveTargetMarketplace)
        : marketplaces;

      // 先检查成功加载的插件
      for (const marketplace of marketplacesToSearch) {
        const plugin = marketplace.installedPlugins.find(p => p.name === targetName);
        if (plugin) {
          // 从 V2 数据获取作用域以正确处理操作
          const pluginId = `${plugin.name}@${marketplace.name}`;
          const { scope } = getPluginInstallationFromV2(pluginId);

          const pluginState: PluginState = {
            plugin,
            marketplace: marketplace.name,
            scope,
            pendingEnable: undefined,
            pendingUpdate: false,
          };
          setSelectedPlugin(pluginState);
          setViewState('plugin-details');
          pendingAutoActionRef.current = action;
          hasAutoNavigated.current = true;
          return;
        }
      }

      // 回退到失败插件（有错误但未加载的）
      const failedItem = unifiedItems.find(item => item.type === 'failed-plugin' && item.name === targetName);
      if (failedItem && failedItem.type === 'failed-plugin') {
        setViewState({
          type: 'failed-plugin-details',
          plugin: {
            id: failedItem.id,
            name: failedItem.name,
            marketplace: failedItem.marketplace,
            errors: failedItem.errors,
            scope: failedItem.scope,
          },
        });
        hasAutoNavigated.current = true;
      }

      // 在已加载或失败的插件中都没匹配 —— 关闭对话框并给出
      // 消息，而不是默默停在插件列表上。仅当请求了某个操作
      // （例如 /plugin uninstall X）时才这样做；纯导航
      // （/plugin manage）仍应只显示列表。
      if (!hasAutoNavigated.current && action) {
        hasAutoNavigated.current = true;
        setResult(`Plugin "${targetPlugin}" is not installed in this project`);
      }
    }
  }, [targetPlugin, targetMarketplace, marketplaces, loading, unifiedItems, action, setResult]);

  // 从详情视图处理单个插件操作
  const handleSingleOperation = async (operation: 'enable' | 'disable' | 'update' | 'uninstall') => {
    if (!selectedPlugin) return;

    const pluginScope = selectedPlugin.scope || 'user';
    const isBuiltin = pluginScope === 'builtin';

    // 内置插件只能启用/禁用，不能更新/卸载。
    if (isBuiltin && (operation === 'update' || operation === 'uninstall')) {
      setProcessError('Built-in plugins cannot be updated or uninstalled.');
      return;
    }

    // 托管作用域的插件只能更新，不能启用/禁用/卸载
    if (!isBuiltin && !isInstallableScope(pluginScope) && operation !== 'update') {
      setProcessError('This plugin is managed by your organization. Contact your admin to disable it.');
      return;
    }

    setIsProcessing(true);
    setProcessError(null);

    try {
      const pluginId = `${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`;
      let reverseDependents: string[] | undefined;

      // enable/disable 省略 scope —— pluginScope 是 installed_plugins.json
      // 中的安装作用域（文件缓存所在地），可能与 settings 中的作用域
      // （启用状态所在地）不一致。传入它会触发跨作用域守卫。
      // 自动检测能找到正确的作用域。#38084
      switch (operation) {
        case 'enable': {
          const enableResult = await enablePluginOp(pluginId);
          if (!enableResult.success) {
            throw new Error(enableResult.message);
          }
          break;
        }
        case 'disable': {
          const disableResult = await disablePluginOp(pluginId);
          if (!disableResult.success) {
            throw new Error(disableResult.message);
          }
          reverseDependents = disableResult.reverseDependents;
          break;
        }
        case 'uninstall': {
          if (isBuiltin) break; // 上面已守卫；此处收窄 pluginScope
          if (!isInstallableScope(pluginScope)) break;
          // 如果插件在 .hclaude/settings.json（与团队共享）中启用，
          // 则转到确认对话框，提供在 settings.local.json 中禁用的选项。
          // 直接检查 settings 文件 —— `pluginScope`（来自
          // installed_plugins.json）即使在插件同时被项目启用时也可能为
          // 'user'，而卸载 user 作用域的安装会让项目启用仍生效。
          if (isPluginEnabledAtProjectScope(pluginId)) {
            setIsProcessing(false);
            setViewState('confirm-project-uninstall');
            return;
          }
          // 如果插件有持久化数据（${CLAUDE_PLUGIN_DATA}）且这是最后一个作用域，
          // 在删除前提示。对多作用域安装，操作的 isLastScope 检查无论用户
          // 选 y/n 都不会删除 —— 显示对话框会误导（"y" → 什么都没发生）。
          // 长度检查与 pluginOperations.ts:513 一致。
          const installs = loadInstalledPluginsV2().plugins[pluginId];
          const isLastScope = !installs || installs.length <= 1;
          const dataSize = isLastScope ? await getPluginDataDirSize(pluginId) : null;
          if (dataSize) {
            setIsProcessing(false);
            setViewState({ type: 'confirm-data-cleanup', size: dataSize });
            return;
          }
          const result = await uninstallPluginOp(pluginId, pluginScope);
          if (!result.success) {
            throw new Error(result.message);
          }
          reverseDependents = result.reverseDependents;
          break;
        }
        case 'update': {
          if (isBuiltin) break; // 上面已守卫；此处收窄 pluginScope
          const result = await updatePluginOp(pluginId, pluginScope);
          if (!result.success) {
            throw new Error(result.message);
          }
          // 如果已是最新版本，显示信息并退出
          if (result.alreadyUpToDate) {
            setResult(`${selectedPlugin.plugin.name} is already at the latest version (${result.newVersion}).`);
            if (onManageComplete) {
              await onManageComplete();
            }
            setParentViewState({ type: 'menu' });
            return;
          }
          // 成功 —— 将在下面显示标准消息
          break;
        }
      }

      // 操作（enable、disable、uninstall、update）现在使用集中化的函数，
      // 它们自己处理 settings 更新，因此这里只需要清理缓存
      clearAllCaches();

      // 如果插件最终处于启用状态，则提示配置 manifest.userConfig + channel
      // userConfig。重新读取 settings，而不是依赖 `operation === 'enable'`：
      // install 在安装时就启用，所以菜单会先显示 "Disable"。
      // PluginOptionsFlow 自身会检查 getUnconfiguredOptions —— 如果不需要
      // 填写任何内容，它会立即调用 onDone('skipped')。
      const pluginIdNow = `${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`;
      const settingsAfter = getSettings_DEPRECATED();
      const enabledAfter = settingsAfter?.enabledPlugins?.[pluginIdNow] !== false;
      if (enabledAfter) {
        setIsProcessing(false);
        setViewState({ type: 'plugin-options' });
        return;
      }

      const operationName =
        operation === 'enable'
          ? 'Enabled'
          : operation === 'disable'
            ? 'Disabled'
            : operation === 'update'
              ? 'Updated'
              : 'Uninstalled';

      // 单行警告 —— 通知超时约为 8s，多行会滚出屏幕。
      // 持久记录在 Errors 标签中（重载后的 dependency-unsatisfied）。
      const depWarn =
        reverseDependents && reverseDependents.length > 0 ? ` · required by ${reverseDependents.join(', ')}` : '';
      const message = `✓ ${operationName} ${selectedPlugin.plugin.name}${depWarn}. Run /reload-plugins to apply.`;
      setResult(message);

      if (onManageComplete) {
        await onManageComplete();
      }

      setParentViewState({ type: 'menu' });
    } catch (error) {
      setIsProcessing(false);
      const errorMessage = error instanceof Error ? error.message : String(error);
      setProcessError(`Failed to ${operation}: ${errorMessage}`);
      logError(toError(error));
    }
  };

  // 最新 ref：让自动操作 effect 调用当前闭包，而无需把
  // handleSingleOperation（每次渲染都重建）加到依赖里。
  const handleSingleOperationRef = useRef(handleSingleOperation);
  handleSingleOperationRef.current = handleSingleOperation;

  // 在自动导航落到 plugin-details 后，自动执行 action prop
  // （/plugin uninstall X、/plugin enable X 等）。
  useEffect(() => {
    if (viewState === 'plugin-details' && selectedPlugin && pendingAutoActionRef.current) {
      const pending = pendingAutoActionRef.current;
      pendingAutoActionRef.current = undefined;
      void handleSingleOperationRef.current(pending);
    }
  }, [viewState, selectedPlugin]);

  // 处理切换启用/禁用
  const handleToggle = React.useCallback(() => {
    if (selectedIndex >= filteredItems.length) return;
    const item = filteredItems[selectedIndex];
    if (item?.type === 'flagged-plugin') return;
    if (item?.type === 'plugin') {
      const pluginId = `${item.plugin.name}@${item.marketplace}`;
      const mergedSettings = getSettings_DEPRECATED();
      const currentPending = pendingToggles.get(pluginId);
      const isEnabled = mergedSettings?.enabledPlugins?.[pluginId] !== false;
      const pluginScope = item.scope;
      const isBuiltin = pluginScope === 'builtin';
      if (isBuiltin || isInstallableScope(pluginScope as PersistablePluginScope)) {
        const newPending = new Map(pendingToggles);
        // 省略 scope —— 参见 handleSingleOperation 中 enable/disable 的注释。
        if (currentPending) {
          // 取消：将操作回退到原始状态
          newPending.delete(pluginId);
          void (async () => {
            try {
              if (currentPending === 'will-disable') {
                await enablePluginOp(pluginId);
              } else {
                await disablePluginOp(pluginId);
              }
              clearAllCaches();
            } catch (err) {
              logError(err);
            }
          })();
        } else {
          newPending.set(pluginId, isEnabled ? 'will-disable' : 'will-enable');
          void (async () => {
            try {
              if (isEnabled) {
                await disablePluginOp(pluginId);
              } else {
                await enablePluginOp(pluginId);
              }
              clearAllCaches();
            } catch (err) {
              logError(err);
            }
          })();
        }
        setPendingToggles(newPending);
      }
    } else if (item?.type === 'mcp') {
      void toggleMcpServer(item.client.name);
    }
  }, [selectedIndex, filteredItems, pendingToggles, pluginStates, toggleMcpServer]);

  // 在 plugin-list 中处理确认（Enter）
  const handleAccept = React.useCallback(() => {
    if (selectedIndex >= filteredItems.length) return;
    const item = filteredItems[selectedIndex];
    if (item?.type === 'plugin') {
      const state = pluginStates.find(s => s.plugin.name === item.plugin.name && s.marketplace === item.marketplace);
      if (state) {
        setSelectedPlugin(state);
        setViewState('plugin-details');
        setDetailsMenuIndex(0);
        setProcessError(null);
      }
    } else if (item?.type === 'flagged-plugin') {
      setViewState({
        type: 'flagged-detail',
        plugin: {
          id: item.id,
          name: item.name,
          marketplace: item.marketplace,
          reason: item.reason,
          text: item.text,
          flaggedAt: item.flaggedAt,
        },
      });
      setProcessError(null);
    } else if (item?.type === 'failed-plugin') {
      setViewState({
        type: 'failed-plugin-details',
        plugin: {
          id: item.id,
          name: item.name,
          marketplace: item.marketplace,
          errors: item.errors,
          scope: item.scope,
        },
      });
      setDetailsMenuIndex(0);
      setProcessError(null);
    } else if (item?.type === 'mcp') {
      setViewState({ type: 'mcp-detail', client: item.client });
      setProcessError(null);
    }
  }, [selectedIndex, filteredItems, pluginStates]);

  // 插件列表导航（非搜索模式）
  useKeybindings(
    {
      'select:previous': () => {
        if (selectedIndex === 0) {
          setIsSearchMode(true);
        } else {
          pagination.handleSelectionChange(selectedIndex - 1, setSelectedIndex);
        }
      },
      'select:next': () => {
        if (selectedIndex < filteredItems.length - 1) {
          pagination.handleSelectionChange(selectedIndex + 1, setSelectedIndex);
        }
      },
      'select:accept': handleAccept,
    },
    {
      context: 'Select',
      isActive: viewState === 'plugin-list' && !isSearchMode,
    },
  );

  useKeybindings(
    { 'plugin:toggle': handleToggle },
    {
      context: 'Plugin',
      isActive: viewState === 'plugin-list' && !isSearchMode,
    },
  );

  // 在 flagged-detail 视图中处理 dismiss 动作
  const handleFlaggedDismiss = React.useCallback(() => {
    if (typeof viewState !== 'object' || viewState.type !== 'flagged-detail') return;
    void removeFlaggedPlugin(viewState.plugin.id);
    setViewState('plugin-list');
  }, [viewState]);

  useKeybindings(
    { 'select:accept': handleFlaggedDismiss },
    {
      context: 'Select',
      isActive: typeof viewState === 'object' && viewState.type === 'flagged-detail',
    },
  );

  // 构造详情菜单项（导航所需）
  const detailsMenuItems = React.useMemo(() => {
    if (viewState !== 'plugin-details' || !selectedPlugin) return [];

    const mergedSettings = getSettings_DEPRECATED();
    const pluginId = `${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`;
    const isEnabled = mergedSettings?.enabledPlugins?.[pluginId] !== false;
    const isBuiltin = selectedPlugin.marketplace === 'builtin';

    const menuItems: Array<{ label: string; action: () => void }> = [];

    menuItems.push({
      label: isEnabled ? 'Disable plugin' : 'Enable plugin',
      action: () => void handleSingleOperation(isEnabled ? 'disable' : 'enable'),
    });

    // Update/Uninstall 选项 —— 内置插件不可用
    if (!isBuiltin) {
      menuItems.push({
        label: selectedPlugin.pendingUpdate ? 'Unmark for update' : 'Mark for update',
        action: async () => {
          try {
            const localError = await checkIfLocalPlugin(selectedPlugin.plugin.name, selectedPlugin.marketplace);

            if (localError) {
              setProcessError(localError);
              return;
            }

            const newStates = [...pluginStates];
            const index = newStates.findIndex(
              s => s.plugin.name === selectedPlugin.plugin.name && s.marketplace === selectedPlugin.marketplace,
            );
            if (index !== -1) {
              newStates[index]!.pendingUpdate = !selectedPlugin.pendingUpdate;
              setPluginStates(newStates);
              setSelectedPlugin({
                ...selectedPlugin,
                pendingUpdate: !selectedPlugin.pendingUpdate,
              });
            }
          } catch (error) {
            setProcessError(error instanceof Error ? error.message : 'Failed to check plugin update availability');
          }
        },
      });

      if (selectedPluginHasMcpb) {
        menuItems.push({
          label: 'Configure',
          action: async () => {
            setIsLoadingConfig(true);
            try {
              const mcpServersSpec = selectedPlugin.plugin.manifest.mcpServers;

              let mcpbPath: string | null = null;
              if (typeof mcpServersSpec === 'string' && isMcpbSource(mcpServersSpec)) {
                mcpbPath = mcpServersSpec;
              } else if (Array.isArray(mcpServersSpec)) {
                for (const spec of mcpServersSpec) {
                  if (typeof spec === 'string' && isMcpbSource(spec)) {
                    mcpbPath = spec;
                    break;
                  }
                }
              }

              if (!mcpbPath) {
                setProcessError('No MCPB file found in plugin');
                setIsLoadingConfig(false);
                return;
              }

              const pluginId = `${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`;
              const result = await loadMcpbFile(
                mcpbPath,
                selectedPlugin.plugin.path,
                pluginId,
                undefined,
                undefined,
                true,
              );

              if ('status' in result && result.status === 'needs-config') {
                setConfigNeeded(result);
                setViewState('configuring');
              } else {
                setProcessError('Failed to load MCPB for configuration');
              }
            } catch (err) {
              const errorMsg = errorMessage(err);
              setProcessError(`Failed to load configuration: ${errorMsg}`);
            } finally {
              setIsLoadingConfig(false);
            }
          },
        });
      }

      if (
        selectedPlugin.plugin.manifest.userConfig &&
        Object.keys(selectedPlugin.plugin.manifest.userConfig).length > 0
      ) {
        menuItems.push({
          label: 'Configure options',
          action: () => {
            setViewState({
              type: 'configuring-options',
              schema: selectedPlugin.plugin.manifest.userConfig!,
            });
          },
        });
      }

      menuItems.push({
        label: 'Update now',
        action: () => void handleSingleOperation('update'),
      });

      menuItems.push({
        label: 'Uninstall',
        action: () => void handleSingleOperation('uninstall'),
      });
    }

    if (selectedPlugin.plugin.manifest.homepage) {
      menuItems.push({
        label: 'Open homepage',
        action: () => void openBrowser(selectedPlugin.plugin.manifest.homepage!),
      });
    }

    if (selectedPlugin.plugin.manifest.repository) {
      menuItems.push({
        // 通用标签 —— manifest.repository 可能是 GitLab、Bitbucket、
        // Azure DevOps 等（gh-31598）。pluginDetailsHelpers.tsx:74 保留
        // 'View on GitHub'，因为该路径有显式的 isGitHub 检查。
        label: 'View repository',
        action: () => void openBrowser(selectedPlugin.plugin.manifest.repository!),
      });
    }

    menuItems.push({
      label: 'Back to plugin list',
      action: () => {
        setViewState('plugin-list');
        setSelectedPlugin(null);
        setProcessError(null);
      },
    });

    return menuItems;
  }, [viewState, selectedPlugin, selectedPluginHasMcpb, pluginStates]);

  // 插件详情导航
  useKeybindings(
    {
      'select:previous': () => {
        if (detailsMenuIndex > 0) {
          setDetailsMenuIndex(detailsMenuIndex - 1);
        }
      },
      'select:next': () => {
        if (detailsMenuIndex < detailsMenuItems.length - 1) {
          setDetailsMenuIndex(detailsMenuIndex + 1);
        }
      },
      'select:accept': () => {
        if (detailsMenuItems[detailsMenuIndex]) {
          detailsMenuItems[detailsMenuIndex]!.action();
        }
      },
    },
    {
      context: 'Select',
      isActive: viewState === 'plugin-details' && !!selectedPlugin,
    },
  );

  // failed-plugin-details：只有 "Uninstall" 选项，处理 Enter
  useKeybindings(
    {
      'select:accept': () => {
        if (typeof viewState === 'object' && viewState.type === 'failed-plugin-details') {
          void (async () => {
            setIsProcessing(true);
            setProcessError(null);
            const pluginId = viewState.plugin.id;
            const pluginScope = viewState.plugin.scope;
            // 把 scope 传给 uninstallPluginOp，让它能找到正确的 V2 安装
            // 记录并清理磁盘文件。如果不是可安装作用域则回退到默认
            // 作用域（例如 'managed'，不过那种情况已被下面的 isActive
            // 守卫）。deleteDataDir=false：这是加载失败插件的恢复路径 ——
            // 它可能可以重装，因此不要悄悄清除 ${CLAUDE_PLUGIN_DATA}。
            // 正常卸载路径会提示；这条路径保留数据。
            const result = isInstallableScope(pluginScope as PersistablePluginScope)
              ? await uninstallPluginOp(pluginId, pluginScope as InstallableScope, false)
              : await uninstallPluginOp(pluginId, 'user', false);
            let success = result.success;
            if (!success) {
              // 插件从未安装（只在 enabledPlugins 设置中）。
              // 直接从所有可编辑 settings source 中移除。
              const editableSources = ['userSettings' as const, 'projectSettings' as const, 'localSettings' as const];
              for (const source of editableSources) {
                const settings = getSettingsForSource(source);
                if (settings?.enabledPlugins?.[pluginId] !== undefined) {
                  updateSettingsForSource(source, {
                    enabledPlugins: {
                      ...settings.enabledPlugins,
                      [pluginId]: undefined,
                    },
                  });
                  success = true;
                }
              }
              // 清除 memoized 缓存，使下次 loadAllPlugins() 能感知 settings 变更
              clearAllCaches();
            }
            if (success) {
              if (onManageComplete) {
                await onManageComplete();
              }
              setIsProcessing(false);
              // 返回列表（不要 setResult —— 那会关闭整个对话框）
              setViewState('plugin-list');
            } else {
              setIsProcessing(false);
              setProcessError(result.message);
            }
          })();
        }
      },
    },
    {
      context: 'Select',
      isActive:
        typeof viewState === 'object' &&
        viewState.type === 'failed-plugin-details' &&
        viewState.plugin.scope !== 'managed',
    },
  );

  // confirm-project-uninstall：y/enter 在 settings.local.json 中禁用，n/escape 取消
  useKeybindings(
    {
      'confirm:yes': () => {
        if (!selectedPlugin) return;
        setIsProcessing(true);
        setProcessError(null);
        const pluginId = `${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`;
        // 直接写入 `false` —— disablePluginOp 的跨作用域守卫会拒绝
        // 此操作（插件尚未在 localSettings 中；覆盖就是目的本身）。
        const { error } = updateSettingsForSource('localSettings', {
          enabledPlugins: {
            ...getSettingsForSource('localSettings')?.enabledPlugins,
            [pluginId]: false,
          },
        });
        if (error) {
          setIsProcessing(false);
          setProcessError(`Failed to write settings: ${error.message}`);
          return;
        }
        clearAllCaches();
        setResult(
          `✓ Disabled ${selectedPlugin.plugin.name} in .hclaude/settings.local.json. Run /reload-plugins to apply.`,
        );
        if (onManageComplete) void onManageComplete();
        setParentViewState({ type: 'menu' });
      },
      'confirm:no': () => {
        setViewState('plugin-details');
        setProcessError(null);
      },
    },
    {
      context: 'Confirmation',
      isActive: viewState === 'confirm-project-uninstall' && !!selectedPlugin && !isProcessing,
    },
  );

  // confirm-data-cleanup：y 卸载并删除数据目录，n 卸载并保留，esc 取消。
  // 使用原始 useInput 的原因：(1) Confirmation 上下文将 enter 映射为
  // confirm:yes，这会让 Enter 删除数据目录 —— 这是一个 UI 文本
  // （"y to delete · n to keep"）未声明的破坏性默认；(2) 与
  // confirm-project-uninstall（使用 useKeybindings，其中 n 和 escape
  // 都映射到 confirm:no）不同，这里 n 和 escape 是不同动作
  // （keep-data 与 cancel），所以这里刻意保留在原始 useInput 上。
  // eslint-disable-next-line custom-rules/prefer-use-keybindings —— 原始 y/n/esc；Enter 不能触发破坏性删除
  useInput(
    (input, key) => {
      if (!selectedPlugin) return;
      const pluginId = `${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`;
      const pluginScope = selectedPlugin.scope;
      // 该对话框只能从 uninstall 分支进入（已对 isBuiltin 做了守卫），
      // 但 TS 无法跨 viewState 转换跟踪这一点。
      if (!pluginScope || pluginScope === 'builtin' || !isInstallableScope(pluginScope)) return;
      const doUninstall = async (deleteDataDir: boolean) => {
        setIsProcessing(true);
        setProcessError(null);
        try {
          const result = await uninstallPluginOp(pluginId, pluginScope, deleteDataDir);
          if (!result.success) throw new Error(result.message);
          clearAllCaches();
          const suffix = deleteDataDir ? '' : ' · data preserved';
          setResult(`${figures.tick} ${result.message}${suffix}`);
          if (onManageComplete) void onManageComplete();
          setParentViewState({ type: 'menu' });
        } catch (e) {
          setIsProcessing(false);
          setProcessError(e instanceof Error ? e.message : String(e));
        }
      };
      if (input === 'y' || input === 'Y') {
        void doUninstall(true);
      } else if (input === 'n' || input === 'N') {
        void doUninstall(false);
      } else if (key.escape) {
        setViewState('plugin-details');
        setProcessError(null);
      }
    },
    {
      isActive:
        typeof viewState === 'object' && viewState.type === 'confirm-data-cleanup' && !!selectedPlugin && !isProcessing,
    },
  );

  // 当搜索查询变化时重置选择
  React.useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery]);

  // 处理用于进入搜索模式的输入（文本输入由 useSearchInput hook 处理）
  // eslint-disable-next-line custom-rules/prefer-use-keybindings —— 搜索模式需要 useInput 来接收原始文本输入
  useInput(
    (input, key) => {
      const keyIsNotCtrlOrMeta = !key.ctrl && !key.meta;
      if (isSearchMode) {
        // 文本输入由 useSearchInput hook 处理
        return;
      }

      // 通过 '/' 或任意可打印字符（导航键除外）进入搜索模式
      if (input === '/' && keyIsNotCtrlOrMeta) {
        setIsSearchMode(true);
        setSearchQuery('');
        setSelectedIndex(0);
      } else if (
        keyIsNotCtrlOrMeta &&
        input.length > 0 &&
        !/^\s+$/.test(input) &&
        input !== 'j' &&
        input !== 'k' &&
        input !== ' '
      ) {
        setIsSearchMode(true);
        setSearchQuery(input);
        setSelectedIndex(0);
      }
    },
    { isActive: viewState === 'plugin-list' },
  );

  // 加载状态
  if (loading) {
    return <Text>Loading installed plugins…</Text>;
  }

  // 未安装任何插件或 MCP
  if (unifiedItems.length === 0) {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Manage plugins</Text>
        </Box>
        <Text>No plugins or MCP servers installed.</Text>
        <Box marginTop={1}>
          <Text dimColor>Esc to go back</Text>
        </Box>
      </Box>
    );
  }

  if (typeof viewState === 'object' && viewState.type === 'plugin-options' && selectedPlugin) {
    const pluginId = `${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`;
    function finish(msg: string): void {
      setResult(msg);
      // 无论配置保存还是跳过，插件都已经启用 —— onManageComplete →
      // markPluginsChanged → 持久的 "run /reload-plugins" 提示。
      if (onManageComplete) {
        void onManageComplete();
      }
      setParentViewState({ type: 'menu' });
    }
    return (
      <PluginOptionsFlow
        plugin={selectedPlugin.plugin}
        pluginId={pluginId}
        onDone={(outcome, detail) => {
          switch (outcome) {
            case 'configured':
              finish(`✓ Enabled and configured ${selectedPlugin.plugin.name}. Run /reload-plugins to apply.`);
              break;
            case 'skipped':
              finish(`✓ Enabled ${selectedPlugin.plugin.name}. Run /reload-plugins to apply.`);
              break;
            case 'error':
              finish(`Failed to save configuration: ${detail}`);
              break;
          }
        }}
      />
    );
  }

  // 配置选项（来自 Manage 菜单）
  if (typeof viewState === 'object' && viewState.type === 'configuring-options' && selectedPlugin) {
    const pluginId = `${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`;
    return (
      <PluginOptionsDialog
        title={`Configure ${selectedPlugin.plugin.name}`}
        subtitle="Plugin options"
        configSchema={viewState.schema}
        initialValues={loadPluginOptions(pluginId)}
        onSave={values => {
          try {
            savePluginOptions(pluginId, values, viewState.schema);
            clearAllCaches();
            setResult('Configuration saved. Run /reload-plugins for changes to take effect.');
          } catch (err) {
            setProcessError(`Failed to save configuration: ${errorMessage(err)}`);
          }
          setViewState('plugin-details');
        }}
        onCancel={() => setViewState('plugin-details')}
      />
    );
  }

  // 配置视图
  if (viewState === 'configuring' && configNeeded && selectedPlugin) {
    const pluginId = `${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`;

    async function handleSave(config: UserConfigValues) {
      if (!configNeeded || !selectedPlugin) return;

      try {
        // 再次查找 MCPB 路径
        const mcpServersSpec = selectedPlugin.plugin.manifest.mcpServers;
        let mcpbPath: string | null = null;

        if (typeof mcpServersSpec === 'string' && isMcpbSource(mcpServersSpec)) {
          mcpbPath = mcpServersSpec;
        } else if (Array.isArray(mcpServersSpec)) {
          for (const spec of mcpServersSpec) {
            if (typeof spec === 'string' && isMcpbSource(spec)) {
              mcpbPath = spec;
              break;
            }
          }
        }

        if (!mcpbPath) {
          setProcessError('No MCPB file found');
          setViewState('plugin-details');
          return;
        }

        // 使用提供的配置重新加载
        await loadMcpbFile(mcpbPath, selectedPlugin.plugin.path, pluginId, undefined, config);

        // 成功 —— 返回详情
        setProcessError(null);
        setConfigNeeded(null);
        setViewState('plugin-details');
        setResult('Configuration saved. Run /reload-plugins for changes to take effect.');
      } catch (err) {
        const errorMsg = errorMessage(err);
        setProcessError(`Failed to save configuration: ${errorMsg}`);
        setViewState('plugin-details');
      }
    }

    function handleCancel() {
      setConfigNeeded(null);
      setViewState('plugin-details');
    }

    return (
      <PluginOptionsDialog
        title={`Configure ${configNeeded.manifest.name}`}
        subtitle={`Plugin: ${selectedPlugin.plugin.name}`}
        configSchema={configNeeded.configSchema}
        initialValues={configNeeded.existingConfig}
        onSave={handleSave}
        onCancel={handleCancel}
      />
    );
  }

  // 被标记插件的详情视图
  if (typeof viewState === 'object' && viewState.type === 'flagged-detail') {
    const fp = viewState.plugin;
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>
            {fp.name} @ {fp.marketplace}
          </Text>
        </Box>

        <Box marginBottom={1}>
          <Text dimColor>Status: </Text>
          <Text color="error">Removed</Text>
        </Box>

        <Box marginBottom={1} flexDirection="column">
          <Text color="error">Removed from marketplace · reason: {fp.reason}</Text>
          <Text>{fp.text}</Text>
          <Text dimColor>Flagged on {new Date(fp.flaggedAt).toLocaleDateString()}</Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text>{figures.pointer} </Text>
            <Text color="suggestion">Dismiss</Text>
          </Box>
        </Box>

        <Byline>
          <ConfigurableShortcutHint action="select:accept" context="Select" fallback="Enter" description="dismiss" />
          <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="back" />
        </Byline>
      </Box>
    );
  }

  // confirm-project-uninstall：警告共享的 .hclaude/settings.json，
  // 提供改为在 settings.local.json 中禁用的选项。
  if (viewState === 'confirm-project-uninstall' && selectedPlugin) {
    return (
      <Box flexDirection="column">
        <Text bold color="warning">
          {selectedPlugin.plugin.name} is enabled in .hclaude/settings.json (shared with your team)
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text>Disable it just for you in .hclaude/settings.local.json?</Text>
          <Text dimColor>This has the same effect as uninstalling, without affecting other contributors.</Text>
        </Box>
        {processError && (
          <Box marginTop={1}>
            <Text color="error">{processError}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          {isProcessing ? (
            <Text dimColor>Disabling…</Text>
          ) : (
            <Byline>
              <ConfigurableShortcutHint
                action="confirm:yes"
                context="Confirmation"
                fallback="y"
                description="disable"
              />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description="cancel"
              />
            </Byline>
          )}
        </Box>
      </Box>
    );
  }

  // confirm-data-cleanup：删除 ${CLAUDE_PLUGIN_DATA} 目录前提示
  if (typeof viewState === 'object' && viewState.type === 'confirm-data-cleanup' && selectedPlugin) {
    return (
      <Box flexDirection="column">
        <Text bold>
          {selectedPlugin.plugin.name} has {viewState.size.human} of persistent data
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text>Delete it along with the plugin?</Text>
          <Text dimColor>{pluginDataDirPath(`${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`)}</Text>
        </Box>
        {processError && (
          <Box marginTop={1}>
            <Text color="error">{processError}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          {isProcessing ? (
            <Text dimColor>Uninstalling…</Text>
          ) : (
            <Text>
              <Text bold>y</Text> to delete · <Text bold>n</Text> to keep · <Text bold>esc</Text> to cancel
            </Text>
          )}
        </Box>
      </Box>
    );
  }

  // 插件详情视图
  if (viewState === 'plugin-details' && selectedPlugin) {
    const mergedSettings = getSettings_DEPRECATED(); // 使用合并后的 settings 以尊重所有层级
    const pluginId = `${selectedPlugin.plugin.name}@${selectedPlugin.marketplace}`;
    const isEnabled = mergedSettings?.enabledPlugins?.[pluginId] !== false;

    // 计算插件错误段
    const filteredPluginErrors = pluginErrors.filter(
      e =>
        ('plugin' in e && e.plugin === selectedPlugin.plugin.name) ||
        e.source === pluginId ||
        e.source.startsWith(`${selectedPlugin.plugin.name}@`),
    );
    const pluginErrorsSection =
      filteredPluginErrors.length === 0 ? null : (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="error">
            {filteredPluginErrors.length} {plural(filteredPluginErrors.length, 'error')}:
          </Text>
          {filteredPluginErrors.map((error, i) => {
            const guidance = getErrorGuidance(error);
            return (
              <Box key={i} flexDirection="column" marginLeft={2}>
                <Text color="error">{formatErrorMessage(error)}</Text>
                {guidance && (
                  <Text dimColor italic>
                    {figures.arrowRight} {guidance}
                  </Text>
                )}
              </Box>
            );
          })}
        </Box>
      );

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>
            {selectedPlugin.plugin.name} @ {selectedPlugin.marketplace}
          </Text>
        </Box>

        {/* 作用域 */}
        <Box>
          <Text dimColor>Scope: </Text>
          <Text>{selectedPlugin.scope || 'user'}</Text>
        </Box>

        {/* 插件详情 */}
        {selectedPlugin.plugin.manifest.version && (
          <Box>
            <Text dimColor>Version: </Text>
            <Text>{selectedPlugin.plugin.manifest.version}</Text>
          </Box>
        )}

        {selectedPlugin.plugin.manifest.description && (
          <Box marginBottom={1}>
            <Text>{selectedPlugin.plugin.manifest.description}</Text>
          </Box>
        )}

        {selectedPlugin.plugin.manifest.author && (
          <Box>
            <Text dimColor>Author: </Text>
            <Text>{selectedPlugin.plugin.manifest.author.name}</Text>
          </Box>
        )}

        {/* 当前状态 */}
        <Box marginBottom={1}>
          <Text dimColor>Status: </Text>
          <Text color={isEnabled ? 'success' : 'warning'}>{isEnabled ? 'Enabled' : 'Disabled'}</Text>
          {selectedPlugin.pendingUpdate && <Text color="suggestion"> · Marked for update</Text>}
        </Box>

        {/* 已安装组件 */}
        <PluginComponentsDisplay plugin={selectedPlugin.plugin} marketplace={selectedPlugin.marketplace} />

        {/* 插件错误 */}
        {pluginErrorsSection}

        {/* 菜单 */}
        <Box marginTop={1} flexDirection="column">
          {detailsMenuItems.map((item, index) => {
            const isSelected = index === detailsMenuIndex;

            return (
              <Box key={index}>
                {isSelected && <Text>{figures.pointer} </Text>}
                {!isSelected && <Text>{'  '}</Text>}
                <Text
                  bold={isSelected}
                  color={
                    item.label.includes('Uninstall')
                      ? 'error'
                      : item.label.includes('Update')
                        ? 'suggestion'
                        : undefined
                  }
                >
                  {item.label}
                </Text>
              </Box>
            );
          })}
        </Box>

        {/* 处理状态 */}
        {isProcessing && (
          <Box marginTop={1}>
            <Text>Processing…</Text>
          </Box>
        )}

        {/* 错误信息 */}
        {processError && (
          <Box marginTop={1}>
            <Text color="error">{processError}</Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor italic>
            <Byline>
              <ConfigurableShortcutHint action="select:previous" context="Select" fallback="↑" description="navigate" />
              <ConfigurableShortcutHint action="select:accept" context="Select" fallback="Enter" description="select" />
              <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="back" />
            </Byline>
          </Text>
        </Box>
      </Box>
    );
  }

  // 失败插件的详情视图
  if (typeof viewState === 'object' && viewState.type === 'failed-plugin-details') {
    const failedPlugin = viewState.plugin;

    const firstError = failedPlugin.errors[0];
    const errorMessage = firstError ? formatErrorMessage(firstError) : 'Failed to load';

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{failedPlugin.name}</Text>
          <Text dimColor> @ {failedPlugin.marketplace}</Text>
          <Text dimColor> ({failedPlugin.scope})</Text>
        </Text>
        <Text color="error">{errorMessage}</Text>

        {failedPlugin.scope === 'managed' ? (
          <Box marginTop={1}>
            <Text dimColor>Managed by your organization — contact your admin</Text>
          </Box>
        ) : (
          <Box marginTop={1}>
            <Text color="suggestion">{figures.pointer} </Text>
            <Text bold>Remove</Text>
          </Box>
        )}

        {isProcessing && <Text>Processing…</Text>}
        {processError && <Text color="error">{processError}</Text>}

        <Box marginTop={1}>
          <Text dimColor italic>
            <Byline>
              {failedPlugin.scope !== 'managed' && (
                <ConfigurableShortcutHint
                  action="select:accept"
                  context="Select"
                  fallback="Enter"
                  description="remove"
                />
              )}
              <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="back" />
            </Byline>
          </Text>
        </Box>
      </Box>
    );
  }

  // MCP 详情视图
  if (typeof viewState === 'object' && viewState.type === 'mcp-detail') {
    const client = viewState.client;
    const serverToolsCount = filterToolsByServer(mcpTools, client.name).length;

    // MCP 菜单的通用处理器
    const handleMcpViewTools = () => {
      setViewState({ type: 'mcp-tools', client });
    };

    const handleMcpCancel = () => {
      setViewState('plugin-list');
    };

    const handleMcpComplete = (result?: string) => {
      if (result) {
        setResult(result);
      }
      setViewState('plugin-list');
    };

    // 将 MCPServerConnection 转换为合适的 ServerInfo 类型
    const scope = client.config.scope;
    const configType = client.config.type;

    if (configType === 'stdio') {
      const server: StdioServerInfo = {
        name: client.name,
        client,
        scope,
        transport: 'stdio',
        config: client.config as McpStdioServerConfig,
      };
      return (
        <MCPStdioServerMenu
          server={server}
          serverToolsCount={serverToolsCount}
          onViewTools={handleMcpViewTools}
          onCancel={handleMcpCancel}
          onComplete={handleMcpComplete}
          borderless
        />
      );
    } else if (configType === 'sse') {
      const server: SSEServerInfo = {
        name: client.name,
        client,
        scope,
        transport: 'sse',
        isAuthenticated: undefined,
        config: client.config as McpSSEServerConfig,
      };
      return (
        <MCPRemoteServerMenu
          server={server}
          serverToolsCount={serverToolsCount}
          onViewTools={handleMcpViewTools}
          onCancel={handleMcpCancel}
          onComplete={handleMcpComplete}
          borderless
        />
      );
    } else if (configType === 'http') {
      const server: HTTPServerInfo = {
        name: client.name,
        client,
        scope,
        transport: 'http',
        isAuthenticated: undefined,
        config: client.config as McpHTTPServerConfig,
      };
      return (
        <MCPRemoteServerMenu
          server={server}
          serverToolsCount={serverToolsCount}
          onViewTools={handleMcpViewTools}
          onCancel={handleMcpCancel}
          onComplete={handleMcpComplete}
          borderless
        />
      );
    } else if (configType === 'claudeai-proxy') {
      const server: ClaudeAIServerInfo = {
        name: client.name,
        client,
        scope,
        transport: 'claudeai-proxy',
        isAuthenticated: undefined,
        config: client.config as McpClaudeAIProxyServerConfig,
      };
      return (
        <MCPRemoteServerMenu
          server={server}
          serverToolsCount={serverToolsCount}
          onViewTools={handleMcpViewTools}
          onCancel={handleMcpCancel}
          onComplete={handleMcpComplete}
          borderless
        />
      );
    }

    // 兜底 —— 不应发生，但优雅处理
    setViewState('plugin-list');
    return null;
  }

  // MCP 工具视图
  if (typeof viewState === 'object' && viewState.type === 'mcp-tools') {
    const client = viewState.client;
    const scope = client.config.scope;
    const configType = client.config.type;

    // 为 MCPToolListView 构造 ServerInfo
    let server: StdioServerInfo | SSEServerInfo | HTTPServerInfo | ClaudeAIServerInfo;
    if (configType === 'stdio') {
      server = {
        name: client.name,
        client,
        scope,
        transport: 'stdio',
        config: client.config as McpStdioServerConfig,
      };
    } else if (configType === 'sse') {
      server = {
        name: client.name,
        client,
        scope,
        transport: 'sse',
        isAuthenticated: undefined,
        config: client.config as McpSSEServerConfig,
      };
    } else if (configType === 'http') {
      server = {
        name: client.name,
        client,
        scope,
        transport: 'http',
        isAuthenticated: undefined,
        config: client.config as McpHTTPServerConfig,
      };
    } else {
      server = {
        name: client.name,
        client,
        scope,
        transport: 'claudeai-proxy',
        isAuthenticated: undefined,
        config: client.config as McpClaudeAIProxyServerConfig,
      };
    }

    return (
      <MCPToolListView
        server={server}
        onSelectTool={(tool: Tool) => {
          setViewState({ type: 'mcp-tool-detail', client, tool });
        }}
        onBack={() => setViewState({ type: 'mcp-detail', client })}
      />
    );
  }

  // MCP 工具详情视图
  if (typeof viewState === 'object' && viewState.type === 'mcp-tool-detail') {
    const { client, tool } = viewState;
    const scope = client.config.scope;
    const configType = client.config.type;

    // 为 MCPToolDetailView 构造 ServerInfo
    let server: StdioServerInfo | SSEServerInfo | HTTPServerInfo | ClaudeAIServerInfo;
    if (configType === 'stdio') {
      server = {
        name: client.name,
        client,
        scope,
        transport: 'stdio',
        config: client.config as McpStdioServerConfig,
      };
    } else if (configType === 'sse') {
      server = {
        name: client.name,
        client,
        scope,
        transport: 'sse',
        isAuthenticated: undefined,
        config: client.config as McpSSEServerConfig,
      };
    } else if (configType === 'http') {
      server = {
        name: client.name,
        client,
        scope,
        transport: 'http',
        isAuthenticated: undefined,
        config: client.config as McpHTTPServerConfig,
      };
    } else {
      server = {
        name: client.name,
        client,
        scope,
        transport: 'claudeai-proxy',
        isAuthenticated: undefined,
        config: client.config as McpClaudeAIProxyServerConfig,
      };
    }

    return <MCPToolDetailView tool={tool} server={server} onBack={() => setViewState({ type: 'mcp-tools', client })} />;
  }

  // 插件列表视图（主管理界面）
  const visibleItems = pagination.getVisibleItems(filteredItems);

  return (
    <Box flexDirection="column">
      {/* 搜索框 */}
      <Box marginBottom={1}>
        <SearchBox
          query={searchQuery}
          isFocused={isSearchMode}
          isTerminalFocused={isTerminalFocused}
          width={terminalWidth - 4}
          cursorOffset={searchCursorOffset}
        />
      </Box>

      {/* 无搜索结果 */}
      {filteredItems.length === 0 && searchQuery && (
        <Box marginBottom={1}>
          <Text dimColor>No items match &quot;{searchQuery}&quot;</Text>
        </Box>
      )}

      {/* 向上滚动指示器 */}
      {pagination.scrollPosition.canScrollUp && (
        <Box>
          <Text dimColor> {figures.arrowUp} more above</Text>
        </Box>
      )}

      {/* 按作用域分组的插件和 MCP 统一列表 */}
      {visibleItems.map((item, visibleIndex) => {
        const actualIndex = pagination.toActualIndex(visibleIndex);
        const isSelected = actualIndex === selectedIndex && !isSearchMode;

        // 检查是否需要显示作用域标题
        const prevItem = visibleIndex > 0 ? visibleItems[visibleIndex - 1] : null;
        const showScopeHeader = !prevItem || prevItem.scope !== item.scope;

        // 获取作用域标签
        const getScopeLabel = (scope: string): string => {
          switch (scope) {
            case 'flagged':
              return 'Flagged';
            case 'project':
              return 'Project';
            case 'local':
              return 'Local';
            case 'user':
              return 'User';
            case 'enterprise':
              return 'Enterprise';
            case 'managed':
              return 'Managed';
            case 'builtin':
              return 'Built-in';
            case 'dynamic':
              return 'Built-in';
            default:
              return scope;
          }
        };

        return (
          <React.Fragment key={item.id}>
            {showScopeHeader && (
              <Box marginTop={visibleIndex > 0 ? 1 : 0} paddingLeft={2}>
                <Text
                  dimColor={item.scope !== 'flagged'}
                  color={item.scope === 'flagged' ? 'warning' : undefined}
                  bold={item.scope === 'flagged'}
                >
                  {getScopeLabel(item.scope)}
                </Text>
              </Box>
            )}
            <UnifiedInstalledCell item={item} isSelected={isSelected} />
          </React.Fragment>
        );
      })}

      {/* 向下滚动指示器 */}
      {pagination.scrollPosition.canScrollDown && (
        <Box>
          <Text dimColor> {figures.arrowDown} more below</Text>
        </Box>
      )}

      {/* 帮助文本 */}
      <Box marginTop={1} marginLeft={1}>
        <Text dimColor italic>
          <Byline>
            <Text>type to search</Text>
            <ConfigurableShortcutHint action="plugin:toggle" context="Plugin" fallback="Space" description="toggle" />
            <ConfigurableShortcutHint action="select:accept" context="Select" fallback="Enter" description="details" />
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="back" />
          </Byline>
        </Text>
      </Box>

      {/* 插件变更的重载声明 */}
      {pendingToggles.size > 0 && (
        <Box marginLeft={1}>
          <Text dimColor italic>
            Run /reload-plugins to apply changes
          </Text>
        </Box>
      )}
    </Box>
  );
}
