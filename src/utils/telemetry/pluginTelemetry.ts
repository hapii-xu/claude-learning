/**
 * 插件遥测辅助工具 — 插件生命周期事件的共享字段构建器。
 *
 * 实现双列隐私模式：每个用户自定义名称字段同时输出原始值（路由到
 * PII 标记的 _PROTO_* BQ 列）和脱敏 twin 列（当 marketplace 属于
 * 白名单时显示真名，否则显示 'third-party'）。
 *
 * plugin_id_hash 提供一个无隐私依赖的不透明 per-plugin 聚合键 —
 * sha256(name@marketplace + FIXED_SALT) 截断至 16 字符。
 * 这解决了脱敏列无法回答的去重计数和 per-plugin 趋势问题，
 * 同时不会暴露用户自定义名称。
 */

import { createHash } from 'crypto'
import { sep } from 'path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../../services/analytics/index.js'
import type {
  LoadedPlugin,
  PluginError,
  PluginManifest,
} from '../../types/plugin.js'
import {
  isOfficialMarketplaceName,
  parsePluginIdentifier,
} from '../plugins/pluginIdentifier.js'

// builtinPlugins.ts:BUILTIN_MARKETPLACE_NAME — 内联以避免通过 commands.js 的循环依赖
// Marketplace schemas.ts 强制保留 'builtin' 为保留字
const BUILTIN_MARKETPLACE_NAME = 'builtin'

// plugin_id_hash 的固定盐值。所有仓库和发送点使用相同常量。
// 不是 per-org，不轮换 — per-org 盐会破坏跨组织去重计数，
// 轮换会破坏趋势线。客户可以在自己已知的插件名称上计算
// 相同哈希值来反向匹配自己的遥测数据。
const PLUGIN_ID_HASH_SALT = 'claude-plugin-telemetry-v1'

/**
 * 不透明的 per-plugin 聚合键。输入为 name@marketplace 字符串，
 * 与 enabledPlugins 键中出现的一致，marketplace 后缀小写以保证
 * 可复现性。16 字符截断使 BQ GROUP BY 基数可控，
 * 同时在预期的 10k 插件规模下使冲突可忽略不计。
 * 名称大小写在两个分支中均保留（enabledPlugins 键区分大小写）。
 */
export function hashPluginId(name: string, marketplace?: string): string {
  const key = marketplace ? `${name}@${marketplace.toLowerCase()}` : name
  return createHash('sha256')
    .update(key + PLUGIN_ID_HASH_SALT)
    .digest('hex')
    .slice(0, 16)
}

/**
 * 插件来源的 4 值范围枚举。不同于 PluginScope
 * (managed/user/project/local) 的安装目标 — 这里是 marketplace 来源。
 *
 * - official: 来自白名单的 Anthropic marketplace
 * - default-bundle: 随产品发布 (@builtin)，自动启用
 * - org: 企业管理员通过托管设置 (policySettings) 推送
 * - user-local: 用户添加的 marketplace 或本地插件
 */
export type TelemetryPluginScope =
  | 'official'
  | 'org'
  | 'user-local'
  | 'default-bundle'

export function getTelemetryPluginScope(
  name: string,
  marketplace: string | undefined,
  managedNames: Set<string> | null,
): TelemetryPluginScope {
  if (marketplace === BUILTIN_MARKETPLACE_NAME) return 'default-bundle'
  if (isOfficialMarketplaceName(marketplace)) return 'official'
  if (managedNames?.has(name)) return 'org'
  return 'user-local'
}

/**
 * 插件如何进入会话。区分自选择安装与组织推送 —
 * 仅 plugin_scope 无法区分（official 插件可能是用户安装的，
 * 也可能是组织推送的；两者 scope='official'）。
 */
export type EnabledVia =
  | 'user-install'
  | 'org-policy'
  | 'default-enable'
  | 'seed-mount'

/** 技能/命令调用的触发方式。 */
export type InvocationTrigger =
  | 'user-slash'
  | 'claude-proactive'
  | 'nested-skill'

/** 技能调用的执行位置。 */
export type SkillExecutionContext = 'fork' | 'inline' | 'remote'

/** 插件安装如何发起。 */
export type InstallSource =
  | 'cli-explicit'
  | 'ui-discover'
  | 'ui-suggestion'
  | 'deep-link'

export function getEnabledVia(
  plugin: LoadedPlugin,
  managedNames: Set<string> | null,
  seedDirs: string[],
): EnabledVia {
  if (plugin.isBuiltin) return 'default-enable'
  if (managedNames?.has(plugin.name)) return 'org-policy'
  // 尾部 sep：/opt/plugins 不应匹配 /opt/plugins-extra
  if (
    seedDirs.some(dir =>
      plugin.path.startsWith(dir.endsWith(sep) ? dir : dir + sep),
    )
  ) {
    return 'seed-mount'
  }
  return 'user-install'
}

/**
 * 以 name@marketplace 为键的通用插件遥测字段。返回哈希、
 * 范围枚举和脱敏 twin 列。调用方需单独添加原始 _PROTO_* 字段
 * （这些字段需要 PII 标记类型）。
 */
