import { queryHaiku } from '../api/claude.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { getSkillLearningConfig } from './config.js'
import type { InstinctCandidate } from './instinctParser.js'
import type { StoredSkillObservation } from './observationStore.js'
import type {
  ObserverBackend,
  ObserverBackendContext,
} from './observerBackend.js'
import {
  INSTINCT_DOMAINS,
  type InstinctDomain,
  type SkillLearningScope,
} from './types.js'

/**
 * 基于 LLM 的观察者后端。
 *
 * 通过项目的 `queryHaiku` 辅助函数运行轻量快速模型（Haiku），
 * 向其提供最近观察记录的紧凑摘要，并请求最多三条 JSON 格式的原子可复用本能。
 * 输出经过验证后映射为 `InstinctCandidate[]`，使现有的进化流水线
 * 能以相同方式消费 LLM 输出和启发式输出。
 *
 * 设计说明：
 * - 复用 `queryHaiku`（经过完整的 Claude Code API 栈：
 *   OAuth、beta 头、providers、测试中的 VCR）。无新增鉴权代码。
 * - 将输入限制在观察缓冲区末尾，使提示词保持简洁可预测，
 *   并在 10 秒中止信号下运行，确保慢速 Haiku 往返不会阻塞 REPL 轮次结束。
 * - 任何失败（中止、解析错误、空输出）均返回 `[]` ——
 *   该后端通过 `SKILL_LEARNING_OBSERVER_BACKEND=llm` 选择启用，
 *   当 API 不可用时绝不能使技能学习失稳。
 */

const MAX_OBSERVATIONS_PER_CALL = 30
const MAX_CANDIDATES_PER_CALL = 3

// --- 熔断器状态 ---
let consecutiveFailures = 0
let circuitOpenUntil = 0

export function resetCircuitBreaker(): void {
  consecutiveFailures = 0
  circuitOpenUntil = 0
}

const LLM_OBSERVER_SYSTEM_PROMPT = `你分析编程助手会话中的一段简短观察序列（用户消息、带结果的工具调用、助手消息），并提取原子性、可复用的"本能"—— 有助于助手在未来类似情境中正确行动的行为模式。

仅以 JSON 数组回应（无散文、无代码围栏、无注释）。每项须符合此 schema：

{
  "trigger": string,        // <= 80 字符，描述本能适用时机的短语
  "action": string,         // <= 120 字符，描述应采取何种行动的短语
  "confidence": number,     // 0..1 —— 观察结果支持该模式的强度
  "domain": "workflow"|"testing"|"debugging"|"code-style"|"security"|"git"|"project",
  "scope": "project"|"global",
  "evidence": string[]      // 1..3 条从观察中摘录或改写的简短证据
}

规则：
- 若无明显可复用内容，返回 []。禁止猜测。
- 最多 3 项，置信度由高到低排列。
- confidence > 0.7 仅当观察显示模式在实际运作时（纠正后紧跟成功重试、重复序列、明确规则）。
- 绝不包含密钥、令牌、完整文件内容或个人识别数据。
- scope "global" 仅当模式明显与项目无关时（通用测试、git 规范）；默认为 "project"。`

export const llmObserverBackend: ObserverBackend = {
  name: 'llm',
  analyze(
    observations: StoredSkillObservation[],
    ctx?: ObserverBackendContext,
  ): Promise<InstinctCandidate[]> {
    return analyseWithHaiku(observations, ctx)
  },
}

