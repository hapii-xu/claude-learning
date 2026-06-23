import React from 'react';
import { removeSandboxViolationTags } from 'src/utils/sandbox/sandbox-ui-utils.js';
import { KeyboardShortcutHint } from '@anthropic/ink';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { OutputLine } from 'src/components/shell/OutputLine.js';
import { ShellTimeDisplay } from 'src/components/shell/ShellTimeDisplay.js';
import { Box, Text } from '@anthropic/ink';
import type { Out as BashOut } from './BashTool.js';

type Props = {
  content: Omit<BashOut, 'interrupted'>;
  verbose: boolean;
  timeoutMs?: number;
};

// 用于匹配 "Shell cwd was reset to <path>" 消息的正则
// 使用 (?:^|\n) 来匹配字符串开头或换行之后的位置
const SHELL_CWD_RESET_PATTERN = /(?:^|\n)(Shell cwd was reset to .+)$/;

/**
 * 若 stderr 中存在沙箱违规信息，则将其提取出来
 * 返回清理后的 stderr 以及违规内容
 */
function extractSandboxViolations(stderr: string): {
  cleanedStderr: string;
} {
  const violationsMatch = stderr.match(/<sandbox_violations>([\s\S]*?)<\/sandbox_violations>/);

  if (!violationsMatch) {
    return { cleanedStderr: stderr };
  }

  // 从 stderr 中移除沙箱违规段落
  const cleanedStderr = removeSandboxViolationTags(stderr).trim();

  return {
    cleanedStderr,
  };
}

/**
 * 从 stderr 中提取 "Shell cwd was reset" 警告消息
 * 分别返回清理后的 stderr 与该警告消息
 */
function extractCwdResetWarning(stderr: string): {
  cleanedStderr: string;
  cwdResetWarning: string | null;
} {
  const match = stderr.match(SHELL_CWD_RESET_PATTERN);
  if (!match) {
    return { cleanedStderr: stderr, cwdResetWarning: null };
  }

  // 从捕获组 1 中提取警告消息
  const cwdResetWarning = match[1] ?? null;
  // 从 stderr 中移除该警告（替换掉整个匹配）
  const cleanedStderr = stderr.replace(SHELL_CWD_RESET_PATTERN, '').trim();

  return { cleanedStderr, cwdResetWarning };
}

export default function BashToolResultMessage({
  content: {
    stdout = '',
    stderr: stdErrWithViolations = '',
    isImage,
    returnCodeInterpretation,
    noOutputExpected,
    backgroundTaskId,
  },
  verbose,
  timeoutMs,
}: Props): React.ReactNode {
  // 从 stderr 中提取沙箱违规信息，这样在 UI 上看起来更干净
  // 我们希望模型能够看到违规内容，以便解释哪里出了问题，
  // 同时用户可以在违规日志中查看它们
  const { cleanedStderr: stderrWithoutViolations } = extractSandboxViolations(stdErrWithViolations);

  // 提取 "Shell cwd was reset" 警告，改用警告色（而非错误色）渲染
  const { cleanedStderr: stderr, cwdResetWarning } = extractCwdResetWarning(stderrWithoutViolations);

  // 若是图片，则在 UI 中不做截断
  if (isImage) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>[已检测到图片数据并发送至 Claude]</Text>
      </MessageResponse>
    );
  }

  return (
    <Box flexDirection="column">
      {stdout !== '' ? <OutputLine content={stdout} verbose={verbose} /> : null}
      {stderr.trim() !== '' ? <OutputLine content={stderr} verbose={verbose} isError /> : null}
      {cwdResetWarning ? (
        <MessageResponse>
          <Text dimColor>{cwdResetWarning}</Text>
        </MessageResponse>
      ) : null}
      {stdout === '' && stderr.trim() === '' && !cwdResetWarning ? (
        <MessageResponse height={1}>
          <Text dimColor>
            {backgroundTaskId ? (
              <>
                正在后台运行 <KeyboardShortcutHint shortcut="↓" action="管理" parens />
              </>
            ) : (
              returnCodeInterpretation || (noOutputExpected ? '完成' : '（无输出）')
            )}
          </Text>
        </MessageResponse>
      ) : null}
      {timeoutMs && (
        <MessageResponse>
          <ShellTimeDisplay timeoutMs={timeoutMs} />
        </MessageResponse>
      )}
    </Box>
  );
}
