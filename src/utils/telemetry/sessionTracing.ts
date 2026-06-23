/**
 * Claude Code 会话追踪（使用 OpenTelemetry，BETA）
 *
 * 本模块提供高级 API，用于创建和管理 span，
 * 以追踪 Claude Code 工作流。每次用户交互都会创建一个根交互 span，
 * 其中包含操作 span（LLM 请求、工具调用等）。
 *
 * 前提条件：
 * - 通过 feature('ENHANCED_TELEMETRY_BETA') 启用增强遥测
 * - 配置 OTEL_TRACES_EXPORTER（console、otlp 等）
 */

import { feature } from 'bun:bundle'
import { context as otelContext, type Span, trace } from '@opentelemetry/api'
import { AsyncLocalStorage } from 'async_hooks'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { AssistantMessage, UserMessage } from '../../types/message.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { getTelemetryAttributes } from '../telemetryAttributes.js'
import {
  addBetaInteractionAttributes,
  addBetaLLMRequestAttributes,
  addBetaLLMResponseAttributes,
  addBetaToolInputAttributes,
  addBetaToolResultAttributes,
  isBetaTracingEnabled,
  type LLMRequestNewContext,
  truncateContent,
} from './betaSessionTracing.js'
import {
  endInteractionPerfettoSpan,
  endLLMRequestPerfettoSpan,
  endToolPerfettoSpan,
  endUserInputPerfettoSpan,
  isPerfettoTracingEnabled,
  startInteractionPerfettoSpan,
  startLLMRequestPerfettoSpan,
  startToolPerfettoSpan,
  startUserInputPerfettoSpan,
} from './perfettoTracing.js'

// 重新导出给调用方使用
export type { Span }
export { isBetaTracingEnabled, type LLMRequestNewContext }

// API 调用的消息类型（UserMessage 或 AssistantMessage）
type APIMessage = UserMessage | AssistantMessage

type SpanType =
  | 'interaction'
  | 'llm_request'
  | 'tool'
  | 'tool.blocked_on_user'
  | 'tool.execution'
  | 'hook'

interface SpanContext {
  span: Span
  startTime: number
  attributes: Record<string, string | number | boolean>
  ended?: boolean
  perfettoSpanId?: string
}

// ALS 直接存储 SpanContext，因此在 span 激活期间持有强引用。
// 因此 activeSpans 可以使用 WeakRef —— 当 ALS 被清除
// （enterWith(undefined)）且没有其他代码持有 SpanContext 时，GC 可以回收它，
// WeakRef 就会失效。
const interactionContext = new AsyncLocalStorage<SpanContext | undefined>()
const toolContext = new AsyncLocalStorage<SpanContext | undefined>()
const activeSpans = new Map<string, WeakRef<SpanContext>>()
// 不存储在 ALS 中的 span（LLM 请求、等待用户、工具执行、hook）
// 需要强引用以防止 GC 在对应的 end* 函数获取之前回收 SpanContext。
const strongSpans = new Map<string, SpanContext>()
let interactionSequence = 0
let _cleanupIntervalStarted = false

const SPAN_TTL_MS = 30 * 60 * 1000 // 30 分钟

function getSpanId(span: Span): string {
  return span.spanContext().spanId || ''
}

/**
 * 延迟启动一个后台定时器，清理 activeSpans 中的孤立 span。
 *
 * 正常的拆卸流程会调用 endInteractionSpan / endToolSpan，立即删除 span。
 * 此定时器是针对从未结束的 span 的安全网（例如中止的流、查询中未捕获的异常）
 * —— 没有它的话，这些 span 会无限期地累积在 activeSpans 中，
 * 持有对 Span 对象和 OpenTelemetry 上下文链的引用。
 *
 * 在第一次 startInteractionSpan 调用时初始化（而非模块加载时），
 * 以避免触发 no-top-level-side-effects lint 规则，并防止
 * 在从未启动 span 的进程中运行该定时器。
 * unref() 防止定时器在所有其他工作完成后阻止进程退出。
 */
