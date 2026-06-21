// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import React, { useMemo } from 'react';
import { Ansi, Box, Text } from '@anthropic/ink';
import { FilePathLink } from '../FilePathLink.js';
import { toInkColor } from '../../utils/ink.js';
import type { Attachment } from 'src/utils/attachments.js';
import type { NullRenderingAttachmentType } from './nullRenderingAttachments.js';
import { useAppState } from '../../state/AppState.js';
import { getDisplayPath } from 'src/utils/file.js';
import { formatFileSize } from 'src/utils/format.js';
import { MessageResponse } from '../MessageResponse.js';
import { basename, sep } from 'path';
import { UserTextMessage } from './UserTextMessage.js';
import { DiagnosticsDisplay } from '../DiagnosticsDisplay.js';
import { getContentText } from 'src/utils/messages.js';
import type { Theme } from 'src/utils/theme.js';
import { UserImageMessage } from './UserImageMessage.js';

import { jsonParse } from '../../utils/slowOperations.js';
import { plural } from '../../utils/stringUtils.js';
import { isEnvTruthy } from '../../utils/envUtils.js';
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js';
import { tryRenderPlanApprovalMessage, formatTeammateMessageContent } from './PlanApprovalMessage.js';
import { BLACK_CIRCLE } from '../../constants/figures.js';
import { TeammateMessageContent } from './UserTeammateMessage.js';
import { isShutdownApproved } from '../../utils/teammateMailbox.js';
import { CtrlOToExpand } from '../CtrlOToExpand.js';

import { feature } from 'bun:bundle';
import { useSelectedMessageBg } from '../messageActions.js';

type Props = {
  addMargin: boolean;
  attachment: Attachment;
  verbose: boolean;
  isTranscriptMode?: boolean;
};

