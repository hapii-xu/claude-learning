/**
 * 通过频道（Telegram、iMessage、Discord）发送权限提示。
 *
 * 镜像 `BridgePermissionCallbacks` — 当 CC 遇到权限对话框时，
 * 它还会通过活跃频道发送提示，并将回复与本地 UI / bridge / hooks / 分类器
 * 进行竞速。第一个通过 claim() 解析的获胜。
 *
 * 入站是结构化事件：服务器解析用户的 "yes tbxkq" 回复，
 * 并发出 notifications/claude/channel/permission，携带
 * {request_id, behavior}。CC 永远不会将回复视为文本 — 批准
 * 需要服务器故意发出该特定事件，而不仅仅是中继内容。服务器通过声明
 * capabilities.experimental['claude/channel/permission'] 来选择加入。
 *
 * Kenneth 的"这会不会让 Claude 自我批准？"问题：批准方是
 * 通过频道操作的人类，而非 Claude。但信任边界不在
 * 终端 — 而是允许列表（tengu_harbor_ledger）。被入侵的
 * 频道服务器可以在人类看不到提示的情况下伪造 "yes <id>"。
 * 这是已接受的风险：被入侵的频道已经拥有无限的
 * 对话注入轮次（可以长期进行社会工程攻击，等待
 * acceptEdits 等）；注入后自我批准更快，但不会更
 * 强大。对话框可以拖慢被入侵的频道，但无法阻止它。
 * 参见 PR 讨论 2956440848。
 */

import { jsonStringify } from '../../utils/slowOperations.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'

/**
 * GrowthBook 运行时开关 — 与频道开关（tengu_harbor）分开，
 * 这样频道可以在不附带权限中继功能的情况下发布（Kenneth："如果
 * 明天就发布，就没有预热时间"）。默认 false；可以无需发版即可切换。
 * 在 useManageMCPConnections 挂载时检查一次 — 会话中途的
 * 标志变更不会生效，需要重启。
 */
export function isChannelPermissionRelayEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_harbor_permissions', true)
}

export type ChannelPermissionResponse = {
  behavior: 'allow' | 'deny'
  /** 回复来自哪个频道服务器（例如 "plugin:telegram:tg"）。 */
  fromServer: string
}

export type ChannelPermissionCallbacks = {
  /** 为请求 ID 注册一个解析器。返回取消订阅函数。 */
  onResponse(
    requestId: string,
    handler: (response: ChannelPermissionResponse) => void,
  ): () => void
  /** 从结构化频道事件解析一个待处理请求
   *  （notifications/claude/channel/permission）。如果该 ID 处于
   *  待处理状态则返回 true — 服务器已解析用户的回复并发出
   *  {request_id, behavior}；我们只需与待处理映射进行匹配。 */
  resolve(
    requestId: string,
    behavior: 'allow' | 'deny',
    fromServer: string,
  ): boolean
}

/**
 * 频道服务器的回复格式规范：
 *   /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
 *
 * 5 个小写字母，不含 'l'（看起来像 1/I）。不区分大小写（手机
 * 自动纠正）。不支持单独的 yes/no（对话式）。不包含前缀/后缀内容。
 *
 * CC 生成 ID 并发送提示。服务器解析用户的回复并发出
 * notifications/claude/channel/permission，携带 {request_id,
 * behavior} — CC 不再对文本进行正则匹配。导出此常量以便插件可以
 * 导入精确的正则表达式，而不是手动复制。
 */
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// 25 个字母的字母表：a-z 减去 'l'（看起来像 1/I）。25^5 ≈ 980 万组合空间。
const ID_ALPHABET = 'abcdefghijkmnopqrstuvwxyz'

// 子串黑名单 — 5 个随机字母可能拼出敏感词（Kenneth 在发布讨论中说：
// "这就是我倾向于用数字的原因，很难拼出比 80085 更糟糕的东西"）。
// 非穷举列表，覆盖了"不小心发给老板"级别的词。如果生成的 ID 包含
// 其中任何一个，则用盐值重新哈希。
// prettier-ignore
const ID_AVOID_SUBSTRINGS = [
  'fuck',
  'shit',
  'cunt',
  'cock',
  'dick',
  'twat',
  'piss',
  'crap',
  'bitch',
  'whore',
  'ass',
  'tit',
  'cum',
  'fag',
  'dyke',
  'nig',
  'kike',
  'rape',
  'nazi',
  'damn',
  'poo',
  'pee',
  'wank',
  'anus',
]

function hashToId(input: string): string {
  // FNV-1a → uint32，然后 25 进制编码。不是加密算法，只是一个稳定的
  // 短纯字母 ID。32 位 / log2(25) ≈ 6.9 个字母的熵；
  // 取 5 个稍微浪费一点，但对于这个用途绰绰有余。
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h = h >>> 0
  let s = ''
  for (let i = 0; i < 5; i++) {
    s += ID_ALPHABET[h % 25]
    h = Math.floor(h / 25)
  }
  return s
}

