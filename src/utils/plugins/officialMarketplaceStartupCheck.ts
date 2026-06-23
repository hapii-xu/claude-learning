/**
 * Anthropic 官方 marketplace 的自动安装逻辑。
 *
 * 此模块处理在启动时为新用户自动安装官方 marketplace，
 * 并进行以下适当检查：
 * - 企业策略限制
 * - Git 可用性
 * - 之前的安装尝试
 */

import { join } from 'path'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { logEvent } from '../../services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { toError } from '../errors.js'
import { logError } from '../log.js'
import { checkGitAvailable, markGitUnavailable } from './gitAvailability.js'
import { isSourceAllowedByPolicy } from './marketplaceHelpers.js'
import {
  addMarketplaceSource,
  getMarketplacesCacheDir,
  loadKnownMarketplacesConfig,
  saveKnownMarketplacesConfig,
} from './marketplaceManager.js'
import {
  OFFICIAL_MARKETPLACE_NAME,
  OFFICIAL_MARKETPLACE_SOURCE,
} from './officialMarketplace.js'
import { fetchOfficialMarketplaceFromGcs } from './officialMarketplaceGcs.js'

/**
 * 官方 marketplace 未安装的原因
 */
export type OfficialMarketplaceSkipReason =
  | 'already_attempted'
  | 'already_installed'
  | 'policy_blocked'
  | 'git_unavailable'
  | 'gcs_unavailable'
  | 'unknown'

/**
 * 检查官方 marketplace 自动安装是否通过环境变量禁用。
 */
export function isOfficialMarketplaceAutoInstallDisabled(): boolean {
  return isEnvTruthy(
    process.env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL,
  )
}

/**
 * 重试逻辑配置
 */
export const RETRY_CONFIG = {
  MAX_ATTEMPTS: 10,
  INITIAL_DELAY_MS: 60 * 60 * 1000, // 1 小时
  BACKOFF_MULTIPLIER: 2,
  MAX_DELAY_MS: 7 * 24 * 60 * 60 * 1000, // 1 周
}

/**
 * 使用指数退避计算下次重试延迟
 */
function calculateNextRetryDelay(retryCount: number): number {
  const delay =
    RETRY_CONFIG.INITIAL_DELAY_MS *
    RETRY_CONFIG.BACKOFF_MULTIPLIER ** retryCount
  return Math.min(delay, RETRY_CONFIG.MAX_DELAY_MS)
}

/**
 * 根据失败原因和重试状态判断是否应重试安装
 */
function shouldRetryInstallation(
  config: ReturnType<typeof getGlobalConfig>,
): boolean {
  // 若从未尝试，则应尝试
  if (!config.officialMarketplaceAutoInstallAttempted) {
    return true
  }

  // 若已成功安装，则不重试
  if (config.officialMarketplaceAutoInstalled) {
    return false
  }

  const failReason = config.officialMarketplaceAutoInstallFailReason
  const retryCount = config.officialMarketplaceAutoInstallRetryCount || 0
  const nextRetryTime = config.officialMarketplaceAutoInstallNextRetryTime
  const now = Date.now()

  // 检查是否超过最大尝试次数
  if (retryCount >= RETRY_CONFIG.MAX_ATTEMPTS) {
    return false
  }

  // 永久性失败 —— 不重试
  if (failReason === 'policy_blocked') {
    return false
  }

  // 检查是否已过足够时间可以下次重试
  if (nextRetryTime && now < nextRetryTime) {
    return false
  }

  // 对临时失败（unknown）、半永久性失败（git_unavailable）
  // 以及旧版状态（重试逻辑存在之前的 undefined failReason）进行重试
  return (
    failReason === 'unknown' ||
    failReason === 'git_unavailable' ||
    failReason === 'gcs_unavailable' ||
    failReason === undefined
  )
}

/**
 * 自动安装检查的结果
 */
