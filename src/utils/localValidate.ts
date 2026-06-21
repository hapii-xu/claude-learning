/**
 * /local-memory 和 /local-vault 输入名称的共享校验工具。
 *
 * LocalMemoryRecallTool (PR-1) 和 VaultHttpFetchTool (PR-2) 都需要一致的、
 * 路径安全的、操作系统可移植的键命名方案。multiStore.ts 在
 * PR-0a 键冲突修复后也使用 validateKey 校验条目键。
 *
 * 允许：字母、数字、点、下划线、连字符。
 * 长度 1..128。
 * 拒绝：
 *   - 空 / 过长
 *   - [A-Za-z0-9._-] 之外的任何字符
 *   - 前导点（隐藏文件模式，如 ".gitconfig"）
 *   - Windows 保留设备名（NUL、CON、COM1 等）— 在 Windows 上会
 *     静默写入设备并丢失数据
 */

const KEY_REGEX = /^[A-Za-z0-9._-]+$/
// Windows 将设备名视为保留，无论扩展名 —
// `NUL.txt`、`CON.foo`、`COM1.bak` 都会别名到设备。因此我们必须
// 将 basename 组件（第一个点之前的所有内容）与保留集匹配，
// 而非仅匹配整个键。
const WINDOWS_RESERVED_BASENAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i
const MAX_KEY_LENGTH = 128

export function validateKey(key: string): void {
  if (!key) {
    throw new Error('Empty key')
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new Error(`Key too long (max ${MAX_KEY_LENGTH})`)
  }
  if (!KEY_REGEX.test(key)) {
    throw new Error(`Invalid key chars: ${JSON.stringify(key)}`)
  }
  if (key.startsWith('.')) {
    throw new Error('Leading dot forbidden')
  }
  // M6 修复：匹配 basename（点前组件），以便 NUL.txt 和
  // CON.foo 也被拒绝。在 Windows 上，无论扩展名，
  // 它们仍然别名到设备文件，会静默丢失数据。
  const basenameComponent = key.includes('.') ? key.split('.')[0]! : key
  if (WINDOWS_RESERVED_BASENAME.test(basenameComponent)) {
    throw new Error(`Windows reserved name: ${key}`)
  }
}

/** 当且仅当 key 能通过 validateKey（不抛错）时返回 true。适用于守卫。 */
export function isValidKey(key: string): boolean {
  try {
    validateKey(key)
    return true
  } catch {
    return false
  }
}
