/**
 * vendor/file-index-src（Rust NAPI 模块）的纯 TypeScript 移植。
 *
 * 原生模块封装了 nucleo（https://github.com/helix-editor/nucleo）以实现
 * 高性能模糊文件搜索。此移植重新实现了相同的 API 和评分行为，无需原生依赖。
 *
 * 关键 API：
 *   new FileIndex()
 *   .loadFromFileList(fileList: string[]): void   —— 去重 + 索引路径
 *   .search(query: string, limit: number): SearchResult[]
 *
 * 分词语义：值越小越好。分数为 结果中的位置 / 结果数量，
 * 因此最佳匹配为 0.0。包含 "test" 的路径获得 1.05× 惩罚（上限为
 * 1.0），使非测试文件的排名略高。
 */

export type SearchResult = {
  path: string
  score: number
}

// nucleo 风格的评分常量（近似 fzf-v2 / nucleo 奖励）
const SCORE_MATCH = 16
const BONUS_BOUNDARY = 8
const BONUS_CAMEL = 6
const BONUS_CONSECUTIVE = 4
const BONUS_FIRST_CHAR = 8
const PENALTY_GAP_START = 3
const PENALTY_GAP_EXTENSION = 1

const TOP_LEVEL_CACHE_LIMIT = 100
const MAX_QUERY_LEN = 64
// 同步工作达到此时长（毫秒）后让出事件循环。块大小基于时间
// （而非计数），这样慢速机器获得更小的块并保持响应——
// 5k 路径在 M 系列上约 2ms，但在旧 Windows 硬件上可能超过 15ms。
const CHUNK_MS = 4

// 可重用缓冲区：记录 indexOf 扫描期间每个 needle 字符匹配的位置
const posBuf = new Int32Array(MAX_QUERY_LEN)

export class FileIndex {
  private paths: string[] = []
  private lowerPaths: string[] = []
  private charBits: Int32Array = new Int32Array(0)
  private pathLens: Uint16Array = new Uint16Array(0)
  private topLevelCache: SearchResult[] | null = null
  // 异步构建期间，跟踪有多少路径已填充 bitmap/lowerPath。
  // search() 使用它在构建继续时搜索已就绪的前缀。
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: used via destructuring in search()
  private readyCount = 0

  /**
   * 从字符串数组加载路径。
   * 这是填充索引的主要方式——ripgrep 收集文件，我们只是搜索它们。
   * 自动对路径去重。
   */
  loadFromFileList(fileList: string[]): void {
    // 去重并过滤空字符串（匹配 Rust HashSet 行为）
    const seen = new Set<string>()
    const paths: string[] = []
    for (const line of fileList) {
      if (line.length > 0 && !seen.has(line)) {
        seen.add(line)
        paths.push(line)
      }
    }

    this.buildIndex(paths)
  }

  /**
   * 异步变体：每 ~8–12k 路径让出事件循环一次，使大型索引
   * （270k+ 文件）不会一次阻塞主线程超过 10ms。
   * 结果与 loadFromFileList 相同。
   *
   * 返回 { queryable, done }：
   *   - queryable：第一个块索引完成后立即 resolve（search 返回部分结果）。
   *     对于 270k 路径列表，这在路径数组可用后约 5–10ms 的同步工作。
   *   - done：整个索引构建完成时 resolve。
   */
  loadFromFileListAsync(fileList: string[]): {
    queryable: Promise<void>
    done: Promise<void>
  } {
    let markQueryable: () => void = () => {}
    const queryable = new Promise<void>(resolve => {
      markQueryable = resolve
    })
    const done = this.buildAsync(fileList, markQueryable)
    return { queryable, done }
  }

  private async buildAsync(
    fileList: string[],
    markQueryable: () => void,
  ): Promise<void> {
    const seen = new Set<string>()
    const paths: string[] = []
    let chunkStart = performance.now()
    for (let i = 0; i < fileList.length; i++) {
      const line = fileList[i]!
      if (line.length > 0 && !seen.has(line)) {
        seen.add(line)
        paths.push(line)
      }
      // 每 256 次迭代检查一次，以摊销 performance.now() 的开销
      if ((i & 0xff) === 0xff && performance.now() - chunkStart > CHUNK_MS) {
        await yieldToEventLoop()
        chunkStart = performance.now()
      }
    }

    this.resetArrays(paths)

    chunkStart = performance.now()
    let firstChunk = true
    for (let i = 0; i < paths.length; i++) {
      this.indexPath(i)
      if ((i & 0xff) === 0xff && performance.now() - chunkStart > CHUNK_MS) {
        this.readyCount = i + 1
        if (firstChunk) {
          markQueryable()
          firstChunk = false
        }
        await yieldToEventLoop()
        chunkStart = performance.now()
      }
    }
    this.readyCount = paths.length
    markQueryable()
  }

