import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getKairosActive, getUserMsgOptIn } from 'src/bootstrap/state.js'
import { getFeatureValue_CACHED_WITH_REFRESH } from 'src/services/analytics/growthbook.js'
import { logEvent } from 'src/services/analytics/index.js'
import type { ValidationResult } from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { plural } from 'src/utils/stringUtils.js'
import { isBridgeEnabled } from 'src/bridge/bridgeEnabled.js'
import { resolveAttachments, validateAttachmentPaths } from './attachments.js'
import {
  BRIEF_TOOL_NAME,
  BRIEF_TOOL_PROMPT,
  DESCRIPTION,
  LEGACY_BRIEF_TOOL_NAME,
} from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    message: z.string().describe('发给用户的消息，支持 markdown 格式。'),
    attachments: z
      .array(z.string())
      .optional()
      .describe(
        '可选的附件文件路径（绝对路径或相对于 cwd），用于附带照片、截图、diff、日志，或任何用户应随消息一起看到的文件。',
      ),
    status: z
      .enum(['normal', 'proactive'])
      .describe(
        "当回复用户刚说的内容时使用 'normal'；当你主动发起时使用 'proactive' —— 如他们不在时任务完成、你遇到阻塞、主动发送状态更新。",
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// attachments 必须保持可选——恢复的会话会原样重放 attachment 引入之前
// 的输出，若该字段为必填，会在恢复时导致 UI 渲染器崩溃。
const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('消息内容'),
    attachments: z
      .array(
        z.object({
          path: z.string(),
          size: z.number(),
          isImage: z.boolean(),
          file_uuid: z.string().optional(),
        }),
      )
      .optional()
      .describe('已解析的附件元数据'),
    sentAt: z
      .string()
      .optional()
      .describe(
        '工具执行时在发送进程捕获的 ISO 时间戳。可选 —— 恢复的会话会原样重放 sentAt 之前的输出。',
      ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

const KAIROS_BRIEF_REFRESH_MS = 5 * 60 * 1000

/**
 * 权限检查——用户是否被允许使用 Brief？结合构建期 feature 标志、
 * 运行时 GB 开关以及 assistant 模式直通进行判断。此处不检查 opt-in——
 * 本函数决定的是 opt-in 是否应当被尊重，而非用户是否已 opt-in。
 *
 * 构建期以 KAIROS || KAIROS_BRIEF 进行 OR 门控（与
 * PROACTIVE || KAIROS 的模式相同）：assistant 模式依赖 Brief，因此
 * 仅 KAIROS 也必须打包它。KAIROS_BRIEF 则让 Brief 可以独立发布。
 *
 * 用本函数判断是否应当尊重 `--brief` / `defaultView: 'chat'` / `--tools`
 * 列表。判断工具在当前会话中是否真正激活，请使用 `isBriefEnabled()`。
 *
 * CLAUDE_CODE_BRIEF 环境变量会强制授予权限，用于开发/测试——
 * 绕过 GB 开关，便于未 enrollment 时也能测试。但仍需要 opt-in 动作来激活
 * （--brief、defaultView 等），不过仅靠该环境变量也会通过
 * maybeActivateBrief() 设置 userMsgOptIn。
 */
export function isBriefEntitled(): boolean {
  // 采用正向三元表达式——见 docs/feature-gating.md。若使用负向 early-return，
  // 外部构建中仍无法消除 GB 开关字符串。
  return feature('KAIROS') || feature('KAIROS_BRIEF')
    ? getKairosActive() ||
        isEnvTruthy(process.env.CLAUDE_CODE_BRIEF) ||
        getFeatureValue_CACHED_WITH_REFRESH(
          'tengu_kairos_brief',
          false,
          KAIROS_BRIEF_REFRESH_MS,
        )
    : false
}

/**
 * Brief 工具的统一激活门控。作为一个整体掌控面向模型的行为：
 * 工具可用性、system prompt 段落（getBriefSection）、工具延迟加载绕过
 * （isDeferredTool）以及 todo 催促抑制。
 *
 * 激活需要显式 opt-in（userMsgOptIn），由以下方式之一设置：
 *   - `--brief` CLI 标志（main.tsx 中的 maybeActivateBrief）
 *   - settings 中的 `defaultView: 'chat'`（main.tsx 初始化）
 *   - `/brief` slash 命令（brief.ts）
 *   - `/config` 的 defaultView 选择器（Config.tsx）
 *   - `--tools` / SDK `tools` 选项中的 SendUserMessage（main.tsx）
 *   - CLAUDE_CODE_BRIEF 环境变量（maybeActivateBrief——开发/测试绕过）
 * Assistant 模式（kairosActive）会绕过 opt-in，因为其 system prompt
 * 硬编码了 "you MUST use SendUserMessage"（systemPrompt.md:14）。
 *
 * GB 开关会在此处作为 kill-switch 被再次检查——在会话中途把
 * tengu_kairos_brief 关闭，会在下一次 5 分钟刷新时禁用该工具，
 * 即便对于已 opt-in 的会话也是如此。未 opt-in → 无论 GB 如何都
 * 恒为 false（这是 "brief defaults on for enrolled ants" 的修复）。
 *
 * 从 Tool.isEnabled() 中调用（惰性、初始化之后），绝不在模块作用域调用。
 * getKairosActive() 与 getUserMsgOptIn() 在 main.tsx 中先于任何调用方
 * 抵达此处之前设置。
 */
export function isBriefEnabled(): boolean {
  // 顶层 feature() 守卫对 DCE 至关重要：Bun 在外部构建中可以把三元表达式
  // 常量折叠为 `false`，进而对 BriefTool 对象做死代码消除。仅组合
  // isBriefEntitled()（内部已有自己的守卫）在语义上等价，但会破坏跨边界的
  // 常量折叠。
  return feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (getKairosActive() || getUserMsgOptIn()) && isBriefEntitled()
    : false
}

export const BriefTool = buildTool({
  name: BRIEF_TOOL_NAME,
  aliases: [LEGACY_BRIEF_TOOL_NAME],
  searchHint: '向用户发送消息 —— 你的主要可见输出渠道',
  maxResultSizeChars: 100_000,
  userFacingName() {
    return ''
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isBridgeEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.message
  },
  async validateInput({ attachments }, _context): Promise<ValidationResult> {
    if (!attachments || attachments.length === 0) {
      return { result: true }
    }
    return validateAttachmentPaths(attachments)
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return BRIEF_TOOL_PROMPT
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const n = output.attachments?.length ?? 0
    const suffix = n === 0 ? '' : ` (${n} ${plural(n, 'attachment')} included)`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `消息已发送给用户。${suffix}`,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call({ message, attachments, status }, context) {
    const sentAt = new Date().toISOString()
    logEvent('tengu_brief_send', {
      proactive: status === 'proactive',
      attachment_count: attachments?.length ?? 0,
    })
    if (!attachments || attachments.length === 0) {
      return { data: { message, sentAt } }
    }
    const appState = context.getAppState()
    const resolved = await resolveAttachments(attachments, {
      replBridgeEnabled: appState.replBridgeEnabled,
      signal: context.abortController.signal,
    })
    return {
      data: { message, attachments: resolved, sentAt },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
