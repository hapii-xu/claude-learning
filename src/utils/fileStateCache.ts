import { LRUCache } from 'lru-cache'
import { normalize } from 'path'

export type FileState = {
  content: string
  timestamp: number
  offset: number | undefined
  limit: number | undefined
  // 当此条目由自动注入（如 CLAUDE.md）填充且注入内容与磁盘不匹配时为 true
  //（已剥离 HTML 注释、frontmatter 或截断了 MEMORY.md）。模型只看到了部分视图；
  // Edit/Write 必须先进行显式 Read。`content` 此处保存的是原始磁盘字节
  //（用于 getChangedFiles 差异对比），而非模型看到的内容。
  isPartialView?: boolean
}

// 读取文件状态缓存的默认最大条目数
export const READ_FILE_STATE_CACHE_SIZE = 100

// 文件状态缓存的默认大小限制（25MB）
// 防止大文件内容导致内存无限增长
const DEFAULT_MAX_CACHE_SIZE_BYTES = 25 * 1024 * 1024

/**
 * 一个在访问前对所有路径键进行规范化的文件状态缓存。
 * 确保无论调用方传入相对路径还是含冗余段的绝对路径（如 /foo/../bar）
 * 或 Windows 上的混合路径分隔符（/ 与 \），缓存命中均保持一致。
 */
export class FileStateCache {
  private cache: LRUCache<string, FileState>

  constructor(maxEntries: number, maxSizeBytes: number) {
    this.cache = new LRUCache<string, FileState>({
      max: maxEntries,
      maxSize: maxSizeBytes,
      sizeCalculation: value => {
        const c = value.content
        const s =
          typeof c === 'string'
            ? c
            : c === null || c === undefined
              ? ''
              : typeof c === 'object'
                ? JSON.stringify(c)
                : String(c)
        return Math.max(1, Buffer.byteLength(s, 'utf8'))
      },
    })
  }

  get(key: string): FileState | undefined {
    return this.cache.get(normalize(key))
  }

  set(key: string, value: FileState): this {
    this.cache.set(normalize(key), value)
    return this
  }

  has(key: string): boolean {
    return this.cache.has(normalize(key))
  }

  delete(key: string): boolean {
    return this.cache.delete(normalize(key))
  }

  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }

  get max(): number {
    return this.cache.max
  }

  get maxSize(): number {
    return this.cache.maxSize
  }

  get calculatedSize(): number {
    return this.cache.calculatedSize
  }

  keys(): Generator<string> {
    return this.cache.keys()
  }

  entries(): Generator<[string, FileState]> {
    return this.cache.entries()
  }

  dump(): ReturnType<LRUCache<string, FileState>['dump']> {
    return this.cache.dump()
  }

  load(entries: ReturnType<LRUCache<string, FileState>['dump']>): void {
    this.cache.load(entries)
  }
}

/**
 * 创建带大小限制的 FileStateCache 的工厂函数。
 * 使用 LRUCache 内置的基于大小的驱逐策略防止内存膨胀。
 * 注意：图像不缓存（见 FileReadTool），因此大小限制主要针对
 * 大型文本文件、notebook 及其他可编辑内容。
 */
export function createFileStateCacheWithSizeLimit(
  maxEntries: number,
  maxSizeBytes: number = DEFAULT_MAX_CACHE_SIZE_BYTES,
): FileStateCache {
  return new FileStateCache(maxEntries, maxSizeBytes)
}

// 将缓存转换为对象的辅助函数（供 compact.ts 使用）
export function cacheToObject(
  cache: FileStateCache,
): Record<string, FileState> {
  return Object.fromEntries(cache.entries())
}

// 获取缓存中所有键的辅助函数（供多个组件使用）
export function cacheKeys(cache: FileStateCache): string[] {
  return Array.from(cache.keys())
}

// 克隆 FileStateCache 的辅助函数
// 从源缓存保留大小限制配置
export function cloneFileStateCache(cache: FileStateCache): FileStateCache {
  const cloned = createFileStateCacheWithSizeLimit(cache.max, cache.maxSize)
  cloned.load(cache.dump())
  return cloned
}

// 合并两个文件状态缓存，较新的条目（按时间戳）覆盖较旧的条目
export function mergeFileStateCaches(
  first: FileStateCache,
  second: FileStateCache,
): FileStateCache {
  const merged = cloneFileStateCache(first)
  for (const [filePath, fileState] of second.entries()) {
    const existing = merged.get(filePath)
    // 仅当新条目更新时才覆盖
    if (!existing || fileState.timestamp > existing.timestamp) {
      merged.set(filePath, fileState)
    }
  }
  return merged
}
