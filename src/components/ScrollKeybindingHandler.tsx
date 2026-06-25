import React, { type RefObject, useEffect, useRef } from 'react';
import { useNotifications } from '../context/notifications.js';
import { useCopyOnSelect, useSelectionBgColor } from '../hooks/useCopyOnSelect.js';
import type { ScrollBoxHandle, FocusMove, SelectionState } from '@anthropic/ink';
import { useSelection, type Key, useInput, isXtermJs, getClipboardPath } from '@anthropic/ink';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { logForDebugging } from '../utils/debug.js';

type Props = {
  scrollRef: RefObject<ScrollBoxHandle | null>;
  isActive: boolean;
  /** 每次滚动动作后调用，传入最终的 sticky 状态和
   *  handle（用于在滚动后读取 scrollTop/scrollHeight）。 */
  onScroll?: (sticky: boolean, handle: ScrollBoxHandle) => void;
  /** 启用 modal pager 按键（g/G、ctrl+u/d/b/f）。仅在没有文本输入
   *  与这些字符竞争时才安全 —— 即 transcript 模式。默认为 false。
   *  为 true 时，G 不管 editorMode 和 sticky 状态都能生效；
   *  ctrl+u/d/b/f 不会与 kill-line/exit/task:background/kill-agents
   *  冲突（它们都没挂载，或者在本组件之后挂载，所以
   *  stopImmediatePropagation 会胜出）。 */
  isModal?: boolean;
};

// 终端针对每行预期滚动发送一个 SGR 滚轮事件（在 Ghostty
// src/Surface.zig 中验证过：`for (0..@abs(y.delta)) |_| { mouseReport(.four, ...) }`）。
// Ghostty 在该循环之前已经把离散滚轮 tick 放大了 3 倍；触控板的
// 精确滚动是 像素/cell_size。1 个事件 = 预期 1 行 —— 以此作为
// 基准，并在事件快速到达时拉高倍率。pendingScrollDelta 累加器 +
// render-node-to-output 中的按比例排放负责大批量时的平滑追赶。
//
// xterm.js（VS Code/Cursor/Windsurf 集成终端）每个滚轮档位只发送 1 个
// 事件 —— 没有预放大。下面另一条指数衰减曲线用来补偿较低的事件率，
// 并针对 VS Code 的事件模式调校了突发检测和与间隔相关的上限。

// 原生终端：硬窗口线性斜坡。比窗口更近的事件会拉高倍率；空闲间隔
// 会重置为 `base`（默认 1）。某些模拟器会在自己的层做预放大
// （ghostty discrete=3 每档发 3 个 SGR 事件；iTerm2 的 "faster scroll"
// 类似）—— 此时 base=1 是对的。另一些每档发 1 个事件 —— 这类用户
// 可以设置 CLAUDE_CODE_SCROLL_SPEED=3 以匹配 vim/nvim/opencode 的
// 应用层默认值。我们无法检测是哪一种，所以做成可调节旋钮。
const WHEEL_ACCEL_WINDOW_MS = 40;
const WHEEL_ACCEL_STEP = 0.3;
const WHEEL_ACCEL_MAX = 6;

// 编码器抖动去抖 + 滚轮模式衰减曲线。磨损/廉价的光电编码器在快速
// 旋转时会发出虚假的反向 tick —— 在 Boris 的鼠标上测得占 28%
// 事件（2026-03-17，iTerm2）。模式总是"翻转再翻回"；触控板则一个
// 翻转都没有（同一段录制中 0/458）。一次被确认的抖动证明接的是
// 物理滚轮 —— 启用与 xterm.js 路径相同的指数衰减曲线（已经调校好），
// 并用更高的上限来补偿较低的事件率（~9 次/秒 vs VS Code 的 ~30 次/秒）。
// 触控板走不到这条路径。
//
// 衰减曲线给出：空闲后第 1 次点击 = 1 行（精度），第 2 次 = 10，
// 第 3 次 = 上限。减速时平滑衰减回 1 —— 不需要单独的空闲阈值，
// 大间隔时 m≈0 → mult→1。滚轮模式是 STICKY 的：一旦某次抖动确认是
// 鼠标，衰减曲线就一直生效，直到出现空闲间隔或触控板快速滑动突发
// 提示可能切换了设备。
const WHEEL_BOUNCE_GAP_MAX_MS = 200; // 翻回必须在此时间内到达
// 鼠标约 9 次/秒，而 VS Code 约 30 次 —— STEP 是 xterm.js 的 5 的 3 倍
// 来补偿。在 gap=100ms（m≈0.63）时：一次点击给 1+15*0.63≈10.5。
const WHEEL_MODE_STEP = 15;
const WHEEL_MODE_CAP = 15;
// 每个事件 mult 的最大增长。没有这一项，当 wheelMode 在滚动中途启用时
// （在 trackpad 模式 mult=1 经过 N 个事件后检测到抖动），+STEP*m 项会让
// mult 在一个事件内从 1 跳到 10。用户会看到滚动突然变快 10 倍。
// 上限=3 在 9 次/秒下给出 1→4→7→10→13→15，约 0.5 秒 —— 平滑斜坡
// 而不是跳变。衰减不受影响（target<mult 在 min 中胜出）。
const WHEEL_MODE_RAMP = 3;
// 设备切换退出：鼠标手指换位最长约 830ms（实测）；触控板手势之间的
// 停顿在 2000ms 以上。超过此值的空闲间隔意味着用户停下了 —— 可能
// 切换了设备。退出；下一次鼠标抖动会重新启用。触控板慢速轻扫
// （没有 <5ms 突发，所以突发计数守卫抓不到）正是这一项要防护的场景。
const WHEEL_MODE_IDLE_DISENGAGE_MS = 1500;

// xterm.js：指数衰减。momentum=0.5^(gap/hl) —— 慢点击 → m≈0
// → mult→1（精度）；快点击 → m≈1 → 带动惯性。稳态
// = 1 + step×m/(1-m)，再取上限。VS Code 中实测的事件率（wheel.log）：
// 持续滚动以 20-50ms 间隔（20-40 Hz）发送事件，外加快速滑动时
// 0-2ms 的同批次突发。上限较低（3–6，与间隔相关）是因为事件频率高 ——
// 40 Hz × 6 = 每秒最多 240 行的需求，自适应排放（实测 ~200fps）能处理。
// 上限更高 → 待处理量爆炸。经验调校（boris 2026-03）。见
// docs/research/terminal-scroll-*。
const WHEEL_DECAY_HALFLIFE_MS = 150;
const WHEEL_DECAY_STEP = 5;
// 同批次事件（<BURST_MS）在一个 stdin 批次里到达 —— 终端在做
// 按比例上报。像原生那样按 1 行/事件处理。
const WHEEL_BURST_MS = 5;
// 上限边界：慢事件（≥GAP_MS）取低上限用于短平滑排放；
// 快事件取较高上限用于吞吐（自适应排放处理积压）。
const WHEEL_DECAY_GAP_MS = 80;
const WHEEL_DECAY_CAP_SLOW = 3; // gap ≥ GAP_MS：精度
const WHEEL_DECAY_CAP_FAST = 6; // gap < GAP_MS：吞吐
// 空闲阈值：超过此值的间隔会重置为 kick 值（2），让暂停后的第一次
// 点击无论方向都感觉灵敏。
const WHEEL_DECAY_IDLE_MS = 500;

