import { feature } from 'bun:bundle';
import * as React from 'react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { type Notification, useNotifications } from 'src/context/notifications.js';
import { logEvent } from 'src/services/analytics/index.js';
import { useAppState } from 'src/state/AppState.js';
import { useVoiceState } from '../../context/voice.js';
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js';
import { useIdeConnectionStatus } from '../../hooks/useIdeConnectionStatus.js';
import type { IDESelection } from '../../hooks/useIdeSelection.js';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { useVoiceEnabled } from '../../hooks/useVoiceEnabled.js';
import { Box, Text } from '@anthropic/ink';
import { useClaudeAiLimits } from '../../services/claudeAiLimitsHook.js';
import { calculateTokenWarningState } from '../../services/compact/autoCompact.js';
import type { MCPServerConnection } from '../../services/mcp/types.js';
import type { Message } from '../../types/message.js';
import { getApiKeyHelperElapsedMs, getConfiguredApiKeyHelper, getSubscriptionType } from '../../utils/auth.js';
import type { AutoUpdaterResult } from '../../utils/autoUpdater.js';
import { getExternalEditor } from '../../utils/editor.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import { formatDuration } from '../../utils/format.js';
import { setEnvHookNotifier } from '../../utils/hooks/fileChangedWatcher.js';
import { toIDEDisplayName } from '../../utils/ide.js';
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js';
import { tokenCountFromLastAPIResponse } from '../../utils/tokens.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { IdeStatusIndicator } from '../IdeStatusIndicator.js';
import { MemoryUsageIndicator } from '../MemoryUsageIndicator.js';
import { SentryErrorBoundary } from '../SentryErrorBoundary.js';
import { TokenWarning } from '../TokenWarning.js';
import { SandboxPromptFooterHint } from './SandboxPromptFooterHint.js';

/* eslint-disable @typescript-eslint/no-require-imports */
const VoiceIndicator: typeof import('./VoiceIndicator.js').VoiceIndicator = feature('VOICE_MODE')
  ? require('./VoiceIndicator.js').VoiceIndicator
  : () => null;
/* eslint-enable @typescript-eslint/no-require-imports */

export const FOOTER_TEMPORARY_STATUS_TIMEOUT = 5000;

type Props = {
  apiKeyStatus: VerificationStatus;
  autoUpdaterResult: AutoUpdaterResult | null;
  isAutoUpdating: boolean;
  debug: boolean;
  verbose: boolean;
  messages: Message[];
  onAutoUpdaterResult: (result: AutoUpdaterResult) => void;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  ideSelection: IDESelection | undefined;
  mcpClients?: MCPServerConnection[];
  isInputWrapped?: boolean;
  isNarrow?: boolean;
};

export function Notifications({
  apiKeyStatus,
  autoUpdaterResult: _autoUpdaterResult,
  debug,
  isAutoUpdating: _isAutoUpdating,
  verbose,
  messages,
  onAutoUpdaterResult: _onAutoUpdaterResult,
  onChangeIsUpdating: _onChangeIsUpdating,
  ideSelection,
  mcpClients,
  isInputWrapped = false,
  isNarrow = false,
}: Props): ReactNode {
  const tokenUsage = useMemo(() => {
    const messagesForTokenCount = getMessagesAfterCompactBoundary(messages);
    return tokenCountFromLastAPIResponse(messagesForTokenCount);
  }, [messages]);

  // 来自 AppState 的模型 —— 与 API 请求使用相同来源。getMainLoopModel()
  // 每次调用都会重新读取 settings.json，因此另一个会话的 /model 写入
  // 会泄漏到本会话的显示中（anthropics/claude-code#37596）。
  const mainLoopModel = useMainLoopModel();
  const isShowingCompactMessage = calculateTokenWarningState(tokenUsage, mainLoopModel).isAboveWarningThreshold;
  const { status: ideStatus } = useIdeConnectionStatus(mcpClients);
  const notifications = useAppState(s => s.notifications);
  const { addNotification, removeNotification } = useNotifications();
  const claudeAiLimits = useClaudeAiLimits();

  // 注册 env hook 通知器，用于 CwdChanged/FileChanged 的反馈
  useEffect(() => {
    setEnvHookNotifier((text, isError) => {
      addNotification({
        key: 'env-hook',
        text,
        color: isError ? 'error' : undefined,
        priority: isError ? 'medium' : 'low',
        timeoutMs: isError ? 8000 : 5000,
      });
    });
    return () => setEnvHookNotifier(null);
  }, [addNotification]);

  // 检查是否应显示 IDE 选择指示器
  const shouldShowIdeSelection =
    ideStatus === 'connected' && (ideSelection?.filePath || (ideSelection?.text && ideSelection.lineCount > 0));

  // 检查是否处于超额使用模式（用于 UI 指示器）
  const isInOverageMode = claudeAiLimits.isUsingOverage;
  const subscriptionType = getSubscriptionType();
  const isTeamOrEnterprise = subscriptionType === 'team' || subscriptionType === 'enterprise';

  // 检查是否应显示外部编辑器提示
  const editor = getExternalEditor();
  const shouldShowExternalEditorHint =
    isInputWrapped &&
    !isShowingCompactMessage &&
    apiKeyStatus !== 'invalid' &&
    apiKeyStatus !== 'missing' &&
    editor !== undefined;

  // 当输入换行时，以通知形式显示外部编辑器提示
  useEffect(() => {
    if (shouldShowExternalEditorHint && editor) {
      logEvent('tengu_external_editor_hint_shown', {});
      addNotification({
        key: 'external-editor-hint',
        jsx: (
          <Text dimColor>
            <ConfigurableShortcutHint
              action="chat:externalEditor"
              context="Chat"
              fallback="ctrl+g"
              description={`在 ${toIDEDisplayName(editor)} 中编辑`}
            />
          </Text>
        ),
        priority: 'immediate',
        timeoutMs: 5000,
      });
    } else {
      removeNotification('external-editor-hint');
    }
  }, [shouldShowExternalEditorHint, editor, addNotification, removeNotification]);

  return (
    <SentryErrorBoundary>
      <Box flexDirection="column" alignItems={isNarrow ? 'flex-start' : 'flex-end'} flexShrink={0} overflowX="hidden">
        <NotificationContent
          ideSelection={ideSelection}
          mcpClients={mcpClients}
          notifications={notifications}
          isInOverageMode={isInOverageMode ?? false}
          isTeamOrEnterprise={isTeamOrEnterprise}
          apiKeyStatus={apiKeyStatus}
          debug={debug}
          verbose={verbose}
          tokenUsage={tokenUsage}
          mainLoopModel={mainLoopModel}
        />
      </Box>
    </SentryErrorBoundary>
  );
}

