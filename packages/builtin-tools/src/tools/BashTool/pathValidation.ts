import { homedir } from 'os'
import { isAbsolute, resolve } from 'path'
import type { z } from 'zod/v4'
import type { ToolPermissionContext } from 'src/Tool.js'
import type { Redirect, SimpleCommand } from 'src/utils/bash/ast.js'
import {
  extractOutputRedirections,
  splitCommand_DEPRECATED,
} from 'src/utils/bash/commands.js'
import { tryParseShellCommand } from 'src/utils/bash/shellQuote.js'
import { getDirectoryForPath } from 'src/utils/path.js'
import { allWorkingDirectories } from 'src/utils/permissions/filesystem.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import { createReadRuleSuggestion } from 'src/utils/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from 'src/utils/permissions/PermissionUpdateSchema.js'
import {
  expandTilde,
  type FileOperationType,
  formatDirectoryList,
  isDangerousRemovalPath,
  validatePath,
} from 'src/utils/permissions/pathValidation.js'
import type { BashTool } from './BashTool.js'
import { stripSafeWrappers } from './bashPermissions.js'
import { sedCommandIsAllowedByAllowlist } from './sedValidation.js'

export type PathCommand =
  | 'cd'
  | 'ls'
  | 'find'
  | 'mkdir'
  | 'touch'
  | 'rm'
  | 'rmdir'
  | 'mv'
  | 'cp'
  | 'cat'
  | 'head'
  | 'tail'
  | 'sort'
  | 'uniq'
  | 'wc'
  | 'cut'
  | 'paste'
  | 'column'
  | 'tr'
  | 'file'
  | 'stat'
  | 'diff'
  | 'awk'
  | 'strings'
  | 'hexdump'
  | 'od'
  | 'base64'
  | 'nl'
  | 'grep'
  | 'rg'
  | 'sed'
  | 'git'
  | 'jq'
  | 'sha256sum'
  | 'sha1sum'
  | 'md5sum'

/**
 * 检查 rm/rmdir 命令是否针对危险 path，这类 path 即使存在 allowlist 规则
 * 也应始终要求显式用户批准。
 * 此举可防止诸如 `rm -rf /` 这类命令造成灾难性的数据丢失。
 */