/**
 * 某次按键是否应清除虚拟文本选区。模仿原生终端选区行为：任何按键
 * 都会清除，例外是带修饰键的导航键（shift/opt/cmd + 方向键/
 * home/end/page*）。在原生 macOS 环境里，shift+nav 扩展选区，
 * cmd/opt+nav 通常被终端模拟器拦截用于回滚导航 —— 两者都不会
 * 打扰选区。纯方向键会清除（用户光标移动，原生会取消选区）。
 * 滚轮被排除 —— scroll:lineUp/Down 已通过 keybinding 路径清除。
 */
export function shouldClearSelectionOnKey(key: Key): boolean {
  if (key.wheelUp || key.wheelDown) return false;
  const isNav =
    key.leftArrow ||
    key.rightArrow ||
    key.upArrow ||
    key.downArrow ||
    key.home ||
    key.end ||
    key.pageUp ||
    key.pageDown;
  if (isNav && (key.shift || key.meta || key.super)) return false;
  return true;
}

/**
 * 把按键映射为选区焦点的移动（键盘扩展）。只有 shift 会扩展 —— 它是
 * 通用的文本选择修饰键。cmd（super）只能通过 kitty keyboard 协议
 * 到达 —— 大多数终端里 cmd+方向键会被模拟器拦截，到不了 pty，所以
 * 没有 super 分支。shift+home/end 覆盖行首行尾跳转（mac 笔记本上
 * fn+shift+left/right 等价于 shift+home/end）。shift+opt（按词跳转）
 * 尚未实现 —— 会落到 shouldClearSelectionOnKey，它保留（带修饰的
 * 导航）。对非扩展键返回 null。
 */
export function selectionFocusMoveForKey(key: Key): FocusMove | null {
  if (!key.shift || key.meta) return null;
  if (key.leftArrow) return 'left';
  if (key.rightArrow) return 'right';
  if (key.upArrow) return 'up';
  if (key.downArrow) return 'down';
  if (key.home) return 'lineStart';
  if (key.end) return 'lineEnd';
  return null;
}

export type WheelAccelState = {
  time: number;
  mult: number;
  dir: 0 | 1 | -1;
  xtermJs: boolean;
  /** 携带的小数滚动（仅 xterm.js）。scrollBy 向下取整，所以没有这一项
   *  时 mult=1.5 每次都给 1 行。带上余数后 mult=1.5 平均给 1,2,1,2 ——
   *  长期吞吐正确。 */
  frac: number;
  /** 原生路径的基准 行数/事件。空闲/反向时重置值；斜坡在它之上累加。
   *  xterm.js 路径忽略此项（有自己的 kick=2 调校）。 */
  base: number;
  /** 延迟的方向翻转（仅原生）。可能是编码器抖动，也可能是真实反向 ——
   *  由下一个事件决定。真实反向损失 1 行延迟；抖动被吞掉并触发滚轮
   *  模式。翻转的方向和时间戳可推导（总是 -state.dir 在 state.time），
   *  所以这里只是一个标记。 */
  pendingFlip: boolean;
  /** 一旦抖动被确认（在 BOUNCE_GAP_MAX 内翻转再翻回）就置为 true。
   *  STICKY —— 但在空闲间隔 >1500ms 或触控板特征的突发（见 burstCount）
   *  时退出。状态放在 useRef 里，跨设备切换时保留；退出逻辑处理
   *  mouse→trackpad。 */
  wheelMode: boolean;
  /** 连续的 <5ms 事件。触控板快速滑动会产生 100+ 个 <5ms 事件；
   *  鼠标 ≤3 个（在 /tmp/wheel-tune.txt 中验证）。连续 5+ 个 → 触控板
   *  特征 → 退出滚轮模式，避免设备切换把鼠标加速泄漏给触控板。 */
  burstCount: number;
};

/** 计算一次滚轮事件的行数，会修改加速状态。当方向翻转被延迟以待
 *  抖动判定时返回 0 —— 调用方在 step=0 时空操作（scrollBy(0) 是
 *  no-op，onScroll(false) 是幂等的）。为测试导出。 */
