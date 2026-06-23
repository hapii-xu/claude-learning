import memoize from 'lodash-es/memoize.js'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import {
  clearRegisteredPluginHooks,
  getRegisteredHooks,
  registerHookCallbacks,
} from '../../bootstrap/state.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import { logForDebugging } from '../debug.js'
import { settingsChangeDetector } from '../settings/changeDetector.js'
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
} from '../settings/settings.js'
import type { PluginHookMatcher } from '../settings/types.js'
import { jsonStringify } from '../slowOperations.js'
import { clearPluginCache, loadAllPluginsCacheOnly } from './pluginLoader.js'

// 跟踪热重载订阅是否已设置
let hotReloadSubscribed = false

// 用于热重载变更检测的 enabledPlugins 快照
let lastPluginSettingsSnapshot: string | undefined

/**
 * 将插件 hooks 配置转换为带有插件上下文的原生匹配器
 */
function convertPluginHooksToMatchers(
  plugin: LoadedPlugin,
): Record<HookEvent, PluginHookMatcher[]> {
  const pluginMatchers: Record<HookEvent, PluginHookMatcher[]> = {
    PreToolUse: [],
    PostToolUse: [],
    PostToolUseFailure: [],
    PermissionDenied: [],
    Notification: [],
    UserPromptSubmit: [],
    SessionStart: [],
    SessionEnd: [],
    Stop: [],
    StopFailure: [],
    SubagentStart: [],
    SubagentStop: [],
    PreCompact: [],
    PostCompact: [],
    PermissionRequest: [],
    Setup: [],
    TeammateIdle: [],
    TaskCreated: [],
    TaskCompleted: [],
    Elicitation: [],
    ElicitationResult: [],
    ConfigChange: [],
    WorktreeCreate: [],
    WorktreeRemove: [],
    InstructionsLoaded: [],
    CwdChanged: [],
    FileChanged: [],
  }

  if (!plugin.hooksConfig) {
    return pluginMatchers
  }

  // 处理每个 hook 事件 —— 将所有 hook 类型连同插件上下文一起传递
  for (const [event, matchers] of Object.entries(plugin.hooksConfig)) {
    const hookEvent = event as HookEvent
    if (!pluginMatchers[hookEvent]) {
      continue
    }

    for (const matcher of matchers ?? []) {
      if (matcher.hooks.length > 0) {
        pluginMatchers[hookEvent].push({
          matcher: matcher.matcher,
          hooks: matcher.hooks,
          pluginRoot: plugin.path,
          pluginName: plugin.name,
          pluginId: plugin.source,
        })
      }
    }
  }

  return pluginMatchers
}

/**
 * 从所有已启用插件中加载并注册 hooks
 */
export const loadPluginHooks = memoize(async (): Promise<void> => {
  const { enabled } = await loadAllPluginsCacheOnly()
  const allPluginHooks: Record<HookEvent, PluginHookMatcher[]> = {
    PreToolUse: [],
    PostToolUse: [],
    PostToolUseFailure: [],
    PermissionDenied: [],
    Notification: [],
    UserPromptSubmit: [],
    SessionStart: [],
    SessionEnd: [],
    Stop: [],
    StopFailure: [],
    SubagentStart: [],
    SubagentStop: [],
    PreCompact: [],
    PostCompact: [],
    PermissionRequest: [],
    Setup: [],
    TeammateIdle: [],
    TaskCreated: [],
    TaskCompleted: [],
    Elicitation: [],
    ElicitationResult: [],
    ConfigChange: [],
    WorktreeCreate: [],
    WorktreeRemove: [],
    InstructionsLoaded: [],
    CwdChanged: [],
    FileChanged: [],
  }

  // 处理每个已启用插件
  for (const plugin of enabled) {
    if (!plugin.hooksConfig) {
      continue
    }

    logForDebugging(`Loading hooks from plugin: ${plugin.name}`)
    const pluginMatchers = convertPluginHooksToMatchers(plugin)

    // 将插件 hooks 合并到主集合中
    for (const event of Object.keys(pluginMatchers) as HookEvent[]) {
      allPluginHooks[event].push(...pluginMatchers[event])
    }
  }

  // 以原子对形式执行清除-注册。以前清除操作在 clearPluginHookCache() 中，
  // 这意味着任何 clearAllCaches() 调用（来自 /plugins UI、pluginInstallationHelpers、
  // thinkback 等）都会从 STATE.registeredHooks 中清除插件 hooks，
  // 直到某人恰好再次调用 loadPluginHooks() 才会恢复。SessionStart 在触发前
  // 显式 await loadPluginHooks()，所以总会重新注册；Stop 没有这样的保障，
  // 因此在任何插件管理操作后，插件的 Stop hooks 都静默地不再触发（gh-29767）。
  // 在此处清除使交换成为原子操作 —— 旧 hooks 在此时刻之前保持有效，新 hooks 接管。
  clearRegisteredPluginHooks()
  registerHookCallbacks(allPluginHooks)

  const totalHooks = Object.values(allPluginHooks).reduce(
    (sum, matchers) => sum + matchers.reduce((s, m) => s + m.hooks.length, 0),
    0,
  )
  logForDebugging(
    `Registered ${totalHooks} hooks from ${enabled.length} plugins`,
  )
})

export function clearPluginHookCache(): void {
  // 仅使记忆化失效 —— 不在此处清除 STATE.registeredHooks。
  // 在此处清除会导致插件 hooks 在 clearAllCaches() 和下次
  // loadPluginHooks() 调用之间失效，而对于 Stop hooks 这种情况可能永远不会发生
  // （gh-29767）。清除操作现在位于 loadPluginHooks() 内部，作为原子的
  // 清除-注册对，旧 hooks 在新一轮加载替换它们之前保持有效。
  loadPluginHooks.cache?.clear?.()
}

