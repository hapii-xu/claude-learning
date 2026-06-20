import { isAbsolute, normalize } from 'path'
import { logForDebugging } from '../debug.js'
import { isENOENT } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import { containsPathTraversal } from '../path.js'

const LIMITS = {
  MAX_FILE_SIZE: 512 * 1024 * 1024, // 每个文件最大 512MB
  MAX_TOTAL_SIZE: 1024 * 1024 * 1024, // 总解压大小最大 1024MB
  MAX_FILE_COUNT: 100000, // 最大文件数
  MAX_COMPRESSION_RATIO: 50, // 超过 50:1 的任何比例都可疑
  MIN_COMPRESSION_RATIO: 0.5, // 低于 0.5:1 可能表示已经是压缩的恶意内容
}

/**
 * zip 文件解压期间的状态跟踪器
 */
type ZipValidationState = {
  fileCount: number
  totalUncompressedSize: number
  compressedSize: number
  errors: string[]
}

/**
 * 来自 fflate 过滤器的文件元数据
 */
type ZipFileMetadata = {
  name: string
  originalSize?: number
}

/**
 * 验证 zip 归档中单个文件的结果
 */
type FileValidationResult = {
  isValid: boolean
  error?: string
}

/**
 * 验证文件路径以防止路径遍历攻击
 */
export function isPathSafe(filePath: string): boolean {
  if (containsPathTraversal(filePath)) {
    return false
  }

  // 规范化路径以解析任何 '.' 段
  const normalized = normalize(filePath)

  // 检查绝对路径（我们在归档中只需要相对路径）
  if (isAbsolute(normalized)) {
    return false
  }

  return true
}

/**
 * 在 zip 解压期间验证单个文件
 */
export function validateZipFile(
  file: ZipFileMetadata,
  state: ZipValidationState,
): FileValidationResult {
  state.fileCount++

  let error: string | undefined

  // 检查文件数量
  if (state.fileCount > LIMITS.MAX_FILE_COUNT) {
    error = `归档包含过多文件：${state.fileCount}（最大：${LIMITS.MAX_FILE_COUNT}）`
  }

  // 验证路径安全性
  if (!isPathSafe(file.name)) {
    error = `检测到不安全的文件路径："${file.name}"。不允许路径遍历或绝对路径。`
  }

  // 检查单个文件大小
  const fileSize = file.originalSize || 0
  if (fileSize > LIMITS.MAX_FILE_SIZE) {
    error = `文件 "${file.name}" 过大：${Math.round(fileSize / 1024 / 1024)}MB（最大：${Math.round(LIMITS.MAX_FILE_SIZE / 1024 / 1024)}MB）`
  }

  // 跟踪总解压大小
  state.totalUncompressedSize += fileSize

  // 检查总大小
  if (state.totalUncompressedSize > LIMITS.MAX_TOTAL_SIZE) {
    error = `归档总大小过大：${Math.round(state.totalUncompressedSize / 1024 / 1024)}MB（最大：${Math.round(LIMITS.MAX_TOTAL_SIZE / 1024 / 1024)}MB）`
  }

  // 检查压缩比以检测 zip 炸弹
  const currentRatio = state.totalUncompressedSize / state.compressedSize
  if (currentRatio > LIMITS.MAX_COMPRESSION_RATIO) {
    error = `检测到可疑的压缩比：${currentRatio.toFixed(1)}:1（最大：${LIMITS.MAX_COMPRESSION_RATIO}:1）。这可能是 zip 炸弹。`
  }

  return error ? { isValid: false, error } : { isValid: true }
}

/**
 * 从 Buffer 解压数据并将其内容作为文件路径到 Uint8Array 数据的记录返回。
 * 使用 unzipSync 以避免 bun 中 fflate worker 终止崩溃。
 * 接受原始 zip 字节，以便调用方可以异步读取文件。
 *
 * fflate 是延迟导入的，以避免其约 196KB 的顶级查找表
 * （revfd Int32Array(32769)、rev Uint16Array(32768) 等）在启动时
 * 通过插件加载器链到达此模块时被分配。
 */
