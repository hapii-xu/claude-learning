import envPaths from 'env-paths'
import { join } from 'path'
import { getFsImplementation } from './fsOperations.js'
import { djb2Hash } from './hash.js'

const paths = envPaths('claude-cli')

// 本地 sanitizePath 使用 djb2Hash —— 不是 sessionStoragePortable.ts 中
// 优先使用 Bun.hash (wyhash) 的共享版本。缓存目录名必须在升级时保持稳定，
// 以便现有缓存数据（错误日志、MCP 日志）不会被孤立。
const MAX_SANITIZED_LENGTH = 200
function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized
  }
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${Math.abs(djb2Hash(name)).toString(36)}`
}

function getProjectDir(cwd: string): string {
  return sanitizePath(cwd)
}

export const CACHE_PATHS = {
  baseLogs: () => join(paths.cache, getProjectDir(getFsImplementation().cwd())),
  errors: () =>
    join(paths.cache, getProjectDir(getFsImplementation().cwd()), 'errors'),
  messages: () =>
    join(paths.cache, getProjectDir(getFsImplementation().cwd()), 'messages'),
  mcpLogs: (serverName: string) =>
    join(
      paths.cache,
      getProjectDir(getFsImplementation().cwd()),
      // 为 Windows 兼容性清理服务器名称（冒号保留给驱动器号）
      `mcp-logs-${sanitizePath(serverName)}`,
    ),
}
