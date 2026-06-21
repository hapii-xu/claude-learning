import {
  type AnsiCode,
  type Char,
  ansiCodesToString,
  reduceAnsiCodes,
  tokenize,
  undoAnsiCodes,
} from '@alcalzone/ansi-tokenize'
import { stringWidth } from '@anthropic/ink'

// 如果 code 的 code 等于其 endCode（例如，超链接关闭），则该 code 是"结束 code"
function isEndCode(code: AnsiCode): boolean {
  return code.code === code.endCode
}

// 过滤以仅包含"开始 code"（非结束 code）
function filterStartCodes(codes: AnsiCode[]): AnsiCode[] {
  return codes.filter(c => !isEndCode(c))
}

/**
 * 切片包含 ANSI 转义码的字符串。
 *
 * 与 slice-ansi 包不同，此函数正确处理 OSC 8 超链接序列，
 * 因为 @alcalzone/ansi-tokenize 能正确解析它们。
 */
export default function sliceAnsi(
  str: string,
  start: number,
  end?: number,
): string {
  // 不要将 `end` 传递给 tokenize — 它计算的是码元而非显示单元格，
  // 所以对于带有零宽组合标记的文本，它会过早丢弃 token。
  const tokens = tokenize(str)
  let activeCodes: AnsiCode[] = []
  let position = 0
  let result = ''
  let include = false

  for (const token of tokens) {
    // 按显示宽度前进，而非码元。组合标记（天城文元音附标、
    //  virama、变音符号）宽度为 0 — 通过 .length 计算它们会
    // 使 position 过早超过 `end` 并截断切片。调用方以显示单元格
    // 传递 start/end（通过 stringWidth），所以 position 必须跟踪
    // 相同的单位。
    const width =
      token.type === 'ansi'
        ? 0
        : token.type === 'char'
          ? token.fullWidth
            ? 2
            : stringWidth(token.value)
          : 0

    // 在尾随零宽标记之后断开 — 组合标记附加到前面的基础字符，
    // 所以"भा"（भ + ा，1 个显示单元格）在 end=1 处切片时必须包含
    // ा。在零宽检查之前以 position >= end 断开丢弃它并渲染裸露的
    // भ。ANSI 码宽度为 0 但在 end 之后不得包含（它们开启新样式
    // 运行并泄漏到 undo 序列中），因此也要在字符类型上设置门控。
    // !include 守卫确保空切片（start===end）保持为空，即使字符串
    // 以零宽字符（BOM、ZWJ）开头。
    if (end !== undefined && position >= end) {
      if (token.type === 'ansi' || width > 0 || !include) break
    }

    if (token.type === 'ansi') {
      activeCodes.push(token)
      if (include) {
        // 在切片期间发射所有 ANSI 码
        result += token.code
      }
    } else {
      if (!include && position >= start) {
        // 在开始边界跳过前导零宽标记 — 它们属于左半部分中
        // 前面的基础字符。如果不这样做，标记会出现在两半中：
        // 左 + 右 ≠ 原始。仅当 start > 0 时适用（否则没有前面
        // 的字符拥有它）。
        if (start > 0 && width === 0) continue
        include = true
        // 约简并过滤以仅保留活动的开始码
        activeCodes = filterStartCodes(reduceAnsiCodes(activeCodes))
        result = ansiCodesToString(activeCodes)
      }

      if (include) {
        result += (token as Char).value
      }

      position += width
    }
  }

  // 仅 undo 仍然活动的开始码
  const activeStartCodes = filterStartCodes(reduceAnsiCodes(activeCodes))
  result += ansiCodesToString(undoAnsiCodes(activeStartCodes))
  return result
}
