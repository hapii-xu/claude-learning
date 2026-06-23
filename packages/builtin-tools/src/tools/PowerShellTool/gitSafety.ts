/**
 * Git 可能被武器化用于沙箱逃逸，通过两个向量：
 * 1. 裸仓库攻击：如果 cwd 包含 HEAD + objects/ + refs/ 但没有有效的
 *    .git/HEAD，Git 会将 cwd 视为裸仓库并从 cwd 运行钩子。
 * 2. Git 内部写入 + git：复合命令创建 HEAD/objects/refs/
 *    hooks/ 然后运行 git — git 子命令执行刚创建的恶意钩子。
 */

import { basename, posix, resolve, sep } from 'path'
import { getCwd } from 'src/utils/cwd.js'
import { PS_TOKENIZER_DASH_CHARS } from 'src/utils/powershell/parser.js'

/**
 * 如果规范化路径以 `../<cwd-basename>/` 开头，它会通过父目录重新进入 cwd —
 * 将其解析为 cwd 相对形式。posix.normalize 保留前导 `..`（无 cwd 上下文），
 * 因此当 cwd=/x/project 时，`../project/hooks` 仍然是 `../project/hooks`，
 * 即使它在运行时解析到同一目录，也会错过 `hooks/` 前缀匹配。
 * 检查/使用分歧：验证器看到 `../project/hooks`，PowerShell
 * 根据 cwd 解析为 `hooks`。
 */
function resolveCwdReentry(normalized: string): string {
  if (!normalized.startsWith('../')) return normalized
  const cwdBase = basename(getCwd()).toLowerCase()
  if (!cwdBase) return normalized
  // 迭代剥离 `../<cwd-basename>/` 对（当 cwd 有重复基名段时处理
  // `../../p/p/hooks` 不太可能，但一级是常见攻击）。
  const prefix = '../' + cwdBase + '/'
  let s = normalized
  while (s.startsWith(prefix)) {
    s = s.slice(prefix.length)
  }
  // 也处理精确的 `../<cwd-basename>`（无尾部斜杠）
  if (s === '../' + cwdBase) return '.'
  return s
}

/**
 * 将 PS 参数文本规范化为规范路径，用于 git 内部匹配。
 * 顺序很重要：先做结构性剥离（冒号绑定参数、引号、
 * 反引号转义、provider 前缀、驱动器相对前缀），然后 NTFS
 * 按组件尾部剥离（空格始终；点仅在空格剥离后不是 `./..` 时），
 * 然后 posix.normalize（解析 `..`、`.`、`//`），最后大小写折叠。
 */
