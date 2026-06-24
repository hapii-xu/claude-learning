/**
 * ViewHookMode 显示单个已配置 hook 的只读详情。
 *
 * /hooks 菜单是只读的；此视图替代了原先的删除 hook 确认界面，
 * 并引导用户通过 settings.json 或 Claude 进行编辑。
 */
import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { hookSourceDescriptionDisplayString, type IndividualHookConfig } from '../../utils/hooks/hooksSettings.js';
import { Dialog } from '@anthropic/ink';

type Props = {
  selectedHook: IndividualHookConfig;
  eventSupportsMatcher: boolean;
  onCancel: () => void;
};

export function ViewHookMode({ selectedHook, eventSupportsMatcher, onCancel }: Props): React.ReactNode {
  return (
    <Dialog title="钩子详情" onCancel={onCancel} inputGuide={() => <Text>Esc 返回</Text>}>
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text>
            事件：<Text bold>{selectedHook.event}</Text>
          </Text>
          {eventSupportsMatcher && (
            <Text>
              匹配器：<Text bold>{selectedHook.matcher || '（全部）'}</Text>
            </Text>
          )}
          <Text>
            类型：<Text bold>{selectedHook.config.type}</Text>
          </Text>
          <Text>
            来源：<Text dimColor>{hookSourceDescriptionDisplayString(selectedHook.source)}</Text>
          </Text>
          {selectedHook.pluginName && (
            <Text>
              插件：<Text dimColor>{selectedHook.pluginName}</Text>
            </Text>
          )}
        </Box>
        <Box flexDirection="column">
          <Text dimColor>{getContentFieldLabel(selectedHook.config)}：</Text>
          <Box borderStyle="round" borderDimColor paddingLeft={1} paddingRight={1}>
            <Text>{getContentFieldValue(selectedHook.config)}</Text>
          </Box>
        </Box>
        {'statusMessage' in selectedHook.config && selectedHook.config.statusMessage && (
          <Text>
            状态消息：<Text dimColor>{selectedHook.config.statusMessage}</Text>
          </Text>
        )}
        <Text dimColor>要修改或删除此钩子，请直接编辑 settings.json 或请求 Claude 帮助。</Text>
      </Box>
    </Dialog>
  );
}

/**
 * 根据 hook 的类型，为其主要内容字段获取人类可读的标签。
 */
function getContentFieldLabel(config: IndividualHookConfig['config']): string {
  switch (config.type) {
    case 'command':
      return '命令';
    case 'prompt':
      return '提示词';
    case 'agent':
      return '提示词';
    case 'http':
      return 'URL';
  }
}

/**
 * 获取 hook 主字段的实际内容值，绕过 statusMessage
 * 以便详情视图总是显示真实的 command/prompt/URL。
 */
function getContentFieldValue(config: IndividualHookConfig['config']): string {
  switch (config.type) {
    case 'command':
      return config.command;
    case 'prompt':
      return config.prompt;
    case 'agent':
      return config.prompt;
    case 'http':
      return config.url;
  }
}
