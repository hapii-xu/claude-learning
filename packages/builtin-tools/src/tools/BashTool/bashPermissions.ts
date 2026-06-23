import { feature } from 'bun:bundle'
import { APIUserAbortError } from '@anthropic-ai/sdk'
import type { z } from 'zod/v4'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import type { ToolPermissionContext, ToolUseContext } from 'src/Tool.js'
import type { PendingClassifierCheck } from 'src/types/permissions.js'
import { count } from 'src/utils/array.js'
import {
  checkSemantics,
  nodeTypeId,
  type ParseForSecurityResult,
  parseForSecurityFromAst,
  type Redirect,
  type SimpleCommand,
} from 'src/utils/bash/ast.js'
import {
  type CommandPrefixResult,
  extractOutputRedirections,
  getCommandSubcommandPrefix,
  splitCommand_DEPRECATED,
} from 'src/utils/bash/commands.js'
import { parseCommandRaw } from 'src/utils/bash/parser.js'
import { tryParseShellCommand } from 'src/utils/bash/shellQuote.js'
import { getCwd } from 'src/utils/cwd.js'
import { logForDebugging } from 'src/utils/debug.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'
import { AbortError } from 'src/utils/errors.js'
import type {
  ClassifierBehavior,
  ClassifierResult,
} from 'src/utils/permissions/bashClassifier.js'
import {
  classifyBashCommand,
  getBashPromptAllowDescriptions,
  getBashPromptAskDescriptions,
  getBashPromptDenyDescriptions,
  isClassifierPermissionsEnabled,
} from 'src/utils/permissions/bashClassifier.js'
import type {
  PermissionDecisionReason,
  PermissionResult,
} from 'src/utils/permissions/PermissionResult.js'
import type {
  PermissionRule,
  PermissionRuleValue,
} from 'src/utils/permissions/PermissionRule.js'
import { extractRules } from 'src/utils/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from 'src/utils/permissions/PermissionUpdateSchema.js'
import { permissionRuleValueToString } from 'src/utils/permissions/permissionRuleParser.js'
import {
  createPermissionRequestMessage,
  getRuleByContentsForTool,
} from 'src/utils/permissions/permissions.js'
import {
  parsePermissionRule,
  type ShellPermissionRule,
  matchWildcardPattern as sharedMatchWildcardPattern,
  permissionRuleExtractPrefix as sharedPermissionRuleExtractPrefix,
  suggestionForExactCommand as sharedSuggestionForExactCommand,
  suggestionForPrefix as sharedSuggestionForPrefix,
} from 'src/utils/permissions/shellRuleMatching.js'
import { getPlatform } from 'src/utils/platform.js'
import { SandboxManager } from 'src/utils/sandbox/sandbox-adapter.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { windowsPathToPosixPath } from 'src/utils/windowsPaths.js'
import { BashTool } from './BashTool.js'
import { checkCommandOperatorPermissions } from './bashCommandHelpers.js'
import {
  bashCommandIsSafeAsync_DEPRECATED,
  stripSafeHeredocSubstitutions,
} from './bashSecurity.js'
import { checkPermissionMode } from './modeValidation.js'
import { checkPathConstraints } from './pathValidation.js'
import { checkSedConstraints } from './sedValidation.js'
import { shouldUseSandbox } from './shouldUseSandbox.js'

// DCE 临界：Bun 的 feature() 求值器对每个函数有复杂度预算。
// bashToolHasPermission 正好处在限制边界。import 块中的 `import { X as Y }`
// 别名会占用该预算；当超出阈值时，Bun 无法再证明 feature('BASH_CLASSIFIER')
// 是常量，会静默地把三元表达式求值为 `false`，丢弃所有 pendingClassifierCheck
// 展开。请将别名保持为顶层 const 重新绑定。（另见下面 checkSemanticsDeny 的注释。）
const bashCommandIsSafeAsync = bashCommandIsSafeAsync_DEPRECATED
const splitCommand = splitCommand_DEPRECATED

// 环境变量赋值 prefix（VAR=value）。三个 while 循环共用此正则，用于
// 在提取命令名之前跳过安全的环境变量。
const ENV_VAR_ASSIGN_RE = /^[A-Za-z_]\w*=/

// CC-643：对于复杂的复合命令，splitCommand_DEPRECATED 可能产生
// 非常大的子命令数组（可能指数级增长；#21405 的 ReDoS 修复可能不完整）。
// 每个子命令随后会执行 tree-sitter 解析 + 约 20 个校验器 + logEvent
// （bashSecurity.ts），在元数据被 memoize 后，产生的微任务链会饿死事件循环——
// REPL 冻结在 100% CPU，strace 显示 /proc/self/stat 读取频率约为 127Hz 而
// 没有 epoll_wait。五十这个上限很宽裕：合法的用户命令不会拆分得这么宽。
// 超过上限时我们回退到 'ask'（安全默认值——我们无法证明安全，所以提示用户）。
export const MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50

// GH#11380：限制为复合命令建议的 per-subcommand 规则数量。超过此数量后，
// "Yes, and don't ask again for X, Y, Z…" 标签无论如何都会降级为 "similar commands"，
// 而从一次提示中保存 10+ 条规则更可能是噪声而非用户意图。在一个 && 列表中
// 链接这么多写命令的用户很罕见；他们总是可以先批准一次再手动添加规则。
export const MAX_SUGGESTED_RULES_FOR_COMPOUND = 5

/**
 * [ANT 专用] 记录分类器评估结果以供分析。
 * 这帮助我们了解哪些分类器规则正在被评估，
 * 以及分类器是如何对命令作出决定的。
 */
function logClassifierResultForAnts(
  command: string,
  behavior: ClassifierBehavior,
  descriptions: string[],
  result: ClassifierResult,
): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  logEvent('tengu_internal_bash_classifier_result', {
    behavior:
      behavior as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    descriptions: jsonStringify(
      descriptions,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    matches: result.matches,
    matchedDescription: (result.matchedDescription ??
      '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    confidence:
      result.confidence as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    reason:
      result.reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // 注意：command 包含代码/文件路径 - 这是 ANT 专用，所以可以接受
    command:
      command as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

/**
 * 从原始命令字符串中提取稳定的命令 prefix（command + subcommand）。
 * 仅当开头的环境变量赋值属于 SAFE_ENV_VARS（或对 ant 用户属于
 * ANT_ONLY_SAFE_ENV_VARS）时才跳过。如果遇到非安全的环境变量则返回 null
 * （以回退到精确匹配），或当第二个 token 看起来不像子命令时返回 null
 * （小写字母数字，例如 "commit"、"run"）。
 *
 * 示例：
 *   'git commit -m "fix typo"' → 'git commit'
 *   'NODE_ENV=prod npm run build' → 'npm run'（NODE_ENV 是安全的）
 *   'MY_VAR=val npm run build' → null（MY_VAR 不安全）
 *   'ls -la' → null（是 flag，不是子命令）
 *   'cat file.txt' → null（是文件名，不是子命令）
 *   'chmod 755 file' → null（是数字，不是子命令）
 */
export function getSimpleCommandPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  // 跳过开头的环境变量赋值（VAR=value），但仅当它们属于
  // SAFE_ENV_VARS（或对 ant 用户属于 ANT_ONLY_SAFE_ENV_VARS）时。如果遇到
  // 非安全的环境变量，返回 null 以回退到精确匹配。这能防止生成诸如
  // Bash(npm run:*) 之类的 prefix 规则在 allow-rule 检查时永远无法匹配，
  // 因为 stripSafeWrappers 只剥离安全变量。
  let i = 0
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    const varName = tokens[i]!.split('=')[0]!
    const isAntOnlySafe =
      process.env.USER_TYPE === 'ant' && ANT_ONLY_SAFE_ENV_VARS.has(varName)
    if (!SAFE_ENV_VARS.has(varName) && !isAntOnlySafe) {
      return null
    }
    i++
  }

  const remaining = tokens.slice(i)
  if (remaining.length < 2) return null
  const subcmd = remaining[1]!
  // 第二个 token 必须看起来像子命令（例如 "commit"、"run"、"compose"），
  // 不能是 flag（-rf）、文件名（file.txt）、路径（/tmp）、URL 或数字（755）。
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(subcmd)) return null
  return remaining.slice(0, 2).join(' ')
}

// 像 `bash:*` 或 `sh:*` 这样的裸 prefix 建议会允许通过 `-c` 执行任意代码。
// 像 `env:*` 或 `sudo:*` 这样的 wrapper 建议也会造成同样后果：
// `env` 不在 SAFE_WRAPPER_PATTERNS 中，所以 `env bash -c "evil"` 会原样
// 通过 stripSafeWrappers，并在 prefix-rule 匹配器命中 startsWith("env ")。
// shell 列表镜像了 src/utils/shell/prefix.ts 中的 DANGEROUS_SHELL_PREFIXES，
// 后者保护过旧的 Haiku 提取器。
const BARE_SHELL_PREFIXES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'csh',
  'tcsh',
  'ksh',
  'dash',
  'cmd',
  'powershell',
  'pwsh',
  // 将其参数作为命令执行的 wrapper
  'env',
  'xargs',
  // 安全：checkSemantics（ast.ts）会剥离这些 wrapper 以检查被包装的命令。
  // 建议 `Bash(nice:*)` 会等价于 `Bash(*)`——用户在提示后添加它，
  // 然后 `nice rm -rf /` 会通过语义检查，而 deny/cd+git 闸门只看到 'nice'
  //（下面的 SAFE_WRAPPER_PATTERNS 在此修复之前不会剥离裸 `nice`）。
  // 阻止这些命令被建议。
  'nice',
  'stdbuf',
  'nohup',
  'timeout',
  'time',
  // 权限提升——来自 `sudo -u foo ...` 的 sudo:* 会自动批准
  // 任何未来的 sudo 调用
  'sudo',
  'doas',
  'pkexec',
])

/**
 * 仅 UI 回退：当 getSimpleCommandPrefix 拒绝时，单独提取第一个单词。
 * 在外部构建中 TREE_SITTER_BASH 是关闭的，因此 BashPermissionRequest 中的
 * 异步 tree-sitter 精化永远不会触发——没有这个回退，管道和复合命令
 *（`python3 file.py 2>&1 | tail -20`）会原样倒入可编辑字段。
 *
 * 故意不被 suggestionForExactCommand 使用：后端建议的
 * `Bash(rm:*)` 太宽泛而不能自动生成，但作为可编辑起点这正是用户期望的
 *（Slack C07VBSHV7EV/p1772670433193449）。
 *
 * 复用与 getSimpleCommandPrefix 相同的 SAFE_ENV_VARS 闸门——像
 * `Bash(python3:*)` 这样的规则在检查时永远无法匹配 `RUN=/path python3 ...`，
 * 因为 stripSafeWrappers 不会剥离 RUN。
 */
export function getFirstWordPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean)

  let i = 0
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    const varName = tokens[i]!.split('=')[0]!
    const isAntOnlySafe =
      process.env.USER_TYPE === 'ant' && ANT_ONLY_SAFE_ENV_VARS.has(varName)
    if (!SAFE_ENV_VARS.has(varName) && !isAntOnlySafe) {
      return null
    }
    i++
  }

  const cmd = tokens[i]
  if (!cmd) return null
  // 与 getSimpleCommandPrefix 中的子命令正则相同的形状检查：
  // 拒绝路径（./script.sh、/usr/bin/python）、flag、数字、文件名。
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(cmd)) return null
  if (BARE_SHELL_PREFIXES.has(cmd)) return null
  return cmd
}

function suggestionForExactCommand(command: string): PermissionUpdate[] {
  // Heredoc 命令包含每次调用都会变化的多行内容，
  // 这使得精确匹配规则毫无用处（它们永远不会再匹配）。提取 heredoc 操作符
  // 之前的稳定 prefix，改为建议 prefix 规则。
  const heredocPrefix = extractPrefixBeforeHeredoc(command)
  if (heredocPrefix) {
    return sharedSuggestionForPrefix(BashTool.name, heredocPrefix)
  }

  // 不含 heredoc 的多行命令同样不适合作为精确匹配规则。
  // 保存完整的多行文本可能在中间产生包含 `:*` 的模式，
  // 这会导致权限校验失败并破坏 settings 文件。改用第一行作为 prefix 规则。
  if (command.includes('\n')) {
    const firstLine = command.split('\n')[0]!.trim()
    if (firstLine) {
      return sharedSuggestionForPrefix(BashTool.name, firstLine)
    }
  }

  // 单行命令：提取一个 2 词 prefix 以生成可复用规则。
  // 否则保存的精确匹配规则永远不会匹配未来带不同参数的调用。
  const prefix = getSimpleCommandPrefix(command)
  if (prefix) {
    return sharedSuggestionForPrefix(BashTool.name, prefix)
  }

  return sharedSuggestionForExactCommand(BashTool.name, command)
}

