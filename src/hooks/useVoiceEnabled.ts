import { useMemo } from 'react'
import { useAppState } from '../state/AppState.js'
import {
  hasVoiceAuth,
  isVoiceGrowthBookEnabled,
} from '../voice/voiceModeEnabled.js'

/**
 * 将用户意图（settings.voiceEnabled）与 auth + GB kill-switch 组合。
 * 使用 Doubao 后端时，跳过 auth 检查（Doubao 有自己的凭证）。
 * 仅 auth 部分在 authVersion 上 memoize —— 它是昂贵的
 * （冷 getClaudeAIOAuthTokens memoize → 同步 `security` spawn，~60ms/次，
 * token 刷新在会话中清除缓存时总计 ~180ms）。
 * GB 是廉价的缓存 map 查询，保留在 memo 外，使会话中
 * kill-switch 翻转仍在下次渲染生效。
 */
export function useVoiceEnabled(): boolean {
  const userIntent = useAppState(s => s.settings.voiceEnabled === true)
  const provider = useAppState(s => s.settings.voiceProvider)
  // 所有 hook 必须无条件调用（Rules of Hooks）
  const authVersion = useAppState(s => s.authVersion)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const authed = useMemo(hasVoiceAuth, [authVersion])
  if (provider === 'doubao') {
    return userIntent && isVoiceGrowthBookEnabled()
  }
  return userIntent && authed && isVoiceGrowthBookEnabled()
}
