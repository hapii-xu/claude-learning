import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import { KeyboardShortcutHint } from '@anthropic/ink';
import { Spinner } from '../../components/Spinner.js';
import TextInput from '../../components/TextInput.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { type KeyboardEvent, setClipboard, Box, Link, Text } from '@anthropic/ink';
import { OAuthService } from '../../services/oauth/index.js';
import { saveOAuthTokensIfNeeded } from '../../utils/auth.js';
import { logError } from '../../utils/log.js';

interface OAuthFlowStepProps {
  onSuccess: (token: string) => void;
  onCancel: () => void;
}

type OAuthStatus =
  | { state: 'starting' }
  | { state: 'waiting_for_login'; url: string }
  | { state: 'processing' }
  | { state: 'success'; token: string }
  | { state: 'error'; message: string; toRetry?: OAuthStatus }
  | { state: 'about_to_retry'; nextState: OAuthStatus };

const PASTE_HERE_MSG = 'Paste code here if prompted > ';

export function OAuthFlowStep({ onSuccess, onCancel }: OAuthFlowStepProps): React.ReactNode {
  const [oauthStatus, setOAuthStatus] = useState<OAuthStatus>({
    state: 'starting',
  });
  const [oauthService] = useState(() => new OAuthService());
  const [pastedCode, setPastedCode] = useState('');
  const [cursorOffset, setCursorOffset] = useState(0);
  const [showPastePrompt, setShowPastePrompt] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const timersRef = useRef<Set<NodeJS.Timeout>>(new Set());
  // 独立的 ref，避免 startOAuth 清理定时器时把 urlCopied 的重置也取消
  const urlCopiedTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);

  const terminalSize = useTerminalSize();
  const textInputColumns = Math.max(50, terminalSize.columns - PASTE_HERE_MSG.length - 4);

  function handleKeyDown(e: KeyboardEvent): void {
    if (oauthStatus.state !== 'error') return;
    e.preventDefault();
    if (e.key === 'return' && oauthStatus.toRetry) {
      setPastedCode('');
      setCursorOffset(0);
      setOAuthStatus({
        state: 'about_to_retry',
        nextState: oauthStatus.toRetry,
      });
    } else {
      onCancel();
    }
  }

  async function handleSubmitCode(value: string, url: string) {
    try {
      // 期望的格式来自授权回调 URL： "authorizationCode#state"
      const [authorizationCode, state] = value.split('#');

      if (!authorizationCode || !state) {
        setOAuthStatus({
          state: 'error',
          message: 'Invalid code. Please make sure the full code was copied',
          toRetry: { state: 'waiting_for_login', url },
        });
        return;
      }

      // 记录用户走的哪条路径（手动输入 code）
      logEvent('tengu_oauth_manual_entry', {});
      oauthService.handleManualAuthCodeInput({
        authorizationCode,
        state,
      });
    } catch (err: unknown) {
      logError(err);
      setOAuthStatus({
        state: 'error',
        message: (err as Error).message,
        toRetry: { state: 'waiting_for_login', url },
      });
    }
  }

  const startOAuth = useCallback(async () => {
    // 启动新的 OAuth 流程时，清理所有现有定时器
    timersRef.current.forEach(timer => clearTimeout(timer));
    timersRef.current.clear();

    try {
      const result = await oauthService.startOAuthFlow(
        async url => {
          setOAuthStatus({ state: 'waiting_for_login', url });
          const timer = setTimeout(setShowPastePrompt, 3000, true);
          timersRef.current.add(timer);
        },
        {
          loginWithClaudeAi: true, // 订阅 token 始终使用 Claude AI
          inferenceOnly: true,
          expiresIn: 365 * 24 * 60 * 60, // 1 年
        },
      );

      // 显示处理中状态
      setOAuthStatus({ state: 'processing' });

      // OAuthFlowStep 为 GitHub Actions 创建仅推理 token，并非替代登录。
      // 直接使用 saveOAuthTokensIfNeeded，避免 performLogout 会破坏用户已有的认证会话。
      saveOAuthTokensIfNeeded(result);

      // 对于 OAuth 流程，访问 token 可直接当作 API key 使用
      const timer1 = setTimeout(
        (setOAuthStatus, accessToken, onSuccess, timersRef) => {
          setOAuthStatus({ state: 'success', token: accessToken });
          // 展示成功状态后短暂延迟并自动继续
          const timer2 = setTimeout(onSuccess, 1000, accessToken);
          timersRef.current.add(timer2 as unknown as NodeJS.Timeout);
        },
        100,
        setOAuthStatus,
        result.accessToken,
        onSuccess,
        timersRef,
      );
      timersRef.current.add(timer1);
    } catch (err) {
      const errorMessage = (err as Error).message;
      setOAuthStatus({
        state: 'error',
        message: errorMessage,
        toRetry: { state: 'starting' }, // 允许通过重新启动 OAuth 流程来重试
      });
      logError(err);
      logEvent('tengu_oauth_error', {
        error: errorMessage as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
    }
  }, [oauthService, onSuccess]);

  useEffect(() => {
    if (oauthStatus.state === 'starting') {
      void startOAuth();
    }
  }, [oauthStatus.state, startOAuth]);

  // 重试逻辑
  useEffect(() => {
    if (oauthStatus.state === 'about_to_retry') {
      const timer = setTimeout(
        (nextState, setShowPastePrompt, setOAuthStatus) => {
          // 仅在重试进入 waiting_for_login 状态时显示粘贴提示
          setShowPastePrompt(nextState.state === 'waiting_for_login');
          setOAuthStatus(nextState);
        },
        500,
        oauthStatus.nextState,
        setShowPastePrompt,
        setOAuthStatus,
      );
      timersRef.current.add(timer);
    }
  }, [oauthStatus]);

  useEffect(() => {
    if (pastedCode === 'c' && oauthStatus.state === 'waiting_for_login' && showPastePrompt && !urlCopied) {
      void setClipboard(oauthStatus.url).then(raw => {
        if (raw) process.stdout.write(raw);
        setUrlCopied(true);
        clearTimeout(urlCopiedTimerRef.current);
        urlCopiedTimerRef.current = setTimeout(setUrlCopied, 2000, false);
      });
      setPastedCode('');
    }
  }, [pastedCode, oauthStatus, showPastePrompt, urlCopied]);

  // 组件卸载时清理 OAuth service 和定时器
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      oauthService.cleanup();
      // 清理所有定时器
      timers.forEach(timer => clearTimeout(timer));
      timers.clear();
      clearTimeout(urlCopiedTimerRef.current);
    };
  }, [oauthService]);

  // 辅助函数：渲染合适的状态消息
  function renderStatusMessage(): React.ReactNode {
    switch (oauthStatus.state) {
      case 'starting':
        return (
          <Box>
            <Spinner />
            <Text>Starting authentication…</Text>
          </Box>
        );

      case 'waiting_for_login':
        return (
          <Box flexDirection="column" gap={1}>
            {!showPastePrompt && (
              <Box>
                <Spinner />
                <Text>Opening browser to sign in with your Claude account…</Text>
              </Box>
            )}

            {showPastePrompt && (
              <Box>
                <Text>{PASTE_HERE_MSG}</Text>
                <TextInput
                  value={pastedCode}
                  onChange={setPastedCode}
                  onSubmit={(value: string) => handleSubmitCode(value, oauthStatus.url)}
                  cursorOffset={cursorOffset}
                  onChangeCursorOffset={setCursorOffset}
                  columns={textInputColumns}
                />
              </Box>
            )}
          </Box>
        );

      case 'processing':
        return (
          <Box>
            <Spinner />
            <Text>Processing authentication…</Text>
          </Box>
        );

      case 'success':
        return (
          <Box flexDirection="column" gap={1}>
            <Text color="success">✓ Authentication token created successfully!</Text>
            <Text dimColor>Using token for GitHub Actions setup…</Text>
          </Box>
        );

      case 'error':
        return (
          <Box flexDirection="column" gap={1}>
            <Text color="error">OAuth error: {oauthStatus.message}</Text>
            {oauthStatus.toRetry ? (
              <Text dimColor>Press Enter to try again, or any other key to cancel</Text>
            ) : (
              <Text dimColor>Press any key to return to API key selection</Text>
            )}
          </Box>
        );

      case 'about_to_retry':
        return (
          <Box flexDirection="column" gap={1}>
            <Text color="permission">Retrying…</Text>
          </Box>
        );

      default:
        return null;
    }
  }

  return (
    <Box flexDirection="column" gap={1} tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      {/* 仅在初始 starting 状态时内联显示 header */}
      {oauthStatus.state === 'starting' && (
        <Box flexDirection="column" gap={1} paddingBottom={1}>
          <Text bold>Create Authentication Token</Text>
          <Text dimColor>Creating a long-lived token for GitHub Actions</Text>
        </Box>
      )}
      {/* 非 starting 状态显示 header（避免与内联 header 重复）*/}
      {oauthStatus.state !== 'success' && oauthStatus.state !== 'starting' && oauthStatus.state !== 'processing' && (
        <Box key="header" flexDirection="column" gap={1} paddingBottom={1}>
          <Text bold>Create Authentication Token</Text>
          <Text dimColor>Creating a long-lived token for GitHub Actions</Text>
        </Box>
      )}
      {/* 粘贴提示可见时显示 URL */}
      {oauthStatus.state === 'waiting_for_login' && showPastePrompt && (
        <Box flexDirection="column" key="urlToCopy" gap={1} paddingBottom={1}>
          <Box paddingX={1}>
            <Text dimColor>Browser didn&apos;t open? Use the url below to sign in </Text>
            {urlCopied ? (
              <Text color="success">(Copied!)</Text>
            ) : (
              <Text dimColor>
                <KeyboardShortcutHint shortcut="c" action="copy" parens />
              </Text>
            )}
          </Box>
          <Link url={oauthStatus.url}>
            <Text dimColor>{oauthStatus.url}</Text>
          </Link>
        </Box>
      )}
      <Box paddingLeft={1} flexDirection="column" gap={1}>
        {renderStatusMessage()}
      </Box>
    </Box>
  );
}