export function computeWheelStep(state: WheelAccelState, dir: 1 | -1, now: number): number {
  if (!state.xtermJs) {
    // 设备切换守卫 ①：空闲退出。在 pendingFlip 解析之前运行，这样
    // 一次待定的抖动（最后一批鼠标事件的 28%）不会通过真实反向的
    // 提前返回绕过它。state.time 要么是最后一次已提交事件，要么是
    // 延迟的翻转 —— 两者都算作"最后一次活动"。
    if (state.wheelMode && now - state.time > WHEEL_MODE_IDLE_DISENGAGE_MS) {
      state.wheelMode = false;
      state.burstCount = 0;
      state.mult = state.base;
    }

    // 在改动 state.time/dir 之前先解析任何延迟的翻转 —— 我们需要
    // 翻转前的 state.dir 来区分抖动（翻回）和真实反向（翻转持续），
    // 并需要 state.time（= 抖动时间戳）做间隔检查。
    if (state.pendingFlip) {
      state.pendingFlip = false;
      if (dir !== state.dir || now - state.time > WHEEL_BOUNCE_GAP_MAX_MS) {
        // 真实反向：新方向持续，或翻回来得太晚。提交。延迟事件的
        // 1 行丢失（可接受的延迟）。
        state.dir = dir;
        state.time = now;
        state.mult = state.base;
        return Math.floor(state.mult);
      }
      // 抖动确认：在窗口内翻回了原始方向。state.dir/mult 与抖动前
      // 一致。state.time 已在下面推进到抖动时刻，所以这里的
      // 间隔 = 翻回间隔 —— 反映用户的真实点击节奏（抖动本身就是
      // 一次物理点击，只是有噪声）。
      state.wheelMode = true;
    }

    const gap = now - state.time;
    if (dir !== state.dir && state.dir !== 0) {
      // 翻转。延迟 —— 下一个事件决定是抖动还是真实反向。推进
      // 时间（但不改 dir/mult）：如果这是抖动，确认事件的间隔将是
      // 翻回间隔，反映用户的真实点击率。抖动本身就是一次物理滚轮
      // 点击，只是编码器读错了 —— 它应该计入节奏。
      state.pendingFlip = true;
      state.time = now;
      return 0;
    }
    state.dir = dir;
    state.time = now;

    // ─── 鼠标（滚轮模式，在设备切换信号前 STICKY）───
    if (state.wheelMode) {
      if (gap < WHEEL_BURST_MS) {
        // 同批次突发检查（从 xterm.js 移植）：当 macOS 给出 delta>1 时，
        // iTerm2 的按比例上报会为一个档位发送 2+ 个 SGR 事件。没有这
        // 一项，第 2 个事件在 gap<1ms 时 m≈1 → STEP*m=15 → 一次轻点
        // 给 1+15=16 行。
        //
        // 设备切换守卫 ②：触控板快速滑动产生 100+ 个 <5ms 事件（实测）；
        // 鼠标 ≤3 个。连续 5+ 个 → 触控板快速滑动。
        if (++state.burstCount >= 5) {
          state.wheelMode = false;
          state.burstCount = 0;
          state.mult = state.base;
        } else {
          return 1;
        }
      } else {
        state.burstCount = 0;
      }
    }
    // 重新检查：可能上面已经退出了。
    if (state.wheelMode) {
      // xterm.js 衰减曲线，STEP×3，更高上限。没有空闲阈值 ——
      // 曲线自己处理（gap=1000ms → m≈0.01 → mult≈1）。没有 frac ——
      // 高 mult 时取整损失很小，而 frac 跨空闲保留会让回来后的第一次
      // 点击差一。
      const m = 0.5 ** (gap / WHEEL_DECAY_HALFLIFE_MS);
      const cap = Math.max(WHEEL_MODE_CAP, state.base * 2);
      const next = 1 + (state.mult - 1) * m + WHEEL_MODE_STEP * m;
      state.mult = Math.min(cap, next, state.mult + WHEEL_MODE_RAMP);
      return Math.floor(state.mult);
    }

    // ─── 触控板 / 高分辨率（原生，非滚轮模式）───
    // 紧凑的 40ms 突发窗口：小于 40ms 的事件拉高倍率，更慢的重置。
    // 触控板快速滑动以 <20ms 间隔送出 200+ 事件 → 顶到上限 6。
    // 触控板慢速轻扫以 40-400ms 间隔 → 每次都重置 → 每次 1 行。
    if (gap > WHEEL_ACCEL_WINDOW_MS) {
      state.mult = state.base;
    } else {
      const cap = Math.max(WHEEL_ACCEL_MAX, state.base * 2);
      state.mult = Math.min(cap, state.mult + WHEEL_ACCEL_STEP);
    }
    return Math.floor(state.mult);
  }

  // ─── VSCODE（xterm.js，浏览器滚轮事件）───
  // 浏览器滚轮事件 —— 没有编码器抖动，没有 SGR 突发。衰减曲线与
  // 原始调校保持一致。公式形状与上面的滚轮模式相同（保持同步），
  // 但 STEP=5 而非 15 —— 这里事件率更高。
  const gap = now - state.time;
  const sameDir = dir === state.dir;
  state.time = now;
  state.dir = dir;
  // xterm.js 路径。Debug 日志显示两种模式： 持续滚动时
  // 20-50ms 间隔（~30 Hz）， 快速滑动时 <5ms 的同批次突发。对
  // ，按 1 行/事件给 —— 突发计数本身就是加速，与原生相同。对
  // ，衰减曲线给 3-5 行。对稀疏事件（100ms+，慢的刻意滚动），
  // 曲线给 1-3。
  if (sameDir && gap < WHEEL_BURST_MS) return 1;
  if (!sameDir || gap > WHEEL_DECAY_IDLE_MS) {
    // 方向反向或长时间空闲：从 2 开始（而不是 1），让暂停后的第一次
    // 点击有可见的位移。没有这一项，同方向上 空闲-再-继续 会衰减到
    // mult≈1（1 行）。
    state.mult = 2;
    state.frac = 0;
  } else {
    const m = 0.5 ** (gap / WHEEL_DECAY_HALFLIFE_MS);
    const cap = gap >= WHEEL_DECAY_GAP_MS ? WHEEL_DECAY_CAP_SLOW : WHEEL_DECAY_CAP_FAST;
    state.mult = Math.min(cap, 1 + (state.mult - 1) * m + WHEEL_DECAY_STEP * m);
  }
  const total = state.mult + state.frac;
  const rows = Math.floor(total);
  state.frac = total - rows;
  return rows;
}

/** 读取 CLAUDE_CODE_SCROLL_SPEED，默认 1，clamp 到 (0, 20]。
 *  某些终端会预放大滚轮事件（ghostty discrete=3，iTerm2 的
 *  "faster scroll"）—— 此时 base=1 是对的。另一些每档发 1 个事件 ——
 *  设置 CLAUDE_CODE_SCROLL_SPEED=3 以匹配 vim/nvim/opencode。我们
 *  无法检测当前是哪种终端，因此做成旋钮。从 initAndLogWheelAccel
 *  惰性调用，此时 globalSettings.env 已加载。 */
export function readScrollSpeedBase(): number {
  const raw = process.env.CLAUDE_CODE_SCROLL_SPEED;
  if (!raw) return 1;
  const n = parseFloat(raw);
  return Number.isNaN(n) || n <= 0 ? 1 : Math.min(n, 20);
}

/** 初始滚轮加速状态。xtermJs=true 选择衰减曲线。
 *  base 是原生路径的基准 行数/事件（默认 1）。 */
export function initWheelAccel(xtermJs = false, base = 1): WheelAccelState {
  return {
    time: 0,
    mult: base,
    dir: 0,
    xtermJs,
    frac: 0,
    base,
    pendingFlip: false,
    wheelMode: false,
    burstCount: 0,
  };
}

