import { feature } from 'bun:bundle'
import { prependBullets } from 'src/constants/prompts.js'
import { getAttributionTexts } from 'src/utils/attribution.js'
import { hasEmbeddedSearchTools } from 'src/utils/embeddedTools.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'
import { shouldIncludeGitInstructions } from 'src/utils/gitSettings.js'
import { getClaudeTempDir } from 'src/utils/permissions/filesystem.js'
import { SandboxManager } from 'src/utils/sandbox/sandbox-adapter.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import {
  getDefaultBashTimeoutMs,
  getMaxBashTimeoutMs,
} from 'src/utils/timeouts.js'
import {
  getUndercoverInstructions,
  isUndercover,
} from 'src/utils/undercover.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'
import { TodoWriteTool } from '../TodoWriteTool/TodoWriteTool.js'
import { BASH_TOOL_NAME } from './toolName.js'

export function getDefaultTimeoutMs(): number {
  return getDefaultBashTimeoutMs()
}

export function getMaxTimeoutMs(): number {
  return getMaxBashTimeoutMs()
}

function getBackgroundUsageNote(): string | null {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) {
    return null
  }
  return "你可以使用 `run_in_background` 参数在后台运行命令。仅当你不需要立即获取结果、且愿意在命令完成后收到通知时才使用此参数。无需立即检查输出——命令完成时你会收到通知。使用此参数时无需在命令末尾加 '&'。"
}

