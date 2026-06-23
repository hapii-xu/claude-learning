import z from 'zod/v4'
// 类型已提取到 src/types/permissions.ts 以打破循环依赖
import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
} from '../../types/permissions.js'
import { lazySchema } from '../lazySchema.js'

// 向后兼容的重新导出
export type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
}

/**
 * ToolPermissionBehavior 是权限规则关联的行为。
 * 'allow' 表示规则允许工具运行。
 * 'deny' 表示规则拒绝工具运行。
 * 'ask' 表示规则强制向用户显示提示。
 */
export const permissionBehaviorSchema = lazySchema(() =>
  z.enum(['allow', 'deny', 'ask']),
)

/**
 * PermissionRuleValue 是权限规则的内容。
 * @param toolName - 此规则适用的工具名称
 * @param ruleContent - 规则的可选内容。
 *   每个工具可以在 `checkPermissions()` 中实现自定义处理
 */
export const permissionRuleValueSchema = lazySchema(() =>
  z.object({
    toolName: z.string(),
    ruleContent: z.string().optional(),
  }),
)
