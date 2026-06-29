import { GrowthBook } from '@growthbook/growthbook'
import { isEqual, memoize } from 'lodash-es'
import {
  getIsNonInteractiveSession,
  getSessionTrustAccepted,
} from '../../bootstrap/state.js'
import { getGrowthBookClientKey } from '../../constants/keys.js'
import {
  checkHasTrustDialogAccepted,
  getGlobalConfig,
  saveGlobalConfig,
} from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { toError } from '../../utils/errors.js'
import { getAuthHeaders } from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import { createSignal } from '../../utils/signal.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  type GitHubActionsMetadata,
  getUserForGrowthBook,
} from '../../utils/user.js'
import {
  is1PEventLoggingEnabled,
  logGrowthBookExperimentTo1P,
} from './firstPartyEventLogger.js'

/**
 * 发送给 GrowthBook 用于定向的用户属性。
 * 使用 UUID 后缀（非 Uuid）以与 GrowthBook 命名规范对齐。
 */
export type GrowthBookUserAttributes = {
  id: string
  sessionId: string
  deviceID: string
  platform: 'win32' | 'darwin' | 'linux'
  apiBaseUrlHost?: string
  organizationUUID?: string
  accountUUID?: string
  userType?: string
  subscriptionType?: string
  rateLimitTier?: string
  firstTokenTime?: number
  email?: string
  appVersion?: string
  github?: GitHubActionsMetadata
}

/**
 * API 返回的格式错误的 feature 响应，使用 "value" 而非 "defaultValue"。
 * 这是在 API 修复之前的临时解决方案。
 */
type MalformedFeatureDefinition = {
  value?: unknown
  defaultValue?: unknown
  [key: string]: unknown
}

let client: GrowthBook | null = null

// 具名 handler 引用，供 resetGrowthBook 移除以防止积累
let currentBeforeExitHandler: (() => void) | null = null
let currentExitHandler: (() => void) | null = null

// 跟踪客户端创建时鉴权是否可用
// 用于检测何时需要用新鲜的 auth 头重建客户端
let clientCreatedWithAuth = false

// 从 payload 存储实验数据，供后续记录曝光
type StoredExperimentData = {
  experimentId: string
  variationId: number
  inExperiment?: boolean
  hashAttribute?: string
  hashValue?: string
}
const experimentDataByFeature = new Map<string, StoredExperimentData>()

// 远程评估 feature 值的缓存——SDK 未遵守 remoteEval 响应的临时解决方案
// SDK 的 setForcedFeatures 也不能与 remoteEval 可靠配合
const remoteEvalFeatureValues = new Map<string, unknown>()

// 跟踪初始化前访问的 feature，这些需要记录曝光
const pendingExposures = new Set<string>()

// 跟踪本会话已记录曝光的 feature（去重）
// 防止在热路径中反复调用 getFeatureValue_CACHED_MAY_BE_STALE 时
// 触发重复曝光事件（如渲染循环中的 isAutoMemoryEnabled）
const loggedExposures = new Set<string>()

// 跟踪安全门控检查的重初始化 promise
// 当 GrowthBook 重初始化时（如鉴权变更后），安全门控检查
// 应等待 init 完成，避免返回过期值
let reinitializingPromise: Promise<unknown> | null = null

// GrowthBook feature 值刷新时通知的监听器（初始化或定期刷新）。
// 用于在构造时将 feature 值烘焙进长生命周期对象的系统
// （如 firstPartyEventLogger 读取 tengu_1p_event_batch_config 一次并构建 LoggerProvider），
// 当配置变更时需要重建。每次调用的读取器（如 getEventSamplingConfig / isSinkKilled）
// 无需此机制——它们已经是响应式的。
//
// resetGrowthBook 不会清除——订阅者注册一次（通常在 init.ts 中），
// 必须在鉴权变更重置时存活。
type GrowthBookRefreshListener = () => void | Promise<void>
const refreshed = createSignal()

/** 调用监听器，同步抛出和异步拒绝均路由到 logError。 */
function callSafe(listener: GrowthBookRefreshListener): void {
  try {
    // Promise.resolve() 规范化同步返回值和 Promise，
    // 使同步抛出（被外层 try 捕获）和异步拒绝（被 .catch 捕获）
    // 都到达 logError。若无 .catch，拒绝的异步监听器会成为
    // 未处理的拒绝——try/catch 只能看到 Promise，看不到最终的拒绝。
    void Promise.resolve(listener()).catch(e => {
      logError(e)
    })
  } catch (e) {
    logError(e)
  }
}

/**
 * 注册在 GrowthBook feature 值刷新时触发的回调。
 * 返回取消订阅函数。
 *
 * 若调用时 init 已携带 feature 完成（remoteEvalFeatureValues 已填充），
 * 监听器会在下一个微任务中触发一次。这个"追赶"处理了 GB 网络响应
 * 早于 REPL useEffect 提交的竞争——在快速网络和 MCP 密集配置的外部构建中，
 * init 可在 ~100ms 完成而 REPL 挂载需 ~600ms（见 #20951 外部构建追踪
 * 30.540 vs 31.046）。
 *
 * 变更检测由订阅者负责：每次刷新时回调触发；
 * 对上次看到的配置使用 isEqual 决定是否执行。
 */
export function onGrowthBookRefresh(
  listener: GrowthBookRefreshListener,
): () => void {
  let subscribed = true
  const unsubscribe = refreshed.subscribe(() => callSafe(listener))
  if (remoteEvalFeatureValues.size > 0) {
    queueMicrotask(() => {
      // 重检查：注册和微任务执行之间，监听器可能已被移除，
      // 或 resetGrowthBook 可能已清除 Map。
      if (subscribed && remoteEvalFeatureValues.size > 0) {
        callSafe(listener)
      }
    })
  }
  return () => {
    subscribed = false
    unsubscribe()
  }
}

/**
 * 解析 GrowthBook feature 的环境变量覆盖。
 * 将 CLAUDE_INTERNAL_FC_OVERRIDES 设为 JSON 对象（feature key 到值的映射）
 * 可绕过远程评估和磁盘缓存。适用于需要测试特定 feature flag 配置的评估框架。
 * 仅在 USER_TYPE 为 'ant' 时激活。
 *
 * 示例：CLAUDE_INTERNAL_FC_OVERRIDES='{"my_feature": true, "my_config": {"key": "val"}}'
 */
