import chalk from 'chalk'
import { supportsHyperlinks } from '@anthropic/ink'

// OSC 8 超链接转义序列
// 格式：\e]8;;URL\e\\TEXT\e]8;;\e\\
// 使用 \x07 (BEL) 作为终止符，因其支持更广泛
export const OSC8_START = '\x1b]8;;'
export const OSC8_END = '\x07'

type HyperlinkOptions = {
  supportsHyperlinks?: boolean
}

/**
 * 使用 OSC 8 转义序列创建可点击的超链接。
 * 若终端不支持超链接则回退为纯文本。
 *
 * @param url - 要链接到的 URL
 * @param content - 可选，显示为链接文本的内容（仅在支持超链接时）。
 *                  若提供且支持超链接，则此文本显示为可点击链接。
 *                  若不支持超链接，content 被忽略，仅显示 URL。
 * @param options - 可选，用于测试的覆盖项（supportsHyperlinks）
 */
export function createHyperlink(
  url: string,
  content?: string,
  options?: HyperlinkOptions,
): string {
  const hasSupport = options?.supportsHyperlinks ?? supportsHyperlinks()
  if (!hasSupport) {
    return url
  }

  // 应用基础 ANSI 蓝色 - wrap-ansi 会在换行时保留此颜色
  // RGB 颜色（如主题色）不会被 wrap-ansi 随 OSC 8 一起保留
  const displayText = content ?? url
  const coloredText = chalk.blue(displayText)
  return `${OSC8_START}${url}${OSC8_END}${coloredText}${OSC8_START}${OSC8_END}`
}
