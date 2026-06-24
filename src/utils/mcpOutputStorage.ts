import { writeFile } from 'fs/promises'
import { join } from 'path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { MCPResultType } from '../services/mcp/client.js'
import { toError } from './errors.js'
import { formatFileSize } from './format.js'
import { logError } from './log.js'
import { ensureToolResultsDir, getToolResultsDir } from './toolResultStorage.js'

/**
 * 根据 MCP 结果类型和 schema 生成格式描述字符串。
 */
export function getFormatDescription(
  type: MCPResultType,
  schema?: unknown,
): string {
  switch (type) {
    case 'toolResult':
      return 'Plain text'
    case 'structuredContent':
      return schema ? `JSON with schema: ${schema}` : 'JSON'
    case 'contentArray':
      return schema ? `JSON array with schema: ${schema}` : 'JSON array'
  }
}

/**
 * 生成指示 Claude 从已保存输出文件中读取的提示文本。
 *
 * @param rawOutputPath - 已保存输出文件的路径
 * @param contentLength - 内容的字符长度
 * @param formatDescription - 内容格式描述
 * @param maxReadLength - Read 工具的可选最大字符数（用于 Bash 输出上下文）
 * @returns 要包含在工具结果中的提示文本
 */
export function getLargeOutputInstructions(
  rawOutputPath: string,
  contentLength: number,
  formatDescription: string,
  maxReadLength?: number,
): string {
  const baseInstructions =
    `Error: result (${contentLength.toLocaleString()} characters) exceeds maximum allowed tokens. Output has been saved to ${rawOutputPath}.\n` +
    `Format: ${formatDescription}\n` +
    `Use offset and limit parameters to read specific portions of the file, search within it for specific content, and jq to make structured queries.\n` +
    `REQUIREMENTS FOR SUMMARIZATION/ANALYSIS/REVIEW:\n` +
    `- You MUST read the content from the file at ${rawOutputPath} in sequential chunks until 100% of the content has been read.\n`

  const truncationWarning = maxReadLength
    ? `- If you receive truncation warnings when reading the file ("[N lines truncated]"), reduce the chunk size until you have read 100% of the content without truncation ***DO NOT PROCEED UNTIL YOU HAVE DONE THIS***. Bash output is limited to ${maxReadLength.toLocaleString()} chars.\n`
    : `- If you receive truncation warnings when reading the file, reduce the chunk size until you have read 100% of the content without truncation.\n`

  const completionRequirement = `- Before producing ANY summary or analysis, you MUST explicitly describe what portion of the content you have read. ***If you did not read the entire content, you MUST explicitly state this.***\n`

  return baseInstructions + truncationWarning + completionRequirement
}

/**
 * 将 mime 类型映射到文件扩展名。保守策略：已知类型获得正确扩展名；
 * 未知类型获得 'bin'。扩展名很重要，因为 Read 工具会根据它进行分发
 *（PDF、图片等需要正确的扩展名）。
 */
export function extensionForMimeType(mimeType: string | undefined): string {
  if (!mimeType) return 'bin'
  // 去除 charset/boundary 参数
  const mt = (mimeType.split(';')[0] ?? '').trim().toLowerCase()
  switch (mt) {
    case 'application/pdf':
      return 'pdf'
    case 'application/json':
      return 'json'
    case 'text/csv':
      return 'csv'
    case 'text/plain':
      return 'txt'
    case 'text/html':
      return 'html'
    case 'text/markdown':
      return 'md'
    case 'application/zip':
      return 'zip'
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx'
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return 'xlsx'
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return 'pptx'
    case 'application/msword':
      return 'doc'
    case 'application/vnd.ms-excel':
      return 'xls'
    case 'audio/mpeg':
      return 'mp3'
    case 'audio/wav':
      return 'wav'
    case 'audio/ogg':
      return 'ogg'
    case 'video/mp4':
      return 'mp4'
    case 'video/webm':
      return 'webm'
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    case 'image/svg+xml':
      return 'svg'
    default:
      return 'bin'
  }
}

/**
 * 启发式判断 content-type 头是否表示应保存到磁盘而非放入模型上下文的二进制内容。
 * 类文本类型（text/*、json、xml、表单数据）被视为非二进制。
 */
export function isBinaryContentType(contentType: string): boolean {
  if (!contentType) return false
  const mt = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  if (mt.startsWith('text/')) return false
  // 以 application/ 类型传递的结构化文本格式。使用后缀或精确匹配
  // 而非子字符串，以使 'openxmlformats'（docx/xlsx）保持二进制。
  if (mt.endsWith('+json') || mt === 'application/json') return false
  if (mt.endsWith('+xml') || mt === 'application/xml') return false
  if (mt.startsWith('application/javascript')) return false
  if (mt === 'application/x-www-form-urlencoded') return false
  return true
}

export type PersistBinaryResult =
  | { filepath: string; size: number; ext: string }
  | { error: string }

/**
 * 将原始二进制字节以 mime 派生的扩展名写入 tool-results 目录。
 * 与 persistToolResult（会做字符串化）不同，此函数按原样写入字节，
 * 使生成的文件可用原生工具打开（PDF 用 Read，xlsx 用 pandas 等）。
 */
export async function persistBinaryContent(
  bytes: Buffer,
  mimeType: string | undefined,
  persistId: string,
): Promise<PersistBinaryResult> {
  await ensureToolResultsDir()
  const ext = extensionForMimeType(mimeType)
  const filepath = join(getToolResultsDir(), `${persistId}.${ext}`)

  try {
    await writeFile(filepath, bytes)
  } catch (error) {
    const err = toError(error)
    logError(err)
    return { error: err.message }
  }

  // mime 类型和扩展名是安全的固定词汇字符串（非路径/代码）
  logEvent('tengu_binary_content_persisted', {
    mimeType: (mimeType ??
      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    sizeBytes: bytes.length,
    ext: ext as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  return { filepath, size: bytes.length, ext }
}

/**
 * 构建简短消息告知 Claude 二进制内容已保存到何处。
 * 仅声明路径——不提供规定性提示，因为模型对文件的实际操作能力
 * 取决于 provider/工具链。
 */
export function getBinaryBlobSavedMessage(
  filepath: string,
  mimeType: string | undefined,
  size: number,
  sourceDescription: string,
): string {
  const mt = mimeType || 'unknown type'
  return `${sourceDescription}Binary content (${mt}, ${formatFileSize(size)}) saved to ${filepath}`
}