let envOverrides: Record<string, unknown> | null = null
let envOverridesParsed = false

function getEnvOverrides(): Record<string, unknown> | null {
  if (!envOverridesParsed) {
    envOverridesParsed = true
    if (process.env.USER_TYPE === 'ant') {
      const raw = process.env.CLAUDE_INTERNAL_FC_OVERRIDES
      if (raw) {
        try {
          envOverrides = JSON.parse(raw) as Record<string, unknown>
          logForDebugging(
            `GrowthBook: Using env var overrides for ${Object.keys(envOverrides!).length} features: ${Object.keys(envOverrides!).join(', ')}`,
          )
        } catch {
          logError(
            new Error(
              `GrowthBook: Failed to parse CLAUDE_INTERNAL_FC_OVERRIDES: ${raw}`,
            ),
          )
        }
      }
    }
  }
  return envOverrides
}

/**
 * 检查 feature 是否有环境变量覆盖（CLAUDE_INTERNAL_FC_OVERRIDES）。
 * 若为 true，_CACHED_MAY_BE_STALE 将返回覆盖值而不访问磁盘或网络——
 * 调用方可跳过对该 feature 的 init 等待。
 */
export function hasGrowthBookEnvOverride(feature: string): boolean {
  const overrides = getEnvOverrides()
  return overrides !== null && feature in overrides
}

/**
 * 通过 /config Gates 标签页设置的本地配置覆盖（仅 ant）。
 * 在环境变量覆盖之后检查——环境变量优先，使评估框架保持确定性。
 * 与 getEnvOverrides 不同，此函数不做 memoize：用户可在运行时修改覆盖，
 * 而 getGlobalConfig() 已做内存缓存（指针追踪），直到下次 saveGlobalConfig() 失效。
 */
function getConfigOverrides(): Record<string, unknown> | undefined {
  console.error(
    '[DEBUG growthbook] getConfigOverrides: USER_TYPE =',
    process.env.USER_TYPE,
  )
  if (process.env.USER_TYPE !== 'ant') return undefined
  try {
    const overrides = getGlobalConfig().growthBookOverrides
    console.error(
      '[DEBUG growthbook] getConfigOverrides: growthBookOverrides =',
      JSON.stringify(overrides),
    )
    return overrides
  } catch (e) {
    console.error(
      '[DEBUG growthbook] getConfigOverrides: getGlobalConfig() threw:',
      e,
    )
    return undefined
  }
}

/**
 * 枚举所有已知 GrowthBook feature 及其当前解析值（不含覆盖）。
 * 优先内存 payload，回退磁盘缓存——与 getter 优先级相同。
 * 由 /config Gates 标签页使用。
 */
export function getAllGrowthBookFeatures(): Record<string, unknown> {
  if (remoteEvalFeatureValues.size > 0) {
    return Object.fromEntries(remoteEvalFeatureValues)
  }
  return getGlobalConfig().cachedGrowthBookFeatures ?? {}
}

export function getGrowthBookConfigOverrides(): Record<string, unknown> {
  return getConfigOverrides() ?? {}
}

/**
 * 设置或清除单个配置覆盖。传入 undefined 以清除。
 * 触发 onGrowthBookRefresh 监听器，使将门控值烘焙进长生命周期对象的系统
 * （useMainLoopModel、useSkillsChange 等）重建——否则如覆盖
 * tengu_ant_model_override 直到下次定期刷新才会实际改变模型。
 */
export function setGrowthBookConfigOverride(
  feature: string,
  value: unknown,
): void {
  if (process.env.USER_TYPE !== 'ant') return
  try {
    saveGlobalConfig(c => {
      const current = c.growthBookOverrides ?? {}
      if (value === undefined) {
        if (!(feature in current)) return c
        const { [feature]: _, ...rest } = current
        if (Object.keys(rest).length === 0) {
          const { growthBookOverrides: __, ...configWithout } = c
          return configWithout
        }
        return { ...c, growthBookOverrides: rest }
      }
      if (isEqual(current[feature], value)) return c
      return { ...c, growthBookOverrides: { ...current, [feature]: value } }
    })
    // 订阅者自行检测变更（参见 onGrowthBookRefresh 文档），
    // 在无操作写入时触发也没问题。
    refreshed.emit()
  } catch (e) {
    logError(e)
  }
}

export function clearGrowthBookConfigOverrides(): void {
  if (process.env.USER_TYPE !== 'ant') return
  try {
    saveGlobalConfig(c => {
      if (
        !c.growthBookOverrides ||
        Object.keys(c.growthBookOverrides).length === 0
      ) {
        return c
      }
      const { growthBookOverrides: _, ...rest } = c
      return rest
    })
    refreshed.emit()
  } catch (e) {
    logError(e)
  }
}

/**
 * 若 feature 有实验数据，则记录实验曝光。
 * 会话内去重——每个 feature 最多记录一次。
 */
function logExposureForFeature(feature: string): void {
  // 本会话已记录则跳过（去重）
  if (loggedExposures.has(feature)) {
    return
  }

  const expData = experimentDataByFeature.get(feature)
  if (expData) {
    loggedExposures.add(feature)
    logGrowthBookExperimentTo1P({
      experimentId: expData.experimentId,
      variationId: expData.variationId,
      userAttributes: getUserAttributes(),
      experimentMetadata: {
        feature_id: feature,
      },
    })
  }
}

/**
 * 处理来自 GrowthBook 服务器的远程评估 payload 并填充本地缓存。
 * 在初始 client.init() 和 client.refreshFeatures() 之后均调用，
 * 使 _BLOCKS_ON_INIT 调用方在整个进程生命周期中看到新鲜值，而非仅 init 时的快照。
 *
 * 若刷新时不运行此函数，remoteEvalFeatureValues 会冻结在 init 时的快照，
 * getDynamicConfig_BLOCKS_ON_INIT 在整个进程生命周期返回过期值——
 * 这破坏了长运行会话的 tengu_max_version_config 终止开关。
 */
