// Auto mode 状态函数 — 独立为一个模块，调用方可根据
// feature('TRANSCRIPT_CLASSIFIER') 条件决定是否 require() 加载。

let autoModeActive = false
let autoModeFlagCli = false
// 由异步 verifyAutoModeGateAccess 检查在以下情况下设置：
// 从 GrowthBook 读取到 tengu_auto_mode_config.enabled === 'disabled' 时触发。
// isAutoModeGateEnabled() 使用该标志来阻止 SDK/显式在踢出后重新进入。
let autoModeCircuitBroken = false

export function setAutoModeActive(active: boolean): void {
  autoModeActive = active
}

export function isAutoModeActive(): boolean {
  return autoModeActive
}

export function setAutoModeFlagCli(passed: boolean): void {
  autoModeFlagCli = passed
}

export function getAutoModeFlagCli(): boolean {
  return autoModeFlagCli
}

export function setAutoModeCircuitBroken(broken: boolean): void {
  autoModeCircuitBroken = broken
}

export function isAutoModeCircuitBroken(): boolean {
  return autoModeCircuitBroken
}

export function _resetForTesting(): void {
  autoModeActive = false
  autoModeFlagCli = false
  autoModeCircuitBroken = false
}
