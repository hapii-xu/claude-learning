import { isEnvTruthy } from 'src/utils/envUtils.js'
import { getMaxOutputLength } from 'src/utils/shell/outputLimits.js'
import {
  getPowerShellEdition,
  type PowerShellEdition,
} from 'src/utils/shell/powershellDetection.js'
import {
  getDefaultBashTimeoutMs,
  getMaxBashTimeoutMs,
} from 'src/utils/timeouts.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'
import { POWERSHELL_TOOL_NAME } from './toolName.js'

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
  return `  - 你可以使用 \`run_in_background\` 参数在后台运行命令。仅在不需要立即获取结果、且能接受稍后收到完成通知的情况下使用此参数。无需立即检查输出——命令完成时会自动通知你。`
}

function getSleepGuidance(): string | null {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) {
    return null
  }
  return `  - 避免不必要的 \`Start-Sleep\` 命令：
    - 可以立即运行的命令之间不要 sleep——直接运行即可。
    - 如果命令运行时间较长且希望完成后得到通知——直接使用 \`run_in_background\` 运行命令即可，无需 sleep。
    - 不要在 sleep 循环中重试失败的命令——诊断根本原因或考虑其他方法。
    - 如果在等待用 \`run_in_background\` 启动的后台任务，命令完成时会自动通知——无需轮询。
    - 如果必须轮询外部进程，优先使用检查命令而非先 sleep。
    - 如果必须 sleep，保持短暂（1-5 秒）以避免阻塞用户。`
}

/**
 * 针对特定版本的语法指导。模型的训练数据覆盖两个
 * 版本，但它无法判断当前目标，因此要么在 5.1 上发出 pwsh-7 语法
 *（解析器错误 → 退出 1），要么在 7 上不必要地避免 &&。
 */
function getEditionSection(edition: PowerShellEdition | null): string {
  if (edition === 'desktop') {
    return `PowerShell 版本：Windows PowerShell 5.1 (powershell.exe)
   - 管道链操作符 \`&&\` 和 \`||\` 不可用——它们会导致解析器错误。若要仅在 A 成功时运行 B：\`A; if ($?) { B }\`。无条件串联：\`A; B\`。
   - 三元运算符（\`?:\`）、空值合并运算符（\`??\`）和空值条件运算符（\`?.\`）不可用。请改用 \`if/else\` 和显式 \`$null -eq\` 检查。
   - 避免对原生可执行文件使用 \`2>&1\`。在 5.1 中，在 PowerShell 内重定向原生命令的 stderr 会将每行包装为 ErrorRecord（NativeCommandError）并将 \`$?\` 设为 \`$false\`，即使 exe 返回了退出码 0。stderr 已自动为你捕获——无需重定向。
   - 默认文件编码为 UTF-16 LE（带 BOM）。写入其他工具将读取的文件时，向 \`Out-File\`/\`Set-Content\` 传入 \`-Encoding utf8\`。
   - \`ConvertFrom-Json\` 返回 PSCustomObject，而非 hashtable。\`-AsHashtable\` 不可用。`
  }
  if (edition === 'core') {
    return `PowerShell 版本：PowerShell 7+（pwsh）
   - 管道链操作符 \`&&\` 和 \`||\` 可用，行为与 bash 相同。A 成功才运行 B 时，优先使用 \`cmd1 && cmd2\` 而非 \`cmd1; cmd2\`。
   - 三元运算符（\`$cond ? $a : $b\`）、空值合并运算符（\`??\`）和空值条件运算符（\`?.\`）均可用。
   - 默认文件编码为 UTF-8（无 BOM）。`
  }
  // 检测尚未解决（任何工具调用之前的第一次提示构建）或
  // PS 未安装。提供保守的 5.1 安全指导。
  return `PowerShell 版本：未知——为兼容性假设为 Windows PowerShell 5.1
   - 请勿使用 \`&&\`、\`||\`、三元 \`?:\`、空值合并 \`??\` 或空值条件 \`?.\`。这些仅适用于 PowerShell 7+，在 5.1 上会引发解析器错误。
   - 条件串联命令：\`A; if ($?) { B }\`。无条件串联：\`A; B\`。`
}

