import { createHash, type UUID } from 'crypto'
import { diffLines } from 'diff'
import type { Stats } from 'fs'
import {
  chmod,
  copyFile,
  link,
  mkdir,
  readFile,
  stat,
  unlink,
} from 'fs/promises'
import { dirname, isAbsolute, join, relative } from 'path'
import {
  getIsNonInteractiveSession,
  getOriginalCwd,
  getSessionId,
} from 'src/bootstrap/state.js'
import { logEvent } from 'src/services/analytics/index.js'
import { notifyVscodeFileUpdated } from 'src/services/mcp/vscodeSdkMcp.js'
import type { LogOption } from 'src/types/logs.js'
import { inspect } from 'util'
import { getGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { getErrnoCode, isENOENT } from './errors.js'
import { pathExists } from './file.js'
import { logError } from './log.js'
import { recordFileHistorySnapshot } from './sessionStorage.js'

type BackupFileName = string | null // null 值表示该文件在此版本中不存在

export type FileHistoryBackup = {
  backupFileName: BackupFileName
  version: number
  backupTime: Date
}

export type FileHistorySnapshot = {
  messageId: UUID // 该快照关联的消息 ID
  trackedFileBackups: Record<string, FileHistoryBackup> // 文件路径到备份版本的映射
  timestamp: Date
}

export type FileHistoryState = {
  snapshots: FileHistorySnapshot[]
  trackedFiles: Set<string>
  // 单调递增计数器，每次快照都递增（即使旧快照被淘汰）。
  // 被 useGitDiffStats 用作活跃度信号（一旦达到上限，
  // snapshots.length 就会停止增长）。
  snapshotSequence: number
}

// 已禁用：文件检查点会导致无限制的内存增长（100 个快照 × 完整文件备份）。
// 参见堆快照分析——切换到增量 diff 之后才可重新启用。
const MAX_SNAPSHOTS = 20
export type DiffStats =
  | {
      filesChanged?: string[]
      insertions: number
      deletions: number
    }
  | undefined

export function fileHistoryEnabled(): boolean {
  if (getIsNonInteractiveSession()) {
    return fileHistoryEnabledSdk()
  }
  return (
    getGlobalConfig().fileCheckpointingEnabled !== false &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING)
  )
}

function fileHistoryEnabledSdk(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING) &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING)
  )
}

/**
 * 跟踪文件编辑（以及新增），通过备份其当前内容（必要时）实现。
 *
 * 必须在文件真正被新增或编辑之前调用，以便我们保存编辑前的内容。
 */
