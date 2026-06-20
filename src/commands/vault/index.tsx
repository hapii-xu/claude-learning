import { getGlobalConfig } from '../../utils/config.js';
import type { Command } from '../../types/command.js';

const vaultCommand: Command = {
  type: 'local-jsx',
  name: 'vault',
  aliases: ['vaults'],
  description:
    'Manage remote secret vaults and credentials for cloud agents. Requires Claude Pro/Max/Team subscription.',
  // REPL 的 markdown 渲染器会把 `<...>` 当作 HTML 标签剥离 —— 使用大写形式。
  argumentHint:
    'list | create NAME | get ID | archive ID | add-credential VAULT_ID KEY VALUE | archive-credential VAULT_ID CRED_ID',
  // 当环境变量或已保存设置中存在 workspace API key 时可见。
  // 使用 getter 让 getGlobalConfig() 延迟执行（在 enableConfigs() 之后），
  // 而不是在模块加载时执行，否则会与 bootstrap 竞态并抛错。
  get isHidden(): boolean {
    return !process.env['ANTHROPIC_API_KEY'] && !getGlobalConfig().workspaceApiKey;
  },
  isEnabled: () => true,
  bridgeSafe: false,
  availability: ['claude-ai'],
  load: async () => {
    const m = await import('./launchVault.js');
    return { call: m.callVault };
  },
};

export default vaultCommand;
