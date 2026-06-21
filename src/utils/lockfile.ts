/**
 * proper-lockfile 的惰性访问器。
 *
 * proper-lockfile 依赖 graceful-fs，后者在首次 require 时会
 * monkey-patch 所有 fs 方法（约 8ms）。静态导入 proper-lockfile 会将此
 * 开销拉入启动路径，即使不发生任何锁定（如 `--help`）。
 *
 * 请导入此模块而非直接导入 `proper-lockfile`。底层
 * 包仅在首次实际调用 lock 函数时加载。
 */

import type { CheckOptions, LockOptions, UnlockOptions } from 'proper-lockfile'

type Lockfile = typeof import('proper-lockfile')

let _lockfile: Lockfile | undefined

function getLockfile(): Lockfile {
  if (!_lockfile) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _lockfile = require('proper-lockfile') as Lockfile
  }
  return _lockfile
}

export function lock(
  file: string,
  options?: LockOptions,
): Promise<() => Promise<void>> {
  return getLockfile().lock(file, options)
}

export function lockSync(file: string, options?: LockOptions): () => void {
  return getLockfile().lockSync(file, options)
}

export function unlock(file: string, options?: UnlockOptions): Promise<void> {
  return getLockfile().unlock(file, options)
}

export function check(file: string, options?: CheckOptions): Promise<boolean> {
  return getLockfile().check(file, options)
}
