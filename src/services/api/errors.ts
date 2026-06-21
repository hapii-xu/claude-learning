import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from '@anthropic-ai/sdk'
import type {
  BetaMessage,
  BetaStopReason,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { AFK_MODE_BETA_HEADER } from 'src/constants/betas.js'
import type { SDKAssistantMessageError } from 'src/entrypoints/agentSdkTypes.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from 'src/types/message.js'
import {
  getAnthropicApiKeyWithSource,
  getClaudeAIOAuthTokens,
  getOauthAccountInfo,
  isClaudeAISubscriber,
} from 'src/utils/auth.js'
import {
  createAssistantAPIErrorMessage,
  NO_RESPONSE_REQUESTED,
} from 'src/utils/messages.js'
import {
  getDefaultMainLoopModelSetting,
  isNonCustomOpusModel,
} from 'src/utils/model/model.js'
import { getModelStrings } from 'src/utils/model/modelStrings.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import {
  API_PDF_MAX_PAGES,
  PDF_TARGET_RAW_SIZE,
} from '../../constants/apiLimits.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { formatFileSize } from '../../utils/format.js'
import { ImageResizeError } from '../../utils/imageResizer.js'
import { ImageSizeError } from '../../utils/imageValidation.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  type ClaudeAILimits,
  getRateLimitErrorMessage,
  type OverageDisabledReason,
} from '../claudeAiLimits.js'
import { shouldProcessRateLimits } from '../rateLimitMocking.js' // Used for /mock-limits command
import { extractConnectionErrorDetails, formatAPIError } from './errorUtils.js'

export const API_ERROR_MESSAGE_PREFIX = 'API Error'

export function startsWithApiErrorPrefix(text: string): boolean {
  return (
    text.startsWith(API_ERROR_MESSAGE_PREFIX) ||
    text.startsWith(`Please run /login · ${API_ERROR_MESSAGE_PREFIX}`)
  )
}
export const PROMPT_TOO_LONG_ERROR_MESSAGE = 'Prompt is too long'

export function isPromptTooLongMessage(msg: AssistantMessage): boolean {
  if (!msg.isApiErrorMessage) {
    return false
  }
  const content = msg.message!.content
  if (!Array.isArray(content)) {
    return false
  }
  return content.some(
    block =>
      block.type === 'text' &&
      block.text.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE),
  )
}

/**
 * 从原始的 prompt-too-long API 错误消息中解析实际/上限 token 数，
 * 例如 "prompt is too long: 137500 tokens > 135000 maximum"。
 * 原始字符串可能被包在 SDK 前缀或 JSON 信封里，或大小写不同（Vertex），
 * 因此这里故意放宽匹配。
 */
export function parsePromptTooLongTokenCounts(rawMessage: string): {
  actualTokens: number | undefined
  limitTokens: number | undefined
} {
  const match = rawMessage.match(
    /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i,
  )
  return {
    actualTokens: match ? parseInt(match[1]!, 10) : undefined,
    limitTokens: match ? parseInt(match[2]!, 10) : undefined,
  }
}

/**
 * 返回 prompt-too-long 错误中超额了多少 token，
 * 若消息不是 PTL 或其 errorDetails 无法解析则返回 undefined。
 * Reactive compact 使用这个差值在一次重试中跳过多个分组，
 * 而不是逐个剥离。
 */
export function getPromptTooLongTokenGap(
  msg: AssistantMessage,
): number | undefined {
  if (!isPromptTooLongMessage(msg) || !msg.errorDetails) {
    return undefined
  }
  const { actualTokens, limitTokens } = parsePromptTooLongTokenCounts(
    msg.errorDetails as string,
  )
  if (actualTokens === undefined || limitTokens === undefined) {
    return undefined
  }
  const gap = actualTokens - limitTokens
  return gap > 0 ? gap : undefined
}

/**
 * 这段原始 API 错误文本是否是 stripImagesFromMessages 可以修复的媒体尺寸拒绝？
 * Reactive compact 的 summarize 重试据此决定是剥离并重试（媒体错误），
 * 还是放弃（其他情况）。
 *
 * 这些模式必须与设置 errorDetails 的 getAssistantMessageFromError 分支
 * （约 L523 PDF、约 L560 image、约 L573 many-image）以及 classifyAPIError 的分支
 * （约 L929-946）保持同步。闭环：errorDetails 只在那些分支已经匹配过这些
 * 子串之后才被设置，所以对该路径而言 isMediaSizeError(errorDetails) 恒为真。
 * API 措辞漂移会导致优雅降级（errorDetails 保持 undefined，调用方短路），
 * 而不会出现漏报。
 */
export function isMediaSizeError(raw: string): boolean {
  return (
    (raw.includes('image exceeds') && raw.includes('maximum')) ||
    (raw.includes('image dimensions exceed') && raw.includes('many-image')) ||
    /maximum of \d+ PDF pages/.test(raw)
  )
}