// 惰性初始化辅助。isXtermJs() 组合了 TERM_PROGRAM 环境变量检查 + 异步
// XTVERSION 探测 —— 探测在渲染时可能还没解析完，所以这里放在第一个
// 滚轮事件（启动后 >>50ms）时调用，那时已稳定。记录一次检测到的模式，
// 便于 --debug 用户验证 SSH 检测是否生效。渲染器也会调用
// isXtermJsHost()（在 render-node-to-output 中）来选择排放算法 ——
// 不需要传递状态。
function initAndLogWheelAccel(): WheelAccelState {
  const xtermJs = isXtermJs();
  const base = readScrollSpeedBase();
  logForDebugging(
    `wheel accel: ${xtermJs ? 'decay (xterm.js)' : 'window (native)'} · base=${base} · TERM_PROGRAM=${process.env.TERM_PROGRAM ?? 'unset'}`,
  );
  return initWheelAccel(xtermJs, base);
}

// 拖拽滚动：当拖到视口边缘外时，每隔 AUTOSCROLL_INTERVAL_MS 滚动这么
// 多行。模式 1002 的鼠标追踪只在单元格变化时触发，所以需要一个定时器
// 来在静止时继续滚动。
const AUTOSCROLL_LINES = 2;
const AUTOSCROLL_INTERVAL_MS = 50;
// 连续自动滚动 tick 的硬上限。如果释放事件丢失（鼠标在终端窗口外
// 释放 —— 某些模拟器不捕获指针并丢弃释放事件），isDragging 会一直
// 为 true，定时器会一直跑到某个滚动边界。上限限制损害范围；任何新的
// 拖拽动作事件都会通过 check()→start() 重置计数。
const AUTOSCROLL_MAX_TICKS = 200; // 50ms 下 10 秒

/**
 * 全屏布局下消息滚动框的键盘滚动导航。
 * PgUp/PgDn 按半屏滚动。鼠标滚轮按几行滚动。
 * 滚动会打破 sticky 模式；Ctrl+End 重新启用。滚轮向下滚到底部也会
 * 重新启用 sticky，让新内容自然跟随。
 */
