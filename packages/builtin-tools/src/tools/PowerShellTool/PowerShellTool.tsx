import { feature } from 'bun:bundle';
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import { copyFile, stat as fsStat, truncate as fsTruncate, link } from 'fs/promises';
import * as React from 'react';
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js';
import type { AppState } from 'src/state/AppState.js';
import { z } from 'zod/v4';
import { getKairosActive } from 'src/bootstrap/state.js';
import { TOOL_SUMMARY_MAX_LENGTH } from 'src/constants/toolLimits.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import type { SetToolJSXFn, Tool, ToolCallProgress, ValidationResult } from 'src/Tool.js';
import { buildTool, type ToolDef } from 'src/Tool.js';
import {
  backgroundExistingForegroundTask,
  markTaskNotified,
  registerForeground,
  spawnShellTask,
  unregisterForeground,
} from 'src/tasks/LocalShellTask/LocalShellTask.js';
import type { AgentId } from 'src/types/ids.js';
import type { AssistantMessage } from 'src/types/message.js';
import { extractClaudeCodeHints } from 'src/utils/claudeCodeHints.js';
import { isEnvTruthy } from 'src/utils/envUtils.js';
import { errorMessage as getErrorMessage, ShellError } from 'src/utils/errors.js';
import { truncate } from 'src/utils/format.js';
import { lazySchema } from 'src/utils/lazySchema.js';
import { logError } from 'src/utils/log.js';
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js';
import { getPlatform } from 'src/utils/platform.js';
import { maybeRecordPluginHint } from 'src/utils/plugins/hintRecommendation.js';
import { exec } from 'src/utils/Shell.js';
import type { ExecResult } from 'src/utils/ShellCommand.js';
import { SandboxManager } from 'src/utils/sandbox/sandbox-adapter.js';
import { semanticBoolean } from 'src/utils/semanticBoolean.js';
import { semanticNumber } from 'src/utils/semanticNumber.js';
import { getCachedPowerShellPath } from 'src/utils/shell/powershellDetection.js';
import { EndTruncatingAccumulator } from 'src/utils/stringUtils.js';
import { getTaskOutputPath } from 'src/utils/task/diskOutput.js';
import { TaskOutput } from 'src/utils/task/TaskOutput.js';
import { isOutputLineTruncated } from 'src/utils/terminal.js';
import {
  buildLargeToolResultMessage,
  ensureToolResultsDir,
  generatePreview,
  getToolResultPath,
  PREVIEW_SIZE_BYTES,
} from 'src/utils/toolResultStorage.js';
import { shouldUseSandbox } from '../BashTool/shouldUseSandbox.js';
import { BackgroundHint } from '../BashTool/UI.js';
import {
  buildImageToolResult,
  isImageOutput,
  resetCwdIfOutsideProject,
  resizeShellImageOutput,
  stdErrAppendShellResetMessage,
  stripEmptyLines,
} from '../BashTool/utils.js';
import { trackGitOperations } from '../shared/gitOperationTracking.js';
import { interpretCommandResult } from './commandSemantics.js';
import { powershellToolHasPermission } from './powershellPermissions.js';
import { getDefaultTimeoutMs, getMaxTimeoutMs, getPrompt } from './prompt.js';
import { hasSyncSecurityConcerns, isReadOnlyCommand, resolveToCanonical } from './readOnlyValidation.js';
import { POWERSHELL_TOOL_NAME } from './toolName.js';
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseQueuedMessage,
} from './UI.js';

// 终端输出永远不要使用 os.EOL — Windows 上的 \r\n 会破坏 Ink 渲染
const EOL = '\n';

/**
 * 用于可折叠显示的 PowerShell 搜索命令（grep 等价物）。
 * 以规范（小写）cmdlet 名存储。
 */
const PS_SEARCH_COMMANDS = new Set([
  'select-string', // grep 等价物
  'get-childitem', // find 等价物（带 -Recurse）
  'findstr', // Windows 原生搜索
  'where.exe', // Windows 原生 which
]);

/**
 * 用于可折叠显示的 PowerShell 读取/查看命令。
 * 以规范（小写）cmdlet 名存储。
 */
const PS_READ_COMMANDS = new Set([
  'get-content', // cat 等价物
  'get-item', // 文件信息
  'test-path', // test -e 等价物
  'resolve-path', // realpath 等价物
  'get-process', // ps 等价物
  'get-service', // 系统信息
  'get-childitem', // ls/dir 等价物（递归时也是搜索）
  'get-location', // pwd 等价物
  'get-filehash', // 校验和
  'get-acl', // 权限信息
  'format-hex', // hexdump 等价物
]);

/**
 * 不改变搜索/读取性质的 PowerShell 语义中性命令。
 */
const PS_SEMANTIC_NEUTRAL_COMMANDS = new Set([
  'write-output', // echo 等价物
  'write-host',
]);

/**
 * 检查 PowerShell 命令是否是搜索或读取操作。
 * 用于确定命令是否应在 UI 中折叠。
 */
