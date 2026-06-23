import { mkdir, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { lock } from './lockfile.js'
import { CLAUDE_DIR_NAME } from 'src/constants/claudeDirName.js'

const persistenceLocks = new Map<string, Promise<void>>()

/**
 * 两阶段持久化保留策略。活跃记录（queued/running 等）始终保留 ——
 * 对它们进行上限截断可能会驱逐进行中的工作；该职责由调用方的
 * 泄漏检测承担。非活跃（终结）记录按 `getTimestamp` 降序排列，
 * 并截断以填充 `max` 以下的剩余预算。
 *
 * 返回的列表无论活跃与否都按 `getTimestamp` 降序排列，因此
 * 持久化文件就是简单的逆时间顺序 —— 列表/UI 可以直接消费，
 * 无需重新排序。
 */
export function retainActiveFirst<T>(
  records: readonly T[],
  isActive: (record: T) => boolean,
  getTimestamp: (record: T) => number,
  max: number,
): T[] {
  const sortDesc = (left: T, right: T) =>
    getTimestamp(right) - getTimestamp(left)
  const active = records.filter(isActive).slice().sort(sortDesc)
  const history = records
    .filter(record => !isActive(record))
    .slice()
    .sort(sortDesc)
    .slice(0, Math.max(0, max - active.length))
  return [...active, ...history].sort(sortDesc)
}

export function getAutonomyPersistenceLockCountForTests(): number {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      'getAutonomyPersistenceLockCountForTests can only be called in tests',
    )
  }
  return persistenceLocks.size
}

export async function withAutonomyPersistenceLock<T>(
  rootDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(rootDir)
  const lockPath = join(key, CLAUDE_DIR_NAME, 'autonomy', '.lock')
  const previous = persistenceLocks.get(key) ?? Promise.resolve()

  let release!: () => void
  const current = new Promise<void>(resolve => {
    release = resolve
  })
  const chained = previous.then(() => current)
  persistenceLocks.set(key, chained)

  await previous
  try {
    await mkdir(join(key, CLAUDE_DIR_NAME, 'autonomy'), { recursive: true })
    await writeFile(lockPath, '', { flag: 'a' })
    const unlock = await lock(lockPath, {
      lockfilePath: `${lockPath}.lock`,
      retries: {
        retries: 10,
        factor: 1.2,
        minTimeout: 10,
        maxTimeout: 100,
      },
    })
    try {
      return await fn()
    } finally {
      await unlock().catch(() => {})
    }
  } finally {
    release()
    if (persistenceLocks.get(key) === chained) {
      persistenceLocks.delete(key)
    }
  }
}
