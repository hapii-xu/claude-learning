import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'fs'
import { basename, join, resolve } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import type {
  ProjectContextSource,
  SkillLearningProjectContext,
  SkillLearningProjectRecord,
  SkillLearningProjectsRegistry,
  SkillLearningScope,
} from './types.js'

const REGISTRY_VERSION = 1
const GLOBAL_PROJECT_ID = 'global'
const GLOBAL_PROJECT_NAME = 'Global'

export function getSkillLearningRootDir(): string {
  return join(getClaudeConfigHomeDir(), 'skill-learning')
}

export function getProjectsRegistryPath(): string {
  return join(getSkillLearningRootDir(), 'projects.json')
}

export function getProjectStorageDir(projectId: string): string {
  if (projectId === GLOBAL_PROJECT_ID) {
    return join(getSkillLearningRootDir(), 'global')
  }
  return join(getSkillLearningRootDir(), 'projects', projectId)
}

export function getProjectContextPath(projectId: string): string {
  return join(getProjectStorageDir(projectId), 'project.json')
}

// 基于 cwd 的内存缓存。`resolveContext` 会同步 fork `git` 子进程，
// `persistProjectContext` 每次调用都会写 registry/project.json——
// 在 tool.call 热路径（每个 tool 调用一次封装器）中，
// 这些开销会在一次会话中累积到数百毫秒。
// 缓存以 cwd 字符串为键，确保不同 worktree 各自独立。
//
// 使用 LRU 淘汰做上界：长时间运行的进程若遍历大量 worktree
//（如多 repo 构建编排器），否则缓存会无限增长。
// 每个条目持有一个 SkillLearningProjectContext（instinct + skill 列表），
// 因此容量上限可确保内存占用有界，不受 cwd 多样性影响。
// `defines.ts` 原本将此标注为"无淘汰机制（非 GB 级主因）"——此修复弥补了该缺口。
const PROJECT_CONTEXT_CACHE_MAX = 32
const PROJECT_CONTEXT_CACHE_TRIM_TO = 24
const contextCache = new Map<string, SkillLearningProjectContext>()
const PERSIST_INTERVAL_MS = 5 * 60 * 1000
let lastPersistAt = 0

function setProjectContextCache(
  cwd: string,
  ctx: SkillLearningProjectContext,
): void {
  if (contextCache.has(cwd)) contextCache.delete(cwd)
  contextCache.set(cwd, ctx)
  if (contextCache.size > PROJECT_CONTEXT_CACHE_MAX) {
    const toDrop = contextCache.size - PROJECT_CONTEXT_CACHE_TRIM_TO
    const iter = contextCache.keys()
    for (let i = 0; i < toDrop; i++) {
      const next = iter.next()
      if (next.done) break
      contextCache.delete(next.value)
    }
  }
}

export function resolveProjectContext(
  cwd = process.cwd(),
): SkillLearningProjectContext {
  const cached = contextCache.get(cwd)
  if (cached) {
    // 刷新插入顺序，使频繁访问的 cwd 在淘汰时能够存活。
    contextCache.delete(cwd)
    contextCache.set(cwd, cached)
    // 仍然更新注册表，使长时间运行的进程保持 `lastSeenAt` 相对新鲜，
    // 但做节流处理，避免每次 tool 调用都触发写操作。
    const now = Date.now()
    if (now - lastPersistAt > PERSIST_INTERVAL_MS) {
      lastPersistAt = now
      persistProjectContext(cached)
    }
    return cached
  }
  const resolved = resolveContext(cwd)
  setProjectContextCache(cwd, resolved)
  persistProjectContext(resolved)
  lastPersistAt = Date.now()
  return resolved
}

export function resetProjectContextCacheForTest(): void {
  contextCache.clear()
  lastPersistAt = 0
}

export function listKnownProjects(): SkillLearningProjectRecord[] {
  const registry = readProjectsRegistry(getProjectsRegistryPath())
  return Object.values(registry.projects).sort((a, b) =>
    a.projectName.localeCompare(b.projectName),
  )
}