/**
 * 如果命令包含 heredoc（<<），提取它之前的命令 prefix。
 * 返回 heredoc 操作符之前的一个或多个单词作为稳定 prefix，
 * 若命令不含 heredoc 则返回 null。
 *
 * 示例：
 *   'git commit -m "$(cat <<\'EOF\'\n...\nEOF\n)"' → 'git commit'
 *   'cat <<EOF\nhello\nEOF' → 'cat'
 *   'echo hello' → null（无 heredoc）
 */
function extractPrefixBeforeHeredoc(command: string): string | null {
  if (!command.includes('<<')) return null

  const idx = command.indexOf('<<')
  if (idx <= 0) return null

  const before = command.substring(0, idx).trim()
  if (!before) return null

  const prefix = getSimpleCommandPrefix(before)
  if (prefix) return prefix

  // 回退：跳过安全的环境变量赋值并最多取 2 个 token。
  // 这保留了 flag token（例如 "python3 -c" 保持 "python3 -c"，
  // 而不是只取 "python3"），并跳过诸如 "NODE_ENV=test" 之类的安全环境变量前缀。
  // 如果遇到非安全的环境变量，返回 null 以避免生成永远无法匹配的 prefix 规则
  //（理由与 getSimpleCommandPrefix 相同）。
  const tokens = before.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    const varName = tokens[i]!.split('=')[0]!
    const isAntOnlySafe =
      process.env.USER_TYPE === 'ant' && ANT_ONLY_SAFE_ENV_VARS.has(varName)
    if (!SAFE_ENV_VARS.has(varName) && !isAntOnlySafe) {
      return null
    }
    i++
  }
  if (i >= tokens.length) return null
  return tokens.slice(i, i + 2).join(' ') || null
}

function suggestionForPrefix(prefix: string): PermissionUpdate[] {
  return sharedSuggestionForPrefix(BashTool.name, prefix)
}

/**
 * 从旧版 :* 语法中提取 prefix（例如 "npm:*" -> "npm"）
 * 委托给共享实现。
 */
export const permissionRuleExtractPrefix = sharedPermissionRuleExtractPrefix

/**
 * 将命令与通配符模式进行匹配（对 Bash 区分大小写）。
 * 委托给共享实现。
 */
export function matchWildcardPattern(
  pattern: string,
  command: string,
): boolean {
  return sharedMatchWildcardPattern(pattern, command)
}

/**
 * 将权限规则解析为结构化规则对象。
 * 委托给共享实现。
 */
export const bashPermissionRule: (
  permissionRule: string,
) => ShellPermissionRule = parsePermissionRule

/**
 * 可以安全从命令中剥离的环境变量白名单。
 * 这些变量不能执行代码或加载库。
 *
 * 安全要求：以下变量绝不能加入白名单：
 * - PATH、LD_PRELOAD、LD_LIBRARY_PATH、DYLD_*（执行/库加载）
 * - PYTHONPATH、NODE_PATH、CLASSPATH、RUBYLIB（模块加载）
 * - GOFLAGS、RUSTFLAGS、NODE_OPTIONS（可能包含代码执行 flag）
 * - HOME、TMPDIR、SHELL、BASH_ENV（影响系统行为）
 */
const SAFE_ENV_VARS = new Set([
  // Go - 仅构建/运行时设置
  'GOEXPERIMENT', // 实验特性
  'GOOS', // 目标 OS
  'GOARCH', // 目标架构
  'CGO_ENABLED', // 启用/禁用 CGO
  'GO111MODULE', // 模块模式

  // Rust - 仅日志/调试
  'RUST_BACKTRACE', // 回溯详细程度
  'RUST_LOG', // 日志过滤

  // Node - 仅环境名（不含 NODE_OPTIONS！）
  'NODE_ENV',

  // Python - 仅行为 flag（不含 PYTHONPATH！）
  'PYTHONUNBUFFERED', // 禁用缓冲
  'PYTHONDONTWRITEBYTECODE', // 不生成 .pyc 文件

  // Pytest - 测试配置
  'PYTEST_DISABLE_PLUGIN_AUTOLOAD', // 禁用插件加载
  'PYTEST_DEBUG', // 调试输出

  // API key 和认证
  'ANTHROPIC_API_KEY', // API 认证

  // 区域和字符编码
  'LANG', // 默认 locale
  'LANGUAGE', // 语言偏好列表
  'LC_ALL', // 覆盖所有 locale 设置
  'LC_CTYPE', // 字符分类
  'LC_TIME', // 时间格式
  'CHARSET', // 字符集偏好

  // 终端和显示
  'TERM', // 终端类型
  'COLORTERM', // 彩色终端指示符
  'NO_COLOR', // 禁用彩色输出（通用标准）
  'FORCE_COLOR', // 强制彩色输出
  'TZ', // 时区

  // 各种工具的颜色配置
  'LS_COLORS', // ls 的颜色（GNU）
  'LSCOLORS', // ls 的颜色（BSD/macOS）
  'GREP_COLOR', // grep 匹配颜色（已废弃）
  'GREP_COLORS', // grep 颜色方案
  'GCC_COLORS', // GCC 诊断颜色

  // 显示格式
  'TIME_STYLE', // ls 的时间显示格式
  'BLOCK_SIZE', // du/df 的块大小
  'BLOCKSIZE', // 备用块大小
])

/**
 * ANT 专用、可安全从命令中剥离的环境变量。
 * 仅当 USER_TYPE === 'ant' 时启用。
 *
 * 安全要求：这些环境变量会在权限规则匹配之前被剥离，这意味着
 * `DOCKER_HOST=tcp://evil.com docker ps` 在剥离后会匹配 `Bash(docker ps:*)`
 * 规则。这是故意只对 ANT 启用（在第 ~380 行 gating），绝不能发布给外部用户。
 * DOCKER_HOST 会重定向 Docker 守护进程端点——剥离它会通过向权限检查隐藏
 * 网络端点来绕过基于 prefix 的权限限制。KUBECONFIG 类似地控制 kubectl
 * 与哪个集群通信。这些是为接受该风险的内部高级用户提供的便利剥离。
 *
 * 基于对 tengu_internal_bash_tool_use_permission_request 事件 30 天的分析。
 */
const ANT_ONLY_SAFE_ENV_VARS = new Set([
  // Kubernetes 和容器配置（配置文件指针，非执行）
  'KUBECONFIG', // kubectl 配置文件路径——控制 kubectl 使用哪个集群
  'DOCKER_HOST', // Docker 守护进程 socket/端点——控制 docker 与哪个守护进程通信

  // 云服务商项目/profile 选择（仅名称/标识符）
  'AWS_PROFILE', // AWS profile 名选择
  'CLOUDSDK_CORE_PROJECT', // GCP 项目 ID
  'CLUSTER', // 通用集群名

  // Anthropic 内部集群选择（仅名称/标识符）
  'COO_CLUSTER', // coo 集群名
  'COO_CLUSTER_NAME', // coo 集群名（备选）
  'COO_NAMESPACE', // coo 命名空间
  'COO_LAUNCH_YAML_DRY_RUN', // dry run 模式

  // Feature flag（仅布尔/字符串 flag）
  'SKIP_NODE_VERSION_CHECK', // 跳过版本检查
  'EXPECTTEST_ACCEPT', // 接受测试期望
  'CI', // CI 环境指示符
  'GIT_LFS_SKIP_SMUDGE', // 跳过 LFS 下载

  // GPU/设备选择（仅设备 ID）
  'CUDA_VISIBLE_DEVICES', // GPU 设备选择
  'JAX_PLATFORMS', // JAX 平台选择

  // 显示/终端设置
  'COLUMNS', // 终端宽度
  'TMUX', // TMUX socket 信息

  // 测试/调试配置
  'POSTGRESQL_VERSION', // postgres 版本字符串
  'FIRESTORE_EMULATOR_HOST', // 模拟器 host:port
  'HARNESS_QUIET', // 静默模式 flag
  'TEST_CROSSCHECK_LISTS_MATCH_UPDATE', // 测试更新 flag
  'DBT_PER_DEVELOPER_ENVIRONMENTS', // DBT 配置
  'STATSIG_FORD_DB_CHECKS', // statsig DB 检查 flag

  // 构建配置
  'ANT_ENVIRONMENT', // Anthropic 环境名
  'ANT_SERVICE', // Anthropic 服务名
  'MONOREPO_ROOT_DIR', // monorepo 根路径

  // 版本选择器
  'PYENV_VERSION', // Python 版本选择

  // 凭证（已批准子集——这些不会改变数据外泄风险）
  'PGPASSWORD', // Postgres 密码
  'GH_TOKEN', // GitHub token
  'GROWTHBOOK_API_KEY', // 自托管 growthbook
])

/**
 * 从命令中剥离整行注释。
 * 处理 Claude 在 bash 命令中加入注释的情况，例如：
 *   "# Check the logs directory\nls /home/user/logs"
 * 应被剥离为："ls /home/user/logs"
 *
 * 仅剥离整行注释（整行都是注释的行），
 * 不剥离同一行命令之后的行内注释。
 */
function stripCommentLines(command: string): string {
  const lines = command.split('\n')
  const nonCommentLines = lines.filter(line => {
    const trimmed = line.trim()
    // 保留非空且不以 # 开头的行
    return trimmed !== '' && !trimmed.startsWith('#')
  })

  // 如果所有行都是注释/空行，则返回原始命令
  if (nonCommentLines.length === 0) {
    return command
  }

  return nonCommentLines.join('\n')
}

