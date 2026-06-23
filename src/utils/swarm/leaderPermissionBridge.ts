/**
 * Leader 权限桥接
 *
 * 模块级桥接，允许 REPL 注册其 setToolUseConfirmQueue
 * 和 setToolPermissionContext 函数供进程内 teammate 使用。
 *
 * 当进程内 teammate 请求权限时，它使用标准的
 * ToolUseConfirm 对话框而非 worker 权限徽章。此桥接
 * 使 REPL 的队列设置器和权限上下文设置器可从
 * 进程内运行器的非 React 代码中访问。
 */

import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import type { ToolPermissionContext } from '../../Tool.js'

export type SetToolUseConfirmQueueFn = (
  updater: (prev: ToolUseConfirm[]) => ToolUseConfirm[],
) => void

export type SetToolPermissionContextFn = (
  context: ToolPermissionContext,
  options?: { preserveMode?: boolean },
) => void

let registeredSetter: SetToolUseConfirmQueueFn | null = null
let registeredPermissionContextSetter: SetToolPermissionContextFn | null = null

export function registerLeaderToolUseConfirmQueue(
  setter: SetToolUseConfirmQueueFn,
): void {
  registeredSetter = setter
}

export function getLeaderToolUseConfirmQueue(): SetToolUseConfirmQueueFn | null {
  return registeredSetter
}

export function unregisterLeaderToolUseConfirmQueue(): void {
  registeredSetter = null
}

export function registerLeaderSetToolPermissionContext(
  setter: SetToolPermissionContextFn,
): void {
  registeredPermissionContextSetter = setter
}

export function getLeaderSetToolPermissionContext(): SetToolPermissionContextFn | null {
  return registeredPermissionContextSetter
}

export function unregisterLeaderSetToolPermissionContext(): void {
  registeredPermissionContextSetter = null
}
