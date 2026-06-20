import { randomUUID, type UUID } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { logEvent } from '../../services/analytics/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type {
  ContentReplacementEntry,
  Entry,
  LogOption,
  SerializedMessage,
  TranscriptMessage,
} from '../../types/logs.js'
import { parseJSONL } from '../../utils/json.js'
import {
  getProjectDir,
  getTranscriptPath,
  getTranscriptPathForSession,
  isTranscriptMessage,
  saveCustomTitle,
  searchSessionsByCustomTitle,
} from '../../utils/sessionStorage.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { escapeRegExp } from '../../utils/stringUtils.js'

type TranscriptEntry = TranscriptMessage & {
  forkedFrom?: {
    sessionId: string
    messageUuid: UUID
  }
}

/**
 * 从第一条用户消息中派生单行标题。
 * 折叠空白字符——多行的首条消息（粘贴堆栈、代码）
 * 否则会流入保存的标题中并破坏 resume 提示。
 */
export function deriveFirstPrompt(
  firstUserMessage: Extract<SerializedMessage, { type: 'user' }> | undefined,
): string {
  const content = (firstUserMessage as any)?.message?.content
  if (!content) return 'Branched conversation'
  const raw =
    typeof content === 'string'
      ? content
      : content.find(
          (block: {
            type: string
            text?: string
          }): block is { type: 'text'; text: string } => block.type === 'text',
        )?.text
  if (!raw) return 'Branched conversation'
  return (
    raw.replace(/\s+/g, ' ').trim().slice(0, 100) || 'Branched conversation'
  )
}

/**
 * 通过从 transcript 文件复制来创建当前会话的分支。
 * 保留所有原始元数据（时间戳、gitBranch 等），同时更新
 * sessionId 并添加 forkedFrom 可追溯性。
 */
async function createFork(customTitle?: string): Promise<{
  sessionId: UUID
  title: string | undefined
  forkPath: string
  serializedMessages: SerializedMessage[]
  contentReplacementRecords: ContentReplacementEntry['replacements']
}> {
  const forkSessionId = randomUUID() as UUID
  const originalSessionId = getSessionId()
  const projectDir = getProjectDir(getOriginalCwd())
  const forkSessionPath = getTranscriptPathForSession(forkSessionId)
  const currentTranscriptPath = getTranscriptPath()

  // 确保项目目录存在
  await mkdir(projectDir, { recursive: true, mode: 0o700 })

  // 读取当前 transcript 文件
  let transcriptContent: Buffer
  try {
    transcriptContent = await readFile(currentTranscriptPath)
  } catch {
    throw new Error('No conversation to branch')
  }

  if (transcriptContent.length === 0) {
    throw new Error('No conversation to branch')
  }

  // 解析所有 transcript 条目（消息 + content-replacement 等元数据条目）
  const entries = parseJSONL<Entry>(transcriptContent)

  // 仅过滤出主会话消息（排除 sidechain 和非消息条目）
  const mainConversationEntries = entries.filter(
    (entry): entry is TranscriptMessage =>
      isTranscriptMessage(entry) && !entry.isSidechain,
  )

  // 原会话的 Content-replacement 条目。这些条目记录了哪些
  // tool_result 块被每条消息的预算替换为预览。
  // 如果 fork JSONL 中缺少这些条目，`claude -r {forkId}` 在重建状态时
  // 会使用空的 replacements Map → 之前被替换的结果会被归类为
  // FROZEN，并以完整内容发送（prompt cache miss + 永久超额）。
  // sessionId 必须重写，因为 loadTranscriptFile 通过会话消息的 sessionId 作为 key 进行查找。
  const contentReplacementRecords = entries
    .filter(
      (entry): entry is ContentReplacementEntry =>
        entry.type === 'content-replacement' &&
        entry.sessionId === originalSessionId,
    )
    .flatMap(entry => entry.replacements)

  if (mainConversationEntries.length === 0) {
    throw new Error('No messages to branch')
  }

  // 构建带有新 sessionId 且保留元数据的 forked 条目
  let parentUuid: UUID | null = null
  const lines: string[] = []
  const serializedMessages: SerializedMessage[] = []

  for (const entry of mainConversationEntries) {
    // 创建保留所有原始元数据的 forked transcript 条目
    const forkedEntry: TranscriptEntry = {
      ...entry,
      sessionId: forkSessionId,
      parentUuid,
      isSidechain: false,
      forkedFrom: {
        sessionId: originalSessionId,
        messageUuid: entry.uuid,
      },
    }

    // 为 LogOption 构建序列化消息
    const serialized: SerializedMessage = {
      ...entry,
      sessionId: forkSessionId,
    }

    serializedMessages.push(serialized)
    lines.push(jsonStringify(forkedEntry))
    if (entry.type !== 'progress') {
      parentUuid = entry.uuid
    }
  }

  // 追加带有 fork sessionId 的 content-replacement 条目（如果有）。
  // 以单个条目形式写入（与 insertContentReplacement 形状相同），以便
  // loadTranscriptFile 的 content-replacement 分支能够拾取。
  if (contentReplacementRecords.length > 0) {
    const forkedReplacementEntry: ContentReplacementEntry = {
      type: 'content-replacement',
      sessionId: forkSessionId,
      replacements: contentReplacementRecords,
    }
    lines.push(jsonStringify(forkedReplacementEntry))
  }

  // 写入 fork 会话文件
  await writeFile(forkSessionPath, lines.join('\n') + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  })

  return {
    sessionId: forkSessionId,
    title: customTitle,
    forkPath: forkSessionPath,
    serializedMessages,
    contentReplacementRecords,
  }
}

