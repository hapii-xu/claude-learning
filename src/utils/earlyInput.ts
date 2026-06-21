/**
 * 早期输入捕获
 *
 * 本模块在 REPL 尚未完成初始化时，捕获用户在终端中提前键入的内容。
 * 用户往往在输入 `claude` 后就立刻开始输入提示词，但这些早期按键
 * 在启动过程中本会被丢弃。
 *
 * 用法：
 * 1. 在 cli.tsx 启动时尽早调用 startCapturingEarlyInput()
 * 2. REPL 就绪后，调用 consumeEarlyInput() 获取缓冲区中的文本
 * 3. stopCapturingEarlyInput() 会在输入被消费时自动调用
 */

import { lastGrapheme } from './intl.js'

// 早期输入字符缓冲区
let earlyInputBuffer = ''
// 是否正在捕获的标志
let isCapturing = false
// readable 事件处理函数引用，以便后续移除
let readableHandler: (() => void) | null = null
// 安全阀：超时后自动清理，防止 stdin.ref() 泄漏
let safetyTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 尽早开始捕获 stdin 数据，在 REPL 初始化之前。
 * 应在启动序列中尽早调用。
 *
 * 仅当 stdin 为 TTY（交互式终端）时才进行捕获。
 */
export function startCapturingEarlyInput(): void {
  // 仅在交互模式下捕获：stdin 必须是 TTY，且不能处于
  // print 模式。Raw 模式会禁用 ISIG（终端 Ctrl+C → SIGINT），
  // 这会导致 -p 模式无法被中断。
  if (
    !process.stdin.isTTY ||
    isCapturing ||
    process.argv.includes('-p') ||
    process.argv.includes('--print')
  ) {
    return
  }

  isCapturing = true
  earlyInputBuffer = ''

  // 将 stdin 设为 raw 模式，并使用 'readable' 事件（与 Ink 一致）
  // 这确保与 REPL 后续处理 stdin 的方式兼容
  try {
    process.stdin.setEncoding('utf8')
    process.stdin.setRawMode(true)
    process.stdin.ref()

    readableHandler = () => {
      let chunk = process.stdin.read()
      while (chunk !== null) {
        if (typeof chunk === 'string') {
          processChunk(chunk)
        }
        chunk = process.stdin.read()
      }
    }

    process.stdin.on('readable', readableHandler)

    // 安全阀：如果 Ink 在 10 秒内未接管（例如设置对话框
    // 卡住，或 Windows 上出错导致 Ink 无法挂载），
    // 则 unref stdin 以避免进程永久挂起。
    // REPL 的 Ink App 通常会在此之前调用
    // consumeEarlyInput() → stopCapturingEarlyInput()。
    safetyTimer = setTimeout(() => {
      if (isCapturing) {
        stopCapturingEarlyInput()
      }
    }, 10_000)
    // 不要让定时器本身保持事件循环活跃
    if (
      safetyTimer &&
      typeof safetyTimer === 'object' &&
      'unref' in safetyTimer
    ) {
      safetyTimer.unref()
    }
  } catch {
    // 如果无法设置 raw 模式，静默继续，不进行早期捕获
    isCapturing = false
  }
}

/**
 * 处理一块输入数据
 */
