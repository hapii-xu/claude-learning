/**
 * 提取出来的 Hook Zod schema，用于打破 import 循环。
 *
 * 本文件包含原本位于 src/utils/settings/types.ts 中的
 * hook 相关 schema 定义。将其提取到此处后，可以打破
 * settings/types.ts 与 plugins/schemas.ts 之间的循环依赖。
 *
 * 现在这两个文件都从此共享位置导入，而不是互相导入。
 */

import { HOOK_EVENTS, type HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'
import { SHELL_TYPES } from '../utils/shell/shellProvider.js'

// `if` 条件字段的共享 schema。
// 使用权限规则语法（例如 "Bash(git *)"、"Read(*.ts)"）在 spawn 之前过滤 hook。
// 会针对 hook 输入的 tool_name 和 tool_input 进行求值。
const IfConditionSchema = lazySchema(() =>
  z
    .string()
    .optional()
    .describe(
      'Permission rule syntax to filter when this hook runs (e.g., "Bash(git *)"). ' +
        'Only runs if the tool call matches the pattern. Avoids spawning hooks for non-matching commands.',
    ),
)

// 内部工厂，用于构造各个 hook schema（在导出的可辨识联合类型成员
// 和 HookCommandSchema 工厂之间共享）
function buildHookSchemas() {
  const BashCommandHookSchema = z.object({
    type: z.literal('command').describe('Shell command hook type'),
    command: z.string().describe('Shell command to execute'),
    if: IfConditionSchema(),
    shell: z
      .enum(SHELL_TYPES)
      .optional()
      .describe(
        "Shell interpreter. 'bash' uses your $SHELL (bash/zsh/sh); 'powershell' uses pwsh. Defaults to bash.",
      ),
    timeout: z
      .number()
      .positive()
      .optional()
      .describe('Timeout in seconds for this specific command'),
    statusMessage: z
      .string()
      .optional()
      .describe('Custom status message to display in spinner while hook runs'),
    once: z
      .boolean()
      .optional()
      .describe('If true, hook runs once and is removed after execution'),
    async: z
      .boolean()
      .optional()
      .describe('If true, hook runs in background without blocking'),
    asyncRewake: z
      .boolean()
      .optional()
      .describe(
        'If true, hook runs in background and wakes the model on exit code 2 (blocking error). Implies async.',
      ),
  })

  const PromptHookSchema = z.object({
    type: z.literal('prompt').describe('LLM prompt hook type'),
    prompt: z
      .string()
      .describe(
        'Prompt to evaluate with LLM. Use $ARGUMENTS placeholder for hook input JSON.',
      ),
    if: IfConditionSchema(),
    timeout: z
      .number()
      .positive()
      .optional()
      .describe('Timeout in seconds for this specific prompt evaluation'),
    // @[模型发布]：更新下方 .describe() 字符串中的示例模型 ID（prompt + agent hooks）。
    model: z
      .string()
      .optional()
      .describe(
        'Model to use for this prompt hook (e.g., "claude-sonnet-4-6"). If not specified, uses the default small fast model.',
      ),
    statusMessage: z
      .string()
      .optional()
      .describe('Custom status message to display in spinner while hook runs'),
    once: z
      .boolean()
      .optional()
      .describe('If true, hook runs once and is removed after execution'),
  })

  const HttpHookSchema = z.object({
    type: z.literal('http').describe('HTTP hook type'),
    url: z.string().url().describe('URL to POST the hook input JSON to'),
    if: IfConditionSchema(),
    timeout: z
      .number()
      .positive()
      .optional()
      .describe('Timeout in seconds for this specific request'),
    headers: z.record(z.string(), z.string()).optional().describe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: ${VAR_NAME} 是配置语法的文档说明，不是 JS 模板字面量
      'Additional headers to include in the request. Values may reference environment variables using $VAR_NAME or ${VAR_NAME} syntax (e.g., "Authorization": "Bearer $MY_TOKEN"). Only variables listed in allowedEnvVars will be interpolated.',
    ),
    allowedEnvVars: z
      .array(z.string())
      .optional()
      .describe(
        'Explicit list of environment variable names that may be interpolated in header values. Only variables listed here will be resolved; all other $VAR references are left as empty strings. Required for env var interpolation to work.',
      ),
    statusMessage: z
      .string()
      .optional()
      .describe('Custom status message to display in spinner while hook runs'),
    once: z
      .boolean()
      .optional()
      .describe('If true, hook runs once and is removed after execution'),
  })

  const AgentHookSchema = z.object({
    type: z.literal('agent').describe('Agentic verifier hook type'),
    // 不要在此处添加 .transform()。此 schema 被 parseSettingsFile 使用，
    // 并且 updateSettingsForSource 会把解析结果通过 JSON.stringify 往返一次 ——
    // 被转换过的函数值会被静默丢弃，从而删除用户在 settings.json 中的 prompt
    // （gh-24920、CC-79）。#10594 引入的 transform 把字符串包装成
    // `(_msgs) => prompt`，用于 ExitPlanModeV2Tool 中一种以编程方式构造对象的
    // 场景；该场景后来被重构进 VerifyPlanExecutionTool，而后者已经完全
    // 不再构造 AgentHook 对象。
    prompt: z
      .string()
      .describe(
        'Prompt describing what to verify (e.g. "Verify that unit tests ran and passed."). Use $ARGUMENTS placeholder for hook input JSON.',
      ),
    if: IfConditionSchema(),
    timeout: z
      .number()
      .positive()
      .optional()
      .describe('Timeout in seconds for agent execution (default 60)'),
    model: z
      .string()
      .optional()
      .describe(
        'Model to use for this agent hook (e.g., "claude-sonnet-4-6"). If not specified, uses Haiku.',
      ),
    statusMessage: z
      .string()
      .optional()
      .describe('Custom status message to display in spinner while hook runs'),
    once: z
      .boolean()
      .optional()
      .describe('If true, hook runs once and is removed after execution'),
  })

  return {
    BashCommandHookSchema,
    PromptHookSchema,
    HttpHookSchema,
    AgentHookSchema,
  }
}

