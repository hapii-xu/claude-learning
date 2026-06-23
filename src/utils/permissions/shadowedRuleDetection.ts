import type { ToolPermissionContext } from '../../Tool.js'
import { BASH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BashTool/toolName.js'
import type { PermissionRule, PermissionRuleSource } from './PermissionRule.js'
import {
  getAllowRules,
  getAskRules,
  getDenyRules,
  permissionRuleSourceDisplayString,
} from './permissions.js'

/**
 * 使规则不可达的遮蔽类型
 */
export type ShadowType = 'ask' | 'deny'

/**
 * 表示不可达的权限规则及说明
 */
export type UnreachableRule = {
  rule: PermissionRule
  reason: string
  shadowedBy: PermissionRule
  shadowType: ShadowType
  fix: string
}

/**
 * 检测不可达规则的选项
 */
export type DetectUnreachableRulesOptions = {
  /**
   * 是否为 Bash 命令启用了沙箱自动允许。
   * 为 true 时，来自个人设置的工具级 Bash ask 规则不会阻止
   * 特定的 Bash allow 规则，因为沙箱命令会被自动允许。
   */
  sandboxAutoAllowEnabled: boolean
}

/**
 * 检查规则是否被遮蔽的结果。
 * 使用可辨识联合类型以确保类型安全。
 */
type ShadowResult =
  | { shadowed: false }
  | { shadowed: true; shadowedBy: PermissionRule; shadowType: ShadowType }

/**
 * 判断权限规则来源是否为共享的（对其他用户可见）。
 * 共享设置包括：
 * - projectSettings：提交到 git，与团队共享
 * - policySettings：企业管理，推送给所有用户
 * - command：来自斜杠命令的 frontmatter，可能被共享
 *
 * 个人设置包括：
 * - userSettings：用户的全局 ~/.claude 设置
 * - localSettings：被 gitignore 的项目级设置
 * - cliArg：运行时 CLI 参数
 * - session：内存中的会话级规则
 * - flagSettings：来自 --settings 标志（运行时）
 */
export function isSharedSettingSource(source: PermissionRuleSource): boolean {
  return (
    source === 'projectSettings' ||
    source === 'policySettings' ||
    source === 'command'
  )
}

/**
 * 格式化规则来源以在警告消息中显示。
 */
function formatSource(source: PermissionRuleSource): string {
  return permissionRuleSourceDisplayString(source)
}

/**
 * 根据遮蔽类型生成修复建议。
 */
function generateFixSuggestion(
  shadowType: ShadowType,
  shadowingRule: PermissionRule,
  shadowedRule: PermissionRule,
): string {
  const shadowingSource = formatSource(shadowingRule.source)
  const shadowedSource = formatSource(shadowedRule.source)
  const toolName = shadowingRule.ruleValue.toolName

  if (shadowType === 'deny') {
    return `Remove the "${toolName}" deny rule from ${shadowingSource}, or remove the specific allow rule from ${shadowedSource}`
  }
  return `Remove the "${toolName}" ask rule from ${shadowingSource}, or remove the specific allow rule from ${shadowedSource}`
}

/**
 * 检查特定的 allow 规则是否被 ask 规则遮蔽（不可达）。
 *
 * allow 规则不可达的条件：
 * 1. 存在工具级的 ask 规则（例如 ask 列表中的 "Bash"）
 * 2. 以及特定的 allow 规则（例如 allow 列表中的 "Bash(ls:*)"）
 *
 * ask 规则优先级更高，使特定的 allow 规则不可达，
 * 因为用户总是会被首先提示。
 *
 * 例外情况：对于启用了沙箱自动允许的 Bash，来自个人设置的
 * 工具级 ask 规则不会遮蔽特定的 allow 规则，因为：
 * - 沙箱命令无论如何都会被自动允许
 * - 这仅适用于个人设置（userSettings、localSettings 等）
 * - 共享设置（projectSettings、policySettings）始终会警告，因为
 *   其他团队成员可能未启用沙箱
 */
function isAllowRuleShadowedByAskRule(
  allowRule: PermissionRule,
  askRules: PermissionRule[],
  options: DetectUnreachableRulesOptions,
): ShadowResult {
  const { toolName, ruleContent } = allowRule.ruleValue

  // 仅检查具有特定内容的 allow 规则（例如 "Bash(ls:*)"）
  // 工具级的 allow 规则不会被 ask 规则遮蔽
  if (ruleContent === undefined) {
    return { shadowed: false }
  }

  // 查找同一工具的工具级 ask 规则
  const shadowingAskRule = askRules.find(
    askRule =>
      askRule.ruleValue.toolName === toolName &&
      askRule.ruleValue.ruleContent === undefined,
  )

  if (!shadowingAskRule) {
    return { shadowed: false }
  }

  // 特殊情况：来自个人设置的 Bash 沙箱自动允许
  // 沙箱例外基于 ASK 规则的来源，而非 allow 规则的来源。
  // 如果 ask 规则来自个人设置，用户自己的沙箱会自动允许。
  // 如果 ask 规则来自共享设置，其他团队成员可能未启用沙箱。
  if (toolName === BASH_TOOL_NAME && options.sandboxAutoAllowEnabled) {
    if (!isSharedSettingSource(shadowingAskRule.source)) {
      return { shadowed: false }
    }
    // 继续向下标记为被遮蔽 - 共享设置应始终警告
  }

  return { shadowed: true, shadowedBy: shadowingAskRule, shadowType: 'ask' }
}

/**
 * 检查 allow 规则是否被 deny 规则遮蔽（完全阻止）。
 *
 * allow 规则不可达的条件：
 * 1. 存在工具级的 deny 规则（例如 deny 列表中的 "Bash"）
 * 2. 以及特定的 allow 规则（例如 allow 列表中的 "Bash(ls:*)"）
 *
 * 在权限评估顺序中 deny 规则首先被检查，
 * 因此 allow 规则永远不会被触发 - 工具总是被拒绝。
 * 这比 ask 遮蔽更严重，因为规则确实被完全阻止了。
 */
function isAllowRuleShadowedByDenyRule(
  allowRule: PermissionRule,
  denyRules: PermissionRule[],
): ShadowResult {
  const { toolName, ruleContent } = allowRule.ruleValue

  // 仅检查具有特定内容的 allow 规则（例如 "Bash(ls:*)"）
  // 工具级的 allow 规则与工具级的 deny 规则冲突但不算"被遮蔽"
  if (ruleContent === undefined) {
    return { shadowed: false }
  }

  // 查找同一工具的工具级 deny 规则
  const shadowingDenyRule = denyRules.find(
    denyRule =>
      denyRule.ruleValue.toolName === toolName &&
      denyRule.ruleValue.ruleContent === undefined,
  )

  if (!shadowingDenyRule) {
    return { shadowed: false }
  }

  return { shadowed: true, shadowedBy: shadowingDenyRule, shadowType: 'deny' }
}

/**
 * 检测给定上下文中所有不可达的权限规则。
 *
 * 当前检测：
 * - 被工具级 deny 规则遮蔽的 allow 规则（更严重 - 完全阻止）
 * - 被工具级 ask 规则遮蔽的 allow 规则（总是提示）
 */
export function detectUnreachableRules(
  context: ToolPermissionContext,
  options: DetectUnreachableRulesOptions,
): UnreachableRule[] {
  const unreachable: UnreachableRule[] = []

  const allowRules = getAllowRules(context)
  const askRules = getAskRules(context)
  const denyRules = getDenyRules(context)

  // 检查每个 allow 规则是否被遮蔽
  for (const allowRule of allowRules) {
    // 优先检查 deny 遮蔽（更严重）
    const denyResult = isAllowRuleShadowedByDenyRule(allowRule, denyRules)
    if (denyResult.shadowed) {
      const shadowSource = formatSource(denyResult.shadowedBy.source)
      unreachable.push({
        rule: allowRule,
        reason: `Blocked by "${denyResult.shadowedBy.ruleValue.toolName}" deny rule (from ${shadowSource})`,
        shadowedBy: denyResult.shadowedBy,
        shadowType: 'deny',
        fix: generateFixSuggestion('deny', denyResult.shadowedBy, allowRule),
      })
      continue // 如果已被 deny 遮蔽，不再报告 ask 遮蔽
    }

    // 检查 ask 遮蔽
    const askResult = isAllowRuleShadowedByAskRule(allowRule, askRules, options)
    if (askResult.shadowed) {
      const shadowSource = formatSource(askResult.shadowedBy.source)
      unreachable.push({
        rule: allowRule,
        reason: `Shadowed by "${askResult.shadowedBy.ruleValue.toolName}" ask rule (from ${shadowSource})`,
        shadowedBy: askResult.shadowedBy,
        shadowType: 'ask',
        fix: generateFixSuggestion('ask', askResult.shadowedBy, allowRule),
      })
    }
  }

  return unreachable
}
