import type { StructuredPatchHunk } from 'diff';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { useRegisterOverlay } from '../../context/overlayContext.js';
import { type DiffData, useDiffData } from '../../hooks/useDiffData.js';
import { type TurnDiff, useTurnDiffs } from '../../hooks/useTurnDiffs.js';
import { Box, Text } from '@anthropic/ink';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import type { Message } from '../../types/message.js';
import { plural } from '../../utils/stringUtils.js';
import { Byline, Dialog } from '@anthropic/ink';
import { DiffDetailView } from './DiffDetailView.js';
import { DiffFileList } from './DiffFileList.js';

type Props = {
  messages: Message[];
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void;
};

type ViewMode = 'list' | 'detail';

type DiffSource = { type: 'current' } | { type: 'turn'; turn: TurnDiff };

function turnDiffToDiffData(turn: TurnDiff): DiffData {
  const files = Array.from(turn.files.values())
    .map(f => ({
      path: f.filePath,
      linesAdded: f.linesAdded,
      linesRemoved: f.linesRemoved,
      isBinary: false,
      isLargeFile: false,
      isTruncated: false,
      isNewFile: f.isNewFile,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const hunks = new Map<string, StructuredPatchHunk[]>();
  for (const f of turn.files.values()) {
    hunks.set(f.filePath, f.hunks);
  }

  return {
    stats: {
      filesCount: turn.stats.filesChanged,
      linesAdded: turn.stats.linesAdded,
      linesRemoved: turn.stats.linesRemoved,
    },
    files,
    hunks,
    loading: false,
  };
}

export function DiffDialog({ messages, onDone }: Props): React.ReactNode {
  const gitDiffData = useDiffData();
  const turnDiffs = useTurnDiffs(messages);

  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [sourceIndex, setSourceIndex] = useState<number>(0);

  const sources: DiffSource[] = useMemo(
    () => [{ type: 'current' }, ...turnDiffs.map((turn): DiffSource => ({ type: 'turn', turn }))],
    [turnDiffs],
  );

  const currentSource = sources[sourceIndex];
  const currentTurn = currentSource?.type === 'turn' ? currentSource.turn : null;

  const diffData = useMemo((): DiffData => {
    return currentTurn ? turnDiffToDiffData(currentTurn) : gitDiffData;
  }, [currentTurn, gitDiffData]);

  const selectedFile = diffData.files[selectedIndex];
  const selectedHunks = useMemo(() => {
    return selectedFile ? diffData.hunks.get(selectedFile.path) || [] : [];
  }, [selectedFile, diffData.hunks]);

  // 当来源数量减少时（例如对话回退）钳制 sourceIndex
  useEffect(() => {
    if (sourceIndex >= sources.length) {
      setSourceIndex(Math.max(0, sources.length - 1));
    }
  }, [sources.length, sourceIndex]);

  // 当来源切换时重置文件选择
  const prevSourceIndex = useRef(sourceIndex);
  useEffect(() => {
    if (prevSourceIndex.current !== sourceIndex) {
      setSelectedIndex(0);
      prevSourceIndex.current = sourceIndex;
    }
  }, [sourceIndex]);

  // 注册为模态覆盖层，使 Chat 快捷键和 CancelRequestHandler
  // 在 DiffDialog 显示期间被禁用
  useRegisterOverlay('diff-dialog');

  // Diff 对话框导航快捷键
  // 依赖于视图模式：左右箭头在不同模式下行为不同
  // （来源切换 vs 返回导航），上下/回车则根据 viewMode 决定行为
  //
  // 注意：Escape 处理（diff:dismiss）不在此注册，因为 Dialog 内置的
  // useKeybinding('confirm:no', handleCancel) 已经处理了它。
  // 同时注册两者会产生死代码，因为 Dialog 的子 effect 先注册并调用
  // stopImmediatePropagation()。defaultBindings.ts 中的 diff:dismiss 绑定
  // 仅为 useShortcutDisplay 显示 "esc 关闭" 提示而保留。
  useKeybindings(
    {
      // 左箭头：详情模式下返回，列表模式下切换来源
      'diff:previousSource': () => {
        if (viewMode === 'detail') {
          setViewMode('list');
        } else if (viewMode === 'list' && sources.length > 1) {
          setSourceIndex(prev => Math.max(0, prev - 1));
        }
      },
      'diff:nextSource': () => {
        if (viewMode === 'list' && sources.length > 1) {
          setSourceIndex(prev => Math.min(sources.length - 1, prev + 1));
        }
      },
      'diff:back': () => {
        if (viewMode === 'detail') {
          setViewMode('list');
        }
      },
      'diff:viewDetails': () => {
        if (viewMode === 'list' && selectedFile) {
          setViewMode('detail');
        }
      },
      'diff:previousFile': () => {
        if (viewMode === 'list') {
          setSelectedIndex(prev => Math.max(0, prev - 1));
        }
      },
      'diff:nextFile': () => {
        if (viewMode === 'list') {
          setSelectedIndex(prev => Math.min(diffData.files.length - 1, prev + 1));
        }
      },
    },
    { context: 'DiffDialog' },
  );

  const subtitle = diffData.stats ? (
    <Text dimColor>
      {diffData.stats.filesCount} 个文件已更改
      {diffData.stats.linesAdded > 0 && <Text color="diffAddedWord"> +{diffData.stats.linesAdded}</Text>}
      {diffData.stats.linesRemoved > 0 && <Text color="diffRemovedWord"> -{diffData.stats.linesRemoved}</Text>}
    </Text>
  ) : null;

  // 根据当前来源构建标题
  const headerTitle = currentTurn ? `第 ${currentTurn.turnIndex} 轮` : '未提交的更改';
  const headerSubtitle = currentTurn
    ? currentTurn.userPromptPreview
      ? `"${currentTurn.userPromptPreview}"`
      : ''
    : '(git diff HEAD)';

  // 来源选择器标签
  const sourceSelector =
    sources.length > 1 ? (
      <Box>
        {sourceIndex > 0 && <Text dimColor>◀ </Text>}
        {sources.map((source, i) => {
          const isSelected = i === sourceIndex;
          const label = source.type === 'current' ? '当前' : `T${source.turn.turnIndex}`;
          return (
            <Text key={i} dimColor={!isSelected} bold={isSelected}>
              {i > 0 ? ' · ' : ''}
              {label}
            </Text>
          );
        })}
        {sourceIndex < sources.length - 1 && <Text dimColor> ▶</Text>}
      </Box>
    ) : null;

  const dismissShortcut = useShortcutDisplay('diff:dismiss', 'DiffDialog', 'esc');
  // 当没有文件可显示时，确定合适的提示文案
  const emptyMessage = (() => {
    if (diffData.loading) {
      return '正在加载 diff…';
    }
    if (currentTurn) {
      return '本轮没有文件更改';
    }
    // 检查是否存在有统计但无文件的情况（文件过多）
    if (diffData.stats && diffData.stats.filesCount > 0 && diffData.files.length === 0) {
      return '文件过多，无法显示详情';
    }
    return '工作区是干净的';
  })();

  // 构建标题，副标题内联显示
  const title = (
    <Text>
      {headerTitle}
      {headerSubtitle && <Text dimColor> {headerSubtitle}</Text>}
    </Text>
  );

  // 处理取消/关闭 — 详情模式下返回，列表模式下关闭对话框
  function handleCancel(): void {
    if (viewMode === 'detail') {
      setViewMode('list');
    } else {
      onDone('已关闭 Diff 对话框', { display: 'system' });
    }
  }

  return (
    <Dialog
      title={title}
      onCancel={handleCancel}
      color="background"
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>再按一次 {exitState.keyName} 退出</Text>
        ) : viewMode === 'list' ? (
          <Byline>
            {sources.length > 1 && <Text>←/→ 来源</Text>}
            <Text>↑/↓ 选择</Text>
            <Text>回车 查看</Text>
            <Text>{dismissShortcut} 关闭</Text>
          </Byline>
        ) : (
          <Byline>
            <Text>← 返回</Text>
            <Text>{dismissShortcut} 关闭</Text>
          </Byline>
        )
      }
    >
      {sourceSelector}
      {subtitle}
      {diffData.files.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>{emptyMessage}</Text>
        </Box>
      ) : viewMode === 'list' ? (
        <Box flexDirection="column" marginTop={1}>
          <DiffFileList files={diffData.files} selectedIndex={selectedIndex} />
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <DiffDetailView
            filePath={selectedFile?.path || ''}
            hunks={selectedHunks}
            isLargeFile={selectedFile?.isLargeFile}
            isBinary={selectedFile?.isBinary}
            isTruncated={selectedFile?.isTruncated}
            isUntracked={selectedFile?.isUntracked}
          />
        </Box>
      )}
    </Dialog>
  );
}
