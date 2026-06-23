/**
 * 用于命令验证的 PowerShell 特定安全分析。
 *
 * 检测危险模式：代码注入、下载摇篮、特权
 * 提升、动态命令名、COM 对象等。
 *
 * 所有检查都基于 AST。如果解析失败（valid=false），单个
// 检查都不匹配，powershellCommandIsSafe 返回 '询问'。
 */

import {
  DANGEROUS_SCRIPT_BLOCK_CMDLETS,
  FILEPATH_EXECUTION_CMDLETS,
  MODULE_LOADING_CMDLETS,
} from 'src/utils/powershell/dangerousCmdlets.js'
import type {
  ParsedCommandElement,
  ParsedPowerShellCommand,
} from 'src/utils/powershell/parser.js'
import {
  COMMON_ALIASES,
  commandHasArgAbbreviation,
  deriveSecurityFlags,
  getAllCommands,
  getVariablesByScope,
  hasCommandNamed,
} from 'src/utils/powershell/parser.js'
import { isClmAllowedType } from './clmTypes.js'

type PowerShellSecurityResult = {
  behavior: 'passthrough' | 'ask' | 'allow'
  message?: string
}

const POWERSHELL_EXECUTABLES = new Set([
  'pwsh',
  'pwsh.exe',
  'powershell',
  'powershell.exe',
])

/**
 * 从命令中提取基础可执行文件名，处理完整路径，
 * 如 /usr/bin/pwsh、C:\Windows\...\powershell.exe 或 .\pwsh。
 */
function isPowerShellExecutable(name: string): boolean {
  const lower = name.toLowerCase()
  if (POWERSHELL_EXECUTABLES.has(lower)) {
    return true
  }
  // 从路径提取基名（同时支持 / 和 \ 分隔符）
  const lastSep = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'))
  if (lastSep >= 0) {
    return POWERSHELL_EXECUTABLES.has(lower.slice(lastSep + 1))
  }
  return false
}

/**
 * PowerShell 接受的替代参数前缀字符，等价于
// ASCII hyphen-minus（U+002D）。PowerShell 的 tokenizer
//（SpecialCharacters.IsDash）和 powershell.exe 的 CommandLineParameterParser 都接受所有四种横杠
// 字符加上 Windows PowerShell 5.1 的 `/` 参数分隔符。
// Extent.Text 保留原始字符；transformCommandAst 对
// CommandParameterAst 元素使用 ce.text，因此这些原封不动到达我们。
 */
const PS_ALT_PARAM_PREFIXES = new Set([
  '/', // Windows PowerShell 5.1（powershell.exe，非 pwsh 7+）
  '–', // en-dash
  '—', // em-dash
  '―', // horizontal bar
])

/**
 * commandHasArgAbbreviation 的包装器，还匹配替代
// 参数前缀（`/`、en-dash、em-dash、horizontal-bar）。PowerShell 的
// tokenizer（SpecialCharacters.IsDash）对 powershell.exe
// 参数和 cmdlet 参数都接受这些，因此对所有 PS 参数检查使用此函数 — 不仅
// 是 pwsh.exe 调用。之前 checkComObject/checkStartProcess/
// checkDangerousFilePathExecution/checkForEachMemberName 使用裸
// commandHasArgAbbreviation，因此 `Start-Process foo –Verb RunAs` 绕过。
 */
function psExeHasParamAbbreviation(
  cmd: ParsedCommandElement,
  fullParam: string,
  minPrefix: string,
): boolean {
  if (commandHasArgAbbreviation(cmd, fullParam, minPrefix)) {
    return true
  }
  // 将替代前缀规范化为 `-` 并重新检查。构建合成的 cmd
  // 带规范化参数；commandHasArgAbbreviation 处理冒号值分割。
  const normalized: ParsedCommandElement = {
    ...cmd,
    args: cmd.args.map(a =>
      a.length > 0 && PS_ALT_PARAM_PREFIXES.has(a[0]!) ? '-' + a.slice(1) : a,
    ),
  }
  return commandHasArgAbbreviation(normalized, fullParam, minPrefix)
}

/**
 * 检查 PowerShell 命令是否使用 Invoke-Expression 或其别名（iex）。
 * 这些等价于 eval，可以执行任意代码。
 */
