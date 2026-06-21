import { posix, win32 } from 'path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { getPlatform } from './platform.js'

// 跟踪警告以避免刷屏 — 设置上限以防止内存无限增长
export const MAX_WARNING_KEYS = 1000
const warningCounts = new Map<string, number>()

// 检查是否从构建目录运行（开发模式）
// 这是 getCurrentInstallationType() 中逻辑的同步版本
function isRunningFromBuildDirectory(): boolean {
  let invokedPath = process.argv[1] || ''
  let execPath = process.execPath || process.argv[0] || ''

  // 在 Windows 上，将反斜杠转换为正斜杠以保持一致的路径匹配
  if (getPlatform() === 'windows') {
    invokedPath = invokedPath.split(win32.sep).join(posix.sep)
    execPath = execPath.split(win32.sep).join(posix.sep)
  }

  const pathsToCheck = [invokedPath, execPath]
  const buildDirs = [
    '/build-ant/',
    '/build-external/',
    '/build-external-native/',
    '/build-ant-native/',
  ]

  return pathsToCheck.some(path => buildDirs.some(dir => path.includes(dir)))
}

// 我们已知并希望向用户屏蔽的警告
const INTERNAL_WARNINGS = [
  /MaxListenersExceededWarning.*AbortSignal/,
  /MaxListenersExceededWarning.*EventTarget/,
]

function isInternalWarning(warning: Error): boolean {
  const warningStr = `${warning.name}: ${warning.message}`
  return INTERNAL_WARNINGS.some(pattern => pattern.test(warningStr))
}

// 存储警告处理器引用，以便检测是否已安装
let warningHandler: ((warning: Error) => void) | null = null

export function initializeWarningHandler(): void {
  // 只设置一次处理器 — 检查我们的处理器是否已安装
  const currentListeners = process.listeners('warning')
  if (warningHandler && currentListeners.includes(warningHandler)) {
    return
  }

  // 对于外部用户，移除默认 Node.js 处理器以抑制 stderr 输出
  // 对于内部用户，仅在开发构建中保留默认警告
  // 直接检查开发模式以避免 init 中的异步调用
  // 这保留了与 getCurrentInstallationType() 相同的逻辑但无需异步
  const isDevelopment =
    process.env.NODE_ENV === 'development' || isRunningFromBuildDirectory()
  if (!isDevelopment) {
    process.removeAllListeners('warning')
  }

  // 创建并存储我们的警告处理器
  warningHandler = (warning: Error) => {
    try {
      const warningKey = `${warning.name}: ${warning.message.slice(0, 50)}`
      const count = warningCounts.get(warningKey) || 0

      // 限制 map 大小以防止唯一警告键导致内存无限增长。
      // 达到上限后，新的唯一键不再被追踪 — 其在分析中的
      // occurrence_count 将始终报告为 1。
      if (
        warningCounts.has(warningKey) ||
        warningCounts.size < MAX_WARNING_KEYS
      ) {
        warningCounts.set(warningKey, count + 1)
      }

      const isInternal = isInternalWarning(warning)

      // 始终记录到 Statsig 以进行监控
      // 仅对 ant 用户包含完整详情，因为它们可能包含代码或文件路径
      logEvent('tengu_node_warning', {
        is_internal: isInternal ? 1 : 0,
        occurrence_count: count + 1,
        classname:
          warning.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...(process.env.USER_TYPE === 'ant' && {
          message:
            warning.message as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
      })

      // 在调试模式下，显示所有带上下文的警告
      if (isEnvTruthy(process.env.CLAUDE_DEBUG)) {
        const prefix = isInternal ? '[Internal Warning]' : '[Warning]'
        logForDebugging(`${prefix} ${warning.toString()}`, { level: 'warn' })
      }
      // 对所有用户隐藏警告 — 它们仅记录到 Statsig 用于监控
    } catch {
      // 静默失败 — 我们不希望警告处理器引发问题
    }
  }

  // 安装警告处理器
  process.on('warning', warningHandler)
}
