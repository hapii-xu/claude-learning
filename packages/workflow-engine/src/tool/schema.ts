import { z } from 'zod/v4'

/** Workflow 工具输入 schema。args 可以是任意 JSON 值（对象/数组/字符串等）。*/
export const workflowInputSchema = z.object({
  script: z.string().optional().describe('自包含的 workflow 脚本源码（内联）'),
  name: z
    .string()
    .optional()
    .describe('命名 workflow，解析至 .hclaude/workflows/<name>.ts|js|mjs'),
  scriptPath: z.string().optional().describe('现有脚本文件的绝对路径'),
  args: z
    .unknown()
    .optional()
    .describe(
      '传递给脚本的 args 全局变量。请传入真实 JSON 值（对象/数组/字符串），而非 JSON 字符串。',
    ),
  resumeFromRunId: z
    .string()
    .optional()
    .describe('恢复指定的运行，从日志中回放'),
  description: z.string().optional().describe('本次调用的简短描述（3-5 个词）'),
  title: z.string().optional().describe('进度查看器标题'),
  maxConcurrency: z
    .number()
    .int()
    .min(1)
    .max(16)
    .optional()
    .describe(
      'agent() 的并发上限。默认为 3（最大 16）。当 workflow 包含大量 parallel/pipeline 扇出时，可在启动前通过 AskUserQuestion 与用户确认所需并发数。',
    ),
})

/**
 * Workflow 工具输入类型——从 schema 派生，避免手写类型与 schema 之间的漂移。
 * 旧版实现中，{@link WorkflowInput} 在 types.ts 中手写，schema 在 schema.ts 中，
 * 通过 `as unknown as z.ZodType<WorkflowInput>` 双重断言衔接——当 schema 字段变更
 * 而类型未同步时，TS 不会报错。使用 z.infer 后，schema 与类型永远保持同步。
 */
export type WorkflowInput = z.infer<typeof workflowInputSchema>

/** schema 的 typeof 类型（用于"schema 是唯一事实来源"的精确签名）。*/
export type WorkflowInputSchema = typeof workflowInputSchema
