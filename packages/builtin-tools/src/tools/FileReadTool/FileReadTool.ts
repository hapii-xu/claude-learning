import type { Base64ImageSource } from '@anthropic-ai/sdk/resources/index.mjs'
import { readdir, readFile as readFileAsync } from 'fs/promises'
import * as path from 'path'
import { posix, win32 } from 'path'
import { z } from 'zod/v4'
import {
  PDF_AT_MENTION_INLINE_THRESHOLD,
  PDF_EXTRACT_SIZE_THRESHOLD,
  PDF_MAX_PAGES_PER_READ,
} from 'src/constants/apiLimits.js'
import { hasBinaryExtension } from 'src/constants/files.js'
import { memoryFreshnessNote } from 'src/memdir/memoryAge.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { logEvent } from 'src/services/analytics/index.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  getFileExtensionForAnalytics,
} from 'src/services/analytics/metadata.js'
import {
  countTokensWithAPI,
  roughTokenCountEstimationForFileType,
} from 'src/services/tokenEstimation.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from 'src/skills/loadSkillsDir.js'
import type { ToolUseContext } from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { getCwd } from 'src/utils/cwd.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from 'src/utils/envUtils.js'
import { getErrnoCode, isENOENT } from 'src/utils/errors.js'
import {
  addLineNumbers,
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  getFileModificationTimeAsync,
  suggestPathUnderCwd,
} from 'src/utils/file.js'
import { logFileOperation } from 'src/utils/fileOperationAnalytics.js'
import { formatFileSize } from 'src/utils/format.js'
import { getFsImplementation } from 'src/utils/fsOperations.js'
import {
  compressImageBufferWithTokenLimit,
  createImageMetadataText,
  detectImageFormatFromBuffer,
  type ImageDimensions,
  ImageResizeError,
  maybeResizeAndDownsampleImageBuffer,
} from 'src/utils/imageResizer.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { logError } from 'src/utils/log.js'
import { isAutoMemFile } from 'src/utils/memoryFileDetection.js'
import { createUserMessage } from 'src/utils/messages.js'
import {
  mapNotebookCellsToToolResult,
  readNotebook,
} from 'src/utils/notebook.js'
import { expandPath } from 'src/utils/path.js'
import { extractPDFPages, getPDFPageCount, readPDF } from 'src/utils/pdf.js'
import {
  isPDFExtension,
  isPDFSupported,
  parsePDFPageRange,
} from 'src/utils/pdfUtils.js'
import {
  checkReadPermissionForTool,
  matchingRuleForInput,
} from 'src/utils/permissions/filesystem.js'
import type { PermissionDecision } from 'src/utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from 'src/utils/permissions/shellRuleMatching.js'
import { readFileInRange } from 'src/utils/readFileInRange.js'
import { semanticNumber } from 'src/utils/semanticNumber.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { getDefaultFileReadingLimits } from './limits.js'
import {
  DESCRIPTION,
  FILE_READ_TOOL_NAME,
  FILE_UNCHANGED_STUB,
  LINE_FORMAT_INSTRUCTION,
  OFFSET_INSTRUCTION_DEFAULT,
  OFFSET_INSTRUCTION_TARGETED,
  renderPromptTemplate,
} from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseTag,
  userFacingName,
} from './UI.js'

// 会导致进程挂起的设备文件：无限输出或阻塞输入。
// 仅通过路径检查（无 I/O）。像 /dev/null 这类安全设备被故意排除。
const BLOCKED_DEVICE_PATHS = new Set([
  // 无限输出 —— 永远到不了 EOF
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/full',
  // 阻塞等待输入
  '/dev/stdin',
  '/dev/tty',
  '/dev/console',
  // 读取毫无意义
  '/dev/stdout',
  '/dev/stderr',
  // stdin/stdout/stderr 的 fd 别名
  '/dev/fd/0',
  '/dev/fd/1',
  '/dev/fd/2',
])

function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true
  // /proc/self/fd/0-2 和 /proc/<pid>/fd/0-2 是 stdio 在 Linux 上的别名
  if (
    filePath.startsWith('/proc/') &&
    (filePath.endsWith('/fd/0') ||
      filePath.endsWith('/fd/1') ||
      filePath.endsWith('/fd/2'))
  )
    return true
  return false
}

// 某些 macOS 版本在截图文件名中使用的窄不换行空格（U+202F）
const THIN_SPACE = String.fromCharCode(8239)

