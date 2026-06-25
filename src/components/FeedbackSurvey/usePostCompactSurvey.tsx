import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isFeedbackSurveyDisabled } from 'src/services/analytics/config.js';
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import { shouldUseSessionMemoryCompaction } from '../../services/compact/sessionMemoryCompact.js';
import type { Message } from '../../types/message.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import { isCompactBoundaryMessage } from '../../utils/messages.js';
import { logOTelEvent } from '../../utils/telemetry/events.js';
import { useSurveyState } from './useSurveyState.js';
import type { FeedbackSurveyResponse } from './utils.js';

const HIDE_THANKS_AFTER_MS = 3000;
const POST_COMPACT_SURVEY_GATE = 'tengu_post_compact_survey';
const SURVEY_PROBABILITY = 0.2; // 在 compact 之后以 20% 的概率显示调查

function hasMessageAfterBoundary(messages: Message[], boundaryUuid: string): boolean {
  const boundaryIndex = messages.findIndex(msg => msg.uuid === boundaryUuid);
  if (boundaryIndex === -1) {
    return false;
  }

  // 检查边界之后是否存在用户或 assistant 消息
  for (let i = boundaryIndex + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg && (msg.type === 'user' || msg.type === 'assistant')) {
      return true;
    }
  }
  return false;
}

export function usePostCompactSurvey(
  messages: Message[],
  isLoading: boolean,
  hasActivePrompt = false,
  { enabled = true }: { enabled?: boolean } = {},
): {
  state: 'closed' | 'open' | 'thanks' | 'transcript_prompt' | 'submitting' | 'submitted';
  lastResponse: FeedbackSurveyResponse | null;
  handleSelect: (selected: FeedbackSurveyResponse) => void;
} {
  const [gateEnabled, setGateEnabled] = useState<boolean | null>(null);
  const seenCompactBoundaries = useRef<Set<string>>(new Set());
  // 追踪当前正在等待的 compact 边界（用于在下一条消息后显示调查）
  const pendingCompactBoundaryUuid = useRef<string | null>(null);

  const onOpen = useCallback((appearanceId: string) => {
    const smCompactionEnabled = shouldUseSessionMemoryCompaction();
    logEvent('tengu_post_compact_survey_event', {
      event_type: 'appeared' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      appearance_id: appearanceId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      session_memory_compaction_enabled:
        smCompactionEnabled as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    void logOTelEvent('feedback_survey', {
      event_type: 'appeared',
      appearance_id: appearanceId,
      survey_type: 'post_compact',
    });
  }, []);

  const onSelect = useCallback((appearanceId: string, selected: FeedbackSurveyResponse) => {
    const smCompactionEnabled = shouldUseSessionMemoryCompaction();
    logEvent('tengu_post_compact_survey_event', {
      event_type: 'responded' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      appearance_id: appearanceId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      response: selected as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      session_memory_compaction_enabled:
        smCompactionEnabled as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    void logOTelEvent('feedback_survey', {
      event_type: 'responded',
      appearance_id: appearanceId,
      response: selected,
      survey_type: 'post_compact',
    });
  }, []);

  const { state, lastResponse, open, handleSelect } = useSurveyState({
    hideThanksAfterMs: HIDE_THANKS_AFTER_MS,
    onOpen,
    onSelect,
  });

  // 挂载时检查 feature gate
  useEffect(() => {
    if (!enabled) return;
    setGateEnabled(checkStatsigFeatureGate_CACHED_MAY_BE_STALE(POST_COMPACT_SURVEY_GATE));
  }, [enabled]);

  // 查找 compact 边界消息
  const currentCompactBoundaries = useMemo(
    () => new Set(messages.filter(msg => isCompactBoundaryMessage(msg)).map(msg => msg.uuid)),
    [messages],
  );

  // 检测新的 compact 边界，并推迟到下一条消息后才显示调查
  useEffect(() => {
    if (!enabled) return;

    // 正在显示时不处理
    if (state !== 'closed' || isLoading) {
      return;
    }

    // 当权限或提问 prompt 可见时不显示调查
    if (hasActivePrompt) {
      return;
    }

    // 检查 gate 是否启用
    if (gateEnabled !== true) {
      return;
    }

    if (isFeedbackSurveyDisabled()) {
      return;
    }

    // 检查调查是否被显式禁用
    if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY)) {
      return;
    }

    // 首先，检查是否有等待中的 compact 且新消息已到达
    if (pendingCompactBoundaryUuid.current !== null) {
      if (hasMessageAfterBoundary(messages, pendingCompactBoundaryUuid.current)) {
        // compact 之后有新消息到达 —— 决定是否显示调查
        pendingCompactBoundaryUuid.current = null;

        // 仅 20% 的概率显示调查
        if (Math.random() < SURVEY_PROBABILITY) {
          open();
        }
        return;
      }
    }

    // 查找尚未见过的新的 compact 边界
    const newBoundaries = Array.from(currentCompactBoundaries).filter(uuid => !seenCompactBoundaries.current.has(uuid));

    if (newBoundaries.length > 0) {
      // 将这些边界标记为已见
      seenCompactBoundaries.current = new Set(currentCompactBoundaries);

      // 不立即显示调查 —— 等待下一条消息
      // 存储最近的新的边界 UUID
      pendingCompactBoundaryUuid.current = newBoundaries[newBoundaries.length - 1]!;
    }
  }, [enabled, currentCompactBoundaries, state, isLoading, hasActivePrompt, gateEnabled, messages, open]);

  return { state, lastResponse, handleSelect };
}
