/**
 * 已批准的频道插件允许列表。--channels plugin:name@marketplace
 * 条目只有在 {marketplace, plugin} 在此列表上时才会注册。server:
 * 条目总是失败（模式仅支持插件）。
 * --dangerously-load-development-channels 标志对两种类型都绕过。
 * 放在 GrowthBook 中，以便无需发版即可更新。
 *
 * 插件级粒度：如果一个插件被批准，其所有频道
 * 服务器都被批准。逐服务器门控是过度工程 — 一个长出
 * 恶意第二个服务器的插件已经被入侵了，而逐服务器
 * 条目会在无害的插件重构时被破坏。
 *
 * 允许列表检查是针对用户输入标签的纯 {marketplace, plugin} 比较。
 * 门控的单独 'marketplace' 步骤在此检查运行之前验证
 * 标签与实际安装的内容匹配。
 */

import { z } from 'zod/v4'
import { BUILTIN_MARKETPLACE_NAME } from '../../plugins/builtinPlugins.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { parsePluginIdentifier } from '../../utils/plugins/pluginIdentifier.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'

export type ChannelAllowlistEntry = {
  marketplace: string
  plugin: string
}

const ChannelAllowlistSchema = lazySchema(() =>
  z.array(
    z.object({
      marketplace: z.string(),
      plugin: z.string(),
    }),
  ),
)

export function getChannelAllowlist(): ChannelAllowlistEntry[] {
  const raw = getFeatureValue_CACHED_MAY_BE_STALE<unknown>(
    'tengu_harbor_ledger',
    [],
  )
  const parsed = ChannelAllowlistSchema().safeParse(raw)
  return parsed.success ? parsed.data : []
}

/**
 * 频道总体开关。始终启用 — 绕过 GrowthBook 门控。
 */
export function isChannelsEnabled(): boolean {
  return true
}

/**
 * 基于连接的 pluginSource 的纯允许列表检查 — 用于 UI
 * 预过滤，使 IDE 仅对实际会通过门控的服务器显示"启用频道？"。
 * 这不是安全边界：channel_enable 仍运行完整门控。
 * 匹配 gateChannelServer() 内部的允许列表比较，
 * 但独立运行（无会话/市场耦合 — 当条目从 pluginSource 派生时，
 * 那些都是同义反复）。
 *
 * 对于未定义的 pluginSource（非插件服务器 — 永远无法
 * 匹配以 {marketplace, plugin} 为键的账本）和无 @ 的来源
 * （内置/内联 — 同样原因）返回 false。
 */
export function isChannelAllowlisted(
  pluginSource: string | undefined,
): boolean {
  if (!pluginSource) return false
  const { name, marketplace } = parsePluginIdentifier(pluginSource)
  if (!marketplace) return false
  if (marketplace === BUILTIN_MARKETPLACE_NAME && name === 'weixin') {
    return true
  }
  return getChannelAllowlist().some(
    e => e.plugin === name && e.marketplace === marketplace,
  )
}