function checkDangerousRemovalPaths(
  command: 'rm' | 'rmdir',
  args: string[],
  cwd: string,
): PermissionResult {
  // 使用现有的 path 提取器提取 path
  const extractor = PATH_EXTRACTORS[command]
  const paths = extractor(args)

  for (const path of paths) {
    // 展开 tilde 并解析为绝对 path
    // 注意：我们不解析 symlink 来检查 path，因为危险 path
    // 比如 /tmp 应该被捕获，即使 /tmp 在 macOS 上是 /private/tmp 的 symlink
    const cleanPath = expandTilde(path.replace(/^['"]|['"]$/g, ''))
    const absolutePath = isAbsolute(cleanPath)
      ? cleanPath
      : resolve(cwd, cleanPath)

    // 检查是否为危险 path（使用未解析 symlink 的 path）
    if (isDangerousRemovalPath(absolutePath)) {
      return {
        behavior: 'ask',
        message: `Dangerous ${command} operation detected: '${absolutePath}'\n\nThis command would remove a critical system directory. This requires explicit approval and cannot be auto-allowed by permission rules.`,
        decisionReason: {
          type: 'other',
          reason: `Dangerous ${command} operation on critical path: ${absolutePath}`,
        },
        // 不提供建议 - 我们不希望鼓励保存危险命令
        suggestions: [],
      }
    }
  }

  // 未发现危险 path
  return {
    behavior: 'passthrough',
    message: `No dangerous removals detected for ${command} command`,
  }
}

/**
 * 安全：提取位置（非 flag）参数，正确处理
 * POSIX `--` 选项结束分隔符。
 *
 * 大多数命令（rm、cat、touch 等）在 `--` 处停止解析选项，并将
 * 之后的所有参数视为位置参数，即使它们以 `-` 开头。简单的
 * `!arg.startsWith('-')` 过滤会丢弃这些参数，导致 path 校验被静默跳过，
 * 从而被如下攻击载荷利用：
 *
 *   rm -- -/../.claude/settings.local.json
 *
 * 这里 `-/../.claude/settings.local.json` 以 `-` 开头，简单过滤器会
 * 丢弃它，校验看到零个 path，返回 passthrough，文件在无提示的情况下
 * 被删除。通过处理 `--`，path 会被提取并校验（被
 * isClaudeConfigFilePath / pathInAllowedWorkingPath 阻止）。
 */
function filterOutFlags(args: string[]): string[] {
  const result: string[] = []
  let afterDoubleDash = false
  for (const arg of args) {
    if (afterDoubleDash) {
      result.push(arg)
    } else if (arg === '--') {
      afterDoubleDash = true
    } else if (!arg?.startsWith('-')) {
      result.push(arg)
    }
  }
  return result
}

// 辅助：解析 grep/rg 风格的命令（先 pattern 后 path）
function parsePatternCommand(
  args: string[],
  flagsWithArgs: Set<string>,
  defaults: string[] = [],
): string[] {
  const paths: string[] = []
  let patternFound = false
  // 安全：跟踪 `--` 选项结束分隔符。在 `--` 之后，所有参数都是
  // 位置参数，无论是否以 `-` 开头。见 filterOutFlags() 的文档注释。
  let afterDoubleDash = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined || arg === null) continue

    if (!afterDoubleDash && arg === '--') {
      afterDoubleDash = true
      continue
    }

    if (!afterDoubleDash && arg.startsWith('-')) {
      const flag = arg.split('=')[0]
      // pattern flag 表示我们已经找到了 pattern
      if (flag && ['-e', '--regexp', '-f', '--file'].includes(flag)) {
        patternFound = true
      }
      // 如果 flag 需要参数则跳过下一个参数
      if (flag && flagsWithArgs.has(flag) && !arg.includes('=')) {
        i++
      }
      continue
    }

    // 第一个非 flag 是 pattern，其余是 path
    if (!patternFound) {
      patternFound = true
      continue
    }
    paths.push(arg)
  }

  return paths.length > 0 ? paths : defaults
}

/**
 * 从不同 path 命令的参数中提取 path。
 * 每个命令对如何处理 path 和 flag 都有特定逻辑。
 */
export const PATH_EXTRACTORS: Record<
  PathCommand,
  (args: string[]) => string[]
> = {
  // cd：特殊情况 - 所有参数组成一个 path
  cd: args => (args.length === 0 ? [homedir()] : [args.join(' ')]),

  // ls：过滤 flag，默认为当前目录
  ls: args => {
    const paths = filterOutFlags(args)
    return paths.length > 0 ? paths : ['.']
  },

  // find：收集 path 直到遇到真正的 flag，同时检查接收 path 的 flag
  // 安全：`find -- -path` 使 `-path` 成为搜索起点（而非 predicate）。
  // GNU find 支持 `--` 以允许以 `-` 开头的搜索根。在 `--` 之后，
  // 我们保守地将所有剩余参数作为 path 进行校验。这会过度包含诸如
  // `-name foo` 的 predicate，但 find 是只读操作，且 predicate 解析到
  // cwd 内的 path（被允许），因此不会误判合法用途。这种过度包含确保了
  // 像 `find -- -/../../etc` 这样的攻击 path 能被捕获。
  find: args => {
    const paths: string[] = []
    const pathFlags = new Set([
      '-newer',
      '-anewer',
      '-cnewer',
      '-mnewer',
      '-samefile',
      '-path',
      '-wholename',
      '-ilname',
      '-lname',
      '-ipath',
      '-iwholename',
    ])
    const newerPattern = /^-newer[acmBt][acmtB]$/
    let foundNonGlobalFlag = false
    let afterDoubleDash = false

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (!arg) continue

      if (afterDoubleDash) {
        paths.push(arg)
        continue
      }

      if (arg === '--') {
        afterDoubleDash = true
        continue
      }

      // 处理 flag
      if (arg.startsWith('-')) {
        // 全局选项不会停止收集
        if (['-H', '-L', '-P'].includes(arg)) continue

        // 标记我们已遇到非全局 flag
        foundNonGlobalFlag = true

        // 检查此 flag 是否接收 path 参数
        if (pathFlags.has(arg) || newerPattern.test(arg)) {
          const nextArg = args[i + 1]
          if (nextArg) {
            paths.push(nextArg)
            i++ // 跳过刚处理的 path
          }
        }
        continue
      }

      // 仅收集第一个非全局 flag 之前的非 flag 参数
      if (!foundNonGlobalFlag) {
        paths.push(arg)
      }
    }
    return paths.length > 0 ? paths : ['.']
  },

  // 所有简单命令：仅过滤 flag
  mkdir: filterOutFlags,
  touch: filterOutFlags,
  rm: filterOutFlags,
  rmdir: filterOutFlags,
  mv: filterOutFlags,
  cp: filterOutFlags,
  cat: filterOutFlags,
  head: filterOutFlags,
  tail: filterOutFlags,
  sort: filterOutFlags,
  uniq: filterOutFlags,
  wc: filterOutFlags,
  cut: filterOutFlags,
  paste: filterOutFlags,
  column: filterOutFlags,
  file: filterOutFlags,
  stat: filterOutFlags,
  diff: filterOutFlags,
  awk: filterOutFlags,
  strings: filterOutFlags,
  hexdump: filterOutFlags,
  od: filterOutFlags,
  base64: filterOutFlags,
  nl: filterOutFlags,
  sha256sum: filterOutFlags,
  sha1sum: filterOutFlags,
  md5sum: filterOutFlags,

  // tr：特殊情况 - 跳过字符集
  tr: args => {
    const hasDelete = args.some(
      a =>
        a === '-d' ||
        a === '--delete' ||
        (a.startsWith('-') && a.includes('d')),
    )
    const nonFlags = filterOutFlags(args)
    return nonFlags.slice(hasDelete ? 1 : 2) // 跳过 SET1 或 SET1+SET2
  },

  // grep：先 pattern 后 path，默认为 stdin
  grep: args => {
    const flags = new Set([
      '-e',
      '--regexp',
      '-f',
      '--file',
      '--exclude',
      '--include',
      '--exclude-dir',
      '--include-dir',
      '-m',
      '--max-count',
      '-A',
      '--after-context',
      '-B',
      '--before-context',
      '-C',
      '--context',
    ])
    const paths = parsePatternCommand(args, flags)
    // 特殊情况：如果存在 -r/-R flag 且没有 path，使用当前目录
    if (
      paths.length === 0 &&
      args.some(a => ['-r', '-R', '--recursive'].includes(a))
    ) {
      return ['.']
    }
    return paths
  },

  // rg：先 pattern 后 path，默认为当前目录
  rg: args => {
    const flags = new Set([
      '-e',
      '--regexp',
      '-f',
      '--file',
      '-t',
      '--type',
      '-T',
      '--type-not',
      '-g',
      '--glob',
      '-m',
      '--max-count',
      '--max-depth',
      '-r',
      '--replace',
      '-A',
      '--after-context',
      '-B',
      '--before-context',
      '-C',
      '--context',
    ])
    return parsePatternCommand(args, flags, ['.'])
  },

  // sed：就地处理文件或从 stdin 读取
  sed: args => {
    const paths: string[] = []
    let skipNext = false
    let scriptFound = false
    // 安全：跟踪 `--` 选项结束分隔符。在 `--` 之后，所有参数都是
    // 位置参数，无论是否以 `-` 开头。见 filterOutFlags() 的文档注释。
    let afterDoubleDash = false

    for (let i = 0; i < args.length; i++) {
      if (skipNext) {
        skipNext = false
        continue
      }

      const arg = args[i]
      if (!arg) continue

      if (!afterDoubleDash && arg === '--') {
        afterDoubleDash = true
        continue
      }

      // 处理 flag（仅在 `--` 之前）
      if (!afterDoubleDash && arg.startsWith('-')) {
        // -f flag：下一个参数是需要校验的脚本文件
        if (['-f', '--file'].includes(arg)) {
          const scriptFile = args[i + 1]
          if (scriptFile) {
            paths.push(scriptFile) // 将脚本文件加入 path 以便校验
            skipNext = true
          }
          scriptFound = true
        }
        // -e flag：下一个参数是表达式，不是文件
        else if (['-e', '--expression'].includes(arg)) {
          skipNext = true
          scriptFound = true
        }
        // 组合 flag，如 -ie 或 -nf
        else if (arg.includes('e') || arg.includes('f')) {
          scriptFound = true
        }
        continue
      }

      // 第一个非 flag 是脚本（如果尚未通过 -e/-f 找到）
      if (!scriptFound) {
        scriptFound = true
        continue
      }

      // 其余是文件 path
      paths.push(arg)
    }

    return paths
  },

  // jq：先 filter 后文件 path（类似 grep）
  // jq 命令结构为：jq [flags] filter [files...]
  // 如果未提供文件，jq 从 stdin 读取
  jq: args => {
    const paths: string[] = []
    const flagsWithArgs = new Set([
      '-e',
      '--expression',
      '-f',
      '--from-file',
      '--arg',
      '--argjson',
      '--slurpfile',
      '--rawfile',
      '--args',
      '--jsonargs',
      '-L',
      '--library-path',
      '--indent',
      '--tab',
    ])
    let filterFound = false
    // 安全：跟踪 `--` 选项结束分隔符。在 `--` 之后，所有参数都是
    // 位置参数，无论是否以 `-` 开头。见 filterOutFlags() 的文档注释。
    let afterDoubleDash = false

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === undefined || arg === null) continue

      if (!afterDoubleDash && arg === '--') {
        afterDoubleDash = true
        continue
      }

      if (!afterDoubleDash && arg.startsWith('-')) {
        const flag = arg.split('=')[0]
        // pattern flag 表示我们已找到 filter
        if (flag && ['-e', '--expression'].includes(flag)) {
          filterFound = true
        }
        // 如果 flag 需要参数则跳过下一个参数
        if (flag && flagsWithArgs.has(flag) && !arg.includes('=')) {
          i++
        }
        continue
      }

      // 第一个非 flag 是 filter，其余是文件 path
      if (!filterFound) {
        filterFound = true
        continue
      }
      paths.push(arg)
    }

    // 如果没有文件 path，jq 从 stdin 读取（无需校验 path）
    return paths
  },

  // git：处理访问仓库之外任意文件的子命令
  git: args => {
    // git diff --no-index 是特殊情况 - 它显式比较不受 git 控制的文件
    // 此 flag 允许 git diff 比较文件系统上的任意两个文件，而不仅仅是
    // 仓库内的文件，因此需要 path 校验
    if (args.length >= 1 && args[0] === 'diff') {
      if (args.includes('--no-index')) {
        // 安全：git diff --no-index 在文件 path 之前接受 `--`。
        // 使用能正确处理 `--` 的 filterOutFlags，而非简单的
        // startsWith('-') 过滤，以捕获如 `-/../etc/passwd` 这样的 path。
        const filePaths = filterOutFlags(args.slice(1))
        return filePaths.slice(0, 2) // git diff --no-index 期望恰好 2 个 path
      }
    }
    // 其他 git 命令（add、rm、mv、show 等）在仓库上下文内操作，
    // 并已受 git 自身安全模型的约束，因此无需额外的 path 校验
    return []
  },
}