/**
 * 从 toolUseID 生成短 ID。从 25 个字符的字母表中取 5 个字母（a-z 减去
 * 'l' — 在许多字体中看起来像 1/I）。25^5 ≈ 980 万组合空间，
 * 50% 生日碰撞需要约 3K 个同时待处理的提示，对于单个交互会话来说
 * 荒谬地多。纯字母是为了手机用户不需要切换键盘模式
 * （十六进制交替使用 a-f/0-9 → 模式切换）。如果结果包含
 * 被屏蔽的子串，则用盐值后缀重新哈希 — 5 个随机字母可能拼出
 * 你不想在手机短信中看到的东西。toolUseID 是 `toolu_` +
 * 类 base64 格式；我们使用哈希而非截取。
 */
export function shortRequestId(toolUseID: string): string {
  // 7 个长度-3 × 3 个位置 × 25² + 15 个长度-4 × 2 × 25 + 2 个长度-5
  // ≈ 980 万个中有约 13,877 个被屏蔽 — 大约每 700 个命中一次黑名单。
  // 最多重试 10 次；(1/700)^10 几乎可以忽略。
  let candidate = hashToId(toolUseID)
  for (let salt = 0; salt < 10; salt++) {
    if (!ID_AVOID_SUBSTRINGS.some(bad => candidate.includes(bad))) {
      return candidate
    }
    candidate = hashToId(`${toolUseID}:${salt}`)
  }
  return candidate
}

/**
 * 将工具输入截断为手机尺寸的 JSON 预览。200 个字符大约
 * 是窄屏手机上 3 行的内容。完整输入在本地终端对话框中；
 * 频道只收到一个摘要，这样 Write(5KB-file) 就不会刷屏
 * 你的短信。服务器决定是否显示以及如何显示。
 */
export function truncateForPreview(input: unknown): string {
  try {
    const s = jsonStringify(input)
    return s.length > 200 ? s.slice(0, 200) + '…' : s
  } catch {
    return '(unserializable)'
  }
}

/**
 * 过滤 MCP 客户端，只保留可以中继权限提示的客户端。
 * 三个条件，必须全部满足：已连接 + 在会话的 --channels
 * 允许列表中 + 声明了两个能力。第二个能力是
 * 服务器的明确选择加入 — 纯中继频道永远不会意外成为
 * 权限界面（Kenneth 的"用户可能会感到不悦的
 * 惊讶"）。集中在此处，以便未来添加第四个条件时只需改一处。
 */
export function filterPermissionRelayClients<
  T extends {
    type: string
    name: string
    capabilities?: { experimental?: Record<string, unknown> }
  },
>(
  clients: readonly T[],
  isInAllowlist: (name: string) => boolean,
): (T & { type: 'connected' })[] {
  return clients.filter(
    (c): c is T & { type: 'connected' } =>
      c.type === 'connected' &&
      isInAllowlist(c.name) &&
      Boolean(c.capabilities?.experimental?.['claude/channel']) &&
      Boolean(c.capabilities?.experimental?.['claude/channel/permission']),
  )
}

/**
 * 回调对象的工厂函数。pending Map 通过闭包持有 — 不在
 * 模块级别（参见 src/CLAUDE.md），也不在 AppState 中
 * （状态中的函数会导致相等性/序列化问题）。与
 * `replBridgePermissionCallbacks` 相同的生命周期模式：在 React hook 内
 * 每个会话构建一次，稳定引用存储在 AppState 中。
 *
 * resolve() 从专用通知处理程序
 * （notifications/claude/channel/permission）调用，携带结构化负载。
 * 服务器已经将 "yes tbxkq" 解析为 {request_id, behavior}；我们只需
 * 与待处理映射进行匹配。CC 端不做正则 — 通用频道中的文本
 * 不会意外批准任何东西。
 */
export function createChannelPermissionCallbacks(): ChannelPermissionCallbacks {
  const pending = new Map<
    string,
    (response: ChannelPermissionResponse) => void
  >()

  return {
    onResponse(requestId, handler) {
      // 这里也用大写 — resolve() 已经做了；不对称意味着未来的
      // 调用者传入混合大小写的 ID 会静默地永远匹配不上。
      // shortRequestId 总是发出小写，所以今天这是空操作，
      // 但对称性使契约更加明确。
      const key = requestId.toLowerCase()
      pending.set(key, handler)
      return () => {
        pending.delete(key)
      }
    },

    resolve(requestId, behavior, fromServer) {
      const key = requestId.toLowerCase()
      const resolver = pending.get(key)
      if (!resolver) return false
      // 先删除再调用 — 如果 resolver 抛出异常或重入，
      // 条目已经不存在了。同时也处理重复事件（第二次
      // 发出时直接穿透 — 服务器 bug 或网络重复，忽略）。
      pending.delete(key)
      resolver({ behavior, fromServer })
      return true
    },
  }
}
