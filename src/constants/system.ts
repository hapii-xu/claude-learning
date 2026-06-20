// 关键系统常量已抽取出来，以打破循环依赖

import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { logForDebugging } from '../utils/debug.js'
import { isEnvDefinedFalsy } from '../utils/envUtils.js'
import { getAPIProvider } from '../utils/model/providers.js'
import { getWorkload } from '../utils/workloadContext.js'

const DEFAULT_PREFIX = `You are Claude Code, Anthropic's official CLI for Claude.`
const AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX = `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.`
const AGENT_SDK_PREFIX = `You are a Claude agent, built on Anthropic's Claude Agent SDK.`

const CLI_SYSPROMPT_PREFIX_VALUES = [
  DEFAULT_PREFIX,
  AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX,
  AGENT_SDK_PREFIX,
] as const

export type CLISyspromptPrefix = (typeof CLI_SYSPROMPT_PREFIX_VALUES)[number]

/**
 * 所有可能的 CLI sysprompt 前缀值，splitSysPromptPrefix 使用
 * 它们按内容而非位置识别前缀块。
 */
export const CLI_SYSPROMPT_PREFIXES: ReadonlySet<string> = new Set(
  CLI_SYSPROMPT_PREFIX_VALUES,
)

export function getCLISyspromptPrefix(options?: {
  isNonInteractive: boolean
  hasAppendSystemPrompt: boolean
}): CLISyspromptPrefix {
  const apiProvider = getAPIProvider()
  if (apiProvider === 'vertex') {
    return DEFAULT_PREFIX
  }

  if (options?.isNonInteractive) {
    if (options.hasAppendSystemPrompt) {
      return AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX
    }
    return AGENT_SDK_PREFIX
  }
  return DEFAULT_PREFIX
}

/**
 * 检查归因 header 是否启用。
 * 默认启用，可通过环境变量或 GrowthBook killswitch 禁用。
 */
function isAttributionHeaderEnabled(): boolean {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_attribution_header', true)
}

/**
 * 获取 API 请求的归因 header。
 * 返回一个包含 cc_version（含指纹）和 cc_entrypoint 的 header 字符串。
 * 默认启用，可通过环境变量或 GrowthBook killswitch 禁用。
 *
 * 当启用 NATIVE_CLIENT_ATTESTATION 时，会包含一个 `cch=00000` 占位符。
 * 请求发送前，Bun 的原生 HTTP 栈会在请求体中找到该占位符，
 * 并用计算出的哈希值覆盖这些零。服务器校验该 token 以确认
 * 请求来自真实的 Claude Code 客户端。实现见
 * bun-anthropic/src/http/Attestation.zig。
 *
 * 我们使用占位符（而非从 Zig 注入）是因为等长度替换
 * 可以避免 Content-Length 变化和缓冲区重新分配。
 */
export function getAttributionHeader(fingerprint: string): string {
  if (!isAttributionHeaderEnabled()) {
    return ''
  }

  const version = `${MACRO.VERSION}.${fingerprint}`
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? 'unknown'

  // cch=00000 占位符会被 Bun 的 HTTP 栈覆写为 attestation token
  const cch = feature('NATIVE_CLIENT_ATTESTATION') ? ' cch=00000;' : ''
  // cc_workload：回合（turn）级提示，让 API 可以将例如 cron 发起的
  // 请求路由到较低的 QoS 池。缺省 = 交互式默认值。关于
  // 指纹（仅由消息字符 + 版本计算，见上方第 78 行）和
  // cch attestation（占位符在构造完此字符串后在序列化的 body 字节中被覆写）
  // 都是安全的。服务器的 _parse_cc_header 能容忍未知的额外
  // 字段，因此旧的 API 部署会静默忽略此项。
  const workload = getWorkload()
  const workloadPair = workload ? ` cc_workload=${workload};` : ''
  const header = `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=${entrypoint};${cch}${workloadPair}`

  logForDebugging(`attribution header ${header}`)
  return header
}
