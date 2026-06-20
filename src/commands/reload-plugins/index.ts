/**
 * /reload-plugins — Layer-3 刷新。将待处理的插件变更应用到
 * 当前运行的会话。实现采用惰性加载。
 */
import type { Command } from '../../commands.js'

const reloadPlugins = {
  type: 'local',
  name: 'reload-plugins',
  description: 'Activate pending plugin changes in the current session',
  // SDK 调用方使用 query.reloadPlugins()（control request），而不是
  // 将其作为文本 prompt 发送 — 前者会返回结构化数据
  // （commands、agents、plugins、mcpServers）用于 UI 更新。
  supportsNonInteractive: false,
  load: () => import('./reload-plugins.js'),
} satisfies Command

export default reloadPlugins
