import { memoize } from 'lodash-es'
import type { Command } from 'src/commands.js'
import {
  getCommandName,
  getSkillToolCommands,
  getSlashCommandToolSkills,
} from 'src/commands.js'
import { COMMAND_NAME_TAG } from 'src/constants/xml.js'
import { stringWidth } from '@anthropic/ink'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { count } from 'src/utils/array.js'
import { logForDebugging } from 'src/utils/debug.js'
import { toError } from 'src/utils/errors.js'
import { truncate } from 'src/utils/format.js'
import { logError } from 'src/utils/log.js'

// skill 列表占用上下文窗口的 1%（按字符数计）
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
export const CHARS_PER_TOKEN = 4
export const DEFAULT_CHAR_BUDGET = 8_000 // 兜底值：200k 的 1% × 4

// 每条目的硬上限。列表仅用于发现 —— Skill 工具在调用时会加载完整内容，
// 因此冗长的 whenToUse 字符串只会浪费 turn-1 的 cache_creation token，
// 而不会提升匹配率。适用于所有条目（包括 bundled），因为该上限已经
// 足够宽松，能保留核心用例。
// v2.1.117：从 250 提升至 1536，以支持更丰富的 skill 描述。
export const MAX_LISTING_DESC_CHARS = 1536

export function getCharBudget(contextWindowTokens?: number): number {
  if (Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)) {
    return Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)
  }
  if (contextWindowTokens) {
    return Math.floor(
      contextWindowTokens * CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT,
    )
  }
  return DEFAULT_CHAR_BUDGET
}

function getCommandDescription(cmd: Command): string {
  const desc = cmd.whenToUse
    ? `${cmd.description} - ${cmd.whenToUse}`
    : cmd.description
  return desc.length > MAX_LISTING_DESC_CHARS
    ? desc.slice(0, MAX_LISTING_DESC_CHARS - 1) + '\u2026'
    : desc
}

function formatCommandDescription(cmd: Command): string {
  // 调试：记录 plugin skill 的 userFacingName 与 cmd.name 不一致的情况
  const displayName = getCommandName(cmd)
  if (
    cmd.name !== displayName &&
    cmd.type === 'prompt' &&
    cmd.source === 'plugin'
  ) {
    logForDebugging(
      `Skill prompt: showing "${cmd.name}" (userFacingName="${displayName}")`,
    )
  }

  return `- ${cmd.name}: ${getCommandDescription(cmd)}`
}

const MIN_DESC_LENGTH = 20

export function formatCommandsWithinBudget(
  commands: Command[],
  contextWindowTokens?: number,
): string {
  if (commands.length === 0) return ''

  const budget = getCharBudget(contextWindowTokens)

  // 先尝试完整描述
  const fullEntries = commands.map(cmd => ({
    cmd,
    full: formatCommandDescription(cmd),
  }))
  // join('\n') 对 N 条目会产出 N-1 个换行
  const fullTotal =
    fullEntries.reduce((sum, e) => sum + stringWidth(e.full), 0) +
    (fullEntries.length - 1)

  if (fullTotal <= budget) {
    return fullEntries.map(e => e.full).join('\n')
  }

  // 将 bundled（永不截断）与其他条目分组
  const bundledIndices = new Set<number>()
  const restCommands: Command[] = []
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]!
    if (cmd.type === 'prompt' && cmd.source === 'bundled') {
      bundledIndices.add(i)
    } else {
      restCommands.push(cmd)
    }
  }

  // 计算 bundled skill 占用的空间（使用完整描述，始终保留）
  const bundledChars = fullEntries.reduce(
    (sum, e, i) =>
      bundledIndices.has(i) ? sum + stringWidth(e.full) + 1 : sum,
    0,
  )
  const remainingBudget = budget - bundledChars

  // 计算非 bundled 命令的最大描述长度
  if (restCommands.length === 0) {
    return fullEntries.map(e => e.full).join('\n')
  }

  const restNameOverhead =
    restCommands.reduce((sum, cmd) => sum + stringWidth(cmd.name) + 4, 0) +
    (restCommands.length - 1)
  const availableForDescs = remainingBudget - restNameOverhead
  const maxDescLen = Math.floor(availableForDescs / restCommands.length)

  if (maxDescLen < MIN_DESC_LENGTH) {
    // 极端情况：非 bundled 仅保留名称，bundled 保留描述
    if (process.env.USER_TYPE === 'ant') {
      logEvent('tengu_skill_descriptions_truncated', {
        skill_count: commands.length,
        budget,
        full_total: fullTotal,
        truncation_mode:
          'names_only' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        max_desc_length: maxDescLen,
        bundled_count: bundledIndices.size,
        bundled_chars: bundledChars,
      })
    }
    return commands
      .map((cmd, i) =>
        bundledIndices.has(i) ? fullEntries[i]!.full : `- ${cmd.name}`,
      )
      .join('\n')
  }

  // 截断非 bundled 描述以适应预算
  const truncatedCount = count(
    restCommands,
    cmd => stringWidth(getCommandDescription(cmd)) > maxDescLen,
  )
  if (process.env.USER_TYPE === 'ant') {
    logEvent('tengu_skill_descriptions_truncated', {
      skill_count: commands.length,
      budget,
      full_total: fullTotal,
      truncation_mode:
        'description_trimmed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      max_desc_length: maxDescLen,
      truncated_count: truncatedCount,
      // 本 prompt 中包含的 bundled skill 数量（不含设置了 disableModelInvocation 的 skill）
      bundled_count: bundledIndices.size,
      bundled_chars: bundledChars,
    })
  }
  return commands
    .map((cmd, i) => {
      // bundled skill 始终保留完整描述
      if (bundledIndices.has(i)) return fullEntries[i]!.full
      const description = getCommandDescription(cmd)
      return `- ${cmd.name}: ${truncate(description, maxDescLen)}`
    })
    .join('\n')
}

