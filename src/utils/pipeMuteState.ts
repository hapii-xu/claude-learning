/**
 * pipeMuteState — Master 侧的逻辑断开状态。
 *
 * 跟踪哪些 slave 管道当前"已静音"（逻辑断开）
 * 以及哪些具有临时的 `/send` 覆盖生效。
 *
 * 这仅是本地 master 状态 — 不属于 socket 协议。
 */

// ---------------------------------------------------------------------------
// 静音集合：master 应丢弃其业务消息的 slave
// ---------------------------------------------------------------------------

const _mutedPipes = new Set<string>()

export function setMasterMutedPipes(names: Iterable<string>): void {
  _mutedPipes.clear()
  for (const n of names) _mutedPipes.add(n)
}

export function isMasterPipeMuted(name: string): boolean {
  return _mutedPipes.has(name)
}

export function removeMasterPipeMute(name: string): void {
  _mutedPipes.delete(name)
}

export function clearMasterMutedPipes(): void {
  _mutedPipes.clear()
}

// ---------------------------------------------------------------------------
// 发送覆盖集合：通过显式 `/send` 命令临时取消静音的 slave。
// 覆盖持续到 slave 发出 `done` 或 `error`。
// ---------------------------------------------------------------------------

const _sendOverrides = new Set<string>()
let _sendOverrideVersion = 0
const _sendOverrideListeners = new Set<() => void>()

function emitSendOverrideChanged(): void {
  _sendOverrideVersion += 1
  for (const listener of _sendOverrideListeners) {
    listener()
  }
}

export function addSendOverride(name: string): void {
  _sendOverrides.add(name)
  emitSendOverrideChanged()
}

export function removeSendOverride(name: string): void {
  if (_sendOverrides.delete(name)) {
    emitSendOverrideChanged()
  }
}

export function hasSendOverride(name: string): boolean {
  return _sendOverrides.has(name)
}

export function clearSendOverrides(): void {
  if (_sendOverrides.size > 0) {
    _sendOverrides.clear()
    emitSendOverrideChanged()
  }
}

export function subscribeSendOverride(listener: () => void): () => void {
  _sendOverrideListeners.add(listener)
  return () => {
    _sendOverrideListeners.delete(listener)
  }
}

export function getSendOverrideVersion(): number {
  return _sendOverrideVersion
}
