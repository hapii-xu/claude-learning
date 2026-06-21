import {
  getMainLoopModelOverride,
  setMainLoopModelOverride,
} from '../bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 将保存了 "sonnet[1m]" 的用户迁移到显式的 "sonnet-4-5-20250929[1m]"。
 *
 * "sonnet" 别名现在解析为 Sonnet 4.6，所以之前设置 "sonnet[1m]"
 * （目标为带 1M 上下文的 Sonnet 4.5）的用户需要被固定到显式版本，
 * 以保留其意图的模型。
 *
 * 之所以需要这样做，是因为 Sonnet 4.6 1M 提供给了与 Sonnet 4.5 1M 不同的一组用户，
 * 所以我们需要将现有的 sonnet[1m] 用户固定到 Sonnet 4.5 1M。
 *
 * 特意从 userSettings 读取（而非合并的设置），这样我们不会把项目作用域的
 * "sonnet[1m]" 提升为全局默认值。运行一次，通过全局配置中的完成标志跟踪。
 */
export function migrateSonnet1mToSonnet45(): void {
  const config = getGlobalConfig()
  if (config.sonnet1m45MigrationComplete) {
    return
  }

  const model = getSettingsForSource('userSettings')?.model
  if (model === 'sonnet[1m]') {
    updateSettingsForSource('userSettings', {
      model: 'sonnet-4-5-20250929[1m]',
    })
  }

  // 如果已设置，也迁移内存中的覆盖值
  const override = getMainLoopModelOverride()
  if (override === 'sonnet[1m]') {
    setMainLoopModelOverride('sonnet-4-5-20250929[1m]')
  }

  saveGlobalConfig(current => ({
    ...current,
    sonnet1m45MigrationComplete: true,
  }))
}
