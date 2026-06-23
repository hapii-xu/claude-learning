import { readFileSync } from '../fileRead.js'
import { getFsImplementation, safeResolvePath } from '../fsOperations.js'
import { safeParseJSON } from '../json.js'
import { logError } from '../log.js'
import {
  type EditableSettingSource,
  getEnabledSettingSources,
  type SettingSource,
} from '../settings/constants.js'
import {
  getSettingsFilePathForSource,
  getSettingsForSource,
  updateSettingsForSource,
} from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
} from './PermissionRule.js'
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from './permissionRuleParser.js'

/**
 * 如果在托管设置（policySettings）中启用了 allowManagedPermissionRulesOnly，则返回 true。
 * 启用后，仅尊重来自托管设置的权限规则。
 */
export function shouldAllowManagedPermissionRulesOnly(): boolean {
  return (
    getSettingsForSource('policySettings')?.allowManagedPermissionRulesOnly ===
    true
  )
}

/**
 * 如果应在权限提示中显示"始终允许"选项，则返回 true。
 * 当启用 allowManagedPermissionRulesOnly 时，这些选项会被隐藏。
 */
export function shouldShowAlwaysAllowOptions(): boolean {
  return !shouldAllowManagedPermissionRulesOnly()
}

const SUPPORTED_RULE_BEHAVIORS = [
  'allow',
  'deny',
  'ask',
] as const satisfies PermissionBehavior[]

/**
 * getSettingsForSource 的宽松版本，不会因任何验证错误而失败。
 * 仅解析 JSON 并按原样返回，不进行 schema 验证。
 *
 * 用于加载设置以追加新规则时使用（避免因 hooks 等不相关字段的
 * 验证失败而丢失已有规则）。
 *
 * 仅供编辑使用 - 不要用于读取执行时的设置。
 */
function getSettingsForSourceLenient_FOR_EDITING_ONLY_NOT_FOR_READING(
  source: SettingSource,
): SettingsJson | null {
  const filePath = getSettingsFilePathForSource(source)
  if (!filePath) {
    return null
  }

  try {
    const { resolvedPath } = safeResolvePath(getFsImplementation(), filePath)
    const content = readFileSync(resolvedPath)
    if (content.trim() === '') {
      return {}
    }

    const data = safeParseJSON(content, false)
    // 返回未经验证的原始解析 JSON 以保留所有现有设置
    // 这是安全的，因为我们仅将其用于读取/追加，而非执行
    return data && typeof data === 'object' ? (data as SettingsJson) : null
  } catch {
    return null
  }
}

/**
 * 将权限 JSON 转换为 PermissionRule 对象数组
 * @param data 已解析的权限数据
 * @param source 这些规则的来源
 * @returns PermissionRule 对象数组
 */
function settingsJsonToRules(
  data: SettingsJson | null,
  source: PermissionRuleSource,
): PermissionRule[] {
  if (!data || !data.permissions) {
    return []
  }

  const { permissions } = data
  const rules: PermissionRule[] = []
  for (const behavior of SUPPORTED_RULE_BEHAVIORS) {
    const behaviorArray = permissions[behavior]
    if (behaviorArray) {
      for (const ruleString of behaviorArray) {
        rules.push({
          source,
          ruleBehavior: behavior,
          ruleValue: permissionRuleValueFromString(ruleString),
        })
      }
    }
  }
  return rules
}

/**
 * 从所有相关来源（托管设置和项目设置）加载所有权限规则
 * @returns 所有权限规则数组
 */
export function loadAllPermissionRulesFromDisk(): PermissionRule[] {
  // 如果设置了 allowManagedPermissionRulesOnly，仅使用托管权限规则
  if (shouldAllowManagedPermissionRulesOnly()) {
    return getPermissionRulesForSource('policySettings')
  }

  // 否则，从所有启用的来源加载（向后兼容）
  const rules: PermissionRule[] = []

  for (const source of getEnabledSettingSources()) {
    rules.push(...getPermissionRulesForSource(source))
  }
  return rules
}

/**
 * 从指定来源加载权限规则
 * @param source 要加载的来源
 * @returns 该来源的权限规则数组
 */
export function getPermissionRulesForSource(
  source: SettingSource,
): PermissionRule[] {
  const settingsData = getSettingsForSource(source)
  return settingsJsonToRules(settingsData, source)
}

