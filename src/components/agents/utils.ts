import capitalize from 'lodash-es/capitalize.js'
import type { SettingSource } from 'src/utils/settings/constants.js'
import { getSettingSourceName } from 'src/utils/settings/constants.js'

export function getAgentSourceDisplayName(
  source: SettingSource | 'all' | 'built-in' | 'plugin',
): string {
  if (source === 'all') {
    return '全部 agent'
  }
  if (source === 'built-in') {
    return '内置 agent'
  }
  if (source === 'plugin') {
    return '插件 agent'
  }
  return capitalize(getSettingSourceName(source))
}
