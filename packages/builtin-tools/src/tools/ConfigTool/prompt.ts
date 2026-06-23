import { feature } from 'bun:bundle'
import { getModelOptions } from 'src/utils/model/modelOptions.js'
import { isVoiceGrowthBookEnabled } from 'src/voice/voiceModeEnabled.js'
import {
  getOptionsForSetting,
  SUPPORTED_SETTINGS,
} from './supportedSettings.js'

export const DESCRIPTION = '获取或设置 Claude Code 配置项。'

/**
 * 根据注册表生成 prompt 文档
 */
export function generatePrompt(): string {
  const globalSettings: string[] = []
  const projectSettings: string[] = []

  for (const [key, config] of Object.entries(SUPPORTED_SETTINGS)) {
    // 跳过 model——它有自己独立的段落并包含动态选项
    if (key === 'model') continue
    // 语音相关 setting 在构建期注册，但在运行期由 GrowthBook 门控。
    // 当 kill-switch 打开时，将其从模型 prompt 中隐藏。
    if (
      feature('VOICE_MODE') &&
      key === 'voiceEnabled' &&
      !isVoiceGrowthBookEnabled()
    )
      continue

    const options = getOptionsForSetting(key)
    let line = `- ${key}`

    if (options) {
      line += `: ${options.map(o => `"${o}"`).join(', ')}`
    } else if (config.type === 'boolean') {
      line += `: true/false`
    }

    line += ` - ${config.description}`

    if (config.source === 'global') {
      globalSettings.push(line)
    } else {
      projectSettings.push(line)
    }
  }

  const modelSection = generateModelSection()

  return `获取或设置 Claude Code 配置项。

  查看或更改 Claude Code 设置。当用户请求配置更改、询问当前设置，或调整某项设置对用户有益时使用。


## 用法
- **获取当前值：** 省略 "value" 参数
- **设置新值：** 包含 "value" 参数

## 可配置设置列表
以下设置可供更改：

### 全局设置（存储在 ~/.hclaude.json 中）
${globalSettings.join('\n')}

### 项目设置（存储在 settings.json 中）
${projectSettings.join('\n')}

${modelSection}
## 示例
- 获取主题：{ "setting": "theme" }
- 设置深色主题：{ "setting": "theme", "value": "dark" }
- 启用 vim 模式：{ "setting": "editorMode", "value": "vim" }
- 启用详细输出：{ "setting": "verbose", "value": true }
- 更改模型：{ "setting": "model", "value": "opus" }
- 更改权限模式：{ "setting": "permissions.defaultMode", "value": "plan" }
`
}

function generateModelSection(): string {
  try {
    const options = getModelOptions()
    const lines = options.map(o => {
      const value = o.value === null ? 'null/"default"' : `"${o.value}"`
      return `  - ${value}: ${o.descriptionForModel ?? o.description}`
    })
    return `## 模型
- model - 覆盖默认模型。可用选项：
${lines.join('\n')}`
  } catch {
    return `## 模型
- model - 覆盖默认模型（sonnet、opus、haiku、best 或完整模型 ID）`
  }
}
