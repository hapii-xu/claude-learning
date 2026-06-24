import React from 'react';
import { handlePlanModeTransition } from '../../../bootstrap/state.js';
import { Box, Text } from '@anthropic/ink';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../../services/analytics/index.js';
import { useAppState } from '../../../state/AppState.js';
import { isPlanModeInterviewPhaseEnabled } from '../../../utils/planModeV2.js';
import { Select } from '../../CustomSelect/index.js';
import { PermissionDialog } from '../PermissionDialog.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';

export function EnterPlanModePermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const toolPermissionContextMode = useAppState(s => s.toolPermissionContext.mode);

  function handleResponse(value: 'yes' | 'no'): void {
    if (value === 'yes') {
      logEvent('tengu_plan_enter', {
        interviewPhaseEnabled: isPlanModeInterviewPhaseEnabled(),
        entryMethod: 'tool' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      handlePlanModeTransition(toolPermissionContextMode, 'plan');
      onDone();
      toolUseConfirm.onAllow({}, [{ type: 'setMode', mode: 'plan', destination: 'session' }]);
    } else {
      onDone();
      onReject();
      toolUseConfirm.onReject();
    }
  }

  return (
    <PermissionDialog color="planMode" title="进入规划模式？" workerBadge={workerBadge}>
      <Box flexDirection="column" marginTop={1} paddingX={1}>
        <Text>Claude 想进入规划模式，探索并设计实现方案。</Text>

        <Box marginTop={1} flexDirection="column">
          <Text dimColor>在规划模式中，Claude 将：</Text>
          <Text dimColor> · 深入探索代码库</Text>
          <Text dimColor> · 识别现有模式</Text>
          <Text dimColor> · 设计实现策略</Text>
          <Text dimColor> · 提交计划供你审批</Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>在你批准计划之前，不会进行任何代码修改。</Text>
        </Box>

        <Box marginTop={1}>
          <Select
            options={[
              { label: '是，进入规划模式', value: 'yes' as const },
              { label: '否，立即开始实现', value: 'no' as const },
            ]}
            onChange={handleResponse}
            onCancel={() => handleResponse('no')}
          />
        </Box>
      </Box>
    </PermissionDialog>
  );
}
