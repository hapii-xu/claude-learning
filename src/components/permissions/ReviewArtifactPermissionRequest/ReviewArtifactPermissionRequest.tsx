import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { Select } from '../../CustomSelect/select.js';
import { usePermissionRequestLogging } from '../hooks.js';
import { PermissionDialog } from '../PermissionDialog.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';
import { logUnaryPermissionEvent } from '../utils.js';

export function ReviewArtifactPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const { title, annotations, summary } = toolUseConfirm.input as {
    title?: string;
    annotations?: Array<{ line?: number; message: string; severity?: string }>;
    summary?: string;
  };

  const unaryEvent = {
    completion_type: 'tool_use_single' as const,
    language_name: 'none',
  };
  usePermissionRequestLogging(toolUseConfirm, unaryEvent);

  const annotationCount = annotations?.length ?? 0;

  function handleResponse(value: 'yes' | 'no'): void {
    if (value === 'yes') {
      logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept');
      toolUseConfirm.onAllow(toolUseConfirm.input, []);
      onDone();
    } else {
      logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'reject');
      toolUseConfirm.onReject();
      onReject();
      onDone();
    }
  }

  return (
    <PermissionDialog color="permission" title="审阅构件？" workerBadge={workerBadge}>
      <Box flexDirection="column" marginTop={1} paddingX={1}>
        <Text>Claude 想要审阅{title ? `：${title}` : '一个构件'}。</Text>

        <Box marginTop={1} flexDirection="column">
          <Text dimColor>将呈现 {annotationCount} 条注解。</Text>
          {summary ? <Text dimColor>摘要：{summary}</Text> : null}
        </Box>

        <Box marginTop={1}>
          <Select
            options={[
              { label: '是，显示审阅', value: 'yes' as const },
              { label: '否，跳过', value: 'no' as const },
            ]}
            onChange={handleResponse}
            onCancel={() => handleResponse('no')}
          />
        </Box>
      </Box>
    </PermissionDialog>
  );
}