export type OfficialMarketplaceCheckResult = {
  /** 是否成功安装了 marketplace */
  installed: boolean
  /** 是否跳过了安装（以及原因） */
  skipped: boolean
  /** 跳过原因（若适用） */
  reason?: OfficialMarketplaceSkipReason
  /** 是否保存重试元数据到配置失败 */
  configSaveFailed?: boolean
}

/**
 * 在启动时检查并安装官方 marketplace。
 *
 * 此函数设计为在启动期间以"即发即忘"方式调用。它将：
 * 1. 检查安装是否已尝试过
 * 2. 检查 marketplace 是否已安装
 * 3. 检查企业策略限制
 * 4. 检查 Git 可用性
 * 5. 尝试安装
 * 6. 将结果记录在 GlobalConfig 中
 *
 * @returns 指示安装成功或被跳过的结果
 */
export async function checkAndInstallOfficialMarketplace(): Promise<OfficialMarketplaceCheckResult> {
  const config = getGlobalConfig()

  // 检查是否应重试安装
  if (!shouldRetryInstallation(config)) {
    const reason: OfficialMarketplaceSkipReason =
      config.officialMarketplaceAutoInstallFailReason ?? 'already_attempted'
    logForDebugging(`Official marketplace auto-install skipped: ${reason}`)
    return {
      installed: false,
      skipped: true,
      reason,
    }
  }

  try {
    // 检查是否通过环境变量禁用了自动安装
    if (isOfficialMarketplaceAutoInstallDisabled()) {
      logForDebugging(
        'Official marketplace auto-install disabled via env var, skipping',
      )
      saveGlobalConfig(current => ({
        ...current,
        officialMarketplaceAutoInstallAttempted: true,
        officialMarketplaceAutoInstalled: false,
        officialMarketplaceAutoInstallFailReason: 'policy_blocked',
      }))
      logEvent('tengu_official_marketplace_auto_install', {
        installed: false,
        skipped: true,
        policy_blocked: true,
      })
      return { installed: false, skipped: true, reason: 'policy_blocked' }
    }

    // 检查 marketplace 是否已安装
    const knownMarketplaces = await loadKnownMarketplacesConfig()
    if (knownMarketplaces[OFFICIAL_MARKETPLACE_NAME]) {
      logForDebugging(
        `Official marketplace '${OFFICIAL_MARKETPLACE_NAME}' already installed, skipping`,
      )
      // 标记为已尝试，以便不再检查
      saveGlobalConfig(current => ({
        ...current,
        officialMarketplaceAutoInstallAttempted: true,
        officialMarketplaceAutoInstalled: true,
      }))
      return { installed: false, skipped: true, reason: 'already_installed' }
    }

    // 检查企业策略限制
    if (!isSourceAllowedByPolicy(OFFICIAL_MARKETPLACE_SOURCE)) {
      logForDebugging(
        'Official marketplace blocked by enterprise policy, skipping',
      )
      saveGlobalConfig(current => ({
        ...current,
        officialMarketplaceAutoInstallAttempted: true,
        officialMarketplaceAutoInstalled: false,
        officialMarketplaceAutoInstallFailReason: 'policy_blocked',
      }))
      logEvent('tengu_official_marketplace_auto_install', {
        installed: false,
        skipped: true,
        policy_blocked: true,
      })
      return { installed: false, skipped: true, reason: 'policy_blocked' }
    }

    // inc-5046：先尝试 GCS 镜像 —— 不需要 git，也不访问 GitHub。
    // 后端（anthropic#317037）将 marketplace zip 发布到与原生二进制相同的存储桶。
    // 若 GCS 成功，以 source:'github' 注册 marketplace（仍然正确 —— GCS 是镜像），
    // 完全跳过 git。
    const cacheDir = getMarketplacesCacheDir()
    const installLocation = join(cacheDir, OFFICIAL_MARKETPLACE_NAME)
    const gcsSha = await fetchOfficialMarketplaceFromGcs(
      installLocation,
      cacheDir,
    )
    if (gcsSha !== null) {
      const known = await loadKnownMarketplacesConfig()
      known[OFFICIAL_MARKETPLACE_NAME] = {
        source: OFFICIAL_MARKETPLACE_SOURCE,
        installLocation,
        lastUpdated: new Date().toISOString(),
      }
      await saveKnownMarketplacesConfig(known)

      saveGlobalConfig(current => ({
        ...current,
        officialMarketplaceAutoInstallAttempted: true,
        officialMarketplaceAutoInstalled: true,
        officialMarketplaceAutoInstallFailReason: undefined,
        officialMarketplaceAutoInstallRetryCount: undefined,
        officialMarketplaceAutoInstallLastAttemptTime: undefined,
        officialMarketplaceAutoInstallNextRetryTime: undefined,
      }))
      logEvent('tengu_official_marketplace_auto_install', {
        installed: true,
        skipped: false,
        via_gcs: true,
      })
      return { installed: true, skipped: false }
    }
    // GCS 失败（后端写入前 404，或网络问题）。仅当熔断开关允许时才回退到 git
    // —— 与 refreshMarketplace() 的门控相同。
    if (
      !getFeatureValue_CACHED_MAY_BE_STALE(
        'tengu_plugin_official_mkt_git_fallback',
        true,
      )
    ) {
      logForDebugging(
        'Official marketplace GCS failed; git fallback disabled by flag — skipping install',
      )
      // 与下方 git_unavailable 相同的指数退避重试元数据 ——
      // 暂时性 GCS 失败应使用指数退避重试，而非放弃。
      const retryCount =
        (config.officialMarketplaceAutoInstallRetryCount || 0) + 1
      const now = Date.now()
      const nextRetryTime = now + calculateNextRetryDelay(retryCount)
      saveGlobalConfig(current => ({
        ...current,
        officialMarketplaceAutoInstallAttempted: true,
        officialMarketplaceAutoInstalled: false,
        officialMarketplaceAutoInstallFailReason: 'gcs_unavailable',
        officialMarketplaceAutoInstallRetryCount: retryCount,
        officialMarketplaceAutoInstallLastAttemptTime: now,
        officialMarketplaceAutoInstallNextRetryTime: nextRetryTime,
      }))
      logEvent('tengu_official_marketplace_auto_install', {
        installed: false,
        skipped: true,
        gcs_unavailable: true,
        retry_count: retryCount,
      })
      return { installed: false, skipped: true, reason: 'gcs_unavailable' }
    }

    // 检查 Git 可用性
    const gitAvailable = await checkGitAvailable()
    if (!gitAvailable) {
      logForDebugging(
        'Git not available, skipping official marketplace auto-install',
      )
      const retryCount =
        (config.officialMarketplaceAutoInstallRetryCount || 0) + 1
      const now = Date.now()
      const nextRetryDelay = calculateNextRetryDelay(retryCount)
      const nextRetryTime = now + nextRetryDelay

      let configSaveFailed = false
      try {
        saveGlobalConfig(current => ({
          ...current,
          officialMarketplaceAutoInstallAttempted: true,
          officialMarketplaceAutoInstalled: false,
          officialMarketplaceAutoInstallFailReason: 'git_unavailable',
          officialMarketplaceAutoInstallRetryCount: retryCount,
          officialMarketplaceAutoInstallLastAttemptTime: now,
          officialMarketplaceAutoInstallNextRetryTime: nextRetryTime,
        }))
      } catch (saveError) {
        configSaveFailed = true
        // 正确记录错误以便跟踪
        const configError = toError(saveError)
        logError(configError)

        logForDebugging(
          `Failed to save marketplace auto-install git_unavailable state: ${saveError}`,
          { level: 'error' },
        )
      }
      logEvent('tengu_official_marketplace_auto_install', {
        installed: false,
        skipped: true,
        git_unavailable: true,
        retry_count: retryCount,
      })
      return {
        installed: false,
        skipped: true,
        reason: 'git_unavailable',
        configSaveFailed,
      }
    }

    // 尝试安装
    logForDebugging('Attempting to auto-install official marketplace')
    await addMarketplaceSource(OFFICIAL_MARKETPLACE_SOURCE)

    // 成功
    logForDebugging('Successfully auto-installed official marketplace')
    const previousRetryCount =
      config.officialMarketplaceAutoInstallRetryCount || 0
    saveGlobalConfig(current => ({
      ...current,
      officialMarketplaceAutoInstallAttempted: true,
      officialMarketplaceAutoInstalled: true,
      // 成功后清除重试元数据
      officialMarketplaceAutoInstallFailReason: undefined,
      officialMarketplaceAutoInstallRetryCount: undefined,
      officialMarketplaceAutoInstallLastAttemptTime: undefined,
      officialMarketplaceAutoInstallNextRetryTime: undefined,
    }))
    logEvent('tengu_official_marketplace_auto_install', {
      installed: true,
      skipped: false,
      retry_count: previousRetryCount,
    })
    return { installed: true, skipped: false }
  } catch (error) {
    // 处理安装失败
    const errorMessage = error instanceof Error ? error.message : String(error)

    // 在 macOS 上，/usr/bin/git 是一个始终存在于 PATH 中的 xcrun shim，
    // 因此 checkGitAvailable()（仅执行 `which git`）即使未安装 Xcode CLT 也会通过。
    // shim 随后在克隆时失败，报错 "xcrun: error: invalid active developer path (...)"。
    // 毒化记忆化的可用性检查，使本会话中的其他 git 调用者干净地跳过，
    // 然后静默返回且不记录任何尝试状态 —— 下次启动时全新尝试
    // （对于实际上"git 不存在"的情况无需退避机制）。
    if (errorMessage.includes('xcrun: error:')) {
      markGitUnavailable()
      logForDebugging(
        'Official marketplace auto-install: git is a non-functional macOS xcrun shim, treating as git_unavailable',
      )
      logEvent('tengu_official_marketplace_auto_install', {
        installed: false,
        skipped: true,
        git_unavailable: true,
        macos_xcrun_shim: true,
      })
      return {
        installed: false,
        skipped: true,
        reason: 'git_unavailable',
      }
    }

    logForDebugging(
      `Failed to auto-install official marketplace: ${errorMessage}`,
      { level: 'error' },
    )
    logError(toError(error))

    const retryCount =
      (config.officialMarketplaceAutoInstallRetryCount || 0) + 1
    const now = Date.now()
    const nextRetryDelay = calculateNextRetryDelay(retryCount)
    const nextRetryTime = now + nextRetryDelay

    let configSaveFailed = false
    try {
      saveGlobalConfig(current => ({
        ...current,
        officialMarketplaceAutoInstallAttempted: true,
        officialMarketplaceAutoInstalled: false,
        officialMarketplaceAutoInstallFailReason: 'unknown',
        officialMarketplaceAutoInstallRetryCount: retryCount,
        officialMarketplaceAutoInstallLastAttemptTime: now,
        officialMarketplaceAutoInstallNextRetryTime: nextRetryTime,
      }))
    } catch (saveError) {
      configSaveFailed = true
      // 正确记录错误以便跟踪
      const configError = toError(saveError)
      logError(configError)

      logForDebugging(
        `Failed to save marketplace auto-install failure state: ${saveError}`,
        { level: 'error' },
      )

      // 即使配置保存失败也返回失败结果
      // 这确保我们正确报告安装失败
    }
    logEvent('tengu_official_marketplace_auto_install', {
      installed: false,
      skipped: true,
      failed: true,
      retry_count: retryCount,
    })

    return {
      installed: false,
      skipped: true,
      reason: 'unknown',
      configSaveFailed,
    }
  }
}