function ensureCleanupInterval(): void {
  if (_cleanupIntervalStarted) return
  _cleanupIntervalStarted = true
  const interval = setInterval(() => {
    const cutoff = Date.now() - SPAN_TTL_MS
    for (const [spanId, weakRef] of activeSpans) {
      const ctx = weakRef.deref()
      if (ctx === undefined) {
        activeSpans.delete(spanId)
        strongSpans.delete(spanId)
      } else if (ctx.startTime < cutoff) {
        if (!ctx.ended) ctx.span.end() // 将已记录的任何属性刷新到导出器
        activeSpans.delete(spanId)
        strongSpans.delete(spanId)
      }
    }
  }, 60_000)
  if (typeof interval.unref === 'function') {
    interval.unref() // Node.js / Bun：不阻塞进程退出
  }
}

/**
 * 检查是否启用了增强遥测。
 * 优先级：环境变量覆盖 > ant 构建 > GrowthBook 开关
 */
export function isEnhancedTelemetryEnabled(): boolean {
  if (feature('ENHANCED_TELEMETRY_BETA')) {
    const env =
      process.env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA ??
      process.env.ENABLE_ENHANCED_TELEMETRY_BETA
    if (isEnvTruthy(env)) {
      return true
    }
    if (isEnvDefinedFalsy(env)) {
      return false
    }
    return (
      process.env.USER_TYPE === 'ant' ||
      getFeatureValue_CACHED_MAY_BE_STALE('enhanced_telemetry_beta', false)
    )
  }
  return false
}

/**
 * 检查是否启用了任何追踪（标准增强遥测或 beta 追踪）
 */
function isAnyTracingEnabled(): boolean {
  return isEnhancedTelemetryEnabled() || isBetaTracingEnabled()
}

function getTracer() {
  return trace.getTracer('com.anthropic.claude_code.tracing', '1.0.0')
}

function createSpanAttributes(
  spanType: SpanType,
  customAttributes: Record<string, string | number | boolean> = {},
): Record<string, string | number | boolean> {
  const baseAttributes = getTelemetryAttributes()

  const attributes: Record<string, string | number | boolean> = {
    ...baseAttributes,
    'span.type': spanType,
    ...customAttributes,
  }

  return attributes
}

/**
 * 启动一个交互 span。此 span 包裹一次用户请求 -> Claude 响应周期。
 * 这是一个根 span，包含所有会话级别的属性。
 * 为后续所有操作设置交互上下文。
 */
export function startInteractionSpan(userPrompt: string): Span {
  ensureCleanupInterval()

  // 无论 OTel 追踪状态如何，都启动 Perfetto span
  const perfettoSpanId = isPerfettoTracingEnabled()
    ? startInteractionPerfettoSpan(userPrompt)
    : undefined

  if (!isAnyTracingEnabled()) {
    // 即使 OTel 被禁用，仍然追踪 Perfetto span
    if (perfettoSpanId) {
      const dummySpan = trace.getActiveSpan() || getTracer().startSpan('dummy')
      const spanId = getSpanId(dummySpan)
      const spanContextObj: SpanContext = {
        span: dummySpan,
        startTime: Date.now(),
        attributes: {},
        perfettoSpanId,
      }
      activeSpans.set(spanId, new WeakRef(spanContextObj))
      interactionContext.enterWith(spanContextObj)
      return dummySpan
    }
    return trace.getActiveSpan() || getTracer().startSpan('dummy')
  }

  const tracer = getTracer()
  const isUserPromptLoggingEnabled = isEnvTruthy(
    process.env.OTEL_LOG_USER_PROMPTS,
  )
  const promptToLog = isUserPromptLoggingEnabled ? userPrompt : '<REDACTED>'

  interactionSequence++

  const attributes = createSpanAttributes('interaction', {
    user_prompt: promptToLog,
    user_prompt_length: userPrompt.length,
    'interaction.sequence': interactionSequence,
  })

  const span = tracer.startSpan('claude_code.interaction', {
    attributes,
  })

  // 添加实验性属性（new_context）
  addBetaInteractionAttributes(span, userPrompt)

  const spanId = getSpanId(span)
  const spanContextObj: SpanContext = {
    span,
    startTime: Date.now(),
    attributes,
    perfettoSpanId,
  }
  activeSpans.set(spanId, new WeakRef(spanContextObj))

  interactionContext.enterWith(spanContextObj)

  return span
}

