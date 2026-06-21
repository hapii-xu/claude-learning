import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk'

/**
 * 扩展 AnthropicBedrock 以绕过上游 SDK 的一个 bug：SDK 会把 `anthropic-beta`
 * HTTP header 的值重新塞进请求 body 作为 `anthropic_beta`。Bedrock 的 Opus 4.7
 * endpoint 会以 400 "invalid beta flag" 错误拒绝任何 body 中带 `anthropic_beta`
 * 的请求。
 *
 * Bug 来源（SDK 0.26.4，直到 0.28.1 仍然存在）：
 *   node_modules/@anthropic-ai/bedrock-sdk/client.js 第 122-127 行
 *   （TS 源码：packages/bedrock-sdk/src/client.ts 第 193-198 行）
 *
 * 相关上游 issue：anthropics/claude-code#49238（2026-04-16 创建）。
 *
 * 修复策略：先让 super.buildRequest 完成其工作，然后在 SDK 计算 AWS SigV4
 * 签名之前从返回的 Request 中剥除 `body.anthropic_beta`（签名发生在 buildRequest
 * 下游，因此签名会对清理过的 body 做哈希 —— 没有 403 风险）。`anthropic-beta`
 * HTTP header 保持原样（基础 SDK 已经根据 `betas:` 参数放到了 header 里），
 * 这样 beta flag 仍会按 Bedrock 接受的方式到达 API。
 *
 * 等上游发布修复后，确认 scripts/probe-bedrock-beta-fix.ts 的探测输出
 * "bug reproduced: false"，然后删除这个类并将 `services/api/client.ts` 改为
 * 直接实例化 `AnthropicBedrock`。
 */
type BuildRequestArg = Parameters<AnthropicBedrock['buildRequest']>[0]
type BuildRequestRet = Awaited<ReturnType<AnthropicBedrock['buildRequest']>>

export class BedrockClient extends AnthropicBedrock {
  async buildRequest(options: BuildRequestArg): Promise<BuildRequestRet> {
    const req = await super.buildRequest(options)

    const inner = (
      req as unknown as { req?: { body?: unknown; headers?: unknown } }
    )?.req
    if (!inner || typeof inner.body !== 'string' || inner.body.length === 0) {
      return req
    }

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(inner.body) as Record<string, unknown>
    } catch {
      return req
    }
    if (!('anthropic_beta' in parsed)) {
      return req
    }

    delete parsed.anthropic_beta
    const cleanedBody = JSON.stringify(parsed)
    inner.body = cleanedBody

    const byteLen = String(new TextEncoder().encode(cleanedBody).length)
    const h = inner.headers
    if (typeof Headers !== 'undefined' && h instanceof Headers) {
      if (h.has('content-length')) h.set('content-length', byteLen)
    } else if (h && typeof h === 'object') {
      const asDict = h as Record<string, string>
      if ('content-length' in asDict) asDict['content-length'] = byteLen
    }

    return req
  }
}
