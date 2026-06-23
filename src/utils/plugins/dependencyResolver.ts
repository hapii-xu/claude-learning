/**
 * 插件依赖解析 —— 纯函数，无 I/O。
 *
 * 语义为 `apt` 风格：依赖是*存在保证*，而非模块图。
 * 插件 A 依赖插件 B 意味着"B 的命名空间组件（MCP 服务器、命令、代理）
 * 在 A 运行时必须可用。"
 *
 * 两个入口点：
 *  - `resolveDependencyClosure` —— 安装时的深度优先遍历，带环检测
 *  - `verifyAndDemote` —— 加载时的不动点检查，降级依赖未满足的插件
 *    （会话本地，不写入设置）
 */

import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import type { EditableSettingSource } from '../settings/constants.js'
import { getSettingsForSource } from '../settings/settings.js'
import { parsePluginIdentifier } from './pluginIdentifier.js'
import type { PluginId } from './schemas.js'

/**
 * `--plugin-dir` 插件的合成市场哨兵（pluginLoader.ts 设置 `source = "{name}@inline"`）。
 * 不是真实市场 —— 这些插件的裸依赖无法有意义地继承它。
 */
const INLINE_MARKETPLACE = 'inline'

/**
 * 将依赖引用规范化为完全限定的 "name@marketplace" 形式。
 * 裸名称（无 @）继承声明该依赖的插件所属的市场 ——
 * 跨市场依赖本来就被阻止，所以 @ 后缀在常见情况下是样板代码。
 *
 * 例外：如果声明插件是 @inline（通过 --plugin-dir 加载），
 * 裸依赖原样返回。`inline` 是合成哨兵，不是真实市场 ——
 * 伪造 "dep@inline" 永远不会匹配到任何东西。
 * verifyAndDemote 通过仅名称匹配来处理裸依赖。
 */
export function qualifyDependency(
  dep: string,
  declaringPluginId: string,
): string {
  if (parsePluginIdentifier(dep).marketplace) return dep
  const mkt = parsePluginIdentifier(declaringPluginId).marketplace
  if (!mkt || mkt === INLINE_MARKETPLACE) return dep
  return `${dep}@${mkt}`
}

/**
 * 解析器从市场查找中所需的最小结构。保持最小化意味着解析器
 * 无需构造完整的 PluginMarketplaceEntry 对象即可测试。
 */
export type DependencyLookupResult = {
  // 条目可能是裸名称；qualifyDependency 会将其规范化。
  dependencies?: string[]
}

export type ResolutionResult =
  | { ok: true; closure: PluginId[] }
  | { ok: false; reason: 'cycle'; chain: PluginId[] }
  | { ok: false; reason: 'not-found'; missing: PluginId; requiredBy: PluginId }
  | {
      ok: false
      reason: 'cross-marketplace'
      dependency: PluginId
      requiredBy: PluginId
    }

/**
 * 通过深度优先遍历 `rootId` 的传递依赖闭包。
 *
 * 返回的 `closure` 始终包含 `rootId`，以及所有不在 `alreadyEnabled` 中的传递依赖。
 * 已启用的依赖被跳过（不递归进入）—— 避免在依赖已安装于不同作用域时意外写入设置。
 * 根节点永不跳过，即使已启用，因此重新安装插件总会重新缓存它。
 *
 * 跨市场依赖默认被阻止：市场 A 中的插件不能自动安装市场 B 中的插件。
 * 这是安全边界 —— 从可信市场安装不应静默拉取不可信市场的内容。
 * 两种绕过方式：(1) 先自行安装跨市场依赖（已启用的依赖被跳过，闭包不会碰它），
 * 或 (2) 根市场的 `allowCrossMarketplaceDependenciesOn` 白名单 ——
 * 仅根市场的列表对整个遍历有效（无传递信任：若 A 允许 B，B 的插件依赖 C
 * 仍被阻止，除非 A 也允许 C）。
 *
 * @param rootId 解析起点插件（格式："name@marketplace"）
 * @param lookup 返回 `{dependencies}` 或 `null`（未找到时）的异步查找函数
 * @param alreadyEnabled 要跳过的插件 ID（仅跳过依赖，根节点永不跳过）
 * @param allowedCrossMarketplaces 根市场信任的可自动安装的市场名称
 *   （来自根市场的清单）
 * @returns 要安装的闭包，或环/未找到/跨市场错误
 */
