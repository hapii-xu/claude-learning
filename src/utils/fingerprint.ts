import { createHash } from 'crypto'
import type { AssistantMessage, UserMessage } from '../types/message.js'

/**
 * 来自后端校验的硬编码 salt。
 * 必须完全匹配才能通过指纹校验。
 */
export const FINGERPRINT_SALT = '59cf53e54c78'

/**
 * 从第一条用户消息中提取文本内容。
 *
 * @param messages - 内部消息类型的数组
 * @returns 第一段文本内容，若未找到则返回空字符串
 */
export function extractFirstMessageText(
  messages: (UserMessage | AssistantMessage)[],
): string {
  const firstUserMessage = messages.find(msg => msg.type === 'user')
  if (!firstUserMessage) {
    return ''
  }

  const content = firstUserMessage.message.content

  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    const textBlock = content.find(block => block.type === 'text')
    if (textBlock && textBlock.type === 'text') {
      return textBlock.text
    }
  }

  return ''
}

/**
 * 计算 Claude Code 归属用的 3 字符指纹。
 * 算法：SHA256(SALT + msg[4] + msg[7] + msg[20] + version)[:3]
 * 重要：未经与 1P 和 3P（Bedrock、Vertex、Azure）API
 * 谨慎协调，请勿更改此方法。
 *
 * @param messageText - 第一条用户消息的文本内容
 * @param version - 版本字符串（来自 MACRO.VERSION）
 * @returns 3 字符十六进制指纹
 */
export function computeFingerprint(
  messageText: string,
  version: string,
): string {
  // 提取索引 [4, 7, 20] 处的字符，若索引不存在则使用 "0"
  const indices = [4, 7, 20]
  const chars = indices.map(i => messageText[i] || '0').join('')

  const fingerprintInput = `${FINGERPRINT_SALT}${chars}${version}`

  // SHA256 哈希，返回前 3 个十六进制字符
  const hash = createHash('sha256').update(fingerprintInput).digest('hex')
  return hash.slice(0, 3)
}

/**
 * 从第一条用户消息计算指纹。
 *
 * @param messages - 规范化消息的数组
 * @returns 3 字符十六进制指纹
 */
export function computeFingerprintFromMessages(
  messages: (UserMessage | AssistantMessage)[],
): string {
  const firstMessageText = extractFirstMessageText(messages)
  return computeFingerprint(firstMessageText, MACRO.VERSION)
}
