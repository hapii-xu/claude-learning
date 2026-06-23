import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionMode } from './PermissionMode.js'
import { transitionPermissionMode } from './permissionSetup.js'

/**
 * 确定使用 Shift+Tab 循环模式时的下一个权限模式。
 *
 * 所有用户的统一循环（不区分 USER_TYPE）：
 *   default → acceptEdits → plan → auto → bypassPermissions → default
 */
export function getNextPermissionMode(
  toolPermissionContext: ToolPermissionContext,
  _teamContext?: { leadAgentId: string },
): PermissionMode {
  switch (toolPermissionContext.mode) {
    case 'default':
      return 'acceptEdits'

    case 'acceptEdits':
      return 'plan'

    case 'plan':
      return 'auto'

    case 'auto':
      if (toolPermissionContext.isBypassPermissionsModeAvailable) {
        return 'bypassPermissions'
      }
      return 'default'

    case 'bypassPermissions':
      return 'default'

    case 'dontAsk':
      // 尚未在 UI 循环中暴露，但如果以某种方式到达则返回 default
      return 'default'

    default:
      // 涵盖任何未来模式——始终回退到 default
      return 'default'
  }
}

/**
 * 计算下一个权限模式并为其准备上下文。
 * 处理目标模式所需的任何上下文清理（例如，进入 auto 模式时
 * 剥离危险权限）。
 *
 * @returns 下一个模式和要使用的上下文（如果需要则已剥离危险权限）
 */
export function cyclePermissionMode(
  toolPermissionContext: ToolPermissionContext,
  teamContext?: { leadAgentId: string },
): { nextMode: PermissionMode; context: ToolPermissionContext } {
  const nextMode = getNextPermissionMode(toolPermissionContext, teamContext)
  return {
    nextMode,
    context: transitionPermissionMode(
      toolPermissionContext.mode,
      nextMode,
      toolPermissionContext,
    ),
  }
}