export function stripSafeWrappers(command: string): string {
  // 安全要求：使用 [ \t]+ 而非 \s+——\s 会匹配 \n/\r，它们在 bash 中是
  // 命令分隔符。跨换行匹配会把一行的 wrapper 剥离掉，却让下一行不同的命令
  // 被 bash 执行。
  //
  // 安全要求：`(?:--[ \t]+)?` 消费 wrapper 自身的 `--`，这样
  // `nohup -- rm -- -/../foo` 会被剥离为 `rm -- -/../foo`（而不是 `-- rm ...`，
  // 后者会让 `--` 作为未知 baseCmd 跳过路径校验）。
  const SAFE_WRAPPER_PATTERNS = [
    // timeout：枚举 GNU 长 flag——无值（--foreground、
    // --preserve-status、--verbose），带值支持 =融合 和
    // 空格分隔两种形式（--kill-after=5、--kill-after 5、--signal=TERM、
    // --signal TERM）。短 flag：-v（无参）、-k/-s 支持单独或融合带值。
    // 安全要求：flag 的值使用 allowlist [A-Za-z0-9_.+-]（信号为
    // TERM/KILL/9，时长为 5/5s/10.5）。此前 [^ \t]+ 会匹配
    // $ ( ) ` | ; &——`timeout -k$(id) 10 ls` 被剥离为 `ls`，匹配
    // Bash(ls:*)，而 bash 会在 timeout 运行之前就在词分割阶段展开 $(id)。
    // 与下面已使用 allowlist 的 ENV_VAR_PATTERN 形成对比。
    /^timeout[ \t]+(?:(?:--(?:foreground|preserve-status|verbose)|--(?:kill-after|signal)=[A-Za-z0-9_.+-]+|--(?:kill-after|signal)[ \t]+[A-Za-z0-9_.+-]+|-v|-[ks][ \t]+[A-Za-z0-9_.+-]+|-[ks][A-Za-z0-9_.+-]+)[ \t]+)*(?:--[ \t]+)?\d+(?:\.\d+)?[smhd]?[ \t]+/,
    /^time[ \t]+(?:--[ \t]+)?/,
    // 安全要求：与 checkSemantics 的 wrapper 剥离（ast.ts
    // ~:1990-2080）以及 stripWrappersFromArgv（pathValidation.ts ~:1260）保持同步。
    // 此前该模式要求 `-n N`；checkSemantics 已处理裸 `nice` 和旧版 `-N`。
    // 这种不对称意味着 checkSemantics 会把被包装的命令暴露给语义检查，
    // 但 deny-rule 匹配和 cd+git 闸门看到的却是 wrapper 名。带 Bash(rm:*) deny 的
    // `nice rm -rf /` 变成 ask 而不是 deny；`cd evil && nice git status` 会跳过
    // 裸仓库 RCE 闸门。PR #21503 修复了 stripWrappersFromArgv；此处被遗漏。
    // 现在匹配：`nice cmd`、`nice -n N cmd`、`nice -N cmd`（所有
    // checkSemantics 会剥离的形式）。
    /^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+(?:--[ \t]+)?/,
    // stdbuf：仅融合短 flag（-o0、-eL）。checkSemantics 处理更多
    //（空格分隔、长 --output=MODE），但上面我们对那些情况 fail-closed，
    // 所以这里不过度剥离是安全的。主要需求：`stdbuf -o0 cmd`。
    /^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+(?:--[ \t]+)?/,
    /^nohup[ \t]+(?:--[ \t]+)?/,
  ] as const

  // 环境变量模式：
  // ^([A-Za-z_][A-Za-z0-9_]*)  - 变量名（标准标识符）
  // =                           - 等号
  // ([A-Za-z0-9_./:-]+)         - 值：仅字母数字 + 安全标点
  // [ \t]+                      - 值之后必须的水平空白
  //
  // 安全要求：仅匹配带安全字符的非引号值（不含 $()、`、$var、;|&）。
  //
  // 安全要求：尾随空白必须是 [ \t]+（仅水平），而不是 \s+。
  // \s 会匹配 \n/\r。如果 reconstructCommand 在
  // `TZ=UTC` 和 `echo` 之间输出一个未加引号的换行，\s+ 会跨行匹配并剥离
  // `TZ=UTC<NL>`，剩下 `echo curl evil.com` 去匹配 Bash(echo:*)。但 bash 会把
  // 换行视为命令分隔符。与 needsQuoting 修复形成纵深防御。
  const ENV_VAR_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:-]+)[ \t]+/

  let stripped = command
  let previousStripped = ''

  // 阶段 1：仅剥离开头的环境变量和注释。
  // 在 bash 中，命令前的环境变量赋值（VAR=val cmd）是真正的
  // shell 级别赋值。这些可以安全地剥离以用于权限匹配。
  while (stripped !== previousStripped) {
    previousStripped = stripped
    stripped = stripCommentLines(stripped)

    const envVarMatch = stripped.match(ENV_VAR_PATTERN)
    if (envVarMatch) {
      const varName = envVarMatch[1]!
      const isAntOnlySafe =
        process.env.USER_TYPE === 'ant' && ANT_ONLY_SAFE_ENV_VARS.has(varName)
      if (SAFE_ENV_VARS.has(varName) || isAntOnlySafe) {
        stripped = stripped.replace(ENV_VAR_PATTERN, '')
      }
    }
  }

  // 阶段 2：仅剥离 wrapper 命令和注释。不要剥离环境变量。
  // wrapper 命令（timeout、time、nice、nohup）使用 execvp 运行其
  // 参数，因此 wrapper 之后的 VAR=val 会被当作要执行的命令，
  // 而不是环境变量赋值。在此剥离环境变量会造成解析器所见与实际执行内容
  // 不一致。（HackerOne #3543050）
  previousStripped = ''
  while (stripped !== previousStripped) {
    previousStripped = stripped
    stripped = stripCommentLines(stripped)

    for (const pattern of SAFE_WRAPPER_PATTERNS) {
      stripped = stripped.replace(pattern, '')
    }
  }

  return stripped.trim()
}

// 安全要求：timeout flag 值的 allowlist（信号为 TERM/KILL/9，
// 时长为 5/5s/10.5）。拒绝 $ ( ) ` | ; & 和换行符，
// 它们此前通过 [^ \t]+ 被匹配——`timeout -k$(id) 10 ls` 绝不能被剥离。
const TIMEOUT_FLAG_VALUE_RE = /^[A-Za-z0-9_.+-]+$/

/**
 * 解析 timeout 的 GNU flag（长 + 短、融合 + 空格分隔），并
 * 返回 DURATION token 的 argv 索引；若 flag 无法解析则返回 -1。
 * 枚举：--foreground/--preserve-status/--verbose（无值）、
 * --kill-after/--signal（带值，=融合 与 空格分隔 都支持）、-v（无
 * 值）、-k/-s（带值，融合 与 空格分隔 都支持）。
 *
 * 从 stripWrappersFromArgv 中抽出，以使 bashToolHasPermission 保持在
 * Bun 的 feature() DCE 复杂度阈值之下——内联它会破坏
 * 分类器测试中 feature('BASH_CLASSIFIER') 的求值。
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
    } // 选项结束标记
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
 * stripSafeWrappers 的 argv 级别对应实现。从 AST 派生的 argv 中剥离相同的
 * wrapper 命令（timeout、time、nice、nohup）。环境变量已经被分离到
 * SimpleCommand.envVars 中，因此无需剥离环境变量。
 *
 * 与上面的 SAFE_WRAPPER_PATTERNS 保持同步——如果你在那里添加 wrapper，
 * 也要在这里添加。
 */
export function stripWrappersFromArgv(argv: string[]): string[] {
  // 安全要求：消费 wrapper 选项之后可选的 `--`，与 wrapper 自身行为一致。
  // 否则 `['nohup','--','rm','--','-/../foo']` 会把 `--` 当作 baseCmd 并
  // 跳过路径校验。参见 SAFE_WRAPPER_PATTERNS 注释。
  let a = argv
  for (;;) {
    if (a[0] === 'time' || a[0] === 'nohup') {
      a = a.slice(a[1] === '--' ? 2 : 1)
    } else if (a[0] === 'timeout') {
      const i = skipTimeoutFlags(a)
      if (i < 0 || !a[i] || !/^\d+(?:\.\d+)?[smhd]?$/.test(a[i]!)) return a
      a = a.slice(i + 1)
    } else if (
      a[0] === 'nice' &&
      a[1] === '-n' &&
      a[2] &&
      /^-?\d+$/.test(a[2])
    ) {
      a = a.slice(a[3] === '--' ? 4 : 3)
    } else {
      return a
    }
  }
}

/**
 * 会使*不同的二进制*运行的环境变量（注入或解析劫持）。
 * 仅是启发式判断——export-&& 形式会绕过此检查，且 excludedCommands
 * 本身也不是安全边界。
 */
export const BINARY_HIJACK_VARS = /^(LD_|DYLD_|PATH$)/

/**
 * 从命令中剥离所有开头环境变量 prefix，无论变量名是否在安全列表中。
 *
 * 用于 deny/ask 规则匹配：当用户拒绝 `claude` 或 `rm` 时，即使命令带有
 * 任意环境变量前缀如 `FOO=bar claude`，也应保持阻止。stripSafeWrappers
 * 中的安全列表限制对 allow 规则是正确的（防止 `DOCKER_HOST=evil docker ps`
 * 自动匹配 `Bash(docker ps:*)`），但 deny 规则必须更难被绕过。
 *
 * 也用于 sandbox.excludedCommands 匹配（不是安全边界——
 * 权限提示才是），并以 BINARY_HIJACK_VARS 作为 blocklist。
 *
 * 安全要求：使用比 stripSafeWrappers 更宽的值模式。该值
 * 模式仅排除真正的 shell 注入字符（$、反引号、;、|
 * &、括号、重定向、引号、反斜杠）和空白。诸如
 * =、+、@、~、, 之类的字符在未加引号的环境变量赋值位置是无害的，必须
 * 被匹配，以防诸如 `FOO=a=b denied_command` 的简单绕过。
 *
 * @param blocklist - 可选的 regex，针对每个变量名进行测试；匹配的变量
 *   不会被剥离（剥离在此停止）。deny 规则请省略；excludedCommands 请传入
 *   BINARY_HIJACK_VARS。
 */
export function stripAllLeadingEnvVars(
  command: string,
  blocklist?: RegExp,
): string {
  // 用于 deny-rule 剥离的更宽值模式。处理：
  //
  // - 标准赋值（FOO=bar）、追加（FOO+=bar）、数组（FOO[0]=bar）
  // - 单引号值：'[^'\n\r]*'——bash 抑制所有展开
  // - 带反斜杠转义的双引号值："(?:\\.|[^"$`\\\n\r])*"
  //   在 bash 双引号中，只有 \$、\`、\"、\\ 和 \newline 是特殊的。
  //   其他 \x 序列是无害的，所以我们在双引号内允许 \.。
  //   我们仍然排除原始 $ 和 `（不带反斜杠）以阻止展开。
  // - 未加引号的值：排除 shell 元字符，允许反斜杠转义
  // - 拼接段：FOO='x'y"z"——bash 会拼接相邻段
  //
  // 安全要求：尾随空白必须是 [ \t]+（仅水平），而不是 \s+。
  //
  // 外层 * 每次迭代匹配一个原子单元：一个完整的引号字符串、
  // 一个反斜杠转义对，或一个未加引号的安全字符。
  // 内层双引号分支 (?:...|...)* 受结束 " 限制，
  // 因此它不会与外层 * 产生回溯交互。
  //
  // 注意：$ 被从未加引号/双引号值字符类中排除，以阻止
  // 诸如 $(cmd)、${var} 和 $((expr)) 的危险形式。这意味着
  // FOO=$VAR 不会被剥离——添加 $VAR 匹配会产生 ReDoS 风险
  //（CodeQL #671），且 $VAR 绕过优先级较低。
  const ENV_VAR_PATTERN =
    /^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?)\+?=(?:'[^'\n\r]*'|"(?:\\.|[^"$`\\\n\r])*"|\\.|[^ \t\n\r$`;|&()<>\\\\'"])*[ \t]+/

  let stripped = command
  let previousStripped = ''

  while (stripped !== previousStripped) {
    previousStripped = stripped
    stripped = stripCommentLines(stripped)

    const m = stripped.match(ENV_VAR_PATTERN)
    if (!m) continue
    if (blocklist?.test(m[1]!)) break
    stripped = stripped.slice(m[0].length)
  }

  return stripped.trim()
}