export function ScrollKeybindingHandler({ scrollRef, isActive, onScroll, isModal = false }: Props): React.ReactNode {
  const selection = useSelection();
  const { addNotification } = useNotifications();
  // 在第一个滚轮事件时惰性初始化，这样 XTVERSION 探测（在 raw 模式
  // 启用时触发）到那时已解析完 —— 在 useRef() 中初始化会在 SSH 下
  // 探测回复到达之前就读取 getWheelBase()。
  const wheelAccel = useRef<WheelAccelState | null>(null);

  function showCopiedToast(text: string): void {
    // getClipboardPath 同步读取环境变量 —— 预测 setClipboard 的结果
    // （原生 pbcopy / tmux load-buffer / 原始 OSC 52），以便告诉用户
    // 粘贴是直接可用还是需要 prefix+]。
    const path = getClipboardPath();
    const n = text.length;
    let msg: string;
    switch (path) {
      case 'native':
        msg = `已复制 ${n} 个字符到剪贴板`;
        break;
      case 'tmux-buffer':
        msg = `已复制 ${n} 个字符到 tmux buffer · 用 prefix + ] 粘贴`;
        break;
      case 'osc52':
        msg = `已通过 OSC 52 发送 ${n} 个字符 · 如果粘贴失败请检查终端剪贴板设置`;
        break;
    }
    addNotification({
      key: 'selection-copied',
      text: msg,
      color: 'suggestion',
      priority: 'immediate',
      timeoutMs: path === 'native' ? 2000 : 4000,
    });
  }

  function copyAndToast(): void {
    const text = selection.copySelection();
    if (text) showCopiedToast(text);
  }

  // 平移选区以跟踪键盘翻页跳转。选区坐标是屏幕缓冲区本地的；一次
  // 让内容移动 N 行的 scrollTo 也必须把 anchor+focus 平移 N，让高亮
  // 保持在同一段文本上（原生终端行为：选区随内容移动，在视口边缘裁剪）。
  // 即将滚出视口的行在滚动前被捕获进 scrolledOffAbove/Below，这样
  // getSelectedText 仍能返回完整文本。滚轮滚动（通过 scrollBy 的
  // scroll:lineUp/Down）仍然清除 —— 它的异步 pendingScrollDelta 排放
  // 意味着实际增量无法同步获知（后续处理）。
  function translateSelectionForJump(s: ScrollBoxHandle, delta: number): void {
    const sel = selection.getState();
    if (!sel?.anchor || !sel.focus) return;
    const top = s.getViewportTop();
    const bottom = top + s.getViewportHeight() - 1;
    // 仅当选区位于 scrollbox 内容上时才平移。页脚/prompt/
    // StickyPromptHeader 中的选区位于静态文本上 —— 滚动不会移动
    // 它们下方的内容。与 ink.tsx 的 auto-follow 平移守卫相同
    // （commit 36a8d154）。
    if (sel.anchor.row < top || sel.anchor.row > bottom) return;
    // 跨边界：anchor 在 scrollbox，focus 在页脚/页头。镜像 ink.tsx 的
    // Flag-3 守卫 —— 不平移也不捕获，直接放过。静态端点钉住了选区；
    // 平移会把它瞬移进 scrollbox 内容。
    if (sel.focus.row < top || sel.focus.row > bottom) return;
    const max = Math.max(0, s.getScrollHeight() - s.getViewportHeight());
    const cur = s.getScrollTop() + s.getPendingDelta();
    // 边界 clamp 后的实际滚动距离。jumpBy 在 target >= max 时可能调用
    // scrollToBottom，但视图不能越过 max，所以选区平移在这里被限定。
    const actual = Math.max(0, Math.min(max, cur + delta)) - cur;
    if (actual === 0) return;
    if (actual > 0) {
      // 向下滚动：内容上移。顶部的行离开视口。
      // anchor+focus 平移 -actual，跟踪上移的内容。
      selection.captureScrolledRows(top, top + actual - 1, 'above');
      selection.shiftSelection(-actual, top, bottom);
    } else {
      // 向上滚动：内容下移。底部的行离开视口。
      const a = -actual;
      selection.captureScrolledRows(bottom - a + 1, bottom, 'below');
      selection.shiftSelection(a, top, bottom);
    }
  }

  useKeybindings(
    {
      'scroll:pageUp': () => {
        const s = scrollRef.current;
        if (!s) return;
        const d = -Math.max(1, Math.floor(s.getViewportHeight() / 2));
        translateSelectionForJump(s, d);
        const sticky = jumpBy(s, d);
        onScroll?.(sticky, s);
      },
      'scroll:pageDown': () => {
        const s = scrollRef.current;
        if (!s) return;
        const d = Math.max(1, Math.floor(s.getViewportHeight() / 2));
        translateSelectionForJump(s, d);
        const sticky = jumpBy(s, d);
        onScroll?.(sticky, s);
      },
      'scroll:lineUp': () => {
        // 滚轮：scrollBy 累加进 pendingScrollDelta，由渲染器异步排放。
        // captureScrolledRows 无法在行离开前读到它们（排放是非确定性的）。
        // 目前先清除。
        selection.clearSelection();
        const s = scrollRef.current;
        // 当 ScrollBox 内容能完全放下时返回 false（未消费）——
        // 滚动会是 no-op。让子组件的 handler 接管滚轮事件
        // （例如居中 Modal 内的 Settings Config 列表导航，那里分页切片
        // 总是能完全放下）。
        if (!s || s.getScrollHeight() <= s.getViewportHeight()) return false;
        wheelAccel.current ??= initAndLogWheelAccel();
        scrollUp(s, computeWheelStep(wheelAccel.current, -1, performance.now()));
        onScroll?.(false, s);
      },
      'scroll:lineDown': () => {
        selection.clearSelection();
        const s = scrollRef.current;
        if (!s || s.getScrollHeight() <= s.getViewportHeight()) return false;
        wheelAccel.current ??= initAndLogWheelAccel();
        const step = computeWheelStep(wheelAccel.current, 1, performance.now());
        const reachedBottom = scrollDown(s, step);
        onScroll?.(reachedBottom, s);
      },
      'scroll:top': () => {
        const s = scrollRef.current;
        if (!s) return;
        translateSelectionForJump(s, -(s.getScrollTop() + s.getPendingDelta()));
        s.scrollTo(0);
        onScroll?.(false, s);
      },
      'scroll:bottom': () => {
        const s = scrollRef.current;
        if (!s) return;
        const max = Math.max(0, s.getScrollHeight() - s.getViewportHeight());
        translateSelectionForJump(s, max - (s.getScrollTop() + s.getPendingDelta()));
        // scrollTo(max) 立即写入 scrollTop，让渲染阶段的 sticky 跟随
        // 计算出 followDelta=0。没有这一步，仅 scrollToBottom() 会留下
        // 过期的 scrollTop → followDelta=max-过期值 →
        // shiftSelectionForFollow 又把上面已经做过的平移再做一遍，
        // 产生 2 倍偏移。scrollToBottom() 然后重新启用 sticky。
        s.scrollTo(max);
        s.scrollToBottom();
        onScroll?.(true, s);
      },
      'selection:copy': copyAndToast,
    },
    { context: 'Scroll', isActive },
  );

  // scroll:halfPage*/fullPage* 没有默认按键绑定 —— ctrl+u/d/b/f
  // 在普通模式下都有真实归属（kill-line/exit/task:background/kill-agents）。
  // Transcript 模式通过下面的 isModal 原生 useInput 获取它们。这些
  // handler 只为自定义重绑定保留。
  useKeybindings(
    {
      'scroll:halfPageUp': () => {
        const s = scrollRef.current;
        if (!s) return;
        const d = -Math.max(1, Math.floor(s.getViewportHeight() / 2));
        translateSelectionForJump(s, d);
        const sticky = jumpBy(s, d);
        onScroll?.(sticky, s);
      },
      'scroll:halfPageDown': () => {
        const s = scrollRef.current;
        if (!s) return;
        const d = Math.max(1, Math.floor(s.getViewportHeight() / 2));
        translateSelectionForJump(s, d);
        const sticky = jumpBy(s, d);
        onScroll?.(sticky, s);
      },
      'scroll:fullPageUp': () => {
        const s = scrollRef.current;
        if (!s) return;
        const d = -Math.max(1, s.getViewportHeight());
        translateSelectionForJump(s, d);
        const sticky = jumpBy(s, d);
        onScroll?.(sticky, s);
      },
      'scroll:fullPageDown': () => {
        const s = scrollRef.current;
        if (!s) return;
        const d = Math.max(1, s.getViewportHeight());
        translateSelectionForJump(s, d);
        const sticky = jumpBy(s, d);
        onScroll?.(sticky, s);
      },
    },
    { context: 'Scroll', isActive },
  );

  // Modal pager 按键 —— 仅 transcript 模式。less/tmux copy-mode 血统：
  // ctrl+u/d（半页），ctrl+b/f（整页），g/G（顶/底）。Tom 的决议
  // （2026-03-15）："在 ctrl-o 模式下，ctrl-u、ctrl-d 等应该基本能用！"
  // —— transcript 就是 copy-mode 容器。
  //
  // 安全是因为冲突的 handler 在这里都不可达：
  //   ctrl+u → kill-line，ctrl+d → exit：PromptInput 未挂载
  //   ctrl+b → task:background：SessionBackgroundHint 未挂载
  //   ctrl+f → chat:killAgents 已移到 ctrl+x ctrl+k；无冲突
  //   g/G → 可打印字符：没有 prompt 吃掉它们，不需要 vim/sticky 门槛
  //
  // TODO(search)：`/`、n/N —— 在 Richard Kim 的 d94b07add4（分支
  // claude/jump-recent-message-CEPcq）上构建。getItemY 的 Yoga 遍历 +
  // computeOrigin + anchorY 已解决 scroll-to-index。jumpToPrevTurn 是
  // n/N 的模板。通过 OVERSCAN_ROWS=80 单次完成；两阶段方案试过并
  // 被放弃（❯ 振荡）。见团队记忆 scroll-copy-mode-design.md。
  useInput(
    (input, key, event) => {
      const s = scrollRef.current;
      if (!s) return;
      const sticky = applyModalPagerAction(s, modalPagerAction(input, key), d => translateSelectionForJump(s, d));
      if (sticky === null) return;
      onScroll?.(sticky, s);
      event.stopImmediatePropagation();
    },
    { isActive: isActive && isModal },
  );

  // Esc 清除选区；任何其他按键也会清除（与原生终端行为一致，选区在
  // 输入时消失）。
  // Ctrl+C 在存在选区时复制 —— 这在传统终端上是必要的，那里
  // ctrl+shift+c 发送的是同一个字节（\x03，shift 丢失），而 cmd+c 永远
  // 到不了 pty（终端拦截它用于 Edit > Copy）。
  // 通过原生 useInput 处理，以便我们能有条件地消费：Esc/Ctrl+C 只有
  // 在存在选区时才停止传播，否则仍可用于 cancel-request / 中断。其他
  // 按键从不停止传播 —— 观察到它们作为副作用清除选区。
  // selection:copy 键位绑定（ctrl+shift+c / cmd+c）在上面通过
  // useKeybindings 注册，并在到达这里之前消费自己的事件。
  useInput(
    (input, key, event) => {
      if (!selection.hasSelection()) return;
      if (key.escape) {
        selection.clearSelection();
        event.stopImmediatePropagation();
        return;
      }
      if (key.ctrl && !key.shift && !key.meta && input === 'c') {
        copyAndToast();
        event.stopImmediatePropagation();
        return;
      }
      const move = selectionFocusMoveForKey(key);
      if (move) {
        selection.moveFocus(move);
        event.stopImmediatePropagation();
        return;
      }
      if (shouldClearSelectionOnKey(key)) {
        selection.clearSelection();
      }
    },
    { isActive },
  );

  useDragToScroll(scrollRef, selection, isActive, onScroll);
  useCopyOnSelect(selection, isActive, showCopiedToast);
  useSelectionBgColor(selection);

  return null;
}

