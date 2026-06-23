import type { Command } from '../../types/command.js';

const localMemoryCommand: Command = {
  type: 'local-jsx',
  name: 'local-memory',
  aliases: ['lm'],
  description:
    'Manage local memory stores for notes and context. Stored in ~/.hclaude/local-memory/ — no API key required.',
  // 避免在 hint 中使用 `<store>` / `<key>` / `<value>` —— REPL markdown 渲染器
  // 会把尖括号包裹的词当成 HTML 标签过滤掉。大写的占位符可见。
  // 与 /local-vault 是同一种修复方式。
  argumentHint: 'list | create STORE | store STORE KEY VALUE | fetch STORE KEY | entries STORE | archive STORE',
  isHidden: false,
  isEnabled: () => true,
  bridgeSafe: true,
  load: async () => {
    const m = await import('./launchLocalMemory.js');
    return { call: m.callLocalMemory };
  },
};

export default localMemoryCommand;
