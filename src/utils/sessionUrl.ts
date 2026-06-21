import { randomUUID, type UUID } from 'crypto'
import { validateUuid } from './uuid.js'

export type ParsedSessionUrl = {
  sessionId: UUID
  ingressUrl: string | null
  isUrl: boolean
  jsonlFile: string | null
  isJsonlFile: boolean
}

/**
 * 解析会话恢复标识符，可以是以下之一：
 * - 包含会话 ID 的 URL（例如，https://api.example.com/v1/session_ingress/session/550e8400-e29b-41d4-a716-446655440000）
 * - 纯会话 ID（UUID）
 *
 * @param resumeIdentifier - 要解析的 URL 或会话 ID
 * @returns 解析后的会话信息，无效时返回 null
 */
export function parseSessionIdentifier(
  resumeIdentifier: string,
): ParsedSessionUrl | null {
  // 在 URL 解析之前检查 JSONL 文件路径，因为 Windows 绝对路径
  //（例如，C:\path\file.jsonl）会被解析为以 C: 为协议的有效 URL
  if (resumeIdentifier.toLowerCase().endsWith('.jsonl')) {
    return {
      sessionId: randomUUID() as UUID,
      ingressUrl: null,
      isUrl: false,
      jsonlFile: resumeIdentifier,
      isJsonlFile: true,
    }
  }

  // 检查是否为纯 UUID
  if (validateUuid(resumeIdentifier)) {
    return {
      sessionId: resumeIdentifier as UUID,
      ingressUrl: null,
      isUrl: false,
      jsonlFile: null,
      isJsonlFile: false,
    }
  }

  // 检查是否为 URL
  try {
    const url = new URL(resumeIdentifier)

    // 使用整个 URL 作为入口 URL
    // 始终生成随机会话 ID
    return {
      sessionId: randomUUID() as UUID,
      ingressUrl: url.href,
      isUrl: true,
      jsonlFile: null,
      isJsonlFile: false,
    }
  } catch {
    // 不是有效 URL
  }

  return null
}
