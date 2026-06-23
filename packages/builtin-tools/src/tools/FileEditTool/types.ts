import { z } from 'zod/v4'
import { lazySchema } from 'src/utils/lazySchema.js'
import { semanticBoolean } from 'src/utils/semanticBoolean.js'

// 输入 schema，其中 replace_all 为可选字段
const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe('要修改的文件的绝对路径'),
    old_string: z.string().describe('要替换的文本'),
    new_string: z
      .string()
      .describe(
        '替换后的文本（必须与 old_string 不同）',
      ),
    replace_all: semanticBoolean(
      z.boolean().default(false).optional(),
    ).describe('是否替换所有出现的 old_string（默认为 false）'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 解析后的输出类型 — call() 接收的类型。使用 z.output 而非 z.input：
// 因为 semanticBoolean 的输入端类型为 unknown（预处理器接受任意值）。
export type FileEditInput = z.output<InputSchema>

// 不含 file_path 的单个编辑类型
export type EditInput = Omit<FileEditInput, 'file_path'>

// 运行时版本，其中 replace_all 始终有定义
export type FileEdit = {
  old_string: string
  new_string: string
  replace_all: boolean
}

export const hunkSchema = lazySchema(() =>
  z.object({
    oldStart: z.number(),
    oldLines: z.number(),
    newStart: z.number(),
    newLines: z.number(),
    lines: z.array(z.string()),
  }),
)

export const gitDiffSchema = lazySchema(() =>
  z.object({
    filename: z.string(),
    status: z.enum(['modified', 'added']),
    additions: z.number(),
    deletions: z.number(),
    changes: z.number(),
    patch: z.string(),
    repository: z
      .string()
      .nullable()
      .optional()
      .describe('可用时为 GitHub owner/repo'),
  }),
)

// FileEditTool 的输出 schema
const outputSchema = lazySchema(() =>
  z.object({
    filePath: z.string().describe('已编辑的文件路径'),
    oldString: z.string().describe('被替换的原始字符串'),
    newString: z.string().describe('替换后的新字符串'),
    originalFile: z
      .string()
      .describe('编辑前的原始文件内容'),
    structuredPatch: z
      .array(hunkSchema())
      .describe('展示变更的 diff 补丁'),
    userModified: z
      .boolean()
      .describe('用户是否修改了建议的变更'),
    replaceAll: z.boolean().describe('是否替换了所有出现位置'),
    gitDiff: gitDiffSchema().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type FileEditOutput = z.infer<OutputSchema>

export { inputSchema, outputSchema }