async function processRemoteEvalPayload(
  gbClient: GrowthBook,
): Promise<boolean> {
  // 临时方案：转换远程评估响应格式
  // API 返回 { "value": ... } 但 SDK 期望 { "defaultValue": ... }
  // TODO: API 修复返回正确格式后移除此处理
  const payload = gbClient.getPayload()
  // 空对象是 truthy——若无 length 检查，`{features: {}}`
  //（服务器瞬时 bug、截断响应）会通过，清空下方 map，返回 true，
  // syncRemoteEvalToDisk 会将 `{}` 整体写入磁盘：导致共享 ~/.hclaude.json
  // 的所有进程完全屏蔽 flag。
  if (!payload?.features || Object.keys(payload.features).length === 0) {
    return false
  }

  // 重建前清除，防止刷新间被删除的 feature 留下过期幽灵条目
  // 短路 getFeatureValueInternal。
  experimentDataByFeature.clear()

  const transformedFeatures: Record<string, MalformedFeatureDefinition> = {}
  for (const [key, feature] of Object.entries(payload.features)) {
    const f = feature as MalformedFeatureDefinition
    if ('value' in f && !('defaultValue' in f)) {
      transformedFeatures[key] = {
        ...f,
        defaultValue: f.value,
      }
    } else {
      transformedFeatures[key] = f
    }

    // 存储实验数据，供 feature 被访问时记录
    if (f.source === 'experiment' && f.experimentResult) {
      const expResult = f.experimentResult as {
        variationId?: number
      }
      const exp = f.experiment as { key?: string } | undefined
      if (exp?.key && expResult.variationId !== undefined) {
        experimentDataByFeature.set(key, {
          experimentId: exp.key,
          variationId: expResult.variationId,
        })
      }
    }
  }
  // 用转换后的 feature 重新设置 payload
  await gbClient.setPayload({
    ...payload,
    features: transformedFeatures,
  })

  // 临时方案：直接从远程评估响应缓存评估值。
  // SDK 的 evalFeature() 尝试在本地重新评估规则，忽略 remoteEval 的预评估 'value'。
  // setForcedFeatures 也不可靠。因此我们自行缓存值并在 getFeatureValueInternal 中使用。
  remoteEvalFeatureValues.clear()
  for (const [key, feature] of Object.entries(transformedFeatures)) {
    // 在 remoteEval:true 下服务器预评估。无论答案在 `value`（当前 API）
    // 还是 `defaultValue`（TODO 后的 API 格式），都是该用户的权威值。
    // 同时守卫两者使 syncRemoteEvalToDisk 在 API 部分或完全迁移时均正确。
    const v = 'value' in feature ? feature.value : feature.defaultValue
    if (v !== undefined) {
      remoteEvalFeatureValues.set(key, v)
    }
  }
  return true
}

/**
 * 将完整的 remoteEvalFeatureValues map 写入磁盘。每次成功的
 * processRemoteEvalPayload 恰好调用一次——不从失败路径调用，
 * 因此 init 超时中毒在结构上不可能（init 处的 .catch() 永不到达此处）。
 *
 * 整体替换（非合并）：服务端删除的 feature 在下次成功 payload 时从磁盘删除。
 * Ant 构建 ⊇ 外部构建，切换构建安全——写入始终是该进程 SDK key 的完整答案。
 */
function syncRemoteEvalToDisk(): void {
  const fresh = Object.fromEntries(remoteEvalFeatureValues)
  const config = getGlobalConfig()
  if (isEqual(config.cachedGrowthBookFeatures, fresh)) {
    return
  }
  saveGlobalConfig(current => ({
    ...current,
    cachedGrowthBookFeatures: fresh,
  }))
}

/**
 * GrowthBook feature 门控的本地默认覆盖。
 *
 * 当 GrowthBook 未连接时（如无 1P 事件日志、无适配器），
 * 使用这些值代替硬编码默认值（通常为 false）。
 * 允许在无需 GrowthBook 服务器连接的情况下启用有真实实现的 feature。
 *
 * 设置 CLAUDE_CODE_DISABLE_LOCAL_GATES=1 可绕过这些默认值。
 *
 * 分类：
 *   P0 — 纯本地 feature（无外部依赖）
 *   P1 — 需要 Claude API（任意有效 API key 均可）
 *   KS — 终止开关（默认 true，保持为 true）
 */
const LOCAL_GATE_DEFAULTS: Record<string, unknown> = {
  // ── P0：纯本地 feature ──────────────────────────────────────
  tengu_keybinding_customization_release: true, // 自定义快捷键
  tengu_streaming_tool_execution2: true, // 流式工具执行
  tengu_kairos_cron: true, // Cron/计划任务
  tengu_amber_json_tools: true, // token 高效 JSON 工具（约节省 4.5%）
  tengu_immediate_model_command: true, // 查询期间即时 /model、/fast、/effort
  tengu_basalt_3kr: true, // MCP 指令增量（仅发送变更）
  tengu_pebble_leaf_prune: true, // 会话存储叶节点裁剪
  tengu_chair_sermon: true, // 消息合并（合并相邻块）
  tengu_lodestone_enabled: true, // 深度链接协议（claude://）
  tengu_auto_background_agents: true, // 120 秒后自动后台 agent
  tengu_fgts: true, // 系统提示中的细粒度工具状态

  // ── P1：依赖 API 的 feature ───────────────────────────────────
  tengu_session_memory: true, // 会话记忆（跨会话持久化）
  tengu_passport_quail: true, // 自动记忆提取
  tengu_moth_copse: true, // 跳过记忆索引，使用预获取的记忆
  tengu_coral_fern: true, // "搜索历史上下文"区域
  tengu_chomp_inflection: true, // 提示建议
  tengu_hive_evidence: true, // 验证 agent
  tengu_kairos_brief: true, // 简报模式
  tengu_kairos_brief_config: { enable_slash_command: true }, // 简报 /slash 命令可见性
  tengu_sedge_lantern: true, // 离开摘要
  tengu_onyx_plover: { enabled: true }, // 自动记忆整合
  tengu_willow_mode: 'dialog', // 空闲返回提示

  // ── 终止开关（保持 true 以防远端禁用）──────────
  tengu_turtle_carbon: true, // Ultrathink 扩展思考
  tengu_amber_stoat: true, // 内置 Explore/Plan agent
  tengu_amber_flint: true, // Agent 团队/群体
  tengu_slim_subagent_claudemd: true, // 子 agent 的精简 CLAUDE.md
  tengu_birch_trellis: true, // tree-sitter bash 安全分析
  tengu_collage_kaleidoscope: true, // macOS 剪贴板图片读取
  tengu_compact_cache_prefix: true, // 压缩期间复用提示缓存
  tengu_kairos_assistant: true, // KAIROS 助手模式激活
  tengu_kairos_cron_durable: true, // 持久化 cron 任务
  tengu_attribution_header: true, // API 请求归因头
  tengu_slate_prism: true, // Agent 进度摘要

  // ── Ultrareview（通过 CCR 的云端代码审查）─────────────────────
  tengu_review_bughunter_config: { enabled: true }, // /ultrareview 命令可见性
  tengu_ccr_bundle_seed_enabled: true, // Bundle seed：分支模式跳过 GitHub App 检查
}

