// Doubao（豆包）ASR 语音转文字适配器，用于语音模式。
//
// 封装 doubaoime-asr npm 包，对外暴露与
// voiceStreamSTT.ts 相同的接口。doubao 后端内部使用基于 AsyncGenerator 的
// 流式协议；此适配器将其桥接到
// useVoice.ts 使用的 send/finalize/close 模式。

import { homedir } from 'node:os'
import type { ASRResponse } from 'doubaoime-asr'
import type {
  FinalizeSource,
  VoiceStreamCallbacks,
  VoiceStreamConnection,
} from './voiceStreamSTT.js'
import { logForDebugging } from '../utils/debug.js'
import { logError } from '../utils/log.js'

// 重新导出 FinalizeSource，以便 useVoice 可以从任一模块导入
export type { FinalizeSource } from './voiceStreamSTT.js'

// ─── AsyncIterable 音频队列 ─────────────────────────────────────────

// 一个实现了 AsyncIterable<Uint8Array> 的推入式队列。
// send() 推入数据块；push(null) 表示流结束。
class AudioChunkQueue {
  private chunks: (Uint8Array | null)[] = []
  private waiting: ((result: IteratorResult<Uint8Array>) => void) | null = null
  private done = false

  push(chunk: Uint8Array | null): void {
    if (this.done) return
    if (chunk === null) {
      this.done = true
      if (this.waiting) {
        const resolve = this.waiting
        this.waiting = null
        resolve({ value: undefined, done: true })
      }
      return
    }
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: chunk, done: false })
    } else {
      this.chunks.push(chunk)
    }
  }

  abort(): void {
    this.done = true
    this.chunks.length = 0
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        if (this.chunks.length > 0) {
          const chunk = this.chunks.shift()!
          return { value: chunk, done: false }
        }
        if (this.done) {
          return { value: undefined, done: true }
        }
        return new Promise<IteratorResult<Uint8Array>>(resolve => {
          this.waiting = resolve
        })
      },
    }
  }
}

// ─── 可用性 ────────────────────────────────────────────────────────

let doubaoAvailable: boolean | null = null

export async function isDoubaoAvailable(): Promise<boolean> {
  if (doubaoAvailable !== null) return doubaoAvailable
  try {
    await import('doubaoime-asr')
    doubaoAvailable = true
  } catch {
    doubaoAvailable = false
  }
  return doubaoAvailable
}

// 同步检查 —— 返回缓存的结果，或当设置了
// VOICE_PROVIDER=doubao 且尚无缓存结果时乐观返回 true。
// 实际导入发生在 connectDoubaoStream 中，由其报告错误。
export function isDoubaoAvailableSync(): boolean {
  if (doubaoAvailable !== null) return doubaoAvailable
  return true
}

// ─── 连接 ──────────────────────────────────────────────────────────

