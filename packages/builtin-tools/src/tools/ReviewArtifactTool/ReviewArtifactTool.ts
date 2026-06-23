import { z } from 'zod/v4'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import React from 'react'
import { Box, Text } from '@anthropic/ink'

const REVIEW_ARTIFACT_TOOL_NAME = 'ReviewArtifact'

const DESCRIPTION =
  '通过内联标注和反馈审阅一个产出物（代码片段、文档或其他内容）。'

const inputSchema = lazySchema(() =>
  z.strictObject({
    artifact: z
      .string()
      .describe(
        '待审阅产出物的内容（代码片段、文档文本等）。',
      ),
    title: z
      .string()
      .optional()
      .describe('待审阅产出物的可选标题或文件路径。'),
    annotations: z
      .array(
        z.object({
          line: z
            .number()
            .optional()
            .describe('标注的行号（从 1 开始）。'),
          message: z.string().describe('标注或反馈消息。'),
          severity: z
            .enum(['info', 'warning', 'error', 'suggestion'])
            .optional()
            .describe('标注的严重级别。'),
        }),
      )
      .describe('产出物上的标注/评论列表。'),
    summary: z
      .string()
      .optional()
      .describe('审阅的总体总结。'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    artifact: z.string().describe('已审阅的产出物内容。'),
    title: z.string().optional().describe('已审阅产出物的标题。'),
    annotationCount: z.number().describe('应用的标注数量。'),
    summary: z.string().optional().describe('审阅总结。'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const ReviewArtifactTool = buildTool({
  name: REVIEW_ARTIFACT_TOOL_NAME,
  searchHint: 'review code or documents with inline annotations',
  maxResultSizeChars: 100_000,
  async description(input) {
    const { title } = input as { title?: string }
    return title
      ? `Claude 想要审阅：${title}`
      : 'Claude 想要审阅一个产出物'
  },
  userFacingName() {
    return 'ReviewArtifact'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.title ?? input.artifact.slice(0, 200)
  },
  async prompt() {
    return `使用本工具呈现对代码片段、文档或其他产出物的审阅结果，包含内联标注和反馈。每个标注可针对特定行并包含严重级别。${DESCRIPTION}`
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `已完成审阅，共 ${output.annotationCount} 条标注。${output.summary ? ` 总结：${output.summary}` : ''}`,
    }
  },
  renderToolUseMessage(
    input: Partial<z.infer<InputSchema>>,
    { verbose }: { theme?: string; verbose: boolean },
  ): React.ReactNode {
    const title = input.title ?? '未命名产出物'
    const count = input.annotations?.length ?? 0
    if (verbose) {
      return `审阅："${title}"（${count} 条标注）`
    }
    return title
  },
  renderToolResultMessage(
    output: Output,
    _progressMessages: unknown[],
    { verbose }: { verbose: boolean },
  ): React.ReactNode {
    if (verbose) {
      return React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(
          Text,
          null,
          `已审阅产出物：${output.title ?? '未命名'}（${output.annotationCount} 条标注）`,
        ),
        output.summary
          ? React.createElement(Text, { dimColor: true }, output.summary)
          : null,
      )
    }
    return React.createElement(
      Text,
      null,
      `审阅完成：${output.annotationCount} 条标注`,
    )
  },
  async call({ artifact, title, annotations, summary }, _context) {
    const output: Output = {
      artifact,
      title,
      annotationCount: annotations.length,
      summary,
    }
    return { data: output }
  },
} satisfies ToolDef<InputSchema, Output>)
