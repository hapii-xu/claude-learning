/**
 * 针对 PowerShell 的权限检查，从 bashPermissions.ts 改编，
 * 用于不区分大小写的 cmdlet 匹配。
 */

import { resolve } from 'path'
import type { ToolPermissionContext, ToolUseContext } from 'src/Tool.js'
import type {
  PermissionDecisionReason,
  PermissionResult,
} from 'src/types/permissions.js'
import { getCwd } from 'src/utils/cwd.js'
import { isCurrentDirectoryBareGitRepo } from 'src/utils/git.js'
import type { PermissionRule } from 'src/utils/permissions/PermissionRule.js'
import type { PermissionUpdate } from 'src/utils/permissions/PermissionUpdateSchema.js'
import {
  createPermissionRequestMessage,
  getRuleByContentsForToolName,
} from 'src/utils/permissions/permissions.js'
import {
  matchWildcardPattern,
  parsePermissionRule,
  type ShellPermissionRule,
  suggestionForExactCommand as sharedSuggestionForExactCommand,
} from 'src/utils/permissions/shellRuleMatching.js'
import {
  classifyCommandName,
  deriveSecurityFlags,
  getAllCommandNames,
  getFileRedirections,
  type ParsedCommandElement,
  type ParsedPowerShellCommand,
  PS_TOKENIZER_DASH_CHARS,
  parsePowerShellCommand,
  stripModulePrefix,
} from 'src/utils/powershell/parser.js'
import { containsVulnerableUncPath } from 'src/utils/shell/readOnlyCommandValidation.js'
import { isDotGitPathPS, isGitInternalPathPS } from './gitSafety.js'
import {
  checkPermissionMode,
  isSymlinkCreatingCommand,
} from './modeValidation.js'
import {
  checkPathConstraints,
  dangerousRemovalDeny,
  isDangerousRemovalRawPath,
} from './pathValidation.js'
import { powershellCommandIsSafe } from './powershellSecurity.js'
import {
  argLeaksValue,
  isAllowlistedCommand,
  isCwdChangingCmdlet,
  isProvablySafeStatement,
  isReadOnlyCommand,
  isSafeOutputCommand,
  resolveToCanonical,
} from './readOnlyValidation.js'
import { POWERSHELL_TOOL_NAME } from './toolName.js'

// 匹配 `$var = `、`$var += `、`$env:X = `、`$x ??= ` 等。用于在
// 解析失败的回退路径中剥离嵌套赋值前缀。
const PS_ASSIGN_PREFIX_RE = /^\$[\w:]+\s*(?:[+\-*/%]|\?\?)?\s*=\s*/

/**
 * 可以在调用方指定路径放置文件的 cmdlet。git 内部路径
// 防护检查任何参数是否是 git 内部路径
//（hooks/、refs/、objects/、HEAD）。非创建写入器（remove-item、
// clear-content）故意缺失 — 它们无法植入新钩子。
 */
const GIT_SAFETY_WRITE_CMDLETS = new Set([
  'new-item',
  'set-content',
  'add-content',
  'out-file',
  'copy-item',
  'move-item',
  'rename-item',
  'expand-archive',
  'invoke-webrequest',
  'invoke-restmethod',
  'tee-object',
  'export-csv',
  'export-clixml',
])

/**
 * 将文件以归档控制的路径写入 cwd 的外部归档解压应用程序。
// `tar -xf payload.tar; git status` 击败
// isCurrentDirectoryBareGitRepo（TOCTOU）：检查在
// 权限评估时运行，tar 在检查之后、git 运行之前
// 解压 HEAD/hooks/refs/。与 GIT_SAFETY_WRITE_CMDLETS 不同（我们可以检查
// 参数中的 git 内部路径），归档内容是不透明的 — 任何
// 在 git 之前的解压都必须询问。只按名匹配（小写，
// 带和不带 .exe）。
 */
const GIT_SAFETY_ARCHIVE_EXTRACTORS = new Set([
  'tar',
  'tar.exe',
  'bsdtar',
  'bsdtar.exe',
  'unzip',
  'unzip.exe',
  '7z',
  '7z.exe',
  '7za',
  '7za.exe',
  'gzip',
  'gzip.exe',
  'gunzip',
  'gunzip.exe',
  'expand-archive',
])

/**
 * 从 PowerShell 命令字符串中提取命令名。
 * 使用解析器从 AST 获取第一个命令名。
 */
async function extractCommandName(command: string): Promise<string> {
  const trimmed = command.trim()
  if (!trimmed) {
    return ''
  }
  const parsed = await parsePowerShellCommand(trimmed)
  const names = getAllCommandNames(parsed)
  return names[0] ?? ''
}

/**
 * 将权限规则字符串解析为结构化规则对象。
 * 委托给共享的 parsePermissionRule。
 */
export function powershellPermissionRule(
  permissionRule: string,
): ShellPermissionRule {
  return parsePermissionRule(permissionRule)
}

/**
 * 为精确命令匹配生成权限更新建议。
 *
 * 跳过无法干净往返的命令的精确命令建议：
 * - 多行：换行符无法在规范化中存活，规则永远不会匹配
 * - 字面 *：原样存储 `Remove-Item * -Force` 通过 hasWildcards() 重新解析为通配符
//   规则（匹配 `^Remove-Item .* -Force$`）。转义为
//   `\*` 会创建死规则 — parsePermissionRule 的精确分支返回
//   带反斜杠的原始字符串，因此 `Remove-Item \* -Force` 从不匹配
//   传入的 `Remove-Item * -Force`。glob 无论如何都不安全地用于精确自动允许；
//   仍提供前缀建议。（发现 #12）
 */
function suggestionForExactCommand(command: string): PermissionUpdate[] {
  if (command.includes('\n') || command.includes('*')) {
    return []
  }
  return sharedSuggestionForExactCommand(POWERSHELL_TOOL_NAME, command)
}

/**
 * PowerShell 输入 schema 类型 - 为初始实现简化
 */
type PowerShellInput = {
  command: string
  timeout?: number
}

/**
 * 按内容匹配输入命令过滤规则。
 * PowerShell 特定：全程使用不区分大小写的匹配。
 * 遵循与 BashTool 的 local filterRulesByContentsMatchingInput 相同的结构。
 */