/**
 * 查找本地门控默认值。若未配置则返回 undefined，
 * 允许调用方穿透到原始 defaultValue。
 */
function getLocalGateDefault(feature: string): unknown | undefined {
  if (process.env.CLAUDE_CODE_DISABLE_LOCAL_GATES) {
    return undefined
  }
  return LOCAL_GATE_DEFAULTS[feature]
}

/**
 * 检查是否应启用 GrowthBook 操作
 */
function isGrowthBookEnabled(): boolean {
  // 适配器模式：有自定义服务器配置时直接启用
  if (process.env.CLAUDE_GB_ADAPTER_URL && process.env.CLAUDE_GB_ADAPTER_KEY) {
    return true
  }
  // GrowthBook depends on 1P event logging.
  return is1PEventLoggingEnabled()
}

/**
 * ANTHROPIC_BASE_URL 指向非 Anthropic 代理时的主机名。
 *
 * 企业代理部署（Epic、Marble 等）通常使用 apiKeyHelper 鉴权，
 * 这意味着 isAnthropicAuthEnabled() 返回 false，
 * organizationUUID/accountUUID/email 均不在 GrowthBook 属性中。
 * 若无此属性，就没有稳定的属性来定向这些用户——只有每设备 ID。
 * 参见 src/utils/auth.ts isAnthropicAuthEnabled()。
 *
 * 对未设置/默认值（api.anthropic.com）返回 undefined，使直接 API 用户
 * 不包含此属性。仅主机名——不含路径/查询/凭证。
 */
export function getApiBaseUrlHost(): string | undefined {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return undefined
  try {
    const host = new URL(baseUrl).host
    if (host === 'api.anthropic.com') return undefined
    return host
  } catch {
    return undefined
  }
}

/**
 * 从 CoreUserData 获取 GrowthBook 用户属性
 */
function getUserAttributes(): GrowthBookUserAttributes {
  const user = getUserForGrowthBook()

  // 对 ant 员工，即使设置了 ANTHROPIC_API_KEY 也始终尝试包含 OAuth 配置中的 email。
  // 确保 GrowthBook 按 email 定向无论鉴权方式如何都能工作。
  let email = user.email
  if (!email && process.env.USER_TYPE === 'ant') {
    email = getGlobalConfig().oauthAccount?.emailAddress
  }

  const apiBaseUrlHost = getApiBaseUrlHost()

  const attributes = {
    id: user.deviceId,
    sessionId: user.sessionId,
    deviceID: user.deviceId,
    platform: user.platform,
    ...(apiBaseUrlHost && { apiBaseUrlHost }),
    ...(user.organizationUuid && { organizationUUID: user.organizationUuid }),
    ...(user.accountUuid && { accountUUID: user.accountUuid }),
    ...(user.userType && { userType: user.userType }),
    ...(user.subscriptionType && { subscriptionType: user.subscriptionType }),
    ...(user.rateLimitTier && { rateLimitTier: user.rateLimitTier }),
    ...(user.firstTokenTime && { firstTokenTime: user.firstTokenTime }),
    ...(email && { email }),
    ...(user.appVersion && { appVersion: user.appVersion }),
    ...(user.githubActionsMetadata && {
      githubActionsMetadata: user.githubActionsMetadata,
    }),
  }
  return attributes
}

/**
 * 获取或创建 GrowthBook 客户端实例
 */
