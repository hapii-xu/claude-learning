import { feature } from 'bun:bundle'
import type { QuerySource } from '../../constants/querySource.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { getUserContext } from '../../context.js'
import { clearSpeculativeChecks } from '@claude-code-best/builtin-tools/tools/BashTool/bashPermissions.js'
import { clearClassifierApprovals } from '../../utils/classifierApprovals.js'
import { resetGetMemoryFilesCache } from '../../utils/claudemd.js'
import { logError } from '../../utils/log.js'
import { clearSessionMessagesCache } from '../../utils/sessionStorage.js'
import { clearBetaTracingState } from '../../utils/telemetry/betaSessionTracing.js'
import { resetMicrocompactState } from './microCompact.js'

/**
 * Compact 作用域的清理回调，由 REPL 或其他长生命周期组件注册。
 * 在 runPostCompactCleanup() 期间调用，释放实例级状态
 * （如 contentReplacementState）以及模块级缓存占用的内存。
 */
const compactCleanupCallbacks: Array<() => void> = []

export function registerCompactCleanup(callback: () => void): void {
  compactCleanupCallbacks.push(callback)
}

/**
 * 压缩后运行缓存和跟踪状态的清理。
 * 在自动压缩和手动 /compact 之后调用，释放被压缩失效的跟踪结构占用的内存。
 *
 * 注意：我们有意不在此清除已调用的 skill 内容。
 * Skill 内容必须在多次压缩之间保留，以便
 * createSkillAttachmentIfNeeded() 能在后续压缩附件中包含完整的 skill 文本。
 *
 * querySource: 传入压缩请求的 source，以便跳过那些会破坏主线程
 * 模块级状态的重置。子代理（agent:*）在同一进程中运行，共享模块级状态
 * （context-collapse 存储、getMemoryFiles 一次性钩子标志、
 * getUserContext 缓存）；当子代理压缩时重置这些状态会破坏主线程的状态。
 * 所有压缩调用者都应传入 querySource —— undefined 仅对确实是
 * 仅主线程的调用者安全（/compact、/clear）。
 */
export function runPostCompactCleanup(querySource?: QuerySource): void {
  // 子代理（agent:*）在同一进程中运行，与主线程共享模块级状态。
  // 仅为主线程压缩重置主线程模块级状态（context-collapse、memory 文件缓存）。
  // 与 isMainThread（index.ts:188）相同的 startsWith 模式。
  const isMainThreadCompact =
    querySource === undefined ||
    querySource.startsWith('repl_main_thread') ||
    querySource === 'sdk'

  resetMicrocompactState()
  if (feature('CONTEXT_COLLAPSE')) {
    if (isMainThreadCompact) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      ;(
        require('../contextCollapse/index.js') as typeof import('../contextCollapse/index.js')
      ).resetContextCollapse()
      /* eslint-enable @typescript-eslint/no-require-imports */
    }
  }
  if (isMainThreadCompact) {
    // getUserContext 是包裹 getClaudeMds() → getMemoryFiles() 的缓存外层。
    // 如果只清除内层 getMemoryFiles 缓存，下一轮会命中 getUserContext 缓存，
    // 永远不会到达 getMemoryFiles()，因此已装备的 InstructionsLoaded 钩子
    // 永远不会触发。手动 /compact 已在调用点显式清除；自动压缩和响应式压缩
    // 之前没有 —— 这里集中清除，使所有压缩路径行为一致。
    getUserContext.cache.clear?.()
    resetGetMemoryFilesCache('compact')
  }
  clearSystemPromptSections()
  clearClassifierApprovals()
  clearSpeculativeChecks()
  // 有意不调用 resetSentSkillNames()：压缩后重新注入完整的
  // skill_listing（~4K tokens）纯粹是 cache_creation。模型 schema 中
  // 仍有 SkillTool，invoked_skills 保留已用 skill，动态添加由
  // skillChangeDetector / cacheUtils 重置处理。完整理由见 compactConversation()。
  clearBetaTracingState()
  if (feature('COMMIT_ATTRIBUTION')) {
    // 有意 fire-and-forget：文件内容缓存扫描是尽力而为的内存释放，
    // 没有调用者依赖其完成。保持 runPostCompactCleanup 同步让压缩调用点
    // （REPL post-compact handler、/compact 命令、autoCompact）无需额外的
    // 微任务往返就能完成自身状态转换 —— 扫描在下一次事件循环 tick 时追上。
    //
    // .catch 是必须的，即使当前 attributionHooks.ts 是空操作桩：
    // 没有它，未来恢复的 sweepFileContentCache 如果抛出异常，会变成
    // 未处理的 promise 拒绝，而该函数的同步签名让调用者无法观察到。
    void import('../../utils/attributionHooks.js')
      .then(m => m.sweepFileContentCache())
      .catch(error => {
        logError(error)
      })
  }
  clearSessionMessagesCache()
  for (const cb of compactCleanupCallbacks) {
    try {
      cb()
    } catch (error) {
      logError(error)
    }
  }
}
