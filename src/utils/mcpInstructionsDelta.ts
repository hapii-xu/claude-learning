import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { logEvent } from '../services/analytics/index.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
} from '../services/mcp/types.js'
import type { Message } from '../types/message.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'

export type McpInstructionsDelta = {
  /** 服务器名称 — 用于无状态扫描重建。 */
  addedNames: string[]
  /** 为 addedNames 渲染的 "## {name}\n{instructions}" 块。 */
  addedBlocks: string[]
  removedNames: string[]
}

/**
 * 客户端编写的指令块，用于在服务器连接时公告，
 * 补充（或替代）服务器自身的 `InitializeResult.instructions`。
 * 让第一方服务器（如 claude-in-chrome）能够携带
 * 服务器自身不知道的客户端上下文。
 */
export type ClientSideInstruction = {
  serverName: string
  block: string
}

/**
 * True → 通过持久化的 delta 附件公告 MCP 服务器指令。
 * False → prompts.ts 保留其 DANGEROUS_uncachedSystemPromptSection
 * （每轮重建；延迟连接时破坏缓存）。
 *
 * 环境变量覆盖用于本地测试：CLAUDE_CODE_MCP_INSTR_DELTA=true/false
 * 优先级高于 ant 绕过和 GrowthBook 门控。
 */
export function isMcpInstructionsDeltaEnabled(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_MCP_INSTR_DELTA)) return true
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_MCP_INSTR_DELTA)) return false
  return (
    process.env.USER_TYPE === 'ant' ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_basalt_3kr', false)
  )
}

/**
 * 对比当前已连接的 MCP 服务器中带有指令的集合
 * （服务器通过 InitializeResult 提供的，或客户端合成的）
 * 与此会话中已公告的内容。若无变化则返回 null。
 *
 * 指令在连接生命周期内是不变的（握手时一次设定），
 * 因此扫描基于服务器 NAME 做 diff，而非内容。
 */
export function getMcpInstructionsDelta(
  mcpClients: MCPServerConnection[],
  messages: Message[],
  clientSideInstructions: ClientSideInstruction[],
): McpInstructionsDelta | null {
  const announced = new Set<string>()
  let attachmentCount = 0
  let midCount = 0
  for (const msg of messages) {
    if (msg.type !== 'attachment') continue
    attachmentCount++
    if (msg.attachment!.type !== 'mcp_instructions_delta') continue
    midCount++
    const delta = msg.attachment! as unknown as McpInstructionsDelta
    for (const n of delta.addedNames) announced.add(n)
    for (const n of delta.removedNames) announced.delete(n)
  }

  const connected = mcpClients.filter(
    (c): c is ConnectedMCPServer => c.type === 'connected',
  )
  const connectedNames = new Set(connected.map(c => c.name))

  // 有指令待公告的服务器（两种渠道皆可）。一个服务器可能
  // 同时具有两者：服务器提供的指令 + 附加的客户端块。
  const blocks = new Map<string, string>()
  for (const c of connected) {
    if (c.instructions) blocks.set(c.name, `## ${c.name}\n${c.instructions}`)
  }
  for (const ci of clientSideInstructions) {
    if (!connectedNames.has(ci.serverName)) continue
    const existing = blocks.get(ci.serverName)
    blocks.set(
      ci.serverName,
      existing
        ? `${existing}\n\n${ci.block}`
        : `## ${ci.serverName}\n${ci.block}`,
    )
  }

  const added: Array<{ name: string; block: string }> = []
  for (const [name, block] of blocks) {
    if (!announced.has(name)) added.push({ name, block })
  }

  // 之前已公告但当前不再连接的服务器 → 移除。
  // 不存在"已公告但当前无指令"的仍在连接的服务器情况：
  // InitializeResult 是不变的，客户端指令门控实际上在会话期间
  // 是稳定的。（/model 可以翻转模型门控，但 deferred_tools_delta
  // 也有同样的属性，我们将历史视为历史记录 — 不做
  // 追溯撤回。）
  const removed: string[] = []
  for (const n of announced) {
    if (!connectedNames.has(n)) removed.push(n)
  }

  if (added.length === 0 && removed.length === 0) return null

  // 与 tengu_deferred_tools_pool_change 使用相同的诊断字段 — 同样的
  // 扫描在生产环境失败的 bug，同样的附件持久化路径。
  logEvent('tengu_mcp_instructions_pool_change', {
    addedCount: added.length,
    removedCount: removed.length,
    priorAnnouncedCount: announced.size,
    clientSideCount: clientSideInstructions.length,
    messagesLength: messages.length,
    attachmentCount,
    midCount,
  })

  added.sort((a, b) => a.name.localeCompare(b.name))
  return {
    addedNames: added.map(a => a.name),
    addedBlocks: added.map(a => a.block),
    removedNames: removed.sort(),
  }
}