/**
 * 解析可能含有不同空格字符的 macOS 截图路径。
 * 根据不同的 macOS 版本，macOS 在截图文件名中的 AM/PM 之前
 * 使用普通空格或窄空格（U+202F）。当给定路径的文件不存在时，
 * 本函数会尝试使用另一种空格字符。
 *
 * @param filePath - 要解析的已规范化文件路径
 * @returns 磁盘上实际文件的路径（空格字符可能不同）
 */
/**
 * 对于带 AM/PM 的 macOS 截图路径，AM/PM 前的空格根据 macOS 版本
 * 可能是普通空格或窄空格。如果原路径不存在，返回要尝试的备用路径，
 * 否则返回 undefined。
 */
function getAlternateScreenshotPath(filePath: string): string | undefined {
  const filename = path.basename(filePath)
  const amPmPattern = /^(.+)([ \u202F])(AM|PM)(\.png)$/
  const match = filename.match(amPmPattern)
  if (!match) return undefined

  const currentSpace = match[2]
  const alternateSpace = currentSpace === ' ' ? THIN_SPACE : ' '
  return filePath.replace(
    `${currentSpace}${match[3]}${match[4]}`,
    `${alternateSpace}${match[3]}${match[4]}`,
  )
}

// 文件读取监听器 —— 允许其他服务在文件被读取时收到通知
type FileReadListener = (filePath: string, content: string) => void
const fileReadListeners: FileReadListener[] = []

export function registerFileReadListener(
  listener: FileReadListener,
): () => void {
  fileReadListeners.push(listener)
  return () => {
    const i = fileReadListeners.indexOf(listener)
    if (i >= 0) fileReadListeners.splice(i, 1)
  }
}

export class MaxFileReadTokenExceededError extends Error {
  constructor(
    public tokenCount: number,
    public maxTokens: number,
  ) {
    super(
      `文件内容（${tokenCount} tokens）超过了允许的最大 token 数（${maxTokens}）。请使用 offset 和 limit 参数读取文件的特定部分，或搜索特定内容而不是读取整个文件。`,
    )
    this.name = 'MaxFileReadTokenExceededError'
  }
}

// 常见图片扩展名
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

/**
 * 检测文件路径是否为用于 analytics 日志记录的会话相关文件。
 * 仅匹配 Claude 配置目录（例如 ~/.claude）内的文件。
 * 返回会话文件类型，如果不是会话文件则返回 null。
 */
