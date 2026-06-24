// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { Box, Link, Text, type TextProps } from '@anthropic/ink';
import { FilePathLink } from '../FilePathLink.js';
import { feature } from 'bun:bundle';
import * as React from 'react';
import { useState } from 'react';
import sample from 'lodash-es/sample.js';
import { BLACK_CIRCLE, REFERENCE_MARK, TEARDROP_ASTERISK } from '../../constants/figures.js';
import figures from 'figures';
import { basename } from 'path';
import { MessageResponse } from '../MessageResponse.js';

import { openPath } from '../../utils/browser.js';
/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemSaved = feature('TEAMMEM') ? (require('./teamMemSaved.js') as typeof import('./teamMemSaved.js')) : null;
/* eslint-enable @typescript-eslint/no-require-imports */
import { TURN_COMPLETION_VERBS } from '../../constants/turnCompletionVerbs.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import type {
  SystemMessage,
  SystemStopHookSummaryMessage,
  SystemBridgeStatusMessage,
  SystemTurnDurationMessage,
  SystemThinkingMessage,
  SystemMemorySavedMessage,
} from '../../types/message.js';
import { SystemAPIErrorMessage } from './SystemAPIErrorMessage.js';
import { formatDuration, formatNumber, formatSecondsShort } from '../../utils/format.js';
import { getGlobalConfig } from '../../utils/config.js';
import ThemedText from '../design-system/ThemedText.js';
import { CtrlOToExpand } from '../CtrlOToExpand.js';
import { useAppStateStore } from '../../state/AppState.js';
import { isBackgroundTask, type TaskState } from '../../tasks/types.js';
import { getPillLabel } from '../../tasks/pillLabel.js';
import { useSelectedMessageBg } from '../messageActions.js';

type Props = {
  message: SystemMessage;
  addMargin: boolean;
  verbose: boolean;
  isTranscriptMode?: boolean;
};

export function SystemTextMessage({ message, addMargin, verbose, isTranscriptMode }: Props): React.ReactNode {
  const bg = useSelectedMessageBg();
  // Turn duration 消息总是以灰色显示
  if (message.subtype === 'turn_duration') {
    return <TurnDurationMessage message={message} addMargin={addMargin} />;
  }

  if (message.subtype === 'memory_saved') {
    return <MemorySavedMessage message={message} addMargin={addMargin} />;
  }

  if (message.subtype === 'away_summary') {
    return (
      <Box flexDirection="row" marginTop={addMargin ? 1 : 0} backgroundColor={bg} width="100%">
        <Box minWidth={2}>
          <Text dimColor>{REFERENCE_MARK}</Text>
        </Box>
        <Text dimColor>{String(message.content ?? '')}</Text>
      </Box>
    );
  }

  // Agents 已终止的确认
  if (message.subtype === 'agents_killed') {
    return (
      <Box flexDirection="row" marginTop={addMargin ? 1 : 0} backgroundColor={bg} width="100%">
        <Box minWidth={2}>
          <Text color="error">{BLACK_CIRCLE}</Text>
        </Box>
        <Text dimColor>所有后台 Agent 已停止</Text>
      </Box>
    );
  }

  // Thinking 消息是细微的，类似于 turn duration（仅 ant）
  if (message.subtype === 'thinking') {
    if (process.env.USER_TYPE === 'ant') {
      return <ThinkingMessage message={message} addMargin={addMargin} />;
    }
    return null;
  }

  if (message.subtype === 'bridge_status') {
    return <BridgeStatusMessage message={message} addMargin={addMargin} />;
  }

  if (message.subtype === 'scheduled_task_fire') {
    return (
      <Box marginTop={addMargin ? 1 : 0} backgroundColor={bg} width="100%">
        <Text dimColor>
          {TEARDROP_ASTERISK} {String(message.content ?? '')}
        </Text>
      </Box>
    );
  }

  if (message.subtype === 'permission_retry') {
    return (
      <Box marginTop={addMargin ? 1 : 0} backgroundColor={bg} width="100%">
        <Text dimColor>{TEARDROP_ASTERISK} </Text>
        <Text>已允许 </Text>
        <Text bold>{(message.commands as string[]).join(', ')}</Text>
      </Box>
    );
  }

  // Stop hook 摘要应始终可见
  const isStopHookSummary = message.subtype === 'stop_hook_summary';

  if (!isStopHookSummary && !verbose && message.level === 'info') {
    return null;
  }

  if (message.subtype === 'api_error') {
    return <SystemAPIErrorMessage message={message} verbose={verbose} />;
  }

  if (message.subtype === 'stop_hook_summary') {
    return (
      <StopHookSummaryMessage
        message={message as SystemStopHookSummaryMessage}
        addMargin={addMargin}
        verbose={verbose}
        isTranscriptMode={isTranscriptMode}
      />
    );
  }

  const content = message.content;
  // 以防 event 没有 content
  // 校验，所以尽管类型如此，content 在运行时可能是 undefined。
  if (typeof content !== 'string') {
    return null;
  }
  return (
    <Box flexDirection="row" width="100%">
      <SystemTextMessageInner
        content={content}
        addMargin={addMargin}
        dot={message.level !== 'info'}
        color={message.level === 'warning' ? 'warning' : undefined}
        dimColor={message.level === 'info'}
      />
    </Box>
  );
}