  private buildIndex(paths: string[]): void {
    this.resetArrays(paths)
    for (let i = 0; i < paths.length; i++) {
      this.indexPath(i)
    }
    this.readyCount = paths.length
  }

  private resetArrays(paths: string[]): void {
    const n = paths.length
    this.paths = paths
    this.lowerPaths = new Array(n)
    this.charBits = new Int32Array(n)
    this.pathLens = new Uint16Array(n)
    this.readyCount = 0
    this.topLevelCache = computeTopLevelEntries(paths, TOP_LEVEL_CACHE_LIMIT)
  }

  // 预计算：小写、a–z 位图、长度。位图可对缺少任何 needle 字母的路径
  // 进行 O(1) 拒绝（对 "test" 等宽泛查询有 89% 存活率——仍是 10%+ 的免费收益；
  // 对罕见字符有 90%+ 拒绝率）。
  private indexPath(i: number): void {
    const lp = this.paths[i]!.toLowerCase()
    this.lowerPaths[i] = lp
    const len = lp.length
    this.pathLens[i] = len
    let bits = 0
    for (let j = 0; j < len; j++) {
      const c = lp.charCodeAt(j)
      if (c >= 97 && c <= 122) bits |= 1 << (c - 97)
    }
    this.charBits[i] = bits
  }

  /**
   * 使用模糊匹配搜索符合查询的文件。
   * 返回按匹配分数排序的前 N 个结果。
   */
  search(query: string, limit: number): SearchResult[] {
    if (limit <= 0) return []
    if (query.length === 0) {
      if (this.topLevelCache) {
        return this.topLevelCache.slice(0, limit)
      }
      return []
    }

    // 智能大小写：全小写查询 → 不区分大小写；有大写 → 区分大小写
    const caseSensitive = query !== query.toLowerCase()
    const needle = caseSensitive ? query : query.toLowerCase()
    const nLen = Math.min(needle.length, MAX_QUERY_LEN)
    const needleChars: string[] = new Array(nLen)
    let needleBitmap = 0
    for (let j = 0; j < nLen; j++) {
      const ch = needle.charAt(j)
      needleChars[j] = ch
      const cc = ch.charCodeAt(0)
      if (cc >= 97 && cc <= 122) needleBitmap |= 1 << (cc - 97)
    }

    // 假设每个匹配都获得最大边界奖励时的分数上限。
    // 用于在 charCodeAt 密集的边界遍历之前，拒绝那些仅间隙惩罚就使其
    // 无法超过当前 top-k 阈值的路径。
    const scoreCeiling =
      nLen * (SCORE_MATCH + BONUS_BOUNDARY) + BONUS_FIRST_CHAR + 32

    // Top-k：维护最佳 `limit` 个匹配的升序排序数组。
    // 避免在我们只需要 `limit` 个匹配时对所有匹配进行 O(n log n) 排序。
    const topK: { path: string; fuzzScore: number }[] = []
    let threshold = -Infinity

    const { paths, lowerPaths, charBits, pathLens, readyCount } = this

    for (let i = 0; i < readyCount; i++) {
      // O(1) 位图拒绝：路径必须包含 needle 中的每个字母
      if ((charBits[i]! & needleBitmap) !== needleBitmap) continue

      const haystack = caseSensitive ? paths[i]! : lowerPaths[i]!

      // 贪婪最左 indexOf 在第一个 needle 字符出现较早（例如 "src/" 中的 's'）
      // 而真实匹配在更深处（例如 "settings/"）时，给出快速但次优的位置。
      // 我们从多个起始位置评分——最左命中加上 needle[0] 的每个单词边界出现——
      // 并保留最佳结果。典型路径有 2–4 个边界起点，因此开销极小。

      // 收集 needle[0] 的候选起始位置
      const firstChar = needleChars[0]!
      let startCount = 0
      // startPositions 是栈分配的（重用数组会增加复杂性而收益微乎其微；
      // 路径很少有 >8 个边界起点）
      const startPositions: number[] = []

      // 始终尝试最左出现
      const firstPos = haystack.indexOf(firstChar)
      if (firstPos === -1) continue
      startPositions[startCount++] = firstPos

      // 也尝试 needle[0] 出现的每个单词边界位置
      for (let bp = firstPos + 1; bp < haystack.length; bp++) {
        if (haystack.charCodeAt(bp) !== firstChar.charCodeAt(0)) continue
        // 检查此位置是否在单词边界
        const prevCode = haystack.charCodeAt(bp - 1)
        if (
          prevCode === 47 || // /
          prevCode === 92 || // \
          prevCode === 45 || // -
          prevCode === 95 || // _
          prevCode === 46 || // .
          prevCode === 32 // space
        ) {
          startPositions[startCount++] = bp
        }
      }

      const originalPath = paths[i]!
      const hLen = pathLens[i]!
      const lengthBonus = Math.max(0, 32 - (hLen >> 2))
      let bestScore = -Infinity

      for (let si = 0; si < startCount; si++) {
        posBuf[0] = startPositions[si]!
        let gapPenalty = 0
        let consecBonus = 0
        let prev = posBuf[0]!
        let matched = true
        for (let j = 1; j < nLen; j++) {
          const pos = haystack.indexOf(needleChars[j]!, prev + 1)
          if (pos === -1) {
            matched = false
            break
          }
          posBuf[j] = pos
          const gap = pos - prev - 1
          if (gap === 0) consecBonus += BONUS_CONSECUTIVE
          else gapPenalty += PENALTY_GAP_START + gap * PENALTY_GAP_EXTENSION
          prev = pos
        }
        if (!matched) continue

        // 此起始位置的间隙约束拒绝
        if (
          topK.length === limit &&
          scoreCeiling + consecBonus - gapPenalty + lengthBonus <= threshold
        ) {
          continue
        }

        // 边界/驼峰评分
        let score = nLen * SCORE_MATCH + consecBonus - gapPenalty
        score += scoreBonusAt(originalPath, posBuf[0]!, true)
        for (let j = 1; j < nLen; j++) {
          score += scoreBonusAt(originalPath, posBuf[j]!, false)
        }
        score += lengthBonus

        if (score > bestScore) bestScore = score
      }

      if (bestScore === -Infinity) continue
      const score = bestScore

      if (topK.length < limit) {
        topK.push({ path: originalPath, fuzzScore: score })
        if (topK.length === limit) {
          topK.sort((a, b) => a.fuzzScore - b.fuzzScore)
          threshold = topK[0]!.fuzzScore
        }
      } else if (score > threshold) {
        let lo = 0
        let hi = topK.length
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (topK[mid]!.fuzzScore < score) lo = mid + 1
          else hi = mid
        }
        topK.splice(lo, 0, { path: originalPath, fuzzScore: score })
        topK.shift()
        threshold = topK[0]!.fuzzScore
      }
    }

