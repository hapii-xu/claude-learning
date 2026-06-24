import { memo, type ReactNode } from 'react';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Box, Text, stringWidth } from '@anthropic/ink';
import { truncatePathMiddle, truncateToWidth } from '../../utils/format.js';
import type { Theme } from '../../utils/theme.js';

export type SuggestionItem = {
  id: string;
  displayText: string;
  tag?: string;
  description?: string;
  metadata?: unknown;
  color?: keyof Theme;
};

export type SuggestionType =
  | 'command'
  | 'file'
  | 'directory'
  | 'agent'
  | 'shell'
  | 'custom-title'
  | 'slack-channel'
  | 'none';

export const OVERLAY_MAX_ITEMS = 5;

/**
 * 根据建议类型获取对应图标
 * 图标：+ 表示文件，◇ 表示 MCP 资源，* 表示 agent
 */
function getIcon(itemId: string): string {
  if (itemId.startsWith('file-')) return '+';
  if (itemId.startsWith('mcp-resource-')) return '◇';
  if (itemId.startsWith('agent-')) return '*';
  return '+';
}

/**
 * 检查某项是否为统一建议类型（文件、mcp-resource 或 agent）
 */
function isUnifiedSuggestion(itemId: string): boolean {
  return itemId.startsWith('file-') || itemId.startsWith('mcp-resource-') || itemId.startsWith('agent-');
}

const SuggestionItemRow = memo(function SuggestionItemRow({
  item,
  maxColumnWidth,
  isSelected,
}: {
  item: SuggestionItem;
  maxColumnWidth?: number;
  isSelected: boolean;
}): ReactNode {
  const columns = useTerminalSize().columns;
  const isUnified = isUnifiedSuggestion(item.id);

  // 对于统一建议（文件、mcp-resource、agent），使用带图标的单行布局
  if (isUnified) {
    const icon = getIcon(item.id);
    const textColor: keyof Theme | undefined = isSelected ? 'suggestion' : undefined;
    const dimColor = !isSelected;

    const isFile = item.id.startsWith('file-');
    const isMcpResource = item.id.startsWith('mcp-resource-');

    // 计算布局宽度
    // 布局："X "（2）+ 显示文本 + " – "（3）+ 描述 + 内边距（4）
    const iconWidth = 2; // 图标 + 空格（固定）
    const paddingWidth = 4;
    const separatorWidth = item.description ? 3 : 0; // ' – ' 分隔符

    // 文件：从路径中间截断，以同时显示目录上下文和文件名
    // MCP 资源：将 displayText 限制为 30 个字符（从末尾截断）
    // agent：不截断
    let displayText: string;
    if (isFile) {
      // 如果有描述则预留空间，否则使用全部可用空间
      const descReserve = item.description ? Math.min(20, stringWidth(item.description)) : 0;
      const maxPathLength = columns - iconWidth - paddingWidth - separatorWidth - descReserve;
      displayText = truncatePathMiddle(item.displayText, maxPathLength);
    } else if (isMcpResource) {
      const maxDisplayTextLength = 30;
      displayText = truncateToWidth(item.displayText, maxDisplayTextLength);
    } else {
      displayText = item.displayText;
    }

    const availableWidth = columns - iconWidth - stringWidth(displayText) - separatorWidth - paddingWidth;

    // 将整行构建为单个字符串以防止自动换行
    let lineContent: string;
    if (item.description) {
      const maxDescLength = Math.max(0, availableWidth);
      const truncatedDesc = truncateToWidth(item.description.replace(/\s+/g, ' '), maxDescLength);
      lineContent = `${icon} ${displayText} – ${truncatedDesc}`;
    } else {
      lineContent = `${icon} ${displayText}`;
    }

    return (
      <Text color={textColor} dimColor={dimColor} wrap="truncate">
        {lineContent}
      </Text>
    );
  }

  // 对于非统一建议（命令、shell 等），使用 main 中改进的布局
  // 将命令名称列限制为终端宽度的 40%，以确保描述有足够空间
  const maxNameWidth = Math.floor(columns * 0.4);
  const displayTextWidth = Math.min(maxColumnWidth ?? stringWidth(item.displayText) + 5, maxNameWidth);

  const textColor = item.color || (isSelected ? 'suggestion' : undefined);
  const shouldDim = !isSelected;

  // 将显示文本截断并填充至固定宽度
  let displayText = item.displayText;
  if (stringWidth(displayText) > displayTextWidth - 2) {
    displayText = truncateToWidth(displayText, displayTextWidth - 2);
  }
  const paddedDisplayText = displayText + ' '.repeat(Math.max(0, displayTextWidth - stringWidth(displayText)));

  const tagText = item.tag ? `[${item.tag}] ` : '';
  const tagWidth = stringWidth(tagText);
  const descriptionWidth = Math.max(0, columns - displayTextWidth - tagWidth - 4);
  // Skill 描述可能含有换行符（例如 /claude-api 的「TRIGGER when:」块）。
  // 多行行会使叠加层超过 minHeight；当过滤器筛过该 skill 后，叠加层缩小并留下幽灵行。
  // 截断前先将其展平为单行。
  const truncatedDescription = item.description
    ? truncateToWidth(item.description.replace(/\s+/g, ' '), descriptionWidth)
    : '';

  return (
    <Text wrap="truncate">
      <Text color={textColor} dimColor={shouldDim}>
        {paddedDisplayText}
      </Text>
      {tagText ? (
        <Text color={item.tag === 'local' ? 'ansi:yellow' : undefined} dimColor={item.tag !== 'local'}>
          {tagText}
        </Text>
      ) : null}
      <Text color={isSelected ? 'suggestion' : undefined} dimColor={!isSelected}>
        {truncatedDescription}
      </Text>
    </Text>
  );
});

