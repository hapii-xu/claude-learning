/**
 * PowerShell 权限模式验证。
 *
 * 根据当前权限模式检查命令是否应被自动允许。
 * 在 acceptEdits 模式下，修改文件系统的 PowerShell cmdlet 会被自动允许。
 * 遵循与 BashTool/modeValidation.ts 相同的模式。
 */

import type { ToolPermissionContext } from 'src/Tool.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import type { ParsedPowerShellCommand } from 'src/utils/powershell/parser.js'
import {
  deriveSecurityFlags,
  getPipelineSegments,
  PS_TOKENIZER_DASH_CHARS,
} from 'src/utils/powershell/parser.js'
import {
  argLeaksValue,
  isAllowlistedPipelineTail,
  isCwdChangingCmdlet,
  isSafeOutputCommand,
  resolveToCanonical,
} from './readOnlyValidation.js'

/**
 * 在 acceptEdits 模式下自动允许的文件系统修改 cmdlet。
 * 以规范（小写）cmdlet 名存储。
 *
 * 具有复杂参数绑定的 Tier 3 cmdlet 已移除 — 它们会回退到
 * '询问'。只有简单的写入 cmdlet（第一个位置参数 = -Path）在此处自动允许，
 * 并且它们通过 pathValidation.ts 中的 CMDLET_PATH_CONFIG 进行路径验证。
 */
const ACCEPT_EDITS_ALLOWED_CMDLETS = new Set([
  'set-content',
  'add-content',
  'remove-item',
  'clear-content',
])

function isAcceptEditsAllowedCmdlet(name: string): boolean {
  // resolveToCanonical 通过 COMMON_ALIASES 处理别名，例如 'rm' → 'remove-item'，
  // 'ac' → 'add-content'。任何解析到允许 cmdlet 的别名都会自动允许。
  // Tier 3 cmdlet（new-item、copy-item、move-item 等）及其别名
  //（mkdir、ni、cp、mv 等）解析到不在集合中的 cmdlet，回退到'询问'。
  const canonical = resolveToCanonical(name)
  return ACCEPT_EDITS_ALLOWED_CMDLETS.has(canonical)
}

/**
 * 创建文件系统链接（重解析点或硬链接）的 New-Item -ItemType 值。
 * 这三者都在运行时重定向路径解析 — 符号链接和 junction 是目录/文件重解析点；
 * 硬链接为文件的 inode 起别名。其中任何一个都会让后续的相对路径写入
 * 落到验证器视图之外。
 */
const LINK_ITEM_TYPES = new Set(['symboliclink', 'junction', 'hardlink'])

/**
 * 检查一个小写的、横杠规范化的参数（冒号值已剥离）是否是
 * New-Item 的 -ItemType 或 -Type 参数的明确 PowerShell 缩写。
 * 最小前缀：`-it`（避免与其他 New-Item 参数歧义），`-ty`
 *（避免 `-t` 与 `-Target` 冲突）。
 */
function isItemTypeParamAbbrev(p: string): boolean {
  return (
    (p.length >= 3 && '-itemtype'.startsWith(p)) ||
    (p.length >= 3 && '-type'.startsWith(p))
  )
}

/**
 * 检测 New-Item 是否创建文件系统链接（-ItemType SymbolicLink /
 * Junction / HardLink，或 -Type 别名）。链接会以与
 * Set-Location/New-PSDrive 相同的方式毒化后续路径解析：通过链接的相对路径
 * 解析到链接目标，而非验证器视图。发现 #18。
 *
 * 处理 PS 参数缩写（`-it`、`-ite`、... `-itemtype`；`-ty`、
 * `-typ`、`-type`），unicode 横杠前缀（en-dash/em-dash/horizontal-bar），
 * 以及冒号绑定值（`-it:Junction`）。
 */
