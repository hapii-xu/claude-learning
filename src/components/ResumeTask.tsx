import React, { useCallback, useState } from 'react';
import { useTerminalSize } from 'src/hooks/useTerminalSize.js';
import { type CodeSession, fetchCodeSessionsFromSessionsAPI } from 'src/utils/teleport/api.js';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- raw j/k/arrow list navigation
import { Box, Text, useInput } from '@anthropic/ink';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js';
import { logForDebugging } from '../utils/debug.js';
import { detectCurrentRepository } from '../utils/detectRepository.js';
import { formatRelativeTime } from '../utils/format.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Select } from './CustomSelect/index.js';
import { Byline, KeyboardShortcutHint } from '@anthropic/ink';
import { Spinner } from './Spinner.js';
import { TeleportError } from './TeleportError.js';

type Props = {
  onSelect: (session: CodeSession) => void;
  onCancel: () => void;
  isEmbedded?: boolean;
};

type LoadErrorType = 'network' | 'auth' | 'api' | 'other';

const UPDATED_STRING = 'Updated';
const SPACE_BETWEEN_TABLE_COLUMNS = '  ';

export function ResumeTask({ onSelect, onCancel, isEmbedded = false }: Props): React.ReactNode {
  const { rows } = useTerminalSize();
  const [sessions, setSessions] = useState<CodeSession[]>([]);
  const [currentRepo, setCurrentRepo] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadErrorType, setLoadErrorType] = useState<LoadErrorType | null>(null);
  const [retrying, setRetrying] = useState(false);

  const [hasCompletedTeleportErrorFlow, setHasCompletedTeleportErrorFlow] = useState(false);

  // 跟踪 focused index 以在标题中显示滚动位置
  const [focusedIndex, setFocusedIndex] = useState(1);

  const escKey = useShortcutDisplay('confirm:no', 'Confirmation', 'Esc');

  const loadSessions = useCallback(async () => {
    try {
      setLoading(true);
      setLoadErrorType(null);

      // 检测当前仓库
      const detectedRepo = await detectCurrentRepository();
      setCurrentRepo(detectedRepo);
      logForDebugging(`Current repository: ${detectedRepo || 'not detected'}`);

      const codeSessions = await fetchCodeSessionsFromSessionsAPI();

      // 如果检测到当前仓库，则按仓库过滤会话
      let filteredSessions = codeSessions;
      if (detectedRepo) {
        filteredSessions = codeSessions.filter(session => {
          if (!session.repo) return false;
          const sessionRepo = `${session.repo.owner.login}/${session.repo.name}`;
          return sessionRepo === detectedRepo;
        });
        logForDebugging(
          `Filtered ${filteredSessions.length} sessions for repo ${detectedRepo} from ${codeSessions.length} total`,
        );
      }

      // 按 updated_at 排序（最新的在前）
      const sortedSessions = [...filteredSessions].sort((a, b) => {
        const dateA = new Date(a.updated_at);
        const dateB = new Date(b.updated_at);
        return dateB.getTime() - dateA.getTime();
      });

      setSessions(sortedSessions);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logForDebugging(`Error loading code sessions: ${errorMessage}`);
      setLoadErrorType(determineErrorType(errorMessage));
    } finally {
      setLoading(false);
      setRetrying(false);
    }
  }, []);

  const handleRetry = () => {
    setRetrying(true);
    void loadSessions();
  };

  // 通过 keybinding 处理 escape
  useKeybinding('confirm:no', onCancel, { context: 'Confirmation' });

  useInput((input, key) => {
    // 在没有渲染 <Select> 的情况下需要处理 ctrl+c
    if (key.ctrl && input === 'c') {
      onCancel();
      return;
    }

    // 在错误状态下用 'ctrl+r' 处理重试
    if (key.ctrl && input === 'r' && loadErrorType) {
      handleRetry();
      return;
    }

    // 处理错误状态下的 Enter 键，允许继续使用常规 teleport 流程
    if (loadErrorType !== null && key.return) {
      onCancel(); // 这会继续使用常规 teleport 流程
      return;
    }
  });

  const handleErrorComplete = useCallback(() => {
    setHasCompletedTeleportErrorFlow(true);
    void loadSessions();
  }, [setHasCompletedTeleportErrorFlow, loadSessions]);

  // 如有需要则显示错误对话框
  if (!hasCompletedTeleportErrorFlow) {
    return <TeleportError onComplete={handleErrorComplete} />;
  }

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box flexDirection="row">
          <Spinner />
          <Text bold>正在加载 Claude Code 会话…</Text>
        </Box>
        <Text dimColor>{retrying ? '正在重试…' : '正在获取你的 Claude Code 会话…'}</Text>
      </Box>
    );
  }

  if (loadErrorType) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="error">
          加载 Claude Code 会话失败
        </Text>

        {renderErrorSpecificGuidance(loadErrorType)}

        <Text dimColor>
          按 <Text bold>Ctrl+R</Text> 重试 · 按 <Text bold>{escKey}</Text> 取消
        </Text>
      </Box>
    );
  }

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>
          未找到 Claude Code 会话
          {currentRepo && <Text>（{currentRepo}）</Text>}
        </Text>
        <Box marginTop={1}>
          <Text dimColor>
            按 <Text bold>{escKey}</Text> 取消
          </Text>
        </Box>
      </Box>
    );
  }

  const sessionMetadata = sessions.map(session => ({
    ...session,
    timeString: formatRelativeTime(new Date(session.updated_at)),
  }));
  const maxTimeStringLength = Math.max(UPDATED_STRING.length, ...sessionMetadata.map(meta => meta.timeString.length));

  const options = sessionMetadata.map(({ timeString, title, id }) => {
    const paddedTime = timeString.padEnd(maxTimeStringLength, ' ');

    // TODO: 等 API 返回后加入分支名
    return {
      label: `${paddedTime}  ${title}`,
      value: id,
    };
  });

  // 为嵌入式与全屏渲染调整布局
  // 开销：padding (2) + 标题 (1) + marginY (2) + header (1) + footer (1) = 7
  const layoutOverhead = 7;
  const maxVisibleOptions = Math.max(
    1,
    isEmbedded
      ? Math.min(sessions.length, 5, rows - 6 - layoutOverhead)
      : Math.min(sessions.length, rows - 1 - layoutOverhead),
  );
  const maxHeight = maxVisibleOptions + layoutOverhead;

  // 列表需要滚动时在标题中显示滚动位置
  const showScrollPosition = sessions.length > maxVisibleOptions;

  return (
    <Box flexDirection="column" padding={1} height={maxHeight}>
      <Text bold>
        选择要恢复的会话
        {showScrollPosition && (
          <Text dimColor>
            {' '}
            （第 {focusedIndex} 个，共 {sessions.length} 个）
          </Text>
        )}
        {currentRepo && <Text dimColor> （{currentRepo}）</Text>}：
      </Text>
      <Box flexDirection="column" marginTop={1} flexGrow={1}>
        <Box marginLeft={2}>
          <Text bold>
            {UPDATED_STRING.padEnd(maxTimeStringLength, ' ')}
            {SPACE_BETWEEN_TABLE_COLUMNS}
            {'会话标题'}
          </Text>
        </Box>
        <Select
          visibleOptionCount={maxVisibleOptions}
          options={options}
          onChange={value => {
            const session = sessions.find(s => s.id === value);
            if (session) {
              onSelect(session);
            }
          }}
          onFocus={value => {
            const index = options.findIndex(o => o.value === value);
            if (index >= 0) {
              setFocusedIndex(index + 1);
            }
          }}
        />
      </Box>
      <Box flexDirection="row">
        <Text dimColor>
          <Byline>
            <KeyboardShortcutHint shortcut="↑/↓" action="select" />
            <KeyboardShortcutHint shortcut="Enter" action="confirm" />
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />
          </Byline>
        </Text>
      </Box>
    </Box>
  );
}

