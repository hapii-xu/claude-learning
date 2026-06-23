/**
 * 可移植的会话存储工具函数。
 *
 * 纯 Node.js 实现 — 不依赖日志、实验或功能标志等内部模块。
 * 由 CLI（src/utils/sessionStorage.ts）和 VS Code 扩展
 *（packages/claude-vscode/src/common-host/sessionStorage.ts）共享。
 */

import type { UUID } from 'crypto'
import { open as fsOpen, readdir, realpath, stat } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { getWorktreePathsPortable } from './getWorktreePathsPortable.js'
import { djb2Hash } from './hash.js'

/** 轻量元数据读取时首尾缓冲区的大小。 */
export const LITE_READ_BUF_SIZE = 65536

// ---------------------------------------------------------------------------
// UUID 校验
// ---------------------------------------------------------------------------

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validateUuid(maybeUuid: unknown): UUID | null {
  if (typeof maybeUuid !== 'string') return null
  return uuidRegex.test(maybeUuid) ? (maybeUuid as UUID) : null
}

// ---------------------------------------------------------------------------
// JSON 字符串字段提取 — 无需完整解析，可处理截断的行
// ---------------------------------------------------------------------------

/**
 * 对从原始文本中提取的 JSON 字符串值进行反转义。
 * 仅在存在转义序列时才分配新字符串。
 */
export function unescapeJsonString(raw: string): string {
  if (!raw.includes('\\')) return raw
  try {
    return JSON.parse(`"${raw}"`)
  } catch {
    return raw
  }
}

/**
 * 从原始文本中提取简单 JSON 字符串字段值，无需完整解析。
 * 查找 `"key":"value"` 或 `"key": "value"` 模式。
 * 返回第一个匹配项，未找到则返回 undefined。
 */
export function extractJsonStringField(
  text: string,
  key: string,
): string | undefined {
  const patterns = [`"${key}":"`, `"${key}": "`]
  for (const pattern of patterns) {
    const idx = text.indexOf(pattern)
    if (idx < 0) continue

    const valueStart = idx + pattern.length
    let i = valueStart
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2
        continue
      }
      if (text[i] === '"') {
        return unescapeJsonString(text.slice(valueStart, i))
      }
      i++
    }
  }
  return undefined
}

/**
 * 与 extractJsonStringField 类似，但查找最后一次出现的位置。
 * 适用于追加写入的字段（如 customTitle、tag 等）。
 */
export function extractLastJsonStringField(
  text: string,
  key: string,
): string | undefined {
  const patterns = [`"${key}":"`, `"${key}": "`]
  let lastValue: string | undefined
  for (const pattern of patterns) {
    let searchFrom = 0
    while (true) {
      const idx = text.indexOf(pattern, searchFrom)
      if (idx < 0) break

      const valueStart = idx + pattern.length
      let i = valueStart
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2
          continue
        }
        if (text[i] === '"') {
          lastValue = unescapeJsonString(text.slice(valueStart, i))
          break
        }
        i++
      }
      searchFrom = i + 1
    }
  }
  return lastValue
}

// ---------------------------------------------------------------------------
// 从头部块中提取首条提示词
// ---------------------------------------------------------------------------

/**
 * 用于匹配自动生成或系统消息的模式，在查找第一条有意义的用户提示词时跳过这些内容。
 * 匹配以小写 XML 类标签开头的内容（IDE 上下文、hook 输出、任务通知、频道消息等）
 * 或合成中断标记。
 */
const SKIP_FIRST_PROMPT_PATTERN =
  /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

const COMMAND_NAME_RE = /<command-name>(.*?)<\/command-name>/

/**
 * 从 JSONL 头部块中提取第一条有意义的用户提示词。
 *
 * 跳过 tool_result 消息、isMeta、isCompactSummary、command-name 消息
 * 以及自动生成的模式（会话 hook、tick、IDE 元数据等）。
 * 截断至 200 个字符。
 */
