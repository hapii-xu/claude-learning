import { getMainThreadAgentType } from '../bootstrap/state.js'
import type { HookResultMessage } from '../types/message.js'
import { createAttachmentMessage } from './attachments.js'
import { logForDebugging } from './debug.js'
import { withDiagnosticsTiming } from './diagLogs.js'
import { isBareMode } from './envUtils.js'
import { updateWatchPaths } from './hooks/fileChangedWatcher.js'
import { shouldAllowManagedHooksOnly } from './hooks/hooksConfigSnapshot.js'
import { executeSessionStartHooks, executeSetupHooks } from './hooks.js'
import { logError } from './log.js'
import { loadPluginHooks } from './plugins/loadPluginHooks.js'

type SessionStartHooksOptions = {
  sessionId?: string
  agentType?: string
  model?: string
  forceSyncExecution?: boolean
}

// 由 processSessionStartHooks 在 hook 发出 initialUserMessage 时设置；
// 由 takeInitialUserMessage 消费一次。此副作用通道避免了更改
// Promise<HookResultMessage[]> 返回类型，而 main.tsx 和 print.ts
// 都已等待该类型（sessionStartHooksPromise 在 main.tsx 中启动，
// 稍后加入 — 将结构性返回类型更改通过该_handoff_传播会触及
// 五个调用点，而该值仅用于 print 模式）。
let pendingInitialUserMessage: string | undefined

export function takeInitialUserMessage(): string | undefined {
  const v = pendingInitialUserMessage
  pendingInitialUserMessage = undefined
  return v
}