/**
 * 消息级谓词：这条 assistant 消息是否是媒体尺寸拒绝？
 * 与 isPromptTooLongMessage 对应。检查 errorDetails（由
 * getAssistantMessageFromError 在 ~L523/560/573 的分支中填充的原始 API 错误字符串），
 * 而不是 content 文本，因为媒体错误有按变体不同的 content 字符串。
 */
export function isMediaSizeErrorMessage(msg: AssistantMessage): boolean {
  return (
    msg.isApiErrorMessage === true &&
    msg.errorDetails !== undefined &&
    isMediaSizeError(msg.errorDetails as string)
  )
}
export const CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE = 'Credit balance is too low'
export const INVALID_API_KEY_ERROR_MESSAGE = 'Not logged in · Please run /login'
export const INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL =
  'Invalid API key · Fix external API key'
export const ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH =
  'Your ANTHROPIC_API_KEY belongs to a disabled organization · Unset the environment variable to use your subscription instead'
export const ORG_DISABLED_ERROR_MESSAGE_ENV_KEY =
  'Your ANTHROPIC_API_KEY belongs to a disabled organization · Update or unset the environment variable'
export const TOKEN_REVOKED_ERROR_MESSAGE =
  'OAuth token revoked · Please run /login'
export const CCR_AUTH_ERROR_MESSAGE =
  'Authentication error · This may be a temporary network issue, please try again'
export const REPEATED_529_ERROR_MESSAGE = 'Repeated 529 Overloaded errors'
export const CUSTOM_OFF_SWITCH_MESSAGE =
  'Opus is experiencing high load, please use /model to switch to Sonnet'
export const API_TIMEOUT_ERROR_MESSAGE = 'Request timed out'
export function getPdfTooLargeErrorMessage(): string {
  const limits = `max ${API_PDF_MAX_PAGES} pages, ${formatFileSize(PDF_TARGET_RAW_SIZE)}`
  return getIsNonInteractiveSession()
    ? `PDF too large (${limits}). Try reading the file a different way (e.g., extract text with pdftotext).`
    : `PDF too large (${limits}). Double press esc to go back and try again, or use pdftotext to convert to text first.`
}
export function getPdfPasswordProtectedErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? 'PDF is password protected. Try using a CLI tool to extract or convert the PDF.'
    : 'PDF is password protected. Please double press esc to edit your message and try again.'
}
export function getPdfInvalidErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? 'The PDF file was not valid. Try converting it to text first (e.g., pdftotext).'
    : 'The PDF file was not valid. Double press esc to go back and try again with a different file.'
}
export function getImageTooLargeErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? 'Image was too large. Try resizing the image or using a different approach.'
    : 'Image was too large. Double press esc to go back and try again with a smaller image.'
}
export function getRequestTooLargeErrorMessage(): string {
  const limits = `max ${formatFileSize(PDF_TARGET_RAW_SIZE)}`
  return getIsNonInteractiveSession()
    ? `Request too large (${limits}). Try with a smaller file.`
    : `Request too large (${limits}). Double press esc to go back and try with a smaller file.`
}
export const OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE =
  'Your account does not have access to Claude Code. Please run /login.'

export function getTokenRevokedErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? 'Your account does not have access to Claude. Please login again or contact your administrator.'
    : TOKEN_REVOKED_ERROR_MESSAGE
}

export function getOauthOrgNotAllowedErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? 'Your organization does not have access to Claude. Please login again or contact your administrator.'
    : OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE
}

/**
 * 检查是否处于 CCR（Claude Code Remote）模式。
 * 在 CCR 模式下，认证由基础设施通过 JWT 提供，不通过 /login。
 * 瞬时认证错误应建议重试，而不是建议登录。
 */
function isCCRMode(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)
}

