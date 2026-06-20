// auto-dream（记忆整合子 agent）的后台任务入口。
// 让原本不可见的 fork agent 显示在 footer pill 和 Shift+Down 对话框中。
// dream agent 本身保持不变 —— 这只是通过现有的任务注册表进行的纯 UI 呈现。

import { rollbackConsolidationLock } from '../../services/autoDream/consolidationLock.js'
import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'

// 仅保留最近 N 轮用于实时显示。
const MAX_TURNS = 30

// dream agent 的一轮 assistant 输出，工具调用折叠为计数。
export type DreamTurn = {
  text: string
  toolUseCount: number
}

// 不做阶段检测 —— dream prompt 本身有 4 段结构
// （orient/gather/consolidate/prune），但我们不解析它。只是在第一个
// Edit/Write tool_use 落地时从 'starting' 翻到 'updating'。
export type DreamPhase = 'starting' | 'updating'

export type DreamTaskState = TaskStateBase & {
  type: 'dream'
  phase: DreamPhase
  sessionsReviewing: number
  /**
   * 通过 onMessage 从 Edit/Write tool_use 块中观察到的路径。这只是 dream
   * agent 实际改动的一个不完整映射 —— 它漏掉了任何通过 bash 进行的写入，
   * 只捕获到我们通过模式匹配识别的工具调用。
   * 应当视作「至少这些文件被改过」，而不是「只有这些文件被改过」。
   */
  filesTouched: string[]
  /** assistant 文本回复，工具调用已折叠。不包含 prompt。 */
  turns: DreamTurn[]
  abortController?: AbortController
  /** 暂存起来，便于 kill 时回滚锁的 mtime（与 fork 失败的处理路径一致）。 */
  priorMtime: number
}

export function isDreamTask(task: unknown): task is DreamTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'dream'
  )
}

export function registerDreamTask(
  setAppState: SetAppState,
  opts: {
    sessionsReviewing: number
    priorMtime: number
    abortController: AbortController
  },
): string {
  const id = generateTaskId('dream')
  const task: DreamTaskState = {
    ...createTaskStateBase(id, 'dream', 'dreaming'),
    type: 'dream',
    status: 'running',
    phase: 'starting',
    sessionsReviewing: opts.sessionsReviewing,
    filesTouched: [],
    turns: [],
    abortController: opts.abortController,
    priorMtime: opts.priorMtime,
  }
  registerTask(task, setAppState)
  return id
}

export function addDreamTurn(
  taskId: string,
  turn: DreamTurn,
  touchedPaths: string[],
  setAppState: SetAppState,
): void {
  updateTaskState<DreamTaskState>(taskId, setAppState, task => {
    const seen = new Set(task.filesTouched)
    const newTouched = touchedPaths.filter(p => !seen.has(p) && seen.add(p))
    // 如果该轮为空且没有新增任何被改动的文件，则完全跳过更新。
    // 避免在纯空操作上触发重渲染。
    if (
      turn.text === '' &&
      turn.toolUseCount === 0 &&
      newTouched.length === 0
    ) {
      return task
    }
    return {
      ...task,
      phase: newTouched.length > 0 ? 'updating' : task.phase,
      filesTouched:
        newTouched.length > 0
          ? [...task.filesTouched, ...newTouched]
          : task.filesTouched,
      turns: task.turns.slice(-(MAX_TURNS - 1)).concat(turn),
    }
  })
}

export function completeDreamTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  // notified: 立即设为 true —— dream 没有面向模型的通知路径
  // （它是纯 UI 的），而任务驱逐要求处于 terminal 状态且 notified 为 true。
  // 内联的 appendSystemMessage 完成提示就是用户侧的呈现方式。
  updateTaskState<DreamTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'completed',
    endTime: Date.now(),
    notified: true,
    abortController: undefined,
  }))
}

export function failDreamTask(taskId: string, setAppState: SetAppState): void {
  updateTaskState<DreamTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'failed',
    endTime: Date.now(),
    notified: true,
    abortController: undefined,
  }))
}

export const DreamTask: Task = {
  name: 'DreamTask',
  type: 'dream',

  async kill(taskId, setAppState) {
    let priorMtime: number | undefined
    updateTaskState<DreamTaskState>(taskId, setAppState, task => {
      if (task.status !== 'running') return task
      task.abortController?.abort()
      priorMtime = task.priorMtime
      return {
        ...task,
        status: 'killed',
        endTime: Date.now(),
        notified: true,
        abortController: undefined,
      }
    })
    // 回滚锁的 mtime，以便下一个会话可以重试。与 autoDream.ts 中
    // fork 失败的 catch 路径一致。如果 updateTaskState 是无操作
    // （已经处于 terminal 状态），priorMtime 仍为 undefined，我们直接跳过。
    if (priorMtime !== undefined) {
      await rollbackConsolidationLock(priorMtime)
    }
  },
}
