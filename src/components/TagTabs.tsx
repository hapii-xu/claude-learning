import React from 'react';
import { Box, Text, stringWidth } from '@anthropic/ink';
import { truncateToWidth } from '../utils/format.js';

// 用于宽度计算的常量 —— 派生自实际渲染的字符串
const ALL_TAB_LABEL = 'All';
const TAB_PADDING = 2; // tab 文本前后的空格：" {tab} "
const HASH_PREFIX_LENGTH = 1; // 非 All tab 的 "#" 前缀
const LEFT_ARROW_PREFIX = '← ';
const RIGHT_HINT_WITH_COUNT_PREFIX = '→';
const RIGHT_HINT_SUFFIX = '（Tab 循环切换）';
const RIGHT_HINT_NO_COUNT = '（Tab 循环切换）';
const MAX_OVERFLOW_DIGITS = 2; // 假设宽度计算时最多有 99 个隐藏 tab

// 计算出的宽度
const LEFT_ARROW_WIDTH = LEFT_ARROW_PREFIX.length + MAX_OVERFLOW_DIGITS + 1; // "← NN " 加间隙
const RIGHT_HINT_WIDTH_WITH_COUNT =
  RIGHT_HINT_WITH_COUNT_PREFIX.length + MAX_OVERFLOW_DIGITS + RIGHT_HINT_SUFFIX.length; // "→NN（Tab 循环切换）"
const RIGHT_HINT_WIDTH_NO_COUNT = RIGHT_HINT_NO_COUNT.length;

type Props = {
  tabs: string[];
  selectedIndex: number;
  availableWidth: number;
  showAllProjects?: boolean;
};

/**
 * 计算一个 tab 的显示宽度
 */
function getTabWidth(tab: string, maxWidth?: number): number {
  if (tab === ALL_TAB_LABEL) {
    return ALL_TAB_LABEL.length + TAB_PADDING;
  }
  // 对于非 All tab：" #{tag} "，但如有需要会截断 tag
  const tagWidth = stringWidth(tab);
  const effectiveTagWidth = maxWidth ? Math.min(tagWidth, maxWidth - TAB_PADDING - HASH_PREFIX_LENGTH) : tagWidth;
  return Math.max(0, effectiveTagWidth) + TAB_PADDING + HASH_PREFIX_LENGTH;
}

/**
 * 将 tag 截断以适配 maxWidth，考虑 padding 和 hash 前缀
 */
function truncateTag(tag: string, maxWidth: number): string {
  // Available space for the tag text itself: maxWidth - " #" - " "
  const availableForTag = maxWidth - TAB_PADDING - HASH_PREFIX_LENGTH;
  if (stringWidth(tag) <= availableForTag) {
    return tag;
  }
  if (availableForTag <= 1) {
    return tag.charAt(0);
  }
  return truncateToWidth(tag, availableForTag);
}

export function TagTabs({ tabs, selectedIndex, availableWidth, showAllProjects = false }: Props): React.ReactNode {
  const resumeLabel = showAllProjects ? '恢复（所有项目）' : '恢复';
  const resumeLabelWidth = resumeLabel.length + 1; // +1 为间隙预留

  // 计算我们有多少空间可用于 tab（使用最坏情况下的提示宽度）
  const rightHintWidth = Math.max(RIGHT_HINT_WIDTH_WITH_COUNT, RIGHT_HINT_WIDTH_NO_COUNT);
  const maxTabsWidth = availableWidth - resumeLabelWidth - rightHintWidth - 2; // 2 for gaps

  // 将 selectedIndex 限制在有效范围内
  const safeSelectedIndex = Math.max(0, Math.min(selectedIndex, tabs.length - 1));

  // 计算每个 tab 的宽度，对很长的 tag 做截断
  const maxSingleTabWidth = Math.max(20, Math.floor(maxTabsWidth / 2)); // 至少为一个 tab 保留一半的空间
  const tabWidths = tabs.map(tab => getTabWidth(tab, maxSingleTabWidth));

  // 找到一个能放下的 tab 窗口，以 selectedIndex 为中心
  let startIndex = 0;
  let endIndex = tabs.length;

  // 计算所有 tab 的总宽度
  const totalTabsWidth = tabWidths.reduce((sum, w, i) => sum + w + (i < tabWidths.length - 1 ? 1 : 0), 0); // +1 为 tab 之间的间隙

  if (totalTabsWidth > maxTabsWidth) {
    // 需要只显示一部分 —— 当不在起点时要为左箭头预留空间
    const effectiveMaxWidth = maxTabsWidth - LEFT_ARROW_WIDTH;

    // 从选中的 tab 开始
    let windowWidth = tabWidths[safeSelectedIndex] ?? 0;
    startIndex = safeSelectedIndex;
    endIndex = safeSelectedIndex + 1;

    // 扩展窗口以包含更多 tab
    while (startIndex > 0 || endIndex < tabs.length) {
      const canExpandLeft = startIndex > 0;
      const canExpandRight = endIndex < tabs.length;

      if (canExpandLeft) {
        const leftWidth = (tabWidths[startIndex - 1] ?? 0) + 1; // +1 for gap
        if (windowWidth + leftWidth <= effectiveMaxWidth) {
          startIndex--;
          windowWidth += leftWidth;
          continue;
        }
      }

      if (canExpandRight) {
        const rightWidth = (tabWidths[endIndex] ?? 0) + 1; // +1 for gap
        if (windowWidth + rightWidth <= effectiveMaxWidth) {
          endIndex++;
          windowWidth += rightWidth;
          continue;
        }
      }

      break;
    }
  }

  const hiddenLeft = startIndex;
  const hiddenRight = tabs.length - endIndex;
  const visibleTabs = tabs.slice(startIndex, endIndex);
  const visibleIndices = visibleTabs.map((_, i) => startIndex + i);

  return (
    <Box flexDirection="row" gap={1}>
      <Text color="suggestion">{resumeLabel}</Text>
      {hiddenLeft > 0 && (
        <Text dimColor>
          {LEFT_ARROW_PREFIX}
          {hiddenLeft}
        </Text>
      )}
      {visibleTabs.map((tab, i) => {
        const actualIndex = visibleIndices[i]!;
        const isSelected = actualIndex === safeSelectedIndex;
        const displayText = tab === ALL_TAB_LABEL ? tab : `#${truncateTag(tab, maxSingleTabWidth - TAB_PADDING)}`;
        return (
          <Text
            key={tab}
            backgroundColor={isSelected ? 'suggestion' : undefined}
            color={isSelected ? 'inverseText' : undefined}
            bold={isSelected}
          >
            {' '}
            {displayText}{' '}
          </Text>
        );
      })}
      {hiddenRight > 0 ? (
        <Text dimColor>
          {RIGHT_HINT_WITH_COUNT_PREFIX}
          {hiddenRight}
          {RIGHT_HINT_SUFFIX}
        </Text>
      ) : (
        <Text dimColor>{RIGHT_HINT_NO_COUNT}</Text>
      )}
    </Box>
  );
}
