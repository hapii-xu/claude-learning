import { feature } from 'bun:bundle';
import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { getPlatform } from 'src/utils/platform.js';
import { isKeybindingCustomizationEnabled } from '../../keybindings/loadUserBindings.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js';
import { isFastModeAvailable, isFastModeEnabled } from '../../utils/fastMode.js';
import { getNewlineInstructions } from './utils.js';

/** 将快捷键格式化以在帮助菜单中展示（例如 "ctrl+o" → "ctrl + o"） */
function formatShortcut(shortcut: string): string {
  return shortcut.replace(/\+/g, ' + ');
}

type Props = {
  dimColor?: boolean;
  fixedWidth?: boolean;
  gap?: number;
  paddingX?: number;
};

export function PromptInputHelpMenu(props: Props): React.ReactNode {
  const { dimColor, fixedWidth, gap, paddingX } = props;

  // 从快捷键绑定系统中获取已配置的快捷键
  const transcriptShortcut = formatShortcut(useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o'));
  const todosShortcut = formatShortcut(useShortcutDisplay('app:toggleTodos', 'Global', 'ctrl+t'));
  const undoShortcut = formatShortcut(useShortcutDisplay('chat:undo', 'Chat', 'ctrl+_'));
  const stashShortcut = formatShortcut(useShortcutDisplay('chat:stash', 'Chat', 'ctrl+s'));
  const cycleModeShortcut = formatShortcut(useShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab'));
  const modelPickerShortcut = formatShortcut(useShortcutDisplay('chat:modelPicker', 'Chat', 'alt+p'));
  const fastModeShortcut = formatShortcut(useShortcutDisplay('chat:fastMode', 'Chat', 'alt+o'));
  const externalEditorShortcut = formatShortcut(useShortcutDisplay('chat:externalEditor', 'Chat', 'ctrl+g'));
  const terminalShortcut = formatShortcut(useShortcutDisplay('app:toggleTerminal', 'Global', 'meta+j'));
  const imagePasteShortcut = formatShortcut(useShortcutDisplay('chat:imagePaste', 'Chat', 'ctrl+v'));

  // 在 JSX 外部计算终端快捷键元素，以满足 feature() 的使用限制
  const terminalShortcutElement = feature('TERMINAL_PANEL') ? (
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_terminal_panel', false) ? (
      <Box>
        <Text dimColor={dimColor}>{terminalShortcut} 打开终端</Text>
      </Box>
    ) : null
  ) : null;

  return (
    <Box paddingX={paddingX} flexDirection="row" gap={gap}>
      <Box flexDirection="column" width={fixedWidth ? 24 : undefined}>
        <Box>
          <Text dimColor={dimColor}>! 进入 bash 模式</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>/ 输入命令</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>@ 引用文件路径</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>& 后台执行</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>/btw 插入旁注问题</Text>
        </Box>
      </Box>
      <Box flexDirection="column" width={fixedWidth ? 35 : undefined}>
        <Box>
          <Text dimColor={dimColor}>双击 esc 清空输入</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>
            {cycleModeShortcut} {process.env.USER_TYPE === 'ant' ? '循环切换模式' : '自动接受编辑'}
          </Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>{transcriptShortcut} 开启详细输出</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>{todosShortcut} 切换任务面板</Text>
        </Box>
        {terminalShortcutElement}
        <Box>
          <Text dimColor={dimColor}>{getNewlineInstructions()}</Text>
        </Box>
      </Box>
      <Box flexDirection="column">
        <Box>
          <Text dimColor={dimColor}>{undoShortcut} 撤销</Text>
        </Box>
        {getPlatform() !== 'windows' && (
          <Box>
            <Text dimColor={dimColor}>ctrl + z 挂起进程</Text>
          </Box>
        )}
        <Box>
          <Text dimColor={dimColor}>{imagePasteShortcut} 粘贴图片</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>{modelPickerShortcut} 切换模型</Text>
        </Box>
        {isFastModeEnabled() && isFastModeAvailable() && (
          <Box>
            <Text dimColor={dimColor}>{fastModeShortcut} 切换快速模式</Text>
          </Box>
        )}
        <Box>
          <Text dimColor={dimColor}>{stashShortcut} 储藏当前 prompt</Text>
        </Box>
        <Box>
          <Text dimColor={dimColor}>{externalEditorShortcut} 在 $EDITOR 中编辑</Text>
        </Box>
        {isKeybindingCustomizationEnabled() && (
          <Box>
            <Text dimColor={dimColor}>/keybindings 自定义快捷键</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
