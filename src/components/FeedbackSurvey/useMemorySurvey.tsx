import { useCallback, useEffect, useMemo, useRef } from 'react';
import { isFeedbackSurveyDisabled } from 'src/services/analytics/config.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import { isAutoMemoryEnabled } from '../../memdir/paths.js';
import { isPolicyAllowed } from '../../services/policyLimits/index.js';
import { FILE_READ_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileReadTool/prompt.js';
import type { Message } from '../../types/message.js';
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import { isAutoManagedMemoryFile } from '../../utils/memoryFileDetection.js';
import { extractTextContent, getLastAssistantMessage } from '../../utils/messages.js';
import { logOTelEvent } from '../../utils/telemetry/events.js';
import { submitTranscriptShare } from './submitTranscriptShare.js';
import type { TranscriptShareResponse } from './TranscriptSharePrompt.js';
import { useSurveyState } from './useSurveyState.js';
import type { FeedbackSurveyResponse } from './utils.js';

const HIDE_THANKS_AFTER_MS = 3000;
const MEMORY_SURVEY_GATE = 'tengu_dunwich_bell';
const MEMORY_SURVEY_EVENT = 'tengu_memory_survey_event';
const SURVEY_PROBABILITY = 0.2;
const TRANSCRIPT_SHARE_TRIGGER = 'memory_survey';

const MEMORY_WORD_RE = /\bmemor(?:y|ies)\b/i;

function hasMemoryFileRead(messages: Message[]): boolean {
  for (const message of messages) {
    if (message.type !== 'assistant') {
      continue;
    }
    const content = message.message!.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (block.type !== 'tool_use' || block.name !== FILE_READ_TOOL_NAME) {
        continue;
      }
      const input = block.input as { file_path?: unknown };
      if (typeof input.file_path === 'string' && isAutoManagedMemoryFile(input.file_path)) {
        return true;
      }
    }
  }
  return false;
}

