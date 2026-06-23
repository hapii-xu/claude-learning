/**
 * Agent Swarm 的同步权限提示
 *
 * 本模块提供在 swarm 中多个 agent 之间协调权限提示的基础设施。
 * 当 worker agent 需要工具使用的权限时，
 * 它可以将请求转发给团队 leader，由 leader 批准或拒绝。
 *
 * 系统使用 teammate 邮箱进行消息传递：
 * - Worker 向 leader 的邮箱发送权限请求
 * - Leader 向 worker 的邮箱发送权限响应
 *
 * 流程：
 * 1. Worker agent 遇到权限提示
 * 2. Worker 向 leader 的邮箱发送 permission_request 消息
 * 3. Leader 轮询邮箱消息并检测到权限请求
 * 4. 用户通过 leader 的 UI 批准/拒绝
 * 5. Leader 向 worker 的邮箱发送 permission_response 消息
 * 6. Worker 轮询邮箱获取响应并继续执行
 */

import { mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import { logForDebugging } from '../debug.js'
import { getErrnoCode } from '../errors.js'
import { lazySchema } from '../lazySchema.js'
import * as lockfile from '../lockfile.js'
import { logError } from '../log.js'
import type { PermissionUpdate } from '../permissions/PermissionUpdateSchema.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import {
  getAgentId,
  getAgentName,
  getTeammateColor,
  getTeamName,
} from '../teammate.js'
import {
  createPermissionRequestMessage,
  createPermissionResponseMessage,
  createSandboxPermissionRequestMessage,
  createSandboxPermissionResponseMessage,
  writeToMailbox,
} from '../teammateMailbox.js'
import { getTeamDir, readTeamFileAsync } from './teamHelpers.js'

/**
 * worker 向 leader 发送权限请求的完整请求 schema
 */
export const SwarmPermissionRequestSchema = lazySchema(() =>
  z.object({
    /** 此请求的唯一标识符 */
    id: z.string(),
    /** Worker 的 CLAUDE_CODE_AGENT_ID */
    workerId: z.string(),
    /** Worker 的 CLAUDE_CODE_AGENT_NAME */
    workerName: z.string(),
    /** Worker 的 CLAUDE_CODE_AGENT_COLOR */
    workerColor: z.string().optional(),
    /** 用于路由的团队名称 */
    teamName: z.string(),
    /** 需要权限的工具名称（例如 "Bash"、"Edit"） */
    toolName: z.string(),
    /** 来自 worker 上下文的原始 toolUseID */
    toolUseId: z.string(),
    /** 工具使用的可读描述 */
    description: z.string(),
    /** 序列化的工具输入 */
    input: z.record(z.string(), z.unknown()),
    /** 来自权限结果的权限规则建议 */
    permissionSuggestions: z.array(z.unknown()),
    /** 请求的状态 */
    status: z.enum(['pending', 'approved', 'rejected']),
    /** 谁解决了此请求 */
    resolvedBy: z.enum(['worker', 'leader']).optional(),
    /** 解决时的时间戳 */
    resolvedAt: z.number().optional(),
    /** 拒绝反馈消息 */
    feedback: z.string().optional(),
    /** 如果解决者修改了输入，则为修改后的输入 */
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    /** 解决期间应用的"始终允许"规则 */
    permissionUpdates: z.array(z.unknown()).optional(),
    /** 请求创建时的时间戳 */
    createdAt: z.number(),
  }),
)

export type SwarmPermissionRequest = z.infer<
  ReturnType<typeof SwarmPermissionRequestSchema>
>

/**
 * leader/worker 解决请求时返回的解决数据
 */
export type PermissionResolution = {
  /** 决定：批准或拒绝 */
  decision: 'approved' | 'rejected'
  /** 谁解决了此请求 */
  resolvedBy: 'worker' | 'leader'
  /** 如果被拒绝，可选的反馈消息 */
  feedback?: string
  /** 如果解决者修改了，可选的更新输入 */
  updatedInput?: Record<string, unknown>
  /** 要应用的权限更新（例如"始终允许"规则） */
  permissionUpdates?: PermissionUpdate[]
}

/**
 * 获取团队权限请求的基础目录
 * 路径：~/.claude/teams/{teamName}/permissions/
 */
