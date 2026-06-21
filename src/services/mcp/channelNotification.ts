/**
 * 频道通知 — 允许 MCP 服务器将用户消息推送到
 * 对话中。"频道"（Discord、Slack、SMS 等）就是一个 MCP 服务器，
 * 它：
 *   - 暴露用于出站消息的工具（例如 `send_message`） — 标准 MCP
 *   - 为入站消息发送 `notifications/claude/channel` 通知 — 本文件
 *
 * 通知处理程序将内容包装在 <channel> 标签中并
 * 入队。SleepTool 轮询 hasCommandsInQueue() 并在 1 秒内唤醒。
 * 模型看到消息来自哪里，并决定用哪个工具回复
 * （频道的 MCP 工具、SendUserMessage 或两者都用）。
 *
 * feature('KAIROS') || feature('KAIROS_CHANNELS')。运行时开关 tengu_harbor。
 * 需要 claude.ai OAuth 认证 — API 密钥用户被阻止，直到
 * console 获得 channelsEnabled 管理界面。团队/企业组织
 * 必须在托管设置中通过 channelsEnabled: true 显式选择加入。
 */

import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js'
import type { AnyObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { z } from 'zod/v4'
import { type ChannelEntry, getAllowedChannels } from '../../bootstrap/state.js'
import { CHANNEL_TAG } from '../../constants/xml.js'
import { getSubscriptionType } from '../../utils/auth.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { parsePluginIdentifier } from '../../utils/plugins/pluginIdentifier.js'
import { escapeXmlAttr } from '../../utils/xml.js'
import {
  type ChannelAllowlistEntry,
  getChannelAllowlist,
} from './channelAllowlist.js'

export const ChannelMessageNotificationSchema = lazySchema(() =>
  z.object({
    method: z.literal('notifications/claude/channel'),
    params: z.object({
      content: z.string(),
      // 透传不透明字段 — thread_id、user，或频道希望模型
      // 看到的任何内容。渲染为 <channel> 标签的属性。
      meta: z.record(z.string(), z.string()).optional(),
    }),
  }),
)

/**
 * 来自频道服务器的结构化权限回复。支持此功能的服务器
 * 声明 `capabilities.experimental['claude/channel/permission']` 并
 * 发出此事件来替代通过 notifications/claude/channel 中继
 * "yes tbxkq" 文本。每个服务器显式选择加入 — 只想
 * 中继文本的频道永远不会意外成为权限界面。
 *
 * 服务器解析用户的回复（规范：/^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i）
 * 并发出 {request_id, behavior}。CC 将 request_id 与其
 * 待处理映射进行匹配。与正则拦截方法不同，通用
 * 频道中的文本永远不会意外匹配 — 批准需要服务器
 * 故意发出此特定事件。
 */
export const CHANNEL_PERMISSION_METHOD =
  'notifications/claude/channel/permission'
export const ChannelPermissionNotificationSchema = lazySchema(() =>
  z.object({
    method: z.literal(CHANNEL_PERMISSION_METHOD),
    params: z.object({
      request_id: z.string(),
      behavior: z.enum(['allow', 'deny']),
    }),
  }),
)

/**
 * 出站：CC → 服务器。在 interactiveHandler.ts 中当权限对话框
 * 打开且服务器已声明权限能力时触发。服务器为其平台
 * 格式化消息（Telegram markdown、iMessage 富文本、Discord embed）
 * 并发送给人类。当人类回复 "yes tbxkq" 时，服务器根据
 * PERMISSION_REPLY_RE 解析并发出上述入站模式。
 *
 * 不是 zod 模式 — CC 发送此内容，不验证它。这里的类型
 * 使协议的两半可以并排记录。
 */
export const CHANNEL_PERMISSION_REQUEST_METHOD =
  'notifications/claude/channel/permission_request'
export type ChannelPermissionRequestParams = {
  request_id: string
  tool_name: string
  description: string
  /** JSON 序列化的工具输入，截断到 200 个字符并以 … 结尾。完整
   *  输入在本地终端对话框中；这是手机尺寸的
   *  预览。服务器决定是否以及如何显示它。 */
  input_preview: string
  /** 支持多聊天路由的服务器的可选源频道路由提示。
   *  向后兼容：不关心的服务器可以忽略它并保留
   *  其现有的回退行为。 */
  channel_context?: {
    source_server?: string
    chat_id?: string
  }
}

export const ChannelPermissionRequestNotificationSchema: () => AnyObjectSchema =
  lazySchema(() =>
    z.object({
      method: z.literal(CHANNEL_PERMISSION_REQUEST_METHOD),
      params: z.object({
        request_id: z.string(),
        tool_name: z.string(),
        description: z.string(),
        input_preview: z.string(),
        channel_context: z
          .object({
            source_server: z.string().optional(),
            chat_id: z.string().optional(),
          })
          .optional(),
      }),
    }),
  )

/**
 * Meta 键变为 XML 属性名称 — 精心构造的键如
 * `x="" injected="y` 会破坏属性结构。只接受
 * 看起来像普通标识符的键。这比 XML 规范更严格
 * （XML 规范允许 `:`、`.`、`-`），但实际上频道服务器只
 * 发送 `chat_id`、`user`、`thread_ts`、`message_id`。
 */
const SAFE_META_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/

export function wrapChannelMessage(
  serverName: string,
  content: string,
  meta?: Record<string, string>,
): string {
  const attrs = Object.entries(meta ?? {})
    .filter(([k]) => SAFE_META_KEY.test(k))
    .map(([k, v]) => ` ${k}="${escapeXmlAttr(v)}"`)
    .join('')
  return `<${CHANNEL_TAG} source="${escapeXmlAttr(serverName)}"${attrs}>\n${content}\n</${CHANNEL_TAG}>`
}

/**
 * 当前会话的有效允许列表。团队/企业组织可以在
 * 托管设置中设置 allowedChannelPlugins — 设置后，它会替换
 * GrowthBook 台账（管理员拥有信任决策）。未定义则回退
 * 到台账。非托管用户始终使用台账。
 *
 * 调用者已经为策略门读取了 sub/policy — 传入它们以
 * 避免重复读取 getSettingsForSource（未缓存）。
 */
export function getEffectiveChannelAllowlist(
  sub: ReturnType<typeof getSubscriptionType>,
  orgList: ChannelAllowlistEntry[] | undefined,
): {
  entries: ChannelAllowlistEntry[]
  source: 'org' | 'ledger'
} {
  if ((sub === 'team' || sub === 'enterprise') && orgList) {
    return { entries: orgList, source: 'org' }
  }
  return { entries: getChannelAllowlist(), source: 'ledger' }
}

export type ChannelGateResult =
  | { action: 'register' }
  | {
      action: 'skip'
      kind:
        | 'capability'
        | 'disabled'
        | 'auth'
        | 'policy'
        | 'session'
        | 'marketplace'
        | 'allowlist'
      reason: string
    }

/**
 * 将已连接的 MCP 服务器与用户解析的 --channels 条目进行匹配。
 * server-kind 精确匹配裸名称；plugin-kind 匹配 plugin:X:Y 的第二个
 * 段。返回匹配的条目，以便调用者可以读取其
 * kind — 这是用户的信任声明，而非从运行时形状推断。
 */
export function findChannelEntry(
  serverName: string,
  channels: readonly ChannelEntry[],
): ChannelEntry | undefined {
  // 无条件分割 — 对于像 'slack' 这样的裸名称，parts 是 ['slack']，
  // plugin-kind 分支正确地永远不会匹配（parts[0] !== 'plugin'）。
  const parts = serverName.split(':')
  return channels.find(c =>
    c.kind === 'server'
      ? serverName === c.name
      : parts[0] === 'plugin' && parts[1] === c.name,
  )
}

/**
 * 对 MCP 服务器的频道通知路径进行门控。调用者先检查
 * feature('KAIROS') || feature('KAIROS_CHANNELS')（构建时
 * 消除）。门控顺序：能力 → 运行时开关（tengu_harbor）→
 * 认证（仅 OAuth）→ 组织策略 → 会话 --channels → 允许列表。
 * API 密钥用户在认证层被阻止 — 频道需要
 * claude.ai 认证；console 组织尚无管理员选择加入界面。
 *
 *   skip      不是频道服务器，或托管组织未选择加入，或
 *             不在会话 --channels 中。连接保持；处理程序
 *             不注册。
 *   register  订阅 notifications/claude/channel。
 *
 * 哪些服务器可以连接由 allowedMcpServers 管理 —
 * 此门控只决定通知处理程序是否注册。
 */
export function gateChannelServer(
  serverName: string,
  capabilities: ServerCapabilities | undefined,
  pluginSource: string | undefined,
): ChannelGateResult {
  // 频道服务器声明 `experimental['claude/channel']: {}`（MCP 的
  // 存在信号惯用法 — 与 `tools: {}` 相同）。真值覆盖 `{}` 和
  // `true`；缺失/undefined/显式 `false` 都会失败。键匹配
  // 通知方法命名空间（notifications/claude/channel）。
  if (!capabilities?.experimental?.['claude/channel']) {
    return {
      action: 'skip',
      kind: 'capability',
      reason: 'server did not declare claude/channel capability',
    }
  }

  // 用户级会话选择加入。服务器必须被显式列在
  // --channels 中才能在此会话推送入站消息 — 防止受信任的
  // 服务器意外添加能力。
  const entry = findChannelEntry(serverName, getAllowedChannels())
  if (!entry) {
    return {
      action: 'skip',
      kind: 'session',
      reason: `server ${serverName} not in --channels list for this session`,
    }
  }

  if (entry.kind === 'plugin') {
    // Marketplace 验证：标签是意图（plugin:slack@anthropic），
    // 运行时名称只是 plugin:slack:X — 可能是 slack@anthropic 或
    // slack@evil，取决于安装了什么。在信任标签进行下面的
    // 允许列表检查之前验证它们匹配。来源在
    // addPluginScopeToServers 时存储在配置上 — undefined（非插件服务器，
    // 对于 plugin-kind 条目不应该发生）或无 @（内置/内联）
    // 都会使比较失败。
    const actual = pluginSource
      ? parsePluginIdentifier(pluginSource).marketplace
      : undefined
    if (actual !== entry.marketplace) {
      return {
        action: 'skip',
        kind: 'marketplace',
        reason: `you asked for plugin:${entry.name}@${entry.marketplace} but the installed ${entry.name} plugin is from ${actual ?? 'an unknown source'}`,
      }
    }
  }

  return { action: 'register' }
}
