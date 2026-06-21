import type { StructuredPatchHunk } from 'diff'
import { useMemo, useRef } from 'react'
import type { FileEditOutput } from '@claude-code-best/builtin-tools/tools/FileEditTool/types.js'
import type { Output as FileWriteOutput } from '@claude-code-best/builtin-tools/tools/FileWriteTool/FileWriteTool.js'
import type { Message } from '../types/message.js'

export type TurnFileDiff = {
  filePath: string
  hunks: StructuredPatchHunk[]
  isNewFile: boolean
  linesAdded: number
  linesRemoved: number
}

export type TurnDiff = {
  turnIndex: number
  userPromptPreview: string
  timestamp: string
  files: Map<string, TurnFileDiff>
  stats: {
    filesChanged: number
    linesAdded: number
    linesRemoved: number
  }
}

type FileEditResult = FileEditOutput | FileWriteOutput

type TurnDiffCache = {
  completedTurns: TurnDiff[]
  currentTurn: TurnDiff | null
  lastProcessedIndex: number
  lastTurnIndex: number
}

function isFileEditResult(result: unknown): result is FileEditResult {
  if (!result || typeof result !== 'object') return false
  const r = result as Record<string, unknown>
  // FileEditTool：有带内容的 structuredPatch
  // FileWriteTool（update）：有带内容的 structuredPatch
  // FileWriteTool（create）：有 type='create' 和 content（structuredPatch 为空）
  const hasFilePath = typeof r.filePath === 'string'
  const hasStructuredPatch =
    Array.isArray(r.structuredPatch) && r.structuredPatch.length > 0
  const isNewFile = r.type === 'create' && typeof r.content === 'string'
  return hasFilePath && (hasStructuredPatch || isNewFile)
}

function isFileWriteOutput(result: FileEditResult): result is FileWriteOutput {
  return (
    'type' in result && (result.type === 'create' || result.type === 'update')
  )
}

function countHunkLines(hunks: StructuredPatchHunk[]): {
  added: number
  removed: number
} {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

function getUserPromptPreview(message: Message): string {
  if (message.type !== 'user') return ''
  const content = message.message!.content
  const text = typeof content === 'string' ? content : ''
  // 截断到约 30 个字符
  if (text.length <= 30) return text
  return text.slice(0, 29) + '…'
}

function computeTurnStats(turn: TurnDiff): void {
  let totalAdded = 0
  let totalRemoved = 0
  for (const file of turn.files.values()) {
    totalAdded += file.linesAdded
    totalRemoved += file.linesRemoved
  }
  turn.stats = {
    filesChanged: turn.files.size,
    linesAdded: totalAdded,
    linesRemoved: totalRemoved,
  }
}

/**
 * 从消息中提取基于轮次的 diff。
 * 一个轮次定义为一个用户提示后跟助手响应和工具结果。
 * 每个有文件编辑的轮次都会包含在结果中。
 *
 * 使用增量累积 —— 仅处理自上次渲染以来的新消息。
 */
export function useTurnDiffs(messages: Message[]): TurnDiff[] {
  const cache = useRef<TurnDiffCache>({
    completedTurns: [],
    currentTurn: null,
    lastProcessedIndex: 0,
    lastTurnIndex: 0,
  })

  return useMemo(() => {
    const c = cache.current

    // 如果消息减少则重置（用户回退了对话）
    if (messages.length < c.lastProcessedIndex) {
      c.completedTurns = []
      c.currentTurn = null
      c.lastProcessedIndex = 0
      c.lastTurnIndex = 0
    }

    // 仅处理新消息
    for (let i = c.lastProcessedIndex; i < messages.length; i++) {
      const message = messages[i]
      if (!message || message.type !== 'user') continue

      // 检查这是否是用户提示（而不是工具结果）
      const isToolResult =
        message.toolUseResult ||
        (Array.isArray(message.message!.content) &&
          message.message!.content[0]?.type === 'tool_result')

      if (!isToolResult && !message.isMeta) {
        // 在用户提示时开始一个新轮次
        if (c.currentTurn && c.currentTurn.files.size > 0) {
          computeTurnStats(c.currentTurn)
          c.completedTurns.push(c.currentTurn)
        }

        c.lastTurnIndex++
        c.currentTurn = {
          turnIndex: c.lastTurnIndex,
          userPromptPreview: getUserPromptPreview(message),
          timestamp: message.timestamp as string,
          files: new Map(),
          stats: { filesChanged: 0, linesAdded: 0, linesRemoved: 0 },
        }
      } else if (c.currentTurn && message.toolUseResult) {
        // 从工具结果收集文件编辑
        const result = message.toolUseResult
        if (isFileEditResult(result)) {
          const { filePath, structuredPatch } = result
          const isNewFile = 'type' in result && result.type === 'create'

          // 获取或创建文件条目
          let fileEntry = c.currentTurn.files.get(filePath)
          if (!fileEntry) {
            fileEntry = {
              filePath,
              hunks: [],
              isNewFile,
              linesAdded: 0,
              linesRemoved: 0,
            }
            c.currentTurn.files.set(filePath, fileEntry)
          }

          // 对于新文件，从内容生成合成 hunk
          if (
            isNewFile &&
            structuredPatch.length === 0 &&
            isFileWriteOutput(result)
          ) {
            const content = result.content
            const lines = content.split('\n')
            const syntheticHunk: StructuredPatchHunk = {
              oldStart: 0,
              oldLines: 0,
              newStart: 1,
              newLines: lines.length,
              lines: lines.map(l => '+' + l),
            }
            fileEntry.hunks.push(syntheticHunk)
            fileEntry.linesAdded += lines.length
          } else {
            // 追加 hunks（同一文件可能在一个轮次中被多次编辑）
            fileEntry.hunks.push(...structuredPatch)

            // 更新行计数
            const { added, removed } = countHunkLines(structuredPatch)
            fileEntry.linesAdded += added
            fileEntry.linesRemoved += removed
          }

          // 如果文件先创建后编辑，它仍然是新文件
          if (isNewFile) {
            fileEntry.isNewFile = true
          }
        }
      }
    }

    c.lastProcessedIndex = messages.length

    // 构建结果：已完成的轮次 + 当前轮次（如果有文件）
    const result = [...c.completedTurns]
    if (c.currentTurn && c.currentTurn.files.size > 0) {
      // 在包含之前为当前轮次计算统计
      computeTurnStats(c.currentTurn)
      result.push(c.currentTurn)
    }

    // 以倒序返回（最近的最先）
    return result.reverse()
  }, [messages])
}
