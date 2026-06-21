import type { PermissionRule } from 'src/utils/permissions/PermissionRule.js'
import { getSettingsForSource } from 'src/utils/settings/settings.js'
import type { SettingsJson } from 'src/utils/settings/types.js'
import { BASH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BashTool/toolName.js'
import { SAFE_ENV_VARS } from '../../utils/managedEnvConstants.js'
import { getPermissionRulesForSource } from '../../utils/permissions/permissionsLoader.js'

function hasHooks(settings: SettingsJson | null): boolean {
  if (settings === null || settings.disableAllHooks) {
    return false
  }
  if (settings.statusLine) {
    return true
  }
  if (settings.fileSuggestion) {
    return true
  }
  if (!settings.hooks) {
    return false
  }
  for (const hookConfig of Object.values(settings.hooks)) {
    if (hookConfig.length > 0) {
      return true
    }
  }
  return false
}

export function getHooksSources(): string[] {
  const sources: string[] = []

  const projectSettings = getSettingsForSource('projectSettings')
  if (hasHooks(projectSettings)) {
    sources.push('.claude/settings.json')
  }

  const localSettings = getSettingsForSource('localSettings')
  if (hasHooks(localSettings)) {
    sources.push('.claude/settings.local.json')
  }

  return sources
}

function hasBashPermission(rules: PermissionRule[]): boolean {
  return rules.some(
    rule =>
      rule.ruleBehavior === 'allow' &&
      (rule.ruleValue.toolName === BASH_TOOL_NAME ||
        rule.ruleValue.toolName.startsWith(BASH_TOOL_NAME + '(')),
  )
}

/**
 * 获取哪些设置来源具有 bash 允许规则。
 * 返回一个具有 bash 权限的文件路径数组。
 */
export function getBashPermissionSources(): string[] {
  const sources: string[] = []

  const projectRules = getPermissionRulesForSource('projectSettings')
  if (hasBashPermission(projectRules)) {
    sources.push('.claude/settings.json')
  }

  const localRules = getPermissionRulesForSource('localSettings')
  if (hasBashPermission(localRules)) {
    sources.push('.claude/settings.local.json')
  }

  return sources
}

/**
 * 格式化带有正确 "and" 连接符的项列表。
 * @param items - 要格式化的项数组
 * @param limit - 可选的限制，控制摘要前显示多少项（为 0 时忽略）
 */
export function formatListWithAnd(items: string[], limit?: number): string {
  if (items.length === 0) return ''

  // 当 limit 为 0 时忽略限制
  const effectiveLimit = limit === 0 ? undefined : limit

  // 如果没有限制或项数在限制内，使用正常格式化
  if (!effectiveLimit || items.length <= effectiveLimit) {
    if (items.length === 1) return items[0]!
    if (items.length === 2) return `${items[0]} and ${items[1]}`

    const lastItem = items[items.length - 1]!
    const allButLast = items.slice(0, -1)
    return `${allButLast.join(', ')}, and ${lastItem}`
  }

  // 如果项数超过限制，显示前几项并统计剩余项
  const shown = items.slice(0, effectiveLimit)
  const remaining = items.length - effectiveLimit

  if (shown.length === 1) {
    return `${shown[0]} and ${remaining} more`
  }

  return `${shown.join(', ')}, and ${remaining} more`
}

/**
 * 检查设置是否配置了 otelHeadersHelper
 */
function hasOtelHeadersHelper(settings: SettingsJson | null): boolean {
  return !!settings?.otelHeadersHelper
}

/**
 * 获取哪些设置来源配置了 otelHeadersHelper。
 * 返回具有 otelHeadersHelper 的文件路径数组。
 */
export function getOtelHeadersHelperSources(): string[] {
  const sources: string[] = []

  const projectSettings = getSettingsForSource('projectSettings')
  if (hasOtelHeadersHelper(projectSettings)) {
    sources.push('.claude/settings.json')
  }

  const localSettings = getSettingsForSource('localSettings')
  if (hasOtelHeadersHelper(localSettings)) {
    sources.push('.claude/settings.local.json')
  }

  return sources
}

/**
 * 检查设置是否配置了 apiKeyHelper
 */
function hasApiKeyHelper(settings: SettingsJson | null): boolean {
  return !!settings?.apiKeyHelper
}

/**
 * 获取哪些设置来源配置了 apiKeyHelper。
 * 返回具有 apiKeyHelper 的文件路径数组。
 */
export function getApiKeyHelperSources(): string[] {
  const sources: string[] = []

  const projectSettings = getSettingsForSource('projectSettings')
  if (hasApiKeyHelper(projectSettings)) {
    sources.push('.claude/settings.json')
  }

  const localSettings = getSettingsForSource('localSettings')
  if (hasApiKeyHelper(localSettings)) {
    sources.push('.claude/settings.local.json')
  }

  return sources
}

/**
 * 检查设置是否配置了 AWS 命令
 */
function hasAwsCommands(settings: SettingsJson | null): boolean {
  return !!(settings?.awsAuthRefresh || settings?.awsCredentialExport)
}

/**
 * 获取哪些设置来源配置了 AWS 命令。
 * 返回具有 awsAuthRefresh 或 awsCredentialExport 的文件路径数组。
 */
export function getAwsCommandsSources(): string[] {
  const sources: string[] = []

  const projectSettings = getSettingsForSource('projectSettings')
  if (hasAwsCommands(projectSettings)) {
    sources.push('.claude/settings.json')
  }

  const localSettings = getSettingsForSource('localSettings')
  if (hasAwsCommands(localSettings)) {
    sources.push('.claude/settings.local.json')
  }

  return sources
}

/**
 * 检查设置是否配置了 GCP 命令
 */
function hasGcpCommands(settings: SettingsJson | null): boolean {
  return !!settings?.gcpAuthRefresh
}

/**
 * 获取哪些设置来源配置了 GCP 命令。
 * 返回具有 gcpAuthRefresh 的文件路径数组。
 */
export function getGcpCommandsSources(): string[] {
  const sources: string[] = []

  const projectSettings = getSettingsForSource('projectSettings')
  if (hasGcpCommands(projectSettings)) {
    sources.push('.claude/settings.json')
  }

  const localSettings = getSettingsForSource('localSettings')
  if (hasGcpCommands(localSettings)) {
    sources.push('.claude/settings.local.json')
  }

  return sources
}

/**
 * 检查设置是否配置了危险的环境变量。
 * 任何不在 SAFE_ENV_VARS 中的环境变量都被视为危险。
 */
function hasDangerousEnvVars(settings: SettingsJson | null): boolean {
  if (!settings?.env) {
    return false
  }
  return Object.keys(settings.env).some(
    key => !SAFE_ENV_VARS.has(key.toUpperCase()),
  )
}

/**
 * 获取哪些设置来源配置了危险的环境变量。
 * 返回具有不在 SAFE_ENV_VARS 中的环境变量的文件路径数组。
 */
export function getDangerousEnvVarsSources(): string[] {
  const sources: string[] = []

  const projectSettings = getSettingsForSource('projectSettings')
  if (hasDangerousEnvVars(projectSettings)) {
    sources.push('.claude/settings.json')
  }

  const localSettings = getSettingsForSource('localSettings')
  if (hasDangerousEnvVars(localSettings)) {
    sources.push('.claude/settings.local.json')
  }

  return sources
}