export async function fileHistoryTrackEdit(
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void,
  filePath: string,
  messageId: UUID,
): Promise<void> {
  if (!fileHistoryEnabled()) {
    return
  }

  const trackingPath = maybeShortenFilePath(filePath)

  // 第一阶段：检查是否需要备份。推测性的写入会在每次重复调用时覆盖
  // 确定性的 {hash}@v1 备份——编辑后再次调用 trackEdit 会用编辑后的
  // 内容损坏 v1。
  let captured: FileHistoryState | undefined
  updateFileHistoryState(state => {
    captured = state
    return state
  })
  if (!captured) return
  const mostRecent = captured.snapshots.at(-1)
  if (!mostRecent) {
    logError(new Error('FileHistory: Missing most recent snapshot'))
    logEvent('tengu_file_history_track_edit_failed', {})
    return
  }
  if (mostRecent.trackedFileBackups[trackingPath]) {
    // 已在最近快照中被跟踪；下一次 makeSnapshot 会重新检查 mtime，
    // 若已变更则重新备份。不要触碰 v1 备份。
    return
  }

  // 第二阶段：异步备份。
  let backup: FileHistoryBackup
  try {
    backup = await createBackup(filePath, 1)
  } catch (error) {
    logError(error)
    logEvent('tengu_file_history_track_edit_failed', {})
    return
  }
  const isAddingFile = backup.backupFileName === null

  // 第三阶段：提交。重新检查 tracked（可能有另一个 trackEdit 抢先执行）。
  updateFileHistoryState((state: FileHistoryState) => {
    try {
      const mostRecentSnapshot = state.snapshots.at(-1)
      if (
        !mostRecentSnapshot ||
        mostRecentSnapshot.trackedFileBackups[trackingPath]
      ) {
        return state
      }

      // 该文件尚未在最近快照中被跟踪，因此我们需要在最近快照里
      // 追溯性地登记一个备份。
      const updatedTrackedFiles = state.trackedFiles.has(trackingPath)
        ? state.trackedFiles
        : new Set(state.trackedFiles).add(trackingPath)

      // 浅拷贝足够了：备份的值在插入后永远不会被修改，所以我们只需要
      // 新的顶层 + trackedFileBackups 引用，以触发 React 变更检测。深拷贝
      // 会复制每个已存在备份的 Date/string 字段——为新增一个条目付出 O(n)
      // 的代价。
      const updatedMostRecentSnapshot = {
        ...mostRecentSnapshot,
        trackedFileBackups: {
          ...mostRecentSnapshot.trackedFileBackups,
          [trackingPath]: backup,
        },
      }

      const updatedState = {
        ...state,
        snapshots: (() => {
          const copy = state.snapshots.slice()
          copy[copy.length - 1] = updatedMostRecentSnapshot
          return copy
        })(),
        trackedFiles: updatedTrackedFiles,
      }
      maybeDumpStateForDebug(updatedState)

      // 快照已发生变化，记录一次快照更新。
      void recordFileHistorySnapshot(
        messageId,
        updatedMostRecentSnapshot,
        true, // isSnapshotUpdate
      ).catch(error => {
        logError(new Error(`FileHistory: Failed to record snapshot: ${error}`))
      })

      logEvent('tengu_file_history_track_edit_success', {
        isNewFile: isAddingFile,
        version: backup.version,
      })
      logForDebugging(`FileHistory: Tracked file modification for ${filePath}`)

      return updatedState
    } catch (error) {
      logError(error)
      logEvent('tengu_file_history_track_edit_failed', {})
      return state
    }
  })
}

/**
 * 在文件历史中添加一个快照，并备份任何被修改的被跟踪文件。
 */
