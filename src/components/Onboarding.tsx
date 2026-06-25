import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import { setupTerminal, shouldOfferTerminalSetup } from '../commands/terminalSetup/terminalSetup.js';
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Link, Newline, Text, useTheme } from '@anthropic/ink';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { isAnthropicAuthEnabled } from '../utils/auth.js';
import { normalizeApiKeyForConfig } from '../utils/authPortable.js';
import { getCustomApiKeyStatus } from '../utils/config.js';
import { env } from '../utils/env.js';
import { isRunningOnHomespace } from '../utils/envUtils.js';
import { PreflightStep } from '../utils/preflightChecks.js';
import type { ThemeSetting } from '../utils/theme.js';
import { ApproveApiKey } from './ApproveApiKey.js';
import { ConsoleOAuthFlow } from './ConsoleOAuthFlow.js';
import { Select } from './CustomSelect/select.js';
import { WelcomeV2 } from './LogoV2/WelcomeV2.js';
import { PressEnterToContinue } from './PressEnterToContinue.js';
import { ThemePicker } from './ThemePicker.js';
import { OrderedList } from './ui/OrderedList.js';

type StepId = 'preflight' | 'theme' | 'oauth' | 'api-key' | 'security' | 'terminal-setup';

interface OnboardingStep {
  id: StepId;
  component: React.ReactNode;
}

type Props = {
  onDone(): void;
};

