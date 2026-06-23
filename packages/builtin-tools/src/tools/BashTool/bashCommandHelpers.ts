import type { z } from 'zod/v4'
import {
  isUnsafeCompoundCommand_DEPRECATED,
  splitCommand_DEPRECATED,
} from 'src/utils/bash/commands.js'
import {
  buildParsedCommandFromRoot,
  type IParsedCommand,
  ParsedCommand,
} from 'src/utils/bash/ParsedCommand.js'
import { type Node, PARSE_ABORTED } from 'src/utils/bash/parser.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import type { PermissionUpdate } from 'src/utils/permissions/PermissionUpdateSchema.js'
import { createPermissionRequestMessage } from 'src/utils/permissions/permissions.js'
import { BashTool } from './BashTool.js'
import { bashCommandIsSafeAsync_DEPRECATED } from './bashSecurity.js'

export type CommandIdentityCheckers = {
  isNormalizedCdCommand: (command: string) => boolean
  isNormalizedGitCommand: (command: string) => boolean
}

async function segmentedCommandPermissionResult(
  input: z.infer<typeof BashTool.inputSchema>,
  segments: string[],
  bashToolHasPermissionFn: (
    input: z.infer<typeof BashTool.inputSchema>,
  ) => Promise<PermissionResult>,
  checkers: CommandIdentityCheckers,
): Promise<PermissionResult> {
  // 检查所有段中是否存在多个 cd 命令
  const cdCommands = segments.filter(segment => {
    const trimmed = segment.trim()
    return checkers.isNormalizedCdCommand(trimmed)
  })
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

  // 安全：检查管道段之间的 cd+git 组合以防止裸仓库 fsmonitor 绕过。
  // 当 cd 和 git 位于不同的管道段时（例如 "cd sub && echo | git status"），
  // 每个段会被独立检查，都不会触发 bashPermissions.ts 中的 cd+git 检查。
  // 必须在此处检测这种跨段模式。
  // 每个管道段本身可以是复合命令（例如 "cd sub && echo"），
  // 因此在检查前需将每个段拆分为子命令。
  {
    let hasCd = false
    let hasGit = false
    for (const segment of segments) {
      const subcommands = splitCommand_DEPRECATED(segment)
      for (const sub of subcommands) {
        const trimmed = sub.trim()
        if (checkers.isNormalizedCdCommand(trimmed)) {
          hasCd = true
        }
        if (checkers.isNormalizedGitCommand(trimmed)) {
          hasGit = true
        }
      }
    }
    if (hasCd && hasGit) {
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

  const segmentResults = new Map<string, PermissionResult>()

  // 通过完整的权限系统检查每个分段
  for (const segment of segments) {
    const trimmedSegment = segment.trim()
    if (!trimmedSegment) continue // 跳过空分段

    const segmentResult = await bashToolHasPermissionFn({
      ...input,
      command: trimmedSegment,
    })
    segmentResults.set(trimmedSegment, segmentResult)
  }

  // 检查是否有任一分段被拒绝（在评估完所有分段之后）
  const deniedSegment = Array.from(segmentResults.entries()).find(
    ([, result]) => result.behavior === 'deny',
  )

  if (deniedSegment) {
    const [segmentCommand, segmentResult] = deniedSegment
    return {
      behavior: 'deny',
      message:
        segmentResult.behavior === 'deny'
          ? segmentResult.message
          : `Permission denied for: ${segmentCommand}`,
      decisionReason: {
        type: 'subcommandResults',
        reasons: segmentResults,
      },
    }
  }

  const allAllowed = Array.from(segmentResults.values()).every(
    result => result.behavior === 'allow',
  )

  if (allAllowed) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'subcommandResults',
        reasons: segmentResults,
      },
    }
  }

  // 从需要批准的分段中收集建议
  const suggestions: PermissionUpdate[] = []
  for (const [, result] of segmentResults) {
    if (
      result.behavior !== 'allow' &&
      'suggestions' in result &&
      result.suggestions
    ) {
      suggestions.push(...result.suggestions)
    }
  }

  const decisionReason = {
    type: 'subcommandResults' as const,
    reasons: segmentResults,
  }

  return {
    behavior: 'ask',
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    decisionReason,
    suggestions: suggestions.length > 0 ? suggestions : undefined,
  }
}

