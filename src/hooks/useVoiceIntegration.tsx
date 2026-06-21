import { feature } from 'bun:bundle';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNotifications } from '../context/notifications.js';
import { useIsModalOverlayActive } from '../context/overlayContext.js';
import { useGetVoiceState, useSetVoiceState, useVoiceState } from '../context/voice.js';
import { KeyboardEvent, useInput } from '@anthropic/ink';
// 向后兼容的桥接，直到 REPL 将 handleKeyDown 连接到 <Box onKeyDown>
import { useOptionalKeybindingContext } from '../keybindings/KeybindingContext.js';
import { keystrokesEqual } from '../keybindings/resolver.js';
import type { ParsedKeystroke } from '../keybindings/types.js';
import { normalizeFullWidthSpace } from '../utils/stringUtils.js';
import { useVoiceEnabled } from './useVoiceEnabled.js';

// 死代码消除：voice input hook 的条件导入。
/* eslint-disable @typescript-eslint/no-require-imports */
// 捕获模块命名空间，而非函数：spyOn() 会修改模块
// 对象，所以 `voiceNs.useVoice(...)` 解析到 spy，即使此模块
// 在 spy 安装之前已加载（测试顺序无关）。
const voiceNs: { useVoice: typeof import('./useVoice.js').useVoice } = feature('VOICE_MODE')
  ? require('./useVoice.js')
  : {
      useVoice: ({ enabled: _e }: { onTranscript: (t: string) => void; enabled: boolean }) => ({
        state: 'idle' as const,
        handleKeyEvent: (_fallbackMs?: number) => {},
      }),
    };
/* eslint-enable @typescript-eslint/no-require-imports */

// 按键之间算作按住（auto-repeat）的最大间隔（ms）。
// 终端 auto-repeat 每 30-80ms 触发一次；120ms 覆盖抖动，同时
// 排除正常打字速度（按键之间 100-300ms）。
const RAPID_KEY_GAP_MS = 120;

// 修饰键组合首次按键激活的回退（ms）。必须匹配
// useVoice.ts 中的 FIRST_PRESS_FALLBACK_MS。覆盖最大 OS 初始
// 按键重复延迟（macOS 滑块为 "Long" 时约 2s），使按住
// 修饰键组合不会在第一次 auto-repeat 于默认 600ms
// REPEAT_FALLBACK_MS 之后到达时分裂成两个会话。
const MODIFIER_FIRST_PRESS_FALLBACK_MS = 2000;

// 激活 voice 所需的快速连续按键事件数。
// 仅适用于 bare-char 绑定（space、v 等），因为单次按键
// 可能是正常打字。修饰键组合在第一次按键时激活。
const HOLD_THRESHOLD = 5;

// 开始显示 warmup 反馈的快速按键事件数。
const WARMUP_THRESHOLD = 2;

// 将 KeyboardEvent 与 ParsedKeystroke 匹配。取代了旧版
// matchesKeystroke(input, Key, ...) 路径，该路径假设 useInput 的原始
// `input` 参数 —— KeyboardEvent.key 持有归一化名称（例如 'space'、
// 'f9'），getKeyName() 不处理这些，所以修饰键组合和 f 键
// 在 onKeyDown 迁移后（#23524）静默匹配失败。
function matchesKeyboardEvent(e: KeyboardEvent, target: ParsedKeystroke): boolean {
  // KeyboardEvent 存储键名；ParsedKeystroke 对 space 存 ' '，
  // 对 return 存 'enter'（见 parser.ts case 'space'/'return'）。
  const key = e.key === 'space' ? ' ' : e.key === 'return' ? 'enter' : e.key.toLowerCase();
  if (key !== target.key) return false;
  if (e.ctrl !== target.ctrl) return false;
  if (e.shift !== target.shift) return false;
  // KeyboardEvent.meta 折叠了 alt|option（终端限制 —— esc-prefix）；
  // ParsedKeystroke 将 alt 和 meta 作为同一事物的别名。
  if (e.meta !== (target.alt || target.meta)) return false;
  if (e.superKey !== target.super) return false;
  return true;
}

