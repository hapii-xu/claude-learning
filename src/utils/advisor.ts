import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { shouldIncludeFirstPartyOnlyBetas } from './betas.js'
import { isEnvTruthy } from './envUtils.js'
import { getInitialSettings } from './settings/settings.js'

// SDK 尚未提供 advisor 块的类型定义。
// TODO(hackyon): 当此功能公开发布时，迁移到真实的 anthropic SDK 类型
export type AdvisorServerToolUseBlock = {
  type: 'server_tool_use'
  id: string
  name: 'advisor'
  input: { [key: string]: unknown }
}

export type AdvisorToolResultBlock = {
  type: 'advisor_tool_result'
  tool_use_id: string
  content:
    | {
        type: 'advisor_result'
        text: string
      }
    | {
        type: 'advisor_redacted_result'
        encrypted_content: string
      }
    | {
        type: 'advisor_tool_result_error'
        error_code: string
      }
}

export type AdvisorBlock = AdvisorServerToolUseBlock | AdvisorToolResultBlock

export function isAdvisorBlock(param: {
  type: string
  name?: string
}): param is AdvisorBlock {
  return (
    param.type === 'advisor_tool_result' ||
    (param.type === 'server_tool_use' && param.name === 'advisor')
  )
}

type AdvisorConfig = {
  enabled?: boolean
  canUserConfigure?: boolean
  baseModel?: string
  advisorModel?: string
}

function getAdvisorConfig(): AdvisorConfig {
  const result = getFeatureValue_CACHED_MAY_BE_STALE<AdvisorConfig>(
    'tengu_sage_compass',
    {},
  )
  console.error(
    '[DEBUG advisor] getAdvisorConfig result:',
    JSON.stringify(result),
  )
  return result
}

export function isAdvisorEnabled(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL)) {
    console.error(
      '[DEBUG advisor] isAdvisorEnabled: false (DISABLE_ADVISOR_TOOL env set)',
    )
    return false
  }
  // advisor beta 头部仅限第一方（Bedrock/Vertex 会返回 400）。
  if (!shouldIncludeFirstPartyOnlyBetas() && process.env.USER_TYPE !== 'ant') {
    console.error(
      '[DEBUG advisor] isAdvisorEnabled: false (shouldIncludeFirstPartyOnlyBetas=false)',
    )
    return false
  }
  const config = getAdvisorConfig()
  console.error(
    '[DEBUG advisor] isAdvisorEnabled: config.enabled =',
    config.enabled,
  )
  return config.enabled ?? false
}

export function canUserConfigureAdvisor(): boolean {
  // ┌──────────────┬──────────────────────────────────────────────────────────────┬────────────────────────────┐
  // │     字段     │                             含义                             │            例子            │
  // ├──────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────┤
  // │ baseModel    │ 基础模型/主模型 —— 当前跑 agent 主循环的那个模型，即"提问方" │ 你现在用的 options.model   │
  // ├──────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────┤
  // │ advisorModel │ 顾问模型/reviewer —— 被请教来给建议的更强模型，即"回答方"    │ 想让它充当 reviewer 的模型 │
  // └──────────────┴──────────────────────────────────────────────────────────────┴────────────────────────────┘

  // 实验的语义是："当用户的主模型正好是 baseModel 时，强制把它的 advisor 覆盖成 advisorModel"。这是 Anthropic 做 A/B
  // 实验用的——"对跑模型 X 的用户，强制 advisor 用模型 Y，看看效果"。
  return isAdvisorEnabled() && (getAdvisorConfig().canUserConfigure ?? false)
}

export function getExperimentAdvisorModels():
  | { baseModel: string; advisorModel: string }
  | undefined {
  const config = getAdvisorConfig()
  return isAdvisorEnabled() &&
    !canUserConfigureAdvisor() &&
    config.baseModel &&
    config.advisorModel
    ? { baseModel: config.baseModel, advisorModel: config.advisorModel }
    : undefined
}

// @[MODEL LAUNCH]: 如果新模型支持 advisor 工具，添加到此列表。
// 检查主循环模型是否支持调用 advisor 工具。
export function modelSupportsAdvisor(model: string): boolean {
  const m = model.toLowerCase()
  return (
    m.includes('opus-4-7') ||
    m.includes('opus-4-6') ||
    m.includes('sonnet-4-6') ||
    process.env.USER_TYPE === 'ant'
  )
}

// @[MODEL LAUNCH]: 如果新模型可以作为 advisor 模型，添加到此列表。
export function isValidAdvisorModel(model: string): boolean {
  const m = model.toLowerCase()
  return (
    m.includes('opus-4-7') ||
    m.includes('opus-4-6') ||
    m.includes('sonnet-4-6') ||
    process.env.USER_TYPE === 'ant'
  )
}

export function getInitialAdvisorSetting(): string | undefined {
  if (!isAdvisorEnabled()) {
    return undefined
  }
  return getInitialSettings().advisorModel
}

export function getAdvisorUsage(
  usage: BetaUsage,
): Array<BetaUsage & { model: string }> {
  const iterations = usage.iterations as
    | Array<{ type: string }>
    | null
    | undefined
  if (!iterations) {
    return []
  }
  return iterations.filter(
    it => it.type === 'advisor_message',
  ) as unknown as Array<BetaUsage & { model: string }>
}

export const ADVISOR_TOOL_INSTRUCTIONS = `# Advisor Tool

You have access to an \`advisor\` tool backed by a stronger reviewer model. It takes NO parameters -- when you call it, your entire conversation history is automatically forwarded. The advisor sees the task, every tool call you've made, every result you've seen.

Call advisor BEFORE substantive work -- before writing code, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, reading code, seeing what's there), do that, then call advisor. Orientation is not substantive work. Writing, editing, and declaring an answer are.

Also call advisor:
- When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, stage the change, save the result. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.
- When stuck -- errors recurring, approach not converging, results that don't fit.
- When considering a change of approach.

On tasks longer than a few steps, call advisor at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling -- the advisor adds most of its value on the first call, before the approach crystallizes.

Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim (the file says X, the code does Y), adapt. A passing self-test is not evidence the advice is wrong -- it's evidence your test doesn't check what the advice is checking.

If you've already retrieved data pointing one way and the advisor points another: don't silently switch. Surface the conflict in one more advisor call -- "I found X, you suggest Y, which constraint breaks the tie?" The advisor saw your evidence but may have underweighted it; a reconcile call is cheaper than committing to the wrong branch.`
