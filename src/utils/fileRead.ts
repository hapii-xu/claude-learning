/**
 * 同步文件读取路径，从 file.ts 中提取。
 *
 * file.ts 通过 log.ts → types/logs.ts → types/message.ts →
 * Tool.ts → commands.ts → … 位于设置的 SCC 中。任何需要从 file.ts
 * 使用 readFileSync 的模块都会拉入整个依赖链。此叶子模块仅导入
 * fsOperations 和 debug，两者均终止于 Node 内置模块。
 *
 * detectFileEncoding/detectLineEndings 保留在 file.ts 中 — 它们在意外失败时
 * 调用 logError（log.ts → SCC）。这里的 -ForResolvedPath/-ForString
 * 辅助函数是纯净部分；需要日志包装器的调用方从 file.ts 导入。
 */

import { logForDebugging } from './debug.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'

export type LineEndingType = 'CRLF' | 'LF'

export function detectEncodingForResolvedPath(
  resolvedPath: string,
): BufferEncoding {
  const { buffer, bytesRead } = getFsImplementation().readSync(resolvedPath, {
    length: 4096,
  })

  // 空文件应默认使用 utf8 而非 ascii
  // 这修复了向空文件写入 emoji/CJK 导致乱码的 bug
  if (bytesRead === 0) {
    return 'utf8'
  }

  if (bytesRead >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf16le'
  }

  if (
    bytesRead >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    return 'utf8'
  }

  // 对非空文件默认使用 utf8，因为它是 ascii 的超集
  // 且能正确处理所有 Unicode 字符
  return 'utf8'
}

export function detectLineEndingsForString(content: string): LineEndingType {
  let crlfCount = 0
  let lfCount = 0

  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      if (i > 0 && content[i - 1] === '\r') {
        crlfCount++
      } else {
        lfCount++
      }
    }
  }

  return crlfCount > lfCount ? 'CRLF' : 'LF'
}

/**
 * 类似 readFileSync，但在一次文件系统遍历中同时返回检测到的编码和原始行结束风格。
 * 回写文件的调用方（如 FileEditTool）可复用这些信息，而无需分别调用
 * detectFileEncoding / detectLineEndings，后者每次都会重做 safeResolvePath +
 * readSync(4KB)。
 */
export function readFileSyncWithMetadata(filePath: string): {
  content: string
  encoding: BufferEncoding
  lineEndings: LineEndingType
} {
  const fs = getFsImplementation()
  const { resolvedPath, isSymlink } = safeResolvePath(fs, filePath)

  if (isSymlink) {
    logForDebugging(`Reading through symlink: ${filePath} -> ${resolvedPath}`)
  }

  const encoding = detectEncodingForResolvedPath(resolvedPath)
  const raw = fs.readFileSync(resolvedPath, { encoding })
  // 在 CRLF 规范化消除差异之前，从原始头部检测行结束符。
  // 4096 个代码单元 ≥ detectLineEndings 的 4096 字节 readSync 采样
  //（行结束符是 ASCII，因此单位不匹配无关紧要）。
  const lineEndings = detectLineEndingsForString(raw.slice(0, 4096))
  return {
    content: raw.replaceAll('\r\n', '\n'),
    encoding,
    lineEndings,
  }
}

export function readFileSync(filePath: string): string {
  return readFileSyncWithMetadata(filePath).content
}
