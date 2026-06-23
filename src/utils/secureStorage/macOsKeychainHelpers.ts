/**
 * 在 keychainPrefetch.ts 和 macOsKeychainStorage.ts 之间共享的轻量级辅助函数。
 *
 * 本模块禁止导入 execa、execFileNoThrow 或
 * execFileNoThrowPortable。keychainPrefetch.ts 在 main.tsx 的最顶部触发
 * （在它并行化的约 65ms 模块求值之前），而 Bun 的
 * __esm 包装器会在访问任何符号时求值整个模块——
 * 因此这里引入重量级的传递导入会破坏预取效果。仅 execa →
 * human-signals → cross-spawn 的调用链就会产生约 58ms 的同步初始化开销。
 *
 * 下方的导入（envUtils、oauth 常量、crypto、os）在 main.tsx:5 的
 * startupProfiler.ts 中已经被求值过，所以当 keychainPrefetch.ts 引入本文件时
 * 不会增加额外的模块初始化成本。
 */

import { createHash } from 'crypto'
import { userInfo } from 'os'
import { getOauthConfig } from 'src/constants/oauth.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import type { SecureStorageData } from './types.js'

// 用于区分 OAuth 凭据钥匙串条目和旧版
// API 密钥条目（后者不使用后缀）的后缀。两者共享服务名称基础部分。
// 切勿修改此值——它是钥匙串查找键的一部分，修改后会导致
// 已存储的凭据无法被找到。
export const CREDENTIALS_SERVICE_SUFFIX = '-credentials'

export function getMacOsKeychainStorageServiceName(
  serviceSuffix: string = '',
): string {
  const configDir = getClaudeConfigHomeDir()
  const isDefaultDir = !process.env.CLAUDE_CONFIG_DIR

  // 使用配置目录路径的哈希值创建唯一且稳定的后缀
  // 仅为非默认目录添加后缀以保持向后兼容
  const dirHash = isDefaultDir
    ? ''
    : `-${createHash('sha256').update(configDir).digest('hex').substring(0, 8)}`
  return `Claude Code${getOauthConfig().OAUTH_FILE_SUFFIX}${serviceSuffix}${dirHash}`
}

export function getUsername(): string {
  try {
    return process.env.USER || userInfo().username
  } catch {
    return 'claude-code-user'
  }
}

// --

// 钥匙串读取缓存，用于避免重复调用开销较大的 security CLI。
// TTL 限制跨进程场景下的数据过期时间（另一个 CC 实例
// 刷新/作废令牌），同时避免每次读取都触发阻塞式的 spawnSync。
// 进程内写入通过 clearKeychainCache() 直接使缓存失效。
//
// 同步 read() 路径每次 `security` 子进程调用约需 500ms。在启动时有
// 50+ 个 claude.ai MCP 连接器进行认证的情况下，较短的 TTL 会在
// 启动高峰期过期并触发重复的同步读取——已观察到 5.5 秒的事件循环阻塞
// （go/ccshare/adamj-20260326-212235）。30 秒的跨进程数据过期是可以接受的：
// OAuth 令牌的过期时间以小时计，唯一的跨进程写入者是另一个
// CC 实例的 /login 或令牌刷新操作。
//
// 放在这里（而非 macOsKeychainStorage.ts）是为了让 keychainPrefetch.ts
// 能够预热缓存而不引入 execa。用对象包装是因为 ES 模块的
// `let` 绑定在模块边界之间不可写——本文件和
// macOsKeychainStorage.ts 都需要修改全部三个字段。
export const KEYCHAIN_CACHE_TTL_MS = 30_000

export const keychainCacheState: {
  cache: { data: SecureStorageData | null; cachedAt: number } // cachedAt 为 0 表示无效
  // 每次缓存失效时递增。readAsync() 在启动子进程前捕获此值，
  // 如果存在更新的代数则跳过缓存写入，防止
  // 过期的子进程结果覆盖 update() 写入的新数据。
  generation: number
  // 去重并发的 readAsync() 调用，确保 TTL 过期时在高负载下
  // 只启动一个子进程而非 N 个。失效时清空，防止新的读取
  // 加入已过期的进行中 promise。
  readInFlight: Promise<SecureStorageData | null> | null
} = {
  cache: { data: null, cachedAt: 0 },
  generation: 0,
  readInFlight: null,
}

export function clearKeychainCache(): void {
  keychainCacheState.cache = { data: null, cachedAt: 0 }
  keychainCacheState.generation++
  keychainCacheState.readInFlight = null
}

/**
 * 从预取结果（keychainPrefetch.ts）预热钥匙串缓存。
 * 仅在缓存尚未被修改时写入——如果同步 read() 或
 * update() 已经执行过，其结果是权威的，我们将丢弃预取结果。
 */
export function primeKeychainCacheFromPrefetch(stdout: string | null): void {
  if (keychainCacheState.cache.cachedAt !== 0) return
  let data: SecureStorageData | null = null
  if (stdout) {
    try {
      // eslint-disable-next-line custom-rules/no-direct-json-operations -- jsonParse() 会将 slowOperations（lodash-es/cloneDeep）引入早期启动导入链；参见文件头部注释
      data = JSON.parse(stdout)
    } catch {
      // 预取结果格式错误——交由同步 read() 重新获取
      return
    }
  }
  keychainCacheState.cache = { data, cachedAt: Date.now() }
}
