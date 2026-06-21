// 语音服务：用于按键通话语音输入的音频录制。
//
// 在 macOS、Linux 和 Windows 上使用原生音频捕获（cpal）
// 进行进程内麦克风访问。如果原生模块不可用，
// 在 Linux 上回退到 SoX `rec` 或 arecord（ALSA）。

import { type ChildProcess, spawn, spawnSync } from 'child_process'
import { readFile } from 'fs/promises'
import { logForDebugging } from '../utils/debug.js'
import { isEnvTruthy, isRunningOnHomespace } from '../utils/envUtils.js'
import { logError } from '../utils/log.js'
import { getPlatform } from '../utils/platform.js'

// 延迟加载的原生音频模块。audio-capture.node 链接
// CoreAudio.framework + AudioUnit.framework；dlopen 是同步的，
// 热启动时阻塞事件循环约 1 秒，冷 coreaudiod 时
// （唤醒后、启动后）最多约 8 秒。加载发生在首次语音按键时 —— 无
// 预加载，因为无法让 dlopen 变为非阻塞，启动冻结比首次按键延迟更糟糕。
type AudioNapi = typeof import('audio-capture-napi')
let audioNapi: AudioNapi | null = null
let audioNapiPromise: Promise<AudioNapi> | null = null

function loadAudioNapi(): Promise<AudioNapi> {
  audioNapiPromise ??= (async () => {
    const t0 = Date.now()
    const mod = await import('audio-capture-napi')
    // vendor/audio-capture-src/index.ts 将 require(...node) 延迟到
    // 首次函数调用 —— 在此触发以便计时反映真实成本。
    mod.isNativeAudioAvailable()
    audioNapi = mod
    logForDebugging(`[voice] audio-capture-napi loaded in ${Date.now() - t0}ms`)
    return mod
  })()
  return audioNapiPromise
}

// ─── 常量 ───────────────────────────────────────────────────────

const RECORDING_SAMPLE_RATE = 16000
const RECORDING_CHANNELS = 1

// SoX 静音检测：在此静音持续时间后停止
const SILENCE_DURATION_SECS = '2.0'
const SILENCE_THRESHOLD = '3%'

// ─── 依赖检查 ────────────────────────────────────────────────────

function hasCommand(cmd: string): boolean {
  // 直接 spawn 目标而不是使用 `which cmd`。在 Termux/Android 上
  // `which` 是 shell 内建命令 —— 从 Node spawn 时外部二进制
  // 不存在或被内核阻止（EPERM）。仅在非 Windows 上到达此代码
  // （win32 从所有调用方提前返回），没有 PATHEXT 问题。
  // result.error 仅在 spawn 本身失败时设置（ENOENT/EACCES）；退出
  // 代码无关紧要 —— 无法识别的 --version 仍意味着 cmd 存在。
  const result = spawnSync(cmd, ['--version'], {
    stdio: 'ignore',
    timeout: 3000,
  })
  return result.error === undefined
}

// 探测 arecord 是否能实际打开捕获设备。hasCommand()
// 仅检查 PATH；在 WSL1/Win10-WSL2/无头 Linux 上，二进制文件存在
// 但在 open() 时失败，因为没有 ALSA 卡片且没有 PulseAudio
// 服务器。在 WSL2+WSLg（Win11）上，PulseAudio 通过 RDP 管道工作，arecord
// 成功。我们使用与 startArecordRecording() 相同的参数 spawn，并竞争
// 一个短计时器：如果进程在 150ms 后仍存活，它已打开
// 设备；如果提前退出，stderr 告诉我们原因。已记忆化 —— 音频
// 设备可用性在会话中不会改变，且每次语音按键时通过
// checkRecordingAvailability() 调用。
type ArecordProbeResult = { ok: boolean; stderr: string }
let arecordProbe: Promise<ArecordProbeResult> | null = null

