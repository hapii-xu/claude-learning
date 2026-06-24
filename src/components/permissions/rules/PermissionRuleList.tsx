import chalk from 'chalk';
import figures from 'figures';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppState, useSetAppState } from 'src/state/AppState.js';
import { applyPermissionUpdate, persistPermissionUpdate } from 'src/utils/permissions/PermissionUpdate.js';
import type { PermissionUpdateDestination } from 'src/utils/permissions/PermissionUpdateSchema.js';
import type { CommandResultDisplay } from '../../../commands.js';
import { Select } from '../../../components/CustomSelect/select.js';
import { useExitOnCtrlCDWithKeybindings } from '../../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { useSearchInput } from '../../../hooks/useSearchInput.js';
import { type KeyboardEvent, Box, Text, useTerminalFocus } from '@anthropic/ink';
import { useKeybinding } from '../../../keybindings/useKeybinding.js';
import { type AutoModeDenial, getAutoModeDenials } from '../../../utils/autoModeDenials.js';
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleValue,
} from '../../../utils/permissions/PermissionRule.js';
import { permissionRuleValueToString } from '../../../utils/permissions/permissionRuleParser.js';
import {
  deletePermissionRule,
  getAllowRules,
  getAskRules,
  getDenyRules,
  permissionRuleSourceDisplayString,
} from '../../../utils/permissions/permissions.js';
import type { UnreachableRule } from '../../../utils/permissions/shadowedRuleDetection.js';
import { jsonStringify } from '../../../utils/slowOperations.js';
import { Pane, Tab, Tabs, useTabHeaderFocus, useTabsWidth } from '@anthropic/ink';
import { SearchBox } from '../../SearchBox.js';
import type { Option } from '../../ui/option.js';
import { AddPermissionRules } from './AddPermissionRules.js';
import { AddWorkspaceDirectory } from './AddWorkspaceDirectory.js';
import { PermissionRuleDescription } from './PermissionRuleDescription.js';
import { PermissionRuleInput } from './PermissionRuleInput.js';
import { RecentDenialsTab } from './RecentDenialsTab.js';
import { RemoveWorkspaceDirectory } from './RemoveWorkspaceDirectory.js';
import { WorkspaceTab } from './WorkspaceTab.js';

type TabType = 'recent' | 'allow' | 'ask' | 'deny' | 'workspace';

type RuleSourceTextProps = {
  rule: PermissionRule;
};
function RuleSourceText({ rule }: RuleSourceTextProps): React.ReactNode {
  return <Text dimColor>{`来自 ${permissionRuleSourceDisplayString(rule.source)}`}</Text>;
}

// Helper function to get the appropriate label for rule behavior
function getRuleBehaviorLabel(ruleBehavior: PermissionBehavior): string {
  switch (ruleBehavior) {
    case 'allow':
      return '已允许';
    case 'deny':
      return '已拒绝';
    case 'ask':
      return '询问';
  }
}

// Component for showing tool details and managing the interactive deletion workflow
function RuleDetails({
  rule,
  onDelete,
  onCancel,
}: {
  rule: PermissionRule;
  onDelete: () => void;
  onCancel: () => void;
}): React.ReactNode {
  const exitState = useExitOnCtrlCDWithKeybindings();
  // Use configurable keybinding for ESC to cancel
  useKeybinding('confirm:no', onCancel, { context: 'Confirmation' });

  const ruleDescription = (
    <Box flexDirection="column" marginX={2}>
      <Text bold>{permissionRuleValueToString(rule.ruleValue)}</Text>
      <PermissionRuleDescription ruleValue={rule.ruleValue} />
      <RuleSourceText rule={rule} />
    </Box>
  );

  const footer = (
    <Box marginLeft={3}>
      {exitState.pending ? <Text dimColor>再次按 {exitState.keyName} 退出</Text> : <Text dimColor>Esc 取消</Text>}
    </Box>
  );

  // Managed settings can't be edited
  if (rule.source === 'policySettings') {
    return (
      <>
        <Box
          flexDirection="column"
          gap={1}
          borderStyle="round"
          paddingLeft={1}
          paddingRight={1}
          borderColor="permission"
        >
          <Text bold color="permission">
            规则详情
          </Text>
          {ruleDescription}
          <Text italic>
            此规则由托管设置配置，无法修改。
            {'\n'}
            如需更多信息，请联系系统管理员。
          </Text>
        </Box>
        {footer}
      </>
    );
  }

  return (
    <>
      <Box flexDirection="column" gap={1} borderStyle="round" paddingLeft={1} paddingRight={1} borderColor="error">
        <Text bold color="error">
          删除 {getRuleBehaviorLabel(rule.ruleBehavior)} 工具？
        </Text>
        {ruleDescription}
        <Text>确定要删除此权限规则吗？</Text>
        <Select
          onChange={_ => (_ === 'yes' ? onDelete() : onCancel())}
          onCancel={onCancel}
          options={[
            { label: '是', value: 'yes' },
            { label: '否', value: 'no' },
          ]}
        />
      </Box>
      {footer}
    </>
  );
}