export const getPrompt = memoize(async (_cwd: string): Promise<string> => {
  return `在主对话中执行一个 skill

当用户要求你执行任务时，检查是否有可用的 skill 匹配。Skill 提供专业能力和领域知识。

当用户引用"slash command"或"/<某命令>"（例如 "/commit"、"/review-pr"）时，他们指的是一个 skill。使用此工具来调用它。

如何调用：
- 使用此工具，传入 skill 名称和可选参数
- 示例：
  - \`skill: "pdf"\` - 调用 pdf skill
  - \`skill: "commit", args: "-m 'Fix bug'"\` - 带参数调用
  - \`skill: "review-pr", args: "123"\` - 带参数调用
  - \`skill: "ms-office-suite:pdf"\` - 使用完全限定名称调用

注意：
- 可用的 skill 列在对话中的 system-reminder 消息里
- 当某个 skill 匹配用户请求时，这是一个强制要求：在生成任何其他响应之前，必须先调用相关的 Skill 工具
- 绝对不要提及一个 skill 却不实际调用此工具
- 不要调用已经在运行的 skill
- 不要对内置 CLI 命令（如 /help、/clear 等）使用此工具
- 如果在当前对话轮次中看到 <${COMMAND_NAME_TAG}> 标签，表示该 skill 已经加载——直接按指令操作，不要再次调用此工具
`
})

export async function getSkillToolInfo(cwd: string): Promise<{
  totalCommands: number
  includedCommands: number
}> {
  const agentCommands = await getSkillToolCommands(cwd)

  return {
    totalCommands: agentCommands.length,
    includedCommands: agentCommands.length,
  }
}

// 返回 SkillTool prompt 中包含的命令。
// 所有命令都会被包含（描述可能会被截断以适应预算）。
// 被 analyzeContext 用于统计 skill token 数。
export function getLimitedSkillToolCommands(cwd: string): Promise<Command[]> {
  return getSkillToolCommands(cwd)
}

export function clearPromptCache(): void {
  getPrompt.cache?.clear?.()
}

export async function getSkillInfo(cwd: string): Promise<{
  totalSkills: number
  includedSkills: number
}> {
  try {
    const skills = await getSlashCommandToolSkills(cwd)

    return {
      totalSkills: skills.length,
      includedSkills: skills.length,
    }
  } catch (error) {
    logError(toError(error))

    // 返回零值而不是抛出异常 —— 由调用方决定如何处理
    return {
      totalSkills: 0,
      includedSkills: 0,
    }
  }
}
