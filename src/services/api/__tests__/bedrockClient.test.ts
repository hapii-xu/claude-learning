/**
 * Bedrock anthropic_beta body-vs-header 绕过方案的测试
 * （见 src/services/api/bedrockClient.ts 和 anthropics/claude-code#49238）。
 */
import { describe, expect, test } from 'bun:test'
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk'
import { BedrockClient } from '../bedrockClient.js'

type Captured = {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

function makeCaptureFetch(): {
  fetch: typeof fetch
  get(): Captured | null
} {
  let captured: Captured | null = null
  const capture = async (
    input: URL | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = new Request(input as RequestInfo, init)
    const body = await req.clone().text()
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v
    })
    captured = { url: req.url, method: req.method, headers, body }
    const streamBody =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"model":"x","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
    return new Response(streamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  // SDK 只调用 fetch 函数形式，从不调用 Bun/Node 的 `typeof fetch` 声明的静态 `preconnect`。
  // 类型断言是安全的（与 openai/client.ts 保持一致）。
  return { fetch: capture as unknown as typeof fetch, get: () => captured }
}

const BEDROCK_ARGS = {
  awsRegion: 'us-east-1',
  awsAccessKey: 'AKIAIOSFODNN7EXAMPLE',
  awsSecretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
}
const REQUEST_PARAMS = {
  model: 'anthropic.claude-opus-4-7',
  max_tokens: 10,
  messages: [{ role: 'user' as const, content: 'hi' }],
  betas: ['interleaved-thinking-2025-05-14', 'effort-2025-11-24'],
  stream: true as const,
}

async function dispatch(client: AnthropicBedrock): Promise<void> {
  try {
    const stream = await client.beta.messages.create(REQUEST_PARAMS)
    for await (const _ of stream) {
      /* drain */
    }
  } catch {
    /* ignore: only the captured request shape matters */
  }
}

describe('BedrockClient.buildRequest body.anthropic_beta cleanup', () => {
  test('BUG REPRO: unmodified AnthropicBedrock puts anthropic_beta in body', async () => {
    const { fetch: captureFetch, get } = makeCaptureFetch()
    const client = new AnthropicBedrock({
      ...BEDROCK_ARGS,
      fetch: captureFetch,
    })
    await dispatch(client)
    const c = get()
    expect(c).not.toBeNull()
    const body = JSON.parse(c!.body) as Record<string, unknown>
    expect('anthropic_beta' in body).toBe(true)
    expect(body.anthropic_beta).toEqual([
      'interleaved-thinking-2025-05-14',
      'effort-2025-11-24',
    ])
  })

  test('FIX: BedrockClient strips anthropic_beta from body', async () => {
    const { fetch: captureFetch, get } = makeCaptureFetch()
    const client = new BedrockClient({ ...BEDROCK_ARGS, fetch: captureFetch })
    await dispatch(client)
    const c = get()
    expect(c).not.toBeNull()
    const body = JSON.parse(c!.body) as Record<string, unknown>
    expect('anthropic_beta' in body).toBe(false)
  })

  test('FIX preserves anthropic-beta HTTP header with the original csv value', async () => {
    const { fetch: captureFetch, get } = makeCaptureFetch()
    const client = new BedrockClient({ ...BEDROCK_ARGS, fetch: captureFetch })
    await dispatch(client)
    const c = get()
    expect(c).not.toBeNull()
    expect(c!.headers['anthropic-beta']).toBe(
      'interleaved-thinking-2025-05-14,effort-2025-11-24',
    )
  })

  test('FIX keeps a valid AWS SigV4 authorization header (signing happens after cleanup)', async () => {
    const { fetch: captureFetch, get } = makeCaptureFetch()
    const client = new BedrockClient({ ...BEDROCK_ARGS, fetch: captureFetch })
    await dispatch(client)
    const c = get()
    expect(c).not.toBeNull()
    expect(c!.headers.authorization).toBeDefined()
    // SDK >= 0.80 使用 Bearer 认证；旧版本使用 AWS4-HMAC-SHA256 SigV4。
    // 无论哪种方式，header 都必须存在（即签名未被破坏）。
    expect(
      c!.headers.authorization!.startsWith('AWS4-HMAC-SHA256') ||
        c!.headers.authorization!.startsWith('Bearer '),
    ).toBe(true)
  })

  test('FIX does not disturb requests that never had anthropic_beta', async () => {
    const { fetch: captureFetch, get } = makeCaptureFetch()
    const client = new BedrockClient({ ...BEDROCK_ARGS, fetch: captureFetch })
    try {
      const stream = await client.beta.messages.create({
        model: 'anthropic.claude-opus-4-7',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })
      for await (const _ of stream) {
        /* drain */
      }
    } catch {
      /* ignore */
    }
    const c = get()
    expect(c).not.toBeNull()
    const body = JSON.parse(c!.body) as Record<string, unknown>
    expect('anthropic_beta' in body).toBe(false)
    expect(c!.headers['anthropic-beta']).toBeUndefined()
  })
})