export async function fileHistoryMakeSnapshot(
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void,
  messageId: UUID,
): Promise<void> {
  if (!fileHistoryEnabled()) {
    return undefined
  }

  // 第一阶段：用 no-op updater 捕获当前状态，以便知道需要备份哪些文件。
  // 返回相同的引用使其对任何尊重同引用返回的 wrapper 而言都是真正的
  // no-op（见 src/CLAUDE.md 的 wrapper 规则）。无条件展开的 wrapper 会
  // 触发一次额外的重渲染；对每轮一次的调用来说可以接受。
  let captured: FileHistoryState | undefined
  updateFileHistoryState(state => {
    captured = state
    return state
  })
  if (!captured) return // updateFileHistoryState 是 no-op 占位（例如 mcp.ts）

  // 第二阶段：所有 IO 异步进行，放在 updater 之外。
  const trackedFileBackups: Record<string, FileHistoryBackup> = {}
  const mostRecentSnapshot = captured.snapshots.at(-1)
  if (mostRecentSnapshot) {
    logForDebugging(`FileHistory: Making snapshot for message ${messageId}`)
    await Promise.all(
      Array.from(captured.trackedFiles, async trackingPath => {
        try {
          const filePath = maybeExpandFilePath(trackingPath)
          const latestBackup =
            mostRecentSnapshot.trackedFileBackups[trackingPath]
          const nextVersion = latestBackup ? latestBackup.version + 1 : 1

          // stat 一次文件；ENOENT 表示被跟踪的文件已删除。
          let fileStats: Stats | undefined
          try {
            fileStats = await stat(filePath)
          } catch (e: unknown) {
            if (!isENOENT(e)) throw e
          }

          if (!fileStats) {
            trackedFileBackups[trackingPath] = {
              backupFileName: null, // 用 null 表示被跟踪的文件缺失
              version: nextVersion,
              backupTime: new Date(),
            }
            logEvent('tengu_file_history_backup_deleted_file', {
              version: nextVersion,
            })
            logForDebugging(
              `FileHistory: Missing tracked file: ${trackingPath}`,
            )
            return
          }

          // 文件存在 —— 检查是否需要备份
          if (
            latestBackup &&
            latestBackup.backupFileName !== null &&
            !(await checkOriginFileChanged(
              filePath,
              latestBackup.backupFileName,
              fileStats,
            ))
          ) {
            // 文件自上次版本以来未被修改，复用原备份
            trackedFileBackups[trackingPath] = latestBackup
            return
          }

          // 文件比最近备份更新，创建新备份
          trackedFileBackups[trackingPath] = await createBackup(
            filePath,
            nextVersion,
          )
        } catch (error) {
          logError(error)
          logEvent('tengu_file_history_backup_file_failed', {})
        }
      }),
    )
  }

  // 第三阶段：把新快照提交到 state。读取 state.trackedFiles 时取最新值——
  // 如果 fileHistoryTrackEdit 在第二阶段的异步窗口里新增了文件，它会把
  // 备份写入 state.snapshots[-1].trackedFileBackups。这里继承这些备份，
  // 使新快照覆盖所有当前被跟踪的文件。
  updateFileHistoryState((state: FileHistoryState) => {
    try {
      const lastSnapshot = state.snapshots.at(-1)
      if (lastSnapshot) {
        for (const trackingPath of state.trackedFiles) {
          if (trackingPath in trackedFileBackups) continue
          const inherited = lastSnapshot.trackedFileBackups[trackingPath]
          if (inherited) trackedFileBackups[trackingPath] = inherited
        }
      }
      const now = new Date()
      const newSnapshot: FileHistorySnapshot = {
        messageId,
        trackedFileBackups,
        timestamp: now,
      }

      const allSnapshots = [...state.snapshots, newSnapshot]
      const updatedState: FileHistoryState = {
        ...state,
        snapshots:
          allSnapshots.length > MAX_SNAPSHOTS
            ? allSnapshots.slice(-MAX_SNAPSHOTS)
            : allSnapshots,
        snapshotSequence: (state.snapshotSequence ?? 0) + 1,
      }
      maybeDumpStateForDebug(updatedState)

      void notifyVscodeSnapshotFilesUpdated(state, updatedState).catch(logError)

      // 将文件历史快照记录到 session 存储，以便支持恢复
      void recordFileHistorySnapshot(
        messageId,
        newSnapshot,
        false, // isSnapshotUpdate
      ).catch(error => {
        logError(new Error(`FileHistory: Failed to record snapshot: ${error}`))
      })

      logForDebugging(
        `FileHistory: Added snapshot for ${messageId}, tracking ${state.trackedFiles.size} files`,
      )
      logEvent('tengu_file_history_snapshot_success', {
        trackedFilesCount: state.trackedFiles.size,
        snapshotCount: updatedState.snapshots.length,
      })

      return updatedState
    } catch (error) {
      logError(error)
      logEvent('tengu_file_history_snapshot_failed', {})
      return state
    }
  })
}

/**
 * 将文件系统回滚到之前的某个快照。
 */
export async function fileHistoryRewind(
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void,
  messageId: UUID,
): Promise<void> {
  if (!fileHistoryEnabled()) {
    return
  }

  // Rewind 是纯粹的文件系统副作用，不会修改 FileHistoryState。
  // 用 no-op updater 捕获 state，然后异步进行 IO。
  let captured: FileHistoryState | undefined
  updateFileHistoryState(state => {
    captured = state
    return state
  })
  if (!captured) return

  const targetSnapshot = captured.snapshots.findLast(
    snapshot => snapshot.messageId === messageId,
  )
  if (!targetSnapshot) {
    logError(new Error(`FileHistory: Snapshot for ${messageId} not found`))
    logEvent('tengu_file_history_rewind_failed', {
      trackedFilesCount: captured.trackedFiles.size,
      snapshotFound: false,
    })
    throw new Error('The selected snapshot was not found')
  }

  try {
    logForDebugging(
      `FileHistory: [Rewind] Rewinding to snapshot for ${messageId}`,
    )
    const filesChanged = await applySnapshot(captured, targetSnapshot)

    logForDebugging(`FileHistory: [Rewind] Finished rewinding to ${messageId}`)
    logEvent('tengu_file_history_rewind_success', {
      trackedFilesCount: captured.trackedFiles.size,
      filesChangedCount: filesChanged.length,
    })
  } catch (error) {
    logError(error)
    logEvent('tengu_file_history_rewind_failed', {
      trackedFilesCount: captured.trackedFiles.size,
      snapshotFound: true,
    })
    throw error
  }
}

