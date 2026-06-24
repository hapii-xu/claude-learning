import { getPastedTextRefNumLines } from 'src/history.js'
import type { PastedContent } from 'src/utils/config.js'

const TRUNCATION_THRESHOLD = 10000 // 触发截断的字符数阈值
const PREVIEW_LENGTH = 1000 // 在开头和结尾分别显示的字符数

type TruncatedMessage = {
  truncatedText: string
  placeholderContent: string
}

/**
 * 判断输入文本是否需要截断。如果需要，则添加
 * 截断文本占位符并返回结果
 *
 * @param text 输入文本
 * @param nextPasteId 要使用的引用 ID
 * @returns 要显示的新文本，以及适用时的独立占位符内容。
 */
export function maybeTruncateMessageForInput(
  text: string,
  nextPasteId: number,
): TruncatedMessage {
  // 如果文本足够短，原样返回
  if (text.length <= TRUNCATION_THRESHOLD) {
    return {
      truncatedText: text,
      placeholderContent: '',
    }
  }

  // 计算从开头和结尾各保留多少字符
  const startLength = Math.floor(PREVIEW_LENGTH / 2)
  const endLength = Math.floor(PREVIEW_LENGTH / 2)

  // 提取要保留的部分
  const startText = text.slice(0, startLength)
  const endText = text.slice(-endLength)

  // 计算将被截断的行数
  const placeholderContent = text.slice(startLength, -endLength)
  const truncatedLines = getPastedTextRefNumLines(placeholderContent)

  // 创建类似粘贴文本的占位符引用
  const placeholderId = nextPasteId
  const placeholderRef = formatTruncatedTextRef(placeholderId, truncatedLines)

  // 将各部分与占位符组合
  const truncatedText = startText + placeholderRef + endText

  return {
    truncatedText,
    placeholderContent,
  }
}

function formatTruncatedTextRef(id: number, numLines: number): string {
  return `[...已截断文本 #${id}，共 +${numLines} 行...]`
}

export function maybeTruncateInput(
  input: string,
  pastedContents: Record<number, PastedContent>,
): { newInput: string; newPastedContents: Record<number, PastedContent> } {
  // 获取截断内容的下一个可用 ID
  const existingIds = Object.keys(pastedContents).map(Number)
  const nextPasteId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1

  // 应用截断
  const { truncatedText, placeholderContent } = maybeTruncateMessageForInput(
    input,
    nextPasteId,
  )

  if (!placeholderContent) {
    return { newInput: input, newPastedContents: pastedContents }
  }

  return {
    newInput: truncatedText,
    newPastedContents: {
      ...pastedContents,
      [nextPasteId]: {
        id: nextPasteId,
        type: 'text',
        content: placeholderContent,
      },
    },
  }
}