// 当根本没有 KeybindingProvider 时（例如 headless/test 上下文）的硬编码默认值。
// 当 provider 存在且查找返回 null 时不使用 —— 那意味着用户 null-unbind 或重新分配了
// space，回退到 space 会选中一个死键或冲突键。
const DEFAULT_VOICE_KEYSTROKE: ParsedKeystroke = {
  key: ' ',
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
  super: false,
};

type InsertTextHandle = {
  insert: (text: string) => void;
  setInputWithCursor: (value: string, cursor: number) => void;
  cursorOffset: number;
};

type UseVoiceIntegrationArgs = {
  setInputValueRaw: React.Dispatch<React.SetStateAction<string>>;
  inputValueRef: React.RefObject<string>;
  insertTextRef: React.RefObject<InsertTextHandle | null>;
};

type InterimRange = { start: number; end: number };

type StripOpts = {
  // 要剥离的字符（配置的 hold 键）。默认为 space。
  char?: string;
  // 在剥离位置捕获 voice prefix/suffix 锚点。
  anchor?: boolean;
  // 保留的最小尾部计数 —— 防止在防御性清理泄漏时剥离
  // 有意的 warmup 字符。
  floor?: number;
};

type UseVoiceIntegrationResult = {
  // 返回剥离后剩余的尾部字符数。
  stripTrailing: (maxStrip: number, opts?: StripOpts) => number;
  // 在 voice 激活失败后撤销 gap 空格并重置锚点 ref。
  resetAnchor: () => void;
  handleKeyEvent: (fallbackMs?: number) => void;
  interimRange: InterimRange | null;
};

