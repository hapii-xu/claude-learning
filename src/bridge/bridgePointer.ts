import { mkdir, readFile, stat, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { z } from 'zod/v4'
import { logForDebugging } from '../utils/debug.js'
import { isENOENT } from '../utils/errors.js'
import { getWorktreePathsPortable } from '../utils/getWorktreePathsPortable.js'
import { lazySchema } from '../utils/lazySchema.js'
import {
  getProjectsDir,
  sanitizePath,
} from '../utils/sessionStoragePortable.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'

/**
 * worktree 扇出的上限。git worktree list 本身天然有界（50 已经很多了），
 * 这个上限用来控制并发的 stat() 突发，并防御病态配置。超过这个数量时，
 * --continue 会回退为只扫描当前目录。
 */
const MAX_WORKTREE_FANOUT = 50

/**
 * Remote Control session 的崩溃恢复指针。
 *
 * 在 bridge session 创建后立即写入、session 期间周期性刷新、干净关闭时
 * 清除。如果进程异常死亡（崩溃、kill -9、终端关闭），指针会保留下来。
 * 下次启动时，`claude remote-control` 会检测到它，并通过 #20460 的
 * --session-id 流程提示用户恢复。
 *
 * 陈旧判断基于文件的 mtime（而非内嵌时间戳），因此周期性写回相同内容
 * 就能起到刷新作用 —— 与后端滚动的 BRIDGE_LAST_POLL_TTL（4h）语义一致。
 * 一个已经轮询 5+ 小时然后崩溃的 bridge，只要在窗口内跑过一次刷新，
 * 指针就仍然是新鲜的。
 *
 * 按工作目录分文件存放（紧挨着 transcript JSONL 文件），避免不同仓库下
 * 同时运行的两个 bridge 互相覆盖。
 */

export const BRIDGE_POINTER_TTL_MS = 4 * 60 * 60 * 1000

const BridgePointerSchema = lazySchema(() =>
  z.object({
    sessionId: z.string(),
    environmentId: z.string(),
    source: z.enum(['standalone', 'repl']),
  }),
)

export type BridgePointer = z.infer<ReturnType<typeof BridgePointerSchema>>

export function getBridgePointerPath(dir: string): string {
  return join(getProjectsDir(), sanitizePath(dir), 'bridge-pointer.json')
}

/**
 * 写入指针。在长 session 中也用它来刷新 mtime —— 用相同的 ID 调用是
 * 一次内容不变的廉价写入，只是推动陈旧时钟前进。best-effort —— 崩溃
 * 恢复文件本身绝不能引发崩溃。出错时记录日志并吞掉。
 */
export async function writeBridgePointer(
  dir: string,
  pointer: BridgePointer,
): Promise<void> {
  const path = getBridgePointerPath(dir)
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, jsonStringify(pointer), 'utf8')
    logForDebugging(`[bridge:pointer] wrote ${path}`)
  } catch (err: unknown) {
    logForDebugging(`[bridge:pointer] write failed: ${err}`, { level: 'warn' })
  }
}

/**
 * 读取指针及其 age（距上次写入的毫秒数）。直接操作并处理错误 ——
 * 不做存在性检查（CLAUDE.md 的 TOCTOU 原则）。任何失败都返回 null：
 * 文件缺失、JSON 损坏、schema 不匹配、或陈旧（mtime 早于 4 小时前）。
 * 陈旧/无效的指针会被删除，避免在后端已经 GC 掉 env 之后还反复弹窗。
 */
export async function readBridgePointer(
  dir: string,
): Promise<(BridgePointer & { ageMs: number }) | null> {
  const path = getBridgePointerPath(dir)
  let raw: string
  let mtimeMs: number
  try {
    // 先 stat 拿 mtime（陈旧判断锚点），再读内容。两次系统调用都
    // 必不可少 —— mtime 本身就是我们返回的数据，不是 TOCTOU 防护。
    mtimeMs = (await stat(path)).mtimeMs
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }

  const parsed = BridgePointerSchema().safeParse(safeJsonParse(raw))
  if (!parsed.success) {
    logForDebugging(`[bridge:pointer] invalid schema, clearing: ${path}`)
    await clearBridgePointer(dir)
    return null
  }

  const ageMs = Math.max(0, Date.now() - mtimeMs)
  if (ageMs > BRIDGE_POINTER_TTL_MS) {
    logForDebugging(`[bridge:pointer] stale (>4h mtime), clearing: ${path}`)
    await clearBridgePointer(dir)
    return null
  }

  return { ...parsed.data, ageMs }
}

