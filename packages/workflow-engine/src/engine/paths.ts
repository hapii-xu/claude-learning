import { resolve, sep } from 'node:path'

/**
 * 判断 target 经解析后是否在 base 内（含等于 base）。
 * 相对路径基于 base 解析（不依赖 process.cwd）。
 * 使用 `sep` 边界避免假阳性前缀匹配（例如 `/foo` 不是 `/foobar` 的父目录）。
 */
export function containsPath(base: string, target: string): boolean {
  const resolvedBase = resolve(base)
  const resolvedTarget = resolve(resolvedBase, target)
  if (resolvedTarget === resolvedBase) return true
  return resolvedTarget.startsWith(resolvedBase + sep)
}

/**
 * 验证命名 workflow 的名称是否合法（拒绝路径穿越）。
 * 拒绝：路径分隔符、空字节、`.` / `..`。
 * 返回清理后的名称，非法则返回 null。
 */
export function sanitizeWorkflowName(name: string): string | null {
  if (typeof name !== 'string' || name.length === 0) return null
  if (name.includes('/') || name.includes('\\')) return null
  if (name.includes('\0')) return null
  if (name === '.' || name === '..') return null
  return name
}