function filterRulesByContentsMatchingInput(
  input: PowerShellInput,
  rules: Map<string, PermissionRule>,
  matchMode: 'exact' | 'prefix',
  behavior: 'deny' | 'ask' | 'allow',
): PermissionRule[] {
  const command = input.command.trim()

  function strEquals(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase()
  }
  function strStartsWith(str: string, prefix: string): boolean {
    return str.toLowerCase().startsWith(prefix.toLowerCase())
  }
  // 安全检查：对规则名使用 stripModulePrefix 扩大了
  // 次级规范匹配 — 拒绝规则 `Module\Remove-Item:*` 阻止
  // `rm` 是意图（安全失败过度匹配），但允许规则
  // `ModuleA\Get-Thing:*` 也匹配 `ModuleB\Get-Thing` 是失败开放。
  // 拒绝/询问过度匹配没问题；允许绝不能过度匹配。
  function stripModulePrefixForRule(name: string): string {
    if (behavior === 'allow') {
      return name
    }
    return stripModulePrefix(name)
  }

  // 从输入中提取第一个单词（命令名）用于规范匹配。
  // 同时保留原始（用于切片原始 `command` 字符串）和剥离
  //（用于规范解析）版本。对于模块限定的输入如
  // `Microsoft.PowerShell.Utility\Invoke-Expression foo`，rawCmdName 持有
  // 完整 token，因此 `command.slice(rawCmdName.length)` 产生正确的剩余部分。
  const rawCmdName = command.split(/\s+/)[0] ?? ''
  const inputCmdName = stripModulePrefix(rawCmdName)
  const inputCanonical = resolveToCanonical(inputCmdName)

  // 构建替换了规范名称的命令版本
  // 例如，'rm foo.txt' -> 'remove-item foo.txt'，因此 Remove-Item 上的拒绝规则也阻止 rm。
  // 安全检查：将名称和参数之间的空白分隔符规范化为
  // 单个空格。PowerShell 接受任何空白（制表符等）作为分隔符，
  // 但前缀规则匹配使用 `prefix + ' '`（字面空格）。没有此项，
  // `rm\t./x` 规范化为 `remove-item\t./x` 并错过拒绝规则
  // `Remove-Item:*`，而 acceptEdits 自动允许（使用 AST cmd.name）仍然
  // 匹配 — 拒绝规则绕过。无条件构建（不仅在规范
  // 不同时），使非空格分隔的原始命令也被规范化。
  const rest = command.slice(rawCmdName.length).replace(/^\s+/, ' ')
  const canonicalCommand = inputCanonical + rest

  return Array.from(rules.entries())
    .filter(([ruleContent]) => {
      const rule = powershellPermissionRule(ruleContent)

      // 还将规则的命令名解析为规范名以进行交叉匹配
      // 例如，'rm' 的拒绝规则也应阻止 'Remove-Item'
      function matchesCommand(cmd: string): boolean {
        switch (rule.type) {
          case 'exact':
            return strEquals(rule.command, cmd)
          case 'prefix':
            switch (matchMode) {
              case 'exact':
                return strEquals(rule.prefix, cmd)
              case 'prefix': {
                if (strEquals(cmd, rule.prefix)) {
                  return true
                }
                return strStartsWith(cmd, rule.prefix + ' ')
              }
            }
            break
          case 'wildcard':
            if (matchMode === 'exact') {
              return false
            }
            return matchWildcardPattern(rule.pattern, cmd, true)
        }
      }

      // 针对原始命令检查
      if (matchesCommand(command)) {
        return true
      }

      // 还针对命令的规范形式检查
      // 这确保 'deny Remove-Item' 也阻止 'rm'、'del'、'ri' 等。
      if (matchesCommand(canonicalCommand)) {
        return true
      }

      // 还将规则的命令名解析为规范名并比较
      // 这确保 'deny rm' 也阻止 'Remove-Item'
      // 安全检查：对拒绝/询问规则命令也应用 stripModulePrefix
      // 名，不仅仅是输入。否则写为
      // `Microsoft.PowerShell.Management\Remove-Item:*` 的拒绝规则被 `rm`、
      // `del` 或普通 `Remove-Item` 绕过 — resolveToCanonical 不会
      // 将模块限定形式与 COMMON_ALIASES 匹配。
      if (rule.type === 'exact') {
        const rawRuleCmdName = rule.command.split(/\s+/)[0] ?? ''
        const ruleCanonical = resolveToCanonical(
          stripModulePrefixForRule(rawRuleCmdName),
        )
        if (ruleCanonical === inputCanonical) {
          // 规则和输入解析到相同的规范 cmdlet
          // 安全检查：使用规范化的 `rest`，不重新切片
          // 自 `command`。原始切片保留制表符分隔符，因此
          // `Remove-Item\t./secret.txt` 与拒绝规则 `rm ./secret.txt` 遗漏。
          // 两端相同地规范化。
          const ruleRest = rule.command
            .slice(rawRuleCmdName.length)
            .replace(/^\s+/, ' ')
          const inputRest = rest
          if (strEquals(ruleRest, inputRest)) {
            return true
          }
        }
      } else if (rule.type === 'prefix') {
        const rawRuleCmdName = rule.prefix.split(/\s+/)[0] ?? ''
        const ruleCanonical = resolveToCanonical(
          stripModulePrefixForRule(rawRuleCmdName),
        )
        if (ruleCanonical === inputCanonical) {
          const ruleRest = rule.prefix
            .slice(rawRuleCmdName.length)
            .replace(/^\s+/, ' ')
          const canonicalPrefix = inputCanonical + ruleRest
          if (matchMode === 'exact') {
            if (strEquals(canonicalPrefix, canonicalCommand)) {
              return true
            }
          } else {
            if (
              strEquals(canonicalCommand, canonicalPrefix) ||
              strStartsWith(canonicalCommand, canonicalPrefix + ' ')
            ) {
              return true
            }
          }
        }
      } else if (rule.type === 'wildcard') {
        // 将通配符模式的命令名解析为规范名并重新匹配
        // 这确保 'deny rm *' 也阻止 'Remove-Item secret.txt'
        const rawRuleCmdName = rule.pattern.split(/\s+/)[0] ?? ''
        const ruleCanonical = resolveToCanonical(
          stripModulePrefixForRule(rawRuleCmdName),
        )
        if (ruleCanonical === inputCanonical && matchMode !== 'exact') {
          // 用规范 cmdlet 名重建模式
          // 与精确和前缀分支相同地规范化分隔符。
          // 没有此项，通配符规则 `rm\t*` 产生 canonicalPattern
          // 带字面制表符，从不匹配空格规范化的
          // canonicalCommand。
          const ruleRest = rule.pattern
            .slice(rawRuleCmdName.length)
            .replace(/^\s+/, ' ')
          const canonicalPattern = inputCanonical + ruleRest
          if (matchWildcardPattern(canonicalPattern, canonicalCommand, true)) {
            return true
          }
        }
      }

      return false
    })
    .map(([, rule]) => rule)
}

/**
 * 跨所有规则类型（deny、ask、allow）获取输入的匹配规则
 */
function matchingRulesForInput(
  input: PowerShellInput,
  toolPermissionContext: ToolPermissionContext,
  matchMode: 'exact' | 'prefix',
) {
  const denyRuleByContents = getRuleByContentsForToolName(
    toolPermissionContext,
    POWERSHELL_TOOL_NAME,
    'deny',
  )
  const matchingDenyRules = filterRulesByContentsMatchingInput(
    input,
    denyRuleByContents,
    matchMode,
    'deny',
  )

  const askRuleByContents = getRuleByContentsForToolName(
    toolPermissionContext,
    POWERSHELL_TOOL_NAME,
    'ask',
  )
  const matchingAskRules = filterRulesByContentsMatchingInput(
    input,
    askRuleByContents,
    matchMode,
    'ask',
  )

  const allowRuleByContents = getRuleByContentsForToolName(
    toolPermissionContext,
    POWERSHELL_TOOL_NAME,
    'allow',
  )
  const matchingAllowRules = filterRulesByContentsMatchingInput(
    input,
    allowRuleByContents,
    matchMode,
    'allow',
  )

  return { matchingDenyRules, matchingAskRules, matchingAllowRules }
}

/**
 * 检查命令是否是权限规则的精确匹配。
 */
export function powershellToolCheckExactMatchPermission(
  input: PowerShellInput,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const trimmedCommand = input.command.trim()
  const { matchingDenyRules, matchingAskRules, matchingAllowRules } =
    matchingRulesForInput(input, toolPermissionContext, 'exact')

  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `使用 ${POWERSHELL_TOOL_NAME} 执行命令 ${trimmedCommand} 的权限已被拒绝。`,
      decisionReason: { type: 'rule', rule: matchingDenyRules[0] },
    }
  }

  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(POWERSHELL_TOOL_NAME),
      decisionReason: { type: 'rule', rule: matchingAskRules[0] },
    }
  }

  if (matchingAllowRules[0] !== undefined) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'rule', rule: matchingAllowRules[0] },
    }
  }

  const decisionReason: PermissionDecisionReason = {
    type: 'other' as const,
    reason: '此命令需要批准',
  }
  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(
      POWERSHELL_TOOL_NAME,
      decisionReason,
    ),
    decisionReason,
    suggestions: suggestionForExactCommand(trimmedCommand),
  }
}

/**
 * 检查 PowerShell 命令的权限，包括前缀匹配。
 */
export function powershellToolCheckPermission(
  input: PowerShellInput,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const command = input.command.trim()

  // 1. 先检查精确匹配
  const exactMatchResult = powershellToolCheckExactMatchPermission(
    input,
    toolPermissionContext,
  )

  // 1a. 如果精确命令有规则则拒绝/询问
  if (
    exactMatchResult.behavior === 'deny' ||
    exactMatchResult.behavior === 'ask'
  ) {
    return exactMatchResult
  }

  // 2. 查找所有匹配规则（前缀或精确）
  const { matchingDenyRules, matchingAskRules, matchingAllowRules } =
    matchingRulesForInput(input, toolPermissionContext, 'prefix')

  // 2a. 如果命令有拒绝规则则拒绝
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `使用 ${POWERSHELL_TOOL_NAME} 执行命令 ${command} 的权限已被拒绝。`,
      decisionReason: {
        type: 'rule',
        rule: matchingDenyRules[0],
      },
    }
  }

  // 2b. 如果命令有询问规则则询问
  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(POWERSHELL_TOOL_NAME),
      decisionReason: {
        type: 'rule',
        rule: matchingAskRules[0],
      },
    }
  }

  // 3. 如果命令有精确匹配允许则允许
  if (exactMatchResult.behavior === 'allow') {
    return exactMatchResult
  }

  // 4. 如果命令有允许规则则允许
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

  // 5. 无规则匹配则穿透，将触发权限提示
  const decisionReason = {
    type: 'other' as const,
    reason: '此命令需要批准',
  }
  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(
      POWERSHELL_TOOL_NAME,
      decisionReason,
    ),
    decisionReason,
    suggestions: suggestionForExactCommand(command),
  }
}

