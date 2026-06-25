// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import * as React from 'react';
import { Box, Text, color, stringWidth } from '@anthropic/ink';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import {
  getLayoutMode,
  calculateLayoutDimensions,
  calculateOptimalLeftWidth,
  formatWelcomeMessage,
  truncatePath,
  getRecentActivitySync,
  getRecentReleaseNotesSync,
  getLogoDisplayData,
} from '../../utils/logoV2Utils.js';
import { truncate } from '../../utils/format.js';
import { getDisplayPath } from '../../utils/file.js';
import { Clawd } from './Clawd.js';
import { FeedColumn } from './FeedColumn.js';
import {
  createRecentActivityFeed,
  createWhatsNewFeed,
  createProjectOnboardingFeed,
  createGuestPassesFeed,
} from './feedConfigs.js';
import { getGlobalConfig, saveGlobalConfig } from 'src/utils/config.js';
import { resolveThemeSetting } from 'src/utils/systemTheme.js';
import { getInitialSettings } from 'src/utils/settings/settings.js';
import { isDebugMode, isDebugToStdErr, getDebugLogPath } from 'src/utils/debug.js';
import { useEffect, useState } from 'react';
import {
  getSteps,
  shouldShowProjectOnboarding,
  incrementProjectOnboardingSeenCount,
} from '../../projectOnboardingState.js';
import { CondensedLogo } from './CondensedLogo.js';
import { OffscreenFreeze } from '../OffscreenFreeze.js';
import { checkForReleaseNotesSync } from '../../utils/releaseNotes.js';
import { getDumpPromptsPath } from 'src/services/api/dumpPrompts.js';
import { isEnvTruthy } from 'src/utils/envUtils.js';
import { getStartupPerfLogPath, isDetailedProfilingEnabled } from 'src/utils/startupProfiler.js';
import { EmergencyTip } from './EmergencyTip.js';
import { VoiceModeNotice } from './VoiceModeNotice.js';
import { Opus1mMergeNotice } from './Opus1mMergeNotice.js';
import { GateOverridesWarning } from './GateOverridesWarning.js';
import { ExperimentEnrollmentNotice } from './ExperimentEnrollmentNotice.js';
import { feature } from 'bun:bundle';

// 条件 require，以便当两个 flag 都为 false 时 ChannelsNotice.tsx 可以被 tree-shake。
// feature() 三元表达式中的模块级辅助组件不会被 tree-shake
// （见 docs/feature-gating.md）；require 模式可以消除整个文件。
// VoiceModeNotice 使用了不安全的辅助组件模式，但 VOICE_MODE
// 是 external: true，所以那里无所谓。
/* eslint-disable @typescript-eslint/no-require-imports */
const ChannelsNoticeModule =
  feature('KAIROS') || feature('KAIROS_CHANNELS')
    ? (require('./ChannelsNotice.js') as typeof import('./ChannelsNotice.js'))
    : null;
/* eslint-enable @typescript-eslint/no-require-imports */
import { SandboxManager } from 'src/utils/sandbox/sandbox-adapter.js';
import { useShowGuestPassesUpsell, incrementGuestPassesSeenCount } from './GuestPassesUpsell.js';
import {
  useShowOverageCreditUpsell,
  incrementOverageCreditUpsellSeenCount,
  createOverageCreditFeed,
} from './OverageCreditUpsell.js';
import { useAppState } from '../../state/AppState.js';
import { getEffortSuffix } from '../../utils/effort.js';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { renderModelSetting } from '../../utils/model/model.js';

const LEFT_PANEL_MAX_WIDTH = 50;