export function fileHistoryCanRestore(
  state: FileHistoryState,
  messageId: UUID,
): boolean {
  if (!fileHistoryEnabled()) {
    return false
  }

  return state.snapshots.some(snapshot => snapshot.messageId === messageId)
}

/**
 * 计算某个文件快照的 diff 统计信息——即如果回滚到该快照会有多少文件
 * 发生变化。
 */
export async function fileHistoryGetDiffStats(
  state: FileHistoryState,
  messageId: UUID,
): Promise<DiffStats> {
  if (!fileHistoryEnabled()) {
    return undefined
  }

  const targetSnapshot = state.snapshots.findLast(
    snapshot => snapshot.messageId === messageId,
  )

  if (!targetSnapshot) {
    return undefined
  }

  const results = await Promise.all(
    Array.from(state.trackedFiles, async trackingPath => {
      try {
        const filePath = maybeExpandFilePath(trackingPath)
        const targetBackup = targetSnapshot.trackedFileBackups[trackingPath]

        const backupFileName: BackupFileName | undefined = targetBackup
          ? targetBackup.backupFileName
          : getBackupFileNameFirstVersion(trackingPath, state)

        if (backupFileName === undefined) {
          // 解析备份时出错，因此不要触碰该文件
          logError(
            new Error('FileHistory: Error finding the backup file to apply'),
          )
          logEvent('tengu_file_history_rewind_restore_file_failed', {
            dryRun: true,
          })
          return null
        }

        const stats = await computeDiffStatsForFile(
          filePath,
          backupFileName === null ? undefined : backupFileName,
        )
        if (stats?.insertions || stats?.deletions) {
          return { filePath, stats }
        }
        if (backupFileName === null && (await pathExists(filePath))) {
          // 快照之后创建的 0 字节文件：即使 diffLines 报告 0/0，
          // 也算作有变化。
          return { filePath, stats }
        }
        return null
      } catch (error) {
        logError(error)
        logEvent('tengu_file_history_rewind_restore_file_failed', {
          dryRun: true,
        })
        return null
      }
    }),
  )

  const filesChanged: string[] = []
  let insertions = 0
  let deletions = 0
  for (const r of results) {
    if (!r) continue
    filesChanged.push(r.filePath)
    insertions += r.stats?.insertions || 0
    deletions += r.stats?.deletions || 0
  }
  return { filesChanged, insertions, deletions }
}

/**
 * 轻量级的布尔检查：回滚到此消息是否会改变磁盘上的任何文件？使用与
 * applySnapshot 非 dry-run 路径相同的 stat/内容比较（checkOriginFileChanged），
 * 而不是 computeDiffStatsForFile，因此永远不会调用 diffLines。遇到第一个
 * 变更文件即提前返回。当调用方只需要是/否答案时使用；
 * fileHistoryGetDiffStats 仍然供需要展示插入/删除行数的调用方使用。
 */
export async function fileHistoryHasAnyChanges(
  state: FileHistoryState,
  messageId: UUID,
): Promise<boolean> {
  if (!fileHistoryEnabled()) {
    return false
  }

  const targetSnapshot = state.snapshots.findLast(
    snapshot => snapshot.messageId === messageId,
  )
  if (!targetSnapshot) {
    return false
  }

  for (const trackingPath of state.trackedFiles) {
    try {
      const filePath = maybeExpandFilePath(trackingPath)
      const targetBackup = targetSnapshot.trackedFileBackups[trackingPath]
      const backupFileName: BackupFileName | undefined = targetBackup
        ? targetBackup.backupFileName
        : getBackupFileNameFirstVersion(trackingPath, state)

      if (backupFileName === undefined) {
        continue
      }
      if (backupFileName === null) {
        // 备份记录显示文件不存在；用 stat 探测（先操作后捕获）。
        if (await pathExists(filePath)) return true
        continue
      }
      if (await checkOriginFileChanged(filePath, backupFileName)) return true
    } catch (error) {
      logError(error)
    }
  }
  return false
}

/**
 * 将给定的文件快照状态应用到被跟踪的文件上（在磁盘上写入/删除），
 * 返回变更文件路径列表。仅异步 IO。
 */
