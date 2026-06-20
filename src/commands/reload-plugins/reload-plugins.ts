import { feature } from 'bun:bundle'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { redownloadUserSettings } from '../../services/settingsSync/index.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { refreshActivePlugins } from '../../utils/plugins/refresh.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { plural } from '../../utils/stringUtils.js'

export const call: LocalCommandCall = async (_args, context) => {
  // CCR：在缓存清理之前重新拉取用户设置，使从用户本地 CLI（settingsSync）
  // 推送过来的 enabledPlugins / extraKnownMarketplaces 生效。非 CCR 的
  // headless 模式（例如 vscode SDK 子进程）与写入 settings 的进程共享磁盘
  // — 文件监听器会投递变更，那里不需要重新拉取。
  //
  // Managed settings 故意不重新拉取：它已经按小时轮询
  // （POLLING_INTERVAL_MS），并且策略执行在设计上就是最终一致的
  // （获取失败时使用过期缓存兜底）。交互式
  // /reload-plugins 也从未重新拉取过它。
  //
  // 不重试：用户发起的命令，单次尝试 + fail-open。用户可以
  // 重新运行 /reload-plugins 来重试。启动路径保留其重试逻辑。
  if (
    feature('DOWNLOAD_USER_SETTINGS') &&
    (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) || getIsRemoteMode())
  ) {
    const applied = await redownloadUserSettings()
    // applyRemoteEntriesToLocal 使用 markInternalWrite 抑制
    // 文件监听器（启动阶段是正确的，此时还没有监听者）；这里触发
    // notifyChange 以便会话进行中的 applySettingsChange 被执行。
    if (applied) {
      settingsChangeDetector.notifyChange('userSettings')
    }
  }

  const r = await refreshActivePlugins(context.setAppState)

  const parts = [
    n(r.enabled_count, 'plugin'),
    n(r.command_count, 'skill'),
    n(r.agent_count, 'agent'),
    n(r.hook_count, 'hook'),
    // "plugin MCP/LSP" 用于与 user-config/built-in 服务器区分，
    // /reload-plugins 不会触碰后者。Commands/hooks 仅为插件；
    // agent_count 为 agent 总数（含 built-ins）。（gh-31321）
    n(r.mcp_count, 'plugin MCP server'),
    n(r.lsp_count, 'plugin LSP server'),
  ]
  let msg = `Reloaded: ${parts.join(' · ')}`

  if (r.error_count > 0) {
    msg += `\n${n(r.error_count, 'error')} during load. Run /doctor for details.`
  }

  return { type: 'text', value: msg }
}

function n(count: number, noun: string): string {
  return `${count} ${plural(count, noun)}`
}
