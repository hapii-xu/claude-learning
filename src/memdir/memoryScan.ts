/**
 * 记忆目录扫描原语。从 findRelevantMemories.ts 中分离出来，
 * 以便 extractMemories 可以导入扫描功能而不引入 sideQuery 和
 * API 客户端链（这会通过 memdir.ts 形成循环 —— #25372）。
 */

import { readdir } from 'fs/promises'
import { basename, join } from 'path'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { readFileInRange } from '../utils/readFileInRange.js'
import { type MemoryType, parseMemoryType } from './memoryTypes.js'

export type MemoryHeader = {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
}

const MAX_MEMORY_FILES = 200
const FRONTMATTER_MAX_LINES = 30

/**
 * 扫描记忆目录中的 .md 文件，读取它们的 frontmatter，并返回
 * 按最新优先排序的头部列表（上限为 MAX_MEMORY_FILES）。
 * findRelevantMemories（查询时召回）和 extractMemories（预注入
 * 列表以便提取代理不必花费一个回合执行 `ls`）共享此函数。
 *
 * 单次遍历：readFileInRange 在内部执行 stat 并返回 mtimeMs，
 * 因此我们先读取再排序，而不是 stat-排序-读取。对于常见情况
 * （N ≤ 200），与单独的 stat 轮次相比，这使系统调用减半；
 * 对于大 N，我们多读取一些小文件，但仍然避免对存活的 200 个
 * 文件执行双重 stat。
 */
export async function scanMemoryFiles(
  memoryDir: string,
  signal: AbortSignal,
): Promise<MemoryHeader[]> {
  try {
    const entries = await readdir(memoryDir, { recursive: true })
    const mdFiles = entries.filter(
      f => f.endsWith('.md') && basename(f) !== 'MEMORY.md',
    )

    const headerResults = await Promise.allSettled(
      mdFiles.map(async (relativePath): Promise<MemoryHeader> => {
        const filePath = join(memoryDir, relativePath)
        const { content, mtimeMs } = await readFileInRange(
          filePath,
          0,
          FRONTMATTER_MAX_LINES,
          undefined,
          signal,
        )
        const { frontmatter } = parseFrontmatter(content, filePath)
        return {
          filename: relativePath,
          filePath,
          mtimeMs,
          description: frontmatter.description || null,
          type: parseMemoryType(frontmatter.type),
        }
      }),
    )

    return headerResults
      .filter(
        (r): r is PromiseFulfilledResult<MemoryHeader> =>
          r.status === 'fulfilled',
      )
      .map(r => r.value)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_MEMORY_FILES)
  } catch {
    return []
  }
}

/**
 * 将记忆头部格式化为文本清单：每个文件一行，格式为
 * [type] filename (timestamp): description。同时用于召回
 * 选择器提示和提取代理提示。
 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map(m => {
      const tag = m.type ? `[${m.type}] ` : ''
      const ts = new Date(m.mtimeMs).toISOString()
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`
    })
    .join('\n')
}
