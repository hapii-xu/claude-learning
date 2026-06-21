/**
 * Team Memory Sync 类型定义
 *
 * 用于仓库级 team memory 同步 API 的 Zod schema 和类型。
 * 基于后端 API 契约（anthropic/anthropic#250711）。
 */

import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

/**
 * team memory 数据的内容部分 —— 扁平的键值存储。
 * 键是相对于 team memory 目录的文件路径（例如 "MEMORY.md"、"patterns.md"）。
 * 值是 UTF-8 字符串内容（通常是 Markdown）。
 */
export const TeamMemoryContentSchema = lazySchema(() =>
  z.object({
    entries: z.record(z.string(), z.string()),
    // 每个 entry 内容的 SHA-256（`sha256:<hex>`）。在
    // anthropic/anthropic#283027 中添加。对于与旧版服务器部署的
    // 前向兼容是可选的；当 entries 为空时为空映射。
    entryChecksums: z.record(z.string(), z.string()).optional(),
  }),
)

/**
 * GET /api/claude_code/team_memory 的完整响应
 */
export const TeamMemoryDataSchema = lazySchema(() =>
  z.object({
    organizationId: z.string(),
    repo: z.string(),
    version: z.number(),
    lastModified: z.string(), // ISO 8601 时间戳
    checksum: z.string(), // 带 'sha256:' 前缀的 SHA256
    content: TeamMemoryContentSchema(),
  }),
)

/**
 * 来自服务器的结构化 413 错误体（anthropic/anthropic#293258）。
 * 服务器的 RequestTooLargeException 序列化 error_code 和
 * 展平到 error.details 中的 extra_details 字典。我们仅建模
 * 条目过多的情况；entry-too-large 通过客户端的
 * MAX_FILE_SIZE_BYTES 预检查处理，需要单独的 schema。
 */
export const TeamMemoryTooManyEntriesSchema = lazySchema(() =>
  z.object({
    error: z.object({
      details: z.object({
        error_code: z.literal('team_memory_too_many_entries'),
        max_entries: z.number().int().positive(),
        received_entries: z.number().int().positive(),
      }),
    }),
  }),
)

export type TeamMemoryData = z.infer<ReturnType<typeof TeamMemoryDataSchema>>

/**
 * 在推送过程中因包含检测到的密钥而被跳过的文件。
 * 路径相对于 team memory 目录。仅记录匹配的 gitleaks 规则 ID，
 * 绝不记录密钥值本身。
 */
export type SkippedSecretFile = {
  path: string
  /** Gitleaks 规则 ID（例如 "github-pat"、"aws-access-token"） */
  ruleId: string
  /** 从规则 ID 派生的人类可读标签 */
  label: string
}

/**
 * 获取 team memory 的结果
 */
export type TeamMemorySyncFetchResult = {
  success: boolean
  data?: TeamMemoryData
  isEmpty?: boolean // 如果 404（无数据存在）则为 true
  notModified?: boolean // 如果 304（ETag 匹配，无更改）则为 true
  checksum?: string // 来自响应头的 ETag
  error?: string
  skipRetry?: boolean
  errorType?: 'auth' | 'timeout' | 'network' | 'parse' | 'unknown'
  httpStatus?: number
}

/**
 * 轻量级仅元数据探测结果（GET ?view=hashes）。
 * 包含每个键的校验和但无 entry 主体。用于在 412 冲突解决期间
 * 低成本地刷新 serverChecksums。
 */
export type TeamMemoryHashesResult = {
  success: boolean
  version?: number
  checksum?: string
  entryChecksums?: Record<string, string>
  error?: string
  errorType?: 'auth' | 'timeout' | 'network' | 'parse' | 'unknown'
  httpStatus?: number
}

/**
 * 上传 team memory 的结果（含冲突信息）
 */
export type TeamMemorySyncPushResult = {
  success: boolean
  filesUploaded: number
  checksum?: string
  conflict?: boolean // 如果 412 Precondition Failed 则为 true
  error?: string
  /** 因包含检测到的密钥而被跳过的文件（PSR M22174）。 */
  skippedSecrets?: SkippedSecretFile[]
  errorType?:
    | 'auth'
    | 'timeout'
    | 'network'
    | 'conflict'
    | 'unknown'
    | 'no_oauth'
    | 'no_repo'
  httpStatus?: number
}

/**
 * 上传 team memory 的结果
 */
export type TeamMemorySyncUploadResult = {
  success: boolean
  checksum?: string
  lastModified?: string
  conflict?: boolean // 如果 412 Precondition Failed 则为 true
  error?: string
  errorType?: 'auth' | 'timeout' | 'network' | 'unknown'
  httpStatus?: number
  /**
   * 从解析的 413 体中获取的结构化 error_code（anthropic/anthropic#293258）。
   * 目前仅建模 'team_memory_too_many_entries'；如果服务器
   * 添加更多（entry_too_large、total_bytes_exceeded），它们会扩展此
   * 联合类型。直接透传给 tengu_team_mem_sync_push 事件，
   * 作为可被 Datadog 过滤的 facet。
   */
  serverErrorCode?: 'team_memory_too_many_entries'
  /**
   * 服务器强制执行的 max_entries，当 serverErrorCode 为
   * team_memory_too_many_entries 时填充。允许调用方缓存有效的
   * （可能是按组织的）限制，用于后续推送。
   */
  serverMaxEntries?: number
  /**
   * 被拒绝的推送在合并后会产生多少个条目。
   * 与 serverMaxEntries 一起填充。
   */
  serverReceivedEntries?: number
}