/**
 * 根据错误消息判断错误类型
 */
function determineErrorType(errorMessage: string): LoadErrorType {
  const message = errorMessage.toLowerCase();

  if (message.includes('fetch') || message.includes('network') || message.includes('timeout')) {
    return 'network';
  }

  if (
    message.includes('auth') ||
    message.includes('token') ||
    message.includes('permission') ||
    message.includes('oauth') ||
    message.includes('not authenticated') ||
    message.includes('/login') ||
    message.includes('console account') ||
    message.includes('403')
  ) {
    return 'auth';
  }

  if (message.includes('api') || message.includes('rate limit') || message.includes('500') || message.includes('529')) {
    return 'api';
  }

  return 'other';
}

/**
 * 渲染针对特定错误的排障指引
 */
function renderErrorSpecificGuidance(errorType: LoadErrorType): React.ReactNode {
  switch (errorType) {
    case 'network':
      return (
        <Box marginY={1} flexDirection="column">
          <Text dimColor>请检查你的网络连接</Text>
        </Box>
      );

    case 'auth':
      return (
        <Box marginY={1} flexDirection="column">
          <Text dimColor>Teleport 需要一个 Claude 账户</Text>
          <Text dimColor>
            运行 <Text bold>/login</Text> 并选择 &quot;带订阅的 Claude 账户&quot;
          </Text>
        </Box>
      );

    case 'api':
      return (
        <Box marginY={1} flexDirection="column">
          <Text dimColor>抱歉，Claude 遇到了一个错误</Text>
        </Box>
      );

    case 'other':
      return (
        <Box marginY={1} flexDirection="row">
          <Text dimColor>抱歉，Claude Code 遇到了一个错误</Text>
        </Box>
      );
  }
}