/**
 * 关于用于权限检查的子命令的信息。
 */
type SubCommandInfo = {
  text: string
  element: ParsedCommandElement
  statement: ParsedPowerShellCommand['statements'][number] | null
  isSafeOutput: boolean
}

/**
 * 从解析的命令中提取需要独立权限检查的子命令。
 * 安全输出 cmdlet（Format-Table、Select-Object 等）被标记但不
// 过滤掉 — 步骤 4.4 仍针对它们检查拒绝规则（拒绝总是
// 获胜），步骤 5 为批准收集跳过它们（它们继承前一个命令的权限）。
 *
 * 还包括控制流语句（if、for、foreach 等）中的嵌套命令，
 * 以确保隐藏在控制流内的命令被检查。
 *
 * 返回子命令信息，包括文本和解析元素，用于准确的
 * 建议生成。
 */
async function getSubCommandsForPermissionCheck(
  parsed: ParsedPowerShellCommand,
  originalCommand: string,
): Promise<SubCommandInfo[]> {
  if (!parsed.valid) {
    // 为未解析的命令返回回退元素
    return [
      {
        text: originalCommand,
        element: {
          name: await extractCommandName(originalCommand),
          nameType: 'unknown',
          elementType: 'CommandAst',
          args: [],
          text: originalCommand,
        },
        statement: null,
        isSafeOutput: false,
      },
    ]
  }

  const subCommands: SubCommandInfo[] = []

  // 检查管道中的直接命令
  for (const statement of parsed.statements) {
    for (const cmd of statement.commands) {
      // 只检查实际命令（CommandAst），不是表达式
      if (cmd.elementType !== 'CommandAst') {
        continue
      }
      subCommands.push({
        text: cmd.text,
        element: cmd,
        statement,
        // 安全检查：nameType 门 — scripts\\Out-Null 剥离为 Out-Null 并
        // 会匹配 SAFE_OUTPUT_CMDLETS，但 PowerShell 运行 .ps1 文件。
        // isSafeOutput: true 使步骤 5 从
        // 批准列表中过滤掉此命令，因此它会静默执行。见 isAllowlistedCommand。
        // 安全检查：args.length === 0 门 — Out-Null -InputObject:(1 > /etc/x)
        // 被过滤为安全输出（仅名）→ 步骤 5 subCommands 为空 →
        // 自动允许 → 括号内的重定向写入文件。只有零参数
        // Out-String/Out-Null/Out-Host 调用是可证明安全的。
        isSafeOutput:
          cmd.nameType !== 'application' &&
          isSafeOutputCommand(cmd.name) &&
          cmd.args.length === 0,
      })
    }

    // 也检查控制流语句中的嵌套命令
    if (statement.nestedCommands) {
      for (const cmd of statement.nestedCommands) {
        subCommands.push({
          text: cmd.text,
          element: cmd,
          statement,
          isSafeOutput:
            cmd.nameType !== 'application' &&
            isSafeOutputCommand(cmd.name) &&
            cmd.args.length === 0,
        })
      }
    }
  }

  if (subCommands.length > 0) {
    return subCommands
  }

  // 无子命令的命令的回退
  return [
    {
      text: originalCommand,
      element: {
        name: await extractCommandName(originalCommand),
        nameType: 'unknown',
        elementType: 'CommandAst',
        args: [],
        text: originalCommand,
      },
      statement: null,
      isSafeOutput: false,
    },
  ]
}

/**
 * PowerShell 工具的主权限检查函数。
 *
 * 此函数实现完整权限流程：
 * 1. 针对拒绝/询问/允许规则检查精确匹配
 * 2. 针对规则检查前缀匹配
 * 3. 通过 powershellCommandIsSafe() 运行安全检查
 * 4. 返回适当的 PermissionResult
 *
 * @param input - PowerShell 工具输入
 * @param context - 工具使用上下文（用于中止信号和会话信息）
 * @returns 解析为 PermissionResult 的 Promise
 */
