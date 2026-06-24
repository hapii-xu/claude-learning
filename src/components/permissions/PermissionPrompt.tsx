import React, { type ReactNode, useCallback, useMemo, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import type { KeybindingAction } from '../../keybindings/types.js';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js';
import { useSetAppState } from '../../state/AppState.js';
import { type OptionWithDescription, Select } from '../CustomSelect/select.js';

export type FeedbackType = 'accept' | 'reject';

export type PermissionPromptOption<T extends string> = {
  value: T;
  label: ReactNode;
  feedbackConfig?: {
    type: FeedbackType;
    placeholder?: string;
  };
  keybinding?: KeybindingAction;
};

export type ToolAnalyticsContext = {
  toolName: string;
  isMcp: boolean;
};

export type PermissionPromptProps<T extends string> = {
  options: PermissionPromptOption<T>[];
  onSelect: (value: T, feedback?: string) => void;
  onCancel?: () => void;
  question?: string | ReactNode;
  toolAnalyticsContext?: ToolAnalyticsContext;
};

const DEFAULT_PLACEHOLDERS: Record<FeedbackType, string> = {
  accept: '告诉 Claude 接下来要做什么',
  reject: '告诉 Claude 需要做哪些不同的事',
};

/**
 * 权限提示的共享组件，支持可选的反馈输入。
 *
 * 处理：
 * - "Do you want to proceed?"（是否继续？）问题，可选 Tab 提示
 * - 反馈能力的 feature flag 检查
 * - 输入模式切换（Tab 展开/收起反馈输入）
 * - 反馈交互的分析事件
 * - 将选项转换为 Select 兼容格式
 */
export function PermissionPrompt<T extends string>({
  options,
  onSelect,
  onCancel,
  question = '是否要继续？',
  toolAnalyticsContext,
}: PermissionPromptProps<T>): React.ReactNode {
  const setAppState = useSetAppState();
  const [acceptFeedback, setAcceptFeedback] = useState('');
  const [rejectFeedback, setRejectFeedback] = useState('');
  const [acceptInputMode, setAcceptInputMode] = useState(false);
  const [rejectInputMode, setRejectInputMode] = useState(false);
  const [focusedValue, setFocusedValue] = useState<T | null>(null);
  // 追踪用户是否曾经进入过反馈模式（收起后仍保留状态）
  const [acceptFeedbackModeEntered, setAcceptFeedbackModeEntered] = useState(false);
  const [rejectFeedbackModeEntered, setRejectFeedbackModeEntered] = useState(false);

  // 查找当前聚焦的选项以及它是否有反馈配置
  const focusedOption = options.find(opt => opt.value === focusedValue);
  const focusedFeedbackType = focusedOption?.feedbackConfig?.type;

  // 当聚焦在启用了反馈但尚未进入输入模式的选项时，显示 Tab 提示
  const showTabHint =
    (focusedFeedbackType === 'accept' && !acceptInputMode) || (focusedFeedbackType === 'reject' && !rejectInputMode);

  // 将选项转换为 Select 兼容格式
  const selectOptions = useMemo((): OptionWithDescription<T>[] => {
    return options.map(opt => {
      const { value, label, feedbackConfig } = opt;

      // 无反馈配置 = 普通选项
      if (!feedbackConfig) {
        return {
          label,
          value,
        };
      }

      const { type, placeholder } = feedbackConfig;
      const isInputMode = type === 'accept' ? acceptInputMode : rejectInputMode;
      const onChange = type === 'accept' ? setAcceptFeedback : setRejectFeedback;
      const defaultPlaceholder = DEFAULT_PLACEHOLDERS[type];

      // 处于输入模式时，显示输入框
      if (isInputMode) {
        return {
          type: 'input' as const,
          label,
          value,
          placeholder: placeholder ?? defaultPlaceholder,
          onChange,
          allowEmptySubmitToCancel: true,
        };
      }

      // 不在输入模式 - 显示普通选项
      return {
        label,
        value,
      };
    });
  }, [options, acceptInputMode, rejectInputMode]);

  // 处理 Tab 键以切换输入模式
  const handleInputModeToggle = useCallback(
    (value: T) => {
      const option = options.find(opt => opt.value === value);
      if (!option?.feedbackConfig) return;

      const { type } = option.feedbackConfig;
      const analyticsProps = {
        toolName: toolAnalyticsContext?.toolName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        isMcp: toolAnalyticsContext?.isMcp ?? false,
      };

      if (type === 'accept') {
        if (acceptInputMode) {
          setAcceptInputMode(false);
          logEvent('tengu_accept_feedback_mode_collapsed', analyticsProps);
        } else {
          setAcceptInputMode(true);
          setAcceptFeedbackModeEntered(true);
          logEvent('tengu_accept_feedback_mode_entered', analyticsProps);
        }
      } else if (type === 'reject') {
        if (rejectInputMode) {
          setRejectInputMode(false);
          logEvent('tengu_reject_feedback_mode_collapsed', analyticsProps);
        } else {
          setRejectInputMode(true);
          setRejectFeedbackModeEntered(true);
          logEvent('tengu_reject_feedback_mode_entered', analyticsProps);
        }
      }
    },
    [options, acceptInputMode, rejectInputMode, toolAnalyticsContext],
  );

  // 处理选择
  const handleSelect = useCallback(
    (value: T) => {
      const option = options.find(opt => opt.value === value);
      if (!option) return;

      // 如适用，获取反馈
      let feedback: string | undefined;
      if (option.feedbackConfig) {
        const rawFeedback = option.feedbackConfig.type === 'accept' ? acceptFeedback : rejectFeedback;
        const trimmedFeedback = rawFeedback.trim();

        if (trimmedFeedback) {
          feedback = trimmedFeedback;
        }

        // 记录 accept/reject 提交及反馈上下文
        const analyticsProps = {
          toolName: toolAnalyticsContext?.toolName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          isMcp: toolAnalyticsContext?.isMcp ?? false,
          has_instructions: !!trimmedFeedback,
          instructions_length: trimmedFeedback?.length ?? 0,
          entered_feedback_mode:
            option.feedbackConfig.type === 'accept' ? acceptFeedbackModeEntered : rejectFeedbackModeEntered,
        };

        if (option.feedbackConfig.type === 'accept') {
          logEvent('tengu_accept_submitted', analyticsProps);
        } else if (option.feedbackConfig.type === 'reject') {
          logEvent('tengu_reject_submitted', analyticsProps);
        }
      }

      onSelect(value, feedback);
    },
    [
      options,
      acceptFeedback,
      rejectFeedback,
      onSelect,
      toolAnalyticsContext,
      acceptFeedbackModeEntered,
      rejectFeedbackModeEntered,
    ],
  );

  // 为配置了快捷键的选项注册快捷键处理器
  const keybindingHandlers = useMemo(() => {
    const handlers: Record<string, () => void> = {};
    for (const opt of options) {
      if (opt.keybinding) {
        handlers[opt.keybinding] = () => handleSelect(opt.value);
      }
    }
    return handlers;
  }, [options, handleSelect]);

  useKeybindings(keybindingHandlers, { context: 'Confirmation' });

  // 处理取消（Esc）
  const handleCancel = useCallback(() => {
    logEvent('tengu_permission_request_escape', {});
    // 递增 Esc 计数用于归因追踪
    setAppState(prev => ({
      ...prev,
      attribution: {
        ...prev.attribution,
        escapeCount: prev.attribution.escapeCount + 1,
      },
    }));
    onCancel?.();
  }, [onCancel, setAppState]);

  return (
    <Box flexDirection="column">
      {typeof question === 'string' ? <Text>{question}</Text> : question}
      <Select
        options={selectOptions}
        inlineDescriptions
        onChange={handleSelect}
        onCancel={handleCancel}
        onFocus={value => {
          // 离开时重置输入模式，但仅当未输入文本时
          const newOption = options.find(opt => opt.value === value);
          if (newOption?.feedbackConfig?.type !== 'accept' && acceptInputMode && !acceptFeedback.trim()) {
            setAcceptInputMode(false);
          }
          if (newOption?.feedbackConfig?.type !== 'reject' && rejectInputMode && !rejectFeedback.trim()) {
            setRejectInputMode(false);
          }
          setFocusedValue(value);
        }}
        onInputModeToggle={handleInputModeToggle}
      />
      <Box marginTop={1}>
        <Text dimColor>Esc 取消{showTabHint && ' · Tab 补充说明'}</Text>
      </Box>
    </Box>
  );
}