// 记录 tool_use/tool_result 不匹配错误的临时辅助函数
function logToolUseToolResultMismatch(
  toolUseId: string,
  messages: Message[],
  messagesForAPI: (UserMessage | AssistantMessage)[],
): void {
  try {
    // 在归一化消息中查找 tool_use
    let normalizedIndex = -1
    for (let i = 0; i < messagesForAPI.length; i++) {
      const msg = messagesForAPI[i]
      if (!msg) continue
      const content = msg.message!.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block.type === 'tool_use' &&
            'id' in block &&
            block.id === toolUseId
          ) {
            normalizedIndex = i
            break
          }
        }
      }
      if (normalizedIndex !== -1) break
    }

    // 在原始消息中查找 tool_use
    let originalIndex = -1
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (!msg) continue
      if (msg.type === 'assistant' && 'message' in msg) {
        const content = msg.message!.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block.type === 'tool_use' &&
              'id' in block &&
              block.id === toolUseId
            ) {
              originalIndex = i
              break
            }
          }
        }
      }
      if (originalIndex !== -1) break
    }

    // 构建归一化后的序列
    const normalizedSeq: string[] = []
    for (let i = normalizedIndex + 1; i < messagesForAPI.length; i++) {
      const msg = messagesForAPI[i]
      if (!msg) continue
      const content = msg.message!.content
      if (Array.isArray(content)) {
        for (const block of content) {
          const role = msg.message!.role
          if (block.type === 'tool_use' && 'id' in block) {
            normalizedSeq.push(`${role}:tool_use:${block.id}`)
          } else if (block.type === 'tool_result' && 'tool_use_id' in block) {
            normalizedSeq.push(`${role}:tool_result:${block.tool_use_id}`)
          } else if (block.type === 'text') {
            normalizedSeq.push(`${role}:text`)
          } else if (block.type === 'thinking') {
            normalizedSeq.push(`${role}:thinking`)
          } else if (block.type === 'image') {
            normalizedSeq.push(`${role}:image`)
          } else {
            normalizedSeq.push(`${role}:${block.type}`)
          }
        }
      } else if (typeof content === 'string') {
        normalizedSeq.push(`${msg.message.role}:string_content`)
      }
    }

    // 构建归一化前的序列
    const preNormalizedSeq: string[] = []
    for (let i = originalIndex + 1; i < messages.length; i++) {
      const msg = messages[i]
      if (!msg) continue

      switch (msg.type) {
        case 'user':
        case 'assistant': {
          if ('message' in msg) {
            const content = msg.message!.content
            if (Array.isArray(content)) {
              for (const block of content) {
                const role = msg.message!.role
                if (block.type === 'tool_use' && 'id' in block) {
                  preNormalizedSeq.push(`${role}:tool_use:${block.id}`)
                } else if (
                  block.type === 'tool_result' &&
                  'tool_use_id' in block
                ) {
                  preNormalizedSeq.push(
                    `${role}:tool_result:${block.tool_use_id}`,
                  )
                } else if (block.type === 'text') {
                  preNormalizedSeq.push(`${role}:text`)
                } else if (block.type === 'thinking') {
                  preNormalizedSeq.push(`${role}:thinking`)
                } else if (block.type === 'image') {
                  preNormalizedSeq.push(`${role}:image`)
                } else {
                  preNormalizedSeq.push(`${role}:${block.type}`)
                }
              }
            } else if (typeof content === 'string') {
              preNormalizedSeq.push(`${msg.message!.role}:string_content`)
            }
          }
          break
        }
        case 'attachment':
          if ('attachment' in msg) {
            preNormalizedSeq.push(`attachment:${msg.attachment!.type}`)
          }
          break
        case 'system':
          if ('subtype' in msg) {
            preNormalizedSeq.push(`system:${msg.subtype}`)
          }
          break
        case 'progress':
          if (
            'progress' in msg &&
            msg.progress &&
            typeof msg.progress === 'object' &&
            'type' in msg.progress
          ) {
            preNormalizedSeq.push(`progress:${msg.progress.type ?? 'unknown'}`)
          } else {
            preNormalizedSeq.push('progress:unknown')
          }
          break
      }
    }

    // 上报到 Statsig
    logEvent('tengu_tool_use_tool_result_mismatch_error', {
      toolUseId:
        toolUseId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      normalizedSequence: normalizedSeq.join(
        ', ',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      preNormalizedSequence: preNormalizedSeq.join(
        ', ',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      normalizedMessageCount: messagesForAPI.length,
      originalMessageCount: messages.length,
      normalizedToolUseIndex: normalizedIndex,
      originalToolUseIndex: originalIndex,
    })
  } catch (_) {
    // 忽略调试日志中的错误
  }
}

/**
 * 类型守卫：检查某个值是否是来自 API 的合法 Message 响应
 */
export function isValidAPIMessage(value: unknown): value is BetaMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    'model' in value &&
    'usage' in value &&
    Array.isArray((value as BetaMessage).content) &&
    typeof (value as BetaMessage).model === 'string' &&
    typeof (value as BetaMessage).usage === 'object'
  )
}

/** AWS 可能返回的低层错误。 */
type AmazonError = {
  Output?: {
    __type?: string
  }
  Version?: string
}

/**
 * 给定一个看起来不太对的响应，看看它是否包含我们能够提取的已知错误类型。
 */
export function extractUnknownErrorFormat(value: unknown): string | undefined {
  // 先检查 value 是否是合法对象
  if (!value || typeof value !== 'object') {
    return undefined
  }

  // Amazon Bedrock 路由错误
  if ((value as AmazonError).Output?.__type) {
    return (value as AmazonError).Output!.__type
  }

  return undefined
}

