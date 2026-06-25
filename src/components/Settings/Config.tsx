// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { feature } from 'bun:bundle';
import { type KeyboardEvent, Box, Text, useTheme, useThemeSetting, useTerminalFocus } from '@anthropic/ink';
import * as React from 'react';
import { useState, useCallback } from 'react';
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js';
import figures from 'figures';
import { type GlobalConfig, saveGlobalConfig, getCurrentProjectConfig, type OutputStyle } from '../../utils/config.js';
import { normalizeApiKeyForConfig } from '../../utils/authPortable.js';
import {
  getGlobalConfig,
  getAutoUpdaterDisabledReason,
  formatAutoUpdaterDisabledReason,
  getRemoteControlAtStartup,
} from '../../utils/config.js';
import chalk from 'chalk';
import {
  permissionModeShortTitle,
  permissionModeFromString,
  toExternalPermissionMode,
  isExternalPermissionMode,
  PERMISSION_MODES,
  type PermissionMode,
} from '../../utils/permissions/PermissionMode.js';
import {
  getAutoModeEnabledState,
  hasAutoModeOptInAnySource,
  transitionPlanAutoMode,
} from '../../utils/permissions/permissionSetup.js';
import { logError } from '../../utils/log.js';
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js';
import { isBridgeEnabled } from '../../bridge/bridgeEnabled.js';
import { ThemePicker } from '../ThemePicker.js';
import { useAppState, useSetAppState, useAppStateStore } from '../../state/AppState.js';
import { ModelPicker } from '../ModelPicker.js';
import { modelDisplayString, isOpus1mMergeEnabled } from '../../utils/model/model.js';
import { isBilledAsExtraUsage } from '../../utils/extraUsage.js';
import { ClaudeMdExternalIncludesDialog } from '../ClaudeMdExternalIncludesDialog.js';
import { ChannelDowngradeDialog, type ChannelDowngradeChoice } from '../ChannelDowngradeDialog.js';
import { Dialog } from '@anthropic/ink';
import { Select } from '../CustomSelect/index.js';
import { OutputStylePicker } from '../OutputStylePicker.js';
import { LanguagePicker } from '../LanguagePicker.js';
import {
  type MemoryFileInfo,
  getExternalClaudeMdIncludes,
  getMemoryFiles,
  hasExternalClaudeMdIncludes,
} from 'src/utils/claudemd.js';
import { Byline, KeyboardShortcutHint, useTabHeaderFocus } from '@anthropic/ink';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { useIsInsideModal } from '../../context/modalContext.js';
import { SearchBox } from '../SearchBox.js';
import { isSupportedTerminal, hasAccessToIDEExtensionDiffFeature } from '../../utils/ide.js';
import { getInitialSettings, getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js';
import { getUserMsgOptIn, setUserMsgOptIn } from '../../bootstrap/state.js';
import { DEFAULT_OUTPUT_STYLE_NAME } from 'src/constants/outputStyles.js';
import { isEnvTruthy, isRunningOnHomespace } from 'src/utils/envUtils.js';
import type { LocalJSXCommandContext, CommandResultDisplay } from '../../commands.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js';
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js';
import {
  getCliTeammateModeOverride,
  clearCliTeammateModeOverride,
} from '../../utils/swarm/backends/teammateModeSnapshot.js';
import { getHardcodedTeammateModelFallback } from '../../utils/swarm/teammateModel.js';
import { useSearchInput } from '../../hooks/useSearchInput.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import {
  clearFastModeCooldown,
  FAST_MODE_MODEL_DISPLAY,
  isFastModeAvailable,
  isFastModeEnabled,
  getFastModeModel,
  isFastModeSupportedByModel,
} from '../../utils/fastMode.js';
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js';
import { getPlatform } from '../../utils/platform.js';

type Props = {
  onClose: (result?: string, options?: { display?: CommandResultDisplay }) => void;
  context: LocalJSXCommandContext;
  setTabsHidden: (hidden: boolean) => void;
  onIsSearchModeChange?: (inSearchMode: boolean) => void;
  contentHeight?: number;
};

type SettingBase =
  | {
      id: string;
      label: string;
    }
  | {
      id: string;
      label: React.ReactNode;
      searchText: string;
    };

type Setting =
  | (SettingBase & {
      value: boolean;
      onChange(value: boolean): void;
      type: 'boolean';
    })
  | (SettingBase & {
      value: string;
      options: string[];
      onChange(value: string): void;
      type: 'enum';
    })
  | (SettingBase & {
      // 对于由自定义组件设置的枚举，我们不需要传入 options，
      // 但仍需要一个 value 用于在顶级 config 菜单中展示
      value: string;
      onChange(value: string): void;
      type: 'managedEnum';
    });

type SubMenu =
  | 'Theme'
  | 'Model'
  | 'TeammateModel'
  | 'ExternalIncludes'
  | 'OutputStyle'
  | 'ChannelDowngrade'
  | 'Language'
  | 'EnableAutoUpdates';