function resolveContext(cwd: string): SkillLearningProjectContext {
  const envProjectDir = process.env.CLAUDE_PROJECT_DIR?.trim()
  if (envProjectDir) {
    const projectRoot = normalizePath(envProjectDir)
    return buildContext({
      source: 'claude_project_dir',
      scope: 'project',
      cwd,
      projectRoot,
      identity: `claude-project-dir:${projectRoot}`,
      projectName: basename(projectRoot) || 'project',
    })
  }

  const gitRemote = git(['remote', 'get-url', 'origin'], cwd)
  if (gitRemote) {
    const projectRoot = git(['rev-parse', '--show-toplevel'], cwd)
    const normalizedRemote = normalizeGitRemote(gitRemote)
    return buildContext({
      source: 'git_remote',
      scope: 'project',
      cwd,
      projectRoot: projectRoot
        ? normalizePath(projectRoot)
        : normalizePath(cwd),
      gitRemote: normalizedRemote,
      identity: `git-remote:${normalizedRemote}`,
      projectName: projectNameFromRemote(normalizedRemote),
    })
  }

  const gitRoot = git(['rev-parse', '--show-toplevel'], cwd)
  if (gitRoot) {
    const projectRoot = normalizePath(gitRoot)
    return buildContext({
      source: 'git_root',
      scope: 'project',
      cwd,
      projectRoot,
      identity: `git-root:${projectRoot}`,
      projectName: basename(projectRoot) || 'project',
    })
  }

  return buildContext({
    source: 'global',
    scope: 'global',
    cwd,
    projectRoot: undefined,
    identity: 'global',
    projectName: GLOBAL_PROJECT_NAME,
  })
}

function buildContext(input: {
  source: ProjectContextSource
  scope: SkillLearningScope
  cwd: string
  projectRoot?: string
  gitRemote?: string
  identity: string
  projectName: string
}): SkillLearningProjectContext {
  const projectId =
    input.scope === 'global'
      ? GLOBAL_PROJECT_ID
      : stableProjectId(input.identity)
  return {
    projectId,
    projectName: input.projectName,
    scope: input.scope,
    source: input.source,
    cwd: normalizePath(input.cwd),
    projectRoot: input.projectRoot,
    gitRemote: input.gitRemote,
    storageDir: getProjectStorageDir(projectId),
  }
}

function persistProjectContext(context: SkillLearningProjectContext): void {
  const now = new Date().toISOString()
  const registryPath = getProjectsRegistryPath()
  const registry = readProjectsRegistry(registryPath)
  const existing = registry.projects[context.projectId]
  const record: SkillLearningProjectRecord = {
    ...context,
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
  }

  registry.projects[context.projectId] = record
  registry.updatedAt = now

  mkdirSync(context.storageDir, { recursive: true })
  mkdirSync(getSkillLearningRootDir(), { recursive: true })
  writeJson(registryPath, registry)
  writeJson(getProjectContextPath(context.projectId), record)
}

function readProjectsRegistry(path: string): SkillLearningProjectsRegistry {
  if (!existsSync(path)) {
    return {
      version: REGISTRY_VERSION,
      updatedAt: new Date(0).toISOString(),
      projects: {},
    }
  }

  try {
    const parsed = JSON.parse(
      readFileSync(path, 'utf8'),
    ) as Partial<SkillLearningProjectsRegistry>
    if (
      parsed.version === REGISTRY_VERSION &&
      typeof parsed.projects === 'object' &&
      parsed.projects
    ) {
      return {
        version: REGISTRY_VERSION,
        updatedAt:
          typeof parsed.updatedAt === 'string'
            ? parsed.updatedAt
            : new Date(0).toISOString(),
        projects: parsed.projects as Record<string, SkillLearningProjectRecord>,
      }
    }
  } catch {
    // 跌落至空注册表。损坏的状态不应阻塞启动。
  }

  return {
    version: REGISTRY_VERSION,
    updatedAt: new Date(0).toISOString(),
    projects: {},
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function git(args: string[], cwd: string): string | null {
  try {
    const output = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const trimmed = output.trim()
    return trimmed ? trimmed : null
  } catch {
    return null
  }
}

function normalizePath(path: string): string {
  const resolved = resolve(path)
  try {
    return realpathSync.native(resolved).normalize('NFC')
  } catch {
    return resolved.normalize('NFC')
  }
}

function normalizeGitRemote(remote: string): string {
  let normalized = remote.trim().replace(/\\/g, '/')
  normalized = normalized.replace(/\.git$/i, '')
  normalized = normalized.replace(/\/+$/g, '')
  return normalized.toLowerCase()
}

function projectNameFromRemote(remote: string): string {
  const match = remote.match(/[:/]([^/:]+?)(?:\.git)?$/)
  return match?.[1] || 'project'
}

function stableProjectId(identity: string): string {
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 16)
  return `project-${hash}`
}
