import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { saveGlobalConfig } from '../utils/config.js'
import { isLegacyModelRemapEnabled } from '../utils/model/model.js'
import { getAPIProvider } from '../utils/model/providers.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 将 first-party 用户从显式 Opus 4.0/4.1 模型字符串迁移走。
 *
 * 'opus' 别名对 1P 已经解析为 Opus 4.7，因此仍在使用显式 4.0/4.1
 * 字符串的人是在 4.5 发布前在 settings 中固定的。parseUserSpecifiedModel
 * 现在在运行时无论如何都会静默重映射它们——此迁移清理 settings 文件，
 * 使 /model 显示正确内容，并设置时间戳以便 REPL 可以显示一次性通知。
 *
 * 仅触及 userSettings。project/local/policy settings 中的遗留字符串保持
 * 原样（我们无法/不应重写那些），且仍由 parseUserSpecifiedModel 在运行时
 * 重映射。读写同一来源使其无需完成标志即可保持幂等，并避免对只在
 * 单个项目中固定 'opus' 的用户静默提升为全局默认值。
 */
export function migrateLegacyOpusToCurrent(): void {
  if (getAPIProvider() !== 'firstParty') {
    return
  }

  if (!isLegacyModelRemapEnabled()) {
    return
  }

  const model = getSettingsForSource('userSettings')?.model
  if (
    model !== 'claude-opus-4-20250514' &&
    model !== 'claude-opus-4-1-20250805' &&
    model !== 'claude-opus-4-0' &&
    model !== 'claude-opus-4-1'
  ) {
    return
  }

  updateSettingsForSource('userSettings', { model: 'opus' })
  saveGlobalConfig(current => ({
    ...current,
    legacyOpusMigrationTimestamp: Date.now(),
  }))
  logEvent('tengu_legacy_opus_migration', {
    from_model:
      model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}
