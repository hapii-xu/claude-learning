import { type FSWatcher, watch } from 'fs'
import { useEffect, useSyncExternalStore } from 'react'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { createSignal } from '../utils/signal.js'
import type { Task } from '../utils/tasks.js'
import {
  getTaskListId,
  getTasksDir,
  isTodoV2Enabled,
  listTasks,
  onTasksUpdated,
  resetTaskList,
} from '../utils/tasks.js'
import { isTeamLead } from '../utils/teammate.js'

const HIDE_DELAY_MS = 5000
const DEBOUNCE_MS = 50
const FALLBACK_POLL_MS = 5000 // 以防 fs.watch 漏掉事件的回退

/**
 * TodoV2 任务列表的单例 store。拥有文件 watcher、计时器
 * 和缓存的任务列表。多个 hook 实例（REPL、Spinner、
 * PromptInputFooterLeftSide）订阅一个共享 store，而不是各自
 * 在同一目录上设置自己的 fs.watch。Spinner 每轮
 * 挂载/卸载 —— 每 hook 的 watcher 导致持续的 watch/unwatch 抖动。
 *
 * 实现 useSyncExternalStore 契约：subscribe/getSnapshot。
 */
class TasksV2Store {
  /** 稳定的数组引用；仅在 fetch 时替换。启动前为 undefined。 */
  #tasks: Task[] | undefined = undefined
  /**
   * hide 计时器超时（所有任务完成 >5s）或
   * 任务列表为空时设置。初始为 false，使第一次 fetch 运行
   * "全部完成 → 调度 5s hide" 路径（匹配原始行为：
   * 恢复一个有已完成任务的会话时短暂显示它们）。
   */
  #hidden = false
  #watcher: FSWatcher | null = null
  #watchedDir: string | null = null
  #hideTimer: ReturnType<typeof setTimeout> | null = null
  #debounceTimer: ReturnType<typeof setTimeout> | null = null
  #pollTimer: ReturnType<typeof setTimeout> | null = null
  #unsubscribeTasksUpdated: (() => void) | null = null
  #changed = createSignal()
  #subscriberCount = 0
  #started = false

  /**
   * useSyncExternalStore 快照。在更新之间返回同一 Task[] 引用
   * （Object.is 稳定性所需）。hidden 时返回 undefined。
   */
  getSnapshot = (): Task[] | undefined => {
    return this.#hidden ? undefined : this.#tasks
  }

  subscribe = (fn: () => void): (() => void) => {
    // 第一个订阅者时懒初始化。useSyncExternalStore 在
    // commit 之后调用此函数，所以此处的 I/O 是安全的（无渲染阶段副作用）。
    // REPL.tsx 为整个会话保持订阅活跃，所以
    // Spinner 挂载/卸载抖动永远不会让计数降到零。
    const unsubscribe = this.#changed.subscribe(fn)
    this.#subscriberCount++
    if (!this.#started) {
      this.#started = true
      this.#unsubscribeTasksUpdated = onTasksUpdated(this.#debouncedFetch)
      // Fire-and-forget：subscribe 在 commit 之后调用（非渲染中），
      // store 在 fetch 解析时通知订阅者。
      void this.#fetch()
    }
    let unsubscribed = false
    return () => {
      if (unsubscribed) return
      unsubscribed = true
      unsubscribe()
      this.#subscriberCount--
      if (this.#subscriberCount === 0) this.#stop()
    }
  }

  #notify(): void {
    this.#changed.emit()
  }

  /**
   * 将文件 watcher 指向当前任务目录。在启动时和
   * #fetch 检测到 task list ID 变化时调用（例如
   * TeamCreateTool 在会话中设置 leaderTeamName）。
   */
  #rewatch(dir: string): void {
    // 即使是同一目录，如果之前的 watch 尝试失败（目录尚不存在）也重试。
    // watcher 一旦建立，同目录是 no-op。
    if (dir === this.#watchedDir && this.#watcher !== null) return
    this.#watcher?.close()
    this.#watcher = null
    this.#watchedDir = dir
    try {
      this.#watcher = watch(dir, this.#debouncedFetch)
      this.#watcher.unref()
    } catch {
      // 目录可能尚不存在（ensureTasksDir 由 writer 调用）。
      // 非关键 —— onTasksUpdated 覆盖进程内更新，
      // poll 计时器覆盖跨进程更新。
    }
  }

