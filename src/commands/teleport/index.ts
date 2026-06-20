import type { Command } from '../../types/command.js'

const teleport: Command = {
  type: 'local-jsx',
  name: 'teleport',
  // 官方 v2.1.123 声明了别名 `tp`（从 claude.exe 逆向而来：
  // `name:"teleport",aliases:["tp"]`）。为保持一致而保留。
  aliases: ['tp'],
  description: 'Resume a Claude Code session from claude.ai',
  // REPL 的 markdown 渲染器会把 `<...>` 当作 HTML 标签剥离 —— 使用大写形式。
  argumentHint: 'SESSION_ID',
  isHidden: false,
  isEnabled: () => true,
  bridgeSafe: false,
  getBridgeInvocationError: (_args: string) =>
    'teleport resumes the REPL and is not bridge-safe',
  load: async () => {
    const m = await import('./launchTeleport.js')
    return { call: m.callTeleport }
  },
}

export default teleport
