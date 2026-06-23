import { execaSync } from 'execa'
import { logForDebugging } from '../debug.js'
import { execFileNoThrow } from '../execFileNoThrow.js'
import { execSyncWithDefaults_DEPRECATED } from '../execFileNoThrowPortable.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  clearKeychainCache,
  getMacOsKeychainStorageServiceName,
  getUsername,
  KEYCHAIN_CACHE_TTL_MS,
  keychainCacheState,
} from './macOsKeychainHelpers.js'
import type { SecureStorage, SecureStorageData } from './types.js'

// `security -i` 使用 4096 字节的 fgets() 缓冲区（darwin 上的 BUFSIZ）读取标准输入。
// 超过此长度的命令行会在参数中间被截断：前 4096 字节作为一个命令被消费
// （未终止的引号 → 失败），溢出部分被解释为第二个未知命令。结果：非零退出且
// 不写入任何数据，但*之前的*钥匙串条目保持完整 —— 后备存储会将其作为过期数据
// 读取。参见 #30337。
// 在限制以下预留 64 字节的余量，以防边缘情况下的行终止符计算差异。
const SECURITY_STDIN_LINE_LIMIT = 4096 - 64

export const macOsKeychainStorage = {
  name: 'keychain',
  read(): SecureStorageData | null {
    const prev = keychainCacheState.cache
    if (Date.now() - prev.cachedAt < KEYCHAIN_CACHE_TTL_MS) {
      return prev.data
    }

    try {
      const storageServiceName = getMacOsKeychainStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
      )
      const username = getUsername()
      const result = execSyncWithDefaults_DEPRECATED(
        `security find-generic-password -a "${username}" -w -s "${storageServiceName}"`,
      )
      if (result) {
        const data = jsonParse(result)
        keychainCacheState.cache = { data, cachedAt: Date.now() }
        return data
      }
    } catch (_e) {
      // 继续执行
    }
    // 过期重用：如果之前有值且刷新失败，
    // 继续提供过期值而不是缓存 null。由于 #23192
    // 在每次 API 请求（macOS 路径）时清除上游记忆化，单个
    // 瞬态 `security` 子进程生成失败会毒化缓存，并在所有子系统中
    // 显示为"未登录"，直到下次用户交互。clearKeychainCache() 设置
    // data=null，因此显式失效（登出、删除）仍会穿透读取。
    if (prev.data !== null) {
      logForDebugging('[keychain] read failed; serving stale cache', {
        level: 'warn',
      })
      keychainCacheState.cache = { data: prev.data, cachedAt: Date.now() }
      return prev.data
    }
    keychainCacheState.cache = { data: null, cachedAt: Date.now() }
    return null
  },
  async readAsync(): Promise<SecureStorageData | null> {
    const prev = keychainCacheState.cache
    if (Date.now() - prev.cachedAt < KEYCHAIN_CACHE_TTL_MS) {
      return prev.data
    }
    if (keychainCacheState.readInFlight) {
      return keychainCacheState.readInFlight
    }

    const gen = keychainCacheState.generation
    const promise = doReadAsync().then(data => {
      // 如果在读取期间缓存被失效或更新，
      // 我们的子进程结果已过期 —— 不要覆盖更新的条目。
      if (gen === keychainCacheState.generation) {
        // 过期重用 —— 镜像上方的 read()。
        if (data === null && prev.data !== null) {
          logForDebugging('[keychain] readAsync failed; serving stale cache', {
            level: 'warn',
          })
        }
        const next = data ?? prev.data
        keychainCacheState.cache = { data: next, cachedAt: Date.now() }
        keychainCacheState.readInFlight = null
        return next
      }
      return data
    })
    keychainCacheState.readInFlight = promise
    return promise
  },
  update(data: SecureStorageData): { success: boolean; warning?: string } {
    // 更新前失效缓存
    clearKeychainCache()

    try {
      const storageServiceName = getMacOsKeychainStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
      )
      const username = getUsername()
      const jsonString = jsonStringify(data)

      // 转换为十六进制以避免任何转义问题
      const hexValue = Buffer.from(jsonString, 'utf-8').toString('hex')

      // 优先使用标准输入（`security -i`），这样进程监控器（CrowdStrike 等）
      // 只看到 "security -i"，而不是有效载荷（INC-3028）。
      // 当有效载荷会溢出标准输入行缓冲区时，回退到参数列表。
      // 参数列表中的十六进制可以被有决心的观察者恢复，但可以阻止
      // 天明的明文 grep 规则，而替代方案 —— 静默凭据损坏 —— 要糟糕得多。
      // darwin 上的 ARG_MAX 是 1MB，所以参数列表对我们的目的来说几乎没有大小限制。
      const command = `add-generic-password -U -a "${username}" -s "${storageServiceName}" -X "${hexValue}"\n`

      let result
      if (command.length <= SECURITY_STDIN_LINE_LIMIT) {
        result = execaSync('security', ['-i'], {
          input: command,
          stdio: ['pipe', 'pipe', 'pipe'],
          reject: false,
        })
      } else {
        logForDebugging(
          `Keychain payload (${jsonString.length}B JSON) exceeds security -i stdin limit; using argv`,
          { level: 'warn' },
        )
        result = execaSync(
          'security',
          [
            'add-generic-password',
            '-U',
            '-a',
            username,
            '-s',
            storageServiceName,
            '-X',
            hexValue,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'], reject: false },
        )
      }

      if (result.exitCode !== 0) {
        return { success: false }
      }

      // 成功时使用新数据更新缓存
      keychainCacheState.cache = { data, cachedAt: Date.now() }
      return { success: true }
    } catch (_e) {
      return { success: false }
    }
  },
  delete(): boolean {
    // 删除前失效缓存
    clearKeychainCache()

    try {
      const storageServiceName = getMacOsKeychainStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
      )
      const username = getUsername()
      execSyncWithDefaults_DEPRECATED(
        `security delete-generic-password -a "${username}" -s "${storageServiceName}"`,
      )
      return true
    } catch (_e) {
      return false
    }
  },
} satisfies SecureStorage

