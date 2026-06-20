import { getGlobalConfig } from '../../utils/config.js'
import type { Command } from '../../types/command.js'

const memoryStoresCommand: Command = {
  type: 'local-jsx',
  name: 'memory-stores',
  aliases: ['mem', 'mstore'],
  description:
    'Manage remote memory stores (cross-device memory persistence). Requires Claude Pro/Max/Team subscription.',
  // REPL markdown 渲染器会把 `<...>` 当作 HTML 标签剥离 —— 用大写形式。
  argumentHint:
    'list | get ID | create NAME | archive ID | memories STORE_ID | create-memory STORE_ID CONTENT | get-memory STORE_ID MEMORY_ID | update-memory STORE_ID MEMORY_ID CONTENT | delete-memory STORE_ID MEMORY_ID | versions STORE_ID | redact STORE_ID VERSION_ID',
  // 当 env 或已保存设置中存在 workspace API key 时可见。
  // 使用 getter 让 getGlobalConfig() 懒执行（在 enableConfigs() 之后），
  // 而不是在模块加载时执行 —— 模块加载时执行会与 bootstrap 竞态并抛错。
  get isHidden(): boolean {
    return (
      !process.env['ANTHROPIC_API_KEY'] && !getGlobalConfig().workspaceApiKey
    )
  },
  isEnabled: () => true,
  bridgeSafe: false,
  availability: ['claude-ai'],
  load: async () => {
    const m = await import('./launchMemoryStores.js')
    return { call: m.callMemoryStores }
  },
}

export default memoryStoresCommand
