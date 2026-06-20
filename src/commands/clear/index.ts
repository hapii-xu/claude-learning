/**
 * Clear 命令 - 仅包含最小元数据。
 * 实现从 clear.ts 懒加载以减少启动时间。
 * 工具函数：
 * - clearSessionCaches: 从 './clear/caches.js' 导入
 * - clearConversation: 从 './clear/conversation.js' 导入
 */
import type { Command } from '../../commands.js'

const clear = {
  type: 'local',
  name: 'clear',
  description: 'Clear conversation history and free up context',
  aliases: ['reset', 'new'],
  supportsNonInteractive: false, // 应当只创建一个新会话
  load: () => import('./clear.js'),
} satisfies Command

export default clear