async function applySnapshot(
  state: FileHistoryState,
  targetSnapshot: FileHistorySnapshot,
): Promise<string[]> {
  const filesChanged: string[] = []
  for (const trackingPath of state.trackedFiles) {
    try {
      const filePath = maybeExpandFilePath(trackingPath)
      const targetBackup = targetSnapshot.trackedFileBackups[trackingPath]

      const backupFileName: BackupFileName | undefined = targetBackup
        ? targetBackup.backupFileName
        : getBackupFileNameFirstVersion(trackingPath, state)

      if (backupFileName === undefined) {
        // 解析备份时出错，因此不要触碰该文件
        logError(
          new Error('FileHistory: Error finding the backup file to apply'),
        )
        logEvent('tengu_file_history_rewind_restore_file_failed', {
          dryRun: false,
        })
        continue
      }

      if (backupFileName === null) {
        // 目标版本中文件不存在；若当前存在则删除它。
        try {
          await unlink(filePath)
          logForDebugging(`FileHistory: [Rewind] Deleted ${filePath}`)
          filesChanged.push(filePath)
        } catch (e: unknown) {
          if (!isENOENT(e)) throw e
          // 已不存在；无需处理。
        }
        continue
      }

      // 文件应存在于某个特定版本。仅在内容不同时才恢复。
      if (await checkOriginFileChanged(filePath, backupFileName)) {
        await restoreBackup(filePath, backupFileName)
        logForDebugging(
          `FileHistory: [Rewind] Restored ${filePath} from ${backupFileName}`,
        )
        filesChanged.push(filePath)
      }
    } catch (error) {
      logError(error)
      logEvent('tengu_file_history_rewind_restore_file_failed', {
        dryRun: false,
      })
    }
  }
  return filesChanged
}

/**
 * 检查原始文件相较备份文件是否已发生改变。
 * 可选地复用调用方预先获取的原始文件 stat（当调用方已经 stat 过以检查
 * 存在性时，避免第二次系统调用）。
 *
 * 导出用于测试。
 */
export async function checkOriginFileChanged(
  originalFile: string,
  backupFileName: string,
  originalStatsHint?: Stats,
): Promise<boolean> {
  const backupPath = resolveBackupPath(backupFileName)

  let originalStats: Stats | null = originalStatsHint ?? null
  if (!originalStats) {
    try {
      originalStats = await stat(originalFile)
    } catch (e: unknown) {
      if (!isENOENT(e)) return true
    }
  }
  let backupStats: Stats | null = null
  try {
    backupStats = await stat(backupPath)
  } catch (e: unknown) {
    if (!isENOENT(e)) return true
  }

  return compareStatsAndContent(originalStats, backupStats, async () => {
    try {
      const [originalContent, backupContent] = await Promise.all([
        readFile(originalFile, 'utf-8'),
        readFile(backupPath, 'utf-8'),
      ])
      return originalContent !== backupContent
    } catch {
      // stat 与 read 之间文件被删除 —— 视作已变更。
      return true
    }
  })
}

/**
 * 同步和异步变更检查共用的 stat/内容比较逻辑。
 * 如果文件相对备份已变更，返回 true。
 */
function compareStatsAndContent<T extends boolean | Promise<boolean>>(
  originalStats: Stats | null,
  backupStats: Stats | null,
  compareContent: () => T,
): T | boolean {
  // 一个存在一个缺失 —— 视作已变更
  if ((originalStats === null) !== (backupStats === null)) {
    return true
  }
  // 都缺失 —— 无变化
  if (originalStats === null || backupStats === null) {
    return false
  }

  // 检查权限和文件大小等 stat 字段
  if (
    originalStats.mode !== backupStats.mode ||
    originalStats.size !== backupStats.size
  ) {
    return true
  }

  // 这是一项依赖修改时间正确设置的优化。如果原始文件的修改时间早于
  // 备份时间，我们可以跳过文件内容比较。
  if (originalStats.mtimeMs < backupStats.mtimeMs) {
    return false
  }

  // 使用更昂贵的文件内容比较。回调自行处理读取错误——这里的
  // try/catch 对异步回调来说其实是死代码。
  return compareContent()
}

/**
 * 计算 diff 中变更的行数。
 */