type RulesTabContentProps = {
  options: Option[];
  searchQuery: string;
  isSearchMode: boolean;
  isFocused: boolean;
  onSelect: (value: string) => void;
  onCancel: () => void;
  lastFocusedRuleKey: string | undefined;
  cursorOffset?: number;
  onHeaderFocusChange?: (focused: boolean) => void;
};

// Component for rendering rules tab content with full width support
function RulesTabContent(props: RulesTabContentProps): React.ReactNode {
  const {
    options,
    searchQuery,
    isSearchMode,
    isFocused,
    onSelect,
    onCancel,
    lastFocusedRuleKey,
    cursorOffset,
    onHeaderFocusChange,
  } = props;
  const tabWidth = useTabsWidth();
  const { headerFocused, focusHeader, blurHeader } = useTabHeaderFocus();
  useEffect(() => {
    if (isSearchMode && headerFocused) blurHeader();
  }, [isSearchMode, headerFocused, blurHeader]);
  useEffect(() => {
    onHeaderFocusChange?.(headerFocused);
  }, [headerFocused, onHeaderFocusChange]);
  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <SearchBox
          query={searchQuery}
          isFocused={isSearchMode && !headerFocused}
          isTerminalFocused={isFocused}
          width={tabWidth}
          cursorOffset={cursorOffset}
        />
      </Box>
      <Select
        options={options}
        onChange={onSelect}
        onCancel={onCancel}
        visibleOptionCount={Math.min(10, options.length)}
        isDisabled={isSearchMode || headerFocused}
        defaultFocusValue={lastFocusedRuleKey}
        onUpFromFirstItem={focusHeader}
      />
    </Box>
  );
}

// Composes the subtitle + search + Select for a single allow/ask/deny tab.
function PermissionRulesTab({
  tab,
  getRulesOptions,
  handleToolSelect,
  ...rulesProps
}: {
  tab: 'allow' | 'ask' | 'deny';
  getRulesOptions: (tab: TabType, query?: string) => { options: Option[] };
  handleToolSelect: (value: string, tab: TabType) => void;
} & Omit<RulesTabContentProps, 'options' | 'onSelect'>): React.ReactNode {
  return (
    <Box flexDirection="column" flexShrink={tab === 'allow' ? 0 : undefined}>
      <Text>
        {
          {
            allow: 'Claude Code 使用已允许的工具时不会询问。',
            ask: 'Claude Code 使用这些工具前始终会请求确认。',
            deny: 'Claude Code 始终会拒绝使用已拒绝工具的请求。',
          }[tab]
        }
      </Text>
      <RulesTabContent
        options={getRulesOptions(tab, rulesProps.searchQuery).options}
        onSelect={v => handleToolSelect(v, tab)}
        {...rulesProps}
      />
    </Box>
  );
}

type Props = {
  onExit: (
    result?: string,
    options?: {
      display?: CommandResultDisplay;
      shouldQuery?: boolean;
      metaMessages?: string[];
    },
  ) => void;
  initialTab?: TabType;
  onRetryDenials?: (commands: string[]) => void;
};

