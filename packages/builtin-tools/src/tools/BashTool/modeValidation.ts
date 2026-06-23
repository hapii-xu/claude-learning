import type { z } from 'zod/v4'
import type { ToolPermissionContext } from 'src/Tool.js'
import { splitCommand_DEPRECATED } from 'src/utils/bash/commands.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import type { BashTool } from './BashTool.js'

const ACCEPT_EDITS_ALLOWED_COMMANDS = [
  'mkdir',
  'touch',
  'rm',
  'rmdir',
  'mv',
  'cp',
  'sed',
] as const

type FilesystemCommand = (typeof ACCEPT_EDITS_ALLOWED_COMMANDS)[number]

function isFilesystemCommand(command: string): command is FilesystemCommand {
  return ACCEPT_EDITS_ALLOWED_COMMANDS.includes(command as FilesystemCommand)
}

function validateCommandForMode(
  cmd: string,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const trimmedCmd = cmd.trim()
  const [baseCmd] = trimmedCmd.split(/\s+/)

  if (!baseCmd) {
    return {
      behavior: 'passthrough',
      message: 'Base command not found',
    }
  }

  // 在 Accept Edits 模式下，自动允许文件系统操作
  if (
    toolPermissionContext.mode === 'acceptEdits' &&
    isFilesystemCommand(baseCmd)
  ) {
    return {
      behavior: 'allow',
      updatedInput: { command: cmd },
      decisionReason: {
        type: 'mode',
        mode: 'acceptEdits',
      },
    }
  }

  return {
    behavior: 'passthrough',
    message: `No mode-specific handling for '${baseCmd}' in ${toolPermissionContext.mode} mode`,
  }
}

/**
 * 检查命令是否应根据当前权限模式采用不同的处理方式
 *
 * 这是基于模式的权限逻辑的主入口。
 * 目前处理 Accept Edits 模式下的文件系统命令，
 * 但设计上可扩展至其他模式。
 *
 * @param input - bash 命令输入
 * @param toolPermissionContext - 包含模式与权限的上下文
 * @returns
 * - 'allow' 表示当前模式允许自动批准
 * - 'ask' 表示该命令在当前模式下需要批准
 * - 'passthrough' 表示没有适用的模式专属处理
 */
export function checkPermissionMode(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  // 若处于 bypass 模式则跳过（在别处处理）
  if (toolPermissionContext.mode === 'bypassPermissions') {
    return {
      behavior: 'passthrough',
      message: 'Bypass mode is handled in main permission flow',
    }
  }

  // 若处于 dontAsk 模式则跳过（在主权限流程中处理）
  if (toolPermissionContext.mode === 'dontAsk') {
    return {
      behavior: 'passthrough',
      message: 'DontAsk mode is handled in main permission flow',
    }
  }

  const commands = splitCommand_DEPRECATED(input.command)

  // 检查每条子命令
  for (const cmd of commands) {
    const result = validateCommandForMode(cmd, toolPermissionContext)

    // 若任一命令触发模式专属行为，则返回该结果
    if (result.behavior !== 'passthrough') {
      return result
    }
  }

  // 无需任何模式专属处理
  return {
    behavior: 'passthrough',
    message: 'No mode-specific validation required',
  }
}

export function getAutoAllowedCommands(
  mode: ToolPermissionContext['mode'],
): readonly string[] {
  return mode === 'acceptEdits' ? ACCEPT_EDITS_ALLOWED_COMMANDS : []
}
