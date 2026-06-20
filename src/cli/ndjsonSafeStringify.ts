import { jsonStringify } from '../utils/slowOperations.js'

// JSON.stringify 会原样输出 U+2028/U+2029（按 ECMA-404 规范是合法的）。当
// 输出是单行 NDJSON 时，任何使用 JavaScript 行终止符语义
//（ECMA-262 §11.3 — \n \r U+2028 U+2029）来切分流的接收方都会从字符串中间
// 切断 JSON。ProcessTransport 现在会静默跳过非 JSON 行而不是崩溃（gh-28405），
// 但被截断的片段仍然会丢失 — 消息会被静默丢弃。
//
// \uXXXX 形式是等价的 JSON（解析为相同的字符串），但
// 绝不会被视为行终止符。这正是 ES2019 的 "Subsume JSON" 提案以及
// Node 的 util.inspect 所采用的做法。
//
// 带分支的单个正则：回调对每次匹配做一次分发，
// 比两次全字符串扫描成本更低。
const JS_LINE_TERMINATORS = /\u2028|\u2029/g

function escapeJsLineTerminators(json: string): string {
  return json.replace(JS_LINE_TERMINATORS, c =>
    c === '\u2028' ? '\\u2028' : '\\u2029',
  )
}

/**
 * 用于每行一条消息的传输方式的 JSON.stringify。对 U+2028
 * LINE SEPARATOR 和 U+2029 PARAGRAPH SEPARATOR 进行转义，使序列化输出
 * 不会被按行切分的接收方破坏。输出仍是合法的 JSON，
 * 并解析为相同的值。
 */
export function ndjsonSafeStringify(value: unknown): string {
  return escapeJsLineTerminators(jsonStringify(value))
}
