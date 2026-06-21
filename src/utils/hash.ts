/**
 * djb2 字符串哈希 — 快速非加密哈希，返回有符号 32 位整数。
 * 跨运行时确定性（不像 Bun.hash 使用 wyhash）。作为
 * Bun.hash 不可用时的回退，或当你需要磁盘稳定
 * 输出时（例如必须在运行时升级后保留的缓存目录名）。
 */
export function djb2Hash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return hash
}

/**
 * 对任意内容进行哈希以进行变更检测。Bun.hash 比
 * sha256 快约 100 倍，且具有足够的碰撞抗性以进行差异检测（非加密安全）。
 */
export function hashContent(content: string): string {
  if (typeof Bun !== 'undefined') {
    return Bun.hash(content).toString()
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('crypto') as typeof import('crypto')
  return crypto.createHash('sha256').update(content).digest('hex')
}

/**
 * 对两个字符串进行哈希，不分配拼接的临时字符串。Bun 路径
 * 对 wyhash 进行种子链（hash(a) 的结果作为 hash(b) 的种子）；Node 路径使用
 * 增量 SHA-256 update。种子链自然消歧
 * ("ts","code") 与 ("tsc","ode")，因此在 Bun 下无需分隔符。
 */
export function hashPair(a: string, b: string): string {
  if (typeof Bun !== 'undefined') {
    return Bun.hash(b, Bun.hash(a)).toString()
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('crypto') as typeof import('crypto')
  return crypto
    .createHash('sha256')
    .update(a)
    .update('\0')
    .update(b)
    .digest('hex')
}
