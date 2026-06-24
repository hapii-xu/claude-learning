import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { Permutations } from 'src/types/utils.js'
import { getSessionId } from '../bootstrap/state.js'
import type { AppState } from '../state/AppState.js'
import type {
  QueueOperation,
  QueueOperationMessage,
} from '../types/messageQueueTypes.js'
import type {
  EditablePromptInputMode,
  PromptInputMode,
  QueuedCommand,
  QueuePriority,
} from '../types/textInputTypes.js'
import type { PastedContent } from './config.js'
import { extractTextContent } from './messages.js'
import { objectGroupBy } from './objectGroupBy.js'
import { recordQueueOperation } from './sessionStorage.js'
import { createSignal } from './signal.js'

export type SetAppState = (f: (prev: AppState) => AppState) => void

// ============================================================================
// 日志辅助
// ============================================================================

function logOperation(operation: QueueOperation, content?: string): void {
  const sessionId = getSessionId()
  const queueOp: QueueOperationMessage = {
    type: 'queue-operation',
    operation,
    timestamp: new Date().toISOString(),
    sessionId,
    ...(content !== undefined && { content }),
  }
  void recordQueueOperation(queueOp)
}

// ============================================================================
// 统一命令队列（模块级，独立于 React 状态）
//
// 所有命令——用户输入、任务通知、孤立权限——均通过此单一队列处理。
// React 组件通过 useSyncExternalStore 订阅
//（subscribeToCommandQueue / getCommandQueueSnapshot）。
// 非 React 代码（print.ts 流式循环）直接通过
// getCommandQueue() / getCommandQueueLength() 读取。
//
// 优先级决定出队顺序：'now' > 'next' > 'later'。
// 相同优先级内，命令按 FIFO 处理。
// ============================================================================

const commandQueue: QueuedCommand[] = []
/** 冻结快照——每次变更时重建，供 useSyncExternalStore 使用。 */
let snapshot: readonly QueuedCommand[] = Object.freeze([])
const queueChanged = createSignal()

function notifySubscribers(): void {
  snapshot = Object.freeze([...commandQueue])
  queueChanged.emit()
}

// ============================================================================
// useSyncExternalStore 接口
// ============================================================================

/**
 * 订阅命令队列变更。
 * 与 React 的 useSyncExternalStore 兼容。
 */
export const subscribeToCommandQueue = queueChanged.subscribe

/**
 * 获取命令队列的当前快照。
 * 与 React 的 useSyncExternalStore 兼容。
 * 返回一个冻结数组，仅在变更时更改引用。
 */
export function getCommandQueueSnapshot(): readonly QueuedCommand[] {
  return snapshot
}

// ============================================================================
// 读取操作（供非 React 代码使用）
// ============================================================================

/**
 * 获取当前队列的可变副本。
 * 用于需要实际命令的一次性读取。
 */
export function getCommandQueue(): QueuedCommand[] {
  return [...commandQueue]
}

/**
 * 不复制地获取当前队列长度。
 */
export function getCommandQueueLength(): number {
  return commandQueue.length
}

/**
 * 检查队列中是否有命令。
 */
export function hasCommandsInQueue(): boolean {
  return commandQueue.length > 0
}

/**
 * 通过通知订阅者触发重新检查。
 * 在异步处理完成后使用，以确保 useSyncExternalStore 消费者
 * 能获取到剩余的命令。
 */
export function recheckCommandQueue(): void {
  if (commandQueue.length > 0) {
    notifySubscribers()
  }
}

// ============================================================================
// 写入操作
// ============================================================================

/**
 * 向队列添加命令。
 * 用于用户发起的命令（prompt、bash、孤立权限）。
 * 默认优先级为 'next'（在任务通知之前处理）。
 */
export function enqueue(command: QueuedCommand): void {
  commandQueue.push({ ...command, priority: command.priority ?? 'next' })
  notifySubscribers()
  logOperation(
    'enqueue',
    typeof command.value === 'string' ? command.value : undefined,
  )
}

/**
 * 向队列添加任务通知。
 * 便捷包装器，默认优先级为 'later'，确保用户输入不会被系统消息饿死。
 */