function filterRulesByContentsMatchingInput(
  input: z.infer<typeof BashTool.inputSchema>,
  rules: Map<string, PermissionRule>,
  matchMode: 'exact' | 'prefix',
  {
    stripAllEnvVars = false,
    skipCompoundCheck = false,
  }: { stripAllEnvVars?: boolean; skipCompoundCheck?: boolean } = {},
): PermissionRule[] {
  const command = input.command.trim()

  // 为权限匹配剥离输出重定向
  // 这让 Bash(python:*) 之类的规则能匹配 "python script.py > output.txt"
  // 重定向目标的安全校验在 checkPathConstraints 中单独进行
  const commandWithoutRedirections =
    extractOutputRedirections(command).commandWithoutRedirections

  // 精确匹配时同时尝试原始命令（保留引号）和剥离重定向的命令
  //（让不含重定向的规则也能匹配）；prefix 匹配只用剥离重定向后的命令
  const commandsForMatching =
    matchMode === 'exact'
      ? [command, commandWithoutRedirections]
      : [commandWithoutRedirections]

  // 为匹配剥离安全的 wrapper 命令（timeout、time、nice、nohup）和环境变量
  // 这让 Bash(npm install:*) 之类的规则能匹配 "timeout 10 npm install foo"
  // 或 "GOOS=linux go build"
  const commandsToTry = commandsForMatching.flatMap(cmd => {
    const strippedCommand = stripSafeWrappers(cmd)
    return strippedCommand !== cmd ? [cmd, strippedCommand] : [cmd]
  })

  // 安全要求：对 deny/ask 规则，也尝试在剥离所有开头环境变量 prefix 之后再匹配。
  // 这能防止通过 `FOO=bar denied_command` 绕过——这里
  // FOO 不在安全列表中。stripSafeWrappers 中的安全列表限制对 allow 规则是
  // 有意为之的（见 HackerOne #3543050），但 deny 规则必须更难被绕过——
  // 被拒绝的命令无论带什么环境变量前缀都应保持拒绝。
  //
  // 我们对所有候选命令迭代地应用两种剥离操作，直到不再产生新候选
  //（不动点）。这能处理交错模式，例如 `nohup FOO=bar timeout 5 claude`：
  //   1. stripSafeWrappers 剥离 `nohup` → `FOO=bar timeout 5 claude`
  //   2. stripAllLeadingEnvVars 剥离 `FOO=bar` → `timeout 5 claude`
  //   3. stripSafeWrappers 剥离 `timeout 5` → `claude`（deny 命中）
  //
  // 不迭代的话，单遍组合会漏掉多层交错。
  if (stripAllEnvVars) {
    const seen = new Set(commandsToTry)
    let startIdx = 0

    // 迭代直到不再产生新候选（不动点）
    while (startIdx < commandsToTry.length) {
      const endIdx = commandsToTry.length
      for (let i = startIdx; i < endIdx; i++) {
        const cmd = commandsToTry[i]
        if (!cmd) {
          continue
        }
        // 尝试剥离环境变量
        const envStripped = stripAllLeadingEnvVars(cmd)
        if (!seen.has(envStripped)) {
          commandsToTry.push(envStripped)
          seen.add(envStripped)
        }
        // 尝试剥离安全 wrapper
        const wrapperStripped = stripSafeWrappers(cmd)
        if (!seen.has(wrapperStripped)) {
          commandsToTry.push(wrapperStripped)
          seen.add(wrapperStripped)
        }
      }
      startIdx = endIdx
    }
  }

  // 为每个候选预计算复合命令状态，避免在规则过滤循环内重复解析
  //（否则 splitCommand 调用数会随 rules.length × commandsToTry.length 增长）。
  // 复合检查仅适用于 'prefix' 模式下的 prefix/wildcard 匹配，且只对 allow 规则生效。
  // 安全要求：deny/ask 规则必须能匹配复合命令，以防通过把被拒命令包进复合表达式来绕过。
  const isCompoundCommand = new Map<string, boolean>()
  if (matchMode === 'prefix' && !skipCompoundCheck) {
    for (const cmd of commandsToTry) {
      if (!isCompoundCommand.has(cmd)) {
        isCompoundCommand.set(cmd, splitCommand(cmd).length > 1)
      }
    }
  }

  return Array.from(rules.entries())
    .filter(([ruleContent]) => {
      const bashRule = bashPermissionRule(ruleContent)

      return commandsToTry.some(cmdToMatch => {
        switch (bashRule.type) {
          case 'exact':
            return bashRule.command === cmdToMatch
          case 'prefix':
            switch (matchMode) {
              // 在 'exact' 模式下，仅当命令与 prefix 规则精确匹配时才返回 true
              case 'exact':
                return bashRule.prefix === cmdToMatch
              case 'prefix': {
                // 安全要求：不允许 prefix 规则匹配复合命令。
                // 例如 Bash(cd:*) 不能匹配 "cd /path && python3 evil.py"。
                // 正常流程中命令在到达这里之前已经拆分过，但 shell 转义可能
                // 让第一遍 splitCommand 失效——例如
                //   cd src\&\& python3 hello.py  →  splitCommand  →  ["cd src&& python3 hello.py"]
                // 这看起来像是一个以 "cd " 开头的单条命令。
                // 在这里重新拆分候选可以捕获这些情况。
                if (isCompoundCommand.get(cmdToMatch)) {
                  return false
                }
                // 确保词边界：prefix 后必须跟空格或字符串结尾
                // 这防止 "ls:*" 匹配到 "lsof" 或 "lsattr"
                if (cmdToMatch === bashRule.prefix) {
                  return true
                }
                if (cmdToMatch.startsWith(bashRule.prefix + ' ')) {
                  return true
                }
                // 同时匹配不带任何 flag 的裸 "xargs <prefix>"。
                // 这让 Bash(grep:*) 能匹配 "xargs grep pattern"，
                // 也让 Bash(rm:*) 之类的 deny 规则能拦截 "xargs rm file"。
                // 天然词边界："xargs -n1 grep" 不以
                // "xargs grep " 开头，因此带 flag 的 xargs 调用不会被匹配。
                const xargsPrefix = 'xargs ' + bashRule.prefix
                if (cmdToMatch === xargsPrefix) {
                  return true
                }
                return cmdToMatch.startsWith(xargsPrefix + ' ')
              }
            }
            break
          case 'wildcard':
            // 安全修复：在精确匹配模式下，通配符绝不能匹配，因为我们
            // 检查的是未解析的完整命令。对未解析命令进行通配符匹配会让
            // "foo *" 匹配到 "foo arg && curl evil.com"，因为 .* 能匹配操作符。
            // 通配符只能在拆分成单个子命令之后匹配。
            if (matchMode === 'exact') {
              return false
            }
            // 安全要求：与 prefix 规则相同，不允许 prefix 模式下的通配符规则
            // 匹配复合命令。例如 Bash(cd *) 绝不能匹配
            // "cd /path && python3 evil.py"，即使 "cd *" 模式本身能匹配它。
            if (isCompoundCommand.get(cmdToMatch)) {
              return false
            }
            // 在 prefix 模式下（拆分之后），通配符可以安全地匹配子命令
            return matchWildcardPattern(bashRule.pattern, cmdToMatch)
        }
      })
    })
    .map(([, rule]) => rule)
}

function matchingRulesForInput(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
  matchMode: 'exact' | 'prefix',
  { skipCompoundCheck = false }: { skipCompoundCheck?: boolean } = {},
) {
  const denyRuleByContents = getRuleByContentsForTool(
    toolPermissionContext,
    BashTool,
    'deny',
  )
  // 安全要求：Deny/ask 规则使用激进的环境变量剥离，确保
  // `FOO=bar denied_command` 仍然能匹配针对 `denied_command` 的 deny 规则。
  const matchingDenyRules = filterRulesByContentsMatchingInput(
    input,
    denyRuleByContents,
    matchMode,
    { stripAllEnvVars: true, skipCompoundCheck: true },
  )

  const askRuleByContents = getRuleByContentsForTool(
    toolPermissionContext,
    BashTool,
    'ask',
  )
  const matchingAskRules = filterRulesByContentsMatchingInput(
    input,
    askRuleByContents,
    matchMode,
    { stripAllEnvVars: true, skipCompoundCheck: true },
  )

  const allowRuleByContents = getRuleByContentsForTool(
    toolPermissionContext,
    BashTool,
    'allow',
  )
  const matchingAllowRules = filterRulesByContentsMatchingInput(
    input,
    allowRuleByContents,
    matchMode,
    { skipCompoundCheck },
  )

  return {
    matchingDenyRules,
    matchingAskRules,
    matchingAllowRules,
  }
}

/**
 * 检查子命令是否与某条权限规则精确匹配
 */
export const bashToolCheckExactMatchPermission = (
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult => {
  const command = input.command.trim()
  const { matchingDenyRules, matchingAskRules, matchingAllowRules } =
    matchingRulesForInput(input, toolPermissionContext, 'exact')

  // 1. 若精确命令被 deny 则拒绝
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${command} has been denied.`,
      decisionReason: {
        type: 'rule',
        rule: matchingDenyRules[0],
      },
    }
  }

  // 2. 若精确命令在 ask 规则中则需询问
  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name),
      decisionReason: {
        type: 'rule',
        rule: matchingAskRules[0],
      },
    }
  }

  // 3. 若精确命令被 allow 则放行
  if (matchingAllowRules[0] !== undefined) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: matchingAllowRules[0],
      },
    }
  }

  // 4. 否则 passthrough
  const decisionReason = {
    type: 'other' as const,
    reason: 'This command requires approval',
  }
  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    decisionReason,
    // 建议精确匹配规则给用户
    // 这里可能被 `checkCommandAndSuggestRules()` 中的 prefix 建议覆盖
    suggestions: suggestionForExactCommand(command),
  }
}

export const bashToolCheckPermission = (
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
  astCommand?: SimpleCommand,
): PermissionResult => {
  const command = input.command.trim()

  // 1. 先检查精确匹配
  const exactMatchResult = bashToolCheckExactMatchPermission(
    input,
    toolPermissionContext,
  )

  // 1a. 若精确命令有规则则 deny/ask
  if (
    exactMatchResult.behavior === 'deny' ||
    exactMatchResult.behavior === 'ask'
  ) {
    return exactMatchResult
  }

  // 2. 查找所有匹配的规则（prefix 或精确）
  // 安全修复：在路径约束之前检查 Bash deny/ask 规则，以防通过项目目录之外的
  // 绝对路径绕过（HackerOne 报告）
  // 经 AST 解析后，子命令已是原子单元——跳过旧版 splitCommand 复检，
  // 后者会把词中 # 误判为复合命令分隔符。
  const { matchingDenyRules, matchingAskRules, matchingAllowRules } =
    matchingRulesForInput(input, toolPermissionContext, 'prefix', {
      skipCompoundCheck: astCommand !== undefined,
    })

  // 2a. 命令有 deny 规则则拒绝
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${command} has been denied.`,
      decisionReason: {
        type: 'rule',
        rule: matchingDenyRules[0],
      },
    }
  }

  // 2b. 命令有 ask 规则则需询问
  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name),
      decisionReason: {
        type: 'rule',
        rule: matchingAskRules[0],
      },
    }
  }

  // 3. 检查路径约束
  // 此检查在 deny/ask 规则之后，以便显式规则优先。
  // 安全要求：当此子命令有 AST 派生的 argv 时，直接透传，
  // 让 checkPathConstraints 直接使用它而不是再用 shell-quote 解析
  //（后者存在单引号反斜杠 bug，会导致 parseCommandArguments 返回 []
  // 并静默跳过路径校验）。
  const pathResult = checkPathConstraints(
    input,
    getCwd(),
    toolPermissionContext,
    compoundCommandHasCd,
    astCommand?.redirects,
    astCommand ? [astCommand] : undefined,
  )
  if (pathResult.behavior !== 'passthrough') {
    return pathResult
  }

  // 4. 精确匹配为 allow 时放行
  if (exactMatchResult.behavior === 'allow') {
    return exactMatchResult
  }

  // 5. 命令有 allow 规则则放行
  if (matchingAllowRules[0] !== undefined) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: matchingAllowRules[0],
      },
    }
  }

  // 5b. 检查 sed 约束（在 mode 自动放行前拦截危险的 sed 操作）
  const sedConstraintResult = checkSedConstraints(input, toolPermissionContext)
  if (sedConstraintResult.behavior !== 'passthrough') {
    return sedConstraintResult
  }

  // 6. 检查 mode 专属权限处理
  const modeResult = checkPermissionMode(input, toolPermissionContext)
  if (modeResult.behavior !== 'passthrough') {
    return modeResult
  }

  // 7. 检查只读规则
  if (BashTool.isReadOnly(input)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Read-only command is allowed',
      },
    }
  }

  // 8. 无规则命中则 passthrough，会触发权限提示
  const decisionReason = {
    type: 'other' as const,
    reason: 'This command requires approval',
  }
  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    decisionReason,
    // 建议精确匹配规则给用户
    // 这里可能被 `checkCommandAndSuggestRules()` 中的 prefix 建议覆盖
    suggestions: suggestionForExactCommand(command),
  }
}

/**
 * 处理单个子命令并应用 prefix 检查与建议
 */
export async function checkCommandAndSuggestRules(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
  commandPrefixResult: CommandPrefixResult | null | undefined,
  compoundCommandHasCd?: boolean,
  astParseSucceeded?: boolean,
): Promise<PermissionResult> {
  // 1. 先检查精确匹配
  const exactMatchResult = bashToolCheckExactMatchPermission(
    input,
    toolPermissionContext,
  )
  if (exactMatchResult.behavior !== 'passthrough') {
    return exactMatchResult
  }

  // 2. 检查命令 prefix
  const permissionResult = bashToolCheckPermission(
    input,
    toolPermissionContext,
    compoundCommandHasCd,
  )
  // 2a. 命令被显式 deny/ask 时返回
  if (
    permissionResult.behavior === 'deny' ||
    permissionResult.behavior === 'ask'
  ) {
    return permissionResult
  }

  // 3. 若检测到命令注入则需询问。当 AST 解析已成功时跳过——
  // tree-sitter 已验证不存在隐藏替换或结构性把戏，因此旧版基于 regex 的
  // 校验器（反斜杠转义操作符等）只会增加误报。
  if (
    !astParseSucceeded &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK)
  ) {
    const safetyResult = await bashCommandIsSafeAsync(input.command)

    if (safetyResult.behavior !== 'passthrough') {
      const decisionReason: PermissionDecisionReason = {
        type: 'other' as const,
        reason:
          safetyResult.behavior === 'ask' && safetyResult.message
            ? safetyResult.message
            : 'This command contains patterns that could pose security risks and requires approval',
      }

      return {
        behavior: 'ask',
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
        decisionReason,
        suggestions: [], // 不建议保存可能危险的命令
      }
    }
  }

  // 4. 命令被 allow 时放行
  if (permissionResult.behavior === 'allow') {
    return permissionResult
  }

  // 5. 有 prefix 时建议 prefix，否则建议精确命令
  const suggestedUpdates = commandPrefixResult?.commandPrefix
    ? suggestionForPrefix(commandPrefixResult.commandPrefix)
    : suggestionForExactCommand(input.command)

  return {
    ...permissionResult,
    suggestions: suggestedUpdates,
  }
}

