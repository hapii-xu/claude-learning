import { createHash } from 'crypto'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/index.js'
import { logEvent } from 'src/services/analytics/index.js'

/**
 * 创建截断的 SHA256 哈希（16 字符）用于文件路径
 * 用于隐私保护的文件操作分析
 */
function hashFilePath(
  filePath: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return createHash('sha256')
    .update(filePath)
    .digest('hex')
    .slice(0, 16) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * 创建完整的 SHA256 哈希（64 字符）用于文件内容
 * 用于去重与变更检测分析
 */
function hashFileContent(
  content: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return createHash('sha256')
    .update(content)
    .digest('hex') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

// 要哈希的最大内容大小（100KB）
// 防止对大文件（如 base64 编码的图片）哈希时内存耗尽
const MAX_CONTENT_HASH_SIZE = 100 * 1024

/**
 * 将文件操作分析记录到 Statsig
 */
export function logFileOperation(params: {
  operation: 'read' | 'write' | 'edit'
  tool: 'FileReadTool' | 'FileWriteTool' | 'FileEditTool'
  filePath: string
  content?: string
  type?: 'create' | 'update'
}): void {
  const metadata: Record<
    string,
    | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    | number
    | boolean
  > = {
    operation:
      params.operation as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    tool: params.tool as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    filePathHash: hashFilePath(params.filePath),
  }

  // 仅在内容提供且小于大小限制时才哈希内容
  // 这防止了哈希大文件（如 base64 编码的图片）导致的内存耗尽
  if (
    params.content !== undefined &&
    params.content.length <= MAX_CONTENT_HASH_SIZE
  ) {
    metadata.contentHash = hashFileContent(params.content)
  }

  if (params.type !== undefined) {
    metadata.type =
      params.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  }

  logEvent('tengu_file_operation', metadata)
}
