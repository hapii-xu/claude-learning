import { useCallback, useRef, useState } from 'react';
import { getModeFromInput } from 'src/components/PromptInput/inputModes.js';
import { useNotifications } from 'src/context/notifications.js';
import { ConfigurableShortcutHint } from '../components/ConfigurableShortcutHint.js';
import { FOOTER_TEMPORARY_STATUS_TIMEOUT } from '../components/PromptInput/Notifications.js';
import { getHistory } from '../history.js';
import { Text } from '@anthropic/ink';
import type { PromptInputMode } from '../types/textInputTypes.js';
import type { HistoryEntry, PastedContent } from '../utils/config.js';

export type HistoryMode = PromptInputMode;

// 按块加载历史条目以减少快速按键时的磁盘读取
const HISTORY_CHUNK_SIZE = 10;

// 共享状态，用于将并发加载请求批处理为单次磁盘读取
// 包含模式过滤器以确保我们不会混合过滤和未过滤的缓存
let pendingLoad: Promise<HistoryEntry[]> | null = null;
let pendingLoadTarget = 0;
let pendingLoadModeFilter: HistoryMode | undefined;

async function loadHistoryEntries(minCount: number, modeFilter?: HistoryMode): Promise<HistoryEntry[]> {
  // 向上取整到下一个块以避免重复的小读取
  const target = Math.ceil(minCount / HISTORY_CHUNK_SIZE) * HISTORY_CHUNK_SIZE;

  // 如果已经有一个具有相同模式过滤器的加载正在进行且将满足我们的需求，等待它
  if (pendingLoad && pendingLoadTarget >= target && pendingLoadModeFilter === modeFilter) {
    return pendingLoad;
  }

  // 如果有加载正在进行但无法满足我们的需求或有不同的过滤器，我们需要等待它
  // 完成，然后开始新的（无法中断正在进行的读取）
  if (pendingLoad) {
    await pendingLoad;
  }

  // 开始新的加载
  pendingLoadTarget = target;
  pendingLoadModeFilter = modeFilter;
  pendingLoad = (async () => {
    const entries: HistoryEntry[] = [];
    let loaded = 0;
    for await (const entry of getHistory()) {
      // 如果指定了模式过滤器，只包含匹配模式的条目
      if (modeFilter) {
        const entryMode = getModeFromInput(entry.display);
        if (entryMode !== modeFilter) {
          continue;
        }
      }
      entries.push(entry);
      loaded++;
      if (loaded >= pendingLoadTarget) break;
    }
    return entries;
  })();

  try {
    return await pendingLoad;
  } finally {
    pendingLoad = null;
    pendingLoadTarget = 0;
    pendingLoadModeFilter = undefined;
  }
}