export type PermissionRuleFromEditableSettings = PermissionRule & {
  source: EditableSettingSource
}

// 可修改的来源（不包括 policySettings 和 flagSettings）
const EDITABLE_SOURCES: EditableSettingSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
]

/**
 * 从项目权限文件中删除一条规则
 * @param rule 要删除的规则
 * @returns 解析为布尔值的 Promise，表示是否成功
 */
export function deletePermissionRuleFromSettings(
  rule: PermissionRuleFromEditableSettings,
): boolean {
  // 运行时检查以确保来源确实是可编辑的
  if (!EDITABLE_SOURCES.includes(rule.source as EditableSettingSource)) {
    return false
  }

  const ruleString = permissionRuleValueToString(rule.ruleValue)
  const settingsData = getSettingsForSource(rule.source)

  // 如果没有设置数据或权限配置，则无需操作
  if (!settingsData || !settingsData.permissions) {
    return false
  }

  const behaviorArray = settingsData.permissions[rule.ruleBehavior]
  if (!behaviorArray) {
    return false
  }

  // 通过往返 parse→serialize 规范化原始设置条目，使旧版名称
  //（如 "KillShell"）与其规范形式（"TaskStop"）匹配。
  const normalizeEntry = (raw: string): string =>
    permissionRuleValueToString(permissionRuleValueFromString(raw))

  if (!behaviorArray.some(raw => normalizeEntry(raw) === ruleString)) {
    return false
  }

  try {
    // 保留原始权限数据的副本以保留未识别的键
    const updatedSettingsData = {
      ...settingsData,
      permissions: {
        ...settingsData.permissions,
        [rule.ruleBehavior]: behaviorArray.filter(
          raw => normalizeEntry(raw) !== ruleString,
        ),
      },
    }

    const { error } = updateSettingsForSource(rule.source, updatedSettingsData)
    if (error) {
      // 错误已在 updateSettingsForSource 内部记录
      return false
    }

    return true
  } catch (error) {
    logError(error)
    return false
  }
}

function getEmptyPermissionSettingsJson(): SettingsJson {
  return {
    permissions: {},
  }
}

/**
 * 向项目权限文件添加规则
 * @param ruleValues 要添加的规则值
 * @returns 解析为布尔值的 Promise，表示是否成功
 */
export function addPermissionRulesToSettings(
  {
    ruleValues,
    ruleBehavior,
  }: {
    ruleValues: PermissionRuleValue[]
    ruleBehavior: PermissionBehavior
  },
  source: EditableSettingSource,
): boolean {
  // 当启用 allowManagedPermissionRulesOnly 时，不持久化新的权限规则
  if (shouldAllowManagedPermissionRulesOnly()) {
    return false
  }

  if (ruleValues.length < 1) {
    // 没有要添加的规则
    return true
  }

  const ruleStrings = ruleValues.map(permissionRuleValueToString)
  // 首先尝试正常的设置加载器（会验证 schema）
  // 如果验证失败，回退到宽松加载以保留现有规则
  // 即使某些字段（如 hooks）存在验证错误
  const settingsData =
    getSettingsForSource(source) ||
    getSettingsForSourceLenient_FOR_EDITING_ONLY_NOT_FOR_READING(source) ||
    getEmptyPermissionSettingsJson()

  try {
    // 确保 permissions 对象存在
    const existingPermissions = settingsData.permissions || {}
    const existingRules = existingPermissions[ruleBehavior] || []

    // 过滤重复项 - 通过往返 parse→serialize 规范化已有条目
    // 使旧版名称与其规范形式匹配。
    const existingRulesSet = new Set(
      existingRules.map(raw =>
        permissionRuleValueToString(permissionRuleValueFromString(raw)),
      ),
    )
    const newRules = ruleStrings.filter(rule => !existingRulesSet.has(rule))

    // 如果没有新规则要添加，返回成功
    if (newRules.length === 0) {
      return true
    }

    // 保留原始设置数据的副本以保留未识别的键
    const updatedSettingsData = {
      ...settingsData,
      permissions: {
        ...existingPermissions,
        [ruleBehavior]: [...existingRules, ...newRules],
      },
    }
    const result = updateSettingsForSource(source, updatedSettingsData)

    if (result.error) {
      throw result.error
    }

    return true
  } catch (error) {
    logError(error)
    return false
  }
}
