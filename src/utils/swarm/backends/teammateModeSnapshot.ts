/**
 * Teammate 模式快照模块。
 *
 * 在会话启动时捕获 teammate 模式，遵循与
 * hooksConfigSnapshot.ts 相同的模式。这确保运行时配置变更
 * 不会影响当前会话的 teammate 模式。
 */

import { getGlobalConfig } from '../../../utils/config.js'
import { logForDebugging } from '../../../utils/debug.js'
import { logError } from '../../../utils/log.js'

export type TeammateMode = 'auto' | 'tmux' | 'windows-terminal' | 'in-process'

// 模块级变量，保存启动时捕获的模式
let initialTeammateMode: TeammateMode | null = null

// CLI 覆盖值（如果提供了 --teammate-mode，则在 capture 之前设置）
let cliTeammateModeOverride: TeammateMode | null = null

/**
 * 设置 teammate 模式的 CLI 覆盖值。
 * 必须在 captureTeammateModeSnapshot() 之前调用。
 */
export function setCliTeammateModeOverride(mode: TeammateMode): void {
  cliTeammateModeOverride = mode
}

/**
 * 获取当前的 CLI 覆盖值（如果有）。
 * 如果未设置 CLI 覆盖值，则返回 null。
 */
export function getCliTeammateModeOverride(): TeammateMode | null {
  return cliTeammateModeOverride
}

/**
 * 清除 CLI 覆盖值并将快照更新为新模式。
 * 当用户在 UI 中更改设置时调用，使其更改生效。
 *
 * @param newMode - 用户选择的新模式（直接传入以避免竞态条件）
 */
export function clearCliTeammateModeOverride(newMode: TeammateMode): void {
  cliTeammateModeOverride = null
  initialTeammateMode = newMode
  logForDebugging(
    `[TeammateModeSnapshot] CLI override cleared, new mode: ${newMode}`,
  )
}

/**
 * 在会话启动时捕获 teammate 模式。
 * 在 main.tsx 中早期调用，CLI 参数解析之后执行。
 * CLI 覆盖值优先于配置。
 */
export function captureTeammateModeSnapshot(): void {
  if (cliTeammateModeOverride) {
    initialTeammateMode = cliTeammateModeOverride
    logForDebugging(
      `[TeammateModeSnapshot] Captured from CLI override: ${initialTeammateMode}`,
    )
  } else {
    const config = getGlobalConfig()
    initialTeammateMode = config.teammateMode ?? 'auto'
    logForDebugging(
      `[TeammateModeSnapshot] Captured from config: ${initialTeammateMode}`,
    )
  }
}

/**
 * 获取本次会话的 teammate 模式。
 * 返回启动时捕获的快照值，忽略任何运行时配置变更。
 */
export function getTeammateModeFromSnapshot(): TeammateMode {
  if (initialTeammateMode === null) {
    // 这表示初始化错误——捕获应在 setup() 中进行
    logError(
      new Error(
        'getTeammateModeFromSnapshot called before capture - this indicates an initialization bug',
      ),
    )
    captureTeammateModeSnapshot()
  }
  // 如果仍以某种方式保持 null，则回退到 'auto'（不应发生，但安全起见）
  return initialTeammateMode ?? 'auto'
}