export function enqueuePendingNotification(command: QueuedCommand): void {
  commandQueue.push({ ...command, priority: command.priority ?? 'later' })
  notifySubscribers()
  logOperation(
    'enqueue',
    typeof command.value === 'string' ? command.value : undefined,
  )
}

const PRIORITY_ORDER: Record<QueuePriority, number> = {
  now: 0,
  next: 1,
  later: 2,
}

/**
 * 移除并返回最高优先级的命令，若队列为空则返回 undefined。
 * 相同优先级内，命令按 FIFO 出队。
 *
 * 可选的 `filter` 缩小候选范围：只考虑谓词返回 `true` 的命令。
 * 不匹配的命令保留在队列中不变。这使得轮次间的排空
 *（SDK、REPL）可以限制为主线程命令（`cmd.agentId === undefined`），
 * 而无需重构现有的 while 循环模式。
 */
export function dequeue(
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  if (commandQueue.length === 0) {
    return undefined
  }

  // 找到优先级最高的第一个命令（遵守过滤器）
  let bestIdx = -1
  let bestPriority = Infinity
  for (let i = 0; i < commandQueue.length; i++) {
    const cmd = commandQueue[i]!
    if (filter && !filter(cmd)) continue
    const priority = PRIORITY_ORDER[cmd.priority ?? 'next']
    if (priority < bestPriority) {
      bestIdx = i
      bestPriority = priority
    }
  }

  if (bestIdx === -1) return undefined

  const [dequeued] = commandQueue.splice(bestIdx, 1)
  notifySubscribers()
  logOperation('dequeue')
  return dequeued
}

/**
 * 移除并返回队列中的所有命令。
 * 为每条命令记录一次出队操作。
 */
export function dequeueAll(): QueuedCommand[] {
  if (commandQueue.length === 0) {
    return []
  }

  const commands = [...commandQueue]
  commandQueue.length = 0
  notifySubscribers()

  for (const _cmd of commands) {
    logOperation('dequeue')
  }

  return commands
}

/**
 * 不移除地返回最高优先级的命令，若队列为空则返回 undefined。
 * 接受可选的 `filter`——只考虑通过谓词的命令。
 */
export function peek(
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  if (commandQueue.length === 0) {
    return undefined
  }
  let bestIdx = -1
  let bestPriority = Infinity
  for (let i = 0; i < commandQueue.length; i++) {
    const cmd = commandQueue[i]!
    if (filter && !filter(cmd)) continue
    const priority = PRIORITY_ORDER[cmd.priority ?? 'next']
    if (priority < bestPriority) {
      bestIdx = i
      bestPriority = priority
    }
  }
  if (bestIdx === -1) return undefined
  return commandQueue[bestIdx]
}

/**
 * 移除并返回所有匹配谓词的命令，保持优先级顺序。
 * 不匹配的命令保留在队列中。
 */
export function dequeueAllMatching(
  predicate: (cmd: QueuedCommand) => boolean,
): QueuedCommand[] {
  const matched: QueuedCommand[] = []
  const remaining: QueuedCommand[] = []
  for (const cmd of commandQueue) {
    if (predicate(cmd)) {
      matched.push(cmd)
    } else {
      remaining.push(cmd)
    }
  }
  if (matched.length === 0) {
    return []
  }
  commandQueue.length = 0
  commandQueue.push(...remaining)
  notifySubscribers()
  for (const _cmd of matched) {
    logOperation('dequeue')
  }
  return matched
}

/**
 * 按引用标识从队列中移除特定命令。
 * 调用方必须传入队列中相同的对象引用（如来自 getCommandsByMaxPriority 的）。
 * 为每个命令记录一次 'remove' 操作。
 */
export function remove(commandsToRemove: QueuedCommand[]): void {
  if (commandsToRemove.length === 0) {
    return
  }

  const before = commandQueue.length
  for (let i = commandQueue.length - 1; i >= 0; i--) {
    if (commandsToRemove.includes(commandQueue[i]!)) {
      commandQueue.splice(i, 1)
    }
  }

  if (commandQueue.length !== before) {
    notifySubscribers()
  }

  for (const _cmd of commandsToRemove) {
    logOperation('remove')
  }
}