export function buildPluginTelemetryFields(
  name: string,
  marketplace: string | undefined,
  managedNames: Set<string> | null = null,
): {
  plugin_id_hash: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  plugin_scope: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  plugin_name_redacted: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  marketplace_name_redacted: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  is_official_plugin: boolean
} {
  const scope = getTelemetryPluginScope(name, marketplace, managedNames)
  // 官方 marketplace 和内置插件均由 Anthropic 控制 —
  // 可以在脱敏列中安全地暴露真实名称。
  const isAnthropicControlled =
    scope === 'official' || scope === 'default-bundle'
  return {
    plugin_id_hash: hashPluginId(
      name,
      marketplace,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    plugin_scope:
      scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    plugin_name_redacted: (isAnthropicControlled
      ? name
      : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    marketplace_name_redacted: (isAnthropicControlled && marketplace
      ? marketplace
      : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    is_official_plugin: isAnthropicControlled,
  }
}

/**
 * per-invocation 调用方（SkillTool、processSlashCommand）
 * 传入 managedNames=null — 会话级别的 tengu_plugin_enabled_for_session
 * 事件携带权威的 plugin_scope，per-invocation 行可通过
 * plugin_id_hash 连接恢复。这使热路径调用点免于额外读取设置。
 */
export function buildPluginCommandTelemetryFields(
  pluginInfo: { pluginManifest: PluginManifest; repository: string },
  managedNames: Set<string> | null = null,
): ReturnType<typeof buildPluginTelemetryFields> {
  const { marketplace } = parsePluginIdentifier(pluginInfo.repository)
  return buildPluginTelemetryFields(
    pluginInfo.pluginManifest.name,
    marketplace,
    managedNames,
  )
}

/**
 * 在会话启动时为每个已启用插件发送一次 tengu_plugin_enabled_for_session。
 * 补充 tengu_skill_loaded（仍按技能触发）— 用于插件级别聚合，
 * 而不是 DISTINCT-on-prefix 技巧。一个有 5 个技能的插件
 * 会发送 5 行 skill_loaded 但只有 1 行此事件。
 */
export function logPluginsEnabledForSession(
  plugins: LoadedPlugin[],
  managedNames: Set<string> | null,
  seedDirs: string[],
): void {
  for (const plugin of plugins) {
    const { marketplace } = parsePluginIdentifier(plugin.repository)

    logEvent('tengu_plugin_enabled_for_session', {
      _PROTO_plugin_name:
        plugin.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      ...(marketplace && {
        _PROTO_marketplace_name:
          marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      ...buildPluginTelemetryFields(plugin.name, marketplace, managedNames),
      enabled_via: getEnabledVia(
        plugin,
        managedNames,
        seedDirs,
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      skill_path_count:
        (plugin.skillsPath ? 1 : 0) + (plugin.skillsPaths?.length ?? 0),
      command_path_count:
        (plugin.commandsPath ? 1 : 0) + (plugin.commandsPaths?.length ?? 0),
      has_mcp: plugin.manifest.mcpServers !== undefined,
      has_hooks: plugin.hooksConfig !== undefined,
      ...(plugin.manifest.version && {
        version: plugin.manifest
          .version as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    })
  }
}

/**
 * CLI 插件操作失败的有限基数错误桶。
 * 将自由格式错误消息映射到 5 个稳定类别，
 * 使面板 GROUP BY 保持可处理。
 */
export type PluginCommandErrorCategory =
  | 'network'
  | 'not-found'
  | 'permission'
  | 'validation'
  | 'unknown'

export function classifyPluginCommandError(
  error: unknown,
): PluginCommandErrorCategory {
  const msg = String((error as { message?: unknown })?.message ?? error)
  if (
    /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|ECONNRESET|network|Could not resolve|Connection refused|timed out/i.test(
      msg,
    )
  ) {
    return 'network'
  }
  if (/\b404\b|not found|does not exist|no such plugin/i.test(msg)) {
    return 'not-found'
  }
  if (/\b40[13]\b|EACCES|EPERM|permission denied|unauthorized/i.test(msg)) {
    return 'permission'
  }
  if (/invalid|malformed|schema|validation|parse error/i.test(msg)) {
    return 'validation'
  }
  return 'unknown'
}

/**
 * 为会话启动时插件加载出现的每个错误发送一次 tengu_plugin_load_failed。
 * 与 tengu_plugin_enabled_for_session 配对，面板可据此计算加载成功率。
 * PluginError.type 已经是有限枚举 — 直接用作 error_category。
 */
export function logPluginLoadErrors(
  errors: PluginError[],
  managedNames: Set<string> | null,
): void {
  for (const err of errors) {
    const { name, marketplace } = parsePluginIdentifier(err.source)
    // 并非所有 PluginError 变体都携带插件名称（有些有 pluginId，
    // 有些是 marketplace 级别的）。如果存在 'plugin' 属性则使用它，
    // 否则回退到从 err.source 解析的名称。
    const pluginName = 'plugin' in err && err.plugin ? err.plugin : name
    logEvent('tengu_plugin_load_failed', {
      error_category:
        err.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      _PROTO_plugin_name:
        pluginName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      ...(marketplace && {
        _PROTO_marketplace_name:
          marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      ...buildPluginTelemetryFields(pluginName, marketplace, managedNames),
    })
  }
}