function StopHookSummaryMessage({
  message,
  addMargin,
  verbose,
  isTranscriptMode,
}: {
  message: SystemStopHookSummaryMessage;
  addMargin: boolean;
  verbose: boolean;
  isTranscriptMode?: boolean;
}): React.ReactNode {
  const bg = useSelectedMessageBg();
  const { hookCount, hookInfos } = message;
  const hookErrors = (message.hookErrors ?? []) as string[];
  const preventedContinuation = message.preventedContinuation as boolean | undefined;
  const stopReason = message.stopReason as string | undefined;
  const { columns } = useTerminalSize();

  // 优先使用 wall-clock 时间（hooks 并行运行）
  const totalDurationMs = message.totalDurationMs ?? hookInfos.reduce((sum, h) => sum + (h.durationMs ?? 0), 0);
  const isAnt = process.env.USER_TYPE === 'ant';

  // 仅在有错误或 continuation 被阻止时显示摘要
  // 对于 ant：hooks 耗时 > 500ms 时也显示
  // 非 stop hooks（例如 PreToolUse）由调用方预过滤
  if (hookErrors.length === 0 && !preventedContinuation && !message.hookLabel) {
    if (!isAnt || totalDurationMs < HOOK_TIMING_DISPLAY_THRESHOLD_MS) {
      return null;
    }
  }

  const totalStr = isAnt && totalDurationMs > 0 ? ` (${formatSecondsShort(totalDurationMs)})` : '';
  // 非 stop hooks（例如 PreToolUse）渲染为没有 bullet 的子行
  if (message.hookLabel) {
    return (
      <Box flexDirection="column" width="100%">
        <Text dimColor>
          {'  ⎿  '}已运行 {hookCount} 个 {message.hookLabel} 钩子
          {totalStr}
        </Text>
        {isTranscriptMode &&
          hookInfos.map((info, idx) => {
            const durationStr =
              isAnt && info.durationMs !== undefined ? ` (${formatSecondsShort(info.durationMs)})` : '';
            return (
              <Text key={`cmd-${idx}`} dimColor>
                {'     ⎿ '}
                {info.command === 'prompt' ? `prompt: ${info.promptText || ''}` : info.command}
                {durationStr}
              </Text>
            );
          })}
      </Box>
    );
  }

  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0} backgroundColor={bg} width="100%">
      <Box minWidth={2}>
        <Text>{BLACK_CIRCLE}</Text>
      </Box>
      <Box flexDirection="column" width={columns - 10}>
        <Text>
          已运行 <Text bold>{hookCount}</Text> 个 {message.hookLabel ?? 'stop'} 钩子
          {totalStr}
          {!verbose && hookInfos.length > 0 && (
            <>
              {' '}
              <CtrlOToExpand />
            </>
          )}
        </Text>
        {verbose &&
          hookInfos.length > 0 &&
          hookInfos.map((info, idx) => {
            const durationStr =
              isAnt && info.durationMs !== undefined ? ` (${formatSecondsShort(info.durationMs)})` : '';
            return (
              <Text key={`cmd-${idx}`} dimColor>
                ⎿ &nbsp;
                {info.command === 'prompt' ? `prompt: ${info.promptText || ''}` : info.command}
                {durationStr}
              </Text>
            );
          })}
        {preventedContinuation && stopReason && (
          <Text>
            <Text dimColor>⎿ &nbsp;</Text>
            {stopReason}
          </Text>
        )}
        {hookErrors.length > 0 &&
          hookErrors.map((err, idx) => (
            <Text key={idx}>
              <Text dimColor>⎿ &nbsp;</Text>
              {message.hookLabel ?? 'Stop'} 钩子错误：{err}
            </Text>
          ))}
      </Box>
    </Box>
  );
}

function SystemTextMessageInner({
  content,
  addMargin,
  dot,
  color,
  dimColor,
}: {
  content: string;
  addMargin: boolean;
  dot: boolean;
  color?: TextProps['color'];
  dimColor?: boolean;
}): React.ReactNode {
  const { columns } = useTerminalSize();
  const bg = useSelectedMessageBg();

  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0} backgroundColor={bg} width="100%">
      {dot && (
        <Box minWidth={2}>
          <Text color={color} dimColor={dimColor}>
            {BLACK_CIRCLE}
          </Text>
        </Box>
      )}
      <Box flexDirection="column" width={columns - 10}>
        <Text color={color} dimColor={dimColor} wrap="wrap">
          {content.trim()}
        </Text>
      </Box>
    </Box>
  );
}