const getGrowthBookClient = memoize(
  (): { client: GrowthBook; initialized: Promise<void> } | null => {
    if (!isGrowthBookEnabled()) {
      return null
    }

    const attributes = getUserAttributes()
    const clientKey = getGrowthBookClientKey()
    const baseUrl =
      process.env.CLAUDE_GB_ADAPTER_URL ||
      (process.env.USER_TYPE === 'ant'
        ? process.env.CLAUDE_CODE_GB_BASE_URL || 'https://api.anthropic.com/'
        : 'https://api.anthropic.com/')
    const isAdapterMode = !!(
      process.env.CLAUDE_GB_ADAPTER_URL && process.env.CLAUDE_GB_ADAPTER_KEY
    )
    if (process.env.USER_TYPE === 'ant') {
      logForDebugging(
        `GrowthBook: Creating client with clientKey=${clientKey}, attributes: ${jsonStringify(attributes)}`,
      )
    }

    // 若信任尚未建立则跳过鉴权
    // 这防止在信任对话框前执行 apiKeyHelper 命令
    // 非交互式会话隐式具有工作区信任
    // getSessionTrustAccepted() 处理 TrustDialog 自动解决但未持久化
    // 特定 CWD（如主目录）信任的情况——showSetupScreens() 在信任对话流程完成后设置此项。
    const hasTrust =
      checkHasTrustDialogAccepted() ||
      getSessionTrustAccepted() ||
      getIsNonInteractiveSession()
    const authHeaders = hasTrust
      ? getAuthHeaders()
      : { headers: {}, error: 'trust not established' }
    // 适配器模式下不需要 auth，GrowthBook Cloud 用 clientKey 即可
    const hasAuth = isAdapterMode || !authHeaders.error
    clientCreatedWithAuth = hasAuth

    // 捕获到局部变量，使 init 回调操作的是当前客户端，
    // 而非 init 完成前重初始化产生的后续客户端
    const thisClient = new GrowthBook({
      apiHost: baseUrl,
      clientKey,
      attributes,
      // remoteEval 仅适用于 Anthropic 内部 API，GrowthBook Cloud 不支持
      remoteEval: !isAdapterMode,
      // cacheKeyAttributes 仅在 remoteEval 时有效
      ...(!isAdapterMode
        ? { cacheKeyAttributes: ['id', 'organizationUUID'] }
        : {}),
      // 若有可用鉴权头则添加
      ...(authHeaders.error
        ? {}
        : { apiHostRequestHeaders: authHeaders.headers }),
      // Ant 员工的调试日志
      ...(process.env.USER_TYPE === 'ant'
        ? {
            log: (msg: string, ctx: Record<string, unknown>) => {
              logForDebugging(`GrowthBook: ${msg} ${jsonStringify(ctx)}`)
            },
          }
        : {}),
    })
    client = thisClient

    if (!hasAuth) {
      // 暂无鉴权——跳过 HTTP init，依赖磁盘缓存值。
      // initializeGrowthBook() 在鉴权可用时会重置并重建。
      return { client: thisClient, initialized: Promise.resolve() }
    }

    const initialized = thisClient
      .init({ timeout: 5000 })
      .then(async result => {
        // 守卫：若此客户端已被更新的客户端替换，跳过处理
        if (client !== thisClient) {
          if (process.env.USER_TYPE === 'ant') {
            logForDebugging(
              'GrowthBook: Skipping init callback for replaced client',
            )
          }
          return
        }

        if (process.env.USER_TYPE === 'ant') {
          logForDebugging(
            `GrowthBook initialized, source: ${result.source}, success: ${result.success}`,
          )
        }

        const hadFeatures = await processRemoteEvalPayload(thisClient)
        // 重检查：processRemoteEvalPayload 在 `await setPayload` 处让出。
        // 目前仅微任务（无加密、无粘性桶服务），但此回调顶部的守卫
        // 在该 await 之前运行；这个在之后运行。
        if (client !== thisClient) return

        if (hadFeatures) {
          for (const feature of pendingExposures) {
            logExposureForFeature(feature)
          }
          pendingExposures.clear()
          syncRemoteEvalToDisk()
          // 通知订阅者：remoteEvalFeatureValues 已填充且磁盘已同步。
          // _CACHED_MAY_BE_STALE 优先读内存（#22295），订阅者立即看到新鲜值。
          refreshed.emit()
        }

        // 记录已加载的 feature
        if (process.env.USER_TYPE === 'ant') {
          const features = thisClient.getFeatures()
          if (features) {
            const featureKeys = Object.keys(features)
            logForDebugging(
              `GrowthBook loaded ${featureKeys.length} features: ${featureKeys.slice(0, 10).join(', ')}${featureKeys.length > 10 ? '...' : ''}`,
            )
          }
        }
      })
      .catch(error => {
        if (process.env.USER_TYPE === 'ant') {
          logError(toError(error))
        }
      })

    // 注册清理 handler 以优雅关闭（具名引用供 resetGrowthBook 移除）
    currentBeforeExitHandler = () => client?.destroy()
    currentExitHandler = () => client?.destroy()
    process.on('beforeExit', currentBeforeExitHandler)
    process.on('exit', currentExitHandler)

    return { client: thisClient, initialized }
  },
)

/**
 * 初始化 GrowthBook 客户端（阻塞直到就绪）
 */
export const initializeGrowthBook = memoize(
  async (): Promise<GrowthBook | null> => {
    let clientWrapper = getGrowthBookClient()
    if (!clientWrapper) {
      return null
    }

    // 检查客户端创建后鉴权是否变得可用
    // 若是，需要用新鲜的 auth 头重建客户端
    // 仅在信任建立后检查，避免在信任对话框前触发 apiKeyHelper
    if (!clientCreatedWithAuth) {
      const hasTrust =
        checkHasTrustDialogAccepted() ||
        getSessionTrustAccepted() ||
        getIsNonInteractiveSession()
      if (hasTrust) {
        const currentAuth = getAuthHeaders()
        if (!currentAuth.error) {
          if (process.env.USER_TYPE === 'ant') {
            logForDebugging(
              'GrowthBook: Auth became available after client creation, reinitializing',
            )
          }
          // 使用 resetGrowthBook 正确销毁旧客户端并停止定期刷新
          // 防止旧客户端 init promise 继续运行导致的双重初始化
          resetGrowthBook()
          clientWrapper = getGrowthBookClient()
          if (!clientWrapper) {
            return null
          }
        }
      }
    }

    await clientWrapper.initialized

    // 成功初始化后设置定期刷新
    // 在此处调用（而非单独调用）以确保每次重初始化后都重新建立
    setupPeriodicGrowthBookRefresh()

    return clientWrapper.client
  },
)

/**
 * 获取带默认回退的 feature 值——阻塞直到初始化。
 * @internal 被废弃函数和缓存函数均使用。
 */
async function getFeatureValueInternal<T>(
  feature: string,
  defaultValue: T,
  logExposure: boolean,
): Promise<T> {
  // 优先检查环境变量覆盖（用于评估框架）
  const overrides = getEnvOverrides()
  if (overrides && feature in overrides) {
    return overrides[feature] as T
  }
  const configOverrides = getConfigOverrides()
  if (configOverrides && feature in configOverrides) {
    return configOverrides[feature] as T
  }

  if (!isGrowthBookEnabled()) {
    const localDefault = getLocalGateDefault(feature)
    return localDefault !== undefined ? (localDefault as T) : defaultValue
  }

  const growthBookClient = await initializeGrowthBook()
  if (!growthBookClient) {
    const localDefault = getLocalGateDefault(feature)
    return localDefault !== undefined ? (localDefault as T) : defaultValue
  }

  // 若有可用的远程评估缓存值则使用（SDK bug 的临时解决方案）
  let result: T
  if (remoteEvalFeatureValues.has(feature)) {
    result = remoteEvalFeatureValues.get(feature) as T
  } else {
    result = growthBookClient.getFeatureValue(feature, defaultValue) as T
  }

  // 使用存储的实验数据记录实验曝光
  if (logExposure) {
    logExposureForFeature(feature)
  }

  if (process.env.USER_TYPE === 'ant') {
    logForDebugging(
      `GrowthBook: getFeatureValue("${feature}") = ${jsonStringify(result)}`,
    )
  }
  return result
}

