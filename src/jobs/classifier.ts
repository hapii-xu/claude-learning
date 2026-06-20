import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AssistantMessage } from '../types/message.js'

/**
 * 从本轮的助手消息中对任务状态进行分类，并更新 state.json。
 *
 * 由 stopHooks.ts 在每次 repl_main_thread 轮次后调用（当设置了 CLAUDE_JOB_DIR 时）。
 * 只有主线程会调用此函数（子代理不会）。
 *
 * @param jobDir - 任务目录的路径（来自 CLAUDE_JOB_DIR 环境变量）
 * @param assistantMessages - 本轮的助手消息
 */
export async function classifyAndWriteState(
  jobDir: string,
  assistantMessages: AssistantMessage[],
): Promise<void> {
  const stateFile = join(jobDir, 'state.json')

  let state: Record<string, unknown>
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf-8'))
  } catch {
    // 没有 state 文件或已损坏——不是有效的任务目录
    return
  }

  const newStatus = classifyStatus(assistantMessages)
  state.status = newStatus
  state.updatedAt = new Date().toISOString()

  writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8')
}

/**
 * 根据助手消息确定任务状态。
 *
 * - 有 tool_use 块 → 仍在运行（工具正在执行）
 * - stop_reason === 'end_turn' → 已完成（模型已结束）
 * - 否则 → 运行中
 */
function classifyStatus(messages: AssistantMessage[]): string {
  if (messages.length === 0) return 'running'

  const lastMessage = messages[messages.length - 1]!
  const content = lastMessage.message?.content

  // 检查最后一条消息是否包含 tool_use 块（仍在执行）
  if (Array.isArray(content)) {
    const hasToolUse = content.some(
      block =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'tool_use',
    )
    if (hasToolUse) return 'running'
  }

  // 通过索引签名检查 stop_reason
  const stopReason = (lastMessage.message as Record<string, unknown>)
    ?.stop_reason
  if (stopReason === 'end_turn') return 'completed'
  if (stopReason === 'max_tokens') return 'running'

  return 'running'
}
