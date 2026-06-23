import React from 'react';
import { z } from 'zod/v4';
import { FallbackToolUseErrorMessage } from 'src/components/FallbackToolUseErrorMessage.js';
import { FallbackToolUseRejectedMessage } from 'src/components/FallbackToolUseRejectedMessage.js';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { Box, Text } from '@anthropic/ink';
import { useShortcutDisplay } from 'src/keybindings/useShortcutDisplay.js';
import type { TaskType } from 'src/Task.js';
import type { Tool } from 'src/Tool.js';
import { buildTool, type ToolDef } from 'src/Tool.js';
import type { LocalAgentTaskState } from 'src/tasks/LocalAgentTask/LocalAgentTask.js';
import type { LocalShellTaskState } from 'src/tasks/LocalShellTask/guards.js';
import type { RemoteAgentTaskState } from 'src/tasks/RemoteAgentTask/RemoteAgentTask.js';
import type { TaskState } from 'src/tasks/types.js';
import { AbortError } from 'src/utils/errors.js';
import { lazySchema } from 'src/utils/lazySchema.js';
import { extractTextContent } from 'src/utils/messages.js';
import { semanticBoolean } from 'src/utils/semanticBoolean.js';
import { sleep } from 'src/utils/sleep.js';
import { jsonParse } from 'src/utils/slowOperations.js';
import { countCharInString } from 'src/utils/stringUtils.js';
import { getTaskOutput } from 'src/utils/task/diskOutput.js';
import { updateTaskState } from 'src/utils/task/framework.js';
import { formatTaskOutput } from 'src/utils/task/outputFormatting.js';
import type { ThemeName } from 'src/utils/theme.js';
import { AgentPromptDisplay, AgentResponseDisplay } from '../AgentTool/UI.js';
import BashToolResultMessage from '../BashTool/BashToolResultMessage.js';
import { TASK_OUTPUT_TOOL_NAME } from './constants.js';

