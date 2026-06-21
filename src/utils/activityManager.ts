import { getActiveTimeCounter as getActiveTimeCounterImpl } from '../bootstrap/state.js'

type ActivityManagerOptions = {
  getNow?: () => number
  getActiveTimeCounter?: typeof getActiveTimeCounterImpl
}

/**
 * ActivityManager 处理用户和 CLI 操作的通用活动跟踪。
 * 它自动去重重叠的活动，并为用户和 CLI 活跃时间提供独立的指标。
 */
export class ActivityManager {
  private activeOperations = new Set<string>()

  private lastUserActivityTime: number = 0 // 以 0 开始表示尚无活动
  private lastCLIRecordedTime: number

  private isCLIActive: boolean = false

  private readonly USER_ACTIVITY_TIMEOUT_MS = 5000 // 5 秒

  private readonly getNow: () => number
  private readonly getActiveTimeCounter: typeof getActiveTimeCounterImpl

  private static instance: ActivityManager | null = null

  constructor(options?: ActivityManagerOptions) {
    this.getNow = options?.getNow ?? (() => Date.now())
    this.getActiveTimeCounter =
      options?.getActiveTimeCounter ?? getActiveTimeCounterImpl
    this.lastCLIRecordedTime = this.getNow()
  }

  static getInstance(): ActivityManager {
    if (!ActivityManager.instance) {
      ActivityManager.instance = new ActivityManager()
    }
    return ActivityManager.instance
  }

  /**
   * 重置单例实例（用于测试目的）
   */
  static resetInstance(): void {
    ActivityManager.instance = null
  }

  /**
   * 使用自定义选项创建新实例（用于测试目的）
   */
  static createInstance(options?: ActivityManagerOptions): ActivityManager {
    ActivityManager.instance = new ActivityManager(options)
    return ActivityManager.instance
  }

  /**
   * 当用户与 CLI 交互时调用（输入、命令等）
   */
  recordUserActivity(): void {
    // 如果 CLI 处于活动状态，不记录用户时间（CLI 优先）
    if (!this.isCLIActive && this.lastUserActivityTime !== 0) {
      const now = this.getNow()
      const timeSinceLastActivity = (now - this.lastUserActivityTime) / 1000

      if (timeSinceLastActivity > 0) {
        const activeTimeCounter = this.getActiveTimeCounter()
        if (activeTimeCounter) {
          const timeoutSeconds = this.USER_ACTIVITY_TIMEOUT_MS / 1000

          // 仅在超时窗口内记录时间
          if (timeSinceLastActivity < timeoutSeconds) {
            activeTimeCounter.add(timeSinceLastActivity, { type: 'user' })
          }
        }
      }
    }

    // 更新最后用户活动时间戳
    this.lastUserActivityTime = this.getNow()
  }

  /**
   * 开始跟踪 CLI 活动（工具执行、AI 响应等）
   */
  startCLIActivity(operationId: string): void {
    // 如果操作已存在，可能意味着上一个操作没有正确清理
    // （例如，组件崩溃/卸载时没有调用 end）。强制清理
    // 以避免高估时间 —— 宁可低估也不要高估。
    if (this.activeOperations.has(operationId)) {
      this.endCLIActivity(operationId)
    }

    const wasEmpty = this.activeOperations.size === 0
    this.activeOperations.add(operationId)

    if (wasEmpty) {
      this.isCLIActive = true
      this.lastCLIRecordedTime = this.getNow()
    }
  }

  /**
   * 停止跟踪 CLI 活动
   */
  endCLIActivity(operationId: string): void {
    this.activeOperations.delete(operationId)

    if (this.activeOperations.size === 0) {
      // 最后一个操作结束 - CLI 变为非活动状态
      // 在切换到非活动状态之前记录 CLI 时间
      const now = this.getNow()
      const timeSinceLastRecord = (now - this.lastCLIRecordedTime) / 1000

      if (timeSinceLastRecord > 0) {
        const activeTimeCounter = this.getActiveTimeCounter()
        if (activeTimeCounter) {
          activeTimeCounter.add(timeSinceLastRecord, { type: 'cli' })
        }
      }

      this.lastCLIRecordedTime = now
      this.isCLIActive = false
    }
  }

  /**
   * 自动跟踪异步操作的便捷方法（主要用于测试/调试）
   */
  async trackOperation<T>(
    operationId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.startCLIActivity(operationId)
    try {
      return await fn()
    } finally {
      this.endCLIActivity(operationId)
    }
  }

  /**
   * 获取当前活动状态（主要用于测试/调试）
   */
  getActivityStates(): {
    isUserActive: boolean
    isCLIActive: boolean
    activeOperationCount: number
  } {
    const now = this.getNow()
    const timeSinceUserActivity = (now - this.lastUserActivityTime) / 1000
    const isUserActive =
      timeSinceUserActivity < this.USER_ACTIVITY_TIMEOUT_MS / 1000

    return {
      isUserActive,
      isCLIActive: this.isCLIActive,
      activeOperationCount: this.activeOperations.size,
    }
  }
}

// 导出单例实例
export const activityManager = ActivityManager.getInstance()
