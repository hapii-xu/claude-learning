import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { isTaskAssignment, type TaskAssignmentMessage } from '../../utils/teammateMailbox.js';

type Props = {
  assignment: TaskAssignmentMessage;
};

/**
 * 渲染一个带有青色边框（团队相关颜色）的任务分配消息。
 */
export function TaskAssignmentDisplay({ assignment }: Props): React.ReactNode {
  return (
    <Box flexDirection="column" marginY={1}>
      <Box borderStyle="round" borderColor="cyan_FOR_SUBAGENTS_ONLY" flexDirection="column" paddingX={1} paddingY={1}>
        <Box marginBottom={1}>
          <Text color="cyan_FOR_SUBAGENTS_ONLY" bold>
            任务 #{assignment.taskId} 由 {assignment.assignedBy} 分配
          </Text>
        </Box>
        <Box>
          <Text bold>{assignment.subject}</Text>
        </Box>
        {assignment.description && (
          <Box marginTop={1}>
            <Text dimColor>{assignment.description}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

/**
 * 尝试从原始内容解析并渲染任务分配消息。
 */
export function tryRenderTaskAssignmentMessage(content: string): React.ReactNode | null {
  const assignment = isTaskAssignment(content);
  if (assignment) {
    return <TaskAssignmentDisplay assignment={assignment} />;
  }
  return null;
}

/**
 * 获取任务分配消息的简要摘要文本。
 */
export function getTaskAssignmentSummary(content: string): string | null {
  const assignment = isTaskAssignment(content);
  if (assignment) {
    return `[任务已分配] #${assignment.taskId} - ${assignment.subject}`;
  }
  return null;
}
