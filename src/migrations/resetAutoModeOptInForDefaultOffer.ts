import { feature } from 'bun:bundle'
import { logEvent } from 'src/services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'
import { getAutoModeEnabledState } from '../utils/permissions/permissionSetup.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 一次性迁移：为那些接受了旧的 2 选项 AutoModeOptInDialog 但未将 auto
 * 设为默认值的用户清除 skipAutoPermissionPrompt。重新显示对话框，让
 * 他们看到新的"将其设为我的默认模式"选项。守卫位于 GlobalConfig
 * （~/.claude.json）中而非 settings.json，因此它能在 settings 重置后
 * 存活且不会自动重新激活。
 *
 * 仅在 tengu_auto_mode_config.enabled === 'enabled' 时运行。对于
 * 'opt-in' 用户，清除 skipAutoPermissionPrompt 会从轮播中移除 auto
 * （permissionSetup.ts:988）—— 对话框将变得不可达，迁移也会自我打败。
 * 实际上约 40 个目标 ant 都是 'enabled'（他们通过 bare Shift+Tab 到达
 * 旧对话框，这需要 'enabled'），但守卫让它无论如何都安全。
 */
export function resetAutoModeOptInForDefaultOffer(): void {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const config = getGlobalConfig()
    if (config.hasResetAutoModeOptInForDefaultOffer) return
    if (getAutoModeEnabledState() !== 'enabled') return

    try {
      const user = getSettingsForSource('userSettings')
      if (
        user?.skipAutoPermissionPrompt &&
        user?.permissions?.defaultMode !== 'auto'
      ) {
        updateSettingsForSource('userSettings', {
          skipAutoPermissionPrompt: undefined,
        })
        logEvent('tengu_migrate_reset_auto_opt_in_for_default_offer', {})
      }

      saveGlobalConfig(c => {
        if (c.hasResetAutoModeOptInForDefaultOffer) return c
        return { ...c, hasResetAutoModeOptInForDefaultOffer: true }
      })
    } catch (error) {
      logError(new Error(`Failed to reset auto mode opt-in: ${error}`))
    }
  }
}
