import { feature } from 'bun:bundle';
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import React, { useContext, useMemo } from 'react';
import { getKairosActive, getUserMsgOptIn } from '../../bootstrap/state.js';
import { Box } from '@anthropic/ink';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js';
import { useAppState } from '../../state/AppState.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import { logError } from '../../utils/log.js';
import { countCharInString } from '../../utils/stringUtils.js';
import { MessageActionsSelectedContext } from '../messageActions.js';
import { HighlightedThinkingText } from './HighlightedThinkingText.js';

type Props = {
  addMargin: boolean;
  param: TextBlockParam;
  isTranscriptMode?: boolean;
  timestamp?: string;
};

// 显示 prompt 文本的硬上限。通过 stdin 管道传输大文件
// （例如 `cat 11k-line-file | claude`）会创建一条用户消息，全屏 Ink
// 渲染器必须每帧 wrap/output 该消息的 <Text> 节点，导致 500ms+
// 的按键延迟。React.memo 跳过 React 渲染，但 Ink 输出阶段
// 仍然会遍历完整挂载的文本。非全屏模式通过 <Static> 避免了
// 该问题（print-and-forget 到终端 scrollback）。
// Head+tail 截断是因为 `{ cat file; echo prompt; } | claude` 把用户的
// 实际问题放在末尾。
const MAX_DISPLAY_CHARS = 10_000;
const TRUNCATE_HEAD_CHARS = 2_500;
const TRUNCATE_TAIL_CHARS = 2_500;

export function UserPromptMessage({ addMargin, param: { text }, isTranscriptMode, timestamp }: Props): React.ReactNode {
  // REPL.tsx 传递 isBriefOnly={viewedTeammateTask ? false : isBriefOnly}
  // 但该 prop 没有传递到这么深 —— 通过直接读取 viewingAgentTaskId 来
  // 复刻该 override。在此处计算（不在子组件中），使父 Box 可以
  // 丢弃其 backgroundColor：在 brief 模式下子组件渲染 label 样式布局，
  // 而 Box backgroundColor 无条件地绘制在子组件后面（子组件无法 opt out）。
  //
  // Hooks 必须始终无条件调用以满足 React 规则。
  // feature gate 应用于计算值，而非 hook 调用。
  const isBriefOnlyState = useAppState(s => s.isBriefOnly);
  const viewingAgentTaskIdState = useAppState(s => s.viewingAgentTaskId);
  // 提升到挂载时 —— 每条消息的组件，每次滚动都会重新渲染。
  const briefEnvEnabledState = useMemo(() => isEnvTruthy(process.env.CLAUDE_CODE_BRIEF), []);
  const useBriefLayout =
    feature('KAIROS') || feature('KAIROS_BRIEF')
      ? (getKairosActive() ||
          (getUserMsgOptIn() &&
            (briefEnvEnabledState || getFeatureValue_CACHED_MAY_BE_STALE('tengu_kairos_brief', false)))) &&
        isBriefOnlyState &&
        !isTranscriptMode &&
        !viewingAgentTaskIdState
      : false;

  // 在 early return 之前截断，使 hook 顺序保持稳定。
  const displayText = useMemo(() => {
    if (text.length <= MAX_DISPLAY_CHARS) return text;
    const head = text.slice(0, TRUNCATE_HEAD_CHARS);
    const tail = text.slice(-TRUNCATE_TAIL_CHARS);
    const hiddenLines = countCharInString(text, '\n', TRUNCATE_HEAD_CHARS) - countCharInString(tail, '\n');
    return `${head}\n… +${hiddenLines} lines …\n${tail}`;
  }, [text]);

  const isSelected = useContext(MessageActionsSelectedContext);

  if (!text) {
    logError(new Error('No content found in user prompt message'));
    return null;
  }

  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      backgroundColor={isSelected ? 'messageActionsBackground' : useBriefLayout ? undefined : 'userMessageBackground'}
      paddingRight={useBriefLayout ? 0 : 1}
    >
      <HighlightedThinkingText
        text={displayText}
        useBriefLayout={useBriefLayout}
        timestamp={useBriefLayout ? timestamp : undefined}
      />
    </Box>
  );
}
