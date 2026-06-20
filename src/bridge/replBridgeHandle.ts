import { updateSessionBridgeId } from '../utils/concurrentSessions.js'
import type { ReplBridgeHandle } from './replBridge.js'
import { toCompatSessionId } from './sessionIdCompat.js'

/**
 * 指向当前活跃 REPL bridge handle 的全局指针，让 useReplBridge 的 React
 * 树之外的调用方（tools、slash commands）可以调用 handle 方法，比如
 * subscribePR。与 bridgeDebug.ts 同样的"一个进程一个 bridge"理由 ——
 * handle 闭包捕获了创建 session 时的 sessionId 和 getAccessToken，独立
 * 重新推导它们（BriefTool/upload.ts 的做法）有 staging/prod token 分叉
 * 的风险。
 *
 * 在 useReplBridge.tsx 中 init 完成时设置；teardown 时清空。
 */

let handle: ReplBridgeHandle | null = null

export function setReplBridgeHandle(h: ReplBridgeHandle | null): void {
  handle = h
  // 把我们的 bridge session ID 发布（或清空）到 session 记录里，让其他
  // 本地 peer 能把我们从它们的 bridge 列表中去重 —— 本地优先。
  void updateSessionBridgeId(getSelfBridgeCompatId() ?? null).catch(() => {})
}

export function getReplBridgeHandle(): ReplBridgeHandle | null {
  return handle
}

/**
 * 我们自己的 bridge session ID，采用 API 在 /v1/sessions 响应中返回的
 * session_* 兼容格式 —— bridge 未连接时返回 undefined。
 */
export function getSelfBridgeCompatId(): string | undefined {
  const h = getReplBridgeHandle()
  return h ? toCompatSessionId(h.bridgeSessionId) : undefined
}
