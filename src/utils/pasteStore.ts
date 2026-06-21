import { createHash } from 'crypto'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { isENOENT } from './errors.js'

const PASTE_STORE_DIR = 'paste-cache'

/**
 * 获取粘贴存储目录（跨会话持久化）。
 */
function getPasteStoreDir(): string {
  return join(getClaudeConfigHomeDir(), PASTE_STORE_DIR)
}

/**
 * 为粘贴内容生成哈希作为文件名。
 * 导出以便调用方在异步存储之前同步获取哈希。
 */
export function hashPastedText(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/**
 * 通过内容哈希获取粘贴文件路径。
 */
function getPastePath(hash: string): string {
  return join(getPasteStoreDir(), `${hash}.txt`)
}

/**
 * 将粘贴的文本内容存储到磁盘。
 * 哈希应已通过 hashPastedText() 预计算，以便调用方
 * 无需等待异步磁盘写入即可立即使用。
 */
export async function storePastedText(
  hash: string,
  content: string,
): Promise<void> {
  try {
    const dir = getPasteStoreDir()
    await mkdir(dir, { recursive: true })

    const pastePath = getPastePath(hash)

    // 内容可寻址：相同哈希 = 相同内容，因此覆盖是安全的
    await writeFile(pastePath, content, { encoding: 'utf8', mode: 0o600 })
    logForDebugging(`Stored paste ${hash} to ${pastePath}`)
  } catch (error) {
    logForDebugging(`Failed to store paste: ${error}`)
  }
}

/**
 * 通过哈希检索粘贴的文本内容。
 * 未找到或出错时返回 null。
 */
export async function retrievePastedText(hash: string): Promise<string | null> {
  try {
    const pastePath = getPastePath(hash)
    return await readFile(pastePath, { encoding: 'utf8' })
  } catch (error) {
    // ENOENT 是粘贴不存在的预期情况
    if (!isENOENT(error)) {
      logForDebugging(`Failed to retrieve paste ${hash}: ${error}`)
    }
    return null
  }
}

/**
 * 清理不再被引用的旧粘贴文件。
 * 这是简单的基于时间的清理 - 移除早于 cutoffDate 的文件。
 */
export async function cleanupOldPastes(cutoffDate: Date): Promise<void> {
  const pasteDir = getPasteStoreDir()

  let files
  try {
    files = await readdir(pasteDir)
  } catch {
    // 目录不存在或无法读取 - 无需清理
    return
  }

  const cutoffTime = cutoffDate.getTime()
  for (const file of files) {
    if (!file.endsWith('.txt')) {
      continue
    }

    const filePath = join(pasteDir, file)
    try {
      const stats = await stat(filePath)
      if (stats.mtimeMs < cutoffTime) {
        await unlink(filePath)
        logForDebugging(`Cleaned up old paste: ${filePath}`)
      }
    } catch {
      // 忽略单个文件的错误
    }
  }
}
