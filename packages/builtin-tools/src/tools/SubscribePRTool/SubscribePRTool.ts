import { z } from 'zod/v4'
import type { ToolResultBlockParam } from 'src/Tool.js'
import { buildTool } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'

const SUBSCRIBE_PR_TOOL_NAME = 'SubscribePR'

const inputSchema = lazySchema(() =>
  z.strictObject({
    repo: z.string().describe('仓库，格式为 owner/repo。'),
    pr_number: z.number().describe('要订阅的 Pull Request 编号。'),
    events: z
      .array(z.enum(['comment', 'review', 'ci', 'merge', 'close']))
      .optional()
      .describe('要订阅的事件类型。默认订阅全部事件。'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type SubscribeInput = z.infer<InputSchema>

type SubscribeOutput = { subscribed: boolean; subscription_id: string }

export const SubscribePRTool = buildTool({
  name: SUBSCRIBE_PR_TOOL_NAME,
  searchHint: '订阅 pull request GitHub webhook 事件监听',
  maxResultSizeChars: 5_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return '通过 GitHub webhook 订阅 pull request 事件'
  },
  async prompt() {
    return `订阅 GitHub pull request 上的事件。当所选事件发生时（评论、评审、CI 状态变化、合并、关闭），你将收到通知。

可用于监控你创建或正在评审的 PR。事件会以可处理的消息形式投递给你。`
  },

  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },

  userFacingName() {
    return 'SubscribePR'
  },

  renderToolUseMessage(input: Partial<SubscribeInput>) {
    const pr =
      input.repo && input.pr_number ? `${input.repo}#${input.pr_number}` : '...'
    return `订阅 PR：${pr}`
  },

  mapToolResultToToolResultBlockParam(
    content: SubscribeOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: content.subscribed
        ? `已订阅 PR 事件（id：${content.subscription_id}）`
        : '订阅 PR 事件失败。',
    }
  },

  async call(_input: SubscribeInput) {
    // webhook 订阅由 KAIROS GitHub webhook 子系统管理。
    // 没有 KAIROS runtime 时，该工具不可用。
    return {
      data: {
        subscribed: false,
        subscription_id: '',
        error: 'SubscribePR 需要 KAIROS GitHub webhook 子系统。',
      },
    }
  },
})
