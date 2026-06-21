import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 将使用已移除的 fennec 模型别名的用户迁移至新的 Opus 4.6 别名。
 * - fennec-latest → opus
 * - fennec-latest[1m] → opus[1m]
 * - fennec-fast-latest → opus[1m] + fast mode
 * - opus-4-5-fast → opus + fast mode
 *
 * 仅触及 userSettings。读写同一来源使其无需完成标志即可保持幂等。
 * project/local/policy settings 中的 Fennec 别名保持原样 —— 我们无法
 * 重写那些，且在此读取合并后的 settings 会导致无限重运行 + 静默全局提升。
 */
export function migrateFennecToOpus(): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  const settings = getSettingsForSource('userSettings')

  const model = settings?.model
  if (typeof model === 'string') {
    if (model.startsWith('fennec-latest[1m]')) {
      updateSettingsForSource('userSettings', {
        model: 'opus[1m]',
      })
    } else if (model.startsWith('fennec-latest')) {
      updateSettingsForSource('userSettings', {
        model: 'opus',
      })
    } else if (
      model.startsWith('fennec-fast-latest') ||
      model.startsWith('opus-4-5-fast')
    ) {
      updateSettingsForSource('userSettings', {
        model: 'opus[1m]',
        fastMode: true,
      })
    }
  }
}