function detectSessionFileType(
  filePath: string,
): 'session_memory' | 'session_transcript' | null {
  const configDir = getClaudeConfigHomeDir()

  // 仅匹配 Claude 配置目录内的文件
  if (!filePath.startsWith(configDir)) {
    return null
  }

  // 将路径规范化为使用正斜杠，以在不同平台上一致匹配
  const normalizedPath = filePath.split(win32.sep).join(posix.sep)

  // 会话内存文件：~/.claude/session-memory/*.md（包括 summary.md）
  if (
    normalizedPath.includes('/session-memory/') &&
    normalizedPath.endsWith('.md')
  ) {
    return 'session_memory'
  }

  // 会话 JSONL 转录文件：~/.claude/projects/*/*.jsonl
  if (
    normalizedPath.includes('/projects/') &&
    normalizedPath.endsWith('.jsonl')
  ) {
    return 'session_transcript'
  }

  return null
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe('要读取的文件的绝对路径'),
    offset: semanticNumber(z.number().int().nonnegative().optional()).describe(
      '开始读取的行号。仅当文件太大无法一次性读取时提供',
    ),
    limit: semanticNumber(z.number().int().positive().optional()).describe(
      '要读取的行数。仅当文件太大无法一次性读取时提供。',
    ),
    pages: z
      .string()
      .optional()
      .describe(
        `PDF 文件的页面范围（例如 "1-5"、"3"、"10-20"）。仅适用于 PDF 文件。每次请求最多 ${PDF_MAX_PAGES_PER_READ} 页。`,
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() => {
  // 定义图片支持的 media 类型
  const imageMediaTypes = z.enum([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
  ])

  return z.discriminatedUnion('type', [
    z.object({
      type: z.literal('text'),
      file: z.object({
        filePath: z.string().describe('被读取文件的路径'),
        content: z.string().describe('文件内容'),
        numLines: z.number().describe('返回内容中的行数'),
        startLine: z.number().describe('起始行号'),
        totalLines: z.number().describe('文件总行数'),
      }),
    }),
    z.object({
      type: z.literal('image'),
      file: z.object({
        base64: z.string().describe('Base64 编码的图片数据'),
        type: imageMediaTypes.describe('图片的 MIME 类型'),
        originalSize: z.number().describe('原始文件大小（字节）'),
        dimensions: z
          .object({
            originalWidth: z
              .number()
              .optional()
              .describe('原始图片宽度（像素）'),
            originalHeight: z
              .number()
              .optional()
              .describe('原始图片高度（像素）'),
            displayWidth: z
              .number()
              .optional()
              .describe('显示的图片宽度（像素，调整大小后）'),
            displayHeight: z
              .number()
              .optional()
              .describe('显示的图片高度（像素，调整大小后）'),
          })
          .optional()
          .describe('用于坐标映射的图片尺寸信息'),
      }),
    }),
    z.object({
      type: z.literal('notebook'),
      file: z.object({
        filePath: z.string().describe('notebook 文件的路径'),
        cells: z.array(z.any()).describe('notebook 单元格数组'),
      }),
    }),
    z.object({
      type: z.literal('pdf'),
      file: z.object({
        filePath: z.string().describe('PDF 文件的路径'),
        base64: z.string().describe('Base64 编码的 PDF 数据'),
        originalSize: z.number().describe('原始文件大小（字节）'),
      }),
    }),
    z.object({
      type: z.literal('parts'),
      file: z.object({
        filePath: z.string().describe('PDF 文件的路径'),
        originalSize: z.number().describe('原始文件大小（字节）'),
        count: z.number().describe('提取的页数'),
        outputDir: z.string().describe('包含提取出的页面图片的目录'),
      }),
    }),
    z.object({
      type: z.literal('file_unchanged'),
      file: z.object({
        filePath: z.string().describe('文件的路径'),
      }),
    }),
  ])
})
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const FileReadTool = buildTool({
  name: FILE_READ_TOOL_NAME,
  searchHint: '读取 文件 图片 PDF notebook',
  // 输出受 maxTokens 约束（validateContentTokens）。超过 100KB 的结果会
  // 持久化到磁盘（减轻长会话中的内存压力），而不是无限期保留在消息数组中。
  maxResultSizeChars: 100_000,
  strict: true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    const limits = getDefaultFileReadingLimits()
    const maxSizeInstruction = limits.includeMaxSizeInPrompt
      ? `. 大于 ${formatFileSize(limits.maxSizeBytes)} 的文件将返回错误；对更大的文件请使用 offset 和 limit`
      : ''
    const offsetInstruction = limits.targetedRangeNudge
      ? OFFSET_INSTRUCTION_TARGETED
      : OFFSET_INSTRUCTION_DEFAULT
    return renderPromptTemplate(
      pickLineFormatInstruction(),
      maxSizeInstruction,
      offsetInstruction,
    )
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `正在读取 ${summary}` : '正在读取文件'
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.file_path
  },
  isSearchOrReadCommand() {
    return { isSearch: false, isRead: true }
  },
  getPath({ file_path }): string {
    return file_path || getCwd()
  },
  backfillObservableInput(input) {
    // hooks.mdx 文档说明 file_path 必须是绝对路径；展开它以避免通过 ~ 或
    // 相对路径绕过 hook allowlist。
    if (typeof input.file_path === 'string') {
      input.file_path = expandPath(input.file_path)
    }
  },
  async preparePermissionMatcher({ file_path }) {
    return pattern => matchWildcardPattern(pattern, file_path)
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkReadPermissionForTool(
      FileReadTool,
      input,
      appState.toolPermissionContext,
    )
  },
  renderToolUseMessage,
  renderToolUseTag,
  renderToolResultMessage,
  // UI.tsx:140 —— 所有类型仅渲染摘要外框："Read N lines"、
  // "Read image (42KB)"，绝不渲染内容本身。面向模型的序列化（见下方）
  // 会发送内容 + 行前缀；UI 不会展示这些。
  extractSearchText() {
    return ''
  },
  renderToolUseErrorMessage,
  async validateInput({ file_path, pages }, toolUseContext: ToolUseContext) {
    // 校验 pages 参数（纯字符串解析，无 I/O）
    if (pages !== undefined) {
      const parsed = parsePDFPageRange(pages)
      if (!parsed) {
        return {
          result: false,
          message: `无效的 pages 参数："${pages}"。请使用诸如 "1-5"、"3" 或 "10-20" 的格式。页码从 1 开始。`,
          errorCode: 7,
        }
      }
      const rangeSize =
        parsed.lastPage === Infinity
          ? PDF_MAX_PAGES_PER_READ + 1
          : parsed.lastPage - parsed.firstPage + 1
      if (rangeSize > PDF_MAX_PAGES_PER_READ) {
        return {
          result: false,
          message: `页面范围 "${pages}" 超过了每次请求最多 ${PDF_MAX_PAGES_PER_READ} 页的限制。请使用更小的范围。`,
          errorCode: 8,
        }
      }
    }

    // 路径展开 + deny 规则检查（无 I/O）
    const fullFilePath = expandPath(file_path)

    const appState = toolUseContext.getAppState()
    const denyRule = matchingRuleForInput(
      fullFilePath,
      appState.toolPermissionContext,
      'read',
      'deny',
    )
    if (denyRule !== null) {
      return {
        result: false,
        message: '该文件位于被你的权限设置拒绝访问的目录中。',
        errorCode: 1,
      }
    }

    // 安全：UNC 路径检查（无 I/O）—— 在用户授予权限之前推迟文件系统操作，
    // 以防止 NTLM 凭据泄露
    const isUncPath =
      fullFilePath.startsWith('\\\\') || fullFilePath.startsWith('//')
    if (isUncPath) {
      return { result: true }
    }

    // 二进制扩展名检查（仅对扩展名做字符串检查，无 I/O）。
    // PDF、图片和 SVG 被排除 —— 本工具会原生渲染它们。
    const ext = path.extname(fullFilePath).toLowerCase()
    if (
      hasBinaryExtension(fullFilePath) &&
      !isPDFExtension(ext) &&
      !IMAGE_EXTENSIONS.has(ext.slice(1))
    ) {
      return {
        result: false,
        message: `本工具无法读取二进制文件。该文件似乎是二进制 ${ext} 文件。请使用合适的工具进行二进制文件分析。`,
        errorCode: 4,
      }
    }

    // 拦截会导致挂起的特定设备文件（无限输出或阻塞输入）。
    // 这是基于路径的检查，无 I/O —— 像 /dev/null 这类安全特殊文件是允许的。
    if (isBlockedDevicePath(fullFilePath)) {
      return {
        result: false,
        message: `无法读取 '${file_path}'：该设备文件会阻塞或产生无限输出。`,
        errorCode: 9,
      }
    }

    return { result: true }
  },
  async call(
    { file_path, offset = 1, limit = undefined, pages },
    context,
    _canUseTool?,
    parentMessage?,
  ) {
    const { readFileState, fileReadingLimits } = context

    const defaults = getDefaultFileReadingLimits()
    const maxSizeBytes =
      fileReadingLimits?.maxSizeBytes ?? defaults.maxSizeBytes
    const maxTokens = fileReadingLimits?.maxTokens ?? defaults.maxTokens

    // Telemetry: track when callers override default read limits.
    // Only fires on override (low volume) — event count = override frequency.
    if (fileReadingLimits !== undefined) {
      logEvent('tengu_file_read_limits_override', {
        hasMaxTokens: fileReadingLimits.maxTokens !== undefined,
        hasMaxSizeBytes: fileReadingLimits.maxSizeBytes !== undefined,
      })
    }

    const ext = path.extname(file_path).toLowerCase().slice(1)
    // 使用 expandPath 进行与 FileEditTool/FileWriteTool 一致的路径规范化
    // （尤其处理空白字符修剪和 Windows 路径分隔符）
    const fullFilePath = expandPath(file_path)

    // 去重：如果我们已经读取过这个精确范围且磁盘上的文件未变化，
    // 则返回一个占位消息而不是重新发送完整内容。之前的 Read tool_result
    // 仍在上下文中 —— 两份完整副本会在后续每个 turn 浪费 cache_creation
    // token。BQ 代理显示约 18% 的 Read 调用是同文件冲突（最高占全集群
    // cache_creation 的 2.64%）。仅适用于 text/notebook 读取 ——
    // images/PDFs 不在 readFileState 中缓存，所以不会命中。
    //
    // Ant soak：2 小时内 1,734 次去重命中，Read 错误无回归。
    // 熔断模式：如果占位消息在外部让模型产生混淆，GB 可禁用。
    // 3P 默认：熔断关闭 = 去重启用。仅客户端 —— 无需服务端支持，
    // 对 Bedrock/Vertex/Foundry 安全。
    const dedupKillswitch = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_read_dedup_killswitch',
      false,
    )
    const existingState = dedupKillswitch
      ? undefined
      : readFileState.get(fullFilePath)
    // 只对来自之前 Read 的条目去重（offset 总是由 Read 设置）。
    // Edit/Write 存储的 offset=undefined —— 它们的 readFileState 条目
    // 反映的是编辑后的 mtime，因此基于它去重会错误地把模型指向编辑前的
    // Read 内容。
    if (
      existingState &&
      !existingState.isPartialView &&
      existingState.offset !== undefined
    ) {
      const rangeMatch =
        existingState.offset === offset && existingState.limit === limit
      if (rangeMatch) {
        try {
          const mtimeMs = await getFileModificationTimeAsync(fullFilePath)
          if (mtimeMs === existingState.timestamp) {
            const analyticsExt = getFileExtensionForAnalytics(fullFilePath)
            logEvent('tengu_file_read_dedup', {
              ...(analyticsExt !== undefined && { ext: analyticsExt }),
            })
            return {
              data: {
                type: 'file_unchanged' as const,
                file: { filePath: file_path },
              },
            }
          }
        } catch {
          // stat 失败 —— 继续执行完整读取
        }
      }
    }

    // 从该文件路径发现 skills（fire-and-forget，非阻塞）
    // 在 simple 模式下跳过 —— 没有 skills 可用
    const cwd = getCwd()
    if (!isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
      const newSkillDirs = await discoverSkillDirsForPaths([fullFilePath], cwd)
      if (newSkillDirs.length > 0) {
        // 存储已发现的目录用于附件展示
        for (const dir of newSkillDirs) {
          context.dynamicSkillDirTriggers?.add(dir)
        }
        // 不要 await —— 让 skill 加载在后台进行
        addSkillDirectories(newSkillDirs).catch(() => {})
      }

      // 激活路径模式匹配该文件的条件 skills
      activateConditionalSkillsForPaths([fullFilePath], cwd)
    }

    try {
      return await callInner(
        file_path,
        fullFilePath,
        fullFilePath,
        ext,
        offset,
        limit,
        pages,
        maxSizeBytes,
        maxTokens,
        readFileState,
        context,
        parentMessage?.message.id,
      )
    } catch (error) {
      // 处理文件未找到的情况：建议相似文件
      const code = getErrnoCode(error)
      if (code === 'ENOENT') {
        // macOS 截图在 AM/PM 之前可能使用窄空格或普通空格 ——
        // 放弃之前先尝试另一种。
        const altPath = getAlternateScreenshotPath(fullFilePath)
        if (altPath) {
          try {
            return await callInner(
              file_path,
              fullFilePath,
              altPath,
              ext,
              offset,
              limit,
              pages,
              maxSizeBytes,
              maxTokens,
              readFileState,
              context,
              parentMessage?.message.id,
            )
          } catch (altError) {
            if (!isENOENT(altError)) {
              throw altError
            }
            // 备用路径也不存在 —— 继续走友好错误提示
          }
        }

        const similarFilename = findSimilarFile(fullFilePath)
        const cwdSuggestion = await suggestPathUnderCwd(fullFilePath)
        let message = `文件不存在。${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}。`
        if (cwdSuggestion) {
          message += ` 你指的是 ${cwdSuggestion} 吗？`
        } else if (similarFilename) {
          message += ` 你指的是 ${similarFilename} 吗？`
        }
        throw new Error(message)
      }
      throw error
    }
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    switch (data.type) {
      case 'image': {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                data: data.file.base64,
                media_type: data.file.type,
              },
            },
          ],
        }
      }
      case 'notebook':
        return mapNotebookCellsToToolResult(data.file.cells, toolUseID)
      case 'pdf':
        // 仅返回 PDF 元数据 —— 实际内容作为补充的 DocumentBlockParam 发送
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `已读取 PDF 文件：${data.file.filePath}（${formatFileSize(data.file.originalSize)}）`,
        }
      case 'parts':
        // 提取出的页面图片在 mapToolResultToAPIMessage 中读取并以图片块形式发送
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `已提取 PDF 页面：从 ${data.file.filePath} 提取 ${data.file.count} 页（${formatFileSize(data.file.originalSize)}）`,
        }
      case 'file_unchanged':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: FILE_UNCHANGED_STUB,
        }
      case 'text': {
        let content: string

        if (data.file.content) {
          content = memoryFileFreshnessPrefix(data) + formatFileLines(data.file)
        } else {
          // 确定合适的警告消息
          content =
            data.file.totalLines === 0
              ? '<system-reminder>警告：文件存在但内容为空。</system-reminder>'
              : `<system-reminder>警告：文件存在但比提供的 offset（${data.file.startLine}）更短。该文件有 ${data.file.totalLines} 行。</system-reminder>`
        }

        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content,
        }
      }
    }
  },
} satisfies ToolDef<InputSchema, Output>)

