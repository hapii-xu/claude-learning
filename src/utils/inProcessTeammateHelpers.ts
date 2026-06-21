/**
 * 进程内队友辅助函数
 *
 * 用于进程内队友集成的辅助函数。
 * 提供以下工具：
 * - 按 agent 名称查找任务 ID
 * - 处理 plan 审批响应
 * - 更新 awaitingPlanApproval 状态
 * - 检测权限相关消息
 */

import type { AppState } from '../state/AppState.js'
import {
  type InProcessTeammateTaskState,
  isInProcessTeammateTask,
} from '../tasks/InProcessTeammateTask/types.js'
import { updateTaskState } from './task/framework.js'
import {
  isPermissionResponse,
  isSandboxPermissionResponse,
  type PlanApprovalResponseMessage,
} from './teammateMailbox.js'

type SetAppState = (updater: (prev: AppState) => AppState) => void

/**
 * 按 agent 名称查找进程内队友的任务 ID。
 *
 * @param agentName - agent 名称（如 "researcher"）
 * @param appState - 当前 AppState
 * @returns 若找到则返回任务 ID，否则返回 undefined
 */
export function findInProcessTeammateTaskId(
  agentName: string,
  appState: AppState,
): string | undefined {
  for (const task of Object.values(appState.tasks)) {
    if (
      isInProcessTeammateTask(task) &&
      task.identity.agentName === agentName
    ) {
      return task.id
    }
  }
  return undefined
}

/**
 * 设置进程内队友的 awaitingPlanApproval 状态。
 *
 * @param taskId - 进程内队友的任务 ID
 * @param setAppState - AppState 设置器
 * @param awaiting - 队友是否在等待 plan 审批
 */
export function setAwaitingPlanApproval(
  taskId: string,
  setAppState: SetAppState,
  awaiting: boolean,
): void {
  updateTaskState<InProcessTeammateTaskState>(taskId, setAppState, task => ({
    ...task,
    awaitingPlanApproval: awaiting,
  }))
}

/**
 * 处理进程内队友的 plan 审批响应。
 * 当消息回调收到 plan_approval_response 时调用。
 *
 * 这会将 awaitingPlanApproval 重置为 false。响应中的 permissionMode
 * 由 agent 循环单独处理（Task #11）。
 *
 * @param taskId - 进程内队友的任务 ID
 * @param _response - plan 审批响应消息（供未来使用）
 * @param setAppState - AppState 设置器
 */
export function handlePlanApprovalResponse(
  taskId: string,
  _response: PlanApprovalResponseMessage,
  setAppState: SetAppState,
): void {
  setAwaitingPlanApproval(taskId, setAppState, false)
}

// ============ 权限委派辅助函数 ============

/**
 * 检查消息是否为权限相关响应。
 * 被进程内队友消息处理器用于检测并处理
 * 来自 team leader 的权限响应。
 *
 * 同时处理工具权限和沙箱（网络 host）权限。
 *
 * @param messageText - 要检查的原始消息文本
 * @returns 若消息为权限响应则返回 true
 */
export function isPermissionRelatedResponse(messageText: string): boolean {
  return (
    !!isPermissionResponse(messageText) ||
    !!isSandboxPermissionResponse(messageText)
  )
}
