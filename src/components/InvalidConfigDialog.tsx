import React from 'react';
import { Box, Dialog, wrappedRender as render, Text } from '@anthropic/ink';
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js';
import { AppStateProvider } from '../state/AppState.js';
import type { ConfigParseError } from '../utils/errors.js';
import { getBaseRenderOptions } from '../utils/renderOptions.js';
import { jsonStringify, writeFileSync_DEPRECATED } from '../utils/slowOperations.js';
import type { ThemeName } from '../utils/theme.js';
import { Select } from './CustomSelect/index.js';

interface InvalidConfigHandlerProps {
  error: ConfigParseError;
}

interface InvalidConfigDialogProps {
  filePath: string;
  errorDescription: string;
  onExit: () => void;
  onReset: () => void;
}

/**
 * 当 Claude 配置文件包含无效 JSON 时显示的对话框
 */
function InvalidConfigDialog({
  filePath,
  errorDescription,
  onExit,
  onReset,
}: InvalidConfigDialogProps): React.ReactNode {
  // Select 的 onChange 处理函数
  const handleSelect = (value: string) => {
    if (value === 'exit') {
      onExit();
    } else {
      onReset();
    }
  };

  return (
    <Dialog title="配置错误" color="error" onCancel={onExit}>
      <Box flexDirection="column" gap={1}>
        <Text>
          位于 <Text bold>{filePath}</Text> 的配置文件包含无效的 JSON。
        </Text>
        <Text>{errorDescription}</Text>
      </Box>
      <Box flexDirection="column">
        <Text bold>请选择一个选项：</Text>
        <Select
          options={[
            { label: '退出并手动修复', value: 'exit' },
            { label: '重置为默认配置', value: 'reset' },
          ]}
          onChange={handleSelect}
          onCancel={onExit}
        />
      </Box>
    </Dialog>
  );
}

/**
 * 用于错误对话框的安全回退主题名，避免循环依赖。
 * 使用硬编码的暗色主题，无需从配置读取。
 */
const SAFE_ERROR_THEME_NAME: ThemeName = 'dark';

export async function showInvalidConfigDialog({ error }: InvalidConfigHandlerProps): Promise<void> {
  // 为此特定用法扩展 RenderOptions，增加 theme 属性
  type SafeRenderOptions = Parameters<typeof render>[1] & { theme?: ThemeName };

  const renderOptions: SafeRenderOptions = {
    ...getBaseRenderOptions(false),
    // 重要：使用硬编码的主题名以避免与 getGlobalConfig() 的循环依赖
    // 这使得即便配置文件有 JSON 语法错误，错误对话框也能正常显示
    theme: SAFE_ERROR_THEME_NAME,
  };

  // biome-ignore lint/suspicious/noAsyncPromiseExecutor: render must be awaited inside executor
  await new Promise<void>(async resolve => {
    const { unmount } = await render(
      <AppStateProvider>
        <KeybindingSetup>
          <InvalidConfigDialog
            filePath={error.filePath}
            errorDescription={error.message}
            onExit={() => {
              unmount();
              void resolve();
              process.exit(1);
            }}
            onReset={() => {
              writeFileSync_DEPRECATED(error.filePath, jsonStringify(error.defaultConfig, null, 2), {
                flush: false,
                encoding: 'utf8',
              });
              unmount();
              void resolve();
              process.exit(0);
            }}
          />
        </KeybindingSetup>
      </AppStateProvider>,
      renderOptions,
    );
  });
}