/**
 * 移除匹配谓词的命令。
 * 返回已移除的命令。
 */
export function removeByFilter(
  predicate: (cmd: QueuedCommand) => boolean,
): QueuedCommand[] {
  const removed: QueuedCommand[] = []
  for (let i = commandQueue.length - 1; i >= 0; i--) {
    if (predicate(commandQueue[i]!)) {
      removed.unshift(commandQueue.splice(i, 1)[0]!)
    }
  }

  if (removed.length > 0) {
    notifySubscribers()
    for (const _cmd of removed) {
      logOperation('remove')
    }
  }

  return removed
}

/**
 * 清除队列中的所有命令。
 * 供 ESC 取消功能用于丢弃已排队通知。
 */
export function clearCommandQueue(): void {
  if (commandQueue.length === 0) {
    return
  }
  commandQueue.length = 0
  notifySubscribers()
}

/**
 * 清除所有命令并重置快照。
 * 用于测试清理。
 */
export function resetCommandQueue(): void {
  commandQueue.length = 0
  snapshot = Object.freeze([])
}

// ============================================================================
// 可编辑模式辅助函数
// ============================================================================

const NON_EDITABLE_MODES = new Set<PromptInputMode>([
  'task-notification',
] satisfies Permutations<Exclude<PromptInputMode, EditablePromptInputMode>>)

export function isPromptInputModeEditable(
  mode: PromptInputMode,
): mode is EditablePromptInputMode {
  return !NON_EDITABLE_MODES.has(mode)
}

/**
 * 此排队命令是否可以通过 UP/ESC 拉入输入缓冲区。
 * 系统生成的命令（主动触发、计划任务、计划验证、频道消息）
 * 包含原始 XML，不得泄漏到用户输入中。
 */
export function isQueuedCommandEditable(cmd: QueuedCommand): boolean {
  return isPromptInputModeEditable(cmd.mode) && !cmd.isMeta
}

/**
 * 此排队命令是否应在提示符下方的队列预览中渲染。
 * 是 editable 的超集——频道消息会显示（让键盘用户看到到达的内容），
 * 但保持不可编辑（原始 XML）。
 */