export function useMemorySurvey(
  messages: Message[],
  isLoading: boolean,
  hasActivePrompt = false,
  { enabled = true }: { enabled?: boolean } = {},
): {
  state: 'closed' | 'open' | 'thanks' | 'transcript_prompt' | 'submitting' | 'submitted';
  lastResponse: FeedbackSurveyResponse | null;
  handleSelect: (selected: FeedbackSurveyResponse) => void;
  handleTranscriptSelect: (selected: TranscriptShareResponse) => void;
} {
  // 追踪已评估过的 assistant 消息 UUID，避免在重新渲染时重新掷概率骰，
  // 或对同一轮重复扫描消息。
  const seenAssistantUuids = useRef<Set<string>>(new Set());
  // 一旦观察到读取 memory 文件，本会话内保持为 true ——
  // 后续轮次跳过 O(n) 扫描。
  const memoryReadSeen = useRef(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const onOpen = useCallback((appearanceId: string) => {
    logEvent(MEMORY_SURVEY_EVENT, {
      event_type: 'appeared' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      appearance_id: appearanceId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    void logOTelEvent('feedback_survey', {
      event_type: 'appeared',
      appearance_id: appearanceId,
      survey_type: 'memory',
    });
  }, []);

  const onSelect = useCallback((appearanceId: string, selected: FeedbackSurveyResponse) => {
    logEvent(MEMORY_SURVEY_EVENT, {
      event_type: 'responded' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      appearance_id: appearanceId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      response: selected as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    void logOTelEvent('feedback_survey', {
      event_type: 'responded',
      appearance_id: appearanceId,
      response: selected,
      survey_type: 'memory',
    });
  }, []);

  const shouldShowTranscriptPrompt = useCallback((selected: FeedbackSurveyResponse) => {
    if (process.env.USER_TYPE !== 'ant') {
      return false;
    }
    if (selected !== 'bad' && selected !== 'good') {
      return false;
    }
    if (getGlobalConfig().transcriptShareDismissed) {
      return false;
    }
    if (!isPolicyAllowed('allow_product_feedback')) {
      return false;
    }
    return true;
  }, []);

  const onTranscriptPromptShown = useCallback((appearanceId: string) => {
    logEvent(MEMORY_SURVEY_EVENT, {
      event_type: 'transcript_prompt_appeared' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      appearance_id: appearanceId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      trigger: TRANSCRIPT_SHARE_TRIGGER as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    void logOTelEvent('feedback_survey', {
      event_type: 'transcript_prompt_appeared',
      appearance_id: appearanceId,
      survey_type: 'memory',
    });
  }, []);

  const onTranscriptSelect = useCallback(
    async (appearanceId: string, selected: TranscriptShareResponse): Promise<boolean> => {
      logEvent(MEMORY_SURVEY_EVENT, {
        event_type: `transcript_share_${selected}` as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        appearance_id: appearanceId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        trigger: TRANSCRIPT_SHARE_TRIGGER as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });

      if (selected === 'dont_ask_again') {
        saveGlobalConfig(current => ({
          ...current,
          transcriptShareDismissed: true,
        }));
      }

      if (selected === 'yes') {
        const result = await submitTranscriptShare(messagesRef.current, TRANSCRIPT_SHARE_TRIGGER, appearanceId);
        logEvent(MEMORY_SURVEY_EVENT, {
          event_type: (result.success
            ? 'transcript_share_submitted'
            : 'transcript_share_failed') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          appearance_id: appearanceId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          trigger: TRANSCRIPT_SHARE_TRIGGER as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
        return result.success;
      }

      return false;
    },
    [],
  );

  const { state, lastResponse, open, handleSelect, handleTranscriptSelect } = useSurveyState({
    hideThanksAfterMs: HIDE_THANKS_AFTER_MS,
    onOpen,
    onSelect,
    shouldShowTranscriptPrompt,
    onTranscriptPromptShown,
    onTranscriptSelect,
  });

  const lastAssistant = useMemo(() => getLastAssistantMessage(messages), [messages]);

  useEffect(() => {
    if (!enabled) return;

    // /clear 会重置消息但 REPL 仍保持挂载 —— 重置 ref，避免上一段对话的
    // memory 读取泄漏到新对话中。
    if (messages.length === 0) {
      memoryReadSeen.current = false;
      seenAssistantUuids.current.clear();
      return;
    }

    if (state !== 'closed' || isLoading || hasActivePrompt) {
      return;
    }

    // 第三方默认：调查关闭（Bedrock/Vertex/Foundry 上没有 GrowthBook）。
    if (!getFeatureValue_CACHED_MAY_BE_STALE(MEMORY_SURVEY_GATE, false)) {
      return;
    }

    if (!isAutoMemoryEnabled()) {
      return;
    }

    if (isFeedbackSurveyDisabled()) {
      return;
    }

    if (!isPolicyAllowed('allow_product_feedback')) {
      return;
    }

    if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY)) {
      return;
    }

    if (!lastAssistant || seenAssistantUuids.current.has(lastAssistant.uuid)) {
      return;
    }

    const text = extractTextContent(
      Array.isArray(lastAssistant.message.content) ? lastAssistant.message.content : [],
      ' ',
    );
    if (!MEMORY_WORD_RE.test(text)) {
      return;
    }

    // 在 memory 读取扫描之前先标记为已评估，这样一轮里提到 "memory" 但
    // 实际没有读取 memory 时，不会在后续以相同最后一条 assistant 消息的
    // 渲染中触发重复的 O(n) 扫描。
    seenAssistantUuids.current.add(lastAssistant.uuid);

    if (!memoryReadSeen.current) {
      memoryReadSeen.current = hasMemoryFileRead(messages);
    }
    if (!memoryReadSeen.current) {
      return;
    }

    if (Math.random() < SURVEY_PROBABILITY) {
      open();
    }
  }, [enabled, state, isLoading, hasActivePrompt, lastAssistant, messages, open]);

  return { state, lastResponse, handleSelect, handleTranscriptSelect };
}
