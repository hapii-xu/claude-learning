import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDynamicConfig } from 'src/hooks/useDynamicConfig.js';
import { isFeedbackSurveyDisabled } from 'src/services/analytics/config.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import { isPolicyAllowed } from '../../services/policyLimits/index.js';
import type { Message } from '../../types/message.js';
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import { getLastAssistantMessage } from '../../utils/messages.js';
import { getMainLoopModel } from '../../utils/model/model.js';
import { getInitialSettings } from '../../utils/settings/settings.js';
import { logOTelEvent } from '../../utils/telemetry/events.js';
import { submitTranscriptShare, type TranscriptShareTrigger } from './submitTranscriptShare.js';
import type { TranscriptShareResponse } from './TranscriptSharePrompt.js';
import { useSurveyState } from './useSurveyState.js';
import type { FeedbackSurveyResponse, FeedbackSurveyType } from './utils.js';

type FeedbackSurveyConfig = {
  minTimeBeforeFeedbackMs: number;
  minTimeBetweenFeedbackMs: number;
  minTimeBetweenGlobalFeedbackMs: number;
  minUserTurnsBeforeFeedback: number;
  minUserTurnsBetweenFeedback: number;
  hideThanksAfterMs: number;
  onForModels: string[];
  probability: number;
};

type TranscriptAskConfig = {
  probability: number;
};

const DEFAULT_FEEDBACK_SURVEY_CONFIG: FeedbackSurveyConfig = {
  minTimeBeforeFeedbackMs: 600000,
  minTimeBetweenFeedbackMs: 3600000,
  minTimeBetweenGlobalFeedbackMs: 100000000,
  minUserTurnsBeforeFeedback: 5,
  minUserTurnsBetweenFeedback: 10,
  hideThanksAfterMs: 3000,
  onForModels: ['*'],
  probability: 0.005,
};

const DEFAULT_TRANSCRIPT_ASK_CONFIG: TranscriptAskConfig = {
  probability: 0,
};