function processChunk(str: string): void {
  let i = 0
  while (i < str.length) {
    const char = str[i]!
    const code = char.charCodeAt(0)

    // Ctrl+C（code 3）- 停止捕获并立即退出。
    // 此处使用 process.exit 而非 gracefulShutdown，因为在启动的
    // 早期阶段，关闭机制尚未初始化。
    if (code === 3) {
      stopCapturingEarlyInput()
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(130) // Ctrl+C 的标准退出码
      return
    }

    // Ctrl+D（code 4）- EOF，停止捕获
    if (code === 4) {
      stopCapturingEarlyInput()
      return
    }

    // 退格键（code 127 或 8）- 删除最后一个字形簇
    if (code === 127 || code === 8) {
      if (earlyInputBuffer.length > 0) {
        const last = lastGrapheme(earlyInputBuffer)
        earlyInputBuffer = earlyInputBuffer.slice(0, -(last.length || 1))
      }
      i++
      continue
    }

    // 跳过转义序列（方向键、功能键、焦点事件等）
    // 所有转义序列以 ESC（0x1B）开头。
    if (code === 27) {
      i++ // 跳过 ESC 字符
      if (i >= str.length) continue

      const next = str.charCodeAt(i)!

      // CSI 序列：ESC [ ... <终止字节 0x40-0x7E>
      // 例如 \x1b[?64;1;2;4;6;17;18;21;22c（DA1 响应）
      if (next === 0x5b /* [ */) {
        i++ // 跳过 '['
        // 跳过参数字节（0x30-0x3F）和中间字节（0x20-0x2F）
        while (
          i < str.length &&
          str.charCodeAt(i)! >= 0x20 &&
          str.charCodeAt(i)! <= 0x3f
        ) {
          i++
        }
        // 跳过终止字节（0x40-0x7E）
        if (
          i < str.length &&
          str.charCodeAt(i)! >= 0x40 &&
          str.charCodeAt(i)! <= 0x7e
        )
          i++
        continue
      }

      // 字符串序列：DCS (P)、OSC (])、SOS (X)、PM (^)
      // 以 BEL (0x07) 或 ST (ESC \) 终止
      if (
        next === 0x50 /* P */ ||
        next === 0x5d /* ] */ ||
        next === 0x58 /* X */ ||
        next === 0x5e /* ^ */
      ) {
        i++ // 跳过引入符
        while (i < str.length) {
          if (str.charCodeAt(i) === 0x07) {
            i++
            break
          } // BEL 终止
          if (
            str.charCodeAt(i) === 0x1b &&
            i + 1 < str.length &&
            str.charCodeAt(i + 1)! === 0x5c
          ) {
            i += 2
            break // ESC \ (ST) 终止
          }
          i++
        }
        continue
      }

      // SS2 (N)、SS3 (O) — 2 字节序列，跳过两个字节
      // 其他简单转义序列：ESC <字节 0x40-0x7E> — 跳过一个字节
      if (i < str.length) i++
      continue
    }

    // 跳过其他控制字符（制表符和换行符除外）
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      i++
      continue
    }

    // 将回车符转换为换行符
    if (code === 13) {
      earlyInputBuffer += '\n'
      i++
      continue
    }

    // 将可打印字符和允许的控制字符加入缓冲区
    earlyInputBuffer += char
    i++
  }
}

/**
 * 停止捕获早期输入。
 * 在输入被消费时自动调用，也可手动调用。
 */
export function stopCapturingEarlyInput(): void {
  if (!isCapturing) {
    return
  }

  isCapturing = false

  // 清除安全定时器
  if (safetyTimer) {
    clearTimeout(safetyTimer)
    safetyTimer = null
  }

  if (readableHandler) {
    process.stdin.removeListener('readable', readableHandler)
    readableHandler = null
  }

  // 撤销 startCapturingEarlyInput 中的 ref()，防止 Ink 未接管时
  // 事件循环被保持（例如 Windows Node.js 不支持 raw 模式，
  // 或设置过程中出错）。Ink 的 handleSetRawMode(true) 会再次
  // 调用 stdin.ref()，其 handleSetRawMode(false) / 卸载路径会
  // 调用 stdin.unref()，因此即使 Ink 接管了，这里的 unref 也是
  // 安全的 —— 两次 ref/unref 调用相互抵消。
  try {
    process.stdin.unref()
  } catch {
    // stdin 可能已被销毁
  }

  // 不要在此重置 setRawMode —— Ink 的 App.handleSetRawMode(true)
  // 会同步调用 stopCapturingEarlyInput()，然后立即在同一 stdin 上
  // 调用 setRawMode(true) + ref()，如果在此处关闭它会在 Windows 上
  // 产生明显的闪烁。
}

/**
 * 消费已捕获的早期输入。
 * 返回捕获的输入并清空缓冲区。
 * 调用时会自动停止捕获。
 */
export function consumeEarlyInput(): string {
  stopCapturingEarlyInput()
  const input = earlyInputBuffer.trim()
  earlyInputBuffer = ''
  return input
}

/**
 * 检查是否有可用的早期输入（不消费）。
 */
export function hasEarlyInput(): boolean {
  return earlyInputBuffer.trim().length > 0
}

/**
 * 用文本预设早期输入缓冲区，REPL 渲染时这些文本将
 * 预填在提示输入框中。不会自动提交。
 */
export function seedEarlyInput(text: string): void {
  earlyInputBuffer = text
}

/**
 * 检查当前是否正在捕获早期输入。
 */
export function isCapturingEarlyInput(): boolean {
  return isCapturing
}
