import figures from 'figures';
import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import {
  AGENT_COLOR_TO_THEME_COLOR,
  AGENT_COLORS,
  type AgentColorName,
} from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js';
import type { PromptInputMode } from 'src/types/textInputTypes.js';
import { getTeammateColor } from 'src/utils/teammate.js';
import type { Theme } from 'src/utils/theme.js';
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js';

type Props = {
  mode: PromptInputMode;
  isLoading: boolean;
  viewingAgentName?: string;
  viewingAgentColor?: AgentColorName;
};

/**
 * 获取队友分配颜色对应的主题色键名。
 * 如果不是队友或颜色无效则返回 undefined。
 */
function getTeammateThemeColor(): keyof Theme | undefined {
  if (!isAgentSwarmsEnabled()) {
    return undefined;
  }
  const colorName = getTeammateColor();
  if (!colorName) {
    return undefined;
  }
  if (AGENT_COLORS.includes(colorName as AgentColorName)) {
    return AGENT_COLOR_TO_THEME_COLOR[colorName as AgentColorName];
  }
  return undefined;
}

type PromptCharProps = {
  isLoading: boolean;
  // 死代码消除：参数命名为 themeColor，以避免在外部构建产物中出现 "teammate" 字符串
  themeColor?: keyof Theme;
};

/**
 * 渲染提示符字符（❯）。
 * 当设置了队友颜色时，覆盖默认颜色。
 */
function PromptChar({ isLoading, themeColor }: PromptCharProps): React.ReactNode {
  // 赋值给原始名称，便于函数内部阅读
  const teammateColor = themeColor;
  const isAnt = process.env.USER_TYPE === 'ant';
  const color = teammateColor ?? (isAnt ? 'subtle' : undefined);

  return (
    <Text color={color} dimColor={isLoading}>
      {figures.pointer}&nbsp;
    </Text>
  );
}

export function PromptInputModeIndicator({
  mode,
  isLoading,
  viewingAgentName,
  viewingAgentColor,
}: Props): React.ReactNode {
  const teammateColor = getTeammateThemeColor();

  // 将正在查看的队友颜色转换为主题色键名
  // 未设置时回退到 PromptChar 的默认值（ant 用户为 subtle，外部用户为 undefined）
  const viewedTeammateThemeColor = viewingAgentColor ? AGENT_COLOR_TO_THEME_COLOR[viewingAgentColor] : undefined;

  return (
    <Box alignItems="flex-start" alignSelf="flex-start" flexWrap="nowrap" justifyContent="flex-start">
      {viewingAgentName ? (
        // 在标准提示符字符上使用队友的颜色，与已有风格保持一致
        <PromptChar isLoading={isLoading} themeColor={viewedTeammateThemeColor} />
      ) : mode === 'bash' ? (
        <Text color="bashBorder" dimColor={isLoading}>
          !&nbsp;
        </Text>
      ) : (
        <PromptChar isLoading={isLoading} themeColor={isAgentSwarmsEnabled() ? teammateColor : undefined} />
      )}
    </Box>
  );
}