export function getAssistantMessageFromError(
  error: unknown,
  model: string,
  options?: {
    messages?: Message[]
    messagesForAPI?: (UserMessage | AssistantMessage)[]
  },
): AssistantMessage {
  // 检查是否是 SDK 超时错误
  if (
    error instanceof APIConnectionTimeoutError ||
    (error instanceof APIConnectionError &&
      error.message.toLowerCase().includes('timeout'))
  ) {
    return createAssistantAPIErrorMessage({
      content: API_TIMEOUT_ERROR_MESSAGE,
      error: 'unknown',
    })
  }

  // 检查图片尺寸/缩放错误（在 API 调用前的校验阶段抛出）
  // 对 CLI 用户使用 getImageTooLargeErrorMessage() 显示 "esc esc" 提示，
  // 对 SDK 用户（非交互模式）使用通用消息
  if (error instanceof ImageSizeError || error instanceof ImageResizeError) {
    return createAssistantAPIErrorMessage({
      content: getImageTooLargeErrorMessage(),
    })
  }

  // 检查针对 Opus PAYG 用户的应急容量关闭开关
  if (
    error instanceof Error &&
    error.message.includes(CUSTOM_OFF_SWITCH_MESSAGE)
  ) {
    return createAssistantAPIErrorMessage({
      content: CUSTOM_OFF_SWITCH_MESSAGE,
      error: 'rate_limit',
    })
  }

  if (
    error instanceof APIError &&
    error.status === 429 &&
    shouldProcessRateLimits(isClaudeAISubscriber())
  ) {
    // 检查是否是带多个 rate limit header 的新版 API
    const rateLimitType = error.headers?.get?.(
      'anthropic-ratelimit-unified-representative-claim',
    ) as 'five_hour' | 'seven_day' | 'seven_day_opus' | null

    const overageStatus = error.headers?.get?.(
      'anthropic-ratelimit-unified-overage-status',
    ) as 'allowed' | 'allowed_warning' | 'rejected' | null

    // 如果有新的 header，走新版消息生成
    if (rateLimitType || overageStatus) {
      // 从错误 header 构建 limits 对象以决定合适的消息
      const limits: ClaudeAILimits = {
        status: 'rejected',
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
      }

      // 从 header 中提取 rate limit 信息
      const resetHeader = error.headers?.get?.(
        'anthropic-ratelimit-unified-reset',
      )
      if (resetHeader) {
        limits.resetsAt = Number(resetHeader)
      }

      if (rateLimitType) {
        limits.rateLimitType = rateLimitType
      }

      if (overageStatus) {
        limits.overageStatus = overageStatus
      }

      const overageResetHeader = error.headers?.get?.(
        'anthropic-ratelimit-unified-overage-reset',
      )
      if (overageResetHeader) {
        limits.overageResetsAt = Number(overageResetHeader)
      }

      const overageDisabledReason = error.headers?.get?.(
        'anthropic-ratelimit-unified-overage-disabled-reason',
      ) as OverageDisabledReason | null
      if (overageDisabledReason) {
        limits.overageDisabledReason = overageDisabledReason
      }

      // 对所有新版 API rate limit 使用新的消息格式
      const specificErrorMessage = getRateLimitErrorMessage(limits, model)
      if (specificErrorMessage) {
        return createAssistantAPIErrorMessage({
          content: specificErrorMessage,
          error: 'rate_limit',
        })
      }

      // 如果 getRateLimitErrorMessage 返回 null，说明 fallback 机制会静默处理
      // （例如对符合资格的用户做 Opus -> Sonnet 降级）。
      // 返回 NO_RESPONSE_REQUESTED，这样用户不会看到错误，但该消息仍会记录在
      // 对话历史中以便 Claude 看到。
      return createAssistantAPIErrorMessage({
        content: NO_RESPONSE_REQUESTED,
        error: 'rate_limit',
      })
    }

    // 没有 quota header —— 这不是 quota 限制。直接透出 API 的实际消息，
    // 而不是通用的 "Rate limit reached"。Entitlement 拒绝
    // （例如 1M 上下文但未启用 Extra Usage）和基础设施容量 429 会落到这里。
    if (error.message.includes('Extra usage is required for long context')) {
      const hint = getIsNonInteractiveSession()
        ? 'enable extra usage at claude.ai/settings/usage, or use --model to switch to standard context'
        : 'run /extra-usage to enable, or /model to switch to standard context'
      return createAssistantAPIErrorMessage({
        content: `${API_ERROR_MESSAGE_PREFIX}: Extra usage is required for 1M context · ${hint}`,
        error: 'rate_limit',
      })
    }
    // SDK 的 APIError.makeMessage 在没有顶层 .message 时会在前面加 "429 "
    // 并把 body 做 JSON 序列化 —— 这里提取内部的 error.message。
    const stripped = error.message.replace(/^429\s+/, '')
    const innerMessage = stripped.match(/"message"\s*:\s*"([^"]*)"/)?.[1]
    const detail = innerMessage || stripped
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: Request rejected (429) · ${detail || 'this may be a temporary capacity issue — check status.anthropic.com'}`,
      error: 'rate_limit',
    })
  }

  // 处理 prompt too long 错误（Vertex 返回 413，直连 API 返回 400）
  // 使用大小写不敏感的检查，因为 Vertex 返回的是 "Prompt is too long"（首字母大写）
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('prompt is too long')
  ) {
    // content 保持通用（UI 按精确字符串匹配）。带 token 计数的原始错误
    // 放进 errorDetails —— reactive compact 的重试循环通过
    // getPromptTooLongTokenGap 从中解析超额量。
    return createAssistantAPIErrorMessage({
      content: PROMPT_TOO_LONG_ERROR_MESSAGE,
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  // 检查 PDF 页数上限错误
  if (
    error instanceof Error &&
    /maximum of \d+ PDF pages/.test(error.message)
  ) {
    return createAssistantAPIErrorMessage({
      content: getPdfTooLargeErrorMessage(),
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  // 检查 PDF 密码保护错误
  if (
    error instanceof Error &&
    error.message.includes('The PDF specified is password protected')
  ) {
    return createAssistantAPIErrorMessage({
      content: getPdfPasswordProtectedErrorMessage(),
      error: 'invalid_request',
    })
  }

  // 检查无效 PDF 错误（例如把 HTML 文件重命名为 .pdf）
  // 如果没有这个处理，无效的 PDF document 块会残留在对话上下文中，
  // 导致后续每次 API 调用都以 400 失败。
  if (
    error instanceof Error &&
    error.message.includes('The PDF specified was not valid')
  ) {
    return createAssistantAPIErrorMessage({
      content: getPdfInvalidErrorMessage(),
      error: 'invalid_request',
    })
  }

  // 检查图片尺寸错误（例如 "image exceeds 5 MB maximum: 5316852 bytes > 5242880 bytes"）
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('image exceeds') &&
    error.message.includes('maximum')
  ) {
    return createAssistantAPIErrorMessage({
      content: getImageTooLargeErrorMessage(),
      errorDetails: error.message,
    })
  }

  // 检查多图片尺寸错误（API 对多图片请求强制更严格的 2000px 上限）
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('image dimensions exceed') &&
    error.message.includes('many-image')
  ) {
    return createAssistantAPIErrorMessage({
      content: getIsNonInteractiveSession()
        ? 'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.'
        : 'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Run /compact to remove old images from context, or start a new session.',
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  // 服务端拒绝了 afk-mode beta header（套餐不包含 auto mode）。
  // 在未启用 TRANSCRIPT_CLASSIFIER 的构建中 AFK_MODE_BETA_HEADER 为 ''，
  // 此处的 truthy 守卫让其保持无效。
  if (
    AFK_MODE_BETA_HEADER &&
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes(AFK_MODE_BETA_HEADER) &&
    error.message.includes('anthropic-beta')
  ) {
    return createAssistantAPIErrorMessage({
      content: 'Auto mode is unavailable for your plan',
      error: 'invalid_request',
    })
  }

  // 检查 request too large 错误（413 状态码）
  // 通常发生在一个大 PDF + 对话上下文超过 32MB API 上限时
  if (error instanceof APIError && error.status === 413) {
    return createAssistantAPIErrorMessage({
      content: getRequestTooLargeErrorMessage(),
      error: 'invalid_request',
    })
  }

  // 检查 tool_use/tool_result 并发错误
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes(
      '`tool_use` ids were found without `tool_result` blocks immediately after',
    )
  ) {
    // 若有消息上下文，则上报到 Statsig
    if (options?.messages && options?.messagesForAPI) {
      const toolUseIdMatch = error.message.match(/toolu_[a-zA-Z0-9]+/)
      const toolUseId = toolUseIdMatch ? toolUseIdMatch[0] : null
      if (toolUseId) {
        logToolUseToolResultMismatch(
          toolUseId,
          options.messages,
          options.messagesForAPI,
        )
      }
    }

    if (process.env.USER_TYPE === 'ant') {
      const baseMessage = `API Error: 400 ${error.message}\n\nRun /share and post the JSON file to ${MACRO.FEEDBACK_CHANNEL}.`
      const rewindInstruction = getIsNonInteractiveSession()
        ? ''
        : ' Then, use /rewind to recover the conversation.'
      return createAssistantAPIErrorMessage({
        content: baseMessage + rewindInstruction,
        error: 'invalid_request',
      })
    } else {
      const baseMessage = 'API Error: 400 due to tool use concurrency issues.'
      const rewindInstruction = getIsNonInteractiveSession()
        ? ''
        : ' Run /rewind to recover the conversation.'
      return createAssistantAPIErrorMessage({
        content: baseMessage + rewindInstruction,
        error: 'invalid_request',
      })
    }
  }

  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('unexpected `tool_use_id` found in `tool_result`')
  ) {
    logEvent('tengu_unexpected_tool_result', {})
  }

  // 重复的 tool_use ID（CC-1212）。ensureToolResultPairing 在发送前会剥离这些，
  // 命中此处意味着出现了新的破坏路径。记录日志用于根因分析，
  // 并给用户一个恢复路径而不是死锁。
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('`tool_use` ids must be unique')
  ) {
    logEvent('tengu_duplicate_tool_use_id', {})
    const rewindInstruction = getIsNonInteractiveSession()
      ? ''
      : ' Run /rewind to recover the conversation.'
    return createAssistantAPIErrorMessage({
      content: `API Error: 400 duplicate tool_use ID in conversation history.${rewindInstruction}`,
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  // 检查订阅用户尝试使用 Opus 时出现的 invalid model name 错误
  if (
    isClaudeAISubscriber() &&
    error instanceof APIError &&
    error.status === 400 &&
    error.message.toLowerCase().includes('invalid model name') &&
    (isNonCustomOpusModel(model) || model === 'opus')
  ) {
    return createAssistantAPIErrorMessage({
      content:
        'Claude Opus is not available with the Claude Pro plan. If you have updated your subscription plan recently, run /logout and /login for the plan to take effect.',
      error: 'invalid_request',
    })
  }

  // 检查针对 Ant 用户的 invalid model name 错误。Claude Code 可能给 Ant 用户
  // 默认使用一个内部专属的自定义模型，也可能有些 Ant 用户使用了新的、
  // 尚未加进 gating 的 org ID。
  if (
    process.env.USER_TYPE === 'ant' &&
    !process.env.ANTHROPIC_MODEL &&
    error instanceof Error &&
    error.message.toLowerCase().includes('invalid model name')
  ) {
    // 从配置中获取 organization ID —— 只在实际使用 OAuth 时使用 OAuth 账户数据
    const orgId = getOauthAccountInfo()?.organizationUuid
    const baseMsg = `[ANT-ONLY] Your org isn't gated into the \`${model}\` model. Either run \`claude\` with \`ANTHROPIC_MODEL=${getDefaultMainLoopModelSetting()}\``
    const msg = orgId
      ? `${baseMsg} or share your orgId (${orgId}) in ${MACRO.FEEDBACK_CHANNEL} for help getting access.`
      : `${baseMsg} or reach out in ${MACRO.FEEDBACK_CHANNEL} for help getting access.`

    return createAssistantAPIErrorMessage({
      content: msg,
      error: 'invalid_request',
    })
  }

  if (
    error instanceof Error &&
    error.message.includes('Your credit balance is too low')
  ) {
    return createAssistantAPIErrorMessage({
      content: CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
      error: 'billing_error',
    })
  }
  // "Organization has been disabled" —— 通常是来自前雇主/项目的过期
  // ANTHROPIC_API_KEY 覆盖了订阅认证。只处理环境变量的情况；
  // apiKeyHelper 和 /login 管理的 key 意味着当前认证的 org 确实被禁用，
  // 没有休眠的 fallback 可以指向。
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.toLowerCase().includes('organization has been disabled')
  ) {
    const { source } = getAnthropicApiKeyWithSource()
    // getAnthropicApiKeyWithSource 把环境变量和 FD 传递的 key 混在同一个
    // source 值下，且 CCR 模式下 OAuth 即使有环境变量也保持激活。
    // 这三个守卫确保我们只在环境变量确实设置且确实在线上时才归咎于它。
    if (
      source === 'ANTHROPIC_API_KEY' &&
      process.env.ANTHROPIC_API_KEY &&
      !isClaudeAISubscriber()
    ) {
      const hasStoredOAuth = getClaudeAIOAuthTokens()?.accessToken != null
      // 不使用 'authentication_failed' —— 它会触发 VS Code 的 showLogin()，
      // 但登录解决不了（已批准的环境变量持续覆盖 OAuth）。修复是基于配置的
      // （取消设置该变量），所以 invalid_request 才是正确的。
      return createAssistantAPIErrorMessage({
        error: 'invalid_request',
        content: hasStoredOAuth
          ? ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH
          : ORG_DISABLED_ERROR_MESSAGE_ENV_KEY,
      })
    }
  }

  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('x-api-key')
  ) {
    // CCR 模式下认证走 JWT —— 这很可能是瞬时网络问题
    if (isCCRMode()) {
      return createAssistantAPIErrorMessage({
        error: 'authentication_failed',
        content: CCR_AUTH_ERROR_MESSAGE,
      })
    }

    // 检查 API key 是否来自外部源
    const { source } = getAnthropicApiKeyWithSource()
    const isExternalSource =
      source === 'ANTHROPIC_API_KEY' || source === 'apiKeyHelper'

    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content: isExternalSource
        ? INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL
        : INVALID_API_KEY_ERROR_MESSAGE,
    })
  }

  // 检查 OAuth token 撤销错误
  if (
    error instanceof APIError &&
    error.status === 403 &&
    error.message.includes('OAuth token has been revoked')
  ) {
    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content: getTokenRevokedErrorMessage(),
    })
  }

  // 检查 OAuth organization 不被允许的错误
  if (
    error instanceof APIError &&
    (error.status === 401 || error.status === 403) &&
    error.message.includes(
      'OAuth authentication is currently not allowed for this organization',
    )
  ) {
    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content: getOauthOrgNotAllowedErrorMessage(),
    })
  }

  // 处理其他 401/403 认证错误的通用处理器
  if (
    error instanceof APIError &&
    (error.status === 401 || error.status === 403)
  ) {
    // CCR 模式下认证走 JWT —— 这很可能是瞬时网络问题
    if (isCCRMode()) {
      return createAssistantAPIErrorMessage({
        error: 'authentication_failed',
        content: CCR_AUTH_ERROR_MESSAGE,
      })
    }

    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content: getIsNonInteractiveSession()
        ? `Failed to authenticate. ${API_ERROR_MESSAGE_PREFIX}: ${error.message}`
        : `Please run /login · ${API_ERROR_MESSAGE_PREFIX}: ${error.message}`,
    })
  }

  // Bedrock 错误，例如 "403 You don't have access to the model with the specified model ID."
  // 不包含实际的 model ID
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) &&
    error instanceof Error &&
    error.message.toLowerCase().includes('model id')
  ) {
    const switchCmd = getIsNonInteractiveSession() ? '--model' : '/model'
    const fallbackSuggestion = get3PModelFallbackSuggestion(model)
    return createAssistantAPIErrorMessage({
      content: fallbackSuggestion
        ? `${API_ERROR_MESSAGE_PREFIX} (${model}): ${error.message}. Try ${switchCmd} to switch to ${fallbackSuggestion}.`
        : `${API_ERROR_MESSAGE_PREFIX} (${model}): ${error.message}. Run ${switchCmd} to pick a different model.`,
      error: 'invalid_request',
    })
  }

  // 404 Not Found —— 通常意味着选中的模型不存在或不可用。
  // 引导用户到 /model 以选择一个合法的模型。
  // 对 3P 用户，建议一个具体的 fallback 模型供其尝试。
  if (error instanceof APIError && error.status === 404) {
    const switchCmd = getIsNonInteractiveSession() ? '--model' : '/model'
    const fallbackSuggestion = get3PModelFallbackSuggestion(model)
    return createAssistantAPIErrorMessage({
      content: fallbackSuggestion
        ? `The model ${model} is not available on your ${getAPIProvider()} deployment. Try ${switchCmd} to switch to ${fallbackSuggestion}, or ask your admin to enable this model.`
        : `There's an issue with the selected model (${model}). It may not exist or you may not have access to it. Run ${switchCmd} to pick a different model.`,
      error: 'invalid_request',
    })
  }

  // 连接错误（非超时）—— 使用 formatAPIError 获取详细消息
  if (error instanceof APIConnectionError) {
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: ${formatAPIError(error)}`,
      error: 'unknown',
    })
  }

  if (error instanceof Error) {
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: ${error.message}`,
      error: 'unknown',
    })
  }
  return createAssistantAPIErrorMessage({
    content: API_ERROR_MESSAGE_PREFIX,
    error: 'unknown',
  })
}