const SUPPORTED_PATH_COMMANDS = Object.keys(PATH_EXTRACTORS) as PathCommand[]

const ACTION_VERBS: Record<PathCommand, string> = {
  cd: 'change directories to',
  ls: 'list files in',
  find: 'search files in',
  mkdir: 'create directories in',
  touch: 'create or modify files in',
  rm: 'remove files from',
  rmdir: 'remove directories from',
  mv: 'move files to/from',
  cp: 'copy files to/from',
  cat: 'concatenate files from',
  head: 'read the beginning of files from',
  tail: 'read the end of files from',
  sort: 'sort contents of files from',
  uniq: 'filter duplicate lines from files in',
  wc: 'count lines/words/bytes in files from',
  cut: 'extract columns from files in',
  paste: 'merge files from',
  column: 'format files from',
  tr: 'transform text from files in',
  file: 'examine file types in',
  stat: 'read file stats from',
  diff: 'compare files from',
  awk: 'process text from files in',
  strings: 'extract strings from files in',
  hexdump: 'display hex dump of files from',
  od: 'display octal dump of files from',
  base64: 'encode/decode files from',
  nl: 'number lines in files from',
  grep: 'search for patterns in files from',
  rg: 'search for patterns in files from',
  sed: 'edit files in',
  git: 'access files with git from',
  jq: 'process JSON from files in',
  sha256sum: 'compute SHA-256 checksums for files in',
  sha1sum: 'compute SHA-1 checksums for files in',
  md5sum: 'compute MD5 checksums for files in',
}

