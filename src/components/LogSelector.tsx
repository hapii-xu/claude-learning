import chalk from 'chalk';
import figures from 'figures';
import Fuse from 'fuse.js';
import React from 'react';
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js';
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js';
import { useSearchInput } from '../hooks/useSearchInput.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import {
  applyColor,
  Box,
  Text,
  useInput,
  useTerminalFocus,
  useTheme,
  type Color,
  Byline,
  Divider,
  KeyboardShortcutHint,
} from '@anthropic/ink';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { logEvent } from '../services/analytics/index.js';
import type { LogOption, SerializedMessage } from '../types/logs.js';
import { formatLogMetadata, truncateToWidth } from '../utils/format.js';
import { getWorktreePaths } from '../utils/getWorktreePaths.js';
import { getBranch } from '../utils/git.js';
import { getLogDisplayTitle } from '../utils/log.js';
import {
  getFirstMeaningfulUserMessageTextContent,
  getSessionIdFromLog,
  isCustomTitleEnabled,
  saveCustomTitle,
} from '../utils/sessionStorage.js';
import { getTheme } from '../utils/theme.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Select } from './CustomSelect/select.js';
import { SearchBox } from './SearchBox.js';
import { SessionPreview } from './SessionPreview.js';
import { Spinner } from './Spinner.js';
import { TagTabs } from './TagTabs.js';
import TextInput from './TextInput.js';
import { type TreeNode, TreeSelect } from './ui/TreeSelect.js';

type AgenticSearchState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'results'; results: LogOption[]; query: string }
  | { status: 'error'; message: string };

export type LogSelectorProps = {
  logs: LogOption[];
  maxHeight?: number;
  forceWidth?: number;
  onCancel?: () => void;
  onSelect: (log: LogOption) => void;
  onLogsChanged?: () => void;
  onLoadMore?: (count: number) => void;
  initialSearchQuery?: string;
  showAllProjects?: boolean;
  onToggleAllProjects?: () => void;
  onAgenticSearch?: (query: string, logs: LogOption[], signal?: AbortSignal) => Promise<LogOption[]>;
};

type LogTreeNode = TreeNode<{ log: LogOption; indexInFiltered: number }>;

function normalizeAndTruncateToWidth(text: string, maxWidth: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return truncateToWidth(normalized, maxWidth);
}

// TreeSelect 会添加的前缀宽度
const PARENT_PREFIX_WIDTH = 2; // '▼ ' 或 '▶ '
const CHILD_PREFIX_WIDTH = 4; // '  ▸ '

// 深度搜索常量
const DEEP_SEARCH_MAX_MESSAGES = 2000;
const DEEP_SEARCH_CROP_SIZE = 1000;
const DEEP_SEARCH_MAX_TEXT_LENGTH = 50000; // 每个 session 可搜索文本的上限
const FUSE_THRESHOLD = 0.3;
const DATE_TIE_THRESHOLD_MS = 60 * 1000; // 1 分钟 —— 在此窗口内使用相关性作为排序兜底
const SNIPPET_CONTEXT_CHARS = 50; // 匹配项前后展示的字符数

type Snippet = { before: string; match: string; after: string };

function formatSnippet({ before, match, after }: Snippet, highlightColor: (text: string) => string): string {
  return chalk.dim(before) + highlightColor(match) + chalk.dim(after);
}

function extractSnippet(text: string, query: string, contextChars: number): Snippet | null {
  // 查找 query 的精确出现位置（大小写不敏感）。
  // 注意：Fuse 执行的是模糊匹配，因此可能漏掉部分模糊匹配结果。
  // 目前可以接受 —— 未来可使用 Fuse 的 includeMatches 选项，
  // 直接基于匹配索引进行处理。
  const matchIndex = text.toLowerCase().indexOf(query.toLowerCase());
  if (matchIndex === -1) return null;

  const matchEnd = matchIndex + query.length;
  const snippetStart = Math.max(0, matchIndex - contextChars);
  const snippetEnd = Math.min(text.length, matchEnd + contextChars);

  const beforeRaw = text.slice(snippetStart, matchIndex);
  const matchText = text.slice(matchIndex, matchEnd);
  const afterRaw = text.slice(matchEnd, snippetEnd);

  return {
    before: (snippetStart > 0 ? '…' : '') + beforeRaw.replace(/\s+/g, ' ').trimStart(),
    match: matchText.trim(),
    after: afterRaw.replace(/\s+/g, ' ').trimEnd() + (snippetEnd < text.length ? '…' : ''),
  };
}

function buildLogLabel(
  log: LogOption,
  maxLabelWidth: number,
  options?: {
    isGroupHeader?: boolean;
    isChild?: boolean;
    forkCount?: number;
  },
): string {
  const { isGroupHeader = false, isChild = false, forkCount = 0 } = options || {};

  // TreeSelect 会添加前缀，这里只需计算其宽度
  const prefixWidth = isGroupHeader && forkCount > 0 ? PARENT_PREFIX_WIDTH : isChild ? CHILD_PREFIX_WIDTH : 0;

  const sessionCountSuffix = isGroupHeader && forkCount > 0 ? `（+${forkCount} 个其他 session）` : '';

  const sidechainSuffix = log.isSidechain ? '（sidechain）' : '';

  const maxSummaryWidth = maxLabelWidth - prefixWidth - sidechainSuffix.length - sessionCountSuffix.length;
  const truncatedSummary = normalizeAndTruncateToWidth(getLogDisplayTitle(log), maxSummaryWidth);
  return `${truncatedSummary}${sidechainSuffix}${sessionCountSuffix}`;
}

