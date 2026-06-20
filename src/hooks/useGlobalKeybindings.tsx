/**
 * 注册全局快捷键处理程序的组件。
 *
 * 必须在 KeybindingSetup 内部渲染以访问快捷键上下文。
 * 此组件不渲染任何内容 - 仅注册快捷键处理程序。
 */
import { feature } from 'bun:bundle';
import { useCallback } from 'react';
import { instances } from '@anthropic/ink';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import type { Screen } from '../screens/REPL.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js';
import { useAppState, useSetAppState } from '../state/AppState.js';
import { count } from '../utils/array.js';
import { getTerminalPanel } from '../utils/terminalPanel.js';

type Props = {
  screen: Screen;
  setScreen: React.Dispatch<React.SetStateAction<Screen>>;
  showAllInTranscript: boolean;
  setShowAllInTranscript: React.Dispatch<React.SetStateAction<boolean>>;
  messageCount: number;
  onEnterTranscript?: () => void;
  onExitTranscript?: () => void;
  virtualScrollActive?: boolean;
  searchBarOpen?: boolean;
};

/**
 * 注册全局快捷键处理程序：
 * - ctrl+t：切换待办列表
 * - ctrl+o：切换 transcript 模式
 * - ctrl+e：切换在 transcript 中显示所有消息
 * - ctrl+c/escape：退出 transcript 模式
 */
