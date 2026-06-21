// 深度集成后端：从 live session 解析 agent/model/tools，委托给核心 runAgent。
// 实现 AgentAdapter 接口，由 registry 注册并路由（U5）。
import {
  type AgentAdapter,
  type AgentAdapterContext,
  type AgentRunParams,
  type AgentRunResult,
  WorkflowAbortedError,
} from '@claude-code-best/workflow-engine'
import { assembleToolPool } from '../../tools.js'
import { finalizeAgentTool } from '@claude-code-best/builtin-tools/tools/AgentTool/agentToolUtils.js'
import { runAgent } from '@claude-code-best/builtin-tools/tools/AgentTool/runAgent.js'
import {
  isBuiltInAgent,
  type AgentDefinition,
  type BuiltInAgentDefinition,
} from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { createUserMessage, extractTextContent } from '../../utils/messages.js'
import { getTokenCountFromUsage } from '../../utils/tokens.js'
import { createHash } from 'node:crypto'
import { createAgentId } from '../../utils/uuid.js'
import { logForDebugging } from '../../utils/debug.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import {
  createAgentWorktree,
  hasWorktreeChanges,
  removeAgentWorktree,
} from '../../utils/worktree.js'
import { logEvent } from '../../services/analytics/index.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import type { Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { readHostBundle } from '../hostHandle.js'

/** workflow subagent 的兜底定义（当 agentType 未命中真实 registry 条目时使用）。 */
export const WORKFLOW_AGENT: BuiltInAgentDefinition = {
  agentType: 'workflow-worker',
  whenToUse: 'subtask dispatched by the agent() hook inside a workflow script',
  tools: ['*'],
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () =>
    'You are a workflow sub-agent. Complete the task concisely; your final text is the return value relayed to the workflow.',
}

/** agentType -> 真实 agent registry（activeAgents 命中时使用，否则兜底）。导出供单元测试覆盖。 */
export function resolveAgentDefinition(
  agentType: string | undefined,
  toolUseContext: ToolUseContext,
): AgentDefinition {
  if (!agentType) return WORKFLOW_AGENT
  const found = toolUseContext.options.agentDefinitions.activeAgents.find(
    a => a.agentType === agentType,
  )
  return found ?? WORKFLOW_AGENT
}

/** model alias -> 当前 provider 的真实 model id。v1 直接透传（保留映射扩展点）。导出供单元测试覆盖。 */
export function mapWorkflowModel(
  model: string | undefined,
): string | undefined {
  return model
}

/**
 * 从 agent 的最终消息中抽取 schema 模式下产出的 JSON 对象；失败时返回 null。导出供单元测试覆盖。
 *
 * 健壮性策略（按优先级，返回第一个成功解析的结果）：
 * 1. 带围栏的代码块（```json ... ``` 或 ``` ... ```）—— agent 经常自发地加上围栏
 * 2. 裸文本中第一个"括号平衡"的 {...} 片段 —— 处理前后叙事 / 多段输出
 *
 * 使用括号栈扫描而非 `indexOf('{')..lastIndexOf('}')`：能正确处理嵌套对象、
 * 字符串字面量中的 `{}` 以及转义字符。不会把多个不相关的 JSON 片段拼起来（旧版本会这么干）。
 *
 * 不做语法修复（尾随逗号、单引号 -> 双引号、删除注释）—— agent 不会产出非标准 JSON，
 * 修复反而可能在字符串内部造成错误改动（例如 `"http://..."` 被 // 注释正则吞掉）。
 * 解析失败时直接跳到下一个候选。
 *
 * 只返回普通对象（typeof === 'object' && !null && !Array）；
 * schema 模式契约是对象，array/number/string 都视为 agent 偏离。
 */
export function extractStructuredOutput(
  content: Array<{ type: string; text?: string }>,
): unknown | null {
  for (const block of content) {
    if (block.type !== 'text' || !block.text) continue
    const found = findFirstJsonObject(block.text)
    if (found !== null) return found
  }
  return null
}

