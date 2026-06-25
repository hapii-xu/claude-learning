import React, { useEffect } from 'react';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import type { TeleportRemoteResponse } from 'src/utils/conversationRecovery.js';
import type { CodeSession } from 'src/utils/teleport/api.js';
import { type TeleportSource, useTeleportResume } from '../hooks/useTeleportResume.js';
import { Box, Text } from '@anthropic/ink';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { ResumeTask } from './ResumeTask.js';
import { Spinner } from './Spinner.js';

interface TeleportResumeWrapperProps {
  onComplete: (result: TeleportRemoteResponse) => void;
  onCancel: () => void;
  onError?: (error: string, formattedMessage?: string) => void;
  isEmbedded?: boolean;
  source: TeleportSource;
}

/**
 * 管理完整 teleport 恢复流程的包装组件，
 * 包括会话选择、加载状态和错误处理
 */
export function TeleportResumeWrapper({
  onComplete,
  onCancel,
  onError,
  isEmbedded = false,
  source,
}: TeleportResumeWrapperProps): React.ReactNode {
  const { resumeSession, isResuming, error, selectedSession } = useTeleportResume(source);

  // 在 teleport 流程开始时记录日志（用于漏斗跟踪）
  useEffect(() => {
    logEvent('tengu_teleport_started', {
      source: source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
  }, [source]);

  const handleSelect = async (session: CodeSession) => {
    const result = await resumeSession(session);
    if (result) {
      onComplete(result);
    } else if (error) {
      // 如果提供了错误处理器，则使用它
      if (onError) {
        onError(error.message, error.formattedMessage);
      }
      // 否则错误将显示在 UI 中
    }
  };

  const handleCancel = () => {
    logEvent('tengu_teleport_cancelled', {});
    onCancel();
  };

  // 允许用 Esc 关闭错误状态
  useKeybinding('app:interrupt', handleCancel, {
    context: 'Global',
    isActive: !!error && !onError,
  });

  // 恢复时显示加载 spinner
  if (isResuming && selectedSession) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box flexDirection="row">
          <Spinner />
          <Text bold>正在恢复会话…</Text>
        </Box>
        <Text dimColor>正在加载 &quot;{selectedSession.title}&quot;…</Text>
      </Box>
    );
  }

  // 如果恢复时出现问题，则显示错误
  if (error && !onError) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="error">
          恢复会话失败
        </Text>
        <Text dimColor>{error.message}</Text>
        <Box marginTop={1}>
          <Text dimColor>
            按 <Text bold>Esc</Text> 取消
          </Text>
        </Box>
      </Box>
    );
  }

  return <ResumeTask onSelect={handleSelect} onCancel={handleCancel} isEmbedded={isEmbedded} />;
}
