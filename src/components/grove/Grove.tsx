import React, { useEffect, useState } from 'react';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import { Box, Link, Text, useInput } from '@anthropic/ink';
import {
  type AccountSettings,
  calculateShouldShowGrove,
  type GroveConfig,
  getGroveNoticeConfig,
  getGroveSettings,
  markGroveNoticeViewed,
  updateGroveSettings,
} from '../../services/api/grove.js';
import { Select } from '../CustomSelect/index.js';
import { Byline, Dialog, KeyboardShortcutHint } from '@anthropic/ink';

export type GroveDecision = 'accept_opt_in' | 'accept_opt_out' | 'defer' | 'escape' | 'skip_rendering';

type Props = {
  showIfAlreadyViewed: boolean;
  location: 'settings' | 'policy_update_modal' | 'onboarding';
  onDone(decision: GroveDecision): void;
};

const NEW_TERMS_ASCII = ` _____________
 |          \\  \\
 | NEW TERMS \\__\\
 |              |
 |  ----------  |
 |  ----------  |
 |  ----------  |
 |  ----------  |
 |  ----------  |
 |              |
 |______________|`;

function GracePeriodContentBody(): React.ReactNode {
  return (
    <>
      <Text>
        我们对《消费者条款》和《隐私政策》的更新将于 <Text bold>2025 年 10 月 8 日</Text> 生效。你
        可以立即接受更新后的条款。
      </Text>

      <Box flexDirection="column">
        <Text>有哪些变更？</Text>

        <Box paddingLeft={1}>
          <Text>
            <Text>· </Text>
            <Text bold>你可以帮助改进 Claude </Text>
            <Text>
              — 允许使用你的聊天和编码会话来训练和改进 Anthropic AI 模型。可随时在 隐私设置（
              <Link url={'https://claude.ai/settings/data-privacy-controls'}></Link>
              ）中更改。
            </Text>
          </Text>
        </Box>
        <Box paddingLeft={1}>
          <Text>
            <Text>· </Text>
            <Text bold>数据留存更新 </Text>
            <Text>— 为帮助我们改进 AI 模型和安全防护，我们将数据留存期限延长至 5 年。</Text>
          </Text>
        </Box>
      </Box>

      <Text>
        了解更多（<Link url={'https://www.anthropic.com/news/updates-to-our-consumer-terms'}></Link>）或阅读更新后的
        《消费者条款》（<Link url={'https://anthropic.com/legal/terms'}></Link>）和《隐私政策》（
        <Link url={'https://anthropic.com/legal/privacy'}></Link>）
      </Text>
    </>
  );
}

function PostGracePeriodContentBody(): React.ReactNode {
  return (
    <>
      <Text>我们已更新《消费者条款》和《隐私政策》。</Text>

      <Box flexDirection="column" gap={1}>
        <Text>有哪些变更？</Text>

        <Box flexDirection="column">
          <Text bold>帮助改进 Claude</Text>
          <Text>允许使用你的聊天和编码会话来训练和改进 Anthropic AI 模型。你可以随时在 隐私设置中更改</Text>
          <Link url={'https://claude.ai/settings/data-privacy-controls'}></Link>
        </Box>

        <Box flexDirection="column">
          <Text bold>这对数据留存的影响</Text>
          <Text>
            开启"帮助改进 Claude"设置会将数据留存期限从 30 天延长至 5 年。关闭则 保持默认的 30
            天数据留存。可随时删除数据。
          </Text>
        </Box>
      </Box>

      <Text>
        了解更多（<Link url={'https://www.anthropic.com/news/updates-to-our-consumer-terms'}></Link>）或阅读更新后的
        《消费者条款》（<Link url={'https://anthropic.com/legal/terms'}></Link>）和《隐私政策》（
        <Link url={'https://anthropic.com/legal/privacy'}></Link>）
      </Text>
    </>
  );
}

