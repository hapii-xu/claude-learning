// 使用 Anthropic voice_stream STT 的 hold-to-talk 语音输入 React hook。
//
// 按住 keybinding 录音；松开停止并提交。Auto-repeat 键事件会重置
// 内部计时器 —— 当 RELEASE_TIMEOUT_MS 内没有按键事件到达时，
// 录音会自动停止。使用原生音频模块（macOS）或 SoX 进行录音，
// 并使用 Anthropic 的 voice_stream 端点（conversation_engine）做 STT。

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSetVoiceState } from '../context/voice.js'
import { useTerminalFocus } from '@anthropic/ink'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { getVoiceKeyterms } from '../services/voiceKeyterms.js'
import {
  connectVoiceStream,
  type FinalizeSource,
  isVoiceStreamAvailable,
  type VoiceStreamConnection,
} from '../services/voiceStreamSTT.js'
import {
  connectDoubaoStream,
  isDoubaoAvailableSync,
} from '../services/doubaoSTT.js'
import { logForDebugging } from '../utils/debug.js'
import { toError } from '../utils/errors.js'
import { getSystemLocaleLanguage } from '../utils/intl.js'
import { logError } from '../utils/log.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { sleep } from '../utils/sleep.js'

function isDoubaoProvider(): boolean {
  return getInitialSettings().voiceProvider === 'doubao'
}

// ─── 语言归一化 ─────────────────────────────────────────────

const DEFAULT_STT_LANGUAGE = 'en'

// 将语言名称（英语和母语）映射到 voice_stream Deepgram 后端
// 支持的 BCP-47 代码。键必须小写。
//
// 该列表必须是服务端 supported_language_codes 白名单
// （GrowthBook: speech_to_text_voice_stream_config）的子集。
// 若 CLI 发送了服务端拒绝的代码，WebSocket 会以
// 1008 "Unsupported language" 关闭，语音功能中断。不支持的语言
// 会回退到 DEFAULT_STT_LANGUAGE，使录音仍能工作。
const LANGUAGE_NAME_TO_CODE: Record<string, string> = {
  english: 'en',
  spanish: 'es',
  español: 'es',
  espanol: 'es',
  french: 'fr',
  français: 'fr',
  francais: 'fr',
  japanese: 'ja',
  日本語: 'ja',
  german: 'de',
  deutsch: 'de',
  portuguese: 'pt',
  português: 'pt',
  portugues: 'pt',
  italian: 'it',
  italiano: 'it',
  korean: 'ko',
  한국어: 'ko',
  hindi: 'hi',
  हिन्दी: 'hi',
  हिंदी: 'hi',
  indonesian: 'id',
  'bahasa indonesia': 'id',
  bahasa: 'id',
  russian: 'ru',
  русский: 'ru',
  polish: 'pl',
  polski: 'pl',
  turkish: 'tr',
  türkçe: 'tr',
  turkce: 'tr',
  dutch: 'nl',
  nederlands: 'nl',
  ukrainian: 'uk',
  українська: 'uk',
  greek: 'el',
  ελληνικά: 'el',
  czech: 'cs',
  čeština: 'cs',
  cestina: 'cs',
  danish: 'da',
  dansk: 'da',
  swedish: 'sv',
  svenska: 'sv',
  norwegian: 'no',
  norsk: 'no',
}

// GrowthBook speech_to_text_voice_stream_config 白名单的子集。
// 发送不在服务端白名单中的代码会关闭连接。
const SUPPORTED_LANGUAGE_CODES = new Set([
  'en',
  'es',
  'fr',
  'ja',
  'de',
  'pt',
  'it',
  'ko',
  'hi',
  'id',
  'ru',
  'pl',
  'tr',
  'nl',
  'uk',
  'el',
  'cs',
  'da',
  'sv',
  'no',
])

// 将语言偏好字符串（来自 settings.language）归一化为 voice_stream
// 端点支持的 BCP-47 代码。输入无法解析时返回默认语言。
// 当输入非空但不支持时，fellBackFrom 设为原始输入，以便调用方
// 可以提示警告。
export function normalizeLanguageForSTT(language: string | undefined): {
  code: string
  fellBackFrom?: string
} {
  if (!language) return { code: DEFAULT_STT_LANGUAGE }
  const lower = language.toLowerCase().trim()
  if (!lower) return { code: DEFAULT_STT_LANGUAGE }
  if (SUPPORTED_LANGUAGE_CODES.has(lower)) return { code: lower }
  const fromName = LANGUAGE_NAME_TO_CODE[lower]
  if (fromName) return { code: fromName }
  const base = lower.split('-')[0]
  if (base && SUPPORTED_LANGUAGE_CODES.has(base)) return { code: base }
  return { code: DEFAULT_STT_LANGUAGE, fellBackFrom: language }
}

// 懒加载的 voice 模块。我们将导入 voice.ts（及其原生 audio-capture-napi
// 依赖）推迟到 voice 输入真正激活时。在 macOS 上，加载原生音频模块
// 可能触发 TCC 麦克风权限提示 —— 我们必须避免在 voice 输入真正启用前
// 发生这种情况。
type VoiceModule = typeof import('../services/voice.js')
let voiceModule: VoiceModule | null = null

type VoiceState = 'idle' | 'recording' | 'processing'

type UseVoiceOptions = {
  onTranscript: (text: string) => void
  onError?: (message: string) => void
  enabled: boolean
  focusMode: boolean
}

type UseVoiceReturn = {
  state: VoiceState
  handleKeyEvent: (fallbackMs?: number) => void
}

