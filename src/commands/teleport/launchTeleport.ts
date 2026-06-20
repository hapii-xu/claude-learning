import type { UUID } from 'node:crypto'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import type { LogOption } from '../../types/logs.js'
import { getLastSessionLog } from '../../utils/sessionStorage.js'
import {
  teleportResumeCodeSession,
  validateGitState,
} from '../../utils/teleport.js'
import { fetchCodeSessionsFromSessionsAPI } from '../../utils/teleport/api.js'

// 类似 UUID 的会话 ID 的最小长度（8 个十六进制字符，允许包含连字符）
const SESSION_ID_MIN_LENGTH = 8

// 在交互式选择器中最多显示的会话数量
const PICKER_PAGE_CAP = 20

function meta(
  s: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return s as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

export type TeleportProgressStep =
  | 'fetch'
  | 'validate'
  | 'resume'
  | 'ready'
  | 'error'

/**
 * 将会话列表格式化为文本选择器（headless 模式下没有交互式 UI）。
 * 返回一段提示，用户可从中复制所需的会话 ID。
 */
function formatSessionsPicker(
  sessions: Array<{
    id: string
    title: string
    status: string
    created_at: string
  }>,
): string {
  const rows = sessions.slice(0, PICKER_PAGE_CAP).map((s, i) => {
    const idx = String(i + 1).padStart(2)
    const title = s.title.slice(0, 50).padEnd(50)
    const status = s.status.padEnd(14)
    const created = s.created_at.slice(0, 10)
    return `  ${idx}. ${title}  ${status}  ${created}  id=${s.id}`
  })
  return [
    '## Available sessions (most recent first)',
    '',
    ...rows,
    '',
    'Run `/teleport <session-id>` to resume a session.',
  ].join('\n')
}

/**
 * /teleport [session-id]
 *
 * 不带 session-id：从 Sessions API 拉取用户的会话列表，
 * 并渲染交互式选择器（或在 headless 模式下输出文本列表）。
 *
 * 带 session-id：
 * 1. 验证本地 git 状态（必须为干净状态）
 * 2. 通过 teleportResumeCodeSession() 拉取会话日志和分支
 * 3. 按 ID 查找对应的会话 LogOption
 * 4. 通过 context.resume() 移交给 REPL
 *
 * 遥测覆盖范围：
 * - tengu_teleport_started
 * - tengu_teleport_events_fetch_fail
 * - tengu_teleport_page_cap
 * - tengu_teleport_source_decision
 * - tengu_teleport_resume_session
 * - tengu_teleport_first_message_success
 * - tengu_teleport_first_message_error
 * - tengu_teleport_failed
 * - tengu_teleport_cancelled
 * - tengu_teleport_null
 * - tengu_teleport_errors_detected
 * - tengu_teleport_errors_resolved
 * - tengu_teleport_error_session_not_found_
 * - tengu_teleport_error_repo_mismatch_sessions_api
 * - tengu_teleport_error_repo_not_in_git_dir_sessions_api
 * - tengu_teleport_error_bad_token
 * - tengu_teleport_error_bad_status
 */
export const callTeleport: LocalJSXCommandCall = async (
  onDone,
  context,
  args,
) => {
  const rawArgs = args.trim()
  // --print 标志：headless / 非交互式输出
  const isPrintMode = rawArgs === '--print' || rawArgs.startsWith('--print ')
  const sessionId = isPrintMode
    ? rawArgs.replace(/^--print\s*/, '').trim()
    : rawArgs

  logEvent('tengu_teleport_started', {
    has_session_id: meta(sessionId ? 'true' : 'false'),
  })

  // ── 无 session ID：交互式选择器 ──
  if (!sessionId) {
    logEvent('tengu_teleport_source_decision', {
      source: meta('sessions_api'),
    })

    let sessions: Array<{
      id: string
      title: string
      status: string
      created_at: string
    }>
    try {
      const raw = await fetchCodeSessionsFromSessionsAPI()
      sessions = raw.map(s => ({
        id: s.id,
        title: s.title ?? 'Untitled',
        status: (s.status ?? 'unknown') as string,
        created_at: s.created_at ?? '',
      }))
    } catch (fetchErr: unknown) {
      const msg =
        fetchErr instanceof Error ? fetchErr.message : String(fetchErr)

      if (/forbidden|401|403/i.test(msg)) {
        logEvent('tengu_teleport_events_fetch_forbidden', {
          error: meta(msg.slice(0, 200)),
        })
        onDone(
          'Teleport: permission denied fetching sessions. Check your OAuth token (`claude auth status`).',
          { display: 'system' },
        )
        return null
      }
      if (/not found|404/i.test(msg)) {
        logEvent('tengu_teleport_events_fetch_not_found', {
          error: meta(msg.slice(0, 200)),
        })
        onDone(
          'Teleport: sessions endpoint returned 404. The Sessions API may not be available for your account.',
          { display: 'system' },
        )
        return null
      }
      if (/token|unauthorized/i.test(msg)) {
        logEvent('tengu_teleport_error_bad_token', {
          error: meta(msg.slice(0, 200)),
        })
        onDone(
          `Teleport: authentication error — ${msg}. Try \`claude auth login\`.`,
          { display: 'system' },
        )
        return null
      }

      logEvent('tengu_teleport_events_fetch_fail', {
        error: meta(msg.slice(0, 200)),
      })
      onDone(
        `Teleport: failed to fetch sessions — ${msg}.\nUsage: /teleport SESSION_ID`,
        { display: 'system' },
      )
      return null
    }

    if (sessions.length === 0) {
      logEvent('tengu_teleport_null', {})
      onDone(
        'No active sessions found on claude.ai/code.\nStart a new session at https://claude.ai/code',
        { display: 'system' },
      )
      return null
    }

    if (sessions.length >= PICKER_PAGE_CAP) {
      logEvent('tengu_teleport_page_cap', {
        count: meta(String(sessions.length)),
      })
    }

    const pickerText = formatSessionsPicker(sessions)

    if (isPrintMode) {
      onDone(pickerText, { display: 'system' })
      return null
    }

    // 交互式上下文：显示列表，提示用户携带 ID 重新运行。
    // 完整的 Ink <SelectInput> 选择器需要事件循环，而并非所有命令上下文都能
    // 安全地提供；文本列表是可移植的兜底方案。
    onDone(pickerText, { display: 'system' })
    return null
  }

  // ── 基本格式校验 ──
  if (
    sessionId.length < SESSION_ID_MIN_LENGTH ||
    !/^[0-9a-f-]{8,}$/i.test(sessionId)
  ) {
    logEvent('tengu_teleport_error_bad_status', {
      error: meta(`invalid_session_id: ${sessionId.slice(0, 40)}`),
    })
    onDone(
      `Invalid session id "${sessionId}". Expected a UUID-like string (e.g. 12345678-abcd-...).`,
      { display: 'system' },
    )
    return null
  }

  logEvent('tengu_teleport_source_decision', { source: meta('explicit_id') })

  // ── 进度跟踪（仅内部使用，无需 Ink 渲染） ──
  const steps: TeleportProgressStep[] = []
  const recordStep = (step: TeleportProgressStep) => {
    steps.push(step)
  }

  // ── Git 状态校验 ──
  recordStep('validate')
  try {
    await validateGitState()
  } catch (gErr: unknown) {
    const msg = gErr instanceof Error ? gErr.message : String(gErr)
    logEvent('tengu_teleport_errors_detected', {
      error: meta(msg.slice(0, 200)),
    })
    onDone(`Cannot teleport: ${msg}`, { display: 'system' })
    return null
  }

  // ── 恢复会话 ──
  recordStep('resume')
  try {
    let lastProgress = ''

    await teleportResumeCodeSession(sessionId, stage => {
      lastProgress = String(stage)
    })

    logEvent('tengu_teleport_resume_session', {
      stage: meta(lastProgress),
    })

    recordStep('ready')

    if (!context.resume) {
      logEvent('tengu_teleport_null', {})
      // resume 回调不可用（例如非交互式上下文）
      if (isPrintMode) {
        onDone(`Session ${sessionId} fetched successfully.`, {
          display: 'system',
        })
        return null
      }
      onDone(
        `Teleport resume succeeded for ${sessionId}, but the REPL did not provide a resume callback.`,
        { display: 'system' },
      )
      return null
    }

    // 查找会话日志，以便传递给 context.resume()。
    recordStep('fetch')
    const log: LogOption | null = await getLastSessionLog(sessionId as UUID)
    if (!log) {
      logEvent('tengu_teleport_errors_detected', {
        error: meta('log_not_found_after_resume'),
      })
      onDone(
        `Teleport fetched session ${sessionId} but the local log was not found. Try /resume ${sessionId} manually.`,
        { display: 'system' },
      )
      return null
    }

    logEvent('tengu_teleport_errors_resolved', {})
    await context.resume(sessionId as UUID, log, 'slash_command_session_id')
    logEvent('tengu_teleport_first_message_success', {})
    return null
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)

    // 将错误消息内容映射到具体的遥测事件名
    let evt = 'tengu_teleport_failed'
    if (/not found/i.test(msg)) {
      evt = 'tengu_teleport_error_session_not_found_'
    } else if (/repo.*mismatch/i.test(msg)) {
      evt = 'tengu_teleport_error_repo_mismatch_sessions_api'
    } else if (/not in.*git|git.*dir/i.test(msg)) {
      evt = 'tengu_teleport_error_repo_not_in_git_dir_sessions_api'
    } else if (/cancelled|aborted/i.test(msg)) {
      evt = 'tengu_teleport_cancelled'
    } else if (/token|unauthorized|401/i.test(msg)) {
      evt = 'tengu_teleport_error_bad_token'
    } else if (/status|4\d\d|5\d\d/i.test(msg)) {
      evt = 'tengu_teleport_error_bad_status'
    }

    logEvent(evt, { error: meta(msg.slice(0, 200)) })
    logEvent('tengu_teleport_first_message_error', {
      error: meta(msg.slice(0, 200)),
    })
    onDone(`Teleport failed: ${msg}`, { display: 'system' })
    return null
  }
}