/**
 * 当用户把选区拖到 ScrollBox 顶部或底部边缘之外时自动滚动。anchor 被
 * 反向平移以保持在同一内容上（原来在视口第 N 行的内容，滚动 d 之后
 * 位于第 N±d 行）。focus 停在鼠标位置（边缘行）。
 *
 * 选区坐标是屏幕缓冲区本地的，所以当原始内容滚出时 anchor 被 clamp
 * 到视口边界。为了保留完整选区，即将滚出的行在每次滚动步进之前被
 * 捕获进 scrolledOffAbove/scrolledOffBelow，并由 getSelectedText 拼回。
 */
function useDragToScroll(
  scrollRef: RefObject<ScrollBoxHandle | null>,
  selection: ReturnType<typeof useSelection>,
  isActive: boolean,
  onScroll: Props['onScroll'],
): void {
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const dirRef = useRef<-1 | 0 | 1>(0); // -1 向上滚，+1 向下滚，0 空闲
  // 在 stop() 后保留 —— 只在拖拽结束时重置。语义见 check()。
  const lastScrolledDirRef = useRef<-1 | 0 | 1>(0);
  const ticksRef = useRef(0);
  // onScroll 每次渲染可能换身份（如果调用方没有 memoize）。通过 ref
  // 读取，这样 effect 不会在每次滚动引起的重渲染上重新订阅并杀掉
  // 定时器。
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;

  useEffect(() => {
    if (!isActive) return;

    function stop(): void {
      dirRef.current = 0;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }

    function tick(): void {
      const sel = selection.getState();
      const s = scrollRef.current;
      const dir = dirRef.current;
      // dir === 0 防御过期的 interval（start() 可能在立即 tick 已经在
      // 滚动边界调用 stop() 之后又设置了一个）。ticks 上限防御丢失的
      // 释放事件（鼠标在终端窗口外释放）导致 isDragging 卡在 true。
      if (!sel?.isDragging || !sel.focus || !s || dir === 0 || ++ticksRef.current > AUTOSCROLL_MAX_TICKS) {
        stop();
        return;
      }
      // scrollBy 累加进 pendingScrollDelta；屏幕缓冲区在下次渲染排放它
      // 之前不会更新。如果上一个 tick 的滚动还没排放，captureScrolledRows
      // 会读到过期内容（与上一个 tick 相同的行 → 在累加器里重复，并且
      // 真正滚出去的行丢失）。跳过本次 tick；50ms 间隔会在 Ink 的 16ms
      // 渲染赶上后重试。也防止 shiftAnchor 失步。
      if (s.getPendingDelta() !== 0) return;
      const top = s.getViewportTop();
      const bottom = top + s.getViewportHeight() - 1;
      // 把 anchor clamp 到 [top, bottom]。不是 [0, bottom]：ScrollBox
      // 第 0 行的 padding 行会在 getSelectedText 中于 scrolledOffAbove 和
      // 屏幕内容之间产生一行空白。padding 行高亮只是个小的视觉点缀；
      // 文本正确性优先。
      if (dir < 0) {
        if (s.getScrollTop() <= 0) {
          stop();
          return;
        }
        // 向上滚动：内容在视口中下移，所以 anchor 行 +N。
        // clamp 到实际滚动距离，让 anchor 在接近顶部边界时保持同步
        // （渲染器在排放时把 scrollTop clamp 到 0）。
        const actual = Math.min(AUTOSCROLL_LINES, s.getScrollTop());
        // 在 scrollBy 覆盖之前，捕获即将从底部滚出的行。
        // 只有选区内的行被捕获（captureScrolledRows 与选区边界取交集）。
        selection.captureScrolledRows(bottom - actual + 1, bottom, 'below');
        selection.shiftAnchor(actual, 0, bottom);
        s.scrollBy(-AUTOSCROLL_LINES);
      } else {
        const max = Math.max(0, s.getScrollHeight() - s.getViewportHeight());
        if (s.getScrollTop() >= max) {
          stop();
          return;
        }
        // 向下滚动：内容在视口中上移，所以 anchor 行 -N。
        // clamp 到实际滚动距离，让 anchor 在接近底部边界时保持同步
        // （渲染器在排放时把 scrollTop clamp 到 max）。
        const actual = Math.min(AUTOSCROLL_LINES, max - s.getScrollTop());
        // 捕获即将从顶部滚出的行。
        selection.captureScrolledRows(top, top + actual - 1, 'above');
        selection.shiftAnchor(-actual, top, bottom);
        s.scrollBy(AUTOSCROLL_LINES);
      }
      onScrollRef.current?.(false, s);
    }

    function start(dir: -1 | 1): void {
      // 在提前返回之前记录：check() 中的空累加器重置可能在穿越前
      // 阶段已经把它清零（累加器在 anchor 行进入捕获范围之前是空的）。
      // 每次调用都重新记录，这样损坏会被立即修复。
      lastScrolledDirRef.current = dir;
      if (dirRef.current === dir) return; // 已经在这个方向了
      stop();
      dirRef.current = dir;
      ticksRef.current = 0;
      tick();
      // tick() 可能已经撞到滚动边界并调用 stop()（dir 重置为 0）。只有
      // 我们还在走时才启动 interval —— 否则 interval 会以 dir === 0
      // 永远跑下去什么也不做。
      if (dirRef.current === dir) {
        timerRef.current = setInterval(tick, AUTOSCROLL_INTERVAL_MS);
      }
    }

    // 每次选区变化（开始/拖拽/结束/清除）时重新求值。当拖拽离开视口时
    // 驱动拖拽滚动自动滚动。早期版本在这里于拖拽开始时打破 sticky，以
    // 防止流式输出期间的选区漂移 —— ink.tsx 现在改为按跟随增量平移
    // 选区坐标（原生终端行为：视图继续滚动，高亮随文本上移）。保持
    // sticky 还避免了 useVirtualScroll 的 tail-walk → forward-walk 幽灵
    // 增长。
    function check(): void {
      const s = scrollRef.current;
      if (!s) {
        stop();
        return;
      }
      const top = s.getViewportTop();
      const bottom = top + s.getViewportHeight() - 1;
      const sel = selection.getState();
      // 传入最后一次滚动的方向（而不是 dirRef），这样在 shiftAnchor 把
      // anchor clamp 向第 0 行之后，anchor 守卫被绕过。使用
      // lastScrolledDirRef（在 stop() 后保留）让自动滚动能 在鼠标短暂
      // 进入视口后恢复。仅同方向 —— 鼠标从底部以下跳到顶部以上必须停止，
      // 因为在 scrolledOffAbove/Below 累加器持有前一方向行时反向会在
      // getSelectedText 中重复文本。在拖拽结束时或两个累加器都为空时
      // 重置：startSelection 会清空它们（selection.ts），所以丢失释放
      // 后（isDragging 卡 true，AUTOSCROLL_MAX_TICKS 存在的原因）的新
      // 拖拽仍会重置。安全：下面的 start() 在提前返回之前会重新记录
      // lastScrolledDirRef，所以这里滚动中途的重置会被立即撤销。
      if (!sel?.isDragging || (sel.scrolledOffAbove.length === 0 && sel.scrolledOffBelow.length === 0)) {
        lastScrolledDirRef.current = 0;
      }
      const dir = dragScrollDirection(sel, top, bottom, lastScrolledDirRef.current);
      if (dir === 0) {
        // 被阻止的反向：focus 跳到对侧边缘（窗口外拖拽返回、快速甩动）。
        // handleSelectionDrag 已经把 focus 移过 anchor，翻转了
        // selectionBounds —— 累加器现在成了孤儿（持有错误一侧的行）。
        // 清空它，让 getSelectedText 与可见高亮一致。
        if (lastScrolledDirRef.current !== 0 && sel?.focus) {
          const want = sel.focus.row < top ? -1 : sel.focus.row > bottom ? 1 : 0;
          if (want !== 0 && want !== lastScrolledDirRef.current) {
            sel.scrolledOffAbove = [];
            sel.scrolledOffBelow = [];
            sel.scrolledOffAboveSW = [];
            sel.scrolledOffBelowSW = [];
            lastScrolledDirRef.current = 0;
          }
        }
        stop();
      } else start(dir);
    }

    const unsubscribe = selection.subscribe(check);
    return () => {
      unsubscribe();
      stop();
      lastScrolledDirRef.current = 0;
    };
  }, [isActive, scrollRef, selection]);
}

