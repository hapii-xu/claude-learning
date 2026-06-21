import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'

/**
 * 持久化到磁盘的 daemon 状态，使 `status` / `stop` 可以在
 * 与启动 daemon 的 CLI 进程不同的另一个 CLI 进程中工作。
 */
export interface DaemonStateData {
  pid: number
  cwd: string
  startedAt: string
  workerKinds: string[]
  lastStatus: 'running' | 'stopped' | 'error'
}

export type DaemonStatus = 'running' | 'stopped' | 'stale'

/**
 * 返回指定 daemon 名称对应的 daemon 状态文件路径。
 */
export function getDaemonStateFilePath(name = 'remote-control'): string {
  return join(getClaudeConfigHomeDir(), 'daemon', `${name}.json`)
}

/**
 * 将 daemon 状态写入磁盘。由 supervisor 在启动时调用。
 */
export function writeDaemonState(
  state: DaemonStateData,
  name = 'remote-control',
): void {
  const filePath = getDaemonStateFilePath(name)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8')
}

/**
 * 从磁盘读取 daemon 状态。状态文件不存在时返回 null。
 */
export function readDaemonState(
  name = 'remote-control',
): DaemonStateData | null {
  const filePath = getDaemonStateFilePath(name)
  try {
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as DaemonStateData
  } catch {
    return null
  }
}

/**
 * 移除 daemon 状态文件。
 */
export function removeDaemonState(name = 'remote-control'): void {
  const filePath = getDaemonStateFilePath(name)
  try {
    unlinkSync(filePath)
  } catch {
    // 文件可能不存在——没关系
  }
}

/**
 * 检查给定 PID 的进程是否存活。
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 通过读取状态文件并探测 PID 来查询 daemon 状态。
 *
 * 返回值：
 *  - { status: 'running', state } —— PID 存活
 *  - { status: 'stopped' }        —— 无状态文件
 *  - { status: 'stale' }          —— 状态文件存在但 PID 已死亡（自动清理）
 */
export function queryDaemonStatus(name = 'remote-control'): {
  status: DaemonStatus
  state?: DaemonStateData
} {
  const state = readDaemonState(name)
  if (!state) {
    return { status: 'stopped' }
  }

  if (isProcessAlive(state.pid)) {
    return { status: 'running', state }
  }

  // 陈旧——进程已死亡但状态文件仍存在
  removeDaemonState(name)
  return { status: 'stale' }
}

/**
 * 通过发送 SIGTERM、等待、必要时再发送 SIGKILL 来停止运行中的 daemon。
 * 之后会清理状态文件。
 *
 * @returns daemon 已停止则返回 true，未在运行则返回 false
 */
export async function stopDaemonByPid(
  name = 'remote-control',
  timeoutMs = 10_000,
): Promise<boolean> {
  const state = readDaemonState(name)
  if (!state) {
    return false
  }

  const { pid } = state

  if (!isProcessAlive(pid)) {
    removeDaemonState(name)
    return false
  }

  // 发送 SIGTERM
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    removeDaemonState(name)
    return false
  }

  // 带超时地等待退出
  const deadline = Date.now() + timeoutMs
  const pollInterval = 200

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      removeDaemonState(name)
      return true
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval))
  }

  // 强制 kill
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 已经死亡
  }

  // 短暂等待 SIGKILL 生效
  await new Promise(resolve => setTimeout(resolve, 500))

  removeDaemonState(name)
  return true
}