/**
 * 通过检查与现有会话名称的冲突来生成唯一的 fork 名称。
 * 如果 "baseName (Branch)" 已存在，则尝试 "baseName (Branch 2)"、"baseName (Branch 3)" 等。
 */
async function getUniqueForkName(baseName: string): Promise<string> {
  const candidateName = `${baseName} (Branch)`

  // 检查该精确名称是否已存在
  const existingWithExactName = await searchSessionsByCustomTitle(
    candidateName,
    { exact: true },
  )

  if (existingWithExactName.length === 0) {
    return candidateName
  }

  // 名称冲突 - 查找唯一的数字后缀
  // 搜索所有以基础模式开头的会话
  const existingForks = await searchSessionsByCustomTitle(`${baseName} (Branch`)

  // 提取现有 fork 编号以找到下一个可用编号
  const usedNumbers = new Set<number>([1]) // 将 " (Branch)" 视为编号 1
  const forkNumberPattern = new RegExp(
    `^${escapeRegExp(baseName)} \\(Branch(?: (\\d+))?\\)$`,
  )

  for (const session of existingForks) {
    const match = session.customTitle?.match(forkNumberPattern)
    if (match) {
      if (match[1]) {
        usedNumbers.add(parseInt(match[1], 10))
      } else {
        usedNumbers.add(1) // 没有编号的 " (Branch)" 被视为 1
      }
    }
  }

  // 查找下一个可用编号
  let nextNumber = 2
  while (usedNumbers.has(nextNumber)) {
    nextNumber++
  }

  return `${baseName} (Branch ${nextNumber})`
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const customTitle = args?.trim() || undefined

  const originalSessionId = getSessionId()

  try {
    const {
      sessionId,
      title,
      forkPath,
      serializedMessages,
      contentReplacementRecords,
    } = await createFork(customTitle)

    // 为 resume 构建 LogOption
    const now = new Date()
    const firstPrompt = deriveFirstPrompt(
      serializedMessages.find(m => m.type === 'user') as
        | Extract<SerializedMessage, { type: 'user' }>
        | undefined,
    )

    // 保存自定义标题 - 使用提供的标题或以 firstPrompt 作为默认值
    // 确保 /status 和 /resume 显示相同的会话名称
    // 始终添加 " (Branch)" 后缀以明确表示这是分支会话
    // 通过添加数字后缀来处理冲突（例如 " (Branch 2)"、" (Branch 3)"）
    const baseName = title ?? firstPrompt
    const effectiveTitle = await getUniqueForkName(baseName)
    await saveCustomTitle(sessionId, effectiveTitle, forkPath)

    logEvent('tengu_conversation_forked', {
      message_count: serializedMessages.length,
      has_custom_title: !!title,
    })

    const forkLog: LogOption = {
      date: now.toISOString().split('T')[0]!,
      messages: serializedMessages,
      fullPath: forkPath,
      value: now.getTime(),
      created: now,
      modified: now,
      firstPrompt,
      messageCount: serializedMessages.length,
      isSidechain: false,
      sessionId,
      customTitle: effectiveTitle,
      contentReplacements: contentReplacementRecords,
    }

    // 进入 fork
    const titleInfo = title ? ` "${title}"` : ''
    const resumeHint = `\nTo resume the original: claude -r ${originalSessionId}`
    const successMessage = `Branched conversation${titleInfo}. You are now in the branch.${resumeHint}`

    if (context.resume) {
      await context.resume(sessionId, forkLog, 'fork')
      onDone(successMessage, { display: 'system' })
    } else {
      // 当 resume 不可用时的回退方案
      onDone(
        `Branched conversation${titleInfo}. Resume with: /resume ${sessionId}`,
      )
    }

    return null
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error occurred'
    onDone(`Failed to branch conversation: ${message}`)
    return null
  }
}
