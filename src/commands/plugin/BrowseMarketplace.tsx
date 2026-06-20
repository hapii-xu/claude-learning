import figures from 'figures';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js';
import { Box, Byline, Text } from '@anthropic/ink';
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js';
import type { LoadedPlugin } from '../../types/plugin.js';
import { count } from '../../utils/array.js';
import { openBrowser } from '../../utils/browser.js';
import { logForDebugging } from '../../utils/debug.js';
import { errorMessage } from '../../utils/errors.js';
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js';
import { formatInstallCount, getInstallCounts } from '../../utils/plugins/installCounts.js';
import { isPluginGloballyInstalled, isPluginInstalled } from '../../utils/plugins/installedPluginsManager.js';
import {
  createPluginId,
  formatFailureDetails,
  formatMarketplaceLoadingErrors,
  getMarketplaceSourceDisplay,
  loadMarketplacesWithGracefulDegradation,
} from '../../utils/plugins/marketplaceHelpers.js';
import { getMarketplace, loadKnownMarketplacesConfig } from '../../utils/plugins/marketplaceManager.js';
import { OFFICIAL_MARKETPLACE_NAME } from '../../utils/plugins/officialMarketplace.js';
import { installPluginFromMarketplace } from '../../utils/plugins/pluginInstallationHelpers.js';
import { isPluginBlockedByPolicy } from '../../utils/plugins/pluginPolicy.js';
import { plural } from '../../utils/stringUtils.js';
import { truncateToWidth } from '../../utils/truncate.js';
import { findPluginOptionsTarget, PluginOptionsFlow } from './PluginOptionsFlow.js';
import { PluginTrustWarning } from './PluginTrustWarning.js';
import {
  buildPluginDetailsMenuOptions,
  extractGitHubRepo,
  type InstallablePlugin,
  PluginSelectionKeyHint,
} from './pluginDetailsHelpers.js';
import type { ViewState as ParentViewState } from './types.js';
import { usePagination } from './usePagination.js';

type Props = {
  error: string | null;
  setError: (error: string | null) => void;
  result: string | null;
  setResult: (result: string | null) => void;
  setViewState: (state: ParentViewState) => void;
  onInstallComplete?: () => void | Promise<void>;
  targetMarketplace?: string;
  targetPlugin?: string;
};

type ViewState =
  | 'marketplace-list'
  | 'plugin-list'
  | 'plugin-details'
  | { type: 'plugin-options'; plugin: LoadedPlugin; pluginId: string };

type MarketplaceInfo = {
  name: string;
  totalPlugins: number;
  installedCount: number;
  source?: string;
};

