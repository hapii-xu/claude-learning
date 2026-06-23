/**
 * 由托管设置（policySettings）支持的插件策略检查。
 *
 * 作为叶子模块保留（仅导入设置），以避免循环依赖
 * ——marketplaceHelpers.ts 导入 marketplaceManager.ts，
 * 后者会传递触达插件子系统的大部分内容。
 */

import { getSettingsForSource } from '../settings/settings.js'

/**
 * 检查插件是否被组织策略（managed-settings.json）强制禁用。
 * 被策略屏蔽的插件在任何作用域下均不能被用户安装或启用。
 * 作为策略屏蔽的唯一数据来源，贯穿安装检查点、启用操作和 UI 过滤器。
 */
export function isPluginBlockedByPolicy(pluginId: string): boolean {
  const policyEnabled = getSettingsForSource('policySettings')?.enabledPlugins
  return policyEnabled?.[pluginId] === false
}