/**
 * 为 `--continue` 提供的 worktree 感知读取。REPL bridge 把指针写到
 * `getOriginalCwd()`，而 EnterWorktreeTool/activeWorktreeSession 可能把它
 * 改成某个 worktree 路径 —— 但 `claude remote-control --continue` 是以
 * `resolve('.')` = shell CWD 运行的。这里跨 git worktree 兄弟目录扇出
 * 查找最新的指针，与 /resume 的语义保持一致。
 *
 * 快速路径：先检查 `dir`。只有没命中时才 shell out 跑 `git worktree list`
 * —— 常见场景（指针就在启动目录）只需一次 stat、零次 exec。扇出读
 * 并发执行；上限 MAX_WORKTREE_FANOUT。
 *
 * 返回指针以及找到它的目录，这样调用方在 resume 失败时可以清掉正确
 * 的那个文件。
 */
export async function readBridgePointerAcrossWorktrees(
  dir: string,
): Promise<{ pointer: BridgePointer & { ageMs: number }; dir: string } | null> {
  // 快速路径：当前目录。覆盖 standalone bridge（永远匹配）以及没有发生
  // worktree 变更的 REPL bridge。
  const here = await readBridgePointer(dir)
  if (here) {
    return { pointer: here, dir }
  }

  // 扇出：扫描 worktree 兄弟。getWorktreePathsPortable 有 5s 超时，任何
  // 错误（不是 git 仓库、git 未安装）都返回 []。
  const worktrees = await getWorktreePathsPortable(dir)
  if (worktrees.length <= 1) return null
  if (worktrees.length > MAX_WORKTREE_FANOUT) {
    logForDebugging(
      `[bridge:pointer] ${worktrees.length} worktrees exceeds fanout cap ${MAX_WORKTREE_FANOUT}, skipping`,
    )
    return null
  }

  // 相对 `dir` 去重，避免重复 stat。sanitizePath 归一化大小写/分隔符，
  // 让 worktree-list 的输出与快速路径的 key 匹配 —— 在 Windows 上这很
  // 重要，git 可能吐出 C:/ 而我们存的是 c:/。
  const dirKey = sanitizePath(dir)
  const candidates = worktrees.filter(wt => sanitizePath(wt) !== dirKey)

  // 并发 stat+read。每个 readBridgePointer 都是一次 stat()（没有指针的
  // worktree 会 ENOENT，很廉价），再加上罕见命中时一次约 100 字节的读。
  // Promise.all → 总延迟约等于最慢的那一次 stat。
  const results = await Promise.all(
    candidates.map(async wt => {
      const p = await readBridgePointer(wt)
      return p ? { pointer: p, dir: wt } : null
    }),
  )

  // 挑最新的（ageMs 最小）。指针里保存了 environmentId，所以不管
  // --continue 是从哪个 worktree 启动的，resume 都能重连到正确的 env。
  let freshest: {
    pointer: BridgePointer & { ageMs: number }
    dir: string
  } | null = null
  for (const r of results) {
    if (r && (!freshest || r.pointer.ageMs < freshest.pointer.ageMs)) {
      freshest = r
    }
  }
  if (freshest) {
    logForDebugging(
      `[bridge:pointer] fanout found pointer in worktree ${freshest.dir} (ageMs=${freshest.pointer.ageMs})`,
    )
  }
  return freshest
}

/**
 * 删除指针。幂等 —— 进程上次已经干净关闭时 ENOENT 是预期内的。
 */
export async function clearBridgePointer(dir: string): Promise<void> {
  const path = getBridgePointerPath(dir)
  try {
    await unlink(path)
    logForDebugging(`[bridge:pointer] cleared ${path}`)
  } catch (err: unknown) {
    if (!isENOENT(err)) {
      logForDebugging(`[bridge:pointer] clear failed: ${err}`, {
        level: 'warn',
      })
    }
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return jsonParse(raw)
  } catch {
    return null
  }
}