export function endInteractionSpan(): void {
  const spanContext = interactionContext.getStore()
  if (!spanContext) {
    return
  }

  if (spanContext.ended) {
    return
  }

  // 结束 Perfetto span
  if (spanContext.perfettoSpanId) {
    endInteractionPerfettoSpan(spanContext.perfettoSpanId)
  }

  if (!isAnyTracingEnabled()) {
    spanContext.ended = true
    activeSpans.delete(getSpanId(spanContext.span))
    // 清除存储，使此后创建的异步续体（定时器、
    // promise 回调、I/O）不会继承对已结束 span 的引用。
    // enterWith(undefined) 是有意为之：exit(() => {}) 是空操作，因为它
    // 仅在回调内部抑制存储并立即返回。
    interactionContext.enterWith(undefined)
    return
  }

  const duration = Date.now() - spanContext.startTime
  spanContext.span.setAttributes({
    'interaction.duration_ms': duration,
  })

  spanContext.span.end()
  spanContext.ended = true
  activeSpans.delete(getSpanId(spanContext.span))
  interactionContext.enterWith(undefined)
}

export function startLLMRequestSpan(
  model: string,
  newContext?: LLMRequestNewContext,
  messagesForAPI?: APIMessage[],
  fastMode?: boolean,
): Span {
  // 无论 OTel 追踪状态如何，都启动 Perfetto span
  const perfettoSpanId = isPerfettoTracingEnabled()
    ? startLLMRequestPerfettoSpan({
        model,
        querySource: newContext?.querySource,
        messageId: undefined, // 将在 endLLMRequestSpan 中设置
      })
    : undefined

  if (!isAnyTracingEnabled()) {
    // 即使 OTel 被禁用，仍然追踪 Perfetto span
    if (perfettoSpanId) {
      const dummySpan = trace.getActiveSpan() || getTracer().startSpan('dummy')
      const spanId = getSpanId(dummySpan)
      const spanContextObj: SpanContext = {
        span: dummySpan,
        startTime: Date.now(),
        attributes: { model },
        perfettoSpanId,
      }
      activeSpans.set(spanId, new WeakRef(spanContextObj))
      strongSpans.set(spanId, spanContextObj)
      return dummySpan
    }
    return trace.getActiveSpan() || getTracer().startSpan('dummy')
  }

  const tracer = getTracer()
  const parentSpanCtx = interactionContext.getStore()

  const attributes = createSpanAttributes('llm_request', {
    model: model,
    'llm_request.context': parentSpanCtx ? 'interaction' : 'standalone',
    speed: fastMode ? 'fast' : 'normal',
  })

  const ctx = parentSpanCtx
    ? trace.setSpan(otelContext.active(), parentSpanCtx.span)
    : otelContext.active()
  const span = tracer.startSpan('claude_code.llm_request', { attributes }, ctx)

  // 如果提供了 query_source（agent 名称），则添加
  if (newContext?.querySource) {
    span.setAttribute('query_source', newContext.querySource)
  }

  // 添加实验性属性（system prompt, new_context）
  addBetaLLMRequestAttributes(span, newContext, messagesForAPI)

  const spanId = getSpanId(span)
  const spanContextObj: SpanContext = {
    span,
    startTime: Date.now(),
    attributes,
    perfettoSpanId,
  }
  activeSpans.set(spanId, new WeakRef(spanContextObj))
  strongSpans.set(spanId, spanContextObj)

  return span
}

/**
 * 结束一个 LLM 请求 span 并附加响应元数据。
 *
 * @param span - 可选。startLLMRequestSpan() 返回的确切 span。
 *   重要：当多个 LLM 请求并行运行时（例如预热请求、
 *   主题分类器、文件路径提取器、主线程），你 必须 传递特定的 span，
 *   以确保响应附加到正确的请求。否则，响应可能会被
 *   错误地附加到 activeSpans 映射中碰巧是"最后一个"的 span。
 *
 *   如果未提供，则回退到查找最近的 llm_request span（旧版行为）。
 */
