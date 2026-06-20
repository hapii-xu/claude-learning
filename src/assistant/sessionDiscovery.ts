import { logForDebugging } from '../utils/debug.js'

/**
 * assistant 发现所需的最小会话类型。
 * 只有 `id` 会被 main.tsx（L4757）使用；其他字段用于选择器展示。
 * ID 格式为 `session_*`（兼容前缀）— viewer 端点使用 /v1/sessions/*。
 */
export type AssistantSession = {
  id: string
  title: string
  status: string
  created_at: string
}

/**
 * 发现 Anthropic CCR 上的 assistant 会话。
 *
 * 复用现有的 fetchCodeSessionsFromSessionsAPI()，该函数会带上
 * 正确的 OAuth + anthropic-beta headers 调用 GET /v1/sessions。
 *
 * 失败时抛出异常 — main.tsx L4720-4725 会捕获并展示错误。
 * 出错时绝不返回 []（否则会静默跳转到安装向导）。
 */
export async function discoverAssistantSessions(): Promise<AssistantSession[]> {
  const { fetchCodeSessionsFromSessionsAPI } = await import(
    '../utils/teleport/api.js'
  )

  let allSessions
  try {
    allSessions = await fetchCodeSessionsFromSessionsAPI()
  } catch (err) {
    logForDebugging(
      `[assistant:discovery] fetchCodeSessionsFromSessionsAPI failed: ${err}`,
    )
    throw err
  }

  // 仅保留 active/working 状态的会话 — completed/archived 不可挂载
  return allSessions
    .filter(
      s =>
        s.status === 'idle' || s.status === 'working' || s.status === 'waiting',
    )
    .map(s => ({
      id: s.id,
      title: s.title || 'Untitled',
      status: s.status,
      created_at: s.created_at ?? '',
    }))
}