// 给 CLAUDE 的说明：不要添加任何"预热"逻辑。**关键**是不要
// 在启动时添加额外工作。
export async function processSessionStartHooks(
  source: 'startup' | 'resume' | 'clear' | 'compact',
  {
    sessionId,
    agentType,
    model,
    forceSyncExecution,
  }: SessionStartHooksOptions = {},
): Promise<HookResultMessage[]> {
  // --bare 跳过所有 hook。executeHooks 在 --bare 下已提前返回
  //（hooks.ts:1861），但这也会跳过下面的 loadPluginHooks() await —
  // 加载永远不会运行的插件 hook 没有意义。
  if (isBareMode()) {
    return []
  }
  const hookMessages: HookResultMessage[] = []
  const additionalContexts: string[] = []
  const allWatchPaths: string[] = []

  // 如果限制为仅托管 hook，则跳过加载插件 hook
  // 插件 hook 是不受信的外部代码，应被策略阻止
  if (shouldAllowManagedHooksOnly()) {
    logForDebugging('Skipping plugin hooks - allowManagedHooksOnly is enabled')
  } else {
    // 确保在执行 SessionStart hook 之前加载插件 hook。
    // loadPluginHooks() 可能在启动期间被提前调用（即发即忘，非阻塞）
    // 以预加载 hook，但我们必须保证在执行前已注册 hook。
    // 此函数已记忆化，因此如果 hook 已加载，则立即返回，
    // 开销可忽略不计（仅一次缓存查找）。
    try {
      await withDiagnosticsTiming('load_plugin_hooks', () => loadPluginHooks())
    } catch (error) {
      // 记录错误但不崩溃 — 在没有插件 hook 的情况下继续会话启动
      /* eslint-disable no-restricted-syntax -- 两个分支都用上下文包装，非 toError 情况 */
      const enhancedError =
        error instanceof Error
          ? new Error(
              `Failed to load plugin hooks during ${source}: ${error.message}`,
            )
          : new Error(
              `Failed to load plugin hooks during ${source}: ${String(error)}`,
            )
      /* eslint-enable no-restricted-syntax */

      if (error instanceof Error && error.stack) {
        enhancedError.stack = error.stack
      }

      logError(enhancedError)

      // 根据错误类型提供具体指导
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      let userGuidance = ''

      if (
        errorMessage.includes('Failed to clone') ||
        errorMessage.includes('network') ||
        errorMessage.includes('ETIMEDOUT') ||
        errorMessage.includes('ENOTFOUND')
      ) {
        userGuidance =
          'This appears to be a network issue. Check your internet connection and try again.'
      } else if (
        errorMessage.includes('Permission denied') ||
        errorMessage.includes('EACCES') ||
        errorMessage.includes('EPERM')
      ) {
        userGuidance =
          'This appears to be a permissions issue. Check file permissions on ~/.hclaude/plugins/'
      } else if (
        errorMessage.includes('Invalid') ||
        errorMessage.includes('parse') ||
        errorMessage.includes('JSON') ||
        errorMessage.includes('schema')
      ) {
        userGuidance =
          'This appears to be a configuration issue. Check your plugin settings in .hclaude/settings.json'
      } else {
        userGuidance =
          'Please fix the plugin configuration or remove problematic plugins from your settings.'
      }

      logForDebugging(
        `Warning: Failed to load plugin hooks. SessionStart hooks from plugins will not execute. ` +
          `Error: ${errorMessage}. ${userGuidance}`,
        { level: 'warn' },
      )

      // 继续执行 — 插件 hook 将不可用，但来自 .hclaude/settings.json
      // 的项目级 hook（通过 captureHooksConfigSnapshot 加载）仍可工作
    }
  }

  // 执行 SessionStart hook，忽略阻塞错误
  // 使用提供的 agentType 或回退到存储在 bootstrap 状态中的值
  const resolvedAgentType = agentType ?? getMainThreadAgentType()
  for await (const hookResult of executeSessionStartHooks(
    source,
    sessionId,
    resolvedAgentType,
    model,
    undefined,
    undefined,
    forceSyncExecution,
  )) {
    if (hookResult.message) {
      hookMessages.push(hookResult.message)
    }
    if (
      hookResult.additionalContexts &&
      hookResult.additionalContexts.length > 0
    ) {
      additionalContexts.push(...hookResult.additionalContexts)
    }
    if (hookResult.initialUserMessage) {
      pendingInitialUserMessage = hookResult.initialUserMessage
    }
    if (hookResult.watchPaths && hookResult.watchPaths.length > 0) {
      allWatchPaths.push(...hookResult.watchPaths)
    }
  }

  if (allWatchPaths.length > 0) {
    updateWatchPaths(allWatchPaths)
  }

  // 如果 hook 提供了额外上下文，则将其作为消息添加
  if (additionalContexts.length > 0) {
    const contextMessage = createAttachmentMessage({
      type: 'hook_additional_context',
      content: additionalContexts,
      hookName: 'SessionStart',
      toolUseID: 'SessionStart',
      hookEvent: 'SessionStart',
    })
    hookMessages.push(contextMessage)
  }

  return hookMessages
}

export async function processSetupHooks(
  trigger: 'init' | 'maintenance',
  { forceSyncExecution }: { forceSyncExecution?: boolean } = {},
): Promise<HookResultMessage[]> {
  // 与上面的 processSessionStartHooks 相同的理由。
  if (isBareMode()) {
    return []
  }
  const hookMessages: HookResultMessage[] = []
  const additionalContexts: string[] = []

  if (shouldAllowManagedHooksOnly()) {
    logForDebugging('Skipping plugin hooks - allowManagedHooksOnly is enabled')
  } else {
    try {
      await loadPluginHooks()
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logForDebugging(
        `Warning: Failed to load plugin hooks. Setup hooks from plugins will not execute. Error: ${errorMessage}`,
        { level: 'warn' },
      )
    }
  }

  for await (const hookResult of executeSetupHooks(
    trigger,
    undefined,
    undefined,
    forceSyncExecution,
  )) {
    if (hookResult.message) {
      hookMessages.push(hookResult.message)
    }
    if (
      hookResult.additionalContexts &&
      hookResult.additionalContexts.length > 0
    ) {
      additionalContexts.push(...hookResult.additionalContexts)
    }
  }

  if (additionalContexts.length > 0) {
    const contextMessage = createAttachmentMessage({
      type: 'hook_additional_context',
      content: additionalContexts,
      hookName: 'Setup',
      toolUseID: 'Setup',
      hookEvent: 'Setup',
    })
    hookMessages.push(contextMessage)
  }

  return hookMessages
}
