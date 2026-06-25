import figures from 'figures';
import { homedir } from 'os';
import { Box, Text } from '@anthropic/ink';
import type { Step } from '../../projectOnboardingState.js';
import { formatCreditAmount, getCachedReferrerReward } from '../../services/api/referral.js';
import type { LogOption } from '../../types/logs.js';
import { getCwd } from '../../utils/cwd.js';
import { formatRelativeTimeAgo } from '../../utils/format.js';
import type { FeedConfig, FeedLine } from './Feed.js';

export function createRecentActivityFeed(activities: LogOption[]): FeedConfig {
  const lines: FeedLine[] = activities.map(log => {
    const time = formatRelativeTimeAgo(log.modified);
    const description = log.summary && log.summary !== 'No prompt' ? log.summary : log.firstPrompt;

    return {
      text: description || '',
      timestamp: time,
    };
  });

  return {
    title: '最近活动',
    lines,
    footer: lines.length > 0 ? '输入 /resume 查看更多' : undefined,
    emptyMessage: '暂无最近活动',
  };
}

export function createWhatsNewFeed(releaseNotes: string[]): FeedConfig {
  const lines: FeedLine[] = releaseNotes.map(note => {
    if (process.env.USER_TYPE === 'ant') {
      const match = note.match(/^(\d+\s+\w+\s+ago)\s+(.+)$/);
      if (match) {
        return {
          timestamp: match[1],
          text: match[2] || '',
        };
      }
    }
    return {
      text: note,
    };
  });

  const emptyMessage =
    process.env.USER_TYPE === 'ant'
      ? '无法获取最新的 claude-cli-internal 提交记录'
      : '查看 Claude Code 更新日志以了解最新变更';

  return {
    title: process.env.USER_TYPE === 'ant' ? "What's new [ANT-ONLY: Latest CC commits]" : '最新动态',
    lines,
    footer: lines.length > 0 ? '输入 /release-notes 查看更多' : undefined,
    emptyMessage,
  };
}

export function createProjectOnboardingFeed(steps: Step[]): FeedConfig {
  const enabledSteps = steps
    .filter(({ isEnabled }) => isEnabled)
    .sort((a, b) => Number(a.isComplete) - Number(b.isComplete));

  const lines: FeedLine[] = enabledSteps.map(({ text, isComplete }) => {
    const checkmark = isComplete ? `${figures.tick} ` : '';
    return {
      text: `${checkmark}${text}`,
    };
  });

  const warningText =
    getCwd() === homedir() ? '提示：你已在家目录中启动 claude。为获得最佳体验，请改为在项目目录中启动。' : undefined;

  if (warningText) {
    lines.push({
      text: warningText,
    });
  }

  return {
    title: '入门小贴士',
    lines,
  };
}

export function createGuestPassesFeed(): FeedConfig {
  const reward = getCachedReferrerReward();
  const subtitle = reward ? `分享 Claude Code，赚取 ${formatCreditAmount(reward)} 额外用量` : '与好友分享 Claude Code';
  return {
    title: '3 张 guest pass',
    lines: [],
    customContent: {
      content: (
        <>
          <Box marginY={1}>
            <Text color="claude">[✻] [✻] [✻]</Text>
          </Box>
          <Text dimColor>{subtitle}</Text>
        </>
      ),
      width: 48,
    },
    footer: '/passes',
  };
}
