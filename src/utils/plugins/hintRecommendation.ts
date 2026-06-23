/**
 * 插件提示推荐。
 *
 * lspRecommendation.ts 的配套模块：LSP 推荐由文件编辑触发，
 * 插件提示则由 CLI/SDK 向 stderr 输出 `<claude-code-hint />` 标签触发
 * （由 Bash/PowerShell 工具检测）。
 *
 * 状态持久化在 GlobalConfig.claudeCodeHints 中 —— 每个插件的一次性展示记录
 * 以及禁用标志（用户选择了"不再显示"）。官方市场过滤在 v1 中硬编码。
 */

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../../services/analytics/index.js'
import {
  type ClaudeCodeHint,
  hasShownHintThisSession,
  setPendingHint,
} from '../claudeCodeHints.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'
import { isPluginInstalled } from './installedPluginsManager.js'
import { getPluginById } from './marketplaceManager.js'
import {
  isOfficialMarketplaceName,
  parsePluginIdentifier,
} from './pluginIdentifier.js'
import { isPluginBlockedByPolicy } from './pluginPolicy.js'

/**
 * `claudeCodeHints.plugin[]` 的硬性上限 —— 控制配置增长。每个已展示的插件
 * 追加一个 slug；超过此上限后停止提示（也停止追加），避免配置无限增长。
 */
const MAX_SHOWN_PLUGINS = 100

export type PluginHintRecommendation = {
  pluginId: string
  pluginName: string
  marketplaceName: string
  pluginDescription?: string
  sourceCommand: string
}

/**
 * 由 shell 工具在检测到 `type="plugin"` 提示时调用的预存储门控。
 * 以下情况丢弃该提示：
 *
 *  - 本次会话已展示过对话框
 *  - 用户已禁用提示
 *  - 已展示插件列表达到配置增长上限
 *  - 插件 slug 无法解析为 `name@marketplace` 格式
 *  - 市场不是官方市场（v1 硬编码）
 *  - 插件已安装
 *  - 插件在之前的会话中已经展示过
 *
 * 有意设计为同步 —— shell 工具不应为了过滤一行 stderr 就 await 市场查找。
 * 异步的市场缓存检查在后续 resolvePluginHint（hook 侧）中执行。
 */
export function maybeRecordPluginHint(hint: ClaudeCodeHint): void {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_lapis_finch', false)) return
  if (hasShownHintThisSession()) return

  const state = getGlobalConfig().claudeCodeHints
  if (state?.disabled) return

  const shown = state?.plugin ?? []
  if (shown.length >= MAX_SHOWN_PLUGINS) return

  const pluginId = hint.value
  const { name, marketplace } = parsePluginIdentifier(pluginId)
  if (!name || !marketplace) return
  if (!isOfficialMarketplaceName(marketplace)) return
  if (shown.includes(pluginId)) return
  if (isPluginInstalled(pluginId)) return
  if (isPluginBlockedByPolicy(pluginId)) return

  // 限制对同一 slug 的重复查找 —— 每次调用都输出提示的 CLI
  // 不应对同一插件触发 N 次解析循环。
  if (triedThisSession.has(pluginId)) return
  triedThisSession.add(pluginId)

  setPendingHint(hint)
}

const triedThisSession = new Set<string>()

/** 仅用于测试的重置函数。 */
export function _resetHintRecommendationForTesting(): void {
  triedThisSession.clear()
}

/**
 * 将待处理提示解析为可渲染的推荐内容。执行同步预存储门控跳过的异步市场查找。
 * 若插件不在市场缓存中则返回 null —— 提示被丢弃。
 */
export async function resolvePluginHint(
  hint: ClaudeCodeHint,
): Promise<PluginHintRecommendation | null> {
  const pluginId = hint.value
  const { name, marketplace } = parsePluginIdentifier(pluginId)

  const pluginData = await getPluginById(pluginId)

  logEvent('tengu_plugin_hint_detected', {
    _PROTO_plugin_name: (name ??
      '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    _PROTO_marketplace_name: (marketplace ??
      '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    result: (pluginData
      ? 'passed'
      : 'not_in_cache') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  if (!pluginData) {
    logForDebugging(
      `[hintRecommendation] ${pluginId} not found in marketplace cache`,
    )
    return null
  }

  return {
    pluginId,
    pluginName: pluginData.entry.name,
    marketplaceName: marketplace ?? '',
    pluginDescription: pluginData.entry.description,
    sourceCommand: hint.sourceCommand,
  }
}

/**
 * 记录该插件的提示已被展示。无论用户选择是/否都会调用 —— 一次性展示语义。
 */
export function markHintPluginShown(pluginId: string): void {
  saveGlobalConfig(current => {
    const existing = current.claudeCodeHints?.plugin ?? []
    if (existing.includes(pluginId)) return current
    return {
      ...current,
      claudeCodeHints: {
        ...current.claudeCodeHints,
        plugin: [...existing, pluginId],
      },
    }
  })
}

/** 用户选择"不再显示插件安装提示"时调用。 */
export function disableHintRecommendations(): void {
  saveGlobalConfig(current => {
    if (current.claudeCodeHints?.disabled) return current
    return {
      ...current,
      claudeCodeHints: { ...current.claudeCodeHints, disabled: true },
    }
  })
}
