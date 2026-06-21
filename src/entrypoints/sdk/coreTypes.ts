// SDK Core Types —— SDK 消费方与 SDK 构建方共用的通用可序列化类型。
//
// 类型由 coreSchemas.ts 中的 Zod schema 生成。
// 修改类型步骤：
// 1. 编辑 coreSchemas.ts 中的 Zod schema
// 2. 运行：bun scripts/generate-sdk-types.ts
//
// schema 可在 coreSchemas.ts 中用于运行时校验，但不属于
// 公共 API。

// 为 SDK 消费方重新导出 sandbox 类型
export type {
  SandboxFilesystemConfig,
  SandboxIgnoreViolations,
  SandboxNetworkConfig,
  SandboxSettings,
} from '../sandboxTypes.js'
// 重新导出所有生成类型
export * from './coreTypes.generated.js'

// 重新导出无法用 Zod schema 表达的工具类型
export type { NonNullableUsage } from './sdkUtilityTypes.js'

// 供运行时使用的常量数组
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
] as const

export const EXIT_REASONS = [
  'clear',
  'resume',
  'logout',
  'prompt_input_exit',
  'other',
  'bypass_permissions_disabled',
] as const
