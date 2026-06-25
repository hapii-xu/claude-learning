import React, { useEffect, useState } from 'react';
import type { CommandResultDisplay } from '../commands.js';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- 原始输入用于"任意键关闭"和 y/n 提示
import { Box, Text, useInput, LoadingState } from '@anthropic/ink';
import { getDesktopInstallStatus, openCurrentSessionInDesktop } from '../utils/desktopDeepLink.js';
import { openBrowser } from '../utils/browser.js';

import { errorMessage } from '../utils/errors.js';
import { gracefulShutdown } from '../utils/gracefulShutdown.js';
import { flushSessionStorage } from '../utils/sessionStorage.js';

const DESKTOP_DOCS_URL = 'https://clau.de/desktop';

export function getDownloadUrl(): string {
  switch (process.platform) {
    case 'win32':
      return 'https://claude.ai/api/desktop/win32/x64/exe/latest/redirect';
    default:
      return 'https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect';
  }
}

type DesktopHandoffState = 'checking' | 'prompt-download' | 'flushing' | 'opening' | 'success' | 'error';

type Props = {
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void;
};

export function DesktopHandoff({ onDone }: Props): React.ReactNode {
  const [state, setState] = useState<DesktopHandoffState>('checking');
  const [error, setError] = useState<string | null>(null);
  const [downloadMessage, setDownloadMessage] = useState<string>('');

  // \u5904\u7406\u9519\u8bef\u548c\u4e0b\u8f7d\u63d0\u793a\u72b6\u6001\u4e0b\u7684\u952e\u76d8\u8f93\u5165
  useInput(input => {
    if (state === 'error') {
      onDone(error ?? '\u672a\u77e5\u9519\u8bef', { display: 'system' });
      return;
    }
    if (state === 'prompt-download') {
      if (input === 'y' || input === 'Y') {
        openBrowser(getDownloadUrl()).catch(() => {});
        onDone(
          `\u5f00\u59cb\u4e0b\u8f7d\u3002\u5b89\u88c5\u5b8c\u6210\u540e\u8bf7\u91cd\u65b0\u8fd0\u884c /desktop\u3002\n\u4e86\u89e3\u66f4\u591a\uff1a${DESKTOP_DOCS_URL}`,
          { display: 'system' },
        );
      } else if (input === 'n' || input === 'N') {
        onDone(
          `/desktop \u9700\u8981\u684c\u9762\u7aef\u5e94\u7528\u3002\u4e86\u89e3\u66f4\u591a\uff1a${DESKTOP_DOCS_URL}`,
          { display: 'system' },
        );
      }
    }
  });

  useEffect(() => {
    async function performHandoff(): Promise<void> {
      // \u68c0\u67e5\u684c\u9762\u7aef\u5b89\u88c5\u72b6\u6001
      setState('checking');
      const installStatus = await getDesktopInstallStatus();

      if (installStatus.status === 'not-installed') {
        setDownloadMessage('\u672a\u5b89\u88c5 Claude Desktop\u3002');
        setState('prompt-download');
        return;
      }

      if (installStatus.status === 'version-too-old') {
        setDownloadMessage(
          `Claude Desktop \u9700\u8981\u66f4\u65b0\uff08\u68c0\u6d4b\u5230 v${installStatus.version}\uff0c\u9700\u8981 v1.1.2396+\uff09\u3002`,
        );
        setState('prompt-download');
        return;
      }

      // \u5237\u65b0\u4f1a\u8bdd\u5b58\u50a8\uff0c\u786e\u4fdd\u5bf9\u8bdd\u8bb0\u5f55\u5df2\u5b8c\u6574\u5199\u5165
      setState('flushing');
      await flushSessionStorage();

      // \u6253\u5f00 deep link\uff08\u5f00\u53d1\u6a21\u5f0f\u4e0b\u4f7f\u7528 claude-dev://\uff09
      setState('opening');
      const result = await openCurrentSessionInDesktop();

      if (!result.success) {
        setError(result.error ?? '\u6253\u5f00 Claude Desktop \u5931\u8d25');
        setState('error');
        return;
      }

      // \u6210\u529f \u2014\u2014 \u9000\u51fa CLI
      setState('success');

      // \u7ed9\u7528\u6237\u4e00\u70b9\u65f6\u95f4\u770b\u5230\u6210\u529f\u63d0\u793a
      setTimeout(
        async (onDone: Props['onDone']) => {
          onDone('\u4f1a\u8bdd\u5df2\u8f6c\u79fb\u5230 Claude Desktop', { display: 'system' });
          await gracefulShutdown(0, 'other');
        },
        500,
        onDone,
      );
    }

    performHandoff().catch(err => {
      setError(errorMessage(err));
      setState('error');
    });
  }, [onDone]);

  if (state === 'error') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text color="error">错误：{error}</Text>
        <Text dimColor>按任意键继续…</Text>
      </Box>
    );
  }

  if (state === 'prompt-download') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text>{downloadMessage}</Text>
        <Text>立即下载？(y/n)</Text>
      </Box>
    );
  }

  const messages: Record<Exclude<DesktopHandoffState, 'error' | 'prompt-download'>, string> = {
    checking: '正在检查 Claude Desktop…',
    flushing: '正在保存会话…',
    opening: '正在打开 Claude Desktop…',
    success: '正在 Claude Desktop 中打开…',
  };

  return <LoadingState message={messages[state]} />;
}
