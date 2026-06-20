/**
 * Color 命令 - 仅包含最小元数据。
 * 实现从 color.ts 懒加载以减少启动时间。
 */
import type { Command } from '../../commands.js'

const color = {
  type: 'local-jsx',
  name: 'color',
  description: 'Set the prompt bar color for this session',
  immediate: true,
  argumentHint: '<color|default>',
  load: () => import('./color.js'),
} satisfies Command

export default color