export function isSymlinkCreatingCommand(cmd: {
  name: string
  args: string[]
}): boolean {
  const canonical = resolveToCanonical(cmd.name)
  if (canonical !== 'new-item') return false
  for (let i = 0; i < cmd.args.length; i++) {
    const raw = cmd.args[i] ?? ''
    if (raw.length === 0) continue
    // 规范化 unicode 横杠前缀（–、—、―）和正斜杠（PS 5.1
    // 参数前缀）→ ASCII `-`，使前缀比较生效。PS tokenizer
    // 将所有四种横杠字符加上 `/` 视为参数标记。（bug #26）
    const normalized =
      PS_TOKENIZER_DASH_CHARS.has(raw[0]!) || raw[0] === '/'
        ? '-' + raw.slice(1)
        : raw
    const lower = normalized.toLowerCase()
    // 分割冒号绑定值：-it:SymbolicLink → 参数='-it'，值='symboliclink'
    const colonIdx = lower.indexOf(':', 1)
    const paramRaw = colonIdx > 0 ? lower.slice(0, colonIdx) : lower
    // 剥离反引号转义：-Item`Type → -ItemType（bug #22）
    const param = paramRaw.replace(/`/g, '')
    if (!isItemTypeParamAbbrev(param)) continue
    const rawVal =
      colonIdx > 0
        ? lower.slice(colonIdx + 1)
        : (cmd.args[i + 1]?.toLowerCase() ?? '')
    // 从冒号绑定值剥离反引号转义：-it:Sym`bolicLink → symboliclink
    // 与 L103 的参数名剥离对称。空格分隔的参数使用 .value
    //（由 .NET 解析器解析反引号），但冒号绑定使用 .text（原始源码）。
    // 剥离外围引号：-it:'SymbolicLink' 或 -it:"Junction"（bug #6）
    const val = rawVal.replace(/`/g, '').replace(/^['"]|['"]$/g, '')
    if (LINK_ITEM_TYPES.has(val)) return true
  }
  return false
}

/**
 * 根据当前权限模式检查命令是否应不同地处理。
 *
 * 在 acceptEdits 模式下，自动允许修改文件系统的 PowerShell cmdlet。
 * 使用 AST 在检查白名单之前解析别名。
 *
 * @param input - PowerShell 命令输入
 * @param parsed - 命令的已解析 AST
 * @param toolPermissionContext - 包含模式和权限的上下文
 * @returns
 * - 'allow' 当当前模式允许自动批准时
 * - 'passthrough' 当没有模式特定处理适用时
 */
export function checkPermissionMode(
  input: { command: string },
  parsed: ParsedPowerShellCommand,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  // 跳过 bypass 和 dontAsk 模式（在其他地方处理）
  if (
    toolPermissionContext.mode === 'bypassPermissions' ||
    toolPermissionContext.mode === 'dontAsk'
  ) {
    return {
      behavior: 'passthrough',
      message: '模式在主权限流程中处理',
    }
  }

  if (toolPermissionContext.mode !== 'acceptEdits') {
    return {
      behavior: 'passthrough',
      message: '无需模式特定验证',
    }
  }

  // acceptEdits 模式：检查所有命令是否都是修改文件系统的 cmdlet
  if (!parsed.valid) {
    return {
      behavior: 'passthrough',
      message: '无法为未解析的命令验证模式',
    }
  }

  // 安全检查：检测子表达式、脚本块或成员调用，
  // 它们可能被用来通过 acceptEdits 模式走私任意代码。
  const securityFlags = deriveSecurityFlags(parsed)
  if (
    securityFlags.hasSubExpressions ||
    securityFlags.hasScriptBlocks ||
    securityFlags.hasMemberInvocations ||
    securityFlags.hasSplatting ||
    securityFlags.hasAssignments ||
    securityFlags.hasStopParsing ||
    securityFlags.hasExpandableStrings
  ) {
    return {
      behavior: 'passthrough',
      message: '命令包含需要批准的子表达式、脚本块或成员调用',
    }
  }

  const segments = getPipelineSegments(parsed)

  // 安全检查：有效解析但段为空 = 没有命令可检查，不自动允许
  if (segments.length === 0) {
    return {
      behavior: 'passthrough',
      message: '没有找到可验证 acceptEdits 模式的命令',
    }
  }

  // 安全检查：复合 cwd 不同步防护 — 与 BashTool 对等。
  // 当复合中的任何语句包含 Set-Location/Push-Location/Pop-Location
  //（或别名 cd、sl、chdir、pushd、popd）时，cwd 在语句之间会改变。
  // 路径验证针对过期的进程 cwd 解析相对路径，因此后续语句中的写入
  // cmdlet 针对与验证器检查的不同目录。
  // 示例：`Set-Location ./.hclaude; Set-Content ./settings.json '...'` — 验证器
  // 看到 ./settings.json 为 /project/settings.json，但 PowerShell 写入到
  // /project/.hclaude/settings.json。拒绝在包含 cwd 更改命令的复合中自动允许
  // 任何写入操作。这与 BashTool 的 compoundCommandHasCd 防护一致
  //（BashTool/pathValidation.ts:630-655）。
  const totalCommands = segments.reduce(
    (sum, seg) => sum + seg.commands.length,
    0,
  )
  if (totalCommands > 1) {
    let hasCdCommand = false
    let hasSymlinkCreate = false
    let hasWriteCommand = false
    for (const seg of segments) {
      for (const cmd of seg.commands) {
        if (cmd.elementType !== 'CommandAst') continue
        if (isCwdChangingCmdlet(cmd.name)) hasCdCommand = true
        if (isSymlinkCreatingCommand(cmd)) hasSymlinkCreate = true
        if (isAcceptEditsAllowedCmdlet(cmd.name)) hasWriteCommand = true
      }
    }
    if (hasCdCommand && hasWriteCommand) {
      return {
        behavior: 'passthrough',
        message:
          '复合命令包含目录更改命令（Set-Location/Push-Location/Pop-Location）和写入操作 — 无法自动允许，因为路径验证使用过期的 cwd',
      }
    }
    // 安全检查：链接创建复合防护（发现 #18）。与上方的 cd
    // 防护对称。`New-Item -ItemType SymbolicLink -Path ./link -Value /etc;
    // Get-Content ./link/passwd` — 路径验证针对 cwd 解析 ./link/passwd
    //（验证时该处无链接），但运行时跟随刚创建的链接到 /etc/passwd。
    // 与 cwd 不同步相同的 TOCTOU 形态。
    // 适用于 SymbolicLink、Junction 和 HardLink — 三者都在运行时重定向路径解析。
    // 不要求 `hasWriteCommand`：通过符号链接读取同样危险
    //（通过 Get-Content ./link/etc/shadow 泄露），并且在刚创建链接后使用路径的
    // 任何其他命令都无法验证。
    if (hasSymlinkCreate) {
      return {
        behavior: 'passthrough',
        message:
          '复合命令创建文件系统链接（New-Item -ItemType SymbolicLink/Junction/HardLink）— 无法自动允许，因为路径验证无法跟随刚创建的链接',
      }
    }
  }

  for (const segment of segments) {
    for (const cmd of segment.commands) {
      if (cmd.elementType !== 'CommandAst') {
        // 安全检查：此防护对三种情况承重。不要收窄它。
        //
        // 1. 表达式管道源（设计）：'/etc/passwd' | Remove-Item
        //    — 字符串字面量是 CommandExpressionAst，管道值绑定到
        //    -Path。我们无法静态知道它代表的路径。
        //
        // 2. 控制流语句（意外但被依赖）：
        //    foreach ($x in ...) { Remove-Item $x }。非 PipelineAst 语句
        //    在 segment.commands 中产生一个合成的 CommandExpressionAst 条目
        //   （parser.ts transformStatement）。没有此防护，nestedCommands 中的
        //    Remove-Item $x 会在下方被检查并自动允许 — 但 $x
        //    是循环绑定变量，我们无法验证。
        //
        // 3. 非 PipelineAst 重定向覆盖（意外）：cmd && cmd2 > /tmp
        //    也在此产生一个合成元素。isReadOnlyCommand 依赖
        //    相同的意外（其白名单拒绝合成元素的全文名），因此两条路径都安全失败。
        return {
          behavior: 'passthrough',
          message: `管道包含无法静态验证的表达式源（${cmd.elementType}）`,
        }
      }
      // 安全检查：nameType 从原始名称在 stripModulePrefix 之前计算。
      // 'application' = 原始名称有路径字符（. \\ /）。scripts\\Remove-Item
      // 剥离为 Remove-Item 并会匹配下方的 ACCEPT_EDITS_ALLOWED_CMDLETS，
      // 但 PowerShell 运行 scripts\\Remove-Item.ps1。与 isAllowlistedCommand 相同的门。
      if (cmd.nameType === 'application') {
        return {
          behavior: 'passthrough',
          message: `命令 '${cmd.name}' 从类路径名称解析，需要批准`,
        }
      }
      // 安全检查：elementTypes 白名单 — 与 isAllowlistedCommand 相同。
      // 上方的 deriveSecurityFlags 检查 hasSubExpressions 等，但不
      // 标记裸 Variable/Other elementTypes。`Remove-Item $env:PATH`：
      //   elementTypes = ['StringConstant', 'Variable']
      //   deriveSecurityFlags：无子表达式 → 通过
      //   checkPathConstraints：将字面文本 '$env:PATH' 解析为相对
      //     路径 → cwd/$env:PATH → 在 cwd 内 → 允许
      //   运行时：PowerShell 展开 $env:PATH → 删除实际环境值路径
      // isAllowlistedCommand 拒绝非 StringConstant/Parameter；这是
      // acceptEdits 的对等门。
      //
      // 还检查冒号绑定表达式元字符（与 isAllowlistedCommand 的
      // 冒号绑定检查相同）。`Remove-Item -Path:(1 > /tmp/x)`：
      //   elementTypes = ['StringConstant', 'Parameter'] — 通过上方白名单
      //   deriveSecurityFlags：.Argument 中的 ParenExpressionAst 未被
      //     Get-SecurityPatterns 检测到（ParenExpressionAst 不在 FindAll 过滤器中）
      //   checkPathConstraints：字面文本 '-Path:(1 > /tmp/x)' 不是路径
      //   运行时：括号求值，重定向写入 /tmp/x → 任意写入
      if (cmd.elementTypes) {
        for (let i = 1; i < cmd.elementTypes.length; i++) {
          const t = cmd.elementTypes[i]
          if (t !== 'StringConstant' && t !== 'Parameter') {
            return {
              behavior: 'passthrough',
              message: `命令参数有无法验证的类型（${t}）— 变量路径无法静态解析`,
            }
          }
          if (t === 'Parameter') {
            // elementTypes[i] ↔ args[i-1]（elementTypes[0] 是命令名）。
            const arg = cmd.args[i - 1] ?? ''
            const colonIdx = arg.indexOf(':')
            if (colonIdx > 0 && /[$(@{[]/.test(arg.slice(colonIdx + 1))) {
              return {
                behavior: 'passthrough',
                message: '冒号绑定参数包含无法静态验证的表达式',
              }
            }
          }
        }
      }
      // 安全输出 cmdlet（Out-Null 等）和白名单管道尾部
      // 转换器（Format-*、Measure-Object、Select-Object 等）不影响
      // 前一个命令的语义。跳过它们，使
      // `Remove-Item ./foo | Out-Null` 或 `Set-Content ./foo hi | Format-Table`
      // 像裸写入 cmdlet 一样自动允许。isAllowlistedPipelineTail
      // 是从 SAFE_OUTPUT_CMDLETS 移到 CMDLET_ALLOWLIST
      // 的 cmdlet 的窄回退（argLeaksValue 验证其参数）。
      if (
        isSafeOutputCommand(cmd.name) ||
        isAllowlistedPipelineTail(cmd, input.command)
      ) {
        continue
      }
      if (!isAcceptEditsAllowedCmdlet(cmd.name)) {
        return {
          behavior: 'passthrough',
          message: `acceptEdits 模式中 '${cmd.name}' 无模式特定处理`,
        }
      }
      // 安全检查：拒绝具有不可分类参数类型的命令。'Other'
      // 覆盖 HashtableAst、ConvertExpressionAst、BinaryExpressionAst — 全都
      // 可能包含嵌套重定向或解析器无法完全分解的代码。isAllowlistedCommand
      //（readOnlyValidation.ts）已经通过 argLeaksValue 强制此白名单；
      // 这关闭了 acceptEdits 模式中相同的差距。没有此检查，
      // 作为 -Value 参数的 @{k='payload' > ~/.bashrc} 会通过，因为
      // HashtableAst 映射到 'Other'。
      // argLeaksValue 还捕获冒号绑定变量（-Flag:$env:SECRET）。
      if (argLeaksValue(cmd.name, cmd)) {
        return {
          behavior: 'passthrough',
          message: `'${cmd.name}' 中的参数在 acceptEdits 模式下无法静态验证`,
        }
      }
    }

    // 也检查控制流语句中的嵌套命令
    if (segment.nestedCommands) {
      for (const cmd of segment.nestedCommands) {
        if (cmd.elementType !== 'CommandAst') {
          // 安全检查：与上方相同 — 嵌套命令中的非 CommandAst 元素
          //（控制流体）无法作为路径源静态验证。
          return {
            behavior: 'passthrough',
            message: `嵌套表达式元素（${cmd.elementType}）无法静态验证`,
          }
        }
        if (cmd.nameType === 'application') {
          return {
            behavior: 'passthrough',
            message: `嵌套命令 '${cmd.name}' 从类路径名称解析，需要批准`,
          }
        }
        if (
          isSafeOutputCommand(cmd.name) ||
          isAllowlistedPipelineTail(cmd, input.command)
        ) {
          continue
        }
        if (!isAcceptEditsAllowedCmdlet(cmd.name)) {
          return {
            behavior: 'passthrough',
            message: `acceptEdits 模式中 '${cmd.name}' 无模式特定处理`,
          }
        }
        // 安全检查：与上方主命令循环相同的 argLeaksValue 检查。
        if (argLeaksValue(cmd.name, cmd)) {
          return {
            behavior: 'passthrough',
            message: `嵌套 '${cmd.name}' 中的参数在 acceptEdits 模式下无法静态验证`,
          }
        }
      }
    }
  }

  // 所有命令都是修改文件系统的 cmdlet -- 自动允许
  return {
    behavior: 'allow',
    updatedInput: input,
    decisionReason: {
      type: 'mode',
      mode: 'acceptEdits',
    },
  }
}
