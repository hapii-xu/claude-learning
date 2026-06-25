import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import { registerPostSamplingHook } from '../../utils/hooks/postSamplingHooks.js'
import { getSkillLearningConfig } from './config.js'
import { isSkillLearningEnabled } from './featureCheck.js'
import {
  appendObservation,
  getSkillLearningRoot,
  purgeOldObservations,
  stringifyField,
} from './observationStore.js'
import { resolveProjectContext } from './projectContext.js'
import './sessionObserver.js'
import { createInstinct } from './instinctParser.js'
import {
  analyzeWithActiveBackend,
  resolveDefaultObserverBackend,
} from './observerBackend.js'
import {
  decayInstinctConfidence,
  loadInstincts,
  prunePendingInstincts,
  upsertInstinct,
} from './instinctStore.js'
import type { StoredSkillObservation } from './observationStore.js'
import type { Message } from '../../types/message.js'
import {
  applySkillLifecycleDecision,
  compareExistingArtifacts,
  decideSkillLifecycle,
} from './skillLifecycle.js'
import {
  generateAgentCandidates,
  generateCommandCandidates,
  clusterInstincts,
} from './evolution.js'
import { generateOrMergeSkillDraft } from './skillGenerator.js'
import { shouldGenerateSkillFromInstincts } from './learningPolicy.js'
import { writeLearnedCommand } from './commandGenerator.js'
import { writeLearnedAgent } from './agentGenerator.js'
import { readObservations } from './observationStore.js'
import { checkPromotion } from './promotion.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { CLAUDE_DIR_NAME } from 'src/constants/claudeDirName.js'

export const RUNTIME_SESSION_ID = 'runtime-session'

let initialized = false
let runtimeTurn = 0
// tool-hook observations 的消费时间戳水位线——仅重放上一次 post-sampling 之后到达的记录。
let lastConsumedToolHookTimestamp = ''

// --- H5: LLM 调用节流 ---
let llmCallsThisSession = 0
let lastLlmCallTimestamp = 0

// --- H6: 消息水位线去重 ---
// 键格式：`${sessionId}:${messageId}`——防止在同一 REPL 会话的多次 post-sampling 调用中重复处理同一消息。
const lastProcessedMessageIds = new Set<string>()
const MAX_PROCESSED_IDS = 1000
const TRIM_PROCESSED_IDS_TO = 500

export function resetRuntimeLLMBookkeeping(): void {
  llmCallsThisSession = 0
  lastLlmCallTimestamp = 0
  lastProcessedMessageIds.clear()
}

export function getRuntimeTurn(): number {
  return runtimeTurn
}

export function initSkillLearning(): void {
  if (initialized) return
  initialized = true
  // 从 SKILL_LEARNING_OBSERVER_BACKEND 环境变量解析活跃的 observer backend。
  // 若不调用此函数，注册表会停留在最先注册的 backend（heuristic）上——
  // 这意味着环境变量的切换在生产环境中会静默失效。
  // 吞掉注册表错误，防止环境变量拼写错误导致启动崩溃。
  try {
    resolveDefaultObserverBackend()
  } catch {
    // 尚未注册任何 backend，或环境变量指向未知名称——保留注册表现有状态。
  }
  registerPostSamplingHook(runSkillLearningPostSampling)
  // fire-and-forget 启动维护：ECC 校验置信度衰减、observation 清理、pending instinct 修剪。
  // 吞掉错误，确保 skill-learning 维护任务永不阻塞 CLI 启动。
  void runStartupMaintenance().catch(() => {})
}

async function runStartupMaintenance(): Promise<void> {
  if (!isSkillLearningEnabled()) return
  if (process.env.CLAUDE_SKILL_LEARNING_DISABLE) return
  const project = resolveProjectContext(process.cwd())
  const options = { project }
  await Promise.allSettled([
    decayInstinctConfidence(options),
    purgeOldObservations(options),
    prunePendingInstincts(30, options),
  ])
}

function isInsideSkillLearningStorage(cwd: string): boolean {
  try {
    const root = getSkillLearningRoot()
    return cwd.startsWith(root)
  } catch {
    return false
  }
}