function getCommitAndPRInstructions(): string {
  // 纵深防御：即使用户完全禁用了 git 相关说明，undercover 指令也必须保留。
  // 署名剥离与 model-ID 隐藏是机械性的，无论如何都生效；但显式的
  // "不要暴露身份" 指令是防止模型在 commit 消息中主动泄露内部代号
  // 的最后一道防线。
  const undercoverSection =
    process.env.USER_TYPE === 'ant' && isUndercover()
      ? getUndercoverInstructions() + '\n'
      : ''

  if (!shouldIncludeGitInstructions()) return undercoverSection

  // 对于 ant 用户，使用指向 skills 的简短版本
  if (process.env.USER_TYPE === 'ant') {
    const skillsSection = !isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)
      ? `如需进行 git 提交和创建 Pull Request，请使用 \`/commit\` 和 \`/commit-push-pr\` skills：
- \`/commit\` - 提交已暂存的更改
- \`/commit-push-pr\` - 提交、推送并创建 Pull Request

这些 skills 会处理 git 安全协议、规范化提交消息格式以及 PR 创建。

创建 Pull Request 之前，先运行 \`/simplify\` 审查你的更改，然后进行端到端测试（例如通过 \`/tmux\` 测试交互式功能）。

`
      : ''
    return `${undercoverSection}# Git 操作

${skillsSection}重要：除非用户明确要求，否则绝不跳过钩子（--no-verify、--no-gpg-sign 等）。

对于其他 GitHub 相关任务（包括处理 issue、检查和发布），请通过 Bash 工具使用 gh 命令。如果收到 GitHub URL，请使用 gh 命令获取所需信息。

# 其他常用操作
- 查看 Github PR 的评论：gh api repos/foo/bar/pulls/123/comments`
  }

  // 对于外部用户，包含完整的内联说明
  const { commit: commitAttribution, pr: prAttribution } = getAttributionTexts()

  return `# 使用 git 提交更改

仅在用户请求时才创建提交。如不明确，请先询问。当用户要求你创建新的 git 提交时，请仔细遵循以下步骤：

你可以在一次响应中调用多个工具。当请求多条独立信息且所有命令都可能成功时，并行运行多个工具调用以获得最佳性能。下方编号步骤表示哪些命令应批量并行执行。

Git 安全协议：
- 绝不更新 git config
- 除非用户明确请求，否则绝不运行破坏性 git 命令（push --force、reset --hard、checkout .、restore .、clean -f、branch -D）。未经授权的破坏性操作会导致工作丢失，因此只有在收到明确指令时才运行这些命令
- 除非用户明确要求，否则绝不跳过钩子（--no-verify、--no-gpg-sign 等）
- 绝不强制推送到 main/master，若用户要求则警告用户
- 关键：始终创建新提交而非修改现有提交，除非用户明确请求 git amend。pre-commit 钩子失败时，提交并未发生——此时 --amend 会修改上一个提交，可能导致工作丢失。应在钩子失败后修复问题、重新暂存，并创建新提交
- 暂存文件时，优先按名称添加具体文件，而非使用 "git add -A" 或 "git add ."，以免意外包含敏感文件（.env、credentials）或大型二进制文件
- 除非用户明确要求，否则绝不提交更改。仅在明确被要求时才提交，否则用户会感到你过于主动

1. 并行运行以下 bash 命令，每条命令使用 ${BASH_TOOL_NAME} 工具：
  - 运行 git status 命令查看所有未跟踪文件。重要：绝不使用 -uall 标志，因为它会在大型仓库中导致内存问题。
  - 运行 git diff 命令查看将要提交的已暂存和未暂存更改。
  - 运行 git log 命令查看最近的提交消息，以便遵循该仓库的提交消息风格。
2. 分析所有已暂存的更改（包括之前已暂存和新增的），并起草提交消息：
  - 总结更改的性质（如新功能、对现有功能的增强、bug 修复、重构、测试、文档等）。确保消息准确反映更改及其目的（即"add"表示全新功能，"update"表示对现有功能的增强，"fix"表示 bug 修复，等等）。
  - 不要提交可能包含密钥的文件（.env、credentials.json 等）。如果用户明确要求提交这些文件，请警告用户
  - 起草简洁（1-2 句）的提交消息，专注于"为什么"而非"做了什么"
  - 确保消息准确反映更改及其目的
3. 并行运行以下命令：
   - 将相关未跟踪文件添加到暂存区。
   - 创建带有消息${commitAttribution ? `（结尾附：\n   ${commitAttribution}）的` : '的'}提交。
   - 提交完成后运行 git status 验证成功。
   注意：git status 依赖提交完成，因此在提交后按顺序运行。
4. 如果提交因 pre-commit 钩子失败：修复问题并创建新提交

重要说明：
- 除 git bash 命令外，绝不运行其他读取或探索代码的命令
- 绝不使用 ${TodoWriteTool.name} 或 ${AGENT_TOOL_NAME} 工具
- 除非用户明确要求，否则不要推送到远程仓库
- 重要：绝不使用带 -i 标志的 git 命令（如 git rebase -i 或 git add -i），因为它们需要不受支持的交互式输入。
- 重要：不要在 git rebase 命令中使用 --no-edit，因为它不是 git rebase 的有效选项。
- 如果没有可提交的更改（即没有未跟踪文件且没有修改），不要创建空提交
- 为确保格式正确，始终通过 HEREDOC 传递提交消息，例如：
<example>
git commit -m "$(cat <<'EOF'
   Commit message here.${commitAttribution ? `\n\n   ${commitAttribution}` : ''}
   EOF
   )"
</example>

# 创建 Pull Request
对于所有 GitHub 相关任务（包括处理 issue、pull request、检查和发布），请通过 Bash 工具使用 gh 命令。如果收到 GitHub URL，请使用 gh 命令获取所需信息。

重要：当用户要求你创建 pull request 时，请仔细遵循以下步骤：

1. 使用 ${BASH_TOOL_NAME} 工具并行运行以下 bash 命令，以了解自分支从主分支分叉以来的当前状态：
   - 运行 git status 命令查看所有未跟踪文件（绝不使用 -uall 标志）
   - 运行 git diff 命令查看将要提交的已暂存和未暂存更改
   - 检查当前分支是否跟踪远程分支并与远程保持同步，以便了解是否需要推送到远程
   - 运行 git log 命令和 \`git diff [base-branch]...HEAD\` 以了解当前分支（自从从基础分支分叉以来）的完整提交历史
2. 分析将包含在 pull request 中的所有更改，确保查看所有相关提交（不仅仅是最新提交，而是将包含在 pull request 中的所有提交！！！），并起草 pull request 标题和摘要：
   - 保持 PR 标题简短（70 个字符以内）
   - 详细信息放在描述/正文中，而不是标题里
3. 并行运行以下命令：
   - 如需，创建新分支
   - 如需，使用 -u 标志推送到远程
   - 使用以下格式通过 gh pr create 创建 PR。使用 HEREDOC 传递正文以确保格式正确。
<example>
gh pr create --title "the pr title" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

## Test plan
[Bulleted markdown checklist of TODOs for testing the pull request...]${prAttribution ? `\n\n${prAttribution}` : ''}
EOF
)"
</example>

重要：
- 绝不使用 ${TodoWriteTool.name} 或 ${AGENT_TOOL_NAME} 工具
- 完成后返回 PR URL，以便用户查看

# 其他常用操作
- 查看 Github PR 的评论：gh api repos/foo/bar/pulls/123/comments`
}

// SandboxManager 会合并来自多个来源（settings 分层、默认值、CLI 标志）的配置，
// 且不会去重，因此像 ~/.cache 这样的路径会在 allowOnly 中出现 3 次。
// 在内联到 prompt 之前在此去重——仅影响模型看到的内容，不影响沙箱实际执行。
// 当启用沙箱时，可节省约 150-200 token/请求。
function dedup<T>(arr: T[] | undefined): T[] | undefined {
  if (!arr || arr.length === 0) return arr
  return [...new Set(arr)]
}

