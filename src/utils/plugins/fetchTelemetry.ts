/**
 * 插件/市场网络请求的遥测模块。
 *
 * 为 inc-5046（GitHub 投诉 claude-plugins-official 加载量）而添加。
 * 在此之前，fetch 操作只有 logForDebugging —— 无法衡量实际网络流量。
 * 此模块可呈现命中 GitHub、GCS 还是用户自托管的情况，从而观察 GCS 迁移效果，
 * 并在 GitHub 再次发邮件之前发现热路径回归问题。
 *
 * 触发量：在启动时触发（install-counts 24h TTL），
 * 以及用户显式操作时触发（安装/更新）。不会每次交互触发。
 * 信封结构类似 tengu_binary_download_*。
 */

import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS as SafeString,
} from '../../services/analytics/index.js'
import { OFFICIAL_MARKETPLACE_NAME } from './officialMarketplace.js'

export type PluginFetchSource =
  | 'install_counts'
  | 'marketplace_clone'
  | 'marketplace_pull'
  | 'marketplace_url'
  | 'plugin_clone'
  | 'mcpb'

export type PluginFetchOutcome = 'success' | 'failure' | 'cache_hit'

// 按名称上报的公共主机白名单。其他主机（企业 git、自托管、内网）
// 归入 'other' 桶 —— 不希望内部主机名（如 git.mycorp.internal）出现在遥测中。
// 有限基数也可以让仪表盘的主机分布保持可读。
const KNOWN_PUBLIC_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'gist.githubusercontent.com',
  'gitlab.com',
  'bitbucket.org',
  'codeberg.org',
  'dev.azure.com',
  'ssh.dev.azure.com',
  'storage.googleapis.com', // GCS —— Dickson 迁移目标所在位置
])

/**
 * 从 URL 或 git spec 中提取主机名并归入白名单桶。
 * 支持 `https://host/...`、`git@host:path`、`ssh://host/...` 格式。
 * 返回已知公共主机、'other'（可解析但不在白名单中 —— 不泄露私有主机名），
 * 或 'unknown'（不可解析 / 本地路径）。
 */
function extractHost(urlOrSpec: string): string {
  let host: string
  const scpMatch = /^[^@/]+@([^:/]+):/.exec(urlOrSpec)
  if (scpMatch) {
    host = scpMatch[1]!
  } else {
    try {
      host = new URL(urlOrSpec).hostname
    } catch {
      return 'unknown'
    }
  }
  const normalized = host.toLowerCase()
  return KNOWN_PUBLIC_HOSTS.has(normalized) ? normalized : 'other'
}

/**
 * 如果 URL/spec 指向 anthropics/claude-plugins-official 则返回 true ——
 * 即 GitHub 投诉的那个仓库。让仪表盘可以区分"我们自己的问题"流量与用户配置的市场。
 */
function isOfficialRepo(urlOrSpec: string): boolean {
  return urlOrSpec.includes(`anthropics/${OFFICIAL_MARKETPLACE_NAME}`)
}

export function logPluginFetch(
  source: PluginFetchSource,
  urlOrSpec: string | undefined,
  outcome: PluginFetchOutcome,
  durationMs: number,
  errorKind?: string,
): void {
  // 字符串值为有限枚举 / 仅主机名 —— 不含代码、路径或原始错误信息。
  // 隐私信封与 tengu_web_fetch_host 相同。
  logEvent('tengu_plugin_remote_fetch', {
    source: source as SafeString,
    host: (urlOrSpec ? extractHost(urlOrSpec) : 'unknown') as SafeString,
    is_official: urlOrSpec ? isOfficialRepo(urlOrSpec) : false,
    outcome: outcome as SafeString,
    duration_ms: Math.round(durationMs),
    ...(errorKind && { error_kind: errorKind as SafeString }),
  })
}

/**
 * 将错误分类为 error_kind 字段的稳定桶，保持基数有限 ——
 * 原始错误信息会导致仪表盘分组爆炸。
 *
 * 同时处理 axios Error 对象（Node.js 错误码如 ENOTFOUND）
 * 和 git stderr 字符串（如 "Could not resolve host"）。
 * DNS 检查在 timeout 之前，因为 marketplaceManager.ts:~950 的 gitClone 错误增强
 * 会将 DNS 失败重写为包含 "timeout" 字样 —— 反序会将 git DNS 误归类为 timeout。
 */
export function classifyFetchError(error: unknown): string {
  const msg = String((error as { message?: unknown })?.message ?? error)
  if (
    /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|Could not resolve host|Connection refused/i.test(
      msg,
    )
  ) {
    return 'dns_or_refused'
  }
  if (/ETIMEDOUT|timed out|timeout/i.test(msg)) return 'timeout'
  if (
    /ECONNRESET|socket hang up|Connection reset by peer|remote end hung up/i.test(
      msg,
    )
  ) {
    return 'conn_reset'
  }
  if (/403|401|authentication|permission denied/i.test(msg)) return 'auth'
  if (/404|not found|repository not found/i.test(msg)) return 'not_found'
  if (/certificate|SSL|TLS|unable to get local issuer/i.test(msg)) return 'tls'
  // Schema 验证抛出 "Invalid response format"（install_counts）——
  // 与真正的未知错误区分，让仪表盘可以单独看到"服务器返回了无效数据"。
  if (/Invalid response format|Invalid marketplace schema/i.test(msg)) {
    return 'invalid_schema'
  }
  return 'other'
}
