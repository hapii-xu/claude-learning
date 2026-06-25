import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { TEARDROP_ASTERISK } from '../../constants/figures.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { setClipboard } from '@anthropic/ink';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- enter to copy link
import { Box, Link, Text, useInput } from '@anthropic/ink';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { logEvent } from '../../services/analytics/index.js';
import {
  fetchReferralRedemptions,
  formatCreditAmount,
  getCachedOrFetchPassesEligibility,
} from '../../services/api/referral.js';
import type { ReferralRedemptionsResponse, ReferrerRewardInfo } from '../../services/oauth/types.js';
import { count } from '../../utils/array.js';
import { logError } from '../../utils/log.js';
import { Pane } from '@anthropic/ink';

type PassStatus = {
  passNumber: number;
  isAvailable: boolean;
};

type Props = {
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void;
};

export function Passes({ onDone }: Props): React.ReactNode {
  const [loading, setLoading] = useState(true);
  const [passStatuses, setPassStatuses] = useState<PassStatus[]>([]);
  const [isAvailable, setIsAvailable] = useState(false);
  const [referralLink, setReferralLink] = useState<string | null>(null);
  const [referrerReward, setReferrerReward] = useState<ReferrerRewardInfo | null | undefined>(undefined);

  const exitState = useExitOnCtrlCDWithKeybindings(() => onDone('访客通行证对话框已关闭', { display: 'system' }));

  const handleCancel = useCallback(() => {
    onDone('访客通行证对话框已关闭', { display: 'system' });
  }, [onDone]);

  useKeybinding('confirm:no', handleCancel, { context: 'Confirmation' });

  useInput((_input, key) => {
    if (key.return && referralLink) {
      void setClipboard(referralLink).then(raw => {
        if (raw) process.stdout.write(raw);
        logEvent('tengu_guest_passes_link_copied', {});
        onDone(`推荐链接已复制到剪贴板！`);
      });
    }
  });

  useEffect(() => {
    async function loadPassesData() {
      try {
        // 先检查资格（若可用则使用缓存）
        const eligibilityData = await getCachedOrFetchPassesEligibility();

        if (!eligibilityData || !eligibilityData.eligible) {
          setIsAvailable(false);
          setLoading(false);
          return;
        }

        setIsAvailable(true);

        // 如果可用，存储推荐链接
        if (eligibilityData.referral_code_details?.referral_link) {
          setReferralLink(eligibilityData.referral_code_details.referral_link);
        }

        // 为 v1 活动消息存储 referrer reward 信息
        setReferrerReward(eligibilityData.referrer_reward);

        // 使用 eligibility 返回的活动作为 redemptions 活动
        const campaign = eligibilityData.referral_code_details?.campaign ?? 'claude_code_guest_pass';

        // 获取 redemptions 数据
        let redemptionsData: ReferralRedemptionsResponse;
        try {
          redemptionsData = await fetchReferralRedemptions(campaign);
        } catch (err) {
          logError(err as Error);
          setIsAvailable(false);
          setLoading(false);
          return;
        }

        // 构建 pass 状态数组
        const redemptions = redemptionsData.redemptions || [];
        const maxRedemptions = redemptionsData.limit || 3;
        const statuses: PassStatus[] = [];

        for (let i = 0; i < maxRedemptions; i++) {
          const redemption = redemptions[i];
          statuses.push({
            passNumber: i + 1,
            isAvailable: !redemption,
          });
        }

        setPassStatuses(statuses);
        setLoading(false);
      } catch (err) {
        // 对任何错误，仅显示 passes 为不可用
        logError(err as Error);
        setIsAvailable(false);
        setLoading(false);
      }
    }

    void loadPassesData();
  }, []);

  if (loading) {
    return (
      <Pane>
        <Box flexDirection="column" gap={1}>
          <Text dimColor>正在加载访客通行证信息…</Text>
          <Text dimColor italic>
            {exitState.pending ? <>再按一次 {exitState.keyName} 退出</> : <>Esc 取消</>}
          </Text>
        </Box>
      </Pane>
    );
  }

  if (!isAvailable) {
    return (
      <Pane>
        <Box flexDirection="column" gap={1}>
          <Text>当前没有可用的访客通行证。</Text>
          <Text dimColor italic>
            {exitState.pending ? <>再按一次 {exitState.keyName} 退出</> : <>Esc 取消</>}
          </Text>
        </Box>
      </Pane>
    );
  }

  const availableCount = count(passStatuses, p => p.isAvailable);

  // 排序 passes：可用的在前，然后是已兑换的
  const sortedPasses = [...passStatuses].sort((a, b) => +b.isAvailable - +a.isAvailable);

  // 票据的 ASCII 艺术图
  const renderTicket = (pass: PassStatus) => {
    const isRedeemed = !pass.isAvailable;

    if (isRedeemed) {
      // 灰色的已兑换票据，带斜线
      return (
        <Box key={pass.passNumber} flexDirection="column" marginRight={1}>
          <Text dimColor>{'┌─────────╱'}</Text>
          <Text dimColor>{` ) CC ${TEARDROP_ASTERISK} ┊╱`}</Text>
          <Text dimColor>{'└───────╱'}</Text>
        </Box>
      );
    }

    return (
      <Box key={pass.passNumber} flexDirection="column" marginRight={1}>
        <Text>{'┌──────────┐'}</Text>
        <Text>
          {' ) CC '}
          <Text color="claude">{TEARDROP_ASTERISK}</Text>
          {' ┊ ( '}
        </Text>
        <Text>{'└──────────┘'}</Text>
      </Box>
    );
  };

  return (
    <Pane>
      <Box flexDirection="column" gap={1}>
        <Text color="permission">访客通行证 · 剩余 {availableCount} 张</Text>

        <Box flexDirection="row" marginLeft={2}>
          {sortedPasses.slice(0, 3).map(pass => renderTicket(pass))}
        </Box>

        {referralLink && (
          <Box marginLeft={2}>
            <Text>{referralLink}</Text>
          </Box>
        )}

        <Box flexDirection="column" marginLeft={2}>
          <Text dimColor>
            {referrerReward
              ? `向朋友分享一周免费的 Claude Code。如果他们喜欢并订阅，你将获得 ${formatCreditAmount(referrerReward)} 额外用量继续构建。 `
              : `向朋友分享一周免费的 Claude Code。 `}
            <Link
              url={
                referrerReward
                  ? 'https://support.claude.com/en/articles/13456702-claude-code-guest-passes'
                  : 'https://support.claude.com/en/articles/12875061-claude-code-guest-passes'
              }
            >
              适用条款。
            </Link>
          </Text>
        </Box>

        <Box>
          <Text dimColor italic>
            {exitState.pending ? <>再按一次 {exitState.keyName} 退出</> : <>Enter 复制链接 · Esc 取消</>}
          </Text>
        </Box>
      </Box>
    </Pane>
  );
}
