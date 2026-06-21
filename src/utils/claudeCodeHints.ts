/**
 * Claude Code hints 协议。
 *
 * 在 Claude Code 下运行的 CLI 和 SDK 可以输出自闭合的
 * `<claude-code-hint />` 标签到 stderr（由 shell 工具合并到 stdout）。
 * 调度器（harness）扫描工具输出中的这些标签，在输出到达模型前剥离它们，
 * 并向用户展示安装提示 —— 无推理、无主动执行。
 *
 * 本文件既提供解析器，也提供一个小型的模块级 pending hint 存储。
 * 存储为单槽（非队列）—— 每个会话最多展示一次提示，因此无需累积。
 * React 通过 useSyncExternalStore 订阅。
 *
 * 面向供应商的规范见 docs/claude-code-hints.md。
 */

import { logForDebugging } from './debug.js'
import { createSignal } from './signal.js'

export type ClaudeCodeHintType = 'plugin'

export type ClaudeCodeHint = {
  /** 发送方声明的规范版本。未知版本会被丢弃。 */
  v: number
  /** Hint 判别器。v1 仅定义 `plugin`。 */
  type: ClaudeCodeHintType
  /**
   * Hint 载荷。对于 `type: 'plugin'`：一个 `name@marketplace` 形式的 slug，
   * 与 `parsePluginIdentifier` 接受的形式一致。
   */
  value: string
  /**
   * 产生此 hint 的 shell 命令的第一个 token。
   * 在安装提示中展示，便于用户识别发出 hint 的工具与推荐的插件是否匹配。
   */
  sourceCommand: string
}

/** 本调度器（harness）理解的规范版本集合。 */
const SUPPORTED_VERSIONS = new Set([1])

/** 本调度器在支持的版本下理解的 hint 类型集合。 */
const SUPPORTED_TYPES = new Set<string>(['plugin'])

/**
 * 外层标签匹配。锚定到整行（多行模式），因此嵌入在更大行中的
 * hint 标记（例如日志语句中引用该标签）会被忽略。
 * 行首尾的空白会被容忍，因为某些 SDK 会填充 stderr。
 */
const HINT_TAG_RE = /^[ \t]*<claude-code-hint\s+([^>]*?)\s*\/>[ \t]*$/gm

/**
 * 属性匹配器。接受 `key="value"` 和 `key=value`（以空白或 `/>` 闭合序列终止）。
 * 含空白或 `"` 的值必须使用引号形式。引号形式不支持转义序列；
 * 若将来需要，请提升规范版本。
 */
const ATTR_RE = /(\w+)=(?:"([^"]*)"|([^\s/>]+))/g

/**
 * 扫描 shell 工具输出中的 hint 标签，返回解析后的 hints
 * 并移除 hint 行的输出。剥离后的输出是模型可见的内容 ——
 * hints 是仅属于调度器（harness）的旁路通道。
 *
 * @param output - 原始命令输出（stdout 与 stderr 混合）。
 * @param command - 产生该输出的命令；其首个空白分隔的 token
 *   会被记录为 `sourceCommand`。
 */
export function extractClaudeCodeHints(
  output: string,
  command: string,
): { hints: ClaudeCodeHint[]; stripped: string } {
  // 快速路径：无标签起始序列 → 无需处理、无需分配。
  if (!output.includes('<claude-code-hint')) {
    return { hints: [], stripped: output }
  }

  const sourceCommand = firstCommandToken(command)
  const hints: ClaudeCodeHint[] = []

  const stripped = output.replace(HINT_TAG_RE, rawLine => {
    const attrs = parseAttrs(rawLine)
    const v = Number(attrs.v)
    const type = attrs.type
    const value = attrs.value

    if (!SUPPORTED_VERSIONS.has(v)) {
      logForDebugging(
        `[claudeCodeHints] dropped hint with unsupported v=${attrs.v}`,
      )
      return ''
    }
    if (!type || !SUPPORTED_TYPES.has(type)) {
      logForDebugging(
        `[claudeCodeHints] dropped hint with unsupported type=${type}`,
      )
      return ''
    }
    if (!value) {
      logForDebugging('[claudeCodeHints] dropped hint with empty value')
      return ''
    }

    hints.push({ v, type: type as ClaudeCodeHintType, value, sourceCommand })
    return ''
  })

  // 丢弃匹配行会留下空行（周围的换行符仍保留）。
  // 折叠 replace 引入的连续空行，避免模型可见的输出增加垂直空白。
  const collapsed =
    hints.length > 0 || stripped !== output
      ? stripped.replace(/\n{3,}/g, '\n\n')
      : stripped

  return { hints, stripped: collapsed }
}

function parseAttrs(tagBody: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const m of tagBody.matchAll(ATTR_RE)) {
    attrs[m[1]!] = m[2] ?? m[3] ?? ''
  }
  return attrs
}

function firstCommandToken(command: string): string {
  const trimmed = command.trim()
  const spaceIdx = trimmed.search(/\s/)
  return spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
}

// ============================================================================
// Pending-hint 存储（useSyncExternalStore 接口）
//
// 单槽：若槽已满则写入胜出（否则每次调用都发送 hint 的 CLI
// 会堆积）。对话框每个会话最多展示一次；之后 setPendingHint 变为空操作。
//
// 调用方应在写入前进行门控（已安装？已展示？已达上限？）——
// 参见 hintRecommendation.ts 中 plugin 类型的 maybeRecordPluginHint。
// 本模块保持插件无关，以便未来 hint 类型复用同一存储。
// ============================================================================

let pendingHint: ClaudeCodeHint | null = null
let shownThisSession = false
const pendingHintChanged = createSignal()
const notify = pendingHintChanged.emit

/** 原始存储写入。调用方应先进行门控（见模块注释）。 */
export function setPendingHint(hint: ClaudeCodeHint): void {
  if (shownThisSession) return
  pendingHint = hint
  notify()
}

/** 清空槽但不翻转会话标志 —— 用于被拒绝的 hints。 */
export function clearPendingHint(): void {
  if (pendingHint !== null) {
    pendingHint = null
    notify()
  }
}

/** 翻转每会话一次的标志。仅在对话框实际展示时调用。 */
export function markShownThisSession(): void {
  shownThisSession = true
}

export const subscribeToPendingHint = pendingHintChanged.subscribe

export function getPendingHintSnapshot(): ClaudeCodeHint | null {
  return pendingHint
}

export function hasShownHintThisSession(): boolean {
  return shownThisSession
}

/** 仅测试用重置。 */
export function _resetClaudeCodeHintStore(): void {
  pendingHint = null
  shownThisSession = false
}

export const _test = {
  parseAttrs,
  firstCommandToken,
}