export async function resolveDependencyClosure(
  rootId: PluginId,
  lookup: (id: PluginId) => Promise<DependencyLookupResult | null>,
  alreadyEnabled: ReadonlySet<PluginId>,
  allowedCrossMarketplaces: ReadonlySet<string> = new Set(),
): Promise<ResolutionResult> {
  const rootMarketplace = parsePluginIdentifier(rootId).marketplace
  const closure: PluginId[] = []
  const visited = new Set<PluginId>()
  const stack: PluginId[] = []

  async function walk(
    id: PluginId,
    requiredBy: PluginId,
  ): Promise<ResolutionResult | null> {
    // 跳过已启用的依赖（避免意外写入设置），
    // 但绝不跳过根节点：安装已启用的插件仍需缓存/注册它。
    // 没有此保护，重新安装已在设置中但磁盘上缺失的插件
    // （如缓存被清除、installed_plugins.json 过期）将返回空闭包，
    // `cacheAndRegisterPlugin` 永远不会触发 —— 用户看到
    // "✔ Successfully installed" 但实际上什么都没发生。
    if (id !== rootId && alreadyEnabled.has(id)) return null
    // 安全性：阻止跨市场边界的自动安装。在 alreadyEnabled 检查之后运行 ——
    // 若用户手动安装了跨市场依赖，它在 alreadyEnabled 中，永远不会到达这里。
    const idMarketplace = parsePluginIdentifier(id).marketplace
    if (
      idMarketplace !== rootMarketplace &&
      !(idMarketplace && allowedCrossMarketplaces.has(idMarketplace))
    ) {
      return {
        ok: false,
        reason: 'cross-marketplace',
        dependency: id,
        requiredBy,
      }
    }
    if (stack.includes(id)) {
      return { ok: false, reason: 'cycle', chain: [...stack, id] }
    }
    if (visited.has(id)) return null
    visited.add(id)

    const entry = await lookup(id)
    if (!entry) {
      return { ok: false, reason: 'not-found', missing: id, requiredBy }
    }

    stack.push(id)
    for (const rawDep of entry.dependencies ?? []) {
      const dep = qualifyDependency(rawDep, id)
      const err = await walk(dep, id)
      if (err) return err
    }
    stack.pop()

    closure.push(id)
    return null
  }

  const err = await walk(rootId, rootId)
  if (err) return err
  return { ok: true, closure }
}

/**
 * 加载时安全网：对每个已启用的插件，验证清单中的所有依赖也在已启用集合中。降级失败的插件。
 *
 * 不动点循环：降级插件 A 可能导致依赖 A 的插件 B 出问题，因此迭代直到无变化为止。
 *
 * `reason` 字段区分：
 *  - `'not-enabled'` —— 依赖存在于已加载集合但被禁用
 *  - `'not-found'` —— 依赖完全不存在（不在任何市场中）
 *
 * 不修改输入。返回要降级的插件 ID（来源）集合。
 *
 * @param plugins 所有已加载的插件（已启用 + 已禁用）
 * @returns 要降级的 pluginId 集合，以及用于 `/doctor` 的错误信息
 */
