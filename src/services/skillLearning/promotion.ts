import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Instinct, StoredInstinct } from './instinctParser.js'
import {
  getInstinctsDir,
  loadInstincts,
  saveInstinct,
  type InstinctStoreOptions,
} from './instinctStore.js'
import { getSkillLearningRoot } from './observationStore.js'
import type { SkillLearningProjectContext } from './types.js'

export type PromotionCandidate = {
  instinctId: string
  averageConfidence: number
  projectIds: string[]
}

export type PromotionOptions = {
  rootDir?: string
  minProjects?: number
  minConfidence?: number
}

/**
 * 使用 FIFO 淘汰的有界 Set。每次会话的晋升次数在实践中很少（个位数），
 * 但长时间运行的 sandbox/daemon 若从不重启可能会突破此限。
 * 该上限是防御性的，降级行为——超过 N 条后重新晋升并遗忘最旧的——
 * 是无害的，因为晋升操作在 lifecycle 层是幂等的。
 */
const SESSION_PROMOTED_IDS_MAX = 256
const SESSION_PROMOTED_IDS_TRIM_TO = 192
const sessionPromotedIds = new Set<string>()

function recordSessionPromoted(id: string): void {
  sessionPromotedIds.add(id)
  if (sessionPromotedIds.size > SESSION_PROMOTED_IDS_MAX) {
    const toDrop = sessionPromotedIds.size - SESSION_PROMOTED_IDS_TRIM_TO
    const iter = sessionPromotedIds.values()
    for (let i = 0; i < toDrop; i++) {
      const next = iter.next()
      if (next.done) break
      sessionPromotedIds.delete(next.value)
    }
  }
}

export function resetPromotionBookkeeping(): void {
  sessionPromotedIds.clear()
}

export function findPromotionCandidates(
  instincts: Instinct[],
  minProjects = 2,
  minConfidence = 0.8,
): PromotionCandidate[] {
  const grouped = new Map<string, Instinct[]>()
  for (const instinct of instincts) {
    if (instinct.scope !== 'project') continue
    const group = grouped.get(instinct.id) ?? []
    group.push(instinct)
    grouped.set(instinct.id, group)
  }

  return Array.from(grouped.entries()).flatMap(([instinctId, group]) => {
    const projectIds = Array.from(
      new Set(group.map(instinct => instinct.projectId).filter(Boolean)),
    ) as string[]
    const averageConfidence =
      group.reduce((sum, instinct) => sum + instinct.confidence, 0) /
      group.length
    if (
      projectIds.length >= minProjects &&
      averageConfidence >= minConfidence
    ) {
      return [
        {
          instinctId,
          projectIds,
          averageConfidence: Number(averageConfidence.toFixed(2)),
        },
      ]
    }
    return []
  })
}

export async function checkPromotion(
  options: PromotionOptions = {},
): Promise<PromotionCandidate[]> {
  const minProjects = options.minProjects ?? 2
  const minConfidence = options.minConfidence ?? 0.8
  const allProjectInstincts = await loadAllProjectInstincts(options.rootDir)

  const candidates = findPromotionCandidates(
    allProjectInstincts,
    minProjects,
    minConfidence,
  )
  const promoted: PromotionCandidate[] = []

  for (const candidate of candidates) {
    if (sessionPromotedIds.has(candidate.instinctId)) continue

    const source = allProjectInstincts.find(
      instinct => instinct.id === candidate.instinctId,
    )
    if (!source) continue

    const globalInstinct: StoredInstinct = {
      ...source,
      scope: 'global',
      projectId: undefined,
      projectName: undefined,
      confidence: candidate.averageConfidence,
      updatedAt: new Date().toISOString(),
    }

    const globalOptions: InstinctStoreOptions = {
      rootDir: options.rootDir,
      scope: 'global',
      project: globalProjectContext(options.rootDir),
    }
    await saveInstinct(globalInstinct, globalOptions)

    recordSessionPromoted(candidate.instinctId)
    promoted.push(candidate)
  }

  return promoted
}

async function loadAllProjectInstincts(
  rootDir?: string,
): Promise<StoredInstinct[]> {
  const root = getSkillLearningRoot(rootDir ? { rootDir } : undefined)
  const projectsRoot = join(root, 'projects')
  if (!existsSync(projectsRoot)) return []

  const entries = await readdir(projectsRoot, { withFileTypes: true })
  const instincts: StoredInstinct[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const project: SkillLearningProjectContext = {
      projectId: entry.name,
      projectName: entry.name,
      scope: 'project',
      source: 'git_root',
      cwd: projectsRoot,
      storageDir: join(projectsRoot, entry.name),
    }
    const projectInstincts = await loadInstincts({
      rootDir,
      project,
      scope: 'project',
    })
    instincts.push(...projectInstincts)
  }
  return instincts
}

function globalProjectContext(rootDir?: string): SkillLearningProjectContext {
  const root = getSkillLearningRoot(rootDir ? { rootDir } : undefined)
  return {
    projectId: 'global',
    projectName: 'Global',
    scope: 'global',
    source: 'global',
    cwd: root,
    storageDir: join(root, 'global'),
  }
}

// 重新导出，供需要检查全局 instincts 目录的调用方使用。
export function getGlobalInstinctsDir(rootDir?: string): string {
  return getInstinctsDir({
    rootDir,
    scope: 'global',
    project: globalProjectContext(rootDir),
  })
}
