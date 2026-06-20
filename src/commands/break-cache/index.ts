import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import type { Command, LocalCommandResult } from '../../types/command.js'

/**
 * next-request-no-cache 标记文件的路径。
 * 当该文件存在时，主 API 调用路径应在 system prompt 中追加一段随机
 * 注释以破坏 prefix-cache 哈希，随后删除该文件。
 *
 * 约定：公开导出，以便其他模块（如 claude.ts）可以检查它。
 */
export function getBreakCacheMarkerPath(): string {
  return join(getClaudeConfigHomeDir(), '.next-request-no-cache')
}

/**
 * always-on break-cache 标志文件的路径。
 * 当该文件存在时，每次 API 请求都会获得一个 cache-busting nonce
 *（而不只是下一次请求）。
 */
export function getBreakCacheAlwaysPath(): string {
  return join(getClaudeConfigHomeDir(), '.break-cache-always')
}

/**
 * 记录每次 cache-break 事件的 append-only JSONL 日志路径。
 *
 * 替代旧的 read-modify-write 统计 JSON，以避免两个并发的
 * `/break-cache once` 调用相互竞争导致计数丢失。每次 break 追加一行；
 * `readStats()` 在读取时进行聚合。
 *
 * 使用 getClaudeConfigHomeDir()，以便 CLAUDE_CONFIG_DIR 环境变量在
 * 测试环境中覆盖路径。
 */
export function getBreakCacheStatsPath(): string {
  return join(getClaudeConfigHomeDir(), 'break-cache-events.jsonl')
}

interface BreakCacheStats {
  totalBreaks: number
  lastBreakAt: string | null
  alwaysModeEnabled: boolean
}

interface BreakCacheEvent {
  at: string
  kind: 'once' | 'always_on' | 'always_off'
}

/**
 * 通过聚合 append-only 事件日志来读取统计信息。
 * 由于仅追加，并发写入者不会丢失计数。
 */
function readStats(): BreakCacheStats {
  try {
    const raw = readFileSync(getBreakCacheStatsPath(), 'utf8')
    const events = raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line) as BreakCacheEvent
        } catch {
          return null
        }
      })
      .filter((e): e is BreakCacheEvent => e !== null)

    const onceBreaks = events.filter(e => e.kind === 'once')
    const lastEvent = events[events.length - 1]
    const alwaysEvents = events.filter(
      e => e.kind === 'always_on' || e.kind === 'always_off',
    )
    const lastAlways = alwaysEvents[alwaysEvents.length - 1]

    return {
      totalBreaks: onceBreaks.length,
      lastBreakAt: lastEvent?.at ?? null,
      alwaysModeEnabled: lastAlways?.kind === 'always_on',
    }
  } catch {
    return { totalBreaks: 0, lastBreakAt: null, alwaysModeEnabled: false }
  }
}

/**
 * 向统计日志追加一行事件。
 * 对于小规模写入，append 在操作系统层面是原子的，因此并发调用者
 * 不会相互覆盖计数。
 */
function appendBreakEvent(kind: BreakCacheEvent['kind']): void {
  const statsPath = getBreakCacheStatsPath()
  mkdirSync(getClaudeConfigHomeDir(), { recursive: true })
  const event: BreakCacheEvent = { at: new Date().toISOString(), kind }
  appendFileSync(statsPath, JSON.stringify(event) + '\n', 'utf8')
}

function incrementBreakCount(): void {
  appendBreakEvent('once')
}

const USAGE_TEXT = [
  'Usage: /break-cache [scope]',
  '',
  '  (no args)        Schedule a one-time cache break for the next API call',
  '  once             Same as no args',
  '  always           Enable persistent cache-break mode (every request)',
  '  off              Disable always mode and clear any pending marker',
  '  --clear          Clear the pending once marker (cancel before next call)',
  '  status           Show current break-cache status and stats',
  '',
  'How it works:',
  '  The Anthropic prompt cache keys on the system-prompt prefix hash.',
  '  A unique nonce invalidates the hash, forcing a fresh compute.',
  '  This is useful when you want to ensure a clean context window.',
].join('\n')