async function computeDiffStatsForFile(
  originalFile: string,
  backupFileName?: string,
): Promise<DiffStats> {
  const filesChanged: string[] = []
  let insertions = 0
  let deletions = 0
  try {
    const backupPath = backupFileName
      ? resolveBackupPath(backupFileName)
      : undefined

    const [originalContent, backupContent] = await Promise.all([
      readFileAsyncOrNull(originalFile),
      backupPath ? readFileAsyncOrNull(backupPath) : null,
    ])

    if (originalContent === null && backupContent === null) {
      return {
        filesChanged,
        insertions,
        deletions,
      }
    }

    filesChanged.push(originalFile)

    // 计算 diff
    const changes = diffLines(originalContent ?? '', backupContent ?? '')
    changes.forEach(c => {
      if (c.added) {
        insertions += c.count || 0
      }
      if (c.removed) {
        deletions += c.count || 0
      }
    })
  } catch (error) {
    logError(new Error(`FileHistory: Error generating diffStats: ${error}`))
  }

  return {
    filesChanged,
    insertions,
    deletions,
  }
}

function getBackupFileName(filePath: string, version: number): string {
  const fileNameHash = createHash('sha256')
    .update(filePath)
    .digest('hex')
    .slice(0, 16)
  return `${fileNameHash}@v${version}`
}

function resolveBackupPath(backupFileName: string, sessionId?: string): string {
  const configDir = getClaudeConfigHomeDir()
  return join(
    configDir,
    'file-history',
    sessionId || getSessionId(),
    backupFileName,
  )
}

/**
 * 为 filePath 处的文件创建备份。如果文件不存在（ENOENT），则记录一个
 * null 备份（表示文件当时不存在的标记）。所有 IO 都是异步的。懒 mkdir：
 * 先尝试 copyFile，ENOENT 时再创建目录。
 */
async function createBackup(
  filePath: string | null,
  version: number,
): Promise<FileHistoryBackup> {
  if (filePath === null) {
    return { backupFileName: null, version, backupTime: new Date() }
  }

  const backupFileName = getBackupFileName(filePath, version)
  const backupPath = resolveBackupPath(backupFileName)

  // 先 stat：如果源文件不存在，记录一个 null 备份并跳过拷贝。
  // 这样可以干净地区分"源文件缺失"和"备份目录缺失"——如果共用一个
  // catch，那么 copyFile 成功与 stat 之间被删除的文件会留下一个孤儿
  // 备份，而 state 里却记录为 null。
  let srcStats: Stats
  try {
    srcStats = await stat(filePath)
  } catch (e: unknown) {
    if (isENOENT(e)) {
      return { backupFileName: null, version, backupTime: new Date() }
    }
    throw e
  }

  // copyFile 保留内容并避免把整个文件读进 JS 堆（之前的
  // readFileSync+writeFileSync 流水线会这么做，并在大体积被跟踪文件上
  // OOM）。懒 mkdir：99% 的调用命中快速路径（目录已存在）；遇到 ENOENT
  // 时再 mkdir 并重试。
  try {
    await copyFile(filePath, backupPath)
  } catch (e: unknown) {
    if (!isENOENT(e)) throw e
    await mkdir(dirname(backupPath), { recursive: true })
    await copyFile(filePath, backupPath)
  }

  // 在备份上保留文件权限。
  await chmod(backupPath, srcStats.mode)

  logEvent('tengu_file_history_backup_file_created', {
    version: version,
    fileSize: srcStats.size,
  })

  return {
    backupFileName,
    version,
    backupTime: new Date(),
  }
}

/**
 * 从备份路径恢复文件，会创建必要的目录并保留权限。
 * 懒 mkdir：先尝试 copyFile，ENOENT 时创建目录。
 */
async function restoreBackup(
  filePath: string,
  backupFileName: string,
): Promise<void> {
  const backupPath = resolveBackupPath(backupFileName)

  // 先 stat：如果备份不存在，记录日志并在尝试拷贝前退出。
  // 干净地区分"备份缺失"和"目标目录缺失"。
  let backupStats: Stats
  try {
    backupStats = await stat(backupPath)
  } catch (e: unknown) {
    if (isENOENT(e)) {
      logEvent('tengu_file_history_rewind_restore_file_failed', {})
      logError(
        new Error(`FileHistory: [Rewind] Backup file not found: ${backupPath}`),
      )
      return
    }
    throw e
  }

  // 懒 mkdir：99% 的调用命中快速路径（目标目录已存在）。
  try {
    await copyFile(backupPath, filePath)
  } catch (e: unknown) {
    if (!isENOENT(e)) throw e
    await mkdir(dirname(filePath), { recursive: true })
    await copyFile(backupPath, filePath)
  }

  // 恢复文件权限
  await chmod(filePath, backupStats.mode)
}