function pickLineFormatInstruction(): string {
  return LINE_FORMAT_INSTRUCTION
}

/** 为文件内容添加行号格式化。 */
function formatFileLines(file: { content: string; startLine: number }): string {
  return addLineNumbers(file)
}

/**
 * 从 call() 到 mapToolResultToToolResultBlockParam 的侧信道：auto-memory
 * 文件的 mtime，以 `data` 对象身份为键。避免在输出 schema（会流入 SDK
 * 类型）中加入仅用于展示的字段，也避免在 mapper 中执行同步 fs。
 * 当 data 对象在渲染后变得不可达时，WeakMap 会自动 GC。
 */
const memoryFileMtimes = new WeakMap<object, number>()

function memoryFileFreshnessPrefix(data: object): string {
  const mtimeMs = memoryFileMtimes.get(data)
  if (mtimeMs === undefined) return ''
  return memoryFreshnessNote(mtimeMs)
}

async function validateContentTokens(
  content: string,
  ext: string,
  maxTokens?: number,
): Promise<void> {
  const effectiveMaxTokens =
    maxTokens ?? getDefaultFileReadingLimits().maxTokens

  // 快速拒绝：如果原始字节数超过 token 上限的 4 倍，
  // 则没有任何编码能够装下（最坏情况约为 4 字节/token）。
  const byteLength = Buffer.byteLength(content)
  if (byteLength > effectiveMaxTokens * 4) {
    throw new MaxFileReadTokenExceededError(
      Math.ceil(byteLength / 4),
      effectiveMaxTokens,
    )
  }

  const tokenEstimate = roughTokenCountEstimationForFileType(content, ext)
  if (!tokenEstimate || tokenEstimate <= effectiveMaxTokens / 4) return

  const tokenCount = await countTokensWithAPI(content)
  const effectiveCount = tokenCount ?? tokenEstimate

  if (effectiveCount > effectiveMaxTokens) {
    throw new MaxFileReadTokenExceededError(effectiveCount, effectiveMaxTokens)
  }
}