function getSimpleSandboxSection(): string {
  if (!SandboxManager.isSandboxingEnabled()) {
    return ''
  }

  const fsReadConfig = SandboxManager.getFsReadConfig()
  const fsWriteConfig = SandboxManager.getFsWriteConfig()
  const networkRestrictionConfig = SandboxManager.getNetworkRestrictionConfig()
  const allowUnixSockets = SandboxManager.getAllowUnixSockets()
  const ignoreViolations = SandboxManager.getIgnoreViolations()
  const allowUnsandboxedCommands =
    SandboxManager.areUnsandboxedCommandsAllowed()

  // 将 per-UID 的临时目录字面量（例如 /private/tmp/claude-1001/）替换为
  // "$TMPDIR"，使 prompt 在不同用户间保持一致——避免破坏跨用户的全局
  // prompt 缓存。沙箱在运行时会自动设置 $TMPDIR。
  const claudeTempDir = getClaudeTempDir()
  const normalizeAllowOnly = (paths: string[]): string[] =>
    [...new Set(paths)].map(p => (p === claudeTempDir ? '$TMPDIR' : p))

  const filesystemConfig = {
    read: {
      denyOnly: dedup(fsReadConfig.denyOnly),
      ...(fsReadConfig.allowWithinDeny && {
        allowWithinDeny: dedup(fsReadConfig.allowWithinDeny),
      }),
    },
    write: {
      allowOnly: normalizeAllowOnly(fsWriteConfig.allowOnly),
      denyWithinAllow: dedup(fsWriteConfig.denyWithinAllow),
    },
  }

  const networkConfig = {
    ...(networkRestrictionConfig?.allowedHosts && {
      allowedHosts: dedup(networkRestrictionConfig.allowedHosts),
    }),
    ...(networkRestrictionConfig?.deniedHosts && {
      deniedHosts: dedup(networkRestrictionConfig.deniedHosts),
    }),
    ...(allowUnixSockets && { allowUnixSockets: dedup(allowUnixSockets) }),
  }

  const restrictionsLines = []
  if (Object.keys(filesystemConfig).length > 0) {
    restrictionsLines.push(`Filesystem: ${jsonStringify(filesystemConfig)}`)
  }
  if (Object.keys(networkConfig).length > 0) {
    restrictionsLines.push(`Network: ${jsonStringify(networkConfig)}`)
  }
  if (ignoreViolations) {
    restrictionsLines.push(
      `Ignored violations: ${jsonStringify(ignoreViolations)}`,
    )
  }

  const sandboxOverrideItems: Array<string | string[]> =
    allowUnsandboxedCommands
      ? [
          'You should always default to running commands within the sandbox. Do NOT attempt to set `dangerouslyDisableSandbox: true` unless:',
          [
            'The user *explicitly* asks you to bypass sandbox',
            'A specific command just failed and you see evidence of sandbox restrictions causing the failure. Note that commands can fail for many reasons unrelated to the sandbox (missing files, wrong arguments, network issues, etc.).',
          ],
          'Evidence of sandbox-caused failures includes:',
          [
            '"Operation not permitted" errors for file/network operations',
            'Access denied to specific paths outside allowed directories',
            'Network connection failures to non-whitelisted hosts',
            'Unix socket connection errors',
          ],
          'When you see evidence of sandbox-caused failure:',
          [
            "Immediately retry with `dangerouslyDisableSandbox: true` (don't ask, just do it)",
            'Briefly explain what sandbox restriction likely caused the failure. Be sure to mention that the user can use the `/sandbox` command to manage restrictions.',
            'This will prompt the user for permission',
          ],
          'Treat each command you execute with `dangerouslyDisableSandbox: true` individually. Even if you have recently run a command with this setting, you should default to running future commands within the sandbox.',
          'Do not suggest adding sensitive paths like ~/.bashrc, ~/.zshrc, ~/.ssh/*, or credential files to the sandbox allowlist.',
        ]
      : [
          'All commands MUST run in sandbox mode - the `dangerouslyDisableSandbox` parameter is disabled by policy.',
          'Commands cannot run outside the sandbox under any circumstances.',
          'If a command fails due to sandbox restrictions, work with the user to adjust sandbox settings instead.',
        ]

  const items: Array<string | string[]> = [
    ...sandboxOverrideItems,
    'For temporary files, always use the `$TMPDIR` environment variable. TMPDIR is automatically set to the correct sandbox-writable directory in sandbox mode. Do NOT use `/tmp` directly - use `$TMPDIR` instead.',
  ]

  return [
    '',
    '## Command sandbox',
    'By default, your command will be run in a sandbox. This sandbox controls which directories and network hosts commands may access or modify without an explicit override.',
    '',
    'The sandbox has the following restrictions:',
    restrictionsLines.join('\n'),
    '',
    ...prependBullets(items),
  ].join('\n')
}

