import type {
  Base64ImageSource,
  ContentBlockParam,
  ImageBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import type { UUID } from 'crypto'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import { detectImageFormatFromBase64 } from '../utils/imageResizer.js'

/**
 * 处理 bridge 上的一条 inbound user 消息，抽出内容和 UUID 供入队使用。
 * 同时支持字符串内容和 ContentBlockParam[]（例如包含图片的消息）。
 *
 * 对 bridge 客户端可能用 camelCase `mediaType` 而不是 snake_case
 * `media_type` 的图片 block 做归一化（mobile-apps#5825）。
 *
 * 返回抽出的字段，需要跳过该消息（非 user 类型、内容缺失/为空）时
 * 返回 undefined。
 */
export function extractInboundMessageFields(
  msg: SDKMessage,
):
  | { content: string | Array<ContentBlockParam>; uuid: UUID | undefined }
  | undefined {
  if (msg.type !== 'user') return undefined
  const content = (
    msg.message as { content?: string | Array<ContentBlockParam> } | undefined
  )?.content
  if (!content) return undefined
  if (Array.isArray(content) && content.length === 0) return undefined

  const uuid =
    'uuid' in msg && typeof msg.uuid === 'string'
      ? (msg.uuid as UUID)
      : undefined

  return {
    content: Array.isArray(content) ? normalizeImageBlocks(content) : content,
    uuid,
  }
}

/**
 * 归一化 bridge 客户端发来的 image content block。iOS/web 客户端可能
 * 发 `mediaType`（驼峰）而非 `media_type`（下划线），也可能干脆省略。
 * 不归一化的话，坏 block 会毒化 session —— 之后每次 API 调用都会以
 * "media_type: Field required" 失败。
 *
 * 快速路径扫描：无需归一化时返回原数组引用（happy path 零分配）。
 */
export function normalizeImageBlocks(
  blocks: Array<ContentBlockParam>,
): Array<ContentBlockParam> {
  if (!blocks.some(isMalformedBase64Image)) return blocks

  return blocks.map(block => {
    if (!isMalformedBase64Image(block)) return block
    const src = block.source as unknown as Record<string, unknown>
    const mediaType =
      typeof src.mediaType === 'string' && src.mediaType
        ? src.mediaType
        : detectImageFormatFromBase64(block.source.data)
    return {
      ...block,
      source: {
        type: 'base64' as const,
        media_type: mediaType as Base64ImageSource['media_type'],
        data: block.source.data,
      },
    }
  })
}

function isMalformedBase64Image(
  block: ContentBlockParam,
): block is ImageBlockParam & { source: Base64ImageSource } {
  if (block.type !== 'image' || block.source?.type !== 'base64') return false
  return !(block.source as unknown as Record<string, unknown>).media_type
}
