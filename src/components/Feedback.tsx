import axios from 'axios';
import { readFile, stat } from 'fs/promises';
import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { getLastAPIRequest } from 'src/bootstrap/state.js';
import { logEventTo1P } from 'src/services/analytics/firstPartyEventLogger.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import { getLastAssistantMessage, normalizeMessagesForAPI } from 'src/utils/messages.js';
import type { CommandResultDisplay } from '../commands.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box, Text, useInput } from '@anthropic/ink';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { queryHaiku } from '../services/api/claude.js';
import { startsWithApiErrorPrefix } from '../services/api/errors.js';
import type { Message } from '../types/message.js';
import { checkAndRefreshOAuthTokenIfNeeded } from '../utils/auth.js';
import { openBrowser } from '../utils/browser.js';
import { logForDebugging } from '../utils/debug.js';
import { env } from '../utils/env.js';
import { type GitRepoState, getGitState, getIsGit } from '../utils/git.js';
import { getAuthHeaders, getUserAgent } from '../utils/http.js';
import { getInMemoryErrors, logError } from '../utils/log.js';
import { isEssentialTrafficOnly } from '../utils/privacyLevel.js';
import {
  extractTeammateTranscriptsFromTasks,
  getTranscriptPath,
  loadAllSubagentTranscriptsFromDisk,
  MAX_TRANSCRIPT_READ_BYTES,
} from '../utils/sessionStorage.js';
import { jsonStringify } from '../utils/slowOperations.js';
import { asSystemPrompt } from '../utils/systemPromptType.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { Byline, Dialog, KeyboardShortcutHint } from '@anthropic/ink';
import TextInput from './TextInput.js';

// 该值通过实验测试 URL 长度限制得出
const GITHUB_URL_LIMIT = 7250;
const GITHUB_ISSUES_REPO_URL =
  process.env.USER_TYPE === 'ant'
    ? 'https://github.com/anthropics/claude-cli-internal/issues'
    : 'https://github.com/anthropics/claude-code/issues';

type Props = {
  abortSignal: AbortSignal;
  messages: Message[];
  initialDescription?: string;
  onDone(result: string, options?: { display?: CommandResultDisplay }): void;
  backgroundTasks?: {
    [taskId: string]: {
      type: string;
      identity?: { agentId: string };
      messages?: Message[];
    };
  };
};

type Step = 'userInput' | 'consent' | 'submitting' | 'done';

type FeedbackData = {
  // latestAssistantMessageId 是最近一次主模型调用的消息 ID
  latestAssistantMessageId: string | null;
  message_count: number;
  datetime: string;
  description: string;
  platform: string;
  gitRepo: boolean;
  version: string | null;
  transcript: Message[];
  subagentTranscripts?: { [agentId: string]: Message[] };
  rawTranscriptJsonl?: string;
};

