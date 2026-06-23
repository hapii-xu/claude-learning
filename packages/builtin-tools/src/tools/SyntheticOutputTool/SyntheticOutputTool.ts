import { Ajv } from 'ajv'
import { z } from 'zod/v4'
import type { Tool, ToolInputJSONSchema } from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/utils/errors.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import { jsonStringify } from 'src/utils/slowOperations.js'

// 由于 schema 是动态提供的，允许任意输入对象
const inputSchema = lazySchema(() => z.object({}).passthrough())
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.string().describe('结构化输出的工具结果'),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const SYNTHETIC_OUTPUT_TOOL_NAME = 'StructuredOutput'

export function isSyntheticOutputToolEnabled(opts: {
  isNonInteractiveSession: boolean
}): boolean {
  return opts.isNonInteractiveSession
}

export const SyntheticOutputTool = buildTool({
  isMcp: false,
  isEnabled() {
    // 该工具仅在满足条件时被创建（见 main.tsx 中 isSyntheticOutputToolEnabled()
    // 对工具创建做了门控）。一旦创建，就始终启用。
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  isOpenWorld() {
    return false
  },
  name: SYNTHETIC_OUTPUT_TOOL_NAME,
  searchHint: '以结构化 JSON 格式返回最终响应',
  maxResultSizeChars: 100_000,
  async description(): Promise<string> {
    return '按请求的格式返回结构化输出'
  },
  async prompt(): Promise<string> {
    return `使用此工具按请求的结构化格式返回最终响应。你必须在响应末尾精确调用一次此工具以提供结构化输出。`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async call(input) {
    // 该工具仅校验并将输入作为结构化输出返回
    return {
      data: '成功提供结构化输出',
      structured_output: input,
    }
  },
  async checkPermissions(input): Promise<PermissionResult> {
    // 始终允许此工具 - 它只是返回数据
    return {
      behavior: 'allow',
      updatedInput: input,
    }
  },
  // 最小化的 UI 实现 - 此工具面向非交互式 SDK/CLI 使用
  renderToolUseMessage(input: Record<string, unknown>) {
    const keys = Object.keys(input)
    if (keys.length === 0) return null
    if (keys.length <= 3) {
      return keys.map(k => `${k}: ${jsonStringify(input[k])}`).join(', ')
    }
    return `${keys.length} 个字段：${keys.slice(0, 3).join(', ')}…`
  },
  renderToolUseRejectedMessage() {
    return '结构化输出被拒绝'
  },
  renderToolUseErrorMessage() {
    return '结构化输出错误'
  },
  renderToolUseProgressMessage() {
    return null
  },
  renderToolResultMessage(output: string) {
    return output
  },
  mapToolResultToToolResultBlockParam(content: string, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

type CreateResult = { tool: Tool<InputSchema> } | { error: string }

// Workflow 脚本每次运行会调用 agent({schema: BUGS_SCHEMA}) 30-80 次，
// 使用的是同一个 schema 对象引用。若不缓存，每次调用都会执行
// new Ajv() + validateSchema() + compile()（约 1.4ms 的 JIT 代码生成）。
// 基于引用一致的缓存把 80 次调用的 Ajv 开销从 ~110ms 降到 ~4ms。
const toolCache = new WeakMap<object, CreateResult>()

/**
 * 使用给定的 JSON schema 创建一个 SyntheticOutputTool。
 * 成功时返回 {tool}；schema 非法时返回 {error} 及 Ajv 的诊断信息
 * （例如 "data/properties/bugs should be object"）。
 */
export function createSyntheticOutputTool(
  jsonSchema: Record<string, unknown>,
): CreateResult {
  const cached = toolCache.get(jsonSchema)
  if (cached) return cached

  const result = buildSyntheticOutputTool(jsonSchema)
  toolCache.set(jsonSchema, result)
  return result
}

function buildSyntheticOutputTool(
  jsonSchema: Record<string, unknown>,
): CreateResult {
  try {
    const ajv = new Ajv({ allErrors: true })
    const isValidSchema = ajv.validateSchema(jsonSchema)
    if (!isValidSchema) {
      return { error: ajv.errorsText(ajv.errors) }
    }
    const validateSchema = ajv.compile(jsonSchema)

    return {
      tool: {
        ...SyntheticOutputTool,
        inputJSONSchema: jsonSchema as ToolInputJSONSchema,
        async call(input) {
          const isValid = validateSchema(input)
          if (!isValid) {
            const errors = validateSchema.errors
              ?.map(e => `${e.instancePath || 'root'}: ${e.message}`)
              .join(', ')
            throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
              `输出不匹配必需的 schema：${errors}`,
              `StructuredOutput schema mismatch: ${(errors ?? '').slice(0, 150)}`,
            )
          }
          return {
            data: '成功提供结构化输出',
            structured_output: input,
          }
        },
      },
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
