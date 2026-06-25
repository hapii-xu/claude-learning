import { feature } from 'bun:bundle';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js';
import { getInitialSettings } from '../../utils/settings/settings.js';
import { isVoiceModeEnabled } from '../../voice/voiceModeEnabled.js';
import { AnimatedAsterisk } from './AnimatedAsterisk.js';
import { shouldShowOpus1mMergeNotice } from './Opus1mMergeNotice.js';

const MAX_SHOW_COUNT = 3;

export function VoiceModeNotice(): React.ReactNode {
  // 正向三元模式 — 见 docs/feature-gating.md。
  // 所有字符串都必须放在受保护分支内，以便死代码消除。
  return feature('VOICE_MODE') ? <VoiceModeNoticeInner /> : null;
}

function VoiceModeNoticeInner(): React.ReactNode {
  // 在挂载时一次性捕获资格 — 没有响应式订阅。它位于
  // 消息列表顶部，很快进入 scrollback；进入 scrollback 后
  // 任何重新渲染都会强制完全终端重置。
  // 如果用户在本会话运行 /voice，该通知保持可见；下一会话不再展示，
  // 因为 voiceEnabled 会已在磁盘上为 true。
  const [show] = useState(
    () =>
      isVoiceModeEnabled() &&
      getInitialSettings().voiceEnabled !== true &&
      (getGlobalConfig().voiceNoticeSeenCount ?? 0) < MAX_SHOW_COUNT &&
      !shouldShowOpus1mMergeNotice(),
  );

  useEffect(() => {
    if (!show) return;
    // 在 updater 外部捕获，以便 StrictMode 的第二次调用是 no-op。
    const newCount = (getGlobalConfig().voiceNoticeSeenCount ?? 0) + 1;
    saveGlobalConfig(prev => {
      if ((prev.voiceNoticeSeenCount ?? 0) >= newCount) return prev;
      return { ...prev, voiceNoticeSeenCount: newCount };
    });
  }, [show]);

  if (!show) return null;

  return (
    <Box paddingLeft={2}>
      <AnimatedAsterisk />
      <Text dimColor> 语音模式现已可用 · 输入 /voice 启用</Text>
    </Box>
  );
}