export async function callBreakCache(
  args: string,
): Promise<LocalCommandResult> {
  const scope = args.trim().toLowerCase()
  const markerPath = getBreakCacheMarkerPath()
  const alwaysPath = getBreakCacheAlwaysPath()

  // ── status ──
  if (scope === 'status') {
    const stats = readStats()
    const onceActive = existsSync(markerPath)
    const alwaysActive = existsSync(alwaysPath)
    return {
      type: 'text',
      value: [
        '## Break-Cache Status',
        '',
        `  Once marker:    ${onceActive ? 'ACTIVE (next call will bust cache)' : 'not set'}`,
        `  Always mode:    ${alwaysActive ? 'ON (every call busts cache)' : 'off'}`,
        '',
        '## Stats',
        `  total_breaks:   ${stats.totalBreaks}`,
        `  last_break_at:  ${stats.lastBreakAt ?? 'never'}`,
      ].join('\n'),
    }
  }

  // ── off ──
  if (scope === 'off') {
    let cleared = false
    if (existsSync(markerPath)) {
      unlinkSync(markerPath)
      cleared = true
    }
    if (existsSync(alwaysPath)) {
      unlinkSync(alwaysPath)
      cleared = true
    }
    appendBreakEvent('always_off')
    return {
      type: 'text',
      value: cleared
        ? 'Break-cache disabled. Removed once marker and/or always flag.'
        : 'Break-cache was not active.',
    }
  }

  // ── --clear ──
  if (scope === '--clear') {
    if (existsSync(markerPath)) {
      unlinkSync(markerPath)
      return {
        type: 'text',
        value: `Cache-break marker cleared.\n  \`${markerPath}\``,
      }
    }
    return {
      type: 'text',
      value: 'No cache-break marker was set.',
    }
  }

  // ── always ──
  if (scope === 'always') {
    writeFileSync(alwaysPath, new Date().toISOString(), 'utf8')
    appendBreakEvent('always_on')
    return {
      type: 'text',
      value: [
        '## Always-on cache break enabled',
        '',
        `Flag written: \`${alwaysPath}\``,
        '',
        'Every API call will now append a random nonce to the system prompt,',
        'permanently preventing prompt-cache hits for this session.',
        '',
        'To disable: `/break-cache off`',
      ].join('\n'),
    }
  }

  // ── once（legacy 默认值，或显式的 "once"）──
  if (scope === '' || scope === 'once') {
    const timestamp = new Date().toISOString()
    writeFileSync(markerPath, timestamp, 'utf8')
    incrementBreakCount()
    const stats = readStats()

    return {
      type: 'text',
      value: [
        '## Cache break scheduled',
        '',
        `Marker written: \`${markerPath}\``,
        `Timestamp: ${timestamp}`,
        '',
        'The next API call will append a random nonce to the system prompt,',
        'causing a cache miss. The marker is removed automatically after use.',
        '',
        'To cancel before the next call: `/break-cache --clear`',
        'For every call:               `/break-cache always`',
        '',
        `Total breaks this session: ${stats.totalBreaks}`,
        '',
        '_How it works: Anthropic prompt cache keys on the system-prompt prefix hash._',
        '_A unique nonce invalidates the hash, forcing a fresh compute._',
      ].join('\n'),
    }
  }

  // ── 未知 scope ──
  return {
    type: 'text',
    value: [`Unknown scope: "${scope}"`, '', USAGE_TEXT].join('\n'),
  }
}

const breakCache: Command = {
  type: 'local-jsx',
  name: 'break-cache',
  description:
    'Manage prompt-cache breaking. Open actions or run: once, status, always, off',
  isHidden: false,
  isEnabled: () => !getIsNonInteractiveSession(),
  argumentHint: '[once|status|always|off|--clear]',
  bridgeSafe: true,
  getBridgeInvocationError: args =>
    args.trim()
      ? undefined
      : 'Use /break-cache once/status/always/off over Remote Control.',
  load: () => import('./panel.js'),
}

export const breakCacheNonInteractive: Command = {
  type: 'local',
  name: 'break-cache',
  description:
    'Force the next (or all) API call(s) to miss prompt cache. Scopes: once, status, always, off',
  isHidden: false,
  isEnabled: () => getIsNonInteractiveSession(),
  supportsNonInteractive: true,
  bridgeSafe: true,
  load: async () => ({
    call: callBreakCache,
  }),
}

export default breakCache
