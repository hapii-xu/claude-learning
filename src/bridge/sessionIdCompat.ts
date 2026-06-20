/**
 * CCR v2 compat 层的 session ID tag 转换 helper。
 *
 * 单独放在一个文件（而不是 workSecret.ts）里，是为了让 sessionHandle.ts
 * 和 replBridgeTransport.ts（bridge.mjs 入口）可以从 workSecret.ts 导入
 * 而不拉进这些 retag 函数。
 *
 * isCseShimEnabled 的 kill switch 通过 setCseShimGate() 注入，以避免对
 * bridgeEnabled.ts → growthbook.ts → config.ts 的静态导入 —— 这些都禁止
 * 出现在 sdk.mjs bundle 里（scripts/build-agent-sdk.sh）。已经引入了
 * bridgeEnabled.ts 的调用方负责注册 gate；SDK 路径永远不注册，所以 shim
 * 默认启用（与 isCseShimEnabled() 本身的默认值一致）。
 */

let _isCseShimEnabled: (() => boolean) | undefined

/**
 * 注册 cse_ shim 的 GrowthBook gate。由已经引入 bridgeEnabled.ts 的
 * bridge 初始化代码调用。
 */
export function setCseShimGate(gate: () => boolean): void {
  _isCseShimEnabled = gate
}

/**
 * 把 `cse_*` session ID 重新打成 `session_*`，给 v1 compat API 使用。
 *
 * worker 端点（/v1/code/sessions/{id}/worker/*）要的是 `cse_*`；work poll
 * 下发的就是它。面向客户端的 compat 端点（/v1/sessions/{id}、
 * /v1/sessions/{id}/archive、/v1/sessions/{id}/events）要的是 `session_*`
 * —— compat/convert.go:27 会校验 TagSession。同一个 UUID，换身衣服而已。
 * 对非 `cse_*` 的 ID 是 no-op。
 *
 * bridgeMain 对 worker 注册和 session 管理调用复用同一个 sessionId 变量。
 * compat gate 下它从 work poll 取到的是 `cse_*`，所以 archiveSession /
 * fetchSessionTitle 需要做这次 re-tag。
 */
export function toCompatSessionId(id: string): string {
  if (!id.startsWith('cse_')) return id
  if (_isCseShimEnabled && !_isCseShimEnabled()) return id
  return 'session_' + id.slice('cse_'.length)
}

/**
 * 把 `session_*` session ID 重新打成 `cse_*`，给 infra 层调用使用。
 *
 * toCompatSessionId 的反操作。POST /v1/environments/{id}/bridge/reconnect
 * 位于 compat 层之下：一旦服务器侧 ccr_v2_compat_enabled 打开，它会按
 * infra tag（`cse_*`）查找 session。createBridgeSession 返回的仍然是
 * `session_*`（compat/convert.go:41），bridge-pointer 存的也是这个 —— 于
 * 是 perpetual reconnect 就传了错误的 tag，收到 "Session not found"。
 * UUID 相同，tag 不对。对非 `session_*` 的 ID 是 no-op。
 */
export function toInfraSessionId(id: string): string {
  if (!id.startsWith('session_')) return id
  return 'cse_' + id.slice('session_'.length)
}
