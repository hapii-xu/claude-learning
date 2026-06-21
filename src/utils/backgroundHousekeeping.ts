import { feature } from 'bun:bundle'
import { initAutoDream } from '../services/autoDream/autoDream.js'
import { initMagicDocs } from '../services/MagicDocs/magicDocs.js'
import { initSkillImprovement } from './hooks/skillImprovement.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const registerProtocolModule = feature('LODESTONE')
  ? (require('./deepLink/registerProtocol.js') as typeof import('./deepLink/registerProtocol.js'))
  : null

/* eslint-enable @typescript-eslint/no-require-imports */

import { getIsInteractive, getLastInteractionTime } from '../bootstrap/state.js'
import {
  cleanupNpmCacheForAnthropicPackages,
  cleanupOldMessageFilesInBackground,
  cleanupOldVersionsThrottled,
} from './cleanup.js'
import { cleanupOldVersions } from './nativeInstaller/index.js'
import { autoUpdateMarketplacesAndPluginsInBackground } from './plugins/pluginAutoupdate.js'

// 24 小时的毫秒数
const RECURRING_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

// 启动后 10 分钟。
const DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION = 10 * 60 * 1000

export function startBackgroundHousekeeping(): void {
  void initMagicDocs()
  void initSkillImprovement()
  if (feature('EXTRACT_MEMORIES')) {
    void import('../services/extractMemories/extractMemories.js')
      .then(({ initExtractMemories }) => {
        initExtractMemories()
      })
      .catch(() => {
        // 模块加载失败 —— 非关键，内存提取只是不会运行
      })
  }
  initAutoDream()
  void autoUpdateMarketplacesAndPluginsInBackground()
  if (feature('LODESTONE') && getIsInteractive()) {
    void registerProtocolModule!.ensureDeepLinkProtocolRegistered()
  }

  let needsCleanup = true
  async function runVerySlowOps(): Promise<void> {
    // 如果用户在过去一分钟内有操作，不要让他们等待这些慢操作运行。
    if (
      getIsInteractive() &&
      getLastInteractionTime() > Date.now() - 1000 * 60
    ) {
      setTimeout(
        runVerySlowOps,
        DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION,
      ).unref()
      return
    }

    if (needsCleanup) {
      needsCleanup = false
      await cleanupOldMessageFilesInBackground()
    }

    // 如果用户在过去一分钟内有操作，不要让他们等待这些慢操作运行。
    if (
      getIsInteractive() &&
      getLastInteractionTime() > Date.now() - 1000 * 60
    ) {
      setTimeout(
        runVerySlowOps,
        DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION,
      ).unref()
      return
    }

    await cleanupOldVersions()
  }

  setTimeout(
    runVerySlowOps,
    DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION,
  ).unref()

  // 对于长时间运行的会话，每 24 小时调度一次定期清理。
  // 两个清理函数都使用标记文件和锁来限制为每天一次，
  // 如果另一个进程持有锁则立即跳过。
  if (process.env.USER_TYPE === 'ant') {
    const interval = setInterval(() => {
      void cleanupNpmCacheForAnthropicPackages()
      void cleanupOldVersionsThrottled()
    }, RECURRING_CLEANUP_INTERVAL_MS)

    // 不要让这个 interval 阻止进程退出
    interval.unref()
  }
}
