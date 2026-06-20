import type { Command } from '../../commands.js'
import { isSkillSearchCompiledIn } from '../../services/skillSearch/featureCheck.js'

const skillSearch = {
  type: 'local-jsx',
  name: 'skill-search',
  description: 'Control automatic skill matching during conversations',
  argumentHint: '[start|stop|about|status]',
  // 只要子系统被编译进来（build flag）就可见；运行时激活是独立的，
  // 由操作员通过 /skill-search start 控制。
  isEnabled: () => isSkillSearchCompiledIn(),
  isHidden: false,
  load: () => import('./skillSearchPanel.js'),
} satisfies Command

export default skillSearch
