import figures from 'figures';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
import { type KeyboardEvent, Box, Text } from '@anthropic/ink';
import { useKeybinding, useKeybindings } from '../../../keybindings/useKeybinding.js';
import { useAppState } from '../../../state/AppState.js';
import type { Question } from '@claude-code-best/builtin-tools/tools/AskUserQuestionTool/AskUserQuestionTool.js';
import { getExternalEditor } from '../../../utils/editor.js';
import { toIDEDisplayName } from '../../../utils/ide.js';
import { editPromptInEditor } from '../../../utils/promptEditor.js';
import { Divider } from '@anthropic/ink';
import TextInput from '../../TextInput.js';
import { PermissionRequestTitle } from '../PermissionRequestTitle.js';
import { PreviewBox } from './PreviewBox.js';
import { QuestionNavigationBar } from './QuestionNavigationBar.js';
import type { QuestionState } from './use-multiple-choice-state.js';

type Props = {
  question: Question;
  questions: Question[];
  currentQuestionIndex: number;
  answers: Record<string, string>;
  questionStates: Record<string, QuestionState>;
  hideSubmitTab?: boolean;
  minContentHeight?: number;
  minContentWidth?: number;
  onUpdateQuestionState: (questionText: string, updates: Partial<QuestionState>, isMultiSelect: boolean) => void;
  onAnswer: (questionText: string, label: string | string[], textInput?: string, shouldAdvance?: boolean) => void;
  onTextInputFocus: (isInInput: boolean) => void;
  onCancel: () => void;
  onTabPrev?: () => void;
  onTabNext?: () => void;
  onRespondToClaude: () => void;
  onFinishPlanInterview: () => void;
};

/**
 * 用于带预览内容的问题的并排视图。
 * 左侧显示垂直选项列表，右侧显示预览面板。
 */