export const COMMAND_OPERATION_TYPE: Record<PathCommand, FileOperationType> = {
  cd: 'read',
  ls: 'read',
  find: 'read',
  mkdir: 'create',
  touch: 'create',
  rm: 'write',
  rmdir: 'write',
  mv: 'write',
  cp: 'write',
  cat: 'read',
  head: 'read',
  tail: 'read',
  sort: 'read',
  uniq: 'read',
  wc: 'read',
  cut: 'read',
  paste: 'read',
  column: 'read',
  tr: 'read',
  file: 'read',
  stat: 'read',
  diff: 'read',
  awk: 'read',
  strings: 'read',
  hexdump: 'read',
  od: 'read',
  base64: 'read',
  nl: 'read',
  grep: 'read',
  rg: 'read',
  sed: 'write',
  git: 'read',
  jq: 'read',
  sha256sum: 'read',
  sha1sum: 'read',
  md5sum: 'read',
}

/**
 * 命令专属校验器，在 path 校验之前运行。
 * 命令有效返回 true，应被拒绝返回 false。
 * 用于阻止带有可能绕过 path 校验的 flag 的命令。
 */
const COMMAND_VALIDATOR: Partial<
  Record<PathCommand, (args: string[]) => boolean>
> = {
  mv: (args: string[]) => !args.some(arg => arg?.startsWith('-')),
  cp: (args: string[]) => !args.some(arg => arg?.startsWith('-')),
}

function validateCommandPaths(
  command: PathCommand,
  args: string[],
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
  operationTypeOverride?: FileOperationType,
): PermissionResult {
  const extractor = PATH_EXTRACTORS[command]
  const paths = extractor(args)
  const operationType = operationTypeOverride ?? COMMAND_OPERATION_TYPE[command]

  // 安全：检查命令专属校验器（例如，阻止可能绕过 path 校验的 flag）
  // 一些命令如 mv/cp 拥有可绕过 path 提取的 flag（--target-directory=PATH），
  // 因此我们对这些命令阻止所有 flag 以确保安全。
  const validator = COMMAND_VALIDATOR[command]
  if (validator && !validator(args)) {
    return {
      behavior: 'ask',
      message: `${command} with flags requires manual approval to ensure path safety. For security, Claude Code cannot automatically validate ${command} commands that use flags, as some flags like --target-directory=PATH can bypass path validation.`,
      decisionReason: {
        type: 'other',
        reason: `${command} command with flags requires manual approval`,
      },
    }
  }

  // 安全：阻止包含 'cd' 的复合命令中的写操作
  // 这可防止通过在操作前更改目录来绕过 path 安全检查。
  // 攻击示例：cd .claude/ && mv test.txt settings.json
  // 这会绕过对 .claude/settings.json 的检查，因为 path 是相对于
  // 原始 CWD 解析的，未考虑 cd 的影响。
  //
  // 替代方案：与其阻止所有带 cd 的写操作，我们可以在命令链中跟踪
  // 有效 CWD（例如，在 "cd .claude/" 之后，后续命令将以 CWD=".claude/"
  // 进行校验）。这样更宽松，但需要谨慎处理：
  // - 相对 path（cd ../foo）
  // - 特殊 cd 目标（cd ~、cd -、无参数 cd）
  // - 连续多个 cd 命令
  // - cd 目标无法确定的错误情况
  // 目前，我们采取要求手动批准的保守做法。
  if (compoundCommandHasCd && operationType !== 'read') {
    return {
      behavior: 'ask',
      message: `Commands that change directories and perform write operations require explicit approval to ensure paths are evaluated correctly. For security, Claude Code cannot automatically determine the final working directory when 'cd' is used in compound commands.`,
      decisionReason: {
        type: 'other',
        reason:
          'Compound command contains cd with write operation - manual approval required to prevent path resolution bypass',
      },
    }
  }

  for (const path of paths) {
    const { allowed, resolvedPath, decisionReason } = validatePath(
      path,
      cwd,
      toolPermissionContext,
      operationType,
    )

    if (!allowed) {
      const workingDirs = Array.from(
        allWorkingDirectories(toolPermissionContext),
      )
      const dirListStr = formatDirectoryList(workingDirs)

      // 如果安全检查提供了自定义原因（type: 'other' 或 'safetyCheck'）则使用它
      // 否则使用标准的"被阻止"消息
      const message =
        decisionReason?.type === 'other' ||
        decisionReason?.type === 'safetyCheck'
          ? decisionReason.reason
          : `${command} in '${resolvedPath}' was blocked. For security, Claude Code may only ${ACTION_VERBS[command]} the allowed working directories for this session: ${dirListStr}.`

      if (decisionReason?.type === 'rule') {
        return {
          behavior: 'deny',
          message,
          decisionReason,
        }
      }

      return {
        behavior: 'ask',
        message,
        blockedPath: resolvedPath,
        decisionReason,
      }
    }
  }

  // 所有 path 均有效 - 返回 passthrough
  return {
    behavior: 'passthrough',
    message: `Path validation passed for ${command} command`,
  }
}

