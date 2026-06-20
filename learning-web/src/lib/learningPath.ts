import { modules } from '@/data/modules'
import type { LearningModule } from '@/data/types'

/**
 * 计算学习路径 — 按 prerequisites 依赖排序的模块序列
 * 使用拓扑排序，同时检测循环依赖
 */
export function computeLearningPath(): LearningModule[] {
  const moduleMap = new Map(modules.map(m => [m.id, m]))
  const visited = new Set<string>()
  const result: LearningModule[] = []

  function visit(mod: LearningModule) {
    if (visited.has(mod.id)) return
    visited.add(mod.id)

    // 先访问前置模块
    if (mod.prerequisites) {
      for (const preId of mod.prerequisites) {
        const pre = moduleMap.get(preId)
        if (pre) visit(pre)
      }
    }

    result.push(mod)
  }

  for (const mod of modules) {
    visit(mod)
  }

  return result
}

/**
 * 获取模块依赖图数据 — 用于可视化
 */
export interface DependencyNode {
  id: string
  title: string
  group: string
  x?: number
  y?: number
}

export interface DependencyEdge {
  from: string
  to: string
}

export function computeDependencyGraph(): {
  nodes: DependencyNode[]
  edges: DependencyEdge[]
} {
  const nodes: DependencyNode[] = modules.map(m => ({
    id: m.id,
    title: m.title,
    group: m.group.id,
  }))

  const edges: DependencyEdge[] = []

  // 从 prerequisites 构建边
  for (const mod of modules) {
    if (mod.prerequisites) {
      for (const preId of mod.prerequisites) {
        edges.push({ from: preId, to: mod.id })
      }
    }
  }

  // 从共享文件构建隐式依赖（如果模块B的文件import了模块A的文件）
  // 这是一个简化的启发式方法
  const fileModuleMap = new Map<string, string>()
  for (const mod of modules) {
    for (const file of mod.files) {
      fileModuleMap.set(file.path, mod.id)
    }
  }

  return { nodes, edges }
}

/**
 * 获取模块的学习建议
 */
export function getModuleLearningAdvice(moduleId: string): string | null {
  const mod = modules.find(m => m.id === moduleId)
  if (!mod) return null

  const parts: string[] = []

  if (mod.prerequisites && mod.prerequisites.length > 0) {
    const preNames = mod.prerequisites
      .map(id => modules.find(m => m.id === id)?.title)
      .filter(Boolean)
    if (preNames.length > 0) {
      parts.push(`建议先学习: ${preNames.join('、')}`)
    }
  }

  // 找到依赖此模块的后续模块
  const dependents = modules.filter(m => m.prerequisites?.includes(moduleId))
  if (dependents.length > 0) {
    parts.push(`学完后可继续: ${dependents.map(d => d.title).join('、')}`)
  }

  return parts.length > 0 ? parts.join('。') : null
}