export function BrowseMarketplace({
  error,
  setError,
  result: _result,
  setResult,
  setViewState: setParentViewState,
  onInstallComplete,
  targetMarketplace,
  targetPlugin,
}: Props): React.ReactNode {
  // 视图状态
  const [viewState, setViewState] = useState<ViewState>('marketplace-list');
  const [selectedMarketplace, setSelectedMarketplace] = useState<string | null>(null);
  const [selectedPlugin, setSelectedPlugin] = useState<InstallablePlugin | null>(null);

  // 数据状态
  const [marketplaces, setMarketplaces] = useState<MarketplaceInfo[]>([]);
  const [availablePlugins, setAvailablePlugins] = useState<InstallablePlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [installCounts, setInstallCounts] = useState<Map<string, number> | null>(null);

  // 选择状态
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedForInstall, setSelectedForInstall] = useState<Set<string>>(new Set());
  const [installingPlugins, setInstallingPlugins] = useState<Set<string>>(new Set());

  // 插件列表的分页（连续滚动）
  const pagination = usePagination<InstallablePlugin>({
    totalItems: availablePlugins.length,
    selectedIndex,
  });

  // 详情视图状态
  const [detailsMenuIndex, setDetailsMenuIndex] = useState(0);
  const [isInstalling, setIsInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  // 用于非致命错误（例如某些市场加载失败）的警告状态
  const [warning, setWarning] = useState<string | null>(null);

  // 处理 Esc 返回 —— 取决于 viewState 的导航
  const handleBack = React.useCallback(() => {
    if (viewState === 'plugin-list') {
      // 如果通过 targetMarketplace 直接跳转到了某个市场，
      // 则返回到 manage-marketplaces 显示该市场的详情
      if (targetMarketplace) {
        setParentViewState({
          type: 'manage-marketplaces',
          targetMarketplace,
        });
      } else if (marketplaces.length === 1) {
        // 如果只有一个市场，则跳过 marketplace-list 视图，
        // 因为加载时已经自动跳过了它
        setParentViewState({ type: 'menu' });
      } else {
        setViewState('marketplace-list');
        setSelectedMarketplace(null);
        setSelectedForInstall(new Set());
      }
    } else if (viewState === 'plugin-details') {
      setViewState('plugin-list');
      setSelectedPlugin(null);
    } else {
      // 在根层级（marketplace-list）时，退出插件菜单
      setParentViewState({ type: 'menu' });
    }
  }, [viewState, targetMarketplace, setParentViewState, marketplaces.length]);

  useKeybinding('confirm:no', handleBack, { context: 'Confirmation' });

  // 加载市场并统计已安装的插件数
  useEffect(() => {
    async function loadMarketplaceData() {
      try {
        const config = await loadKnownMarketplacesConfig();

        // 加载市场（带优雅降级）
        const { marketplaces, failures } = await loadMarketplacesWithGracefulDegradation(config);

        const marketplaceInfos: MarketplaceInfo[] = [];
        for (const { name, config: marketplaceConfig, data: marketplace } of marketplaces) {
          if (marketplace) {
            // 统计有多少来自该市场的插件已安装
            const installedFromThisMarketplace = count(marketplace.plugins, plugin =>
              isPluginInstalled(createPluginId((plugin as { name: string }).name, name)),
            );

            marketplaceInfos.push({
              name,
              totalPlugins: marketplace.plugins.length,
              installedCount: installedFromThisMarketplace,
              source: getMarketplaceSourceDisplay(marketplaceConfig.source),
            });
          }
        }

        // 排序，使 claude-plugin-directory 始终排在最前
        marketplaceInfos.sort((a, b) => {
          if (a.name === 'claude-plugin-directory') return -1;
          if (b.name === 'claude-plugin-directory') return 1;
          return 0;
        });

        setMarketplaces(marketplaceInfos);

        // 处理市场加载错误/警告
        const successCount = count(marketplaces, m => m.data !== null);
        const errorResult = formatMarketplaceLoadingErrors(failures, successCount);
        if (errorResult) {
          if (errorResult.type === 'warning') {
            setWarning(errorResult.message + '. Showing available marketplaces.');
          } else {
            throw new Error(errorResult.message);
          }
        }

        // 如果只有一个市场，则跳过市场选择
        if (marketplaceInfos.length === 1 && !targetMarketplace && !targetPlugin) {
          const singleMarketplace = marketplaceInfos[0];
          if (singleMarketplace) {
            setSelectedMarketplace(singleMarketplace.name);
            setViewState('plugin-list');
          }
        }

        // 在市场加载完成后处理 targetMarketplace 和 targetPlugin
        if (targetPlugin) {
          // 跨所有市场搜索该插件
          let foundPlugin: InstallablePlugin | null = null;
          let foundMarketplace: string | null = null;

          for (const [name] of Object.entries(config)) {
            const marketplace = await getMarketplace(name);
            if (marketplace) {
              const plugin = marketplace.plugins.find(p => p.name === targetPlugin);
              if (plugin) {
                const pluginId = createPluginId(plugin.name, name);
                foundPlugin = {
                  entry: plugin,
                  marketplaceName: name,
                  pluginId,
                  // isPluginGloballyInstalled：仅当存在 user/managed 作用域时
                  // 才阻止（无需添加）。Project/local 作用域的安装不会阻止 ——
                  // 用户可能希望升级到 user 作用域（gh-29997）。
                  isInstalled: isPluginGloballyInstalled(pluginId),
                };
                foundMarketplace = name;
                break;
              }
            }
          }

          if (foundPlugin && foundMarketplace) {
            // 仅阻止全局（user/managed）安装 —— project/local 作用域意味着
            // 用户可能仍想添加一个 user 作用域的条目，使该插件在其他项目中
            // 也可用（gh-29997、gh-29240、gh-29392）。
            // plugin-details 视图提供全部三种作用域选项；后端
            // （installPluginOp → addInstalledPlugin）已支持每个插件多个作用域
            // 条目。
            const pluginId = foundPlugin.pluginId;
            const globallyInstalled = isPluginGloballyInstalled(pluginId);

            if (globallyInstalled) {
              setError(`Plugin '${pluginId}' is already installed globally. Use '/plugin' to manage existing plugins.`);
            } else {
              // 导航到插件详情视图
              setSelectedMarketplace(foundMarketplace);
              setSelectedPlugin(foundPlugin);
              setViewState('plugin-details');
            }
          } else {
            setError(`Plugin "${targetPlugin}" not found in any marketplace`);
          }
        } else if (targetMarketplace) {
          // 直接导航到指定市场
          const marketplaceExists = marketplaceInfos.some(m => m.name === targetMarketplace);
          if (marketplaceExists) {
            setSelectedMarketplace(targetMarketplace);
            setViewState('plugin-list');
          } else {
            setError(`Marketplace "${targetMarketplace}" not found`);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load marketplaces');
      } finally {
        setLoading(false);
      }
    }
    void loadMarketplaceData();
  }, [setError, targetMarketplace, targetPlugin]);

  // 当选中某个市场时加载插件
  useEffect(() => {
    if (!selectedMarketplace) return;

    let cancelled = false;

    async function loadPluginsForMarketplace(marketplaceName: string) {
      setLoading(true);
      try {
        const marketplace = await getMarketplace(marketplaceName);
        if (cancelled) return;
        if (!marketplace) {
          throw new Error(`Failed to load marketplace: ${marketplaceName}`);
        }

        // 过滤掉已安装的插件
        const installablePlugins: InstallablePlugin[] = [];
        for (const entry of marketplace.plugins) {
          const pluginId = createPluginId(entry.name, marketplaceName);
          if (isPluginBlockedByPolicy(pluginId)) continue;
          installablePlugins.push({
            entry,
            marketplaceName: marketplaceName,
            pluginId,
            // 仅当为全局作用域（user/managed）时才标记为 "installed"。
            // Project/local 安装不会阻止 —— 用户可以通过 plugin-details
            // 视图添加 user 作用域（gh-29997）。
            isInstalled: isPluginGloballyInstalled(pluginId),
          });
        }

        // 获取安装次数并按热度排序
        try {
          const counts = await getInstallCounts();
          if (cancelled) return;
          setInstallCounts(counts);

          if (counts) {
            // 按安装次数降序排序，再按字母序排序
            installablePlugins.sort((a, b) => {
              const countA = counts.get(a.pluginId) ?? 0;
              const countB = counts.get(b.pluginId) ?? 0;
              if (countA !== countB) return countB - countA;
              return a.entry.name.localeCompare(b.entry.name);
            });
          } else {
            // 没有可用次数 —— 按字母序排序
            installablePlugins.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
          }
        } catch (error) {
          if (cancelled) return;
          // 记录错误，然后优雅降级为按字母序排序
          logForDebugging(`Failed to fetch install counts: ${errorMessage(error)}`);
          installablePlugins.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
        }

        setAvailablePlugins(installablePlugins);
        setSelectedIndex(0);
        setSelectedForInstall(new Set());
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load plugins');
      } finally {
        setLoading(false);
      }
    }

    void loadPluginsForMarketplace(selectedMarketplace);
    return () => {
      cancelled = true;
    };
  }, [selectedMarketplace, setError]);

  // 安装选中的插件
  const installSelectedPlugins = async () => {
    if (selectedForInstall.size === 0) return;

    const pluginsToInstall = availablePlugins.filter(p => selectedForInstall.has(p.pluginId));

    setInstallingPlugins(new Set(pluginsToInstall.map(p => p.pluginId)));

    let successCount = 0;
    let failureCount = 0;
    const newFailedPlugins: Array<{ name: string; reason: string }> = [];

    for (const plugin of pluginsToInstall) {
      const result = await installPluginFromMarketplace({
        pluginId: plugin.pluginId,
        entry: plugin.entry,
        marketplaceName: plugin.marketplaceName,
        scope: 'user',
      });

      if (result.success) {
        successCount++;
      } else {
        failureCount++;
        newFailedPlugins.push({
          name: plugin.entry.name,
          reason: (result as { success: false; error: string }).error,
        });
      }
    }

    setInstallingPlugins(new Set());
    setSelectedForInstall(new Set());
    clearAllCaches();

    // 处理安装结果
    if (failureCount === 0) {
      // 全部成功
      const message =
        `✓ Installed ${successCount} ${plural(successCount, 'plugin')}. ` + `Run /reload-plugins to activate.`;

      setResult(message);
    } else if (successCount === 0) {
      // 全部失败 —— 显示带原因的错误
      setError(`Failed to install: ${formatFailureDetails(newFailedPlugins, true)}`);
    } else {
      // 混合结果 —— 显示部分成功
      const message =
        `✓ Installed ${successCount} of ${successCount + failureCount} plugins. ` +
        `Failed: ${formatFailureDetails(newFailedPlugins, false)}. ` +
        `Run /reload-plugins to activate successfully installed plugins.`;

      setResult(message);
    }

    // 处理完成回调和导航
    if (successCount > 0) {
      if (onInstallComplete) {
        await onInstallComplete();
      }
    }

    setParentViewState({ type: 'menu' });
  };

  // 从详情视图安装单个插件
  const handleSinglePluginInstall = async (plugin: InstallablePlugin, scope: 'user' | 'project' | 'local' = 'user') => {
    setIsInstalling(true);
    setInstallError(null);

    const result = await installPluginFromMarketplace({
      pluginId: plugin.pluginId,
      entry: plugin.entry,
      marketplaceName: plugin.marketplaceName,
      scope,
    });

    if (result.success) {
      const loaded = await findPluginOptionsTarget(plugin.pluginId);
      if (loaded) {
        setIsInstalling(false);
        setViewState({
          type: 'plugin-options',
          plugin: loaded,
          pluginId: plugin.pluginId,
        });
        return;
      }
      setResult(result.message);
      if (onInstallComplete) {
        await onInstallComplete();
      }
      setParentViewState({ type: 'menu' });
    } else {
      setIsInstalling(false);
      setInstallError((result as { success: false; error: string }).error);
    }
  };

  // 处理错误状态
  useEffect(() => {
    if (error) {
      setResult(error);
    }
  }, [error, setResult]);

  // 市场列表导航
  useKeybindings(
    {
      'select:previous': () => {
        if (selectedIndex > 0) {
          setSelectedIndex(selectedIndex - 1);
        }
      },
      'select:next': () => {
        if (selectedIndex < marketplaces.length - 1) {
          setSelectedIndex(selectedIndex + 1);
        }
      },
      'select:accept': () => {
        const marketplace = marketplaces[selectedIndex];
        if (marketplace) {
          setSelectedMarketplace(marketplace.name);
          setViewState('plugin-list');
        }
      },
    },
    { context: 'Select', isActive: viewState === 'marketplace-list' },
  );

  // 插件列表导航
  useKeybindings(
    {
      'select:previous': () => {
        if (selectedIndex > 0) {
          pagination.handleSelectionChange(selectedIndex - 1, setSelectedIndex);
        }
      },
      'select:next': () => {
        if (selectedIndex < availablePlugins.length - 1) {
          pagination.handleSelectionChange(selectedIndex + 1, setSelectedIndex);
        }
      },
      'select:accept': () => {
        if (selectedIndex === availablePlugins.length && selectedForInstall.size > 0) {
          void installSelectedPlugins();
        } else if (selectedIndex < availablePlugins.length) {
          const plugin = availablePlugins[selectedIndex];
          if (plugin) {
            if (plugin.isInstalled) {
              setParentViewState({
                type: 'manage-plugins',
                targetPlugin: plugin.entry.name,
                targetMarketplace: plugin.marketplaceName,
              });
            } else {
              setSelectedPlugin(plugin);
              setViewState('plugin-details');
              setDetailsMenuIndex(0);
              setInstallError(null);
            }
          }
        }
      },
    },
    { context: 'Select', isActive: viewState === 'plugin-list' },
  );

  useKeybindings(
    {
      'plugin:toggle': () => {
        if (selectedIndex < availablePlugins.length) {
          const plugin = availablePlugins[selectedIndex];
          if (plugin && !plugin.isInstalled) {
            const newSelection = new Set(selectedForInstall);
            if (newSelection.has(plugin.pluginId)) {
              newSelection.delete(plugin.pluginId);
            } else {
              newSelection.add(plugin.pluginId);
            }
            setSelectedForInstall(newSelection);
          }
        }
      },
      'plugin:install': () => {
        if (selectedForInstall.size > 0) {
          void installSelectedPlugins();
        }
      },
    },
    { context: 'Plugin', isActive: viewState === 'plugin-list' },
  );

  // 插件详情导航
  const detailsMenuOptions = React.useMemo(() => {
    if (!selectedPlugin) return [];
    const hasHomepage = selectedPlugin.entry.homepage;
    const githubRepo = extractGitHubRepo(selectedPlugin);
    return buildPluginDetailsMenuOptions(hasHomepage, githubRepo);
  }, [selectedPlugin]);

  useKeybindings(
    {
      'select:previous': () => {
        if (detailsMenuIndex > 0) {
          setDetailsMenuIndex(detailsMenuIndex - 1);
        }
      },
      'select:next': () => {
        if (detailsMenuIndex < detailsMenuOptions.length - 1) {
          setDetailsMenuIndex(detailsMenuIndex + 1);
        }
      },
      'select:accept': () => {
        if (!selectedPlugin) return;
        const action = detailsMenuOptions[detailsMenuIndex]?.action;
        const hasHomepage = selectedPlugin.entry.homepage;
        const githubRepo = extractGitHubRepo(selectedPlugin);
        if (action === 'install-user') {
          void handleSinglePluginInstall(selectedPlugin, 'user');
        } else if (action === 'install-project') {
          void handleSinglePluginInstall(selectedPlugin, 'project');
        } else if (action === 'install-local') {
          void handleSinglePluginInstall(selectedPlugin, 'local');
        } else if (action === 'homepage' && hasHomepage) {
          void openBrowser(hasHomepage);
        } else if (action === 'github' && githubRepo) {
          void openBrowser(`https://github.com/${githubRepo}`);
        } else if (action === 'back') {
          setViewState('plugin-list');
          setSelectedPlugin(null);
        }
      },
    },
    {
      context: 'Select',
      isActive: viewState === 'plugin-details' && !!selectedPlugin,
    },
  );

  if (typeof viewState === 'object' && viewState.type === 'plugin-options') {
    const { plugin, pluginId } = viewState;
    function finish(msg: string): void {
      setResult(msg);
      if (onInstallComplete) {
        void onInstallComplete();
      }
      setParentViewState({ type: 'menu' });
    }
    return (
      <PluginOptionsFlow
        plugin={plugin}
        pluginId={pluginId}
        onDone={(outcome, detail) => {
          switch (outcome) {
            case 'configured':
              finish(`✓ Installed and configured ${plugin.name}. Run /reload-plugins to apply.`);
              break;
            case 'skipped':
              finish(`✓ Installed ${plugin.name}. Run /reload-plugins to apply.`);
              break;
            case 'error':
              finish(`Installed but failed to save config: ${detail}`);
              break;
          }
        }}
      />
    );
  }

  // 加载状态
  if (loading) {
    return <Text>Loading…</Text>;
  }

  // 错误状态
  if (error) {
    return <Text color="error">{error}</Text>;
  }

  // 市场选择视图
  if (viewState === 'marketplace-list') {
    if (marketplaces.length === 0) {
      return (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>Select marketplace</Text>
          </Box>
          <Text>No marketplaces configured.</Text>
          <Text dimColor>Add a marketplace first using {"'Add marketplace'"}.</Text>
          <Box marginTop={1} paddingLeft={1}>
            <Text dimColor>
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description="go back"
              />
            </Text>
          </Box>
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Select marketplace</Text>
        </Box>

        {/* 市场加载失败的警告横幅 */}
        {warning && (
          <Box marginBottom={1} flexDirection="column">
            <Text color="warning">
              {figures.warning} {warning}
            </Text>
          </Box>
        )}
        {marketplaces.map((marketplace, index) => (
          <Box key={marketplace.name} flexDirection="column" marginBottom={index < marketplaces.length - 1 ? 1 : 0}>
            <Box>
              <Text color={selectedIndex === index ? 'suggestion' : undefined}>
                {selectedIndex === index ? figures.pointer : ' '} {marketplace.name}
              </Text>
            </Box>
            <Box marginLeft={2}>
              <Text dimColor>
                {marketplace.totalPlugins} {plural(marketplace.totalPlugins, 'plugin')} available
                {marketplace.installedCount > 0 && ` · ${marketplace.installedCount} already installed`}
                {marketplace.source && ` · ${marketplace.source}`}
              </Text>
            </Box>
          </Box>
        ))}

        <Box marginTop={1}>
          <Text dimColor italic>
            <Byline>
              <ConfigurableShortcutHint action="select:accept" context="Select" fallback="Enter" description="select" />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description="go back"
              />
            </Byline>
          </Text>
        </Box>
      </Box>
    );
  }

  // 插件详情视图
  if (viewState === 'plugin-details' && selectedPlugin) {
    const hasHomepage = selectedPlugin.entry.homepage;
    const githubRepo = extractGitHubRepo(selectedPlugin);

    const menuOptions = buildPluginDetailsMenuOptions(hasHomepage, githubRepo);

    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Plugin Details</Text>
        </Box>

        {/* 插件元信息 */}
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{selectedPlugin.entry.name}</Text>
          {selectedPlugin.entry.version && <Text dimColor>Version: {selectedPlugin.entry.version}</Text>}
          {selectedPlugin.entry.description && (
            <Box marginTop={1}>
              <Text>{selectedPlugin.entry.description}</Text>
            </Box>
          )}
          {selectedPlugin.entry.author && (
            <Box marginTop={1}>
              <Text dimColor>
                By:{' '}
                {typeof selectedPlugin.entry.author === 'string'
                  ? selectedPlugin.entry.author
                  : selectedPlugin.entry.author.name}
              </Text>
            </Box>
          )}
        </Box>

        {/* 将要安装的内容 */}
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Will install:</Text>
          {selectedPlugin.entry.commands && (
            <Text dimColor>
              · Commands:{' '}
              {Array.isArray(selectedPlugin.entry.commands)
                ? selectedPlugin.entry.commands.join(', ')
                : Object.keys(selectedPlugin.entry.commands).join(', ')}
            </Text>
          )}
          {selectedPlugin.entry.agents && (
            <Text dimColor>
              · Agents:{' '}
              {Array.isArray(selectedPlugin.entry.agents)
                ? selectedPlugin.entry.agents.join(', ')
                : Object.keys(selectedPlugin.entry.agents).join(', ')}
            </Text>
          )}
          {selectedPlugin.entry.hooks && (
            <Text dimColor>· Hooks: {Object.keys(selectedPlugin.entry.hooks).join(', ')}</Text>
          )}
          {selectedPlugin.entry.mcpServers && (
            <Text dimColor>
              · MCP Servers:{' '}
              {Array.isArray(selectedPlugin.entry.mcpServers)
                ? selectedPlugin.entry.mcpServers.join(', ')
                : typeof selectedPlugin.entry.mcpServers === 'object'
                  ? Object.keys(selectedPlugin.entry.mcpServers).join(', ')
                  : 'configured'}
            </Text>
          )}
          {!selectedPlugin.entry.commands &&
            !selectedPlugin.entry.agents &&
            !selectedPlugin.entry.hooks &&
            !selectedPlugin.entry.mcpServers && (
              <>
                {typeof selectedPlugin.entry.source === 'object' &&
                'source' in selectedPlugin.entry.source &&
                (selectedPlugin.entry.source.source === 'github' ||
                  selectedPlugin.entry.source.source === 'url' ||
                  selectedPlugin.entry.source.source === 'npm' ||
                  selectedPlugin.entry.source.source === 'pip') ? (
                  <Text dimColor>· Component summary not available for remote plugin</Text>
                ) : (
                  // TODO: 实际扫描本地插件目录以显示真实的组件
                  // 这需要访问文件系统来检查：
                  // - commands/ 目录并列出文件
                  // - agents/ 目录并列出文件
                  // - hooks/ 目录并列出文件
                  // - .mcp.json 或 mcp-servers.json 文件
                  <Text dimColor>· Components will be discovered at installation</Text>
                )}
              </>
            )}
        </Box>

        <PluginTrustWarning />

        {/* 错误信息 */}
        {installError && (
          <Box marginBottom={1}>
            <Text color="error">Error: {installError}</Text>
          </Box>
        )}

        {/* 菜单选项 */}
        <Box flexDirection="column">
          {menuOptions.map((option, index) => (
            <Box key={option.action}>
              {detailsMenuIndex === index && <Text>{'> '}</Text>}
              {detailsMenuIndex !== index && <Text>{'  '}</Text>}
              <Text bold={detailsMenuIndex === index}>
                {isInstalling && option.action === 'install' ? 'Installing…' : option.label}
              </Text>
            </Box>
          ))}
        </Box>

        <Box marginTop={1} paddingLeft={1}>
          <Text dimColor>
            <Byline>
              <ConfigurableShortcutHint action="select:accept" context="Select" fallback="Enter" description="select" />
              <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="back" />
            </Byline>
          </Text>
        </Box>
      </Box>
    );
  }

  // 插件安装视图
  if (availablePlugins.length === 0) {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Install plugins</Text>
        </Box>
        <Text dimColor>No new plugins available to install.</Text>
        <Text dimColor>All plugins from this marketplace are already installed.</Text>
        <Box marginLeft={3}>
          <Text dimColor italic>
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" />
          </Text>
        </Box>
      </Box>
    );
  }

  // 从分页中获取可见插件
  const visiblePlugins = pagination.getVisibleItems(availablePlugins);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Install Plugins</Text>
      </Box>

      {/* 向上滚动指示器 */}
      {pagination.scrollPosition.canScrollUp && (
        <Box>
          <Text dimColor> {figures.arrowUp} more above</Text>
        </Box>
      )}

      {/* 插件列表 */}
      {visiblePlugins.map((plugin, visibleIndex) => {
        const actualIndex = pagination.toActualIndex(visibleIndex);
        const isSelected = selectedIndex === actualIndex;
        const isSelectedForInstall = selectedForInstall.has(plugin.pluginId);
        const isInstalling = installingPlugins.has(plugin.pluginId);
        const isLast = visibleIndex === visiblePlugins.length - 1;

        return (
          <Box key={plugin.pluginId} flexDirection="column" marginBottom={isLast && !error ? 0 : 1}>
            <Box>
              <Text color={isSelected ? 'suggestion' : undefined}>{isSelected ? figures.pointer : ' '} </Text>
              <Text color={plugin.isInstalled ? 'success' : undefined}>
                {plugin.isInstalled
                  ? figures.tick
                  : isInstalling
                    ? figures.ellipsis
                    : isSelectedForInstall
                      ? figures.radioOn
                      : figures.radioOff}{' '}
                {plugin.entry.name}
                {plugin.entry.category && <Text dimColor> [{plugin.entry.category}]</Text>}
                {plugin.entry.tags?.includes('community-managed') && <Text dimColor> [Community Managed]</Text>}
                {plugin.isInstalled && <Text dimColor> (installed)</Text>}
                {installCounts && selectedMarketplace === OFFICIAL_MARKETPLACE_NAME && (
                  <Text dimColor>
                    {' · '}
                    {formatInstallCount(installCounts.get(plugin.pluginId) ?? 0)} installs
                  </Text>
                )}
              </Text>
            </Box>
            {plugin.entry.description && (
              <Box marginLeft={4}>
                <Text dimColor>{truncateToWidth(plugin.entry.description, 60)}</Text>
                {plugin.entry.version && <Text dimColor> · v{plugin.entry.version}</Text>}
              </Box>
            )}
          </Box>
        );
      })}

      {/* 向下滚动指示器 */}
      {pagination.scrollPosition.canScrollDown && (
        <Box>
          <Text dimColor> {figures.arrowDown} more below</Text>
        </Box>
      )}

      {/* UI 中显示的错误信息 */}
      {error && (
        <Box marginTop={1}>
          <Text color="error">
            {figures.cross} {error}
          </Text>
        </Box>
      )}

      <PluginSelectionKeyHint hasSelection={selectedForInstall.size > 0} />
    </Box>
  );
}
