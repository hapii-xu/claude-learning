/**
 * 会话文件访问分析钩子。
 * 通过 Read、Grep、Glob 工具追踪对会话内存和转录文件的访问。
 * 同时通过 Read、Grep、Glob、Edit 和 Write 工具追踪 memdir 文件访问。
 */
import { feature } from 'bun:bundle'
import { registerHookCallbacks } from '../bootstrap/state.js'
import type { HookInput, HookJSONOutput } from '../entrypoints/agentSdkTypes.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { FILE_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileEditTool/constants.js'
import { inputSchema as editInputSchema } from '@claude-code-best/builtin-tools/tools/FileEditTool/types.js'
import { FileReadTool } from '@claude-code-best/builtin-tools/tools/FileReadTool/FileReadTool.js'
import { FILE_READ_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileReadTool/prompt.js'
import { FileWriteTool } from '@claude-code-best/builtin-tools/tools/FileWriteTool/FileWriteTool.js'
import { FILE_WRITE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileWriteTool/prompt.js'
import { GlobTool } from '@claude-code-best/builtin-tools/tools/GlobTool/GlobTool.js'
import { GLOB_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GlobTool/prompt.js'
import { GrepTool } from '@claude-code-best/builtin-tools/tools/GrepTool/GrepTool.js'
import { GREP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GrepTool/prompt.js'
import type { HookCallback } from '../types/hooks.js'
import {
  detectSessionFileType,
  detectSessionPatternType,
  isAutoMemFile,
  memoryScopeForPath,
} from './memoryFileDetection.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('../memdir/teamMemPaths.js') as typeof import('../memdir/teamMemPaths.js'))
  : null
const teamMemWatcher = feature('TEAMMEM')
  ? (require('../services/teamMemorySync/watcher.js') as typeof import('../services/teamMemorySync/watcher.js'))
  : null
const memoryShapeTelemetry = feature('MEMORY_SHAPE_TELEMETRY')
  ? (require('../memdir/memoryShapeTelemetry.js') as typeof import('../memdir/memoryShapeTelemetry.js'))
  : null

/* eslint-enable @typescript-eslint/no-require-imports */
import { getSubagentLogName } from './agentContext.js'

/**
 * 从工具输入中提取文件路径，用于 memdir 检测。
 * 覆盖 Read（file_path）、Edit（file_path）和 Write（file_path）。
 */
function getFilePathFromInput(
  toolName: string,
  toolInput: unknown,
): string | null {
  switch (toolName) {
    case FILE_READ_TOOL_NAME: {
      const parsed = FileReadTool.inputSchema.safeParse(toolInput)
      return parsed.success ? parsed.data.file_path : null
    }
    case FILE_EDIT_TOOL_NAME: {
      const parsed = editInputSchema().safeParse(toolInput)
      return parsed.success ? parsed.data.file_path : null
    }
    case FILE_WRITE_TOOL_NAME: {
      const parsed = FileWriteTool.inputSchema.safeParse(toolInput)
      return parsed.success ? parsed.data.file_path : null
    }
    default:
      return null
  }
}

/**
 * 从工具输入中提取文件类型。
 * 返回检测到的会话文件类型，或 null。
 */
function getSessionFileTypeFromInput(
  toolName: string,
  toolInput: unknown,
): 'session_memory' | 'session_transcript' | null {
  switch (toolName) {
    case FILE_READ_TOOL_NAME: {
      const parsed = FileReadTool.inputSchema.safeParse(toolInput)
      if (!parsed.success) return null
      return detectSessionFileType(parsed.data.file_path)
    }
    case GREP_TOOL_NAME: {
      const parsed = GrepTool.inputSchema.safeParse(toolInput)
      if (!parsed.success) return null
      // 若提供了路径则检查路径
      if (parsed.data.path) {
        const pathType = detectSessionFileType(parsed.data.path)
        if (pathType) return pathType
      }
      // 检查 glob 模式
      if (parsed.data.glob) {
        const globType = detectSessionPatternType(parsed.data.glob)
        if (globType) return globType
      }
      return null
    }
    case GLOB_TOOL_NAME: {
      const parsed = GlobTool.inputSchema.safeParse(toolInput)
      if (!parsed.success) return null
      // 若提供了路径则检查路径
      if (parsed.data.path) {
        const pathType = detectSessionFileType(parsed.data.path)
        if (pathType) return pathType
      }
      // 检查模式
      const patternType = detectSessionPatternType(parsed.data.pattern)
      if (patternType) return patternType
      return null
    }
    default:
      return null
  }
}

/**
 * 检查某次工具调用是否构成内存文件访问。
 * 检测会话内存（通过 Read/Grep/Glob）和 memdir 访问（通过 Read/Edit/Write）。
 * 使用与 PostToolUse 会话文件访问钩子相同的判断条件。
 */
export function isMemoryFileAccess(
  toolName: string,
  toolInput: unknown,
): boolean {
  if (getSessionFileTypeFromInput(toolName, toolInput) === 'session_memory') {
    return true
  }

  const filePath = getFilePathFromInput(toolName, toolInput)
  if (
    filePath &&
    (isAutoMemFile(filePath) ||
      (feature('TEAMMEM') && teamMemPaths!.isTeamMemFile(filePath)))
  ) {
    return true
  }

  return false
}

/**
 * PostToolUse 回调，用于记录会话文件访问事件。
 */
async function handleSessionFileAccess(
  input: HookInput,
  _toolUseID: string | null,
  _signal: AbortSignal | undefined,
): Promise<HookJSONOutput> {
  if (input.hook_event_name !== 'PostToolUse') return {}

  const fileType = getSessionFileTypeFromInput(
    input.tool_name as string,
    input.tool_input as string,
  )

  const subagentName = getSubagentLogName()
  const subagentProps = subagentName ? { subagent_name: subagentName } : {}

  if (fileType === 'session_memory') {
    logEvent('tengu_session_memory_accessed', { ...subagentProps })
  } else if (fileType === 'session_transcript') {
    logEvent('tengu_transcript_accessed', { ...subagentProps })
  }

  // Memdir 访问追踪
  const filePath = getFilePathFromInput(
    input.tool_name as string,
    input.tool_input as string,
  )
  if (filePath && isAutoMemFile(filePath)) {
    logEvent('tengu_memdir_accessed', {
      tool: input.tool_name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...subagentProps,
    })

    switch (input.tool_name) {
      case FILE_READ_TOOL_NAME:
        logEvent('tengu_memdir_file_read', { ...subagentProps })
        break
      case FILE_EDIT_TOOL_NAME:
        logEvent('tengu_memdir_file_edit', { ...subagentProps })
        break
      case FILE_WRITE_TOOL_NAME:
        logEvent('tengu_memdir_file_write', { ...subagentProps })
        break
    }
  }

  // 团队内存访问追踪
  if (feature('TEAMMEM') && filePath && teamMemPaths!.isTeamMemFile(filePath)) {
    logEvent('tengu_team_mem_accessed', {
      tool: input.tool_name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...subagentProps,
    })

    switch (input.tool_name) {
      case FILE_READ_TOOL_NAME:
        logEvent('tengu_team_mem_file_read', { ...subagentProps })
        break
      case FILE_EDIT_TOOL_NAME:
        logEvent('tengu_team_mem_file_edit', { ...subagentProps })
        teamMemWatcher?.notifyTeamMemoryWrite()
        break
      case FILE_WRITE_TOOL_NAME:
        logEvent('tengu_team_mem_file_write', { ...subagentProps })
        teamMemWatcher?.notifyTeamMemoryWrite()
        break
    }
  }

  if (feature('MEMORY_SHAPE_TELEMETRY') && filePath) {
    const scope = memoryScopeForPath(filePath)
    if (
      scope !== null &&
      (input.tool_name === FILE_EDIT_TOOL_NAME ||
        input.tool_name === FILE_WRITE_TOOL_NAME)
    ) {
      memoryShapeTelemetry!.logMemoryWriteShape(
        input.tool_name as string,
        input.tool_input as Record<string, unknown>,
        filePath,
        scope,
      )
    }
  }

  return {}
}

/**
 * 注册会话文件访问追踪钩子。
 * 在 CLI 初始化时调用。
 */
export function registerSessionFileAccessHooks(): void {
  const hook: HookCallback = {
    type: 'callback',
    callback: handleSessionFileAccess,
    timeout: 1, // 极短超时 - 仅用于日志记录
    internal: true,
  }

  registerHookCallbacks({
    PostToolUse: [
      { matcher: FILE_READ_TOOL_NAME, hooks: [hook] },
      { matcher: GREP_TOOL_NAME, hooks: [hook] },
      { matcher: GLOB_TOOL_NAME, hooks: [hook] },
      { matcher: FILE_EDIT_TOOL_NAME, hooks: [hook] },
      { matcher: FILE_WRITE_TOOL_NAME, hooks: [hook] },
    ],
  })
}