/**
 * 对 3P 用户，当选中的模型不可用时建议一个 fallback 模型。
 * 返回一个模型名建议；若无合适建议则返回 undefined。
 */
function get3PModelFallbackSuggestion(model: string): string | undefined {
  if (getAPIProvider() === 'firstParty') {
    return undefined
  }
  // @[MODEL LAUNCH]: 为新模型添加 fallback 建议链 → 对 3P 用户回退到上一版本
  const m = model.toLowerCase()
  // 若失败模型看起来是 Opus 4.6 变体，建议默认 Opus（3P 为 4.1）
  if (m.includes('opus-4-7') || m.includes('opus_4_7')) {
    return getModelStrings().opus46
  }
  if (m.includes('opus-4-6') || m.includes('opus_4_6')) {
    return getModelStrings().opus41
  }
  // 若失败模型看起来是 Sonnet 4.6 变体，建议 Sonnet 4.5
  if (m.includes('sonnet-4-6') || m.includes('sonnet_4_6')) {
    return getModelStrings().sonnet45
  }
  // 若失败模型看起来是 Sonnet 4.5 变体，建议 Sonnet 4
  if (m.includes('sonnet-4-5') || m.includes('sonnet_4_5')) {
    return getModelStrings().sonnet40
  }
  return undefined
}