export async function runSkillLearningPostSampling(
  context: REPLHookContext,
): Promise<void> {
  if (!isSkillLearningEnabled()) return
  // 自过滤层级顺序：env 退出开关、入口点（仅限主 REPL 线程——
  // `startsWith` 覆盖 'repl_main_thread:outputStyle:<name>'）、
  // sub-agent 跳过，以及路径守卫（防止用户手动编辑 skill-learning
  // 存储目录内文件时产生反馈循环）。
  if (process.env.CLAUDE_SKILL_LEARNING_DISABLE) return
  if (!context.querySource?.startsWith('repl_main_thread')) return
  if (context.toolUseContext.agentId) return
  const cwd = process.cwd()
  if (isInsideSkillLearningStorage(cwd)) return

  const project = resolveProjectContext(cwd)
  const options = { project }
  ++runtimeTurn

  const observations: StoredSkillObservation[] = []

  // 始终从 REPL 消息流重建——它是唯一能捕获用户提示和助手输出的来源
  //（tool-hook observations 仅覆盖 tool 事件）。
  for (const observation of observationsFromMessages(
    context.messages,
    project,
  )) {
    observations.push(await appendObservation(observation, options))
  }

  // 此外拉取自上次消费水位线以来到达的 tool-hook observations——
  // 这些是具有精确结果的确定性记录。
  const all = await readObservations(options)
  const fresh = all.filter(
    o =>
      o.source === 'tool-hook' &&
      o.sessionId === RUNTIME_SESSION_ID &&
      typeof o.timestamp === 'string' &&
      o.timestamp > lastConsumedToolHookTimestamp,
  )
  observations.push(...fresh)
  for (const o of fresh) {
    if (o.timestamp > lastConsumedToolHookTimestamp) {
      lastConsumedToolHookTimestamp = o.timestamp
    }
  }

  if (observations.length === 0) return

  // H5：节流 LLM 调用——最小 observation 数量、每会话上限及防抖间隔。
  // 任一门控触发时，直接回退到 heuristic。
  const now = Date.now()
  const minObservations = 5
  const { llm } = getSkillLearningConfig()
  const shouldCallLLM =
    observations.length >= minObservations &&
    llmCallsThisSession < llm.maxCallsPerSession &&
    now - lastLlmCallTimestamp >= llm.cooldownMs

  let candidates
  if (shouldCallLLM) {
    llmCallsThisSession++
    lastLlmCallTimestamp = now
    candidates = await analyzeWithActiveBackend(observations, { project })
  } else {
    // 回退到 heuristic backend，不消耗 LLM 调用额度。
    const { heuristicObserverBackend } = await import('./sessionObserver.js')
    const result = heuristicObserverBackend.analyze(observations, { project })
    candidates = Array.isArray(result) ? result : await result
  }

  for (const candidate of candidates) {
    await upsertInstinct(createInstinct(candidate), options)
  }

  await autoEvolveLearnedSkills(options)
}

export function resetRuntimeObserverForTest(): void {
  runtimeTurn = 0
  lastConsumedToolHookTimestamp = ''
  resetRuntimeLLMBookkeeping()
}

async function autoEvolveLearnedSkills(options: {
  project: ReturnType<typeof resolveProjectContext>
}): Promise<void> {
  const instincts = await loadInstincts(options)
  const cwd = process.cwd()

  const skillRoots = [
    join(cwd, CLAUDE_DIR_NAME, 'skills'),
    join(getClaudeConfigHomeDir(), 'skills'),
  ]
  const skillClusters = clusterInstincts(instincts).filter(
    candidate =>
      candidate.target === 'skill' &&
      shouldGenerateSkillFromInstincts(candidate.instincts),
  )
  for (const cluster of skillClusters) {
    const outcome = await generateOrMergeSkillDraft(
      cluster.instincts,
      { cwd, scope: cluster.instincts[0]?.scope ?? 'project' },
      skillRoots,
    )
    if (outcome.action === 'append-evidence') continue
    const draft = outcome.draft
    if (existsSync(join(draft.outputPath, 'SKILL.md'))) continue
    const existing = await compareExistingArtifacts('skill', draft, skillRoots)
    const decision = decideSkillLifecycle(draft, existing)
    await applySkillLifecycleDecision(decision)
  }

  const commandDrafts = generateCommandCandidates(instincts, { cwd })
  for (const draft of commandDrafts) {
    const roots = [
      join(cwd, CLAUDE_DIR_NAME, 'commands'),
      join(getClaudeConfigHomeDir(), 'commands'),
    ]
    const existing = await compareExistingArtifacts('command', draft, roots)
    if (existing.length > 0) continue
    await writeLearnedCommand(draft)
  }

  const agentDrafts = generateAgentCandidates(instincts, { cwd })
  for (const draft of agentDrafts) {
    const roots = [
      join(cwd, CLAUDE_DIR_NAME, 'agents'),
      join(getClaudeConfigHomeDir(), 'agents'),
    ]
    const existing = await compareExistingArtifacts('agent', draft, roots)
    if (existing.length > 0) continue
    await writeLearnedAgent(draft)
  }

  await checkPromotion()
}