/** 在文本中找到第一个可被解析为普通对象的 JSON 片段。 */
function findFirstJsonObject(text: string): unknown | null {
  // 1. 围栏代码块 —— 优先（agent 天然倾向于加围栏；剥掉围栏后整体解析）
  for (const m of text.matchAll(
    /```[\t ]*[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```/g,
  )) {
    const parsed = tryParseObject(m[1] ?? '')
    if (parsed !== null) return parsed
  }
  // 2. 裸文本：扫描每个 '{'，找到平衡配对并尝试解析
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    const end = findBalancedObjectEnd(text, i)
    if (end < 0) continue
    const parsed = tryParseObject(text.slice(i, end + 1))
    if (parsed !== null) return parsed
  }
  return null
}

/**
 * 从 start（必须是 `{`）开始，找到与之配对的 `}` 索引；不平衡时返回 -1。
 * 跳过字符串字面量内的括号和转义字符。不跳过注释（JSON 标准不允许注释，
 * agent 也不会产出；这会是一个风险 —— 见函数 doc）。
 */
function findBalancedObjectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\')
        i++ // 跳过转义字符以及下一个字符
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 尝试解析候选；只返回普通对象，其他（array/number/null）返回 null。 */
function tryParseObject(candidate: string): unknown | null {
  const trimmed = candidate.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  try {
    const v = JSON.parse(trimmed)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

type WorkflowWorktreeInfo = Awaited<ReturnType<typeof createAgentWorktree>>

/**
 * 为 workflow agent 的 worktree 隔离生成 slug：从 sha256(runId:agentId) 截取 hex 段，
 * 与 cleanupStaleAgentWorktrees 的清理正则 `^wf_[0-9a-f]{8}-[0-9a-f]{3}-\d+$` 保持一致。
 * taskId 是 `w`+base36（不是 UUID），无法直接放进正则段；sha256 是确定性映射，
 * agentId 保证同一 runId 下多个 agent 的 slug 唯一（无共享计数器、无线程安全问题）。
 */
function makeWorkflowWorktreeSlug(runId: string, agentId: string): string {
  const h = createHash('sha256').update(`${runId}:${agentId}`).digest('hex')
  return `wf_${h.slice(0, 8)}-${h.slice(8, 11)}-${parseInt(h.slice(11, 17), 16) % 100000}`
}

/**
 * agent 结束后清理 worktree：hookBased 保留（无法探测 VCS 变更）；否则用
 * hasWorktreeChanges（fail-closed）探测，无变更时自动移除，有变更/探测失败时保留
 * 并记录路径（v1 用日志而非扩展 AgentRunResult，以避免触动 journal 序列化）。
 */
async function cleanupWorkflowWorktree(
  info: WorkflowWorktreeInfo,
  agentType: string,
): Promise<void> {
  if (info.hookBased || !info.headCommit) return
  let changed = true
  try {
    changed = await hasWorktreeChanges(info.worktreePath, info.headCommit)
  } catch (e) {
    logForDebugging(
      `workflow worktree change-detect failed (${agentType}): ${(e as Error).message}`,
    )
    changed = true
  }
  if (!changed) {
    try {
      await removeAgentWorktree(
        info.worktreePath,
        info.worktreeBranch,
        info.gitRoot,
      )
    } catch (e) {
      logForDebugging(
        `workflow worktree remove failed (${agentType}): ${(e as Error).message}`,
      )
    }
  } else {
    logForDebugging(
      `workflow worktree retained (has changes, ${agentType}): ${info.worktreePath}`,
    )
  }
}

/** 深度集成后端：从 live session 解析 agent/model/tools，委托给核心 runAgent。 */
export const claudeCodeBackend: AgentAdapter = {
  id: 'claude-code',
  capabilities: { structuredOutput: true, tools: true },

  async run(
    params: AgentRunParams,
    ctx: AgentAdapterContext,
  ): Promise<AgentRunResult> {
    const { toolUseContext, canUseTool } = readHostBundle(ctx.host)
    const appState = toolUseContext.getAppState()
    const agentDef = resolveAgentDefinition(params.agentType, toolUseContext)
    const model = mapWorkflowModel(params.model)
    // coreAgentId：核心层 subagent 的跟踪 ID（一个字符串，在 runAgent 内部使用）。
    // 与 ctx.agentId（引擎的数字 seq，用于面板 / killAgent 路由）是不同概念 —— 不能混用。
    const coreAgentId = createAgentId()

    // isolation:'worktree' —— 在独立 git worktree 内运行 agent，避免并发写入冲突。
    let worktreeInfo: WorkflowWorktreeInfo | null = null
    if (params.isolation === 'worktree') {
      try {
        worktreeInfo = await createAgentWorktree(
          makeWorkflowWorktreeSlug(ctx.runId, coreAgentId),
        )
      } catch (e) {
        // fail-closed：隔离失败时不要静默回退到共享 cwd（否则并发写入会在数据上竞争）
        const detail = (e as Error).message
        logForDebugging(
          `workflow worktree creation failed (${agentDef.agentType}): ${detail}`,
        )
        return { kind: 'dead', reason: 'worktree-failed', detail }
      }
    }
    // runWithCwdOverride 让 agent 内部的 Bash/Read 等工具看到 worktree 路径
    //（AsyncLocalStorage 跨 await 保留）；runAgent 的 worktreePath 参数只写元数据。
    const runInCwd = worktreeInfo
      ? <T>(fn: () => T): T =>
          runWithCwdOverride(worktreeInfo!.worktreePath, fn)
      : <T>(fn: () => T): T => fn()

    // 把 ctx.signal 桥接到 runAgent.override.abortController。否则当 workflow 被杀时，
    // runAgent 毫无感知（这是 'x' 失效的根因）：abort 信号到不了内部 fetch，agent 会跑完。
    // 单 agent kill 走的是 service.kill(runId, agentId) -> ports.taskRegistrar.killAgent ->
    // agentAbortControllers.get(agentId).abort()；两条路径由同一个 controller 接管。
    const agentAbort = new AbortController()
    const onParentAbort = (): void => agentAbort.abort()
    if (ctx.signal.aborted) {
      agentAbort.abort()
    } else {
      ctx.signal.addEventListener('abort', onParentAbort, { once: true })
    }
    if (typeof ctx.registerAgentAbort === 'function') {
      ctx.registerAgentAbort(ctx.agentId, agentAbort)
    }

    const workerPermissionContext = {
      ...appState.toolPermissionContext,
      mode: agentDef.permissionMode ?? 'acceptEdits',
    }
    const workerTools = assembleToolPool(
      workerPermissionContext,
      appState.mcp.tools,
    )

    // schema -> 指示 agent 在最后的文本块里直接产出 JSON。
    // 不要求调用 StructuredOutput 工具 —— 它不在 workflow subagent 的工具集合中（只有
    // stop_hook 路径会显式注入；workflow 走 assembleToolPool，默认池不含它）。
    // 历史上 prompt 要求"调用 StructuredOutput 工具"，导致 12 个 agent 里有 8 个不愿收尾或挣扎着调用；
    // 经验上 dead 的主因是工具触达不到，而非"遗忘"。修改契约：原始 JSON 文本，extractStructuredOutput
    // 容忍围栏围栏 + 前后叙事 + 多段。
    const promptText = params.schema
      ? [
          params.prompt,
          '',
          'After completing the task, emit your final answer as a single JSON object matching this JSON Schema:',
          '```json',
          JSON.stringify(params.schema, null, 2),
          '```',
          '',
          'CRITICAL RULES:',
          '- The JSON object must be the LAST text block in your response. Do not write any prose after it.',
          '- Emit the JSON as plain text (markdown code fences optional).',
          '- Do NOT call any "StructuredOutput" or "SyntheticOutput" tool — it is not available in this environment.',
          '- Your turn must end with the JSON object. Anything after it (prose, tool calls) will be ignored or cause your answer to be discarded.',
        ].join('\n')
      : params.prompt

    const promptMessages = [createUserMessage({ content: promptText })]
    const messages: Message[] = []
    const startTime = Date.now()
    // 累计运行进度（onProgress push -> agent_progress 事件 -> 面板实时刷新 token/工具）。
    let tokenCount = 0
    let toolCount = 0

    try {
      await runInCwd(async () => {
        for await (const msg of runAgent({
          agentDefinition: agentDef,
          promptMessages,
          toolUseContext,
          canUseTool,
          isAsync: true,
          querySource: toolUseContext.options.querySource ?? 'workflow',
          availableTools: workerTools,
          // override 同一个对象：coreAgentId（核心 subagent 跟踪）+ abortController（kill 桥接）。
          // runAgent 的 model 是顶层 ModelAlias；workflow 的 model 是任意 alias 字符串，
          // 类型不兼容，由 provider 层在运行时解析。通过双重断言透传（比 as any/never 更好）。
          override: { agentId: coreAgentId, abortController: agentAbort },
          ...(model ? { model: model as unknown as ModelAlias } : {}),
          ...(worktreeInfo ? { worktreePath: worktreeInfo.worktreePath } : {}),
        })) {
          messages.push(msg as Message)
          // 累计运行进度：assistant 消息带 usage（累计值 -> 覆盖），content 内的 tool_use（增量）。
          if (msg.type === 'assistant' && msg.message) {
            const usage = msg.message.usage as
              | Parameters<typeof getTokenCountFromUsage>[0]
              | undefined
            if (usage) tokenCount = getTokenCountFromUsage(usage)
            const content = msg.message.content as
              | Array<{ type: string }>
              | undefined
            if (content)
              toolCount += content.filter(b => b.type === 'tool_use').length
          }
          ctx.onProgress?.({ tokenCount, toolCount })
        }
      })
    } catch (e) {
      // abort（杀 workflow / 杀 agent）：检测后必须重新抛出 WorkflowAbortedError，
      // 否则 hooks.agent 会把 abort 当成普通失败吞进 dead，workflow 也无法感知自己被杀了
      //（'x' kill 路径失效的另一面：信号确实到了，但结果被伪装成正常完成）。
      if (agentAbort.signal.aborted || (e as Error)?.name === 'AbortError') {
        throw new WorkflowAbortedError()
      }
      const detail = (e as Error).message
      logForDebugging(
        `workflow sub-agent error (${agentDef.agentType}): ${detail}`,
      )
      logEvent('tengu_workflow_agent', { ok: 0 })
      return { kind: 'dead', reason: 'runagent-threw', detail }
    } finally {
      // 清理（幂等）：listener removeEventListener / Map.delete 都可重复调用。
      if (typeof ctx.unregisterAgentAbort === 'function') {
        ctx.unregisterAgentAbort(ctx.agentId)
      }
      ctx.signal.removeEventListener('abort', onParentAbort)
      if (worktreeInfo) {
        const info = worktreeInfo
        worktreeInfo = null
        await cleanupWorkflowWorktree(info, agentDef.agentType)
      }
    }

    const finalized = finalizeAgentTool(messages, coreAgentId, {
      prompt: params.prompt,
      resolvedAgentModel: toolUseContext.options.mainLoopModel,
      isBuiltInAgent: isBuiltInAgent(agentDef),
      startTime,
      agentType: agentDef.agentType,
      isAsync: true,
    })
    const outputTokens =
      finalized.usage?.output_tokens ?? finalized.totalTokens ?? 0
    // 用于面板展示：总上下文 token、工具调用数、完成时解析出的 model id。
    const finalTokenCount = finalized.totalTokens ?? 0
    const finalToolCount = finalized.totalToolUseCount ?? 0
    const resolvedModel = model ?? toolUseContext.options.mainLoopModel
    logEvent('tengu_workflow_agent', { ok: 1, outputTokens })

    if (params.schema) {
      const structured = extractStructuredOutput(finalized.content)
      if (structured === null) {
        // agent 跑完了所有工具调用，但最后的文本块里没有可解析的普通对象 JSON。
        // 典型场景：一长串工具链之后忘记产出 JSON、JSON 嵌套不平衡、解析失败。
        // 把最后一段文本的预览放进 detail，让 hooks 重试日志和面板能立即看到 agent 到底说了什么。
        const preview = extractTextContent(finalized.content, '\n').slice(
          0,
          200,
        )
        logForDebugging(
          `workflow sub-agent produced no JSON object (${agentDef.agentType}); preview: ${preview}`,
        )
        return {
          kind: 'dead',
          reason: 'no-structured-output',
          detail: preview,
        }
      }
      return {
        kind: 'ok',
        output: structured as object,
        usage: { outputTokens },
        model: resolvedModel,
        toolCount: finalToolCount,
        tokenCount: finalTokenCount,
      }
    }
    const text = extractTextContent(finalized.content, '\n')
    return {
      kind: 'ok',
      output: text,
      usage: { outputTokens },
      model: resolvedModel,
      toolCount: finalToolCount,
      tokenCount: finalTokenCount,
    }
  },
}