/**
 * 把 API 错误分类为具体的错误类型，用于分析埋点。
 * 返回标准化的错误类型字符串，适合用作 Datadog 标签。
 */
export function classifyAPIError(error: unknown): string {
  // 被中止的请求
  if (error instanceof Error && error.message === 'Request was aborted.') {
    return 'aborted'
  }

  // 超时错误
  if (
    error instanceof APIConnectionTimeoutError ||
    (error instanceof APIConnectionError &&
      error.message.toLowerCase().includes('timeout'))
  ) {
    return 'api_timeout'
  }

  // 检查重复 529 错误
  if (
    error instanceof Error &&
    error.message.includes(REPEATED_529_ERROR_MESSAGE)
  ) {
    return 'repeated_529'
  }

  // 检查应急容量关闭开关
  if (
    error instanceof Error &&
    error.message.includes(CUSTOM_OFF_SWITCH_MESSAGE)
  ) {
    return 'capacity_off_switch'
  }

  // 限流
  if (error instanceof APIError && error.status === 429) {
    return 'rate_limit'
  }

  // 服务端过载（529）
  if (
    error instanceof APIError &&
    (error.status === 529 ||
      error.message?.includes('"type":"overloaded_error"'))
  ) {
    return 'server_overload'
  }

  // Prompt/内容大小错误
  if (
    error instanceof Error &&
    error.message
      .toLowerCase()
      .includes(PROMPT_TOO_LONG_ERROR_MESSAGE.toLowerCase())
  ) {
    return 'prompt_too_long'
  }

  // PDF 错误
  if (
    error instanceof Error &&
    /maximum of \d+ PDF pages/.test(error.message)
  ) {
    return 'pdf_too_large'
  }

  if (
    error instanceof Error &&
    error.message.includes('The PDF specified is password protected')
  ) {
    return 'pdf_password_protected'
  }

  // 图片尺寸错误
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('image exceeds') &&
    error.message.includes('maximum')
  ) {
    return 'image_too_large'
  }

  // 多图片尺寸错误
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('image dimensions exceed') &&
    error.message.includes('many-image')
  ) {
    return 'image_too_large'
  }

  // 工具使用错误（400）
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes(
      '`tool_use` ids were found without `tool_result` blocks immediately after',
    )
  ) {
    return 'tool_use_mismatch'
  }

  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('unexpected `tool_use_id` found in `tool_result`')
  ) {
    return 'unexpected_tool_result'
  }

  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('`tool_use` ids must be unique')
  ) {
    return 'duplicate_tool_use_id'
  }

  // 无效模型错误（400）
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.toLowerCase().includes('invalid model name')
  ) {
    return 'invalid_model'
  }

  // 信用额度/计费错误
  if (
    error instanceof Error &&
    error.message
      .toLowerCase()
      .includes(CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE.toLowerCase())
  ) {
    return 'credit_balance_low'
  }

  // 认证错误
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('x-api-key')
  ) {
    return 'invalid_api_key'
  }

  if (
    error instanceof APIError &&
    error.status === 403 &&
    error.message.includes('OAuth token has been revoked')
  ) {
    return 'token_revoked'
  }

  if (
    error instanceof APIError &&
    (error.status === 401 || error.status === 403) &&
    error.message.includes(
      'OAuth authentication is currently not allowed for this organization',
    )
  ) {
    return 'oauth_org_not_allowed'
  }

  // 通用认证错误
  if (
    error instanceof APIError &&
    (error.status === 401 || error.status === 403)
  ) {
    return 'auth_error'
  }

  // Bedrock 专属错误
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) &&
    error instanceof Error &&
    error.message.toLowerCase().includes('model id')
  ) {
    return 'bedrock_model_access'
  }

  // 基于状态码的兜底
  if (error instanceof APIError) {
    const status = error.status
    if (status >= 500) return 'server_error'
    if (status >= 400) return 'client_error'
  }

  // 连接错误 —— 先检查 SSL/TLS 问题
  if (error instanceof APIConnectionError) {
    const connectionDetails = extractConnectionErrorDetails(error)
    if (connectionDetails?.isSSLError) {
      return 'ssl_cert_error'
    }
    return 'connection_error'
  }

  return 'unknown'
}