export function extractFirstPromptFromHead(head: string): string {
  let start = 0
  let commandFallback = ''
  while (start < head.length) {
    const newlineIdx = head.indexOf('\n', start)
    const line =
      newlineIdx >= 0 ? head.slice(start, newlineIdx) : head.slice(start)
    start = newlineIdx >= 0 ? newlineIdx + 1 : head.length

    if (!line.includes('"type":"user"') && !line.includes('"type": "user"'))
      continue
    if (line.includes('"tool_result"')) continue
    if (line.includes('"isMeta":true') || line.includes('"isMeta": true'))
      continue
    if (
      line.includes('"isCompactSummary":true') ||
      line.includes('"isCompactSummary": true')
    )
      continue

    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      if (entry.type !== 'user') continue

      const message = entry.message as Record<string, unknown> | undefined
      if (!message) continue

      const content = message.content
      const texts: string[] = []
      if (typeof content === 'string') {
        texts.push(content)
      } else if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === 'text' && typeof block.text === 'string') {
            texts.push(block.text as string)
          }
        }
      }

      for (const raw of texts) {
        let result = raw.replace(/\n/g, ' ').trim()
        if (!result) continue

        // 跳过斜杠命令消息，但记住第一条作为备选
        const cmdMatch = COMMAND_NAME_RE.exec(result)
        if (cmdMatch) {
          if (!commandFallback) commandFallback = cmdMatch[1]!
          continue
        }

        // 在通用 XML 跳过逻辑之前，为 bash 输入添加 ! 前缀格式化
        const bashMatch = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(result)
        if (bashMatch) return `! ${bashMatch[1]!.trim()}`

        if (SKIP_FIRST_PROMPT_PATTERN.test(result)) continue

        if (result.length > 200) {
          result = result.slice(0, 200).trim() + '\u2026'
        }
        return result
      }
    } catch {}
  }
  if (commandFallback) return commandFallback
  return ''
}

// ---------------------------------------------------------------------------
// 文件 I/O — 读取文件的首尾内容
// ---------------------------------------------------------------------------

/**
 * 读取文件的前 LITE_READ_BUF_SIZE 字节和后 LITE_READ_BUF_SIZE 字节。
 *
 * 对于头部覆盖尾部的小文件，`tail === head`。
 * 接受共享 Buffer 以避免每个文件的单独分配开销。
 * 出现任何错误时返回 `{ head: '', tail: '' }`。
 */
export async function readHeadAndTail(
  filePath: string,
  fileSize: number,
  buf: Buffer,
): Promise<{ head: string; tail: string }> {
  try {
    const fh = await fsOpen(filePath, 'r')
    try {
      const headResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, 0)
      if (headResult.bytesRead === 0) return { head: '', tail: '' }

      const head = buf.toString('utf8', 0, headResult.bytesRead)

      const tailOffset = Math.max(0, fileSize - LITE_READ_BUF_SIZE)
      let tail = head
      if (tailOffset > 0) {
        const tailResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, tailOffset)
        tail = buf.toString('utf8', 0, tailResult.bytesRead)
      }

      return { head, tail }
    } finally {
      await fh.close()
    }
  } catch {
    return { head: '', tail: '' }
  }
}

export type LiteSessionFile = {
  mtime: number
  size: number
  head: string
  tail: string
}

/**
 * 打开单个会话文件，获取其 stat 信息，并通过一个文件描述符读取首尾内容。
 * 自行分配缓冲区 — 可安全用于 Promise.all 并发场景。
 * 出现任何错误时返回 null。
 */