function buildLogMetadata(log: LogOption, options?: { isChild?: boolean; showProjectPath?: boolean }): string {
  const { isChild = false, showProjectPath = false } = options || {};
  // 对齐子项前缀宽度
  const childPadding = isChild ? '    ' : ''; // 4 个空格，对应 '  ▸ '
  const baseMetadata = formatLogMetadata(log);
  const projectSuffix = showProjectPath && log.projectPath ? ` · ${log.projectPath}` : '';
  return childPadding + baseMetadata + projectSuffix;
}

export function LogSelector({
  logs,
  maxHeight = Infinity,
  forceWidth,
  onCancel,
  onSelect,
  onLogsChanged,
  onLoadMore,
  initialSearchQuery,
  showAllProjects = false,
  onToggleAllProjects,
  onAgenticSearch,
}: LogSelectorProps): React.ReactNode {
  const terminalSize = useTerminalSize();
  const columns = forceWidth === undefined ? terminalSize.columns : forceWidth;
  const exitState = useExitOnCtrlCDWithKeybindings(onCancel);
  const isTerminalFocused = useTerminalFocus();
  const isResumeWithRenameEnabled = isCustomTitleEnabled();
  const isDeepSearchEnabled = process.env.USER_TYPE === 'ant';
  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  const highlightColor = React.useMemo(
    () => (text: string) => applyColor(text, theme.warning as Color),
    [theme.warning],
  );
  const isAgenticSearchEnabled = process.env.USER_TYPE === 'ant';

  const [currentBranch, setCurrentBranch] = React.useState<string | null>(null);
  const [branchFilterEnabled, setBranchFilterEnabled] = React.useState(false);
  const [showAllWorktrees, setShowAllWorktrees] = React.useState(false);
  const [hasMultipleWorktrees, setHasMultipleWorktrees] = React.useState(false);
  const currentCwd = React.useMemo(() => getOriginalCwd(), []);
  const [renameValue, setRenameValue] = React.useState('');
  const [renameCursorOffset, setRenameCursorOffset] = React.useState(0);
  const [expandedGroupSessionIds, setExpandedGroupSessionIds] = React.useState<Set<string>>(new Set());
  const [focusedNode, setFocusedNode] = React.useState<LogTreeNode | null>(null);
  // 记录聚焦索引，用于标题中的滚动位置展示
  const [focusedIndex, setFocusedIndex] = React.useState(1);
  const [viewMode, setViewMode] = React.useState<'list' | 'preview' | 'rename' | 'search'>('list');
  const [previewLog, setPreviewLog] = React.useState<LogOption | null>(null);
  const prevFocusedIdRef = React.useRef<string | null>(null);
  const [selectedTagIndex, setSelectedTagIndex] = React.useState(0);

  // Agentic 搜索状态
  const [agenticSearchState, setAgenticSearchState] = React.useState<AgenticSearchState>({ status: 'idle' });
  // 记录「使用 Claude 深度搜索」选项是否处于聚焦状态
  const [isAgenticSearchOptionFocused, setIsAgenticSearchOptionFocused] = React.useState(false);
  // 用于取消 agentic 搜索的 AbortController
  const agenticSearchAbortRef = React.useRef<AbortController | null>(null);

  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    cursorOffset: searchCursorOffset,
  } = useSearchInput({
    isActive: viewMode === 'search' && agenticSearchState.status !== 'searching',
    onExit: () => {
      setViewMode('list');
      logEvent('tengu_session_search_toggled', { enabled: false });
    },
    onExitUp: () => {
      setViewMode('list');
      logEvent('tengu_session_search_toggled', { enabled: false });
    },
    passthroughCtrlKeys: ['n'],
    initialQuery: initialSearchQuery || '',
  });

  // 对 transcript 搜索做防抖以提升性能（标题搜索为即时）
  const deferredSearchQuery = React.useDeferredValue(searchQuery);

  // 深度搜索的额外防抖 —— 停止输入后等待 300ms
  const [debouncedDeepSearchQuery, setDebouncedDeepSearchQuery] = React.useState('');
  React.useEffect(() => {
    if (!deferredSearchQuery) {
      setDebouncedDeepSearchQuery('');
      return;
    }
    const timeoutId = setTimeout(setDebouncedDeepSearchQuery, 300, deferredSearchQuery);
    return () => clearTimeout(timeoutId);
  }, [deferredSearchQuery]);

  // 异步深度搜索结果状态
  const [deepSearchResults, setDeepSearchResults] = React.useState<{
    results: Array<{ log: LogOption; score?: number; searchableText: string }>;
    query: string;
  } | null>(null);
  const [isSearching, setIsSearching] = React.useState(false);

  React.useEffect(() => {
    void getBranch().then(branch => setCurrentBranch(branch));
    void getWorktreePaths(currentCwd).then(paths => {
      setHasMultipleWorktrees(paths.length > 1);
    });
  }, [currentCwd]);

  // 缓存可搜索文本提取 —— 仅在 logs 变化时重新计算
  const searchableTextByLog = React.useMemo(() => new Map(logs.map(log => [log, buildSearchableText(log)])), [logs]);

  // logs 变化时一次性预构建 Fuse 索引（而非每次搜索时重建）
  const fuseIndex = React.useMemo(() => {
    if (!isDeepSearchEnabled) return null;

    const logsWithText = logs
      .map(log => ({
        log,
        searchableText: searchableTextByLog.get(log) ?? '',
      }))
      .filter(item => item.searchableText);

    return new Fuse(logsWithText, {
      keys: ['searchableText'],
      threshold: FUSE_THRESHOLD,
      ignoreLocation: true,
      includeScore: true,
    });
  }, [logs, searchableTextByLog, isDeepSearchEnabled]);

  // 从 logs 计算唯一 tag（在任何过滤之前）
  const uniqueTags = React.useMemo(() => getUniqueTags(logs), [logs]);
  const hasTags = uniqueTags.length > 0;
  const tagTabs = React.useMemo(() => (hasTags ? ['All', ...uniqueTags] : []), [hasTags, uniqueTags]);

  // 限制越界索引（例如 logs 变化后），避免额外渲染
  const effectiveTagIndex = tagTabs.length > 0 && selectedTagIndex < tagTabs.length ? selectedTagIndex : 0;
  const selectedTab = tagTabs[effectiveTagIndex];
  const tagFilter = selectedTab === 'All' ? undefined : selectedTab;

  // Tag 标签栏现为单行，支持横向滚动
  const tagTabsLines = hasTags ? 1 : 0;

  // 基础过滤（即时）—— 应用 tag、branch 和 resume 过滤器
  const baseFilteredLogs = React.useMemo(() => {
    let filtered = logs;
    if (isResumeWithRenameEnabled) {
      filtered = logs.filter(log => {
        const currentSessionId = getSessionId();
        const logSessionId = getSessionIdFromLog(log);
        const isCurrentSession = currentSessionId && logSessionId === currentSessionId;
        // 始终展示当前 session
        if (isCurrentSession) {
          return true;
        }
        // 始终展示带自定义标题的 session（例如 loop 模式的 session）
        if (log.customTitle) {
          return true;
        }
        // 完整 log 则检查 messages 数组
        const fromMessages = getFirstMeaningfulUserMessageTextContent(log.messages);
        if (fromMessages) {
          return true;
        }
        // 到达此组件的所有 log 都是 enriched —— 有 prompt 或自定义标题则保留
        if (log.firstPrompt || log.customTitle) {
          return true;
        }
        return false;
      });
    }

    // 如指定了 tag 过滤器则应用
    if (tagFilter !== undefined) {
      filtered = filtered.filter(log => log.tag === tagFilter);
    }

    if (branchFilterEnabled && currentBranch) {
      filtered = filtered.filter(log => log.gitBranch === currentBranch);
    }

    if (hasMultipleWorktrees && !showAllWorktrees) {
      filtered = filtered.filter(log => log.projectPath === currentCwd);
    }

    return filtered;
  }, [
    logs,
    isResumeWithRenameEnabled,
    tagFilter,
    branchFilterEnabled,
    currentBranch,
    hasMultipleWorktrees,
    showAllWorktrees,
    currentCwd,
  ]);

  // 即时标题/branch/tag/PR 过滤（每次按键都执行，但速度很快）
  const titleFilteredLogs = React.useMemo(() => {
    if (!searchQuery) {
      return baseFilteredLogs;
    }
    const query = searchQuery.toLowerCase();
    return baseFilteredLogs.filter(log => {
      const displayedTitle = getLogDisplayTitle(log).toLowerCase();
      const branch = (log.gitBranch || '').toLowerCase();
      const tag = (log.tag || '').toLowerCase();
      const prInfo = log.prNumber ? `pr #${log.prNumber} ${log.prRepository || ''}`.toLowerCase() : '';
      return displayedTitle.includes(query) || branch.includes(query) || tag.includes(query) || prInfo.includes(query);
    });
  }, [baseFilteredLogs, searchQuery]);

  // 当 query 处于防抖等待时显示搜索中指示器
  React.useEffect(() => {
    if (isDeepSearchEnabled && deferredSearchQuery && deferredSearchQuery !== debouncedDeepSearchQuery) {
      setIsSearching(true);
    }
  }, [deferredSearchQuery, debouncedDeepSearchQuery, isDeepSearchEnabled]);

  // 异步深度搜索 effect —— 300ms 防抖后执行
  React.useEffect(() => {
    if (!isDeepSearchEnabled || !debouncedDeepSearchQuery || !fuseIndex) {
      setDeepSearchResults(null);
      setIsSearching(false);
      return;
    }

    // 使用 setTimeout(0) 让出事件循环 —— 避免界面卡顿
    const timeoutId = setTimeout(
      (fuseIndex, debouncedDeepSearchQuery, setDeepSearchResults, setIsSearching) => {
        const results = fuseIndex.search(debouncedDeepSearchQuery);

        // 按日期排序（最新优先），同一分钟内用相关性作为兜底
        results.sort((a, b) => {
          const aTime = new Date(a.item.log.modified).getTime();
          const bTime = new Date(b.item.log.modified).getTime();
          const timeDiff = bTime - aTime;
          if (Math.abs(timeDiff) > DATE_TIE_THRESHOLD_MS) {
            return timeDiff;
          }
          // 同一分钟窗口内使用相关性评分（越小越好）
          return (a.score ?? 1) - (b.score ?? 1);
        });

        setDeepSearchResults({
          results: results.map(r => ({
            log: r.item.log,
            score: r.score,
            searchableText: r.item.searchableText,
          })),
          query: debouncedDeepSearchQuery,
        });
        setIsSearching(false);
      },
      0,
      fuseIndex,
      debouncedDeepSearchQuery,
      setDeepSearchResults,
      setIsSearching,
    );

    return () => {
      clearTimeout(timeoutId);
    };
  }, [debouncedDeepSearchQuery, fuseIndex, isDeepSearchEnabled]);

  // 合并标题匹配结果与异步深度搜索结果
  const { filteredLogs, snippets } = React.useMemo(() => {
    const snippetMap = new Map<LogOption, Snippet>();

    // 以即时标题匹配结果作为起始
    let filtered = titleFilteredLogs;

    // 若深度搜索结果可用且 query 匹配则合并进来
    if (deepSearchResults && debouncedDeepSearchQuery && deepSearchResults.query === debouncedDeepSearchQuery) {
      // 从深度搜索结果中提取 snippet
      for (const result of deepSearchResults.results) {
        if (result.searchableText) {
          const snippet = extractSnippet(result.searchableText, debouncedDeepSearchQuery, SNIPPET_CONTEXT_CHARS);
          if (snippet) {
            snippetMap.set(result.log, snippet);
          }
        }
      }

      // 补充仅 transcript 匹配的结果（即未出现在标题匹配中的结果）
      const titleMatchIds = new Set(filtered.map(log => log.messages[0]?.uuid));
      const transcriptOnlyMatches = deepSearchResults.results
        .map(r => r.log)
        .filter(log => !titleMatchIds.has(log.messages[0]?.uuid));
      filtered = [...filtered, ...transcriptOnlyMatches];
    }

    return { filteredLogs: filtered, snippets: snippetMap };
  }, [titleFilteredLogs, deepSearchResults, debouncedDeepSearchQuery]);

  // 当 agentic 搜索结果可用且非空时使用之，否则使用常规过滤后的 logs
  const displayedLogs = React.useMemo(() => {
    if (agenticSearchState.status === 'results' && agenticSearchState.results.length > 0) {
      return agenticSearchState.results;
    }
    return filteredLogs;
  }, [agenticSearchState, filteredLogs]);

  // 计算摘要文本的可用宽度
  const maxLabelWidth = Math.max(30, columns - 4);

  // 构建分组视图的树节点
  const treeNodes = React.useMemo<LogTreeNode[]>(() => {
    if (!isResumeWithRenameEnabled) {
      return [];
    }

    const sessionGroups = groupLogsBySessionId(displayedLogs);

    return Array.from(sessionGroups.entries()).map(([sessionId, groupLogs]): LogTreeNode => {
      const latestLog = groupLogs[0]!;
      const indexInFiltered = displayedLogs.indexOf(latestLog);
      const snippet = snippets.get(latestLog);
      const snippetStr = snippet ? formatSnippet(snippet, highlightColor) : null;

      if (groupLogs.length === 1) {
        // 单条 log —— 无子项
        const metadata = buildLogMetadata(latestLog, {
          showProjectPath: showAllProjects,
        });
        return {
          id: `log:${sessionId}:0`,
          value: { log: latestLog, indexInFiltered },
          label: buildLogLabel(latestLog, maxLabelWidth),
          description: snippetStr ? `${metadata}\n  ${snippetStr}` : metadata,
          dimDescription: true,
        };
      }

      // 多条 log —— 父项带子项
      const forkCount = groupLogs.length - 1;
      const children: LogTreeNode[] = groupLogs.slice(1).map((log, index) => {
        const childIndexInFiltered = displayedLogs.indexOf(log);
        const childSnippet = snippets.get(log);
        const childSnippetStr = childSnippet ? formatSnippet(childSnippet, highlightColor) : null;
        const childMetadata = buildLogMetadata(log, {
          isChild: true,
          showProjectPath: showAllProjects,
        });
        return {
          id: `log:${sessionId}:${index + 1}`,
          value: { log, indexInFiltered: childIndexInFiltered },
          label: buildLogLabel(log, maxLabelWidth, { isChild: true }),
          description: childSnippetStr ? `${childMetadata}\n      ${childSnippetStr}` : childMetadata,
          dimDescription: true,
        };
      });

      const parentMetadata = buildLogMetadata(latestLog, {
        showProjectPath: showAllProjects,
      });
      return {
        id: `group:${sessionId}`,
        value: { log: latestLog, indexInFiltered },
        label: buildLogLabel(latestLog, maxLabelWidth, {
          isGroupHeader: true,
          forkCount,
        }),
        description: snippetStr ? `${parentMetadata}\n  ${snippetStr}` : parentMetadata,
        dimDescription: true,
        children,
      };
    });
  }, [isResumeWithRenameEnabled, displayedLogs, maxLabelWidth, showAllProjects, snippets, highlightColor]);

  // 构建旧版扁平列表视图的选项
  const flatOptions = React.useMemo(() => {
    if (isResumeWithRenameEnabled) {
      return [];
    }

    return displayedLogs.map((log, index) => {
      const rawSummary = getLogDisplayTitle(log);
      const summaryWithSidechain = rawSummary + (log.isSidechain ? '（sidechain）' : '');
      const summary = normalizeAndTruncateToWidth(summaryWithSidechain, maxLabelWidth);

      const baseDescription = formatLogMetadata(log);
      const projectSuffix = showAllProjects && log.projectPath ? ` · ${log.projectPath}` : '';
      const snippet = snippets.get(log);
      const snippetStr = snippet ? formatSnippet(snippet, highlightColor) : null;

      return {
        label: summary,
        description: snippetStr
          ? `${baseDescription}${projectSuffix}\n  ${snippetStr}`
          : baseDescription + projectSuffix,
        dimDescription: true,
        value: index.toString(),
      };
    });
  }, [isResumeWithRenameEnabled, displayedLogs, highlightColor, maxLabelWidth, showAllProjects, snippets]);

  // 从 focusedNode 推导当前聚焦的 log
  const focusedLog = focusedNode?.value.log ?? null;

  const getExpandCollapseHint = (): string => {
    if (!isResumeWithRenameEnabled || !focusedLog) return '';
    const sessionId = getSessionIdFromLog(focusedLog);
    if (!sessionId) return '';

    const sessionLogs = displayedLogs.filter(log => getSessionIdFromLog(log) === sessionId);
    const hasMultipleLogs = sessionLogs.length > 1;

    if (!hasMultipleLogs) return '';

    const isExpanded = expandedGroupSessionIds.has(sessionId);
    const isChildNode = sessionLogs.indexOf(focusedLog) > 0;

    if (isChildNode) {
      return '← 折叠';
    }

    return isExpanded ? '← 折叠' : '→ 展开';
  };

  const handleRenameSubmit = React.useCallback(async () => {
    const sessionId = focusedLog ? getSessionIdFromLog(focusedLog) : undefined;
    if (!focusedLog || !sessionId) {
      setViewMode('list');
      setRenameValue('');
      return;
    }

    if (renameValue.trim()) {
      // 为跨项目 session（不同 worktree）传入 fullPath
      await saveCustomTitle(sessionId, renameValue.trim(), focusedLog.fullPath);
      if (isResumeWithRenameEnabled && onLogsChanged) {
        onLogsChanged();
      }
    }
    setViewMode('list');
    setRenameValue('');
  }, [focusedLog, renameValue, onLogsChanged, isResumeWithRenameEnabled]);

  const exitSearchMode = React.useCallback(() => {
    setViewMode('list');
    logEvent('tengu_session_search_toggled', { enabled: false });
  }, []);

  const enterSearchMode = React.useCallback(() => {
    setViewMode('search');
    logEvent('tengu_session_search_toggled', { enabled: true });
  }, []);

  // 触发 agentic 搜索的处理函数
  const handleAgenticSearch = React.useCallback(async () => {
    if (!searchQuery.trim() || !onAgenticSearch || !isAgenticSearchEnabled) {
      return;
    }

    // 中止之前的搜索
    agenticSearchAbortRef.current?.abort();
    const abortController = new AbortController();
    agenticSearchAbortRef.current = abortController;

    setAgenticSearchState({ status: 'searching' });
    logEvent('tengu_agentic_search_started', {
      query_length: searchQuery.length,
    });

    try {
      const results = await onAgenticSearch(searchQuery, logs, abortController.signal);
      // 更新 state 前检查是否已被中止
      if (abortController.signal.aborted) {
        return;
      }
      setAgenticSearchState({ status: 'results', results, query: searchQuery });
      logEvent('tengu_agentic_search_completed', {
        query_length: searchQuery.length,
        results_count: results.length,
      });
    } catch (error) {
      // 已中止的请求不显示错误
      if (abortController.signal.aborted) {
        return;
      }
      setAgenticSearchState({
        status: 'error',
        message: error instanceof Error ? error.message : '搜索失败',
      });
      logEvent('tengu_agentic_search_error', {
        query_length: searchQuery.length,
      });
    }
  }, [searchQuery, onAgenticSearch, isAgenticSearchEnabled, logs]);

  // query 变化时清除 agentic 搜索结果/错误
  React.useEffect(() => {
    if (agenticSearchState.status !== 'idle' && agenticSearchState.status !== 'searching') {
      // 当 query 与产生结果/错误时的 query 不同时清除
      if (
        (agenticSearchState.status === 'results' && agenticSearchState.query !== searchQuery) ||
        agenticSearchState.status === 'error'
      ) {
        setAgenticSearchState({ status: 'idle' });
      }
    }
  }, [searchQuery, agenticSearchState]);

  // 清理：组件卸载时中止所有进行中的 agentic 搜索
  React.useEffect(() => {
    return () => {
      agenticSearchAbortRef.current?.abort();
    };
  }, []);

  // 当 agentic 搜索完成并返回结果时聚焦到第一项
  const prevAgenticStatusRef = React.useRef(agenticSearchState.status);
  React.useEffect(() => {
    const prevStatus = prevAgenticStatusRef.current;
    prevAgenticStatusRef.current = agenticSearchState.status;

    // 搜索刚完成时，聚焦到列表第一项
    if (prevStatus === 'searching' && agenticSearchState.status === 'results') {
      if (isResumeWithRenameEnabled && treeNodes.length > 0) {
        setFocusedNode(treeNodes[0]!);
      } else if (!isResumeWithRenameEnabled && displayedLogs.length > 0) {
        const firstLog = displayedLogs[0]!;
        setFocusedNode({
          id: '0',
          value: { log: firstLog, indexInFiltered: 0 },
          label: '',
        });
      }
    }
  }, [agenticSearchState.status, isResumeWithRenameEnabled, treeNodes, displayedLogs]);

  const handleFlatOptionsSelectFocus = React.useCallback(
    (value: string) => {
      const index = parseInt(value, 10);
      const log = displayedLogs[index];
      if (!log || prevFocusedIdRef.current === index.toString()) {
        return;
      }
      prevFocusedIdRef.current = index.toString();
      setFocusedNode({
        id: index.toString(),
        value: { log, indexInFiltered: index },
        label: '',
      });
      setFocusedIndex(index + 1);
    },
    [displayedLogs],
  );

  const handleTreeSelectFocus = React.useCallback(
    (node: LogTreeNode) => {
      setFocusedNode(node);
      // 更新聚焦索引，用于滚动位置展示
      const index = displayedLogs.findIndex(log => getSessionIdFromLog(log) === getSessionIdFromLog(node.value.log));
      if (index >= 0) {
        setFocusedIndex(index + 1);
      }
    },
    [displayedLogs],
  );

  // Escape 中止进行中的 agentic 搜索
  useKeybinding(
    'confirm:no',
    () => {
      agenticSearchAbortRef.current?.abort();
      setAgenticSearchState({ status: 'idle' });
      logEvent('tengu_agentic_search_cancelled', {});
    },
    {
      context: 'Confirmation',
      isActive: viewMode !== 'preview' && agenticSearchState.status === 'searching',
    },
  );

  // rename 模式下按 Escape —— 退出 rename 模式
  // 使用 Settings context，这样 'n' 键不会退出（允许在 rename 输入中输入 'n'）
  useKeybinding(
    'confirm:no',
    () => {
      setViewMode('list');
      setRenameValue('');
    },
    {
      context: 'Settings',
      isActive: viewMode === 'rename' && agenticSearchState.status !== 'searching',
    },
  );

  // 当 agentic 搜索选项聚焦时按 Escape —— 清除并取消
  useKeybinding(
    'confirm:no',
    () => {
      setSearchQuery('');
      setIsAgenticSearchOptionFocused(false);
      onCancel?.();
    },
    {
      context: 'Confirmation',
      isActive:
        viewMode !== 'preview' &&
        viewMode !== 'rename' &&
        viewMode !== 'search' &&
        isAgenticSearchOptionFocused &&
        agenticSearchState.status !== 'searching',
    },
  );

  // 处理非 Escape 的输入
  useInput(
    (input, key) => {
      if (viewMode === 'preview') {
        // preview 模式自行处理输入
        return;
      }

      // agentic 搜索的中止已通过 keybinding 处理
      if (agenticSearchState.status === 'searching') {
        return;
      }

      if (viewMode === 'rename') {
        // rename 模式的 Escape 已通过 keybinding 处理
        // 此分支仅处理 rename 模式下的非 Escape 输入（通过 TextInput）
      } else if (viewMode === 'search') {
        // 文本输入由 useSearchInput hook 处理
        if (input.toLowerCase() === 'n' && key.ctrl) {
          exitSearchMode();
        } else if (key.return || key.downArrow) {
          // 如适用，聚焦到 agentic 搜索选项
          if (
            searchQuery.trim() &&
            onAgenticSearch &&
            isAgenticSearchEnabled &&
            agenticSearchState.status !== 'results'
          ) {
            setIsAgenticSearchOptionFocused(true);
          }
        }
      } else {
        // 聚焦时处理 agentic 搜索选项（Escape 已通过 keybinding 处理）
        if (isAgenticSearchOptionFocused) {
          if (key.return) {
            // 触发 agentic 搜索
            void handleAgenticSearch();
            setIsAgenticSearchOptionFocused(false);
            return;
          } else if (key.downArrow) {
            // 将焦点移到 session 列表
            setIsAgenticSearchOptionFocused(false);
            return;
          } else if (key.upArrow) {
            // 返回搜索模式
            setViewMode('search');
            setIsAgenticSearchOptionFocused(false);
            return;
          }
        }

        // 处理 tag 标签的 Tab 循环
        if (hasTags && key.tab) {
          const offset = key.shift ? -1 : 1;
          setSelectedTagIndex(prev => {
            const current = prev < tagTabs.length ? prev : 0;
            const newIndex = (current + tagTabs.length + offset) % tagTabs.length;
            const newTab = tagTabs[newIndex];
            logEvent('tengu_session_tag_filter_changed', {
              is_all: newTab === 'All',
              tag_count: uniqueTags.length,
            });
            return newIndex;
          });
          return;
        }

        const keyIsNotCtrlOrMeta = !key.ctrl && !key.meta;
        const lowerInput = input.toLowerCase();
        // Ctrl+字母快捷键用于触发操作（把普通字母键释放给「输入即搜索」）
        if (lowerInput === 'a' && key.ctrl && onToggleAllProjects) {
          onToggleAllProjects();
          logEvent('tengu_session_all_projects_toggled', {
            enabled: !showAllProjects,
          });
        } else if (lowerInput === 'b' && key.ctrl) {
          const newEnabled = !branchFilterEnabled;
          setBranchFilterEnabled(newEnabled);
          logEvent('tengu_session_branch_filter_toggled', {
            enabled: newEnabled,
          });
        } else if (lowerInput === 'w' && key.ctrl && hasMultipleWorktrees) {
          const newValue = !showAllWorktrees;
          setShowAllWorktrees(newValue);
          logEvent('tengu_session_worktree_filter_toggled', {
            enabled: newValue,
          });
        } else if (lowerInput === '/' && keyIsNotCtrlOrMeta) {
          setViewMode('search');
          logEvent('tengu_session_search_toggled', { enabled: true });
        } else if (lowerInput === 'r' && key.ctrl && focusedLog) {
          setViewMode('rename');
          setRenameValue('');
          logEvent('tengu_session_rename_started', {});
        } else if (lowerInput === 'v' && key.ctrl && focusedLog) {
          setPreviewLog(focusedLog);
          setViewMode('preview');
          logEvent('tengu_session_preview_opened', {
            messageCount: focusedLog.messageCount,
          });
        } else if (focusedLog && keyIsNotCtrlOrMeta && input.length > 0 && !/^\s+$/.test(input)) {
          // 任意可打印字符都会进入搜索模式并开始输入
          setViewMode('search');
          setSearchQuery(input);
          logEvent('tengu_session_search_toggled', { enabled: true });
        }
      }
    },
    { isActive: true },
  );

  const filterIndicators = [];
  if (branchFilterEnabled && currentBranch) {
    filterIndicators.push(currentBranch);
  }
  if (hasMultipleWorktrees && !showAllWorktrees) {
    filterIndicators.push('当前 worktree');
  }

  const showAdditionalFilterLine = filterIndicators.length > 0 && viewMode !== 'search';

  // 搜索框占 3 行（上边框、内容、下边框）
  const searchBoxLines = 3;
  const headerLines = 5 + searchBoxLines + (showAdditionalFilterLine ? 1 : 0) + tagTabsLines;
  const footerLines = 2;
  const visibleCount = Math.max(1, Math.floor((maxHeight - headerLines - footerLines) / 3));

  // 渐进式加载：当用户滚动到接近底部时请求更多 logs
  React.useEffect(() => {
    if (!onLoadMore) return;
    const buffer = visibleCount * 2;
    if (focusedIndex + buffer >= displayedLogs.length) {
      onLoadMore(visibleCount * 3);
    }
  }, [focusedIndex, visibleCount, displayedLogs.length, onLoadMore]);

  // 没有 logs 时提前返回
  if (logs.length === 0) {
    return null;
  }

  // 处于激活状态时显示 preview 模式
  if (viewMode === 'preview' && previewLog && isResumeWithRenameEnabled) {
    return (
      <SessionPreview
        log={previewLog}
        onExit={() => {
          setViewMode('list');
          setPreviewLog(null);
        }}
        onSelect={onSelect}
      />
    );
  }

  return (
    <Box flexDirection="column" height={maxHeight - 1}>
      <Box flexShrink={0}>
        <Divider color="suggestion" />
      </Box>
      <Box flexShrink={0}>
        <Text> </Text>
      </Box>

      {hasTags ? (
        <TagTabs
          tabs={tagTabs}
          selectedIndex={effectiveTagIndex}
          availableWidth={columns}
          showAllProjects={showAllProjects}
        />
      ) : (
        <Box flexShrink={0}>
          <Text bold color="suggestion">
            恢复 Session
            {viewMode === 'list' && displayedLogs.length > visibleCount && (
              <Text dimColor>
                {' '}
                ({focusedIndex} / {displayedLogs.length})
              </Text>
            )}
          </Text>
        </Box>
      )}
      <SearchBox
        query={searchQuery}
        isFocused={viewMode === 'search'}
        isTerminalFocused={isTerminalFocused}
        cursorOffset={searchCursorOffset}
      />
      {filterIndicators.length > 0 && viewMode !== 'search' && (
        <Box flexShrink={0} paddingLeft={2}>
          <Text dimColor>
            <Byline>{filterIndicators}</Byline>
          </Text>
        </Box>
      )}
      <Box flexShrink={0}>
        <Text> </Text>
      </Box>

      {/* Agentic 搜索加载状态 */}
      {agenticSearchState.status === 'searching' && (
        <Box paddingLeft={1} flexShrink={0}>
          <Spinner />
          <Text> 搜索中…</Text>
        </Box>
      )}

      {/* agentic 搜索完成并返回结果时的结果标题 */}
      {agenticSearchState.status === 'results' && agenticSearchState.results.length > 0 && (
        <Box paddingLeft={1} marginBottom={1} flexShrink={0}>
          <Text dimColor italic>
            Claude 找到了以下结果：
          </Text>
        </Box>
      )}

      {/* agentic 搜索无结果、且深度搜索也无结果时的兜底提示 */}
      {agenticSearchState.status === 'results' &&
        agenticSearchState.results.length === 0 &&
        filteredLogs.length === 0 && (
          <Box paddingLeft={1} marginBottom={1} flexShrink={0}>
            <Text dimColor italic>
              未找到匹配的 session。
            </Text>
          </Box>
        )}

      {/* agentic 搜索失败、且深度搜索也无结果时的错误提示 */}
      {agenticSearchState.status === 'error' && filteredLogs.length === 0 && (
        <Box paddingLeft={1} marginBottom={1} flexShrink={0}>
          <Text dimColor italic>
            未找到匹配的 session。
          </Text>
        </Box>
      )}

      {/* Agentic 搜索选项 —— 搜索时作为列表第一项 */}
      {Boolean(searchQuery.trim()) &&
        onAgenticSearch &&
        isAgenticSearchEnabled &&
        agenticSearchState.status !== 'searching' &&
        agenticSearchState.status !== 'results' &&
        agenticSearchState.status !== 'error' && (
          <Box flexShrink={0} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={isAgenticSearchOptionFocused ? 'suggestion' : undefined}>
                {isAgenticSearchOptionFocused ? figures.pointer : ' '}
              </Text>
              <Text color={isAgenticSearchOptionFocused ? 'suggestion' : undefined} bold={isAgenticSearchOptionFocused}>
                使用 Claude 深度搜索 →
              </Text>
            </Box>
            <Box height={1} />
          </Box>
        )}

      {/* agentic 搜索进行中时隐藏 session 列表 */}
      {agenticSearchState.status === 'searching' ? null : viewMode === 'rename' && focusedLog ? (
        <Box paddingLeft={2} flexDirection="column">
          <Text bold>重命名 session：</Text>
          <Box paddingTop={1}>
            <TextInput
              value={renameValue}
              onChange={setRenameValue}
              onSubmit={handleRenameSubmit}
              placeholder={getLogDisplayTitle(focusedLog!, '输入新的 session 名称')}
              columns={columns}
              cursorOffset={renameCursorOffset}
              onChangeCursorOffset={setRenameCursorOffset}
              showCursor={true}
            />
          </Box>
        </Box>
      ) : isResumeWithRenameEnabled ? (
        <TreeSelect
          nodes={treeNodes}
          onSelect={node => {
            onSelect(node.value.log);
          }}
          onFocus={handleTreeSelectFocus}
          onCancel={onCancel}
          focusNodeId={focusedNode?.id}
          visibleOptionCount={visibleCount}
          layout="expanded"
          isDisabled={viewMode === 'search' || isAgenticSearchOptionFocused}
          hideIndexes={false}
          isNodeExpanded={nodeId => {
            // 在搜索或 branch 过滤模式下始终展开
            if (viewMode === 'search' || branchFilterEnabled) {
              return true;
            }
            // 从 node ID 中提取 sessionId（格式为 "group:sessionId"）
            const sessionId = typeof nodeId === 'string' && nodeId.startsWith('group:') ? nodeId.substring(6) : null;
            return sessionId ? expandedGroupSessionIds.has(sessionId) : false;
          }}
          onExpand={nodeId => {
            const sessionId = typeof nodeId === 'string' && nodeId.startsWith('group:') ? nodeId.substring(6) : null;
            if (sessionId) {
              setExpandedGroupSessionIds(prev => new Set(prev).add(sessionId));
              logEvent('tengu_session_group_expanded', {});
            }
          }}
          onCollapse={nodeId => {
            const sessionId = typeof nodeId === 'string' && nodeId.startsWith('group:') ? nodeId.substring(6) : null;
            if (sessionId) {
              setExpandedGroupSessionIds(prev => {
                const newSet = new Set(prev);
                newSet.delete(sessionId);
                return newSet;
              });
            }
          }}
          onUpFromFirstItem={enterSearchMode}
        />
      ) : (
        <Select
          options={flatOptions}
          onChange={value => {
            // 旧版扁平列表模式 —— 索引直接映射到 displayedLogs
            const itemIndex = parseInt(value, 10);
            const log = displayedLogs[itemIndex];
            if (log) {
              onSelect(log);
            }
          }}
          visibleOptionCount={visibleCount}
          onCancel={onCancel}
          onFocus={handleFlatOptionsSelectFocus}
          defaultFocusValue={focusedNode?.id.toString()}
          layout="expanded"
          isDisabled={viewMode === 'search' || isAgenticSearchOptionFocused}
          onUpFromFirstItem={enterSearchMode}
        />
      )}
      <Box paddingLeft={2}>
        {exitState.pending ? (
          <Text dimColor>再按一次 {exitState.keyName} 退出</Text>
        ) : viewMode === 'rename' ? (
          <Text dimColor>
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="保存" />
              <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="取消" />
            </Byline>
          </Text>
        ) : agenticSearchState.status === 'searching' ? (
          <Text dimColor>
            <Byline>
              <Text>正在使用 Claude 搜索…</Text>
              <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="取消" />
            </Byline>
          </Text>
        ) : isAgenticSearchOptionFocused ? (
          <Text dimColor>
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="搜索" />
              <KeyboardShortcutHint shortcut="↓" action="跳过" />
              <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="取消" />
            </Byline>
          </Text>
        ) : viewMode === 'search' ? (
          <Text dimColor>
            <Byline>
              <Text>{isSearching && isDeepSearchEnabled ? '搜索中…' : '输入即可搜索'}</Text>
              <KeyboardShortcutHint shortcut="Enter" action="选择" />
              <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="清除" />
            </Byline>
          </Text>
        ) : (
          <Text dimColor>
            <Byline>
              {onToggleAllProjects && (
                <KeyboardShortcutHint shortcut="Ctrl+A" action={`显示${showAllProjects ? '当前目录' : '全部项目'}`} />
              )}
              {currentBranch && <KeyboardShortcutHint shortcut="Ctrl+B" action="切换 branch 过滤" />}
              {hasMultipleWorktrees && (
                <KeyboardShortcutHint
                  shortcut="Ctrl+W"
                  action={`显示${showAllWorktrees ? '当前 worktree' : '全部 worktree'}`}
                />
              )}
              <KeyboardShortcutHint shortcut="Ctrl+V" action="预览" />
              <KeyboardShortcutHint shortcut="Ctrl+R" action="重命名" />
              <Text>输入即可搜索</Text>
              <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="取消" />
              {getExpandCollapseHint() && <Text>{getExpandCollapseHint()}</Text>}
            </Byline>
          </Text>
        )}
      </Box>
    </Box>
  );
}

