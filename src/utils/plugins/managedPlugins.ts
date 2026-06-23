import { getSettingsForSource } from '../settings/settings.js'

/**
 * 被组织策略锁定的插件名称（policySettings.enabledPlugins）。
 *
 * 当管理设置未声明任何插件条目时返回 null（常见情况 —— 无策略生效）。
 */
export function getManagedPluginNames(): Set<string> | null {
  const enabledPlugins = getSettingsForSource('policySettings')?.enabledPlugins
  if (!enabledPlugins) {
    return null
  }
  const names = new Set<string>()
  for (const [pluginId, value] of Object.entries(enabledPlugins)) {
    // 只有 plugin@marketplace 布尔条目（true 或 false）受保护。
    // 旧版 owner/repo 数组形式不受保护。
    if (typeof value !== 'boolean' || !pluginId.includes('@')) {
      continue
    }
    const name = pluginId.split('@')[0]
    if (name) {
      names.add(name)
    }
  }
  return names.size > 0 ? names : null
}
