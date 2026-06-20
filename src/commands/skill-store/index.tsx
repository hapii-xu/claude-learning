import { getGlobalConfig } from '../../utils/config.js';
import type { Command } from '../../types/command.js';

const skillStoreCommand: Command = {
  type: 'local-jsx',
  name: 'skill-store',
  aliases: ['ss', 'cloud-skills'],
  description:
    'Browse and install remote skills from the Anthropic skill marketplace. Requires Claude Pro/Max/Team subscription.',
  // REPL markdown 渲染器会把 `<...>` 当作 HTML 标签剥除 — 使用大写。
  argumentHint:
    'list | get ID | versions ID | version ID VER | create NAME MARKDOWN | delete ID | install ID[@VERSION]',
  // 当从 env 或已保存的 settings 中能获取到 workspace API key 时可见。
  // 使用 getter 让 getGlobalConfig() 懒加载执行（在 enableConfigs() 之后），
  // 而不是在模块加载时执行，否则会与 bootstrap 竞态并抛错。
  get isHidden(): boolean {
    return !process.env['ANTHROPIC_API_KEY'] && !getGlobalConfig().workspaceApiKey;
  },
  isEnabled: () => true,
  bridgeSafe: false,
  availability: ['claude-ai'],
  load: async () => {
    const m = await import('./launchSkillStore.js');
    return { call: m.callSkillStore };
  },
};

export default skillStoreCommand;
