export type CachedMCState = {
  registeredTools: Set<string>
  toolOrder: string[]
  deletedRefs: Set<string>
  pinnedEdits: PinnedCacheEdits[]
  toolsSentToAPI: boolean
}

export type CacheEditsBlock = {
  type: 'cache_edits'
  edits: Array<{ type: string; tool_use_id: string }>
}

export type PinnedCacheEdits = {
  userMessageIndex: number
  block: CacheEditsBlock
}

const TRIGGER_THRESHOLD = 10
const KEEP_RECENT = 5

/**
 * 当 CLAUDE_CACHED_MICROCOMPACT 环境变量设为 '1' 或 feature 显式启用时返回 true。
 */
export function isCachedMicrocompactEnabled(): boolean {
  return process.env.CLAUDE_CACHED_MICROCOMPACT === '1'
}

/**
 * 对支持 cache_edits 的 Claude 4.x 模型返回 true。
 */
export function isModelSupportedForCacheEditing(model: string): boolean {
  return /claude-[a-z]+-4[-\d]/.test(model)
}

export function getCachedMCConfig(): {
  triggerThreshold: number
  keepRecent: number
} {
  return { triggerThreshold: TRIGGER_THRESHOLD, keepRecent: KEEP_RECENT }
}

export function createCachedMCState(): CachedMCState {
  return {
    registeredTools: new Set(),
    toolOrder: [],
    deletedRefs: new Set(),
    pinnedEdits: [],
    toolsSentToAPI: false,
  }
}

export function markToolsSentToAPI(state: CachedMCState): void {
  state.toolsSentToAPI = true
}

export function resetCachedMCState(state: CachedMCState): void {
  state.registeredTools.clear()
  state.toolOrder = []
  state.deletedRefs.clear()
  state.pinnedEdits = []
  state.toolsSentToAPI = false
}

export function registerToolResult(state: CachedMCState, toolId: string): void {
  if (!state.registeredTools.has(toolId)) {
    state.registeredTools.add(toolId)
    state.toolOrder.push(toolId)
  }
}

export function registerToolMessage(
  state: CachedMCState,
  groupIds: string[],
): void {
  for (const id of groupIds) {
    registerToolResult(state, id)
  }
}

/**
 * 返回应被删除的 tool ID 列表（从最旧到最新），使数量降到 threshold 以下，
 * 排除已删除的 tool 和最近见过的那些。
 */
export function getToolResultsToDelete(state: CachedMCState): string[] {
  const { triggerThreshold, keepRecent } = getCachedMCConfig()
  const active = state.toolOrder.filter(id => !state.deletedRefs.has(id))
  if (active.length <= triggerThreshold) return []
  // 保留最近的 keepRecent 个 tool
  const toDelete = active.slice(0, active.length - keepRecent)
  return toDelete
}

/**
 * 创建一个删除指定 tool result ID 的 cache_edits block。
 * 若 toolIds 为空则返回 null。
 */
export function createCacheEditsBlock(
  _state: CachedMCState,
  toolIds: string[],
): CacheEditsBlock | null {
  if (toolIds.length === 0) return null
  return {
    type: 'cache_edits',
    edits: toolIds.map(id => ({
      type: 'delete_tool_result',
      tool_use_id: id,
    })),
  }
}