type Props = {
  suggestions: SuggestionItem[];
  selectedSuggestion: number;
  maxColumnWidth?: number;
  /**
   * 为 true 时，建议列表渲染在 position=absolute 的叠加层内。
   * 省略 minHeight 和 flex-end，避免渲染器的 y 钳位将较少的条目下推到输入框区域。
   */
  overlay?: boolean;
};

export function PromptInputFooterSuggestions({
  suggestions,
  selectedSuggestion,
  maxColumnWidth: maxColumnWidthProp,
  overlay,
}: Props): ReactNode {
  const { rows } = useTerminalSize();
  // 一次显示的最大建议数量（为输入框预留空间）。
  // 叠加模式（全屏）固定使用 5 —— 浮动框位于 ScrollBox 上方，
  // 因此终端高度不是限制因素。
  const maxVisibleItems = overlay ? OVERLAY_MAX_ITEMS : Math.min(6, Math.max(1, rows - 3));

  // 没有建议可显示
  if (suggestions.length === 0) {
    return null;
  }

  // 如果提供了 prop（来自所有命令的稳定宽度），则使用它，否则从可见项计算
  const maxColumnWidth = maxColumnWidthProp ?? Math.max(...suggestions.map(item => stringWidth(item.displayText))) + 5;

  // 根据选中索引计算可见项范围
  const startIndex = Math.max(
    0,
    Math.min(selectedSuggestion - Math.floor(maxVisibleItems / 2), suggestions.length - maxVisibleItems),
  );
  const endIndex = Math.min(startIndex + maxVisibleItems, suggestions.length);
  const visibleItems = suggestions.slice(startIndex, endIndex);

  // 非叠加（内联）模式下，justifyContent 将建议锚定在底部（靠近输入框）。
  // 叠加模式下省略 minHeight 和 flex-end：父元素是 position=absolute，
  // bottom='100%'，当其 y 值为负时，渲染器会将其钳位到 0。
  // 添加 minHeight + flex-end 会在列表项少于 maxVisibleItems 时产生空白填充行，
  // 将可见项下移到输入框区域。
  return (
    <Box flexDirection="column" justifyContent={overlay ? undefined : 'flex-end'}>
      {visibleItems.map(item => (
        <SuggestionItemRow
          key={item.id}
          item={item}
          maxColumnWidth={maxColumnWidth}
          isSelected={item.id === suggestions[selectedSuggestion]?.id}
        />
      ))}
    </Box>
  );
}

export default memo(PromptInputFooterSuggestions);
