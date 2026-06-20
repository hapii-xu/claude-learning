import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * 文件级 mtime-based 缓存
 * 缓存写入到 .cache/learning-web/<namespace>/<hash>.json
 * 失效条件：源文件 mtime 变化
 */

const CACHE_DIR = path.resolve(
  import.meta.dirname,
  '..',
  '.cache',
  'learning-web',
)

interface CacheEntry<T> {
  sourcePath: string
  sourceMtime: number
  createdAt: number
  data: T
}

function ensureCacheDir(namespace: string): string {
  const dir = path.join(CACHE_DIR, namespace)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function cacheKey(sourcePath: string, extra = ''): string {
  const input = `${sourcePath}:${extra}`
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 16)
}

function getMtime(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 从缓存读取（未命中或失效返回 null）
 */
export function readCache<T>(
  namespace: string,
  sourcePath: string,
  extra = '',
): T | null {
  try {
    const dir = ensureCacheDir(namespace)
    const key = cacheKey(sourcePath, extra)
    const cacheFile = path.join(dir, `${key}.json`)

    if (!fs.existsSync(cacheFile)) return null

    const entry: CacheEntry<T> = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'))

    // 失效检查：源文件 mtime 变化
    const currentMtime = getMtime(entry.sourcePath)
    if (currentMtime !== entry.sourceMtime) {
      // 过期 — 删除旧缓存
      try {
        fs.unlinkSync(cacheFile)
      } catch {
        /* ignore */
      }
      return null
    }

    return entry.data
  } catch {
    return null
  }
}

/**
 * 写入缓存
 */
export function writeCache<T>(
  namespace: string,
  sourcePath: string,
  data: T,
  extra = '',
): void {
  try {
    const dir = ensureCacheDir(namespace)
    const key = cacheKey(sourcePath, extra)
    const cacheFile = path.join(dir, `${key}.json`)

    const entry: CacheEntry<T> = {
      sourcePath,
      sourceMtime: getMtime(sourcePath),
      createdAt: Date.now(),
      data,
    }

    fs.writeFileSync(cacheFile, JSON.stringify(entry), 'utf-8')
  } catch {
    // 缓存写入失败不阻塞主逻辑
  }
}

/**
 * 清除指定 namespace 下的所有缓存
 */
export function clearCache(namespace: string): void {
  const dir = path.join(CACHE_DIR, namespace)
  try {
    if (fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir)) {
        fs.unlinkSync(path.join(dir, file))
      }
    }
  } catch {
    // ignore
  }
}