export function createPathChecker(
  command: PathCommand,
  operationTypeOverride?: FileOperationType,
) {
  return (
    args: string[],
    cwd: string,
    context: ToolPermissionContext,
    compoundCommandHasCd?: boolean,
  ): PermissionResult => {
    // 首先检查常规 path 校验（包含显式 deny 规则）
    const result = validateCommandPaths(
      command,
      args,
      cwd,
      context,
      compoundCommandHasCd,
      operationTypeOverride,
    )

    // 如果被显式拒绝，遵从它（不要用危险 path 消息覆盖）
    if (result.behavior === 'deny') {
      return result
    }

    // 在显式 deny 规则之后、其他结果之前检查危险删除 path
    // 这确保即使用户有 allowlist 规则或 glob pattern 被拒绝，
    // 该检查也会运行，同时遵从显式 deny 规则。危险 pattern 会获得
    // 特定错误消息，覆盖通用的 glob pattern 拒绝消息。
    if (command === 'rm' || command === 'rmdir') {
      const dangerousPathResult = checkDangerousRemovalPaths(command, args, cwd)
      if (dangerousPathResult.behavior !== 'passthrough') {
        return dangerousPathResult
      }
    }

    // 如果是 passthrough，直接返回
    if (result.behavior === 'passthrough') {
      return result
    }

    // 如果是 ask 决策，根据操作类型添加建议
    if (result.behavior === 'ask') {
      const operationType =
        operationTypeOverride ?? COMMAND_OPERATION_TYPE[command]
      const suggestions: PermissionUpdate[] = []

      // 仅在存在被阻止 path 时建议添加目录/规则
      if (result.blockedPath) {
        if (operationType === 'read') {
          // 对于读操作，建议为该目录添加 Read 规则（仅在目录存在时）
          const dirPath = getDirectoryForPath(result.blockedPath)
          const suggestion = createReadRuleSuggestion(dirPath, 'session')
          if (suggestion) {
            suggestions.push(suggestion)
          }
        } else {
          // 对于写/创建操作，建议添加该目录
          suggestions.push({
            type: 'addDirectories',
            directories: [getDirectoryForPath(result.blockedPath)],
            destination: 'session',
          })
        }
      }

      // 对于写操作，也建议启用 accept-edits 模式
      if (operationType === 'write' || operationType === 'create') {
        suggestions.push({
          type: 'setMode',
          mode: 'acceptEdits',
          destination: 'session',
        })
      }

      result.suggestions = suggestions
    }

    // 直接返回决策
    return result
  }
}

/**
 * 使用 shell-quote 解析命令参数，将 glob 对象转换为字符串。
 * 这是必要的，因为 shell-quote 会把 *.txt 这样的 pattern 解析为 glob 对象，
 * 但 path 校验需要它们作为字符串。
 */
function parseCommandArguments(cmd: string): string[] {
  const parseResult = tryParseShellCommand(cmd, env => `$${env}`)
  if (!parseResult.success) {
    // 格式错误的 shell 语法，返回空数组
    return []
  }
  const parsed = parseResult.tokens
  const extractedArgs: string[] = []

  for (const arg of parsed) {
    if (typeof arg === 'string') {
      // 包含空字符串 - 它们是有效参数（例如 grep "" /tmp/t）
      extractedArgs.push(arg)
    } else if (
      typeof arg === 'object' &&
      arg !== null &&
      'op' in arg &&
      arg.op === 'glob' &&
      'pattern' in arg
    ) {
      // shell-quote 将 glob pattern 解析为对象，但校验需要它们作为字符串
      extractedArgs.push(String(arg.pattern))
    }
  }

  return extractedArgs
}

/**
 * 校验单个命令的 path 约束和 shell 安全性。
 *
 * 此函数：
 * 1. 解析命令参数
 * 2. 检查是否为 path 命令（cd、ls、find）
 * 3. 校验是否存在 shell 注入 pattern
 * 4. 校验所有 path 是否在允许的目录内
 *
 * @param cmd - 要校验的命令字符串
 * @param cwd - 当前工作目录
 * @param toolPermissionContext - 包含允许目录的上下文
 * @param compoundCommandHasCd - 完整复合命令是否包含 cd
 * @returns PermissionResult - 非 path 命令返回 'passthrough'，否则返回校验结果
 */
function validateSinglePathCommand(
  cmd: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
): PermissionResult {
  // 安全：在提取基础命令之前剥离 wrapper 命令（timeout、nice、nohup、time）。
  // 如果不这样做，用这些工具包装的危险命令会绕过 path 校验，因为会检查
  // wrapper 命令（例如 'timeout'）而非实际命令（例如 'rm'）。
  // 示例：'timeout 10 rm -rf /' 否则会把 'timeout' 当作基础命令。
  const strippedCmd = stripSafeWrappers(cmd)

  // 将命令解析为参数，处理引号和 glob
  const extractedArgs = parseCommandArguments(strippedCmd)
  if (extractedArgs.length === 0) {
    return {
      behavior: 'passthrough',
      message: 'Empty command - no paths to validate',
    }
  }

  // 检查这是否是一条需要校验的 path 命令
  const [baseCmd, ...args] = extractedArgs
  if (!baseCmd || !SUPPORTED_PATH_COMMANDS.includes(baseCmd as PathCommand)) {
    return {
      behavior: 'passthrough',
      message: `Command '${baseCmd}' is not a path-restricted command`,
    }
  }

  // 对于只读 sed 命令（例如 sed -n '1,10p' file.txt），
  // 将文件路径按读操作而不是写操作来校验。
  // sed 在 path 校验中通常被归类为 'write'，但当命令完全是读取行为
  //（带 -n 的行打印）时，文件参数是只读的。
  const operationTypeOverride =
    baseCmd === 'sed' && sedCommandIsAllowedByAllowlist(strippedCmd)
      ? ('read' as FileOperationType)
      : undefined

  // 校验所有路径是否都位于允许的目录内
  const pathChecker = createPathChecker(
    baseCmd as PathCommand,
    operationTypeOverride,
  )
  return pathChecker(args, cwd, toolPermissionContext, compoundCommandHasCd)
}

