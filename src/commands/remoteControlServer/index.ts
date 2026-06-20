import { feature } from 'bun:bundle'
import { isBridgeEnabled } from '../../bridge/bridgeEnabled.js'
import type { Command } from '../../commands.js'

function isEnabled(): boolean {
  if (!feature('BRIDGE_MODE')) {
    return false
  }
  if (feature('DAEMON')) {
    return isBridgeEnabled()
  }
  // DAEMON feature 被禁用 — 仍然允许该命令，但在运行时警告
  // headless/daemon worker 模式不可用。
  return isBridgeEnabled()
}

const remoteControlServer = {
  type: 'local-jsx',
  name: 'remote-control-server',
  aliases: ['rcs'],
  description:
    'Start a persistent Remote Control server (daemon) that accepts multiple sessions',
  isEnabled,
  get isHidden() {
    return !isEnabled()
  },
  immediate: true,
  load: () => import('./remoteControlServer.js'),
} satisfies Command

export default remoteControlServer