const inputSchema = lazySchema(() =>
  z.strictObject({
    task_id: z.string().describe('要获取输出的任务 ID'),
    block: semanticBoolean(z.boolean().default(true)).describe('是否等待任务完成'),
    timeout: z.number().min(0).max(600000).default(30000).describe('最大等待时间（毫秒）'),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

type TaskOutputToolInput = z.infer<InputSchema>;

// 覆盖所有任务类型的统一输出类型
type TaskOutput = {
  task_id: string;
  task_type: TaskType;
  status: string;
  description: string;
  output: string;
  exitCode?: number | null;
  error?: string;
  // 用于 agent
  prompt?: string;
  result?: string;
};

type TaskOutputToolOutput = {
  retrieval_status: 'success' | 'timeout' | 'not_ready';
  task: TaskOutput | null;
};

// 从集中类型文件重新导出 Progress，以打破 import 循环
export type { TaskOutputProgress as Progress } from 'src/types/tools.js';

// 获取任意任务类型的输出
async function getTaskOutputData(task: TaskState): Promise<TaskOutput> {
  let output: string;
  if (task.type === 'local_bash') {
    const bashTask = task as LocalShellTaskState;
    const taskOutputObj = bashTask.shellCommand?.taskOutput;
    if (taskOutputObj) {
      const stdout = await taskOutputObj.getStdout();
      const stderr = taskOutputObj.getStderr();
      output = [stdout, stderr].filter(Boolean).join('\n');
    } else {
      output = await getTaskOutput(task.id);
    }
  } else {
    output = await getTaskOutput(task.id);
  }

  const baseOutput: TaskOutput = {
    task_id: task.id,
    task_type: task.type,
    status: task.status,
    description: task.description,
    output,
  };

  // 添加类型特定的字段
  if (task.type === 'local_bash') {
    const bashTask = task as LocalShellTaskState;
    return {
      ...baseOutput,
      exitCode: bashTask.result?.code ?? null,
    };
  }

  if (task.type === 'local_agent') {
    const agentTask = task as LocalAgentTaskState;
    // 优先使用内存中 result 的干净最终答案，而不是磁盘上的原始 JSONL 记录。
    // 磁盘输出是指向完整会话记录（每条消息、每次工具调用等）的符号链接，
    // 不只是 subagent 的答案。内存中的 result 只包含最终的 assistant 文本内容块。
    const cleanResult = agentTask.result ? extractTextContent(agentTask.result.content, '\n') : undefined;
    return {
      ...baseOutput,
      prompt: agentTask.prompt,
      result: cleanResult || output,
      output: cleanResult || output,
      error: agentTask.error,
    };
  }

  if (task.type === 'remote_agent') {
    const remoteTask = task as RemoteAgentTaskState;
    return {
      ...baseOutput,
      prompt: remoteTask.command,
    };
  }

  return baseOutput;
}

// 等待任务完成
async function waitForTaskCompletion(
  taskId: string,
  getAppState: () => { tasks?: Record<string, TaskState> },
  timeoutMs: number,
  abortController?: AbortController,
): Promise<TaskState | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    // 检查 abort 信号
    if (abortController?.signal.aborted) {
      throw new AbortError();
    }

    const state = getAppState();
    const task = state.tasks?.[taskId] as TaskState | undefined;

    if (!task) {
      return null;
    }

    if (task.status !== 'running' && task.status !== 'pending') {
      return task;
    }

    // 再次轮询前等待
    await sleep(100);
  }

  // 超时 - 返回当前状态
  const finalState = getAppState();
  return (finalState.tasks?.[taskId] as TaskState) ?? null;
}

export const TaskOutputTool: Tool<InputSchema, TaskOutputToolOutput> = buildTool({
  name: TASK_OUTPUT_TOOL_NAME,
  searchHint: '读取后台任务的输出/日志',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  // 重命名工具的向后兼容别名
  aliases: ['AgentOutputTool', 'BashOutputTool'],

  userFacingName() {
    return 'Task Output';
  },

  get inputSchema(): InputSchema {
    return inputSchema();
  },

  async description() {
    return '[已废弃] — 建议改用 Read 读取任务输出文件路径';
  },

  isConcurrencySafe(_input) {
    return this.isReadOnly?.(_input) ?? false;
  },

  isEnabled() {
    return process.env.USER_TYPE !== 'ant';
  },

  isReadOnly(_input) {
    return true;
  },
  toAutoClassifierInput(input) {
    return input.task_id;
  },

  async prompt() {
    return `DEPRECATED: Prefer using the Read tool on the task's output file path instead. Background tasks return their output file path in the tool result, and you receive a <task-notification> with the same path when the task completes — Read that file directly.

- 从运行中或已完成的任务（后台 shell、agent 或远程会话）获取输出
- 接受用于标识任务的 task_id 参数
- 返回任务输出以及状态信息
- 使用 block=true（默认）以等待任务完成
- 使用 block=false 以非阻塞方式检查当前状态
- 可通过 /tasks 命令查找任务 ID
- 适用于所有任务类型：后台 shell、异步 agent 以及远程会话`;
  },

  async validateInput({ task_id }, { getAppState }) {
    if (!task_id) {
      return {
        result: false,
        message: '必须提供 Task ID',
        errorCode: 1,
      };
    }

    const appState = getAppState();
    const task = appState.tasks?.[task_id] as TaskState | undefined;

    if (!task) {
      return {
        result: false,
        message: `未找到 ID 为 ${task_id} 的任务`,
        errorCode: 2,
      };
    }

    return { result: true };
  },

  async call(input: TaskOutputToolInput, toolUseContext, _canUseTool, _parentMessage, onProgress) {
    const { task_id, block, timeout } = input;

    const appState = toolUseContext.getAppState();
    const task = appState.tasks?.[task_id] as TaskState | undefined;

    if (!task) {
      throw new Error(`未找到 ID 为 ${task_id} 的任务`);
    }

    if (!block) {
      // 非阻塞：返回当前状态
      if (task.status !== 'running' && task.status !== 'pending') {
        // 标记为已通知
        updateTaskState(task_id, toolUseContext.setAppState, t => ({
          ...t,
          notified: true,
        }));
        return {
          data: {
            retrieval_status: 'success' as const,
            task: await getTaskOutputData(task),
          },
        };
      }
      return {
        data: {
          retrieval_status: 'not_ready' as const,
          task: await getTaskOutputData(task),
        },
      };
    }

    // 阻塞：等待完成
    if (onProgress) {
      onProgress({
        toolUseID: `task-output-waiting-${Date.now()}`,
        data: {
          type: 'waiting_for_task',
          taskDescription: task.description,
          taskType: task.type,
        },
      });
    }

    const completedTask = await waitForTaskCompletion(
      task_id,
      toolUseContext.getAppState,
      timeout,
      toolUseContext.abortController,
    );

    if (!completedTask) {
      return {
        data: {
          retrieval_status: 'timeout' as const,
          task: null,
        },
      };
    }

    if (completedTask.status === 'running' || completedTask.status === 'pending') {
      return {
        data: {
          retrieval_status: 'timeout' as const,
          task: await getTaskOutputData(completedTask),
        },
      };
    }

    // 标记为已通知
    updateTaskState(task_id, toolUseContext.setAppState, t => ({
      ...t,
      notified: true,
    }));

    return {
      data: {
        retrieval_status: 'success' as const,
        task: await getTaskOutputData(completedTask),
      },
    };
  },

  mapToolResultToToolResultBlockParam(data, toolUseID) {
    const parts: string[] = [];

    parts.push(`<retrieval_status>${data.retrieval_status}</retrieval_status>`);

    if (data.task) {
      parts.push(`<task_id>${data.task.task_id}</task_id>`);
      parts.push(`<task_type>${data.task.task_type}</task_type>`);
      parts.push(`<status>${data.task.status}</status>`);

      if (data.task.exitCode !== undefined && data.task.exitCode !== null) {
        parts.push(`<exit_code>${data.task.exitCode}</exit_code>`);
      }

      if (data.task.output?.trim()) {
        const { content } = formatTaskOutput(data.task.output, data.task.task_id);
        parts.push(`<output>\n${content.trimEnd()}\n</output>`);
      }

      if (data.task.error) {
        parts.push(`<error>${data.task.error}</error>`);
      }
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: parts.join('\n\n'),
    };
  },

  renderToolUseMessage(input) {
    const { block = true } = input;
    if (!block) {
      return '非阻塞';
    }
    return '';
  },

  renderToolUseTag(input) {
    if (!input.task_id) {
      return null;
    }
    return <Text dimColor> {input.task_id}</Text>;
  },

  renderToolUseProgressMessage(progressMessages) {
    const lastProgress = progressMessages[progressMessages.length - 1];
    const progressData = lastProgress?.data as { taskDescription?: string; taskType?: string } | undefined;

    return (
      <Box flexDirection="column">
        {progressData?.taskDescription && <Text>&nbsp;&nbsp;{progressData.taskDescription}</Text>}
        <Text>
          &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;正在等待任务 <Text dimColor>(按 esc 给出额外指令)</Text>
        </Text>
      </Box>
    );
  },

  renderToolResultMessage(content, _, { verbose, theme }) {
    return <TaskOutputResultDisplay content={content} verbose={verbose} theme={theme} />;
  },

  renderToolUseRejectedMessage() {
    return <FallbackToolUseRejectedMessage />;
  },

  renderToolUseErrorMessage(result, { verbose }) {
    return <FallbackToolUseErrorMessage result={result} verbose={verbose} />;
  },
} satisfies ToolDef<InputSchema, TaskOutputToolOutput>);

function TaskOutputResultDisplay({
  content,
  verbose = false,
  theme,
}: {
  content: string | TaskOutputToolOutput;
  verbose?: boolean;
  theme: ThemeName;
}): React.ReactNode {
  const expandShortcut = useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o');
  const result: TaskOutputToolOutput = typeof content === 'string' ? jsonParse(content) : content;

  if (!result.task) {
    return (
      <MessageResponse>
        <Text dimColor>没有可用的任务输出</Text>
      </MessageResponse>
    );
  }

  const { task } = result;

  // 对于 shell 任务，像 BashToolResultMessage 一样渲染
  if (task.task_type === 'local_bash') {
    const bashOut = {
      stdout: task.output,
      stderr: '',
      isImage: false,
      dangerouslyDisableSandbox: true,
      returnCodeInterpretation: task.error,
    };
    return <BashToolResultMessage content={bashOut} verbose={verbose} />;
  }

  // 对于 agent 任务，使用 prompt/响应展示渲染
  if (task.task_type === 'local_agent') {
    const lineCount = task.result ? countCharInString(task.result, '\n') + 1 : 0;

    if (result.retrieval_status === 'success') {
      if (verbose) {
        return (
          <Box flexDirection="column">
            <Text>
              {task.description} ({lineCount} 行)
            </Text>
            <Box flexDirection="column" paddingLeft={2} marginTop={1}>
              {task.prompt && <AgentPromptDisplay prompt={task.prompt} theme={theme} dim />}
              {task.result && (
                <Box marginTop={1}>
                  <AgentResponseDisplay content={[{ type: 'text', text: task.result }]} theme={theme} />
                </Box>
              )}
              {task.error && (
                <Box flexDirection="column" marginTop={1}>
                  <Text color="error" bold>
                    错误：
                  </Text>
                  <Box paddingLeft={2}>
                    <Text color="error">{task.error}</Text>
                  </Box>
                </Box>
              )}
            </Box>
          </Box>
        );
      }
      return (
        <MessageResponse>
          <Text dimColor>读取输出（{expandShortcut} 展开）</Text>
        </MessageResponse>
      );
    }

    if (result.retrieval_status === 'timeout' || task.status === 'running') {
      return (
        <MessageResponse>
          <Text dimColor>任务仍在运行中…</Text>
        </MessageResponse>
      );
    }

    if (result.retrieval_status === 'not_ready') {
      return (
        <MessageResponse>
          <Text dimColor>任务仍在运行中…</Text>
        </MessageResponse>
      );
    }

    return (
      <MessageResponse>
        <Text dimColor>任务尚未就绪</Text>
      </MessageResponse>
    );
  }

  // 对于远程 agent 任务
  if (task.task_type === 'remote_agent') {
    return (
      <Box flexDirection="column">
        <Text>
          &nbsp;&nbsp;{task.description} [{task.status}]
        </Text>
        {task.output && verbose && (
          <Box paddingLeft={4} marginTop={1}>
            <Text>{task.output}</Text>
          </Box>
        )}
        {!verbose && task.output && (
          <Text dimColor>
            {'     '}（{expandShortcut} 展开）
          </Text>
        )}
      </Box>
    );
  }

  // 默认渲染
  return (
    <Box flexDirection="column">
      <Text>
        &nbsp;&nbsp;{task.description} [{task.status}]
      </Text>
      {task.output && (
        <Box paddingLeft={4}>
          <Text>{task.output.slice(0, 500)}</Text>
        </Box>
      )}
    </Box>
  );
}

export default TaskOutputTool;
