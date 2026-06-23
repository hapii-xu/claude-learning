/**
 * Marketplace 对账器 — 使 known_marketplaces.json 与 settings 中声明的意图保持一致。
 *
 * 两个层次：
 * - diffMarketplaces()：比较（读取 .git 进行工作树规范化，已记忆化）
 * - reconcileMarketplaces()：捆绑差异 + 安装（I/O，幂等，仅新增）
 */

import isEqual from 'lodash-es/isEqual.js'
import { isAbsolute, resolve } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { pathExists } from '../file.js'
import { findCanonicalGitRoot } from '../git.js'
import { logError } from '../log.js'
import {
  addMarketplaceSource,
  type DeclaredMarketplace,
  getDeclaredMarketplaces,
  loadKnownMarketplacesConfig,
} from './marketplaceManager.js'
import {
  isLocalMarketplaceSource,
  type KnownMarketplacesFile,
  type MarketplaceSource,
} from './schemas.js'

export type MarketplaceDiff = {
  /** 在 settings 中声明，但 known_marketplaces.json 中不存在 */
  missing: string[]
  /** 两者都存在，但 settings 来源 ≠ JSON 来源（settings 优先） */
  sourceChanged: Array<{
    name: string
    declaredSource: MarketplaceSource
    materializedSource: MarketplaceSource
  }>
  /** 两者都存在，来源匹配 */
  upToDate: string[]
}

/**
 * 比较声明的意图（settings）与物化状态（JSON）。
 *
 * 比较前解析 `declared` 中的相对目录/文件路径，
 * 使带 `./path` 的项目 settings 能匹配 JSON 中的绝对路径。路径
 * 解析读取 `.git` 以规范化工作树路径（已记忆化）。
 */
export function diffMarketplaces(
  declared: Record<string, DeclaredMarketplace>,
  materialized: KnownMarketplacesFile,
  opts?: { projectRoot?: string },
): MarketplaceDiff {
  const missing: string[] = []
  const sourceChanged: MarketplaceDiff['sourceChanged'] = []
  const upToDate: string[] = []

  for (const [name, intent] of Object.entries(declared)) {
    const state = materialized[name]
    const normalizedIntent = normalizeSource(intent.source, opts?.projectRoot)

    if (!state) {
      missing.push(name)
    } else if (intent.sourceIsFallback) {
      // 回退：存在即可。不比较来源 — 声明的来源
      // 仅作为 `missing` 分支的默认值。如果 seed/prior-install/mirror
      // 以任何来源物化了此 marketplace，则保持不变。比较
      // 会报告 sourceChanged → 重新克隆 → 覆盖物化内容。
      upToDate.push(name)
    } else if (!isEqual(normalizedIntent, state.source)) {
      sourceChanged.push({
        name,
        declaredSource: normalizedIntent,
        materializedSource: state.source,
      })
    } else {
      upToDate.push(name)
    }
  }

  return { missing, sourceChanged, upToDate }
}

export type ReconcileOptions = {
  /** 跳过声明的 marketplace。用于 zip-cache 模式中不支持的来源类型。 */
  skip?: (name: string, source: MarketplaceSource) => boolean
  onProgress?: (event: ReconcileProgressEvent) => void
}

export type ReconcileProgressEvent =
  | {
      type: 'installing'
      name: string
      action: 'install' | 'update'
      index: number
      total: number
    }
  | { type: 'installed'; name: string; alreadyMaterialized: boolean }
  | { type: 'failed'; name: string; error: string }

export type ReconcileResult = {
  installed: string[]
  updated: string[]
  failed: Array<{ name: string; error: string }>
  upToDate: string[]
  skipped: string[]
}

/**
 * 使 known_marketplaces.json 与声明的意图保持一致。
 * 幂等。仅新增（从不删除）。不修改 AppState。
 */