export function AttachmentMessage({ attachment, addMargin, verbose, isTranscriptMode }: Props): React.ReactNode {
  const bg = useSelectedMessageBg();
  // 提升到挂载时 —— 每条消息的组件，每次滚动都会重新渲染。
  const isDemoEnvRaw = useMemo(() => isEnvTruthy(process.env.IS_DEMO), []);
  const isDemoEnv = feature('EXPERIMENTAL_SKILL_SEARCH') ? isDemoEnvRaw : false;
  // 在 switch 之前处理 teammate_mailbox
  if (isAgentSwarmsEnabled() && attachment.type === 'teammate_mailbox') {
    // 在计数之前过滤掉 idle 通知 - 它们在 UI 中是隐藏的，
    // 所以在计数中显示它们会造成困惑（"mailbox 中有 2 条消息：" 但什么都不显示）
    const visibleMessages = attachment.messages.filter(msg => {
      if (isShutdownApproved(msg.text)) {
        return false;
      }
      try {
        const parsed = jsonParse(msg.text);
        return parsed?.type !== 'idle_notification' && parsed?.type !== 'teammate_terminated';
      } catch {
        return true; // Non-JSON messages are visible
      }
    });

    if (visibleMessages.length === 0) {
      return null;
    }
    return (
      <Box flexDirection="column">
        {visibleMessages.map((msg, idx) => {
          // 尝试解析为 JSON 以处理 task_assignment 消息
          let parsedMsg: {
            type?: string;
            taskId?: string;
            subject?: string;
            assignedBy?: string;
          } | null = null;
          try {
            parsedMsg = jsonParse(msg.text);
          } catch {
            // Not JSON, treat as plain text
          }

          if (parsedMsg?.type === 'task_assignment') {
            return (
              <Box key={idx} paddingLeft={2}>
                <Text>{BLACK_CIRCLE} </Text>
                <Text>Task assigned: </Text>
                <Text bold>#{parsedMsg.taskId}</Text>
                <Text> - {parsedMsg.subject}</Text>
                <Text dimColor> (from {parsedMsg.assignedBy || msg.from})</Text>
              </Box>
            );
          }

          // 注意：idle_notification 消息已在上面过滤掉

          // 尝试渲染为 plan approval 消息（请求或响应）
          const planApprovalElement = tryRenderPlanApprovalMessage(msg.text, msg.from);
          if (planApprovalElement) {
            return <React.Fragment key={idx}>{planApprovalElement}</React.Fragment>;
          }

          // 纯文本消息 - 带有 chevron 的发送者标头，内容被截断
          const inkColor = toInkColor(msg.color);
          const formattedContent = formatTeammateMessageContent(msg.text) ?? msg.text;
          return (
            <TeammateMessageContent
              key={idx}
              displayName={msg.from}
              inkColor={inkColor}
              content={formattedContent}
              summary={msg.summary}
              isTranscriptMode={isTranscriptMode}
            />
          );
        })}
      </Box>
    );
  }

  // skill_discovery 在此处渲染（不在 switch 中），这样 'skill_discovery'
  // 字符串字面量就留在 feature() 守卫的块内。case 标签无法被
  // 条件性消除；if 语句体可以。
  if (feature('EXPERIMENTAL_SKILL_SEARCH')) {
    if (attachment.type === 'skill_discovery') {
      if (attachment.skills.length === 0) return null;
      // Ant 用户会内联看到 shortIds，这样他们就能在 turn 仍然新鲜时
      // /skill-feedback。外部用户（当此 gate 打开时）只会看到
      // names —— shortId 在 ant 构建之外反正也是 undefined。
      const names = attachment.skills.map(s => (s.shortId ? `${s.name} [${s.shortId}]` : s.name)).join(', ');
      const firstId = attachment.skills[0]?.shortId;
      const hint =
        process.env.USER_TYPE === 'ant' && !isDemoEnv && firstId
          ? ` · /skill-feedback ${firstId} 1=wrong 2=noisy 3=good [comment]`
          : '';
      return (
        <Line>
          <Text bold>{attachment.skills.length}</Text> relevant {plural(attachment.skills.length, 'skill')}: {names}
          {hint && <Text dimColor>{hint}</Text>}
        </Line>
      );
    }
  }

  // tool_discovery 在此处渲染（不在 switch 中），这样 'tool_discovery'
  // 字符串字面量就留在 feature() 守卫的块内。
  if (feature('EXPERIMENTAL_SEARCH_EXTRA_TOOLS')) {
    if (attachment.type === 'tool_discovery') {
      if (attachment.tools.length === 0) return null;
      const names = attachment.tools.map(t => t.name).join(', ');
      return (
        <Line>
          <Text dimColor>Discovered tools: </Text>
          <Text>{names}</Text>
        </Line>
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- teammate_mailbox/skill_discovery/tool_discovery handled before switch
  switch (attachment.type) {
    case 'directory':
      return (
        <Line>
          Listed directory <Text bold>{attachment.displayPath + sep}</Text>
        </Line>
      );
    case 'file':
    case 'already_read_file':
      if (attachment.content.type === 'notebook') {
        return (
          <Line>
            Read <Text bold>{attachment.displayPath}</Text> ({attachment.content.file.cells.length} cells)
          </Line>
        );
      }
      if (attachment.content.type === 'file_unchanged') {
        return (
          <Line>
            Read <Text bold>{attachment.displayPath}</Text> (unchanged)
          </Line>
        );
      }
      return (
        <Line>
          Read <Text bold>{attachment.displayPath}</Text> (
          {attachment.content.type === 'text'
            ? `${attachment.content.file.numLines}${attachment.truncated ? '+' : ''} lines`
            : formatFileSize(attachment.content.file.originalSize)}
          )
        </Line>
      );
    case 'compact_file_reference':
      return (
        <Line>
          Referenced file <Text bold>{attachment.displayPath}</Text>
        </Line>
      );
    case 'pdf_reference':
      return (
        <Line>
          Referenced PDF <Text bold>{attachment.displayPath}</Text> ({attachment.pageCount} pages)
        </Line>
      );
    case 'selected_lines_in_ide':
      return (
        <Line>
          ⧉ Selected <Text bold>{attachment.lineEnd - attachment.lineStart + 1}</Text> lines from{' '}
          <Text bold>{attachment.displayPath}</Text> in {attachment.ideName}
        </Line>
      );
    case 'nested_memory':
      return (
        <Line>
          Loaded <Text bold>{attachment.displayPath}</Text>
        </Line>
      );
    case 'relevant_memories':
      // 通常被吸收进 CollapsedReadSearchGroup（collapseReadSearch.ts），
      // 所以只有在前一个 tool 不可折叠（Edit、Write）且没有打开的
      // group 时才渲染。匹配 CollapsedReadSearchContent 的样式：
      // 2-space gutter，dim text，仅显示计数 —— 文件名/内容在 ctrl+o 中。
      return (
        <Box flexDirection="column" marginTop={addMargin ? 1 : 0} backgroundColor={bg}>
          <Box flexDirection="row">
            <Box minWidth={2} />
            <Text dimColor>
              Recalled <Text bold>{attachment.memories.length}</Text>{' '}
              {attachment.memories.length === 1 ? 'memory' : 'memories'}
              {!isTranscriptMode && (
                <>
                  {' '}
                  <CtrlOToExpand />
                </>
              )}
            </Text>
          </Box>
          {(verbose || isTranscriptMode) &&
            attachment.memories.map(m => (
              <Box key={m.path} flexDirection="column">
                <MessageResponse>
                  <Text dimColor>
                    <FilePathLink filePath={m.path}>{basename(m.path)}</FilePathLink>
                  </Text>
                </MessageResponse>
                {isTranscriptMode && (
                  <Box paddingLeft={5}>
                    <Text>
                      <Ansi>{m.content}</Ansi>
                    </Text>
                  </Box>
                )}
              </Box>
            ))}
        </Box>
      );
    case 'dynamic_skill': {
      const skillCount = attachment.skillNames.length;
      return (
        <Line>
          Loaded{' '}
          <Text bold>
            {skillCount} {plural(skillCount, 'skill')}
          </Text>{' '}
          from <Text bold>{attachment.displayPath}</Text>
        </Line>
      );
    }
    case 'skill_listing': {
      if (attachment.isInitial) {
        return null;
      }
      return (
        <Line>
          <Text bold>{attachment.skillCount}</Text> {plural(attachment.skillCount, 'skill')} available
        </Line>
      );
    }
    case 'agent_listing_delta': {
      if (attachment.isInitial || attachment.addedTypes.length === 0) {
        return null;
      }
      const count = attachment.addedTypes.length;
      return (
        <Line>
          <Text bold>{count}</Text> agent {plural(count, 'type')} available
        </Line>
      );
    }
    case 'queued_command': {
      const text = typeof attachment.prompt === 'string' ? attachment.prompt : getContentText(attachment.prompt) || '';
      const hasImages = attachment.imagePasteIds && attachment.imagePasteIds.length > 0;
      return (
        <Box flexDirection="column">
          <UserTextMessage
            addMargin={addMargin}
            param={{ text, type: 'text' }}
            verbose={verbose}
            isTranscriptMode={isTranscriptMode}
          />
          {hasImages && attachment.imagePasteIds?.map(id => <UserImageMessage key={id} imageId={id} />)}
        </Box>
      );
    }
    case 'plan_file_reference':
      return <Line>Plan file referenced ({getDisplayPath(attachment.planFilePath)})</Line>;
    case 'invoked_skills': {
      if (attachment.skills.length === 0) {
        return null;
      }
      const skillNames = attachment.skills.map(s => s.name).join(', ');
      return <Line>Skills restored ({skillNames})</Line>;
    }
    case 'diagnostics':
      return <DiagnosticsDisplay attachment={attachment} verbose={verbose} />;
    case 'mcp_resource':
      return (
        <Line>
          Read MCP resource <Text bold>{attachment.name}</Text> from {attachment.server}
        </Line>
      );
    case 'command_permissions':
      // skill 的成功消息由 SkillTool 的 renderToolResultMessage 渲染，
      // 所以这里不渲染任何内容以避免重复消息。
      return null;
    case 'async_hook_response': {
      // SessionStart hook 完成仅在 verbose 模式下显示
      if (attachment.hookEvent === 'SessionStart' && !verbose) {
        return null;
      }
      // 一般情况下隐藏 async hook 完成消息，除非在 verbose 模式下
      if (!verbose && !isTranscriptMode) {
        return null;
      }
      return (
        <Line>
          Async hook <Text bold>{attachment.hookEvent}</Text> completed
        </Line>
      );
    }
    case 'hook_blocking_error': {
      // Stop hooks 作为摘要渲染在 SystemStopHookSummaryMessage 中
      if (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') {
        return null;
      }
      // 向用户显示 stderr，以便他们理解 hook 为何被阻塞
      const stderr = attachment.blockingError.blockingError.trim();
      return (
        <>
          <Line color="error">{attachment.hookName} hook returned blocking error</Line>
          {stderr ? <Line color="error">{stderr}</Line> : null}
        </>
      );
    }
    case 'hook_non_blocking_error': {
      // Stop hooks 作为摘要渲染在 SystemStopHookSummaryMessage 中
      if (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') {
        return null;
      }
      // 完整的 hook 输出通过 hookEvents.ts 记录到 debug log
      return <Line color="error">{attachment.hookName} hook error</Line>;
    }
    case 'hook_error_during_execution':
      // Stop hooks 作为摘要渲染在 SystemStopHookSummaryMessage 中
      if (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') {
        return null;
      }
      // 完整的 hook 输出通过 hookEvents.ts 记录到 debug log
      return <Line>{attachment.hookName} hook warning</Line>;
    case 'hook_success':
      // 完整的 hook 输出通过 hookEvents.ts 记录到 debug log
      return null;
    case 'hook_stopped_continuation':
      // Stop hooks 作为摘要渲染在 SystemStopHookSummaryMessage 中
      if (attachment.hookEvent === 'Stop' || attachment.hookEvent === 'SubagentStop') {
        return null;
      }
      return (
        <Line color="warning">
          {attachment.hookName} hook stopped continuation: {attachment.message}
        </Line>
      );
    case 'hook_system_message':
      return (
        <Line>
          {attachment.hookName} says: {attachment.content}
        </Line>
      );
    case 'hook_permission_decision': {
      const action = attachment.decision === 'allow' ? 'Allowed' : 'Denied';
      return (
        <Line>
          {action} by <Text bold>{attachment.hookEvent}</Text> hook
        </Line>
      );
    }
    case 'task_status':
      return <TaskStatusMessage attachment={attachment} />;
    case 'teammate_shutdown_batch':
      return (
        <Box flexDirection="row" width="100%" marginTop={1} backgroundColor={bg}>
          <Text dimColor>{BLACK_CIRCLE} </Text>
          <Text dimColor>
            {attachment.count} {plural(attachment.count, 'teammate')} shut down gracefully
          </Text>
        </Box>
      );
    default:
      // 穷尽性检查：到达此处的每个 type 都必须在 NULL_RENDERING_TYPES 中。
      // 如果 TS 报错，说明新增了一个 Attachment type 但上面既没有对应的 case 也
      // 没有在 NULL_RENDERING_TYPES 中添加条目 —— 决定：渲染某内容（添加
      // 一个 case）或什么都不渲染（添加到数组）。Messages.tsx 会预过滤这些，
      // 所以这个分支是为其他渲染路径提供的深度防御。
      //
      // skill_discovery 和 teammate_mailbox 在 switch 之前的运行时守卫块中
      // （feature() / isAgentSwarmsEnabled()）处理，TS 无法通过它们收窄类型 ——
      // 此处通过 type union 排除（仅编译时，无 emit）。
      attachment.type satisfies
        | NullRenderingAttachmentType
        | 'skill_discovery'
        | 'tool_discovery'
        | 'teammate_mailbox'
        | 'bagel_console';
      return null;
  }
}

type TaskStatusAttachment = Extract<Attachment, { type: 'task_status' }>;

function TaskStatusMessage({ attachment }: { attachment: TaskStatusAttachment }): React.ReactNode {
  // 对于 ant，killed 任务状态显示在 CoordinatorTaskPanel 中。
  // 不要在 chat 中再次渲染。
  if (process.env.USER_TYPE === 'ant' && attachment.status === 'killed') {
    return null;
  }

  // 仅在启用 swarms 时访问 teammate 相关代码。
  // TeammateTaskStatus 订阅 AppState；通过守卫挂载我们
  // 避免为每个非 teammate 附件添加 store listener。
  if (isAgentSwarmsEnabled() && attachment.taskType === 'in_process_teammate') {
    return <TeammateTaskStatus attachment={attachment} />;
  }

  return <GenericTaskStatus attachment={attachment} />;
}

function GenericTaskStatus({ attachment }: { attachment: TaskStatusAttachment }): React.ReactNode {
  const bg = useSelectedMessageBg();
  const statusText =
    attachment.status === 'completed'
      ? 'completed in background'
      : attachment.status === 'killed'
        ? 'stopped'
        : attachment.status === 'running'
          ? 'still running in background'
          : attachment.status;
  return (
    <Box flexDirection="row" width="100%" marginTop={1} backgroundColor={bg}>
      <Text dimColor>{BLACK_CIRCLE} </Text>
      <Text dimColor>
        Task &quot;<Text bold>{attachment.description}</Text>&quot; {statusText}
      </Text>
    </Box>
  );
}

function TeammateTaskStatus({ attachment }: { attachment: TaskStatusAttachment }): React.ReactNode {
  const bg = useSelectedMessageBg();
  // 窄选择器：仅在此特定任务变化时重新渲染。
  const task = useAppState(s => s.tasks[attachment.taskId]);
  if (task?.type !== 'in_process_teammate') {
    // 回退到通用渲染（任务尚未在 store 中，或类型错误）
    return <GenericTaskStatus attachment={attachment} />;
  }
  const agentColor = toInkColor(task.identity.color);
  const statusText = attachment.status === 'completed' ? 'shut down gracefully' : attachment.status;
  return (
    <Box flexDirection="row" width="100%" marginTop={1} backgroundColor={bg}>
      <Text dimColor>{BLACK_CIRCLE} </Text>
      <Text dimColor>
        Teammate{' '}
        <Text color={agentColor} bold dimColor={false}>
          @{task.identity.agentName}
        </Text>{' '}
        {statusText}
      </Text>
    </Box>
  );
}
// 我们允许在此处将 dimColor 设置为 false，以帮助绕过 dim-bold bug。
// https://github.com/chalk/chalk/issues/290
function Line({
  dimColor = true,
  children,
  color,
}: {
  dimColor?: boolean;
  children: React.ReactNode;
  color?: keyof Theme;
}): React.ReactNode {
  const bg = useSelectedMessageBg();
  return (
    <Box backgroundColor={bg}>
      <MessageResponse>
        <Text color={color} dimColor={dimColor} wrap="wrap">
          {children}
        </Text>
      </MessageResponse>
    </Box>
  );
}
