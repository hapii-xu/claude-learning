import { getGlobalConfig } from '../../utils/config.js'
import type { Command } from '../../types/command.js'

// 当环境变量或已保存设置中存在 workspace API key 时可见。
// 使用 getter 让 getGlobalConfig() 懒加载（在 entry 路径执行 enableConfigs() 之后再调用），
// 而不是在模块加载时调用，否则会与 config 系统的 bootstrap 竞态，
// 抛出 "Config accessed before allowed"。
const agentsPlatform: Command = {
  type: 'local-jsx',
  name: 'agents-platform',
  aliases: ['agents', 'schedule-agent'],
  description: 'Manage scheduled remote agents (cron-style triggers)',
  // REPL markdown 渲染器会把 `<...>` 当作 HTML 标签剥离 —— 改用大写。
  argumentHint: 'list | create CRON PROMPT | delete ID | run ID',
  get isHidden(): boolean {
    return (
      !process.env['ANTHROPIC_API_KEY'] && !getGlobalConfig().workspaceApiKey
    )
  },
  isEnabled: () => true,
  bridgeSafe: false,
  availability: ['claude-ai'],
  load: async () => {
    const m = await import('./launchAgentsPlatform.js')
    return { call: m.callAgentsPlatform }
  },
}

export default agentsPlatform
