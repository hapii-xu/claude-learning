import type { FileTreeNode } from '@/data/types'

/**
 * 将 FileTreeNode 树结构展平为文件路径列表（仅包含 file 类型）
 */
export function flattenFileTree(nodes: FileTreeNode[]): string[] {
  const result: string[] = []
  function walk(node: FileTreeNode) {
    if (node.type === 'file') {
      result.push(node.path)
    } else if (node.children) {
      for (const child of node.children) walk(child)
    }
  }
  for (const node of nodes) walk(node)
  return result
}

/**
 * 从参与者显示名推断对应的项目文件路径
 *
 * 策略：
 * 1. 显示名含 '/' 或 '.' → 视为路径片段，在 knownFiles 中找 endsWith 匹配
 * 2. 显示名是纯名称（如 GrowthBook）→ 找文件名（不含扩展名）匹配的项
 * 3. 无匹配 → 返回 null
 */
export function resolveParticipantFile(
  displayName: string,
  knownFiles: string[],
): string | null {
  if (!displayName || knownFiles.length === 0) return null

  const trimmed = displayName.trim()

  // 策略 1：含路径分隔符或文件扩展名 → 精确后缀匹配
  if (trimmed.includes('/') || trimmed.includes('.')) {
    // 尝试精确后缀匹配
    const exact = knownFiles.find(
      f =>
        f === trimmed ||
        f.endsWith(`/${trimmed}`) ||
        f.endsWith(`\\${trimmed}`),
    )
    if (exact) return exact

    // 尝试不带扩展名的后缀匹配（如 "cli.tsx" 匹配 "src/entrypoints/cli.tsx"）
    const baseName = trimmed.replace(/\.[^.]+$/, '')
    const byBase = knownFiles.find(f => {
      const fBase =
        f
          .split('/')
          .pop()
          ?.replace(/\.[^.]+$/, '') || ''
      return f.endsWith(trimmed) || fBase === baseName
    })
    if (byBase) return byBase
  }

  // 策略 2：纯名称 → 找文件名（不含路径和扩展名）完全匹配
  const nameLower = trimmed.toLowerCase()
  const byFileName = knownFiles.find(f => {
    const fileName =
      f
        .split('/')
        .pop()
        ?.replace(/\.[^.]+$/, '')
        ?.toLowerCase() || ''
    return fileName === nameLower
  })
  if (byFileName) return byFileName

  // 策略 3：模糊匹配 → 文件名包含显示名
  const fuzzy = knownFiles.find(f => {
    const fileName = f.split('/').pop()?.toLowerCase() || ''
    return fileName.includes(nameLower)
  })
  if (fuzzy) return fuzzy

  return null
}