// 表示按键释放的 auto-repeat 键事件之间的间隔（ms）。
// 终端 auto-repeat 通常每 30-80ms 触发一次；200ms 足以覆盖
// 抖动，同时仍然感觉灵敏。
const RELEASE_TIMEOUT_MS = 200

// 如果没有看到 auto-repeat，则用来武装 release 计时器的回退（ms）。
// macOS 默认按键重复延迟约为 500ms；600ms 提供了余量。
// 如果用户在 auto-repeat 开始前点击并松开，这保证
// release 计时器会被武装，录音停止。
//
// 对于修饰键组合的首次按键激活（handleKeyEvent 在
// t=0 调用，在任何 auto-repeat 之前），调用方应传入 FIRST_PRESS_FALLBACK_MS
// —— 到下一次按键的间隔是 OS 初始重复*延迟*
// （在 macOS 滑块为 "Long" 时可达 ~2s），而不是重复*速率*。
const REPEAT_FALLBACK_MS = 600
export const FIRST_PRESS_FALLBACK_MS = 2000

// 在没有任何语音的情况下保持 focus-mode 会话存活的时长（ms），
// 之后拆除以释放 WebSocket 连接。在下一个 focus 周期
// （blur → refocus）重新武装。
const FOCUS_SILENCE_TIMEOUT_MS = 5_000

// 录音波形可视化中显示的条数。
const AUDIO_LEVEL_BARS = 16

// 从 16-bit 有符号 PCM 缓冲区计算 RMS 振幅，返回
// 归一化的 0-1 值。sqrt 曲线将较安静的电平扩展到更多
// 视觉范围，使波形能利用全部的块高度。
export function computeLevel(chunk: Buffer): number {
  const samples = chunk.length >> 1 // 16-bit = 2 bytes per sample
  if (samples === 0) return 0
  let sumSq = 0
  for (let i = 0; i < chunk.length - 1; i += 2) {
    // 读取 16-bit 有符号小端
    const sample = ((chunk[i]! | (chunk[i + 1]! << 8)) << 16) >> 16
    sumSq += sample * sample
  }
  const rms = Math.sqrt(sumSq / samples)
  const normalized = Math.min(rms / 2000, 1)
  return Math.sqrt(normalized)
}