/**
 * @deprecated 请使用非阻塞的 getFeatureValue_CACHED_MAY_BE_STALE 代替。
 * 此函数阻塞 GrowthBook 初始化，可能拖慢启动。
 */
export async function getFeatureValue_DEPRECATED<T>(
  feature: string,
  defaultValue: T,
): Promise<T> {
  return getFeatureValueInternal(feature, defaultValue, true)
}

/**
 * 立即从磁盘缓存获取 feature 值。纯读取——磁盘由每次成功 payload
 * （init + 定期刷新）时的 syncRemoteEvalToDisk 填充，非此函数填充。
 *
 * 这是启动关键路径和同步上下文的首选方法。
 * 若缓存由上次进程写入则值可能过期。
 */
export function getFeatureValue_CACHED_MAY_BE_STALE<T>(
  feature: string,
  defaultValue: T,
): T {
  const _debug = feature === 'tengu_sage_compass'
  // 优先检查环境变量覆盖（用于评估框架）
  const overrides = getEnvOverrides()
  if (overrides && feature in overrides) {
    if (_debug)
      console.error(
        '[DEBUG getFeatureValue] hit: envOverrides =',
        JSON.stringify(overrides[feature]),
      )
    return overrides[feature] as T
  }
  const configOverrides = getConfigOverrides()
  if (configOverrides && feature in configOverrides) {
    if (_debug)
      console.error(
        '[DEBUG getFeatureValue] hit: configOverrides =',
        JSON.stringify(configOverrides[feature]),
      )
    return configOverrides[feature] as T
  }
  if (_debug)
    console.error(
      '[DEBUG getFeatureValue] miss configOverrides. isGrowthBookEnabled =',
      isGrowthBookEnabled(),
    )

  if (!isGrowthBookEnabled()) {
    const localDefault = getLocalGateDefault(feature)
    if (_debug)
      console.error(
        '[DEBUG getFeatureValue] GrowthBook disabled. localDefault =',
        localDefault,
      )
    return localDefault !== undefined ? (localDefault as T) : defaultValue
  }

  // LOCAL_GATE_DEFAULTS 优先于远程值和磁盘缓存。
  // 在 fork/自托管部署中，GrowthBook 服务器可能为我们有意启用的门控推送 false。
  // 本地默认值代表项目的有意配置，覆盖除环境/配置覆盖之外的一切
  // （后者是明确的用户意图）。
  const localDefault = getLocalGateDefault(feature)
  if (localDefault !== undefined) {
    if (_debug)
      console.error('[DEBUG getFeatureValue] hit: localDefault =', localDefault)
    return localDefault as T
  }

  // 若有实验数据则记录曝光，否则推迟到 init 后
  if (experimentDataByFeature.has(feature)) {
    logExposureForFeature(feature)
  } else {
    pendingExposures.add(feature)
  }

  // processRemoteEvalPayload 运行后，内存 payload 具有权威性。
  if (remoteEvalFeatureValues.has(feature)) {
    if (_debug)
      console.error(
        '[DEBUG getFeatureValue] hit: remoteEvalFeatureValues =',
        remoteEvalFeatureValues.get(feature),
      )
    return remoteEvalFeatureValues.get(feature) as T
  }

  // 回退到磁盘缓存（跨进程重启存活）
  try {
    const cached = getGlobalConfig().cachedGrowthBookFeatures?.[feature]
    if (_debug)
      console.error(
        '[DEBUG getFeatureValue] diskCache cachedGrowthBookFeatures[tengu_sage_compass] =',
        cached,
      )
    if (cached !== undefined) {
      return cached as T
    }
  } catch {
    if (_debug)
      console.error(
        '[DEBUG getFeatureValue] diskCache threw, falling to defaultValue',
      )
    // 配置尚未初始化——穿透到 defaultValue
  }
  if (_debug)
    console.error(
      '[DEBUG getFeatureValue] returning defaultValue =',
      JSON.stringify(defaultValue),
    )
  return defaultValue
}

/**
 * @deprecated 磁盘缓存现在在每次成功 payload 加载时同步
 * （init + 20 分钟/6 小时定期刷新）。per-feature TTL 从未从服务器
 * 获取新数据——仅将内存状态重写到磁盘，现已冗余。
 * 直接使用 getFeatureValue_CACHED_MAY_BE_STALE。
 */
export function getFeatureValue_CACHED_WITH_REFRESH<T>(
  feature: string,
  defaultValue: T,
  _refreshIntervalMs: number,
): T {
  return getFeatureValue_CACHED_MAY_BE_STALE(feature, defaultValue)
}

/**
 * 通过 GrowthBook 检查 Statsig feature gate 值，回退到 Statsig 缓存。
 *
 * **仅用于迁移**：此函数用于将现有 Statsig gate 迁移到 GrowthBook。
 * 新 feature 请使用 `getFeatureValue_CACHED_MAY_BE_STALE()` 代替。
 *
 * - 优先检查 GrowthBook 磁盘缓存
 * - 迁移期间回退到 Statsig 的 cachedStatsigGates
 * - 若缓存未近期更新，值可能过期
 *
 * @deprecated 新代码请使用 getFeatureValue_CACHED_MAY_BE_STALE()。
 * 此函数仅为支持现有 Statsig gate 迁移而存在。
 */