/**
 * 从消息中提取可搜索的文本内容。
 * 同时处理字符串内容和结构化 content block。
 */
function extractSearchableText(message: SerializedMessage): string {
  // 仅从含有 content 的 user/assistant 消息中提取
  if (message.type !== 'user' && message.type !== 'assistant') {
    return '';
  }

  const content = 'message' in message ? message.message?.content : undefined;
  if (!content) return '';

  // 处理字符串型 content（简单消息）
  if (typeof content === 'string') {
    return content;
  }

  // 处理 content block 数组
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block;
        if ('text' in block && typeof block.text === 'string') return block.text;
        return '';
        // 这里不返回 thinking block 和工具名；
        // 它们对搜索没有帮助，反而会给模糊匹配增加噪声
      })
      .filter(Boolean)
      .join(' ');
  }

  return '';
}

/**
 * 为一条 log 构建可搜索文本，包含 messages、titles、summaries 和 metadata。
 * 为性能考虑，长 transcript 仅截取前/后 N 条消息。
 */
function buildSearchableText(log: LogOption): string {
  const searchableMessages =
    log.messages.length <= DEEP_SEARCH_MAX_MESSAGES
      ? log.messages
      : [...log.messages.slice(0, DEEP_SEARCH_CROP_SIZE), ...log.messages.slice(-DEEP_SEARCH_CROP_SIZE)];
  const messageText = searchableMessages.map(extractSearchableText).filter(Boolean).join(' ');

  const metadata = [
    log.customTitle,
    log.summary,
    log.firstPrompt,
    log.gitBranch,
    log.tag,
    log.prNumber ? `PR #${log.prNumber}` : undefined,
    log.prRepository,
  ]
    .filter(Boolean)
    .join(' ');

  const fullText = `${metadata} ${messageText}`.trim();
  return fullText.length > DEEP_SEARCH_MAX_TEXT_LENGTH ? fullText.slice(0, DEEP_SEARCH_MAX_TEXT_LENGTH) : fullText;
}

function groupLogsBySessionId(filteredLogs: LogOption[]): Map<string, LogOption[]> {
  const groups = new Map<string, LogOption[]>();

  for (const log of filteredLogs) {
    const sessionId = getSessionIdFromLog(log);
    if (sessionId) {
      const existing = groups.get(sessionId);
      if (existing) {
        existing.push(log);
      } else {
        groups.set(sessionId, [log]);
      }
    }
  }

  // 将每个分组内的 logs 按修改日期排序（最新优先）
  groups.forEach(logs => logs.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime()));

  return groups;
}

/**
 * 从 log 列表中获取去重后的 tag，按字母顺序排序
 */
function getUniqueTags(logs: LogOption[]): string[] {
  const tags = new Set<string>();
  for (const log of logs) {
    if (log.tag) {
      tags.add(log.tag);
    }
  }
  return Array.from(tags).sort((a, b) => a.localeCompare(b));
}
