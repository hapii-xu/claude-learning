/**
 * 最小化模块，在 main.tsx 模块求值期间并行触发 macOS 钥匙串读取，
 * 与 settings/mdm/rawRead.ts 中的 startMdmRawRead() 模式相同。
 *
 * isRemoteManagedSettingsEligible() 在 applySafeConfigEnvironmentVariables()
 * 期间通过同步 execSync 顺序读取两个独立的钥匙串条目：
 *   1. "Claude Code-credentials"（OAuth 令牌）  — 约 32ms
 *   2. "Claude Code"（旧版 API 密钥）           — 约 33ms
 * 顺序执行总耗时：每次 macOS 启动约 65ms。
 *
 * 在此处同时触发两者可让子进程与 main.tsx 导入的约 65ms 并行运行。
 * ensureKeychainPrefetchCompleted() 在 main.tsx preAction 中与
 * ensureMdmSettingsLoaded() 一同被 await — 几乎无成本，因为子进程
 * 在导入求值期间就已完成。同步 read() 和
 * getApiKeyFromConfigOrMacOSKeychain() 随后直接命中缓存。
 *
 * 导入保持最小化：仅 child_process + macOsKeychainHelpers.ts（而非
 * macOsKeychainStorage.ts — 后者会引入 execa → human-signals →
 * cross-spawn，约 58ms 的同步模块初始化开销）。helpers 文件自身的
 * 导入链（envUtils、oauth 常量、crypto）在 startupProfiler.ts
 * main.tsx:5 处已完成求值，因此此处无新增模块初始化成本。
 */

import { execFile } from 'child_process'
import { isBareMode } from '../envUtils.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getMacOsKeychainStorageServiceName,
  getUsername,
  primeKeychainCacheFromPrefetch,
} from './macOsKeychainHelpers.js'

const KEYCHAIN_PREFETCH_TIMEOUT_MS = 10_000

// 与 auth.ts 中的 getApiKeyFromConfigOrMacOSKeychain() 共享，
// 使其可在预取已完成时跳过同步 spawn。
// 区分"未启动"（null）和"已完成但无密钥"（{ stdout: null }），
// 让同步读取器只信任已完成的预取结果。
let legacyApiKeyPrefetch: { stdout: string | null } | null = null

let prefetchPromise: Promise<void> | null = null

type SpawnResult = { stdout: string | null; timedOut: boolean }

function spawnSecurity(serviceName: string): Promise<SpawnResult> {
  return new Promise(resolve => {
    execFile(
      'security',
      ['find-generic-password', '-a', getUsername(), '-w', '-s', serviceName],
      { encoding: 'utf-8', timeout: KEYCHAIN_PREFETCH_TIMEOUT_MS },
      (err, stdout) => {
        // 退出码 44（条目未找到）是有效的"无密钥"结果，
        // 可安全地以 null 填充缓存。但超时（err.killed）意味着
        // 钥匙串中可能有密钥但未能获取 — 不填充缓存，
        // 让同步 spawn 重试。
        resolve({
          stdout: err ? null : stdout?.trim() || null,
          timedOut: Boolean(err && 'killed' in err && err.killed),
        })
      },
    )
  })
}

/**
 * 并行触发两个钥匙串读取。在 main.tsx 顶层、
 * startMdmRawRead() 之后立即调用。非 darwin 平台为空操作。
 */
export function startKeychainPrefetch(): void {
  if (process.platform !== 'darwin' || prefetchPromise || isBareMode()) return

  // 立即触发两个子进程（非阻塞）。它们彼此并行运行，
  // 同时也与 main.tsx 的导入并行。后续的 await 在
  // ensureKeychainPrefetchCompleted() 的 Promise.all 中执行。
  const oauthSpawn = spawnSecurity(
    getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX),
  )
  const legacySpawn = spawnSecurity(getMacOsKeychainStorageServiceName())

  prefetchPromise = Promise.all([oauthSpawn, legacySpawn]).then(
    ([oauth, legacy]) => {
      // 超时的预取：不填充缓存。同步 read/spawn 会以自身
      // （更长的）超时重试。此处若填充 null 会遮蔽同步路径
      // 可能成功获取的密钥。
      if (!oauth.timedOut) primeKeychainCacheFromPrefetch(oauth.stdout)
      if (!legacy.timedOut) legacyApiKeyPrefetch = { stdout: legacy.stdout }
    },
  )
}

/**
 * 等待预取完成。在 main.tsx preAction 中与
 * ensureMdmSettingsLoaded() 一同调用 — 几乎无成本，因为子进程
 * 在 main.tsx 导入的约 65ms 内就已完成。非 darwin 平台立即 resolve。
 */
export async function ensureKeychainPrefetchCompleted(): Promise<void> {
  if (prefetchPromise) await prefetchPromise
}

/**
 * 由 auth.ts 中的 getApiKeyFromConfigOrMacOSKeychain() 在
 * 回退到同步 execSync 之前调用。若预取尚未完成则返回 null。
 */
export function getLegacyApiKeyPrefetchResult(): {
  stdout: string | null
} | null {
  return legacyApiKeyPrefetch
}

/**
 * 清除预取结果。与 getApiKeyFromConfigOrMacOSKeychain 的
 * 缓存失效一同调用，避免过时的预取结果遮蔽新写入的值。
 */
export function clearLegacyApiKeyPrefetch(): void {
  legacyApiKeyPrefetch = null
}