function isSearchOrReadPowerShellCommand(command: string): {
  isSearch: boolean;
  isRead: boolean;
} {
  const trimmed = command.trim();
  if (!trimmed) {
    return { isSearch: false, isRead: false };
  }

  // 简单按语句分隔符和管道操作符分割
  // 这是同步函数，因此我们使用轻量级方法
  const parts = trimmed.split(/\s*[;|]\s*/).filter(Boolean);

  if (parts.length === 0) {
    return { isSearch: false, isRead: false };
  }

  let hasSearch = false;
  let hasRead = false;
  let hasNonNeutralCommand = false;

  for (const part of parts) {
    const baseCommand = part.trim().split(/\s+/)[0];
    if (!baseCommand) {
      continue;
    }

    const canonical = resolveToCanonical(baseCommand);

    if (PS_SEMANTIC_NEUTRAL_COMMANDS.has(canonical)) {
      continue;
    }

    hasNonNeutralCommand = true;

    const isPartSearch = PS_SEARCH_COMMANDS.has(canonical);
    const isPartRead = PS_READ_COMMANDS.has(canonical);

    if (!isPartSearch && !isPartRead) {
      return { isSearch: false, isRead: false };
    }

    if (isPartSearch) hasSearch = true;
    if (isPartRead) hasRead = true;
  }

  if (!hasNonNeutralCommand) {
    return { isSearch: false, isRead: false };
  }

  return { isSearch: hasSearch, isRead: hasRead };
}

// 进度显示常量
const PROGRESS_THRESHOLD_MS = 2000;
const PROGRESS_INTERVAL_MS = 1000;
// 在 assistant 模式下，主 agent 中阻塞命令在此毫秒数后自动后台化
const ASSISTANT_BLOCKING_BUDGET_MS = 15_000;

// 不应自动后台化的命令（规范小写）。
// 'sleep' 是 Start-Sleep 的 PS 内置别名，但不在 COMMON_ALIASES 中，
// 因此同时列出两种形式。
const DISALLOWED_AUTO_BACKGROUND_COMMANDS = [
  'start-sleep', // Start-Sleep 应在前台运行，除非显式后台化
  'sleep',
];

/**
 * 检查命令是否允许自动后台化
 * @param command 要检查的命令
 * @returns 对不应自动后台化的命令（如 Start-Sleep）返回 false
 */
function isAutobackgroundingAllowed(command: string): boolean {
  const firstWord = command.trim().split(/\s+/)[0];
  if (!firstWord) return true;
  const canonical = resolveToCanonical(firstWord);
  return !DISALLOWED_AUTO_BACKGROUND_COMMANDS.includes(canonical);
}

/**
 * BashTool 的 detectBlockedSleepPattern 的 PS 风格移植。
 * 捕获 `Start-Sleep N`、`Start-Sleep -Seconds N`、`sleep N`（内置别名）
 * 作为第一个语句。不阻止 `Start-Sleep -Milliseconds`（亚秒级
 * 步进没问题）或浮点秒数（合法的速率限制）。
 */
export function detectBlockedSleepPattern(command: string): string | null {
  // 仅第一个语句 — 按 PS 语句分隔符分割：`;`、`|`、
  // `&`/`&&`/`||`（pwsh 7+）和换行（PS 的主要分隔符）。这是
  // 故意浅的 — 脚本块、子 shell 或后续管道阶段内的 sleep 没问题。匹配 BashTool 的 splitCommandWithOperators
  // 意图（src/utils/bash/commands.ts），无需完整 PS 解析器。
  const first =
    command
      .trim()
      .split(/[;|&\r\n]/)[0]
      ?.trim() ?? '';
  // 匹配：Start-Sleep N、Start-Sleep -Seconds N、Start-Sleep -s N、sleep N
  //（不区分大小写；-Seconds 按 PS 约定可缩写为 -s）
  const m = /^(?:start-sleep|sleep)(?:\s+-s(?:econds)?)?\s+(\d+)\s*$/i.exec(first);
  if (!m) return null;
  const secs = parseInt(m[1]!, 10);
  if (secs < 2) return null; // 小于 2s 的 sleep 没问题（速率限制、步进）

  const rest = command
    .trim()
    .slice(first.length)
    .replace(/^[\s;|&]+/, '');
  return rest ? `Start-Sleep ${secs} 后跟：${rest}` : `独立 Start-Sleep ${secs}`;
}

/**
 * 在 Windows 原生上，沙箱不可用（bwrap/sandbox-exec 是
 * 仅 POSIX）。如果企业策略有 sandbox.enabled 且禁止
// 未沙箱化命令，PowerShell 无法遵守 — 拒绝执行
// 而非静默绕过策略。在 Linux/macOS/WSL2 上，pwsh
// 作为原生二进制在沙箱下运行，与 bash 相同，因此此
// 门不适用。
 *
 * 在 validateInput（干净的工具运行器错误）和 call()
//（覆盖跳过 validateInput 的直接调用者如 promptShellExecution.ts）中都检查。
// call() 防护是承重的。
 */
const WINDOWS_SANDBOX_POLICY_REFUSAL =
  '企业策略要求沙箱化，但原生 Windows 上不可用沙箱化。此平台上的 shell 命令执行被策略阻止。';
function isWindowsSandboxPolicyViolation(): boolean {
  return (
    getPlatform() === 'windows' &&
    SandboxManager.isSandboxEnabledInSettings() &&
    !SandboxManager.areUnsandboxedCommandsAllowed()
  );
}

// 在模块加载时检查后台任务是否被禁用
const isBackgroundTasksDisabled =
  // eslint-disable-next-line custom-rules/no-process-env-top-level -- Intentional: schema must be defined at module load
  isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS);