export function Config({
  onClose,
  context,
  setTabsHidden,
  onIsSearchModeChange,
  contentHeight,
}: Props): React.ReactNode {
  const { headerFocused, focusHeader } = useTabHeaderFocus();
  const insideModal = useIsInsideModal();
  const [, setTheme] = useTheme();
  const themeSetting = useThemeSetting();
  const [globalConfig, setGlobalConfig] = useState(getGlobalConfig());
  const initialConfig = React.useRef(getGlobalConfig());
  const [settingsData, setSettingsData] = useState(getInitialSettings());
  const initialSettingsData = React.useRef(getInitialSettings());
  const [currentOutputStyle, setCurrentOutputStyle] = useState<OutputStyle>(
    settingsData?.outputStyle || DEFAULT_OUTPUT_STYLE_NAME,
  );
  const initialOutputStyle = React.useRef(currentOutputStyle);
  const [currentLanguage, setCurrentLanguage] = useState<string | undefined>(settingsData?.language);
  const initialLanguage = React.useRef(currentLanguage);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [isSearchMode, setIsSearchMode] = useState(false);
  const isTerminalFocused = useTerminalFocus();
  const { rows } = useTerminalSize();
  // contentHeight 由 Settings.tsx 设置（同一个值会传给 Tabs 以固定所有
  // tab 的面板高度——切换时避免布局抖动）。
  // 预留约 10 行给 chrome（搜索框、间距、页脚、滚动提示）。
  // 这里的回退计算用于独立渲染（测试场景）。
  const paneCap = contentHeight ?? Math.min(Math.floor(rows * 0.8), 30);
  const maxVisible = Math.max(5, paneCap - 10);
  const mainLoopModel = useAppState(s => s.mainLoopModel);
  const verbose = useAppState(s => s.verbose);
  const thinkingEnabled = useAppState(s => s.thinkingEnabled);
  const isFastMode = useAppState(s => (isFastModeEnabled() ? s.fastMode : false));
  const promptSuggestionEnabled = useAppState(s => s.promptSuggestionEnabled);
  const currentDefaultPermissionMode = permissionModeFromString(settingsData?.permissions?.defaultMode ?? 'default');
  // 当用户已选择加入或配置完全为 'enabled' 时，在默认模式下拉框中展示 auto——
  // 即使当前处于熔断状态（'disabled'），已选择的用户也应该能在设置里看到它
  // （这是一个临时状态）。
  const showAutoInDefaultModePicker = feature('TRANSCRIPT_CLASSIFIER')
    ? hasAutoModeOptInAnySource() || getAutoModeEnabledState() === 'enabled'
    : false;
  // Chat/Transcript 视图选择器对有权限的用户（通过 GB 灰度门控）可见，
  // 即便他们本次会话还没选择加入——它本身就是持久化的选择入口。
  // 这里写入的 'chat' 会在下次启动时被 main.tsx 读取，若仍有权限则
  // 设置 userMsgOptIn。
  /* eslint-disable @typescript-eslint/no-require-imports */
  const showDefaultViewPicker =
    feature('KAIROS') || feature('KAIROS_BRIEF')
      ? (
          require('@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js') as typeof import('@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js')
        ).isBriefEntitled()
      : false;
  /* eslint-enable @typescript-eslint/no-require-imports */
  const setAppState = useSetAppState();
  const [changes, setChanges] = useState<{ [key: string]: unknown }>({});
  const initialThinkingEnabled = React.useRef(thinkingEnabled);
  // 按来源的设置快照，用于 Escape 时回滚。getInitialSettings() 返回的是
  // 跨来源合并后的结果，无法告诉我们该删除还是该还原；按来源的快照 +
  // updateSettingsForSource 的 undefined-即-删除语义可以做到。通过
  // useState 懒初始化（不使用 setter）以避免每次渲染都读取设置文件——
  // useRef 会立即求值其参数，即便只保留第一个结果。
  const [initialLocalSettings] = useState(() => getSettingsForSource('localSettings'));
  const [initialUserSettings] = useState(() => getSettingsForSource('userSettings'));
  const initialThemeSetting = React.useRef(themeSetting);
  // Config 可能修改的 AppState 字段——挂载时做一次快照。
  const store = useAppStateStore();
  const [initialAppState] = useState(() => {
    const s = store.getState();
    return {
      mainLoopModel: s.mainLoopModel,
      mainLoopModelForSession: s.mainLoopModelForSession,
      verbose: s.verbose,
      thinkingEnabled: s.thinkingEnabled,
      fastMode: s.fastMode,
      promptSuggestionEnabled: s.promptSuggestionEnabled,
      isBriefOnly: s.isBriefOnly,
      replBridgeEnabled: s.replBridgeEnabled,
      replBridgeOutboundOnly: s.replBridgeOutboundOnly,
      settings: s.settings,
    };
  });
  // Bootstrap 状态快照——userMsgOptIn 不在 AppState 中，因此
  // revertChanges 需要单独还原它。若不做这一步，把 defaultView 切换到
  // 'chat' 再按 Escape 会让工具仍处于激活状态，而显示过滤器却被还原——
  // 这正是本次 PR 权限/选择加入拆分要规避的"环境激活"行为。
  const [initialUserMsgOptIn] = useState(() => getUserMsgOptIn());
  // 在首次出现用户可见变更时设置；用于控制 Escape 时是否调用 revertChanges()，
  // 避免打开后直接关闭触发多余的磁盘写入。
  const isDirty = React.useRef(false);
  const [showThinkingWarning, setShowThinkingWarning] = useState(false);
  const [showSubmenu, setShowSubmenu] = useState<SubMenu | null>(null);
  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    cursorOffset: searchCursorOffset,
  } = useSearchInput({
    isActive: isSearchMode && showSubmenu === null && !headerFocused,
    onExit: () => setIsSearchMode(false),
    onExitUp: focusHeader,
    // Ctrl+C/D 必须透传给 Settings 的 useExitOnCtrlCD；'d' 也用于避免
    // 重复动作（删除字符 + 触发退出挂起）。
    passthroughCtrlKeys: ['c', 'd'],
  });

  // 通知父组件 Config 自身的 Esc 处理器何时激活，以便 Settings 让出
  // confirm:no。仅当搜索模式独占键盘时为 true——当 tab 标题获得焦点时为
  // false（此时必须由 Settings 处理 Esc 关闭）。
  const ownsEsc = isSearchMode && !headerFocused;
  React.useEffect(() => {
    onIsSearchModeChange?.(ownsEsc);
  }, [ownsEsc, onIsSearchModeChange]);

  const isConnectedToIde = hasAccessToIDEExtensionDiffFeature(context.options.mcpClients);

  const isFileCheckpointingAvailable = !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING);

  const memoryFiles = React.use(getMemoryFiles(true)) as MemoryFileInfo[];
  const shouldShowExternalIncludesToggle = hasExternalClaudeMdIncludes(memoryFiles);

  const autoUpdaterDisabledReason = getAutoUpdaterDisabledReason();

  function onChangeMainModelConfig(value: string | null): void {
    const previousModel = mainLoopModel;
    logEvent('tengu_config_model_changed', {
      from_model: previousModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      to_model: value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    setAppState(prev => ({
      ...prev,
      mainLoopModel: value,
      mainLoopModelForSession: null,
    }));
    setChanges(prev => {
      const valStr =
        modelDisplayString(value) +
        (isBilledAsExtraUsage(value, false, isOpus1mMergeEnabled()) ? ' · 按额外用量计费' : '');
      if ('model' in prev) {
        const { model, ...rest } = prev;
        return { ...rest, model: valStr };
      }
      return { ...prev, model: valStr };
    });
  }

  function onChangeVerbose(value: boolean): void {
    // 更新全局配置以持久化该设置
    saveGlobalConfig(current => ({ ...current, verbose: value }));
    setGlobalConfig({ ...getGlobalConfig(), verbose: value });

    // 更新 app state 以获得即时 UI 反馈
    setAppState(prev => ({
      ...prev,
      verbose: value,
    }));
    setChanges(prev => {
      if ('verbose' in prev) {
        const { verbose, ...rest } = prev;
        return rest;
      }
      return { ...prev, verbose: value };
    });
  }

  // TODO: 加入 MCP 服务器
  const settingsItems: Setting[] = [
    // 全局设置
    {
      id: 'autoCompactEnabled',
      label: '自动压缩',
      value: globalConfig.autoCompactEnabled,
      type: 'boolean' as const,
      onChange(autoCompactEnabled: boolean) {
        saveGlobalConfig(current => ({ ...current, autoCompactEnabled }));
        setGlobalConfig({ ...getGlobalConfig(), autoCompactEnabled });
        logEvent('tengu_auto_compact_setting_changed', {
          enabled: autoCompactEnabled,
        });
      },
    },
    {
      id: 'spinnerTipsEnabled',
      label: '显示提示',
      value: settingsData?.spinnerTipsEnabled ?? true,
      type: 'boolean' as const,
      onChange(spinnerTipsEnabled: boolean) {
        updateSettingsForSource('localSettings', {
          spinnerTipsEnabled,
        });
        // 更新本地 state 以即时反映变更
        setSettingsData(prev => ({
          ...prev,
          spinnerTipsEnabled,
        }));
        logEvent('tengu_tips_setting_changed', {
          enabled: spinnerTipsEnabled,
        });
      },
    },
    {
      id: 'cacheWarningEnabled',
      label: 'Cache 警告',
      value: settingsData?.cacheWarningEnabled ?? true,
      type: 'boolean' as const,
      onChange(cacheWarningEnabled: boolean) {
        updateSettingsForSource('localSettings', {
          cacheWarningEnabled,
        });
        setSettingsData(prev => ({
          ...prev,
          cacheWarningEnabled,
        }));
        logEvent('tengu_cache_warning_setting_changed', {
          enabled: cacheWarningEnabled,
        });
      },
    },
    {
      id: 'prefersReducedMotion',
      label: '减弱动效',
      value: settingsData?.prefersReducedMotion ?? false,
      type: 'boolean' as const,
      onChange(prefersReducedMotion: boolean) {
        updateSettingsForSource('localSettings', {
          prefersReducedMotion,
        });
        setSettingsData(prev => ({
          ...prev,
          prefersReducedMotion,
        }));
        // 同步到 AppState 以便组件即时响应
        setAppState(prev => ({
          ...prev,
          settings: { ...prev.settings, prefersReducedMotion },
        }));
        logEvent('tengu_reduce_motion_setting_changed', {
          enabled: prefersReducedMotion,
        });
      },
    },
    {
      id: 'thinkingEnabled',
      label: '思考模式',
      value: thinkingEnabled ?? true,
      type: 'boolean' as const,
      onChange(enabled: boolean) {
        setAppState(prev => ({ ...prev, thinkingEnabled: enabled }));
        updateSettingsForSource('userSettings', {
          alwaysThinkingEnabled: enabled ? undefined : false,
        });
        logEvent('tengu_thinking_toggled', { enabled });
      },
    },
    // 快速模式开关（仅 ant 内部，外部构建中已移除）
    ...(isFastModeEnabled() && isFastModeAvailable()
      ? [
          {
            id: 'fastMode',
            label: `快速模式（仅 ${FAST_MODE_MODEL_DISPLAY}）`,
            value: !!isFastMode,
            type: 'boolean' as const,
            onChange(enabled: boolean) {
              clearFastModeCooldown();
              updateSettingsForSource('userSettings', {
                fastMode: enabled ? true : undefined,
              });
              if (enabled) {
                setAppState(prev => ({
                  ...prev,
                  mainLoopModel: getFastModeModel(),
                  mainLoopModelForSession: null,
                  fastMode: true,
                }));
                setChanges(prev => ({
                  ...prev,
                  model: getFastModeModel(),
                  快速模式: 'ON',
                }));
              } else {
                setAppState(prev => ({
                  ...prev,
                  fastMode: false,
                }));
                setChanges(prev => ({ ...prev, 快速模式: 'OFF' }));
              }
            },
          },
        ]
      : []),
    ...(getFeatureValue_CACHED_MAY_BE_STALE('tengu_chomp_inflection', false)
      ? [
          {
            id: 'promptSuggestionEnabled',
            label: 'Prompt 建议',
            value: promptSuggestionEnabled,
            type: 'boolean' as const,
            onChange(enabled: boolean) {
              setAppState(prev => ({
                ...prev,
                promptSuggestionEnabled: enabled,
              }));
              updateSettingsForSource('userSettings', {
                promptSuggestionEnabled: enabled ? undefined : false,
              });
            },
          },
        ]
      : []),
    ...(feature('POOR')
      ? [
          {
            id: 'poorMode',
            label: '穷鬼模式（节省 token）',
            value: (() => {
              const PoorMode =
                require('../../commands/poor/poorMode.js') as typeof import('../../commands/poor/poorMode.js');
              return PoorMode.isPoorModeActive();
            })(),
            type: 'boolean' as const,
            onChange(enabled: boolean) {
              const PoorMode =
                require('../../commands/poor/poorMode.js') as typeof import('../../commands/poor/poorMode.js');
              PoorMode.setPoorMode(enabled);
              setAppState(prev => ({
                ...prev,
                promptSuggestionEnabled: !enabled,
              }));
            },
          },
        ]
      : []),
    // 推测执行开关（仅 ant 内部）
    ...(process.env.USER_TYPE === 'ant'
      ? [
          {
            id: 'speculationEnabled',
            label: '推测执行',
            value: globalConfig.speculationEnabled ?? true,
            type: 'boolean' as const,
            onChange(enabled: boolean) {
              saveGlobalConfig(current => {
                if (current.speculationEnabled === enabled) return current;
                return {
                  ...current,
                  speculationEnabled: enabled,
                };
              });
              setGlobalConfig({
                ...getGlobalConfig(),
                speculationEnabled: enabled,
              });
              logEvent('tengu_speculation_setting_changed', {
                enabled,
              });
            },
          },
        ]
      : []),
    ...(isFileCheckpointingAvailable
      ? [
          {
            id: 'fileCheckpointingEnabled',
            label: '回退代码（检查点）',
            value: globalConfig.fileCheckpointingEnabled,
            type: 'boolean' as const,
            onChange(enabled: boolean) {
              saveGlobalConfig(current => ({
                ...current,
                fileCheckpointingEnabled: enabled,
              }));
              setGlobalConfig({
                ...getGlobalConfig(),
                fileCheckpointingEnabled: enabled,
              });
              logEvent('tengu_file_history_snapshots_setting_changed', {
                enabled: enabled,
              });
            },
          },
        ]
      : []),
    {
      id: 'verbose',
      label: '详细输出',
      value: verbose,
      type: 'boolean',
      onChange: onChangeVerbose,
    },
    {
      id: 'terminalProgressBarEnabled',
      label: '终端进度条',
      value: globalConfig.terminalProgressBarEnabled,
      type: 'boolean' as const,
      onChange(terminalProgressBarEnabled: boolean) {
        saveGlobalConfig(current => ({
          ...current,
          terminalProgressBarEnabled,
        }));
        setGlobalConfig({ ...getGlobalConfig(), terminalProgressBarEnabled });
        logEvent('tengu_terminal_progress_bar_setting_changed', {
          enabled: terminalProgressBarEnabled,
        });
      },
    },
    ...(getFeatureValue_CACHED_MAY_BE_STALE('tengu_terminal_sidebar', false)
      ? [
          {
            id: 'showStatusInTerminalTab',
            label: '在终端标签页中显示状态',
            value: globalConfig.showStatusInTerminalTab ?? false,
            type: 'boolean' as const,
            onChange(showStatusInTerminalTab: boolean) {
              saveGlobalConfig(current => ({
                ...current,
                showStatusInTerminalTab,
              }));
              setGlobalConfig({
                ...getGlobalConfig(),
                showStatusInTerminalTab,
              });
              logEvent('tengu_terminal_tab_status_setting_changed', {
                enabled: showStatusInTerminalTab,
              });
            },
          },
        ]
      : []),
    {
      id: 'showTurnDuration',
      label: '显示单轮耗时',
      value: globalConfig.showTurnDuration,
      type: 'boolean' as const,
      onChange(showTurnDuration: boolean) {
        saveGlobalConfig(current => ({ ...current, showTurnDuration }));
        setGlobalConfig({ ...getGlobalConfig(), showTurnDuration });
        logEvent('tengu_show_turn_duration_setting_changed', {
          enabled: showTurnDuration,
        });
      },
    },
    {
      id: 'defaultPermissionMode',
      label: '默认权限模式',
      value: currentDefaultPermissionMode,
      options: (() => {
        const priorityOrder: PermissionMode[] = ['default', 'plan'];
        return [...priorityOrder, ...PERMISSION_MODES.filter(m => !priorityOrder.includes(m))];
      })(),
      type: 'enum' as const,
      onChange(mode: string) {
        const parsedMode = permissionModeFromString(mode);
        // auto 是仅内部使用的模式——直接存储它，不要转换为
        // 它的外部映射（'default'），否则会让它在设置中不可见。
        const validatedMode =
          parsedMode === 'auto'
            ? parsedMode
            : isExternalPermissionMode(parsedMode)
              ? toExternalPermissionMode(parsedMode)
              : parsedMode;
        const result = updateSettingsForSource('userSettings', {
          permissions: {
            ...settingsData?.permissions,
            defaultMode: validatedMode as (typeof PERMISSION_MODES)[number],
          },
        });

        if (result.error) {
          logError(result.error);
          return;
        }

        // 更新本地 state 以即时反映变更。
        // validatedMode 的类型是宽泛的 PermissionMode 联合类型，但在
        // 运行时它一定是 PERMISSION_MODES 的成员（上面的选项下拉是
        // 基于该数组构建的），所以这里的类型收窄是可靠的。
        setSettingsData(prev => ({
          ...prev,
          permissions: {
            ...prev?.permissions,
            defaultMode: validatedMode as (typeof PERMISSION_MODES)[number],
          },
        }));
        // 记录变更
        setChanges(prev => ({ ...prev, defaultPermissionMode: mode }));
        logEvent('tengu_config_changed', {
          setting: 'defaultPermissionMode' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          value: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
      },
    },
    ...(feature('TRANSCRIPT_CLASSIFIER') && showAutoInDefaultModePicker
      ? [
          {
            id: 'useAutoModeDuringPlan',
            label: '在 plan 模式期间使用 auto 模式',
            value: (settingsData as { useAutoModeDuringPlan?: boolean } | undefined)?.useAutoModeDuringPlan ?? true,
            type: 'boolean' as const,
            onChange(useAutoModeDuringPlan: boolean) {
              updateSettingsForSource('userSettings', {
                useAutoModeDuringPlan,
              });
              setSettingsData(prev => ({
                ...prev,
                useAutoModeDuringPlan,
              }));
              // 内部写入会抑制文件监听器，因此
              // applySettingsChange 不会触发。直接同步以便
              // plan 进行中的开关立即生效。
              setAppState(prev => {
                const next = transitionPlanAutoMode(prev.toolPermissionContext);
                if (next === prev.toolPermissionContext) return prev;
                return { ...prev, toolPermissionContext: next };
              });
              setChanges(prev => ({
                ...prev,
                '在 plan 模式期间使用 auto 模式': useAutoModeDuringPlan,
              }));
            },
          },
        ]
      : []),
    {
      id: 'respectGitignore',
      label: '在文件选择器中遵守 .gitignore',
      value: globalConfig.respectGitignore,
      type: 'boolean' as const,
      onChange(respectGitignore: boolean) {
        saveGlobalConfig(current => ({ ...current, respectGitignore }));
        setGlobalConfig({ ...getGlobalConfig(), respectGitignore });
        logEvent('tengu_respect_gitignore_setting_changed', {
          enabled: respectGitignore,
        });
      },
    },
    {
      id: 'copyFullResponse',
      label: '总是复制完整回复（跳过 /copy 选择器）',
      value: globalConfig.copyFullResponse,
      type: 'boolean' as const,
      onChange(copyFullResponse: boolean) {
        saveGlobalConfig(current => ({ ...current, copyFullResponse }));
        setGlobalConfig({ ...getGlobalConfig(), copyFullResponse });
        logEvent('tengu_config_changed', {
          setting: 'copyFullResponse' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          value: String(copyFullResponse) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
      },
    },
    // 选中即复制仅对应用内选择（全屏 alt-screen 模式）有意义。
    // 在 inline 模式下，选择行为由终端模拟器接管。
    ...(isFullscreenEnvEnabled()
      ? [
          {
            id: 'copyOnSelect',
            label: '选中即复制',
            value: globalConfig.copyOnSelect ?? true,
            type: 'boolean' as const,
            onChange(copyOnSelect: boolean) {
              saveGlobalConfig(current => ({ ...current, copyOnSelect }));
              setGlobalConfig({ ...getGlobalConfig(), copyOnSelect });
              logEvent('tengu_config_changed', {
                setting: 'copyOnSelect' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                value: String(copyOnSelect) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              });
            },
          },
        ]
      : []),
    // autoUpdates 设置已隐藏——用 DISABLE_AUTOUPDATER 环境变量来控制
    autoUpdaterDisabledReason
      ? {
          id: 'autoUpdatesChannel',
          label: '自动更新渠道',
          value: 'disabled',
          type: 'managedEnum' as const,
          onChange() {},
        }
      : {
          id: 'autoUpdatesChannel',
          label: '自动更新渠道',
          value: settingsData?.autoUpdatesChannel ?? 'latest',
          type: 'managedEnum' as const,
          onChange() {
            // 由 toggleSetting -> 'ChannelDowngrade' 处理
          },
        },
    {
      id: 'theme',
      label: '主题',
      value: themeSetting,
      type: 'managedEnum',
      onChange: setTheme,
    },
    {
      id: 'notifChannel',
      label: feature('KAIROS') || feature('KAIROS_PUSH_NOTIFICATION') ? '本地通知' : '通知',
      value: globalConfig.preferredNotifChannel,
      options: ['auto', 'iterm2', 'terminal_bell', 'iterm2_with_bell', 'kitty', 'ghostty', 'notifications_disabled'],
      type: 'enum',
      onChange(notifChannel: GlobalConfig['preferredNotifChannel']) {
        saveGlobalConfig(current => ({
          ...current,
          preferredNotifChannel: notifChannel,
        }));
        setGlobalConfig({
          ...getGlobalConfig(),
          preferredNotifChannel: notifChannel,
        });
      },
    },
    ...(feature('KAIROS') || feature('KAIROS_PUSH_NOTIFICATION')
      ? [
          {
            id: 'taskCompleteNotifEnabled',
            label: '空闲时推送',
            value: globalConfig.taskCompleteNotifEnabled ?? false,
            type: 'boolean' as const,
            onChange(taskCompleteNotifEnabled: boolean) {
              saveGlobalConfig(current => ({
                ...current,
                taskCompleteNotifEnabled,
              }));
              setGlobalConfig({
                ...getGlobalConfig(),
                taskCompleteNotifEnabled,
              });
            },
          },
          {
            id: 'inputNeededNotifEnabled',
            label: '需要输入时推送',
            value: globalConfig.inputNeededNotifEnabled ?? false,
            type: 'boolean' as const,
            onChange(inputNeededNotifEnabled: boolean) {
              saveGlobalConfig(current => ({
                ...current,
                inputNeededNotifEnabled,
              }));
              setGlobalConfig({
                ...getGlobalConfig(),
                inputNeededNotifEnabled,
              });
            },
          },
          {
            id: 'agentPushNotifEnabled',
            label: 'Claude 自行决策时推送',
            value: globalConfig.agentPushNotifEnabled ?? false,
            type: 'boolean' as const,
            onChange(agentPushNotifEnabled: boolean) {
              saveGlobalConfig(current => ({
                ...current,
                agentPushNotifEnabled,
              }));
              setGlobalConfig({
                ...getGlobalConfig(),
                agentPushNotifEnabled,
              });
            },
          },
        ]
      : []),
    {
      id: 'outputStyle',
      label: '输出风格',
      value: currentOutputStyle,
      type: 'managedEnum' as const,
      onChange: () => {}, // 由 OutputStylePicker 子菜单处理
    },
    ...(showDefaultViewPicker
      ? [
          {
            id: 'defaultView',
            label: '默认显示的视图',
            // 'default' 表示该设置未设置——当前会解析为
            // transcript（当 defaultView !== 'chat' 时 main.tsx 直接走默认分支）。
            // String() 将条件 schema 扩展联合类型收窄为 string。
            value: settingsData?.defaultView === undefined ? 'default' : String(settingsData.defaultView),
            options: ['transcript', 'chat', 'default'],
            type: 'enum' as const,
            onChange(selected: string) {
              const defaultView = selected === 'default' ? undefined : (selected as 'chat' | 'transcript');
              updateSettingsForSource('localSettings', { defaultView });
              setSettingsData(prev => ({ ...prev, defaultView }));
              const nextBrief = defaultView === 'chat';
              setAppState(prev => {
                if (prev.isBriefOnly === nextBrief) return prev;
                return { ...prev, isBriefOnly: nextBrief };
              });
              // 让 userMsgOptIn 保持同步，以便工具列表跟随视图变化。
              // 现在是双向同步（与 /brief 一致）——宁可接受一次 cache 失效，
              // 也好过切换走之后工具仍处于开启状态。
              // 通过 initialUserMsgOptIn 快照在 Escape 时还原。
              setUserMsgOptIn(nextBrief);
              setChanges(prev => ({ ...prev, 默认视图: selected }));
              logEvent('tengu_default_view_setting_changed', {
                value: (defaultView ?? 'unset') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              });
            },
          },
        ]
      : []),
    {
      id: 'language',
      label: '语言',
      value: currentLanguage ?? '默认（English）',
      type: 'managedEnum' as const,
      onChange: () => {}, // 由 LanguagePicker 子菜单处理
    },
    {
      id: 'editorMode',
      label: '编辑器模式',
      // 出于向后兼容把 'emacs' 转为 'normal'
      value: globalConfig.editorMode === 'emacs' ? 'normal' : globalConfig.editorMode || 'normal',
      options: ['normal', 'vim'],
      type: 'enum',
      onChange(value: string) {
        saveGlobalConfig(current => ({
          ...current,
          editorMode: value as GlobalConfig['editorMode'],
        }));
        setGlobalConfig({
          ...getGlobalConfig(),
          editorMode: value as GlobalConfig['editorMode'],
        });

        logEvent('tengu_editor_mode_changed', {
          mode: value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          source: 'config_panel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
      },
    },
    {
      id: 'prStatusFooterEnabled',
      label: '显示 PR 状态页脚',
      value: globalConfig.prStatusFooterEnabled ?? true,
      type: 'boolean' as const,
      onChange(enabled: boolean) {
        saveGlobalConfig(current => {
          if (current.prStatusFooterEnabled === enabled) return current;
          return {
            ...current,
            prStatusFooterEnabled: enabled,
          };
        });
        setGlobalConfig({
          ...getGlobalConfig(),
          prStatusFooterEnabled: enabled,
        });
        logEvent('tengu_pr_status_footer_setting_changed', {
          enabled,
        });
      },
    },
    {
      id: 'model',
      label: '模型',
      value: mainLoopModel === null ? '默认（推荐）' : mainLoopModel,
      type: 'managedEnum' as const,
      onChange: onChangeMainModelConfig,
    },
    ...(isConnectedToIde
      ? [
          {
            id: 'diffTool',
            label: 'Diff 工具',
            value: globalConfig.diffTool ?? 'auto',
            options: ['terminal', 'auto'],
            type: 'enum' as const,
            onChange(diffTool: string) {
              saveGlobalConfig(current => ({
                ...current,
                diffTool: diffTool as GlobalConfig['diffTool'],
              }));
              setGlobalConfig({
                ...getGlobalConfig(),
                diffTool: diffTool as GlobalConfig['diffTool'],
              });

              logEvent('tengu_diff_tool_changed', {
                tool: diffTool as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                source: 'config_panel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              });
            },
          },
        ]
      : []),
    ...(!isSupportedTerminal()
      ? [
          {
            id: 'autoConnectIde',
            label: '自动连接 IDE（外部终端）',
            value: globalConfig.autoConnectIde ?? false,
            type: 'boolean' as const,
            onChange(autoConnectIde: boolean) {
              saveGlobalConfig(current => ({ ...current, autoConnectIde }));
              setGlobalConfig({ ...getGlobalConfig(), autoConnectIde });

              logEvent('tengu_auto_connect_ide_changed', {
                enabled: autoConnectIde,
                source: 'config_panel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              });
            },
          },
        ]
      : []),
    ...(isSupportedTerminal()
      ? [
          {
            id: 'autoInstallIdeExtension',
            label: '自动安装 IDE 扩展',
            value: globalConfig.autoInstallIdeExtension ?? true,
            type: 'boolean' as const,
            onChange(autoInstallIdeExtension: boolean) {
              saveGlobalConfig(current => ({
                ...current,
                autoInstallIdeExtension,
              }));
              setGlobalConfig({ ...getGlobalConfig(), autoInstallIdeExtension });

              logEvent('tengu_auto_install_ide_extension_changed', {
                enabled: autoInstallIdeExtension,
                source: 'config_panel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              });
            },
          },
        ]
      : []),
    {
      id: 'claudeInChromeDefaultEnabled',
      label: '默认启用 Claude in Chrome',
      value: globalConfig.claudeInChromeDefaultEnabled ?? true,
      type: 'boolean' as const,
      onChange(enabled: boolean) {
        saveGlobalConfig(current => ({
          ...current,
          claudeInChromeDefaultEnabled: enabled,
        }));
        setGlobalConfig({
          ...getGlobalConfig(),
          claudeInChromeDefaultEnabled: enabled,
        });
        logEvent('tengu_claude_in_chrome_setting_changed', {
          enabled,
        });
      },
    },
    // Teammate 模式（仅在启用 agent swarms 时显示）
    ...(isAgentSwarmsEnabled()
      ? (() => {
          const cliOverride = getCliTeammateModeOverride();
          const label = cliOverride ? `Teammate 模式 [被覆盖：${cliOverride}]` : 'Teammate 模式';
          const isWindows = getPlatform() === 'windows';
          const teammateModeOptions = isWindows
            ? ['auto', 'tmux', 'windows-terminal', 'in-process']
            : ['auto', 'tmux', 'in-process'];
          return [
            {
              id: 'teammateMode',
              label,
              value: globalConfig.teammateMode ?? 'auto',
              options: teammateModeOptions,
              type: 'enum' as const,
              onChange(mode: string) {
                if (mode !== 'auto' && mode !== 'tmux' && mode !== 'windows-terminal' && mode !== 'in-process') {
                  return;
                }
                if (mode === 'windows-terminal' && !isWindows) {
                  return;
                }
                // 清除 CLI 覆盖并设置新模式（传入 mode 以避免竞态条件）
                clearCliTeammateModeOverride(mode);
                saveGlobalConfig(current => ({
                  ...current,
                  teammateMode: mode,
                }));
                setGlobalConfig({
                  ...getGlobalConfig(),
                  teammateMode: mode,
                });
                logEvent('tengu_teammate_mode_changed', {
                  mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                });
              },
            },
            {
              id: 'teammateDefaultModel',
              label: '默认 teammate 模型',
              value: teammateModelDisplayString(globalConfig.teammateDefaultModel),
              type: 'managedEnum' as const,
              onChange() {},
            },
          ];
        })()
      : []),
    // 启动时启用 Remote 的开关——受 build flag + GrowthBook + policy 控制
    ...(feature('BRIDGE_MODE') && isBridgeEnabled()
      ? [
          {
            id: 'remoteControlAtStartup',
            label: '为所有会话启用 Remote Control',
            value:
              globalConfig.remoteControlAtStartup === undefined
                ? 'default'
                : String(globalConfig.remoteControlAtStartup),
            options: ['true', 'false', 'default'],
            type: 'enum' as const,
            onChange(selected: string) {
              if (selected === 'default') {
                // 取消设置该 config key，使其回退到平台默认值
                saveGlobalConfig(current => {
                  if (current.remoteControlAtStartup === undefined) return current;
                  const next = { ...current };
                  delete next.remoteControlAtStartup;
                  return next;
                });
                setGlobalConfig({
                  ...getGlobalConfig(),
                  remoteControlAtStartup: undefined,
                });
              } else {
                const enabled = selected === 'true';
                saveGlobalConfig(current => {
                  if (current.remoteControlAtStartup === enabled) return current;
                  return { ...current, remoteControlAtStartup: enabled };
                });
                setGlobalConfig({
                  ...getGlobalConfig(),
                  remoteControlAtStartup: enabled,
                });
              }
              // 同步到 AppState 以便 useReplBridge 即时响应
              const resolved = getRemoteControlAtStartup();
              setAppState(prev => {
                if (prev.replBridgeEnabled === resolved && !prev.replBridgeOutboundOnly) return prev;
                return {
                  ...prev,
                  replBridgeEnabled: resolved,
                  replBridgeOutboundOnly: false,
                };
              });
            },
          },
        ]
      : []),
    ...(shouldShowExternalIncludesToggle
      ? [
          {
            id: 'showExternalIncludesDialog',
            label: '外部 CLAUDE.md 引入',
            value: (() => {
              const projectConfig = getCurrentProjectConfig();
              if (projectConfig.hasClaudeMdExternalIncludesApproved) {
                return 'true';
              } else {
                return 'false';
              }
            })(),
            type: 'managedEnum' as const,
            onChange() {
              // 将由 toggleSetting 函数处理
            },
          },
        ]
      : []),
    ...(process.env.ANTHROPIC_API_KEY && !isRunningOnHomespace()
      ? [
          {
            id: 'apiKey',
            label: (
              <Text>
                使用自定义 API key: <Text bold>{normalizeApiKeyForConfig(process.env.ANTHROPIC_API_KEY)}</Text>
              </Text>
            ),
            searchText: '使用自定义 API key',
            value: Boolean(
              process.env.ANTHROPIC_API_KEY &&
                globalConfig.customApiKeyResponses?.approved?.includes(
                  normalizeApiKeyForConfig(process.env.ANTHROPIC_API_KEY),
                ),
            ),
            type: 'boolean' as const,
            onChange(useCustomKey: boolean) {
              saveGlobalConfig(current => {
                const updated = { ...current };
                if (!updated.customApiKeyResponses) {
                  updated.customApiKeyResponses = {
                    approved: [],
                    rejected: [],
                  };
                }
                if (!updated.customApiKeyResponses.approved) {
                  updated.customApiKeyResponses = {
                    ...updated.customApiKeyResponses,
                    approved: [],
                  };
                }
                if (!updated.customApiKeyResponses.rejected) {
                  updated.customApiKeyResponses = {
                    ...updated.customApiKeyResponses,
                    rejected: [],
                  };
                }
                if (process.env.ANTHROPIC_API_KEY) {
                  const truncatedKey = normalizeApiKeyForConfig(process.env.ANTHROPIC_API_KEY);
                  if (useCustomKey) {
                    updated.customApiKeyResponses = {
                      ...updated.customApiKeyResponses,
                      approved: [
                        ...(updated.customApiKeyResponses.approved ?? []).filter(k => k !== truncatedKey),
                        truncatedKey,
                      ],
                      rejected: (updated.customApiKeyResponses.rejected ?? []).filter(k => k !== truncatedKey),
                    };
                  } else {
                    updated.customApiKeyResponses = {
                      ...updated.customApiKeyResponses,
                      approved: (updated.customApiKeyResponses.approved ?? []).filter(k => k !== truncatedKey),
                      rejected: [
                        ...(updated.customApiKeyResponses.rejected ?? []).filter(k => k !== truncatedKey),
                        truncatedKey,
                      ],
                    };
                  }
                }
                return updated;
              });
              setGlobalConfig(getGlobalConfig());
            },
          },
        ]
      : []),
  ];

  // 根据搜索查询过滤设置项
  const filteredSettingsItems = React.useMemo(() => {
    if (!searchQuery) return settingsItems;
    const lowerQuery = searchQuery.toLowerCase();
    return settingsItems.filter(setting => {
      if (setting.id.toLowerCase().includes(lowerQuery)) return true;
      const searchableText = 'searchText' in setting ? setting.searchText : setting.label;
      return searchableText.toLowerCase().includes(lowerQuery);
    });
  }, [settingsItems, searchQuery]);

  // 当过滤后的列表缩短时调整选中索引，并在 maxVisible 变化时（例如终端
  // 尺寸改变）保持选中项可见。
  React.useEffect(() => {
    if (selectedIndex >= filteredSettingsItems.length) {
      const newIndex = Math.max(0, filteredSettingsItems.length - 1);
      setSelectedIndex(newIndex);
      setScrollOffset(Math.max(0, newIndex - maxVisible + 1));
      return;
    }
    setScrollOffset(prev => {
      if (selectedIndex < prev) return selectedIndex;
      if (selectedIndex >= prev + maxVisible) return selectedIndex - maxVisible + 1;
      return prev;
    });
  }, [filteredSettingsItems.length, selectedIndex, maxVisible]);

  // 让选中项在滚动窗口中保持可见。
  // 从导航处理器同步调用，以避免出现选中项落在可见窗口之外的渲染帧。
  const adjustScrollOffset = useCallback(
    (newIndex: number) => {
      setScrollOffset(prev => {
        if (newIndex < prev) return newIndex;
        if (newIndex >= prev + maxVisible) return newIndex - maxVisible + 1;
        return prev;
      });
    },
    [maxVisible],
  );

  // Enter：保留所有变更（已由 onChange 处理器持久化），关闭时附带一份
  // 变更摘要。
  const handleSaveAndClose = useCallback(() => {
    // 子菜单处理：每个子菜单有自己的 Enter/Esc——当某个子菜单打开时
    // 不要关闭整个面板。
    if (showSubmenu !== null) {
      return;
    }
    // 记录所发生的变更
    // TODO: 把这些改成正式的提示文案
    const formattedChanges: string[] = Object.entries(changes).map(([key, value]) => {
      logEvent('tengu_config_changed', {
        key: key as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        value: value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      return `将 ${key} 设置为 ${chalk.bold(value)}`;
    });
    // 检查 API key 变更
    // 在 homespace 上，ANTHROPIC_API_KEY 会保留在 process.env 中供子进程
    // 使用，但 Claude Code 自身会忽略它（见 auth.ts）。
    const effectiveApiKey = isRunningOnHomespace() ? undefined : process.env.ANTHROPIC_API_KEY;
    const initialUsingCustomKey = Boolean(
      effectiveApiKey &&
        initialConfig.current.customApiKeyResponses?.approved?.includes(normalizeApiKeyForConfig(effectiveApiKey)),
    );
    const currentUsingCustomKey = Boolean(
      effectiveApiKey &&
        globalConfig.customApiKeyResponses?.approved?.includes(normalizeApiKeyForConfig(effectiveApiKey)),
    );
    if (initialUsingCustomKey !== currentUsingCustomKey) {
      formattedChanges.push(`${currentUsingCustomKey ? '已启用' : '已禁用'}自定义 API key`);
      logEvent('tengu_config_changed', {
        key: 'env.ANTHROPIC_API_KEY' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        value: currentUsingCustomKey as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
    }
    if (globalConfig.theme !== initialConfig.current.theme) {
      formattedChanges.push(`将主题设置为 ${chalk.bold(globalConfig.theme)}`);
    }
    if (globalConfig.preferredNotifChannel !== initialConfig.current.preferredNotifChannel) {
      formattedChanges.push(`将通知设置为 ${chalk.bold(globalConfig.preferredNotifChannel)}`);
    }
    if (currentOutputStyle !== initialOutputStyle.current) {
      formattedChanges.push(`将输出风格设置为 ${chalk.bold(currentOutputStyle)}`);
    }
    if (currentLanguage !== initialLanguage.current) {
      formattedChanges.push(`将回复语言设置为 ${chalk.bold(currentLanguage ?? '默认（English）')}`);
    }
    if (globalConfig.editorMode !== initialConfig.current.editorMode) {
      formattedChanges.push(`将编辑器模式设置为 ${chalk.bold(globalConfig.editorMode || 'emacs')}`);
    }
    if (globalConfig.diffTool !== initialConfig.current.diffTool) {
      formattedChanges.push(`将 diff 工具设置为 ${chalk.bold(globalConfig.diffTool)}`);
    }
    if (globalConfig.autoConnectIde !== initialConfig.current.autoConnectIde) {
      formattedChanges.push(`${globalConfig.autoConnectIde ? '已启用' : '已禁用'}自动连接 IDE`);
    }
    if (globalConfig.autoInstallIdeExtension !== initialConfig.current.autoInstallIdeExtension) {
      formattedChanges.push(`${globalConfig.autoInstallIdeExtension ? '已启用' : '已禁用'}自动安装 IDE 扩展`);
    }
    if (globalConfig.autoCompactEnabled !== initialConfig.current.autoCompactEnabled) {
      formattedChanges.push(`${globalConfig.autoCompactEnabled ? '已启用' : '已禁用'}自动压缩`);
    }
    if (globalConfig.respectGitignore !== initialConfig.current.respectGitignore) {
      formattedChanges.push(`${globalConfig.respectGitignore ? '已启用' : '已禁用'}文件选择器中遵守 .gitignore`);
    }
    if (globalConfig.copyFullResponse !== initialConfig.current.copyFullResponse) {
      formattedChanges.push(`${globalConfig.copyFullResponse ? '已启用' : '已禁用'}总是复制完整回复`);
    }
    if (globalConfig.copyOnSelect !== initialConfig.current.copyOnSelect) {
      formattedChanges.push(`${globalConfig.copyOnSelect ? '已启用' : '已禁用'}选中即复制`);
    }
    if (globalConfig.terminalProgressBarEnabled !== initialConfig.current.terminalProgressBarEnabled) {
      formattedChanges.push(`${globalConfig.terminalProgressBarEnabled ? '已启用' : '已禁用'}终端进度条`);
    }
    if (globalConfig.showStatusInTerminalTab !== initialConfig.current.showStatusInTerminalTab) {
      formattedChanges.push(`${globalConfig.showStatusInTerminalTab ? '已启用' : '已禁用'}终端标签页状态`);
    }
    if (globalConfig.showTurnDuration !== initialConfig.current.showTurnDuration) {
      formattedChanges.push(`${globalConfig.showTurnDuration ? '已启用' : '已禁用'}单轮耗时显示`);
    }
    if (globalConfig.remoteControlAtStartup !== initialConfig.current.remoteControlAtStartup) {
      const remoteLabel =
        globalConfig.remoteControlAtStartup === undefined
          ? '将 Remote Control 重置为默认值'
          : `${globalConfig.remoteControlAtStartup ? '已启用' : '已禁用'}为所有会话启用 Remote Control`;
      formattedChanges.push(remoteLabel);
    }
    if (settingsData?.autoUpdatesChannel !== initialSettingsData.current?.autoUpdatesChannel) {
      formattedChanges.push(`将自动更新渠道设置为 ${chalk.bold(settingsData?.autoUpdatesChannel ?? 'latest')}`);
    }
    if (formattedChanges.length > 0) {
      onClose(formattedChanges.join('\n'));
    } else {
      onClose('配置对话框已关闭', { display: 'system' });
    }
  }, [
    showSubmenu,
    changes,
    globalConfig,
    mainLoopModel,
    currentOutputStyle,
    currentLanguage,
    settingsData?.autoUpdatesChannel,
    isFastModeEnabled() ? (settingsData as Record<string, unknown> | undefined)?.fastMode : undefined,
    onClose,
  ]);

  // 将所有 state store 还原到挂载时的快照。变更在切换开关时会立即写入
  // 磁盘/AppState，因此"取消"意味着要主动把旧值写回去。
  const revertChanges = useCallback(() => {
    // Theme：还原 ThemeProvider 的 React state。必须在全局 config 覆盖
    // 之前执行，因为 setTheme 内部会以增量更新方式调用 saveGlobalConfig——
    // 我们希望最后一次写入是完整快照。
    if (themeSetting !== initialThemeSetting.current) {
      setTheme(initialThemeSetting.current);
    }
    // 全局 config：用快照做完整覆盖。当返回的 ref 等于当前 ref 时
    // saveGlobalConfig 会跳过（测试模式检查 ref；生产环境会写入磁盘，
    // 但内容完全一致）。
    saveGlobalConfig(() => initialConfig.current);
    // 设置文件：还原 Config 可能触及的每个 key。undefined 会删除该 key
    //（settings.ts:368 处 updateSettingsForSource 的 customizer 行为）。
    const il = initialLocalSettings;
    updateSettingsForSource('localSettings', {
      spinnerTipsEnabled: il?.spinnerTipsEnabled,
      prefersReducedMotion: il?.prefersReducedMotion,
      defaultView: il?.defaultView,
      outputStyle: il?.outputStyle,
    });
    const iu = initialUserSettings;
    updateSettingsForSource('userSettings', {
      alwaysThinkingEnabled: iu?.alwaysThinkingEnabled,
      fastMode: iu?.fastMode,
      promptSuggestionEnabled: iu?.promptSuggestionEnabled,
      autoUpdatesChannel: iu?.autoUpdatesChannel,
      minimumVersion: iu?.minimumVersion,
      language: iu?.language,
      ...(feature('TRANSCRIPT_CLASSIFIER')
        ? {
            useAutoModeDuringPlan: (iu as { useAutoModeDuringPlan?: boolean } | undefined)?.useAutoModeDuringPlan,
          }
        : {}),
      // ThemePicker 的 Ctrl+T 会直接写入这个 key——把它包含进来，让磁盘
      // 状态随内存中的 AppState.settings 还原一起回滚。
      syntaxHighlightingDisabled: iu?.syntaxHighlightingDisabled,
      // permissions：上面的 defaultMode onChange 会把合并后的
      // settingsData.permissions 展开写入 userSettings——project/policy 的
      // allow/deny 数组可能因此泄漏到磁盘。展开完整的初始快照，这样
      // mergeWith 的数组 customizer（settings.ts:375）会替换掉泄漏的数组。
      // 显式包含 defaultMode，这样即便 iu.permissions 缺少该 key，undefined
      // 也会触发 customizer 的删除路径。
      permissions:
        iu?.permissions === undefined ? undefined : { ...iu.permissions, defaultMode: iu.permissions.defaultMode },
    });
    // AppState：批量还原所有可能被修改过的字段。
    const ia = initialAppState;
    setAppState(prev => ({
      ...prev,
      mainLoopModel: ia.mainLoopModel,
      mainLoopModelForSession: ia.mainLoopModelForSession,
      verbose: ia.verbose,
      thinkingEnabled: ia.thinkingEnabled,
      fastMode: ia.fastMode,
      promptSuggestionEnabled: ia.promptSuggestionEnabled,
      isBriefOnly: ia.isBriefOnly,
      replBridgeEnabled: ia.replBridgeEnabled,
      replBridgeOutboundOnly: ia.replBridgeOutboundOnly,
      settings: ia.settings,
      // 在上面还原 useAutoModeDuringPlan 后同步 auto-mode 状态——
      // onChange 处理器可能在 plan 进行中激活/停用了 auto。
      toolPermissionContext: transitionPlanAutoMode(prev.toolPermissionContext),
    }));
    // Bootstrap 状态：还原 userMsgOptIn。只被上面的 defaultView onChange
    // 触及，所以这里不需要 feature() 守卫（该路径仅在
    // showDefaultViewPicker 为 true 时存在）。
    if (getUserMsgOptIn() !== initialUserMsgOptIn) {
      setUserMsgOptIn(initialUserMsgOptIn);
    }
  }, [
    themeSetting,
    setTheme,
    initialLocalSettings,
    initialUserSettings,
    initialAppState,
    initialUserMsgOptIn,
    setAppState,
  ]);

  // Escape：还原所有变更（若有）并关闭。
  const handleEscape = useCallback(() => {
    if (showSubmenu !== null) {
      return;
    }
    if (isDirty.current) {
      revertChanges();
    }
    onClose('配置对话框已关闭', { display: 'system' });
  }, [showSubmenu, revertChanges, onClose]);

  // 当子菜单打开时禁用，以便子菜单的 Dialog 处理 ESC；在搜索模式下也禁用，
  // 这样 onKeyDown 处理器（先清空再退出搜索）优先——否则在搜索中按 Escape
  // 会直接跳到还原+关闭。
  useKeybinding('confirm:no', handleEscape, {
    context: 'Settings',
    isActive: showSubmenu === null && !isSearchMode && !headerFocused,
  });
  // 仅在非搜索模式下，Enter 才触发保存并关闭（搜索模式下 Enter 会退出
  // 搜索回到列表——参见 handleKeyDown 中的 isSearchMode 分支）。
  useKeybinding('settings:close', handleSaveAndClose, {
    context: 'Settings',
    isActive: showSubmenu === null && !isSearchMode && !headerFocused,
  });

  // 通过可配置的 keybinding 实现设置项导航和切换动作。
  // 仅在非搜索模式且未打开子菜单时激活。
  const toggleSetting = useCallback(() => {
    const setting = filteredSettingsItems[selectedIndex];
    if (!setting || !setting.onChange) {
      return;
    }

    if (setting.type === 'boolean') {
      isDirty.current = true;
      setting.onChange(!setting.value);
      if (setting.id === 'thinkingEnabled') {
        const newValue = !setting.value;
        const backToInitial = newValue === initialThinkingEnabled.current;
        if (backToInitial) {
          setShowThinkingWarning(false);
        } else if (context.messages.some(m => m.type === 'assistant')) {
          setShowThinkingWarning(true);
        }
      }
      return;
    }

    if (
      setting.id === 'theme' ||
      setting.id === 'model' ||
      setting.id === 'teammateDefaultModel' ||
      setting.id === 'showExternalIncludesDialog' ||
      setting.id === 'outputStyle' ||
      setting.id === 'language'
    ) {
      // managedEnum 项会打开一个子菜单——isDirty 由子菜单的完成回调设置，
      // 而不是在这里（子菜单可能被取消）。
      switch (setting.id) {
        case 'theme':
          setShowSubmenu('Theme');
          setTabsHidden(true);
          return;
        case 'model':
          setShowSubmenu('Model');
          setTabsHidden(true);
          return;
        case 'teammateDefaultModel':
          setShowSubmenu('TeammateModel');
          setTabsHidden(true);
          return;
        case 'showExternalIncludesDialog':
          setShowSubmenu('ExternalIncludes');
          setTabsHidden(true);
          return;
        case 'outputStyle':
          setShowSubmenu('OutputStyle');
          setTabsHidden(true);
          return;
        case 'language':
          setShowSubmenu('Language');
          setTabsHidden(true);
          return;
      }
    }

    if (setting.id === 'autoUpdatesChannel') {
      if (autoUpdaterDisabledReason) {
        // 自动更新已被禁用——改为显示启用对话框
        setShowSubmenu('EnableAutoUpdates');
        setTabsHidden(true);
        return;
      }
      const currentChannel = settingsData?.autoUpdatesChannel ?? 'latest';
      if (currentChannel === 'latest') {
        // 切换到 stable——显示降级对话框
        setShowSubmenu('ChannelDowngrade');
        setTabsHidden(true);
      } else {
        // 切换到 latest——直接执行并清除 minimumVersion
        isDirty.current = true;
        updateSettingsForSource('userSettings', {
          autoUpdatesChannel: 'latest',
          minimumVersion: undefined,
        });
        setSettingsData(prev => ({
          ...prev,
          autoUpdatesChannel: 'latest',
          minimumVersion: undefined,
        }));
        logEvent('tengu_autoupdate_channel_changed', {
          channel: 'latest' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
      }
      return;
    }

    if (setting.type === 'enum') {
      isDirty.current = true;
      const currentIndex = setting.options.indexOf(setting.value);
      const nextIndex = (currentIndex + 1) % setting.options.length;
      setting.onChange(setting.options[nextIndex]!);
      return;
    }
  }, [
    autoUpdaterDisabledReason,
    filteredSettingsItems,
    selectedIndex,
    settingsData?.autoUpdatesChannel,
    setTabsHidden,
  ]);

  const moveSelection = (delta: -1 | 1): void => {
    setShowThinkingWarning(false);
    const newIndex = Math.max(0, Math.min(filteredSettingsItems.length - 1, selectedIndex + delta));
    setSelectedIndex(newIndex);
    adjustScrollOffset(newIndex);
  };

  useKeybindings(
    {
      'select:previous': () => {
        if (selectedIndex === 0) {
          // 在顶部按 ↑ 会进入搜索模式，方便用户到达列表边界后继续输入过滤。
          // 滚轮向上（scroll:lineUp）则采用钳制处理——过冲不应让焦点
          // 离开列表。
          setShowThinkingWarning(false);
          setIsSearchMode(true);
          setScrollOffset(0);
        } else {
          moveSelection(-1);
        }
      },
      'select:next': () => moveSelection(1),
      // 滚轮。当 ScrollBox 内容能完全显示时，ScrollKeybindingHandler 的
      // scroll:line* 会返回 false（未消费）——这里列表是分页（slice）的，
      // 所以总是能完全显示。事件会落回到这个处理器上导航列表，并在边界处钳制。
      'scroll:lineUp': () => moveSelection(-1),
      'scroll:lineDown': () => moveSelection(1),
      'select:accept': toggleSetting,
      'select:previousValue': () => toggleSetting(),
      'select:nextValue': () => toggleSetting(),
      'settings:search': () => {
        setIsSearchMode(true);
        setSearchQuery('');
      },
    },
    {
      context: 'Settings',
      isActive: showSubmenu === null && !isSearchMode && !headerFocused,
    },
  );

  // 跨搜索/列表模式的组合按键处理。分支顺序与原 useInput 的门控优先级一致：
  // 子菜单和标题先短路（由它们自己的处理器接管输入），然后是搜索与列表。
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (showSubmenu !== null) return;
      if (headerFocused) return;
      // 搜索模式：Esc 先清空再退出，Enter/↓ 移到列表。
      if (isSearchMode) {
        if (e.key === 'escape') {
          e.preventDefault();
          if (searchQuery.length > 0) {
            setSearchQuery('');
          } else {
            setIsSearchMode(false);
          }
          return;
        }
        if (e.key === 'return' || e.key === 'down' || e.key === 'wheeldown') {
          e.preventDefault();
          setIsSearchMode(false);
          setSelectedIndex(0);
          setScrollOffset(0);
        }
        return;
      }
      // 列表模式：left/right/tab 循环切换选中项的值。这些键过去用于切换
      // tab；现在只有在 tab 行显式获得焦点时才会切换（见 Settings.tsx 的
      // headerFocused）。
      if (e.key === 'left' || e.key === 'right' || e.key === 'tab') {
        e.preventDefault();
        toggleSetting();
        return;
      }
      // 兜底：可打印字符（除已绑定到动作的之外）进入搜索模式。排除 j/k// ——
      // useKeybindings（仍在 useInput 路径上）会通过 stopImmediatePropagation
      // 消费这些键，但 onKeyDown 是独立派发的，因此必须显式跳过它们。
      if (e.ctrl || e.meta) return;
      if (e.key === 'j' || e.key === 'k' || e.key === '/') return;
      if (e.key.length === 1 && e.key !== ' ') {
        e.preventDefault();
        setIsSearchMode(true);
        setSearchQuery(e.key);
      }
    },
    [showSubmenu, headerFocused, isSearchMode, searchQuery, setSearchQuery, toggleSetting],
  );

  return (
    <Box flexDirection="column" width="100%" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      {showSubmenu === 'Theme' ? (
        <>
          <ThemePicker
            onThemeSelect={setting => {
              isDirty.current = true;
              setTheme(setting);
              setShowSubmenu(null);
              setTabsHidden(false);
            }}
            onCancel={() => {
              setShowSubmenu(null);
              setTabsHidden(false);
            }}
            hideEscToCancel
            skipExitHandling={true} // 跳过退出处理，因为 Config 已经处理了
          />
          <Box>
            <Text dimColor italic>
              <Byline>
                <KeyboardShortcutHint shortcut="Enter" action="select" />
                <ConfigurableShortcutHint
                  action="confirm:no"
                  context="Confirmation"
                  fallback="Esc"
                  description="取消"
                />
              </Byline>
            </Text>
          </Box>
        </>
      ) : showSubmenu === 'Model' ? (
        <>
          <ModelPicker
            initial={mainLoopModel}
            onSelect={(model, _effort) => {
              isDirty.current = true;
              onChangeMainModelConfig(model);
              setShowSubmenu(null);
              setTabsHidden(false);
            }}
            onCancel={() => {
              setShowSubmenu(null);
              setTabsHidden(false);
            }}
            showFastModeNotice={
              isFastModeEnabled()
                ? isFastMode && isFastModeSupportedByModel(mainLoopModel) && isFastModeAvailable()
                : false
            }
          />
          <Text dimColor>
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description="cancel"
              />
            </Byline>
          </Text>
        </>
      ) : showSubmenu === 'TeammateModel' ? (
        <>
          <ModelPicker
            initial={globalConfig.teammateDefaultModel ?? null}
            skipSettingsWrite
            headerText="Default model for newly spawned teammates. The leader can override via the tool call's model parameter."
            onSelect={(model, _effort) => {
              setShowSubmenu(null);
              setTabsHidden(false);
              // First-open-then-Enter from unset: picker highlights "Default"
              // (initial=null) and confirming would write null, silently
              // switching Opus-fallback → follow-leader. Treat as no-op.
              if (globalConfig.teammateDefaultModel === undefined && model === null) {
                return;
              }
              isDirty.current = true;
              saveGlobalConfig(current =>
                current.teammateDefaultModel === model ? current : { ...current, teammateDefaultModel: model },
              );
              setGlobalConfig({
                ...getGlobalConfig(),
                teammateDefaultModel: model,
              });
              setChanges(prev => ({
                ...prev,
                teammateDefaultModel: teammateModelDisplayString(model),
              }));
              logEvent('tengu_teammate_default_model_changed', {
                model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              });
            }}
            onCancel={() => {
              setShowSubmenu(null);
              setTabsHidden(false);
            }}
          />
          <Text dimColor>
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description="cancel"
              />
            </Byline>
          </Text>
        </>
      ) : showSubmenu === 'ExternalIncludes' ? (
        <>
          <ClaudeMdExternalIncludesDialog
            onDone={() => {
              setShowSubmenu(null);
              setTabsHidden(false);
            }}
            externalIncludes={getExternalClaudeMdIncludes(memoryFiles as MemoryFileInfo[])}
          />
          <Text dimColor>
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description="disable external includes"
              />
            </Byline>
          </Text>
        </>
      ) : showSubmenu === 'OutputStyle' ? (
        <>
          <OutputStylePicker
            initialStyle={currentOutputStyle}
            onComplete={style => {
              isDirty.current = true;
              setCurrentOutputStyle(style ?? DEFAULT_OUTPUT_STYLE_NAME);
              setShowSubmenu(null);
              setTabsHidden(false);

              // Save to local settings
              updateSettingsForSource('localSettings', {
                outputStyle: style,
              });

              void logEvent('tengu_output_style_changed', {
                style: (style ??
                  DEFAULT_OUTPUT_STYLE_NAME) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                source: 'config_panel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                settings_source: 'localSettings' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              });
            }}
            onCancel={() => {
              setShowSubmenu(null);
              setTabsHidden(false);
            }}
          />
          <Text dimColor>
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description="cancel"
              />
            </Byline>
          </Text>
        </>
      ) : showSubmenu === 'Language' ? (
        <>
          <LanguagePicker
            initialLanguage={currentLanguage}
            onComplete={language => {
              isDirty.current = true;
              setCurrentLanguage(language);
              setShowSubmenu(null);
              setTabsHidden(false);

              // Save to user settings
              updateSettingsForSource('userSettings', {
                language,
              });

              void logEvent('tengu_language_changed', {
                language: (language ?? 'default') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                source: 'config_panel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              });
            }}
            onCancel={() => {
              setShowSubmenu(null);
              setTabsHidden(false);
            }}
          />
          <Text dimColor>
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="cancel" />
            </Byline>
          </Text>
        </>
      ) : showSubmenu === 'EnableAutoUpdates' ? (
        <Dialog
          title="Enable Auto-Updates"
          onCancel={() => {
            setShowSubmenu(null);
            setTabsHidden(false);
          }}
          hideBorder
          hideInputGuide
        >
          {autoUpdaterDisabledReason?.type !== 'config' ? (
            <>
              <Text>
                {autoUpdaterDisabledReason?.type === 'env'
                  ? 'Auto-updates are controlled by an environment variable and cannot be changed here.'
                  : 'Auto-updates are disabled in development builds.'}
              </Text>
              {autoUpdaterDisabledReason?.type === 'env' && (
                <Text dimColor>Unset {autoUpdaterDisabledReason.envVar} to re-enable auto-updates.</Text>
              )}
            </>
          ) : (
            <Select
              options={[
                {
                  label: 'Enable with latest channel',
                  value: 'latest',
                },
                {
                  label: 'Enable with stable channel',
                  value: 'stable',
                },
              ]}
              onChange={(channel: string) => {
                isDirty.current = true;
                setShowSubmenu(null);
                setTabsHidden(false);

                saveGlobalConfig(current => ({
                  ...current,
                  autoUpdates: true,
                }));
                setGlobalConfig({ ...getGlobalConfig(), autoUpdates: true });

                updateSettingsForSource('userSettings', {
                  autoUpdatesChannel: channel as 'latest' | 'stable',
                  minimumVersion: undefined,
                });
                setSettingsData(prev => ({
                  ...prev,
                  autoUpdatesChannel: channel as 'latest' | 'stable',
                  minimumVersion: undefined,
                }));
                logEvent('tengu_autoupdate_enabled', {
                  channel: channel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                });
              }}
            />
          )}
        </Dialog>
      ) : showSubmenu === 'ChannelDowngrade' ? (
        <ChannelDowngradeDialog
          currentVersion={MACRO.VERSION}
          onChoice={(choice: ChannelDowngradeChoice) => {
            setShowSubmenu(null);
            setTabsHidden(false);

            if (choice === 'cancel') {
              // User cancelled - don't change anything
              return;
            }

            isDirty.current = true;
            // Switch to stable channel
            const newSettings: {
              autoUpdatesChannel: 'stable';
              minimumVersion?: string;
            } = {
              autoUpdatesChannel: 'stable',
            };

            if (choice === 'stay') {
              // User wants to stay on current version until stable catches up
              newSettings.minimumVersion = MACRO.VERSION;
            }

            updateSettingsForSource('userSettings', newSettings);
            setSettingsData(prev => ({
              ...prev,
              ...newSettings,
            }));
            logEvent('tengu_autoupdate_channel_changed', {
              channel: 'stable' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              minimum_version_set: choice === 'stay',
            });
          }}
        />
      ) : (
        <Box flexDirection="column" gap={1} marginY={insideModal ? undefined : 1}>
          <SearchBox
            query={searchQuery}
            isFocused={isSearchMode && !headerFocused}
            isTerminalFocused={isTerminalFocused}
            cursorOffset={searchCursorOffset}
            placeholder="Search settings…"
          />
          <Box flexDirection="column">
            {filteredSettingsItems.length === 0 ? (
              <Text dimColor italic>
                No settings match &quot;{searchQuery}&quot;
              </Text>
            ) : (
              <>
                {scrollOffset > 0 && (
                  <Text dimColor>
                    {figures.arrowUp} {scrollOffset} more above
                  </Text>
                )}
                {filteredSettingsItems.slice(scrollOffset, scrollOffset + maxVisible).map((setting, i) => {
                  const actualIndex = scrollOffset + i;
                  const isSelected = actualIndex === selectedIndex && !headerFocused && !isSearchMode;

                  return (
                    <React.Fragment key={setting.id}>
                      <Box width="100%">
                        <Box width={44}>
                          <Text color={isSelected ? 'suggestion' : undefined}>
                            {isSelected ? figures.pointer : ' '} {setting.label}
                          </Text>
                        </Box>
                        <Box flexGrow={1}>
                          {setting.type === 'boolean' ? (
                            <>
                              <Text color={isSelected ? 'suggestion' : undefined}>{setting.value.toString()}</Text>
                              {showThinkingWarning && setting.id === 'thinkingEnabled' && (
                                <Text color="warning">
                                  {' '}
                                  Changing thinking mode mid-conversation will increase latency and may reduce quality.
                                </Text>
                              )}
                            </>
                          ) : setting.id === 'theme' ? (
                            <Text color={isSelected ? 'suggestion' : undefined}>
                              {THEME_LABELS[setting.value.toString()] ?? setting.value.toString()}
                            </Text>
                          ) : setting.id === 'notifChannel' ? (
                            <Text color={isSelected ? 'suggestion' : undefined}>
                              <NotifChannelLabel value={setting.value.toString()} />
                            </Text>
                          ) : setting.id === 'defaultPermissionMode' ? (
                            <Text color={isSelected ? 'suggestion' : undefined}>
                              {permissionModeShortTitle(setting.value as PermissionMode)}
                            </Text>
                          ) : setting.id === 'autoUpdatesChannel' && autoUpdaterDisabledReason ? (
                            <Box flexDirection="column">
                              <Text color={isSelected ? 'suggestion' : undefined}>disabled</Text>
                              <Text dimColor>({formatAutoUpdaterDisabledReason(autoUpdaterDisabledReason)})</Text>
                            </Box>
                          ) : (
                            <Text color={isSelected ? 'suggestion' : undefined}>{setting.value.toString()}</Text>
                          )}
                        </Box>
                      </Box>
                    </React.Fragment>
                  );
                })}
                {scrollOffset + maxVisible < filteredSettingsItems.length && (
                  <Text dimColor>
                    {figures.arrowDown} {filteredSettingsItems.length - scrollOffset - maxVisible} more below
                  </Text>
                )}
              </>
            )}
          </Box>
          {headerFocused ? (
            <Text dimColor>
              <Byline>
                <KeyboardShortcutHint shortcut="←/→ tab" action="switch" />
                <KeyboardShortcutHint shortcut="↓" action="return" />
                <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="close" />
              </Byline>
            </Text>
          ) : isSearchMode ? (
            <Text dimColor>
              <Byline>
                <Text>Type to filter</Text>
                <KeyboardShortcutHint shortcut="Enter/↓" action="select" />
                <KeyboardShortcutHint shortcut="↑" action="tabs" />
                <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="clear" />
              </Byline>
            </Text>
          ) : (
            <Text dimColor>
              <Byline>
                <ConfigurableShortcutHint
                  action="select:accept"
                  context="Settings"
                  fallback="Space"
                  description="change"
                />
                <ConfigurableShortcutHint
                  action="settings:close"
                  context="Settings"
                  fallback="Enter"
                  description="save"
                />
                <ConfigurableShortcutHint
                  action="settings:search"
                  context="Settings"
                  fallback="/"
                  description="search"
                />
                <ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="cancel" />
              </Byline>
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function teammateModelDisplayString(value: string | null | undefined): string {
  if (value === undefined) {
    return modelDisplayString(getHardcodedTeammateModelFallback());
  }
  if (value === null) return "Default (leader's model)";
  return modelDisplayString(value);
}

const THEME_LABELS: Record<string, string> = {
  auto: 'Auto (match terminal)',
  dark: 'Dark mode',
  light: 'Light mode',
  'dark-daltonized': 'Dark mode (colorblind-friendly)',
  'light-daltonized': 'Light mode (colorblind-friendly)',
  'dark-ansi': 'Dark mode (ANSI colors only)',
  'light-ansi': 'Light mode (ANSI colors only)',
};

function NotifChannelLabel({ value }: { value: string }): React.ReactNode {
  switch (value) {
    case 'auto':
      return 'Auto';
    case 'iterm2':
      return (
        <Text>
          iTerm2 <Text dimColor>(OSC 9)</Text>
        </Text>
      );
    case 'terminal_bell':
      return (
        <Text>
          Terminal Bell <Text dimColor>(\a)</Text>
        </Text>
      );
    case 'kitty':
      return (
        <Text>
          Kitty <Text dimColor>(OSC 99)</Text>
        </Text>
      );
    case 'ghostty':
      return (
        <Text>
          Ghostty <Text dimColor>(OSC 777)</Text>
        </Text>
      );
    case 'iterm2_with_bell':
      return 'iTerm2 w/ Bell';
    case 'notifications_disabled':
      return 'Disabled';
    default:
      return value;
  }
}
