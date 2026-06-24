import React, { useCallback, useMemo } from 'react';
import { Box, Text, useTheme } from '@anthropic/ink';
import { getTheme } from '../../../utils/theme.js';
import { env } from '../../../utils/env.js';
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js';
import { truncateToLines } from '../../../utils/stringUtils.js';
import { logUnaryEvent } from '../../../utils/unaryLogging.js';
import { PermissionDialog } from '../PermissionDialog.js';
import { PermissionPrompt, type PermissionPromptOption } from '../PermissionPrompt.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js';

type OptionValue = 'yes' | 'yes-dont-ask-again' | 'no';

/**
 * MonitorTool 的权限请求 UI。请求用户确认是否启动
 * 长时间运行的后台 monitor 进程。
 * 沿用 FallbackPermissionRequest 的模式。
 */
export function MonitorPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);

  const input = toolUseConfirm.input as {
    command: string;
    description: string;
  };

  const showAlwaysAllowOptions = useMemo(() => shouldShowAlwaysAllowOptions(), []);

  const options: PermissionPromptOption<OptionValue>[] = useMemo(() => {
    const opts: PermissionPromptOption<OptionValue>[] = [
      {
        label: '\u662f',
        value: 'yes',
        feedbackConfig: { type: 'accept' as const },
      },
    ];
    if (showAlwaysAllowOptions) {
      opts.push({
        label: (
          <Text>
            \u662f\uff0c\u4e14\u4e0d\u518d\u8be2\u95ee <Text bold>{toolUseConfirm.tool.name}</Text> \u547d\u4ee4
          </Text>
        ),
        value: 'yes-dont-ask-again',
      });
    }
    opts.push({
      label: '\u5426',
      value: 'no',
      feedbackConfig: { type: 'reject' as const },
    });
    return opts;
  }, [showAlwaysAllowOptions, toolUseConfirm.tool.name]);

  const handleSelect = useCallback(
    (value: OptionValue, feedback?: string) => {
      switch (value) {
        case 'yes':
          logUnaryEvent({
            completion_type: 'tool_use_single',
            event: 'accept',
            metadata: {
              language_name: 'none',
              message_id: toolUseConfirm.assistantMessage.message.id ?? '',
              platform: env.platform,
            },
          });
          toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback);
          onDone();
          break;
        case 'yes-dont-ask-again':
          logUnaryEvent({
            completion_type: 'tool_use_single',
            event: 'accept',
            metadata: {
              language_name: 'none',
              message_id: toolUseConfirm.assistantMessage.message.id ?? '',
              platform: env.platform,
            },
          });
          toolUseConfirm.onAllow(toolUseConfirm.input, [
            {
              type: 'addRules',
              rules: [{ toolName: toolUseConfirm.tool.name }],
              behavior: 'allow',
              destination: 'localSettings',
            },
          ]);
          onDone();
          break;
        case 'no':
          logUnaryEvent({
            completion_type: 'tool_use_single',
            event: 'reject',
            metadata: {
              language_name: 'none',
              message_id: toolUseConfirm.assistantMessage.message.id ?? '',
              platform: env.platform,
            },
          });
          toolUseConfirm.onReject(feedback);
          onReject();
          onDone();
          break;
      }
    },
    [toolUseConfirm, onDone, onReject],
  );

  const handleCancel = useCallback(() => {
    logUnaryEvent({
      completion_type: 'tool_use_single',
      event: 'reject',
      metadata: {
        language_name: 'none',
        message_id: toolUseConfirm.assistantMessage.message.id ?? '',
        platform: env.platform,
      },
    });
    toolUseConfirm.onReject();
    onReject();
    onDone();
  }, [toolUseConfirm, onDone, onReject]);

  return (
    <PermissionDialog title="监控进程" workerBadge={workerBadge}>
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold color={theme.permission as any}>
            {input.description}
          </Text>
          <Text dimColor>{truncateToLines(input.command, 5)}</Text>
        </Box>
        <PermissionRuleExplanation permissionResult={toolUseConfirm.permissionResult} toolType="command" />
        <PermissionPrompt<OptionValue> options={options} onSelect={handleSelect} onCancel={handleCancel} />
      </Box>
    </PermissionDialog>
  );
}