/**
 * 从不再属于已启用集合的插件中移除 hooks，但不添加新启用插件的 hooks。
 * 从 clearAllCaches() 调用，使已卸载/禁用的插件立即停止触发 hooks（gh-36995），
 * 而新启用的插件等待 /reload-plugins —— 与命令/代理/MCP 的行为一致。
 *
 * 完整交换（清除 + 全量注册）仍通过 loadPluginHooks() 发生，
 * /reload-plugins 会等待它。
 */
export async function pruneRemovedPluginHooks(): Promise<void> {
  // 无需剪枝时提前返回 —— 避免在 test/preload.ts 的 beforeEach
  // （会清除 registeredHooks）中触发 loadAllPluginsCacheOnly 记忆化。
  if (!getRegisteredHooks()) return
  const { enabled } = await loadAllPluginsCacheOnly()
  const enabledRoots = new Set(enabled.map(p => p.path))

  // await 之后重新读取：并发的 loadPluginHooks()（热重载）可能在等待期间
  // 替换了 STATE.registeredHooks。持有 await 之前的引用会基于过期数据计算存活者。
  const current = getRegisteredHooks()
  if (!current) return

  // 收集 pluginRoot 仍然已启用的插件 hooks，然后通过现有的清除+注册对进行交换
  //（与上面 loadPluginHooks 相同的原子对模式）。回调 hooks 由
  // clearRegisteredPluginHooks 保留；我们只需重新注册存活者。
  const survivors: Partial<Record<HookEvent, PluginHookMatcher[]>> = {}
  for (const [event, matchers] of Object.entries(current)) {
    const kept = (matchers ?? []).filter(
      (m): m is PluginHookMatcher =>
        'pluginRoot' in m && enabledRoots.has(m.pluginRoot),
    )
    if (kept.length > 0) survivors[event as HookEvent] = kept
  }

  clearRegisteredPluginHooks()
  registerHookCallbacks(survivors)
}

/**
 * 重置热重载订阅状态。仅用于测试。
 */
export function resetHotReloadState(): void {
  hotReloadSubscribed = false
  lastPluginSettingsSnapshot = undefined
}

/**
 * 构建输入到 `loadAllPluginsCacheOnly()` 的设置的稳定字符串快照，用于变更检测。
 * 对键排序，使比较结果与插入顺序无关。
 *
 * 哈希四个字段 —— 不只是 enabledPlugins —— 因为记忆化的
 * loadAllPluginsCacheOnly() 还会读取 strictKnownMarketplaces、blockedMarketplaces
 * （pluginLoader.ts:1933 通过 getBlockedMarketplaces）和 extraKnownMarketplaces。
 * 若远程管理设置只设置其中一个（无 enabledPlugins），仅以 enabledPlugins 为键
 * 的快照永远不会产生 diff，监听器会跳过，记忆化结果会保留远程之前的市场允许/阻止列表。
 * 参见 #23085 / #23152 中毒缓存讨论（Slack C09N89L3VNJ）。
 */
// 导出用于测试 —— setupPluginHookHotReload 中的监听器使用此函数进行变更检测；
// 测试验证它在重要字段上产生 diff。
export function getPluginAffectingSettingsSnapshot(): string {
  const merged = getSettings_DEPRECATED()
  const policy = getSettingsForSource('policySettings')
  // 对两个 Record 字段按键排序，使插入顺序不影响哈希值。
  // 数组字段（strictKnownMarketplaces、blockedMarketplaces）具有 schema 稳定的顺序。
  const sortKeys = <T extends Record<string, unknown>>(o: T | undefined) =>
    o ? Object.fromEntries(Object.entries(o).sort()) : {}
  return jsonStringify({
    enabledPlugins: sortKeys(merged.enabledPlugins),
    extraKnownMarketplaces: sortKeys(merged.extraKnownMarketplaces),
    strictKnownMarketplaces: policy?.strictKnownMarketplaces ?? [],
    blockedMarketplaces: policy?.blockedMarketplaces ?? [],
  })
}

/**
 * 当远程设置变更时为插件 hooks 设置热重载。
 * 当 policySettings 变更时（如来自远程管理设置），
 * 比较影响插件的设置快照，仅在实际发生变化时重新加载。
 */
export function setupPluginHookHotReload(): void {
  if (hotReloadSubscribed) {
    return
  }
  hotReloadSubscribed = true

  // 捕获初始快照，以便第一次 policySettings 变更时进行比较
  lastPluginSettingsSnapshot = getPluginAffectingSettingsSnapshot()

  settingsChangeDetector.subscribe(source => {
    if (source === 'policySettings') {
      const newSnapshot = getPluginAffectingSettingsSnapshot()
      if (newSnapshot === lastPluginSettingsSnapshot) {
        logForDebugging(
          'Plugin hooks: skipping reload, plugin-affecting settings unchanged',
        )
        return
      }

      lastPluginSettingsSnapshot = newSnapshot
      logForDebugging(
        'Plugin hooks: reloading due to plugin-affecting settings change',
      )

      // 清除所有插件相关缓存
      clearPluginCache('loadPluginHooks: plugin-affecting settings changed')
      clearPluginHookCache()

      // 重新加载 hooks（即发即忘，不阻塞）
      void loadPluginHooks()
    }
  })
}