export async function powershellToolHasPermission(
  input: PowerShellInput,
  context: ToolUseContext,
): Promise<PermissionResult> {
  const toolPermissionContext = context.getAppState().toolPermissionContext
  const command = input.command.trim()

  // 空命令检查
  if (!command) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: '空命令是安全的',
      },
    }
  }

  // 解析命令一次，贯穿所有子函数
  const parsed = await parsePowerShellCommand(command)

  // 安全检查：在解析有效性检查之前检查拒绝/询问规则。
  // 拒绝规则作用于原始命令字符串，不需要解析的 AST。
  // 这确保显式拒绝规则即使在解析失败时也阻止命令。
  // 1. 先检查精确匹配
  const exactMatchResult = powershellToolCheckExactMatchPermission(
    input,
    toolPermissionContext,
  )

  // 精确命令被拒绝
  if (exactMatchResult.behavior === 'deny') {
    return exactMatchResult
  }

  // 2. 检查前缀/通配符规则
  const { matchingDenyRules, matchingAskRules } = matchingRulesForInput(
    input,
    toolPermissionContext,
    'prefix',
  )

  // 2a. 如果命令有拒绝规则则拒绝
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `使用 ${POWERSHELL_TOOL_NAME} 执行命令 ${command} 的权限已被拒绝。`,
      decisionReason: {
        type: 'rule',
        rule: matchingDenyRules[0],
      },
    }
  }

  // 2b. 如果命令有询问规则则询问 — 延迟到 decisions[]。
  // 以前这在子命令拒绝检查运行之前早返回，因此
  // `Get-Process; Invoke-Expression evil` 带 ask(Get-Process:*) +
  // deny(Invoke-Expression:*) 会显示询问对话框，拒绝从不
  // 触发。现在：存储询问，在解析成功后推入 decisions[]。
  // 如果解析失败，在解析错误询问之前返回
  //（在 pwsh 不可用时保留规则归属的 decisionReason）。
  let preParseAskDecision: PermissionResult | null = null
  if (matchingAskRules[0] !== undefined) {
    preParseAskDecision = {
      behavior: 'ask',
      message: createPermissionRequestMessage(POWERSHELL_TOOL_NAME),
      decisionReason: {
        type: 'rule',
        rule: matchingAskRules[0],
      },
    }
  }

  // 阻止 UNC 路径 — 从 UNC 路径读取可以触发网络请求
  // 并泄露 NTLM/Kerberos 凭据。延迟到 decisions[]。
  // 原始字符串 UNC 检查不得在子命令拒绝
  //（步骤 4+）之前早返回。与上方 2b 相同的修复。
  if (preParseAskDecision === null && containsVulnerableUncPath(command)) {
    preParseAskDecision = {
      behavior: 'ask',
      message: '命令包含可能触发网络请求的 UNC 路径',
    }
  }

  // 2c. 精确允许规则仅当解析失败且
  // 无预解析询问（2b 前缀或 UNC）挂起时在此短路。将 2b/UNC 从
  // 早返回转为延迟赋值意味着 2c
  // 在 L648 消费 preParseAskDecision 之前触发 — 静默地用允许覆盖
  // 询问。解析成功路径通过 reduce
  //（L917）强制询问 > 允许；没有此防护，解析失败不一致。
  // 这确保用户配置的精确允许规则即使在 pwsh 不可用时也工作。当解析成功时，
  // 精确允许检查延迟到步骤 4.4（子命令拒绝/询问）之后 — 匹配 BashTool 的顺序，其中
  // 主流程精确允许在 bashPermissions.ts:1520 在子命令
  // 拒绝检查（1442-1458）之后运行。没有此项，复合命令上的精确允许
  // 会绕过子命令上的拒绝规则。
  //
  // 安全检查（解析失败分支）：步骤 5 的 nameType 防护位于
  // 子命令循环内，只在 parsed.valid 时运行。
  // 这是 !parsed.valid 的逃生舱。输入侧 stripModulePrefix
  // 是无条件的 — `scripts\build.exe --flag` 剥离为 `build.exe`，
  // canonicalCommand 匹配精确允许，没有此防护我们将
  // 在此返回允许并执行本地脚本。classifyCommandName
  // 是纯字符串函数（无需 AST）。`scripts\build.exe` →
  // 'application'（有 `\`）。与步骤 5 相同的权衡：单独的 `build.exe`
  // 也归类为 'application'（有 `.`），因此合法的可执行文件
  // 精确允许在 pwsh 降级时降级为询问 — 安全失败。
  // 模块限定 cmdlet（Module\Cmdlet）也归类为 'application'
  //（相同 `\`）；相同的安全失败过度触发。
  if (
    exactMatchResult.behavior === 'allow' &&
    !parsed.valid &&
    preParseAskDecision === null &&
    classifyCommandName(command.split(/\s+/)[0] ?? '') !== 'application'
  ) {
    return exactMatchResult
  }

  // 0. 检查命令是否可以解析 - 如果不能，需要批准但不建议持久化
  // 这匹配 Bash 行为：无效语法触发权限提示，但我们不
  // 推荐保存无效命令到设置
  // 注意：此检查故意在拒绝/询问规则之后，以便显式规则仍然工作，
  // 即使解析器失败（例如 pwsh 不可用）。
  if (!parsed.valid) {
    // 安全检查：解析失败路径的回退子命令拒绝扫描。
    // L851+ 的子命令拒绝循环需要 AST；当解析失败
    //（命令超过 MAX_COMMAND_LENGTH、pwsh 不可用、超时、坏
    // JSON）时，我们会返回 '询问' 而不检查子命令拒绝规则。
    // 攻击：`Get-ChildItem # <~2000 chars padding> ; Invoke-Expression evil`
    // → 填充强制 valid=false → 通用询问提示，deny(iex:*) 从不
    // 触发。此回退在 PowerShell 分隔符/分组上分割，并
    // 通过相同的规则匹配器运行每个片段（与步骤 2a 相同，前缀拒绝）。
    // 保守：字符串字面量/注释内的片段可能误报
    // 拒绝 — 此处安全（解析失败已是降级状态，且这是
    // 拒绝降级修复）。针对完整片段匹配（非仅第一个 token），
    // 使像 `Remove-Item foo:*` 的多词规则仍然触发；匹配器的
    // 规范解析处理别名（`iex` → `Invoke-Expression`）。
    //
    // 安全检查：反引号是 PS 转义/行延续，不是分隔符。
    // 在其上分割会将 `Invoke-Ex`pression` 分割为不匹配的
    // 片段。相反：折叠反引号-换行（行延续），使
    // `Invoke-Ex`<nl>pression` 重新连接，剥离剩余反引号（转义
    // 字符 — ``x → x），然后在实际语句/分组分隔符上分割。
    const backtickStripped = command
      .replace(/`[\r\n]+\s*/g, '')
      .replace(/`/g, '')
    for (const fragment of backtickStripped.split(/[;|\n\r{}()&]+/)) {
      const trimmedFrag = fragment.trim()
      if (!trimmedFrag) continue // 跳过空片段
      // 仅当完整命令以 cmdlet 名（无
      // 赋值前缀）开头时跳过完整命令。完整命令已在 2a 检查，但
      // 2a 使用原始文本 — $x %= iex 作为第一个 token `$x` 遗漏
      // deny(iex:*) 规则。如果规范化会改变片段
      //（赋值前缀、dot-source），不跳过 — 让它在规范化后重新检查。（bug #10/#24）
      if (
        trimmedFrag === command &&
        !/^\$[\w:]/.test(trimmedFrag) &&
        !/^[&.]\s/.test(trimmedFrag)
      ) {
        continue
      }
      // 安全检查：在规则匹配之前规范化调用操作符和赋值前缀
      //（发现 #5/#22）。分割器给我们原始片段
      // 文本；matchingRulesForInput 提取第一个 token 作为 cmdlet 名。
      // 没有规范化：
      //   `$x = Invoke-Expression 'p'` → 第一个 token `$x` → deny(iex:*) 遗漏
      //   `. Invoke-Expression 'p'`    → 第一个 token `.`  → deny(iex:*) 遗漏
      //   `& 'Invoke-Expression' 'p'`  → 第一个 token `&` 被分割移除但
      //                                  `'Invoke-Expression'` 保留引号
      //                                  → deny(iex:*) 遗漏
      // 解析成功路径通过 AST 处理这些（parser.ts:839 从
      // rawNameUnstripped 剥离引号；调用操作符是独立的 AST
      // 节点）。此回退镜像该规范化。
      // 循环剥离嵌套赋值：$x = $y = iex → $y = iex → iex
      let normalized = trimmedFrag
      let m: RegExpMatchArray | null
      while ((m = normalized.match(PS_ASSIGN_PREFIX_RE))) {
        normalized = normalized.slice(m[0].length)
      }
      normalized = normalized.replace(/^[&.]\s+/, '') // & cmd、. cmd（dot-source）
      const rawFirst = normalized.split(/\s+/)[0] ?? ''
      const firstTok = rawFirst.replace(/^['"]|['"]$/g, '')
      const normalizedFrag = firstTok + normalized.slice(rawFirst.length)
      // 安全检查：独立于解析的危险移除硬拒绝。
      // checkPathConstraintsForStatement 中的 isDangerousRemovalPath 检查
      // 需要有效的 AST；当 pwsh 超时或不可用时，
      // `Remove-Item /` 从硬拒绝降级为通用询问。在此检查
      // 原始位置参数，使根/home/system 删除被拒绝
      // 无论解析器可用性如何。保守：只位置
      // 参数（跳过 -Param token）；在降级状态下过度拒绝是安全的
      //（与上方子命令扫描相同的拒绝降级理由）。
      if (resolveToCanonical(firstTok) === 'remove-item') {
        for (const arg of normalized.split(/\s+/).slice(1)) {
          if (PS_TOKENIZER_DASH_CHARS.has(arg[0] ?? '')) continue
          if (isDangerousRemovalRawPath(arg)) {
            return dangerousRemovalDeny(arg)
          }
        }
      }
      const { matchingDenyRules: fragDenyRules } = matchingRulesForInput(
        { command: normalizedFrag },
        toolPermissionContext,
        'prefix',
      )
      if (fragDenyRules[0] !== undefined) {
        return {
          behavior: 'deny',
          message: `使用 ${POWERSHELL_TOOL_NAME} 执行命令 ${command} 的权限已被拒绝。`,
          decisionReason: { type: 'rule', rule: fragDenyRules[0] },
        }
      }
    }
    // 解析失败时保留预解析询问消息。延迟询问
    //（2b 前缀规则或 UNC）携带比
    // 通用解析错误询问更好的 decisionReason。子命令拒绝无法在没有解析的情况下运行 AST 循环，
    // 因此上方的回退扫描是尽力而为。
    if (preParseAskDecision !== null) {
      return preParseAskDecision
    }
    const decisionReason = {
      type: 'other' as const,
      reason: `命令包含无法解析的畸形语法：${parsed.errors[0]?.message ?? '未知错误'}`,
    }
    return {
      behavior: 'ask',
      decisionReason,
      message: createPermissionRequestMessage(
        POWERSHELL_TOOL_NAME,
        decisionReason,
      ),
      // 无建议 - 不推荐持久化无效语法
    }
  }

  // ========================================================================
  // 收集然后归约：解析后决策（拒绝 > 询问 > 允许 > 穿透）
  // ========================================================================
  // 从 bashPermissions.ts:1446-1472 移植。每个解析后检查推送
  // 其决策到单个数组；单个 reduce 应用优先级。
  // 这在结构上关闭了询问在拒绝之前的 bug 类：来自
  // 早期检查（安全标志、provider 路径、cd+git）的 '询问' 无法再掩盖
  // 来自后续检查（子命令拒绝、checkPathConstraints）的 '拒绝'。
  //
  // 取代了提交 8f5ae6c56b 中的 firstSubCommandAskRule 存储 — 该
  // 修复只修补了步骤 4；步骤 3、3.5、4.42 有相同的缺陷。存储
  // 模式也很脆弱：下一个编写 `return ask` 的作者又回到
  // 原点。收集然后归约使绕过不可能编写。
  //
  // 每种行为的第一个获胜（数组顺序 = 步骤顺序），因此单检查
  // 询问消息与顺序早返回相同。
  //
  // 上方的预解析拒绝检查（精确/前缀拒绝）保持顺序：它们
  // 在 pwsh 不可用时也触发。预解析询问（前缀询问、原始 UNC）
  // 现在在此延迟，使子命令拒绝（步骤 4）击败它们。

  // 一次性收集子命令（由决策 3、4 和穿透步骤 5 使用）。
  const allSubCommands = await getSubCommandsForPermissionCheck(parsed, command)

  const decisions: PermissionResult[] = []

  // 决策：延迟的预解析询问（2b 前缀询问或 UNC 路径）。
  // 先推送使其消息胜过后续询问（每种行为的第一个获胜），
  // 但 reduce 确保 decisions[] 中的任何拒绝仍击败它。
  if (preParseAskDecision !== null) {
    decisions.push(preParseAskDecision)
  }

  // 决策：安全检查 — 曾是步骤 3（:630-650）。
  // powershellCommandIsSafe 对子表达式、脚本块、
  // 编码命令、下载摇篮等返回 '询问'。只有 '询问' | '穿透'。
  const safetyResult = powershellCommandIsSafe(command, parsed)
  if (safetyResult.behavior !== 'passthrough') {
    const decisionReason: PermissionDecisionReason = {
      type: 'other' as const,
      reason:
        safetyResult.behavior === 'ask' && safetyResult.message
          ? safetyResult.message
          : '此命令包含可能构成安全风险的模式，需要批准',
    }
    decisions.push({
      behavior: 'ask',
      message: createPermissionRequestMessage(
        POWERSHELL_TOOL_NAME,
        decisionReason,
      ),
      decisionReason,
      suggestions: suggestionForExactCommand(command),
    })
  }

  // 决策：using 语句 / 脚本要求 — 对 AST 块遍历不可见。
  // `using module ./evil.psm1` 加载并执行模块的顶级脚本体；
  // `using assembly ./evil.dll` 加载 .NET 程序集（模块初始化器运行）。
  // `#Requires -Modules <name>` 触发从 PSModulePath 加载模块。
  // 这些是 ScriptBlockAst 上命名块的兄弟，不是子节点，所以
  // Process-BlockStatements 和所有下游命令遍历器从不看到它们。
  // 没有此检查，诱饵 cmdlet 如 Get-Process 填充 subCommands，
  // 绕过空语句回退，isReadOnlyCommand 自动允许。
  if (parsed.hasUsingStatements) {
    const decisionReason: PermissionDecisionReason = {
      type: 'other' as const,
      reason: '命令包含可能加载外部代码（模块或程序集）的 `using` 语句',
    }
    decisions.push({
      behavior: 'ask',
      message: createPermissionRequestMessage(
        POWERSHELL_TOOL_NAME,
        decisionReason,
      ),
      decisionReason,
      suggestions: suggestionForExactCommand(command),
    })
  }
  if (parsed.hasScriptRequirements) {
    const decisionReason: PermissionDecisionReason = {
      type: 'other' as const,
      reason: '命令包含可能触发模块加载的 `#Requires` 指令',
    }
    decisions.push({
      behavior: 'ask',
      message: createPermissionRequestMessage(
        POWERSHELL_TOOL_NAME,
        decisionReason,
      ),
      decisionReason,
      suggestions: suggestionForExactCommand(command),
    })
  }

  // 决策：解析参数的 provider/UNC 扫描 — 曾是步骤 3.5（:652-709）。
  // Provider 路径（env:、HKLM:、function:）访问非文件系统资源。
  // UNC 路径可在 Windows 上泄露 NTLM/Kerberos 凭据。上方的原始字符串
  // UNC 检查（预解析）遗漏反引号转义形式；cmd.args 有
  // 解析器解析的反引号转义。标记循环在第一个
  // 匹配时中断（与之前的早返回相同）。
  // Provider 前缀同时匹配短形式（`env:`、`HKLM:`）和
  // 全限定形式（`Microsoft.PowerShell.Core\Registry::HKLM\...`）。
  // 可选的 `(?:[\w.]+\\)?` 处理模块限定前缀；`::?`
  // 匹配单冒号驱动器语法或双冒号 provider 语法。
  const NON_FS_PROVIDER_PATTERN =
    /^(?:[\w.]+\\)?(env|hklm|hkcu|function|alias|variable|cert|wsman|registry)::?/i
  function extractProviderPathFromArg(arg: string): string {
    // 处理冒号参数语法：-Path:env:HOME → 提取 'env:HOME'。
    // 安全检查：PowerShell 的 tokenizer 接受 en-dash/em-dash/horizontal-bar
    //（U+2013/2014/2015）作为参数前缀。`–Path:env:HOME`（en-dash）
    // 也必须剥离 `–Path:` 前缀，否则 NON_FS_PROVIDER_PATTERN 不
    // 匹配（模式是 `^(env|...):`，在 `–Path:env:...` 上失败）。
    let s = arg
    if (s.length > 0 && PS_TOKENIZER_DASH_CHARS.has(s[0]!)) {
      const colonIdx = s.indexOf(':', 1) // 跳过前导横杠
      if (colonIdx > 0) {
        s = s.substring(colonIdx + 1)
      }
    }
    // 匹配前剥离反引号转义：`Registry`::HKLM\... 在 `::` 之前有
    // 反引号，PS tokenizer 在运行时移除，但
    // 否则会阻止 ^ 锚定模式匹配。
    return s.replace(/`/g, '')
  }
  function providerOrUncDecisionForArg(arg: string): PermissionResult | null {
    const value = extractProviderPathFromArg(arg)
    if (NON_FS_PROVIDER_PATTERN.test(value)) {
      return {
        behavior: 'ask',
        message: `命令参数 '${arg}' 使用非文件系统 provider 路径，需要批准`,
      }
    }
    if (containsVulnerableUncPath(value)) {
      return {
        behavior: 'ask',
        message: `命令参数 '${arg}' 包含可能触发网络请求的 UNC 路径`,
      }
    }
    return null
  }
  providerScan: for (const statement of parsed.statements) {
    for (const cmd of statement.commands) {
      if (cmd.elementType !== 'CommandAst') continue
      for (const arg of cmd.args) {
        const decision = providerOrUncDecisionForArg(arg)
        if (decision !== null) {
          decisions.push(decision)
          break providerScan
        }
      }
    }
    if (statement.nestedCommands) {
      for (const cmd of statement.nestedCommands) {
        for (const arg of cmd.args) {
          const decision = providerOrUncDecisionForArg(arg)
          if (decision !== null) {
            decisions.push(decision)
            break providerScan
          }
        }
      }
    }
  }

  // 决策：每个子命令的拒绝/询问规则 — 曾是步骤 4（:711-803）。
  // 每个子命令最多产生一个决策（拒绝或询问）。在
  // 后续子命令上的拒绝规则仍通过 reduce 击败早期子命令上的询问规则。
  // 不需要存储 — reduce 结构上强制拒绝 > 询问。
  //
  // 安全检查：始终从 AST 派生数据构建规范命令字符串
  //（element.name + 空格连接的参数）并针对它检查规则。拒绝
  // 和允许必须使用相同的规范化形式以关闭不对称：
  //   - 调用操作符（`& 'Remove-Item' ./x`）：原始文本以 `&` 开头，
  //     在空白上分割产生操作符，而非 cmdlet 名。
  //   - 非空格空白（`rm\t./x`）：原始前缀匹配使用 `prefix + ' '`
  //    （字面空格），但 PowerShell 接受任何空白分隔符。
  //     checkPermissionMode 自动允许（使用 AST cmd.name）会匹配，而
  //     原始文本上的拒绝规则匹配会遗漏 — 拒绝规则绕过。
  //   - 模块前缀（`Microsoft.PowerShell.Management\Remove-Item`）：
  //     element.name 有模块前缀剥离。
  for (const { text: subCmd, element } of allSubCommands) {
    // element.name 在解析器处剥离引号（transformCommandAst），因此
    // `& 'Invoke-Expression' 'x'` 产生 name='Invoke-Expression'，非
    // "'Invoke-Expression'"。canonicalSubCmd 从相同的剥离
    // 名称构建，因此 `Invoke-Expression:*` 上的拒绝规则前缀匹配命中。
    const canonicalSubCmd =
      element.name !== '' ? [element.name, ...element.args].join(' ') : null

    const subInput = { command: subCmd }
    const { matchingDenyRules: subDenyRules, matchingAskRules: subAskRules } =
      matchingRulesForInput(subInput, toolPermissionContext, 'prefix')
    let matchedDenyRule = subDenyRules[0]
    let matchedAskRule = subAskRules[0]

    if (matchedDenyRule === undefined && canonicalSubCmd !== null) {
      const {
        matchingDenyRules: canonicalDenyRules,
        matchingAskRules: canonicalAskRules,
      } = matchingRulesForInput(
        { command: canonicalSubCmd },
        toolPermissionContext,
        'prefix',
      )
      matchedDenyRule = canonicalDenyRules[0]
      if (matchedAskRule === undefined) {
        matchedAskRule = canonicalAskRules[0]
      }
    }

    if (matchedDenyRule !== undefined) {
      decisions.push({
        behavior: 'deny',
        message: `使用 ${POWERSHELL_TOOL_NAME} 执行命令 ${command} 的权限已被拒绝。`,
        decisionReason: {
          type: 'rule',
          rule: matchedDenyRule,
        },
      })
    } else if (matchedAskRule !== undefined) {
      decisions.push({
        behavior: 'ask',
        message: createPermissionRequestMessage(POWERSHELL_TOOL_NAME),
        decisionReason: {
          type: 'rule',
          rule: matchedAskRule,
        },
      })
    }
  }

  // 决策：cd+git 复合防护 — 曾是步骤 4.42（:805-833）。
  // 当 cd/Set-Location 与 git 配对时，不允许不提示 —
  // cd 到恶意目录使 git 危险（假钩子、裸仓库
  // 攻击）。收集然后归约保持对 BashTool 的改进：在
  // bash 中，cd+git（B9，行 1416）在子命令拒绝（B11）之前运行，因此 cd+git
  // 询问掩盖拒绝。这里，两者在同一决策数组中；拒绝获胜。
  //
  // 安全检查：无 cd-to-CWD 无操作排除。之前的迭代排除
  // `Set-Location .` 作为无操作，但用于
  // 提取目标的"第一个非横杠参数"启发式被冒号绑定参数愚弄：
  // `Set-Location -Path:/etc .` — 真实目标是 /etc，启发式看到 `.`，
  // 排除触发，绕过。UX 情况（模型发出 `Set-Location .; foo`）
  // 很少见；攻击面不值得特殊情况。复合中的任何 cd 系列
  // cmdlet 都设置此标志，周期。
  // 只当有多个子命令时才标记复合 cd。独立的
  // `Set-Location ./subdir` 不是 TOCTOU 风险（没有后续语句针对
  // 过期 cwd 解析相对路径）。没有此项，独立 cd 强制
  // 复合防护，抑制每子命令自动允许路径。（bug #25）
  const hasCdSubCommand =
    allSubCommands.length > 1 &&
    allSubCommands.some(({ element }) => isCwdChangingCmdlet(element.name))
  // 符号链接创建复合防护（发现 #18 / bug 001+004）：当
  // 复合创建文件系统链接时，通过该链接的后续写入
  // 落到验证器视图之外。与 cwd 不同步相同的 TOCTOU 形态。
  const hasSymlinkCreate =
    allSubCommands.length > 1 &&
    allSubCommands.some(({ element }) => isSymlinkCreatingCommand(element))
  const hasGitSubCommand = allSubCommands.some(
    ({ element }) => resolveToCanonical(element.name) === 'git',
  )
  if (hasCdSubCommand && hasGitSubCommand) {
    decisions.push({
      behavior: 'ask',
      message: '带 cd/Set-Location 和 git 的复合命令需要批准，以防止裸仓库攻击',
    })
  }

  // cd+write 复合防护 — 被 checkPathConstraints(compoundCommandHasCd) 包含。
  // 之前此块在 hasCdSubCommand && hasAcceptEditsWrite 时推送 '询问'，
  // 但 checkPathConstraints 现在接收 hasCdSubCommand 并为 cd 复合中的任何
  // 路径操作（读或写）推送 '询问' — 在路径层更广泛的覆盖
  //（BashTool 对等）。步骤 5 !hasCdSubCommand 门和 modeValidation 的
  // 复合 cd 防护保持为纵深防御，用于不
  // 到达 checkPathConstraints 的路径（例如不在 CMDLET_PATH_CONFIG 中的 cmdlet）。

  // 决策：裸仓库防护 — bash 对等。
  // 如果 cwd 有 HEAD/objects/refs/ 而无有效的 .git/HEAD，Git 将
  // cwd 视为裸仓库并从 cwd 运行钩子。攻击者创建
  // hooks/pre-commit，删除 .git/HEAD，然后任何 git 子命令运行它。
  // BashTool readOnlyValidation.ts isCurrentDirectoryBareGitRepo 的移植。
  if (hasGitSubCommand && isCurrentDirectoryBareGitRepo()) {
    decisions.push({
      behavior: 'ask',
      message:
        '目录中有裸仓库指示符（cwd 中有 HEAD、objects/、refs/ 但无 .git/HEAD）的 Git 命令。Git 可能从 cwd 执行钩子。',
    })
  }

  // 决策：git 内部路径写入防护 — bash 对等。
  // 复合命令创建 HEAD/objects/refs/hooks/ 然后运行 git →
  // git 子命令执行刚创建的恶意钩子。针对 git 内部模式检查所有
  // 提取的写入路径 + 重定向目标。
  // BashTool commandWritesToGitInternalPaths 的移植，为 AST 调整。
  if (hasGitSubCommand) {
    const writesToGitInternal = allSubCommands.some(
      ({ element, statement }) => {
        // 此子命令上的重定向目标（原始 Extent.Text — 引号
        // 和 ./ 完整；规范化器处理两者）
        for (const r of element.redirections ?? []) {
          if (isGitInternalPathPS(r.target)) return true
        }
        // 写入 cmdlet 参数（new-item HEAD；mkdir hooks；set-content hooks/pre-commit）
        const canonical = resolveToCanonical(element.name)
        if (!GIT_SAFETY_WRITE_CMDLETS.has(canonical)) return false
        // 原始参数文本 — 规范化器剥离冒号绑定参数、引号、./、大小写。
        // PS ArrayLiteralAst（`New-Item a,hooks/pre-commit`）作为单个
        // 逗号连接参数出现 — 检查前分割。
        if (
          element.args
            .flatMap(a => a.split(','))
            .some(a => isGitInternalPathPS(a))
        ) {
          return true
        }
        // 管道输入：`"hooks/pre-commit" | New-Item -ItemType File` 在运行时将
        // 字符串绑定到 -Path。路径在非 CommandAst 管道
        // 元素中，不在 element.args 中。步骤 5 的 hasExpressionSource 防护
        // 已经在此强制批准；此检查只是添加 git 内部
        // 警告文本。
        if (statement !== null) {
          for (const c of statement.commands) {
            if (c.elementType === 'CommandAst') continue
            if (isGitInternalPathPS(c.text)) return true
          }
        }
        return false
      },
    )
    // 还检查顶层文件重定向（> hooks/pre-commit）
    const redirWritesToGitInternal = getFileRedirections(parsed).some(r =>
      isGitInternalPathPS(r.target),
    )
    if (writesToGitInternal || redirWritesToGitInternal) {
      decisions.push({
        behavior: 'ask',
        message:
          '命令写入 git 内部路径（HEAD、objects/、refs/、hooks/、.git/）并运行 git。这可能植入 git 随后执行的恶意钩子。',
      })
    }
    // 安全检查：归档解压 TOCTOU。isCurrentDirectoryBareGitRepo
    // 在权限评估时检查；`tar -xf x.tar; git status` 解压
    // 裸仓库指示符在检查之后、git 运行之前。与写入
    // cmdlet 不同（我们检查参数中的 git 内部路径），归档
    // 内容不透明 — 与 git 复合中的任何解压都必须询问。
    const hasArchiveExtractor = allSubCommands.some(({ element }) =>
      GIT_SAFETY_ARCHIVE_EXTRACTORS.has(element.name.toLowerCase()),
    )
    if (hasArchiveExtractor) {
      decisions.push({
        behavior: 'ask',
        message:
          '复合命令解压归档并运行 git。归档内容可能植入 git 随后视为仓库根的裸仓库指示符（HEAD、hooks/、refs/）。',
      })
    }
  }

  // 即使没有 git 子命令，.git/ 写入也危险 — 植入的
  // .git/hooks/pre-commit 在用户下次提交时触发。与
  // 上方的裸仓库检查不同（它门控于 hasGitSubCommand，因为 `hooks/`
  // 是常见项目目录名），`.git/` 是明确的。
  {
    const found =
      allSubCommands.some(({ element }) => {
        for (const r of element.redirections ?? []) {
          if (isDotGitPathPS(r.target)) return true
        }
        const canonical = resolveToCanonical(element.name)
        if (!GIT_SAFETY_WRITE_CMDLETS.has(canonical)) return false
        return element.args.flatMap(a => a.split(',')).some(isDotGitPathPS)
      }) || getFileRedirections(parsed).some(r => isDotGitPathPS(r.target))
    if (found) {
      decisions.push({
        behavior: 'ask',
        message: '命令写入 .git/ — 植入的钩子或 config 在下次 git 操作时执行。',
      })
    }
  }

  // 决策：路径约束 — 曾是步骤 4.44（:835-845）。
  // 被早期询问掩盖的拒绝能力检查。返回
  // 'deny' 当 Edit(...) 拒绝规则匹配提取路径时（pathValidation
  // 行 ~994、1088、1160、1210），'ask' 当路径在工作目录外时，或
  // '穿透'。
  //
  // 线程 hasCdSubCommand（BashTool compoundCommandHasCd 对等）：当
  // 复合包含 cwd 更改 cmdlet 时，checkPathConstraints 强制 '询问'
  // 对于带路径操作的任何语句 — 相对路径针对
  // 过期的验证器 cwd 解析，而非 PowerShell 的运行时 cwd。这是
  // CWD 不同步集群（发现 #3/#21/#27/#28）的架构修复，用路径解析层的单个门替换
  // 每个自动允许站点的防护。
  const pathResult = checkPathConstraints(
    input,
    parsed,
    toolPermissionContext,
    hasCdSubCommand,
  )
  if (pathResult.behavior !== 'passthrough') {
    decisions.push(pathResult)
  }

  // 决策：精确允许（解析成功情况）— 曾是步骤 4.45（:861-867）。
  // 匹配 BashTool 顺序：子命令拒绝 → 路径约束 → 精确
  // 允许。Reduce 强制拒绝 > 询问 > 允许，因此精确允许只在
  // 无拒绝或询问触发时浮现 — 与顺序相同。
  //
  // 安全检查：nameType 门 — 镜像 L696-700 处的解析失败防护。
  // 输入侧 stripModulePrefix 是无条件的：`scripts\Get-Content`
  // 剥离为 `Get-Content`，canonicalCommand 匹配精确允许。没有
  // 此门，允许进入 decisions[]，reduce 在步骤 5 之前返回它
  // 能检查 nameType — PowerShell 运行本地 .ps1 文件。解析
  // 成功时第一个命令元素的 AST nameType 是权威的；'application' 意味着脚本/可执行路径，非 cmdlet。
  // 安全检查：与下方每子命令循环相同的 argLeaksValue 门
  //（发现 #32）。没有它，`PowerShell(Write-Output:*)` 精确匹配
  // `Write-Output $env:ANTHROPIC_API_KEY`，推送允许到 decisions[]，
  // reduce 在每子命令门运行之前返回它。
  // allSubCommands.every 检查确保语句中没有命令泄露
  //（单命令精确允许有一个元素；管道有几个）。
  //
  // 安全检查：nameType 门必须检查所有子命令，不仅仅是 [0]
  //（发现 #10）。L171 处的 canonicalCommand 将 `\n` → 空格折叠，因此
  // `code\n.\build.ps1`（两个语句）匹配精确规则
  // `PowerShell(code .\build.ps1)`。只检查 allSubCommands[0] 让
  // 第二个语句（nameType=application，脚本路径）通过。要求
  // 每个子命令都有 nameType !== 'application'。
  if (
    exactMatchResult.behavior === 'allow' &&
    allSubCommands[0] !== undefined &&
    allSubCommands.every(
      sc =>
        sc.element.nameType !== 'application' &&
        !argLeaksValue(sc.text, sc.element),
    )
  ) {
    decisions.push(exactMatchResult)
  }

  // 决策：只读白名单 — 曾是步骤 4.5（:869-885）。
  // 镜像 Bash 对 ls、cat、git status 等的自动允许。PowerShell
  // 等价物：Get-Process、Get-ChildItem、Get-Content、git log 等。
  // Reduce 将此放在子命令询问规则之下（询问 > 允许）。
  if (isReadOnlyCommand(command, parsed)) {
    decisions.push({
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: '命令是只读的，可以安全执行',
      },
    })
  }

  // 决策：文件重定向 — 曾是 :887-900。
  // 重定向（>、>>、2>）写入任意路径。isReadOnlyCommand
  // 内部已经拒绝重定向，因此这无法与上方的只读允许冲突。Reduce 将它放在 checkPermissionMode 允许之上。
  const fileRedirections = getFileRedirections(parsed)
  if (fileRedirections.length > 0) {
    decisions.push({
      behavior: 'ask',
      message: '命令包含可能写入任意路径的文件重定向',
      suggestions: suggestionForExactCommand(command),
    })
  }

  // 决策：模式特定处理（acceptEdits）— 曾是步骤 4.7（:902-906）。
  // checkPermissionMode 只返回 'allow' | '穿透'。
  const modeResult = checkPermissionMode(input, parsed, toolPermissionContext)
  if (modeResult.behavior !== 'passthrough') {
    decisions.push(modeResult)
  }

  // 归约：拒绝 > 询问 > 允许 > 穿透。每种行为类型的第一个
  // 获胜（为单检查情况保留步骤顺序消息）。如果无
  // 决策，穿透到步骤 5 每子命令批准收集。
  const deniedDecision = decisions.find(d => d.behavior === 'deny')
  if (deniedDecision !== undefined) {
    return deniedDecision
  }
  const askDecision = decisions.find(d => d.behavior === 'ask')
  if (askDecision !== undefined) {
    return askDecision
  }
  const allowDecision = decisions.find(d => d.behavior === 'allow')
  if (allowDecision !== undefined) {
    return allowDecision
  }

  // 5. 管道/语句分割：独立检查每个子命令。
  // 这防止像 "Get-Process:*" 这样的前缀规则静默允许
  // 像管道命令 "Get-Process | Stop-Process -Force"。
  // 注意：拒绝规则已在上方（4.4）检查，因此此循环处理
  // 询问规则、显式允许规则和只读白名单回退。

  // 过滤掉安全输出 cmdlet（Format-Table 等）— 它们在步骤 4.4 中
  // 已检查拒绝规则，但不应需要独立批准。
  // 还过滤掉 cd/Set-Location 到 CWD（模型习惯，Bash 对等）。
  const subCommands = allSubCommands.filter(({ element, isSafeOutput }) => {
    if (isSafeOutput) {
      return false
    }
    // 安全检查：nameType 门 — 第六个位置。从批准列表中过滤是
    // 自动允许的一种形式。scripts\\Set-Location . 会在下方匹配
    //（剥离名 'Set-Location'，参数 '.' → CWD）并被静默丢弃，
    // 然后 scripts\\Set-Location.ps1 无提示执行。将 'application'
    // 命令保留在列表中，使它们到达 isAllowlistedCommand（它拒绝它们）。
    if (element.nameType === 'application') {
      return true
    }
    const canonical = resolveToCanonical(element.name)
    if (canonical === 'set-location' && element.args.length > 0) {
      // 安全检查：使用 PS_TOKENIZER_DASH_CHARS，而非仅 ASCII startsWith('-')。
      // `Set-Location –Path .`（en-dash）否则将 `–Path` 视为
      // 目标，针对 cwd 解析（不匹配），并将命令保留在
      // 批准列表中 — 正确。但 `Set-Location –LiteralPath evil` 带
      // en-dash 会找到 `–LiteralPath` 作为"目标"，不匹配 cwd，留在
      // 列表中 — 也正确。风险是反向：Unicode 横杠参数
      // 被视为位置目标。使用 tokenizer 横杠集。
      const target = element.args.find(
        a => a.length === 0 || !PS_TOKENIZER_DASH_CHARS.has(a[0]!),
      )
      if (target && resolve(getCwd(), target) === getCwd()) {
        return false
      }
    }
    return true
  })

  // 注意：cd+git 复合防护已在步骤 4.42 运行。如果我们到达此处，
  // 复合中要么没有 cd，要么没有 git。

  const subCommandsNeedingApproval: string[] = []
  // 语句的子命令被推送到 subCommandsNeedingApproval
  // 在下方步骤 5 循环中。故障关闭门（循环后）只
  // 推送未被此处跟踪的语句 — 防止重复建议，其中
  //"Get-Process"（子命令）和 "$x = Get-Process"（完整语句）都出现。
  //
  // 安全检查：只在 PUSH 时跟踪，非循环入口。
  // 如果语句的唯一子命令通过用户允许规则
  //（L1113）`continue`，在循环入口标记它已见会使故障关闭门
  // 跳过它 — 自动允许不可见的非 CommandAst 内容如裸
  // `$env:SECRET` 在控制流内。示例攻击：用户批准
  // Get-Process，然后 `if ($true) { Get-Process; $env:SECRET }` — Get-Process
  // 被允许规则（continue，无推送），$env:SECRET 是 VariableExpressionAst
  //（非子命令），语句标记已见 → 门跳过 → 自动允许 →
  // 秘密泄露。仅在推送时跟踪：语句保持未见 → 门触发
  // → 询问。
  const statementsSeenInLoop = new Set<
    ParsedPowerShellCommand['statements'][number]
  >()

  for (const { text: subCmd, element, statement } of subCommands) {
    // 先检查拒绝规则 - 用户显式规则优先于白名单
    const subInput = { command: subCmd }
    const subResult = powershellToolCheckPermission(
      subInput,
      toolPermissionContext,
    )

    if (subResult.behavior === 'deny') {
      return {
        behavior: 'deny',
        message: `使用 ${POWERSHELL_TOOL_NAME} 执行命令 ${command} 的权限已被拒绝。`,
        decisionReason: subResult.decisionReason,
      }
    }

    if (subResult.behavior === 'ask') {
      if (statement !== null) {
        statementsSeenInLoop.add(statement)
      }
      subCommandsNeedingApproval.push(subCmd)
      continue
    }

    // 由用户规则显式允许 — 但不适用于应用程序/脚本。
    // 安全检查：输入侧 stripModulePrefix 是无条件的，因此
    // `scripts\Get-Content /etc/shadow` 剥离为 'Get-Content' 并匹配
    // 允许规则 `Get-Content:*`。没有 nameType 防护，continue
    // 跳过所有检查，本地脚本运行。nameType 从
    // 剥离前的原始名称分类 — `scripts\Get-Content` → 'application'（有 `\`）。
    // 模块限定 cmdlet 也归类为 'application' — 安全失败过度触发。
    // 应用程序永远不应被 cmdlet 允许规则自动允许。
    if (
      subResult.behavior === 'allow' &&
      element.nameType !== 'application' &&
      !hasSymlinkCreate
    ) {
      // 安全检查：用户允许规则断言 cmdlet 是安全的，而非
      // 通过它的任意变量展开是安全的。允许
      // PowerShell(Write-Output:*) 的用户无意自动允许
      // `Write-Output $env:ANTHROPIC_API_KEY`。应用与保护
      // 下方内置白名单路径相同的 argLeaksValue 门 — 拒绝
      // Variable/Other/ScriptBlock/SubExpression elementTypes 和冒号绑定
      // 表达式子项。（安全发现 #32）
      //
      // 安全检查：当复合包含符号链接创建命令时也跳过
      //（发现 — 符号链接+读取差距）。New-Item -ItemType SymbolicLink
      // 可以将后续读取重定向到任意路径。内置
      // 白名单路径（下方）和 acceptEdits 路径都门控
      // !hasSymlinkCreate；用户规则路径也必须如此。
      if (argLeaksValue(subCmd, element)) {
        if (statement !== null) {
          statementsSeenInLoop.add(statement)
        }
        subCommandsNeedingApproval.push(subCmd)
        continue
      }
      continue
    }
    if (subResult.behavior === 'allow') {
      // nameType === 'application' 带匹配允许规则：规则
      // 为 cmdlet 编写，但这是伪装的脚本/可执行文件。
      // 不要 continue；穿透到批准（非拒绝 — 用户可能
      // 实际想运行 `scripts\Get-Content` 并会看到提示）。
      if (statement !== null) {
        statementsSeenInLoop.add(statement)
      }
      subCommandsNeedingApproval.push(subCmd)
      continue
    }

    // 安全检查：故障关闭门。除非父语句是 PipelineAst，其中每个元素是
    // CommandAst，否则不要走白名单快捷方式。这包含
    // 之前的 hasExpressionSource 检查（表达式源是语句未通过门的一种方式），并
    // 按构造拒绝赋值、链操作符、控制流和任何未来
    // AST 类型。这阻止的示例：
    //   'env:SECRET_API_KEY' | Get-Content  — CommandExpressionAst 元素
    //   $x = Get-Process                   — AssignmentStatementAst
    //   Get-Process && Get-Service         — PipelineChainAst
    // 显式用户允许规则（上方）在此门之前运行，但应用
    // 自己的 argLeaksValue 检查；两条路径现在都门控参数 elementTypes。
    //
    // 安全检查：当复合包含 cwd 更改 cmdlet 时也跳过
    //（发现 #27 — cd+读取差距）。isAllowlistedCommand 隔离地验证 Get-Content，
    // 但 `Set-Location ~; Get-Content ./.ssh/id_rsa` 从 ~ 运行
    // Get-Content，而非验证器的 cwd。路径验证看到
    // /project/.ssh/id_rsa；运行时读取 ~/.ssh/id_rsa。与
    // 下方的 checkPermissionMode 调用和 checkPathConstraints 线程相同的门。
    if (
      statement !== null &&
      !hasCdSubCommand &&
      !hasSymlinkCreate &&
      isProvablySafeStatement(statement) &&
      isAllowlistedCommand(element, subCmd)
    ) {
      continue
    }

    // 检查每子命令 acceptEdits 模式（BashTool 对等）。
    // 委托给单语句 AST 的 checkPermissionMode，使其所有
    // 防护都适用：表达式管道源（非 CommandAst 元素）、
    // 安全标志（子表达式、脚本块、赋值、splatting 等），
    // 和 ACCEPT_EDITS_ALLOWED_CMDLETS 白名单。这保持一个关于
    // acceptEdits 模式中语句安全的真值来源 — checkPermissionMode 的任何未来
    // 加固都会自动应用于此处。
    //
    // 传递 parsed.variables（非 []），使复合命令中任何语句的 splatting 都
    // 可见。保守：如果我们无法判断 splatted 变量影响哪个语句，
    // 假设它影响所有语句。
    //
    // 安全检查：当复合包含
    // cwd 更改命令（Set-Location/Push-Location/Pop-Location）时跳过此自动允许路径。
    // 合成的单语句 AST 剥离复合上下文，因此
    // checkPermissionMode 无法看到其他语句中的 cd。没有此
    // 门，`Set-Location ./.hclaude; Set-Content ./settings.json '...'` 会
    // 通过：Set-Content 隔离检查，匹配 ACCEPT_EDITS_ALLOWED_CMDLETS，
    // 自动允许 — 但 PowerShell 从更改的 cwd 运行它，写入到
    // .hclaude/settings.json（路径验证器未检查的 Claude config 文件）。
    // 这匹配 BashTool 的 compoundCommandHasCd 防护。
    if (statement !== null && !hasCdSubCommand && !hasSymlinkCreate) {
      const subModeResult = checkPermissionMode(
        { command: subCmd },
        {
          valid: true,
          errors: [],
          variables: parsed.variables,
          hasStopParsing: parsed.hasStopParsing,
          originalCommand: subCmd,
          statements: [statement],
        },
        toolPermissionContext,
      )
      if (subModeResult.behavior === 'allow') {
        continue
      }
    }

    // 不在白名单，无模式自动允许，无显式规则 — 需要批准
    if (statement !== null) {
      statementsSeenInLoop.add(statement)
    }
    subCommandsNeedingApproval.push(subCmd)
  }

  // 安全检查：故障关闭门（下半部分）。上方步骤 5 循环只
  // 迭代 getSubCommandsForPermissionCheck 浮现
  // 并在安全输出过滤器中存活的子命令。产生零
  // CommandAst 子命令（裸 $env:SECRET）或其唯一子命令
  // 被过滤为安全输出（$env:X | Out-String）的语句从不进入循环。
  // 没有此项，它们在空的 subCommandsNeedingApproval 上静默自动允许。
  //
  // 只推送上方未跟踪的语句：如果循环从语句中 PUSHED 任何
  // 子命令，用户会看到提示。也推送
  // 语句文本会创建重复建议，其中接受
  // 子命令规则不防止重新提示。
  // 如果所有子命令 `continue`（允许规则 / 白名单 / 模式允许）
  // 语句未被跟踪，门在下方重新检查它 — 这是
  // 故障关闭属性。
  for (const stmt of parsed.statements) {
    if (!isProvablySafeStatement(stmt) && !statementsSeenInLoop.has(stmt)) {
      subCommandsNeedingApproval.push(stmt.text)
    }
  }

  if (subCommandsNeedingApproval.length === 0) {
    // 安全检查：空列表自动允许只在无
    // 不可验证内容时安全。如果管道有脚本块，每个安全输出
    // cmdlet 在 :1032 过滤，但块内容未验证 —
    // 非命令 AST 节点（AssignmentStatementAst 等）对
    // getAllCommands 不可见。`Where-Object {$true} | Sort-Object {$env:PATH='evil'}`
    // 会在此处自动允许。hasAssignments 是仅顶层（parser.ts:1385），
    // 因此它也不捕获嵌套赋值。改为提示。
    if (deriveSecurityFlags(parsed).hasScriptBlocks) {
      return {
        behavior: 'ask',
        message: createPermissionRequestMessage(POWERSHELL_TOOL_NAME),
        decisionReason: {
          type: 'other',
          reason: '管道由带脚本块的输出格式化 cmdlet 组成 — 块内容无法验证',
        },
      }
    }
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: '所有管道命令单独允许',
      },
    }
  }

  // 6. 一些子命令需要批准 — 构建建议
  const decisionReason = {
    type: 'other' as const,
    reason: '此命令需要批准',
  }

  const pendingSuggestions: PermissionUpdate[] = []
  for (const subCmd of subCommandsNeedingApproval) {
    pendingSuggestions.push(...suggestionForExactCommand(subCmd))
  }

  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(
      POWERSHELL_TOOL_NAME,
      decisionReason,
    ),
    decisionReason,
    suggestions: pendingSuggestions,
  }
}