function probeArecord(): Promise<ArecordProbeResult> {
  arecordProbe ??= new Promise(resolve => {
    const child = spawn(
      'arecord',
      [
        '-f',
        'S16_LE',
        '-r',
        String(RECORDING_SAMPLE_RATE),
        '-c',
        String(RECORDING_CHANNELS),
        '-t',
        'raw',
        '/dev/null',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const timer = setTimeout(
      (c: ChildProcess, r: (v: ArecordProbeResult) => void) => {
        c.kill('SIGTERM')
        r({ ok: true, stderr: '' })
      },
      150,
      child,
      resolve,
    )
    child.once('close', code => {
      clearTimeout(timer)
      // 计时器触发后的 SIGTERM 关闭（code=null）已经 resolve。
      // 代码为 0 的提前关闭是异常的（arecord 不应自行退出），
      // 但视为正常。
      void resolve({ ok: code === 0, stderr: stderr.trim() })
    })
    child.once('error', () => {
      clearTimeout(timer)
      void resolve({ ok: false, stderr: 'arecord: command not found' })
    })
  })
  return arecordProbe
}

export function _resetArecordProbeForTesting(): void {
  arecordProbe = null
}

// cpal 的 ALSA 后端在找不到任何声卡时写入我们的进程 stderr
// （它在进程内运行 —— 没有子进程管道可以捕获）。下面的
// spawn 回退正确管道 stderr，因此当 ALSA 无设备可打开时跳过原生。
// 已记忆化：卡片存在性在会话中不会改变。
let linuxAlsaCardsMemo: Promise<boolean> | null = null

function linuxHasAlsaCards(): Promise<boolean> {
  linuxAlsaCardsMemo ??= readFile('/proc/asound/cards', 'utf8').then(
    cards => {
      const c = cards.trim()
      return c !== '' && !c.includes('no soundcards')
    },
    () => false,
  )
  return linuxAlsaCardsMemo
}

export function _resetAlsaCardsForTesting(): void {
  linuxAlsaCardsMemo = null
}

type PackageManagerInfo = {
  cmd: string
  args: string[]
  displayCommand: string
}

function detectPackageManager(): PackageManagerInfo | null {
  if (process.platform === 'darwin') {
    if (hasCommand('brew')) {
      return {
        cmd: 'brew',
        args: ['install', 'sox'],
        displayCommand: 'brew install sox',
      }
    }
    return null
  }

  if (process.platform === 'linux') {
    if (hasCommand('apt-get')) {
      return {
        cmd: 'sudo',
        args: ['apt-get', 'install', '-y', 'sox'],
        displayCommand: 'sudo apt-get install sox',
      }
    }
    if (hasCommand('dnf')) {
      return {
        cmd: 'sudo',
        args: ['dnf', 'install', '-y', 'sox'],
        displayCommand: 'sudo dnf install sox',
      }
    }
    if (hasCommand('pacman')) {
      return {
        cmd: 'sudo',
        args: ['pacman', '-S', '--noconfirm', 'sox'],
        displayCommand: 'sudo pacman -S sox',
      }
    }
  }

  return null
}

export async function checkVoiceDependencies(): Promise<{
  available: boolean
  missing: string[]
  installCommand: string | null
}> {
  // 原生音频模块（cpal）在 macOS、Linux 和 Windows 上处理一切
  const napi = await loadAudioNapi()
  if (napi.isNativeAudioAvailable()) {
    return { available: true, missing: [], installCommand: null }
  }

  // Windows 没有支持的回退方案 —— 需要原生模块
  if (process.platform === 'win32') {
    return {
      available: false,
      missing: ['Voice mode requires the native audio module (not loaded)'],
      installCommand: null,
    }
  }

  // 在 Linux 上，arecord（ALSA utils）是有效的回退录制后端
  if (process.platform === 'linux' && hasCommand('arecord')) {
    return { available: true, missing: [], installCommand: null }
  }

  const missing: string[] = []

  if (!hasCommand('rec')) {
    missing.push('sox (rec command)')
  }

  const pm = missing.length > 0 ? detectPackageManager() : null
  return {
    available: missing.length === 0,
    missing,
    installCommand: pm?.displayCommand ?? null,
  }
}

// ─── 录制可用性 ──────────────────────────────────────────────────

export type RecordingAvailability = {
  available: boolean
  reason: string | null
}

// 通过完整的回退链（原生 → arecord → SoX）进行探测录制，
// 以验证至少有一个后端可以录制。在 macOS 上，这也会
// 在首次使用时触发 TCC 权限对话框。我们信任探测
// 结果而非 TCC 状态 API，后者对于临时签名或跨架构
// 二进制文件（例如 x64-on-arm64）可能不可靠。
export async function requestMicrophonePermission(): Promise<boolean> {
  const napi = await loadAudioNapi()
  if (!napi.isNativeAudioAvailable()) {
    return true // 非原生平台跳过此检查
  }

  const started = await startRecording(
    _chunk => {}, // 丢弃音频数据 —— 这仅是权限探测
    () => {}, // 忽略静音检测结束信号
    { silenceDetection: false },
  )
  if (started) {
    stopRecording()
    return true
  }
  return false
}

export async function checkRecordingAvailability(): Promise<RecordingAvailability> {
  // 远程环境没有本地麦克风
  if (isRunningOnHomespace() || isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
    return {
      available: false,
      reason:
        'Voice mode requires microphone access, but no audio device is available in this environment.\n\nTo use voice mode, run Claude Code locally instead.',
    }
  }

  // 原生音频模块（cpal）在 macOS、Linux 和 Windows 上处理一切
  const napi = await loadAudioNapi()
  if (napi.isNativeAudioAvailable()) {
    return { available: true, reason: null }
  }

  // Windows 没有支持的回退方案
  if (process.platform === 'win32') {
    return {
      available: false,
      reason:
        'Voice recording requires the native audio module, which could not be loaded.',
    }
  }

  const wslNoAudioReason =
    'Voice mode could not access an audio device in WSL.\n\nWSL2 with WSLg (Windows 11) provides audio via PulseAudio — if you are on Windows 10 or WSL1, run Claude Code in native Windows instead.'

  // 在 Linux（包括 WSL）上，探测 arecord。hasCommand() 不足：
  // 二进制文件可能存在但设备 open() 失败（WSL1、Win10-WSL2、
  // 无头 Linux）。WSL2+WSLg（Win11 默认）通过 PulseAudio RDP
  // 管道工作 —— cpal 失败（无 /proc/asound/cards）但 arecord 成功。
  if (process.platform === 'linux' && hasCommand('arecord')) {
    const probe = await probeArecord()
    if (probe.ok) {
      return { available: true, reason: null }
    }
    if (getPlatform() === 'wsl') {
      return { available: false, reason: wslNoAudioReason }
    }
    logForDebugging(`[voice] arecord probe failed: ${probe.stderr}`)
    // 回退到 SoX
  }

  // 回退：检查 SoX
  if (!hasCommand('rec')) {
    // 没有 arecord 且没有 SoX 的 WSL：下面通用的"安装 SoX"
    // 提示在 WSL1/Win10 上具有误导性（根本无音频设备），
    // 但在 WSL2+WSLg 上是正确的（SoX 通过 PulseAudio 工作）。由于无法
    // 在没有后端可探测的情况下区分 WSLg 与否，显示 WSLg
    // 指导 —— 它将 WSL1 用户引导至原生 Windows，同时告诉 WSLg
    // 用户他们的设置应该可以工作（他们可以安装 sox 或 alsa-utils）。
    // 已知缺口：有 SoX 但没有 arecord 的 WSL 跳过此分支和
    // 上面的探测 —— hasCommand('rec') 同样会撒谎。我们乐观地
    // 信任它（WSLg+SoX 会工作）而不是对几乎为零的
    // 人群（WSL1 × 最小发行版 × 有 SoX 但无 alsa-utils）使用 probeSox()。
    if (getPlatform() === 'wsl') {
      return { available: false, reason: wslNoAudioReason }
    }
    const pm = detectPackageManager()
    return {
      available: false,
      reason: pm
        ? `Voice mode requires SoX for audio recording. Install it with: ${pm.displayCommand}`
        : 'Voice mode requires SoX for audio recording. Install SoX manually:\n  macOS: brew install sox\n  Ubuntu/Debian: sudo apt-get install sox\n  Fedora: sudo dnf install sox',
    }
  }

  return { available: true, reason: null }
}

// ─── 录制（macOS/Linux/Windows 上的原生音频，Linux 上的 SoX/arecord 回退）─────────────

let activeRecorder: ChildProcess | null = null
let nativeRecordingActive = false

export async function startRecording(
  onData: (chunk: Buffer) => void,
  onEnd: () => void,
  options?: { silenceDetection?: boolean },
): Promise<boolean> {
  logForDebugging(`[voice] startRecording called, platform=${process.platform}`)

  // 首先尝试原生音频模块（macOS、Linux、Windows 通过 cpal）
  const napi = await loadAudioNapi()
  const nativeAvailable =
    napi.isNativeAudioAvailable() &&
    (process.platform !== 'linux' || (await linuxHasAlsaCards()))
  const useSilenceDetection = options?.silenceDetection !== false
  if (nativeAvailable) {
    // 确保之前的录制已完全停止
    if (nativeRecordingActive || napi.isNativeRecordingActive()) {
      napi.stopNativeRecording()
      nativeRecordingActive = false
    }
    const started = napi.startNativeRecording(
      (data: Buffer) => {
        onData(data)
      },
      () => {
        if (useSilenceDetection) {
          nativeRecordingActive = false
          onEnd()
        }
        // 在按键通话模式下，忽略原生模块的静音触发
        // onEnd。录制持续到调用方显式调用
        // stopRecording()（例如用户按下 Ctrl+X）。
      },
    )
    if (started) {
      nativeRecordingActive = true
      return true
    }
    // 原生录制失败 —— 回退到平台回退方案
  }

  // Windows 没有支持的回退方案
  if (process.platform === 'win32') {
    logForDebugging('[voice] Windows native recording unavailable, no fallback')
    return false
  }

  // 在 Linux 上，在 SoX 之前尝试 arecord（ALSA utils）。参考探测结果以便
  // 后端选择与 checkRecordingAvailability() 匹配 —— 否则
  // 在同时有 alsa-utils 和 SoX 的无头 Linux 上，可用性
  // 检查会回退到 SoX（probe.ok=false，非 WSL），但此路径
  // 仍会选择损坏的 arecord。探测已记忆化；零延迟。
  if (
    process.platform === 'linux' &&
    hasCommand('arecord') &&
    (await probeArecord()).ok
  ) {
    return startArecordRecording(onData, onEnd)
  }

  // 回退：SoX rec（Linux，或原生模块不可用时的 macOS）
  return startSoxRecording(onData, onEnd, options)
}

function startSoxRecording(
  onData: (chunk: Buffer) => void,
  onEnd: () => void,
  options?: { silenceDetection?: boolean },
): boolean {
  const useSilenceDetection = options?.silenceDetection !== false

  // 录制原始 PCM：16 kHz、16 位有符号、单声道，输出到 stdout。
  // --buffer 1024 强制 SoX 以小块刷新音频，而不是
  // 在内部缓冲区中积累数据。没有这个，SoX 可能
  // 在管道传输时缓冲数秒音频后才向 stdout 写入，
  // 导致进程退出前数据流为零。
  const args = [
    '-q', // 静默
    '--buffer',
    '1024',
    '-t',
    'raw',
    '-r',
    String(RECORDING_SAMPLE_RATE),
    '-e',
    'signed',
    '-b',
    '16',
    '-c',
    String(RECORDING_CHANNELS),
    '-', // stdout
  ]

  // 添加静音检测过滤器（静音时自动停止）。
  // 对于用户手动控制开始/停止的按键通话省略此项。
  if (useSilenceDetection) {
    args.push(
      'silence', // 静音时开始/停止
      '1',
      '0.1',
      SILENCE_THRESHOLD,
      '1',
      SILENCE_DURATION_SECS,
      SILENCE_THRESHOLD,
    )
  }

  const child = spawn('rec', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  activeRecorder = child

  child.stdout?.on('data', (chunk: Buffer) => {
    onData(chunk)
  })

  // 消费 stderr 以防止背压
  child.stderr?.on('data', () => {})

  child.on('close', () => {
    activeRecorder = null
    onEnd()
  })

  child.on('error', err => {
    logError(err)
    activeRecorder = null
    onEnd()
  })

  return true
}

function startArecordRecording(
  onData: (chunk: Buffer) => void,
  onEnd: () => void,
): boolean {
  // 录制原始 PCM：16 kHz、16 位有符号小端序、单声道，输出到 stdout。
  // arecord 不支持内置静音检测，因此此后端
  // 最适合按键通话（silenceDetection: false）。
  const args = [
    '-f',
    'S16_LE', // 有符号 16 位小端序
    '-r',
    String(RECORDING_SAMPLE_RATE),
    '-c',
    String(RECORDING_CHANNELS),
    '-t',
    'raw', // 原始 PCM，无 WAV 头
    '-q', // 静默 —— 无进度输出
    '-', // 写入 stdout
  ]

  const child = spawn('arecord', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  activeRecorder = child

  child.stdout?.on('data', (chunk: Buffer) => {
    onData(chunk)
  })

  // 消费 stderr 以防止背压
  child.stderr?.on('data', () => {})

  child.on('close', () => {
    activeRecorder = null
    onEnd()
  })

  child.on('error', err => {
    logError(err)
    activeRecorder = null
    onEnd()
  })

  return true
}

export function stopRecording(): void {
  if (nativeRecordingActive && audioNapi) {
    audioNapi.stopNativeRecording()
    nativeRecordingActive = false
    return
  }
  if (activeRecorder) {
    activeRecorder.kill('SIGTERM')
    activeRecorder = null
  }
}
