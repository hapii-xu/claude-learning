import { feature } from 'bun:bundle'
import { chmod, mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  getOriginalCwd,
  getSessionId,
  onSessionSwitch,
} from '../bootstrap/state.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { errorMessage, isFsInaccessible } from './errors.js'
import { isProcessRunning } from './genericProcessUtils.js'
import { getPlatform } from './platform.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import { getAgentId } from './teammate.js'

export type SessionKind = 'interactive' | 'bg' | 'daemon' | 'daemon-worker'
export type SessionStatus = 'busy' | 'idle' | 'waiting'

function getSessionsDir(): string {
  return join(getClaudeConfigHomeDir(), 'sessions')
}

/**
 * 来自 env 的 kind 覆盖。由生成器（`claude --bg`、daemon supervisor）
 * 设置，以便子进程可以自行注册而无需父进程为其写入文件 ——
 * 退出时清理的接线因此自动生效。
 * 受 gate 保护，因此 env-var 字符串会从外部构建中被 DCE 移除。
 */
function envSessionKind(): SessionKind | undefined {
  if (feature('BG_SESSIONS')) {
    const k = process.env.CLAUDE_CODE_SESSION_KIND
    if (k === 'bg' || k === 'daemon' || k === 'daemon-worker') return k
  }
  return undefined
}

/**
 * 当此 REPL 运行在 `claude --bg` tmux 会话中时为 true。
 * 退出路径（/exit、ctrl+c、ctrl+d）应分离已附加的客户端
 * 而非杀死进程。
 */
export function isBgSession(): boolean {
  return envSessionKind() === 'bg'
}

/**
 * 为此会话写入 PID 文件并注册清理。
 *
 * 注册所有顶级会话 —— 交互式 CLI、SDK（vscode、desktop、
 * typescript、python、-p）、bg/daemon 生成 —— 以便 `claude ps`
 * 能看到用户可能在运行的所有内容。仅跳过 teammate/subagent，
 * 因为它们会混淆 swarm 使用与真正的并发，
 * 并用噪音污染 ps 输出。
 *
 * 若注册成功返回 true，若跳过返回 false。
 * 错误记录到 debug，永不抛出。
 */
export async function registerSession(): Promise<boolean> {
  if (getAgentId() != null) return false

  const kind: SessionKind = envSessionKind() ?? 'interactive'
  const dir = getSessionsDir()
  const pidFile = join(dir, `${process.pid}.json`)

  registerCleanup(async () => {
    try {
      await unlink(pidFile)
    } catch {
      // ENOENT 是正常的（已删除或从未写入）
    }
  })

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
    await writeFile(
      pidFile,
      jsonStringify({
        pid: process.pid,
        sessionId: getSessionId(),
        cwd: getOriginalCwd(),
        startedAt: Date.now(),
        kind,
        entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
        ...(feature('UDS_INBOX')
          ? { messagingSocketPath: process.env.CLAUDE_CODE_MESSAGING_SOCKET }
          : {}),
        ...(feature('BG_SESSIONS')
          ? {
              name: process.env.CLAUDE_CODE_SESSION_NAME,
              logPath: process.env.CLAUDE_CODE_SESSION_LOG,
              agent: process.env.CLAUDE_CODE_AGENT,
            }
          : {}),
      }),
    )
    // --resume / /resume 通过 switchSession 修改 getSessionId()。
    // 否则 PID 文件中的 sessionId 将过时，`claude ps` 的 sparkline
    // 会读取错误的会话记录。
    onSessionSwitch(id => {
      void updatePidFile({ sessionId: id })
    })
    return true
  } catch (e) {
    logForDebugging(`[concurrentSessions] register failed: ${errorMessage(e)}`)
    return false
  }
}

/**
 * 在此会话的 PID 注册文件中更新会话名称，
 * 以便 ListPeers 可以展示它。尽力而为：若 name 为假值、
 * 文件不存在（会话未注册）或读写失败则静默无操作。
 */
async function updatePidFile(patch: Record<string, unknown>): Promise<void> {
  const pidFile = join(getSessionsDir(), `${process.pid}.json`)
  try {
    const data = jsonParse(await readFile(pidFile, 'utf8')) as Record<
      string,
      unknown
    >
    await writeFile(pidFile, jsonStringify({ ...data, ...patch }))
  } catch (e) {
    logForDebugging(
      `[concurrentSessions] updatePidFile failed: ${errorMessage(e)}`,
    )
  }
}

export async function updateSessionName(
  name: string | undefined,
): Promise<void> {
  if (!name) return
  await updatePidFile({ name })
}

/**
 * 记录此会话的 Remote Control 会话 ID，以便对等枚举
 * 去重：一个可通过 UDS 和 bridge 同时访问的会话应只显示一次
 *（本地优先）。在 bridge 拆除时清除，以免过时的 ID 在重连后
 * 抑制合法的远程会话。
 */
export async function updateSessionBridgeId(
  bridgeSessionId: string | null,
): Promise<void> {
  await updatePidFile({ bridgeSessionId })
}

/**
 * 推送 `claude ps` 的实时活动状态。从 REPL 的状态变更
 * effect 中即发即忘 —— 写入丢失仅意味着 ps 在一次刷新中
 * 回退到会话记录尾部推导。
 */
export async function updateSessionActivity(patch: {
  status?: SessionStatus
  waitingFor?: string
}): Promise<void> {
  if (!feature('BG_SESSIONS')) return
  await updatePidFile({ ...patch, updatedAt: Date.now() })
}

/**
 * 统计存活的并发 CLI 会话数（包括当前会话）。
 * 过滤掉过时的 PID 文件（崩溃的会话）并删除它们。
 * 出错时返回 0（保守策略）。
 */
export async function countConcurrentSessions(): Promise<number> {
  const dir = getSessionsDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (e) {
    if (!isFsInaccessible(e)) {
      logForDebugging(`[concurrentSessions] readdir failed: ${errorMessage(e)}`)
    }
    return 0
  }

  let count = 0
  for (const file of files) {
    // 严格的文件名守卫：仅 `<pid>.json` 是候选项。parseInt 的
    // 宽松前缀解析意味着 `2026-03-14_notes.md` 会被解析为
    // PID 2026 并作为过时文件被清除 —— 导致静默的用户数据丢失。
    // 见 anthropics/claude-code#34210。
    if (!/^\d+\.json$/.test(file)) continue
    const pid = parseInt(file.slice(0, -5), 10)
    if (pid === process.pid) {
      count++
      continue
    }
    if (isProcessRunning(pid)) {
      count++
    } else if (getPlatform() !== 'wsl') {
      // 来自崩溃会话的过时文件 —— 清除它。在 WSL 上跳过：
      // 如果 ~/.hclaude/sessions/ 与 Windows 原生 Claude 共享
      //（通过符号链接或 CLAUDE_CONFIG_DIR），Windows PID 无法
      // 从 WSL 探测，我们会错误地删除存活会话的文件。
      // 这只是遥测，因此保守的欠计数是可接受的。
      void unlink(join(dir, file)).catch(() => {})
    }
  }
  return count
}