async function doReadAsync(): Promise<SecureStorageData | null> {
  try {
    const storageServiceName = getMacOsKeychainStorageServiceName(
      CREDENTIALS_SERVICE_SUFFIX,
    )
    const username = getUsername()
    const { stdout, code } = await execFileNoThrow(
      'security',
      ['find-generic-password', '-a', username, '-w', '-s', storageServiceName],
      { useCwd: false, preserveOutputOnError: false },
    )
    if (code === 0 && stdout) {
      return jsonParse(stdout.trim())
    }
  } catch (_e) {
    // 继续执行
  }
  return null
}

let keychainLockedCache: boolean | undefined

/**
 * 检查 macOS 钥匙串是否被锁定。
 * 如果在 macOS 上且钥匙串被锁定（security show-keychain-info 的退出码为 36），则返回 true。
 * 这通常发生在 SSH 会话中，钥匙串不会自动解锁。
 *
 * 在进程生命周期内缓存 —— execaSync('security', ...) 是一个约 27ms 的同步
 * 子进程生成，这从渲染（AssistantTextMessage）中调用。
 * 在带有"未登录"消息的会话中进行虚拟滚动重新挂载时，
 * 每次重新挂载都会重新生成 security(1)，为提交增加 27ms/消息。
 * 钥匙串锁定状态在 CLI 会话期间不会改变。
 */
export function isMacOsKeychainLocked(): boolean {
  if (keychainLockedCache !== undefined) return keychainLockedCache
  // 仅在 macOS 上检查
  if (process.platform !== 'darwin') {
    keychainLockedCache = false
    return false
  }

  try {
    const result = execaSync('security', ['show-keychain-info'], {
      reject: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // 退出码 36 表示钥匙串被锁定
    keychainLockedCache = result.exitCode === 36
  } catch {
    // 如果命令因任何原因失败，假设钥匙串未锁定
    keychainLockedCache = false
  }
  return keychainLockedCache
}