function NotificationContent({
  ideSelection,
  mcpClients,
  notifications,
  isInOverageMode,
  isTeamOrEnterprise,
  apiKeyStatus,
  debug,
  verbose,
  tokenUsage,
  mainLoopModel,
}: {
  ideSelection: IDESelection | undefined;
  mcpClients?: MCPServerConnection[];
  notifications: {
    current: Notification | null;
    queue: Notification[];
  };
  isInOverageMode: boolean;
  isTeamOrEnterprise: boolean;
  apiKeyStatus: VerificationStatus;
  debug: boolean;
  verbose: boolean;
  tokenUsage: number;
  mainLoopModel: string;
}): ReactNode {
  // 轮询 apiKeyHelper 的运行中状态以显示「助手缓慢」提示。
  // 受配置限制 —— 大多数用户从不设置 apiKeyHelper，
  // 对他们来说此 effect 是无操作（不分配定时器）。
  const [apiKeyHelperSlow, setApiKeyHelperSlow] = useState<string | null>(null);
  useEffect(() => {
    if (!getConfiguredApiKeyHelper()) return;
    const interval = setInterval(
      (setSlow: React.Dispatch<React.SetStateAction<string | null>>) => {
        const ms = getApiKeyHelperElapsedMs();
        const next = ms >= 10_000 ? formatDuration(ms) : null;
        setSlow(prev => (next === prev ? prev : next));
      },
      1000,
      setApiKeyHelperSlow,
    );
    return () => clearInterval(interval);
  }, []);

  // 语音状态（仅在 VOICE_MODE 构建中，由 GrowthBook 在运行时控制）
  const voiceStateRaw = useVoiceState(s => s.voiceState);
  const voiceState = feature('VOICE_MODE') ? voiceStateRaw : ('idle' as const);
  const voiceEnabledRaw = useVoiceEnabled();
  const voiceEnabled = feature('VOICE_MODE') ? voiceEnabledRaw : false;
  const voiceErrorRaw = useVoiceState(s => s.voiceError);
  const voiceError = feature('VOICE_MODE') ? voiceErrorRaw : null;
  const isBriefOnlyState = useAppState(s => s.isBriefOnly);
  const isBriefOnly = feature('KAIROS') || feature('KAIROS_BRIEF') ? isBriefOnlyState : false;

  // 当语音正在录制或处理时，将所有通知替换为仅显示语音指示器。
  if (feature('VOICE_MODE') && voiceEnabled && (voiceState === 'recording' || voiceState === 'processing')) {
    return <VoiceIndicator voiceState={voiceState} />;
  }

  return (
    <>
      <IdeStatusIndicator ideSelection={ideSelection} mcpClients={mcpClients} />
      {notifications.current &&
        ('jsx' in notifications.current ? (
          <Text wrap="truncate" key={notifications.current.key}>
            {notifications.current.jsx}
          </Text>
        ) : (
          <Text color={notifications.current.color} dimColor={!notifications.current.color} wrap="truncate">
            {notifications.current.text}
          </Text>
        ))}
      {isInOverageMode && !isTeamOrEnterprise && (
        <Box>
          <Text dimColor wrap="truncate">
            正在使用额外用量
          </Text>
        </Box>
      )}
      {apiKeyHelperSlow && (
        <Box>
          <Text color="warning" wrap="truncate">
            apiKeyHelper 响应较慢{' '}
          </Text>
          <Text dimColor wrap="truncate">
            ({apiKeyHelperSlow})
          </Text>
        </Box>
      )}
      {(apiKeyStatus === 'invalid' || apiKeyStatus === 'missing') && (
        <Box>
          <Text color="error" wrap="truncate">
            {isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ? '认证失败 · 请重试' : '未登录 · 请运行 /login'}
          </Text>
        </Box>
      )}
      {debug && (
        <Box>
          <Text color="warning" wrap="truncate">
            调试模式
          </Text>
        </Box>
      )}
      {apiKeyStatus !== 'invalid' && apiKeyStatus !== 'missing' && verbose && (
        <Box>
          <Text dimColor wrap="truncate">
            {tokenUsage} tokens
          </Text>
        </Box>
      )}
      {!isBriefOnly && <TokenWarning tokenUsage={tokenUsage} model={mainLoopModel} />}
      {feature('VOICE_MODE')
        ? voiceEnabled &&
          voiceError && (
            <Box>
              <Text color="error" wrap="truncate">
                {voiceError}
              </Text>
            </Box>
          )
        : null}
      <MemoryUsageIndicator />
      <SandboxPromptFooterHint />
    </>
  );
}
