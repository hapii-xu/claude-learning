import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getKairosActive, setUserMsgOptIn } from '../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { ToolUseContext } from '../Tool.js'
import { isBriefEntitled } from '@claude-code-best/builtin-tools/tools/BriefTool/BriefTool.js'
import { BRIEF_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BriefTool/prompt.js'
import type {
  Command,
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../types/command.js'
import { lazySchema } from '../utils/lazySchema.js'

// Zod 防护可避免 GB 推送时的手滑错误（与 pollConfig.ts / cronScheduler.ts 同一模式）。
// 配置格式异常时整体回退到 DEFAULT_BRIEF_CONFIG，而不是部分信任。
const briefConfigSchema = lazySchema(() =>
  z.object({
    enable_slash_command: z.boolean(),
  }),
)
type BriefConfig = z.infer<ReturnType<typeof briefConfigSchema>>

const DEFAULT_BRIEF_CONFIG: BriefConfig = {
  enable_slash_command: false,
}

// 无 TTL —— 该 gate 控制的是斜杠命令的 *可见性*，不是 kill switch。
// CACHED_MAY_BE_STALE 仍会有一次后台更新翻转（首次调用触发 fetch；第二次调用拿到新值），
// 但之后不会再有额外翻转。
// 工具可用性 gate（isBriefEnabled 中的 tengu_kairos_brief）保留其 5 分钟 TTL，
// 因为它确实是 kill switch。
function getBriefConfig(): BriefConfig {
  const raw = getFeatureValue_CACHED_MAY_BE_STALE<unknown>(
    'tengu_kairos_brief_config',
    DEFAULT_BRIEF_CONFIG,
  )
  const parsed = briefConfigSchema().safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_BRIEF_CONFIG
}

const brief = {
  type: 'local-jsx',
  name: 'brief',
  description: 'Toggle brief-only mode',
  isEnabled: () => {
    if (feature('KAIROS') || feature('KAIROS_BRIEF')) {
      return getBriefConfig().enable_slash_command
    }
    return false
  },
  immediate: true,
  load: () =>
    Promise.resolve({
      async call(
        onDone: LocalJSXCommandOnDone,
        context: ToolUseContext & LocalJSXCommandContext,
      ): Promise<React.ReactNode> {
        const current = context.getAppState().isBriefOnly
        const newState = !current

        // 权限校验只拦截「开启」切换 —— 「关闭」始终允许，
        // 以免会话中途 GB gate 翻转时把用户卡住。
        if (newState && !isBriefEntitled()) {
          logEvent('tengu_brief_mode_toggled', {
            enabled: false,
            gated: true,
            source:
              'slash_command' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          onDone('Brief tool is not enabled for your account', {
            display: 'system',
          })
          return null
        }

        // 双向联动：userMsgOptIn 跟随 isBriefOnly，使工具在 brief 模式开启时才可用。
        // 每次切换都会使 prompt cache 失效（工具列表变化），但工具列表过期更糟 ——
        // 会话中途开启 /brief 时，此前模型没有该工具可用，只能输出会被过滤器隐藏的纯文本。
        setUserMsgOptIn(newState)

        context.setAppState(prev => {
          if (prev.isBriefOnly === newState) return prev
          return { ...prev, isBriefOnly: newState }
        })

        logEvent('tengu_brief_mode_toggled', {
          enabled: newState,
          gated: false,
          source:
            'slash_command' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })

        // 会话中途仅靠工具列表变化信号不够强（模型可能凭惯性继续输出纯文本，
        // 或继续调用刚被移除的工具）。向下一轮上下文显式注入提示，使切换语义清晰无歧义。
        // Kairos 激活时跳过：isBriefEnabled() 会在 getKairosActive() 上短路，
        // 工具实际并不会从列表中消失，且 Kairos system prompt 已强制要求 SendUserMessage。
        // 内联 <system-reminder> 包裹 —— 从 utils/messages.ts 引入 wrapInSystemReminder
        // 会经由本模块的 import 链把 constants/xml.ts 拉进 bridge SDK bundle，
        // 触发 excluded-strings 检查。
        const metaMessages = getKairosActive()
          ? undefined
          : [
              `<system-reminder>\n${
                newState
                  ? `Brief mode is now enabled. Use the ${BRIEF_TOOL_NAME} tool for all user-facing output — plain text outside it is hidden from the user's view.`
                  : `Brief mode is now disabled. The ${BRIEF_TOOL_NAME} tool is no longer available — reply with plain text.`
              }\n</system-reminder>`,
            ]

        onDone(
          newState ? 'Brief-only mode enabled' : 'Brief-only mode disabled',
          { display: 'system', metaMessages },
        )
        return null
      },
    }),
} satisfies Command

export default brief
