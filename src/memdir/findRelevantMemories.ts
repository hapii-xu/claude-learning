import { feature } from 'bun:bundle'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { getDefaultSonnetModel } from '../utils/model/model.js'
import { sideQuery } from '../utils/sideQuery.js'
import type { LangfuseSpan } from '../services/langfuse/index.js'
import { jsonParse } from '../utils/slowOperations.js'
import {
  formatMemoryManifest,
  type MemoryHeader,
  scanMemoryFiles,
} from './memoryScan.js'

export type RelevantMemory = {
  path: string
  mtimeMs: number
}

const SELECT_MEMORIES_SYSTEM_PROMPT = `你正在筛选对 Claude Code 处理用户查询有用的记忆。你将获得用户的查询内容以及可用记忆文件的列表（包含文件名和描述）。

请返回一个文件名列表，列出那些在处理用户查询时明显有用的记忆（最多 5 个）。仅包含你根据名称和描述确定会有帮助的记忆。
- 如果你不确定某条记忆是否对处理用户查询有用，则不要将其包含在列表中。请有选择性和判断力。
- 如果列表中没有明显有用的记忆，可以返回空列表。
- 如果提供了最近使用工具的列表，不要选择这些工具的使用参考或 API 文档类记忆（Claude Code 已在使用它们）。但仍应选择包含这些工具的警告、注意事项或已知问题的记忆——正在使用时恰恰是这些内容最重要的时候。
`

/**
 * 通过扫描记忆文件头部并让 Sonnet 选择最相关的记忆，
 * 找到与查询相关的记忆文件。
 *
 * 返回最相关记忆的绝对文件路径 + mtime（最多 5 个）。
 * 排除 MEMORY.md（已加载到系统提示中）。
 * mtime 被传递以便调用方可以向主模型展示新鲜度信息，
 * 而无需再次 stat。
 *
 * `alreadySurfaced` 在 Sonnet 调用之前过滤先前回合中
 * 已展示过的路径，这样选择器就可以将 5 个名额的预算
 * 用于新的候选项，而不是重新选择调用方会丢弃的文件。
 */
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  signal: AbortSignal,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
  parentSpan?: LangfuseSpan | null,
): Promise<RelevantMemory[]> {
  logForDebugging(
    `[Hapii] Memdir.findRelevantMemories 开始 queryLen=${query.length} dir=${memoryDir} alreadySurfaced=${alreadySurfaced.size}`,
    { level: 'info' },
  )
  const memories = (await scanMemoryFiles(memoryDir, signal)).filter(
    m => !alreadySurfaced.has(m.filePath),
  )
  logForDebugging(
    `[Hapii] Memdir.findRelevantMemories 扫描完成 candidateCount=${memories.length}`,
    { level: 'info' },
  )
  if (memories.length === 0) {
    return []
  }

  const selectedFilenames = await selectRelevantMemories(
    query,
    memories,
    signal,
    recentTools,
    parentSpan,
  )
  const byFilename = new Map(memories.map(m => [m.filename, m]))
  const selected = selectedFilenames
    .map(filename => byFilename.get(filename))
    .filter((m): m is MemoryHeader => m !== undefined)

  // 即使在选择为空时也触发：选择率需要分母，且 -1 ages 区分
  // "运行了，没选择任何内容"和"从未运行"。
  if (feature('MEMORY_SHAPE_TELEMETRY')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { logMemoryRecallShape } =
      require('./memoryShapeTelemetry.js') as typeof import('./memoryShapeTelemetry.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    logMemoryRecallShape(memories, selected)
  }

  const result = selected.map(m => ({ path: m.filePath, mtimeMs: m.mtimeMs }))
  logForDebugging(
    `[Hapii] Memdir.findRelevantMemories 完成 selectedCount=${result.length} paths=[${result.map(r => r.path).join(', ')}]`,
    { level: 'info' },
  )
  return result
}

async function selectRelevantMemories(
  query: string,
  memories: MemoryHeader[],
  signal: AbortSignal,
  recentTools: readonly string[],
  parentSpan?: LangfuseSpan | null,
): Promise<string[]> {
  const validFilenames = new Set(memories.map(m => m.filename))

  const manifest = formatMemoryManifest(memories)

  // 当 Claude Code 正在积极使用工具时（例如 mcp__X__spawn），
  // 显示该工具的参考文档是噪音 —— 对话已经包含可用的用法。
  // 否则选择器会在关键字重叠时匹配（query 中的 "spawn" + 记忆
  // 描述中的 "spawn" → 误报）。
  const toolsSection =
    recentTools.length > 0
      ? `\n\n最近使用的工具：${recentTools.join(', ')}`
      : ''

  try {
    const result = await sideQuery({
      model: getDefaultSonnetModel(),
      system: SELECT_MEMORIES_SYSTEM_PROMPT,
      skipSystemPromptPrefix: true,
      messages: [
        {
          role: 'user',
          content: `查询：${query}\n\n可用记忆：\n${manifest}${toolsSection}`,
        },
      ],
      max_tokens: 256,
      output_format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            selected_memories: { type: 'array', items: { type: 'string' } },
          },
          required: ['selected_memories'],
          additionalProperties: false,
        },
      },
      signal,
      querySource: 'memdir_relevance',
      optional: true,
      parentSpan,
    })

    const textBlock = result.content.find(block => block.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      return []
    }

    const parsed: { selected_memories: string[] } = jsonParse(textBlock.text)
    return parsed.selected_memories.filter(f => validFilenames.has(f))
  } catch (e) {
    if (signal.aborted) {
      return []
    }
    logForDebugging(
      `[memdir] selectRelevantMemories failed: ${errorMessage(e)}`,
      { level: 'warn' },
    )
    return []
  }
}