export function isQueuedCommandVisible(cmd: QueuedCommand): boolean {
  if (
    (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
    (cmd as Record<string, unknown>).origin !== undefined &&
    ((cmd as Record<string, unknown>).origin as Record<string, unknown>)
      ?.kind === 'channel'
  )
    return true
  return isQueuedCommandEditable(cmd)
}

/**
 * 从排队命令值中提取文本。
 * 对于字符串，直接返回字符串。
 * 对于 ContentBlockParam[]，从文本块中提取文本。
 */
function extractTextFromValue(value: string | ContentBlockParam[]): string {
  return typeof value === 'string' ? value : extractTextContent(value, '\n')
}

/**
 * 从 ContentBlockParam[] 中提取图片并转换为 PastedContent 格式。
 * 对于字符串值或未找到图片时，返回空数组。
 */
function extractImagesFromValue(
  value: string | ContentBlockParam[],
  startId: number,
): PastedContent[] {
  if (typeof value === 'string') {
    return []
  }

  const images: PastedContent[] = []
  let imageIndex = 0
  for (const block of value) {
    if (block.type === 'image' && block.source.type === 'base64') {
      images.push({
        id: startId + imageIndex,
        type: 'image',
        content: block.source.data,
        mediaType: block.source.media_type,
        filename: `image${imageIndex + 1}`,
      })
      imageIndex++
    }
  }
  return images
}

export type PopAllEditableResult = {
  text: string
  cursorOffset: number
  images: PastedContent[]
}

/**
 * 弹出所有可编辑命令并与当前输入合并以供编辑。
 * 通知模式（task-notification）保留在队列中，稍后自动处理。
 * 返回包含合并文本、光标偏移量和待恢复图片的对象。
 * 若队列中无可编辑命令则返回 undefined。
 */
export function popAllEditable(
  currentInput: string,
  currentCursorOffset: number,
): PopAllEditableResult | undefined {
  if (commandQueue.length === 0) {
    return undefined
  }

  const { editable = [], nonEditable = [] } = objectGroupBy(
    [...commandQueue],
    cmd => (isQueuedCommandEditable(cmd) ? 'editable' : 'nonEditable'),
  )

  if (editable.length === 0) {
    return undefined
  }

  // 从排队命令中提取文本（同时处理字符串和 ContentBlockParam[]）
  const queuedTexts = editable.map(cmd => extractTextFromValue(cmd.value))
  const newInput = [...queuedTexts, currentInput].filter(Boolean).join('\n')

  // 计算光标偏移量：已合并排队命令的长度 + 1 + 当前光标偏移量
  const cursorOffset = queuedTexts.join('\n').length + 1 + currentCursorOffset

  // 从排队命令中提取图片
  const images: PastedContent[] = []
  let nextImageId = Date.now() // 使用时间戳作为唯一 ID 的基础
  for (const cmd of editable) {
    // handlePromptSubmit 将图片队列化到 pastedContents（value 为字符串）。
    // 保留原始 PastedContent id，以便 imageStore 查找仍然有效。
    if (cmd.pastedContents) {
      for (const content of Object.values(cmd.pastedContents)) {
        if (content.type === 'image') {
          images.push(content)
        }
      }
    }
    // Bridge/远程命令可能直接在 ContentBlockParam[] 中嵌入图片。
    const cmdImages = extractImagesFromValue(cmd.value, nextImageId)
    images.push(...cmdImages)
    nextImageId += cmdImages.length
  }

  for (const command of editable) {
    logOperation(
      'popAll',
      typeof command.value === 'string' ? command.value : undefined,
    )
  }

  // 用仅含不可编辑命令的内容替换队列
  commandQueue.length = 0
  commandQueue.push(...nonEditable)
  notifySubscribers()

  return { text: newInput, cursorOffset, images }
}

// ============================================================================
// 向后兼容别名（已弃用——优先使用新名称）
// ============================================================================

/** @deprecated 使用 subscribeToCommandQueue */
export const subscribeToPendingNotifications = subscribeToCommandQueue

/** @deprecated 使用 getCommandQueueSnapshot */
export function getPendingNotificationsSnapshot(): readonly QueuedCommand[] {
  return snapshot
}

/** @deprecated 使用 hasCommandsInQueue */
export const hasPendingNotifications = hasCommandsInQueue

/** @deprecated 使用 getCommandQueueLength */
export const getPendingNotificationsCount = getCommandQueueLength

/** @deprecated 使用 recheckCommandQueue */
export const recheckPendingNotifications = recheckCommandQueue

/** @deprecated 使用 dequeue */
export function dequeuePendingNotification(): QueuedCommand | undefined {
  return dequeue()
}

/** @deprecated 使用 resetCommandQueue */
export const resetPendingNotifications = resetCommandQueue

/** @deprecated 使用 clearCommandQueue */
export const clearPendingNotifications = clearCommandQueue

/**
 * 获取达到或超过给定优先级的命令，不移除它们。
 * 用于链中间排空，此时只应处理紧急项目。
 *
 * 优先级顺序：'now' (0) > 'next' (1) > 'later' (2)。
 * 传入 'now' 只返回 now 优先级命令；传入 'later' 返回所有命令。
 */
export function getCommandsByMaxPriority(
  maxPriority: QueuePriority,
): QueuedCommand[] {
  const threshold = PRIORITY_ORDER[maxPriority]
  return commandQueue.filter(
    cmd => PRIORITY_ORDER[cmd.priority ?? 'next'] <= threshold,
  )
}

/**
 * 若命令是 slash 命令（应通过 processSlashCommand 路由而非作为文本发送给模型）
 * 则返回 true。
 *
 * 带有 `skipSlashCommands` 的命令通常被视为纯文本，
 * Remote Control bridge 消息（`bridgeOrigin`）除外，
 * 它们稍后通过 isBridgeSafeCommand() 重新验证。
 */
export function isSlashCommand(cmd: QueuedCommand): boolean {
  return (
    typeof cmd.value === 'string' &&
    cmd.value.trim().startsWith('/') &&
    (!cmd.skipSlashCommands || cmd.bridgeOrigin === true)
  )
}