export function GlobalKeybindingHandlers({
  screen,
  setScreen,
  showAllInTranscript,
  setShowAllInTranscript,
  messageCount,
  onEnterTranscript,
  onExitTranscript,
  virtualScrollActive,
  searchBarOpen = false,
}: Props): null {
  const expandedView = useAppState(s => s.expandedView);
  const setAppState = useSetAppState();

  // 切换待办列表 (ctrl+t) - 在视图间循环
  const handleToggleTodos = useCallback(() => {
    logEvent('tengu_toggle_todos', {
      is_expanded: expandedView === 'tasks',
    });
    setAppState(prev => {
      const { getAllInProcessTeammateTasks } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../tasks/InProcessTeammateTask/InProcessTeammateTask.js') as typeof import('../tasks/InProcessTeammateTask/InProcessTeammateTask.js');
      const hasTeammates = count(getAllInProcessTeammateTasks(prev.tasks), t => t.status === 'running') > 0;

      if (hasTeammates) {
        // 两者都存在：none → tasks → teammates → none
        switch (prev.expandedView) {
          case 'none':
            return { ...prev, expandedView: 'tasks' as const };
          case 'tasks':
            return { ...prev, expandedView: 'teammates' as const };
          case 'teammates':
            return { ...prev, expandedView: 'none' as const };
        }
      }
      // 只有 tasks：none ↔ tasks
      return {
        ...prev,
        expandedView: prev.expandedView === 'tasks' ? ('none' as const) : ('tasks' as const),
      };
    });
  }, [expandedView, setAppState]);

  // 切换 transcript 模式 (ctrl+o)。双向 prompt ↔ transcript。
  // Brief 视图有自己在 ctrl+shift+b 上的专用切换。
  const isBriefOnlyState = useAppState(s => s.isBriefOnly);
  const handleToggleTranscript = useCallback(() => {
    if (feature('KAIROS') || feature('KAIROS_BRIEF')) {
      // 逃生舱：GB kill-switch 在 defaultView=chat 被持久化时
      // 可能让 isBriefOnly 卡在开启状态，显示空白的 filterForBriefTool
      // 视图。用户会去按 ctrl+o —— 先清除卡住的状态。
      // 仅在 prompt 屏幕需要 —— transcript 模式已经忽略
      // isBriefOnly（Messages.tsx 过滤器在 !isTranscriptMode 上门控）。
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { isBriefEnabled } =
        require('@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js') as typeof import('@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js');
      /* eslint-enable @typescript-eslint/no-require-imports */
      if (!isBriefEnabled() && isBriefOnlyState && screen !== 'transcript') {
        setAppState(prev => {
          if (!prev.isBriefOnly) return prev;
          return { ...prev, isBriefOnly: false };
        });
        return;
      }
    }

    const isEnteringTranscript = screen !== 'transcript';
    logEvent('tengu_toggle_transcript', {
      is_entering: isEnteringTranscript,
      show_all: showAllInTranscript,
      message_count: messageCount,
    });
    setScreen(s => (s === 'transcript' ? 'prompt' : 'transcript'));
    setShowAllInTranscript(false);
    if (isEnteringTranscript && onEnterTranscript) {
      onEnterTranscript();
    }
    if (!isEnteringTranscript && onExitTranscript) {
      onExitTranscript();
    }
  }, [
    screen,
    setScreen,
    isBriefOnlyState,
    showAllInTranscript,
    setShowAllInTranscript,
    messageCount,
    setAppState,
    onEnterTranscript,
    onExitTranscript,
  ]);

  // 在 transcript 模式下切换显示所有消息 (ctrl+e)
  const handleToggleShowAll = useCallback(() => {
    logEvent('tengu_transcript_toggle_show_all', {
      is_expanding: !showAllInTranscript,
      message_count: messageCount,
    });
    setShowAllInTranscript(prev => !prev);
  }, [showAllInTranscript, setShowAllInTranscript, messageCount]);

  // 退出 transcript 模式 (ctrl+c 或 escape)
  const handleExitTranscript = useCallback(() => {
    logEvent('tengu_transcript_exit', {
      show_all: showAllInTranscript,
      message_count: messageCount,
    });
    setScreen('prompt');
    setShowAllInTranscript(false);
    if (onExitTranscript) {
      onExitTranscript();
    }
  }, [setScreen, showAllInTranscript, setShowAllInTranscript, messageCount, onExitTranscript]);

  // 切换 brief-only 视图 (ctrl+shift+b)。纯显示过滤器切换 ——
  // 不触及 opt-in 状态。非对称门控（镜像 /brief）：OFF
  // 转换始终允许，这样让你进入的同一键也能让你出来，
  // 即使 GB kill-switch 在会话中途触发。
  const handleToggleBrief = useCallback(() => {
    if (feature('KAIROS') || feature('KAIROS_BRIEF')) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { isBriefEnabled } =
        require('@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js') as typeof import('@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js');
      /* eslint-enable @typescript-eslint/no-require-imports */
      if (!isBriefEnabled() && !isBriefOnlyState) return;
      const next = !isBriefOnlyState;
      logEvent('tengu_brief_mode_toggled', {
        enabled: next,
        gated: false,
        source: 'keybinding' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      setAppState(prev => {
        if (prev.isBriefOnly === next) return prev;
        return { ...prev, isBriefOnly: next };
      });
    }
  }, [isBriefOnlyState, setAppState]);

  // 注册快捷键处理程序
  useKeybinding('app:toggleTodos', handleToggleTodos, {
    context: 'Global',
  });
  useKeybinding('app:toggleTranscript', handleToggleTranscript, {
    context: 'Global',
  });
  useKeybinding('app:toggleBrief', handleToggleBrief, {
    context: 'Global',
    isActive: feature('KAIROS') ? true : feature('KAIROS_BRIEF') ? true : false,
  });

  // 注册队友快捷键
  useKeybinding(
    'app:toggleTeammatePreview',
    () => {
      setAppState(prev => ({
        ...prev,
        showTeammateMessagePreview: !prev.showTeammateMessagePreview,
      }));
    },
    {
      context: 'Global',
    },
  );

  // 切换内置终端面板 (meta+j)。
  // toggle() 在 spawnSync 中阻塞直到用户从 tmux 分离。
  const handleToggleTerminal = useCallback(() => {
    if (feature('TERMINAL_PANEL')) {
      if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_terminal_panel', false)) {
        return;
      }
      getTerminalPanel().toggle();
    }
  }, []);
  useKeybinding('app:toggleTerminal', handleToggleTerminal, {
    context: 'Global',
  });

  // 清屏并强制全量重绘 (ctrl+l)。当终端被外部清除
  // （macOS Cmd+K）且 Ink 的 diff 引擎认为未更改的单元格
  // 无需重绘时的恢复路径。
  const handleRedraw = useCallback(() => {
    instances.get(process.stdout)?.forceRedraw();
  }, []);
  useKeybinding('app:redraw', handleRedraw, { context: 'Global' });

  // Transcript 特定的绑定（仅在 transcript 模式下活跃）
  const isInTranscript = screen === 'transcript';
  useKeybinding('transcript:toggleShowAll', handleToggleShowAll, {
    context: 'Transcript',
    isActive: isInTranscript && !virtualScrollActive,
  });
  useKeybinding('transcript:exit', handleExitTranscript, {
    context: 'Transcript',
    // Bar-open 是一种模式（拥有按键）。导航中（高亮
    // 可见，n/N 活跃，bar 关闭）不是 —— Esc 直接退出 transcript，
    // 与 less q 相同。useSearchInput 不停止传播，
    // 所以如果没有此门控，其 onCancel 和此处理程序都会
    // 在一次 Esc 上触发（子级先注册，先触发，冒泡）。
    isActive: isInTranscript && !searchBarOpen,
  });

  return null;
}