// 工具函数：从字符串中脱敏敏感信息
export function redactSensitiveInfo(text: string): string {
  let redacted = text;

  // Anthropic API 密钥（sk-ant...），含引号和不含引号两种情况
  // 先处理带引号的情况
  redacted = redacted.replace(/"(sk-ant[^\s"']{24,})"/g, '"[REDACTED_API_KEY]"');
  // 再处理不带引号的情况 —— 更通用的匹配模式
  redacted = redacted.replace(
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .replace(re, string) 在无匹配路径上返回原字符串（Object.is）
    /(?<![A-Za-z0-9"'])(sk-ant-?[A-Za-z0-9_-]{10,})(?![A-Za-z0-9"'])/g,
    '[REDACTED_API_KEY]',
  );

  // AWS 密钥 —— AWSXXXX 格式，添加测试所需的匹配模式
  redacted = redacted.replace(/AWS key: "(AWS[A-Z0-9]{20,})"/g, 'AWS key: "[REDACTED_AWS_KEY]"');

  // AWS AKIAXXX 格式密钥
  redacted = redacted.replace(/(AKIA[A-Z0-9]{16})/g, '[REDACTED_AWS_KEY]');

  // Google Cloud 密钥
  redacted = redacted.replace(
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- 同上
    /(?<![A-Za-z0-9])(AIza[A-Za-z0-9_-]{35})(?![A-Za-z0-9])/g,
    '[REDACTED_GCP_KEY]',
  );

  // Vertex AI 服务账号密钥
  redacted = redacted.replace(
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- 同上
    /(?<![A-Za-z0-9])([a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com)(?![A-Za-z0-9])/g,
    '[REDACTED_GCP_SERVICE_ACCOUNT]',
  );

  // 请求头中的通用 API 密钥
  redacted = redacted.replace(/(["']?x-api-key["']?\s*[:=]\s*["']?)[^"',\s)}\]]+/gi, '$1[REDACTED_API_KEY]');

  // Authorization 请求头和 Bearer 令牌
  redacted = redacted.replace(
    /(["']?authorization["']?\s*[:=]\s*["']?(bearer\s+)?)[^"',\s)}\]]+/gi,
    '$1[REDACTED_TOKEN]',
  );

  // AWS 环境变量
  redacted = redacted.replace(/(AWS[_-][A-Za-z0-9_]+\s*[=:]\s*)["']?[^"',\s)}\]]+["']?/gi, '$1[REDACTED_AWS_VALUE]');

  // GCP 环境变量
  redacted = redacted.replace(/(GOOGLE[_-][A-Za-z0-9_]+\s*[=:]\s*)["']?[^"',\s)}\]]+["']?/gi, '$1[REDACTED_GCP_VALUE]');

  // 含密钥的环境变量
  redacted = redacted.replace(
    /((API[-_]?KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*)["']?[^"',\s)}\]]+["']?/gi,
    '$1[REDACTED]',
  );

  return redacted;
}

// 获取脱敏后的错误日志（已移除敏感信息）
function getSanitizedErrorLogs(): Array<{
  error?: string;
  timestamp?: string;
}> {
  // 对错误日志进行脱敏处理，移除所有 API 密钥
  return getInMemoryErrors().map(errorInfo => {
    // 创建 errorInfo 的副本，避免修改原始对象
    const errorCopy = { ...errorInfo } as { error?: string; timestamp?: string };

    // 若 error 字段存在且为字符串，则进行脱敏
    if (errorCopy && typeof errorCopy.error === 'string') {
      errorCopy.error = redactSensitiveInfo(errorCopy.error);
    }

    return errorCopy;
  });
}

async function loadRawTranscriptJsonl(): Promise<string | null> {
  try {
    const transcriptPath = getTranscriptPath();
    const { size } = await stat(transcriptPath);
    if (size > MAX_TRANSCRIPT_READ_BYTES) {
      logForDebugging(`跳过原始 transcript 读取：文件过大（${size} 字节）`, { level: 'warn' });
      return null;
    }
    return await readFile(transcriptPath, 'utf-8');
  } catch {
    return null;
  }
}

export function Feedback({
  abortSignal,
  messages,
  initialDescription,
  onDone,
  backgroundTasks = {},
}: Props): React.ReactNode {
  const [step, setStep] = useState<Step>('userInput');
  const [cursorOffset, setCursorOffset] = useState(0);
  const [description, setDescription] = useState(initialDescription ?? '');
  const [feedbackId, setFeedbackId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [envInfo, setEnvInfo] = useState<{
    isGit: boolean;
    gitState: GitRepoState | null;
  }>({ isGit: false, gitState: null });
  const [title, setTitle] = useState<string | null>(null);
  const textInputColumns = useTerminalSize().columns - 4;

  useEffect(() => {
    async function loadEnvInfo() {
      const isGit = await getIsGit();
      let gitState: GitRepoState | null = null;
      if (isGit) {
        gitState = await getGitState();
      }
      setEnvInfo({ isGit, gitState });
    }
    void loadEnvInfo();
  }, []);

  const submitReport = useCallback(async () => {
    setStep('submitting');
    setError(null);
    setFeedbackId(null);

    // 获取脱敏后的错误信息用于报告
    const sanitizedErrors = getSanitizedErrorLogs();

    // 从消息数组中提取最近一条助手消息的 ID
    const lastAssistantMessage = getLastAssistantMessage(messages);
    const lastAssistantMessageId = lastAssistantMessage?.requestId ?? null;

    const [diskTranscripts, rawTranscriptJsonl] = await Promise.all([
      loadAllSubagentTranscriptsFromDisk(),
      loadRawTranscriptJsonl(),
    ]);
    const teammateTranscripts = extractTeammateTranscriptsFromTasks(backgroundTasks);
    const subagentTranscripts = { ...diskTranscripts, ...teammateTranscripts };

    const reportData = {
      latestAssistantMessageId: lastAssistantMessageId,
      message_count: messages.length,
      datetime: new Date().toISOString(),
      description,
      platform: env.platform,
      gitRepo: envInfo.isGit,
      terminal: env.terminal,
      version: MACRO.VERSION,
      transcript: normalizeMessagesForAPI(messages),
      errors: sanitizedErrors,
      lastApiRequest: getLastAPIRequest(),
      ...(Object.keys(subagentTranscripts).length > 0 && {
        subagentTranscripts,
      }),
      ...(rawTranscriptJsonl && { rawTranscriptJsonl }),
    };

    const [result, t] = await Promise.all([
      submitFeedback(reportData as FeedbackData, abortSignal),
      generateTitle(description, abortSignal),
    ]);

    setTitle(t);

    if (result.success) {
      if (result.feedbackId) {
        setFeedbackId(result.feedbackId);
        logEvent('tengu_bug_report_submitted', {
          feedback_id: result.feedbackId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          last_assistant_message_id:
            lastAssistantMessageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
        // 仅限内部（1P）：自由文本已获批写入 BQ，通过 feedback_id 关联。
        logEventTo1P('tengu_bug_report_description', {
          feedback_id: result.feedbackId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          description: redactSensitiveInfo(description) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
      }
      setStep('done');
    } else {
      if (result.isZdrOrg) {
        setError('对于采用自定义数据留存策略的组织，不可使用反馈收集功能。');
      } else {
        setError('无法提交反馈，请稍后再试。');
      }
      // 保持在 userInput 步骤，让用户可以保留内容后重试
      setStep('userInput');
    }
  }, [description, envInfo.isGit, messages]);

  // 处理取消操作 —— 由 Dialog 的自动 Esc 处理逻辑调用
  const handleCancel = useCallback(() => {
    // 完成后不执行取消 —— 由其他按键关闭对话框
    if (step === 'done') {
      if (error) {
        onDone('提交反馈 / bug 报告时出错', {
          display: 'system',
        });
      } else {
        onDone('反馈 / bug 报告已提交', { display: 'system' });
      }
      return;
    }
    onDone('反馈 / bug 报告已取消', { display: 'system' });
  }, [step, error, onDone]);

  // 文本输入阶段使用 Settings 上下文，仅 Escape（而非 'n'）触发 confirm:no。
  // 这样用户在文本框中输入 'n' 时不会意外触发取消，但仍可用 Escape 取消。
  useKeybinding('confirm:no', handleCancel, {
    context: 'Settings',
    isActive: step === 'userInput',
  });

  useInput((input, key) => {
    // 完成或出错时，允许任意按键关闭对话框
    if (step === 'done') {
      if (key.return && title) {
        // 按 Enter 时打开 GitHub Issue URL
        const issueUrl = createGitHubIssueUrl(feedbackId ?? '', title, description, getSanitizedErrorLogs());
        void openBrowser(issueUrl);
      }
      if (error) {
        onDone('提交反馈 / bug 报告时出错', {
          display: 'system',
        });
      } else {
        onDone('反馈 / bug 报告已提交', { display: 'system' });
      }
      return;
    }

    // 在 userInput 步骤出错时，允许用户编辑后重试
    // （不因任意按键关闭 —— 仍可按 Esc 取消）
    if (error && step !== 'userInput') {
      onDone('提交反馈 / bug 报告时出错', {
        display: 'system',
      });
      return;
    }

    if (step === 'consent' && (key.return || input === ' ')) {
      void submitReport();
    }
  });

  return (
    <Dialog
      title="提交反馈 / Bug 报告"
      onCancel={handleCancel}
      isCancelActive={step !== 'userInput'}
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>再按一次 {exitState.keyName} 退出</Text>
        ) : step === 'userInput' ? (
          <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="继续" />
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="取消" />
          </Byline>
        ) : step === 'consent' ? (
          <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="提交" />
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="取消" />
          </Byline>
        ) : null
      }
    >
      {step === 'userInput' && (
        <Box flexDirection="column" gap={1}>
          <Text>请在下方描述问题：</Text>
          <TextInput
            value={description}
            onChange={value => {
              setDescription(value);
              // 用户开始编辑时清除错误，以允许重试
              if (error) {
                setError(null);
              }
            }}
            columns={textInputColumns}
            onSubmit={() => setStep('consent')}
            onExitMessage={() => onDone('反馈已取消', { display: 'system' })}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            showCursor
          />
          {error && (
            <Box flexDirection="column" gap={1}>
              <Text color="error">{error}</Text>
              <Text dimColor>编辑后按 Enter 重试，或按 Esc 取消</Text>
            </Box>
          )}
        </Box>
      )}

      {step === 'consent' && (
        <Box flexDirection="column">
          <Text>本报告将包含：</Text>
          <Box marginLeft={2} flexDirection="column">
            <Text>
              - 您的反馈 / bug 描述：<Text dimColor>{description}</Text>
            </Text>
            <Text>
              - 环境信息：{' '}
              <Text dimColor>
                {env.platform}, {env.terminal}, v{MACRO.VERSION}
              </Text>
            </Text>
            {envInfo.gitState && (
              <Text>
                - Git 仓库元数据：{' '}
                <Text dimColor>
                  {envInfo.gitState.branchName}
                  {envInfo.gitState.commitHash ? `, ${envInfo.gitState.commitHash.slice(0, 7)}` : ''}
                  {envInfo.gitState.remoteUrl ? ` @ ${envInfo.gitState.remoteUrl}` : ''}
                  {!envInfo.gitState.isHeadOnRemote && '，未同步'}
                  {!envInfo.gitState.isClean && '，有本地改动'}
                </Text>
              </Text>
            )}
            <Text>- 当前会话 transcript</Text>
          </Box>
          <Box marginTop={1}>
            <Text wrap="wrap" dimColor>
              我们将使用您的反馈来调试相关问题，或改进 Claude Code 的功能（例如降低未来出现 bug 的风险）。
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text>
              按 <Text bold>Enter</Text> 确认并提交。
            </Text>
          </Box>
        </Box>
      )}

      {step === 'submitting' && (
        <Box flexDirection="row" gap={1}>
          <Text>正在提交报告…</Text>
        </Box>
      )}

      {step === 'done' && (
        <Box flexDirection="column">
          {error ? <Text color="error">{error}</Text> : <Text color="success">感谢您的报告！</Text>}
          {feedbackId && <Text dimColor>反馈 ID：{feedbackId}</Text>}
          <Box marginTop={1}>
            <Text>按 </Text>
            <Text bold>Enter </Text>
            <Text>打开浏览器并起草 GitHub issue，或按任意其他键关闭。</Text>
          </Box>
        </Box>
      )}
    </Dialog>
  );
}

export function createGitHubIssueUrl(
  feedbackId: string,
  title: string,
  description: string,
  errors: Array<{
    error?: string;
    timestamp?: string;
  }>,
): string {
  const sanitizedTitle = redactSensitiveInfo(title);
  const sanitizedDescription = redactSensitiveInfo(description);

  const bodyPrefix =
    `**Bug 描述**\n${sanitizedDescription}\n\n` +
    `**环境信息**\n` +
    `- 平台：${env.platform}\n` +
    `- 终端：${env.terminal}\n` +
    `- 版本：${MACRO.VERSION || 'unknown'}\n` +
    `- 反馈 ID：${feedbackId}\n` +
    `\n**错误**\n\`\`\`json\n`;
  const errorSuffix = `\n\`\`\`\n`;
  const errorsJson = jsonStringify(errors);

  const baseUrl = `${GITHUB_ISSUES_REPO_URL}/new?title=${encodeURIComponent(sanitizedTitle)}&labels=user-reported,bug&body=`;
  const truncationNote = `\n**注意：** 内容已被截断。\n`;

  const encodedPrefix = encodeURIComponent(bodyPrefix);
  const encodedSuffix = encodeURIComponent(errorSuffix);
  const encodedNote = encodeURIComponent(truncationNote);
  const encodedErrors = encodeURIComponent(errorsJson);

  // 计算可用于错误信息的 URL 空间
  const spaceForErrors =
    GITHUB_URL_LIMIT - baseUrl.length - encodedPrefix.length - encodedSuffix.length - encodedNote.length;

  // 若仅描述内容即超出限制，则截断所有内容
  if (spaceForErrors <= 0) {
    const ellipsis = encodeURIComponent('…');
    const buffer = 50; // 额外安全余量
    const maxEncodedLength = GITHUB_URL_LIMIT - baseUrl.length - ellipsis.length - encodedNote.length - buffer;
    const fullBody = bodyPrefix + errorsJson + errorSuffix;
    let encodedFullBody = encodeURIComponent(fullBody);

    if (encodedFullBody.length > maxEncodedLength) {
      encodedFullBody = encodedFullBody.slice(0, maxEncodedLength);
      // 不在 %XX 序列中间截断
      const lastPercent = encodedFullBody.lastIndexOf('%');
      if (lastPercent >= encodedFullBody.length - 2) {
        encodedFullBody = encodedFullBody.slice(0, lastPercent);
      }
    }

    return baseUrl + encodedFullBody + ellipsis + encodedNote;
  }

  // 若错误信息放得下，无需截断
  if (encodedErrors.length <= spaceForErrors) {
    return baseUrl + encodedPrefix + encodedErrors + encodedSuffix;
  }

  // 截断错误信息以适应空间（优先保留描述内容）
  // 直接对已编码的错误字符串截片，再回退以避免截断 %XX 序列
  const ellipsis = encodeURIComponent('…');
  const buffer = 50; // 额外安全余量
  let truncatedEncodedErrors = encodedErrors.slice(0, spaceForErrors - ellipsis.length - buffer);
  // 若截断位置在 %XX 中间，回退到 % 之前
  const lastPercent = truncatedEncodedErrors.lastIndexOf('%');
  if (lastPercent >= truncatedEncodedErrors.length - 2) {
    truncatedEncodedErrors = truncatedEncodedErrors.slice(0, lastPercent);
  }

  return baseUrl + encodedPrefix + truncatedEncodedErrors + ellipsis + encodedSuffix + encodedNote;
}

async function generateTitle(description: string, abortSignal: AbortSignal): Promise<string> {
  try {
    const response = await queryHaiku({
      systemPrompt: asSystemPrompt([
        '根据这份 Claude Code 的 bug 报告，为公开 GitHub Issue 生成一个简洁的技术标题（最多 80 字符）。',
        'Claude Code 是一款基于 Anthropic API 的智能编程 CLI 工具。',
        '标题要求：',
        '- 标题首先标注问题类型 [Bug] 或 [Feature Request]',
        '- 简洁、具体，准确描述实际问题',
        '- 使用适合软件问题的技术术语',
        '- 对于错误信息，提取关键错误（例如使用 "Missing Tool Result Block" 而非完整信息）',
        '- 直接清晰，便于开发者理解问题',
        '- 若无法确定明确问题，使用 "Bug Report: [简短描述]"',
        '- 所有 LLM API 错误均来自 Anthropic API，而非其他模型提供商',
        '你的回复将直接用作 GitHub Issue 的标题，不得包含任何其他注释或说明',
        'Examples of good titles include: "[Bug] Auto-Compact triggers to soon", "[Bug] Anthropic API Error: Missing Tool Result Block", "[Bug] Error: Invalid Model Name for Opus"',
      ]),
      userPrompt: description,
      signal: abortSignal,
      options: {
        hasAppendSystemPrompt: false,
        toolChoice: undefined,
        isNonInteractiveSession: false,
        agents: [],
        querySource: 'feedback',
        mcpTools: [],
      },
    });

    const _firstBlock = response?.message?.content?.[0] as unknown as Record<string, unknown> | undefined;
    const title = _firstBlock?.type === 'text' ? (_firstBlock.text as string) : 'Bug Report';

    // 检查标题是否包含 API 错误信息
    if (startsWithApiErrorPrefix(title)) {
      return createFallbackTitle(description);
    }

    return title;
  } catch (error) {
    // 生成标题出错时使用回退标题
    logError(error);
    return createFallbackTitle(description);
  }
}

function createFallbackTitle(description: string): string {
  // 基于 bug 描述创建安全的回退标题

  // 尝试从第一行提取有意义的标题
  const firstLine = description.split('\n')[0] || '';

  // 若第一行很短，直接使用
  if (firstLine.length <= 60 && firstLine.length > 5) {
    return firstLine;
  }

  // 对于较长的描述，创建截断版本
  // 尽量在单词边界处截断
  let truncated = firstLine.slice(0, 60);
  if (firstLine.length > 60) {
    // 找到 60 字符限制前的最后一个空格
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > 30) {
      // 仅在不过度截断时按单词边界裁剪
      truncated = truncated.slice(0, lastSpace);
    }
    truncated += '...';
  }

  return truncated.length < 10 ? 'Bug Report' : truncated;
}

// 辅助函数：脱敏并记录错误，避免暴露 API 密钥
function sanitizeAndLogError(err: unknown): void {
  if (err instanceof Error) {
    // 创建副本并脱敏可能包含的敏感信息
    const safeError = new Error(redactSensitiveInfo(err.message));

    // 同时脱敏堆栈跟踪（若存在）
    if (err.stack) {
      safeError.stack = redactSensitiveInfo(err.stack);
    }

    logError(safeError);
  } else {
    // 对于非 Error 对象，转换为字符串后脱敏
    const errorString = redactSensitiveInfo(String(err));
    logError(new Error(errorString));
  }
}

async function submitFeedback(
  data: FeedbackData,
  signal?: AbortSignal,
): Promise<{ success: boolean; feedbackId?: string; isZdrOrg?: boolean }> {
  if (isEssentialTrafficOnly()) {
    return { success: false };
  }

  try {
    // 获取认证头前确保 OAuth 令牌是最新的
    // 防止因缓存令牌过期导致 401 错误
    await checkAndRefreshOAuthTokenIfNeeded();

    const authResult = getAuthHeaders();
    if (authResult.error) {
      return { success: false };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': getUserAgent(),
      ...authResult.headers,
    };

    const response = await axios.post(
      'https://api.anthropic.com/api/claude_cli_feedback',
      {
        content: jsonStringify(data),
      },
      {
        headers,
        timeout: 30000, // 30 秒超时，防止请求挂起
        signal,
      },
    );

    if (response.status === 200) {
      const result = response.data;
      if (result?.feedback_id) {
        return { success: true, feedbackId: result.feedback_id };
      }
      sanitizeAndLogError(new Error('提交反馈失败：请求未返回 feedback_id'));
      return { success: false };
    }

    sanitizeAndLogError(new Error('提交反馈失败：' + response.status));
    return { success: false };
  } catch (err) {
    // 处理取消/中止 —— 不记录为错误
    if (axios.isCancel(err)) {
      return { success: false };
    }

    if (axios.isAxiosError(err) && err.response?.status === 403) {
      const errorData = err.response.data;
      if (
        errorData?.error?.type === 'permission_error' &&
        errorData?.error?.message?.includes('Custom data retention settings')
      ) {
        sanitizeAndLogError(new Error('无法提交反馈，因为启用了自定义数据留存设置'));
        return { success: false, isZdrOrg: true };
      }
    }
    // 使用安全错误记录函数，避免泄露 API 密钥
    sanitizeAndLogError(err);
    return { success: false };
  }
}