export function checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
  gate: string,
): boolean {
  // 优先检查环境变量覆盖（用于评估框架）
  const overrides = getEnvOverrides()
  if (overrides && gate in overrides) {
    return Boolean(overrides[gate])
  }
  const configOverrides = getConfigOverrides()
  if (configOverrides && gate in configOverrides) {
    return Boolean(configOverrides[gate])
  }

  if (!isGrowthBookEnabled()) {
    const localDefault = getLocalGateDefault(gate)
    return localDefault !== undefined ? Boolean(localDefault) : false
  }

  // 若有实验数据则记录曝光，否则推迟到 init 后
  if (experimentDataByFeature.has(gate)) {
    logExposureForFeature(gate)
  } else {
    pendingExposures.add(gate)
  }

  // 立即从磁盘返回缓存值
  // 先检查 GrowthBook 缓存，再回退到 Statsig 缓存（迁移期）
  try {
    const config = getGlobalConfig()
    const gbCached = config.cachedGrowthBookFeatures?.[gate]
    if (gbCached !== undefined) {
      return Boolean(gbCached)
    }
    // 迁移期回退到 Statsig 缓存
    const statsigCached = config.cachedStatsigGates?.[gate]
    if (statsigCached !== undefined) {
      return statsigCached
    }
  } catch {
    // 配置尚未初始化——穿透到本地门控默认值
  }
  // 两个缓存均无值（或配置未初始化）——使用本地门控默认值
  const localDefault = getLocalGateDefault(gate)
  return localDefault !== undefined ? Boolean(localDefault) : false
}

/**
 * 检查安全限制门控，若正在重初始化则等待。
 *
 * 用于鉴权变更后需要新鲜值的安全关键门控。
 *
 * 行为：
 * - 若 GrowthBook 正在重初始化（如登录后），等待其完成
 * - 否则立即返回缓存值（先 Statsig 缓存，再 GrowthBook）
 *
 * 安全相关检查时先检查 Statsig 缓存作为安全措施：
 * 若 Statsig 缓存表明门控已启用，则遵从它。
 */
export async function checkSecurityRestrictionGate(
  gate: string,
): Promise<boolean> {
  // 优先检查环境变量覆盖（用于评估框架）
  const overrides = getEnvOverrides()
  if (overrides && gate in overrides) {
    return Boolean(overrides[gate])
  }
  const configOverrides = getConfigOverrides()
  if (configOverrides && gate in configOverrides) {
    return Boolean(configOverrides[gate])
  }

  if (!isGrowthBookEnabled()) {
    return false
  }

  // 若重初始化正在进行，等待其完成
  // 确保鉴权变更后获取新鲜值
  if (reinitializingPromise) {
    await reinitializingPromise
  }

  // 先检查 Statsig 缓存——可能有上次已登录会话的正确值
  const config = getGlobalConfig()
  const statsigCached = config.cachedStatsigGates?.[gate]
  if (statsigCached !== undefined) {
    return Boolean(statsigCached)
  }

  // 再检查 GrowthBook 缓存
  const gbCached = config.cachedGrowthBookFeatures?.[gate]
  if (gbCached !== undefined) {
    return Boolean(gbCached)
  }

  // 无缓存——返回 false（不为未缓存的门控阻塞 init）
  return false
}

/**
 * 检查布尔权益门控，有"回退到阻塞"语义。
 *
 * 快速路径：若磁盘缓存已为 `true`，立即返回。
 * 慢速路径：若磁盘为 `false`/缺失，等待 GrowthBook init 并获取新鲜服务器值（最多约 5s）。
 * 磁盘由 init 内的 syncRemoteEvalToDisk 填充，慢速路径返回时磁盘已有新鲜值——
 * 此处无需写入。
 *
 * 用于基于订阅/组织门控的用户调用 feature（如 /remote-control），
 * 其中过期的 `false` 会不公平地阻止访问，但过期的 `true` 可接受
 * （服务器是真正的门控者）。
 */
export async function checkGate_CACHED_OR_BLOCKING(
  gate: string,
): Promise<boolean> {
  // 优先检查环境变量覆盖（用于评估框架）
  const overrides = getEnvOverrides()
  if (overrides && gate in overrides) {
    return Boolean(overrides[gate])
  }
  const configOverrides = getConfigOverrides()
  if (configOverrides && gate in configOverrides) {
    return Boolean(configOverrides[gate])
  }

  if (!isGrowthBookEnabled()) {
    const localDefault = getLocalGateDefault(gate)
    return localDefault !== undefined ? Boolean(localDefault) : false
  }

  // 快速路径：磁盘缓存已为 true——信任它
  const cached = getGlobalConfig().cachedGrowthBookFeatures?.[gate]
  if (cached === true) {
    // 若有实验数据则记录曝光，否则推迟
    if (experimentDataByFeature.has(gate)) {
      logExposureForFeature(gate)
    } else {
      pendingExposures.add(gate)
    }
    return true
  }

  // 慢速路径：磁盘为 false/缺失——可能过期，获取新鲜值
  return getFeatureValueInternal(gate, false, true)
}

/**
 * 鉴权变更（登录/登出）后刷新 GrowthBook。
 *
 * 注意：必须销毁并重建客户端，因为 GrowthBook 的
 * apiHostRequestHeaders 在客户端创建后无法更新。
 */
export function refreshGrowthBookAfterAuthChange(): void {
  if (!isGrowthBookEnabled()) {
    return
  }

  try {
    // 完全重置客户端以获取新鲜的 auth 头
    // 这是必要的，因为 apiHostRequestHeaders 在创建后无法更新
    resetGrowthBook()

    // resetGrowthBook 清除了 remoteEvalFeatureValues。若下方重初始化
    // 超时（hadFeatures=false）或因 !hasAuth（登出）短路，
    // init 回调通知永不触发——订阅者保持与上一账户 memoize 状态同步。
    // 在此通知使其立即重读（回退到磁盘缓存）。若重初始化成功，
    // 将以新鲜值再次通知；否则至少同步到重置后状态。
    refreshed.emit()

    // 用新鲜的 auth 头和属性重初始化
    // 跟踪此 promise 使安全门控检查可以等待。
    // .catch 在 .finally 之前：initializeGrowthBook 在其同步辅助函数抛出时
    // 可能拒绝（getGrowthBookClient、getAuthHeaders、resetGrowthBook——
    // clientWrapper.initialized 本身有自己的 .catch 所以永不拒绝），
    // 且 .finally 以原始拒绝重新沉降——下方的同步 try/catch 无法捕获异步拒绝。
    reinitializingPromise = initializeGrowthBook()
      .catch(error => {
        logError(toError(error))
        return null
      })
      .finally(() => {
        reinitializingPromise = null
      })
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      throw error
    }
    logError(toError(error))
  }
}