export function verifyAndDemote(plugins: readonly LoadedPlugin[]): {
  demoted: Set<string>
  errors: PluginError[]
} {
  const known = new Set(plugins.map(p => p.source))
  const enabled = new Set(plugins.filter(p => p.enabled).map(p => p.source))
  // 来自 --plugin-dir（@inline）插件的裸依赖的仅名称索引：
  // 真实市场未知，故将 "B" 与任意已启用的 "B@*" 匹配。
  // enabledByName 是多重集：若 B@epic 和 B@other 都已启用，
  // 降级其中一个不能让 "B" 从索引中消失。
  const knownByName = new Set(
    plugins.map(p => parsePluginIdentifier(p.source).name),
  )
  const enabledByName = new Map<string, number>()
  for (const id of enabled) {
    const n = parsePluginIdentifier(id).name
    enabledByName.set(n, (enabledByName.get(n) ?? 0) + 1)
  }
  const errors: PluginError[] = []

  let changed = true
  while (changed) {
    changed = false
    for (const p of plugins) {
      if (!enabled.has(p.source)) continue
      for (const rawDep of p.manifest.dependencies ?? []) {
        const dep = qualifyDependency(rawDep, p.source)
        // 裸依赖 ← @inline 插件：仅按名称匹配（参见 enabledByName）
        const isBare = !parsePluginIdentifier(dep).marketplace
        const satisfied = isBare
          ? (enabledByName.get(dep) ?? 0) > 0
          : enabled.has(dep)
        if (!satisfied) {
          enabled.delete(p.source)
          const count = enabledByName.get(p.name) ?? 0
          if (count <= 1) enabledByName.delete(p.name)
          else enabledByName.set(p.name, count - 1)
          errors.push({
            type: 'dependency-unsatisfied',
            source: p.source,
            plugin: p.name,
            dependency: dep,
            reason: (isBare ? knownByName.has(dep) : known.has(dep))
              ? 'not-enabled'
              : 'not-found',
          })
          changed = true
          break
        }
      }
    }
  }

  const demoted = new Set(
    plugins.filter(p => p.enabled && !enabled.has(p.source)).map(p => p.source),
  )
  return { demoted, errors }
}

/**
 * 查找所有将 `pluginId` 声明为依赖的已启用插件。
 * 用于卸载/禁用时发出警告（"被以下插件依赖：X, Y"）。
 *
 * @param pluginId 被移除/禁用的插件
 * @param plugins 所有已加载的插件（仅检查已启用的）
 * @returns 若 `pluginId` 消失会出问题的插件名称列表
 */
export function findReverseDependents(
  pluginId: PluginId,
  plugins: readonly LoadedPlugin[],
): string[] {
  const { name: targetName } = parsePluginIdentifier(pluginId)
  return plugins
    .filter(
      p =>
        p.enabled &&
        p.source !== pluginId &&
        (p.manifest.dependencies ?? []).some(d => {
          const qualified = qualifyDependency(d, p.source)
          // 裸依赖（来自 @inline 插件）：仅按名称匹配
          return parsePluginIdentifier(qualified).marketplace
            ? qualified === pluginId
            : qualified === targetName
        }),
    )
    .map(p => p.name)
}

/**
 * 构建当前在给定设置作用域中已启用的插件 ID 集合。
 * 供安装时解析使用，以跳过已启用的依赖并避免意外写入设置。
 *
 * 匹配 `true`（普通启用）以及数组值（版本约束，参见 settings/types.ts:455-463 ——
 * `"foo@bar": ["^1.0.0"]` 形式的插件是已启用的）。
 * 没有数组检查，版本固定的依赖会被重新加入闭包，设置写入会将约束覆盖为 `true`。
 */
export function getEnabledPluginIdsForScope(
  settingSource: EditableSettingSource,
): Set<PluginId> {
  return new Set(
    Object.entries(getSettingsForSource(settingSource)?.enabledPlugins ?? {})
      .filter(([, v]) => v === true || Array.isArray(v))
      .map(([k]) => k),
  )
}

/**
 * 格式化安装成功消息的"（+ N 个依赖）"后缀。
 * `installedDeps` 为空时返回空字符串。
 */
export function formatDependencyCountSuffix(installedDeps: string[]): string {
  if (installedDeps.length === 0) return ''
  const n = installedDeps.length
  return ` (+ ${n} ${n === 1 ? 'dependency' : 'dependencies'})`
}

/**
 * 格式化卸载/禁用结果的"警告：被 X, Y 依赖"后缀。
 * CLI 结果消息使用破折号风格（不是通知 UI 使用的中点风格）。
 * 无反向依赖时返回空字符串。
 */
export function formatReverseDependentsSuffix(
  rdeps: string[] | undefined,
): string {
  if (!rdeps || rdeps.length === 0) return ''
  return ` — warning: required by ${rdeps.join(', ')}`
}