export function getPermissionDir(teamName: string): string {
  return join(getTeamDir(teamName), 'permissions')
}

/**
 * 获取团队的待处理目录
 */
function getPendingDir(teamName: string): string {
  return join(getPermissionDir(teamName), 'pending')
}

/**
 * 获取团队的已解决目录
 */
function getResolvedDir(teamName: string): string {
  return join(getPermissionDir(teamName), 'resolved')
}

/**
 * 确保权限目录结构存在（异步）
 */
async function ensurePermissionDirsAsync(teamName: string): Promise<void> {
  const permDir = getPermissionDir(teamName)
  const pendingDir = getPendingDir(teamName)
  const resolvedDir = getResolvedDir(teamName)

  for (const dir of [permDir, pendingDir, resolvedDir]) {
    await mkdir(dir, { recursive: true })
  }
}

/**
 * 获取待处理请求文件的路径
 */
function getPendingRequestPath(teamName: string, requestId: string): string {
  return join(getPendingDir(teamName), `${requestId}.json`)
}

/**
 * 获取已解决请求文件的路径
 */
function getResolvedRequestPath(teamName: string, requestId: string): string {
  return join(getResolvedDir(teamName), `${requestId}.json`)
}

/**
 * 生成唯一的请求 ID
 */
export function generateRequestId(): string {
  return `perm-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

/**
 * 创建一个新的 SwarmPermissionRequest 对象
 */
export function createPermissionRequest(params: {
  toolName: string
  toolUseId: string
  input: Record<string, unknown>
  description: string
  permissionSuggestions?: unknown[]
  teamName?: string
  workerId?: string
  workerName?: string
  workerColor?: string
}): SwarmPermissionRequest {
  const teamName = params.teamName || getTeamName()
  const workerId = params.workerId || getAgentId()
  const workerName = params.workerName || getAgentName()
  const workerColor = params.workerColor || getTeammateColor()

  if (!teamName) {
    throw new Error('Team name is required for permission requests')
  }
  if (!workerId) {
    throw new Error('Worker ID is required for permission requests')
  }
  if (!workerName) {
    throw new Error('Worker name is required for permission requests')
  }

  return {
    id: generateRequestId(),
    workerId,
    workerName,
    workerColor,
    teamName,
    toolName: params.toolName,
    toolUseId: params.toolUseId,
    description: params.description,
    input: params.input,
    permissionSuggestions: params.permissionSuggestions || [],
    status: 'pending',
    createdAt: Date.now(),
  }
}

/**
 * 将权限请求写入待处理目录，带文件锁定
 * 由 worker agent 在需要 leader 权限批准时调用
 *
 * @returns 写入的请求
 */
export async function writePermissionRequest(
  request: SwarmPermissionRequest,
): Promise<SwarmPermissionRequest> {
  await ensurePermissionDirsAsync(request.teamName)

  const pendingPath = getPendingRequestPath(request.teamName, request.id)
  const lockDir = getPendingDir(request.teamName)

  // 创建目录级锁文件以实现原子写入
  const lockFilePath = join(lockDir, '.lock')
  await writeFile(lockFilePath, '', 'utf-8')

  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(lockFilePath)

    // 写入请求文件
    await writeFile(pendingPath, jsonStringify(request, null, 2), 'utf-8')

    logForDebugging(
      `[PermissionSync] Wrote pending request ${request.id} from ${request.workerName} for ${request.toolName}`,
    )

    return request
  } catch (error) {
    logForDebugging(
      `[PermissionSync] Failed to write permission request: ${error}`,
    )
    logError(error)
    throw error
  } finally {
    if (release) {
      await release()
    }
  }
}

/**
 * 读取团队所有待处理的权限请求
 * 由团队 leader 调用以查看需要处理的请求
 */
export async function readPendingPermissions(
  teamName?: string,
): Promise<SwarmPermissionRequest[]> {
  const team = teamName || getTeamName()
  if (!team) {
    logForDebugging('[PermissionSync] No team name available')
    return []
  }

  const pendingDir = getPendingDir(team)

  let files: string[]
  try {
    files = await readdir(pendingDir)
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return []
    }
    logForDebugging(`[PermissionSync] Failed to read pending requests: ${e}`)
    logError(e)
    return []
  }

  const jsonFiles = files.filter(f => f.endsWith('.json') && f !== '.lock')

  const results = await Promise.all(
    jsonFiles.map(async file => {
      const filePath = join(pendingDir, file)
      try {
        const content = await readFile(filePath, 'utf-8')
        const parsed = SwarmPermissionRequestSchema().safeParse(
          jsonParse(content),
        )
        if (parsed.success) {
          return parsed.data
        }
        logForDebugging(
          `[PermissionSync] Invalid request file ${file}: ${parsed.error.message}`,
        )
        return null
      } catch (err) {
        logForDebugging(
          `[PermissionSync] Failed to read request file ${file}: ${err}`,
        )
        return null
      }
    }),
  )

  const requests = results.filter(r => r !== null)

  // 按创建时间排序（最旧的在前）
  requests.sort((a, b) => a.createdAt - b.createdAt)

  return requests
}

/**
 * 按 ID 读取已解决的权限请求
 * 由 worker 调用以检查其请求是否已被解决
 *
 * @returns 已解决的请求，如果尚未解决则返回 null
 */
export async function readResolvedPermission(
  requestId: string,
  teamName?: string,
): Promise<SwarmPermissionRequest | null> {
  const team = teamName || getTeamName()
  if (!team) {
    return null
  }

  const resolvedPath = getResolvedRequestPath(team, requestId)

  try {
    const content = await readFile(resolvedPath, 'utf-8')
    const parsed = SwarmPermissionRequestSchema().safeParse(jsonParse(content))
    if (parsed.success) {
      return parsed.data
    }
    logForDebugging(
      `[PermissionSync] Invalid resolved request ${requestId}: ${parsed.error.message}`,
    )
    return null
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return null
    }
    logForDebugging(
      `[PermissionSync] Failed to read resolved request ${requestId}: ${e}`,
    )
    logError(e)
    return null
  }
}

/**
 * 解决权限请求
 * 由团队 leader（或在自解决情况下的 worker）调用
 *
 * 将解决结果写入 resolved/，从 pending/ 中移除
 */
export async function resolvePermission(
  requestId: string,
  resolution: PermissionResolution,
  teamName?: string,
): Promise<boolean> {
  const team = teamName || getTeamName()
  if (!team) {
    logForDebugging('[PermissionSync] No team name available')
    return false
  }

  await ensurePermissionDirsAsync(team)

  const pendingPath = getPendingRequestPath(team, requestId)
  const resolvedPath = getResolvedRequestPath(team, requestId)
  const lockFilePath = join(getPendingDir(team), '.lock')

  await writeFile(lockFilePath, '', 'utf-8')

  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(lockFilePath)

    // 读取待处理的请求
    let content: string
    try {
      content = await readFile(pendingPath, 'utf-8')
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT') {
        logForDebugging(
          `[PermissionSync] Pending request not found: ${requestId}`,
        )
        return false
      }
      throw e
    }

    const parsed = SwarmPermissionRequestSchema().safeParse(jsonParse(content))
    if (!parsed.success) {
      logForDebugging(
        `[PermissionSync] Invalid pending request ${requestId}: ${parsed.error.message}`,
      )
      return false
    }

    const request = parsed.data

    // 使用解决数据更新请求
    const resolvedRequest: SwarmPermissionRequest = {
      ...request,
      status: resolution.decision === 'approved' ? 'approved' : 'rejected',
      resolvedBy: resolution.resolvedBy,
      resolvedAt: Date.now(),
      feedback: resolution.feedback,
      updatedInput: resolution.updatedInput,
      permissionUpdates: resolution.permissionUpdates,
    }

    // 写入已解决目录
    await writeFile(
      resolvedPath,
      jsonStringify(resolvedRequest, null, 2),
      'utf-8',
    )

    // 从待处理目录中移除
    await unlink(pendingPath)

    logForDebugging(
      `[PermissionSync] Resolved request ${requestId} with ${resolution.decision}`,
    )

    return true
  } catch (error) {
    logForDebugging(`[PermissionSync] Failed to resolve request: ${error}`)
    logError(error)
    return false
  } finally {
    if (release) {
      await release()
    }
  }
}

/**
 * 清理旧的已解决权限文件
 * 定期调用以防止文件堆积
 *
 * @param teamName - 团队名称
 * @param maxAgeMs - 最大年龄（毫秒）（默认：1 小时）
 */
export async function cleanupOldResolutions(
  teamName?: string,
  maxAgeMs = 3600000,
): Promise<number> {
  const team = teamName || getTeamName()
  if (!team) {
    return 0
  }

  const resolvedDir = getResolvedDir(team)

  let files: string[]
  try {
    files = await readdir(resolvedDir)
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return 0
    }
    logForDebugging(`[PermissionSync] Failed to cleanup resolutions: ${e}`)
    logError(e)
    return 0
  }

  const now = Date.now()
  const jsonFiles = files.filter(f => f.endsWith('.json'))

  const cleanupResults = await Promise.all(
    jsonFiles.map(async file => {
      const filePath = join(resolvedDir, file)
      try {
        const content = await readFile(filePath, 'utf-8')
        const request = jsonParse(content) as SwarmPermissionRequest

        // 检查解决是否足够旧以进行清理
        // 使用 >= 处理 maxAgeMs 为 0 的边界情况（清理所有内容）
        const resolvedAt = request.resolvedAt || request.createdAt
        if (now - resolvedAt >= maxAgeMs) {
          await unlink(filePath)
          logForDebugging(`[PermissionSync] Cleaned up old resolution: ${file}`)
          return 1
        }
        return 0
      } catch {
        // 如果无法解析，无论如何清理掉
        try {
          await unlink(filePath)
          return 1
        } catch {
          // 忽略删除错误
          return 0
        }
      }
    }),
  )

  const cleanedCount = cleanupResults.reduce<number>((sum, n) => sum + n, 0)

  if (cleanedCount > 0) {
    logForDebugging(
      `[PermissionSync] Cleaned up ${cleanedCount} old resolutions`,
    )
  }

  return cleanedCount
}

/**
 * Worker 轮询的旧版响应类型
 * 用于与 worker 集成代码保持向后兼容
 */
export type PermissionResponse = {
  /** 响应对应的请求 ID */
  requestId: string
  /** 决定：批准或拒绝 */
  decision: 'approved' | 'denied'
  /** 响应创建时的时间戳 */
  timestamp: string
  /** 如果被拒绝，可选的反馈消息 */
  feedback?: string
  /** 如果解决者修改了，可选的更新输入 */
  updatedInput?: Record<string, unknown>
  /** 要应用的权限更新（例如"始终允许"规则） */
  permissionUpdates?: unknown[]
}

/**
 * 轮询权限响应（worker 端便捷函数）
 * 将已解决的请求转换为更简单的响应格式
 *
 * @returns 权限响应，如果尚未解决则返回 null
 */
export async function pollForResponse(
  requestId: string,
  _agentName?: string,
  teamName?: string,
): Promise<PermissionResponse | null> {
  const resolved = await readResolvedPermission(requestId, teamName)
  if (!resolved) {
    return null
  }

  return {
    requestId: resolved.id,
    decision: resolved.status === 'approved' ? 'approved' : 'denied',
    timestamp: resolved.resolvedAt
      ? new Date(resolved.resolvedAt).toISOString()
      : new Date(resolved.createdAt).toISOString(),
    feedback: resolved.feedback,
    updatedInput: resolved.updatedInput,
    permissionUpdates: resolved.permissionUpdates,
  }
}

/**
 * 处理后移除 worker 的响应
 * 这是 deleteResolvedPermission 的别名，用于向后兼容
 */
export async function removeWorkerResponse(
  requestId: string,
  _agentName?: string,
  teamName?: string,
): Promise<void> {
  await deleteResolvedPermission(requestId, teamName)
}

/**
 * 检查当前 agent 是否为团队 leader
 */
export function isTeamLeader(teamName?: string): boolean {
  const team = teamName || getTeamName()
  if (!team) {
    return false
  }

  // 团队 leader 没有设置 agent ID，或者其 ID 为 'team-lead'
  const agentId = getAgentId()

  return !agentId || agentId === 'team-lead'
}

/**
 * 检查当前 agent 是否为 swarm 中的 worker
 */
export function isSwarmWorker(): boolean {
  const teamName = getTeamName()
  const agentId = getAgentId()

  return !!teamName && !!agentId && !isTeamLeader()
}

/**
 * 删除已解决的权限文件
 * 在 worker 处理完解决结果后调用
 */
export async function deleteResolvedPermission(
  requestId: string,
  teamName?: string,
): Promise<boolean> {
  const team = teamName || getTeamName()
  if (!team) {
    return false
  }

  const resolvedPath = getResolvedRequestPath(team, requestId)

  try {
    await unlink(resolvedPath)
    logForDebugging(
      `[PermissionSync] Deleted resolved permission: ${requestId}`,
    )
    return true
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return false
    }
    logForDebugging(
      `[PermissionSync] Failed to delete resolved permission: ${e}`,
    )
    logError(e)
    return false
  }
}

/**
 * 提交权限请求（writePermissionRequest 的别名）
 * 为与 worker 集成代码保持向后兼容而提供
 */
export const submitPermissionRequest = writePermissionRequest

// ============================================================================
// 基于邮箱的权限系统
// ============================================================================

/**
 * 从团队文件中获取 leader 的名称
 * 这是向 leader 的邮箱发送权限请求所必需的
 */
export async function getLeaderName(teamName?: string): Promise<string | null> {
  const team = teamName || getTeamName()
  if (!team) {
    return null
  }

  const teamFile = await readTeamFileAsync(team)
  if (!teamFile) {
    logForDebugging(`[PermissionSync] Team file not found for team: ${team}`)
    return null
  }

  const leadMember = teamFile.members.find(
    m => m.agentId === teamFile.leadAgentId,
  )
  return leadMember?.name || 'team-lead'
}

/**
 * 通过邮箱向 leader 发送权限请求。
 * 这是替代基于文件的 pending 目录的新邮箱方案。
 *
 * @param request - 要发送的权限请求
 * @returns 如果消息发送成功则返回 true
 */
export async function sendPermissionRequestViaMailbox(
  request: SwarmPermissionRequest,
): Promise<boolean> {
  const leaderName = await getLeaderName(request.teamName)
  if (!leaderName) {
    logForDebugging(
      `[PermissionSync] Cannot send permission request: leader name not found`,
    )
    return false
  }

  try {
    // 创建权限请求消息
    const message = createPermissionRequestMessage({
      request_id: request.id,
      agent_id: request.workerName,
      tool_name: request.toolName,
      tool_use_id: request.toolUseId,
      description: request.description,
      input: request.input,
      permission_suggestions: request.permissionSuggestions,
    })

    // 发送到 leader 的邮箱（根据接收者路由到进程内或基于文件的邮箱）
    await writeToMailbox(
      leaderName,
      {
        from: request.workerName,
        text: jsonStringify(message),
        timestamp: new Date().toISOString(),
        color: request.workerColor,
      },
      request.teamName,
    )

    logForDebugging(
      `[PermissionSync] Sent permission request ${request.id} to leader ${leaderName} via mailbox`,
    )
    return true
  } catch (error) {
    logForDebugging(
      `[PermissionSync] Failed to send permission request via mailbox: ${error}`,
    )
    logError(error)
    return false
  }
}

/**
 * 通过邮箱向 worker 发送权限响应。
 * 这是替代基于文件的 resolved 目录的新邮箱方案。
 *
 * @param workerName - 要发送响应的 worker 名称
 * @param resolution - 权限解决结果
 * @param requestId - 原始请求 ID
 * @param teamName - 团队名称
 * @returns 如果消息发送成功则返回 true
 */
export async function sendPermissionResponseViaMailbox(
  workerName: string,
  resolution: PermissionResolution,
  requestId: string,
  teamName?: string,
): Promise<boolean> {
  const team = teamName || getTeamName()
  if (!team) {
    logForDebugging(
      `[PermissionSync] Cannot send permission response: team name not found`,
    )
    return false
  }

  try {
    // 创建权限响应消息
    const message = createPermissionResponseMessage({
      request_id: requestId,
      subtype: resolution.decision === 'approved' ? 'success' : 'error',
      error: resolution.feedback,
      updated_input: resolution.updatedInput,
      permission_updates: resolution.permissionUpdates,
    })

    // 获取发送者名称（leader 的名称）
    const senderName = getAgentName() || 'team-lead'

    // 发送到 worker 的邮箱（根据接收者路由到进程内或基于文件的邮箱）
    await writeToMailbox(
      workerName,
      {
        from: senderName,
        text: jsonStringify(message),
        timestamp: new Date().toISOString(),
      },
      team,
    )

    logForDebugging(
      `[PermissionSync] Sent permission response for ${requestId} to worker ${workerName} via mailbox`,
    )
    return true
  } catch (error) {
    logForDebugging(
      `[PermissionSync] Failed to send permission response via mailbox: ${error}`,
    )
    logError(error)
    return false
  }
}

// ============================================================================
// 沙箱权限邮箱系统
// ============================================================================

/**
 * 生成唯一的沙箱权限请求 ID
 */
export function generateSandboxRequestId(): string {
  return `sandbox-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

/**
 * 通过邮箱向 leader 发送沙箱权限请求。
 * 当沙箱运行时需要网络访问批准时由 worker 调用。
 *
 * @param host - 请求网络访问的主机
 * @param requestId - 此请求的唯一 ID
 * @param teamName - 可选的团队名称
 * @returns 如果消息发送成功则返回 true
 */
export async function sendSandboxPermissionRequestViaMailbox(
  host: string,
  requestId: string,
  teamName?: string,
): Promise<boolean> {
  const team = teamName || getTeamName()
  if (!team) {
    logForDebugging(
      `[PermissionSync] Cannot send sandbox permission request: team name not found`,
    )
    return false
  }

  const leaderName = await getLeaderName(team)
  if (!leaderName) {
    logForDebugging(
      `[PermissionSync] Cannot send sandbox permission request: leader name not found`,
    )
    return false
  }

  const workerId = getAgentId()
  const workerName = getAgentName()
  const workerColor = getTeammateColor()

  if (!workerId || !workerName) {
    logForDebugging(
      `[PermissionSync] Cannot send sandbox permission request: worker ID or name not found`,
    )
    return false
  }

  try {
    const message = createSandboxPermissionRequestMessage({
      requestId,
      workerId,
      workerName,
      workerColor,
      host,
    })

    // 发送到 leader 的邮箱（根据接收者路由到进程内或基于文件的邮箱）
    await writeToMailbox(
      leaderName,
      {
        from: workerName,
        text: jsonStringify(message),
        timestamp: new Date().toISOString(),
        color: workerColor,
      },
      team,
    )

    logForDebugging(
      `[PermissionSync] Sent sandbox permission request ${requestId} for host ${host} to leader ${leaderName} via mailbox`,
    )
    return true
  } catch (error) {
    logForDebugging(
      `[PermissionSync] Failed to send sandbox permission request via mailbox: ${error}`,
    )
    logError(error)
    return false
  }
}

/**
 * 通过邮箱向 worker 发送沙箱权限响应。
 * 由 leader 在批准/拒绝沙箱网络访问请求时调用。
 *
 * @param workerName - 要发送响应的 worker 名称
 * @param requestId - 原始请求 ID
 * @param host - 被批准/拒绝的主机
 * @param allow - 是否允许连接
 * @param teamName - 可选的团队名称
 * @returns 如果消息发送成功则返回 true
 */
export async function sendSandboxPermissionResponseViaMailbox(
  workerName: string,
  requestId: string,
  host: string,
  allow: boolean,
  teamName?: string,
): Promise<boolean> {
  const team = teamName || getTeamName()
  if (!team) {
    logForDebugging(
      `[PermissionSync] Cannot send sandbox permission response: team name not found`,
    )
    return false
  }

  try {
    const message = createSandboxPermissionResponseMessage({
      requestId,
      host,
      allow,
    })

    const senderName = getAgentName() || 'team-lead'

    // 发送到 worker 的邮箱（根据接收者路由到进程内或基于文件的邮箱）
    await writeToMailbox(
      workerName,
      {
        from: senderName,
        text: jsonStringify(message),
        timestamp: new Date().toISOString(),
      },
      team,
    )

    logForDebugging(
      `[PermissionSync] Sent sandbox permission response for ${requestId} (host: ${host}, allow: ${allow}) to worker ${workerName} via mailbox`,
    )
    return true
  } catch (error) {
    logForDebugging(
      `[PermissionSync] Failed to send sandbox permission response via mailbox: ${error}`,
    )
    logError(error)
    return false
  }
}
