import type { Command } from '../../types/command.js'

const scheduleCommand: Command = {
  type: 'local-jsx',
  // 主名称由 'schedule' 改名为 'triggers'，以避免与上游内置
  // skill `src/skills/bundled/scheduleRemoteAgents.ts`（同样注册为
  // `/schedule`）冲突。新名称与底层 API 端点（`/v1/code/triggers`）一致。
  // 目录仍命名为 schedule/ 以最小化改动范围 — 仅修改用户可见的斜杠命令名。
  name: 'triggers',
  aliases: ['cron'],
  description:
    'Manage scheduled remote agent triggers (cloud cron). Requires Claude Pro/Max/Team subscription.',
  // REPL markdown 渲染器会把 `<...>` 当作 HTML 标签剥除 — 使用大写。
  argumentHint:
    'list | get ID | create CRON PROMPT | update ID FIELD VALUE | delete ID | run ID | enable ID | disable ID',
  isHidden: false,
  isEnabled: () => true,
  bridgeSafe: false,
  availability: ['claude-ai'],
  load: async () => {
    const m = await import('./launchSchedule.js')
    return { call: m.callSchedule }
  },
}

export default scheduleCommand