async function analyseWithHaiku(
  observations: StoredSkillObservation[],
  ctx?: ObserverBackendContext,
): Promise<InstinctCandidate[]> {
  if (observations.length === 0) return []

  // 熔断器：若熔断器处于打开状态，完全跳过 queryHaiku。
  if (Date.now() < circuitOpenUntil) {
    return runHeuristicFallback(observations, ctx)
  }

  const capped = observations.slice(-MAX_OBSERVATIONS_PER_CALL)
  const userPrompt = buildUserPrompt(capped)
  const signal = makeTimeoutSignal(getSkillLearningConfig().llm.timeoutMs)

  let responseText: string
  try {
    const response = await queryHaiku({
      systemPrompt: asSystemPrompt([LLM_OBSERVER_SYSTEM_PROMPT]),
      userPrompt,
      signal,
      options: {
        querySource: 'skill_learning_observer',
        enablePromptCaching: true,
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    })
    // 成功：重置失败计数器。
    consecutiveFailures = 0
    responseText = extractResponseText(response.message?.content)
  } catch {
    // Haiku 失败（超时 / 限流 / 错误响应）—— 递增失败计数器，
    // 并在必要时打开熔断器。
    consecutiveFailures++
    if (consecutiveFailures >= getSkillLearningConfig().llm.failureThreshold) {
      circuitOpenUntil =
        Date.now() + getSkillLearningConfig().llm.circuitCooldownMs
    }
    return runHeuristicFallback(observations, ctx)
  }

  const parsed = parseInstinctCandidates(responseText, ctx, capped)
  if (parsed.length === 0) {
    // LLM 输出为空或格式错误 —— 计为一次失败，以便在 Haiku 系统性
    // 返回无效内容时（例如模型版本漂移导致不再输出预期 JSON）
    // 打开熔断器。
    consecutiveFailures++
    if (consecutiveFailures >= getSkillLearningConfig().llm.failureThreshold) {
      circuitOpenUntil =
        Date.now() + getSkillLearningConfig().llm.circuitCooldownMs
    }
    return runHeuristicFallback(observations, ctx)
  }
  return parsed
}

async function runHeuristicFallback(
  observations: StoredSkillObservation[],
  ctx?: ObserverBackendContext,
): Promise<InstinctCandidate[]> {
  try {
    const { heuristicObserverBackend } = await import('./sessionObserver.js')
    const result = heuristicObserverBackend.analyze(observations, ctx)
    return Array.isArray(result) ? result : await result
  } catch {
    return []
  }
}

function buildUserPrompt(observations: StoredSkillObservation[]): string {
  const rendered = observations
    .map((observation, index) => renderObservation(observation, index))
    .join('\n')
  return `Observations (chronological, newest last):\n${rendered}\n\nExtract up to ${MAX_CANDIDATES_PER_CALL} atomic instincts. JSON array only.`
}

function renderObservation(
  observation: StoredSkillObservation,
  index: number,
): string {
  const segments: string[] = [`#${index + 1}`, `event=${observation.event}`]
  if (observation.toolName) segments.push(`tool=${observation.toolName}`)
  if (observation.outcome) segments.push(`outcome=${observation.outcome}`)
  if (observation.messageText) {
    segments.push(
      `text=${JSON.stringify(truncate(observation.messageText, 200))}`,
    )
  }
  if (observation.toolInput) {
    segments.push(`in=${JSON.stringify(truncate(observation.toolInput, 120))}`)
  }
  if (observation.toolOutput) {
    segments.push(
      `out=${JSON.stringify(truncate(observation.toolOutput, 120))}`,
    )
  }
  return segments.join(' | ')
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}

function extractResponseText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record.type !== 'text') continue
    if (typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('').trim()
}

function parseInstinctCandidates(
  raw: string,
  ctx: ObserverBackendContext | undefined,
  observations: StoredSkillObservation[],
): InstinctCandidate[] {
  const json = extractJsonArray(raw)
  if (!json) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const observationIds = observations.map(observation => observation.id)
  const candidates: InstinctCandidate[] = []

  for (const item of parsed.slice(0, MAX_CANDIDATES_PER_CALL)) {
    const candidate = normaliseCandidate(item, ctx, observationIds)
    if (candidate) candidates.push(candidate)
  }

  return candidates
}

function extractJsonArray(raw: string): string | undefined {
  if (!raw) return undefined
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return undefined
  return raw.slice(start, end + 1)
}

function normaliseCandidate(
  item: unknown,
  ctx: ObserverBackendContext | undefined,
  observationIds: string[],
): InstinctCandidate | undefined {
  if (!item || typeof item !== 'object') return undefined
  const record = item as Record<string, unknown>

  const trigger = stringField(record.trigger, 80)
  const action = stringField(record.action, 120)
  if (!trigger || !action) return undefined

  const evidence = evidenceField(record.evidence)
  if (evidence.length === 0) return undefined

  return {
    trigger,
    action,
    confidence: clampUnitInterval(record.confidence),
    domain: domainField(record.domain),
    source: 'session-observation',
    scope: scopeField(record.scope),
    projectId: ctx?.project?.projectId,
    projectName: ctx?.project?.projectName,
    evidence,
    observationIds,
  }
}

function stringField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

function clampUnitInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function domainField(value: unknown): InstinctDomain {
  if (typeof value !== 'string') return 'project'
  return (INSTINCT_DOMAINS as readonly string[]).includes(value)
    ? (value as InstinctDomain)
    : 'project'
}

function scopeField(value: unknown): SkillLearningScope {
  return value === 'global' ? 'global' : 'project'
}

function evidenceField(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const entries: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (!trimmed) continue
    entries.push(trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed)
    if (entries.length === 3) break
  }
  return entries
}

function makeTimeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms)
}
