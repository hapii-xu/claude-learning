import { detectFileEncoding } from './file.js'
import { getFsImplementation } from './fsOperations.js'

type CachedFileData = {
  content: string
  encoding: BufferEncoding
  mtime: number
}

/**
 * 一个简单的内存文件内容缓存，基于修改时间自动失效。
 * 消除 FileEditTool 操作中的冗余文件读取。
 */
class FileReadCache {
  private cache = new Map<string, CachedFileData>()
  private readonly maxCacheSize = 1000

  /**
   * 带缓存读取文件，返回内容和编码。
   * 缓存键包含文件路径和修改时间以实现自动失效。
   */
  readFile(filePath: string): { content: string; encoding: BufferEncoding } {
    const fs = getFsImplementation()

    // 获取文件 stat 用于缓存失效
    let stats
    try {
      stats = fs.statSync(filePath)
    } catch (error) {
      // 文件已删除，从缓存中移除并重新抛出异常
      this.cache.delete(filePath)
      throw error
    }

    const cacheKey = filePath
    const cachedData = this.cache.get(cacheKey)

    // 检查是否有有效的缓存数据
    if (cachedData && cachedData.mtime === stats.mtimeMs) {
      return {
        content: cachedData.content,
        encoding: cachedData.encoding,
      }
    }

    // 缓存未命中或数据过期 — 读取文件
    const encoding = detectFileEncoding(filePath)
    const content = fs
      .readFileSync(filePath, { encoding })
      .replaceAll('\r\n', '\n')

    // 更新缓存
    this.cache.set(cacheKey, {
      content,
      encoding,
      mtime: stats.mtimeMs,
    })

    // 若缓存过大则驱逐最旧的条目
    if (this.cache.size > this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) {
        this.cache.delete(firstKey)
      }
    }

    return { content, encoding }
  }

  /**
   * 清空整个缓存，适用于测试或内存管理。
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * 从缓存中移除特定文件。
   */
  invalidate(filePath: string): void {
    this.cache.delete(filePath)
  }

  /**
   * 获取缓存统计信息，用于调试/监控。
   */
  getStats(): { size: number; entries: string[] } {
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.keys()),
    }
  }
}

// 导出单例
export const fileReadCache = new FileReadCache()
