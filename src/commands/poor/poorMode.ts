/**
 * 穷鬼模式状态 —— 激活时跳过 extract_memories 和 prompt_suggestion，
 * 以减少 token 消耗。
 *
 * 持久化到 settings.json，因此可以在会话重启后保留。
 */

import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'

let poorModeActive: boolean | null = null

export function isPoorModeActive(): boolean {
  if (poorModeActive === null) {
    poorModeActive = getInitialSettings().poorMode === true
  }
  return poorModeActive
}

export function setPoorMode(active: boolean): void {
  poorModeActive = active
  updateSettingsForSource('userSettings', {
    poorMode: active || undefined,
  })
}
