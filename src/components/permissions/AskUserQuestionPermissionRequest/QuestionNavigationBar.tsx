import figures from 'figures';
import React, { useMemo } from 'react';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
import { Box, Text, stringWidth } from '@anthropic/ink';
import type { Question } from '@claude-code-best/builtin-tools/tools/AskUserQuestionTool/AskUserQuestionTool.js';
import { truncateToWidth } from '../../../utils/format.js';

type Props = {
  questions: Question[];
  currentQuestionIndex: number;
  answers: Record<string, string>;
  hideSubmitTab?: boolean;
};

export function QuestionNavigationBar({
  questions,
  currentQuestionIndex,
  answers,
  hideSubmitTab = false,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize();

  // 根据可用宽度计算每个标签页的显示文本
  const tabDisplayTexts = useMemo(() => {
    // 计算固定宽度元素
    const leftArrow = '← ';
    const rightArrow = ' →';
    const submitText = hideSubmitTab ? '' : ` ${figures.tick} Submit `;
    const checkboxWidth = 2; // 复选框 + 空格
    const paddingPerTab = 2; // 每个标签页文本前后的空格

    const fixedWidth = stringWidth(leftArrow) + stringWidth(rightArrow) + stringWidth(submitText);

    // 所有问题标签页的可用宽度
    const availableForTabs = columns - fixedWidth;

    if (availableForTabs <= 0) {
      // 终端太窄，回退到最小显示
      return questions.map((q: Question, index: number) => {
        const header = q?.header || `Q${index + 1}`;
        return index === currentQuestionIndex ? header.slice(0, 3) : '';
      });
    }

    // 计算每个标签页的理想宽度（复选框 + 内边距 + 文本）
    const tabHeaders = questions.map((q: Question, index: number) => q?.header || `Q${index + 1}`);
    const idealWidths = tabHeaders.map(header => checkboxWidth + paddingPerTab + stringWidth(header));

    // 计算总理想宽度
    const totalIdealWidth = idealWidths.reduce((sum, w) => sum + w, 0);

    // 若都能容纳，使用完整 header
    if (totalIdealWidth <= availableForTabs) {
      return tabHeaders;
    }

    // 需要截断 - 优先当前标签页
    const currentHeader = tabHeaders[currentQuestionIndex] || '';
    const currentIdealWidth = checkboxWidth + paddingPerTab + stringWidth(currentHeader);

    // 其他标签页的最小宽度（复选框 + 内边距 + 1 字符 + 省略号）
    const minWidthPerTab = checkboxWidth + paddingPerTab + 2; // "X…"

    // 计算当前标签页的空间（尽量显示完整文本）
    const currentTabWidth = Math.min(currentIdealWidth, availableForTabs / 2);
    const remainingWidth = availableForTabs - currentTabWidth;

    // 计算其他标签页的空间
    const otherTabCount = questions.length - 1;
    const widthPerOtherTab = Math.max(minWidthPerTab, Math.floor(remainingWidth / Math.max(otherTabCount, 1)));

    return tabHeaders.map((header, index) => {
      if (index === currentQuestionIndex) {
        // 当前标签页 - 尽可能多显示
        const maxTextWidth = currentTabWidth - checkboxWidth - paddingPerTab;
        return truncateToWidth(header, maxTextWidth);
      } else {
        // 其他标签页 - 截断以适应
        const maxTextWidth = widthPerOtherTab - checkboxWidth - paddingPerTab;
        return truncateToWidth(header, maxTextWidth);
      }
    });
  }, [questions, currentQuestionIndex, columns, hideSubmitTab]);

  const hideArrows = questions.length === 1 && hideSubmitTab;

  return (
    <Box flexDirection="row" marginBottom={1}>
      {!hideArrows && <Text color={currentQuestionIndex === 0 ? 'inactive' : undefined}>← </Text>}
      {questions.map((q: Question, index: number) => {
        const isSelected = index === currentQuestionIndex;
        const isAnswered = q?.question && !!answers[q.question];
        const checkbox = isAnswered ? figures.checkboxOn : figures.checkboxOff;
        const displayText = tabDisplayTexts[index] || q?.header || `Q${index + 1}`;

        return (
          <Box key={q?.question || `question-${index}`}>
            {isSelected ? (
              <Text backgroundColor="permission" color="inverseText">
                {' '}
                {checkbox} {displayText}{' '}
              </Text>
            ) : (
              <Text>
                {' '}
                {checkbox} {displayText}{' '}
              </Text>
            )}
          </Box>
        );
      })}
      {!hideSubmitTab && (
        <Box key="submit">
          {currentQuestionIndex === questions.length ? (
            <Text backgroundColor="permission" color="inverseText">
              {' '}
              {figures.tick} Submit{' '}
            </Text>
          ) : (
            <Text> {figures.tick} Submit </Text>
          )}
        </Box>
      )}
      {!hideArrows && <Text color={currentQuestionIndex === questions.length ? 'inactive' : undefined}> →</Text>}
    </Box>
  );
}
