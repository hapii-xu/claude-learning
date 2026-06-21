import { feature } from 'bun:bundle'
import type { PendingClassifierCheck } from '../../../types/permissions.js'
import { logError } from '../../../utils/log.js'
import type { PermissionDecision } from '../../../utils/permissions/PermissionResult.js'
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js'
import type { PermissionContext } from '../PermissionContext.js'

type CoordinatorPermissionParams = {
  ctx: PermissionContext
  pendingClassifierCheck?: PendingClassifierCheck | undefined
  updatedInput: Record<string, unknown> | undefined
  suggestions: PermissionUpdate[] | undefined
  permissionMode: string | undefined
}

/**
 * 处理协调器 worker 的权限流程。
 *
 * 对于协调器 worker，自动化检查（hooks 和分类器）会
 * 按顺序等待完成，然后才回退到交互式对话框。
 *
 * 如果自动化检查解决了权限则返回 PermissionDecision，
 * 如果调用方应回退到交互式对话框则返回 null。
 */
async function handleCoordinatorPermission(
  params: CoordinatorPermissionParams,
): Promise<PermissionDecision | null> {
  const { ctx, updatedInput, suggestions, permissionMode } = params

  try {
    // 1. 首先尝试权限 hooks（快速、本地）
    const hookResult = await ctx.runHooks(
      permissionMode,
      suggestions,
      updatedInput,
    )
    if (hookResult) return hookResult

    // 2. 尝试分类器（慢、推理 —— 仅 bash）
    const classifierResult = feature('BASH_CLASSIFIER')
      ? await ctx.tryClassifier?.(params.pendingClassifierCheck, updatedInput)
      : null
    if (classifierResult) {
      return classifierResult
    }
  } catch (error) {
    // 如果自动化检查意外失败，回退到显示对话框
    // 以便用户手动决定。非 Error 抛出会获得一个上下文前缀
    // 使日志可追踪 —— 故意不使用 toError()，那会丢弃
    // 前缀。
    if (error instanceof Error) {
      logError(error)
    } else {
      logError(new Error(`Automated permission check failed: ${String(error)}`))
    }
  }

  // 3. 两者都未解决（或检查失败）—— 回退到下方对话框。
  // Hooks 已运行，分类器已消费。
  return null
}

export { handleCoordinatorPermission }
export type { CoordinatorPermissionParams }
