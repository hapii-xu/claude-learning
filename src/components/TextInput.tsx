import { feature } from 'bun:bundle';
import chalk from 'chalk';
import React, { useMemo, useRef } from 'react';
import { useVoiceState } from '../context/voice.js';
import { useClipboardImageHint } from '../hooks/useClipboardImageHint.js';
import { useSettings } from '../hooks/useSettings.js';
import { useTextInput } from '../hooks/useTextInput.js';
import { Box, color, useAnimationFrame, useTerminalFocus, useTheme } from '@anthropic/ink';
import type { BaseTextInputProps } from '../types/textInputTypes.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import type { TextHighlight } from '../utils/textHighlighting.js';
import { BaseTextInput } from './BaseTextInput.js';
import { hueToRgb } from './Spinner/utils.js';

// \u6ce2\u5f62\u6761\u7528\u7684 block \u5b57\u7b26\uff1a\u7a7a\u683c\uff08\u9759\u97f3\uff09+ 8 \u4e2a\u9010\u6e10\u5347\u9ad8\u7684 block \u5143\u7d20\u3002
const BARS = ' \u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588';

// 迷你波形光标宽度
const CURSOR_WAVEFORM_WIDTH = 1;

// 平滑系数（0 = 瞬时，1 = 冻结）。作为 EMA 应用，
// 同时平滑上升和下降，使波形条稳定、不抖动。
const SMOOTH = 0.7;

// 音频电平的提升系数 —— computeLevel 用一个保守的除数（rms/2000）做归一化，
// 所以正常说话大约在 0.3-0.5。这个乘数让波形条能使用完整范围。
const LEVEL_BOOST = 1.8;

// 原始音频电平阈值（提升前），低于此值时光标显示为灰色。
// computeLevel 返回 sqrt(rms/2000)，所以环境麦克风噪声
// 通常在 0.05-0.15。说话一般从 0.2 起。
const SILENCE_THRESHOLD = 0.15;

export type Props = BaseTextInputProps & {
  highlights?: TextHighlight[];
};

export default function TextInput(props: Props): React.ReactNode {
  const [theme] = useTheme();
  const isTerminalFocused = useTerminalFocus();
  // 提升到挂载时 —— 此组件在每次按键时都会重新渲染。
  const accessibilityEnabled = useMemo(() => isEnvTruthy(process.env.CLAUDE_CODE_ACCESSIBILITY), []);
  const settings = useSettings();
  const reducedMotion = settings.prefersReducedMotion ?? false;

  const voiceStateRaw = useVoiceState(s => s.voiceState);
  const voiceState = feature('VOICE_MODE') ? voiceStateRaw : ('idle' as const);
  const isVoiceRecording = voiceState === 'recording';

  const audioLevelsRaw = useVoiceState(s => s.voiceAudioLevels);
  const audioLevels = feature('VOICE_MODE') ? audioLevelsRaw : [];
  const smoothedRef = useRef<number[]>(new Array(CURSOR_WAVEFORM_WIDTH).fill(0));

  const needsAnimation = isVoiceRecording && !reducedMotion;
  const [animRefRaw, animTimeRaw] = useAnimationFrame(needsAnimation ? 50 : null);
  const animRef = feature('VOICE_MODE') ? animRefRaw : () => {};
  const animTime = feature('VOICE_MODE') ? animTimeRaw : 0;

  // 当终端重新获得焦点且剪贴板中有图片时显示提示
  useClipboardImageHint(isTerminalFocused, !!props.onImagePaste);

  // 光标反转函数：录音时显示迷你波形，
  // 否则使用标准的 chalk.inverse。没有预热脉冲 —— ~120ms 的
  // 预热窗口对 1s 周期的脉冲来说太短，无法体现；而且在预热期间以
  // 50ms 驱动 TextInput 重新渲染（同时空格每 30-80ms 到达一次）
  // 会导致明显的卡顿。
  const canShowCursor = isTerminalFocused && !accessibilityEnabled;
  let invert: (text: string) => string;
  if (!canShowCursor) {
    invert = (text: string) => text;
  } else if (isVoiceRecording && !reducedMotion) {
    // 基于最新音频电平的单条波形
    const smoothed = smoothedRef.current;
    const raw = audioLevels.length > 0 ? (audioLevels[audioLevels.length - 1] ?? 0) : 0;
    const target = Math.min(raw * LEVEL_BOOST, 1);
    smoothed[0] = (smoothed[0] ?? 0) * SMOOTH + target * (1 - SMOOTH);
    const displayLevel = smoothed[0] ?? 0;
    const barIndex = Math.max(1, Math.min(Math.round(displayLevel * (BARS.length - 1)), BARS.length - 1));
    const isSilent = raw < SILENCE_THRESHOLD;
    const hue = ((animTime / 1000) * 90) % 360;
    const { r, g, b } = isSilent ? { r: 128, g: 128, b: 128 } : hueToRgb(hue);
    invert = () => chalk.rgb(r, g, b)(BARS[barIndex]!);
  } else {
    invert = chalk.inverse;
  }

  const textInputState = useTextInput({
    value: props.value,
    onChange: props.onChange,
    onSubmit: props.onSubmit,
    onExit: props.onExit,
    onExitMessage: props.onExitMessage,
    onHistoryReset: props.onHistoryReset,
    onHistoryUp: props.onHistoryUp,
    onHistoryDown: props.onHistoryDown,
    onClearInput: props.onClearInput,
    focus: props.focus,
    mask: props.mask,
    multiline: props.multiline,
    cursorChar: props.showCursor ? ' ' : '',
    highlightPastedText: props.highlightPastedText,
    invert,
    themeText: color('text', theme),
    columns: props.columns,
    maxVisibleLines: props.maxVisibleLines,
    onImagePaste: props.onImagePaste,
    disableCursorMovementForUpDownKeys: props.disableCursorMovementForUpDownKeys,
    disableEscapeDoublePress: props.disableEscapeDoublePress,
    externalOffset: props.cursorOffset,
    onOffsetChange: props.onChangeCursorOffset,
    inputFilter: props.inputFilter,
    inlineGhostText: props.inlineGhostText,
    dim: chalk.dim,
  });

  return (
    <Box ref={animRef}>
      <BaseTextInput
        inputState={textInputState}
        terminalFocus={isTerminalFocused}
        highlights={props.highlights}
        invert={invert}
        hidePlaceholderText={isVoiceRecording}
        {...props}
      />
    </Box>
  );
}
