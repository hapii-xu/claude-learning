/**
 * 将 ANSI 转义的终端文本转换为 SVG 格式
 * 支持基本的 ANSI 颜色代码（前景色）
 */

import { escapeXml } from './xml.js'

export type AnsiColor = {
  r: number
  g: number
  b: number
}

// 默认终端调色板（类似于大多数终端）
const ANSI_COLORS: Record<number, AnsiColor> = {
  30: { r: 0, g: 0, b: 0 }, // 黑色
  31: { r: 205, g: 49, b: 49 }, // 红色
  32: { r: 13, g: 188, b: 121 }, // 绿色
  33: { r: 229, g: 229, b: 16 }, // 黄色
  34: { r: 36, g: 114, b: 200 }, // 蓝色
  35: { r: 188, g: 63, b: 188 }, // 洋红色
  36: { r: 17, g: 168, b: 205 }, // 青色
  37: { r: 229, g: 229, b: 229 }, // 白色
  // 亮色
  90: { r: 102, g: 102, b: 102 }, // 亮黑色（灰色）
  91: { r: 241, g: 76, b: 76 }, // 亮红色
  92: { r: 35, g: 209, b: 139 }, // 亮绿色
  93: { r: 245, g: 245, b: 67 }, // 亮黄色
  94: { r: 59, g: 142, b: 234 }, // 亮蓝色
  95: { r: 214, g: 112, b: 214 }, // 亮洋红色
  96: { r: 41, g: 184, b: 219 }, // 亮青色
  97: { r: 255, g: 255, b: 255 }, // 亮白色
}

export const DEFAULT_FG: AnsiColor = { r: 229, g: 229, b: 229 } // 浅灰色
export const DEFAULT_BG: AnsiColor = { r: 30, g: 30, b: 30 } // 深灰色

export type TextSpan = {
  text: string
  color: AnsiColor
  bold: boolean
}

export type ParsedLine = TextSpan[]

/**
 * 从文本中解析 ANSI 转义序列
 * 支持：
 * - 基本颜色（30-37、90-97）
 * - 256 色模式（38;5;n）
 * - 24 位真彩色（38;2;r;g;b）
 */
export function parseAnsi(text: string): ParsedLine[] {
  const lines: ParsedLine[] = []
  const rawLines = text.split('\n')

  for (const line of rawLines) {
    const spans: TextSpan[] = []
    let currentColor = DEFAULT_FG
    let bold = false
    let i = 0

    while (i < line.length) {
      // 检查 ANSI 转义序列
      if (line[i] === '\x1b' && line[i + 1] === '[') {
        // 查找转义序列的结尾
        let j = i + 2
        while (j < line.length && !/[A-Za-z]/.test(line[j]!)) {
          j++
        }

        if (line[j] === 'm') {
          // 颜色/样式代码
          const codes = line
            .slice(i + 2, j)
            .split(';')
            .map(Number)

          let k = 0
          while (k < codes.length) {
            const code = codes[k]!
            if (code === 0) {
              // 重置
              currentColor = DEFAULT_FG
              bold = false
            } else if (code === 1) {
              bold = true
            } else if (code >= 30 && code <= 37) {
              currentColor = ANSI_COLORS[code] || DEFAULT_FG
            } else if (code >= 90 && code <= 97) {
              currentColor = ANSI_COLORS[code] || DEFAULT_FG
            } else if (code === 39) {
              currentColor = DEFAULT_FG
            } else if (code === 38) {
              // 扩展颜色 - 检查下一个代码
              if (codes[k + 1] === 5 && codes[k + 2] !== undefined) {
                // 256 色模式：38;5;n
                const colorIndex = codes[k + 2]!
                currentColor = get256Color(colorIndex)
                k += 2
              } else if (
                codes[k + 1] === 2 &&
                codes[k + 2] !== undefined &&
                codes[k + 3] !== undefined &&
                codes[k + 4] !== undefined
              ) {
                // 24 位真彩色：38;2;r;g;b
                currentColor = {
                  r: codes[k + 2]!,
                  g: codes[k + 3]!,
                  b: codes[k + 4]!,
                }
                k += 4
              }
            }
            k++
          }
        }

        i = j + 1
        continue
      }

      // 普通字符 - 查找相同样式文本的范围
      const textStart = i
      while (i < line.length && line[i] !== '\x1b') {
        i++
      }

      const spanText = line.slice(textStart, i)
      if (spanText) {
        spans.push({ text: spanText, color: currentColor, bold })
      }
    }

    // 如果行为空则添加空 span（以保留行）
    if (spans.length === 0) {
      spans.push({ text: '', color: DEFAULT_FG, bold: false })
    }

    lines.push(spans)
  }

  return lines
}

/**
 * 从 256 色调色板中获取颜色
 */
