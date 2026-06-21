export type SessionState = 'idle' | 'running' | 'requires_action'

import { isProactiveActive } from '../proactive/index.js'

/**
 * 随 requires_action 转换携带的上下文，以便下游界面
 *（CCR 侧边栏、推送通知）可以显示会话被阻塞的原因，
 * 而不仅仅是它被阻塞了。
 *
 * 两条传递路径：
 * - tool_name + action_description → RequiresActionDetails proto
 *  （webhook 负载，类型化，记录在 Datadog 中）
 * - 完整对象 → external_metadata.pending_action（Session 上可查询的
 *   JSON，让前端无需 proto 往返即可迭代形状）
 */
export type RequiresActionDetails = {
  tool_name: string
  /** 人类可读摘要，例如"正在编辑 src/foo.ts"、"正在运行 npm test" */
  action_description: string
  tool_use_id: string
  request_id: string
  /** 原始工具输入 — 前端从 external_metadata.pending_action.input
   * 读取以解析问题选项/计划内容，而无需扫描事件流。 */
  input?: Record<string, unknown>
}

export type AutomationStatePhase = 'standby' | 'sleeping'

export type AutomationStateMetadata = {
  enabled: boolean
  phase: AutomationStatePhase | null
  next_tick_at: number | null
  sleep_until: number | null
}

import { isEnvTruthy } from './envUtils.js'
import type { PermissionMode } from './permissions/PermissionMode.js'
import { enqueueSdkEvent } from './sdkEventQueue.js'

// CCR external_metadata 键 — 在 onChangeAppState 中推送，
// 在 externalMetadataToAppState 中恢复。
export type SessionExternalMetadata = {
  permission_mode?: string | null
  is_ultraplan_mode?: boolean | null
  model?: string | null
  pending_action?: RequiresActionDetails | null
  automation_state?: AutomationStateMetadata | null
  // 不透明 — 在发射点类型化。在此处导入 PostTurnSummaryOutput
  // 会将导入路径字符串通过 agentSdkBridge 对 SessionState 的
  // 再导出泄漏到 sdk.d.ts 中。
  post_turn_summary?: unknown
  // 来自分叉 agent 总结器的中途进度行 — 每约 5 步 / 2 分钟触发一次，
  // 以便长时间运行的 turn 在 post_turn_summary 到达之前仍能显示
  //"当前正在发生什么"。
  task_summary?: string | null
}

type SessionStateChangedListener = (
  state: SessionState,
  details?: RequiresActionDetails,
) => void
type SessionMetadataChangedListener = (
  metadata: SessionExternalMetadata,
) => void
type PermissionModeChangedListener = (mode: PermissionMode) => void
type SessionMetadataListenerOptions = {
  replayCurrent?: boolean
}

let stateListener: SessionStateChangedListener | null = null
let metadataListener: SessionMetadataChangedListener | null = null
let permissionModeListener: PermissionModeChangedListener | null = null

export function setSessionStateChangedListener(
  cb: SessionStateChangedListener | null,
): void {
  stateListener = cb
}

export function setSessionMetadataChangedListener(
  cb: SessionMetadataChangedListener | null,
  options?: SessionMetadataListenerOptions,
): void {
  metadataListener = cb
  if (!cb || !options?.replayCurrent) {
    return
  }

  const snapshot = getSessionMetadataSnapshot()
  if (Object.keys(snapshot).length === 0) {
    return
  }

  cb(snapshot)
}

/**
 * 为来自 onChangeAppState 的权限模式更改注册监听器。
 * 由 print.ts 连接以发射 SDK system:status 消息，使 CCR/IDE
 * 客户端能够实时看到模式转换 — 无论哪个代码路径改变了
 * toolPermissionContext.mode（Shift+Tab、ExitPlanMode 对话框、
 * 斜杠命令、bridge set_permission_mode 等）。
 */
export function setPermissionModeChangedListener(
  cb: PermissionModeChangedListener | null,
): void {
  permissionModeListener = cb
}

let hasPendingAction = false
let currentState: SessionState = 'idle'
let currentAutomationState: AutomationStateMetadata | null = null
let currentMetadata: SessionExternalMetadata = {}