export async function unzipFile(
  zipData: Buffer,
): Promise<Record<string, Uint8Array>> {
  const { unzipSync } = await import('fflate')
  const compressedSize = zipData.length

  const state: ZipValidationState = {
    fileCount: 0,
    totalUncompressedSize: 0,
    compressedSize: compressedSize,
    errors: [],
  }

  const result = unzipSync(new Uint8Array(zipData), {
    filter: file => {
      const validationResult = validateZipFile(file, state)
      if (!validationResult.isValid) {
        throw new Error(validationResult.error!)
      }
      return true
    },
  })

  logForDebugging(
    `Zip 解压完成：${state.fileCount} 个文件，${Math.round(state.totalUncompressedSize / 1024)}KB 解压后大小`,
  )

  return result
}

/**
 * 从 zip 的中央目录解析 Unix 文件模式。
 *
 * fflate 的 `unzipSync` 只返回 `Record<string, Uint8Array>` — 它不
 * 暴露存储在中央目录中的外部文件属性。这意味着可执行位
 * 在解压过程中丢失（所有文件变为 0644）。git-clone 路径原生
 * 保留 +x，但 GCS/zip 路径需要此辅助函数来保持对等。
 *
 * 返回在 Unix 主机上创建的条目的 `name → mode`（`versionMadeBy`
 * 高字节 === 3）。来自其他主机的条目，或未设置模式位的条目
 * 被省略。调用方应将缺失的键视为"使用默认模式"。
 *
 * 格式根据 PKZIP APPNOTE.TXT §4.3.12（中央目录）和 §4.3.16（EOCD）。
 * 不处理 ZIP64 — 对 >4GB 或 >65535 个条目的归档返回 `{}`，
 * 这对于 marketplace zip（约 3.5MB）和 MCPB 包来说没问题。
 */
export function parseZipModes(data: Uint8Array): Record<string, number> {
  // Buffer 视图用于 readUInt* 方法 — 共享内存，无复制。
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const modes: Record<string, number> = {}

  // 1. 查找中央目录结束记录（签名 0x06054b50）。它位于
  //    尾部 22 + 65535 字节（固定 EOCD 大小 + 最大注释长度）。
  //    向后扫描 — EOCD 通常是最后 22 个字节。
  const minEocd = Math.max(0, buf.length - 22 - 0xffff)
  let eocd = -1
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return modes // 格式错误 — 让 fflate 的错误在其他地方浮现

  const entryCount = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16) // 中央目录起始偏移

  // 2. 遍历中央目录条目（签名 0x02014b50）。每个条目有一个
  //    46 字节的固定头，后跟可变长度的名称/额外/注释。
  for (let i = 0; i < entryCount; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break
    const versionMadeBy = buf.readUInt16LE(off + 4)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const externalAttr = buf.readUInt32LE(off + 38)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)

    // versionMadeBy 高字节 = 主机操作系统。3 = Unix。对于 Unix zip，
    // externalAttr 的高 16 位保存 st_mode（文件类型 + 权限位）。
    if (versionMadeBy >> 8 === 3) {
      const mode = (externalAttr >>> 16) & 0xffff
      if (mode) modes[name] = mode
    }

    off += 46 + nameLen + extraLen + commentLen
  }

  return modes
}

/**
 * 从磁盘异步读取 zip 文件并解压。
 * 将其内容作为文件路径到 Uint8Array 数据的记录返回。
 */
export async function readAndUnzipFile(
  filePath: string,
): Promise<Record<string, Uint8Array>> {
  const fs = getFsImplementation()

  try {
    const zipData = await fs.readFileBytes(filePath)
    // 这里需要 await：没有它，来自现在异步的
    // unzipFile() 的拒绝会逃脱 try/catch 并绕过下面的错误包装。
    return await unzipFile(zipData)
  } catch (error) {
    if (isENOENT(error)) {
      throw error
    }
    const errorMessage = error instanceof Error ? error.message : String(error)
    throw new Error(`读取或解压文件失败：${errorMessage}`)
  }
}