/**
 * 检查命令在沙箱环境下是否应被自动放行。
 * 若存在应被尊重的显式 deny/ask 规则，则提前返回。
 *
 * 注意：此函数仅在沙箱和 auto-allow 都启用时才应被调用。
 *
 * @param input - bash 工具输入
 * @param toolPermissionContext - 权限上下文
 * @returns PermissionResult，取值为：
 *   - 存在显式规则（精确或 prefix）时返回 deny/ask
 *   - 无显式规则时返回 allow（沙箱 auto-apply 生效）
 *   - 由于处于 auto-allow 模式，不应返回 passthrough
 */
function checkSandboxAutoAllow(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const command = input.command.trim()

  // 检查针对完整命令的显式 deny/ask 规则（精确 + prefix）
  const { matchingDenyRules, matchingAskRules } = matchingRulesForInput(
    input,
    toolPermissionContext,
    'prefix',
  )

  // 完整命令存在显式 deny 规则时立即返回
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${command} has been denied.`,
      decisionReason: {
        type: 'rule',
        rule: matchingDenyRules[0],
      },
    }
  }

  // 安全要求：对复合命令，逐个检查每个子命令是否命中 deny/ask 规则。
  // Bash(rm:*) 之类的 prefix 规则不会匹配完整复合命令
  //（例如 "echo hello && rm -rf /" 不以 "rm" 开头），因此必须逐个检查。
  // 重要：子命令 deny 检查必须在完整命令 ask 返回之前运行。
  // 否则匹配完整命令的通配符 ask 规则（例如 Bash(*echo*)）会在子命令
  //（例如 Bash(rm:*)）的 prefix deny 规则被检查之前返回 'ask'，
  // 把 deny 降级为 ask。
  const subcommands = splitCommand(command)
  if (subcommands.length > 1) {
    let firstAskRule: PermissionRule | undefined
    for (const sub of subcommands) {
      const subResult = matchingRulesForInput(
        { command: sub },
        toolPermissionContext,
        'prefix',
      )
      // Deny 优先——立即返回
      if (subResult.matchingDenyRules[0] !== undefined) {
        return {
          behavior: 'deny',
          message: `Permission to use ${BashTool.name} with command ${command} has been denied.`,
          decisionReason: {
            type: 'rule',
            rule: subResult.matchingDenyRules[0],
          },
        }
      }
      // 暂存第一个 ask 命中；先不返回（所有子命令的 deny 优先级更高）
      firstAskRule ??= subResult.matchingAskRules[0]
    }
    if (firstAskRule) {
      return {
        behavior: 'ask',
        message: createPermissionRequestMessage(BashTool.name),
        decisionReason: {
          type: 'rule',
          rule: firstAskRule,
        },
      }
    }
  }

  // 完整命令 ask 检查（在所有 deny 来源都已用尽之后）
  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name),
      decisionReason: {
        type: 'rule',
        rule: matchingAskRules[0],
      },
    }
  }
  // 无显式规则，因此沙箱下自动放行

  return {
    behavior: 'allow',
    updatedInput: input,
    decisionReason: {
      type: 'other',
      reason: 'Auto-allowed with sandbox (autoAllowBashIfSandboxed enabled)',
    },
  }
}

/**
 * 过滤掉 `cd ${cwd}` prefix 子命令，保持 astCommands 对齐。
 * 抽出为独立函数是为了让 bashToolHasPermission 保持在 Bun 的 feature() DCE
 * 复杂度阈值之下——内联它会破坏约 10 个分类器测试中 pendingClassifierCheck
 * 的挂载。
 */
function filterCdCwdSubcommands(
  rawSubcommands: string[],
  astCommands: SimpleCommand[] | undefined,
  cwd: string,
  cwdMingw: string,
): { subcommands: string[]; astCommandsByIdx: (SimpleCommand | undefined)[] } {
  const subcommands: string[] = []
  const astCommandsByIdx: (SimpleCommand | undefined)[] = []
  for (let i = 0; i < rawSubcommands.length; i++) {
    const cmd = rawSubcommands[i]!
    if (cmd === `cd ${cwd}` || cmd === `cd ${cwdMingw}`) continue
    subcommands.push(cmd)
    astCommandsByIdx.push(astCommands?.[i])
  }
  return { subcommands, astCommandsByIdx }
}

/**
 * 用于 AST too-complex 和 checkSemantics 路径的提前退出 deny 执行。
 * 若精确匹配结果非 passthrough（deny/ask/allow）则直接返回，
 * 然后检查 prefix/wildcard deny 规则。若两者都未命中则返回 null，
 * 表示调用方应继续落到 ask。抽出为独立函数是为了让
 * bashToolHasPermission 保持在 Bun 的 feature() DCE 复杂度阈值之下。
 */
function checkEarlyExitDeny(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult | null {
  const exactMatchResult = bashToolCheckExactMatchPermission(
    input,
    toolPermissionContext,
  )
  if (exactMatchResult.behavior !== 'passthrough') {
    return exactMatchResult
  }
  const denyMatch = matchingRulesForInput(
    input,
    toolPermissionContext,
    'prefix',
  ).matchingDenyRules[0]
  if (denyMatch !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${input.command} has been denied.`,
      decisionReason: { type: 'rule', rule: denyMatch },
    }
  }
  return null
}

/**
 * checkSemantics 路径的 deny 执行。先调用 checkEarlyExitDeny（精确匹配
 * + 完整命令 prefix deny），再逐个检查每个 SimpleCommand 的 .text 文本段
 * 是否命中 prefix deny 规则。逐子命令检查是必要的，因为
 * filterRulesByContentsMatchingInput 有复合命令守卫
 *（splitCommand().length > 1 → prefix 规则返回 false），会使 `Bash(eval:*)`
 * 无法匹配 `echo foo | eval rm` 这类完整管道。每个 SimpleCommand 文本段
 * 是单条命令，因此守卫不会触发。
 *
 * 独立为辅助函数（不合并进 checkEarlyExitDeny 或内联到调用点）是因为
 * bashToolHasPermission 已紧贴 Bun 的 feature() DCE 复杂度阈值——
 * 在那里多加约 5 行就会破坏 feature('BASH_CLASSIFIER') 求值并丢弃
 * pendingClassifierCheck。
 */
function checkSemanticsDeny(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
  commands: readonly { text: string }[],
): PermissionResult | null {
  const fullCmd = checkEarlyExitDeny(input, toolPermissionContext)
  if (fullCmd !== null) return fullCmd
  for (const cmd of commands) {
    const subDeny = matchingRulesForInput(
      { ...input, command: cmd.text },
      toolPermissionContext,
      'prefix',
    ).matchingDenyRules[0]
    if (subDeny !== undefined) {
      return {
        behavior: 'deny',
        message: `Permission to use ${BashTool.name} with command ${input.command} has been denied.`,
        decisionReason: { type: 'rule', rule: subDeny },
      }
    }
  }
  return null
}

/**
 * 当分类器已启用且存在 allow 描述时，构建待处理的分类器检查元数据。
 * 若分类器被禁用、处于 auto 模式或无 allow 描述，则返回 undefined。
 */
function buildPendingClassifierCheck(
  command: string,
  toolPermissionContext: ToolPermissionContext,
): { command: string; cwd: string; descriptions: string[] } | undefined {
  if (!isClassifierPermissionsEnabled()) {
    return undefined
  }
  // 在 auto 模式下跳过——auto 模式分类器会处理所有权限决策
  if (feature('TRANSCRIPT_CLASSIFIER') && toolPermissionContext.mode === 'auto')
    return undefined
  if (toolPermissionContext.mode === 'bypassPermissions') return undefined

  const allowDescriptions = getBashPromptAllowDescriptions(
    toolPermissionContext,
  )
  if (allowDescriptions.length === 0) return undefined

  return {
    command,
    cwd: getCwd(),
    descriptions: allowDescriptions,
  }
}

const speculativeChecks = new Map<string, Promise<ClassifierResult>>()

/**
 * 提前启动投机式 bash allow 分类器检查，使其与 pre-tool hooks、
 * deny/ask 分类器以及权限对话框的初始化并行运行。
 * 结果随后可通过 executeAsyncClassifierCheck 经
 * consumeSpeculativeClassifierCheck 消费。
 */
export function peekSpeculativeClassifierCheck(
  command: string,
): Promise<ClassifierResult> | undefined {
  return speculativeChecks.get(command)
}

export function startSpeculativeClassifierCheck(
  command: string,
  toolPermissionContext: ToolPermissionContext,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
): boolean {
  // 与 buildPendingClassifierCheck 相同的守卫
  if (!isClassifierPermissionsEnabled()) return false
  if (feature('TRANSCRIPT_CLASSIFIER') && toolPermissionContext.mode === 'auto')
    return false
  if (toolPermissionContext.mode === 'bypassPermissions') return false
  const allowDescriptions = getBashPromptAllowDescriptions(
    toolPermissionContext,
  )
  if (allowDescriptions.length === 0) return false

  const cwd = getCwd()
  const promise = classifyBashCommand(
    command,
    cwd,
    allowDescriptions,
    'allow',
    signal,
    isNonInteractiveSession,
  )
  // 防止在 promise 被消费之前 signal 中止时产生未处理拒绝。
  // 原始 promise（可能 reject）仍保存在 Map 中供消费方 await。
  promise.catch(() => {})
  speculativeChecks.set(command, promise)
  return true
}

/**
 * 消费给定命令的投机式分类器检查结果。
 * 若存在则返回对应 promise（并从 map 中移除），否则返回 undefined。
 */
export function consumeSpeculativeClassifierCheck(
  command: string,
): Promise<ClassifierResult> | undefined {
  const promise = speculativeChecks.get(command)
  if (promise) {
    speculativeChecks.delete(command)
  }
  return promise
}

export function clearSpeculativeChecks(): void {
  speculativeChecks.clear()
}

/**
 * 等待一个待处理的分类器检查，若为高置信度 allow 则返回
 * PermissionDecisionReason，否则返回 undefined。
 *
 * 被 swarm agents（tmux 和进程内）用于门控权限转发：
 * 先运行分类器，仅当分类器未自动批准时才上报给 leader。
 */
export async function awaitClassifierAutoApproval(
  pendingCheck: PendingClassifierCheck,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
): Promise<PermissionDecisionReason | undefined> {
  const { command, cwd, descriptions } = pendingCheck
  const speculativeResult = consumeSpeculativeClassifierCheck(command)
  const classifierResult = speculativeResult
    ? await speculativeResult
    : await classifyBashCommand(
        command,
        cwd,
        descriptions,
        'allow',
        signal,
        isNonInteractiveSession,
      )

  logClassifierResultForAnts(command, 'allow', descriptions, classifierResult)

  if (
    feature('BASH_CLASSIFIER') &&
    classifierResult.matches &&
    classifierResult.confidence === 'high'
  ) {
    return {
      type: 'classifier',
      classifier: 'bash_allow',
      reason: `Allowed by prompt rule: "${classifierResult.matchedDescription}"`,
    }
  }
  return undefined
}

type AsyncClassifierCheckCallbacks = {
  shouldContinue: () => boolean
  onAllow: (decisionReason: PermissionDecisionReason) => void
  onComplete?: () => void
}

/**
 * 异步执行 bash allow 分类器检查。
 * 此函数在权限提示显示时于后台运行。
 * 若分类器以高置信度 allow 且用户尚未交互，则自动批准。
 *
 * @param pendingCheck - 来自 bashToolHasPermission 的分类器检查元数据
 * @param signal - 中止 signal
 * @param isNonInteractiveSession - 是否为非交互会话
 * @param callbacks - 用于检查是否应继续并处理批准的回调
 */