const fullInputSchema = lazySchema(() =>
  z.strictObject({
    command: z.string().describe('要执行的 PowerShell 命令'),
    timeout: semanticNumber(z.number().optional()).describe(`可选超时（毫秒，最大 ${getMaxTimeoutMs()}）`),
    description: z.string().optional().describe('清晰、简洁的描述，使用主动语态说明此命令的作用。'),
    run_in_background: semanticBoolean(z.boolean().optional()).describe(
      `设置为 true 以在后台运行此命令。稍后使用 Read 读取输出。`,
    ),
    dangerouslyDisableSandbox: semanticBoolean(z.boolean().optional()).describe(
      '设置为 true 以危险地覆盖沙箱模式并在无沙箱的情况下运行命令。',
    ),
  }),
);

// 当后台任务被禁用时，从 schema 中条件性移除 run_in_background
const inputSchema = lazySchema(() =>
  isBackgroundTasksDisabled ? fullInputSchema().omit({ run_in_background: true }) : fullInputSchema(),
);
type InputSchema = ReturnType<typeof inputSchema>;

// 为类型使用 fullInputSchema，以始终包含 run_in_background
//（即使它从 schema 中省略，代码也需要处理它）
export type PowerShellToolInput = z.infer<ReturnType<typeof fullInputSchema>>;