export async function reconcileMarketplaces(
  opts?: ReconcileOptions,
): Promise<ReconcileResult> {
  const declared = getDeclaredMarketplaces()
  if (Object.keys(declared).length === 0) {
    return { installed: [], updated: [], failed: [], upToDate: [], skipped: [] }
  }

  let materialized: KnownMarketplacesFile
  try {
    materialized = await loadKnownMarketplacesConfig()
  } catch (e) {
    logError(e)
    materialized = {}
  }

  const diff = diffMarketplaces(declared, materialized, {
    projectRoot: getOriginalCwd(),
  })

  type WorkItem = {
    name: string
    source: MarketplaceSource
    action: 'install' | 'update'
  }
  const work: WorkItem[] = [
    ...diff.missing.map(
      (name): WorkItem => ({
        name,
        source: normalizeSource(declared[name]!.source),
        action: 'install',
      }),
    ),
    ...diff.sourceChanged.map(
      ({ name, declaredSource }): WorkItem => ({
        name,
        source: declaredSource,
        action: 'update',
      }),
    ),
  ]

  const skipped: string[] = []
  const toProcess: WorkItem[] = []
  for (const item of work) {
    if (opts?.skip?.(item.name, item.source)) {
      skipped.push(item.name)
      continue
    }
    // 对于 sourceChanged 的本地路径条目，如果声明的路径不存在则跳过。
    // 防止多检出场景中 normalizeSource 无法规范化
    // 并产生死路径 — 物化条目可能仍然
    // 有效；addMarketplaceSource 无论如何都会失败，所以跳过可以避免
    // 嘈杂的 "failed" 事件并保留工作条目。缺失条目
    // 不跳过（没有东西需要保留；用户应该看到错误）。
    if (
      item.action === 'update' &&
      isLocalMarketplaceSource(item.source) &&
      !(await pathExists(item.source.path))
    ) {
      logForDebugging(
        `[reconcile] '${item.name}' declared path does not exist; keeping materialized entry`,
      )
      skipped.push(item.name)
      continue
    }
    toProcess.push(item)
  }

  if (toProcess.length === 0) {
    return {
      installed: [],
      updated: [],
      failed: [],
      upToDate: diff.upToDate,
      skipped,
    }
  }

  logForDebugging(
    `[reconcile] ${toProcess.length} marketplace(s): ${toProcess.map(w => `${w.name}(${w.action})`).join(', ')}`,
  )

  const installed: string[] = []
  const updated: string[] = []
  const failed: ReconcileResult['failed'] = []

  for (let i = 0; i < toProcess.length; i++) {
    const { name, source, action } = toProcess[i]!
    opts?.onProgress?.({
      type: 'installing',
      name,
      action,
      index: i + 1,
      total: toProcess.length,
    })

    try {
      // addMarketplaceSource 是来源幂等的 — 同一来源返回
      // alreadyMaterialized:true 而不克隆。对于 'update'（来源
      // 已变更），新来源不匹配现有来源 → 继续克隆
      // 并覆盖旧的 JSON 条目。
      const result = await addMarketplaceSource(source)

      if (action === 'install') installed.push(name)
      else updated.push(name)
      opts?.onProgress?.({
        type: 'installed',
        name,
        alreadyMaterialized: result.alreadyMaterialized,
      })
    } catch (e) {
      const error = errorMessage(e)
      failed.push({ name, error })
      opts?.onProgress?.({ type: 'failed', name, error })
      logError(e)
    }
  }

  return { installed, updated, failed, upToDate: diff.upToDate, skipped }
}

/**
 * 解析相对目录/文件路径以进行稳定比较。
 * 在项目范围声明的 Settings 可能使用项目相对路径；
 * JSON 存储绝对路径。
 *
 * 对于 git 工作树，解析时使用主检出（规范根）
 * 而非工作树的当前目录。项目 settings 提交到 git，
 * 所以 `./foo` 意味着"相对于此仓库" — 但 known_marketplaces.json 是
 * 用户全局的，每个 marketplace 名称只有一个条目。针对
 * 工作树当前目录解析意味着每个工作树会话都用
 * 自己的绝对路径覆盖共享条目，删除工作树后留下死
 * installLocation。规范根在所有工作树中是稳定的。
 */
function normalizeSource(
  source: MarketplaceSource,
  projectRoot?: string,
): MarketplaceSource {
  if (
    (source.source === 'directory' || source.source === 'file') &&
    !isAbsolute(source.path)
  ) {
    const base = projectRoot ?? getOriginalCwd()
    const canonicalRoot = findCanonicalGitRoot(base)
    return {
      ...source,
      path: resolve(canonicalRoot ?? base, source.path),
    }
  }
  return source
}