export function useVoice({
  onTranscript,
  onError,
  enabled,
  focusMode,
}: UseVoiceOptions): UseVoiceReturn {
  const [state, setState] = useState<VoiceState>('idle')
  const stateRef = useRef<VoiceState>('idle')
  const connectionRef = useRef<VoiceStreamConnection | null>(null)
  const accumulatedRef = useRef('')
  const onTranscriptRef = useRef(onTranscript)
  const onErrorRef = useRef(onError)
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 录音中看到第二次按键（auto-repeat）后为 true。
  // OS 按键重复延迟（macOS 上约 500ms）意味着第一次按键
  // 是单独的 —— 在 auto-repeat 开始前武装 release 计时器
  // 会导致错误的释放判定。
  const seenRepeatRef = useRef(false)
  const repeatFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  // 当前录音会话由终端 focus（而非按键）启动时为 true。
  // focus 驱动的会话在 blur 时结束，而非按键释放时。
  const focusTriggeredRef = useRef(false)
  // 在 focus mode 中长时间静默后拆除会话的计时器。
  const focusSilenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  // 当 focus-mode 会话因静默被拆除时设置。防止
  // focus effect 立即重启。在 blur 时清除，以便
  // 下一个 focus 周期重新武装录音。
  const silenceTimedOutRef = useRef(false)
  const recordingStartRef = useRef(0)
  // 每次 startRecordingSession() 时递增。回调捕获自己的
  // generation，如果有更新的会话已开始则退出 —— 防止一个
  // 慢连接的僵尸 WS（来自被放弃的会话）在下一次会话中途
  // 覆盖 connectionRef。
  const sessionGenRef = useRef(0)
  // 本次会话期间触发了 early-error 重试时为 true。
  // 用于 tengu_voice_recording_completed 分析事件。
  const retryUsedRef = useRef(false)
  // 本次会话捕获的完整音频，保留用于 silent-drop 重放。约 1% 的
  // 会话会遇到粘性损坏的 CE pod —— 接受音频但返回零
  // 转录（anthropics/anthropic#287008 session-sticky 变体）；当
  // finalize() 通过 no_data_timeout 解析且 hadAudioSignal=true 时，我们
  // 在新的 WS 上重放缓冲区一次。上限：32KB/s × ~60s 最大 ≈ 2MB。
  const fullAudioRef = useRef<Buffer[]>([])
  const silentDropRetriedRef = useRef(false)
  // 调度 early-error 重试时递增。在每次
  // attemptConnect 中捕获 —— onError 吞掉 stale-gen 事件（conn 1 的
  // 尾部 close-error），但呈现当前 gen 的事件（conn 2 的
  // 真实失败）。与 sessionGenRef 形状相同，下一层。
  const attemptGenRef = useRef(0)
  // focus mode 中已刷新字符的累计（每个 final 转录
  // 立即注入并重置 accumulatedRef）。在 completed 事件中
  // 加到 transcriptChars，使 focus-mode 会话不会
  // 误判为 silent-drop（即使转录成功，transcriptChars=0）。
  const focusFlushedCharsRef = useRef(0)
  // 收到至少一个具有非平凡信号的音频块时为 true。
  // 用于区分 "麦克风静默/不可访问" 与 "未检测到语音"。
  const hasAudioSignalRef = useRef(false)
  // 当前会话触发过 onReady 后为 true。与 connectionRef（会被
  // cleanup() 置空）不同，它在 effect 顺序竞态中存活，例如 Effect 3
  // 的 cleanup 在 Effect 2 的 finishRecording() 之前运行 —— 比如
  // focus mode 中 /voice 录音中途被切换关闭。用于 wsConnected 分析
  // 维度和错误消息分支。在 startRecordingSession 中重置。
  const everConnectedRef = useRef(false)
  const audioLevelsRef = useRef<number[]>([])
  const isFocused = useTerminalFocus()
  const setVoiceState = useSetVoiceState()

  // 保持回调 ref 最新，不触发重新渲染
  onTranscriptRef.current = onTranscript
  onErrorRef.current = onError

  function updateState(newState: VoiceState): void {
    stateRef.current = newState
    setState(newState)
    setVoiceState(prev => {
      if (prev.voiceState === newState) return prev
      return { ...prev, voiceState: newState }
    })
  }

  const cleanup = useCallback((): void => {
    // 让任何进行中的会话失效（主连接 isStale()、重放
    // isStale()、finishRecording 延续）。不这样处理的话，在
    // 重放窗口期间禁用 voice 会让陈旧的重放打开 WS，
    // 累积转录，并在 voice 被拆除后注入它。
    sessionGenRef.current++
    if (cleanupTimerRef.current) {
      clearTimeout(cleanupTimerRef.current)
      cleanupTimerRef.current = null
    }
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = null
    }
    if (repeatFallbackTimerRef.current) {
      clearTimeout(repeatFallbackTimerRef.current)
      repeatFallbackTimerRef.current = null
    }
    if (focusSilenceTimerRef.current) {
      clearTimeout(focusSilenceTimerRef.current)
      focusSilenceTimerRef.current = null
    }
    silenceTimedOutRef.current = false
    voiceModule?.stopRecording()
    if (connectionRef.current) {
      connectionRef.current.close()
      connectionRef.current = null
    }
    accumulatedRef.current = ''
    audioLevelsRef.current = []
    fullAudioRef.current = []
    setVoiceState(prev => {
      if (prev.voiceInterimTranscript === '' && !prev.voiceAudioLevels.length)
        return prev
      return { ...prev, voiceInterimTranscript: '', voiceAudioLevels: [] }
    })
  }, [setVoiceState])

  function finishRecording(): void {
    logForDebugging(
      '[voice] finishRecording: stopping recording, transitioning to processing',
    )
    // 会话结束 —— 让任何进行中的尝试失效，这样它的迟到 onError
    // （用户释放按键后 conn 2 才响应）不会在下方的
    // "check network" 消息之上再次触发。
    attemptGenRef.current++
    // 在清除 focusTriggered 之前捕获它 —— 作为事件维度
    // 需要，以便 BigQuery 可以过滤掉被动 focus-mode 自动录音（用户聚焦
    // 终端但未说话 → 环境噪声使 hadAudioSignal=true → 错误的
    // silent-drop 签名）。focusFlushedCharsRef 修复了带语音会话的
    // transcriptChars 准确性；focusTriggered 支持过滤不带语音的会话。
    const focusTriggered = focusTriggeredRef.current
    focusTriggeredRef.current = false
    updateState('processing')
    voiceModule?.stopRecording()
    // 在 finalize 往返之前捕获时长，这样 WebSocket
    // 等待时间不会被包含（否则快速点击看起来像 > 2s）。
    // 所有 ref 支持的值在此处捕获，在 async 边界之前 ——
    // finalize 等待期间的按键可能启动新会话并重置
    // 这些 ref（例如 startRecordingSession 中 focusFlushedCharsRef = 0），
    // 重现该 ref 旨在防止的 silent-drop 误报。
    const recordingDurationMs = Date.now() - recordingStartRef.current
    const hadAudioSignal = hasAudioSignalRef.current
    const retried = retryUsedRef.current
    const focusFlushedChars = focusFlushedCharsRef.current
    // wsConnected 区分 "后端接收了音频但丢弃了"（bug 后端
    // PR #287008 修复的）与 "WS 握手从未完成" ——
    // 后一种情况下音频仍在 audioBuffer 中，从未到达
    // 服务端，但 hasAudioSignalRef 因环境噪声已经为 true。
    const wsConnected = everConnectedRef.current
    // 在 .then() 之前捕获 generation —— 如果在 finalize 等待期间有新会话启动，
    // sessionGenRef 在 continuation 运行时已经前进，所以在 .then() 内捕获会得到新会话的
    // gen，每个 staleness 检查都会变成 no-op。
    const myGen = sessionGenRef.current
    const isStale = () => sessionGenRef.current !== myGen
    logForDebugging('[voice] Recording stopped')

    // 发送 finalize 并等待 WebSocket 关闭，然后再读取
    // 累积的转录。close 处理程序会将任何未上报的
    // interim 文本提升为 final，所以我们必须等它触发。
    const finalizePromise: Promise<FinalizeSource | undefined> =
      connectionRef.current
        ? connectionRef.current.finalize()
        : Promise.resolve(undefined)

    void finalizePromise
      .then(async finalizeSource => {
        if (isStale()) return
        // Silent-drop 重放：当服务端接受了音频（wsConnected）、
        // 麦克风捕获了真实信号（hadAudioSignal），但 finalize
        // 超时且零转录 —— 约 1% 的 session-sticky CE-pod bug。
        // 在新连接上重放缓冲音频一次。250ms
        // 退避清除 same-pod 快速重连竞态（与下方的
        // early-error 重试路径相同间隔）。
        if (
          finalizeSource === 'no_data_timeout' &&
          hadAudioSignal &&
          wsConnected &&
          !focusTriggered &&
          focusFlushedChars === 0 &&
          accumulatedRef.current.trim() === '' &&
          !silentDropRetriedRef.current &&
          fullAudioRef.current.length > 0
        ) {
          silentDropRetriedRef.current = true
          logForDebugging(
            `[voice] Silent-drop detected (no_data_timeout, ${String(fullAudioRef.current.length)} chunks); replaying on fresh connection`,
          )
          logEvent('tengu_voice_silent_drop_replay', {
            recordingDurationMs,
            chunkCount: fullAudioRef.current.length,
          })
          if (connectionRef.current) {
            connectionRef.current.close()
            connectionRef.current = null
          }
          const replayBuffer = fullAudioRef.current
          await sleep(250)
          if (isStale()) return
          const stt = normalizeLanguageForSTT(getInitialSettings().language)
          const keyterms = await getVoiceKeyterms()
          if (isStale()) return
          await new Promise<void>(resolve => {
            void connectVoiceStream(
              {
                onTranscript: (t, isFinal) => {
                  if (isStale()) return
                  if (isFinal && t.trim()) {
                    if (accumulatedRef.current) accumulatedRef.current += ' '
                    accumulatedRef.current += t.trim()
                  }
                },
                onError: () => resolve(),
                onClose: () => {},
                onReady: conn => {
                  if (isStale()) {
                    conn.close()
                    resolve()
                    return
                  }
                  connectionRef.current = conn
                  const SLICE = 32_000
                  let slice: Buffer[] = []
                  let bytes = 0
                  for (const c of replayBuffer) {
                    if (bytes > 0 && bytes + c.length > SLICE) {
                      conn.send(Buffer.concat(slice))
                      slice = []
                      bytes = 0
                    }
                    slice.push(c)
                    bytes += c.length
                  }
                  if (slice.length) conn.send(Buffer.concat(slice))
                  void conn.finalize().then(() => {
                    conn.close()
                    resolve()
                  })
                },
              },
              { language: stt.code, keyterms },
            ).then(
              c => {
                if (!c) resolve()
              },
              () => resolve(),
            )
          })
          if (isStale()) return
        }
        fullAudioRef.current = []

        const text = accumulatedRef.current.trim()
        logForDebugging(
          `[voice] Final transcript assembled (${String(text.length)} chars): "${text.slice(0, 200)}"`,
        )

        // 追踪 silent-drop 比率：transcriptChars=0 + hadAudioSignal=true
        // + recordingDurationMs>2000 = bug 后端 PR #287008 修复的问题。
        // focusFlushedCharsRef 使 focus mode 的 transcriptChars 准确
        // （每个 final 立即注入并重置 accumulatedRef）。
        //
        // 注意：此事件仅在 finishRecording() 路径触发。onError
        // 回退和 !conn（无 OAuth）路径绕过此逻辑 → 不要计算
        // COUNT(completed)/COUNT(started) 作为成功率；silent-drop
        // 分母（仅 completed 事件）内部一致。
        logEvent('tengu_voice_recording_completed', {
          transcriptChars: text.length + focusFlushedChars,
          recordingDurationMs,
          hadAudioSignal,
          retried,
          silentDropRetried: silentDropRetriedRef.current,
          wsConnected,
          focusTriggered,
        })

        if (connectionRef.current) {
          connectionRef.current.close()
          connectionRef.current = null
        }

        if (text) {
          logForDebugging(
            `[voice] Injecting transcript (${String(text.length)} chars)`,
          )
          onTranscriptRef.current(text)
        } else if (focusFlushedChars === 0 && recordingDurationMs > 2000) {
          // 仅在 focus mode 也没有刷新任何内容、且录音 > 2s 时
          // 才警告空转录（短录音 = 误触 →
          // 静默返回 idle）。
          if (!wsConnected) {
            // WS 从未连接 → 音频从未到达后端。不是 silent
            // drop；是连接失败（OAuth 刷新慢、网络等）。
            onErrorRef.current?.(
              'Voice connection failed. Check your network and try again.',
            )
          } else if (!hadAudioSignal) {
            // 区分静默麦克风（采集问题）与语音未被识别。
            onErrorRef.current?.(
              'No audio detected from microphone. Check that the correct input device is selected and that Claude Code has microphone access.',
            )
          } else {
            onErrorRef.current?.('No speech detected.')
          }
        }

        accumulatedRef.current = ''
        setVoiceState(prev => {
          if (prev.voiceInterimTranscript === '') return prev
          return { ...prev, voiceInterimTranscript: '' }
        })
        updateState('idle')
      })
      .catch(err => {
        logError(toError(err))
        if (!isStale()) updateState('idle')
      })
  }

  // 当启用 voice 时，懒加载导入 voice.ts，使 checkRecordingAvailability
  // 等函数在用户按下 voice 键时已就绪。不要预加载
  // 原生模块 —— require('audio-capture.node') 是对
  // CoreAudio/AudioUnit 的同步 dlopen，会阻塞事件循环 ~1s（warm）到 ~8s
  // （cold coreaudiod）。setImmediate 无济于事：它让出一个 tick，然后
  // dlopen 仍然阻塞。第一次按下 voice 键时承担 dlopen 开销。
  useEffect(() => {
    if (enabled && !voiceModule) {
      void import('../services/voice.js').then(mod => {
        voiceModule = mod
      })
    }
  }, [enabled])

  // ── Focus 静默计时器 ────────────────────────────────────────────
  // 武装（或重置）一个计时器，在 FOCUS_SILENCE_TIMEOUT_MS
  // 无语音后拆除 focus-mode 会话。在会话启动时和每次刷新转录后调用。
  function armFocusSilenceTimer(): void {
    if (focusSilenceTimerRef.current) {
      clearTimeout(focusSilenceTimerRef.current)
    }
    focusSilenceTimerRef.current = setTimeout(
      (
        focusSilenceTimerRef,
        stateRef,
        focusTriggeredRef,
        silenceTimedOutRef,
        finishRecording,
      ) => {
        focusSilenceTimerRef.current = null
        if (stateRef.current === 'recording' && focusTriggeredRef.current) {
          logForDebugging(
            '[voice] Focus silence timeout — tearing down session',
          )
          silenceTimedOutRef.current = true
          finishRecording()
        }
      },
      FOCUS_SILENCE_TIMEOUT_MS,
      focusSilenceTimerRef,
      stateRef,
      focusTriggeredRef,
      silenceTimedOutRef,
      finishRecording,
    )
  }

  // ── Focus 驱动的录音 ──────────────────────────────────────────
  // 在 focus mode 中，当终端获得 focus 时开始录音，
  // 失去 focus 时停止。这支持 "multi-clauding army"
  // 工作流，语音输入跟随窗口 focus。
  useEffect(() => {
    if (!enabled || !focusMode || isDoubaoProvider()) {
      // focus 驱动的录音正在进行时禁用了 focus mode ——
      // 停止录音，使其不会一直拖延到静默计时器触发。
      if (focusTriggeredRef.current && stateRef.current === 'recording') {
        logForDebugging(
          '[voice] Focus mode disabled during recording, finishing',
        )
        finishRecording()
      }
      return
    }
    let cancelled = false
    if (
      isFocused &&
      stateRef.current === 'idle' &&
      !silenceTimedOutRef.current
    ) {
      const beginFocusRecording = (): void => {
        // 重新检查条件 —— 在 await 期间 state 或 enabled/focusMode 可能已变化
        // （effect cleanup 设置了 cancelled）。
        if (
          cancelled ||
          stateRef.current !== 'idle' ||
          silenceTimedOutRef.current
        )
          return
        logForDebugging('[voice] Focus gained, starting recording session')
        focusTriggeredRef.current = true
        void startRecordingSession()
        armFocusSilenceTimer()
      }
      if (voiceModule) {
        beginFocusRecording()
      } else {
        // voice 模块正在加载（async import 从缓存作为
        // microtask 解析）。在启动录音会话之前等待它。
        void import('../services/voice.js').then(mod => {
          voiceModule = mod
          beginFocusRecording()
        })
      }
    } else if (!isFocused) {
      // 在 blur 时清除静默超时标志，使下一个 focus
      // 周期重新武装录音。
      silenceTimedOutRef.current = false
      if (stateRef.current === 'recording') {
        logForDebugging('[voice] Focus lost, finishing recording')
        finishRecording()
      }
    }
    return () => {
      cancelled = true
    }
  }, [enabled, focusMode, isFocused])

  // ── 启动新的录音会话（voice_stream connect + audio） ──
  async function startRecordingSession(): Promise<void> {
    if (!voiceModule) {
      onErrorRef.current?.(
        'Voice module not loaded yet. Try again in a moment.',
      )
      return
    }

    // 同步转换为 'recording'，在任何 await 之前。调用方
    // 在 `void startRecordingSession()` 之后立即同步读取 state：
    // - useVoiceIntegration.tsx 空格保持守卫立即从 store 读取 voiceState ——
    //   如果看到 'idle' 就清除 isSpaceHoldActiveRef，
    //   空格 auto-repeat 会泄漏到文本输入（100% 复现）
    // - 下方 handleKeyEvent 的 `currentState === 'idle'` 重入检查
    // 如果先运行 await，两者都看到陈旧的 'idle'。见 PR #20873 评审。
    updateState('recording')
    recordingStartRef.current = Date.now()
    accumulatedRef.current = ''
    seenRepeatRef.current = false
    hasAudioSignalRef.current = false
    retryUsedRef.current = false
    silentDropRetriedRef.current = false
    fullAudioRef.current = []
    focusFlushedCharsRef.current = 0
    everConnectedRef.current = false
    const myGen = ++sessionGenRef.current

    // ── 预检查：我们真的能录音吗？ ──────────────
    const availability = await voiceModule.checkRecordingAvailability()
    if (!availability.available) {
      logForDebugging(
        `[voice] Recording not available: ${availability.reason ?? 'unknown'}`,
      )
      onErrorRef.current?.(
        availability.reason ?? 'Audio recording is not available.',
      )
      cleanup()
      updateState('idle')
      return
    }

    logForDebugging(
      '[voice] Starting recording session, connecting voice stream',
    )
    // 清除任何之前的错误
    setVoiceState(prev => {
      if (!prev.voiceError) return prev
      return { ...prev, voiceError: null }
    })

    // 在 WebSocket 连接期间缓冲音频块。一旦连接
    // 就绪（onReady 触发），缓冲的块会被刷新，后续
    // 块直接发送。
    const audioBuffer: Buffer[] = []

    // 立即开始录音 —— 音频在 WebSocket
    // 打开前被缓冲，消除了等待 OAuth + WS 连接的 1-2s 延迟。
    logForDebugging(
      '[voice] startRecording: buffering audio while WebSocket connects',
    )
    audioLevelsRef.current = []
    const started = await voiceModule.startRecording(
      (chunk: Buffer) => {
        // 为 fullAudioRef 重放缓冲区复制一份。voiceStreamSTT 中的 send()
        // 会防御性地再复制一次 —— 在音频速率下可接受。
        // 在 focus mode 中跳过缓冲 —— 重放以 !focusTriggered 门控，
        // 所以缓冲区是死重量（10 分钟会话可达 ~20MB）。
        const owned = Buffer.from(chunk)
        if (!focusTriggeredRef.current) {
          fullAudioRef.current.push(owned)
        }
        if (connectionRef.current) {
          connectionRef.current.send(owned)
        } else {
          audioBuffer.push(owned)
        }
        // 更新录音可视化器的音频电平直方图
        const level = computeLevel(chunk)
        if (!hasAudioSignalRef.current && level > 0.01) {
          hasAudioSignalRef.current = true
        }
        const levels = audioLevelsRef.current
        if (levels.length >= AUDIO_LEVEL_BARS) {
          levels.shift()
        }
        levels.push(level)
        // 复制数组以便 React 看到新引用
        const snapshot = [...levels]
        audioLevelsRef.current = snapshot
        setVoiceState(prev => ({ ...prev, voiceAudioLevels: snapshot }))
      },
      () => {
        // 外部结束（例如设备错误）—— 作为停止处理
        if (stateRef.current === 'recording') {
          finishRecording()
        }
      },
      { silenceDetection: false },
    )

    if (!started) {
      logError(new Error('[voice] Recording failed — no audio tool found'))
      onErrorRef.current?.(
        'Failed to start audio capture. Check that your microphone is accessible.',
      )
      cleanup()
      updateState('idle')
      setVoiceState(prev => ({
        ...prev,
        voiceError: 'Recording failed — no audio tool found',
      }))
      return
    }

    const rawLanguage = getInitialSettings().language
    const stt = normalizeLanguageForSTT(rawLanguage)
    logEvent('tengu_voice_recording_started', {
      focusTriggered: focusTriggeredRef.current,
      sttLanguage:
        stt.code as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      sttLanguageIsDefault: !rawLanguage?.trim(),
      sttLanguageFellBack: stt.fellBackFrom !== undefined,
      // 来自 Intl 的 ISO 639 子标签（有界集合，永不是用户文本）。Intl 失败时为 undefined ——
      // 从 payload 中省略，无重试成本（已缓存）。
      systemLocaleLanguage:
        getSystemLocaleLanguage() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    // 如果连接在交付任何转录前出错，则重试一次。
    // conversation-engine 代理可以拒绝快速重连（~1/N_pods
    // same-pod 冲突），或 CE 的 Deepgram 上游可能在自己的
    // teardown 窗口期间失败（anthropics/anthropic#287008 将其作为
    // TranscriptError 而非 silent-drop 呈现）。250ms 退避可清除两者。
    // 重试窗口期间捕获的音频路由到 audioBuffer（通过
    // 上方录音回调中的 connectionRef.current null 检查），并由
    // 第二次 onReady 刷新。
    let sawTranscript = false

    // 与音频录音并行连接 WebSocket。
    // 先收集 keyterms（异步但很快 —— 无模型调用），然后连接。
    // 如果有更新的会话已启动，则从回调中退出。防止
    // 慢连接的僵尸 WS（例如用户释放、再按下、第一个
    // WS 仍在握手）向新会话触发 onReady/onError，
    // 破坏其 connectionRef / 触发虚假重试。
    const isStale = () => sessionGenRef.current !== myGen

    const attemptConnect = (keyterms: string[]): void => {
      const myAttemptGen = attemptGenRef.current
      // 基于 settings.voiceProvider 选择 STT 后端
      const connectFn = isDoubaoProvider()
        ? (
            cbs: Parameters<typeof connectDoubaoStream>[0],
            opts: Parameters<typeof connectDoubaoStream>[1],
          ) => connectDoubaoStream(cbs, opts)
        : (
            cbs: Parameters<typeof connectVoiceStream>[0],
            opts: Parameters<typeof connectVoiceStream>[1],
          ) => connectVoiceStream(cbs, opts)
      void connectFn(
        {
          onTranscript: (text: string, isFinal: boolean) => {
            if (isStale()) return
            sawTranscript = true
            logForDebugging(
              `[voice] onTranscript: isFinal=${String(isFinal)} text="${text}"`,
            )
            if (isFinal && text.trim()) {
              if (focusTriggeredRef.current) {
                // focus mode：立即刷新每个 final 转录并
                // 继续录音。这在终端 focused 时提供连续转录。
                logForDebugging(
                  `[voice] Focus mode: flushing final transcript immediately: "${text.trim()}"`,
                )
                onTranscriptRef.current(text.trim())
                focusFlushedCharsRef.current += text.trim().length
                setVoiceState(prev => {
                  if (prev.voiceInterimTranscript === '') return prev
                  return { ...prev, voiceInterimTranscript: '' }
                })
                accumulatedRef.current = ''
                // 用户正在说话 —— 重置静默计时器。
                armFocusSilenceTimer()
              } else {
                // hold-to-talk：累积以空格分隔的 final 转录
                if (accumulatedRef.current) {
                  accumulatedRef.current += ' '
                }
                accumulatedRef.current += text.trim()
                logForDebugging(
                  `[voice] Accumulated final transcript: "${accumulatedRef.current}"`,
                )
                // 清除 interim，因为 final 取代它
                setVoiceState(prev => {
                  const preview = accumulatedRef.current
                  if (prev.voiceInterimTranscript === preview) return prev
                  return { ...prev, voiceInterimTranscript: preview }
                })
              }
            } else if (!isFinal) {
              // 活跃的 interim 语音重置 focus 静默计时器。
              // Nova 3 禁用 auto-finalize，所以 isFinal 在流中
              // 永不为 true —— 不这样处理的话，5s 计时器会在
              // 活跃语音期间触发并拆除会话。
              if (focusTriggeredRef.current) {
                armFocusSilenceTimer()
              }
              // 将累积的 finals + 当前 interim 显示为实时预览
              const interim = text.trim()
              const preview = accumulatedRef.current
                ? accumulatedRef.current + (interim ? ' ' + interim : '')
                : interim
              setVoiceState(prev => {
                if (prev.voiceInterimTranscript === preview) return prev
                return { ...prev, voiceInterimTranscript: preview }
              })
            }
          },
          onError: (error: string, opts?: { fatal?: boolean }) => {
            if (isStale()) {
              logForDebugging(
                `[voice] ignoring onError from stale session: ${error}`,
              )
              return
            }
            // 吞掉被取代尝试的错误。涵盖 conn 1 在
            // 重试调度后的尾部 close，以及当前 conn 在
            // 其 ws error 已在下方呈现后的 ws close 事件
            // （呈现时 gen 已递增）。
            if (attemptGenRef.current !== myAttemptGen) {
              logForDebugging(
                `[voice] ignoring stale onError from superseded attempt: ${error}`,
              )
              return
            }
            // 早期失败重试：任何转录前的服务端错误 =
            // 可能是瞬态上游竞态（CE 拒绝、Deepgram
            // 未就绪）。清除 connectionRef 让音频重新缓冲、
            // 退避、重连。如果用户已释放按键
            // （state 留在 'recording'）则跳过 —— 重试他们已结束的会话没有意义。
            // 致命错误（Cloudflare bot 挑战、auth
            // 拒绝）在每次重试时都是相同的失败，所以
            // 穿透下去呈现消息。
            if (
              !opts?.fatal &&
              !sawTranscript &&
              stateRef.current === 'recording'
            ) {
              if (!retryUsedRef.current) {
                retryUsedRef.current = true
                logForDebugging(
                  `[voice] early voice_stream error (pre-transcript), retrying once: ${error}`,
                )
                logEvent('tengu_voice_stream_early_retry', {})
                connectionRef.current = null
                attemptGenRef.current++
                setTimeout(
                  (stateRef, attemptConnect, keyterms) => {
                    if (stateRef.current === 'recording') {
                      attemptConnect(keyterms)
                    }
                  },
                  250,
                  stateRef,
                  attemptConnect,
                  keyterms,
                )
                return
              }
            }
            // 呈现中 —— 递增 gen，使此 conn 的尾部 close-error
            // （ws 先触发 error 再触发 close 1006）被上方吞掉。
            attemptGenRef.current++
            logError(new Error(`[voice] voice_stream error: ${error}`))
            onErrorRef.current?.(`Voice stream error: ${error}`)
            // 出错时清除音频缓冲区以避免内存泄漏
            audioBuffer.length = 0
            focusTriggeredRef.current = false
            cleanup()
            updateState('idle')
          },
          onClose: () => {
            // no-op；生命周期由 cleanup() 处理
          },
          onReady: conn => {
            // 仅当我们仍在录音状态且这仍是
            // 当前会话时才继续。来自被放弃会话的
            // 慢连接僵尸 WS 如果用户之后启动了新会话，
            // 仍能通过 'recording' 检查。
            if (isStale() || stateRef.current !== 'recording') {
              conn.close()
              return
            }

            // WebSocket 现在真正打开 —— 赋值 connectionRef，使
            // 后续音频回调直接发送而非缓冲。
            connectionRef.current = conn
            everConnectedRef.current = true

            // 刷新 WebSocket 连接期间缓冲的所有音频块。
            // 这是安全的，因为 onReady 从
            // WebSocket 'open' 事件触发，保证 send() 不会被丢弃。
            //
            // 合并为 ~1s 的切片，而非每个 chunk 一次 ws.send
            // —— 更少的 WS 帧意味着两端开销更低。
            const SLICE_TARGET_BYTES = 32_000 // ~1s at 16kHz/16-bit/mono
            if (audioBuffer.length > 0) {
              let totalBytes = 0
              for (const c of audioBuffer) totalBytes += c.length
              const slices: Buffer[][] = [[]]
              let sliceBytes = 0
              for (const chunk of audioBuffer) {
                if (
                  sliceBytes > 0 &&
                  sliceBytes + chunk.length > SLICE_TARGET_BYTES
                ) {
                  slices.push([])
                  sliceBytes = 0
                }
                slices[slices.length - 1]!.push(chunk)
                sliceBytes += chunk.length
              }
              logForDebugging(
                `[voice] onReady: flushing ${String(audioBuffer.length)} buffered chunks (${String(totalBytes)} bytes) as ${String(slices.length)} coalesced frame(s)`,
              )
              for (const slice of slices) {
                conn.send(Buffer.concat(slice))
              }
            }
            audioBuffer.length = 0

            // WebSocket 就绪后重置 release 计时器。
            // 仅在已看到 auto-repeat 时才武装 —— 否则 OS
            // 按键重复延迟（~500ms）尚未流逝，计时器
            // 会过早触发。
            if (releaseTimerRef.current) {
              clearTimeout(releaseTimerRef.current)
            }
            if (seenRepeatRef.current) {
              releaseTimerRef.current = setTimeout(
                (releaseTimerRef, stateRef, finishRecording) => {
                  releaseTimerRef.current = null
                  if (stateRef.current === 'recording') {
                    finishRecording()
                  }
                },
                RELEASE_TIMEOUT_MS,
                releaseTimerRef,
                stateRef,
                finishRecording,
              )
            }
          },
        },
        {
          language: stt.code,
          keyterms,
        },
      ).then(conn => {
        if (isStale()) {
          conn?.close()
          return
        }
        if (!conn) {
          logForDebugging(
            '[voice] Failed to connect to voice_stream (no OAuth token?)',
          )
          onErrorRef.current?.(
            'Voice mode requires a Claude.ai account. Please run /login to sign in.',
          )
          // 失败时清除音频缓冲区
          audioBuffer.length = 0
          cleanup()
          updateState('idle')
          return
        }

        // 安全检查：如果用户在 connectVoiceStream 解析前
        // （但 onReady 已经运行后）释放了按键，关闭连接。
        if (stateRef.current !== 'recording') {
          audioBuffer.length = 0
          conn.close()
          return
        }
      })
    }

    // Doubao 后端不使用 keyterms —— 跳过 async 获取
    if (isDoubaoProvider()) {
      attemptConnect([])
    } else {
      void getVoiceKeyterms().then(attemptConnect)
    }
  }

  // ── Hold-to-talk 处理程序 ────────────────────────────────────────────
  // 每次按键时调用（包括按住键期间的终端 auto-repeat）。
  // 事件之间间隔超过 RELEASE_TIMEOUT_MS 被解释为按键释放。
  //
  // 第一次按键时立即开始录音以消除
  // 启动延迟。release 计时器仅在检测到 auto-repeat 后
  // 才武装（以避免在 macOS 上 ~500ms 的 OS 按键重复
  // 延迟期间发生错误释放）。
  const handleKeyEvent = useCallback(
    (fallbackMs = REPEAT_FALLBACK_MS): void => {
      const sttAvailable = isDoubaoProvider()
        ? isDoubaoAvailableSync()
        : isVoiceStreamAvailable()
      if (!enabled || !sttAvailable) {
        return
      }

      // 在 focus mode 中，录音由终端 focus 驱动，而非按键。
      if (focusTriggeredRef.current) {
        // 活跃的 focus 录音 —— 忽略按键事件（会话在 blur 时结束）。
        return
      }
      if (focusMode && silenceTimedOutRef.current) {
        // focus 会话因静默超时 —— 按键重新武装它。
        logForDebugging(
          '[voice] Re-arming focus recording after silence timeout',
        )
        silenceTimedOutRef.current = false
        focusTriggeredRef.current = true
        void startRecordingSession()
        armFocusSilenceTimer()
        return
      }

      const currentState = stateRef.current

      // 处理中时忽略按键
      if (currentState === 'processing') {
        return
      }

      if (currentState === 'idle') {
        logForDebugging(
          '[voice] handleKeyEvent: idle, starting recording session immediately',
        )
        void startRecordingSession()
        // 回退：如果 REPEAT_FALLBACK_MS 内没有 auto-repeat，
        // 仍然武装 release 计时器（用户可能点击并松开了）。
        repeatFallbackTimerRef.current = setTimeout(
          (
            repeatFallbackTimerRef,
            stateRef,
            seenRepeatRef,
            releaseTimerRef,
            finishRecording,
          ) => {
            repeatFallbackTimerRef.current = null
            if (stateRef.current === 'recording' && !seenRepeatRef.current) {
              logForDebugging(
                '[voice] No auto-repeat seen, arming release timer via fallback',
              )
              seenRepeatRef.current = true
              releaseTimerRef.current = setTimeout(
                (releaseTimerRef, stateRef, finishRecording) => {
                  releaseTimerRef.current = null
                  if (stateRef.current === 'recording') {
                    finishRecording()
                  }
                },
                RELEASE_TIMEOUT_MS,
                releaseTimerRef,
                stateRef,
                finishRecording,
              )
            }
          },
          fallbackMs,
          repeatFallbackTimerRef,
          stateRef,
          seenRepeatRef,
          releaseTimerRef,
          finishRecording,
        )
      } else if (currentState === 'recording') {
        // 录音中的第二次+ 按键 —— auto-repeat 已开始。
        seenRepeatRef.current = true
        if (repeatFallbackTimerRef.current) {
          clearTimeout(repeatFallbackTimerRef.current)
          repeatFallbackTimerRef.current = null
        }
      }

      // 每次按键（包括 auto-repeat）时重置 release 计时器
      if (releaseTimerRef.current) {
        clearTimeout(releaseTimerRef.current)
      }

      // 仅在已看到 auto-repeat 后才武装 release 计时器。
      // macOS 上 OS 按键重复延迟约 500ms；没有这个门控，
      // 200ms 计时器会在 repeat 开始前触发，导致错误释放。
      if (stateRef.current === 'recording' && seenRepeatRef.current) {
        releaseTimerRef.current = setTimeout(
          (releaseTimerRef, stateRef, finishRecording) => {
            releaseTimerRef.current = null
            if (stateRef.current === 'recording') {
              finishRecording()
            }
          },
          RELEASE_TIMEOUT_MS,
          releaseTimerRef,
          stateRef,
          finishRecording,
        )
      }
    },
    [enabled, focusMode, cleanup],
  )

  // 仅在禁用或卸载时清理 - 不在 state 变化时清理
  useEffect(() => {
    if (!enabled && stateRef.current !== 'idle') {
      cleanup()
      updateState('idle')
    }
    return () => {
      cleanup()
    }
  }, [enabled, cleanup])

  return {
    state,
    handleKeyEvent,
  }
}