function checkInvokeExpression(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (hasCommandNamed(parsed, 'Invoke-Expression')) {
    return {
      behavior: 'ask',
      message: '命令使用 Invoke-Expression，它可以执行任意代码',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查动态命令调用，其中命令名本身是
// 无法静态解析的表达式。
 *
 * PoC：
 *   & ${function:Invoke-Expression} 'payload'  — VariableExpressionAst
 *   & ('iex','x')[0] 'payload'                 — IndexExpressionAst → 'Other'
 *   & ('i'+'ex') 'payload'                     — BinaryExpressionAst → 'Other'
 *
 * 在所有情况下 cmd.name 是字面范围文本（例如 "('iex','x')[0]"），
// 它不匹配 hasCommandNamed('Invoke-Expression')。在运行时，
 * PowerShell 将表达式求值为命令名并调用它。
 *
 * 合法命令名总是 StringConstantExpressionAst（映射到
// 'StringConstant'）：`Get-Process`、`git`、`ls`。名称位置的任何其他元素类型都是动态的。我们不使用动态类型黑名单（脆弱 —
 * mapElementType 的默认情况将未知 AST 类型映射到 'Other'，`=== 'Variable'` 检查遗漏），而是使用 'StringConstant' 白名单。
 *
 * elementTypes[0] 是命令名元素（transformCommandAst 先推送它，
// 在参数元素之前）。`!== undefined` 防护在
// elementTypes 缺失时保留故障开放（解析详情不可用 — 如果解析完全失败，valid=false 已经在链中更早返回 '询问'）。
 */
function checkDynamicCommandName(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    if (cmd.elementType !== 'CommandAst') {
      continue
    }
    const nameElementType = cmd.elementTypes?.[0]
    if (nameElementType !== undefined && nameElementType !== 'StringConstant') {
      return {
        behavior: 'ask',
        message: '命令名是动态表达式，无法静态验证',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查编码命令参数，它掩盖意图。
 * 这些通常用于恶意软件以绕过安全工具。
 */
function checkEncodedCommand(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    if (isPowerShellExecutable(cmd.name)) {
      if (psExeHasParamAbbreviation(cmd, '-encodedcommand', '-e')) {
        return {
          behavior: 'ask',
          message: '命令使用编码参数，掩盖意图',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 PowerShell 重调用（嵌套 pwsh/powershell 进程）。
 *
 * 命令位置中的任何 PowerShell 可执行文件都被标记 — 不仅仅是
// -Command/-File。接收 stdin（`Get-Content x | pwsh`）的裸 `pwsh` 或
// 位置脚本路径在无显式
// 标志的情况下执行任意代码。与 checkStartProcess 向量 2 相同的不可验证嵌套进程理由：我们无法静态分析子进程将运行什么。
 */
function checkPwshCommandOrFile(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    if (isPowerShellExecutable(cmd.name)) {
      return {
        behavior: 'ask',
        message: '命令派生无法验证的嵌套 PowerShell 进程',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查下载摇篮模式 - 常见恶意软件技术，
 * 下载并执行远程代码。
 *
 * 每个语句：捕获管道摇篮（`IWR ... | IEX`）。
 * 跨语句：捕获分割摇篮（`$r = IWR ...; IEX $r.Content`）。
 * 跨语句情况已被 checkInvokeExpression（它
 * 扫描所有语句）阻止，但此检查改进了警告消息。
 */
const DOWNLOADER_NAMES = new Set([
  'invoke-webrequest',
  'iwr',
  'invoke-restmethod',
  'irm',
  'new-object',
  'start-bitstransfer', // MITRE T1197
])

function isDownloader(name: string): boolean {
  return DOWNLOADER_NAMES.has(name.toLowerCase())
}

function isIex(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === 'invoke-expression' || lower === 'iex'
}

function checkDownloadCradles(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 每个语句：管道摇篮（IWR ... | IEX）
  for (const statement of parsed.statements) {
    const cmds = statement.commands
    if (cmds.length < 2) {
      continue
    }
    const hasDownloader = cmds.some(cmd => isDownloader(cmd.name))
    const hasIex = cmds.some(cmd => isIex(cmd.name))
    if (hasDownloader && hasIex) {
      return {
        behavior: 'ask',
        message: '命令下载并执行远程代码',
      }
    }
  }

  // 跨语句：分割摇篮（$r = IWR ...; IEX $r.Content）。
  // 无新误报：如果 IEX 存在，checkInvokeExpression 已经询问。
  const all = getAllCommands(parsed)
  if (all.some(c => isDownloader(c.name)) && all.some(c => isIex(c.name))) {
    return {
      behavior: 'ask',
      message: '命令下载并执行远程代码',
    }
  }

  return { behavior: 'passthrough' }
}

/**
 * 检查独立下载工具 — LOLBAS 工具常用于
 * 获取有效载荷。与 checkDownloadCradles（需要下载 + IEX
// 在管道中）不同，此检查标记下载操作本身。
 *
 * Start-BitsTransfer：始终是文件传输（MITRE T1197）。
 * certutil -urlcache：经典 LOLBAS 下载。只在带 -urlcache 时标记；
 * 裸 `certutil` 有许多合法证书管理用途。
 * bitsadmin /transfer：遗留 BITS 下载（PowerShell 之前）。
 */
function checkDownloadUtilities(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    // Start-BitsTransfer 专为文件传输而构建 — 无安全变体。
    if (lower === 'start-bitstransfer') {
      return {
        behavior: 'ask',
        message: '命令通过 BITS 传输下载文件',
      }
    }
    // certutil / certutil.exe — 仅当存在 -urlcache。certutil 有
    // 许多非下载用途（证书存储查询、编码等）。
    // certutil.exe 根据标准 Windows
    // 工具约定同时接受 -urlcache 和 /urlcache — 检查两种形式（下方的 bitsadmin 同样）。
    if (lower === 'certutil' || lower === 'certutil.exe') {
      const hasUrlcache = cmd.args.some(a => {
        const la = a.toLowerCase()
        return la === '-urlcache' || la === '/urlcache'
      })
      if (hasUrlcache) {
        return {
          behavior: 'ask',
          message: '命令使用 certutil 从 URL 下载',
        }
      }
    }
    // bitsadmin /transfer — 遗留 BITS CLI，与 Start-BitsTransfer 相同威胁。
    if (lower === 'bitsadmin' || lower === 'bitsadmin.exe') {
      if (cmd.args.some(a => a.toLowerCase() === '/transfer')) {
        return {
          behavior: 'ask',
          message: '命令通过 BITS 传输下载文件',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 Add-Type 使用，它在运行时编译并加载 .NET 代码。
 * 这可用于执行任意编译代码。
 */
function checkAddType(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (hasCommandNamed(parsed, 'Add-Type')) {
    return {
      behavior: 'ask',
      message: '命令编译并加载 .NET 代码',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 New-Object -ComObject。像 WScript.Shell、
 * Shell.Application、MMC20.Application、Schedule.Service、Msxml2.XMLHTTP 这样的 COM 对象
 * 有自己的执行/下载能力 — 无需 IEX。
 *
 * 我们无法枚举所有危险 ProgID，因此标记任何 -ComObject。对象
 * 创建本身是惰性的，但提示应警告用户 COM
 * 实例化是执行原语。结果上的方法调用
 *（.Run()、.Exec()）由 checkMemberInvocations 独立捕获。
 */
function checkComObject(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    if (cmd.name.toLowerCase() !== 'new-object') {
      continue
    }
    // -ComObject 最小缩写是 -com（New-Object 参数：-TypeName、-ComObject、
    // -ArgumentList、-Property、-Strict；-co 在 PS5.1 中因
    // 通用参数如 -Confirm 而有歧义，因此使用 -com）。
    if (psExeHasParamAbbreviation(cmd, '-comobject', '-com')) {
      return {
        behavior: 'ask',
        message: '命令实例化 COM 对象，可能具有执行能力',
      }
    }
    // 安全检查：checkTypeLiterals 只看到来自
    // parsed.typeLiterals 的 [bracket] 语法。`New-Object System.Net.WebClient` 将类型作为
    // STRING ARG（StringConstantExpressionAst）传递，非 TypeExpressionAst，
    // 因此 CLM 从不触发。提取 -TypeName（命名、冒号绑定或
    // 位置 0）并通过 isClmAllowedType 运行。关闭 attackVectors D4。
    let typeName: string | undefined
    for (let i = 0; i < cmd.args.length; i++) {
      const a = cmd.args[i]!
      const lower = a.toLowerCase()
      // -TypeName 缩写：-t 是明确的（无其他 New-Object -t* 参数）。
      // 先处理冒号绑定形式：-TypeName:Foo.Bar
      if (lower.startsWith('-t') && lower.includes(':')) {
        const colonIdx = a.indexOf(':')
        const paramPart = lower.slice(0, colonIdx)
        if ('-typename'.startsWith(paramPart)) {
          typeName = a.slice(colonIdx + 1)
          break
        }
      }
      // 空格分隔形式：-TypeName Foo.Bar
      if (
        lower.startsWith('-t') &&
        '-typename'.startsWith(lower) &&
        cmd.args[i + 1] !== undefined
      ) {
        typeName = cmd.args[i + 1]
        break
      }
    }
    // 位置 0 绑定到 -TypeName（NetParameterSet 默认）。命名参数
    //（-Strict、-ArgumentList、-Property、-ComObject）可能在位置
    // TypeName 之前出现，因此扫描过去它们以找到第一个未消费参数。
    if (typeName === undefined) {
      // New-Object 命名参数消费后续值参数
      const VALUE_PARAMS = new Set(['-argumentlist', '-comobject', '-property'])
      // 开关参数（无值参数）
      const SWITCH_PARAMS = new Set(['-strict'])
      for (let i = 0; i < cmd.args.length; i++) {
        const a = cmd.args[i]!
        if (a.startsWith('-')) {
          const lower = a.toLowerCase()
          // 跳过 -TypeName 变体（已由上方命名参数循环处理）
          if (lower.startsWith('-t') && '-typename'.startsWith(lower)) {
            i++ // 跳过值
            continue
          }
          // 冒号绑定形式：-Param:Value（单个 token，无需跳过）
          if (lower.includes(':')) continue
          if (SWITCH_PARAMS.has(lower)) continue
          if (VALUE_PARAMS.has(lower)) {
            i++ // 跳过值
            continue
          }
          // 未知参数 — 保守跳过
          continue
        }
        // 第一个非横杠参数是位置 TypeName
        typeName = a
        break
      }
    }
    if (typeName !== undefined && !isClmAllowedType(typeName)) {
      return {
        behavior: 'ask',
        message: `New-Object 实例化 .NET 类型 '${typeName}'，在 ConstrainedLanguage 白名单之外`,
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查带 -FilePath（或
// -LiteralPath）调用的 DANGEROUS_SCRIPT_BLOCK_CMDLETS。这些运行脚本文件 — 任意代码执行，树中无
// ScriptBlockAst。
 *
 * checkScriptBlockInjection 只在 hasScriptBlocks 为 true 时触发。带
// -FilePath 时无 ScriptBlockAst，因此 DANGEROUS_SCRIPT_BLOCK_CMDLETS 从不
// 被咨询。此检查为 -FilePath 向量关闭该差距。
 *
 * DANGEROUS_SCRIPT_BLOCK_CMDLETS 中接受 -FilePath 的 cmdlet：
 *   Invoke-Command   -FilePath            （通过 COMMON_ALIASES 的 icm 别名）
 *   Start-Job        -FilePath、-LiteralPath
 *   Start-ThreadJob  -FilePath
 *   Register-ScheduledJob -FilePath
 * *-PSSession 和 Register-*Event 条目不接受 -FilePath。
 *
 * -f 对所有四个都是明确的 -FilePath（无其他 -f* 参数）。
 * -l 对 Start-Job 的 -LiteralPath 明确；在
 * 其他上是无害无操作（无 -l* 参数冲突）。
 */

function checkDangerousFilePathExecution(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    const resolved = COMMON_ALIASES[lower]?.toLowerCase() ?? lower
    if (!FILEPATH_EXECUTION_CMDLETS.has(resolved)) {
      continue
    }
    if (
      psExeHasParamAbbreviation(cmd, '-filepath', '-f') ||
      psExeHasParamAbbreviation(cmd, '-literalpath', '-l')
    ) {
      return {
        behavior: 'ask',
        message: `${cmd.name} -FilePath 执行任意脚本文件`,
      }
    }
    // 位置绑定：`Start-Job script.ps1` 通过 FilePathParameterSet 解析将位置 0 绑定到
    // -FilePath（ScriptBlock 参数选择
    // ScriptBlockParameterSet）。与 checkForEachMemberName 相同模式：
    // 任何非横杠 StringConstant 是潜在 -FilePath。过度标记
    //（例如 `Start-Job -Name foo` 其中 `foo` 是 StringConstant）是安全失败。
    for (let i = 0; i < cmd.args.length; i++) {
      const argType = cmd.elementTypes?.[i + 1]
      const arg = cmd.args[i]
      if (argType === 'StringConstant' && arg && !arg.startsWith('-')) {
        return {
          behavior: 'ask',
          message: `${cmd.name} 带位置字符串参数绑定到 -FilePath 并执行脚本文件`,
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查 ForEach-Object -MemberName。在每个管道对象上按字符串名调用方法 — 语义上等价于 `| % { $_.Method() }`，
 * 但树中无 ScriptBlockAst 或 InvokeMemberExpressionAst。
 *
 * PoC：`Get-Process | ForEach-Object -MemberName Kill` → 杀死所有进程。
 * checkScriptBlockInjection 遗漏它（无脚本块）；checkMemberInvocations
 * 遗漏它（无 .Method() 语法）。别名 `%` 和 `foreach` 通过
 * COMMON_ALIASES 解析。
 */
function checkForEachMemberName(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    const resolved = COMMON_ALIASES[lower]?.toLowerCase() ?? lower
    if (resolved !== 'foreach-object') {
      continue
    }
    // ForEach-Object 以 -m 开头的参数：只有 -MemberName。-m 明确。
    if (psExeHasParamAbbreviation(cmd, '-membername', '-m')) {
      return {
        behavior: 'ask',
        message: 'ForEach-Object -MemberName 按字符串名调用方法，无法验证',
      }
    }
    // PS7+：`ForEach-Object Kill` 通过 MemberSet 参数集解析将位置字符串参数绑定到
    // -MemberName（ScriptBlock 参数选择
    // ScriptBlockSet）。扫描所有参数 — `-Verbose Kill` 或
    // `-ErrorAction Stop Kill` 仍位置绑定 Kill。任何非横杠
    // StringConstant 是潜在 -MemberName；过度标记是安全失败。
    for (let i = 0; i < cmd.args.length; i++) {
      const argType = cmd.elementTypes?.[i + 1]
      const arg = cmd.args[i]
      if (argType === 'StringConstant' && arg && !arg.startsWith('-')) {
        return {
          behavior: 'ask',
          message:
            'ForEach-Object 带位置字符串参数绑定到 -MemberName 并按名调用方法',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 检查危险 Start-Process 模式。
 *
 * 两个向量：
 * 1. `-Verb RunAs` — 特权提升（UAC 提示）。
 * 2. 启动 PowerShell 可执行文件 — 嵌套调用。
 * `Start-Process pwsh -ArgumentList "-e <b64>"` 逃避
 * checkEncodedCommand/checkPwshCommandOrFile，因为 cmd.name 是
 * `Start-Process`，非 `pwsh`。`-e` 位于 -ArgumentList
 * 字符串值内，从不作为外部命令的参数解析。
 * 与其解析 -ArgumentList 内容（脆弱 — 它是不透明
 * 字符串或数组），标记任何目标是 PS
 * 可执行文件的 Start-Process：嵌套调用按构造不可验证。
 */
function checkStartProcess(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (lower !== 'start-process' && lower !== 'saps' && lower !== 'start') {
      continue
    }
    // 向量 1：-Verb RunAs（空格或冒号语法）。
    // 空格语法：psExeHasParamAbbreviation 找到 -Verb/-v，然后扫描参数
    // 查找裸 'runas' token。
    if (
      psExeHasParamAbbreviation(cmd, '-Verb', '-v') &&
      cmd.args.some(a => a.toLowerCase() === 'runas')
    ) {
      return {
        behavior: 'ask',
        message: '命令请求提升的特权',
      }
    }
    // 冒号语法 — 两层：
    //（a）结构性：PR #23554 为冒号绑定参数添加了 children[]。
    //    children[i] = [{type, text}] 用于绑定值。检查任何
    //    -v* 前缀参数是否有其文本规范化（剥离
    //    引号/反引号/空白）为 'runas' 的子项。健壮对抗任意
    //    正则无法预期的引号。
    //（b）正则回退：对于不带 children[] 的解析输出或作为
    //    纵深防御。-Verb:'RunAs'、-Verb:"RunAs"、-Verb:`runas 都
    //    绕过旧的 /...:runas$/ 模式，因为引号/tick 打破
    //    匹配。
    if (cmd.children) {
      for (let i = 0; i < cmd.args.length; i++) {
        // 匹配参数名前剥离反引号（bug #14）：-V`erb:RunAs
        const argClean = cmd.args[i]!.replace(/`/g, '')
        if (!/^[-–—―/]v[a-z]*:/i.test(argClean)) continue
        const kids = cmd.children[i]
        if (!kids) continue
        for (const child of kids) {
          if (child.text.replace(/['"`\s]/g, '').toLowerCase() === 'runas') {
            return {
              behavior: 'ask',
              message: '命令请求提升的特权',
            }
          }
        }
      }
    }
    if (
      cmd.args.some(a => {
        // 匹配前剥离反引号（bug #14 / 评审 nit #2）
        const clean = a.replace(/`/g, '')
        return /^[-–—―/]v[a-z]*:['"` ]*runas['"` ]*$/i.test(clean)
      })
    ) {
      return {
        behavior: 'ask',
        message: '命令请求提升的特权',
      }
    }
    // 向量 2：针对 PowerShell 可执行文件的 Start-Process。
    // 目标要么是第一个位置参数，要么是 -FilePath 之后的值。
    // 扫描所有参数 — 任何 PS 可执行文件 token 都被视为启动
    // 目标。已知误报：路径值参数（-WorkingDirectory、
    // -RedirectStandard*）其基名是 pwsh/powershell —
    // isPowerShellExecutable 从路径提取基名，因此
    // `-WorkingDirectory C:\projects\pwsh` 触发。接受的权衡：
    // Start-Process 不在 CMDLET_ALLOWLIST 中（总是提示），
    // 结果是询问而非拒绝，并且正确解析 Start-Process 参数
    // 绑定是脆弱的。剥离解析器可能保留的引号。
    for (const arg of cmd.args) {
      const stripped = arg.replace(/^['"]|['"]$/g, '')
      if (isPowerShellExecutable(stripped)) {
        return {
          behavior: 'ask',
          message: 'Start-Process 启动无法验证的嵌套 PowerShell 进程',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 脚本块安全的 cmdlet（过滤/输出 cmdlet）。
 * 管道到这些的脚本块只是谓词或投影，不是任意执行。
 */
const SAFE_SCRIPT_BLOCK_CMDLETS = new Set([
  'where-object',
  'sort-object',
  'select-object',
  'group-object',
  'format-table',
  'format-list',
  'format-wide',
  'format-custom',
  // 不是 foreach-object — 其块是任意脚本，非谓词。
  // getAllCommands 递归，因此块内的命令都被检查，但
  // 非命令 AST 节点（AssignmentStatementAst 等）对它不可见。
  // 见 powershellPermissions.ts 步骤 5 hasScriptBlocks 防护。
])

/**
 * 检查脚本块注入模式，其中脚本块
 * 出现在可能执行任意代码的可疑上下文中。
 *
 * 与安全过滤/输出 cmdlet（Where-Object、
 * Sort-Object、Select-Object、Group-Object）一起使用的脚本块被允许。
 * 与危险 cmdlet（Invoke-Command、Invoke-Expression、
 * Start-Job 等）一起使用的脚本块被标记。
 */
function checkScriptBlockInjection(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  const security = deriveSecurityFlags(parsed)
  if (!security.hasScriptBlocks) {
    return { behavior: 'passthrough' }
  }

  // 检查解析结果中的所有命令。如果任何命令在
  // 危险集合中，标记它。如果所有带脚本块的命令在
  // 安全集合中（或白名单），允许它。
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (DANGEROUS_SCRIPT_BLOCK_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message: '命令包含带危险 cmdlet 的脚本块，可能执行任意代码',
      }
    }
  }

  // 检查所有命令是否都是安全脚本块消费者或不使用脚本块
  const allCommandsSafe = getAllCommands(parsed).every(cmd => {
    const lower = cmd.name.toLowerCase()
    // 安全过滤/输出 cmdlet
    if (SAFE_SCRIPT_BLOCK_CMDLETS.has(lower)) {
      return true
    }
    // 解析别名
    const alias = COMMON_ALIASES[lower]
    if (alias && SAFE_SCRIPT_BLOCK_CMDLETS.has(alias.toLowerCase())) {
      return true
    }
    // 带脚本块的未知命令 — 标记为潜在危险
    return false
  })

  if (allCommandsSafe) {
    return { behavior: 'passthrough' }
  }

  return {
    behavior: 'ask',
    message: '命令包含可能执行任意代码的脚本块',
  }
}

/**
 * 仅 AST 检查：检测子表达式 $()，它可以隐藏命令执行。
 */
function checkSubExpressions(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasSubExpressions) {
    return {
      behavior: 'ask',
      message: '命令包含子表达式 $()',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 仅 AST 检查：检测带嵌入
 * 表达式（如 "$env:PATH" 或 "$(dangerous-command)"）的可展开字符串（双引号）。这些可以隐藏
 * 字符串字面量内的命令执行或变量插值。
 */
function checkExpandableStrings(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasExpandableStrings) {
    return {
      behavior: 'ask',
      message: '命令包含带嵌入表达式的可展开字符串',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 仅 AST 检查：检测 splatting（@variable），它可以掩盖参数。
 */
function checkSplatting(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasSplatting) {
    return {
      behavior: 'ask',
      message: '命令使用 splatting（@variable）',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 仅 AST 检查：检测停止解析 token（--%），它阻止进一步解析。
 */
function checkStopParsing(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasStopParsing) {
    return {
      behavior: 'ask',
      message: '命令使用停止解析 token（--%）',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 仅 AST 检查：检测 .NET 方法调用，它们可以访问系统 API。
 */
function checkMemberInvocations(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  if (deriveSecurityFlags(parsed).hasMemberInvocations) {
    return {
      behavior: 'ask',
      message: '命令调用 .NET 方法',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 仅 AST 检查：Microsoft 的 ConstrainedLanguage 白名单之外的类型字面量。
 * CLM 屏蔽所有 .NET 类型访问，除了约 90 个
 * Microsoft 认为对不可信代码安全的原语/属性。我们信任该列表作为
//"安全"边界 — 它之外的任何内容（Reflection.Assembly、IO.Pipes、
 * Diagnostics.Process、InteropServices.Marshal 等）都可以访问
// 危及权限模型的系统 API。
 *
 * 在 checkMemberInvocations 之后运行：它广泛标记任何 ::Method / .Method()
// 调用；此检查是更具体的"哪些类型"信号。两者都在
// [Reflection.Assembly]::Load 上触发；CLM 给出精确消息。纯类型强转
// 如 [int]$x 无成员调用，只命中此检查。
 */
function checkTypeLiterals(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const t of parsed.typeLiterals ?? []) {
    if (!isClmAllowedType(t)) {
      return {
        behavior: 'ask',
        message: `命令使用 .NET 类型 [${t}]，在 ConstrainedLanguage 白名单之外`,
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * Invoke-Item（别名 ii）以默认处理程序打开文件（Windows 上 ShellExecute，
 * Unix 上 open/xdg-open）。在 .exe/.ps1/.bat/.cmd 上这是 RCE。
 * Bug 008：ii 不在任何黑名单中；穿透提示不解释
 * 执行风险。总是询问 — 无安全变体（即使打开 .txt 也可能
 * 调用接受参数的用户配置处理程序）。
 */
function checkInvokeItem(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (lower === 'invoke-item' || lower === 'ii') {
      return {
        behavior: 'ask',
        message:
          'Invoke-Item 以默认处理程序打开文件（ShellExecute）。在可执行文件上它运行任意代码。',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 计划任务持久化原语。Register-ScheduledJob 被阻止
 *（DANGEROUS_SCRIPT_BLOCK_CMDLETS）；较新的 Register-ScheduledTask cmdlet
 * 和遗留 schtasks.exe /create 未被。持久化在会话之外
 * 无解释性提示。
 */
const SCHEDULED_TASK_CMDLETS = new Set([
  'register-scheduledtask',
  'new-scheduledtask',
  'new-scheduledtaskaction',
  'set-scheduledtask',
])

function checkScheduledTask(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (SCHEDULED_TASK_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message: `${cmd.name} 创建或修改计划任务（持久化原语）`,
      }
    }
    if (lower === 'schtasks' || lower === 'schtasks.exe') {
      if (
        cmd.args.some(a => {
          const la = a.toLowerCase()
          return (
            la === '/create' ||
            la === '/change' ||
            la === '-create' ||
            la === '-change'
          )
        })
      ) {
        return {
          behavior: 'ask',
          message: 'schtasks 带 create/change 修改计划任务（持久化原语）',
        }
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 仅 AST 检查：通过 env: 作用域上的 Set-Item/New-Item 检测环境变量操作。
 */
const ENV_WRITE_CMDLETS = new Set([
  'set-item',
  'si',
  'new-item',
  'ni',
  'remove-item',
  'ri',
  'del',
  'rm',
  'rd',
  'rmdir',
  'erase',
  'clear-item',
  'cli',
  'set-content',
  // 'sc' 省略 — 在 PS Core 7+ 上与 sc.exe 冲突，见 COMMON_ALIASES 注释
  'add-content',
  'ac',
])

function checkEnvVarManipulation(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  const envVars = getVariablesByScope(parsed, 'env')
  if (envVars.length === 0) {
    return { behavior: 'passthrough' }
  }
  // 检查任何命令是否是写入 cmdlet
  for (const cmd of getAllCommands(parsed)) {
    if (ENV_WRITE_CMDLETS.has(cmd.name.toLowerCase())) {
      return {
        behavior: 'ask',
        message: '命令修改环境变量',
      }
    }
  }
  // 如果有涉及环境变量的赋值也标记
  if (deriveSecurityFlags(parsed).hasAssignments && envVars.length > 0) {
    return {
      behavior: 'ask',
      message: '命令修改环境变量',
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * 模块加载 cmdlet 执行 .psm1 的顶级脚本体（Import-Module）
 * 或从任意仓库下载（Install-Module、Save-Module）。像
 * `Import-Module:*` 的通配符允许规则会让攻击者提供的
 * .psm1 以用户特权执行 — 与 Invoke-Expression 相同风险。
 *
 * NEVER_SUGGEST（dangerousCmdlets.ts）从此列表派生，因此 UI
 * 从不将这些作为通配符建议提供，但用户仍可手动
 * 编写允许规则。此检查确保权限引擎独立
 * 门控这些 cmdlet。
 */

function checkModuleLoading(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (MODULE_LOADING_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message:
          '命令加载、安装或下载 PowerShell 模块或脚本，它可以执行任意代码',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * Set-Alias/New-Alias 可以劫持未来的命令解析：在
 * `Set-Alias Get-Content Invoke-Expression` 之后，任何后续的 `Get-Content $x`
 * 执行任意代码。Set-Variable/New-Variable 可以毒化
 * `$PSDefaultParameterValues`（例如 `Set-Variable PSDefaultParameterValues
 * @{'*:Path'='/etc/passwd'}`），这改变每个后续 cmdlet 的行为。
 * 两者都无法静态验证 — 我们需要跟踪会话中所有未来
 * 命令解析。总是询问。
 */
const RUNTIME_STATE_CMDLETS = new Set([
  'set-alias',
  'sal',
  'new-alias',
  'nal',
  'set-variable',
  'sv',
  'new-variable',
  'nv',
])

function checkRuntimeStateManipulation(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    // 剥离模块限定符：`Microsoft.PowerShell.Utility\Set-Alias` → `set-alias`
    const raw = cmd.name.toLowerCase()
    const lower = raw.includes('\\')
      ? raw.slice(raw.lastIndexOf('\\') + 1)
      : raw
    if (RUNTIME_STATE_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message: '命令创建或修改可能影响未来命令解析的别名或变量',
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * Invoke-WmiMethod / Invoke-CimMethod 是通过 WMI 的 Start-Process 等价物。
 * `Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList "cmd /c ..."`
 * 派生任意进程，完全绕过 checkStartProcess。无窄
 * 安全使用存在 — -Class 和 -MethodName 接受任意字符串，因此
 * 仅门控 Win32_Process 会遗漏 -Class $x 或其他进程派生
 * WMI 类。对任何调用返回询问。（安全发现 #34）
 */
const WMI_SPAWN_CMDLETS = new Set([
  'invoke-wmimethod',
  'iwmi',
  'invoke-cimmethod',
])

function checkWmiProcessSpawn(
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  for (const cmd of getAllCommands(parsed)) {
    const lower = cmd.name.toLowerCase()
    if (WMI_SPAWN_CMDLETS.has(lower)) {
      return {
        behavior: 'ask',
        message: `${cmd.name} 可以通过 WMI/CIM（Win32_Process Create）派生任意进程`,
      }
    }
  }
  return { behavior: 'passthrough' }
}

/**
 * PowerShell 安全验证的主入口点。
 * 针对已知危险模式检查 PowerShell 命令。
 *
 * 所有检查都基于 AST。如果 AST 解析失败（parsed.valid === false），
 * 单个检查都不匹配，我们作为安全默认返回 '询问'。
 *
 * @param command - 要验证的 PowerShell 命令（未使用，保留用于 API 兼容）
 * @param parsed - 来自 PowerShell 原生解析器的解析 AST（必需）
 * @returns 指示命令是否安全的安全结果
 */
export function powershellCommandIsSafe(
  _command: string,
  parsed: ParsedPowerShellCommand,
): PowerShellSecurityResult {
  // 如果 AST 解析失败，我们无法确定安全性 — 询问用户
  if (!parsed.valid) {
    return {
      behavior: 'ask',
      message: '无法解析命令进行安全分析',
    }
  }

  const validators = [
    checkInvokeExpression,
    checkDynamicCommandName,
    checkEncodedCommand,
    checkPwshCommandOrFile,
    checkDownloadCradles,
    checkDownloadUtilities,
    checkAddType,
    checkComObject,
    checkDangerousFilePathExecution,
    checkInvokeItem,
    checkScheduledTask,
    checkForEachMemberName,
    checkStartProcess,
    checkScriptBlockInjection,
    checkSubExpressions,
    checkExpandableStrings,
    checkSplatting,
    checkStopParsing,
    checkMemberInvocations,
    checkTypeLiterals,
    checkEnvVarManipulation,
    checkModuleLoading,
    checkRuntimeStateManipulation,
    checkWmiProcessSpawn,
  ]

  for (const validator of validators) {
    const result = validator(parsed)
    if (result.behavior === 'ask') {
      return result
    }
  }

  // 所有检查通过
  return { behavior: 'passthrough' }
}