export function getSimplePrompt(): string {
  // Ant 原生构建将 find/grep 别名到 Claude shell 中内嵌的 bfs/ugrep，
  // 因此我们不再刻意避开它们（并且 Glob/Grep 工具已被移除）。
  const embedded = hasEmbeddedSearchTools()

  const toolPreferenceItems = [
    ...(embedded
      ? []
      : [
          `File search: Use ${GLOB_TOOL_NAME} (NOT find or ls)`,
          `Content search: Use ${GREP_TOOL_NAME} (NOT grep or rg)`,
        ]),
    `Read files: Use ${FILE_READ_TOOL_NAME} (NOT cat/head/tail)`,
    `Edit files: Use ${FILE_EDIT_TOOL_NAME} (NOT sed/awk)`,
    `Write files: Use ${FILE_WRITE_TOOL_NAME} (NOT echo >/cat <<EOF)`,
    'Communication: Output text directly (NOT echo/printf)',
  ]

  const avoidCommands = embedded
    ? '`cat`, `head`, `tail`, `sed`, `awk`, or `echo`'
    : '`find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo`'

  const multipleCommandsSubitems = [
    `If the commands are independent and can run in parallel, make multiple ${BASH_TOOL_NAME} tool calls in a single message. Example: if you need to run "git status" and "git diff", send a single message with two ${BASH_TOOL_NAME} tool calls in parallel.`,
    `If the commands depend on each other and must run sequentially, use a single ${BASH_TOOL_NAME} call with '&&' to chain them together.`,
    "Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.",
    'DO NOT use newlines to separate commands (newlines are ok in quoted strings).',
  ]

  const gitSubitems = [
    'Prefer to create a new commit rather than amending an existing commit.',
    'Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.',
    'Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user has explicitly asked for it. If a hook fails, investigate and fix the underlying issue.',
  ]

  const sleepSubitems = [
    'Do not sleep between commands that can run immediately — just run them.',
    ...(feature('MONITOR_TOOL')
      ? [
          'Use the Monitor tool to stream events from a background process (each stdout line is a notification). For one-shot "wait until done," use Bash with run_in_background instead.',
        ]
      : []),
    'For long-running commands, use `run_in_background` — you will be notified when it completes. Do not poll.',
    'Do not retry failing commands in a sleep loop — diagnose the root cause.',
    ...(feature('MONITOR_TOOL')
      ? [
          '`sleep N` as the first command with N ≥ 2 is blocked. If you need a delay (rate limiting, deliberate pacing), keep it under 2 seconds.',
        ]
      : [
          'If you must sleep, keep the duration short (1-5 seconds) to avoid blocking the user.',
        ]),
  ]
  const backgroundNote = getBackgroundUsageNote()

  const instructionItems: Array<string | string[]> = [
    'If your command will create new directories or files, first use this tool to run `ls` to verify the parent directory exists and is the correct location.',
    'Always quote file paths that contain spaces with double quotes in your command (e.g., cd "path with spaces/file.txt")',
    'Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of `cd`. You may use `cd` if the User explicitly requests it.',
    `You may specify an optional timeout in milliseconds (up to ${getMaxTimeoutMs()}ms / ${getMaxTimeoutMs() / 60000} minutes). By default, your command will timeout after ${getDefaultTimeoutMs()}ms (${getDefaultTimeoutMs() / 60000} minutes).`,
    ...(backgroundNote !== null ? [backgroundNote] : []),
    'When issuing multiple commands:',
    multipleCommandsSubitems,
    'For git commands:',
    gitSubitems,
    'Avoid unnecessary `sleep` commands:',
    sleepSubitems,
    ...(embedded
      ? [
          // bfs（支撑 `find`）在 -regex 中使用 Oniguruma，它采用最左优先
          // 匹配（leftmost-first），而 GNU find 使用 POSIX 最长匹配。
          // 当较短的备选项是较长备选项的前缀时，这会静默丢弃部分匹配。
          "When using `find -regex` with alternation, put the longest alternative first. Example: use `'.*\\.\\(tsx\\|ts\\)'` not `'.*\\.\\(ts\\|tsx\\)'` — the second form silently skips `.tsx` files.",
        ]
      : []),
  ]

  return [
    'Executes a given bash command and returns its output.',
    '',
    "The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).",
    '',
    `IMPORTANT: Avoid using this tool to run ${avoidCommands} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:`,
    '',
    ...prependBullets(toolPreferenceItems),
    `While the ${BASH_TOOL_NAME} tool can do similar things, it’s better to use the built-in tools as they provide a better user experience and make it easier to review tool calls and give permission.`,
    '',
    '# Instructions',
    ...prependBullets(instructionItems),
    getSimpleSandboxSection(),
    ...(getCommitAndPRInstructions() ? ['', getCommitAndPRInstructions()] : []),
  ].join('\n')
}
