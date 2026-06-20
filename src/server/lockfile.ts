// 自动生成的存根 - 用真实实现替换

export interface ServerLockInfo {
  pid: number
  port: number
  host: string
  httpUrl: string
  startedAt: number
}

export const writeServerLock: (info: ServerLockInfo) => Promise<void> =
  async () => {}
export const removeServerLock: () => Promise<void> = async () => {}
export const probeRunningServer: () => Promise<ServerLockInfo | null> =
  async () => null