function get256Color(index: number): AnsiColor {
  // 标准颜色（0-15）
  if (index < 16) {
    const standardColors: AnsiColor[] = [
      { r: 0, g: 0, b: 0 }, // 0 黑色
      { r: 128, g: 0, b: 0 }, // 1 红色
      { r: 0, g: 128, b: 0 }, // 2 绿色
      { r: 128, g: 128, b: 0 }, // 3 黄色
      { r: 0, g: 0, b: 128 }, // 4 蓝色
      { r: 128, g: 0, b: 128 }, // 5 洋红色
      { r: 0, g: 128, b: 128 }, // 6 青色
      { r: 192, g: 192, b: 192 }, // 7 白色
      { r: 128, g: 128, b: 128 }, // 8 亮黑色
      { r: 255, g: 0, b: 0 }, // 9 亮红色
      { r: 0, g: 255, b: 0 }, // 10 亮绿色
      { r: 255, g: 255, b: 0 }, // 11 亮黄色
      { r: 0, g: 0, b: 255 }, // 12 亮蓝色
      { r: 255, g: 0, b: 255 }, // 13 亮洋红色
      { r: 0, g: 255, b: 255 }, // 14 亮青色
      { r: 255, g: 255, b: 255 }, // 15 亮白色
    ]
    return standardColors[index] || DEFAULT_FG
  }

  // 216 色立方体（16-231）
  if (index < 232) {
    const i = index - 16
    const r = Math.floor(i / 36)
    const g = Math.floor((i % 36) / 6)
    const b = i % 6
    return {
      r: r === 0 ? 0 : 55 + r * 40,
      g: g === 0 ? 0 : 55 + g * 40,
      b: b === 0 ? 0 : 55 + b * 40,
    }
  }

  // 灰度（232-255）
  const gray = (index - 232) * 10 + 8
  return { r: gray, g: gray, b: gray }
}

export type AnsiToSvgOptions = {
  fontFamily?: string
  fontSize?: number
  lineHeight?: number
  paddingX?: number
  paddingY?: number
  backgroundColor?: string
  borderRadius?: number
}

/**
 * 将 ANSI 文本转换为 SVG
 * 在每行内使用单个 <text> 中的 <tspan> 元素，以便渲染器
 * 原生处理字符间距（无需手动计算 charWidth）
 */
export function ansiToSvg(
  ansiText: string,
  options: AnsiToSvgOptions = {},
): string {
  const {
    fontFamily = 'Menlo, Monaco, monospace',
    fontSize = 14,
    lineHeight = 22,
    paddingX = 24,
    paddingY = 24,
    backgroundColor = `rgb(${DEFAULT_BG.r}, ${DEFAULT_BG.g}, ${DEFAULT_BG.b})`,
    borderRadius = 8,
  } = options

  const lines = parseAnsi(ansiText)

  // 去除尾随空行
  while (
    lines.length > 0 &&
    lines[lines.length - 1]!.every(span => span.text.trim() === '')
  ) {
    lines.pop()
  }

  // 基于最大行长估算宽度（仅用于 SVG 尺寸）
  // 对于等宽字体，字符宽度约为 0.6 * fontSize
  const charWidthEstimate = fontSize * 0.6
  const maxLineLength = Math.max(
    ...lines.map(spans => spans.reduce((acc, s) => acc + s.text.length, 0)),
  )
  const width = Math.ceil(maxLineLength * charWidthEstimate + paddingX * 2)
  const height = lines.length * lineHeight + paddingY * 2

  // 构建 SVG - 使用 tspan 元素以便渲染器处理字符定位
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n`
  svg += `  <rect width="100%" height="100%" fill="${backgroundColor}" rx="${borderRadius}" ry="${borderRadius}"/>\n`
  svg += `  <style>\n`
  svg += `    text { font-family: ${fontFamily}; font-size: ${fontSize}px; white-space: pre; }\n`
  svg += `    .b { font-weight: bold; }\n`
  svg += `  </style>\n`

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const spans = lines[lineIndex]!
    const y =
      paddingY + (lineIndex + 1) * lineHeight - (lineHeight - fontSize) / 2

    // 为每个彩色段构建一个带有 <tspan> 子元素的单个 <text> 元素
    // xml:space="preserve" 防止 SVG 折叠空白
    svg += `  <text x="${paddingX}" y="${y}" xml:space="preserve">`

    for (const span of spans) {
      if (!span.text) continue

      const colorStr = `rgb(${span.color.r}, ${span.color.g}, ${span.color.b})`
      const boldClass = span.bold ? ' class="b"' : ''

      svg += `<tspan fill="${colorStr}"${boldClass}>${escapeXml(span.text)}</tspan>`
    }

    svg += `</text>\n`
  }

  svg += `</svg>`

  return svg
}