/**
 * 获取某个文件最早（第一个）的备份版本，用于回滚到某个目标备份点、
 * 但该文件当时还未被跟踪的场景。
 *
 * @returns 返回第一个版本的备份文件名；如果文件在第一个版本中不存在，
 * 返回 null；如果找不到任何第一个版本，返回 undefined
 */
function getBackupFileNameFirstVersion(
  trackingPath: string,
  state: FileHistoryState,
): BackupFileName | undefined {
  for (const snapshot of state.snapshots) {
    const backup = snapshot.trackedFileBackups[trackingPath]
    if (backup !== undefined && backup.version === 1) {
      // 可能是文件名也可能是 null，null 表示文件在第一个版本中不存在。
      return backup.backupFileName
    }
  }

  // undefined 表示解析第一个版本时出错。
  return undefined
}

/**
 * 使用相对路径作为键，以减少跟踪所需的 session 存储空间。
 */
function maybeShortenFilePath(filePath: string): string {
  if (!isAbsolute(filePath)) {
    return filePath
  }
  const cwd = getOriginalCwd()
  if (filePath.startsWith(cwd)) {
    return relative(cwd, filePath)
  }
  return filePath
}

function maybeExpandFilePath(filePath: string): string {
  if (isAbsolute(filePath)) {
    return filePath
  }
  return join(getOriginalCwd(), filePath)
}

/**
 * 为给定的 log 选项恢复文件历史快照状态。
 */
export function fileHistoryRestoreStateFromLog(
  fileHistorySnapshots: FileHistorySnapshot[],
  onUpdateState: (newState: FileHistoryState) => void,
): void {
  if (!fileHistoryEnabled()) {
    return
  }
  // 从绝对路径迁移到缩短后的相对跟踪路径时，复制一份快照。
  const snapshots: FileHistorySnapshot[] = []
  // 从快照重建被跟踪文件集合
  const trackedFiles = new Set<string>()
  for (const snapshot of fileHistorySnapshots) {
    const trackedFileBackups: Record<string, FileHistoryBackup> = {}
    for (const [path, backup] of Object.entries(snapshot.trackedFileBackups)) {
      const trackingPath = maybeShortenFilePath(path)
      trackedFiles.add(trackingPath)
      trackedFileBackups[trackingPath] = backup
    }
    snapshots.push({
      ...snapshot,
      trackedFileBackups: trackedFileBackups,
    })
  }
  onUpdateState({
    snapshots: snapshots,
    trackedFiles: trackedFiles,
    snapshotSequence: snapshots.length,
  })
}

/**
 * 为给定的 log 选项拷贝文件历史快照。
 */
