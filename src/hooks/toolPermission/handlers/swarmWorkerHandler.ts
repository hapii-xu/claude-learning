import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { PendingClassifierCheck } from '../../../types/permissions.js'
import { isAgentSwarmsEnabled } from '../../../utils/agentSwarmsEnabled.js'
import { toError } from '../../../utils/errors.js'
import { logError } from '../../../utils/log.js'
import type { PermissionDecision } from '../../../utils/permissions/PermissionResult.js'
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js'
import {
  createPermissionRequest,
  isSwarmWorker,
  sendPermissionRequestViaMailbox,
} from '../../../utils/swarm/permissionSync.js'
import { registerPermissionCallback } from '../../useSwarmPermissionPoller.js'
import type { PermissionContext } from '../PermissionContext.js'
import { createResolveOnce } from '../PermissionContext.js'

type SwarmWorkerPermissionParams = {
  ctx: PermissionContext
  description: string
  pendingClassifierCheck?: PendingClassifierCheck | undefined
  updatedInput: Record<string, unknown> | undefined
  suggestions: PermissionUpdate[] | undefined
}

/**
 * 处理 swarm worker 的权限流程。
 *
 * 作为 swarm worker 运行时：
 * 1. 尝试对 bash 命令进行分类器自动批准
 * 2. 通过邮箱将权限请求转发给 leader
 * 3. 注册 leader 响应时的回调
 * 4. 等待时设置待处理指示器
 *
 * 如果分类器自动批准则返回 PermissionDecision，
 * 或返回一个在 leader 响应时解决的 Promise。
 * 如果 swarm 未启用或这不是 swarm worker 则返回 null，
 * 以便调用方可以回退到交互式处理。
 */
async function handleSwarmWorkerPermission(
  params: SwarmWorkerPermissionParams,
): Promise<PermissionDecision | null> {
  if (!isAgentSwarmsEnabled() || !isSwarmWorker()) {
    return null
  }

  const { ctx, description, updatedInput, suggestions } = params

  // 对于 bash 命令，在转发给 leader 之前尝试分类器自动批准。
  // Agent 等待分类器结果（而不是像主 agent 那样与用户交互竞争）。
  const classifierResult = feature('BASH_CLASSIFIER')
    ? await ctx.tryClassifier?.(params.pendingClassifierCheck, updatedInput)
    : null
  if (classifierResult) {
    return classifierResult
  }

  // 通过邮箱将权限请求转发给 leader
  try {
    const clearPendingRequest = (): void =>
      ctx.toolUseContext.setAppState(prev => ({
        ...prev,
        pendingWorkerRequest: null,
      }))

    const decision = await new Promise<PermissionDecision>(resolve => {
      const { resolve: resolveOnce, claim } = createResolveOnce(resolve)

      // 创建权限请求
      const request = createPermissionRequest({
        toolName: ctx.tool.name,
        toolUseId: ctx.toolUseID,
        input: ctx.input,
        description,
        permissionSuggestions: suggestions,
      })

      // 在发送请求之前注册回调以避免竞争条件
      // （leader 在回调注册之前就响应了）
      registerPermissionCallback({
        requestId: request.id,
        toolUseId: ctx.toolUseID,
        async onAllow(
          allowedInput: Record<string, unknown> | undefined,
          permissionUpdates: PermissionUpdate[],
          feedback?: string,
          contentBlocks?: ContentBlockParam[],
        ) {
          if (!claim()) return // await 之前的原子检查并标记
          clearPendingRequest()

          // 将更新的输入与原始输入合并
          const finalInput =
            allowedInput && Object.keys(allowedInput).length > 0
              ? allowedInput
              : ctx.input

          resolveOnce(
            await ctx.handleUserAllow(
              finalInput,
              permissionUpdates,
              feedback,
              undefined,
              contentBlocks,
            ),
          )
        },
        onReject(feedback?: string, contentBlocks?: ContentBlockParam[]) {
          if (!claim()) return
          clearPendingRequest()

          ctx.logDecision({
            decision: 'reject',
            source: { type: 'user_reject', hasFeedback: !!feedback },
          })

          resolveOnce(ctx.cancelAndAbort(feedback, undefined, contentBlocks))
        },
      })

      // 现在回调已注册，向 leader 发送请求
      void sendPermissionRequestViaMailbox(request)

      // 显示视觉指示器表示我们正在等待 leader 批准
      ctx.toolUseContext.setAppState(prev => ({
        ...prev,
        pendingWorkerRequest: {
          toolName: ctx.tool.name,
          toolUseId: ctx.toolUseID,
          description,
        },
      }))

      // 如果在等待 leader 响应时 abort 信号触发，
      // 用取消决定解决 promise 以免其挂起。
      ctx.toolUseContext.abortController.signal.addEventListener(
        'abort',
        () => {
          if (!claim()) return
          clearPendingRequest()
          ctx.logCancelled()
          resolveOnce(ctx.cancelAndAbort(undefined, true))
        },
        { once: true },
      )
    })

    return decision
  } catch (error) {
    // 如果 swarm 权限提交失败，回退到本地处理
    logError(toError(error))
    // 继续到下方的本地 UI 处理
    return null
  }
}

export { handleSwarmWorkerPermission }
export type { SwarmWorkerPermissionParams }