/**
 * 构建命令分段，剥离输出重定向，以避免在权限检查时把文件名误当作命令。
 * 使用 ParsedCommand 以保留原始引号。
 */
async function buildSegmentWithoutRedirections(
  segmentCommand: string,
): Promise<string> {
  // 快速路径：若不存在重定向操作符，则跳过解析
  if (!segmentCommand.includes('>')) {
    return segmentCommand
  }

  // 使用 ParsedCommand 剥离重定向，同时保留引号
  const parsed = await ParsedCommand.parse(segmentCommand)
  return parsed?.withoutOutputRedirections() ?? segmentCommand
}

/**
 * 包装函数：解析 IParsedCommand（若可用则从预解析的 AST root 构建，
 * 否则通过 ParsedCommand.parse），再委托给
 * bashToolCheckCommandOperatorPermissions。
 */
export async function checkCommandOperatorPermissions(
  input: z.infer<typeof BashTool.inputSchema>,
  bashToolHasPermissionFn: (
    input: z.infer<typeof BashTool.inputSchema>,
  ) => Promise<PermissionResult>,
  checkers: CommandIdentityCheckers,
  astRoot: Node | null | typeof PARSE_ABORTED,
): Promise<PermissionResult> {
  const parsed =
    astRoot && astRoot !== PARSE_ABORTED
      ? buildParsedCommandFromRoot(input.command, astRoot)
      : await ParsedCommand.parse(input.command)
  if (!parsed) {
    return { behavior: 'passthrough', message: 'Failed to parse command' }
  }
  return bashToolCheckCommandOperatorPermissions(
    input,
    bashToolHasPermissionFn,
    checkers,
    parsed,
  )
}

/**
 * 检查命令是否含有超出简单子命令检查范围的特殊操作符。
 */
async function bashToolCheckCommandOperatorPermissions(
  input: z.infer<typeof BashTool.inputSchema>,
  bashToolHasPermissionFn: (
    input: z.infer<typeof BashTool.inputSchema>,
  ) => Promise<PermissionResult>,
  checkers: CommandIdentityCheckers,
  parsed: IParsedCommand,
): Promise<PermissionResult> {
  // 1. 检查是否存在不安全的复合命令（子 shell、命令分组）。
  const tsAnalysis = parsed.getTreeSitterAnalysis()
  const isUnsafeCompound = tsAnalysis
    ? tsAnalysis.compoundStructure.hasSubshell ||
      tsAnalysis.compoundStructure.hasCommandGroup
    : isUnsafeCompoundCommand_DEPRECATED(input.command)
  if (isUnsafeCompound) {
    // 此命令包含类似 `>` 的操作符，我们不把它作为子命令分隔符支持
    // 检查 bashCommandIsSafe_DEPRECATED 是否提供了更具体的消息
    const safetyResult = await bashCommandIsSafeAsync_DEPRECATED(input.command)

    const decisionReason = {
      type: 'other' as const,
      reason:
        safetyResult.behavior === 'ask' && safetyResult.message
          ? safetyResult.message
          : 'This command uses shell operators that require approval for safety',
    }
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
      decisionReason,
      // 这是一个不安全的复合命令，因此我们不希望给出规则建议，因为我们也无法允许它
    }
  }

  // 2. 使用 ParsedCommand 检查管道命令（保留引号）
  const pipeSegments = parsed.getPipeSegments()

  // 若没有管道（单分段），交给正常流程处理
  if (pipeSegments.length <= 1) {
    return {
      behavior: 'passthrough',
      message: 'No pipes found in command',
    }
  }

  // 对每个分段剥离输出重定向，同时保留引号
  const segments = await Promise.all(
    pipeSegments.map(segment => buildSegmentWithoutRedirections(segment)),
  )

  // 作为分段命令处理
  return segmentedCommandPermissionResult(
    input,
    segments,
    bashToolHasPermissionFn,
    checkers,
  )
}