function normalizeGitPathArg(arg: string): string {
  let s = arg
  // 规范化参数前缀：横杠字符（–、—、―）和正斜杠
  // （PS 5.1）。/Path:hooks/pre-commit → 提取冒号绑定值。（bug #28）
  if (s.length > 0 && (PS_TOKENIZER_DASH_CHARS.has(s[0]!) || s[0] === '/')) {
    const c = s.indexOf(':', 1)
    if (c > 0) s = s.slice(c + 1)
  }
  s = s.replace(/^['"]|['"]$/g, '')
  s = s.replace(/`/g, '')
  // PS provider 限定路径：FileSystem::hooks/pre-commit → hooks/pre-commit
  // 也处理全限定形式：Microsoft.PowerShell.Core\FileSystem::path
  s = s.replace(/^(?:[A-Za-z0-9_.]+\\){0,3}FileSystem::/i, '')
  // 驱动器相对 C:foo（冒号后无分隔符）在该驱动器上是 cwd 相对的。
  // C:\foo（带分隔符）是绝对路径，不得匹配 —
  // 负向先行断言保留了它。
  s = s.replace(/^[A-Za-z]:(?![/\\])/, '')
  s = s.replace(/\\/g, '/')
  // Win32 CreateFileW 按组件：迭代剥离尾部空格，
  // 然后尾部点，如果结果是 `.` 或 `..`（特殊）则停止。
  // `.. ` → `..`，`.. .` → `..`，`...` → '' → `.`，`hooks .` → `hooks`。
  // 原本的 ''（前导斜杠分割）保持 ''（绝对路径标记）。
  s = s
    .split('/')
    .map(c => {
      if (c === '') return c
      let prev
      do {
        prev = c
        c = c.replace(/ +$/, '')
        if (c === '.' || c === '..') return c
        c = c.replace(/\.+$/, '')
      } while (c !== prev)
      return c || '.'
    })
    .join('/')
  s = posix.normalize(s)
  if (s.startsWith('./')) s = s.slice(2)
  return s.toLowerCase()
}

const GIT_INTERNAL_PREFIXES = ['head', 'objects', 'refs', 'hooks'] as const

/**
 * 安全检查：将逃逸 cwd（前导 `../` 或绝对路径）的规范化路径针对
 * 实际 cwd 进行解析，然后检查它是否落回 cwd 内部。
 * 如果是，剥离 cwd 并返回 cwd 相对剩余部分用于前缀匹配。
 * 如果落在 cwd 外部，返回 null（真正外部 — path-validation 的职责）。
 * 覆盖 `..\<cwd-basename>\HEAD` 和 `C:\<full-cwd>\HEAD`，
 * posix.normalize 单独无法解析（它将前导 `..` 保留原样）。
 *
 * 这是裸仓库 HEAD 攻击的唯一防线。path-validation 的
 * DANGEROUS_FILES 故意排除了裸 `HEAD`（在名为 HEAD 的合法非 git 文件上
 * 误报风险），而 DANGEROUS_DIRECTORIES 只匹配每段 `.git` —
 * 因此 `<cwd>/HEAD` 会通过该层。此处的 cwd 解析是承重逻辑；
 * 不要在没有添加替代防护的情况下移除。
 */
function resolveEscapingPathToCwdRelative(n: string): string | null {
  const cwd = getCwd()
  // 从 posix 规范化形式重建一个平台可解析的路径。
  // `n` 使用正斜杠（normalizeGitPathArg 将 \\ 转为 /）；resolve()
  // 在 Windows 上处理正斜杠。
  const abs = resolve(cwd, n)
  const cwdWithSep = cwd.endsWith(sep) ? cwd : cwd + sep
  // 不区分大小写比较：normalizeGitPathArg 将 `n` 转为小写，所以
  // resolve() 的输出中来自 `n` 的组件是小写的，但 cwd 可能是
  // 大小写混合（例如 C:\Users\...）。Windows 路径不区分大小写。
  const absLower = abs.toLowerCase()
  const cwdLower = cwd.toLowerCase()
  const cwdWithSepLower = cwdWithSep.toLowerCase()
  if (absLower === cwdLower) return '.'
  if (!absLower.startsWith(cwdWithSepLower)) return null
  return abs.slice(cwdWithSep.length).replace(/\\/g, '/').toLowerCase()
}

function matchesGitInternalPrefix(n: string): boolean {
  if (n === 'head' || n === '.git') return true
  if (n.startsWith('.git/') || /^git~\d+($|\/)/.test(n)) return true
  for (const p of GIT_INTERNAL_PREFIXES) {
    if (p === 'head') continue
    if (n === p || n.startsWith(p + '/')) return true
  }
  return false
}

/**
 * 当参数（原始 PS 参数文本）解析为 cwd 中的 git 内部路径时返回 true。
 * 同时覆盖裸仓库路径（hooks/、refs/）和标准仓库路径
 * （.git/hooks/、.git/config）。
 */
export function isGitInternalPathPS(arg: string): boolean {
  const n = resolveCwdReentry(normalizeGitPathArg(arg))
  if (matchesGitInternalPrefix(n)) return true
  // 安全检查：resolveCwdReentry 和 posix.normalize 无法完全解析的
  // 前导 `../` 或绝对路径。针对实际 cwd 解析 — 如果结果落回 cwd 内的
  // git 内部位置，防护仍必须触发。
  if (n.startsWith('../') || n.startsWith('/') || /^[a-z]:/.test(n)) {
    const rel = resolveEscapingPathToCwdRelative(n)
    if (rel !== null && matchesGitInternalPrefix(rel)) return true
  }
  return false
}

/**
 * 当参数解析为 .git/ 内的路径（标准仓库元数据目录）时返回 true。
 * 与 isGitInternalPathPS 不同，不匹配裸仓库式根级
 * `hooks/`、`refs/` 等 — 那些是常见的项目目录名。
 */
export function isDotGitPathPS(arg: string): boolean {
  const n = resolveCwdReentry(normalizeGitPathArg(arg))
  if (matchesDotGitPrefix(n)) return true
  // 安全检查：与 isGitInternalPathPS 相同的 cwd 解析 — 捕获
  // 落回 cwd 的 `..\<cwd-basename>\.git\hooks\pre-commit`。
  if (n.startsWith('../') || n.startsWith('/') || /^[a-z]:/.test(n)) {
    const rel = resolveEscapingPathToCwdRelative(n)
    if (rel !== null && matchesDotGitPrefix(rel)) return true
  }
  return false
}

function matchesDotGitPrefix(n: string): boolean {
  if (n === '.git' || n.startsWith('.git/')) return true
  // NTFS 8.3 短名：.git 变为 GIT~1（或 GIT~2 等，如果多个
  // 以 "git" 开头的点文件存在）。normalizeGitPathArg 转为小写，所以
  // 检查 git~N 作为第一个组件。
  return /^git~\d+($|\/)/.test(n)
}