export async function readSessionLite(
  filePath: string,
): Promise<LiteSessionFile | null> {
  try {
    const fh = await fsOpen(filePath, 'r')
    try {
      const stat = await fh.stat()
      const buf = Buffer.allocUnsafe(LITE_READ_BUF_SIZE)
      const headResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, 0)
      if (headResult.bytesRead === 0) return null

      const head = buf.toString('utf8', 0, headResult.bytesRead)
      const tailOffset = Math.max(0, stat.size - LITE_READ_BUF_SIZE)
      let tail = head
      if (tailOffset > 0) {
        const tailResult = await fh.read(buf, 0, LITE_READ_BUF_SIZE, tailOffset)
        tail = buf.toString('utf8', 0, tailResult.bytesRead)
      }

      return { mtime: stat.mtime.getTime(), size: stat.size, head, tail }
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 路径净化
// ---------------------------------------------------------------------------

/**
 * 单个文件系统路径组件（目录名或文件名）的最大长度。
 * 大多数文件系统（ext4、APFS、NTFS）将单个组件限制为 255 字节。
 * 此处使用 200，以为哈希后缀和分隔符预留空间。
 */
export const MAX_SANITIZED_LENGTH = 200

function simpleHash(str: string): string {
  return Math.abs(djb2Hash(str)).toString(36)
}

/**
 * 将字符串转换为可安全用作目录名或文件名的形式。
 * 将所有非字母数字字符替换为连字符。
 * 确保跨平台兼容性，包括 Windows（冒号等字符在 Windows 上为保留字符）。
 *
 * 对于超出文件系统限制（255 字节）的深层嵌套路径，
 * 截断后追加哈希后缀以保证唯一性。
 *
 * @param name - 需要转换的字符串（如 '/Users/foo/my-project' 或 'plugin:name:server'）
 * @returns 安全的名称（如 '-Users-foo-my-project' 或 'plugin-name-server'）
 */
export function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized
  }
  const hash =
    typeof Bun !== 'undefined' ? Bun.hash(name).toString(36) : simpleHash(name)
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`
}

// ---------------------------------------------------------------------------
// 项目目录查找（由 listSessions 和 getSessionMessages 共享）
// ---------------------------------------------------------------------------

export function getProjectsDir(): string {
  return join(getClaudeConfigHomeDir(), 'projects')
}

export function getProjectDir(projectDir: string): string {
  return join(getProjectsDir(), sanitizePath(projectDir))
}

/**
 * 使用 realpath + NFC 规范化将目录路径解析为规范形式。
 * 若 realpath 失败（如目录尚不存在），则仅使用 NFC 规范化作为回退。
 * 确保符号链接路径（如 macOS 上的 /tmp → /private/tmp）解析到同一项目目录。
 */
export async function canonicalizePath(dir: string): Promise<string> {
  try {
    return (await realpath(dir)).normalize('NFC')
  } catch {
    return dir.normalize('NFC')
  }
}

/**
 * 查找给定路径对应的项目目录，对长路径（>200 字符）的哈希不匹配情况具有容错性。
 * CLI 使用 Bun.hash，而 Node.js 下的 SDK 使用 simpleHash —— 对于超过
 * MAX_SANITIZED_LENGTH 的路径，两者会生成不同的目录后缀。
 * 当精确匹配不存在时，此函数回退到基于前缀的扫描。
 */
export async function findProjectDir(
  projectPath: string,
): Promise<string | undefined> {
  const exact = getProjectDir(projectPath)
  try {
    await readdir(exact)
    return exact
  } catch {
    // 精确匹配失败 —— 对于短路径，这意味着不存在会话。
    // 对于长路径，尝试前缀匹配以处理哈希不匹配的情况。
    const sanitized = sanitizePath(projectPath)
    if (sanitized.length <= MAX_SANITIZED_LENGTH) {
      return undefined
    }
    const prefix = sanitized.slice(0, MAX_SANITIZED_LENGTH)
    const projectsDir = getProjectsDir()
    try {
      const dirents = await readdir(projectsDir, { withFileTypes: true })
      const match = dirents.find(
        d => d.isDirectory() && d.name.startsWith(prefix + '-'),
      )
      return match ? join(projectsDir, match.name) : undefined
    } catch {
      return undefined
    }
  }
}

/**
 * 将 sessionId 解析为其在磁盘上的 JSONL 文件路径。
 *
 * 提供 `dir` 时：对其进行规范化，在该项目的目录中查找
 *（在 Bun/Node 哈希不匹配时使用 findProjectDir 作为回退），
 * 然后回退到兄弟 git worktree。结果中的 `projectPath` 是找到文件的
 * 规范用户可见目录。
 *
 * 省略 `dir` 时：扫描 ~/.claude/projects/ 下所有项目目录。
 * 此情况下 `projectPath` 为 undefined（没有有意义的项目路径可报告）。
 *
 * 使用 stat 检查文件是否存在（先操作再捕获 ENOENT，不使用 existsSync）。
 * 零字节文件视为未找到，以便调用方继续搜索兄弟目录中的有效副本。
 *
 * 返回 `fileSize` 以避免调用方（loadSessionBuffer）重复 stat。
 *
 * 由 getSessionInfoImpl 和 getSessionMessagesImpl 共享 —— 调用方
 * 在解析路径上调用自己的读取器（readSessionLite / loadSessionBuffer）。
 */
export async function resolveSessionFilePath(
  sessionId: string,
  dir?: string,
): Promise<
  | { filePath: string; projectPath: string | undefined; fileSize: number }
  | undefined
> {
  const fileName = `${sessionId}.jsonl`

  if (dir) {
    const canonical = await canonicalizePath(dir)
    const projectDir = await findProjectDir(canonical)
    if (projectDir) {
      const filePath = join(projectDir, fileName)
      try {
        const s = await stat(filePath)
        if (s.size > 0)
          return { filePath, projectPath: canonical, fileSize: s.size }
      } catch {
        // ENOENT/EACCES — 继续搜索
      }
    }
    // Worktree 回退 —— 会话可能位于不同的 worktree 根目录下
    let worktreePaths: string[]
    try {
      worktreePaths = await getWorktreePathsPortable(canonical)
    } catch {
      worktreePaths = []
    }
    for (const wt of worktreePaths) {
      if (wt === canonical) continue
      const wtProjectDir = await findProjectDir(wt)
      if (!wtProjectDir) continue
      const filePath = join(wtProjectDir, fileName)
      try {
        const s = await stat(filePath)
        if (s.size > 0) return { filePath, projectPath: wt, fileSize: s.size }
      } catch {
        // ENOENT/EACCES — 继续搜索
      }
    }
    return undefined
  }

  // 未提供 dir —— 扫描所有项目目录
  const projectsDir = getProjectsDir()
  let dirents: string[]
  try {
    dirents = await readdir(projectsDir)
  } catch {
    return undefined
  }
  for (const name of dirents) {
    const filePath = join(projectsDir, name, fileName)
    try {
      const s = await stat(filePath)
      if (s.size > 0)
        return { filePath, projectPath: undefined, fileSize: s.size }
    } catch {
      // ENOENT/ENOTDIR — 不在此项目中，继续扫描
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 压缩边界分块读取（由 loadTranscriptFile 和 SDK getSessionMessages 共享）
// ---------------------------------------------------------------------------

/** 前向逐字记录读取器的分块大小。1 MB 在 I/O 调用次数与缓冲区增长之间取得平衡。 */
const TRANSCRIPT_READ_CHUNK_SIZE = 1024 * 1024

/**
 * 低于此文件大小时，跳过预压缩过滤。
 * 大型会话（>5 MB）几乎总有压缩边界 —— 它们变大是因为多轮对话触发了自动压缩。
 */
export const SKIP_PRECOMPACT_THRESHOLD = 5 * 1024 * 1024

/** 定位边界时搜索的标记字节。懒初始化：首次使用时分配，而非模块加载时。
 * 大多数会话不会恢复。 */
let _compactBoundaryMarker: Buffer | undefined
function compactBoundaryMarker(): Buffer {
  return (_compactBoundaryMarker ??= Buffer.from('"compact_boundary"'))
}

/**
 * 确认字节匹配的行是真正的 compact_boundary（标记可能出现在用户内容中），
 * 并检查是否存在 preservedSegment。
 */
function parseBoundaryLine(
  line: string,
): { hasPreservedSegment: boolean } | null {
  try {
    const parsed = JSON.parse(line) as {
      type?: string
      subtype?: string
      compactMetadata?: { preservedSegment?: unknown }
    }
    if (parsed.type !== 'system' || parsed.subtype !== 'compact_boundary') {
      return null
    }
    return {
      hasPreservedSegment: Boolean(parsed.compactMetadata?.preservedSegment),
    }
  } catch {
    return null
  }
}

/**
 * --resume 加载路径的单次前向分块读取。Attr-snap 行在文件描述符层面被跳过；
 * 压缩边界在流中截断。峰值是输出大小，而非文件大小。
 *
 * 存留的（最后一条）attr-snap 追加在 EOF，而非原位插入；
 * restoreAttributionStateFromSnapshots 只读取 [length-1]，因此位置无关紧要。
 */

type Sink = { buf: Buffer; len: number; cap: number }

function sinkWrite(s: Sink, src: Buffer, start: number, end: number): void {
  const n = end - start
  if (n <= 0) return
  if (s.len + n > s.buf.length) {
    const grown = Buffer.allocUnsafe(
      Math.min(Math.max(s.buf.length * 2, s.len + n), s.cap),
    )
    s.buf.copy(grown, 0, 0, s.len)
    s.buf = grown
  }
  src.copy(s.buf, s.len, start, end)
  s.len += n
}

function hasPrefix(
  src: Buffer,
  prefix: Buffer,
  at: number,
  end: number,
): boolean {
  return (
    end - at >= prefix.length &&
    src.compare(prefix, 0, prefix.length, at, at + prefix.length) === 0
  )
}

const ATTR_SNAP_PREFIX = Buffer.from('{"type":"attribution-snapshot"')
const SYSTEM_PREFIX = Buffer.from('{"type":"system"')
const LF = 0x0a
const LF_BYTE = Buffer.from([LF])
const BOUNDARY_SEARCH_BOUND = 256 // 标记约在第 28 字节处；256 为冗余空间

type LoadState = {
  out: Sink
  boundaryStartOffset: number
  hasPreservedSegment: boolean
  lastSnapSrc: Buffer | null // 最近一条 attr-snap，追加到 EOF
  lastSnapLen: number
  lastSnapBuf: Buffer | undefined
  bufFileOff: number // buf[0] 在文件中的偏移量
  carryLen: number
  carryBuf: Buffer | undefined
  straddleSnapCarryLen: number // 每个分块；由 processStraddle 重置
  straddleSnapTailEnd: number
}

// 跨越分块接缝的行。返回 0 表示跳转至拼接逻辑。
function processStraddle(
  s: LoadState,
  chunk: Buffer,
  bytesRead: number,
): number {
  s.straddleSnapCarryLen = 0
  s.straddleSnapTailEnd = 0
  if (s.carryLen === 0) return 0
  const cb = s.carryBuf!
  const firstNl = chunk.indexOf(LF)
  if (firstNl === -1 || firstNl >= bytesRead) return 0
  const tailEnd = firstNl + 1
  if (hasPrefix(cb, ATTR_SNAP_PREFIX, 0, s.carryLen)) {
    s.straddleSnapCarryLen = s.carryLen
    s.straddleSnapTailEnd = tailEnd
    s.lastSnapSrc = null
  } else if (s.carryLen < ATTR_SNAP_PREFIX.length) {
    return 0 // too short to rule out attr-snap
  } else {
    if (hasPrefix(cb, SYSTEM_PREFIX, 0, s.carryLen)) {
      const hit = parseBoundaryLine(
        cb.toString('utf-8', 0, s.carryLen) +
          chunk.toString('utf-8', 0, firstNl),
      )
      if (hit?.hasPreservedSegment) {
        s.hasPreservedSegment = true
      } else if (hit) {
        s.out.len = 0
        s.boundaryStartOffset = s.bufFileOff
        s.hasPreservedSegment = false
        s.lastSnapSrc = null
      }
    }
    sinkWrite(s.out, cb, 0, s.carryLen)
    sinkWrite(s.out, chunk, 0, tailEnd)
  }
  s.bufFileOff += s.carryLen + tailEnd
  s.carryLen = 0
  return tailEnd
}

// 剥离 attr-snap，在边界处截断。保留的行以连续段写入。
function scanChunkLines(
  s: LoadState,
  buf: Buffer,
  boundaryMarker: Buffer,
): { lastSnapStart: number; lastSnapEnd: number; trailStart: number } {
  let boundaryAt = buf.indexOf(boundaryMarker)
  let runStart = 0
  let lineStart = 0
  let lastSnapStart = -1
  let lastSnapEnd = -1
  let nl = buf.indexOf(LF)
  while (nl !== -1) {
    const lineEnd = nl + 1
    if (boundaryAt !== -1 && boundaryAt < lineStart) {
      boundaryAt = buf.indexOf(boundaryMarker, lineStart)
    }
    if (hasPrefix(buf, ATTR_SNAP_PREFIX, lineStart, lineEnd)) {
      sinkWrite(s.out, buf, runStart, lineStart)
      lastSnapStart = lineStart
      lastSnapEnd = lineEnd
      runStart = lineEnd
    } else if (
      boundaryAt >= lineStart &&
      boundaryAt < Math.min(lineStart + BOUNDARY_SEARCH_BOUND, lineEnd)
    ) {
      const hit = parseBoundaryLine(buf.toString('utf-8', lineStart, nl))
      if (hit?.hasPreservedSegment) {
        s.hasPreservedSegment = true // 不截断；保留的消息已在输出中
      } else if (hit) {
        s.out.len = 0
        s.boundaryStartOffset = s.bufFileOff + lineStart
        s.hasPreservedSegment = false
        s.lastSnapSrc = null
        lastSnapStart = -1
        s.straddleSnapCarryLen = 0
        runStart = lineStart
      }
      boundaryAt = buf.indexOf(
        boundaryMarker,
        boundaryAt + boundaryMarker.length,
      )
    }
    lineStart = lineEnd
    nl = buf.indexOf(LF, lineStart)
  }
  sinkWrite(s.out, buf, runStart, lineStart)
  return { lastSnapStart, lastSnapEnd, trailStart: lineStart }
}

// 缓冲区内的 snap 优先于跨缝 snap（文件中位置更靠后）。carryBuf 在此处仍有效。
function captureSnap(
  s: LoadState,
  buf: Buffer,
  chunk: Buffer,
  lastSnapStart: number,
  lastSnapEnd: number,
): void {
  if (lastSnapStart !== -1) {
    s.lastSnapLen = lastSnapEnd - lastSnapStart
    if (s.lastSnapBuf === undefined || s.lastSnapLen > s.lastSnapBuf.length) {
      s.lastSnapBuf = Buffer.allocUnsafe(s.lastSnapLen)
    }
    buf.copy(s.lastSnapBuf, 0, lastSnapStart, lastSnapEnd)
    s.lastSnapSrc = s.lastSnapBuf
  } else if (s.straddleSnapCarryLen > 0) {
    s.lastSnapLen = s.straddleSnapCarryLen + s.straddleSnapTailEnd
    if (s.lastSnapBuf === undefined || s.lastSnapLen > s.lastSnapBuf.length) {
      s.lastSnapBuf = Buffer.allocUnsafe(s.lastSnapLen)
    }
    s.carryBuf!.copy(s.lastSnapBuf, 0, 0, s.straddleSnapCarryLen)
    chunk.copy(s.lastSnapBuf, s.straddleSnapCarryLen, 0, s.straddleSnapTailEnd)
    s.lastSnapSrc = s.lastSnapBuf
  }
}

function captureCarry(s: LoadState, buf: Buffer, trailStart: number): void {
  s.carryLen = buf.length - trailStart
  if (s.carryLen > 0) {
    if (s.carryBuf === undefined || s.carryLen > s.carryBuf.length) {
      s.carryBuf = Buffer.allocUnsafe(s.carryLen)
    }
    buf.copy(s.carryBuf, 0, trailStart, buf.length)
  }
}

function finalizeOutput(s: LoadState): void {
  if (s.carryLen > 0) {
    const cb = s.carryBuf!
    if (hasPrefix(cb, ATTR_SNAP_PREFIX, 0, s.carryLen)) {
      s.lastSnapSrc = cb
      s.lastSnapLen = s.carryLen
    } else {
      sinkWrite(s.out, cb, 0, s.carryLen)
    }
  }
  if (s.lastSnapSrc) {
    if (s.out.len > 0 && s.out.buf[s.out.len - 1] !== LF) {
      sinkWrite(s.out, LF_BYTE, 0, 1)
    }
    sinkWrite(s.out, s.lastSnapSrc, 0, s.lastSnapLen)
  }
}

export async function readTranscriptForLoad(
  filePath: string,
  fileSize: number,
): Promise<{
  boundaryStartOffset: number
  postBoundaryBuf: Buffer
  hasPreservedSegment: boolean
}> {
  const boundaryMarker = compactBoundaryMarker()
  const CHUNK_SIZE = TRANSCRIPT_READ_CHUNK_SIZE

  const s: LoadState = {
    out: {
      // 有门控的调用方传入 fileSize > 5MB，min(fileSize, 8MB) 落在 [5, 8]MB；
      // 无边界的大型会话（输出 24-31MB）需要 2 次扩容。
      // 无门控的调用方（attribution.ts）也可能传入小文件 ——
      // min 只是合理初始化缓冲区大小，不会触发扩容。
      buf: Buffer.allocUnsafe(Math.min(fileSize, 8 * 1024 * 1024)),
      len: 0,
      // +1：finalizeOutput 可能在非 LF 结尾的 carry 与重排后的最后一条
      // attr-snap 之间插入一个 LF（应对崩溃截断的文件）。
      cap: fileSize + 1,
    },
    boundaryStartOffset: 0,
    hasPreservedSegment: false,
    lastSnapSrc: null,
    lastSnapLen: 0,
    lastSnapBuf: undefined,
    bufFileOff: 0,
    carryLen: 0,
    carryBuf: undefined,
    straddleSnapCarryLen: 0,
    straddleSnapTailEnd: 0,
  }

  const chunk = Buffer.allocUnsafe(CHUNK_SIZE)
  const fd = await fsOpen(filePath, 'r')
  try {
    let filePos = 0
    while (filePos < fileSize) {
      const { bytesRead } = await fd.read(
        chunk,
        0,
        Math.min(CHUNK_SIZE, fileSize - filePos),
        filePos,
      )
      if (bytesRead === 0) break
      filePos += bytesRead

      const chunkOff = processStraddle(s, chunk, bytesRead)

      let buf: Buffer
      if (s.carryLen > 0) {
        const bufLen = s.carryLen + (bytesRead - chunkOff)
        buf = Buffer.allocUnsafe(bufLen)
        s.carryBuf!.copy(buf, 0, 0, s.carryLen)
        chunk.copy(buf, s.carryLen, chunkOff, bytesRead)
      } else {
        buf = chunk.subarray(chunkOff, bytesRead)
      }

      const r = scanChunkLines(s, buf, boundaryMarker)
      captureSnap(s, buf, chunk, r.lastSnapStart, r.lastSnapEnd)
      captureCarry(s, buf, r.trailStart)
      s.bufFileOff += r.trailStart
    }
    finalizeOutput(s)
  } finally {
    await fd.close()
  }

  return {
    boundaryStartOffset: s.boundaryStartOffset,
    postBoundaryBuf: s.out.buf.subarray(0, s.out.len),
    hasPreservedSegment: s.hasPreservedSegment,
  }
}
