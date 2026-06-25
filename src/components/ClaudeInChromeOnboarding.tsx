import React from 'react';
import { logEvent } from 'src/services/analytics/index.js';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- 按 Enter 继续
import { Box, Dialog, Link, Newline, Text, useInput } from '@anthropic/ink';
import { isChromeExtensionInstalled } from '../utils/claudeInChrome/setup.js';
import { saveGlobalConfig } from '../utils/config.js';

const CHROME_EXTENSION_URL = 'https://claude.ai/chrome';
const CHROME_PERMISSIONS_URL = 'https://clau.de/chrome/permissions';

type Props = {
  onDone(): void;
};

export function ClaudeInChromeOnboarding({ onDone }: Props): React.ReactNode {
  const [isExtensionInstalled, setIsExtensionInstalled] = React.useState(false);

  React.useEffect(() => {
    logEvent('tengu_claude_in_chrome_onboarding_shown', {});
    void isChromeExtensionInstalled().then(setIsExtensionInstalled);
    saveGlobalConfig(current => {
      return { ...current, hasCompletedClaudeInChromeOnboarding: true };
    });
  }, []);

  // 处理 Enter 键继续操作
  useInput((_input, key) => {
    if (key.return) {
      onDone();
    }
  });

  return (
    <Dialog title="Claude in Chrome (Beta)" onCancel={onDone} color="chromeYellow">
      <Box flexDirection="column" gap={1}>
        <Text>
          Claude in Chrome 配合 Chrome 扩展，让您可以直接从 Claude Code 控制浏览器。
          您可以浏览网站、填写表单、截图、录制 GIF，并通过控制台日志和网络请求进行调试。
          {!isExtensionInstalled && (
            <>
              <Newline />
              <Newline />
              需要安装 Chrome 扩展。请在 <Link url={CHROME_EXTENSION_URL} /> 开始使用。
            </>
          )}
        </Text>

        <Text dimColor>
          站点级权限继承自 Chrome 扩展。在 Chrome 扩展设置中管理权限，可控制 Claude 能浏览、点击、输入的站点
          {isExtensionInstalled && (
            <>
              {' '}
              (<Link url={CHROME_PERMISSIONS_URL} />)
            </>
          )}
          。
        </Text>
        <Text dimColor>
          了解更多信息，请使用{' '}
          <Text bold color="chromeYellow">
            /chrome
          </Text>{' '}
          或访问 <Link url="https://code.claude.com/docs/en/chrome" />
        </Text>
      </Box>
    </Dialog>
  );
}
