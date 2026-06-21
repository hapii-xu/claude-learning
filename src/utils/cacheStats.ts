import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getClaudeConfigHomeDir } from './envUtils.js'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface CacheUsage {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

export interface CacheStatsState {
  version: 1
  signature: string | null
  lastResetAt: number | null // ms epoch; reset when signature changes
  lastHitRate: number | null // persisted fallback
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/**
 * 计算整数命中率（0–100），如果分母为零或输入为 null 则返回 null。
 */
export function computeHitRate(u: CacheUsage | null): number | null {
  if (!u) return null
  const denom =
    u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens
  if (denom === 0) return null
  return Math.round((u.cache_read_input_tokens / denom) * 100)
}

/**
 * 唯一标识使用快照的稳定字符串。
 * 签名的变化意味着新的 API 响应到达 —— 重置 TTL 时钟。
 */
export function tokenSignature(u: CacheUsage): string {
  return `${u.input_tokens}|${u.cache_creation_input_tokens}|${u.cache_read_input_tokens}`
}

// ---------------------------------------------------------------------------
// 状态文件 I/O
// ---------------------------------------------------------------------------

/**
 * 从 sessionId 派生的确定性短文件名，以便：
 *   - 不同会话永远不会冲突。
 *   - 原始会话 id 永远不会写入磁盘。
 */
export function getStateFilePath(sessionId: string): string {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 16)
  return join(getClaudeConfigHomeDir(), 'cache-stats', `${hash}.json`)
}

const INIT_STATE: CacheStatsState = {
  version: 1,
  signature: null,
  lastResetAt: null,
  lastHitRate: null,
}

function isValidState(obj: unknown): obj is CacheStatsState {
  if (typeof obj !== 'object' || obj === null) return false
  const s = obj as Record<string, unknown>
  return (
    s['version'] === 1 &&
    (s['signature'] === null || typeof s['signature'] === 'string') &&
    (s['lastResetAt'] === null || typeof s['lastResetAt'] === 'number') &&
    (s['lastHitRate'] === null || typeof s['lastHitRate'] === 'number')
  )
}

/**
 * 读取状态文件。任何错误（损坏、缺失等）时返回初始化默认值。
 */
export async function readState(filePath: string): Promise<CacheStatsState> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (isValidState(parsed)) return parsed
    return { ...INIT_STATE }
  } catch {
    return { ...INIT_STATE }
  }
}

/**
 * 原子写入状态：写入临时文件然后重命名 —— 可防止
 * 部分写入损坏和并发读取。
 */
export async function writeStateAtomic(
  filePath: string,
  state: CacheStatsState,
): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })
  const tmp = `${filePath}.${process.pid}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(state), 'utf8')
    await rename(tmp, filePath)
  } catch {
    // 尽最大努力；静默忽略错误以免 UI 崩溃
  }
}