/**
 * 相对 ScrollBox 视口计算拖拽选区的自动滚动方向。当未拖拽、缺
 * anchor/focus、或 anchor 在视口外时返回 0 —— 从输入区开始的多击或
 * 拖拽不能接管消息滚动（之前在向上滚动状态下于输入区双击会通过
 * shiftAnchor 损坏 anchor，并每 50ms 错误地滚动消息历史，直到释放）。
 *
 * alreadyScrollingDir 在自动滚动激活后绕过 anchor 在视口内的守卫
 * （shiftAnchor 合法地把 anchor clamp 向第 0 行，低于 `top`），但只
 * 允许同方向继续。如果 focus 跳到对侧边缘（下→上或上→下 —— 快速
 * 甩动或窗口外拖拽时可能发生，因为模式 1002 按单元格变化上报，而非
 * 每个单元格），返回 0 以停止 —— 在不清空 scrolledOffAbove/Below 的
 * 情况下反向会在它们滚回屏幕时重复已捕获的行。
 */
export function dragScrollDirection(
  sel: SelectionState | null,
  top: number,
  bottom: number,
  alreadyScrollingDir: -1 | 0 | 1 = 0,
): -1 | 0 | 1 {
  if (!sel?.isDragging || !sel.anchor || !sel.focus) return 0;
  const row = sel.focus.row;
  const want: -1 | 0 | 1 = row < top ? -1 : row > bottom ? 1 : 0;
  if (alreadyScrollingDir !== 0) {
    // 仅同方向。focus 在对侧，或回到视口内，停止滚动 —— 已捕获的行
    // 留在 scrolledOffAbove/Below 中但永远不会滚回屏幕，所以
    // getSelectedText 是正确的。
    return want === alreadyScrollingDir ? want : 0;
  }
  // anchor 必须在视口内我们才能接管这次拖拽。如果用户在输入框或
  // 页头开始选择，自动滚动消息历史会让人意外，并通过 shiftAnchor
  // 损坏 anchor。
  if (sel.anchor.row < top || sel.anchor.row > bottom) return 0;
  return want;
}

// 键盘翻页跳转：scrollTo() 直接写入 scrollTop 并清空 pendingScrollDelta
// —— 一帧，无排放。scrollBy() 累加进 pendingScrollDelta，由渲染器在
// 若干帧内排放（render-node-to-output.ts 的 drainProportional/
// drainAdaptive）—— 对滚轮平滑性是对的，但对用户期望 snap 的
// PgUp/ctrl+u 是错的。target 相对于 scrollTop+pendingDelta，这样
// 滚轮突发中途的跳转会落在滚轮正在前往的位置。
export function jumpBy(s: ScrollBoxHandle, delta: number): boolean {
  const max = Math.max(0, s.getScrollHeight() - s.getViewportHeight());
  const target = s.getScrollTop() + s.getPendingDelta() + delta;
  if (target >= max) {
    // 立即写入 scrollTop，让 follow-scroll 看到 followDelta=0。运行过
    // translateSelectionForJump 的调用方已经平移过；仅 scrollToBottom()
    // 会通过渲染阶段的 sticky 跟随再次平移。
    s.scrollTo(max);
    s.scrollToBottom();
    return true;
  }
  s.scrollTo(Math.max(0, target));
  return false;
}

// 滚轮向下越过 maxScroll 时重新启用 sticky，让在底部滚动自然重新钉住
// （与典型聊天应用行为一致）。返回最终的 sticky 状态供调用方传播。
function scrollDown(s: ScrollBoxHandle, amount: number): boolean {
  const max = Math.max(0, s.getScrollHeight() - s.getViewportHeight());
  // 包含 pendingDelta：scrollBy 累加进 pendingScrollDelta 但不更新
  // scrollTop，所以一批滚轮事件内 getScrollTop() 单独是过期的。没有
  // 这一项，滚到底部永远不会重新启用 sticky 滚动。
  const effectiveTop = s.getScrollTop() + s.getPendingDelta();
  if (effectiveTop + amount >= max) {
    s.scrollToBottom();
    return true;
  }
  s.scrollBy(amount);
  return false;
}

