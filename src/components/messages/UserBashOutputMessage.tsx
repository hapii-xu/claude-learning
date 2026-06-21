import * as React from 'react';
import BashToolResultMessage from '@claude-code-best/builtin-tools/tools/BashTool/BashToolResultMessage.js';
import { extractTag } from '../../utils/messages.js';

export function UserBashOutputMessage({ content, verbose }: { content: string; verbose?: boolean }): React.ReactNode {
  const rawStdout = extractTag(content, 'bash-stdout') ?? '';
  // 如果存在 <persisted-output> 则解包 —— 保留内部内容（文件路径 +
  // 预览）给用户；wrapper tag 本身是面向模型的信号。
  const stdout = extractTag(rawStdout, 'persisted-output') ?? rawStdout;
  const stderr = extractTag(content, 'bash-stderr') ?? '';
  return <BashToolResultMessage content={{ stdout, stderr }} verbose={!!verbose} />;
}
