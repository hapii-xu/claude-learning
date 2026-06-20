import type { Command } from '../../commands.js'
import { isSkillLearningCompiledIn } from '../../services/skillLearning/featureCheck.js'

const skillLearning = {
  type: 'local-jsx',
  name: 'skill-learning',
  description: 'Manage skill learning (observe, analyze, evolve)',
  argumentHint:
    '[start|stop|about|status|ingest|evolve|export|import|prune|promote|projects]',
  // 只要子系统被编译进来，该斜杠命令就可见。
  // 至于运行时 feature 是否真正工作是由 `/skill-learning start` 控制的
  // 另一件事情（见 featureCheck.ts）。
  isEnabled: () => isSkillLearningCompiledIn(),
  isHidden: false,
  load: () => import('./skillPanel.js'),
} satisfies Command

export default skillLearning