// 滚轮向上越过 scrollTop=0 时通过 scrollTo(0) clamp，清空
// pendingScrollDelta，这样激进的滚轮突发（如 MX Master 自由旋转）
// 不会累积无界的负增量。没有这个 clamp，useVirtualScroll 的
// [effLo, effHi] 跨度会增长到超过 MAX_MOUNTED_ITEMS 能覆盖的范围，
// 中间排放帧会在没有已挂载子元素的 scrollTop 上渲染 —— 空白视口。
export function scrollUp(s: ScrollBoxHandle, amount: number): void {
  // 包含 pendingDelta：scrollBy 累加但不更新 scrollTop，所以一批
  // 滚轮事件内 getScrollTop() 单独是过期的。
  const effectiveTop = s.getScrollTop() + s.getPendingDelta();
  if (effectiveTop - amount <= 0) {
    s.scrollTo(0);
    return;
  }
  s.scrollBy(-amount);
}

export type ModalPagerAction =
  | 'lineUp'
  | 'lineDown'
  | 'halfPageUp'
  | 'halfPageDown'
  | 'fullPageUp'
  | 'fullPageDown'
  | 'top'
  | 'bottom';

/**
 * 把按键映射为 modal pager 动作。为测试导出。
 * 对 modal pager 不处理的键返回 null（它们会穿透）。
 *
 * ctrl+u/d/b/f 是 less 血统的绑定。g/G 是裸字母（仅在没有挂载 prompt
 * 时安全）。G 在传统终端上以 input='G' shift=false 到达，或在 kitty
 * 协议终端上以 input='g' shift=true 到达。小写 g 需要 !shift 守卫，
 * 这样它不会也匹配 kitty 的 G。
 *
 * 按键重复：stdin 把按住的可打印字符合并成一个多字符字符串（如
 * 'ggg'）。只处理均一字符的批次 —— 像 'gG' 这样的混合输入不是按键
 * 重复。g/G 是幂等的绝对跳转，所以计数无关紧要（消费掉整个批次只是
 * 防止它泄漏到 printable 时清除选区的 handler）。
 */
export function modalPagerAction(
  input: string,
  key: Pick<Key, 'ctrl' | 'meta' | 'shift' | 'upArrow' | 'downArrow' | 'home' | 'end'>,
): ModalPagerAction | null {
  if (key.meta) return null;
  // 先处理特殊键 —— 方向键/home/end 到达时带的是空或垃圾 input，
  // 所以这些必须在任何 input 字符串逻辑之前检查。shift 保留给
  // 选区扩展（selectionFocusMoveForKey）；ctrl+home/end 已经有
  // useKeybindings 路由到 scroll:top/bottom。
  if (!key.ctrl && !key.shift) {
    if (key.upArrow) return 'lineUp';
    if (key.downArrow) return 'lineDown';
    if (key.home) return 'top';
    if (key.end) return 'bottom';
  }
  if (key.ctrl) {
    if (key.shift) return null;
    switch (input) {
      case 'u':
        return 'halfPageUp';
      case 'd':
        return 'halfPageDown';
      case 'b':
        return 'fullPageUp';
      case 'f':
        return 'fullPageDown';
      // emacs 风格的行滚动（less 同时接受 ctrl+n/p 和 ctrl+e/y）。
      // 在搜索导航期间也能用 —— 跳转后不必离开 modal 即可微调。
      // 这个 useInput 的 isActive 上没有 !searchOpen 门槛。
      case 'n':
        return 'lineDown';
      case 'p':
        return 'lineUp';
      default:
        return null;
    }
  }
  // 裸字母。按键重复批次：只对均一字符的批次生效。
  const c = input[0];
  if (!c || input !== c.repeat(input.length)) return null;
  // kitty 把 G 发为 input='g' shift=true；传统终端发为 'G' shift=false。
  // 在 shift 门槛之前检查，让两者都落到 'bottom'。
  if (c === 'G' || (c === 'g' && key.shift)) return 'bottom';
  if (key.shift) return null;
  switch (c) {
    case 'g':
      return 'top';
    // j/k 按 Tom 3 月 18 日的要求重新加回 —— 撤销了 3 月 16 日的移除。
    // 在搜索导航期间也能用（n/N 落地后微调），因为 isModal 与
    // searchOpen 无关。
    case 'j':
      return 'lineDown';
    case 'k':
      return 'lineUp';
    // less：space = 下翻一页，b = 上翻一页。ctrl+b 已在上面映射；
    // 裸 b 是 less 原生版本。
    case ' ':
      return 'fullPageDown';
    case 'b':
      return 'fullPageUp';
    default:
      return null;
  }
}

/**
 * 把一个 modal pager 动作应用到 ScrollBox。返回最终的 sticky 状态，
 * 如果动作为 null 则返回 null（无事可做 —— 调用方应穿透）。在滚动
 * 之前调用 onBeforeJump(delta)，让调用方可以按滚动增量平移文本选区
 * （捕获即将离场的行，平移 anchor+focus）而不是清除它。为测试导出。
 */
export function applyModalPagerAction(
  s: ScrollBoxHandle,
  act: ModalPagerAction | null,
  onBeforeJump: (delta: number) => void,
): boolean | null {
  switch (act) {
    case null:
      return null;
    case 'lineUp':
    case 'lineDown': {
      const d = act === 'lineDown' ? 1 : -1;
      onBeforeJump(d);
      return jumpBy(s, d);
    }
    case 'halfPageUp':
    case 'halfPageDown': {
      const half = Math.max(1, Math.floor(s.getViewportHeight() / 2));
      const d = act === 'halfPageDown' ? half : -half;
      onBeforeJump(d);
      return jumpBy(s, d);
    }
    case 'fullPageUp':
    case 'fullPageDown': {
      const page = Math.max(1, s.getViewportHeight());
      const d = act === 'fullPageDown' ? page : -page;
      onBeforeJump(d);
      return jumpBy(s, d);
    }
    case 'top':
      onBeforeJump(-(s.getScrollTop() + s.getPendingDelta()));
      s.scrollTo(0);
      return false;
    case 'bottom': {
      const max = Math.max(0, s.getScrollHeight() - s.getViewportHeight());
      onBeforeJump(max - (s.getScrollTop() + s.getPendingDelta()));
      // 在 scrollToBottom 之前立即写入 scrollTop —— 与 scroll:bottom 和
      // jumpBy 的 max 分支相同的双重平移修复。
      s.scrollTo(max);
      s.scrollToBottom();
      return true;
    }
  }
}
