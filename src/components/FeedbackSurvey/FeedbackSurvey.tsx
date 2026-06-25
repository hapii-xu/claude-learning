import React from 'react';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import { Box, Text } from '@anthropic/ink';
import { FeedbackSurveyView, isValidResponseInput } from './FeedbackSurveyView.js';
import type { TranscriptShareResponse } from './TranscriptSharePrompt.js';
import { TranscriptSharePrompt } from './TranscriptSharePrompt.js';
import { useDebouncedDigitInput } from './useDebouncedDigitInput.js';
import type { FeedbackSurveyResponse } from './utils.js';

type Props = {
  state: 'closed' | 'open' | 'thanks' | 'transcript_prompt' | 'submitting' | 'submitted';
  lastResponse: FeedbackSurveyResponse | null;
  handleSelect: (selected: FeedbackSurveyResponse) => void;
  handleTranscriptSelect?: (selected: TranscriptShareResponse) => void;
  inputValue: string;
  setInputValue: (value: string) => void;
  onRequestFeedback?: () => void;
  message?: string;
};

export function FeedbackSurvey({
  state,
  lastResponse,
  handleSelect,
  handleTranscriptSelect,
  inputValue,
  setInputValue,
  onRequestFeedback,
  message,
}: Props): React.ReactNode {
  if (state === 'closed') {
    return null;
  }

  if (state === 'thanks') {
    return (
      <FeedbackSurveyThanks
        lastResponse={lastResponse}
        inputValue={inputValue}
        setInputValue={setInputValue}
        onRequestFeedback={onRequestFeedback}
      />
    );
  }

  if (state === 'submitted') {
    return (
      <Box marginTop={1}>
        <Text color="success">{'\u2713'} \u611f\u8c22\u60a8\u5206\u4eab\u60a8\u7684 transcript\uff01</Text>
      </Box>
    );
  }

  if (state === 'submitting') {
    return (
      <Box marginTop={1}>
        <Text dimColor>\u6b63\u5728\u5206\u4eab transcript{'\u2026'}</Text>
      </Box>
    );
  }

  if (state === 'transcript_prompt') {
    if (!handleTranscriptSelect) {
      return null;
    }
    // 当用户正在输入非响应字符时隐藏 prompt
    if (inputValue && !['1', '2', '3'].includes(inputValue)) {
      return null;
    }
    return (
      <TranscriptSharePrompt onSelect={handleTranscriptSelect} inputValue={inputValue} setInputValue={setInputValue} />
    );
  }

  // state === 'open'
  // 当用户输入的不是调查响应时隐藏调查。
  // 避免在用户输入消息时调查弹出，从而造成误提交（如 "s3cmd"）。
  if (inputValue && !isValidResponseInput(inputValue)) {
    return null;
  }

  return (
    <FeedbackSurveyView
      onSelect={handleSelect}
      inputValue={inputValue}
      setInputValue={setInputValue}
      message={message}
    />
  );
}

type ThanksProps = {
  lastResponse: FeedbackSurveyResponse | null;
  inputValue: string;
  setInputValue: (value: string) => void;
  onRequestFeedback?: () => void;
};

const isFollowUpDigit = (char: string): char is '1' => char === '1';

function FeedbackSurveyThanks({
  lastResponse,
  inputValue,
  setInputValue,
  onRequestFeedback,
}: ThanksProps): React.ReactNode {
  const showFollowUp = onRequestFeedback && lastResponse === 'good';

  // 监听 "1" 键按下以启动 /feedback
  useDebouncedDigitInput({
    inputValue,
    setInputValue,
    isValidDigit: isFollowUpDigit,
    enabled: Boolean(showFollowUp),
    once: true,
    onDigit: () => {
      logEvent('tengu_feedback_survey_event', {
        event_type: 'followup_accepted' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        response: lastResponse as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      onRequestFeedback?.();
    },
  });

  const feedbackCommand = process.env.USER_TYPE === 'ant' ? '/issue' : '/feedback';

  return (
    <Box marginTop={1} flexDirection="column">
      <Text color="success">\u611f\u8c22\u60a8\u7684\u53cd\u9988\uff01</Text>
      {showFollowUp ? (
        <Text dimColor>
          \uff08\u53ef\u9009\uff09\u6309 [<Text color="ansi:cyan">1</Text>]
          \u544a\u8bc9\u6211\u4eec\u54ea\u91cc\u505a\u5f97\u597d {' \u00b7 '}
          {feedbackCommand}
        </Text>
      ) : lastResponse === 'bad' ? (
        <Text dimColor>\u4f7f\u7528 /issue \u62a5\u544a\u6a21\u578b\u884c\u4e3a\u95ee\u9898\u3002</Text>
      ) : (
        <Text dimColor>\u968f\u65f6\u4f7f\u7528 {feedbackCommand} \u5206\u4eab\u8be6\u7ec6\u53cd\u9988\u3002</Text>
      )}
    </Box>
  );
}