function observationsFromMessages(
  messages: Message[],
  project: ReturnType<typeof resolveProjectContext>,
): StoredSkillObservation[] {
  const sessionId = RUNTIME_SESSION_ID
  const base = {
    sessionId,
    projectId: project.projectId,
    projectName: project.projectName,
    cwd: project.cwd,
    timestamp: new Date().toISOString(),
    source: 'hook' as const,
  }

  return messages.flatMap((message): StoredSkillObservation[] => {
    // H6：水位线去重——跳过本会话中已处理过的消息。
    const msgKey = `${sessionId}:${String(message.uuid)}`
    if (lastProcessedMessageIds.has(msgKey)) return []
    lastProcessedMessageIds.add(msgKey)
    // FIFO 截断以维持 Set 有界。精确缩减至 TRIM_PROCESSED_IDS_TO 条
    //（差一修复：之前因减法未计入刚添加的条目而留下 size+1）。
    if (lastProcessedMessageIds.size > MAX_PROCESSED_IDS) {
      const toDrop = lastProcessedMessageIds.size - TRIM_PROCESSED_IDS_TO
      const iter = lastProcessedMessageIds.values()
      for (let i = 0; i < toDrop; i++) {
        const next = iter.next()
        if (next.done) break
        lastProcessedMessageIds.delete(next.value)
      }
    }

    if (message.type === 'user') {
      const toolResults = toolResultsFromContent(message.message?.content)
      if (toolResults.length > 0) {
        return toolResults.map(result => ({
          ...base,
          id: crypto.randomUUID(),
          event: 'tool_complete',
          toolName: result.toolName,
          toolOutput: result.output,
          outcome: result.isError ? 'failure' : 'success',
        }))
      }
      const text = textFromContent(message.message?.content)
      return text.trim()
        ? [
            {
              ...base,
              id: crypto.randomUUID(),
              event: 'user_message',
              messageText: text,
            },
          ]
        : []
    }

    if (message.type === 'assistant') {
      const toolUses = toolUsesFromContent(message.message?.content)
      const text = textFromContent(message.message?.content)
      return [
        ...toolUses.map(toolUse => ({
          ...base,
          id: crypto.randomUUID(),
          event: 'tool_start' as const,
          toolName: toolUse.toolName,
          toolInput: toolUse.input,
        })),
        ...(text.trim()
          ? [
              {
                ...base,
                id: crypto.randomUUID(),
                event: 'assistant_message' as const,
                messageText: text,
              },
            ]
          : []),
      ]
    }

    return []
  })
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (!block || typeof block !== 'object') return ''
      const record = block as Record<string, unknown>
      return typeof record.text === 'string' ? record.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

function toolUsesFromContent(
  content: unknown,
): Array<{ toolName: string; input?: string }> {
  if (!Array.isArray(content)) return []
  return content.flatMap(block => {
    if (!block || typeof block !== 'object') return []
    const record = block as Record<string, unknown>
    if (record.type !== 'tool_use') return []
    return [
      {
        toolName: String(record.name ?? 'unknown_tool'),
        input: stringifyField(record.input),
      },
    ]
  })
}

function toolResultsFromContent(
  content: unknown,
): Array<{ toolName: string; output?: string; isError: boolean }> {
  if (!Array.isArray(content)) return []
  return content.flatMap(block => {
    if (!block || typeof block !== 'object') return []
    const record = block as Record<string, unknown>
    if (record.type !== 'tool_result') return []
    return [
      {
        toolName: String(record.name ?? record.tool_name ?? 'unknown_tool'),
        output: stringifyField(record.content),
        isError: record.is_error === true,
      },
    ]
  })
}