/**
 * 与 validateSinglePathCommand 类似，但直接基于 AST 派生的 argv 进行处理，
 * 而不是再用 shell-quote 重新解析命令字符串。这样可以避免 shell-quote 的
 * 单引号反斜杠 bug——该 bug 会让 parseCommandArguments 静默返回 []，
 * 从而跳过 path 校验。
 */
function validateSinglePathCommandArgv(
  cmd: SimpleCommand,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
): PermissionResult {
  const argv = stripWrappersFromArgv(cmd.argv)
  if (argv.length === 0) {
    return {
      behavior: 'passthrough',
      message: 'Empty command - no paths to validate',
    }
  }
  const [baseCmd, ...args] = argv
  if (!baseCmd || !SUPPORTED_PATH_COMMANDS.includes(baseCmd as PathCommand)) {
    return {
      behavior: 'passthrough',
      message: `Command '${baseCmd}' is not a path-restricted command`,
    }
  }
  // sed 只读覆盖：由于 sedCommandIsAllowedByAllowlist 接收字符串，
  // 这里使用 .text 进行 allowlist 检查。argv 已经剥离了 wrapper，
  // 但 .text 是原始的 tree-sitter span（包含 `timeout 5 ` 前缀），
  // 因此这里也需要剥离。
  const operationTypeOverride =
    baseCmd === 'sed' &&
    sedCommandIsAllowedByAllowlist(stripSafeWrappers(cmd.text))
      ? ('read' as FileOperationType)
      : undefined
  const pathChecker = createPathChecker(
    baseCmd as PathCommand,
    operationTypeOverride,
  )
  return pathChecker(args, cwd, toolPermissionContext, compoundCommandHasCd)
}

