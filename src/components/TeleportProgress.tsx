import figures from 'figures';
import * as React from 'react';
import { useState } from 'react';
import type { Root } from '@anthropic/ink';
import { Box, Text, useAnimationFrame } from '@anthropic/ink';
import { AppStateProvider } from '../state/AppState.js';
import {
  checkOutTeleportedSessionBranch,
  processMessagesForTeleportResume,
  type TeleportProgressStep,
  type TeleportResult,
  teleportResumeCodeSession,
} from '../utils/teleport.js';

type Props = {
  currentStep: TeleportProgressStep;
  sessionId?: string;
};

const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];

const STEPS: { key: TeleportProgressStep; label: string }[] = [
  { key: 'validating', label: '正在校验会话' },
  { key: 'fetching_logs', label: '正在获取会话日志' },
  { key: 'fetching_branch', label: '正在获取分支信息' },
  { key: 'checking_out', label: '正在切换分支' },
];

export function TeleportProgress({ currentStep, sessionId }: Props): React.ReactNode {
  const [ref, time] = useAnimationFrame(100);
  const frame = Math.floor(time / 100) % SPINNER_FRAMES.length;

  const currentStepIndex = STEPS.findIndex(s => s.key === currentStep);

  return (
    <Box ref={ref} flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="claude">
          {SPINNER_FRAMES[frame]} 正在 teleport 会话…
        </Text>
      </Box>

      {sessionId && (
        <Box marginBottom={1}>
          <Text dimColor>{sessionId}</Text>
        </Box>
      )}

      <Box flexDirection="column" marginLeft={2}>
        {STEPS.map((step, index) => {
          const isComplete = index < currentStepIndex;
          const isCurrent = index === currentStepIndex;
          const isPending = index > currentStepIndex;

          let icon: string;
          let color: string | undefined;

          if (isComplete) {
            icon = figures.tick;
            color = 'green';
          } else if (isCurrent) {
            icon = SPINNER_FRAMES[frame]!;
            color = 'claude';
          } else {
            icon = figures.circle;
            color = undefined;
          }

          return (
            <Box key={step.key} flexDirection="row">
              <Box width={2}>
                <Text color={color as never} dimColor={isPending}>
                  {icon}
                </Text>
              </Box>
              <Text dimColor={isPending} bold={isCurrent}>
                {step.label}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

/**
 * 将会话 teleport 到远程，并在已有的 root 中渲染进度 UI。
 * 获取会话、切换分支，并返回结果。
 */
export async function teleportWithProgress(root: Root, sessionId: string): Promise<TeleportResult> {
  // 从渲染的组件中捕获 setState 函数
  let setStep: (step: TeleportProgressStep) => void = () => {};

  function TeleportProgressWrapper(): React.ReactNode {
    const [step, _setStep] = useState<TeleportProgressStep>('validating');
    setStep = _setStep;
    return <TeleportProgress currentStep={step} sessionId={sessionId} />;
  }

  root.render(
    <AppStateProvider>
      <TeleportProgressWrapper />
    </AppStateProvider>,
  );

  const result = await teleportResumeCodeSession(sessionId, setStep);
  setStep('checking_out');
  const { branchName, branchError } = await checkOutTeleportedSessionBranch(result.branch);
  return {
    messages: processMessagesForTeleportResume(result.log, branchError),
    branchName,
  };
}