export function useVoiceIntegration({
  setInputValueRaw,
  inputValueRef,
  insertTextRef,
}: UseVoiceIntegrationArgs): UseVoiceIntegrationResult {
  const { addNotification } = useNotifications();

  // 跟踪 voice 启动时光标前/后的输入内容，
  // 使 interim 转录可以插入到光标位置而不破坏
  // 周围的用户文本。
  const voicePrefixRef = useRef<string | null>(null);
  const voiceSuffixRef = useRef<string>('');
  // 跟踪此 hook 最后写入的输入值（通过锚点、interim effect
  // 或 handleVoiceTranscript）。如果 inputValueRef.current 分叉，用户
  // 已提交或编辑 —— 两条写入路径都退出以避免破坏。这是
  // 唯一能正确处理 empty-prefix-empty-suffix 的守卫：
  // startsWith('')/endsWith('') 检查空洞通过，长度检查
  // 无法区分已清除的输入和从未设置的输入。
  const lastSetInputRef = useRef<string | null>(null);

  // 剥离尾部 hold-key 字符（并可选捕获 voice
  // 锚点）。在 warmup 期间调用（清理越过
  // stopImmediatePropagation 泄漏的字符 —— 监听器顺序不保证），
  // 在激活时调用（anchor=true 捕获光标周围的 prefix/suffix
  // 用于 interim 转录放置）。调用方传入
  // 预期剥离的精确计数，使边界上的预先存在字符被保留
  // （例如 hold-key 为 "v" 时 "hav" 中的 "v"）。
  // floor 选项设置保留的最小尾部计数
  // （warmup 期间这是我们有意放行的计数，所以
  // 防御性清理仅移除泄漏）。返回剥离后剩余的
  // 尾部字符数。无变化时不执行
  // 状态更新。
  const stripTrailing = useCallback(
    (maxStrip: number, { char = ' ', anchor = false, floor = 0 }: StripOpts = {}) => {
      const prev = inputValueRef.current;
      const offset = insertTextRef.current?.cursorOffset ?? prev.length;
      const beforeCursor = prev.slice(0, offset);
      const afterCursor = prev.slice(offset);
      // 当 hold 键为 space 时，也计数 CJK IME 可能
      // 为同一物理键插入的全角空格（U+3000）。
      // U+3000 是 BMP 单代码单元，所以索引与 beforeCursor 对齐。
      const scan = char === ' ' ? normalizeFullWidthSpace(beforeCursor) : beforeCursor;
      let trailing = 0;
      while (trailing < scan.length && scan[scan.length - 1 - trailing] === char) {
        trailing++;
      }
      const stripCount = Math.max(0, Math.min(trailing - floor, maxStrip));
      const remaining = trailing - stripCount;
      const stripped = beforeCursor.slice(0, beforeCursor.length - stripCount);
      // 用非空格 suffix 锚定时，插入一个 gap 空格，使
      // 波形光标位于 gap 上而非覆盖第一个
      // suffix 字母。interim 转录 effect 维护此相同
      // 结构（prefix + leading + interim + trailing + suffix），所以
      // 转录文本到达后 gap 是无缝的。
      // 锚点时总是覆盖 —— 如果之前的激活未能启动
      // voice（voiceState 保持 'idle'），cleanup effect 未触发，
      // 旧锚点是陈旧的。anchor=true 仅在单次
      // 激活调用时传入，录音期间从不传入，所以覆盖是安全的。
      let gap = '';
      if (anchor) {
        voicePrefixRef.current = stripped;
        voiceSuffixRef.current = afterCursor;
        if (afterCursor.length > 0 && !/^\s/.test(afterCursor)) {
          gap = ' ';
        }
      }
      const newValue = stripped + gap + afterCursor;
      if (anchor) lastSetInputRef.current = newValue;
      if (newValue === prev && stripCount === 0) return remaining;
      if (insertTextRef.current) {
        insertTextRef.current.setInputWithCursor(newValue, stripped.length);
      } else {
        setInputValueRaw(newValue);
      }
      return remaining;
    },
    [setInputValueRaw, inputValueRef, insertTextRef],
  );

  // 撤销 stripTrailing(..., {anchor:true}) 插入的 gap 空格并
  // 重置 voice prefix/suffix ref。在 voice 激活失败
  // （voiceHandleKeyEvent 后 voiceState 保持 'idle'）时调用，所以
  // cleanup effect（下方的 voiceState useEffect）—— 仅在 voiceState 转换时触发 —— 无法
  // 到达陈旧锚点。没有这个，gap 空格和陈旧 ref
  // 会在输入中持久存在。
  const resetAnchor = useCallback(() => {
    const prefix = voicePrefixRef.current;
    if (prefix === null) return;
    const suffix = voiceSuffixRef.current;
    voicePrefixRef.current = null;
    voiceSuffixRef.current = '';
    const restored = prefix + suffix;
    if (insertTextRef.current) {
      insertTextRef.current.setInputWithCursor(restored, prefix.length);
    } else {
      setInputValueRaw(restored);
    }
  }, [setInputValueRaw, insertTextRef]);

  // Voice state 选择器。useVoiceEnabled = 用户意图（settings）+
  // auth + GB kill-switch，auth 部分在 authVersion 上 memoize，所以
  // 渲染循环永远不会命中冷 keychain spawn。
  const voiceEnabledRaw = useVoiceEnabled();
  const voiceEnabled = feature('VOICE_MODE') ? voiceEnabledRaw : false;
  const voiceStateRaw = useVoiceState(s => s.voiceState);
  const voiceState = feature('VOICE_MODE') ? voiceStateRaw : ('idle' as const);
  const voiceInterimTranscriptRaw = useVoiceState(s => s.voiceInterimTranscript);
  const voiceInterimTranscript = feature('VOICE_MODE') ? voiceInterimTranscriptRaw : '';

  // 为 focus mode 设置 voice 锚点（录音通过终端
  // focus 启动，而非按键保持）。Key-hold 在 stripTrailing 中设置锚点。
  useEffect(() => {
    if (!feature('VOICE_MODE')) return;
    if (voiceState === 'recording' && voicePrefixRef.current === null) {
      const input = inputValueRef.current;
      const offset = insertTextRef.current?.cursorOffset ?? input.length;
      voicePrefixRef.current = input.slice(0, offset);
      voiceSuffixRef.current = input.slice(offset);
      lastSetInputRef.current = input;
    }
    if (voiceState === 'idle') {
      voicePrefixRef.current = null;
      voiceSuffixRef.current = '';
      lastSetInputRef.current = null;
    }
  }, [voiceState, inputValueRef, insertTextRef]);

  // 随着 voice 转录语音，用 interim 转录实时更新
  // prompt 输入。prefix（光标前的用户输入文本）被
  // 保留，转录插入 prefix 和 suffix 之间。
  useEffect(() => {
    if (!feature('VOICE_MODE')) return;
    if (voicePrefixRef.current === null) return;
    const prefix = voicePrefixRef.current;
    const suffix = voiceSuffixRef.current;
    // 提交竞态：如果输入不是此 hook 最后设置的值，
    // 用户已提交（清除它）或编辑了它。voicePrefixRef 仅
    // 在 voiceState→idle 时清除，所以在 'processing'
    // 窗口（CloseStream 和 WS close 之间）仍被设置 —— 这捕获
    // 那时到达的精炼 TranscriptText 并重新填充已清除的输入。
    if (inputValueRef.current !== lastSetInputRef.current) return;
    const needsSpace = prefix.length > 0 && !/\s$/.test(prefix) && voiceInterimTranscript.length > 0;
    // 不要以 voiceInterimTranscript.length 做门控 —— 当 handleVoiceTranscript
    // 设置 final 文本后 interim 清除为 ''
    // 时，prefix 和 suffix 之间的尾部空格
    // 仍必须保留。
    const needsTrailingSpace = suffix.length > 0 && !/^\s/.test(suffix);
    const leadingSpace = needsSpace ? ' ' : '';
    const trailingSpace = needsTrailingSpace ? ' ' : '';
    const newValue = prefix + leadingSpace + voiceInterimTranscript + trailingSpace + suffix;
    // 将光标定位在转录文本之后（suffix 之前）
    const cursorPos = prefix.length + leadingSpace.length + voiceInterimTranscript.length;
    if (insertTextRef.current) {
      insertTextRef.current.setInputWithCursor(newValue, cursorPos);
    } else {
      setInputValueRaw(newValue);
    }
    lastSetInputRef.current = newValue;
  }, [voiceInterimTranscript, setInputValueRaw, inputValueRef, insertTextRef]);

  const handleVoiceTranscript = useCallback(
    (text: string) => {
      if (!feature('VOICE_MODE')) return;
      const prefix = voicePrefixRef.current;
      // 无 voice 锚点 —— voice 已重置（或从未启动）。无事可做。
      if (prefix === null) return;
      const suffix = voiceSuffixRef.current;
      // 提交竞态：finishRecording() → 用户按 Enter（输入清除）
      // → WebSocket close → 此回调以陈旧 prefix/suffix 触发。
      // 如果输入不是此 hook 最后设置的（通过 interim effect
      // 或锚点），用户已提交或编辑 —— 不要重新填充。与
      // `text.length` 比较会在 final 比
      // interim 长（ASR 通常添加标点/修正）时误报。
      if (inputValueRef.current !== lastSetInputRef.current) return;
      const needsSpace = prefix.length > 0 && !/\s$/.test(prefix) && text.length > 0;
      const needsTrailingSpace = suffix.length > 0 && !/^\s/.test(suffix) && text.length > 0;
      const leadingSpace = needsSpace ? ' ' : '';
      const trailingSpace = needsTrailingSpace ? ' ' : '';
      const newInput = prefix + leadingSpace + text + trailingSpace + suffix;
      // 将光标定位在转录文本之后（suffix 之前）
      const cursorPos = prefix.length + leadingSpace.length + text.length;
      if (insertTextRef.current) {
        insertTextRef.current.setInputWithCursor(newInput, cursorPos);
      } else {
        setInputValueRaw(newInput);
      }
      lastSetInputRef.current = newInput;
      // 更新 prefix 以包含此块，使 focus mode 可以
      // 在其后继续追加后续转录。
      voicePrefixRef.current = prefix + leadingSpace + text;
    },
    [setInputValueRaw, inputValueRef, insertTextRef],
  );

  const voice = voiceNs.useVoice({
    onTranscript: handleVoiceTranscript,
    onError: (message: string) => {
      addNotification({
        key: 'voice-error',
        text: message,
        color: 'error',
        priority: 'immediate',
        timeoutMs: 10_000,
      });
    },
    enabled: voiceEnabled,
    focusMode: false,
  });

  // 计算输入值中 interim（尚未 final）转录
  // 文本的字符范围，以便 UI 可以变暗显示。
  const interimRange = useMemo((): InterimRange | null => {
    if (!feature('VOICE_MODE')) return null;
    if (voicePrefixRef.current === null) return null;
    if (voiceInterimTranscript.length === 0) return null;
    const prefix = voicePrefixRef.current;
    const needsSpace = prefix.length > 0 && !/\s$/.test(prefix) && voiceInterimTranscript.length > 0;
    const start = prefix.length + (needsSpace ? 1 : 0);
    const end = start + voiceInterimTranscript.length;
    return { start, end };
  }, [voiceInterimTranscript]);

  return {
    stripTrailing,
    resetAnchor,
    handleKeyEvent: voice.handleKeyEvent,
    interimRange,
  };
}