export function endLLMRequestSpan(
  span?: Span,
  metadata?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    success?: boolean
    statusCode?: number
    error?: string
    attempt?: number
    modelResponse?: string
    /** 模型的文本输出（非思考内容） */
    modelOutput?: string
    /** 模型的思考/推理输出 */
    thinkingOutput?: string
    /** 输出是否包含工具调用（详情查看工具 span） */
    hasToolCall?: boolean
    /** 首 token 时间（毫秒） */
    ttftMs?: number
    /** 成功尝试之前的预请求设置耗时（毫秒） */
    requestSetupMs?: number
    /** 每次尝试开始的时间戳（Date.now()）—— 用于发出重试子 span */
    attemptStartTimes?: number[]
  },
): void {
  let llmSpanContext: SpanContext | undefined

  if (span) {
    // 直接使用提供的 span —— 这是并行请求的正确做法
    const spanId = getSpanId(span)
    llmSpanContext = activeSpans.get(spanId)?.deref()
  } else {
    // 旧版回退：查找最近的 llm_request span
    // 警告：当多个请求在进行中时，这可能导致响应不匹配
    llmSpanContext = Array.from(activeSpans.values())
      .findLast(r => {
        const ctx = r.deref()
        return (
          ctx?.attributes['span.type'] === 'llm_request' ||
          ctx?.attributes['model']
        )
      })
      ?.deref()
  }

  if (!llmSpanContext) {
    // span 已经结束或从未被追踪
    return
  }

  const duration = Date.now() - llmSpanContext.startTime

  // 使用完整元数据结束 Perfetto span
  if (llmSpanContext.perfettoSpanId) {
    endLLMRequestPerfettoSpan(llmSpanContext.perfettoSpanId, {
      ttftMs: metadata?.ttftMs,
      ttltMs: duration, // 最后 token 时间即为总耗时
      promptTokens: metadata?.inputTokens,
      outputTokens: metadata?.outputTokens,
      cacheReadTokens: metadata?.cacheReadTokens,
      cacheCreationTokens: metadata?.cacheCreationTokens,
      success: metadata?.success,
      error: metadata?.error,
      requestSetupMs: metadata?.requestSetupMs,
      attemptStartTimes: metadata?.attemptStartTimes,
    })
  }

  if (!isAnyTracingEnabled()) {
    const spanId = getSpanId(llmSpanContext.span)
    activeSpans.delete(spanId)
    strongSpans.delete(spanId)
    return
  }

  const endAttributes: Record<string, string | number | boolean> = {
    duration_ms: duration,
  }

  if (metadata) {
    if (metadata.inputTokens !== undefined)
      endAttributes['input_tokens'] = metadata.inputTokens
    if (metadata.outputTokens !== undefined)
      endAttributes['output_tokens'] = metadata.outputTokens
    if (metadata.cacheReadTokens !== undefined)
      endAttributes['cache_read_tokens'] = metadata.cacheReadTokens
    if (metadata.cacheCreationTokens !== undefined)
      endAttributes['cache_creation_tokens'] = metadata.cacheCreationTokens
    if (metadata.success !== undefined)
      endAttributes['success'] = metadata.success
    if (metadata.statusCode !== undefined)
      endAttributes['status_code'] = metadata.statusCode
    if (metadata.error !== undefined) endAttributes['error'] = metadata.error
    if (metadata.attempt !== undefined)
      endAttributes['attempt'] = metadata.attempt
    if (metadata.hasToolCall !== undefined)
      endAttributes['response.has_tool_call'] = metadata.hasToolCall
    if (metadata.ttftMs !== undefined)
      endAttributes['ttft_ms'] = metadata.ttftMs

    // 添加实验性响应属性（model_output, thinking_output）
    addBetaLLMResponseAttributes(endAttributes, metadata)
  }

  llmSpanContext.span.setAttributes(endAttributes)
  llmSpanContext.span.end()

  const spanId = getSpanId(llmSpanContext.span)
  activeSpans.delete(spanId)
  strongSpans.delete(spanId)
}