export function useArrowKeyHistory(
  onSetInput: (value: string, mode: HistoryMode, pastedContents: Record<number, PastedContent>) => void,
  currentInput: string,
  pastedContents: Record<number, PastedContent>,
  setCursorOffset?: (offset: number) => void,
  currentMode?: HistoryMode,
): {
  historyIndex: number;
  setHistoryIndex: (index: number) => void;
  onHistoryUp: () => void;
  onHistoryDown: () => boolean;
  resetHistory: () => void;
  dismissSearchHint: () => void;
} {
  const [historyIndex, setHistoryIndex] = useState(0);
  const [lastShownHistoryEntry, setLastShownHistoryEntry] = useState<
    (HistoryEntry & { mode?: HistoryMode }) | undefined
  >(undefined);
  const hasShownSearchHintRef = useRef(false);
  const { addNotification, removeNotification } = useNotifications();

  // 缓存已加载的历史条目
  const historyCache = useRef<HistoryEntry[]>([]);
  // 跟踪缓存加载时使用的模式过滤器
  const historyCacheModeFilter = useRef<HistoryMode | undefined>(undefined);

  // 历史索引的同步跟踪器以避免过时闭包问题
  // React 状态更新是异步的，所以快速按键可能看到过时的值
  const historyIndexRef = useRef(0);

  // 跟踪历史导航开始时活动的模式过滤器
  // 这在第一次箭头按下时设置并保持固定直到重置
  const initialModeFilterRef = useRef<HistoryMode | undefined>(undefined);

  // 用于跟踪当前输入值的 ref，以便草稿保留
  // 这些确保我们使用最新值捕获草稿，而不是过时的闭包值
  const currentInputRef = useRef(currentInput);
  const pastedContentsRef = useRef(pastedContents);
  const currentModeRef = useRef(currentMode);

  // 保持 ref 与 props 同步（每次渲染时同步更新）
  currentInputRef.current = currentInput;
  pastedContentsRef.current = pastedContents;
  currentModeRef.current = currentMode;

  const setInputWithCursor = useCallback(
    (value: string, mode: HistoryMode, contents: Record<number, PastedContent>, cursorToStart = false): void => {
      onSetInput(value, mode, contents);
      setCursorOffset?.(cursorToStart ? 0 : value.length);
    },
    [onSetInput, setCursorOffset],
  );

  const updateInput = useCallback(
    (input: HistoryEntry | undefined, cursorToStart = false): void => {
      if (!input || !input.display) return;

      const mode = getModeFromInput(input.display);
      const value = mode === 'bash' ? input.display.slice(1) : input.display;

      setInputWithCursor(value, mode, input.pastedContents ?? {}, cursorToStart);
    },
    [setInputWithCursor],
  );

  const showSearchHint = useCallback((): void => {
    addNotification({
      key: 'search-history-hint',
      jsx: (
        <Text dimColor>
          <ConfigurableShortcutHint
            action="history:search"
            context="Global"
            fallback="ctrl+r"
            description="search history"
          />
        </Text>
      ),
      priority: 'immediate',
      timeoutMs: FOOTER_TEMPORARY_STATUS_TIMEOUT,
    });
  }, [addNotification]);

  const onHistoryUp = useCallback((): void => {
    // 同步捕获并递增以处理快速按键
    const targetIndex = historyIndexRef.current;
    historyIndexRef.current++;

    const inputAtPress = currentInputRef.current;
    const pastedContentsAtPress = pastedContentsRef.current;
    const modeAtPress = currentModeRef.current;

    if (targetIndex === 0) {
      initialModeFilterRef.current = modeAtPress === 'bash' ? modeAtPress : undefined;

      // 使用 ref 同步保存草稿以获取最新值
      // 这确保我们在任何异步操作或重新渲染之前捕获草稿
      const hasInput = inputAtPress.trim() !== '';
      setLastShownHistoryEntry(
        hasInput
          ? {
              display: inputAtPress,
              pastedContents: pastedContentsAtPress,
              mode: modeAtPress,
            }
          : undefined,
      );
    }

    const modeFilter = initialModeFilterRef.current;

    void (async () => {
      const neededCount = targetIndex + 1; // 我们需要多少条目

      // 如果模式过滤器更改，使缓存失效
      if (historyCacheModeFilter.current !== modeFilter) {
        historyCache.current = [];
        historyCacheModeFilter.current = modeFilter;
        historyIndexRef.current = 0;
      }

      // 如果需要加载更多条目
      if (historyCache.current.length < neededCount) {
        // 批处理并发请求 - 快速按键共享单次磁盘读取
        const entries = await loadHistoryEntries(neededCount, modeFilter);
        // 仅当我们加载的内容多于当前缓存时才更新缓存
        // （处理多个加载乱序完成的竞争条件）
        if (entries.length > historyCache.current.length) {
          historyCache.current = entries;
        }
      }

      // 检查是否可以导航
      if (targetIndex >= historyCache.current.length) {
        // 回滚 ref，因为我们无法导航
        historyIndexRef.current--;
        // 保持草稿完整 - 用户停留在当前输入
        return;
      }

      const newIndex = targetIndex + 1;
      setHistoryIndex(newIndex);
      updateInput(historyCache.current[targetIndex], true);

      // 在每次会话中导航通过 2 个历史条目后显示一次提示
      if (newIndex >= 2 && !hasShownSearchHintRef.current) {
        hasShownSearchHintRef.current = true;
        showSearchHint();
      }
    })();
  }, [updateInput, showSearchHint]);

  const onHistoryDown = useCallback((): boolean => {
    // 使用 ref 保持一致的读取
    const currentIndex = historyIndexRef.current;
    if (currentIndex > 1) {
      historyIndexRef.current--;
      setHistoryIndex(currentIndex - 1);
      updateInput(historyCache.current[currentIndex - 2]);
    } else if (currentIndex === 1) {
      historyIndexRef.current = 0;
      setHistoryIndex(0);
      if (lastShownHistoryEntry) {
        // 恢复草稿及其保存的模式（如果可用）
        const savedMode = lastShownHistoryEntry.mode;
        if (savedMode) {
          setInputWithCursor(lastShownHistoryEntry.display, savedMode, lastShownHistoryEntry.pastedContents ?? {});
        } else {
          updateInput(lastShownHistoryEntry);
        }
      } else {
        // 在过滤模式下，清除输入时保持该模式
        setInputWithCursor('', initialModeFilterRef.current ?? 'prompt', {});
      }
    }
    return currentIndex <= 0;
  }, [lastShownHistoryEntry, updateInput, setInputWithCursor]);

  const resetHistory = useCallback((): void => {
    setLastShownHistoryEntry(undefined);
    setHistoryIndex(0);
    historyIndexRef.current = 0;
    initialModeFilterRef.current = undefined;
    removeNotification('search-history-hint');
    historyCache.current = [];
    historyCacheModeFilter.current = undefined;
  }, [removeNotification]);

  const dismissSearchHint = useCallback((): void => {
    removeNotification('search-history-hint');
  }, [removeNotification]);

  return {
    historyIndex,
    setHistoryIndex,
    onHistoryUp,
    onHistoryDown,
    resetHistory,
    dismissSearchHint,
  };
}
