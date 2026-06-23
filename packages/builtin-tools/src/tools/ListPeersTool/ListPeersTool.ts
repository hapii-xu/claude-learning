import { z } from 'zod/v4'
import type { ToolResultBlockParam } from 'src/Tool.js'
import { buildTool } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'

const LIST_PEERS_TOOL_NAME = 'ListPeers'

const inputSchema = lazySchema(() =>
  z.strictObject({
    include_self: z
      .boolean()
      .optional()
      .describe('是否在列表中包含当前会话。默认为 false。'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type ListPeersInput = z.infer<InputSchema>

type PeerInfo = {
  address: string
  name?: string
  cwd?: string
  pid?: number
}
type ListPeersOutput = { peers: PeerInfo[] }

export const ListPeersTool = buildTool({
  name: LIST_PEERS_TOOL_NAME,
  searchHint: '列出并发现其他 Claude Code 会话（UDS Socket / Bridge 远程会话）',
  maxResultSizeChars: 50_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return '发现其他 Claude Code 会话以进行跨会话消息传递'
  },
  async prompt() {
    return `列出可以通过 SendMessage 接收消息的活动 Claude Code 会话。

返回一个包含地址的对等方数组。在 SendMessage 中使用这些地址作为 \`to\` 字段：
- \`"uds:/path/to.sock"\` — 同一台机器上的本地会话（Unix Domain Socket）
- \`"bridge:session_..."\` — 通过 Remote Control 的远程会话

在发送跨会话消息之前，使用此工具发现消息目标。仅返回具有活动消息套接字的运行中会话。`
  },

  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },

  userFacingName() {
    return LIST_PEERS_TOOL_NAME
  },

  renderToolUseMessage() {
    return 'ListPeers'
  },

  mapToolResultToToolResultBlockParam(
    content: ListPeersOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    const lines = content.peers.map(
      p =>
        `${p.address}${p.name ? ` (${p.name})` : ''}${p.cwd ? ` @ ${p.cwd}` : ''}`,
    )
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content:
        lines.length > 0
          ? `Found ${lines.length} peer(s):\n${lines.join('\n')}`
          : 'No peers found.',
    }
  },

  async call(_input: ListPeersInput, context) {
    // 对等方发现使用并发会话 PID 注册表和
    // UDS socket 目录。实现扫描活跃的 socket
    // 并可选地包括远程控制桥接对等方。
    const peers: PeerInfo[] = []
    const seen = new Set<string>()
    const addPeer = (peer: PeerInfo): void => {
      if (seen.has(peer.address)) return
      seen.add(peer.address)
      peers.push(peer)
    }

    /* eslint-disable @typescript-eslint/no-require-imports */
    const udsMessaging =
      require('src/utils/udsMessaging.js') as typeof import('src/utils/udsMessaging.js')
    const udsClient =
      require('src/utils/udsClient.js') as typeof import('src/utils/udsClient.js')
    const bridgePeers =
      require('src/bridge/peerSessions.js') as typeof import('src/bridge/peerSessions.js')
    /* eslint-enable @typescript-eslint/no-require-imports */

    const messagingSocketPath = udsMessaging.getUdsMessagingSocketPath()
    if (messagingSocketPath) {
      // 用于参考的自身条目
      if (_input.include_self) {
        addPeer({
          address: udsMessaging.formatUdsAddress(messagingSocketPath),
          name: 'self',
          pid: process.pid,
        })
      }
    }

    for (const peer of await udsClient.listPeers()) {
      if (!peer.messagingSocketPath) continue
      addPeer({
        address: udsMessaging.formatUdsAddress(peer.messagingSocketPath),
        name: peer.name ?? peer.kind,
        cwd: peer.cwd,
        pid: peer.pid,
      })
    }

    for (const peer of await bridgePeers.listBridgePeers()) {
      addPeer(peer)
    }

    return {
      data: { peers },
    }
  },
})