export function startToolSpan(
  toolName: string,
  toolAttributes?: Record<string, string | number | boolean>,
  toolInput?: string,
): Span {
  // 无论 OTel 追踪状态如何，都启动 Perfetto span
  const perfettoSpanId = isPerfettoTracingEnabled()
    ? startToolPerfettoSpan(toolName, toolAttributes)
    : undefined

  if (!isAnyTracingEnabled()) {
    // 即使 OTel 被禁用，仍然追踪 Perfetto span
    if (perfettoSpanId) {
      const dummySpan = trace.getActiveSpan() || getTracer().startSpan('dummy')
      const spanId = getSpanId(dummySpan)
      const spanContextObj: SpanContext = {
        span: dummySpan,
        startTime: Date.now(),
        attributes: { 'span.type': 'tool', tool_name: toolName },
        perfettoSpanId,
      }
      activeSpans.set(spanId, new WeakRef(spanContextObj))
      toolContext.enterWith(spanContextObj)
      return dummySpan
    }
    return trace.getActiveSpan() || getTracer().startSpan('dummy')
  }

  const tracer = getTracer()
  const parentSpanCtx = interactionContext.getStore()

  const attributes = createSpanAttributes('tool', {
    tool_name: toolName,
    ...toolAttributes,
  })

  const ctx = parentSpanCtx
    ? trace.setSpan(otelContext.active(), parentSpanCtx.span)
    : otelContext.active()
  const span = tracer.startSpan('claude_code.tool', { attributes }, ctx)

  // 添加实验性工具输入属性
  if (toolInput) {
    addBetaToolInputAttributes(span, toolName, toolInput)
  }

  const spanId = getSpanId(span)
  const spanContextObj: SpanContext = {
    span,
    startTime: Date.now(),
    attributes,
    perfettoSpanId,
  }
  activeSpans.set(spanId, new WeakRef(spanContextObj))

  toolContext.enterWith(spanContextObj)

  return span
}

export function startToolBlockedOnUserSpan(): Span {
  // 无论 OTel 追踪状态如何，都启动 Perfetto span
  const perfettoSpanId = isPerfettoTracingEnabled()
    ? startUserInputPerfettoSpan('tool_permission')
    : undefined

  if (!isAnyTracingEnabled()) {
    // 即使 OTel 被禁用，仍然追踪 Perfetto span
    if (perfettoSpanId) {
      const dummySpan = trace.getActiveSpan() || getTracer().startSpan('dummy')
      const spanId = getSpanId(dummySpan)
      const spanContextObj: SpanContext = {
        span: dummySpan,
        startTime: Date.now(),
        attributes: { 'span.type': 'tool.blocked_on_user' },
        perfettoSpanId,
      }
      activeSpans.set(spanId, new WeakRef(spanContextObj))
      strongSpans.set(spanId, spanContextObj)
      return dummySpan
    }
    return trace.getActiveSpan() || getTracer().startSpan('dummy')
  }

  const tracer = getTracer()
  const parentSpanCtx = toolContext.getStore()

  const attributes = createSpanAttributes('tool.blocked_on_user')

  const ctx = parentSpanCtx
    ? trace.setSpan(otelContext.active(), parentSpanCtx.span)
    : otelContext.active()
  const span = tracer.startSpan(
    'claude_code.tool.blocked_on_user',
    { attributes },
    ctx,
  )

  const spanId = getSpanId(span)
  const spanContextObj: SpanContext = {
    span,
    startTime: Date.now(),
    attributes,
    perfettoSpanId,
  }
  activeSpans.set(spanId, new WeakRef(spanContextObj))
  strongSpans.set(spanId, spanContextObj)

  return span
}

export function endToolBlockedOnUserSpan(
  decision?: string,
  source?: string,
): void {
  const blockedSpanContext = Array.from(activeSpans.values())
    .findLast(
      r => r.deref()?.attributes['span.type'] === 'tool.blocked_on_user',
    )
    ?.deref()

  if (!blockedSpanContext) {
    return
  }

  // 结束 Perfetto span
  if (blockedSpanContext.perfettoSpanId) {
    endUserInputPerfettoSpan(blockedSpanContext.perfettoSpanId, {
      decision,
      source,
    })
  }

  if (!isAnyTracingEnabled()) {
    const spanId = getSpanId(blockedSpanContext.span)
    activeSpans.delete(spanId)
    strongSpans.delete(spanId)
    return
  }

  const duration = Date.now() - blockedSpanContext.startTime
  const attributes: Record<string, string | number | boolean> = {
    duration_ms: duration,
  }

  if (decision) {
    attributes['decision'] = decision
  }
  if (source) {
    attributes['source'] = source
  }

  blockedSpanContext.span.setAttributes(attributes)
  blockedSpanContext.span.end()

  const spanId = getSpanId(blockedSpanContext.span)
  activeSpans.delete(spanId)
  strongSpans.delete(spanId)
}

