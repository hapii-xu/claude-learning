import type { UUID } from 'crypto';
import React, { useCallback } from 'react';
import { Box, Text, Byline, KeyboardShortcutHint, LoadingState } from '@anthropic/ink';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { getAllBaseTools } from '../tools.js';
import type { LogOption } from '../types/logs.js';
import { formatRelativeTimeAgo } from '../utils/format.js';
import { getSessionIdFromLog, isLiteLog, loadFullLog } from '../utils/sessionStorage.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Messages } from './Messages.js';

type Props = {
  log: LogOption;
  onExit: () => void;
  onSelect: (log: LogOption) => void;
};

export function SessionPreview({ log, onExit, onSelect }: Props): React.ReactNode {
  // fullLog 保存带有已加载 messages 的完整日志。
  // 传入的 `log` 可能是一个 "lite log"（messages 数组为空），
  // 所以我们在挂载时加载完整 messages 并存储在这里。
  const [fullLog, setFullLog] = React.useState<LogOption | null>(null);

  // 如果是 lite log，则加载完整的 messages
  React.useEffect(() => {
    setFullLog(null);
    if (isLiteLog(log)) {
      void loadFullLog(log).then(setFullLog);
    }
  }, [log]);

  const isLoading = isLiteLog(log) && fullLog === null;
  const displayLog = fullLog ?? log;
  const conversationId = getSessionIdFromLog(displayLog) || ('' as UUID);

  // 为预览获取所有 base tools（只读视图不需要权限）
  const tools = getAllBaseTools();

  // 通过 keybindings 处理键盘输入
  useKeybinding('confirm:no', onExit, { context: 'Confirmation' });

  const handleSelect = useCallback(() => {
    onSelect(fullLog ?? log);
  }, [onSelect, fullLog, log]);

  useKeybinding('confirm:yes', handleSelect, { context: 'Confirmation' });

  // 获取完整日志时显示加载状态
  if (isLoading) {
    return (
      <Box flexDirection="column" padding={1}>
        <LoadingState message="正在加载会话…" />
        <Text dimColor>
          <Byline>
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />
          </Byline>
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Messages
        messages={displayLog.messages}
        tools={tools}
        commands={[]}
        verbose={true}
        toolJSX={null}
        toolUseConfirmQueue={[]}
        inProgressToolUseIDs={new Set()}
        isMessageSelectorVisible={false}
        conversationId={conversationId}
        screen="transcript"
        streamingToolUses={[]}
        showAllInTranscript={true}
        isLoading={false}
      />
      <Box
        flexShrink={0}
        flexDirection="column"
        borderTopDimColor
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        borderStyle="single"
        paddingLeft={2}
      >
        <Text>
          {formatRelativeTimeAgo(displayLog.modified)} · {displayLog.messageCount} 条消息
          {displayLog.gitBranch ? ` · ${displayLog.gitBranch}` : ''}
        </Text>
        <Text dimColor>
          <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="resume" />
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />
          </Byline>
        </Text>
      </Box>
    </Box>
  );
}
