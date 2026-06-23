import { SETTING_SOURCES, type SettingSource } from '../settings/constants.js'
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
} from '../settings/settings.js'
import { type EnvironmentResource, fetchEnvironments } from './environments.js'

export type EnvironmentSelectionInfo = {
  availableEnvironments: EnvironmentResource[]
  selectedEnvironment: EnvironmentResource | null
  selectedEnvironmentSource: SettingSource | null
}

/**
 * 获取可用环境及当前选中环境的信息。
 *
 * @returns Promise<EnvironmentSelectionInfo>，包含：
 *   - availableEnvironments：来自 API 的所有环境
 *   - selectedEnvironment：将被使用的环境（基于设置或第一个可用环境），
 *     如果没有可用环境则为 null
 *   - selectedEnvironmentSource：配置了 defaultEnvironmentId 的 SettingSource，
 *     如果使用默认值（第一个环境）则为 null
 */
export async function getEnvironmentSelectionInfo(): Promise<EnvironmentSelectionInfo> {
  // 获取可用环境
  const environments = await fetchEnvironments()

  if (environments.length === 0) {
    return {
      availableEnvironments: [],
      selectedEnvironment: null,
      selectedEnvironmentSource: null,
    }
  }

  // 获取合并后的设置，以确认实际会使用哪个环境
  const mergedSettings = getSettings_DEPRECATED()
  const defaultEnvironmentId = mergedSettings?.remote?.defaultEnvironmentId

  // 确定会选择哪个环境
  let selectedEnvironment: EnvironmentResource =
    environments.find(env => env.kind !== 'bridge') ?? environments[0]!
  let selectedEnvironmentSource: SettingSource | null = null

  if (defaultEnvironmentId) {
    const matchingEnvironment = environments.find(
      env => env.environment_id === defaultEnvironmentId,
    )

    if (matchingEnvironment) {
      selectedEnvironment = matchingEnvironment

      // 查找该设置来自哪个来源
      // 从最低优先级到最高优先级遍历，最后一个匹配项获胜（即最高优先级）
      for (let i = SETTING_SOURCES.length - 1; i >= 0; i--) {
        const source = SETTING_SOURCES[i]
        if (!source || source === 'flagSettings') {
          // 跳过 flagSettings，因为它不是我们检查的常规来源
          continue
        }
        const sourceSettings = getSettingsForSource(source)
        if (
          sourceSettings?.remote?.defaultEnvironmentId === defaultEnvironmentId
        ) {
          selectedEnvironmentSource = source
          break
        }
      }
    }
  }

  return {
    availableEnvironments: environments,
    selectedEnvironment,
    selectedEnvironmentSource,
  }
}
