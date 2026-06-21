import React from 'react';
import { renderPlaceholder } from '../hooks/renderPlaceholder.js';
import { usePasteHandler } from '../hooks/usePasteHandler.js';
import { useDeclaredCursor } from '@anthropic/ink';
import { Ansi, Box, Text, useInput } from '@anthropic/ink';
import type { BaseInputState, BaseTextInputProps } from '../types/textInputTypes.js';
import type { TextHighlight } from '../utils/textHighlighting.js';
import { HighlightedInput } from './PromptInput/ShimmeredInput.js';

type BaseTextInputComponentProps = BaseTextInputProps & {
  inputState: BaseInputState;
  children?: React.ReactNode;
  terminalFocus: boolean;
  highlights?: TextHighlight[];
  invert?: (text: string) => string;
  hidePlaceholderText?: boolean;
};

/**
 * 文本输入的基础组件，处理渲染和基本输入
 */
export function BaseTextInput({
  inputState,
  children,
  terminalFocus,
  invert,
  hidePlaceholderText,
  ...props
}: BaseTextInputComponentProps): React.ReactNode {
  const { onInput, renderedValue, cursorLine, cursorColumn } = inputState;

  // 将原生终端光标停放在输入插入符处。终端模拟器在物理光标位置
  // 放置 IME 预编辑文本，屏幕阅读器/放大镜也跟踪它 —— 所以在此处停放
  // 可让 CJK 输入内联显示，并让辅助工具跟随输入。下方的 Box ref
  // 是 yoga 布局原点；(cursorLine, cursorColumn) 相对于它。
  // 仅在输入聚焦、显示其光标且终端本身拥有焦点时激活。
  const cursorRef = useDeclaredCursor({
    line: cursorLine,
    column: cursorColumn,
    active: Boolean(props.focus && props.showCursor && terminalFocus),
  });

  const { wrappedOnInput, isPasting } = usePasteHandler({
    onPaste: props.onPaste,
    onInput: (input, key) => {
      // 粘贴期间阻止 Enter 键触发提交
      if (isPasting && key.return) {
        return;
      }
      onInput(input, key);
    },
    onImagePaste: props.onImagePaste,
  });

  // 粘贴状态变化时通知父组件
  const { onIsPastingChange } = props;
  React.useEffect(() => {
    if (onIsPastingChange) {
      onIsPastingChange(isPasting);
    }
  }, [isPasting, onIsPastingChange]);

  const { showPlaceholder, renderedPlaceholder } = renderPlaceholder({
    placeholder: props.placeholder,
    value: props.value,
    showCursor: props.showCursor,
    focus: props.focus,
    terminalFocus,
    invert,
    hidePlaceholderText,
  });

  useInput(wrappedOnInput, { isActive: props.focus });

  // 仅当有值且提供了 hint 时显示参数提示
  // 仅在以下情况显示参数提示：
  // 1. 有要显示的 hint
  // 2. 已输入命令（value 非空）
  // 3. 命令尚无参数（空格后无文本）
  // 4. 实际上正在输入命令（value 以 / 开头）
  const commandWithoutArgs =
    (props.value && props.value.trim().indexOf(' ') === -1) || (props.value && props.value.endsWith(' '));

  const showArgumentHint = Boolean(
    props.argumentHint && props.value && commandWithoutArgs && props.value.startsWith('/'),
  );

  // 过滤掉包含光标位置的高亮
  const cursorFiltered =
    props.showCursor && props.highlights
      ? props.highlights.filter(h => h.dimColor || props.cursorOffset < h.start || props.cursorOffset >= h.end)
      : props.highlights;

  // 为视口窗口调整高亮：高亮位置引用完整输入文本，
  // 但 renderedValue 仅包含窗口子集。
  const { viewportCharOffset, viewportCharEnd } = inputState;
  const filteredHighlights =
    cursorFiltered && viewportCharOffset > 0
      ? cursorFiltered
          .filter(h => h.end > viewportCharOffset && h.start < viewportCharEnd)
          .map(h => ({
            ...h,
            start: Math.max(0, h.start - viewportCharOffset),
            end: h.end - viewportCharOffset,
          }))
      : cursorFiltered;

  const hasHighlights = filteredHighlights && filteredHighlights.length > 0;

  if (hasHighlights) {
    return (
      <Box ref={cursorRef}>
        <HighlightedInput text={renderedValue} highlights={filteredHighlights} />
        {showArgumentHint && (
          <Text dimColor>
            {props.value?.endsWith(' ') ? '' : ' '}
            {props.argumentHint}
          </Text>
        )}
        {children}
      </Box>
    );
  }

  return (
    <Box ref={cursorRef}>
      <Text wrap="truncate-end" dimColor={props.dimColor}>
        {showPlaceholder && props.placeholderElement ? (
          props.placeholderElement
        ) : showPlaceholder && renderedPlaceholder ? (
          <Ansi>{renderedPlaceholder}</Ansi>
        ) : (
          <Ansi>{renderedValue}</Ansi>
        )}
        {showArgumentHint && (
          <Text dimColor>
            {props.value?.endsWith(' ') ? '' : ' '}
            {props.argumentHint}
          </Text>
        )}
        {children}
      </Text>
    </Box>
  );
}