export async function copyFileHistoryForResume(log: LogOption): Promise<void> {
  if (!fileHistoryEnabled()) {
    return
  }

  const fileHistorySnapshots = log.fileHistorySnapshots
  if (!fileHistorySnapshots || log.messages.length === 0) {
    return
  }
  const lastMessage = log.messages[log.messages.length - 1]
  const previousSessionId = lastMessage?.sessionId
  if (!previousSessionId) {
    logError(
      new Error(
        `FileHistory: Failed to copy backups on restore (no previous session id)`,
      ),
    )
    return
  }

  const sessionId = getSessionId()
  if (previousSessionId === sessionId) {
    logForDebugging(
      `FileHistory: No need to copy file history for resuming with same session id: ${sessionId}`,
    )
    return
  }

  try {
    // 所有备份共享同一个目录：{configDir}/file-history/{sessionId}/
    // 预先创建一次，而不是每个备份文件创建一次
    const newBackupDir = join(
      getClaudeConfigHomeDir(),
      'file-history',
      sessionId,
    )
    await mkdir(newBackupDir, { recursive: true })

    // 将所有备份文件从上一个 session 迁移到当前 session。
    // 并行处理所有快照；每个快照内部 link 也是并行执行。
    let failedSnapshots = 0
    await Promise.allSettled(
      fileHistorySnapshots.map(async snapshot => {
        const backupEntries = Object.values(snapshot.trackedFileBackups).filter(
          (backup): backup is typeof backup & { backupFileName: string } =>
            backup.backupFileName !== null,
        )

        const results = await Promise.allSettled(
          backupEntries.map(async ({ backupFileName }) => {
            const oldBackupPath = resolveBackupPath(
              backupFileName,
              previousSessionId,
            )
            const newBackupPath = join(newBackupDir, backupFileName)

            try {
              await link(oldBackupPath, newBackupPath)
            } catch (e: unknown) {
              const code = getErrnoCode(e)
              if (code === 'EEXIST') {
                // 已迁移过，跳过
                return
              }
              if (code === 'ENOENT') {
                logError(
                  new Error(
                    `FileHistory: Failed to copy backup ${backupFileName} on restore (backup file does not exist in ${previousSessionId})`,
                  ),
                )
                throw e
              }
              logError(
                new Error(
                  `FileHistory: Error hard linking backup file from previous session`,
                ),
              )
              // 硬链接失败时回退到拷贝
              try {
                await copyFile(oldBackupPath, newBackupPath)
              } catch (copyErr) {
                logError(
                  new Error(
                    `FileHistory: Error copying over backup from previous session`,
                  ),
                )
                throw copyErr
              }
            }

            logForDebugging(
              `FileHistory: Copied backup ${backupFileName} from session ${previousSessionId} to ${sessionId}`,
            )
          }),
        )

        const copyFailed = results.some(r => r.status === 'rejected')

        // 只有成功迁移了备份文件，才记录该快照
        if (!copyFailed) {
          void recordFileHistorySnapshot(
            snapshot.messageId,
            snapshot,
            false, // isSnapshotUpdate
          ).catch(_ => {
            logError(
              new Error(`FileHistory: Failed to record copy backup snapshot`),
            )
          })
        } else {
          failedSnapshots++
        }
      }),
    )

    if (failedSnapshots > 0) {
      logEvent('tengu_file_history_resume_copy_failed', {
        numSnapshots: fileHistorySnapshots.length,
        failedSnapshots,
      })
    }
  } catch (error) {
    logError(error)
  }
}

/**
 * 在快照之间发生变化的文件，通知 VSCode。
 * 将上一个快照与新快照对比，对任何内容发生变化的文件发送
 * file_updated 通知。
 * 触发即忘（由 fileHistoryMakeSnapshot 通过 void 方式派发）。
 */
async function notifyVscodeSnapshotFilesUpdated(
  oldState: FileHistoryState,
  newState: FileHistoryState,
): Promise<void> {
  const oldSnapshot = oldState.snapshots.at(-1)
  const newSnapshot = newState.snapshots.at(-1)

  if (!newSnapshot) {
    return
  }

  for (const trackingPath of newState.trackedFiles) {
    const filePath = maybeExpandFilePath(trackingPath)
    const oldBackup = oldSnapshot?.trackedFileBackups[trackingPath]
    const newBackup = newSnapshot.trackedFileBackups[trackingPath]

    // 两个备份指向同一版本时跳过（无变化）
    if (
      oldBackup?.backupFileName === newBackup?.backupFileName &&
      oldBackup?.version === newBackup?.version
    ) {
      continue
    }

    // 从上一个备份获取旧内容
    let oldContent: string | null = null
    if (oldBackup?.backupFileName) {
      const backupPath = resolveBackupPath(oldBackup.backupFileName)
      oldContent = await readFileAsyncOrNull(backupPath)
    }

    // 从新备份或当前文件获取新内容
    let newContent: string | null = null
    if (newBackup?.backupFileName) {
      const backupPath = resolveBackupPath(newBackup.backupFileName)
      newContent = await readFileAsyncOrNull(backupPath)
    }
    // 如果 newBackup?.backupFileName === null，说明文件被删除；newContent 保持为 null。

    // 仅当内容确实变化时才通知
    if (oldContent !== newContent) {
      notifyVscodeFileUpdated(filePath, oldContent, newContent)
    }
  }
}

/** 吞掉所有错误并返回 null 的异步读取（尽力而为）。 */
async function readFileAsyncOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

const ENABLE_DUMP_STATE = false
function maybeDumpStateForDebug(state: FileHistoryState): void {
  if (ENABLE_DUMP_STATE) {
    console.error(inspect(state, false, 5))
  }
}