export async function executeAsyncClassifierCheck(
  pendingCheck: { command: string; cwd: string; descriptions: string[] },
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
  callbacks: AsyncClassifierCheckCallbacks,
): Promise<void> {
  const { command, cwd, descriptions } = pendingCheck
  const speculativeResult = consumeSpeculativeClassifierCheck(command)

  let classifierResult: ClassifierResult
  try {
    classifierResult = speculativeResult
      ? await speculativeResult
      : await classifyBashCommand(
          command,
          cwd,
          descriptions,
          'allow',
          signal,
          isNonInteractiveSession,
        )
  } catch (error: unknown) {
    // 当 coordinator 会话被取消时，abort signal 触发，
    // 分类器 API 调用会以 APIUserAbortError reject。这是预期行为，
    // 不应作为未处理 promise 拒绝冒泡。
    if (error instanceof APIUserAbortError || error instanceof AbortError) {
      callbacks.onComplete?.()
      return
    }
    callbacks.onComplete?.()
    throw error
  }

  logClassifierResultForAnts(command, 'allow', descriptions, classifierResult)

  // 若用户已做出决策或已与权限对话框交互（方向键、tab、输入等），则不自动批准
  if (!callbacks.shouldContinue()) return

  if (
    feature('BASH_CLASSIFIER') &&
    classifierResult.matches &&
    classifierResult.confidence === 'high'
  ) {
    callbacks.onAllow({
      type: 'classifier',
      classifier: 'bash_allow',
      reason: `Allowed by prompt rule: "${classifierResult.matchedDescription}"`,
    })
  } else {
    // 无命中——通知调用方清除检查指示器
    callbacks.onComplete?.()
  }
}

/**
 * 检查是否需要请求用户许可以用给定输入调用 BashTool 的主实现
 */
