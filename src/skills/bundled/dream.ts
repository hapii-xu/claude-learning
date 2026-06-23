// 手动 /dream 技能 —— 交互式运行记忆整合提示。
// 从 KAIROS feature gate 中提取，以便在自动记忆启用时
// 无条件可用。

import { getAutoMemPath, isAutoMemoryEnabled } from '../../memdir/paths.js'
import { buildConsolidationPrompt } from '../../services/autoDream/consolidationPrompt.js'
import { recordConsolidation } from '../../services/autoDream/consolidationLock.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getProjectDir } from '../../utils/sessionStorage.js'
import { registerBundledSkill } from '../bundledSkills.js'

const DREAM_PROMPT_PREFIX = `# Dream：记忆整合（手动运行）

你正在执行一次手动 dream——对记忆文件的反思性整理。与自动后台 dream 不同，此次运行拥有完整工具权限，且用户正在观察。将你近期学到的内容整合为持久、有序的记忆，以便未来会话快速定向。

`

export function registerDreamSkill(): void {
  registerBundledSkill({
    name: 'dream',
    description:
      '手动触发记忆整合——审查、整理并精简自动记忆文件。',
    whenToUse:
      '当用户输入 /dream 或想手动整合记忆、整理记忆文件或清理过时条目时使用。',
    userInvocable: true,
    isEnabled: () => isAutoMemoryEnabled(),
    async getPromptForCommand(args) {
      const memoryRoot = getAutoMemPath()
      const transcriptDir = getProjectDir(getOriginalCwd())

      // 乐观地标记整合锁（与 KAIROS 路径相同）。
      await recordConsolidation()

      const basePrompt = buildConsolidationPrompt(memoryRoot, transcriptDir, '')
      let prompt = DREAM_PROMPT_PREFIX + basePrompt

      if (args) {
        prompt += `\n\n## 用户提供的附加上下文\n\n${args}`
      }

      return [{ type: 'text', text: prompt }]
    },
  })
}
