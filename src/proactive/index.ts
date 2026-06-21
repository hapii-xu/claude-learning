/**
 * Proactive 模式——基于 tick 的自主代理。
 *
 * 状态机：inactive → active（→ paused → active）→ inactive
 *
 * 当 active 时，REPL 会定期注入 <tick> 提示，使模型即使在用户空闲时
 * 也能继续工作。SleepTool 让模型控制自己的唤醒节奏。
 */

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let active = false
let paused = false
let contextBlocked = false
let nextTickAt: number | null = null
let activationSource: string | undefined

const listeners = new Set<() => void>()

function notify(): void {
  for (const cb of listeners) {
    try {
      cb()
    } catch {
      // 订阅者错误不得中断通知者
    }
  }
}

// ---------------------------------------------------------------------------
// 公共 API——由 REPL.tsx、PromptInputFooterLeftSide、prompts.ts 消费
// ---------------------------------------------------------------------------

export function isProactiveActive(): boolean {
  return active
}

export function activateProactive(source?: string): void {
  if (active) return
  active = true
  paused = false
  contextBlocked = false
  activationSource = source
  notify()
}

export function deactivateProactive(): void {
  if (!active) return
  active = false
  paused = false
  contextBlocked = false
  nextTickAt = null
  activationSource = undefined
  notify()
}

export function isProactivePaused(): boolean {
  return paused
}

export function pauseProactive(): void {
  if (!active || paused) return
  paused = true
  nextTickAt = null
  notify()
}

export function resumeProactive(): void {
  if (!active || !paused) return
  paused = false
  notify()
}

/**
 * 阻塞 / 解除 tick 生成。
 *
 * 在 API 错误时设为 `true`，以防止 tick → 错误 → tick 的失控循环。
 * 在成功响应或压缩后清除。
 */
export function setContextBlocked(blocked: boolean): void {
  if (contextBlocked === blocked) return
  contextBlocked = blocked
  if (blocked) {
    nextTickAt = null
  }
  notify()
}

export function isContextBlocked(): boolean {
  return contextBlocked
}

/**
 * 安排下一次 tick 的时间戳（epoch 毫秒）。
 * 由 useProactive 在提交 tick 后调用。
 */
export function setNextTickAt(ts: number | null): void {
  nextTickAt = ts
  notify()
}

/**
 * 返回下一次计划 tick 的 epoch 毫秒时间戳，或 null。
 * 由 PromptInputFooterLeftSide 用于渲染倒计时。
 */
export function getNextTickAt(): number | null {
  if (!active || paused || contextBlocked) return null
  return nextTickAt
}

export function getActivationSource(): string | undefined {
  return activationSource
}

/**
 * 订阅任何 proactive 状态变化。
 * 返回一个取消订阅函数。
 */
export function subscribeToProactiveChanges(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/**
 * tick 是否应该立即触发。
 * 组合所有阻塞条件的便捷谓词。
 */
export function shouldTick(): boolean {
  return active && !paused && !contextBlocked
}