/**
 * 处理 hold-to-talk voice 激活的组件。
 *
 * 激活键可通过 keybindings 配置（voice:pushToTalk，
 * 默认：space）。Hold 检测依赖 OS auto-repeat 以 30-80ms 间隔
 * 投递事件流。两种绑定类型有效：
 *
 * **修饰键 + 字母（meta+k、ctrl+x、alt+v）：** 最干净。在
 * 第一次按键时激活 —— 修饰键组合是明确的意图（不可能
 * 误打），所以不适用 hold 阈值。字母部分
 * 按住时 auto-repeat，向 useVoice.ts 中的释放检测喂数据。
 * 无 flow-through，无剥离。
 *
 * **Bare 字符（space、v、x）：** 需要 HOLD_THRESHOLD 次快速按键才能
 * 激活（单次 space 可能是正常打字）。前
 * WARMUP_THRESHOLD 次按键流入输入，使单次按键正常
 * 打字。超过后，快速按键被吞掉；激活时
 * flow-through 字符被剥离。绑定 "v" 不会使 "v"
 * 不可打 —— 正常打字（按键之间 >120ms）会流过；
 * 只有按住键的快速 auto-repeat 触发激活。
 *
 * 已知损坏：modifier+space（NUL → 解析为 ctrl+backtick）、chords
 * （离散序列，无 hold）。验证会对此发出警告。
 */
