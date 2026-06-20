import type { Command } from '../../types/command.js';

const localVaultCommand: Command = {
  type: 'local-jsx',
  name: 'local-vault',
  aliases: ['lv', 'local-secret'],
  description:
    'Manage local encrypted secrets. Stored in OS keychain or encrypted file fallback — no API key required.',
  // 避免在 hint 中使用 `<key>` / `<value>` —— REPL markdown 渲染器会把
  // 尖括号包裹的词当作 HTML 标签吞掉。大写的占位符可以保留。
  argumentHint: 'list | set KEY VALUE | get KEY [--reveal] | delete KEY',
  isHidden: false,
  isEnabled: () => true,
  bridgeSafe: true,
  load: async () => {
    const m = await import('./launchLocalVault.js');
    return { call: m.callLocalVault };
  },
};

export default localVaultCommand;