export function startToolExecutionSpan(): Span {
  if (!isAnyTracingEnabled()) {
    return trace.getActiveSpan() || getTracer().startSpan('dummy')
  }

  const tracer = getTracer()
  const parentSpanCtx = toolContext.getStore()

  const attributes = createSpanAttributes('tool.execution')

  const ctx = parentSpanCtx
    ? trace.setSpan(otelContext.active(), parentSpanCtx.span)
    : otelContext.active()
  const span = tracer.startSpan(
    'claude_code.tool.execution',
    { attributes },
    ctx,
  )

  const spanId = getSpanId(span)
  const spanContextObj: SpanContext = {
    span,
    startTime: Date.now(),
    attributes,
  }
  activeSpans.set(spanId, new WeakRef(spanContextObj))
  strongSpans.set(spanId, spanContextObj)

  return span
}

export function endToolExecutionSpan(metadata?: {
  success?: boolean
  error?: string
}): void {
  if (!isAnyTracingEnabled()) {
    return
  }

  const executionSpanContext = Array.from(activeSpans.values())
    .findLast(r => r.deref()?.attributes['span.type'] === 'tool.execution')
    ?.deref()

  if (!executionSpanContext) {
    return
  }

  const duration = Date.now() - executionSpanContext.startTime
  const attributes: Record<string, string | number | boolean> = {
    duration_ms: duration,
  }

  if (metadata) {
    if (metadata.success !== undefined) attributes['success'] = metadata.success
    if (metadata.error !== undefined) attributes['error'] = metadata.error
  }

  executionSpanContext.span.setAttributes(attributes)
  executionSpanContext.span.end()

  const spanId = getSpanId(executionSpanContext.span)
  activeSpans.delete(spanId)
  strongSpans.delete(spanId)
}

export function endToolSpan(toolResult?: string, resultTokens?: number): void {
  const toolSpanContext = toolContext.getStore()

  if (!toolSpanContext) {
    return
  }

  // 结束 Perfetto span
  if (toolSpanContext.perfettoSpanId) {
    endToolPerfettoSpan(toolSpanContext.perfettoSpanId, {
      success: true,
      resultTokens,
    })
  }

  if (!isAnyTracingEnabled()) {
    const spanId = getSpanId(toolSpanContext.span)
    activeSpans.delete(spanId)
    // 与上面 interactionContext 同理：清除以使后续异步
    // 工作不会持有对已结束工具 span 的过时引用。
    toolContext.enterWith(undefined)
    return
  }

  const duration = Date.now() - toolSpanContext.startTime
  const endAttributes: Record<string, string | number | boolean> = {
    duration_ms: duration,
  }

  // 添加实验性工具结果属性（new_context）
  if (toolResult) {
    const toolName = toolSpanContext.attributes['tool_name'] || 'unknown'
    addBetaToolResultAttributes(endAttributes, toolName, toolResult)
  }

  if (resultTokens !== undefined) {
    endAttributes['result_tokens'] = resultTokens
  }

  toolSpanContext.span.setAttributes(endAttributes)
  toolSpanContext.span.end()

  const spanId = getSpanId(toolSpanContext.span)
  activeSpans.delete(spanId)
  toolContext.enterWith(undefined)
}

function isToolContentLoggingEnabled(): boolean {
  return isEnvTruthy(process.env.OTEL_LOG_TOOL_CONTENT)
}

/**
 * 添加一个包含工具内容/输出数据的 span 事件。
 * 仅在设置了 OTEL_LOG_TOOL_CONTENT=1 时记录。
 * 如果内容超过 MAX_CONTENT_SIZE 则进行截断。
 */
export function addToolContentEvent(
  eventName: string,
  attributes: Record<string, string | number | boolean>,
): void {
  if (!isAnyTracingEnabled() || !isToolContentLoggingEnabled()) {
    return
  }

  const currentSpanCtx = toolContext.getStore()
  if (!currentSpanCtx) {
    return
  }

  // 对可能很大的字符串属性进行截断
  const processedAttributes: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'string') {
      const { content, truncated } = truncateContent(value)
      processedAttributes[key] = content
      if (truncated) {
        processedAttributes[`${key}_truncated`] = true
        processedAttributes[`${key}_original_length`] = value.length
      }
    } else {
      processedAttributes[key] = value
    }
  }

  currentSpanCtx.span.addEvent(eventName, processedAttributes)
}

export function getCurrentSpan(): Span | null {
  if (!isAnyTracingEnabled()) {
    return null
  }

  return (
    toolContext.getStore()?.span ?? interactionContext.getStore()?.span ?? null
  )
}