export function useFeedbackSurvey(
  messages: Message[],
  isLoading: boolean,
  submitCount: number,
  surveyType: FeedbackSurveyType = 'session',
  hasActivePrompt: boolean = false,
): {
  state: 'closed' | 'open' | 'thanks' | 'transcript_prompt' | 'submitting' | 'submitted';
  lastResponse: FeedbackSurveyResponse | null;
  handleSelect: (selected: FeedbackSurveyResponse) => boolean;
  handleTranscriptSelect: (selected: TranscriptShareResponse) => void;
} {
  const lastAssistantMessageIdRef = useRef('unknown');
  lastAssistantMessageIdRef.current = getLastAssistantMessage(messages)?.message?.id || 'unknown';
  const [feedbackSurvey, setFeedbackSurvey] = useState<{
    timeLastShown: number | null;
    submitCountAtLastAppearance: number | null;
  }>(() => ({ timeLastShown: null, submitCountAtLastAppearance: null }));
  const config = useDynamicConfig<FeedbackSurveyConfig>('tengu_feedback_survey_config', DEFAULT_FEEDBACK_SURVEY_CONFIG);
  const badTranscriptAskConfig = useDynamicConfig<TranscriptAskConfig>(
    'tengu_bad_survey_transcript_ask_config',
    DEFAULT_TRANSCRIPT_ASK_CONFIG,
  );
  const goodTranscriptAskConfig = useDynamicConfig<TranscriptAskConfig>(
    'tengu_good_survey_transcript_ask_config',
    DEFAULT_TRANSCRIPT_ASK_CONFIG,
  );
  const settingsRate = getInitialSettings().feedbackSurveyRate;
  const sessionStartTime = useRef(Date.now());
  const submitCountAtSessionStart = useRef(submitCount);
  const submitCountRef = useRef(submitCount);
  submitCountRef.current = submitCount;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // 概率闸门：在满足资格条件时只掷一次骰，而不是每次 useMemo 重新求值都掷。
  // 若不如此，每次依赖变化（submitCount、isLoading 切换等）都会重新调用
  // Math.random()，导致在足够多次渲染后调查几乎必然出现。
  const probabilityPassedRef = useRef(false);
  const lastEligibleSubmitCountRef = useRef<number | null>(null);

  const updateLastShownTime = useCallback((timestamp: number, submitCountValue: number) => {
    setFeedbackSurvey(prev => {
      if (prev.timeLastShown === timestamp && prev.submitCountAtLastAppearance === submitCountValue) {
        return prev;
      }
      return {
        timeLastShown: timestamp,
        submitCountAtLastAppearance: submitCountValue,
      };
    });
    // 持久化跨会话节奏状态（此前由 onChangeAppState 观察者完成）
    if (getGlobalConfig().feedbackSurveyState?.lastShownTime !== timestamp) {
      saveGlobalConfig(current => ({
        ...current,
        feedbackSurveyState: {
          lastShownTime: timestamp,
        },
      }));
    }
  }, []);

  const onOpen = useCallback(
    (appearanceId: string) => {
      updateLastShownTime(Date.now(), submitCountRef.current);
      logEvent('tengu_feedback_survey_event', {
        event_type: 'appeared' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        appearance_id: appearanceId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        last_assistant_message_id:
          lastAssistantMessageIdRef.current as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        survey_type: surveyType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      void logOTelEvent('feedback_survey', {
        event_type: 'appeared',
        appearance_id: appearanceId,
        survey_type: surveyType,
      });
    },
    [updateLastShownTime, surveyType],
  );

  const onSelect = useCallback(
    (appearanceId: string, selected: FeedbackSurveyResponse) => {
      updateLastShownTime(Date.now(), submitCountRef.current);
      logEvent('tengu_feedback_survey_event', {
        event_type: 'responded' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        appearance_id: appearanceId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        response: selected as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        last_assistant_message_id:
          lastAssistantMessageIdRef.current as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        survey_type: surveyType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      void logOTelEvent('feedback_survey', {
        event_type: 'responded',
        appearance_id: appearanceId,
        response: selected,
        survey_type: surveyType,
      });
    },
    [updateLastShownTime, surveyType],
  );

  const shouldShowTranscriptPrompt = useCallback(
    (selected: FeedbackSurveyResponse) => {
      // 只有差评和好评会触发 transcript 分享询问
      if (selected !== 'bad' && selected !== 'good') {
        return false;
      }

      // 若用户之前选过"不再询问"则不显示
      if (getGlobalConfig().transcriptShareDismissed) {
        return false;
      }

      // 若产品反馈被组织策略（ZDR）阻止则不显示
      if (!isPolicyAllowed('allow_product_feedback')) {
        return false;
      }

      // 来自 GrowthBook 配置的概率闸门（按评分分别配置）
      const probability = selected === 'bad' ? badTranscriptAskConfig.probability : goodTranscriptAskConfig.probability;
      return Math.random() <= probability;
    },
    [badTranscriptAskConfig.probability, goodTranscriptAskConfig.probability],
  );

  const onTranscriptPromptShown = useCallback(
    (appearanceId: string, surveyResponse: FeedbackSurveyResponse) => {
      const trigger: TranscriptShareTrigger =
        surveyResponse === 'good' ? 'good_feedback_survey' : 'bad_feedback_survey';
      logEvent('tengu_feedback_survey_event', {
        event_type: 'transcript_prompt_appeared' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        appearance_id: appearanceId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        last_assistant_message_id:
          lastAssistantMessageIdRef.current as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        survey_type: surveyType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        trigger: trigger as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      void logOTelEvent('feedback_survey', {
        event_type: 'transcript_prompt_appeared',
        appearance_id: appearanceId,
        survey_type: surveyType,
      });
    },
    [surveyType],
  );

  const onTranscriptSelect = useCallback(
    async (
      appearanceId: string,
      selected: TranscriptShareResponse,
      surveyResponse: FeedbackSurveyResponse | null,
    ): Promise<boolean> => {
      const trigger: TranscriptShareTrigger =
        surveyResponse === 'good' ? 'good_feedback_survey' : 'bad_feedback_survey';

      logEvent('tengu_feedback_survey_event', {
        event_type: `transcript_share_${selected}` as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        appearance_id: appearanceId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        last_assistant_message_id:
          lastAssistantMessageIdRef.current as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        survey_type: surveyType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        trigger: trigger as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });

      if (selected === 'dont_ask_again') {
        saveGlobalConfig(current => ({
          ...current,
          transcriptShareDismissed: true,
        }));
      }

      if (selected === 'yes') {
        const result = await submitTranscriptShare(messagesRef.current, trigger, appearanceId);
        logEvent('tengu_feedback_survey_event', {
          event_type: (result.success
            ? 'transcript_share_submitted'
            : 'transcript_share_failed') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          appearance_id: appearanceId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          trigger: trigger as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
        return result.success;
      }

      return false;
    },
    [surveyType],
  );

  const { state, lastResponse, open, handleSelect, handleTranscriptSelect } = useSurveyState({
    hideThanksAfterMs: config.hideThanksAfterMs,
    onOpen,
    onSelect,
    shouldShowTranscriptPrompt,
    onTranscriptPromptShown,
    onTranscriptSelect,
  });

  const currentModel = getMainLoopModel();
  const isModelAllowed = useMemo(() => {
    if (config.onForModels.length === 0) {
      return false;
    }
    if (config.onForModels.includes('*')) {
      return true;
    }
    return config.onForModels.includes(currentModel);
  }, [config.onForModels, currentModel]);

  const shouldOpen = useMemo(() => {
    if (state !== 'closed') {
      return false;
    }

    if (isLoading) {
      return false;
    }

    // 当权限或提问 prompt 可见时不显示调查
    if (hasActivePrompt) {
      return false;
    }

    // 测试时强制显示
    if (process.env.CLAUDE_FORCE_DISPLAY_SURVEY && !feedbackSurvey.timeLastShown) {
      return true;
    }

    if (!isModelAllowed) {
      return false;
    }

    if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY)) {
      return false;
    }

    if (isFeedbackSurveyDisabled()) {
      return false;
    }

    // 检查组织策略是否允许产品反馈
    if (!isPolicyAllowed('allow_product_feedback')) {
      return false;
    }

    // 检查会话内节奏
    if (feedbackSurvey.timeLastShown) {
      // 检查距本会话上次出现的经过时间
      const timeSinceLastShown = Date.now() - feedbackSurvey.timeLastShown;
      if (timeSinceLastShown < config.minTimeBetweenFeedbackMs) {
        return false;
      }
      // 检查后续出现所需的用户轮次
      if (
        feedbackSurvey.submitCountAtLastAppearance !== null &&
        submitCount < feedbackSurvey.submitCountAtLastAppearance + config.minUserTurnsBetweenFeedback
      ) {
        return false;
      }
    } else {
      // 本会话首次出现
      const timeSinceSessionStart = Date.now() - sessionStartTime.current;
      if (timeSinceSessionStart < config.minTimeBeforeFeedbackMs) {
        return false;
      }
      if (submitCount < submitCountAtSessionStart.current + config.minUserTurnsBeforeFeedback) {
        return false;
      }
    }

    // 概率检查：每个资格窗口只掷一次骰，避免每次 useMemo 重新求值都
    // 重新掷骰（否则会使得触发近乎必然）。
    if (lastEligibleSubmitCountRef.current !== submitCount) {
      lastEligibleSubmitCountRef.current = submitCount;
      probabilityPassedRef.current = Math.random() <= (settingsRate ?? config.probability);
    }
    if (!probabilityPassedRef.current) {
      return false;
    }

    // 检查全局节奏（跨所有会话）
    // 放到最后才检查，因为它需要读取文件系统，代价较高。
    const globalFeedbackState = getGlobalConfig().feedbackSurveyState;
    if (globalFeedbackState?.lastShownTime) {
      const timeSinceGlobalLastShown = Date.now() - globalFeedbackState.lastShownTime;
      if (timeSinceGlobalLastShown < config.minTimeBetweenGlobalFeedbackMs) {
        return false;
      }
    }

    return true;
  }, [
    state,
    isLoading,
    hasActivePrompt,
    isModelAllowed,
    feedbackSurvey.timeLastShown,
    feedbackSurvey.submitCountAtLastAppearance,
    submitCount,
    config.minTimeBetweenFeedbackMs,
    config.minTimeBetweenGlobalFeedbackMs,
    config.minUserTurnsBetweenFeedback,
    config.minTimeBeforeFeedbackMs,
    config.minUserTurnsBeforeFeedback,
    config.probability,
    settingsRate,
  ]);

  useEffect(() => {
    if (shouldOpen) {
      open();
    }
  }, [shouldOpen, open]);

  return { state, lastResponse, handleSelect, handleTranscriptSelect };
}