const outputSchema = lazySchema(() =>
  z.object({
    stdout: z.string().describe('命令的标准输出'),
    stderr: z.string().describe('命令的标准错误输出'),
    interrupted: z.boolean().describe('命令是否被中断'),
    returnCodeInterpretation: z.string().optional().describe('对有特殊含义的非错误退出码的语义解释'),
    isImage: z.boolean().optional().describe('标志，指示 stdout 是否包含图像数据'),
    persistedOutputPath: z.string().optional().describe('当输出过大无法内联显示时，持久化完整输出的路径'),
    persistedOutputSize: z.number().optional().describe('持久化时的总输出大小（字节）'),
    backgroundTaskId: z.string().optional().describe('如果命令在后台运行，后台任务的 ID'),
    backgroundedByUser: z.boolean().optional().describe('如果用户使用 Ctrl+B 手动将命令后台化，则为 true'),
    assistantAutoBackgrounded: z
      .boolean()
      .optional()
      .describe('如果命令被 assistant 模式阻塞预算自动后台化，则为 true'),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;
export type Out = z.infer<OutputSchema>;

import type { PowerShellProgress } from 'src/types/tools.js';

export type { PowerShellProgress } from 'src/types/tools.js';

const COMMON_BACKGROUND_COMMANDS = [
  'npm',
  'yarn',
  'pnpm',
  'node',
  'python',
  'python3',
  'go',
  'cargo',
  'make',
  'docker',
  'terraform',
  'webpack',
  'vite',
  'jest',
  'pytest',
  'curl',
  'Invoke-WebRequest',
  'build',
  'test',
  'serve',
  'watch',
  'dev',
] as const;

function getCommandTypeForLogging(command: string): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  const trimmed = command.trim();
  const firstWord = trimmed.split(/\s+/)[0] || '';

  for (const cmd of COMMON_BACKGROUND_COMMANDS) {
    if (firstWord.toLowerCase() === cmd.toLowerCase()) {
      return cmd as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
    }
  }

  return 'other' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;
}

export const PowerShellTool = buildTool({
  name: POWERSHELL_TOOL_NAME,
  searchHint: '执行 Windows PowerShell 命令',
  maxResultSizeChars: 30_000,
  strict: true,

  async description({ description }: Partial<PowerShellToolInput>): Promise<string> {
    return description || '运行 PowerShell 命令';
  },

  async prompt(): Promise<string> {
    return getPrompt();
  },

  isConcurrencySafe(input: PowerShellToolInput): boolean {
    return this.isReadOnly?.(input) ?? false;
  },

  isSearchOrReadCommand(input: Partial<PowerShellToolInput>): {
    isSearch: boolean;
    isRead: boolean;
  } {
    if (!input?.command) {
      return { isSearch: false, isRead: false };
    }
    return isSearchOrReadPowerShellCommand(input.command);
  },

  isReadOnly(input: PowerShellToolInput): boolean {
    // 在声明只读之前检查同步安全启发式。
    // 完整 AST 解析是异步的，此处不可用，因此我们使用
    // 基于正则的子表达式、splatting、成员
    // 调用和赋值检测 — 匹配 BashTool 在 cmdlet 白名单评估之前检查
    // 安全问题的模式。
    if (hasSyncSecurityConcerns(input.command)) {
      return false;
    }
    // 注意：此处在无解析 AST 的情况下调用 isReadOnlyCommand。没有
    // AST，isReadOnlyCommand 无法分割管道/语句，对除最简单单 token 命令外的
    // 任何内容都将返回
    // false。这是同步 Tool.isReadOnly() 接口的已知限制 — 真正的
    // 只读自动允许在 powershellToolHasPermission（步骤
    // 4.5）中异步发生，那里解析的 AST 可用。
    return isReadOnlyCommand(input.command);
  },
  toAutoClassifierInput(input) {
    return input.command;
  },

  get inputSchema(): InputSchema {
    return inputSchema();
  },

  get outputSchema(): OutputSchema {
    return outputSchema();
  },

  userFacingName(): string {
    return 'PowerShell';
  },

  getToolUseSummary(input: Partial<PowerShellToolInput> | undefined): string | null {
    if (!input?.command) {
      return null;
    }
    const { command, description } = input;
    if (description) {
      return description;
    }
    return truncate(command, TOOL_SUMMARY_MAX_LENGTH);
  },

  getActivityDescription(input: Partial<PowerShellToolInput> | undefined): string {
    if (!input?.command) {
      return '正在运行命令';
    }
    const desc = input.description ?? truncate(input.command, TOOL_SUMMARY_MAX_LENGTH);
    return `正在运行 ${desc}`;
  },

  isEnabled(): boolean {
    return true;
  },

  async validateInput(input: PowerShellToolInput): Promise<ValidationResult> {
    // 纵深防御：在 call() 中也为直接调用者做了防护。
    if (isWindowsSandboxPolicyViolation()) {
      return {
        result: false,
        message: WINDOWS_SANDBOX_POLICY_REFUSAL,
        errorCode: 11,
      };
    }
    if (feature('MONITOR_TOOL') && !isBackgroundTasksDisabled && !input.run_in_background) {
      const sleepPattern = detectBlockedSleepPattern(input.command);
      if (sleepPattern !== null) {
        return {
          result: false,
          message: `已阻止：${sleepPattern}。使用 run_in_background: true 在后台运行阻塞命令 — 完成时会收到完成通知。对于流式事件（监视日志、轮询 API），请使用 Monitor 工具。如果你确实需要延迟（速率限制、刻意步进），请保持在 2 秒以下。`,
          errorCode: 10,
        };
      }
    }
    return { result: true };
  },

  async checkPermissions(
    input: PowerShellToolInput,
    context: Parameters<Tool['checkPermissions']>[1],
  ): Promise<PermissionResult> {
    return await powershellToolHasPermission(input, context);
  },

  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseQueuedMessage,
  renderToolResultMessage,
  renderToolUseErrorMessage,

  mapToolResultToToolResultBlockParam(
    {
      interrupted,
      stdout,
      stderr,
      isImage,
      persistedOutputPath,
      persistedOutputSize,
      backgroundTaskId,
      backgroundedByUser,
      assistantAutoBackgrounded,
    }: Out,
    toolUseID: string,
  ): ToolResultBlockParam {
    // 对于图像数据，格式化为 Claude 的图像内容块
    if (isImage) {
      const block = buildImageToolResult(stdout, toolUseID);
      if (block) return block;
    }

    let processedStdout = stdout;

    if (persistedOutputPath) {
      const trimmed = stdout ? stdout.replace(/^(\s*\n)+/, '').trimEnd() : '';
      const preview = generatePreview(trimmed, PREVIEW_SIZE_BYTES);
      processedStdout = buildLargeToolResultMessage({
        filepath: persistedOutputPath,
        originalSize: persistedOutputSize ?? 0,
        isJson: false,
        preview: preview.preview,
        hasMore: preview.hasMore,
      });
    } else if (stdout) {
      processedStdout = stdout.replace(/^(\s*\n)+/, '');
      processedStdout = processedStdout.trimEnd();
    }

    let errorMessage = stderr.trim();
    if (interrupted) {
      if (stderr) errorMessage += EOL;
      errorMessage += '<error>命令在完成前被中止</error>';
    }

    let backgroundInfo = '';
    if (backgroundTaskId) {
      const outputPath = getTaskOutputPath(backgroundTaskId);
      if (assistantAutoBackgrounded) {
        backgroundInfo = `命令超过 assistant 模式阻塞预算（${ASSISTANT_BLOCKING_BUDGET_MS / 1000}s），已移至后台，ID：${backgroundTaskId}。它仍在运行 — 完成时会通知你。输出正写入：${outputPath}。在 assistant 模式下，将长时间运行的工作委托给子 agent 或使用 run_in_background 以保持此对话的响应性。`;
      } else if (backgroundedByUser) {
        backgroundInfo = `命令被用户手动后台化，ID：${backgroundTaskId}。输出正写入：${outputPath}`;
      } else {
        backgroundInfo = `命令在后台运行，ID：${backgroundTaskId}。输出正写入：${outputPath}`;
      }
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: [processedStdout, errorMessage, backgroundInfo].filter(Boolean).join('\n'),
      is_error: interrupted,
    };
  },

  async call(
    input: PowerShellToolInput,
    toolUseContext: Parameters<Tool['call']>[1],
    _canUseTool?: CanUseToolFn,
    _parentMessage?: AssistantMessage,
    onProgress?: ToolCallProgress<PowerShellProgress>,
  ): Promise<{ data: Out }> {
    // 承重防护：promptShellExecution.ts 和 processBashCommand.tsx
    // 直接调用 PowerShellTool.call()，绕过 validateInput。这是
    // 覆盖所有调用者的检查。见 isWindowsSandboxPolicyViolation
    // 注释了解策略理由。
    if (isWindowsSandboxPolicyViolation()) {
      throw new Error(WINDOWS_SANDBOX_POLICY_REFUSAL);
    }

    const { abortController, setAppState, setToolJSX } = toolUseContext;

    const isMainThread = !toolUseContext.agentId;

    let progressCounter = 0;

    try {
      const commandGenerator = runPowerShellCommand({
        input,
        abortController,
        // 使用始终共享的任务通道，使异步 agent 的后台
        // shell 任务真正被注册（并在 agent 退出时可杀死）。
        setAppState: toolUseContext.setAppStateForTasks ?? setAppState,
        setToolJSX,
        preventCwdChanges: !isMainThread,
        isMainThread,
        toolUseId: toolUseContext.toolUseId,
        agentId: toolUseContext.agentId,
      });

      let generatorResult;
      do {
        generatorResult = await commandGenerator.next();
        if (!generatorResult.done && onProgress) {
          const progress = generatorResult.value;
          onProgress({
            toolUseID: `ps-progress-${progressCounter++}`,
            data: {
              type: 'powershell_progress',
              output: progress.output,
              fullOutput: progress.fullOutput,
              elapsedTimeSeconds: progress.elapsedTimeSeconds,
              totalLines: progress.totalLines,
              totalBytes: progress.totalBytes,
              timeoutMs: progress.timeoutMs,
              taskId: progress.taskId,
            },
          });
        }
      } while (!generatorResult.done);

      const result = generatorResult.value;

      // 馈送 git/PR 使用指标（与 BashTool 相同的计数器）。PS 以
      // 相同语法将 git/gh/glab/curl 作为外部二进制调用，因此
      // trackGitOperations 中 shell 无关的正则检测原样工作。
      // 在 backgroundTaskId 早返回之前调用，使后台化的
      // 命令也被计数（匹配 BashTool.tsx:912）。
      //
      // 预飞哨兵防护：两条 PS 预飞路径（pwsh-not-found、
      // exec-spawn-catch）返回 code: 0 + 空 stdout + stderr，使 call() 能
      // 优雅地呈现 stderr 而非抛出 ShellError。但
      // gitOperationTracking.ts:48 将 code 0 视为成功，并会
      // 正则匹配命令，错误计数从未运行的命令。
      // BashTool 安全 — 其预飞通过 createFailedCommand
      //（code: 1），因此跟踪早返回。对此哨兵跳过跟踪。
      const isPreFlightSentinel = result.code === 0 && !result.stdout && result.stderr && !result.backgroundTaskId;
      if (!isPreFlightSentinel) {
        trackGitOperations(input.command, result.code, result.stdout);
      }

      // 区分用户驱动的中断（提交新消息）与其他
      // 中断状态。只有用户中断应抑制 ShellError —
      // 超时杀死或进程杀死带 isError 仍应抛出。
      // 匹配 BashTool 的 isInterrupt。
      const isInterrupt = result.interrupted && abortController.signal.reason === 'interrupt';

      // 只有主线程跟踪/重置 cwd；agent 有自己的 cwd
      // 隔离。匹配 BashTool 的 !preventCwdChanges 防护。
      // 在 backgroundTaskId 早返回之前运行：命令可能在
      // 后台化之前更改 CWD（例如 `Set-Location C:\temp;
      // Start-Sleep 60`），BashTool 没有这样的早返回 — 其
      // 后台化结果流经 :945 处的 resetCwdIfOutsideProject。
      let stderrForShellReset = '';
      if (isMainThread) {
        const appState = toolUseContext.getAppState();
        if (resetCwdIfOutsideProject(appState.toolPermissionContext)) {
          stderrForShellReset = stdErrAppendShellResetMessage('');
        }
      }

      // 如果后台化，立即返回任务 ID。先剥离提示，
      // 使中断后台化的 fullOutput 不会泄漏标签到
      // 模型（BashTool 无早返回，因此所有路径都流经其
      // 单一提取点）。
      if (result.backgroundTaskId) {
        const bgExtracted = extractClaudeCodeHints(result.stdout || '', input.command);
        if (isMainThread && bgExtracted.hints.length > 0) {
          for (const hint of bgExtracted.hints) maybeRecordPluginHint(hint);
        }
        return {
          data: {
            stdout: bgExtracted.stripped,
            stderr: [result.stderr || '', stderrForShellReset].filter(Boolean).join('\n'),
            interrupted: false,
            backgroundTaskId: result.backgroundTaskId,
            backgroundedByUser: result.backgroundedByUser,
            assistantAutoBackgrounded: result.assistantAutoBackgrounded,
          },
        };
      }

      const stdoutAccumulator = new EndTruncatingAccumulator();
      const processedStdout = (result.stdout || '').trimEnd();

      stdoutAccumulator.append(processedStdout + EOL);

      // 使用语义规则解释退出码。PS 原生 cmdlet（Select-String、
      // Compare-Object、Test-Path）在无匹配时退出 0，因此它们总是命中此处的默认
      // 行为。这主要处理外部 .exe（grep、rg、findstr、fc、robocopy），
      // 其中非零可能意味着"无匹配"/"文件已复制"而非失败。
      const interpretation = interpretCommandResult(input.command, result.code, processedStdout, result.stderr || '');

      // toolErrors.ts 中的 getErrorParts() 已经在构建 ShellError 消息时从 error.code 前置了 'Exit code N'。
      // 不要在此处将其重复到 stdout（BashTool 在 :939 的追加是死
      // 代码 — 它在 stdoutAccumulator.toString() 被读取之前抛出）。

      let stdout = stripEmptyLines(stdoutAccumulator.toString());

      // Claude Code hints 协议：基于 CLAUDECODE=1 门控的 CLI/SDK 向 stderr 发出
      // `<claude-code-hint />` 标签（此处合并到 stdout）。扫描、
      // 记录供 useClaudeCodeHintRecommendation 呈现，然后剥离，
      // 使模型从不看到标签 — 零 token 侧通道。
      // 剥离无条件运行（子 agent 输出也必须保持干净）；
      // 只有对话记录是主线程专用。
      const extracted = extractClaudeCodeHints(stdout, input.command);
      stdout = extracted.stripped;
      if (isMainThread && extracted.hints.length > 0) {
        for (const hint of extracted.hints) maybeRecordPluginHint(hint);
      }

      // preSpawnError 意味着 exec() 成功但内部 shell 在命令运行之前失败
      //（例如 CWD 删除）。createFailedCommand 设置 code=1，
      // interpretCommandResult 可能误认为 grep-no-match / findstr
      // string-not-found。直接抛出。匹配 BashTool.tsx:957。
      if (result.preSpawnError) {
        throw new Error(result.preSpawnError);
      }
      if (interpretation.isError && !isInterrupt) {
        throw new ShellError(stdout, result.stderr || '', result.code, result.interrupted);
      }

      // 大输出：磁盘文件超过 getMaxOutputLength() 字节。
      // stdout 已经包含第一块。将输出文件复制到
      // tool-results 目录，使模型可以通过 FileRead 读取。如果 > 64 MB，
      // 复制后截断。匹配 BashTool.tsx:983-1005。
      //
      // 放在 preSpawnError/ShellError 抛出之后（匹配 BashTool 的
      // 顺序，其中持久化在 try/finally 之后）：同时产生 >maxOutputLength 字节的失败命令
      // 否则会做 3-4 次磁盘
      // 系统调用，存储到 tool-results/，然后抛出 — 使文件成为孤儿。
      const MAX_PERSISTED_SIZE = 64 * 1024 * 1024;
      let persistedOutputPath: string | undefined;
      let persistedOutputSize: number | undefined;
      if (result.outputFilePath && result.outputTaskId) {
        try {
          const fileStat = await fsStat(result.outputFilePath);
          persistedOutputSize = fileStat.size;

          await ensureToolResultsDir();
          const dest = getToolResultPath(result.outputTaskId, false);
          if (fileStat.size > MAX_PERSISTED_SIZE) {
            await fsTruncate(result.outputFilePath, MAX_PERSISTED_SIZE);
          }
          try {
            await link(result.outputFilePath, dest);
          } catch {
            await copyFile(result.outputFilePath, dest);
          }
          persistedOutputPath = dest;
        } catch {
          // 文件可能已经消失 — stdout 预览足够
        }
      }

      // 如果存在则限制图像尺寸 + 大小（CC-304 — 见
      // resizeShellImageOutput）。限定解码缓冲区的作用域，使其在我们构建输出对象之前可被
      // 回收。
      let isImage = isImageOutput(stdout);
      let compressedStdout = stdout;
      if (isImage) {
        const resized = await resizeShellImageOutput(stdout, result.outputFilePath, persistedOutputSize);
        if (resized) {
          compressedStdout = resized;
        } else {
          // 解析失败（例如数据 URL 之后的多行 stdout）。保持
          // isImage 与我们实际发送的内容同步，使 UI 标签保持
          // 准确 — mapToolResultToToolResultBlockParam 的防御性
          // 回退将发送文本，而非图像块。
          isImage = false;
        }
      }

      const finalStderr = [result.stderr || '', stderrForShellReset].filter(Boolean).join('\n');

      logEvent('tengu_powershell_tool_command_executed', {
        command_type: getCommandTypeForLogging(input.command),
        stdout_length: compressedStdout.length,
        stderr_length: finalStderr.length,
        exit_code: result.code,
        interrupted: result.interrupted,
      });

      return {
        data: {
          stdout: compressedStdout,
          stderr: finalStderr,
          interrupted: result.interrupted,
          returnCodeInterpretation: interpretation.message,
          isImage,
          persistedOutputPath,
          persistedOutputSize,
        },
      };
    } finally {
      if (setToolJSX) setToolJSX(null);
    }
  },
  isResultTruncated(output: Out): boolean {
    return isOutputLineTruncated(output.stdout) || isOutputLineTruncated(output.stderr);
  },
} satisfies ToolDef<InputSchema, Out>);

async function* runPowerShellCommand({
  input,
  abortController,
  setAppState,
  setToolJSX,
  preventCwdChanges,
  isMainThread,
  toolUseId,
  agentId,
}: {
  input: PowerShellToolInput;
  abortController: AbortController;
  setAppState: (f: (prev: AppState) => AppState) => void;
  setToolJSX?: SetToolJSXFn;
  preventCwdChanges?: boolean;
  isMainThread?: boolean;
  toolUseId?: string;
  agentId?: AgentId;
}): AsyncGenerator<
  {
    type: 'progress';
    output: string;
    fullOutput: string;
    elapsedTimeSeconds: number;
    totalLines: number;
    totalBytes: number;
    taskId?: string;
    timeoutMs?: number;
  },
  ExecResult,
  void
> {
  const { command, description, timeout, run_in_background, dangerouslyDisableSandbox } = input;
  const timeoutMs = Math.min(timeout || getDefaultTimeoutMs(), getMaxTimeoutMs());

  let fullOutput = '';
  let lastProgressOutput = '';
  let lastTotalLines = 0;
  let lastTotalBytes = 0;
  let backgroundShellId: string | undefined;
  let interruptBackgroundingStarted = false;
  let assistantAutoBackgrounded = false;

  // 进度信号：在异步 .then() 路径中设置 backgroundShellId 时解析，
  // 立即唤醒生成器的 Promise.race，而非
  // 等待下一个 setTimeout tick（匹配 BashTool 模式）。
  let resolveProgress: (() => void) | null = null;
  function createProgressSignal(): Promise<null> {
    return new Promise<null>(resolve => {
      resolveProgress = () => resolve(null);
    });
  }

  const shouldAutoBackground = !isBackgroundTasksDisabled && isAutobackgroundingAllowed(command);

  const powershellPath = await getCachedPowerShellPath();
  if (!powershellPath) {
    // 预飞失败：pwsh 未安装。返回 code 0，使 call() 将
    // 此情况呈现为优雅的 stderr 消息，而非抛出 ShellError —
    // 命令从未运行，因此无有意义的非零退出码可报告。
    return {
      stdout: '',
      stderr: '此系统上不可用 PowerShell。',
      code: 0,
      interrupted: false,
    };
  }

  let shellCommand: Awaited<ReturnType<typeof exec>>;
  try {
    shellCommand = await exec(command, abortController.signal, 'powershell', {
      timeout: timeoutMs,
      onProgress(lastLines, allLines, totalLines, totalBytes, isIncomplete) {
        lastProgressOutput = lastLines;
        fullOutput = allLines;
        lastTotalLines = totalLines;
        lastTotalBytes = isIncomplete ? totalBytes : 0;
      },
      preventCwdChanges,
      // Sandbox 在 Linux/macOS/WSL2 上工作 — pwsh 在那里是原生二进制，
      // SandboxManager.wrapWithSandbox 像包装 bash 一样包装它（Shell.ts 使用
      // /bin/sh 作为外部 spawn 以解析 POSIX 引用的 bwrap/sandbox-exec
      // 字符串）。在 Windows 原生上，沙箱不支持；shouldUseSandbox()
      // 通过 isSandboxingEnabled() → isSupportedPlatform() → false 返回 false。
      // 显式平台检查是冗余但明显的。
      shouldUseSandbox: getPlatform() === 'windows' ? false : shouldUseSandbox({ command, dangerouslyDisableSandbox }),
      shouldAutoBackground,
    });
  } catch (e) {
    logError(e);
    // 预飞失败：spawn/exec 在命令运行之前被拒绝。使用
    // code 0，使 call() 优雅返回 stderr，而非抛出 ShellError。
    return {
      stdout: '',
      stderr: `执行 PowerShell 命令失败：${getErrorMessage(e)}`,
      code: 0,
      interrupted: false,
    };
  }

  const resultPromise = shellCommand.result;

  // 辅助函数：派生后台任务并返回其 ID
  async function spawnBackgroundTask(): Promise<string> {
    const handle = await spawnShellTask(
      {
        command,
        description: description || command,
        shellCommand,
        toolUseId,
        agentId,
      },
      {
        abortController,
        getAppState: () => {
          throw new Error('getAppState 在 runPowerShellCommand 上下文中不可用');
        },
        setAppState,
      },
    );
    return handle.taskId;
  }

  // 辅助函数：开始后台化并记录日志
  function startBackgrounding(eventName: string, backgroundFn?: (shellId: string) => void): void {
    // 如果前台任务已注册（通过进度循环中的 registerForeground），
    // 原地后台化，而非重新派生。重新派生
    // 会覆盖 tasks[taskId]，发出重复的 task_started SDK 事件，
    // 并泄漏第一个清理回调。
    if (foregroundTaskId) {
      if (
        !backgroundExistingForegroundTask(
          foregroundTaskId,
          shellCommand,
          description || command,
          setAppState,
          toolUseId,
        )
      ) {
        return;
      }
      backgroundShellId = foregroundTaskId;
      logEvent(eventName, {
        command_type: getCommandTypeForLogging(command),
      });
      backgroundFn?.(foregroundTaskId);
      return;
    }

    // 未注册前台任务 — 派生新的后台任务
    // 注意：尽管是异步的，spawn 本质上是同步的
    void spawnBackgroundTask().then(shellId => {
      backgroundShellId = shellId;

      // 唤醒生成器的 Promise.race，使其看到 backgroundShellId。
      // 没有此项，生成器等待当前 setTimeout 触发
      //（最多 ~1s）才注意到后台化。匹配 BashTool。
      const resolve = resolveProgress;
      if (resolve) {
        resolveProgress = null;
        resolve();
      }

      logEvent(eventName, {
        command_type: getCommandTypeForLogging(command),
      });

      if (backgroundFn) {
        backgroundFn(shellId);
      }
    });
  }

  // 如果启用，则设置超时自动后台化
  if (shellCommand.onTimeout && shouldAutoBackground) {
    shellCommand.onTimeout(backgroundFn => {
      startBackgrounding('tengu_powershell_command_timeout_backgrounded', backgroundFn);
    });
  }

  // 在 assistant 模式下，主 agent 应保持响应。在
  // ASSISTANT_BLOCKING_BUDGET_MS 后自动后台化阻塞命令，使 agent 能继续
  // 协调而非等待。命令继续运行 — 无状态丢失。
  if (
    feature('KAIROS') &&
    getKairosActive() &&
    isMainThread &&
    !isBackgroundTasksDisabled &&
    run_in_background !== true
  ) {
    setTimeout(() => {
      if (shellCommand.status === 'running' && backgroundShellId === undefined) {
        assistantAutoBackgrounded = true;
        startBackgrounding('tengu_powershell_command_assistant_auto_backgrounded');
      }
    }, ASSISTANT_BLOCKING_BUDGET_MS).unref();
  }

  // 处理 Claude 要求在后台显式运行
  // 当通过 run_in_background 显式请求时，总是接受请求，
  // 无论命令类型如何（isAutobackgroundingAllowed 只适用于自动后台化）
  if (run_in_background === true && !isBackgroundTasksDisabled) {
    const shellId = await spawnBackgroundTask();

    logEvent('tengu_powershell_command_explicitly_backgrounded', {
      command_type: getCommandTypeForLogging(command),
    });

    return {
      stdout: '',
      stderr: '',
      code: 0,
      interrupted: false,
      backgroundTaskId: shellId,
    };
  }

  // 开始轮询输出文件获取进度
  TaskOutput.startPolling(shellCommand.taskOutput.taskId);

  // 设置进度 yield 的定期检查
  const startTime = Date.now();
  let nextProgressTime = startTime + PROGRESS_THRESHOLD_MS;
  let foregroundTaskId: string | undefined;

  // 进度循环：包裹在 try/finally 中，使 stopPolling 在每个退出
  // 路径上被调用 — 正常完成、超时/中断后台化和 Ctrl+B
  //（匹配 BashTool 模式；见 PR #18887 评审帖 :560）
  try {
    while (true) {
      const now = Date.now();
      const timeUntilNextProgress = Math.max(0, nextProgressTime - now);

      const progressSignal = createProgressSignal();
      const result = await Promise.race([
        resultPromise,
        new Promise<null>(resolve => setTimeout(r => r(null), timeUntilNextProgress, resolve).unref()),
        progressSignal,
      ]);

      if (result !== null) {
        // 竞态：后台化触发（15s 定时器 / onTimeout / Ctrl+B）但
        // 命令在下次轮询 tick 之前完成。#handleExit 设置
        // backgroundTaskId 但跳过 outputFilePath（它假设后台
        // 消息或 <task_notification> 会携带路径）。剥离
        // backgroundTaskId 使模型看到干净的已完成命令，
        // 为大输出重建 outputFilePath，并抑制
        // .then() 处理器的冗余 <task_notification>。
        // 检查 result.backgroundTaskId（非闭包变量）也覆盖
        // Ctrl+B，它直接调用 shellCommand.background()。
        if (result.backgroundTaskId !== undefined) {
          markTaskNotified(result.backgroundTaskId, setAppState);
          const fixedResult: ExecResult = {
            ...result,
            backgroundTaskId: undefined,
          };
          // 镜像 ShellCommand.#handleExit 的大输出分支，
          // 因设置了 #backgroundTaskId 而跳过。
          const { taskOutput } = shellCommand;
          if (taskOutput.stdoutToFile && !taskOutput.outputFileRedundant) {
            fixedResult.outputFilePath = taskOutput.path;
            fixedResult.outputFileSize = taskOutput.outputFileSize;
            fixedResult.outputTaskId = taskOutput.taskId;
          }
          // 命令已完成 — 在此处清理流监听器。
          // finally 块的防护（!backgroundShellId && status !== 'backgrounded'）
          // 正确跳过对*运行中*后台化任务的清理，但
          // 在此竞态中进程已完成。匹配 BashTool.tsx:1399。
          shellCommand.cleanup();
          return fixedResult;
        }
        // 命令已完成
        return result;
      }

      // 检查命令是否被后台化（通过超时或中断）
      if (backgroundShellId) {
        return {
          stdout: interruptBackgroundingStarted ? fullOutput : '',
          stderr: '',
          code: 0,
          interrupted: false,
          backgroundTaskId: backgroundShellId,
          assistantAutoBackgrounded,
        };
      }

      // 用户提交了新消息 - 后台化而非杀死
      if (
        abortController.signal.aborted &&
        abortController.signal.reason === 'interrupt' &&
        !interruptBackgroundingStarted
      ) {
        interruptBackgroundingStarted = true;
        if (!isBackgroundTasksDisabled) {
          startBackgrounding('tengu_powershell_command_interrupt_backgrounded');
          // 重新循环，使 backgroundShellId 检查（上方）捕获同步的
          // foregroundTaskId→background 路径。没有此项，我们穿透
          // 到下方的 Ctrl+B 检查，它匹配 status==='backgrounded'
          // 并错误返回 backgroundedByUser:true。（bugs 020/021）
          continue;
        }
        shellCommand.kill();
      }

      // 检查此前台任务是否通过 backgroundAll()（ctrl+b）被后台化
      if (foregroundTaskId) {
        if (shellCommand.status === 'backgrounded') {
          return {
            stdout: '',
            stderr: '',
            code: 0,
            interrupted: false,
            backgroundTaskId: foregroundTaskId,
            backgroundedByUser: true,
          };
        }
      }

      // 进度更新时间
      const elapsed = Date.now() - startTime;
      const elapsedSeconds = Math.floor(elapsed / 1000);

      // 阈值后显示后台化 UI 提示
      if (
        !isBackgroundTasksDisabled &&
        backgroundShellId === undefined &&
        elapsedSeconds >= PROGRESS_THRESHOLD_MS / 1000 &&
        setToolJSX
      ) {
        if (!foregroundTaskId) {
          foregroundTaskId = registerForeground(
            {
              command,
              description: description || command,
              shellCommand,
              agentId,
            },
            setAppState,
            toolUseId,
          );
        }

        setToolJSX({
          jsx: <BackgroundHint />,
          shouldHidePromptInput: false,
          shouldContinueAnimation: true,
          showSpinner: true,
        });
      }

      yield {
        type: 'progress',
        fullOutput,
        output: lastProgressOutput,
        elapsedTimeSeconds: elapsedSeconds,
        totalLines: lastTotalLines,
        totalBytes: lastTotalBytes,
        taskId: shellCommand.taskOutput.taskId,
        ...(timeout ? { timeoutMs } : undefined),
      };

      nextProgressTime = Date.now() + PROGRESS_INTERVAL_MS;
    }
  } finally {
    TaskOutput.stopPolling(shellCommand.taskOutput.taskId);
    // 确保在每个退出路径上运行清理（成功、拒绝、中止）。
    // 后台化时跳过 — LocalShellTask 拥有这些的清理。
    // 匹配 main #21105。
    if (!backgroundShellId && shellCommand.status !== 'backgrounded') {
      if (foregroundTaskId) {
        unregisterForeground(foregroundTaskId, setAppState);
      }
      shellCommand.cleanup();
    }
  }
}
