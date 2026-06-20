import figures from 'figures';
import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js';
import { Byline, Pane, Tab, Tabs } from '@anthropic/ink';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Text } from '@anthropic/ink';
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js';
import { useAppState, useSetAppState } from '../../state/AppState.js';
import type { PluginError } from '../../types/plugin.js';
import { errorMessage } from '../../utils/errors.js';
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js';
import { loadMarketplacesWithGracefulDegradation } from '../../utils/plugins/marketplaceHelpers.js';
import { loadKnownMarketplacesConfig, removeMarketplaceSource } from '../../utils/plugins/marketplaceManager.js';
import { getPluginEditableScopes } from '../../utils/plugins/pluginStartupCheck.js';
import type { EditableSettingSource } from '../../utils/settings/constants.js';
import { getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js';
import { AddMarketplace } from './AddMarketplace.js';
import { BrowseMarketplace } from './BrowseMarketplace.js';
import { DiscoverPlugins } from './DiscoverPlugins.js';
import { ManageMarketplaces } from './ManageMarketplaces.js';
import { ManagePlugins } from './ManagePlugins.js';
import { formatErrorMessage, getErrorGuidance } from './PluginErrors.js';
import { type ParsedCommand, parsePluginArgs } from './parseArgs.js';
import type { PluginSettingsProps, ViewState } from './types.js';
import { ValidatePlugin } from './ValidatePlugin.js';

type TabId = 'discover' | 'installed' | 'marketplaces' | 'errors';

function MarketplaceList({ onComplete }: { onComplete: (result?: string) => void }): React.ReactNode {
  useEffect(() => {
    async function loadList() {
      try {
        const config = await loadKnownMarketplacesConfig();
        const names = Object.keys(config);

        if (names.length === 0) {
          onComplete('No marketplaces configured');
        } else {
          onComplete(`Configured marketplaces:\n${names.map(n => `  • ${n}`).join('\n')}`);
        }
      } catch (err) {
        onComplete(`Error loading marketplaces: ${errorMessage(err)}`);
      }
    }

    void loadList();
  }, [onComplete]);

  return <Text>Loading marketplaces...</Text>;
}

function McpRedirectBanner(): React.ReactNode {
  if ((process.env.USER_TYPE as string) !== 'ant') {
    return null;
  }

  return (
    <Box
      flexDirection="row"
      alignItems="flex-start"
      paddingLeft={1}
      marginTop={1}
      borderLeft
      borderRight={false}
      borderTop={false}
      borderBottom={false}
      borderColor="permission"
      borderStyle="single"
    >
      <Box flexShrink={0}>
        <Text bold italic color="permission">
          i{' '}
        </Text>
      </Box>
      <Text>[ANT-ONLY] MCP servers are now managed in /plugins. Use /mcp no-redirect to test old UI</Text>
    </Box>
  );
}

type ErrorRowAction =
  | { kind: 'navigate'; tab: TabId; viewState: ViewState }
  | {
      kind: 'remove-extra-marketplace';
      name: string;
      sources: Array<{ source: EditableSettingSource; scope: string }>;
    }
  | { kind: 'remove-installed-marketplace'; name: string }
  | { kind: 'managed-only'; name: string }
  | { kind: 'none' };

type ErrorRow = {
  label: string;
  message: string;
  guidance?: string | null;
  action: ErrorRowAction;
  scope?: string;
};

/**
 * 判断哪些 settings source 定义了一个 extraKnownMarketplace 条目。
 * 返回可编辑的 source（user/project/local）以及策略中是否也包含它。
 */
function getExtraMarketplaceSourceInfo(name: string): {
  editableSources: Array<{ source: EditableSettingSource; scope: string }>;
  isInPolicy: boolean;
} {
  const editableSources: Array<{
    source: EditableSettingSource;
    scope: string;
  }> = [];

  const sourcesToCheck = [
    { source: 'userSettings' as const, scope: 'user' },
    { source: 'projectSettings' as const, scope: 'project' },
    { source: 'localSettings' as const, scope: 'local' },
  ];

  for (const { source, scope } of sourcesToCheck) {
    const settings = getSettingsForSource(source);
    if (settings?.extraKnownMarketplaces?.[name]) {
      editableSources.push({ source, scope });
    }
  }

  const policySettings = getSettingsForSource('policySettings');
  const isInPolicy = Boolean(policySettings?.extraKnownMarketplaces?.[name]);

  return { editableSources, isInPolicy };
}

function buildMarketplaceAction(name: string): ErrorRowAction {
  const { editableSources, isInPolicy } = getExtraMarketplaceSourceInfo(name);

  if (editableSources.length > 0) {
    return {
      kind: 'remove-extra-marketplace',
      name,
      sources: editableSources,
    };
  }

  if (isInPolicy) {
    return { kind: 'managed-only', name };
  }

  // 市场位于 known_marketplaces.json 中但不在 extraKnownMarketplaces 里
  // （例如之前手动安装过）—— 路由到 ManageMarketplaces
  return {
    kind: 'navigate',
    tab: 'marketplaces',
    viewState: {
      type: 'manage-marketplaces',
      targetMarketplace: name,
      action: 'remove',
    },
  };
}

function buildPluginAction(pluginName: string): ErrorRowAction {
  return {
    kind: 'navigate',
    tab: 'installed',
    viewState: {
      type: 'manage-plugins',
      targetPlugin: pluginName,
      action: 'uninstall',
    },
  };
}

const TRANSIENT_ERROR_TYPES = new Set(['git-auth-failed', 'git-timeout', 'network-error']);

function isTransientError(error: PluginError): boolean {
  return TRANSIENT_ERROR_TYPES.has(error.type);
}

/**
 * 从 PluginError 中提取插件名，先检查显式字段，
 * 再回退到 source 字段（格式为 "pluginName@marketplace"）。
 */
function getPluginNameFromError(error: PluginError): string | undefined {
  if ('pluginId' in error && error.pluginId) return error.pluginId;
  if ('plugin' in error && error.plugin) return error.plugin;
  // 回退：source 通常包含 "pluginName@marketplace"
  if (error.source.includes('@')) return error.source.split('@')[0];
  return undefined;
}

function buildErrorRows(
  failedMarketplaces: Array<{ name: string; error?: string }>,
  extraMarketplaceErrors: PluginError[],
  pluginLoadingErrors: PluginError[],
  otherErrors: PluginError[],
  brokenInstalledMarketplaces: Array<{ name: string; error: string }>,
  transientErrors: PluginError[],
  pluginScopes: Map<string, string>,
): ErrorRow[] {
  const rows: ErrorRow[] = [];

  // --- 临时性错误置于顶部（重启后重试） ---
  for (const error of transientErrors) {
    const pluginName = 'pluginId' in error ? error.pluginId : 'plugin' in error ? error.plugin : undefined;
    rows.push({
      label: pluginName ?? error.source,
      message: formatErrorMessage(error),
      guidance: 'Restart to retry loading plugins',
      action: { kind: 'none' },
    });
  }

  // --- 市场错误 ---
  // 跟踪已展示的市场名，避免跨 source 重复
  const shownMarketplaceNames = new Set<string>();

  for (const m of failedMarketplaces) {
    shownMarketplaceNames.add(m.name);
    const action = buildMarketplaceAction(m.name);
    const sourceInfo = getExtraMarketplaceSourceInfo(m.name);
    const scope = sourceInfo.isInPolicy ? 'managed' : sourceInfo.editableSources[0]?.scope;
    rows.push({
      label: m.name,
      message: m.error ?? 'Installation failed',
      guidance: action.kind === 'managed-only' ? 'Managed by your organization — contact your admin' : undefined,
      action,
      scope,
    });
  }

  for (const e of extraMarketplaceErrors) {
    const marketplace = 'marketplace' in e ? e.marketplace : e.source;
    if (shownMarketplaceNames.has(marketplace)) continue;
    shownMarketplaceNames.add(marketplace);
    const action = buildMarketplaceAction(marketplace);
    const sourceInfo = getExtraMarketplaceSourceInfo(marketplace);
    const scope = sourceInfo.isInPolicy ? 'managed' : sourceInfo.editableSources[0]?.scope;
    rows.push({
      label: marketplace,
      message: formatErrorMessage(e),
      guidance:
        action.kind === 'managed-only' ? 'Managed by your organization — contact your admin' : getErrorGuidance(e),
      action,
      scope,
    });
  }

  // 已安装但加载其数据失败的市场（来自 known_marketplaces.json）
  for (const m of brokenInstalledMarketplaces) {
    if (shownMarketplaceNames.has(m.name)) continue;
    shownMarketplaceNames.add(m.name);
    rows.push({
      label: m.name,
      message: m.error,
      action: { kind: 'remove-installed-marketplace', name: m.name },
    });
  }

  // --- 插件错误 ---
  const shownPluginNames = new Set<string>();
  for (const error of pluginLoadingErrors) {
    const pluginName = getPluginNameFromError(error);
    if (pluginName && shownPluginNames.has(pluginName)) continue;
    if (pluginName) shownPluginNames.add(pluginName);

    const marketplace = 'marketplace' in error ? error.marketplace : undefined;
    // 先尝试 pluginId@marketplace 格式，再退回到仅 pluginName
    const scope = pluginName ? (pluginScopes.get(error.source) ?? pluginScopes.get(pluginName)) : undefined;
    rows.push({
      label: pluginName ? (marketplace ? `${pluginName} @ ${marketplace}` : pluginName) : error.source,
      message: formatErrorMessage(error),
      guidance: getErrorGuidance(error),
      action: pluginName ? buildPluginAction(pluginName) : { kind: 'none' },
      scope,
    });
  }

  // --- 其他错误（非市场、非特定插件） ---
  for (const error of otherErrors) {
    rows.push({
      label: error.source,
      message: formatErrorMessage(error),
      guidance: getErrorGuidance(error),
      action: { kind: 'none' },
    });
  }

  return rows;
}

/**
 * 从给定 settings source 的 extraKnownMarketplaces 中移除一个市场，
 * 同时移除任何关联的已启用插件。
 */
function removeExtraMarketplace(name: string, sources: Array<{ source: EditableSettingSource }>): void {
  for (const { source } of sources) {
    const settings = getSettingsForSource(source);
    if (!settings) continue;

    const updates: Record<string, unknown> = {};

    // 从 extraKnownMarketplaces 中移除
    if (settings.extraKnownMarketplaces?.[name]) {
      updates.extraKnownMarketplaces = {
        ...settings.extraKnownMarketplaces,
        [name]: undefined,
      };
    }

    // 移除关联的已启用插件（格式："plugin@marketplace"）
    if (settings.enabledPlugins) {
      const suffix = `@${name}`;
      let removedPlugins = false;
      const updatedPlugins = { ...settings.enabledPlugins };
      for (const pluginId in updatedPlugins) {
        if (pluginId.endsWith(suffix)) {
          updatedPlugins[pluginId] = undefined;
          removedPlugins = true;
        }
      }
      if (removedPlugins) {
        updates.enabledPlugins = updatedPlugins;
      }
    }

    if (Object.keys(updates).length > 0) {
      updateSettingsForSource(source, updates);
    }
  }
}

function ErrorsTabContent({
  setViewState,
  setActiveTab,
  markPluginsChanged,
}: {
  setViewState: (state: ViewState) => void;
  setActiveTab: (tab: TabId) => void;
  markPluginsChanged: () => void;
}): React.ReactNode {
  const errors = useAppState(s => s.plugins.errors);
  const installationStatus = useAppState(s => s.plugins.installationStatus);
  const setAppState = useSetAppState();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [marketplaceLoadFailures, setMarketplaceLoadFailures] = useState<Array<{ name: string; error: string }>>([]);

  // 检测已安装但加载其数据失败的市场
  useEffect(() => {
    void (async () => {
      try {
        const config = await loadKnownMarketplacesConfig();
        const { failures } = await loadMarketplacesWithGracefulDegradation(config);
        setMarketplaceLoadFailures(failures);
      } catch {
        // 忽略 —— 如果无法加载配置，其他标签页会处理
      }
    })();
  }, []);

  const failedMarketplaces = installationStatus.marketplaces.filter(m => m.status === 'failed');
  const failedMarketplaceNames = new Set(failedMarketplaces.map(m => m.name));

  // 临时性错误（git/网络）—— 置于顶部并显示 "restart to retry"
  const transientErrors = errors.filter(isTransientError);

  // 与市场相关、但未被安装失败覆盖的加载错误
  const extraMarketplaceErrors = errors.filter(
    e =>
      (e.type === 'marketplace-not-found' ||
        e.type === 'marketplace-load-failed' ||
        e.type === 'marketplace-blocked-by-policy') &&
      !failedMarketplaceNames.has(e.marketplace),
  );

  // 特定插件的加载错误
  const pluginLoadingErrors = errors.filter(e => {
    if (isTransientError(e)) return false;
    if (
      e.type === 'marketplace-not-found' ||
      e.type === 'marketplace-load-failed' ||
      e.type === 'marketplace-blocked-by-policy'
    ) {
      return false;
    }
    return getPluginNameFromError(e) !== undefined;
  });

  // 没有关联插件的剩余错误
  const otherErrors = errors.filter(e => {
    if (isTransientError(e)) return false;
    if (
      e.type === 'marketplace-not-found' ||
      e.type === 'marketplace-load-failed' ||
      e.type === 'marketplace-blocked-by-policy'
    ) {
      return false;
    }
    return getPluginNameFromError(e) === undefined;
  });

  const pluginScopes = getPluginEditableScopes();
  const rows = buildErrorRows(
    failedMarketplaces,
    extraMarketplaceErrors,
    pluginLoadingErrors,
    otherErrors,
    marketplaceLoadFailures,
    transientErrors,
    pluginScopes,
  );

  // 处理 Esc 退出插件菜单
  useKeybinding(
    'confirm:no',
    () => {
      setViewState({ type: 'menu' });
    },
    { context: 'Confirmation' },
  );

  const handleSelect = () => {
    const row = rows[selectedIndex];
    if (!row) return;
    const { action } = row;
    switch (action.kind) {
      case 'navigate':
        setActiveTab(action.tab);
        setViewState(action.viewState);
        break;
      case 'remove-extra-marketplace': {
        const scopes = action.sources.map(s => s.scope).join(', ');
        removeExtraMarketplace(action.name, action.sources);
        clearAllCaches();
        // 同步清除此市场的所有过期状态，让 UI 更新无卡顿。
        // markPluginsChanged 只设置 needsRefresh —— 它不会刷新
        // plugins.errors，因此在用户运行 /reload-plugins 之前，这是
        // 权威性的清理。
        setAppState(prev => ({
          ...prev,
          plugins: {
            ...prev.plugins,
            errors: prev.plugins.errors.filter(e => !('marketplace' in e && e.marketplace === action.name)),
            installationStatus: {
              ...prev.plugins.installationStatus,
              marketplaces: prev.plugins.installationStatus.marketplaces.filter(m => m.name !== action.name),
            },
          },
        }));
        setActionMessage(`${figures.tick} Removed "${action.name}" from ${scopes} settings`);
        markPluginsChanged();
        break;
      }
      case 'remove-installed-marketplace': {
        void (async () => {
          try {
            await removeMarketplaceSource(action.name);
            clearAllCaches();
            setMarketplaceLoadFailures(prev => prev.filter(f => f.name !== action.name));
            setActionMessage(`${figures.tick} Removed marketplace "${action.name}"`);
            markPluginsChanged();
          } catch (err) {
            setActionMessage(`Failed to remove "${action.name}": ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
        break;
      }
      case 'managed-only':
        // 无可用操作 —— 指引文本已显示
        break;
      case 'none':
        break;
    }
  };

  useKeybindings(
    {
      'select:previous': () => setSelectedIndex(prev => Math.max(0, prev - 1)),
      'select:next': () => setSelectedIndex(prev => Math.min(rows.length - 1, prev + 1)),
      'select:accept': handleSelect,
    },
    { context: 'Select', isActive: rows.length > 0 },
  );

  // 当行数收缩（例如移除后）时夹取 selectedIndex
  const clampedIndex = Math.min(selectedIndex, Math.max(0, rows.length - 1));
  if (clampedIndex !== selectedIndex) {
    setSelectedIndex(clampedIndex);
  }

  const selectedAction = rows[clampedIndex]?.action;
  const hasAction = selectedAction && selectedAction.kind !== 'none' && selectedAction.kind !== 'managed-only';

  if (rows.length === 0) {
    return (
      <Box flexDirection="column">
        <Box marginLeft={1}>
          <Text dimColor>No plugin errors</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor italic>
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="back" />
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {rows.map((row, idx) => {
        const isSelected = idx === clampedIndex;
        return (
          <Box key={idx} marginLeft={1} flexDirection="column" marginBottom={1}>
            <Text>
              <Text color={isSelected ? 'suggestion' : 'error'}>{isSelected ? figures.pointer : figures.cross} </Text>
              <Text bold={isSelected}>{row.label}</Text>
              {row.scope && <Text dimColor> ({row.scope})</Text>}
            </Text>
            <Box marginLeft={3}>
              <Text color="error">{row.message}</Text>
            </Box>
            {row.guidance && (
              <Box marginLeft={3}>
                <Text dimColor italic>
                  {row.guidance}
                </Text>
              </Box>
            )}
          </Box>
        );
      })}

      {actionMessage && (
        <Box marginTop={1} marginLeft={1}>
          <Text color="claude">{actionMessage}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor italic>
          <Byline>
            <ConfigurableShortcutHint action="select:previous" context="Select" fallback="↑" description="navigate" />
            {hasAction && (
              <ConfigurableShortcutHint
                action="select:accept"
                context="Select"
                fallback="Enter"
                description="resolve"
              />
            )}
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="back" />
          </Byline>
        </Text>
      </Box>
    </Box>
  );
}

function getInitialViewState(parsedCommand: ParsedCommand): ViewState {
  switch (parsedCommand.type) {
    case 'help':
      return { type: 'help' };
    case 'validate':
      return { type: 'validate', path: parsedCommand.path };
    case 'install':
      if (parsedCommand.marketplace) {
        return {
          type: 'browse-marketplace',
          targetMarketplace: parsedCommand.marketplace,
          targetPlugin: parsedCommand.plugin,
        };
      }
      if (parsedCommand.plugin) {
        return {
          type: 'discover-plugins',
          targetPlugin: parsedCommand.plugin,
        };
      }
      return { type: 'discover-plugins' };
    case 'manage':
      return { type: 'manage-plugins' };
    case 'uninstall':
      return {
        type: 'manage-plugins',
        targetPlugin: parsedCommand.plugin,
        action: 'uninstall',
      };
    case 'enable':
      return {
        type: 'manage-plugins',
        targetPlugin: parsedCommand.plugin,
        action: 'enable',
      };
    case 'disable':
      return {
        type: 'manage-plugins',
        targetPlugin: parsedCommand.plugin,
        action: 'disable',
      };
    case 'marketplace':
      if (parsedCommand.action === 'list') {
        return { type: 'marketplace-list' };
      }
      if (parsedCommand.action === 'add') {
        return {
          type: 'add-marketplace',
          initialValue: parsedCommand.target,
        };
      }
      if (parsedCommand.action === 'remove') {
        return {
          type: 'manage-marketplaces',
          targetMarketplace: parsedCommand.target,
          action: 'remove',
        };
      }
      if (parsedCommand.action === 'update') {
        return {
          type: 'manage-marketplaces',
          targetMarketplace: parsedCommand.target,
          action: 'update',
        };
      }
      return { type: 'marketplace-menu' };
    case 'menu':
    default:
      // 默认进入展示所有插件的发现视图
      return { type: 'discover-plugins' };
  }
}

function getInitialTab(viewState: ViewState): TabId {
  if (viewState.type === 'manage-plugins') return 'installed';
  if (viewState.type === 'manage-marketplaces') return 'marketplaces';
  return 'discover';
}

export function PluginSettings({ onComplete, args, showMcpRedirectMessage }: PluginSettingsProps): React.ReactNode {
  const parsedCommand = parsePluginArgs(args);
  const initialViewState = getInitialViewState(parsedCommand);
  const [viewState, setViewState] = useState<ViewState>(initialViewState);
  const [activeTab, setActiveTab] = useState<TabId>(getInitialTab(initialViewState));
  const [inputValue, setInputValue] = useState(
    viewState.type === 'add-marketplace' ? viewState.initialValue || '' : '',
  );
  const [cursorOffset, setCursorOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [childSearchActive, setChildSearchActive] = useState(false);
  const setAppState = useSetAppState();

  // Errors 标签徽标的错误计数 —— 统计 loader 错误 + 后台市场安装失败。
  // 不统计磁盘上市场加载失败（那些需要 I/O，会在标签打开时惰性发现）。
  // 当一个市场既有 loader 错误又有失败的安装状态时，可能比显示的行数
  // 略多（buildErrorRows 会去重）。
  const pluginErrorCount = useAppState(s => {
    let count = s.plugins.errors.length;
    for (const m of s.plugins.installationStatus.marketplaces) {
      if (m.status === 'failed') count++;
    }
    return count;
  });
  const errorsTabTitle = pluginErrorCount > 0 ? `Errors (${pluginErrorCount})` : 'Errors';

  const exitState = useExitOnCtrlCDWithKeybindings();

  /**
   * 当用户提供完整命令并包含所有必填参数时，CLI 模式启用。
   * 在此模式下，操作立即执行，无需交互式提示。
   * 当参数缺失时使用交互模式，允许用户输入参数。
   */
  const cliMode =
    parsedCommand.type === 'marketplace' && parsedCommand.action === 'add' && parsedCommand.target !== undefined;

  // 标记磁盘上的插件状态已变更（Layer 2），且活跃组件（Layer 3）
  // 已过期。用户运行 /reload-plugins 来应用变更。
  // 以前这是 updatePluginState()，它只做了部分刷新（仅 commands ——
  // agents/hooks/MCP 被默默跳过）。现在所有 Layer-3 刷新都通过
  // 统一的 refreshActivePlugins() 原语经由 /reload-plugins 进行，
  // 给出一致的心智模型：插件变更需要 /reload-plugins。
  const markPluginsChanged = useCallback(() => {
    setAppState(prev =>
      prev.plugins.needsRefresh ? prev : { ...prev, plugins: { ...prev.plugins, needsRefresh: true } },
    );
  }, [setAppState]);

  // 处理标签切换（由 Tabs 组件调用）
  const handleTabChange = useCallback((tabId: string) => {
    const tab = tabId as TabId;
    setActiveTab(tab);
    setError(null);
    switch (tab) {
      case 'discover':
        setViewState({ type: 'discover-plugins' });
        break;
      case 'installed':
        setViewState({ type: 'manage-plugins' });
        break;
      case 'marketplaces':
        setViewState({ type: 'manage-marketplaces' });
        break;
      case 'errors':
        // 无需 viewState 变更 —— ErrorsTabContent 渲染在 <Tab id="errors"> 内部
        break;
    }
  }, []);

  // 当子组件把 viewState 设为 'menu' 时处理退出。
  // 子组件通常会同时调用 setResult(msg) 和 setParentViewState
  // ({type:'menu'}) —— 两个 effect 在同一次渲染中触发。仅在没有
  // result 时通过此路径关闭，否则下方的 result effect 会处理关闭，
  // 并将消息投递到 transcript。
  useEffect(() => {
    if (viewState.type === 'menu' && !result) {
      onComplete();
    }
  }, [viewState.type, result, onComplete]);

  // 当 viewState 变为另一个标签的内容时同步 activeTab
  // 这处理了诸如 AddMarketplace 导航到 browse-marketplace 的情况
  useEffect(() => {
    if (viewState.type === 'browse-marketplace' && activeTab !== 'discover') {
      setActiveTab('discover');
    }
  }, [viewState.type, activeTab]);

  // 仅在 add-marketplace 模式下处理 Esc 键
  // 其他标签视图在自己的组件中处理 Esc
  const handleAddMarketplaceEscape = useCallback(() => {
    setActiveTab('marketplaces');
    setViewState({ type: 'manage-marketplaces' });
    setInputValue('');
    setError(null);
  }, []);

  useKeybinding('confirm:no', handleAddMarketplaceEscape, {
    context: 'Settings',
    isActive: viewState.type === 'add-marketplace',
  });

  useEffect(() => {
    if (result) {
      onComplete(result);
    }
  }, [result, onComplete]);

  // 处理 help 视图完成
  useEffect(() => {
    if (viewState.type === 'help') {
      onComplete();
    }
  }, [viewState.type, onComplete]);

  // 根据状态渲染不同视图
  if (viewState.type === 'help') {
    return (
      <Box flexDirection="column">
        <Text bold>Plugin Command Usage:</Text>
        <Text> </Text>
        <Text dimColor>Installation:</Text>
        <Text> /plugin install - Browse and install plugins</Text>
        <Text> /plugin install &lt;marketplace&gt; - Install from specific marketplace</Text>
        <Text> /plugin install &lt;plugin&gt; - Install specific plugin</Text>
        <Text> /plugin install &lt;plugin&gt;@&lt;market&gt; - Install plugin from marketplace</Text>
        <Text> </Text>
        <Text dimColor>Management:</Text>
        <Text> /plugin manage - Manage installed plugins</Text>
        <Text> /plugin enable &lt;plugin&gt; - Enable a plugin</Text>
        <Text> /plugin disable &lt;plugin&gt; - Disable a plugin</Text>
        <Text> /plugin uninstall &lt;plugin&gt; - Uninstall a plugin</Text>
        <Text> </Text>
        <Text dimColor>Marketplaces:</Text>
        <Text> /plugin marketplace - Marketplace management menu</Text>
        <Text> /plugin marketplace add - Add a marketplace</Text>
        <Text> /plugin marketplace add &lt;path/url&gt; - Add marketplace directly</Text>
        <Text> /plugin marketplace update - Update marketplaces</Text>
        <Text> /plugin marketplace update &lt;name&gt; - Update specific marketplace</Text>
        <Text> /plugin marketplace remove - Remove a marketplace</Text>
        <Text> /plugin marketplace remove &lt;name&gt; - Remove specific marketplace</Text>
        <Text> /plugin marketplace list - List all marketplaces</Text>
        <Text> </Text>
        <Text dimColor>Validation:</Text>
        <Text> /plugin validate &lt;path&gt; - Validate a manifest file or directory</Text>
        <Text> </Text>
        <Text dimColor>Other:</Text>
        <Text> /plugin - Main plugin menu</Text>
        <Text> /plugin help - Show this help</Text>
        <Text> /plugins - Alias for /plugin</Text>
      </Box>
    );
  }

  if (viewState.type === 'validate') {
    return <ValidatePlugin onComplete={onComplete} path={viewState.path} />;
  }

  if (viewState.type === 'marketplace-menu') {
    // 显示一个简单的市场操作菜单
    setViewState({ type: 'menu' });
    return null;
  }

  if (viewState.type === 'marketplace-list') {
    return <MarketplaceList onComplete={onComplete} />;
  }

  if (viewState.type === 'add-marketplace') {
    return (
      <AddMarketplace
        inputValue={inputValue}
        setInputValue={setInputValue}
        cursorOffset={cursorOffset}
        setCursorOffset={setCursorOffset}
        error={error}
        setError={setError}
        result={result}
        setResult={setResult}
        setViewState={setViewState}
        onAddComplete={markPluginsChanged}
        cliMode={cliMode}
      />
    );
  }
  // 使用设计系统的 Tabs 组件渲染带标签的界面
  return (
    <Pane color="suggestion">
      <Tabs
        title="Plugins"
        selectedTab={activeTab}
        onTabChange={handleTabChange}
        color="suggestion"
        disableNavigation={childSearchActive}
        banner={showMcpRedirectMessage && activeTab === 'installed' ? <McpRedirectBanner /> : undefined}
      >
        <Tab id="discover" title="Discover">
          {viewState.type === 'browse-marketplace' ? (
            <BrowseMarketplace
              error={error}
              setError={setError}
              result={result}
              setResult={setResult}
              setViewState={setViewState}
              onInstallComplete={markPluginsChanged}
              targetMarketplace={viewState.targetMarketplace}
              targetPlugin={viewState.targetPlugin}
            />
          ) : (
            <DiscoverPlugins
              error={error}
              setError={setError}
              result={result}
              setResult={setResult}
              setViewState={setViewState}
              onInstallComplete={markPluginsChanged}
              onSearchModeChange={setChildSearchActive}
              targetPlugin={viewState.type === 'discover-plugins' ? viewState.targetPlugin : undefined}
            />
          )}
        </Tab>
        <Tab id="installed" title="Installed">
          <ManagePlugins
            setViewState={setViewState}
            setResult={setResult}
            onManageComplete={markPluginsChanged}
            onSearchModeChange={setChildSearchActive}
            targetPlugin={viewState.type === 'manage-plugins' ? viewState.targetPlugin : undefined}
            targetMarketplace={viewState.type === 'manage-plugins' ? viewState.targetMarketplace : undefined}
            action={viewState.type === 'manage-plugins' ? viewState.action : undefined}
          />
        </Tab>
        <Tab id="marketplaces" title="Marketplaces">
          <ManageMarketplaces
            setViewState={setViewState}
            error={error}
            setError={setError}
            setResult={setResult}
            exitState={exitState}
            onManageComplete={markPluginsChanged}
            targetMarketplace={viewState.type === 'manage-marketplaces' ? viewState.targetMarketplace : undefined}
            action={viewState.type === 'manage-marketplaces' ? viewState.action : undefined}
          />
        </Tab>
        <Tab id="errors" title={errorsTabTitle}>
          <ErrorsTabContent
            setViewState={setViewState}
            setActiveTab={setActiveTab}
            markPluginsChanged={markPluginsChanged}
          />
        </Tab>
      </Tabs>
    </Pane>
  );
}