export function PermissionRuleList({ onExit, initialTab, onRetryDenials }: Props): React.ReactNode {
  const hasDenials = getAutoModeDenials().length > 0;
  const defaultTab: TabType = initialTab ?? (hasDenials ? 'recent' : 'allow');
  const [changes, setChanges] = useState<string[]>([]);
  const toolPermissionContext = useAppState(s => s.toolPermissionContext);
  const setAppState = useSetAppState();
  const isTerminalFocused = useTerminalFocus();

  // Ref not state: RecentDenialsTab updates don't need to trigger parent
  // re-render (only read on exit), and re-renders trip the modal ScrollBox
  // collapse bug from #23592 in fullscreen.
  const denialStateRef = useRef<{
    approved: Set<number>;
    retry: Set<number>;
    denials: readonly AutoModeDenial[];
  }>({ approved: new Set(), retry: new Set(), denials: [] });
  const handleDenialStateChange = useCallback((s: typeof denialStateRef.current) => {
    denialStateRef.current = s;
  }, []);

  const [selectedRule, setSelectedRule] = useState<PermissionRule | undefined>();
  // Track the key of the last focused rule to restore position after deletion
  const [lastFocusedRuleKey, setLastFocusedRuleKey] = useState<string | undefined>();
  const [addingRuleToTab, setAddingRuleToTab] = useState<TabType | null>(null);
  const [validatedRule, setValidatedRule] = useState<{
    ruleBehavior: PermissionBehavior;
    ruleValue: PermissionRuleValue;
  } | null>(null);
  const [isAddingWorkspaceDirectory, setIsAddingWorkspaceDirectory] = useState(false);
  const [removingDirectory, setRemovingDirectory] = useState<string | null>(null);
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [headerFocused, setHeaderFocused] = useState(true);
  const handleHeaderFocusChange = useCallback((focused: boolean) => {
    setHeaderFocused(focused);
  }, []);

  const allowRulesByKey = useMemo(() => {
    const map = new Map<string, PermissionRule>();
    getAllowRules(toolPermissionContext).forEach(rule => {
      map.set(jsonStringify(rule), rule);
    });
    return map;
  }, [toolPermissionContext]);

  const denyRulesByKey = useMemo(() => {
    const map = new Map<string, PermissionRule>();
    getDenyRules(toolPermissionContext).forEach(rule => {
      map.set(jsonStringify(rule), rule);
    });
    return map;
  }, [toolPermissionContext]);

  const askRulesByKey = useMemo(() => {
    const map = new Map<string, PermissionRule>();
    getAskRules(toolPermissionContext).forEach(rule => {
      map.set(jsonStringify(rule), rule);
    });
    return map;
  }, [toolPermissionContext]);

  const getRulesOptions = useCallback(
    (tab: TabType, query: string = '') => {
      const rulesByKey = (() => {
        switch (tab) {
          case 'allow':
            return allowRulesByKey;
          case 'deny':
            return denyRulesByKey;
          case 'ask':
            return askRulesByKey;
          case 'workspace':
          case 'recent':
            return new Map<string, PermissionRule>();
        }
      })();

      const options: Option[] = [];

      // Only show "Add a new rule" for allow and deny tabs (and not when searching)
      if (tab !== 'workspace' && tab !== 'recent' && !query) {
        options.push({
          label: `添加新规则${figures.ellipsis}`,
          value: 'add-new-rule',
        });
      }

      // Get all rule keys and sort them alphabetically based on rule's formatted value
      const sortedRuleKeys = Array.from(rulesByKey.keys()).sort((a, b) => {
        const ruleA = rulesByKey.get(a);
        const ruleB = rulesByKey.get(b);
        if (ruleA && ruleB) {
          const ruleAString = permissionRuleValueToString(ruleA.ruleValue).toLowerCase();
          const ruleBString = permissionRuleValueToString(ruleB.ruleValue).toLowerCase();
          return ruleAString.localeCompare(ruleBString);
        }
        return 0;
      });

      // Build options from sorted keys, filtering by search query
      const lowerQuery = query.toLowerCase();
      for (const ruleKey of sortedRuleKeys) {
        const rule = rulesByKey.get(ruleKey);
        if (rule) {
          const ruleString = permissionRuleValueToString(rule.ruleValue);
          // Filter by search query if provided
          if (query && !ruleString.toLowerCase().includes(lowerQuery)) {
            continue;
          }
          options.push({
            label: ruleString,
            value: ruleKey,
          });
        }
      }

      return { options, rulesByKey };
    },
    [allowRulesByKey, denyRulesByKey, askRulesByKey],
  );

  const exitState = useExitOnCtrlCDWithKeybindings();

  const isSearchModeActive =
    !selectedRule && !addingRuleToTab && !validatedRule && !isAddingWorkspaceDirectory && !removingDirectory;

  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    cursorOffset: searchCursorOffset,
  } = useSearchInput({
    isActive: isSearchModeActive && isSearchMode,
    onExit: () => {
      setIsSearchMode(false);
    },
  });

  // Handle entering search mode
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isSearchModeActive) return;
      if (isSearchMode) return;
      if (e.ctrl || e.meta) return;

      // Enter search mode with '/' or any printable character.
      // e.key.length === 1 filters out special keys (down, return, escape,
      // etc.) — previously the raw escape sequence leaked through and
      // triggered search mode with garbage on arrow-key press.
      if (e.key === '/') {
        e.preventDefault();
        setIsSearchMode(true);
        setSearchQuery('');
      } else if (
        e.key.length === 1 &&
        // Don't enter search mode for vim-nav / space / retry key
        e.key !== 'j' &&
        e.key !== 'k' &&
        e.key !== 'm' &&
        e.key !== 'i' &&
        e.key !== 'r' &&
        e.key !== ' '
      ) {
        e.preventDefault();
        setIsSearchMode(true);
        setSearchQuery(e.key);
      }
    },
    [isSearchModeActive, isSearchMode, setSearchQuery],
  );

  const handleToolSelect = useCallback(
    (selectedValue: string, tab: TabType) => {
      const { rulesByKey } = getRulesOptions(tab);
      if (selectedValue === 'add-new-rule') {
        setAddingRuleToTab(tab);
        return;
      } else {
        setSelectedRule(rulesByKey.get(selectedValue));
        return;
      }
    },
    [getRulesOptions],
  );

  const handleRuleInputCancel = useCallback(() => {
    setAddingRuleToTab(null);
  }, []);

  const handleRuleInputSubmit = useCallback((ruleValue: PermissionRuleValue, ruleBehavior: PermissionBehavior) => {
    setValidatedRule({ ruleValue, ruleBehavior });
    setAddingRuleToTab(null);
  }, []);

  const handleAddRulesSuccess = useCallback((rules: PermissionRule[], unreachable?: UnreachableRule[]) => {
    setValidatedRule(null);
    for (const rule of rules) {
      setChanges(prev => [
        ...prev,
        `已添加 ${rule.ruleBehavior} 规则 ${chalk.bold(permissionRuleValueToString(rule.ruleValue))}`,
      ]);
    }

    // Show warnings for any unreachable rules we just added
    if (unreachable && unreachable.length > 0) {
      for (const u of unreachable) {
        const severity = u.shadowType === 'deny' ? 'blocked' : 'shadowed';
        setChanges(prev => [
          ...prev,
          chalk.yellow(`${figures.warning} 警告：${permissionRuleValueToString(u.rule.ruleValue)} 已${severity}`),
          chalk.dim(`  ${u.reason}`),
          chalk.dim(`  修复：${u.fix}`),
        ]);
      }
    }
  }, []);

  const handleAddRuleCancel = useCallback(() => {
    setValidatedRule(null);
  }, []);

  const handleRequestAddDirectory = useCallback(() => setIsAddingWorkspaceDirectory(true), []);
  const handleRequestRemoveDirectory = useCallback((path: string) => setRemovingDirectory(path), []);
  const handleRulesCancel = useCallback(() => {
    const s = denialStateRef.current;
    const denialsFor = (set: Set<number>) =>
      Array.from(set)
        .map(idx => s.denials[idx])
        .filter((d): d is AutoModeDenial => d !== undefined);

    const retryDenials = denialsFor(s.retry);
    if (retryDenials.length > 0) {
      const commands = retryDenials.map(d => d.display);
      onRetryDenials?.(commands);
      onExit(undefined, {
        shouldQuery: true,
        metaMessages: [
          `已授权：${commands.join(', ')}。如需重试，可重新执行 ${commands.length === 1 ? '该命令' : '这些命令'}。`,
        ],
      });
      return;
    }

    const approvedDenials = denialsFor(s.approved);
    if (approvedDenials.length > 0 || changes.length > 0) {
      const approvedMsg =
        approvedDenials.length > 0 ? [`Approved ${approvedDenials.map(d => chalk.bold(d.display)).join(', ')}`] : [];
      onExit([...approvedMsg, ...changes].join('\n'));
    } else {
      onExit('Permissions dialog dismissed', {
        display: 'system',
      });
    }
  }, [changes, onExit, onRetryDenials]);

  // Handle Escape at the top level so it works even when header is focused
  // (which disables the Select component and its select:cancel keybinding).
  // Mirrors the pattern in Settings.tsx.
  useKeybinding('confirm:no', handleRulesCancel, {
    context: 'Settings',
    isActive: isSearchModeActive && !isSearchMode,
  });

  const handleDeleteRule = () => {
    if (!selectedRule) return;

    // Find the adjacent rule to focus on after deletion
    const { options } = getRulesOptions(selectedRule.ruleBehavior as TabType);
    const selectedKey = jsonStringify(selectedRule);
    const ruleKeys = options.filter(opt => opt.value !== 'add-new-rule').map(opt => opt.value);
    const currentIndex = ruleKeys.indexOf(selectedKey);

    // Try to focus on the next rule, or the previous if deleting the last one
    let nextFocusKey: string | undefined;
    if (currentIndex !== -1) {
      if (currentIndex < ruleKeys.length - 1) {
        // Focus on the next rule
        nextFocusKey = ruleKeys[currentIndex + 1];
      } else if (currentIndex > 0) {
        // Focus on the previous rule (we're deleting the last one)
        nextFocusKey = ruleKeys[currentIndex - 1];
      }
    }
    setLastFocusedRuleKey(nextFocusKey);

    void deletePermissionRule({
      rule: selectedRule,
      initialContext: toolPermissionContext,
      setToolPermissionContext(toolPermissionContext) {
        setAppState(prev => ({
          ...prev,
          toolPermissionContext,
        }));
      },
    });

    setChanges(prev => [
      ...prev,
      `已删除 ${selectedRule.ruleBehavior} 规则 ${chalk.bold(permissionRuleValueToString(selectedRule.ruleValue))}`,
    ]);
    setSelectedRule(undefined);
  };

  if (selectedRule) {
    return <RuleDetails rule={selectedRule} onDelete={handleDeleteRule} onCancel={() => setSelectedRule(undefined)} />;
  }

  if (addingRuleToTab && addingRuleToTab !== 'workspace' && addingRuleToTab !== 'recent') {
    return (
      <PermissionRuleInput
        onCancel={handleRuleInputCancel}
        onSubmit={handleRuleInputSubmit}
        ruleBehavior={addingRuleToTab}
      />
    );
  }

  if (validatedRule) {
    return (
      <AddPermissionRules
        onAddRules={handleAddRulesSuccess}
        onCancel={handleAddRuleCancel}
        ruleValues={[validatedRule.ruleValue]}
        ruleBehavior={validatedRule.ruleBehavior}
        initialContext={toolPermissionContext}
        setToolPermissionContext={toolPermissionContext => {
          setAppState(prev => ({
            ...prev,
            toolPermissionContext,
          }));
        }}
      />
    );
  }

  if (isAddingWorkspaceDirectory) {
    return (
      <AddWorkspaceDirectory
        onAddDirectory={(path, remember) => {
          // Apply the permission update to add the directory
          const destination: PermissionUpdateDestination = remember ? 'localSettings' : 'session';

          const permissionUpdate = {
            type: 'addDirectories' as const,
            directories: [path],
            destination,
          };

          const updatedContext = applyPermissionUpdate(toolPermissionContext, permissionUpdate);
          setAppState(prev => ({
            ...prev,
            toolPermissionContext: updatedContext,
          }));

          // Persist if remember is true
          if (remember) {
            persistPermissionUpdate(permissionUpdate);
          }

          setChanges(prev => [
            ...prev,
            `已将目录 ${chalk.bold(path)} 添加到工作区${remember ? '，并保存到本地设置' : '（仅本次会话）'}`,
          ]);
          setIsAddingWorkspaceDirectory(false);
        }}
        onCancel={() => setIsAddingWorkspaceDirectory(false)}
        permissionContext={toolPermissionContext}
      />
    );
  }

  if (removingDirectory) {
    return (
      <RemoveWorkspaceDirectory
        directoryPath={removingDirectory}
        onRemove={() => {
          setChanges(prev => [...prev, `已从工作区移除目录 ${chalk.bold(removingDirectory)}`]);
          setRemovingDirectory(null);
        }}
        onCancel={() => setRemovingDirectory(null)}
        permissionContext={toolPermissionContext}
        setPermissionContext={toolPermissionContext => {
          setAppState(prev => ({
            ...prev,
            toolPermissionContext,
          }));
        }}
      />
    );
  }

  const sharedRulesProps = {
    searchQuery,
    isSearchMode,
    isFocused: isTerminalFocused,
    onCancel: handleRulesCancel,
    lastFocusedRuleKey,
    cursorOffset: searchCursorOffset,
    getRulesOptions,
    handleToolSelect,
    onHeaderFocusChange: handleHeaderFocusChange,
  };

  const isHidden =
    !!selectedRule || !!addingRuleToTab || !!validatedRule || isAddingWorkspaceDirectory || !!removingDirectory;

  return (
    <Box flexDirection="column" onKeyDown={handleKeyDown}>
      <Pane color="permission">
        <Tabs
          title="权限设置："
          color="permission"
          defaultTab={defaultTab}
          hidden={isHidden}
          initialHeaderFocused={!hasDenials}
          navFromContent={!isSearchMode}
        >
          <Tab id="recent" title="最近拒绝">
            <RecentDenialsTab onHeaderFocusChange={handleHeaderFocusChange} onStateChange={handleDenialStateChange} />
          </Tab>
          <Tab id="allow" title="允许">
            <PermissionRulesTab tab="allow" {...sharedRulesProps} />
          </Tab>
          <Tab id="ask" title="询问">
            <PermissionRulesTab tab="ask" {...sharedRulesProps} />
          </Tab>
          <Tab id="deny" title="拒绝">
            <PermissionRulesTab tab="deny" {...sharedRulesProps} />
          </Tab>
          <Tab id="workspace" title="工作区">
            <Box flexDirection="column">
              <Text>Claude Code 可以读取工作区中的文件，并在启用自动接受编辑时进行修改。</Text>
              <WorkspaceTab
                onExit={onExit}
                toolPermissionContext={toolPermissionContext}
                onRequestAddDirectory={handleRequestAddDirectory}
                onRequestRemoveDirectory={handleRequestRemoveDirectory}
                onHeaderFocusChange={handleHeaderFocusChange}
              />
            </Box>
          </Tab>
        </Tabs>
        <Box marginTop={1} paddingLeft={1}>
          <Text dimColor>
            {exitState.pending ? (
              <>再次按 {exitState.keyName} 退出</>
            ) : headerFocused ? (
              <>←/→ 切换标签页 · ↓ 进入 · Esc 取消</>
            ) : isSearchMode ? (
              <>输入筛选 · Enter/↓ 选择 · ↑ 标签页 · Esc 清除</>
            ) : hasDenials && defaultTab === 'recent' ? (
              <>Enter 批准 · r 重试 · ↑↓ 导航 · ←/→ 切换 · Esc 取消</>
            ) : (
              <>↑↓ 导航 · Enter 选择 · 输入搜索 · ←/→ 切换 · Esc 取消</>
            )}
          </Text>
        </Box>
      </Pane>
    </Box>
  );
}
