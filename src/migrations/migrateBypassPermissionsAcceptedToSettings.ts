import { logEvent } from 'src/services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'
import {
  hasSkipDangerousModePermissionPrompt,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 迁移：将 bypassPermissionsModeAccepted 从全局 config 移至 settings.json，
 * 重命名为 skipDangerousModePermissionPrompt。这里是更合适的位置，因为
 * settings.json 是用户可配置的设置文件。
 */
export function migrateBypassPermissionsAcceptedToSettings(): void {
  const globalConfig = getGlobalConfig()

  if (!globalConfig.bypassPermissionsModeAccepted) {
    return
  }

  try {
    if (!hasSkipDangerousModePermissionPrompt()) {
      updateSettingsForSource('userSettings', {
        skipDangerousModePermissionPrompt: true,
      })
    }

    logEvent('tengu_migrate_bypass_permissions_accepted', {})

    saveGlobalConfig(current => {
      if (!('bypassPermissionsModeAccepted' in current)) return current
      const { bypassPermissionsModeAccepted: _, ...updatedConfig } = current
      return updatedConfig
    })
  } catch (error) {
    logError(
      new Error(`Failed to migrate bypass permissions accepted: ${error}`),
    )
  }
}