function validateOutputRedirections(
  redirections: Array<{ target: string; operator: '>' | '>>' }>,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
): PermissionResult {
  // 安全：在包含 'cd' 的复合命令中阻止输出重定向。
  // 这样可以防止通过在重定向之前切换目录来绕过 path 安全检查。
  // 攻击示例：cd .claude/ && echo "malicious" > settings.json
  // 重定向目标会相对于原始 CWD 进行校验，但实际写入发生在 'cd' 执行后
  // 切换过的目录中。
  if (compoundCommandHasCd && redirections.length > 0) {
    return {
      behavior: 'ask',
      message: `Commands that change directories and write via output redirection require explicit approval to ensure paths are evaluated correctly. For security, Claude Code cannot automatically determine the final working directory when 'cd' is used in compound commands.`,
      decisionReason: {
        type: 'other',
        reason:
          'Compound command contains cd with output redirection - manual approval required to prevent path resolution bypass',
      },
    }
  }
  for (const { target } of redirections) {
    // /dev/null is always safe - it discards output
    if (target === '/dev/null') {
      continue
    }
    const { allowed, resolvedPath, decisionReason } = validatePath(
      target,
      cwd,
      toolPermissionContext,
      'create', // Treat > and >> as create operations
    )

    if (!allowed) {
      const workingDirs = Array.from(
        allWorkingDirectories(toolPermissionContext),
      )
      const dirListStr = formatDirectoryList(workingDirs)

      // 若可用（type 为 'other' 或 'safetyCheck'），使用安全检查的自定义原因；
      // 否则使用针对 deny 规则或工作目录限制的标准消息
      const message =
        decisionReason?.type === 'other' ||
        decisionReason?.type === 'safetyCheck'
          ? decisionReason.reason
          : decisionReason?.type === 'rule'
            ? `Output redirection to '${resolvedPath}' was blocked by a deny rule.`
            : `Output redirection to '${resolvedPath}' was blocked. For security, Claude Code may only write to files in the allowed working directories for this session: ${dirListStr}.`

      // 若是被 deny 规则拒绝，则返回 'deny' 行为
      if (decisionReason?.type === 'rule') {
        return {
          behavior: 'deny',
          message,
          decisionReason,
        }
      }

      return {
        behavior: 'ask',
        message,
        blockedPath: resolvedPath,
        decisionReason,
        suggestions: [
          {
            type: 'addDirectories',
            directories: [getDirectoryForPath(resolvedPath)],
            destination: 'session',
          },
        ],
      }
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No unsafe redirections found',
  }
}

/**
 * 检查访问文件系统的命令（cd、ls、find）的路径约束。
 * 同时校验输出重定向，确保其目标位于允许的目录内。
 *
 * @returns
 * - 若任一 path 命令或重定向试图访问允许目录之外的位置，则返回 'ask'
 * - 若未发现 path 命令，或所有路径均在允许目录内，则返回 'passthrough'
 */
export function checkPathConstraints(
  input: z.infer<typeof BashTool.inputSchema>,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
  astRedirects?: Redirect[],
  astCommands?: SimpleCommand[],
): PermissionResult {
  // 安全：进程替换 >(cmd) 可以执行向文件写入的命令，
  // 而这些文件不会作为重定向目标出现。例如：
  //   echo secret > >(tee .git/config)
  // tee 命令会向 .git/config 写入，但它不会被检测为重定向。
  // 对于任何包含进程替换的命令，都要求显式批准。
  // 在 AST 路径下跳过——process_substitution 已在 DANGEROUS_TYPES 中，
  // 在到达此处之前就会以 too-complex 返回。
  if (!astCommands && />>\s*>\s*\(|>\s*>\s*\(|<\s*\(/.test(input.command)) {
    return {
      behavior: 'ask',
      message:
        'Process substitution (>(...) or <(...)) can execute arbitrary commands and requires manual approval',
      decisionReason: {
        type: 'other',
        reason: 'Process substitution requires manual approval',
      },
    }
  }

  // 安全：当存在 AST 派生的重定向时，直接使用它们，而不是再用
  // shell-quote 重新解析。shell-quote 有一个已知的单引号反斜杠 bug，
  // 在解析成功时会将重定向操作符静默合并成乱码 token（这不是解析失败，
  // 因此 fail-closed 守卫无效）。AST 已经正确解析了目标，
  // checkSemantics 也已校验过它们。
  const { redirections, hasDangerousRedirection } = astRedirects
    ? astRedirectsToOutputRedirections(astRedirects)
    : extractOutputRedirections(input.command)

  // 安全：若发现重定向操作符的目标包含 shell 展开语法（$VAR 或 %VAR%），
  // 则要求手动批准，因为目标无法被安全校验。
  if (hasDangerousRedirection) {
    return {
      behavior: 'ask',
      message: 'Shell expansion syntax in paths requires manual approval',
      decisionReason: {
        type: 'other',
        reason: 'Shell expansion syntax in paths requires manual approval',
      },
    }
  }
  const redirectionResult = validateOutputRedirections(
    redirections,
    cwd,
    toolPermissionContext,
    compoundCommandHasCd,
  )
  if (redirectionResult.behavior !== 'passthrough') {
    return redirectionResult
  }

  // 安全：当存在 AST 派生的命令时，使用预解析的 argv 进行迭代，
  // 而不是再用 splitCommand_DEPRECATED + shell-quote 重新解析。
  // shell-quote 有一个单引号反斜杠 bug，会导致 parseCommandArguments
  // 静默返回 []，从而跳过 path 校验（如 isDangerousRemovalPath 等）。
  // AST 已经正确解析了 argv。
  if (astCommands) {
    for (const cmd of astCommands) {
      const result = validateSinglePathCommandArgv(
        cmd,
        cwd,
        toolPermissionContext,
        compoundCommandHasCd,
      )
      if (result.behavior === 'ask' || result.behavior === 'deny') {
        return result
      }
    }
  } else {
    const commands = splitCommand_DEPRECATED(input.command)
    for (const cmd of commands) {
      const result = validateSinglePathCommand(
        cmd,
        cwd,
        toolPermissionContext,
        compoundCommandHasCd,
      )
      if (result.behavior === 'ask' || result.behavior === 'deny') {
        return result
      }
    }
  }

  // 始终返回 passthrough，让其他权限检查继续处理该命令
  return {
    behavior: 'passthrough',
    message: 'All path commands validated successfully',
  }
}

/**
 * 将 AST 派生的 Redirect[] 转换为 validateOutputRedirections 期望的格式。
 * 仅保留输出重定向（排除像 2>&1 这样的 fd 复制），
 * 并将操作符映射为 '>' | '>>'。
 */
function astRedirectsToOutputRedirections(redirects: Redirect[]): {
  redirections: Array<{ target: string; operator: '>' | '>>' }>
  hasDangerousRedirection: boolean
} {
  const redirections: Array<{ target: string; operator: '>' | '>>' }> = []
  for (const r of redirects) {
    switch (r.op) {
      case '>':
      case '>|':
      case '&>':
        redirections.push({ target: r.target, operator: '>' })
        break
      case '>>':
      case '&>>':
        redirections.push({ target: r.target, operator: '>>' })
        break
      case '>&':
        // >&N（仅数字）是 fd 复制（例如 2>&1、>&10），不是文件写入。
        // >&file 是 &>file（重定向到文件）的废弃写法。
        if (!/^\d+$/.test(r.target)) {
          redirections.push({ target: r.target, operator: '>' })
        }
        break
      case '<':
      case '<<':
      case '<&':
      case '<<<':
        // 输入重定向——跳过
        break
    }
  }
  // AST 的目标已完全解析（无 shell 展开）——checkSemantics 已经校验过。
  // 不可能存在危险的重定向。
  return { redirections, hasDangerousRedirection: false }
}

// ───────────────────────────────────────────────────────────────────────────
// Argv 层面的安全 wrapper 剥离（timeout、nice、stdbuf、env、time、nohup）
//
// 这是权威的 stripWrappersFromArgv 实现。bashPermissions.ts 仍然导出一份
// 更窄的旧版本（仅包含 timeout/nice-n-N），属于死代码——没有生产环境消费者——
// 但不能删除：bashPermissions.ts 刚好处在 Bun feature() DCE 复杂度阈值附近，
// 从该模块删除约 80 行会静默破坏 feature('BASH_CLASSIFIER') 的求值
//（会丢弃每一个 pendingClassifierCheck 展开）。已在 PR #21503 第 3 轮验证：
// 基线 classifier 测试 30/30 通过，删除后 22/30 失败。见团队记忆：
// bun-feature-dce-cliff.md。在 PR #21075 中命中 3 次，在 #21503 中命中 2 次。
// 扩展版本放在这里（唯一的生产环境消费者）。
//
// 保持同步：
//   - bashPermissions.ts 中的 SAFE_WRAPPER_PATTERNS（基于文本的 stripSafeWrappers）
//   - checkSemantics 中的 wrapper 剥离循环（src/utils/bash/ast.ts ~1860）
// 如果在任一处新增 wrapper，也要在此处新增。不对称会导致 checkSemantics
// 把被包装的命令暴露给语义检查，而 path 校验看到的只是 wrapper 名 →
// passthrough → 被包装命令的路径从不被校验（PR #21503 review 2907319120）。
// ───────────────────────────────────────────────────────────────────────────

// 安全：timeout flag VALUE 的白名单（信号为 TERM/KILL/9，
// 时长为 5/5s/10.5）。拒绝 $ ( ) ` | ; & 以及换行符，
// 它们此前会被 [^ \t]+ 匹配——`timeout -k$(id) 10 ls` 绝不能被剥离。
const TIMEOUT_FLAG_VALUE_RE = /^[A-Za-z0-9_.+-]+$/

/**
 * 解析 timeout 的 GNU flag（长/短形式、融合/空格分隔），
 * 返回 DURATION token 的 argv 下标；若 flag 无法解析则返回 -1。
 */
function skipTimeoutFlags(a: readonly string[]): number {
  let i = 1
  while (i < a.length) {
    const arg = a[i]!
    const next = a[i + 1]
    if (
      arg === '--foreground' ||
      arg === '--preserve-status' ||
      arg === '--verbose'
    )
      i++
    else if (/^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/.test(arg)) i++
    else if (
      (arg === '--kill-after' || arg === '--signal') &&
      next &&
      TIMEOUT_FLAG_VALUE_RE.test(next)
    )
      i += 2
    else if (arg === '--') {
      i++
      break
    } // 选项结束分隔符
    else if (arg.startsWith('--')) return -1
    else if (arg === '-v') i++
    else if (
      (arg === '-k' || arg === '-s') &&
      next &&
      TIMEOUT_FLAG_VALUE_RE.test(next)
    )
      i += 2
    else if (/^-[ks][A-Za-z0-9_.+-]+$/.test(arg)) i++
    else if (arg.startsWith('-')) return -1
    else break
  }
  return i
}

/**
 * 解析 stdbuf 的 flag（支持 -i/-o/-e 的融合/空格分隔/长-= 形式）。
 * 返回被包装 COMMAND 的 argv 下标；若无法解析或没有消费任何 flag
 *（stdbuf 无 flag 时无副作用），则返回 -1。与 checkSemantics（ast.ts）保持一致。
 */
function skipStdbufFlags(a: readonly string[]): number {
  let i = 1
  while (i < a.length) {
    const arg = a[i]!
    if (/^-[ioe]$/.test(arg) && a[i + 1]) i += 2
    else if (/^-[ioe]./.test(arg)) i++
    else if (/^--(input|output|error)=/.test(arg)) i++
    else if (arg.startsWith('-'))
      return -1 // 未知 flag：fail closed
    else break
  }
  return i > 1 && i < a.length ? i : -1
}

/**
 * 解析 env 的 VAR=val 与安全 flag（-i/-0/-v/-u NAME）。返回被包装 COMMAND 的
 * argv 下标；若无法解析或没有被包装命令则返回 -1。拒绝 -S（argv 拆分器）、
 * -C/-P（altwd/altpath）。与 checkSemantics（ast.ts）保持一致。
 */
function skipEnvFlags(a: readonly string[]): number {
  let i = 1
  while (i < a.length) {
    const arg = a[i]!
    if (arg.includes('=') && !arg.startsWith('-')) i++
    else if (arg === '-i' || arg === '-0' || arg === '-v') i++
    else if (arg === '-u' && a[i + 1]) i += 2
    else if (arg.startsWith('-'))
      return -1 // -S/-C/-P/未知：fail closed
    else break
  }
  return i < a.length ? i : -1
}

/**
 * stripSafeWrappers（bashPermissions.ts）的 argv 层面对应实现。从 AST 派生的
 * argv 中剥离 wrapper 命令。环境变量已经被拆分到 SimpleCommand.envVars，
 * 因此这里不再处理环境变量剥离。
 */
export function stripWrappersFromArgv(argv: string[]): string[] {
  let a = argv
  for (;;) {
    if (a[0] === 'time' || a[0] === 'nohup') {
      a = a.slice(a[1] === '--' ? 2 : 1)
    } else if (a[0] === 'timeout') {
      const i = skipTimeoutFlags(a)
      // 安全（PR #21503 第 3 轮）：无法识别的时长（`.5`、`+5`、
      // `inf`——GNU timeout 接受的 strtod 格式）→ 原样返回 a。
      // 之所以安全，是因为 checkSemantics（ast.ts）对相同输入会 fail CLOSED，
      // 且在 bashToolHasPermission 中先于我们执行，因此我们永远到不了这里。
      if (i < 0 || !a[i] || !/^\d+(?:\.\d+)?[smhd]?$/.test(a[i]!)) return a
      a = a.slice(i + 1)
    } else if (a[0] === 'nice') {
      // 安全（PR #21503 第 3 轮）：与 checkSemantics 对齐——处理裸
      // `nice cmd` 以及旧式 `nice -N cmd`，而不仅仅是 `nice -n N cmd`。
      // 此前仅剥离 `-n N`：`nice rm /outside` →
      // baseCmd='nice' → passthrough → /outside 从不被 path 校验。
      if (a[1] === '-n' && a[2] && /^-?\d+$/.test(a[2]))
        a = a.slice(a[3] === '--' ? 4 : 3)
      else if (a[1] && /^-\d+$/.test(a[1])) a = a.slice(a[2] === '--' ? 3 : 2)
      else a = a.slice(a[1] === '--' ? 2 : 1)
    } else if (a[0] === 'stdbuf') {
      // 安全（PR #21503 第 3 轮）：本 PR 扩大了处理范围。PR 之前，`stdbuf -o0 -eL rm`
      // 会被 fragment 检查拒绝（旧 checkSemantics 的 slice(2) 留下
      // name='-eL'）。PR 之后，checkSemantics 会剥离两个 flag → name='rm'
      // → 通过。但 stripWrappersFromArgv 仍原样返回 →
      // baseCmd='stdbuf' → 不在 SUPPORTED_PATH_COMMANDS 中 → passthrough。
      const i = skipStdbufFlags(a)
      if (i < 0) return a
      a = a.slice(i)
    } else if (a[0] === 'env') {
      // 同样的不对称：checkSemantics 剥离了 env，我们此前没有。
      const i = skipEnvFlags(a)
      if (i < 0) return a
      a = a.slice(i)
    } else {
      return a
    }
  }
}