export function LogoV2(): React.ReactNode {
  const activities = getRecentActivitySync();
  const username = getGlobalConfig().oauthAccount?.displayName ?? '';

  const { columns } = useTerminalSize();
  const showOnboarding = shouldShowProjectOnboarding();
  const showSandboxStatus = SandboxManager.isSandboxingEnabled();
  const showGuestPassesUpsell = useShowGuestPassesUpsell();
  const showOverageCreditUpsell = useShowOverageCreditUpsell();
  const agent = useAppState(s => s.agent);
  const effortValue = useAppState(s => s.effortValue);

  const config = getGlobalConfig();

  let changelog: string[];
  try {
    changelog = getRecentReleaseNotesSync(3);
  } catch {
    changelog = [];
  }

  // 获取公司公告并选择一条：
  // - 首次启动（numStartups === 1）：展示第一条公告
  // - 其他启动：从公告中随机选择一条
  const [announcement] = useState(() => {
    const announcements = getInitialSettings().companyAnnouncements;
    if (!announcements || announcements.length === 0) return undefined;
    return config.numStartups === 1
      ? announcements[0]
      : announcements[Math.floor(Math.random() * announcements.length)];
  });
  const { hasReleaseNotes } = checkForReleaseNotesSync(config.lastReleaseNotesSeen);

  useEffect(() => {
    const currentConfig = getGlobalConfig();
    if (currentConfig.lastReleaseNotesSeen === MACRO.VERSION) {
      return;
    }
    saveGlobalConfig(current => {
      if (current.lastReleaseNotesSeen === MACRO.VERSION) return current;
      return { ...current, lastReleaseNotesSeen: MACRO.VERSION };
    });
    if (showOnboarding) {
      incrementProjectOnboardingSeenCount();
    }
  }, [config, showOnboarding]);

  // 在 condensed 模式下（下面的提前 return 会渲染 <CondensedLogo/>），
  // CondensedLogo 自己的 useEffect 会处理展示计数。此处跳过可避免
  // 重复计数，因为 hooks 在提前 return 之前就会触发。
  const isCondensedMode = !hasReleaseNotes && !showOnboarding && !isEnvTruthy(process.env.CLAUDE_CODE_FORCE_FULL_LOGO);

  useEffect(() => {
    if (showGuestPassesUpsell && !showOnboarding && !isCondensedMode) {
      incrementGuestPassesSeenCount();
    }
  }, [showGuestPassesUpsell, showOnboarding, isCondensedMode]);

  useEffect(() => {
    if (showOverageCreditUpsell && !showOnboarding && !showGuestPassesUpsell && !isCondensedMode) {
      incrementOverageCreditUpsellSeenCount();
    }
  }, [showOverageCreditUpsell, showOnboarding, showGuestPassesUpsell, isCondensedMode]);

  const model = useMainLoopModel();
  const fullModelDisplayName = renderModelSetting(model);
  const { version, cwd, billingType, agentName: agentNameFromSettings } = getLogoDisplayData();
  // 优先使用 AppState.agent（由 --agent CLI flag 设置）而非 settings
  const agentName = agent ?? agentNameFromSettings;
  // -20 用于给订阅名 " · Claude Enterprise" 的最大长度留空间。
  const effortSuffix = getEffortSuffix(model, effortValue);
  const modelDisplayName = truncate(fullModelDisplayName + effortSuffix, LEFT_PANEL_MAX_WIDTH - 20);

  // 如果没有新的 changelog 且不展示 onboarding 且未强制完整 logo，则展示 condensed logo
  if (!hasReleaseNotes && !showOnboarding && !isEnvTruthy(process.env.CLAUDE_CODE_FORCE_FULL_LOGO)) {
    return (
      <>
        <CondensedLogo />
        <VoiceModeNotice />
        <Opus1mMergeNotice />
        {ChannelsNoticeModule && <ChannelsNoticeModule.ChannelsNotice />}
        {isDebugMode() && (
          <Box paddingLeft={2} flexDirection="column">
            <Text color="warning">调试模式已启用</Text>
            <Text dimColor>日志输出到：{isDebugToStdErr() ? 'stderr' : getDebugLogPath()}</Text>
          </Box>
        )}
        <EmergencyTip />
        {process.env.CLAUDE_CODE_TMUX_SESSION && (
          <Box paddingLeft={2} flexDirection="column">
            <Text dimColor>tmux 会话：{process.env.CLAUDE_CODE_TMUX_SESSION}</Text>
            <Text dimColor>
              {process.env.CLAUDE_CODE_TMUX_PREFIX_CONFLICTS
                ? `分离：${process.env.CLAUDE_CODE_TMUX_PREFIX} ${process.env.CLAUDE_CODE_TMUX_PREFIX} d（按两次 prefix - Claude 使用了 ${process.env.CLAUDE_CODE_TMUX_PREFIX}）`
                : `分离：${process.env.CLAUDE_CODE_TMUX_PREFIX} d`}
            </Text>
          </Box>
        )}
        {announcement && (
          <Box paddingLeft={2} flexDirection="column">
            {!process.env.IS_DEMO && config.oauthAccount?.organizationName && (
              <Text dimColor>来自 {config.oauthAccount.organizationName} 的消息：</Text>
            )}
            <Text>{announcement}</Text>
          </Box>
        )}
        {process.env.USER_TYPE === 'ant' && !process.env.DEMO_VERSION && (
          <Box paddingLeft={2} flexDirection="column">
            <Text dimColor>使用 /issue 报告模型行为问题</Text>
          </Box>
        )}
        {process.env.USER_TYPE === 'ant' && !process.env.DEMO_VERSION && (
          <Box paddingLeft={2} flexDirection="column">
            <Text color="warning">[ANT-ONLY] 日志：</Text>
            <Text dimColor>API 调用：{getDisplayPath(getDumpPromptsPath())}</Text>
            <Text dimColor>调试日志：{getDisplayPath(getDebugLogPath())}</Text>
            {isDetailedProfilingEnabled() && <Text dimColor>启动性能：{getDisplayPath(getStartupPerfLogPath())}</Text>}
          </Box>
        )}
        {process.env.USER_TYPE === 'ant' && <GateOverridesWarning />}
        {process.env.USER_TYPE === 'ant' && <ExperimentEnrollmentNotice />}
      </>
    );
  }

  // 计算布局和显示值
  const layoutMode = getLayoutMode(columns);

  const userTheme = resolveThemeSetting(getGlobalConfig().theme);
  const borderTitle = ` ${color('claude', userTheme)('Claude Code')} ${color('inactive', userTheme)(`v${version}`)} `;
  const compactBorderTitle = color('claude', userTheme)(' Claude Code ');

  // compact 模式的提前 return
  if (layoutMode === 'compact') {
    const layoutWidth = 4; // 边框 + 内边距
    let welcomeMessage = formatWelcomeMessage(username);
    if (stringWidth(welcomeMessage) > columns - layoutWidth) {
      welcomeMessage = formatWelcomeMessage(null);
    }

    // 计算 cwd 宽度，若存在 agent 名则需预留空间
    const separator = ' · ';
    const atPrefix = '@';
    const cwdAvailableWidth = agentName
      ? columns - layoutWidth - atPrefix.length - stringWidth(agentName) - separator.length
      : columns - layoutWidth;
    const truncatedCwd = truncatePath(cwd, Math.max(cwdAvailableWidth, 10));
    // OffscreenFreeze：logo 是第一个进入 scrollback 的内容；useMainLoopModel()
    // 订阅了 model 变化，getLogoDisplayData() 会读取 cwd/subscription —
    // 在 scrollback 期间任何变化都会强制完全重置。
    return (
      <>
        <OffscreenFreeze>
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="claude"
            borderText={{
              content: compactBorderTitle,
              position: 'top',
              align: 'start',
              offset: 1,
            }}
            paddingX={1}
            paddingY={1}
            alignItems="center"
            width={columns}
          >
            <Text bold>{welcomeMessage}</Text>
            <Box marginY={1}>
              <Clawd />
            </Box>
            <Text dimColor>{modelDisplayName}</Text>
            <Text dimColor>{billingType}</Text>
            <Text dimColor>{agentName ? `@${agentName} · ${truncatedCwd}` : truncatedCwd}</Text>
          </Box>
        </OffscreenFreeze>
        <VoiceModeNotice />
        <Opus1mMergeNotice />
        {ChannelsNoticeModule && <ChannelsNoticeModule.ChannelsNotice />}
        {showSandboxStatus && (
          <Box marginTop={1} flexDirection="column">
            <Text color="warning">你的 bash 命令将在沙盒中运行。使用 /sandbox 禁用。</Text>
          </Box>
        )}
        {process.env.USER_TYPE === 'ant' && <GateOverridesWarning />}
        {process.env.USER_TYPE === 'ant' && <ExperimentEnrollmentNotice />}
      </>
    );
  }

  const welcomeMessage = formatWelcomeMessage(username);
  const modelLine =
    !process.env.IS_DEMO && config.oauthAccount?.organizationName
      ? `${modelDisplayName} · ${billingType} · ${config.oauthAccount.organizationName}`
      : `${modelDisplayName} · ${billingType}`;
  // 计算 cwd 宽度，若存在 agent 名则需预留空间
  const cwdSeparator = ' · ';
  const cwdAtPrefix = '@';
  const cwdAvailableWidth = agentName
    ? LEFT_PANEL_MAX_WIDTH - cwdAtPrefix.length - stringWidth(agentName) - cwdSeparator.length
    : LEFT_PANEL_MAX_WIDTH;
  const truncatedCwd = truncatePath(cwd, Math.max(cwdAvailableWidth, 10));
  const cwdLine = agentName ? `@${agentName} · ${truncatedCwd}` : truncatedCwd;
  const optimalLeftWidth = calculateOptimalLeftWidth(welcomeMessage, cwdLine, modelLine);

  // 计算布局尺寸
  const { leftWidth, rightWidth } = calculateLayoutDimensions(columns, layoutMode, optimalLeftWidth);

  return (
    <>
      <OffscreenFreeze>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="claude"
          borderText={{
            content: borderTitle,
            position: 'top',
            align: 'start',
            offset: 3,
          }}
        >
          {/* 主内容 */}
          <Box flexDirection={layoutMode === 'horizontal' ? 'row' : 'column'} paddingX={1} gap={1}>
            {/* 左面板 */}
            <Box
              flexDirection="column"
              width={leftWidth}
              justifyContent="space-between"
              alignItems="center"
              minHeight={9}
            >
              <Box marginTop={1}>
                <Text bold>{welcomeMessage}</Text>
              </Box>

              <Clawd />

              <Box flexDirection="column" alignItems="center">
                <Text dimColor>{modelLine}</Text>
                <Text dimColor>{cwdLine}</Text>
              </Box>
            </Box>

            {/* 垂直分隔线 */}
            {layoutMode === 'horizontal' && (
              <Box
                height="100%"
                borderStyle="single"
                borderColor="claude"
                borderDimColor
                borderTop={false}
                borderBottom={false}
                borderLeft={false}
              />
            )}

            {/* 右面板 — Project Onboarding 或 Recent Activity 和 What's New */}
            {layoutMode === 'horizontal' && (
              <FeedColumn
                feeds={
                  showOnboarding
                    ? [createProjectOnboardingFeed(getSteps()), createRecentActivityFeed(activities)]
                    : showGuestPassesUpsell
                      ? [createRecentActivityFeed(activities), createGuestPassesFeed()]
                      : showOverageCreditUpsell
                        ? [createRecentActivityFeed(activities), createOverageCreditFeed()]
                        : [createRecentActivityFeed(activities), createWhatsNewFeed(changelog)]
                }
                maxWidth={rightWidth}
              />
            )}
          </Box>
        </Box>
      </OffscreenFreeze>
      <VoiceModeNotice />
      <Opus1mMergeNotice />
      {ChannelsNoticeModule && <ChannelsNoticeModule.ChannelsNotice />}
      {isDebugMode() && (
        <Box paddingLeft={2} flexDirection="column">
          <Text color="warning">调试模式已启用</Text>
          <Text dimColor>日志输出到：{isDebugToStdErr() ? 'stderr' : getDebugLogPath()}</Text>
        </Box>
      )}
      <EmergencyTip />
      {process.env.CLAUDE_CODE_TMUX_SESSION && (
        <Box paddingLeft={2} flexDirection="column">
          <Text dimColor>tmux 会话：{process.env.CLAUDE_CODE_TMUX_SESSION}</Text>
          <Text dimColor>
            {process.env.CLAUDE_CODE_TMUX_PREFIX_CONFLICTS
              ? `分离：${process.env.CLAUDE_CODE_TMUX_PREFIX} ${process.env.CLAUDE_CODE_TMUX_PREFIX} d（按两次 prefix - Claude 使用了 ${process.env.CLAUDE_CODE_TMUX_PREFIX}）`
              : `分离：${process.env.CLAUDE_CODE_TMUX_PREFIX} d`}
          </Text>
        </Box>
      )}
      {announcement && (
        <Box paddingLeft={2} flexDirection="column">
          {!process.env.IS_DEMO && config.oauthAccount?.organizationName && (
            <Text dimColor>来自 {config.oauthAccount.organizationName} 的消息：</Text>
          )}
          <Text>{announcement}</Text>
        </Box>
      )}
      {showSandboxStatus && (
        <Box paddingLeft={2} flexDirection="column">
          <Text color="warning">你的 bash 命令将在沙盒中运行。使用 /sandbox 禁用。</Text>
        </Box>
      )}
      {process.env.USER_TYPE === 'ant' && !process.env.DEMO_VERSION && (
        <Box paddingLeft={2} flexDirection="column">
          <Text dimColor>使用 /issue 报告模型行为问题</Text>
        </Box>
      )}
      {process.env.USER_TYPE === 'ant' && !process.env.DEMO_VERSION && (
        <Box paddingLeft={2} flexDirection="column">
          <Text color="warning">[ANT-ONLY] 日志：</Text>
          <Text dimColor>API 调用：{getDisplayPath(getDumpPromptsPath())}</Text>
          <Text dimColor>调试日志：{getDisplayPath(getDebugLogPath())}</Text>
          {isDetailedProfilingEnabled() && <Text dimColor>启动性能：{getDisplayPath(getStartupPerfLogPath())}</Text>}
        </Box>
      )}
      {process.env.USER_TYPE === 'ant' && <GateOverridesWarning />}
      {process.env.USER_TYPE === 'ant' && <ExperimentEnrollmentNotice />}
    </>
  );
}
