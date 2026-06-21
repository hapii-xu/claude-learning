/**
 * 对端地址解析 — 与 peerRegistry.ts 分开保留，以便
 * SendMessageTool 能在不传递式加载 bridge（axios）和
 * UDS（fs、net）模块的情况下导入 parseAddress。
 */

/** 将 URI 风格的地址解析为 scheme + target。 */
export function parseAddress(to: string): {
  scheme: 'uds' | 'bridge' | 'tcp' | 'other'
  target: string
} {
  if (to.startsWith('uds:')) return { scheme: 'uds', target: to.slice(4) }
  if (to.startsWith('bridge:')) return { scheme: 'bridge', target: to.slice(7) }
  if (to.startsWith('tcp:')) return { scheme: 'tcp', target: to.slice(4) }
  // 兼容旧版：旧代码 UDS 发送方在 from= 中发出裸 socket 路径；
  // 将它们路由到 UDS 分支，以避免回复被静默丢弃到队友
  // 路由中。（无裸会话 ID 回退 — bridge 消息传递足够新，
  // 不存在旧发送方，且该前缀会劫持队友名称
  // 如 session_manager。）
  if (to.startsWith('/')) return { scheme: 'uds', target: to }
  return { scheme: 'other', target: to }
}

/** 将 tcp: 目标字符串解析为 host 和 port。 */
export function parseTcpTarget(
  target: string,
): { host: string; port: number } | null {
  const match = target.match(/^([^:]+):(\d+)$/)
  if (!match) return null
  const port = parseInt(match[2]!, 10)
  if (port < 1 || port > 65535) return null
  return { host: match[1]!, port }
}