export async function executeInSpan<T>(
  spanName: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  if (!isAnyTracingEnabled()) {
    return fn(trace.getActiveSpan() || getTracer().startSpan('dummy'))
  }

  const tracer = getTracer()
  const parentSpanCtx = toolContext.getStore() ?? interactionContext.getStore()

  const finalAttributes = createSpanAttributes('tool', {
    ...attributes,
  })

  const ctx = parentSpanCtx
    ? trace.setSpan(otelContext.active(), parentSpanCtx.span)
    : otelContext.active()
  const span = tracer.startSpan(spanName, { attributes: finalAttributes }, ctx)

  const spanId = getSpanId(span)
  const spanContextObj: SpanContext = {
    span,
    startTime: Date.now(),
    attributes: finalAttributes,
  }
  activeSpans.set(spanId, new WeakRef(spanContextObj))
  strongSpans.set(spanId, spanContextObj)

  try {
    const result = await fn(span)
    span.end()
    activeSpans.delete(spanId)
    strongSpans.delete(spanId)
    return result
  } catch (error) {
    if (error instanceof Error) {
      span.recordException(error)
    }
    span.end()
    activeSpans.delete(spanId)
    strongSpans.delete(spanId)
    throw error
  }
}

/**
 * 启动一个 hook 执行 span。
 * 仅在 beta 追踪启用时创建 span。
 * @param hookEvent hook 事件类型（例如 'PreToolUse'、'PostToolUse'）
 * @param hookName 完整的 hook 名称（例如 'PreToolUse:Write'）
 * @param numHooks 正在执行的 hook 数量
 * @param hookDefinitions hook 定义的 JSON 字符串，用于追踪
 * @returns span（如果追踪被禁用则返回 dummy span）
 */
export function startHookSpan(
  hookEvent: string,
  hookName: string,
  numHooks: number,
  hookDefinitions: string,
): Span {
  if (!isBetaTracingEnabled()) {
    return trace.getActiveSpan() || getTracer().startSpan('dummy')
  }

  const tracer = getTracer()
  const parentSpanCtx = toolContext.getStore() ?? interactionContext.getStore()

  const attributes = createSpanAttributes('hook', {
    hook_event: hookEvent,
    hook_name: hookName,
    num_hooks: numHooks,
    hook_definitions: hookDefinitions,
  })

  const ctx = parentSpanCtx
    ? trace.setSpan(otelContext.active(), parentSpanCtx.span)
    : otelContext.active()
  const span = tracer.startSpan('claude_code.hook', { attributes }, ctx)

  const spanId = getSpanId(span)
  const spanContextObj: SpanContext = {
    span,
    startTime: Date.now(),
    attributes,
  }
  activeSpans.set(spanId, new WeakRef(spanContextObj))
  strongSpans.set(spanId, spanContextObj)

  return span
}

/**
 * 结束一个 hook 执行 span 并附加结果元数据。
 * 仅在 beta 追踪启用时执行。
 * @param span 要结束的 span（由 startHookSpan 返回）
 * @param metadata hook 执行的结果元数据
 */
export function endHookSpan(
  span: Span,
  metadata?: {
    numSuccess?: number
    numBlocking?: number
    numNonBlockingError?: number
    numCancelled?: number
  },
): void {
  if (!isBetaTracingEnabled()) {
    return
  }

  const spanId = getSpanId(span)
  const spanContext = activeSpans.get(spanId)?.deref()

  if (!spanContext) {
    return
  }

  const duration = Date.now() - spanContext.startTime
  const endAttributes: Record<string, string | number | boolean> = {
    duration_ms: duration,
  }

  if (metadata) {
    if (metadata.numSuccess !== undefined)
      endAttributes['num_success'] = metadata.numSuccess
    if (metadata.numBlocking !== undefined)
      endAttributes['num_blocking'] = metadata.numBlocking
    if (metadata.numNonBlockingError !== undefined)
      endAttributes['num_non_blocking_error'] = metadata.numNonBlockingError
    if (metadata.numCancelled !== undefined)
      endAttributes['num_cancelled'] = metadata.numCancelled
  }

  spanContext.span.setAttributes(endAttributes)
  spanContext.span.end()
  activeSpans.delete(spanId)
  strongSpans.delete(spanId)
}
