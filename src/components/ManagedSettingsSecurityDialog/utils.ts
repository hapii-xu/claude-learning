import {
  DANGEROUS_SHELL_SETTINGS,
  SAFE_ENV_VARS,
} from '../../utils/managedEnvConstants.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import { jsonStringify } from '../../utils/slowOperations.js'

type DangerousShellSetting = (typeof DANGEROUS_SHELL_SETTINGS)[number]

export type DangerousSettings = {
  shellSettings: Partial<Record<DangerousShellSetting, string>>
  envVars: Record<string, string>
  hasHooks: boolean
  hooks?: unknown
}

/**
 * 从设置对象中提取危险设置。
 *
 * 危险环境变量通过检查 SAFE_ENV_VARS 确定 ——
 * 任何不在 SAFE_ENV_VARS 中的环境变量都被视为危险。
 * 权威列表和威胁类别请参见 managedEnv.ts。
 */
export function extractDangerousSettings(
  settings: SettingsJson | null | undefined,
): DangerousSettings {
  if (!settings) {
    return {
      shellSettings: {},
      envVars: {},
      hasHooks: false,
    }
  }

  // 提取危险的 shell 设置
  const shellSettings: Partial<Record<DangerousShellSetting, string>> = {}
  for (const key of DANGEROUS_SHELL_SETTINGS) {
    const value = settings[key]
    if (typeof value === 'string' && value.length > 0) {
      shellSettings[key] = value
    }
  }

  // 提取危险的环境变量 - 任何不在 SAFE_ENV_VARS 中的变量都是危险的
  const envVars: Record<string, string> = {}
  if (settings.env && typeof settings.env === 'object') {
    for (const [key, value] of Object.entries(settings.env)) {
      if (typeof value === 'string' && value.length > 0) {
        // 检查此环境变量是否不在安全列表中
        if (!SAFE_ENV_VARS.has(key.toUpperCase())) {
          envVars[key] = value
        }
      }
    }
  }

  // 检查是否有 hooks
  const hasHooks =
    settings.hooks !== undefined &&
    settings.hooks !== null &&
    typeof settings.hooks === 'object' &&
    Object.keys(settings.hooks).length > 0

  return {
    shellSettings,
    envVars,
    hasHooks,
    hooks: hasHooks ? settings.hooks : undefined,
  }
}

/**
 * 检查设置是否包含任何危险设置
 */
export function hasDangerousSettings(dangerous: DangerousSettings): boolean {
  return (
    Object.keys(dangerous.shellSettings).length > 0 ||
    Object.keys(dangerous.envVars).length > 0 ||
    dangerous.hasHooks
  )
}

/**
 * 比较两组危险设置，查看新设置相比旧设置是否有变化或新增危险设置
 */
export function hasDangerousSettingsChanged(
  oldSettings: SettingsJson | null | undefined,
  newSettings: SettingsJson | null | undefined,
): boolean {
  const oldDangerous = extractDangerousSettings(oldSettings)
  const newDangerous = extractDangerousSettings(newSettings)

  // 如果新设置没有危险设置，则无需提示
  if (!hasDangerousSettings(newDangerous)) {
    return false
  }

  // 如果旧设置没有危险设置但新设置有，则需要提示
  if (!hasDangerousSettings(oldDangerous)) {
    return true
  }

  // 比较危险设置 - 任何变化都触发提示
  const oldJson = jsonStringify({
    shellSettings: oldDangerous.shellSettings,
    envVars: oldDangerous.envVars,
    hooks: oldDangerous.hooks,
  })
  const newJson = jsonStringify({
    shellSettings: newDangerous.shellSettings,
    envVars: newDangerous.envVars,
    hooks: newDangerous.hooks,
  })

  return oldJson !== newJson
}

/**
 * 将危险设置格式化为 UI 可读的列表
 * 仅返回设置名，不返回值
 */
export function formatDangerousSettingsList(
  dangerous: DangerousSettings,
): string[] {
  const items: string[] = []

  // Shell 设置（仅名称）
  for (const key of Object.keys(dangerous.shellSettings)) {
    items.push(key)
  }

  // 环境变量（仅名称）
  for (const key of Object.keys(dangerous.envVars)) {
    items.push(key)
  }

  // Hooks
  if (dangerous.hasHooks) {
    items.push('hooks')
  }

  return items
}
