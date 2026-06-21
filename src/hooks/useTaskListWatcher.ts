import { type FSWatcher, watch } from 'fs'
import { useEffect, useRef } from 'react'
import { logForDebugging } from '../utils/debug.js'
import {
  claimTask,
  DEFAULT_TASKS_MODE_TASK_LIST_ID,
  ensureTasksDir,
  getTasksDir,
  listTasks,
  type Task,
  updateTask,
} from '../utils/tasks.js'

const DEBOUNCE_MS = 1000

type Props = {
  /** 为 undefined 时 hook 不做任何事。task list id 同时作为 agent ID。 */
  taskListId?: string
  isLoading: boolean
  /**
   * 当任务准备好处理时调用。
   * 提交成功返回 true，被拒绝返回 false。
   */
  onSubmitTask: (prompt: string) => boolean
}

/**
 * 监视 task list 目录并自动拾取开放、无 owner 的任务进行处理的 hook。
 *
 * 这启用了 "tasks mode"，Claude 会监视外部创建的任务
 * 并一次处理一个。
 */
export function useTaskListWatcher({
  taskListId,
  isLoading,
  onSubmitTask,
}: Props): void {
  const currentTaskRef = useRef<string | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 通过 ref 稳定不稳定的 props，使 watcher effect 不依赖它们。
  // isLoading 每轮都翻转，onSubmitTask 的身份在 onQuery 依赖变化时
  // 也会变。不这样处理的话，watcher effect 每轮都会重新运行，
  // 每次都调用 watcher.close() + watch() —— 这是 Bun PathWatcherManager
  // 死锁的触发条件（oven-sh/bun#27469）。
  const isLoadingRef = useRef(isLoading)
  isLoadingRef.current = isLoading
  const onSubmitTaskRef = useRef(onSubmitTask)
  onSubmitTaskRef.current = onSubmitTask

  const enabled = taskListId !== undefined
  const agentId = taskListId ?? DEFAULT_TASKS_MODE_TASK_LIST_ID

  // checkForTasks 从 ref 读取 isLoading 和 onSubmitTask ——
  // 始终是最新的，没有陈旧闭包，也不会在每次渲染时强制产生新的
  // 函数身份。存储在 ref 中，这样 watcher effect 就可以调用它
  // 而不依赖它。
  const checkForTasksRef = useRef<() => Promise<void>>(async () => {})
  checkForTasksRef.current = async () => {
    if (!enabled) {
      return
    }

    // 如果我们已经在处理任务，就不需要提交新任务
    if (isLoadingRef.current) {
      return
    }

    const tasks = await listTasks(taskListId)

    // 如果我们有当前任务，检查它是否已被解决
    if (currentTaskRef.current !== null) {
      const currentTask = tasks.find(t => t.id === currentTaskRef.current)
      if (!currentTask || currentTask.status === 'completed') {
        logForDebugging(
          `[TaskListWatcher] Task #${currentTaskRef.current} is marked complete, ready for next task`,
        )
        currentTaskRef.current = null
      } else {
        // 仍在处理当前任务
        return
      }
    }

    // 查找一个无 owner 且未被阻塞的开放任务
    const availableTask = findAvailableTask(tasks)

    if (!availableTask) {
      return
    }

    logForDebugging(
      `[TaskListWatcher] Found available task #${availableTask.id}: ${availableTask.subject}`,
    )

    // 使用 task list 的 agent ID 认领任务
    const result = await claimTask(taskListId, availableTask.id, agentId)

    if (!result.success) {
      logForDebugging(
        `[TaskListWatcher] Failed to claim task #${availableTask.id}: ${result.reason}`,
      )
      return
    }

    currentTaskRef.current = availableTask.id

    // 将任务格式化为 prompt
    const prompt = formatTaskAsPrompt(availableTask)

    logForDebugging(
      `[TaskListWatcher] Submitting task #${availableTask.id} as prompt`,
    )

    const submitted = onSubmitTaskRef.current(prompt)
    if (!submitted) {
      logForDebugging(
        `[TaskListWatcher] Failed to submit task #${availableTask.id}, releasing claim`,
      )
      // 释放认领
      await updateTask(taskListId, availableTask.id, { owner: undefined })
      currentTaskRef.current = null
    }
  }

  // -- Watcher 设置

  // 在 DEBOUNCE_MS 后调度一次检查，折叠快速连续的 fs 事件。
  // 在 watcher 回调和下方的空闲触发 effect 之间共享。
  const scheduleCheckRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!enabled) return

    void ensureTasksDir(taskListId)
    const tasksDir = getTasksDir(taskListId)

    let watcher: FSWatcher | null = null

    const debouncedCheck = (): void => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
      debounceTimerRef.current = setTimeout(
        ref => void ref.current(),
        DEBOUNCE_MS,
        checkForTasksRef,
      )
    }
    scheduleCheckRef.current = debouncedCheck

    try {
      watcher = watch(tasksDir, debouncedCheck)
      watcher.unref()
      logForDebugging(`[TaskListWatcher] Watching for tasks in ${tasksDir}`)
    } catch (error) {
      // fs.watch 在 ENOENT 时会同步抛出 —— ensureTasksDir 应该已经
      // 创建了该目录，但仍优雅地处理竞态
      logForDebugging(`[TaskListWatcher] Failed to watch ${tasksDir}: ${error}`)
    }

    // 初始检查
    debouncedCheck()

    return () => {
      // 此清理仅在 taskListId 变化或卸载时触发 —— 从不每轮触发。
      // 这让 watcher.close() 保持在 Bun PathWatcherManager 死锁
      // 窗口之外。
      scheduleCheckRef.current = () => {}
      if (watcher) {
        watcher.close()
      }
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [enabled, taskListId])

  // 以前 watcher effect 依赖 checkForTasks（以及传递性地依赖
  // isLoading），所以空闲会触发重新设置，其初始的 debouncedCheck 会
  // 拾取下一个任务。显式保留该行为：当 isLoading 下降时，调度一次检查。
  useEffect(() => {
    if (!enabled) return
    if (isLoading) return
    scheduleCheckRef.current()
  }, [enabled, isLoading])
}

/**
 * 查找可处理的可用任务：
 * - 状态为 'pending'
 * - 无 owner 分配
 * - 未被任何未解决的任务阻塞
 */
function findAvailableTask(tasks: Task[]): Task | undefined {
  const unresolvedTaskIds = new Set(
    tasks.filter(t => t.status !== 'completed').map(t => t.id),
  )

  return tasks.find(task => {
    if (task.status !== 'pending') return false
    if (task.owner) return false
    // 检查所有阻塞项是否已完成
    return task.blockedBy.every(id => !unresolvedTaskIds.has(id))
  })
}

/**
 * 将任务格式化为供 Claude 处理的 prompt。
 */
function formatTaskAsPrompt(task: Task): string {
  let prompt = `Complete all open tasks. Start with task #${task.id}: \n\n ${task.subject}`

  if (task.description) {
    prompt += `\n\n${task.description}`
  }

  return prompt
}