export async function bashToolHasPermission(
  input: z.infer<typeof BashTool.inputSchema>,
  context: ToolUseContext,
  getCommandSubcommandPrefixFn = getCommandSubcommandPrefix,
): Promise<PermissionResult> {
  let appState = context.getAppState()

  // 0. 基于 AST 的安全解析。它同时替代了 tryParseShellCommand
  //（shell-quote 预检查）和 bashCommandIsSafe 误解析闸门。
  // tree-sitter 要么产生干净的 SimpleCommand[]（引号已解析、无隐藏替换），
  // 要么返回 'too-complex'——这正是我们判断 splitCommand 输出是否可信
  // 所需的信号。
  //
  // 当 tree-sitter WASM 不可用或通过环境变量禁用注入检查时，
  // 回退到旧路径（约 1370 行的旧版闸门会运行）。
  const injectionCheckDisabled = isEnvTruthy(
    process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK,
  )
  // GrowthBook 为 shadow 模式提供的 killswitch——关闭时整体跳过原生解析。
  // 只计算一次；feature() 必须在下面的三元表达式中保持内联。
  const shadowEnabled = feature('TREE_SITTER_BASH_SHADOW')
    ? getFeatureValue_CACHED_MAY_BE_STALE('tengu_birch_trellis', true)
    : false
  // 这里只解析一次；得到的 AST 会同时供给 parseForSecurityFromAst
  // 和 bashToolCheckCommandOperatorPermissions。
  let astRoot = injectionCheckDisabled
    ? null
    : feature('TREE_SITTER_BASH_SHADOW') && !shadowEnabled
      ? null
      : await parseCommandRaw(input.command)
  let astResult: ParseForSecurityResult = astRoot
    ? parseForSecurityFromAst(input.command, astRoot)
    : { kind: 'parse-unavailable' }
  let astSubcommands: string[] | null = null
  let astRedirects: Redirect[] | undefined
  let astCommands: SimpleCommand[] | undefined
  let shadowLegacySubs: string[] | undefined

  // Shadow-test tree-sitter：记录其判定结果，然后强制设为 parse-unavailable，
  // 以便旧路径保持权威。parseCommand 仍然以 TREE_SITTER_BASH（而非 SHADOW）
  // 为 gate，因此旧版内部仍保持纯正则实现。每次 bash 调用记录一个事件，
  // 同时捕获分歧与不可用原因；模块加载失败由会话级
  // tengu_tree_sitter_load 事件单独覆盖。
  if (feature('TREE_SITTER_BASH_SHADOW')) {
    const available = astResult.kind !== 'parse-unavailable'
    let tooComplex = false
    let semanticFail = false
    let subsDiffer = false
    if (available) {
      tooComplex = astResult.kind === 'too-complex'
      semanticFail =
        astResult.kind === 'simple' && !checkSemantics(astResult.commands).ok
      const tsSubs =
        astResult.kind === 'simple'
          ? astResult.commands.map(c => c.text)
          : undefined
      const legacySubs = splitCommand(input.command)
      shadowLegacySubs = legacySubs
      subsDiffer =
        tsSubs !== undefined &&
        (tsSubs.length !== legacySubs.length ||
          tsSubs.some((s, i) => s !== legacySubs[i]))
    }
    logEvent('tengu_tree_sitter_shadow', {
      available,
      astTooComplex: tooComplex,
      astSemanticFail: semanticFail,
      subsDiffer,
      injectionCheckDisabled,
      killswitchOff: !shadowEnabled,
      cmdOverLength: input.command.length > 10000,
    })
    // 始终强制走旧路径——shadow 模式仅用于观察。
    astResult = { kind: 'parse-unavailable' }
    astRoot = null
  }

  if (astResult.kind === 'too-complex') {
    // 解析成功，但发现了我们无法静态分析的结构
    //（命令替换、展开、控制流、解析器差异）。
    // 尊重精确匹配的 deny/ask/allow，然后检查 prefix/wildcard deny。
    // 仅当无 deny 命中时才落到 ask——不要把 deny 降级为 ask。
    const earlyExit = checkEarlyExitDeny(input, appState.toolPermissionContext)
    if (earlyExit !== null) return earlyExit
    const decisionReason: PermissionDecisionReason = {
      type: 'other' as const,
      reason: astResult.reason,
    }
    logEvent('tengu_bash_ast_too_complex', {
      nodeTypeId: nodeTypeId(astResult.nodeType),
    })
    return {
      behavior: 'ask',
      decisionReason,
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
      suggestions: [],
      ...(feature('BASH_CLASSIFIER')
        ? {
            pendingClassifierCheck: buildPendingClassifierCheck(
              input.command,
              appState.toolPermissionContext,
            ),
          }
        : {}),
    }
  }

  if (astResult.kind === 'simple') {
    // 干净解析：检查语义层面的问题（zsh builtins、eval 等）——
    // 这些命令能正常 tokenize，但因其名字本身就危险。
    const sem = checkSemantics(astResult.commands)
    if (!sem.ok) {
      // 与 too-complex 路径相同的 deny 规则执行：设置了
      // `Bash(eval:*)` deny 的用户期望 `eval "rm"` 被拦截，而不是被降级。
      const earlyExit = checkSemanticsDeny(
        input,
        appState.toolPermissionContext,
        astResult.commands,
      )
      if (earlyExit !== null) return earlyExit
      const decisionReason: PermissionDecisionReason = {
        type: 'other' as const,
        reason: (sem as { ok: false; reason: string }).reason,
      }
      return {
        behavior: 'ask',
        decisionReason,
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
        suggestions: [],
      }
    }
    // 把 token 化后的子命令暂存起来供下面使用。下游代码（规则匹配、
    // 路径提取、cd 检测）仍基于字符串工作，因此我们传入每个 SimpleCommand
    // 的原始源文本段。下游处理（stripSafeWrappers、parseCommandArguments）
    // 会对这些文本段重新 tokenize——这种重新 tokenize 存在已知 bug
    //（stripCommentLines 对引号内换行处理有误），但 checkSemantics 已经
    // 捕获了任何包含换行的 argv 元素，因此这些 bug 在此不会触发。
    // 把下游迁移到直接基于 argv 工作是后续提交。
    astSubcommands = astResult.commands.map(c => c.text)
    astRedirects = astResult.commands.flatMap(c => c.redirects)
    astCommands = astResult.commands
  }

  // 旧版 shell-quote 预检查。仅在 'parse-unavailable'（tree-sitter 未加载
  // 或 TREE_SITTER_BASH feature 关闭）时才会到达。继续落到下面的完整旧路径。
  if (astResult.kind === 'parse-unavailable') {
    logForDebugging(
      'bashToolHasPermission: tree-sitter unavailable, using legacy shell-quote path',
    )
    const parseResult = tryParseShellCommand(input.command)
    if (!parseResult.success) {
      const decisionReason = {
        type: 'other' as const,
        reason: `Command contains malformed syntax that cannot be parsed: ${(parseResult as { success: false; error: string }).error}`,
      }
      return {
        behavior: 'ask',
        decisionReason,
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
      }
    }
  }

  // 检查沙箱自动放行（会尊重显式 deny/ask 规则）
  // 仅当沙箱和 auto-allow 都启用时才调用
  if (
    SandboxManager.isSandboxingEnabled() &&
    SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
    shouldUseSandbox(input)
  ) {
    const sandboxAutoAllowResult = checkSandboxAutoAllow(
      input,
      appState.toolPermissionContext,
    )
    if (sandboxAutoAllowResult.behavior !== 'passthrough') {
      return sandboxAutoAllowResult
    }
  }

  // 先检查精确匹配
  const exactMatchResult = bashToolCheckExactMatchPermission(
    input,
    appState.toolPermissionContext,
  )

  // 精确命令被 deny
  if (exactMatchResult.behavior === 'deny') {
    return exactMatchResult
  }

  // 并行检查 Bash prompt deny 和 ask 规则（均使用 Haiku）。
  // Deny 优先于 ask，两者都优先于 allow 规则。
  // 在 auto 模式下跳过——auto 模式分类器处理所有权限决策
  if (
    isClassifierPermissionsEnabled() &&
    !(
      feature('TRANSCRIPT_CLASSIFIER') &&
      appState.toolPermissionContext.mode === 'auto'
    )
  ) {
    const denyDescriptions = getBashPromptDenyDescriptions(
      appState.toolPermissionContext,
    )
    const askDescriptions = getBashPromptAskDescriptions(
      appState.toolPermissionContext,
    )
    const hasDeny = denyDescriptions.length > 0
    const hasAsk = askDescriptions.length > 0

    if (hasDeny || hasAsk) {
      const [denyResult, askResult] = await Promise.all([
        hasDeny
          ? classifyBashCommand(
              input.command,
              getCwd(),
              denyDescriptions,
              'deny',
              context.abortController.signal,
              context.options.isNonInteractiveSession,
            )
          : null,
        hasAsk
          ? classifyBashCommand(
              input.command,
              getCwd(),
              askDescriptions,
              'ask',
              context.abortController.signal,
              context.options.isNonInteractiveSession,
            )
          : null,
      ])

      if (context.abortController.signal.aborted) {
        throw new AbortError()
      }

      if (denyResult) {
        logClassifierResultForAnts(
          input.command,
          'deny',
          denyDescriptions,
          denyResult,
        )
      }
      if (askResult) {
        logClassifierResultForAnts(
          input.command,
          'ask',
          askDescriptions,
          askResult,
        )
      }

      // Deny 优先
      if (denyResult?.matches && denyResult.confidence === 'high') {
        return {
          behavior: 'deny',
          message: `Denied by Bash prompt rule: "${denyResult.matchedDescription}"`,
          decisionReason: {
            type: 'other',
            reason: `Denied by Bash prompt rule: "${denyResult.matchedDescription}"`,
          },
        }
      }

      if (askResult?.matches && askResult.confidence === 'high') {
        // 跳过 Haiku 调用——UI 本地计算 prefix 并允许用户编辑。
        // 当测试注入了自定义函数时仍会调用它。
        let suggestions: PermissionUpdate[]
        if (getCommandSubcommandPrefixFn === getCommandSubcommandPrefix) {
          suggestions = suggestionForExactCommand(input.command)
        } else {
          const commandPrefixResult = await getCommandSubcommandPrefixFn(
            input.command,
            context.abortController.signal,
            context.options.isNonInteractiveSession,
          )
          if (context.abortController.signal.aborted) {
            throw new AbortError()
          }
          suggestions = commandPrefixResult?.commandPrefix
            ? suggestionForPrefix(commandPrefixResult.commandPrefix)
            : suggestionForExactCommand(input.command)
        }
        return {
          behavior: 'ask',
          message: createPermissionRequestMessage(BashTool.name),
          decisionReason: {
            type: 'other',
            reason: `Required by Bash prompt rule: "${askResult.matchedDescription}"`,
          },
          suggestions,
          ...(feature('BASH_CLASSIFIER')
            ? {
                pendingClassifierCheck: buildPendingClassifierCheck(
                  input.command,
                  appState.toolPermissionContext,
                ),
              }
            : {}),
        }
      }
    }
  }

  // 检查非子命令的 Bash 操作符，如 `>`、`|` 等。
  // 这必须发生在危险路径检查之前，以便管道命令由操作符逻辑处理
  //（后者会生成“多个操作”消息）
  const commandOperatorResult = await checkCommandOperatorPermissions(
    input,
    (i: z.infer<typeof BashTool.inputSchema>) =>
      bashToolHasPermission(i, context, getCommandSubcommandPrefixFn),
    { isNormalizedCdCommand, isNormalizedGitCommand },
    astRoot,
  )
  if (commandOperatorResult.behavior !== 'passthrough') {
    // 安全修复：当管道段处理返回 'allow' 时，仍必须校验原始命令。
    // 管道段处理在检查每段之前会剥离重定向，因此如下命令：
    //   echo 'x' | xargs printf '%s' >> /tmp/file
    // 会让两段都通过（echo 与 xargs printf），但 >> 重定向会绕过校验。
    // 我们必须检查：
    // 1. 输出重定向的路径约束
    // 2. 重定向目标中危险模式（反引号等）的命令安全检查
    if (commandOperatorResult.behavior === 'allow') {
      // 检查原始命令中的危险模式（反引号、$() 等）。
      // 这能捕获如下情况：echo x | xargs echo > `pwd`/evil.txt
      // 反引号位于重定向目标中（从各段中被剥离）。
      // 以 AST 为 gate：当 astSubcommands 非 null 时，tree-sitter 已校验结构
      //（重定向目标中的反引号/$() 会返回 too-complex）。与约 1481、1706、
      // 1755 行的 gate 一致。避免误报：`find -exec {} \; | grep x` 因
      // 反斜杠-; 误判。bashCommandIsSafe 运行完整的旧版 regex 集合（约 20 个
      // 模式）——仅当我们确实要用其结果时才调用。
      const safetyResult =
        astSubcommands === null
          ? await bashCommandIsSafeAsync(input.command)
          : null
      if (
        safetyResult !== null &&
        safetyResult.behavior !== 'passthrough' &&
        safetyResult.behavior !== 'allow'
      ) {
        // 挂载待处理的分类器检查——可能在用户响应前自动批准
        appState = context.getAppState()
        return {
          behavior: 'ask',
          message: createPermissionRequestMessage(BashTool.name, {
            type: 'other',
            reason:
              safetyResult.message ??
              'Command contains patterns that require approval',
          }),
          decisionReason: {
            type: 'other',
            reason:
              safetyResult.message ??
              'Command contains patterns that require approval',
          },
          ...(feature('BASH_CLASSIFIER')
            ? {
                pendingClassifierCheck: buildPendingClassifierCheck(
                  input.command,
                  appState.toolPermissionContext,
                ),
              }
            : {}),
        }
      }

      appState = context.getAppState()
      // 安全要求：从完整命令计算 compoundCommandHasCd，绝不能硬编码 false。
      // 管道处理路径此前在此处传入 `false`，禁用了 pathValidation.ts:821
      // 的 cd+redirect 检查。在 `cd .claude && echo x > settings.json` 后面
      // 拼接 `| echo done` 会经此路径并以 compoundCommandHasCd=false 处理，
      // 使重定向在 cd+redirect 拦截未触发的情况下写入
      // .claude/settings.json。
      const pathResult = checkPathConstraints(
        input,
        getCwd(),
        appState.toolPermissionContext,
        commandHasAnyCd(input.command),
        astRedirects,
        astCommands,
      )
      if (pathResult.behavior !== 'passthrough') {
        return pathResult
      }
    }

    // 当管道各段返回 'ask'（单个段未被规则放行）时，
    // 挂载待处理的分类器检查——可能在用户响应前自动批准。
    if (commandOperatorResult.behavior === 'ask') {
      appState = context.getAppState()
      return {
        ...commandOperatorResult,
        ...(feature('BASH_CLASSIFIER')
          ? {
              pendingClassifierCheck: buildPendingClassifierCheck(
                input.command,
                appState.toolPermissionContext,
              ),
            }
          : {}),
      }
    }

    return commandOperatorResult
  }

  // 安全要求：旧版误解析闸门。仅在 tree-sitter 模块未加载时运行。
  // 超时/中止通过 too-complex 失败闭合（已在上面提前返回），不会路由到这里。
  // 当 AST 解析成功时，astSubcommands 非 null 且我们已校验结构；
  // 此代码块整体跳过。AST 的 'too-complex' 结果涵盖了
  // isBashSecurityCheckForMisparsing 所覆盖的全部情况——二者回答的是同一问题：
  //“splitCommand 对此输入是否可信？”
  if (
    astSubcommands === null &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK)
  ) {
    const originalCommandSafetyResult = await bashCommandIsSafeAsync(
      input.command,
    )
    if (
      originalCommandSafetyResult.behavior === 'ask' &&
      originalCommandSafetyResult.isBashSecurityCheckForMisparsing
    ) {
      // 含安全 heredoc 模式（$(cat <<'EOF'...EOF)）的复合命令会触发对未拆分命令的
      // $() 检查。剥离安全 heredoc 后再检查余下部分——若仍存在其他误解析模式
      //（例如反斜杠转义的操作符），仍必须拦截。
      const remainder = stripSafeHeredocSubstitutions(input.command)
      const remainderResult =
        remainder !== null ? await bashCommandIsSafeAsync(remainder) : null
      if (
        remainder === null ||
        (remainderResult?.behavior === 'ask' &&
          remainderResult.isBashSecurityCheckForMisparsing)
      ) {
        // 若精确命令有显式 allow 权限则放行——
        // 用户是有意识地选择允许此具体命令。
        appState = context.getAppState()
        const exactMatchResult = bashToolCheckExactMatchPermission(
          input,
          appState.toolPermissionContext,
        )
        if (exactMatchResult.behavior === 'allow') {
          return exactMatchResult
        }
        // 挂载待处理的分类器检查——可能在用户响应前自动批准
        const decisionReason: PermissionDecisionReason = {
          type: 'other' as const,
          reason: originalCommandSafetyResult.message,
        }
        return {
          behavior: 'ask',
          message: createPermissionRequestMessage(
            BashTool.name,
            decisionReason,
          ),
          decisionReason,
          suggestions: [], // 不建议保存可能危险的命令
          ...(feature('BASH_CLASSIFIER')
            ? {
                pendingClassifierCheck: buildPendingClassifierCheck(
                  input.command,
                  appState.toolPermissionContext,
                ),
              }
            : {}),
        }
      }
    }
  }

  // 拆分为子命令。优先使用 AST 提取的文本段；仅在 tree-sitter 不可用时
  // 回退到 splitCommand。cd-cwd 过滤会剥除模型喜欢加的 `cd ${cwd}` 前缀。
  const cwd = getCwd()
  const cwdMingw =
    getPlatform() === 'windows' ? windowsPathToPosixPath(cwd) : cwd
  const rawSubcommands =
    astSubcommands ?? shadowLegacySubs ?? splitCommand(input.command)
  const { subcommands, astCommandsByIdx } = filterCdCwdSubcommands(
    rawSubcommands,
    astCommands,
    cwd,
    cwdMingw,
  )

  // CC-643：限制子命令扇出。只有旧版 splitCommand 路径可能爆炸——
  // AST 路径返回有界列表（astSubcommands !== null）或对其无法表示的结构
  // 短路为 'too-complex'。
  if (
    astSubcommands === null &&
    subcommands.length > MAX_SUBCOMMANDS_FOR_SECURITY_CHECK
  ) {
    logForDebugging(
      `bashPermissions: ${subcommands.length} subcommands exceeds cap (${MAX_SUBCOMMANDS_FOR_SECURITY_CHECK}) — returning ask`,
      { level: 'debug' },
    )
    const decisionReason = {
      type: 'other' as const,
      reason: `Command splits into ${subcommands.length} subcommands, too many to safety-check individually`,
    }
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
      decisionReason,
    }
  }

  // 若存在多个 `cd` 命令则需询问
  const cdCommands = subcommands.filter(subCommand =>
    isNormalizedCdCommand(subCommand),
  )
  if (cdCommands.length > 1) {
    const decisionReason = {
      type: 'other' as const,
      reason:
        'Multiple directory changes in one command require approval for clarity',
    }
    return {
      behavior: 'ask',
      decisionReason,
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
    }
  }

  // 跟踪复合命令是否包含 cd，用于安全校验
  // 这能防止通过 cd .claude/ && mv test.txt settings.json 绕过路径检查
  const compoundCommandHasCd = cdCommands.length > 0

  // 安全要求：拦截同时包含 cd 和 git 的复合命令
  // 这能防止通过 cd /malicious/dir && git status 逃逸沙箱——
  // 该恶意目录可能包含设置了 core.fsmonitor 的裸 git 仓库。
  // 此检查必须在此处进行（在子命令级权限检查之前），因为
  // bashToolCheckPermission 通过 BashTool.isReadOnly() 独立检查每个子命令，
  // 后者会仅凭 "git status" 重新推导出 compoundCommandHasCd=false，
  // 绕过 readOnlyValidation.ts 的检查。
  if (compoundCommandHasCd) {
    const hasGitCommand = subcommands.some(cmd =>
      isNormalizedGitCommand(cmd.trim()),
    )
    if (hasGitCommand) {
      const decisionReason = {
        type: 'other' as const,
        reason:
          'Compound commands with cd and git require approval to prevent bare repository attacks',
      }
      return {
        behavior: 'ask',
        decisionReason,
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
      }
    }
  }

  appState = context.getAppState() // 重新计算最新值，以防用户按了 shift+tab

  // 安全修复：在路径约束之前检查 Bash deny/ask 规则
  // 这确保显式 deny 规则（例如 Bash(ls:*)）优先于因路径在项目之外
  // 而返回 'ask' 的路径约束检查。没有此顺序，项目外的绝对路径
  //（例如 ls /home）会因 checkPathConstraints 先返回 'ask' 而绕过 deny 规则。
  //
  // 注意：bashToolCheckPermission 内部会调用 checkPathConstraints，
  // 对每个子命令处理输出重定向校验。但由于 splitCommand 在到达这里之前
  // 已剥离了重定向，我们必须在检查 deny 规则之后、返回结果之前，
  // 对原始命令的输出重定向进行校验。
  const subcommandPermissionDecisions = subcommands.map((command, i) =>
    bashToolCheckPermission(
      { command },
      appState.toolPermissionContext,
      compoundCommandHasCd,
      astCommandsByIdx[i],
    ),
  )

  // 任一子命令被 deny 则拒绝
  const deniedSubresult = subcommandPermissionDecisions.find(
    _ => _.behavior === 'deny',
  )
  if (deniedSubresult !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${input.command} has been denied.`,
      decisionReason: {
        type: 'subcommandResults',
        reasons: new Map(
          subcommandPermissionDecisions.map((result, i) => [
            subcommands[i]!,
            result,
          ]),
        ),
      },
    }
  }

  // 在原始命令上校验输出重定向（splitCommand 已在之前剥离了它们）
  // 这必须在检查 deny 规则之后、返回结果之前进行。
  // 像 "> /etc/passwd" 这样的输出重定向会被 splitCommand 剥离，因此每个
  // 子命令的 checkPathConstraints 调用看不到它们。我们在此处对原始输入
  // 进行校验。
  // 安全要求：当 AST 数据可用时，传入 AST 派生的重定向，以便
  // checkPathConstraints 直接使用它们，而不是再用 shell-quote 解析
  //（后者存在已知的单引号反斜杠误解析 bug，可能静默隐藏重定向操作符）。
  const pathResult = checkPathConstraints(
    input,
    getCwd(),
    appState.toolPermissionContext,
    compoundCommandHasCd,
    astRedirects,
    astCommands,
  )
  if (pathResult.behavior === 'deny') {
    return pathResult
  }

  const askSubresult = subcommandPermissionDecisions.find(
    _ => _.behavior === 'ask',
  )
  const nonAllowCount = count(
    subcommandPermissionDecisions,
    _ => _.behavior !== 'allow',
  )

  // 安全要求（GH#28784）：仅当没有任何子命令独立产生 'ask' 时，
  // 才在路径约束 'ask' 上短路。checkPathConstraints 会在完整输入上重跑
  // 路径-命令循环，因此 `cd <outside-project> && python3 foo.py` 会产生一个
  // 仅带 Read(<dir>/**) 建议的 ask——UI 把它渲染为“Yes, allow reading from
  // <dir>/”，选择该项会静默批准 python3。当某个子命令有自己的 ask
  //（例如 cd 子命令自身的路径约束 ask）时，继续往下走：要么触发下面
  // askSubresult 的短路（单个非 allow 子命令），要么由合并流程为每个
  // 非 allow 子命令收集 Bash 规则建议。bashToolCheckPermission 内部的
  // 每子命令 checkPathConstraints 调用已在那种路径中捕获了 cd 目标的
  // Read 规则。
  //
  // 当没有子命令 ask 时（全部 allow，或全部像 `printf > file` 那样
  // passthrough），pathResult 就是唯一的 ask——返回它以暴露重定向检查。
  if (pathResult.behavior === 'ask' && askSubresult === undefined) {
    return pathResult
  }

  // 任一子命令需要审批（例如 ls/cd 超出边界）则需询问。
  // 仅当恰好一个子命令需要审批时才短路——若有多个
  //（例如 cd-outside-project ask + python3 passthrough），继续落到合并流程，
  // 让提示为所有这些子命令展示 Bash 规则建议，而不是只显示第一个 ask 的
  // Read 规则（GH#28784）。
  if (askSubresult !== undefined && nonAllowCount === 1) {
    return {
      ...askSubresult,
      ...(feature('BASH_CLASSIFIER')
        ? {
            pendingClassifierCheck: buildPendingClassifierCheck(
              input.command,
              appState.toolPermissionContext,
            ),
          }
        : {}),
    }
  }

  // 精确命令被 allow 时放行
  if (exactMatchResult.behavior === 'allow') {
    return exactMatchResult
  }

  // 若所有子命令都经精确或 prefix 匹配被 allow，则放行命令——
  // 但前提是不存在命令注入可能。当 AST 解析成功时，每个子命令都已被确认为
  // 安全（无隐藏替换、无结构性把戏）；对每个子命令重新检查是冗余的。
  // 在旧路径上，对每个子命令重新运行 bashCommandIsSafeAsync。
  let hasPossibleCommandInjection = false
  if (
    astSubcommands === null &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK)
  ) {
    // CC-643：把分歧遥测合并为单个 logEvent。此前的每个子命令一次
    // logEvent 是热路径 syscall 的主要来源（每次调用经
    // process.memoryUsage() 读取 /proc/self/stat）。聚合计数保留了信号。
    let divergenceCount = 0
    const onDivergence = () => {
      divergenceCount++
    }
    const results = await Promise.all(
      subcommands.map(c => bashCommandIsSafeAsync(c, onDivergence)),
    )
    hasPossibleCommandInjection = results.some(
      r => r.behavior !== 'passthrough',
    )
    if (divergenceCount > 0) {
      logEvent('tengu_tree_sitter_security_divergence', {
        quoteContextDivergence: true,
        count: divergenceCount,
      })
    }
  }
  if (
    subcommandPermissionDecisions.every(_ => _.behavior === 'allow') &&
    !hasPossibleCommandInjection
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'subcommandResults',
        reasons: new Map(
          subcommandPermissionDecisions.map((result, i) => [
            subcommands[i]!,
            result,
          ]),
        ),
      },
    }
  }

  // 向 Haiku 查询命令 prefix
  // 跳过 Haiku 调用——UI 本地计算 prefix 并允许用户编辑。
  // 当注入了自定义函数（测试）时仍会调用。
  let commandSubcommandPrefix: Awaited<
    ReturnType<typeof getCommandSubcommandPrefixFn>
  > = null
  if (getCommandSubcommandPrefixFn !== getCommandSubcommandPrefix) {
    commandSubcommandPrefix = await getCommandSubcommandPrefixFn(
      input.command,
      context.abortController.signal,
      context.options.isNonInteractiveSession,
    )
    if (context.abortController.signal.aborted) {
      throw new AbortError()
    }
  }

  // 只有一条命令时无需处理子命令
  appState = context.getAppState() // 重新计算最新值，以防用户按了 shift+tab
  if (subcommands.length === 1) {
    const result = await checkCommandAndSuggestRules(
      { command: subcommands[0]! },
      appState.toolPermissionContext,
      commandSubcommandPrefix,
      compoundCommandHasCd,
      astSubcommands !== null,
    )
    // 若命令未被 allow，挂载待处理的分类器检查。
    // 此时 'ask' 只可能来自 bashCommandIsSafe
    //（checkCommandAndSuggestRules 内部的安全检查），而非来自显式 ask 规则——
    // 那些已在第 13 步（askSubresult 检查）被过滤掉。分类器可以绕过安全检查。
    if (result.behavior === 'ask' || result.behavior === 'passthrough') {
      return {
        ...result,
        ...(feature('BASH_CLASSIFIER')
          ? {
              pendingClassifierCheck: buildPendingClassifierCheck(
                input.command,
                appState.toolPermissionContext,
              ),
            }
          : {}),
      }
    }
    return result
  }

  // 检查子命令权限结果
  const subcommandResults: Map<string, PermissionResult> = new Map()
  for (const subcommand of subcommands) {
    subcommandResults.set(
      subcommand,
      await checkCommandAndSuggestRules(
        {
          // 透传输入参数，例如 `sandbox`
          ...input,
          command: subcommand,
        },
        appState.toolPermissionContext,
        commandSubcommandPrefix?.subcommandPrefixes.get(subcommand),
        compoundCommandHasCd,
        astSubcommands !== null,
      ),
    )
  }

  // 若所有子命令都被 allow 则放行
  // 注意此处与 6b 不同，因为这里会检查命令注入结果。
  if (
    subcommands.every(subcommand => {
      const permissionResult = subcommandResults.get(subcommand)
      return permissionResult?.behavior === 'allow'
    })
  ) {
    // 保留 subcommandResults 作为 PermissionResult 用于 decisionReason
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'subcommandResults',
        reasons: subcommandResults,
      },
    }
  }

  // Otherwise, ask for permission
  const collectedRules: Map<string, PermissionRuleValue> = new Map()

  for (const [subcommand, permissionResult] of subcommandResults) {
    if (
      permissionResult.behavior === 'ask' ||
      permissionResult.behavior === 'passthrough'
    ) {
      const updates =
        'suggestions' in permissionResult
          ? permissionResult.suggestions
          : undefined

      const rules = extractRules(updates)
      for (const rule of rules) {
        // 用字符串表示作为 key 进行去重
        const ruleKey = permissionRuleValueToString(rule)
        collectedRules.set(ruleKey, rule)
      }

      // GH#28784 后续：安全检查类 ask（复合 cd+write、进程替换等）
      // 不携带建议。在像 `cd ~/out && rm -rf x` 这样的复合命令中，这意味着
      // 只有 cd 的 Read 规则会被收集，UI 会把提示标为“Yes, allow reading
      // from <dir>/”——从不提及 rm。这里合成一条 Bash(exact) 规则，让 UI
      // 展示被链式拼接的命令。跳过显式 ask 规则（decisionReason.type
      // 为 'rule'）——那种情况下用户是有意识地想每次都审查。
      if (
        permissionResult.behavior === 'ask' &&
        rules.length === 0 &&
        permissionResult.decisionReason?.type !== 'rule'
      ) {
        for (const rule of extractRules(
          suggestionForExactCommand(subcommand),
        )) {
          const ruleKey = permissionRuleValueToString(rule)
          collectedRules.set(ruleKey, rule)
        }
      }
      // 注意：这里只收集规则，不收集其他更新类型（如 mode 切换）
      // 这对 bash 子命令是合适的，它们主要需要规则建议
    }
  }

  const decisionReason = {
    type: 'subcommandResults' as const,
    reasons: subcommandResults,
  }

  // GH#11380：截断到 MAX_SUGGESTED_RULES_FOR_COMPOUND。Map 保留插入顺序
  //（子命令顺序），因此切片会保留最左的 N 个。
  const cappedRules = Array.from(collectedRules.values()).slice(
    0,
    MAX_SUGGESTED_RULES_FOR_COMPOUND,
  )
  const suggestedUpdates: PermissionUpdate[] | undefined =
    cappedRules.length > 0
      ? [
          {
            type: 'addRules',
            rules: cappedRules,
            behavior: 'allow',
            destination: 'localSettings',
          },
        ]
      : undefined

  // 挂载待处理的分类器检查——可能在用户响应前自动批准。
  // 若任一子命令为 'ask'（例如路径约束或 ask 规则），behavior 为 'ask'——
  // 在 GH#28784 修复之前，ask 子结果总是会在上面短路，因此此路径此前
  // 只会看到 'passthrough' 子命令并硬编码该值。
  return {
    behavior: askSubresult !== undefined ? 'ask' : 'passthrough',
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    decisionReason,
    suggestions: suggestedUpdates,
    ...(feature('BASH_CLASSIFIER')
      ? {
          pendingClassifierCheck: buildPendingClassifierCheck(
            input.command,
            appState.toolPermissionContext,
          ),
        }
      : {}),
  }
}

/**
 * 在剥离安全 wrapper（环境变量、timeout 等）和 shell 引号之后，
 * 检查子命令是否是 git 命令。
 *
 * 安全要求：匹配前必须先做归一化，以防如下绕过：
 *   'git' status    — shell 引号把命令藏起来，逃避朴素的 regex
 *   NO_COLOR=1 git status — 环境变量前缀把命令藏起来
 */
export function isNormalizedGitCommand(command: string): boolean {
  // 快速路径：在任何解析之前先捕获最常见的情况
  if (command.startsWith('git ') || command === 'git') {
    return true
  }
  const stripped = stripSafeWrappers(command)
  const parsed = tryParseShellCommand(stripped)
  if (parsed.success && parsed.tokens.length > 0) {
    // 直接的 git 命令
    if (parsed.tokens[0] === 'git') {
      return true
    }
    // "xargs git ..."——xargs 会在当前目录运行 git，
    // 因此必须将其视为 git 命令以进行 cd+git 安全校验。
    // 这与 filterRulesByContentsMatchingInput 中的 xargs prefix 处理一致。
    if (parsed.tokens[0] === 'xargs' && parsed.tokens.includes('git')) {
      return true
    }
    return false
  }
  return /^git(?:\s|$)/.test(stripped)
}

/**
 * 在剥离安全 wrapper（环境变量、timeout 等）和 shell 引号之后，
 * 检查子命令是否是 cd 命令。
 *
 * 安全要求：匹配前必须先做归一化，以防如下绕过：
 *   FORCE_COLOR=1 cd sub — 环境变量前缀把 cd 藏起来，逃避朴素的 /^cd / regex
 *   这与 isNormalizedGitCommand 对称，以确保归一化方式一致。
 *
 * 同时匹配 pushd/popd——它们和 cd 一样会改变 cwd，因此
 *   pushd /tmp/bare-repo && git status
 * 必须触发同样的 cd+git 守卫。对应 PowerShell 的
 * DIRECTORY_CHANGE_ALIASES（src/utils/powershell/parser.ts）。
 */
export function isNormalizedCdCommand(command: string): boolean {
  const stripped = stripSafeWrappers(command)
  const parsed = tryParseShellCommand(stripped)
  if (parsed.success && parsed.tokens.length > 0) {
    const cmd = parsed.tokens[0]
    return cmd === 'cd' || cmd === 'pushd' || cmd === 'popd'
  }
  return /^(?:cd|pushd|popd)(?:\s|$)/.test(stripped)
}

/**
 * 检查复合命令是否包含任意 cd 命令，
 * 使用能处理环境变量前缀和 shell 引号的归一化检测。
 */
export function commandHasAnyCd(command: string): boolean {
  return splitCommand(command).some(subcmd =>
    isNormalizedCdCommand(subcmd.trim()),
  )
}