function TurnDurationMessage({
  message,
  addMargin,
}: {
  message: SystemTurnDurationMessage;
  addMargin: boolean;
}): React.ReactNode {
  const bg = useSelectedMessageBg();
  const [verb] = useState(() => sample(TURN_COMPLETION_VERBS) ?? '完成');
  const store = useAppStateStore();
  const [backgroundTaskSummary] = useState(() => {
    const tasks = store.getState().tasks;
    const running = (Object.values(tasks ?? {}) as TaskState[]).filter(isBackgroundTask);
    return running.length > 0 ? getPillLabel(running) : null;
  });

  const showTurnDuration = getGlobalConfig().showTurnDuration ?? true;

  const duration = formatDuration(message.durationMs as number);
  const hasBudget = message.budgetLimit !== undefined;
  const budgetSuffix = (() => {
    if (!hasBudget) return '';
    const tokens = message.budgetTokens as number;
    const limit = message.budgetLimit as number;
    const usage =
      tokens >= limit
        ? `已使用 ${formatNumber(tokens)}（最低 ${formatNumber(limit)} ${figures.tick}）`
        : `${formatNumber(tokens)} / ${formatNumber(limit)} (${Math.round((tokens / limit) * 100)}%)`;
    const nudges =
      (message.budgetNudges as number) > 0 ? ` \u00B7 ${message.budgetNudges as number} \u6B21\u63D0\u9192` : '';
    return `${showTurnDuration ? ' \u00B7 ' : ''}${usage}${nudges}`;
  })();

  if (!showTurnDuration && !hasBudget) {
    return null;
  }

  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0} backgroundColor={bg} width="100%">
      <Box minWidth={2}>
        <Text dimColor>{TEARDROP_ASTERISK}</Text>
      </Box>
      <Text dimColor>
        {showTurnDuration && `${verb} ${duration}`}
        {budgetSuffix}
        {backgroundTaskSummary && ` \u00B7 ${backgroundTaskSummary} \u4ECD\u5728\u8FD0\u884C`}
      </Text>
    </Box>
  );
}

function MemorySavedMessage({
  message,
  addMargin,
}: {
  message: SystemMemorySavedMessage;
  addMargin: boolean;
}): React.ReactNode {
  const bg = useSelectedMessageBg();
  const writtenPaths = (message.writtenPaths ?? []) as string[];
  const team = feature('TEAMMEM') ? teamMemSaved!.teamMemSavedPart(message) : null;
  const privateCount = writtenPaths.length - (team?.count ?? 0);
  const parts = [privateCount > 0 ? `${privateCount} 条记忆` : null, team?.segment as React.ReactNode].filter(Boolean);
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0} backgroundColor={bg}>
      <Box flexDirection="row">
        <Box minWidth={2}>
          <Text dimColor>{BLACK_CIRCLE}</Text>
        </Box>
        <Text>
          {(message.verb as string) ?? '\u5DF2\u4FDD\u5B58'} {parts.join(' \u00B7 ')}
        </Text>
      </Box>
      {writtenPaths.map(p => (
        <MemoryFileRow key={p} path={p} />
      ))}
    </Box>
  );
}

function MemoryFileRow({ path }: { path: string }): React.ReactNode {
  const [hover, setHover] = useState(false);
  return (
    <MessageResponse>
      <Box onClick={() => void openPath(path)} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <Text dimColor={!hover} underline={hover}>
          <FilePathLink filePath={path}>{basename(path)}</FilePathLink>
        </Text>
      </Box>
    </MessageResponse>
  );
}

function ThinkingMessage({
  message,
  addMargin,
}: {
  message: SystemThinkingMessage;
  addMargin: boolean;
}): React.ReactNode {
  const bg = useSelectedMessageBg();
  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0} backgroundColor={bg} width="100%">
      <Box minWidth={2}>
        <Text dimColor>{TEARDROP_ASTERISK}</Text>
      </Box>
      <Text dimColor>{String(message.content ?? '')}</Text>
    </Box>
  );
}

function BridgeStatusMessage({
  message,
  addMargin,
}: {
  message: SystemBridgeStatusMessage;
  addMargin: boolean;
}): React.ReactNode {
  const bg = useSelectedMessageBg();
  const url = message.url as string;
  const upgradeNudge = message.upgradeNudge as string | undefined;
  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0} backgroundColor={bg} width={999}>
      <Box minWidth={2} />
      <Box flexDirection="column">
        <Text>
          <ThemedText color="suggestion">/remote-control</ThemedText> 已激活。在 CLI 中或访问以下地址使用：
        </Text>
        <Link url={url}>{url}</Link>
        {upgradeNudge && <Text dimColor>⎿ {upgradeNudge}</Text>}
      </Box>
    </Box>
  );
}