function normalizeAutomationState(
  state: AutomationStateMetadata | null | undefined,
): AutomationStateMetadata | null {
  if (!state || state.enabled !== true) {
    return null
  }

  return {
    enabled: true,
    phase:
      state.phase === 'standby' || state.phase === 'sleeping'
        ? state.phase
        : null,
    next_tick_at:
      typeof state.next_tick_at === 'number' ? state.next_tick_at : null,
    sleep_until:
      typeof state.sleep_until === 'number' ? state.sleep_until : null,
  }
}

function automationStateKey(state: AutomationStateMetadata | null): string {
  return JSON.stringify(state)
}

function applyMetadataUpdate(metadata: SessionExternalMetadata): void {
  const nextMetadata = { ...currentMetadata }
  for (const key of Object.keys(metadata) as Array<
    keyof SessionExternalMetadata
  >) {
    const value = metadata[key]
    if (value === undefined) {
      delete nextMetadata[key]
      continue
    }
    ;(nextMetadata as Record<string, unknown>)[key] = value
  }
  currentMetadata = nextMetadata
}

export function getSessionMetadataSnapshot(): SessionExternalMetadata {
  const snapshot: SessionExternalMetadata = { ...currentMetadata }
  if (currentAutomationState) {
    snapshot.automation_state = { ...currentAutomationState }
  } else if ('automation_state' in currentMetadata) {
    snapshot.automation_state = currentMetadata.automation_state ?? null
  }
  return snapshot
}

export function getSessionState(): SessionState {
  return currentState
}

export function notifySessionStateChanged(
  state: SessionState,
  details?: RequiresActionDetails,
): void {
  currentState = state
  stateListener?.(state, details)

  // 将详细信息镜像到 external_metadata 中，使 GetSession 携带
  // 待处理操作上下文而无需 proto 更改。通过 RFC 7396 null
  // 在下一次非阻塞转换时清除。
  if (state === 'requires_action' && details) {
    hasPendingAction = true
    notifySessionMetadataChanged({
      pending_action: details,
    })
  } else if (hasPendingAction) {
    hasPendingAction = false
    notifySessionMetadataChanged({ pending_action: null })
  }

  // task_summary 由分叉总结器在 turn 中途写入；在 idle 时清除，
  // 以便下一个 turn 不会短暂显示上一个 turn 的进度。
  if (state === 'idle') {
    notifySessionMetadataChanged({ task_summary: null })
  }

  if (state !== 'idle') {
    notifyAutomationStateChanged(
      isProactiveActive()
        ? {
            enabled: true,
            phase: null,
            next_tick_at: null,
            sleep_until: null,
          }
        : null,
    )
  }

  // 镜像到 SDK 事件流，使非 CCR 消费者（scmuxd、VS Code）
  // 看到与 CCR bridge 相同的权威 idle/running 信号。
  // 'idle' 在 heldBackResult 刷新后触发 — 让 scmuxd 切换到 IDLE
  // 并显示后台任务点，而不是卡住的生成中转圈。
  //
  // 在 CCR web + 移动客户端学会在其 isWorking() 最后消息启发式中
  // 忽略此子类型之前，这是可选的 — 尾随 idle 事件目前将它们
  // 固定在"运行中..."。
  // https://anthropic.slack.com/archives/C093BJBD1CP/p1774152406752229
  if (isEnvTruthy(process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS)) {
    enqueueSdkEvent({
      type: 'system',
      subtype: 'session_state_changed',
      state,
    })
  }
}

export function notifySessionMetadataChanged(
  metadata: SessionExternalMetadata,
): void {
  applyMetadataUpdate(metadata)
  metadataListener?.(metadata)
}

export function notifyAutomationStateChanged(
  state: AutomationStateMetadata | null | undefined,
): void {
  const nextState = normalizeAutomationState(state)
  if (
    automationStateKey(nextState) === automationStateKey(currentAutomationState)
  ) {
    return
  }

  currentAutomationState = nextState
  applyMetadataUpdate({ automation_state: nextState })
  metadataListener?.({ automation_state: nextState })
}

/**
 * 由 onChangeAppState 在 toolPermissionContext.mode 更改时触发。
 * 下游监听器（CCR external_metadata PUT、SDK 状态流）都通过
 * 此单一检查点连接，因此没有模式变更路径可以悄悄绕过它们。
 */
export function notifyPermissionModeChanged(mode: PermissionMode): void {
  permissionModeListener?.(mode)
}

export function resetSessionStateForTests(): void {
  stateListener = null
  metadataListener = null
  permissionModeListener = null
  hasPendingAction = false
  currentState = 'idle'
  currentAutomationState = null
  currentMetadata = {}
}