    // topK 是升序的；反转为降序（最佳优先）
    topK.sort((a, b) => b.fuzzScore - a.fuzzScore)

    const matchCount = topK.length
    const denom = Math.max(matchCount, 1)
    const results: SearchResult[] = new Array(matchCount)

    for (let i = 0; i < matchCount; i++) {
      const path = topK[i]!.path
      const positionScore = i / denom
      const finalScore = path.includes('test')
        ? Math.min(positionScore * 1.05, 1.0)
        : positionScore
      results[i] = { path, score: finalScore }
    }

    return results
  }
}

/**
 * 原始大小写路径中位置 `pos` 处匹配的边界/驼峰奖励。
 * `first` 启用字符串起始奖励（仅对 needle[0]）。
 */
function scoreBonusAt(path: string, pos: number, first: boolean): number {
  if (pos === 0) return first ? BONUS_FIRST_CHAR : 0
  const prevCh = path.charCodeAt(pos - 1)
  if (isBoundary(prevCh)) return BONUS_BOUNDARY
  if (isLower(prevCh) && isUpper(path.charCodeAt(pos))) return BONUS_CAMEL
  return 0
}

function isBoundary(code: number): boolean {
  // / \ - _ . space
  return (
    code === 47 || // /
    code === 92 || // \
    code === 45 || // -
    code === 95 || // _
    code === 46 || // .
    code === 32 // space
  )
}

function isLower(code: number): boolean {
  return code >= 97 && code <= 122
}

function isUpper(code: number): boolean {
  return code >= 65 && code <= 90
}

export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

export { CHUNK_MS }

/**
 * 提取唯一的顶层路径段，按（长度升序，然后字母升序）排序。
 * 同时处理 Unix（/）和 Windows（\）路径分隔符。
 * 镜像 lib.rs 中的 FileIndex::compute_top_level_entries。
 */
function computeTopLevelEntries(
  paths: string[],
  limit: number,
): SearchResult[] {
  const topLevel = new Set<string>()

  for (const p of paths) {
    // 在第一个 / 或 \ 分隔符处分割
    let end = p.length
    for (let i = 0; i < p.length; i++) {
      const c = p.charCodeAt(i)
      if (c === 47 || c === 92) {
        end = i
        break
      }
    }
    const segment = p.slice(0, end)
    if (segment.length > 0) {
      topLevel.add(segment)
      if (topLevel.size >= limit) break
    }
  }

  const sorted = Array.from(topLevel)
  sorted.sort((a, b) => {
    const lenDiff = a.length - b.length
    if (lenDiff !== 0) return lenDiff
    return a < b ? -1 : a > b ? 1 : 0
  })

  return sorted.slice(0, limit).map(path => ({ path, score: 0.0 }))
}

export default FileIndex
export type { FileIndex as FileIndexType }
