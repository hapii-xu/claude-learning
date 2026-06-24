import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { getAgentName, getTeammateColor, getTeamName } from '../../utils/teammate.js';
import { Spinner } from '../Spinner.js';
import { WorkerBadge } from './WorkerBadge.js';

type Props = {
  toolName: string;
  description: string;
};

/**
 * 在 worker 等待 leader 批准权限请求时显示的视觉指示器。
 * 显示挂起工具及 spinner，并附带请求内容的说明。
 */
export function WorkerPendingPermission({ toolName, description }: Props): React.ReactNode {
  const teamName = getTeamName();
  const agentName = getAgentName();
  const agentColor = getTeammateColor();

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
      <Box marginBottom={1}>
        <Spinner />
        <Text color="warning" bold>
          {' '}
          等待团队负责人批准
        </Text>
      </Box>

      {agentName && agentColor && (
        <Box marginBottom={1}>
          <WorkerBadge name={agentName} color={agentColor} />
        </Box>
      )}

      <Box>
        <Text dimColor>工具：</Text>
        <Text>{toolName}</Text>
      </Box>

      <Box>
        <Text dimColor>操作：</Text>
        <Text>{description}</Text>
      </Box>

      {teamName && (
        <Box marginTop={1}>
          <Text dimColor>
            权限请求已发送至团队 {'"'}
            {teamName}
            {'"'} 负责人
          </Text>
        </Box>
      )}
    </Box>
  );
}
