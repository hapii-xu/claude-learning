/**
 * Swarm 权限轮询 Hook
 *
 * 此 hook 在 swarm 中作为 worker agent 运行时轮询 team leader 的权限响应。
 * 收到响应时，调用相应的回调（onAllow/onReject）继续执行。
 *
 * 此 hook 应与 useCanUseTool.ts 中的 worker 端集成一起使用，
 * 后者创建由此 hook 监控的 pending 请求。
 */

import { useCallback, useEffect, useRef } from 'react'
import { useInterval } from 'usehooks-ts'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import {
  type PermissionUpdate,
  permissionUpdateSchema,
} from '../utils/permissions/PermissionUpdateSchema.js'
import {
  isSwarmWorker,
  type PermissionResponse,
  pollForResponse,
  removeWorkerResponse,
} from '../utils/swarm/permissionSync.js'
import { getAgentName, getTeamName } from '../utils/teammate.js'

const POLL_INTERVAL_MS = 500

/**
 * 验证来自外部源（mailbox IPC、磁盘轮询）的 permissionUpdates。
 * 来自有 bug/旧 teammate 进程的格式错误条目被过滤掉，
 * 而非未检查地传播到 callback.onAllow()。
 */
function parsePermissionUpdates(raw: unknown): PermissionUpdate[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const schema = permissionUpdateSchema()
  const valid: PermissionUpdate[] = []
  for (const entry of raw) {
    const result = schema.safeParse(entry)
    if (result.success) {
      valid.push(result.data)
    } else {
      logForDebugging(
        `[SwarmPermissionPoller] Dropping malformed permissionUpdate entry: ${result.error.message}`,
        { level: 'warn' },
      )
    }
  }
  return valid
}

/**
 * 处理权限响应的回调签名
 */
export type PermissionResponseCallback = {
  requestId: string
  toolUseId: string
  onAllow: (
    updatedInput: Record<string, unknown> | undefined,
    permissionUpdates: PermissionUpdate[],
    feedback?: string,
  ) => void
  onReject: (feedback?: string) => void
}

/**
 * 待处理权限请求回调的注册表
 * 这使轮询器能在响应到达时找到并调用正确的回调
 */
type PendingCallbackRegistry = Map<string, PermissionResponseCallback>

// 跨渲染持久化的模块级注册表
const pendingCallbacks: PendingCallbackRegistry = new Map()

/**
 * 为待处理权限请求注册回调
 * 由 useCanUseTool 在 worker 提交权限请求时调用
 */
export function registerPermissionCallback(
  callback: PermissionResponseCallback,
): void {
  pendingCallbacks.set(callback.requestId, callback)
  logForDebugging(
    `[SwarmPermissionPoller] Registered callback for request ${callback.requestId}`,
  )
}

/**
 * 注销回调（例如请求在本地解决或超时时）
 */
export function unregisterPermissionCallback(requestId: string): void {
  pendingCallbacks.delete(requestId)
  logForDebugging(
    `[SwarmPermissionPoller] Unregistered callback for request ${requestId}`,
  )
}

/**
 * 检查请求是否有已注册的回调
 */
export function hasPermissionCallback(requestId: string): boolean {
  return pendingCallbacks.has(requestId)
}

/**
 * 清除所有待处理回调（权限和 sandbox）。
 * 在 /clear 时从 clearSessionCaches() 调用以重置陈旧状态，
 * 也用于测试中的隔离。
 */
export function clearAllPendingCallbacks(): void {
  pendingCallbacks.clear()
  pendingSandboxCallbacks.clear()
}

/**
 * 处理来自 mailbox 消息的权限响应。
 * 由 inbox 轮询器在检测到 permission_response 消息时调用。
 *
 * @returns true if the response was processed, false if no callback was registered
 */
export function processMailboxPermissionResponse(params: {
  requestId: string
  decision: 'approved' | 'rejected'
  feedback?: string
  updatedInput?: Record<string, unknown>
  permissionUpdates?: unknown
}): boolean {
  const callback = pendingCallbacks.get(params.requestId)

  if (!callback) {
    logForDebugging(
      `[SwarmPermissionPoller] No callback registered for mailbox response ${params.requestId}`,
    )
    return false
  }

  logForDebugging(
    `[SwarmPermissionPoller] Processing mailbox response for request ${params.requestId}: ${params.decision}`,
  )

  // 调用回调前从注册表移除
  pendingCallbacks.delete(params.requestId)

  if (params.decision === 'approved') {
    const permissionUpdates = parsePermissionUpdates(params.permissionUpdates)
    const updatedInput = params.updatedInput
    callback.onAllow(updatedInput, permissionUpdates)
  } else {
    callback.onReject(params.feedback)
  }

  return true
}

