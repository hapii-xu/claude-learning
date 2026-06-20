import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { randomUUID } from 'crypto';
import * as React from 'react';
import { BashModeProgress } from 'src/components/BashModeProgress.js';
import type { SetToolJSXFn } from 'src/Tool.js';
import { BashTool } from '@claude-code-best/builtin-tools/tools/BashTool/BashTool.js';
import type { AttachmentMessage, SystemMessage, UserMessage } from 'src/types/message.js';
import type { ShellProgress } from 'src/types/tools.js';
import { logEvent } from '../../services/analytics/index.js';
import { errorMessage, ShellError } from '../errors.js';
import {
  createSyntheticUserCaveatMessage,
  createUserInterruptionMessage,
  createUserMessage,
  prepareUserContent,
} from '../messages.js';
import { resolveDefaultShell } from '../shell/resolveDefaultShell.js';
import { isPowerShellToolEnabled } from '../shell/shellToolUtils.js';
import { processToolResultBlock } from '../toolResultStorage.js';
import { escapeXml } from '../xml.js';
import type { ProcessUserInputContext } from './processUserInput.js';

export async function processBashCommand(
  inputString: string,
  precedingInputBlocks: ContentBlockParam[],
  attachmentMessages: AttachmentMessage[],
  context: ProcessUserInputContext,
  setToolJSX: SetToolJSXFn,
): Promise<{
  messages: (UserMessage | AttachmentMessage | SystemMessage)[];
  shouldQuery: boolean;
}> {
  // Shell 路由（docs/design/ps-shell-selection.md §5.2）：查阅
  // defaultShell，回退到 bash。isPowerShellToolEnabled() 应用与 tools.ts
  // 相同的平台 + 环境变量门控，使输入框路由与工具列表可见性一致。
  // 提前计算以便遥测记录实际使用的 shell，而非原始设置。
  const usePowerShell = isPowerShellToolEnabled() && resolveDefaultShell() === 'powershell';

  logEvent('tengu_input_bash', { powershell: usePowerShell });

  const userMessage = createUserMessage({
    content: prepareUserContent({
      inputString: `<bash-input>${inputString}</bash-input>`,
      precedingInputBlocks,
    }),
  });

  // ctrl+b to background indicator
  let jsx: React.ReactNode;

  // 仅显示初始 UI
  setToolJSX({
    jsx: <BashModeProgress input={inputString} progress={null} verbose={context.options.verbose} />,
    shouldHidePromptInput: false,
  });

  try {
    const bashModeContext: ProcessUserInputContext = {
      ...context,
      // TODO: Clean up this hack
      setToolJSX: _ => {
        jsx = _?.jsx;
      },
    };

    // Progress UI — shared across both shell backends (both emit ShellProgress)
    const onProgress = (progress: { data: ShellProgress }) => {
      setToolJSX({
        jsx: (
          <>
            <BashModeProgress input={inputString!} progress={progress.data} verbose={context.options.verbose} />
            {jsx}
          </>
        ),
        shouldHidePromptInput: false,
        showSpinner: false,
      });
    };

    // User-initiated `!` commands run outside sandbox. Both shell tools honor
    // dangerouslyDisableSandbox (checked against areUnsandboxedCommandsAllowed()
    // in shouldUseSandbox.ts). PS sandbox is Linux/macOS/WSL2 only — on Windows
    // native, shouldUseSandbox() returns false regardless (unsupported platform).
    // Lazy-require PowerShellTool so its ~300KB chunk only loads when the
    // user has actually selected the powershell default shell.
    type PSMod = typeof import('@claude-code-best/builtin-tools/tools/PowerShellTool/PowerShellTool.js');
    let PowerShellTool: PSMod['PowerShellTool'] | null = null;
    if (usePowerShell) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      PowerShellTool = (require('@claude-code-best/builtin-tools/tools/PowerShellTool/PowerShellTool.js') as PSMod)
        .PowerShellTool;
      /* eslint-enable @typescript-eslint/no-require-imports */
    }
    const shellTool = PowerShellTool ?? BashTool;

    const response = PowerShellTool
      ? await PowerShellTool.call(
          { command: inputString, dangerouslyDisableSandbox: true },
          bashModeContext,
          undefined,
          undefined,
          onProgress,
        )
      : await BashTool.call(
          {
            command: inputString,
            dangerouslyDisableSandbox: true,
          },
          bashModeContext,
          undefined,
          undefined,
          onProgress,
        );
    const data = response.data;

    if (!data) {
      throw new Error('No result received from shell command');
    }

    const stderr = data.stderr;
    // 复用与内联 !`cmd` bash（promptShellExecution）及模型发起的 Bash
    // 相同的格式化管线。当 BashTool.call() 将大输出持久化到磁盘时，
    // data.persistedOutputPath 会被设置，格式化器将其包裹在 <persisted-output> 中。
    // 传入 stderr:'' 以将其分离给 <bash-stderr> UI 标签。
    const mapped = await processToolResultBlock(shellTool, { ...data, stderr: '' }, randomUUID());
    // mapped.content 可能包含我们自己的 <persisted-output> 包装器
    // （来自 buildLargeToolResultMessage 的可信 XML）。转义它会将结构标签
    // 变成 &lt;persisted-output&gt;，破坏模型解析与
    // UserBashOutputMessage 的 extractTag。仅对原始回退做转义。
    const stdout = typeof mapped.content === 'string' ? mapped.content : escapeXml(data.stdout);
    return {
      messages: [
        createSyntheticUserCaveatMessage(),
        userMessage,
        ...attachmentMessages,
        createUserMessage({
          content: `<bash-stdout>${stdout}</bash-stdout><bash-stderr>${escapeXml(stderr)}</bash-stderr>`,
        }),
      ],
      shouldQuery: false,
    };
  } catch (e) {
    if (e instanceof ShellError) {
      if (e.interrupted) {
        return {
          messages: [
            createSyntheticUserCaveatMessage(),
            userMessage,
            createUserInterruptionMessage({ toolUse: false }),
            ...attachmentMessages,
          ],
          shouldQuery: false,
        };
      }
      return {
        messages: [
          createSyntheticUserCaveatMessage(),
          userMessage,
          ...attachmentMessages,
          createUserMessage({
            content: `<bash-stdout>${escapeXml(e.stdout)}</bash-stdout><bash-stderr>${escapeXml(e.stderr)}</bash-stderr>`,
          }),
        ],
        shouldQuery: false,
      };
    }
    return {
      messages: [
        createSyntheticUserCaveatMessage(),
        userMessage,
        ...attachmentMessages,
        createUserMessage({
          content: `<bash-stderr>Command failed: ${escapeXml(errorMessage(e))}</bash-stderr>`,
        }),
      ],
      shouldQuery: false,
    };
  } finally {
    setToolJSX(null);
  }
}
