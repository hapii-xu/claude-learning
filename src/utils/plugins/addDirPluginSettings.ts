/**
 * 从 --add-dir 目录读取插件相关设置（enabledPlugins、extraKnownMarketplaces）。
 *
 * 这些具有最低优先级 — 调用者必须在其上展开标准设置，
 * 以便 user/project/local/flag/policy 来源都能覆盖。
 */

import { join } from 'path'
import type { z } from 'zod/v4'
import { getAdditionalDirectoriesForClaudeMd } from '../../bootstrap/state.js'
import { parseSettingsFile } from '../settings/settings.js'
import { CLAUDE_DIR_NAME } from 'src/constants/claudeDirName.js'
import type {
  ExtraKnownMarketplaceSchema,
  SettingsJson,
} from '../settings/types.js'

type ExtraKnownMarketplace = z.infer<
  ReturnType<typeof ExtraKnownMarketplaceSchema>
>

const SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const

/**
 * 返回所有 --add-dir 目录中 enabledPlugins 的合并记录。
 *
 * 在每个目录内，settings.local.json 在 settings.json 之后处理
 * （local 在该目录内优先）。跨目录时，CLI 顺序靠后者在
 * 冲突时优先。
 *
 * 这具有最低优先级 — 调用者必须在其上展开标准设置，
 * 以便 user/project/local/flag/policy 能覆盖。
 */
export function getAddDirEnabledPlugins(): NonNullable<
  SettingsJson['enabledPlugins']
> {
  const result: NonNullable<SettingsJson['enabledPlugins']> = {}
  for (const dir of getAdditionalDirectoriesForClaudeMd()) {
    for (const file of SETTINGS_FILES) {
      const { settings } = parseSettingsFile(join(dir, CLAUDE_DIR_NAME, file))
      if (!settings?.enabledPlugins) {
        continue
      }
      Object.assign(result, settings.enabledPlugins)
    }
  }
  return result
}

/**
 * 返回所有 --add-dir 目录中 extraKnownMarketplaces 的合并记录。
 *
 * 优先级规则与 getAddDirEnabledPlugins 相同：settings.local.json 在
 * 每个目录内优先，调用者在其上展开标准设置。
 */
export function getAddDirExtraMarketplaces(): Record<
  string,
  ExtraKnownMarketplace
> {
  const result: Record<string, ExtraKnownMarketplace> = {}
  for (const dir of getAdditionalDirectoriesForClaudeMd()) {
    for (const file of SETTINGS_FILES) {
      const { settings } = parseSettingsFile(join(dir, CLAUDE_DIR_NAME, file))
      if (!settings?.extraKnownMarketplaces) {
        continue
      }
      Object.assign(result, settings.extraKnownMarketplaces)
    }
  }
  return result
}
