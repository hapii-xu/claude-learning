/**
 * generateRecap — 按需生成的"离开期间"会话回顾。
 *
 * 实现对应官方 v2.1.123 的 tt8() 函数：
 *   - 读取 getLastCacheSafeParams()（每个 turn 后设置）以共享 prompt cache
 *   - 使用 recap prompt fork 出一个单轮 query
 *   - 返回一个可辨识联合类型：ok / api-error / no-turn / aborted / failed
 *
 * 该 fork 使用 skipTranscript + skipCacheWrite 保持临时性，避免
 * 污染主会话日志或创建不必要的缓存条目。
 */

import { APIUserAbortError } from '@anthropic-ai/sdk'
import { logForDebugging } from '../../utils/debug.js'
import {
  getLastCacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import {
  createUserMessage,
  getAssistantMessageText,
} from '../../utils/messages.js'

// 对应官方 v2.1.123 中的 G$9 常量：
// "以目标 + 当前任务开头，然后一个下一步行动，≤40 词，无 markdown"
const RECAP_PROMPT_EN =
  'The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. Lead with the overall goal and current task, then the one next action. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.'

const RECAP_PROMPT_ZH =
  '用户离开后回来了。用中文写 1-2 句话，不超过 60 字，无 markdown。先说明高层目标和当前任务，再说明下一步操作。跳过根因分析和次要待办。'

export type RecapResult =
  | { kind: 'ok'; text: string }
  | { kind: 'api-error'; text: string }
  | { kind: 'no-turn' }
  | { kind: 'aborted' }
  | { kind: 'failed' }

async function getRecapPrompt(): Promise<string> {
  try {
    const { getResolvedLanguage } = await import('../../utils/language.js')
    return getResolvedLanguage() === 'zh' ? RECAP_PROMPT_ZH : RECAP_PROMPT_EN
  } catch {
    return RECAP_PROMPT_EN
  }
}

/**
 * 生成当前会话的一句话回顾。
 * 使用上一轮缓存的 CacheSafeParams，使请求可以与主循环共享
 * prompt-cache 前缀。
 *
 * @param signal - 用于取消进行中请求的 AbortSignal
 * @returns RecapResult 可辨识联合类型
 */
export async function generateRecap(signal: AbortSignal): Promise<RecapResult> {
  const cacheSafeParams = getLastCacheSafeParams()
  if (!cacheSafeParams) {
    logForDebugging('[recap] no CacheSafeParams saved, skipping')
    return { kind: 'no-turn' }
  }

  // 包装父级 signal，以便我们能够独立地中断内部请求
  const inner = new AbortController()
  signal.addEventListener('abort', () => inner.abort(), { once: true })

  try {
    const { messages } = await runForkedAgent({
      promptMessages: [createUserMessage({ content: await getRecapPrompt() })],
      cacheSafeParams,
      canUseTool: async () => ({
        behavior: 'deny' as const,
        message: 'Recap cannot use tools',
        decisionReason: { type: 'other' as const, reason: 'away_summary' },
      }),
      overrides: { abortController: inner },
      querySource: 'away_summary',
      forkLabel: 'away_summary',
      maxTurns: 1,
      skipCacheWrite: true,
      skipTranscript: true,
    })

    if (signal.aborted) {
      return { kind: 'aborted' }
    }

    // 检查消息列表中是否存在 API 错误响应
    const errorMsg = messages.find(
      m => m.type === 'assistant' && m.isApiErrorMessage,
    )
    if (errorMsg) {
      return {
        kind: 'api-error',
        text: getAssistantMessageText(errorMsg) ?? '',
      }
    }

    // 从最后一条 assistant 消息中提取文本
    const assistantMsg = messages
      .filter(m => m.type === 'assistant' && !m.isApiErrorMessage)
      .pop()

    if (!assistantMsg) {
      return { kind: 'failed' }
    }

    const text = getAssistantMessageText(assistantMsg)
    if (!text || text.trim().length === 0) {
      return { kind: 'failed' }
    }

    return { kind: 'ok', text: text.trim() }
  } catch (err) {
    if (
      err instanceof APIUserAbortError ||
      signal.aborted ||
      inner.signal.aborted
    ) {
      return { kind: 'aborted' }
    }
    logForDebugging(`[recap] generation failed: ${err}`)
    return { kind: 'failed' }
  }
}