/**
 * hook command 的 schema（不含 function hook —— 它们无法被持久化）
 */
export const HookCommandSchema = lazySchema(() => {
  const {
    BashCommandHookSchema,
    PromptHookSchema,
    AgentHookSchema,
    HttpHookSchema,
  } = buildHookSchemas()
  return z.discriminatedUnion('type', [
    BashCommandHookSchema,
    PromptHookSchema,
    AgentHookSchema,
    HttpHookSchema,
  ])
})

/**
 * 包含多个 hook 的 matcher 配置 schema
 */
export const HookMatcherSchema = lazySchema(() =>
  z.object({
    matcher: z
      .string()
      .optional()
      .describe('String pattern to match (e.g. tool names like "Write")'), // 字符串（例如 Write），用于匹配与 hook 事件相关的值，例如工具名
    hooks: z
      .array(HookCommandSchema())
      .describe('List of hooks to execute when the matcher matches'),
  }),
)

/**
 * hooks 配置的 schema
 * key 是 hook 事件，value 是一个 matcher 配置数组。
 * 使用 partialRecord，因为并非所有 hook 事件都需要被定义。
 */
export const HooksSchema = lazySchema(() =>
  z.partialRecord(z.enum(HOOK_EVENTS), z.array(HookMatcherSchema())),
)

// 从 schema 推断出的类型
export type HookCommand = z.infer<ReturnType<typeof HookCommandSchema>>
export type BashCommandHook = Extract<HookCommand, { type: 'command' }>
export type PromptHook = Extract<HookCommand, { type: 'prompt' }>
export type AgentHook = Extract<HookCommand, { type: 'agent' }>
export type HttpHook = Extract<HookCommand, { type: 'http' }>
export type HookMatcher = z.infer<ReturnType<typeof HookMatcherSchema>>
export type HooksSettings = Partial<Record<HookEvent, HookMatcher[]>>