// ============================================================================
// Sandbox 权限回调注册表
// ============================================================================

/**
 * 处理 sandbox 权限响应的回调签名
 */
export type SandboxPermissionResponseCallback = {
  requestId: string
  host: string
  resolve: (allow: boolean) => void
}

// sandbox 权限回调的模块级注册表
const pendingSandboxCallbacks: Map<string, SandboxPermissionResponseCallback> =
  new Map()

/**
 * 为待处理 sandbox 权限请求注册回调
 * worker 向 leader 发送 sandbox 权限请求时调用
 */
export function registerSandboxPermissionCallback(
  callback: SandboxPermissionResponseCallback,
): void {
  pendingSandboxCallbacks.set(callback.requestId, callback)
  logForDebugging(
    `[SwarmPermissionPoller] Registered sandbox callback for request ${callback.requestId}`,
  )
}

/**
 * 检查 sandbox 请求是否有已注册的回调
 */
export function hasSandboxPermissionCallback(requestId: string): boolean {
  return pendingSandboxCallbacks.has(requestId)
}

/**
 * 处理来自 mailbox 消息的 sandbox 权限响应。
 * 由 inbox 轮询器在检测到 sandbox_permission_response 消息时调用。
 *
 * @returns 响应已处理返回 true，无注册回调返回 false
 */
export function processSandboxPermissionResponse(params: {
  requestId: string
  host: string
  allow: boolean
}): boolean {
  const callback = pendingSandboxCallbacks.get(params.requestId)

  if (!callback) {
    logForDebugging(
      `[SwarmPermissionPoller] No sandbox callback registered for request ${params.requestId}`,
    )
    return false
  }

  logForDebugging(
    `[SwarmPermissionPoller] Processing sandbox response for request ${params.requestId}: allow=${params.allow}`,
  )

  // 调用回调前从注册表移除
  pendingSandboxCallbacks.delete(params.requestId)

  // 用 allow 决定 resolve promise
  callback.resolve(params.allow)

  return true
}

/**
 * 通过调用已注册的回调处理权限响应
 */
function processResponse(response: PermissionResponse): boolean {
  const callback = pendingCallbacks.get(response.requestId)

  if (!callback) {
    logForDebugging(
      `[SwarmPermissionPoller] No callback registered for request ${response.requestId}`,
    )
    return false
  }

  logForDebugging(
    `[SwarmPermissionPoller] Processing response for request ${response.requestId}: ${response.decision}`,
  )

  // 调用回调前从注册表移除
  pendingCallbacks.delete(response.requestId)

  if (response.decision === 'approved') {
    const permissionUpdates = parsePermissionUpdates(response.permissionUpdates)
    const updatedInput = response.updatedInput
    callback.onAllow(updatedInput, permissionUpdates)
  } else {
    callback.onReject(response.feedback)
  }

  return true
}

/**
 * 作为 swarm worker 运行时轮询权限响应的 hook。
 *
 * 此 hook：
 * 1. 仅在 isSwarmWorker() 返回 true 时激活
 * 2. 每 500ms 轮询响应
 * 3. 找到响应时调用已注册的回调
 * 4. 处理后清理响应文件
 */
export function useSwarmPermissionPoller(): void {
  const isProcessingRef = useRef(false)

  const poll = useCallback(async () => {
    // 不是 swarm worker 时不轮询
    if (!isSwarmWorker()) {
      return
    }

    // 防止并发轮询
    if (isProcessingRef.current) {
      return
    }

    // 无注册回调时不轮询
    if (pendingCallbacks.size === 0) {
      return
    }

    isProcessingRef.current = true

    try {
      const agentName = getAgentName()
      const teamName = getTeamName()

      if (!agentName || !teamName) {
        return
      }

      // 检查每个待处理请求是否有响应
      for (const [requestId, _callback] of pendingCallbacks) {
        const response = await pollForResponse(requestId, agentName, teamName)

        if (response) {
          // 处理响应
          const processed = processResponse(response)

          if (processed) {
            // 从 worker 的 inbox 清理响应
            await removeWorkerResponse(requestId, agentName, teamName)
          }
        }
      }
    } catch (error) {
      logForDebugging(
        `[SwarmPermissionPoller] Error during poll: ${errorMessage(error)}`,
      )
    } finally {
      isProcessingRef.current = false
    }
  }, [])

  // 仅在是 swarm worker 时轮询
  const shouldPoll = isSwarmWorker()
  useInterval(() => void poll(), shouldPoll ? POLL_INTERVAL_MS : null)

  // 挂载时初始轮询
  useEffect(() => {
    if (isSwarmWorker()) {
      void poll()
    }
  }, [poll])
}
