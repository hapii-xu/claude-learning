import { z } from 'zod/v4'
import type { ToolResultBlockParam } from 'src/Tool.js'
import { buildTool } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'

const SUGGEST_BACKGROUND_PR_TOOL_NAME = 'SuggestBackgroundPR'

const inputSchema = lazySchema(() =>
  z.strictObject({
    title: z.string().describe('建议的后台 PR 标题。'),
    description: z.string().describe('后台 PR 中要做的改动描述。'),
    branch: z.string().optional().describe('PR 的分支名。省略时自动生成。'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type SuggestInput = z.infer<InputSchema>

type SuggestOutput = { suggested: boolean; suggestion_id: string }

export const SuggestBackgroundPRTool = buildTool({
  name: SUGGEST_BACKGROUND_PR_TOOL_NAME,
  searchHint: 'suggest background pr pull request create',
  maxResultSizeChars: 5_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return '建议为后续改动创建后台 PR'
  },
  async prompt() {
    return `建议在后台创建一个 pull request 以处理后续工作。当你识别出应做但不属于当前任务的改进或清理工作时使用此工具。

建议会呈现给用户，由用户决定批准或忽略。批准后，后台 agent 会创建该 PR。`
  },

  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },

  userFacingName() {
    return 'SuggestPR'
  },

  renderToolUseMessage(input: Partial<SuggestInput>) {
    return `建议 PR：${input.title ?? '...'}`
  },

  mapToolResultToToolResultBlockParam(
    content: SuggestOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: content.suggested
        ? `已记录 PR 建议（id：${content.suggestion_id}）`
        : '记录 PR 建议失败。',
    }
  },

  async call(_input: SuggestInput) {
    // 后台 PR 建议需要 KAIROS runtime。
    return {
      data: {
        suggested: false,
        suggestion_id: '',
        error: 'SuggestBackgroundPR 需要 KAIROS runtime。',
      },
    }
  },
})
