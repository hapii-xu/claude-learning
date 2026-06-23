import type {
  EditableSettingSource,
  SettingSource,
} from '../settings/constants.js'
import {
  ALLOWED_OFFICIAL_MARKETPLACE_NAMES,
  type PluginScope,
} from './schemas.js'

/**
 * 扩展的作用域类型，包含用于仅限会话插件的 'flag'。
 * 'flag' 作用域不会持久化到 installed_plugins.json。
 */
export type ExtendedPluginScope = PluginScope | 'flag'

/**
 * 会持久化到 installed_plugins.json 的作用域。
 * 不包括仅限会话的 'flag'。
 */
export type PersistablePluginScope = Exclude<ExtendedPluginScope, 'flag'>

/**
 * SettingSource 到插件作用域的映射。
 * 注意：flagSettings 映射到 'flag'，该值仅限会话且不会持久化。
 */
export const SETTING_SOURCE_TO_SCOPE = {
  policySettings: 'managed',
  userSettings: 'user',
  projectSettings: 'project',
  localSettings: 'local',
  flagSettings: 'flag',
} as const satisfies Record<SettingSource, ExtendedPluginScope>

/**
 * 解析后的插件标识符，包含名称和可选的市场
 */
export type ParsedPluginIdentifier = {
  name: string
  marketplace?: string
}

/**
 * 将插件标识符字符串解析为名称和市场组件
 * @param plugin 插件标识符（name 或 name@marketplace）
 * @returns 解析后的插件名称和可选的市场
 *
 * 注意：仅使用第一个 '@' 作为分隔符。如果输入包含多个 '@' 符号
 * （例如 "plugin@market@place"），第二个 '@' 之后的内容会被忽略。
 * 这是刻意为之，因为市场名称不应包含 '@'。
 */
export function parsePluginIdentifier(plugin: string): ParsedPluginIdentifier {
  if (plugin.includes('@')) {
    const parts = plugin.split('@')
    return { name: parts[0] || '', marketplace: parts[1] }
  }
  return { name: plugin }
}

/**
 * 通过名称和市场构建插件 ID
 * @param name 插件名称
 * @param marketplace 可选的市场名称
 * @returns 格式为 "name" 或 "name@marketplace" 的插件 ID
 */
export function buildPluginId(name: string, marketplace?: string): string {
  return marketplace ? `${name}@${marketplace}` : name
}

/**
 * 检查市场名称是否为官方（Anthropic 管控）市场。
 * 用于遥测数据脱敏——官方插件标识符可安全记录到
 * 通用 additional_metadata；第三方标识符仅写入
 * 标注了 PII 的 _PROTO_* BQ 列。
 */
export function isOfficialMarketplaceName(
  marketplace: string | undefined,
): boolean {
  return (
    marketplace !== undefined &&
    ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(marketplace.toLowerCase())
  )
}

/**
 * 可安装插件作用域到可编辑配置来源的映射。
 * 这是仅针对可编辑作用域的 SETTING_SOURCE_TO_SCOPE 的逆映射。
 * 注意：'managed' 作用域不可安装插件，因此不包含在此处。
 */
const SCOPE_TO_EDITABLE_SOURCE: Record<
  Exclude<PluginScope, 'managed'>,
  EditableSettingSource
> = {
  user: 'userSettings',
  project: 'projectSettings',
  local: 'localSettings',
}

/**
 * 将插件作用域转换为对应的可编辑配置来源
 * @param scope 插件安装作用域
 * @returns 用于读写配置的对应配置来源
 * @throws 如果作用域为 'managed' 则抛出错误（无法向 managed 作用域安装插件）
 */
export function scopeToSettingSource(
  scope: PluginScope,
): EditableSettingSource {
  if (scope === 'managed') {
    throw new Error('Cannot install plugins to managed scope')
  }
  return SCOPE_TO_EDITABLE_SOURCE[scope]
}

/**
 * 将可编辑配置来源转换为对应的插件作用域。
 * 从 SETTING_SOURCE_TO_SCOPE 派生，以保持单一数据来源。
 * @param source 配置来源
 * @returns 对应的插件作用域
 */
export function settingSourceToScope(
  source: EditableSettingSource,
): Exclude<PluginScope, 'managed'> {
  return SETTING_SOURCE_TO_SCOPE[source] as Exclude<PluginScope, 'managed'>
}