export function GroveDialog({ showIfAlreadyViewed, location, onDone }: Props): React.ReactNode {
  const [shouldShowDialog, setShouldShowDialog] = useState<boolean | null>(null);
  const [groveConfig, setGroveConfig] = useState<GroveConfig | null>(null);

  useEffect(() => {
    async function checkGroveSettings() {
      const [settingsResult, configResult] = await Promise.all([getGroveSettings(), getGroveNoticeConfig()]);

      // 如果成功则提取 config 数据，否则为 null
      const config = configResult.success ? configResult.data : null;
      setGroveConfig(config);

      // 判断是否应显示对话框（API 失败时返回 false）
      const shouldShow = calculateShouldShowGrove(settingsResult, configResult, showIfAlreadyViewed);

      setShouldShowDialog(shouldShow);
      // 如果不应显示对话框，立即调用 onDone
      if (!shouldShow) {
        onDone('skip_rendering');
        return;
      }
      // 每次显示对话框时都标记为已查看（用于提醒频率跟踪）
      void markGroveNoticeViewed();
      // 记录 Grove 政策对话框已显示
      logEvent('tengu_grove_policy_viewed', {
        location: location as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        dismissable: config?.notice_is_grace_period as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
    }

    void checkGroveSettings();
  }, [showIfAlreadyViewed, location, onDone]);

  // 加载中状态
  if (shouldShowDialog === null) {
    return null;
  }

  // 用户已经设置过偏好，不显示对话框
  if (!shouldShowDialog) {
    return null;
  }

  async function onChange(value: 'accept_opt_in' | 'accept_opt_out' | 'defer' | 'escape') {
    switch (value) {
      case 'accept_opt_in': {
        await updateGroveSettings(true);
        logEvent('tengu_grove_policy_submitted', {
          state: true,
          dismissable:
            groveConfig?.notice_is_grace_period as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
        break;
      }
      case 'accept_opt_out': {
        await updateGroveSettings(false);
        logEvent('tengu_grove_policy_submitted', {
          state: false,
          dismissable:
            groveConfig?.notice_is_grace_period as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
        break;
      }
      case 'defer':
        logEvent('tengu_grove_policy_dismissed', {
          state: true,
        });
        break;
      case 'escape':
        logEvent('tengu_grove_policy_escaped', {});
        break;
    }

    onDone(value);
  }

  const acceptOptions = groveConfig?.domain_excluded
    ? [
        {
          label: '接受条款 · 帮助改进 Claude：关闭（针对你所在域名的邮箱）',
          value: 'accept_opt_out',
        },
      ]
    : [
        {
          label: '接受条款 · 帮助改进 Claude：开启',
          value: 'accept_opt_in',
        },
        {
          label: '接受条款 · 帮助改进 Claude：关闭',
          value: 'accept_opt_out',
        },
      ];

  function handleCancel(): void {
    if (groveConfig?.notice_is_grace_period) {
      void onChange('defer');
      return;
    }
    void onChange('escape');
  }

  return (
    <Dialog
      title="《消费者条款》与政策更新"
      color="professionalBlue"
      onCancel={handleCancel}
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>再次按 {exitState.keyName} 退出</Text>
        ) : (
          <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="确认" />
            <KeyboardShortcutHint shortcut="Esc" action="取消" />
          </Byline>
        )
      }
    >
      <Box flexDirection="row">
        <Box flexDirection="column" gap={1} flexGrow={1}>
          {groveConfig?.notice_is_grace_period ? <GracePeriodContentBody /> : <PostGracePeriodContentBody />}
        </Box>
        <Box flexShrink={0}>
          <Text color="professionalBlue">{NEW_TERMS_ASCII}</Text>
        </Box>
      </Box>

      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>请选择你希望如何继续</Text>
          <Text>你的选择在确认后立即生效。</Text>
        </Box>

        <Select
          options={[
            ...acceptOptions,
            // 仅在宽限期内显示"暂不"
            ...(groveConfig?.notice_is_grace_period ? [{ label: '暂不', value: 'defer' }] : []),
          ]}
          onChange={value => onChange(value as 'accept_opt_in' | 'accept_opt_out' | 'defer')}
          onCancel={handleCancel}
        />
      </Box>
    </Dialog>
  );
}

type PrivacySettingsDialogProps = {
  settings: AccountSettings;
  domainExcluded?: boolean;
  onDone(): void;
};

export function PrivacySettingsDialog({
  settings,
  domainExcluded,
  onDone,
}: PrivacySettingsDialogProps): React.ReactNode {
  const [groveEnabled, setGroveEnabled] = useState(settings.grove_enabled);

  React.useEffect(() => {
    logEvent('tengu_grove_privacy_settings_viewed', {});
  }, []);

  useInput(async (input, key) => {
    // 当按下 enter/tab/space 时切换设置
    if (!domainExcluded && (key.tab || key.return || input === ' ')) {
      const newValue = !groveEnabled;
      setGroveEnabled(newValue);
      await updateGroveSettings(newValue);
    }
  });

  let valueComponent = <Text color="error">false</Text>;
  if (domainExcluded) {
    valueComponent = <Text color="error">false（针对你所在域名的邮箱）</Text>;
  } else if (groveEnabled) {
    valueComponent = <Text color="success">true</Text>;
  }

  return (
    <Dialog
      title="数据隐私"
      color="professionalBlue"
      onCancel={onDone}
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>再次按 {exitState.keyName} 退出</Text>
        ) : domainExcluded ? (
          <KeyboardShortcutHint shortcut="Esc" action="取消" />
        ) : (
          <Byline>
            <KeyboardShortcutHint shortcut="Enter/Tab/Space" action="切换" />
            <KeyboardShortcutHint shortcut="Esc" action="取消" />
          </Byline>
        )
      }
    >
      <Text>
        在以下地址查看和管理你的隐私设置 <Link url={'https://claude.ai/settings/data-privacy-controls'}></Link>
      </Text>

      <Box>
        <Box width={44}>
          <Text bold>帮助改进 Claude</Text>
        </Box>
        <Box>{valueComponent}</Box>
      </Box>
    </Dialog>
  );
}
