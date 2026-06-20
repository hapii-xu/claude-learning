/**
 * Copy 命令 - 仅包含最小元数据。
 * 实现从 copy.tsx 懒加载以减少启动时间。
 */
import type { Command } from '../../commands.js'

const copy = {
  type: 'local-jsx',
  name: 'copy',
  description:
    "Copy Claude's last response to clipboard (or /copy N for the Nth-latest)",
  load: () => import('./copy.js'),
} satisfies Command

export default copy