type ImageResult = {
  type: 'image'
  file: {
    base64: string
    type: Base64ImageSource['media_type']
    originalSize: number
    dimensions?: ImageDimensions
  }
}

function createImageResponse(
  buffer: Buffer,
  mediaType: string,
  originalSize: number,
  dimensions?: ImageDimensions,
): ImageResult {
  return {
    type: 'image',
    file: {
      base64: buffer.toString('base64'),
      type: `image/${mediaType}` as Base64ImageSource['media_type'],
      originalSize,
      dimensions,
    },
  }
}

/**
 * call 的内部实现，独立出来以便在外层 call 中处理 ENOENT。
 */
async function callInner(
  file_path: string,
  fullFilePath: string,
  resolvedFilePath: string,
  ext: string,
  offset: number,
  limit: number | undefined,
  pages: string | undefined,
  maxSizeBytes: number,
  maxTokens: number,
  readFileState: ToolUseContext['readFileState'],
  context: ToolUseContext,
  messageId: string | undefined,
): Promise<{
  data: Output
  newMessages?: ReturnType<typeof createUserMessage>[]
}> {
  // --- Notebook ---
  if (ext === 'ipynb') {
    const cells = await readNotebook(resolvedFilePath)
    const cellsJson = jsonStringify(cells)

    const cellsJsonBytes = Buffer.byteLength(cellsJson)
    if (cellsJsonBytes > maxSizeBytes) {
      throw new Error(
        `Notebook 内容（${formatFileSize(cellsJsonBytes)}）超过了允许的最大大小（${formatFileSize(maxSizeBytes)}）。` +
          `请使用 ${BASH_TOOL_NAME} 配合 jq 读取特定部分：\n` +
          `  cat "${file_path}" | jq '.cells[:20]' # 前 20 个单元格\n` +
          `  cat "${file_path}" | jq '.cells[100:120]' # 单元格 100-120\n` +
          `  cat "${file_path}" | jq '.cells | length' # 统计单元格总数\n` +
          `  cat "${file_path}" | jq '.cells[] | select(.cell_type=="code") | .source' # 所有代码单元格的源码`,
      )
    }

    await validateContentTokens(cellsJson, ext, maxTokens)

    // 通过异步 stat 获取 mtime（单次调用，无需预先存在性检查）
    const stats = await getFsImplementation().stat(resolvedFilePath)
    readFileState.set(fullFilePath, {
      content: cellsJson,
      timestamp: Math.floor(stats.mtimeMs),
      offset,
      limit,
    })
    context.nestedMemoryAttachmentTriggers?.add(fullFilePath)

    const data = {
      type: 'notebook' as const,
      file: { filePath: file_path, cells },
    }

    logFileOperation({
      operation: 'read',
      tool: 'FileReadTool',
      filePath: fullFilePath,
      content: cellsJson,
    })

    return { data }
  }

  // --- Image（单次读取，不重复读） ---
  if (IMAGE_EXTENSIONS.has(ext)) {
    // 图片有自己的大小限制（token 预算 + 压缩）——
    // 不应用文本的 maxSizeBytes 上限。
    const data = await readImageWithTokenBudget(resolvedFilePath, maxTokens)
    context.nestedMemoryAttachmentTriggers?.add(fullFilePath)

    logFileOperation({
      operation: 'read',
      tool: 'FileReadTool',
      filePath: fullFilePath,
      content: data.file.base64,
    })

    const metadataText = data.file.dimensions
      ? createImageMetadataText(data.file.dimensions)
      : null

    return {
      data,
      ...(metadataText && {
        newMessages: [
          createUserMessage({ content: metadataText, isMeta: true }),
        ],
      }),
    }
  }

  // --- PDF ---
  if (isPDFExtension(ext)) {
    if (pages) {
      const parsedRange = parsePDFPageRange(pages)
      const extractResult = await extractPDFPages(
        resolvedFilePath,
        parsedRange ?? undefined,
      )
      if (!extractResult.success) {
        throw new Error((extractResult as any).error.message)
      }
      logEvent('tengu_pdf_page_extraction', {
        success: true,
        pageCount: (extractResult as any).data.file.count,
        fileSize: extractResult.data.file.originalSize,
        hasPageRange: true,
      })
      logFileOperation({
        operation: 'read',
        tool: 'FileReadTool',
        filePath: fullFilePath,
        content: `PDF pages ${pages}`,
      })
      const entries = await readdir(extractResult.data.file.outputDir)
      const imageFiles = entries.filter(f => f.endsWith('.jpg')).sort()
      const imageBlocks = await Promise.all(
        imageFiles.map(async f => {
          const imgPath = path.join(extractResult.data.file.outputDir, f)
          const imgBuffer = await readFileAsync(imgPath)
          const resized = await maybeResizeAndDownsampleImageBuffer(
            imgBuffer,
            imgBuffer.length,
            'jpeg',
          )
          return {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type:
                `image/${resized.mediaType}` as Base64ImageSource['media_type'],
              data: resized.buffer.toString('base64'),
            },
          }
        }),
      )
      return {
        data: extractResult.data,
        ...(imageBlocks.length > 0 && {
          newMessages: [
            createUserMessage({ content: imageBlocks, isMeta: true }),
          ],
        }),
      }
    }

    const pageCount = await getPDFPageCount(resolvedFilePath)
    if (pageCount !== null && pageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
      throw new Error(
        `此 PDF 有 ${pageCount} 页，数量太多无法一次性读取。` +
          `请使用 pages 参数读取特定页面范围（例如 pages: "1-5"）。` +
          `每次请求最多 ${PDF_MAX_PAGES_PER_READ} 页。`,
      )
    }

    const fs = getFsImplementation()
    const stats = await fs.stat(resolvedFilePath)
    const shouldExtractPages =
      !isPDFSupported() || stats.size > PDF_EXTRACT_SIZE_THRESHOLD

    if (shouldExtractPages) {
      const extractResult = await extractPDFPages(resolvedFilePath)
      if (extractResult.success) {
        logEvent('tengu_pdf_page_extraction', {
          success: true,
          pageCount: extractResult.data.file.count,
          fileSize: extractResult.data.file.originalSize,
        })
      } else {
        logEvent('tengu_pdf_page_extraction', {
          success: false,
          available: (extractResult as any).error.reason !== 'unavailable',
          fileSize: stats.size,
        })
      }
    }

    if (!isPDFSupported()) {
      throw new Error(
        '当前模型不支持读取完整 PDF。请使用更新的模型（Sonnet 3.5 v2 或更高版本），' +
          `或使用 pages 参数读取特定页面范围（例如 pages: "1-5"，每次请求最多 ${PDF_MAX_PAGES_PER_READ} 页）。` +
          '页面提取需要 poppler-utils：macOS 用 `brew install poppler` 安装，Debian/Ubuntu 用 `apt-get install poppler-utils` 安装。',
      )
    }

    const readResult = await readPDF(resolvedFilePath)
    if (!readResult.success) {
      throw new Error((readResult as any).error.message)
    }
    const pdfData = readResult.data
    logFileOperation({
      operation: 'read',
      tool: 'FileReadTool',
      filePath: fullFilePath,
      content: pdfData.file.base64,
    })

    return {
      data: pdfData,
      newMessages: [
        createUserMessage({
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdfData.file.base64,
              },
            },
          ],
          isMeta: true,
        }),
      ],
    }
  }

  // --- 文本文件（通过 readFileInRange 单次异步读取） ---
  const lineOffset = offset === 0 ? 0 : offset - 1
  const { content, lineCount, totalLines, totalBytes, readBytes, mtimeMs } =
    await readFileInRange(
      resolvedFilePath,
      lineOffset,
      limit,
      limit === undefined ? maxSizeBytes : undefined,
      context.abortController.signal,
    )

  await validateContentTokens(content, ext, maxTokens)

  readFileState.set(fullFilePath, {
    content,
    timestamp: Math.floor(mtimeMs),
    offset,
    limit,
  })
  context.nestedMemoryAttachmentTriggers?.add(fullFilePath)

  // 迭代前先做快照 —— 在回调中取消订阅的监听器会切断实时数组并跳过下一个监听器。
  for (const listener of fileReadListeners.slice()) {
    listener(resolvedFilePath, content)
  }

  const data = {
    type: 'text' as const,
    file: {
      filePath: file_path,
      content,
      numLines: lineCount,
      startLine: offset,
      totalLines,
    },
  }
  if (isAutoMemFile(fullFilePath)) {
    memoryFileMtimes.set(data, mtimeMs)
  }

  logFileOperation({
    operation: 'read',
    tool: 'FileReadTool',
    filePath: fullFilePath,
    content,
  })

  const sessionFileType = detectSessionFileType(fullFilePath)
  const analyticsExt = getFileExtensionForAnalytics(fullFilePath)
  logEvent('tengu_session_file_read', {
    totalLines,
    readLines: lineCount,
    totalBytes,
    readBytes,
    offset,
    ...(limit !== undefined && { limit }),
    ...(analyticsExt !== undefined && { ext: analyticsExt }),
    ...(messageId !== undefined && {
      messageID:
        messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    is_session_memory: sessionFileType === 'session_memory',
    is_session_transcript: sessionFileType === 'session_transcript',
  })

  return { data }
}

/**
 * 读取图片文件，并在需要时应用基于 token 的压缩。
 * 只读取文件一次，然后应用标准调整大小。如果结果超过 token 上限，
 * 则基于同一 buffer 应用激进的压缩。
 *
 * @param filePath - 图片文件路径
 * @param maxTokens - 图片的最大 token 预算
 * @returns 应用了适当压缩的图片数据
 */
export async function readImageWithTokenBudget(
  filePath: string,
  maxTokens: number = getDefaultFileReadingLimits().maxTokens,
  maxBytes?: number,
): Promise<ImageResult> {
  // 只读取文件一次 —— 上限为 maxBytes 以避免在超大文件上 OOM
  const imageBuffer = await getFsImplementation().readFileBytes(
    filePath,
    maxBytes,
  )
  const originalSize = imageBuffer.length

  if (originalSize === 0) {
    throw new Error(`图片文件为空：${filePath}`)
  }

  const detectedMediaType = detectImageFormatFromBuffer(imageBuffer)
  const detectedFormat = detectedMediaType.split('/')[1] || 'png'

  // 尝试标准调整大小
  let result: ImageResult
  try {
    const resized = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      originalSize,
      detectedFormat,
    )
    result = createImageResponse(
      resized.buffer,
      resized.mediaType,
      originalSize,
      resized.dimensions,
    )
  } catch (e) {
    if (e instanceof ImageResizeError) throw e
    logError(e)
    result = createImageResponse(imageBuffer, detectedFormat, originalSize)
  }

  // 检查是否在 token 预算内
  const estimatedTokens = Math.ceil(result.file.base64.length * 0.125)
  if (estimatedTokens > maxTokens) {
    // 基于同一 buffer 进行激进压缩（不重新读取）
    try {
      const compressed = await compressImageBufferWithTokenLimit(
        imageBuffer,
        maxTokens,
        detectedMediaType,
      )
      return {
        type: 'image',
        file: {
          base64: compressed.base64,
          type: compressed.mediaType,
          originalSize,
        },
      }
    } catch (e) {
      logError(e)
      // 兜底：基于同一 buffer 的高度压缩版本
      try {
        const sharpModule = await import('sharp')
        const sharp =
          (
            sharpModule as unknown as {
              default?: typeof sharpModule
            } & typeof sharpModule
          ).default || sharpModule

        const fallbackBuffer = await (sharp as any)(imageBuffer)
          .resize(400, 400, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: 20 })
          .toBuffer()

        return createImageResponse(fallbackBuffer, 'jpeg', originalSize)
      } catch (error) {
        logError(error)
        return createImageResponse(imageBuffer, detectedFormat, originalSize)
      }
    }
  }

  return result
}