  #debouncedFetch = (): void => {
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer)
    this.#debounceTimer = setTimeout(() => void this.#fetch(), DEBOUNCE_MS)
    this.#debounceTimer.unref()
  }

  #fetch = async (): Promise<void> => {
    const taskListId = getTaskListId()
    // Task list ID 可在会话中变化（TeamCreateTool 设置
    // leaderTeamName）—— 将 watcher 指向当前目录。
    this.#rewatch(getTasksDir(taskListId))
    const current = (await listTasks(taskListId)).filter(
      t => !t.metadata?._internal,
    )
    this.#tasks = current

    const hasIncomplete = current.some(t => t.status !== 'completed')

    if (hasIncomplete || current.length === 0) {
      // 有未解决任务（open/in_progress）或为空 —— 重置 hide 状态
      this.#hidden = current.length === 0
      this.#clearHideTimer()
    } else if (this.#hideTimer === null && !this.#hidden) {
      // 所有任务刚变为已完成 —— 调度清除
      this.#hideTimer = setTimeout(
        this.#onHideTimerFired.bind(this, taskListId),
        HIDE_DELAY_MS,
      )
      this.#hideTimer.unref()
    }

    this.#notify()

    // 仅当有需要监控的未完成任务时才调度回退轮询。
    // 当所有任务已完成（或没有任务）时，
    // fs.watch watcher 和 onTasksUpdated 回调足以
    // 检测新活动 —— 无需持续轮询和重新渲染。
    if (this.#pollTimer) {
      clearTimeout(this.#pollTimer)
      this.#pollTimer = null
    }
    if (hasIncomplete) {
      this.#pollTimer = setTimeout(this.#debouncedFetch, FALLBACK_POLL_MS)
      this.#pollTimer.unref()
    }
  }

  #onHideTimerFired(scheduledForTaskListId: string): void {
    this.#hideTimer = null
    // 如果调度以来 task list ID 变化（5s 窗口期间 team 创建/删除）则退出
    // —— 不要重置错误的列表。
    const currentId = getTaskListId()
    if (currentId !== scheduledForTaskListId) return
    // 清除前验证所有任务是否仍已完成
    void listTasks(currentId).then(async tasksToCheck => {
      const allStillCompleted =
        tasksToCheck.length > 0 &&
        tasksToCheck.every(t => t.status === 'completed')
      if (allStillCompleted) {
        await resetTaskList(currentId)
        this.#tasks = []
        this.#hidden = true
      }
      this.#notify()
    })
  }

  #clearHideTimer(): void {
    if (this.#hideTimer) {
      clearTimeout(this.#hideTimer)
      this.#hideTimer = null
    }
  }

  /**
   * 拆除 watcher、计时器和进程内订阅。最后一个
   * 订阅者取消订阅时调用。保留 #tasks/#hidden 缓存，使后续
   * 重新订阅立即渲染最后已知状态。
   */
  #stop(): void {
    this.#watcher?.close()
    this.#watcher = null
    this.#watchedDir = null
    this.#unsubscribeTasksUpdated?.()
    this.#unsubscribeTasksUpdated = null
    this.#clearHideTimer()
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer)
    if (this.#pollTimer) clearTimeout(this.#pollTimer)
    this.#debounceTimer = null
    this.#pollTimer = null
    this.#started = false
  }
}

let _store: TasksV2Store | null = null
function getStore(): TasksV2Store {
  return (_store ??= new TasksV2Store())
}

// 为禁用路径提供的稳定 no-op，使 useSyncExternalStore 不会
// 在每次渲染时抖动其订阅。
const NOOP = (): void => {}
const NOOP_SUBSCRIBE = (): (() => void) => NOOP
const NOOP_SNAPSHOT = (): undefined => undefined

/**
 * 获取持久 UI 显示的当前任务列表的 hook。
 * TodoV2 启用时返回任务，否则返回 undefined。
 * 所有 hook 实例通过 TasksV2Store 共享单个文件 watcher。
 * 如果没有未完成任务，5 秒后隐藏列表。
 */
export function useTasksV2(): Task[] | undefined {
  const teamContext = useAppState(s => s.teamContext)

  const enabled = isTodoV2Enabled() && (!teamContext || isTeamLead(teamContext))

  const store = enabled ? getStore() : null

  return useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    store ? store.getSnapshot : NOOP_SNAPSHOT,
  )
}

/**
 * 同 useTasksV2，加上列表变为 hidden 时折叠展开的任务视图。
 * 从一个始终挂载的组件（REPL）调用，
 * 使折叠效果运行一次而非每个消费者 N× 次。
 */
export function useTasksV2WithCollapseEffect(): Task[] | undefined {
  const tasks = useTasksV2()
  const setAppState = useSetAppState()

  const hidden = tasks === undefined
  useEffect(() => {
    if (!hidden) return
    setAppState(prev => {
      if (prev.expandedView !== 'tasks') return prev
      return { ...prev, expandedView: 'none' as const }
    })
  }, [hidden, setAppState])

  return tasks
}