export function Onboarding({ onDone }: Props): React.ReactNode {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [skipOAuth, setSkipOAuth] = useState(false);
  const [oauthEnabled] = useState(() => isAnthropicAuthEnabled());
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    logEvent('tengu_began_setup', {
      oauthEnabled,
    });
  }, [oauthEnabled]);

  function goToNextStep() {
    if (currentStepIndex < steps.length - 1) {
      const nextIndex = currentStepIndex + 1;
      setCurrentStepIndex(nextIndex);

      logEvent('tengu_onboarding_step', {
        oauthEnabled,
        stepId: steps[nextIndex]?.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
    } else {
      onDone();
    }
  }

  function handleThemeSelection(newTheme: ThemeSetting) {
    setTheme(newTheme);
    goToNextStep();
  }

  const exitState = useExitOnCtrlCDWithKeybindings();

  // 定义所有 onboarding 步骤
  const themeStep = (
    <Box marginX={1}>
      <ThemePicker
        onThemeSelect={handleThemeSelection}
        showIntroText={true}
        helpText="稍后可运行 /theme 修改"
        hideEscToCancel={true}
        skipExitHandling={true} // 跳过退出处理，因为 Onboarding 已经处理了
      />
    </Box>
  );

  const securityStep = (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>开始之前，请注意：</Text>
      <Box flexDirection="column" width={70}>
        {/**
         * OrderedList 在条件渲染时会编号错误，
         * 所以把所有项都放在 if/else 中
         */}
        <OrderedList>
          <OrderedList.Item>
            <Text>在接受之前始终审查更改</Text>
            <Text dimColor wrap="wrap">
              Claude 可能会犯错 —— 尤其是在运行命令
              <Newline />
              或编辑文件时。你对每个操作都保持完全控制。
              <Newline />
            </Text>
          </OrderedList.Item>
          <OrderedList.Item>
            <Text>只在你信任的项目中使用 Claude Code</Text>
            <Text dimColor wrap="wrap">
              不受信任的代码可能包含 prompt 注入攻击。
              <Newline />
              <Link url="https://code.claude.com/docs/en/security" />
            </Text>
          </OrderedList.Item>
        </OrderedList>
      </Box>
      <PressEnterToContinue />
    </Box>
  );

  const _preflightStep = <PreflightStep onSuccess={goToNextStep} />;
  // 创建 steps 数组 - 根据 reAuth 和 oauthEnabled 决定要包含哪些步骤
  const apiKeyNeedingApproval = useMemo(() => {
    // 如果需要则添加 API key 步骤
    // 在 homespace 上，ANTHROPIC_API_KEY 会保留在 process.env 中供子进程使用，
    // 但 Claude Code 自身会忽略它（见 auth.ts）。
    if (!process.env.ANTHROPIC_API_KEY || isRunningOnHomespace()) {
      return '';
    }
    const customApiKeyTruncated = normalizeApiKeyForConfig(process.env.ANTHROPIC_API_KEY);
    if (getCustomApiKeyStatus(customApiKeyTruncated) === 'new') {
      return customApiKeyTruncated;
    }
  }, []);

  function handleApiKeyDone(approved: boolean) {
    if (approved) {
      setSkipOAuth(true);
    }
    goToNextStep();
  }

  const steps: OnboardingStep[] = [];
  // 预检已禁用 —— 用户可能使用第三方 API provider
  // if (oauthEnabled) {
  //   steps.push({ id: 'preflight', component: preflightStep })
  // }
  steps.push({ id: 'theme', component: themeStep });

  if (apiKeyNeedingApproval) {
    steps.push({
      id: 'api-key',
      component: <ApproveApiKey customApiKeyTruncated={apiKeyNeedingApproval} onDone={handleApiKeyDone} />,
    });
  }

  if (oauthEnabled) {
    steps.push({
      id: 'oauth',
      component: (
        <SkippableStep skip={skipOAuth} onSkip={goToNextStep}>
          <ConsoleOAuthFlow onDone={goToNextStep} />
        </SkippableStep>
      ),
    });
  }

  steps.push({ id: 'security', component: securityStep });

  if (shouldOfferTerminalSetup()) {
    steps.push({
      id: 'terminal-setup',
      component: (
        <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>使用 Claude Code 的终端设置？</Text>
          <Box flexDirection="column" width={70} gap={1}>
            <Text>
              为获得最佳编码体验，请为你的终端启用推荐设置
              <Newline />： {env.terminal === 'Apple_Terminal' ? 'Option+Enter 换行和可视响铃' : 'Shift+Enter 换行'}
            </Text>
            <Select
              options={[
                {
                  label: '是，使用推荐设置',
                  value: 'install',
                },
                {
                  label: '否，稍后用 /terminal-setup 再设置',
                  value: 'no',
                },
              ]}
              onChange={value => {
                if (value === 'install') {
                  // 错误已在 setupTerminal 中记录，这里直接吞掉并继续
                  void setupTerminal(theme)
                    .catch(() => {})
                    .finally(goToNextStep);
                } else {
                  goToNextStep();
                }
              }}
              onCancel={() => goToNextStep()}
            />
            <Text dimColor>
              {exitState.pending ? <>再按一次 {exitState.keyName} 退出</> : <>Enter 确认 · Esc 跳过</>}
            </Text>
          </Box>
        </Box>
      ),
    });
  }

  const currentStep = steps[currentStepIndex];

  // 处理 security 步骤上的 Enter 以及 terminal-setup 步骤上的 Escape
  // 依赖项与 goToNextStep 内部使用的保持一致
  const handleSecurityContinue = useCallback(() => {
    if (currentStepIndex === steps.length - 1) {
      onDone();
    } else {
      goToNextStep();
    }
  }, [currentStepIndex, steps.length, oauthEnabled, onDone]);

  const handleTerminalSetupSkip = useCallback(() => {
    goToNextStep();
  }, [currentStepIndex, steps.length, oauthEnabled, onDone]);

  useKeybindings(
    {
      'confirm:yes': handleSecurityContinue,
    },
    {
      context: 'Confirmation',
      isActive: currentStep?.id === 'security',
    },
  );

  useKeybindings(
    {
      'confirm:no': handleTerminalSetupSkip,
    },
    {
      context: 'Confirmation',
      isActive: currentStep?.id === 'terminal-setup',
    },
  );

  return (
    <Box flexDirection="column">
      <WelcomeV2 />
      <Box flexDirection="column" marginTop={1}>
        {currentStep?.component}
        {exitState.pending && (
          <Box padding={1}>
            <Text dimColor>再按一次 {exitState.keyName} 退出</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

export function SkippableStep({
  skip,
  onSkip,
  children,
}: {
  skip: boolean;
  onSkip(): void;
  children: React.ReactNode;
}): React.ReactNode {
  useEffect(() => {
    if (skip) {
      onSkip();
    }
  }, [skip, onSkip]);
  if (skip) {
    return null;
  }
  return children;
}