export async function getPrompt(): Promise<string> {
  const backgroundNote = getBackgroundUsageNote()
  const sleepGuidance = getSleepGuidance()
  const edition = await getPowerShellEdition()

  return `执行指定的 PowerShell 命令，支持可选超时。工作目录在命令之间保持不变；shell 状态（变量、函数）不保留。

重要：本工具用于通过 PowerShell 执行终端操作：git、npm、docker 及 PS cmdlet。请勿用于文件操作（读取、写入、编辑、搜索、查找文件）——请改用专用工具。

${getEditionSection(edition)}

执行命令前，请按以下步骤操作：

1. 目录验证：
   - 如果命令将创建新目录或文件，请先使用 \`Get-ChildItem\`（或 \`ls\`）验证父目录存在且位置正确

2. 命令执行：
   - 包含空格的文件路径始终使用双引号
   - 捕获命令的输出。

PowerShell 语法说明：
   - 变量使用 $ 前缀：$myVar = "value"
   - 转义字符是反引号（\`），而非反斜线
   - 使用 Verb-Noun cmdlet 命名：Get-ChildItem、Set-Location、New-Item、Remove-Item
   - 常用别名：ls（Get-ChildItem）、cd（Set-Location）、cat（Get-Content）、rm（Remove-Item）
   - 管道操作符 | 与 bash 类似，但传递对象而非文本
   - 使用 Select-Object、Where-Object、ForEach-Object 进行过滤和转换
   - 字符串插值："Hello $name" 或 "Hello $($obj.Property)"
   - 注册表访问使用 PSDrive 前缀：\`HKLM:\\SOFTWARE\\...\`、\`HKCU:\\...\`——禁止使用原始 \`HKEY_LOCAL_MACHINE\\...\`
   - 环境变量：使用 \`$env:NAME\` 读取，使用 \`$env:NAME = "value"\` 设置（禁止使用 \`Set-Variable\` 或 bash 的 \`export\`）
   - 通过调用操作符调用路径含空格的原生 exe：\`& "C:\\Program Files\\App\\app.exe" arg1 arg2\`

交互式与阻塞命令（会挂起——本工具以 -NonInteractive 运行）：
   - 禁止使用 \`Read-Host\`、\`Get-Credential\`、\`Out-GridView\`、\`$Host.UI.PromptForChoice\` 或 \`pause\`
   - 破坏性 cmdlet（\`Remove-Item\`、\`Stop-Process\`、\`Clear-Content\` 等）可能会提示确认。若确定要执行，添加 \`-Confirm:$false\`。对只读/隐藏项使用 \`-Force\`。
   - 禁止使用 \`git rebase -i\`、\`git add -i\` 或其他会打开交互式编辑器的命令

向原生可执行文件传递多行字符串（提交信息、文件内容）：
   - 使用单引号 here-string，这样 PowerShell 不会展开其中的 \`$\` 或反引号。结尾的 \`'@\` 必须位于第 0 列（无前导空白），单独成行——缩进会导致解析错误：
<example>
git commit -m @'
Commit message here.
Second line with $literal dollar signs.
'@
</example>
   - 使用 \`@'...'@\`（单引号，字面量）而非 \`@"..."@\`（双引号，插值），除非需要变量展开
   - 对于含 \`-\`、\`@\` 或其他 PowerShell 会作为操作符解析的字符的参数，使用 stop-parsing 标记：\`git log --% --format=%H\`

使用说明：
  - command 参数为必填项。
  - 可以指定可选超时（毫秒，上限 ${getMaxTimeoutMs()}ms / ${getMaxTimeoutMs() / 60000} 分钟）。未指定时，命令将在 ${getDefaultTimeoutMs()}ms（${getDefaultTimeoutMs() / 60000} 分钟）后超时。
  - 清晰简洁地描述命令的作用非常有帮助。
  - 如果输出超过 ${getMaxOutputLength()} 个字符，输出将在返回前被截断。
${backgroundNote ? backgroundNote + '\n' : ''}\
  - 避免使用 PowerShell 运行有专用工具的命令，除非明确指示：
    - 文件搜索：使用 ${GLOB_TOOL_NAME}（而非 Get-ChildItem -Recurse）
    - 内容搜索：使用 ${GREP_TOOL_NAME}（而非 Select-String）
    - 读取文件：使用 ${FILE_READ_TOOL_NAME}（而非 Get-Content）
    - 编辑文件：使用 ${FILE_EDIT_TOOL_NAME}
    - 写入文件：使用 ${FILE_WRITE_TOOL_NAME}（而非 Set-Content/Out-File）
    - 通信：直接输出文本（而非 Write-Output/Write-Host）
  - 发出多个命令时：
    - 如果命令相互独立可并行运行，在单条消息中发起多个 ${POWERSHELL_TOOL_NAME} 工具调用。
    - 如果命令相互依赖必须顺序运行，在单个 ${POWERSHELL_TOOL_NAME} 调用中串联（见上方版本专属串联语法）。
    - 仅在需要顺序运行但不关心前面命令是否失败时使用 \`;\`。
    - 不要用换行符分隔命令（换行在引号字符串和 here-string 中是允许的）
  - 不要在命令前加 \`cd\` 或 \`Set-Location\`——工作目录已自动设为正确的项目目录。
${sleepGuidance ? sleepGuidance + '\n' : ''}\
  - 对于 git 命令：
    - 优先创建新 commit 而非修改已有 commit。
    - 执行破坏性操作前（如 git reset --hard、git push --force、git checkout --），请考虑是否有更安全的替代方案。仅在确实最优时才使用破坏性操作。
    - 除非用户明确要求，否则不要跳过钩子（--no-verify）或绕过签名（--no-gpg-sign、-c commit.gpgsign=false）。如果钩子失败，排查并解决根本问题。`
}
