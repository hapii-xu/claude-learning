/**
 * 权限更新的 Zod schema。
 *
 * 此文件有意保持精简，不包含复杂依赖，
 * 以便可以被 src/types/hooks.ts 安全导入而不产生
 * 循环依赖。
 */
import z from 'zod/v4'
// 类型已提取到 src/types/permissions.ts 以打破循环导入
import type {
  PermissionUpdate,
  PermissionUpdateDestination,
} from '../../types/permissions.js'
import { lazySchema } from '../lazySchema.js'
import { externalPermissionModeSchema } from './PermissionMode.js'
import {
  permissionBehaviorSchema,
  permissionRuleValueSchema,
} from './PermissionRule.js'

// 向后兼容的重新导出
export type { PermissionUpdate, PermissionUpdateDestination }

/**
 * PermissionUpdateDestination 表示新的权限规则应保存到的位置。
 */
export const permissionUpdateDestinationSchema = lazySchema(() =>
  z.enum([
    // 用户设置（全局）
    'userSettings',
    // 项目设置（目录级共享）
    'projectSettings',
    // 本地设置（被 gitignore）
    'localSettings',
    // 仅当前会话的内存中设置
    'session',
    // 来自命令行参数
    'cliArg',
  ]),
)

export const permissionUpdateSchema = lazySchema(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('addRules'),
      rules: z.array(permissionRuleValueSchema()),
      behavior: permissionBehaviorSchema(),
      destination: permissionUpdateDestinationSchema(),
    }),
    z.object({
      type: z.literal('replaceRules'),
      rules: z.array(permissionRuleValueSchema()),
      behavior: permissionBehaviorSchema(),
      destination: permissionUpdateDestinationSchema(),
    }),
    z.object({
      type: z.literal('removeRules'),
      rules: z.array(permissionRuleValueSchema()),
      behavior: permissionBehaviorSchema(),
      destination: permissionUpdateDestinationSchema(),
    }),
    z.object({
      type: z.literal('setMode'),
      mode: externalPermissionModeSchema(),
      destination: permissionUpdateDestinationSchema(),
    }),
    z.object({
      type: z.literal('addDirectories'),
      directories: z.array(z.string()),
      destination: permissionUpdateDestinationSchema(),
    }),
    z.object({
      type: z.literal('removeDirectories'),
      directories: z.array(z.string()),
      destination: permissionUpdateDestinationSchema(),
    }),
  ]),
)