export function PreviewQuestionView({
  question,
  questions,
  currentQuestionIndex,
  answers,
  questionStates,
  hideSubmitTab = false,
  minContentHeight,
  minContentWidth,
  onUpdateQuestionState,
  onAnswer,
  onTextInputFocus,
  onCancel,
  onTabPrev,
  onTabNext,
  onRespondToClaude,
  onFinishPlanInterview,
}: Props): React.ReactNode {
  const isInPlanMode = useAppState(s => s.toolPermissionContext.mode) === 'plan';
  const [isFooterFocused, setIsFooterFocused] = useState(false);
  const [footerIndex, setFooterIndex] = useState(0);
  const [isInNotesInput, setIsInNotesInput] = useState(false);
  const [cursorOffset, setCursorOffset] = useState(0);

  const editor = getExternalEditor();
  const editorName = editor ? toIDEDisplayName(editor) : null;

  const questionText = question.question;
  const questionState = questionStates[questionText];

  // 仅真实选项 —— 预览问题没有 "Other"
  const allOptions = question.options;

  // 追踪哪个选项被聚焦（用于预览显示）
  const [focusedIndex, setFocusedIndex] = useState(0);

  // 导航到不同问题时重置 focusedIndex
  const prevQuestionText = useRef(questionText);
  if (prevQuestionText.current !== questionText) {
    prevQuestionText.current = questionText;
    const selected = questionState?.selectedValue as string | undefined;
    const idx = selected ? allOptions.findIndex(opt => opt.label === selected) : -1;
    setFocusedIndex(idx >= 0 ? idx : 0);
  }

  const focusedOption = allOptions[focusedIndex];
  const selectedValue = questionState?.selectedValue as string | undefined;
  const notesValue = questionState?.textInputValue || '';

  const handleSelectOption = useCallback(
    (index: number) => {
      const option = allOptions[index];
      if (!option) return;

      setFocusedIndex(index);
      onUpdateQuestionState(questionText, { selectedValue: option.label }, false);

      onAnswer(questionText, option.label);
    },
    [allOptions, questionText, onUpdateQuestionState, onAnswer],
  );

  const handleNavigate = useCallback(
    (direction: 'up' | 'down' | number) => {
      if (isInNotesInput) return;

      let newIndex: number;
      if (typeof direction === 'number') {
        newIndex = direction;
      } else if (direction === 'up') {
        newIndex = focusedIndex > 0 ? focusedIndex - 1 : focusedIndex;
      } else {
        newIndex = focusedIndex < allOptions.length - 1 ? focusedIndex + 1 : focusedIndex;
      }

      if (newIndex >= 0 && newIndex < allOptions.length) {
        setFocusedIndex(newIndex);
      }
    },
    [focusedIndex, allOptions.length, isInNotesInput],
  );

  // 处理 ctrl+g 以打开外部编辑器编辑备注
  useKeybinding(
    'chat:externalEditor',
    async () => {
      const currentValue = questionState?.textInputValue || '';
      const result = await editPromptInEditor(currentValue);
      if (result.content !== null && result.content !== currentValue) {
        onUpdateQuestionState(questionText, { textInputValue: result.content }, false);
      }
    },
    { context: 'Chat', isActive: isInNotesInput && !!editor },
  );

  // 处理左右方向键和 Tab 用于问题导航。
  // 这必须放在子组件中（而非仅父组件），因为子组件的 useInput 处理器
  // 会先在事件发射器上注册，并在父组件的处理器之前触发。
  // 否则父组件的 useKeybindings 可能因事件发射器的监听器顺序而不可靠。
  useKeybindings(
    {
      'tabs:previous': () => onTabPrev?.(),
      'tabs:next': () => onTabNext?.(),
    },
    { context: 'Tabs', isActive: !isInNotesInput && !isFooterFocused },
  );

  // 退出备注输入时重新提交答案（纯 label）。
  // 备注存储在 questionStates 中，提交时通过标注收集。
  const handleNotesExit = useCallback(() => {
    setIsInNotesInput(false);
    onTextInputFocus(false);
    if (selectedValue) {
      onAnswer(questionText, selectedValue);
    }
  }, [selectedValue, questionText, onAnswer, onTextInputFocus]);

  const handleDownFromPreview = useCallback(() => {
    setIsFooterFocused(true);
  }, []);

  const handleUpFromFooter = useCallback(() => {
    setIsFooterFocused(false);
  }, []);

  // 处理选项/footer/备注导航的键盘输入。
  // 始终激活——处理器根据 isFooterFocused/isInNotesInput 内部分发。
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (isFooterFocused) {
        if (e.key === 'up' || (e.ctrl && e.key === 'p')) {
          e.preventDefault();
          if (footerIndex === 0) {
            handleUpFromFooter();
          } else {
            setFooterIndex(0);
          }
          return;
        }

        if (e.key === 'down' || (e.ctrl && e.key === 'n')) {
          e.preventDefault();
          if (isInPlanMode && footerIndex === 0) {
            setFooterIndex(1);
          }
          return;
        }

        if (e.key === 'return') {
          e.preventDefault();
          if (footerIndex === 0) {
            onRespondToClaude();
          } else {
            onFinishPlanInterview();
          }
          return;
        }

        if (e.key === 'escape') {
          e.preventDefault();
          onCancel();
        }
        return;
      }

      if (isInNotesInput) {
        // 在备注输入模式下，处理 escape 以退出回到选项导航
        if (e.key === 'escape') {
          e.preventDefault();
          handleNotesExit();
        }
        return;
      }

      // 处理选项导航（垂直）
      if (e.key === 'up' || (e.ctrl && e.key === 'p')) {
        e.preventDefault();
        if (focusedIndex > 0) {
          handleNavigate('up');
        }
      } else if (e.key === 'down' || (e.ctrl && e.key === 'n')) {
        e.preventDefault();
        if (focusedIndex === allOptions.length - 1) {
          // 位于选项底部，跳转到 footer
          handleDownFromPreview();
        } else {
          handleNavigate('down');
        }
      } else if (e.key === 'return') {
        e.preventDefault();
        handleSelectOption(focusedIndex);
      } else if (e.key === 'n' && !e.ctrl && !e.meta) {
        // 按 'n' 聚焦备注输入
        e.preventDefault();
        setIsInNotesInput(true);
        onTextInputFocus(true);
      } else if (e.key === 'escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key.length === 1 && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const idx = parseInt(e.key, 10) - 1;
        if (idx < allOptions.length) {
          handleNavigate(idx);
        }
      }
    },
    [
      isFooterFocused,
      footerIndex,
      isInPlanMode,
      isInNotesInput,
      focusedIndex,
      allOptions.length,
      handleUpFromFooter,
      handleDownFromPreview,
      handleNavigate,
      handleSelectOption,
      handleNotesExit,
      onRespondToClaude,
      onFinishPlanInterview,
      onCancel,
      onTextInputFocus,
    ],
  );

  const previewContent = focusedOption?.preview || null;

  // 右面板的可用宽度为终端宽度减去左面板和间距。
  const LEFT_PANEL_WIDTH = 30;
  const GAP = 4;
  const { columns } = useTerminalSize();
  const previewMaxWidth = columns - LEFT_PANEL_WIDTH - GAP;

  // 内容区域中非预览内容占用的行数：
  // 1: 并排框的 marginTop
  // 2: PreviewBox 边框（上 + 下）
  // 2: 备注区（marginTop=1 + 文本）
  // 2: footer 区（marginTop=1 + 分隔线）
  // 1: "Chat about this" 行
  // 1: plan 模式行（可能显示也可能不显示）
  // 2: 帮助文本（marginTop=1 + 文本）
  const PREVIEW_OVERHEAD = 11;

  // 根据父组件的高度预算计算预览内容的最大可用行数，
  // 防止终端溢出。我们不会将较短的选项填充到与最高项一致——
  // 外框的 minHeight 处理跨问题布局一致性，问题内的抖动可接受。
  const previewMaxLines = useMemo(() => {
    return minContentHeight ? Math.max(1, minContentHeight - PREVIEW_OVERHEAD) : undefined;
  }, [minContentHeight]);

  return (
    <Box flexDirection="column" marginTop={1} tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Divider color="inactive" />
      <Box flexDirection="column" paddingTop={0}>
        <QuestionNavigationBar
          questions={questions}
          currentQuestionIndex={currentQuestionIndex}
          answers={answers}
          hideSubmitTab={hideSubmitTab}
        />
        <PermissionRequestTitle title={question.question} color={'text'} />

        <Box flexDirection="column" minHeight={minContentHeight}>
          {/* 并排布局：左侧选项，右侧预览 */}
          <Box marginTop={1} flexDirection="row" gap={4}>
            {/* 左面板：垂直选项列表 */}
            <Box flexDirection="column" width={30}>
              {allOptions.map((option, index) => {
                const isFocused = focusedIndex === index;
                const isSelected = selectedValue === option.label;

                return (
                  <Box key={option.label} flexDirection="row">
                    {isFocused ? <Text color="suggestion">{figures.pointer}</Text> : <Text> </Text>}
                    <Text dimColor> {index + 1}.</Text>
                    <Text color={isSelected ? 'success' : isFocused ? 'suggestion' : undefined} bold={isFocused}>
                      {' '}
                      {option.label}
                    </Text>
                    {isSelected && <Text color="success"> {figures.tick}</Text>}
                  </Box>
                );
              })}
            </Box>

            {/* 右面板：预览 + 备注 */}
            <Box flexDirection="column" flexGrow={1}>
              <PreviewBox
                content={previewContent || 'No preview available'}
                maxLines={previewMaxLines}
                minWidth={minContentWidth}
                maxWidth={previewMaxWidth}
              />
              <Box marginTop={1} flexDirection="row" gap={1}>
                <Text color="suggestion">备注：</Text>
                {isInNotesInput ? (
                  <TextInput
                    value={notesValue}
                    placeholder="Add notes on this design…"
                    onChange={value => {
                      onUpdateQuestionState(questionText, { textInputValue: value }, false);
                    }}
                    onSubmit={handleNotesExit}
                    onExit={handleNotesExit}
                    focus={true}
                    showCursor={true}
                    columns={60}
                    cursorOffset={cursorOffset}
                    onChangeCursorOffset={setCursorOffset}
                  />
                ) : (
                  <Text dimColor italic>
                    {notesValue || 'press n to add notes'}
                  </Text>
                )}
              </Box>
            </Box>
          </Box>

          {/* Footer 区 */}
          <Box flexDirection="column" marginTop={1}>
            <Divider color="inactive" />
            <Box flexDirection="row" gap={1}>
              {isFooterFocused && footerIndex === 0 ? (
                <Text color="suggestion">{figures.pointer}</Text>
              ) : (
                <Text> </Text>
              )}
              <Text color={isFooterFocused && footerIndex === 0 ? 'suggestion' : undefined}>讨论此问题</Text>
            </Box>
            {isInPlanMode && (
              <Box flexDirection="row" gap={1}>
                {isFooterFocused && footerIndex === 1 ? (
                  <Text color="suggestion">{figures.pointer}</Text>
                ) : (
                  <Text> </Text>
                )}
                <Text color={isFooterFocused && footerIndex === 1 ? 'suggestion' : undefined}>
                  Skip interview and plan immediately
                </Text>
              </Box>
            )}
          </Box>
          <Box marginTop={1}>
            <Text color="inactive" dimColor>
              Enter to select · {figures.arrowUp}/{figures.arrowDown} to navigate · n to add notes
              {questions.length > 1 && <> · Tab to switch questions</>}
              {isInNotesInput && editorName && <> · ctrl+g to edit in {editorName}</>} · Esc to cancel
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
