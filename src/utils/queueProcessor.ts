import type { QueuedCommand } from '../types/textInputTypes.js'
import {
  dequeue,
  dequeueAllMatching,
  hasCommandsInQueue,
  peek,
} from './messageQueueManager.js'

type ProcessQueueParams = {
  executeInput: (commands: QueuedCommand[]) => Promise<void>
}

type ProcessQueueResult = {
  processed: boolean
}

/**
 * 检查队列中的命令是否为斜杠命令（值以 '/' 开头）。
 */
function isSlashCommand(cmd: QueuedCommand): boolean {
  if (typeof cmd.value === 'string') {
    return (
      cmd.value.trim().startsWith('/') &&
      (!cmd.skipSlashCommands || cmd.bridgeOrigin === true)
    )
  }
  // 对于 ContentBlockParam[]，检查第一个文本块
  for (const block of cmd.value) {
    if (block.type === 'text') {
      return (
        block.text.trim().startsWith('/') &&
        (!cmd.skipSlashCommands || cmd.bridgeOrigin === true)
      )
    }
  }
  return false
}

/**
 * 处理队列中的命令。
 *
 * 斜杠命令（以 '/' 开头）和 bash 模式命令逐个处理，
 * 使每个命令单独经过 executeInput 路径。Bash 命令需要
 * 逐命令的错误隔离、退出码和进度 UI。其他非斜杠命令
 * 批量处理：所有与最高优先级项**同模式**的项一次性排空，
 * 作为单个数组传递给 executeInput — 每个项成为自己的
 * 用户消息，拥有自己的 UUID。不同模式（如 prompt 与
 * task-notification）永不混合，因为下游处理不同。
 *
 * 调用方负责确保当前没有查询运行，
 * 并在每个命令完成后再次调用此函数，直到队列为空。
 *
 * @returns 包含处理状态的结果
 */
export function processQueueIfReady({
  executeInput,
}: ProcessQueueParams): ProcessQueueResult {
  // 此处理器在 REPL 主线程的轮次之间运行。跳过任何
  // 发给子 agent 的命令 — 未过滤的 peek() 返回子 agent
  // 通知会设置 targetMode，dequeueAllMatching 会找不到
  // 与该模式匹配且 agentId===undefined 的项，我们会返回
  // processed: false 而队列未变 → React effect 永不再触发，
  // 任何排队的用户提示永久停滞。
  const isMainThread = (cmd: QueuedCommand) => cmd.agentId === undefined

  const next = peek(isMainThread)
  if (!next) {
    return { processed: false }
  }

  // 斜杠命令和 bash 模式命令逐个处理。
  // Bash 命令需要逐命令的错误隔离、退出码和进度 UI。
  if (isSlashCommand(next) || next.mode === 'bash') {
    const cmd = dequeue(isMainThread)!
    void executeInput([cmd])
    return { processed: true }
  }

  // 一次性排空所有同模式的非斜杠命令项。
  const targetMode = next.mode
  const commands = dequeueAllMatching(
    cmd => isMainThread(cmd) && !isSlashCommand(cmd) && cmd.mode === targetMode,
  )
  if (commands.length === 0) {
    return { processed: false }
  }

  void executeInput(commands)
  return { processed: true }
}

/**
 * 检查队列是否有待处理命令。
 * 用于决定是否应触发队列处理。
 */
export function hasQueuedCommands(): boolean {
  return hasCommandsInQueue()
}