/**
 * 重置 GrowthBook 客户端状态（主要用于测试）
 */
export function resetGrowthBook(): void {
  stopPeriodicGrowthBookRefresh()
  // 在销毁客户端前移除 process handler，防止累积
  if (currentBeforeExitHandler) {
    process.off('beforeExit', currentBeforeExitHandler)
    currentBeforeExitHandler = null
  }
  if (currentExitHandler) {
    process.off('exit', currentExitHandler)
    currentExitHandler = null
  }
  client?.destroy()
  client = null
  clientCreatedWithAuth = false
  reinitializingPromise = null
  experimentDataByFeature.clear()
  pendingExposures.clear()
  loggedExposures.clear()
  remoteEvalFeatureValues.clear()
  getGrowthBookClient.cache?.clear?.()
  initializeGrowthBook.cache?.clear?.()
  envOverrides = null
  envOverridesParsed = false
}

// 定期刷新间隔（与 Statsig 的 6 小时间隔一致）
const GROWTHBOOK_REFRESH_INTERVAL_MS =
  process.env.USER_TYPE !== 'ant'
    ? 6 * 60 * 60 * 1000 // 6 小时
    : 20 * 60 * 1000 // 20 分钟（ant 员工）
let refreshInterval: ReturnType<typeof setInterval> | null = null
let beforeExitListener: (() => void) | null = null

/**
 * 轻量刷新——从服务器重新获取 feature，不重建客户端。
 * 用于 auth 头未变更时的定期刷新。
 *
 * 与销毁并重建客户端的 refreshGrowthBookAfterAuthChange() 不同，
 * 此函数保留客户端状态，仅获取新鲜 feature 值。
 */
export async function refreshGrowthBookFeatures(): Promise<void> {
  if (!isGrowthBookEnabled()) {
    return
  }

  try {
    const growthBookClient = await initializeGrowthBook()
    if (!growthBookClient) {
      return
    }

    await growthBookClient.refreshFeatures()

    // 守卫：若此客户端在飞行中刷新期间被替换
    // （如 refreshGrowthBookAfterAuthChange 运行），跳过过期 payload 的处理。
    // 与上方 init 回调守卫镜像。
    if (growthBookClient !== client) {
      if (process.env.USER_TYPE === 'ant') {
        logForDebugging(
          'GrowthBook: Skipping refresh processing for replaced client',
        )
      }
      return
    }

    // 从刷新后的 payload 重建 remoteEvalFeatureValues，使
    // _BLOCKS_ON_INIT 调用者（如自动更新 kill switch 的 getMaxVersion）
    // 看到新鲜值，而非过期的 init 时快照。
    const hadFeatures = await processRemoteEvalPayload(growthBookClient)
    // 与 init 路径相同的重检查：覆盖 processRemoteEvalPayload 内
    // setPayload 的让出（上方守卫仅覆盖 refreshFeatures）。
    if (growthBookClient !== client) return

    if (process.env.USER_TYPE === 'ant') {
      logForDebugging('GrowthBook: 轻量刷新完成')
    }

    // 以 hadFeatures 为门控：若 payload 为空/畸形，
    // remoteEvalFeatureValues 未重建——跳过无效磁盘写入
    // 和多余的订阅者抖动（clearCommandMemoizationCaches
    // + getCommands + 4× 模型重渲染）。
    if (hadFeatures) {
      syncRemoteEvalToDisk()
      refreshed.emit()
    }
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      throw error
    }
    logError(toError(error))
  }
}

/**
 * 设置 GrowthBook feature 的定期刷新。
 * 使用轻量刷新（refreshGrowthBookFeatures）重新获取而不重建客户端。
 *
 * 初始化后为长时间运行的会话调用，确保 feature 值保持新鲜。
 * 与 Statsig 的 6 小时刷新间隔一致。
 */
export function setupPeriodicGrowthBookRefresh(): void {
  if (!isGrowthBookEnabled()) {
    return
  }

  // 清除现有间隔以避免重复
  if (refreshInterval) {
    clearInterval(refreshInterval)
  }

  refreshInterval = setInterval(() => {
    void refreshGrowthBookFeatures()
  }, GROWTHBOOK_REFRESH_INTERVAL_MS)
  // 允许进程自然退出——此定时器不应阻止进程退出
  refreshInterval.unref?.()

  // 仅注册一次清理监听器
  if (!beforeExitListener) {
    beforeExitListener = () => {
      stopPeriodicGrowthBookRefresh()
    }
    process.once('beforeExit', beforeExitListener)
  }
}

/**
 * 停止定期刷新（用于测试或清理）
 */
export function stopPeriodicGrowthBookRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval)
    refreshInterval = null
  }
  if (beforeExitListener) {
    process.removeListener('beforeExit', beforeExitListener)
    beforeExitListener = null
  }
}

// ============================================================================
// Dynamic Config 函数
// 这些是围绕 feature 函数的语义封装，用于 Statsig API 兼容。
// 在 GrowthBook 中，动态配置只是具有对象值的 feature。
// ============================================================================

/**
 * 获取动态配置值——阻塞直到 GrowthBook 初始化。
 * 启动关键路径请首选 getFeatureValue_CACHED_MAY_BE_STALE。
 */
export async function getDynamicConfig_BLOCKS_ON_INIT<T>(
  configName: string,
  defaultValue: T,
): Promise<T> {
  return getFeatureValue_DEPRECATED(configName, defaultValue)
}

/**
 * 立即从磁盘缓存获取动态配置值。纯读取——参见
 * getFeatureValue_CACHED_MAY_BE_STALE。
 * 这是启动关键路径和同步上下文的首选方法。
 *
 * 在 GrowthBook 中，动态配置只是具有对象值的 feature。
 */
export function getDynamicConfig_CACHED_MAY_BE_STALE<T>(
  configName: string,
  defaultValue: T,
): T {
  return getFeatureValue_CACHED_MAY_BE_STALE(configName, defaultValue)
}
