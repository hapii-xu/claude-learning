import type { McpbManifestAny } from '@anthropic-ai/mcpb'
import { errorMessage } from '../errors.js'
import { jsonParse } from '../slowOperations.js'

/**
 * 从 JSON 对象解析并验证 DXT manifest。
 *
 * 延迟导入 @anthropic-ai/mcpb：该包使用 zod v3，每个 schema 实例
 * 急切创建 24 个 .bind(this) 闭包（schemas.js 和 schemas-loose.js
 * 之间约 300 个实例）。延迟导入可以使约 700KB 的绑定闭包远离
 * 启动堆，适用于从不接触 .dxt/.mcpb 的会话。
 */
export async function validateManifest(
  manifestJson: unknown,
): Promise<McpbManifestAny> {
  const { vAny } = await import('@anthropic-ai/mcpb')
  const parseResult = vAny.McpbManifestSchema.safeParse(manifestJson)

  if (!parseResult.success) {
    const errors = parseResult.error.flatten()
    const errorMessages = [
      ...Object.entries(errors.fieldErrors).map(
        ([field, errs]) =>
          `${field}: ${(errs as string[] | undefined)?.join(', ')}`,
      ),
      ...(errors.formErrors || []),
    ]
      .filter(Boolean)
      .join('; ')

    throw new Error(`无效的 manifest：${errorMessages}`)
  }

  return parseResult.data
}

/**
 * 从原始文本数据解析并验证 DXT manifest。
 */
export async function parseAndValidateManifestFromText(
  manifestText: string,
): Promise<McpbManifestAny> {
  let manifestJson: unknown

  try {
    manifestJson = jsonParse(manifestText)
  } catch (error) {
    throw new Error(`manifest.json 中的 JSON 无效：${errorMessage(error)}`)
  }

  return validateManifest(manifestJson)
}

/**
 * 从原始二进制数据解析并验证 DXT manifest。
 */
export async function parseAndValidateManifestFromBytes(
  manifestData: Uint8Array,
): Promise<McpbManifestAny> {
  const manifestText = new TextDecoder().decode(manifestData)
  return parseAndValidateManifestFromText(manifestText)
}

/**
 * 从作者名称和扩展名称生成扩展 ID。
 * 使用与目录后端相同的算法以保持一致性。
 */
export function generateExtensionId(
  manifest: McpbManifestAny,
  prefix?: 'local.unpacked' | 'local.dxt',
): string {
  const sanitize = (str: string) =>
    str
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-_.]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')

  const authorName = manifest.author.name
  const extensionName = manifest.name

  const sanitizedAuthor = sanitize(authorName)
  const sanitizedName = sanitize(extensionName)

  return prefix
    ? `${prefix}.${sanitizedAuthor}.${sanitizedName}`
    : `${sanitizedAuthor}.${sanitizedName}`
}