export function categorizeRetryableAPIError(
  error: APIError,
): SDKAssistantMessageError {
  if (
    error.status === 529 ||
    error.message?.includes('"type":"overloaded_error"')
  ) {
    return 'rate_limit'
  }
  if (error.status === 429) {
    return 'rate_limit'
  }
  if (error.status === 401 || error.status === 403) {
    return 'authentication_failed'
  }
  if (error.status !== undefined && error.status >= 408) {
    return 'server_error'
  }
  return 'unknown'
}

export function getErrorMessageIfRefusal(
  stopReason: BetaStopReason | null,
  model: string,
): AssistantMessage | undefined {
  if (stopReason !== 'refusal') {
    return
  }

  logEvent('tengu_refusal_api_response', {})

  const baseMessage = getIsNonInteractiveSession()
    ? `${API_ERROR_MESSAGE_PREFIX}: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Try rephrasing the request or attempting a different approach.`
    : `${API_ERROR_MESSAGE_PREFIX}: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Please double press esc to edit your last message or start a new session for Claude Code to assist with a different task.`

  const modelSuggestion =
    model !== 'claude-sonnet-4-20250514'
      ? ' If you are seeing this refusal repeatedly, try running /model claude-sonnet-4-20250514 to switch models.'
      : ''

  return createAssistantAPIErrorMessage({
    content: baseMessage + modelSuggestion,
    error: 'invalid_request',
  })
}