export function useVoiceKeybindingHandler({
  voiceHandleKeyEvent,
  stripTrailing,
  resetAnchor,
  isActive,
}: {
  voiceHandleKeyEvent: (fallbackMs?: number) => void;
  stripTrailing: (maxStrip: number, opts?: StripOpts) => number;
  resetAnchor: () => void;
  isActive: boolean;
}): { handleKeyDown: (e: KeyboardEvent) => void } {
  const getVoiceState = useGetVoiceState();
  const setVoiceState = useSetVoiceState();
  const keybindingContext = useOptionalKeybindingContext();
  const isModalOverlayActive = useIsModalOverlayActive();
  const voiceEnabledRaw = useVoiceEnabled();
  const voiceEnabled = feature('VOICE_MODE') ? voiceEnabledRaw : false;
  const voiceStateRaw = useVoiceState(s => s.voiceState);
  const voiceState = feature('VOICE_MODE') ? voiceStateRaw : 'idle';

  // 从 keybinding context 中查找 voice:pushToTalk 的配置键。
  // 前向迭代，最后赢（匹配 resolver）：如果后续的
  // Chat 绑定用 null 或不同的
  // 动作覆盖同一 chord，voice 绑定被丢弃，返回 null —— 用户
  // 通过绑定覆盖显式禁用了 hold-to-talk，所以
  // 不要用回退值替他们做决定。DEFAULT 仅在
  // 根本没有 provider 时使用。Context 过滤是必需的 —— space
  // 也绑定在 Settings/Confirmation/Plugin 中（select:accept 等）；
  // 没有过滤，那些会使默认值变 null。
  const voiceKeystroke = useMemo((): ParsedKeystroke | null => {
    if (!keybindingContext) return DEFAULT_VOICE_KEYSTROKE;
    let result: ParsedKeystroke | null = null;
    for (const binding of keybindingContext.bindings) {
      if (binding.context !== 'Chat') continue;
      if (binding.chord.length !== 1) continue;
      const ks = binding.chord[0];
      if (!ks) continue;
      if (binding.action === 'voice:pushToTalk') {
        result = ks;
      } else if (result !== null && keystrokesEqual(ks, result)) {
        // 后续绑定覆盖此 chord（null unbind 或重新分配）
        result = null;
      }
    }
    return result;
  }, [keybindingContext]);

  // 如果绑定是 bare（无修饰键）单可打印字符，终端
  // auto-repeat 可能将 N 次按键批量为一个输入事件（例如 "vvv"），
  // 字符流入文本输入 —— 我们需要 flow-through + 剥离。
  // 修饰键组合（meta+k、ctrl+x）也 auto-repeat（字母部分
  // 重复）但不插入文本，所以它们从第一次
  // 按键起就被吞掉，无需剥离。matchesKeyboardEvent 处理那些。
  const bareChar =
    voiceKeystroke !== null &&
    voiceKeystroke.key.length === 1 &&
    !voiceKeystroke.ctrl &&
    !voiceKeystroke.alt &&
    !voiceKeystroke.shift &&
    !voiceKeystroke.meta &&
    !voiceKeystroke.super
      ? voiceKeystroke.key
      : null;

  const rapidCountRef = useRef(0);
  // 我们有意放行到文本
  // 输入的快速字符数（前 WARMUP_THRESHOLD 个）。激活剥离移除
  // 最多这么多 + 激活事件的潜在泄漏。对于
  // 默认值（space）这是精确的 —— 预先存在的尾部空格
  // 罕见。对于字母绑定（验证会警告），如果输入已以绑定
  // 字母结尾，可能过度剥离
  // 一个预先存在的字符（例如 "hav" + 按住 "v" → "ha"）。我们不跟踪那个
  // 边界 —— 这是尽力而为，警告也是这么说的。
  const charsInInputRef = useRef(0);
  // 激活剥离后剩余的尾部字符计数 —— 这些
  // 属于用户的锚定 prefix，必须在录音的防御性泄漏清理期间保留。
  const recordingFloorRef = useRef(0);
  // 当前录音由 key-hold 启动（而非 focus）时为 true。
  // 用于避免在 focus-mode 录音期间吞掉按键。
  const isHoldActiveRef = useRef(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 离开 'recording' 时立即重置 hold 状态。物理 hold
  // 在 key-repeat 停止时结束（state → 'processing'）；让 ref
  // 在 'processing' 期间保持设置会吞掉用户在
  // 转录 finalize 期间打的新 space 按键。
  useEffect(() => {
    if (voiceState !== 'recording') {
      isHoldActiveRef.current = false;
      rapidCountRef.current = 0;
      charsInInputRef.current = 0;
      recordingFloorRef.current = 0;
      setVoiceState(prev => {
        if (!prev.voiceWarmingUp) return prev;
        return { ...prev, voiceWarmingUp: false };
      });
    }
  }, [voiceState, setVoiceState]);

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (!voiceEnabled) return;

    // PromptInput 不是有效的转录目标 —— 让 hold 键
    // 流过，而不是吞进陈旧 ref（#33556）。
    // 两种不同的 unmount/unfocus 路径（都需要）：
    //   - !isActive：local-jsx 命令隐藏了 PromptInput（shouldHidePromptInput）
    //     而未注册 overlay —— 例如 /install-github-app、
    //     /plugin。镜像 CommandKeybindingHandlers 的 isActive 门控。
    //   - isModalOverlayActive：overlay（权限对话框、带
    //     onCancel 的 Select）有焦点；PromptInput 已挂载但 focus=false。
    if (!isActive || isModalOverlayActive) return;

    // null 意味着用户覆盖了默认值（null-unbind/重新分配）——
    // hold-to-talk 通过绑定禁用。要切换功能
    // 本身，使用 /voice。
    if (voiceKeystroke === null) return;

    // 匹配配置的键。Bare 字符按内容匹配（处理
    // 批量 auto-repeat 如 "vvv"），拒绝修饰键，使例如
    // ctrl+v 不会触发 "v" 绑定。修饰键组合通过
    // matchesKeyboardEvent 处理（每次重复一个事件，无批量）。
    let repeatCount: number;
    if (bareChar !== null) {
      if (e.ctrl || e.meta || e.shift) return;
      // 绑定到 space 时，也接受 U+3000（全角空格）——
      // CJK IME 为同一物理键发出它。
      const normalized = bareChar === ' ' ? normalizeFullWidthSpace(e.key) : e.key;
      // 快速路径：正常打字（任何不是绑定字符的字符）
      // 在此退出，无需分配。repeat() 检查仅对
      // 批量 auto-repeat（input.length > 1）重要，这很罕见。
      if (normalized[0] !== bareChar) return;
      if (normalized.length > 1 && normalized !== bareChar.repeat(normalized.length)) return;
      repeatCount = normalized.length;
    } else {
      if (!matchesKeyboardEvent(e, voiceKeystroke)) return;
      repeatCount = 1;
    }

    // 守卫：仅在录音由 key-hold 触发时吞掉按键。
    // focus-mode 录音也将 voiceState 设为 'recording'，
    // 但按键应正常流过（voiceHandleKeyEvent
    // 对 focus 触发的会话提前返回）。我们也从 store 检查 voiceState，
    // 这样如果 voiceHandleKeyEvent() 未能转换
    // state（模块未加载、流不可用），我们不会永久
    // 吞掉按键。
    const currentVoiceState = getVoiceState().voiceState;
    if (isHoldActiveRef.current && currentVoiceState !== 'idle') {
      // 已在录音 —— 吞掉后续按键并转发
      // 给 voice 做释放检测。对于 bare 字符，防御性地
      // 剥离，以防文本输入处理程序在此处理程序之前触发
      // （监听器顺序不保证）。修饰键组合不
      // 插入文本，所以无需剥离。
      e.stopImmediatePropagation();
      if (bareChar !== null) {
        stripTrailing(repeatCount, {
          char: bareChar,
          floor: recordingFloorRef.current,
        });
      }
      voiceHandleKeyEvent();
      return;
    }

    // 非 hold 录音（focus-mode）或 processing 活跃。
    // 修饰键组合不能重新激活：stripTrailing(0,{anchor:true})
    // 会用 interim 文本覆盖 voicePrefixRef 并在下一次
    // interim 更新时重复转录。#22144 之前，单次点击
    // 命中 warmup else 分支（仅吞掉）。Bare 字符无条件流过 ——
    // 用户可能在 focus 录音期间打字。
    if (currentVoiceState !== 'idle') {
      if (bareChar === null) e.stopImmediatePropagation();
      return;
    }

    const countBefore = rapidCountRef.current;
    rapidCountRef.current += repeatCount;

    // ── 激活 ────────────────────────────────────────────
    // 先处理，使下方的 warmup 分支不在此事件上运行
    // —— 同一 tick 中两次 strip 调用都会读取
    // 陈旧的 inputValueRef，第二次会剥离不足。
    // 修饰键组合在第一次按键时激活 —— 它们不可能
    // 被误打，所以 hold 阈值（用于
    // 区分打 space 和按住 space）不适用。
    if (bareChar === null || rapidCountRef.current >= HOLD_THRESHOLD) {
      e.stopImmediatePropagation();
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
      rapidCountRef.current = 0;
      isHoldActiveRef.current = true;
      setVoiceState(prev => {
        if (!prev.voiceWarmingUp) return prev;
        return { ...prev, voiceWarmingUp: false };
      });
      if (bareChar !== null) {
        // 剥离有意的 warmup 字符加此事件的泄漏
        // （如果文本输入先触发）。Cap 覆盖两者；min(trailing)
        // 处理无泄漏情况。在此锚定 voice prefix。
        // 返回值（remaining）成为录音时
        // 泄漏清理的 floor。
        recordingFloorRef.current = stripTrailing(charsInInputRef.current + repeatCount, {
          char: bareChar,
          anchor: true,
        });
        charsInInputRef.current = 0;
        voiceHandleKeyEvent();
      } else {
        // 修饰键组合：无插入，无剥离。仅
        // 在当前光标位置锚定 voice prefix。
        // 更长的回退：此调用在 t=0（auto-repeat 之前），
        // 所以到下一次按键的间隔是 OS 初始重复
        // *延迟*（最长 ~2s），而非重复*速率*（~30-80ms）。
        stripTrailing(0, { anchor: true });
        voiceHandleKeyEvent(MODIFIER_FIRST_PRESS_FALLBACK_MS);
      }
      // 如果 voice 未能转换（模块未加载、流
      // 不可用、enabled 陈旧），清除 ref，使后续
      // focus-mode 录音不会继承陈旧 hold 状态
      // 并吞掉按键。Store 是同步的 —— 检查
      // 立即。stripTrailing 上面设置的锚点将
      // 在重试时被覆盖（锚点现在总是覆盖）。
      if (getVoiceState().voiceState === 'idle') {
        isHoldActiveRef.current = false;
        resetAnchor();
      }
      return;
    }

    // ── Warmup（仅 bare-char；修饰键组合已在上方激活） ──
    // 前 WARMUP_THRESHOLD 个字符流入文本输入，使正常
    // 打字零延迟（单次按键正常打字）。
    // 后续快速字符被吞掉，使输入与
    // warmup UI 对齐。防御性剥离（监听器顺序不
    // 保证 —— 文本输入可能已添加字符）。
    // floor 保留有意的 warmup 字符；无泄漏时
    // 剥离是 no-op。检查 countBefore 使越过
    // 阈值的事件仍能流过（终端批量）。
    if (countBefore >= WARMUP_THRESHOLD) {
      e.stopImmediatePropagation();
      stripTrailing(repeatCount, {
        char: bareChar,
        floor: charsInInputRef.current,
      });
    } else {
      charsInInputRef.current += repeatCount;
    }

    // 一旦检测到 hold 模式就显示 warmup 反馈
    if (rapidCountRef.current >= WARMUP_THRESHOLD) {
      setVoiceState(prev => {
        if (prev.voiceWarmingUp) return prev;
        return { ...prev, voiceWarmingUp: true };
      });
    }

    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = setTimeout(
      (resetTimerRef, rapidCountRef, charsInInputRef, setVoiceState) => {
        resetTimerRef.current = null;
        rapidCountRef.current = 0;
        charsInInputRef.current = 0;
        setVoiceState(prev => {
          if (!prev.voiceWarmingUp) return prev;
          return { ...prev, voiceWarmingUp: false };
        });
      },
      RAPID_KEY_GAP_MS,
      resetTimerRef,
      rapidCountRef,
      charsInInputRef,
      setVoiceState,
    );
  };

  // 向后兼容桥接：REPL.tsx 尚未将 handleKeyDown 连接到
  // <Box onKeyDown>。通过 useInput 订阅并适配 InputEvent →
  // KeyboardEvent，直到消费者迁移（单独 PR）。
  // TODO(onKeyDown-migration)：REPL 传递 handleKeyDown 后移除。
  useInput(
    (_input, _key, event) => {
      const kbEvent = new KeyboardEvent(event.keypress);
      handleKeyDown(kbEvent);
      // handleKeyDown 停止了 adapter 事件，而非 emitter
      // 实际检查的 InputEvent —— 转发它，使文本输入的 useInput
      // 监听器被跳过，按住的 space 不会泄漏到 prompt。
      if (kbEvent.didStopImmediatePropagation()) {
        event.stopImmediatePropagation();
      }
    },
    { isActive },
  );

  return { handleKeyDown };
}

// TODO(onKeyDown-migration)：临时 shim，使现有 JSX 调用者
// （<VoiceKeybindingHandler .../>）保持编译。REPL.tsx
// 直接连接 handleKeyDown 后移除。
export function VoiceKeybindingHandler(props: {
  voiceHandleKeyEvent: (fallbackMs?: number) => void;
  stripTrailing: (maxStrip: number, opts?: StripOpts) => number;
  resetAnchor: () => void;
  isActive: boolean;
}): null {
  useVoiceKeybindingHandler(props);
  return null;
}