export async function connectDoubaoStream(
  callbacks: VoiceStreamCallbacks,
  _options?: { language?: string },
): Promise<VoiceStreamConnection | null> {
  let doubaoAsr: typeof import('doubaoime-asr')
  try {
    doubaoAsr = await import('doubaoime-asr')
  } catch (err) {
    logError(
      new Error(
        `[doubao-asr] Failed to import doubaoime-asr package: ${String(err)}`,
      ),
    )
    callbacks.onError(`doubaoime-asr package import failed: ${String(err)}`, {
      fatal: true,
    })
    return null
  }

  const { transcribeRealtime, ASRConfig, ResponseType } = doubaoAsr

  const queue = new AudioChunkQueue()
  let finalized = false

  // 为 finalize() 的 promise 解析句柄 —— 包装在对象中以避免
  // TypeScript 闭包作用域类型收窄问题（TS2349 "not callable"）。
  const finalizeHandle: { resolve: ((source: FinalizeSource) => void) | null } =
    { resolve: null }

  const connection: VoiceStreamConnection = {
    send(audioChunk: Buffer): void {
      if (finalized) return
      queue.push(
        new Uint8Array(
          audioChunk.buffer,
          audioChunk.byteOffset,
          audioChunk.byteLength,
        ),
      )
    },
    finalize(): Promise<FinalizeSource> {
      if (finalized) return Promise.resolve<FinalizeSource>('ws_already_closed')
      finalized = true
      queue.push(null) // 向 generator 发出流结束信号
      // Doubao 在录制期间返回 FINAL_RESULT —— 当用户
      // 松开按键时，所有转录文本已在 accumulatedRef 中。
      // 立即 resolve，以便 UI 跳过 'processing' 状态并
      // 直接进入显示结果。
      logForDebugging('[doubao-asr] Finalize — resolving immediately')
      return Promise.resolve<FinalizeSource>('post_closestream_endpoint')
    },
    close(): void {
      finalized = true
      queue.abort()
      const r = finalizeHandle.resolve
      finalizeHandle.resolve = null
      if (r) r('ws_close')
      callbacks.onClose()
    },
    isConnected(): boolean {
      return true
    },
  }

  // 在后台启动 ASR 会话
  const config = new ASRConfig({
    credentialPath: `${homedir()}/.hclaude/tts/doubao/credentials.json`,
  })

  // 确保凭证已初始化（可能自动生成）
  try {
    await config.ensureCredentials()
  } catch (err) {
    logError(
      new Error(
        `[doubao-asr] Credential initialization failed: ${String(err)}`,
      ),
    )
    callbacks.onError(`Doubao ASR 凭证初始化失败: ${String(err)}`, {
      fatal: true,
    })
    return null
  }

  // 立即触发 onReady —— 与需要等待握手的 Anthropic WebSocket 不同，
  // doubao 后端通过队列接收音频并
  // 内部处理连接。调用方（useVoice.ts）需要 onReady 先触发
  // 才会通过 connection.send() 路由音频块。
  logForDebugging('[doubao-asr] Firing onReady immediately')
  callbacks.onReady(connection)

  // 在后台消费 AsyncGenerator
  void (async () => {
    try {
      const audioSource: AsyncIterable<Uint8Array> = queue
      const gen: AsyncGenerator<ASRResponse> = transcribeRealtime(audioSource, {
        config,
      })

      for await (const resp of gen) {
        if (
          finalized &&
          resp.type !== ResponseType.FINAL_RESULT &&
          resp.type !== ResponseType.SESSION_FINISHED
        ) {
          continue
        }

        switch (resp.type) {
          case ResponseType.SESSION_STARTED:
            logForDebugging('[doubao-asr] Session started')
            break
          case ResponseType.VAD_START:
            logForDebugging('[doubao-asr] VAD detected speech start')
            break
          case ResponseType.INTERIM_RESULT:
            if (resp.text) {
              callbacks.onTranscript(resp.text, false)
            }
            break
          case ResponseType.FINAL_RESULT:
            if (resp.text) {
              callbacks.onTranscript(resp.text, true)
            }
            break
          case ResponseType.ERROR:
            logError(new Error(`[doubao-asr] Error: ${resp.errorMsg}`))
            if (!finalized) {
              callbacks.onError(resp.errorMsg || 'Doubao ASR 识别错误')
            }
            break
          case ResponseType.SESSION_FINISHED:
            logForDebugging('[doubao-asr] Session finished')
            break
          default:
            break
        }
      }

      // Generator 自然耗尽
      const r = finalizeHandle.resolve
      finalizeHandle.resolve = null
      if (r) r('post_closestream_endpoint')
    } catch (err) {
      logError(new Error(`[doubao-asr] Stream error: ${String(err)}`))
      if (!finalized) {
        callbacks.onError(`Doubao ASR 连接错误: ${String(err)}`)
      }
      const r2 = finalizeHandle.resolve
      finalizeHandle.resolve = null
      if (r2) r2('ws_close')
    }
  })()

  return connection
}
