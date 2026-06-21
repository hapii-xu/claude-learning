import { feature } from 'bun:bundle'
import { stat } from 'fs/promises'
import { getClientType } from '../bootstrap/state.js'
import {
  getRemoteSessionUrl,
  isRemoteSessionLocal,
  PRODUCT_URL,
} from '../constants/product.js'
import { TERMINAL_OUTPUT_TAGS } from '../constants/xml.js'
import type { AppState } from '../state/AppState.js'
import { FILE_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GrepTool/prompt.js'
import type { Entry } from '../types/logs.js'
import {
  type AttributionData,
  calculateCommitAttribution,
  isInternalModelRepo,
} from './commitAttribution.js'
import { logForDebugging } from './debug.js'
import { parseJSONL } from './json.js'
import { logError } from './log.js'
import { getAttributionEmail } from './attributionEmail.js'
import { getRealModelName } from './attributionModel.js'
import { isMemoryFileAccess } from './sessionFileAccessHooks.js'
import { getTranscriptPath } from './sessionStorage.js'
import { readTranscriptForLoad } from './sessionStoragePortable.js'
import { getInitialSettings } from './settings/settings.js'
import { isUndercover } from './undercover.js'

export type AttributionTexts = {
  commit: string
  pr: string
}

/**
 * 根据用户设置返回提交和 PR 的归属文本。
 * 处理：
 * - 通过 getRealModelName() 动态获取模型名
 * - 通过 getAttributionEmail() 自动映射邮箱
 * - 自定义归属设置（settings.attribution.commit/pr）
 * - 与已弃用的 includeCoAuthoredBy 设置的向后兼容
 * - 远程模式：返回会话 URL 作为归属
 */
export function getAttributionTexts(): AttributionTexts {
  if (process.env.USER_TYPE === 'ant' && isUndercover()) {
    return { commit: '', pr: '' }
  }

  if (getClientType() === 'remote') {
    const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
    if (remoteSessionId) {
      const ingressUrl = process.env.SESSION_INGRESS_URL
      // 本地开发跳过 —— URL 不会持久化
      if (!isRemoteSessionLocal(remoteSessionId, ingressUrl)) {
        const sessionUrl = getRemoteSessionUrl(remoteSessionId, ingressUrl)
        return { commit: sessionUrl, pr: sessionUrl }
      }
    }
    return { commit: '', pr: '' }
  }

  const modelName = getRealModelName()
  const email = getAttributionEmail(modelName)
  const defaultAttribution = `🤖 Generated with [Claude Code Best](${PRODUCT_URL})`
  const defaultCommit = `Co-Authored-By: ${modelName} <${email}>`

  const settings = getInitialSettings()

  // 新归属设置优先于已弃用的 includeCoAuthoredBy
  if (settings.attribution) {
    return {
      commit: settings.attribution.commit ?? defaultCommit,
      pr: settings.attribution.pr ?? defaultAttribution,
    }
  }

  // 向后兼容：已弃用的 includeCoAuthoredBy 设置
  if (settings.includeCoAuthoredBy === false) {
    return { commit: '', pr: '' }
  }

  return { commit: defaultCommit, pr: defaultAttribution }
}

/**
 * 检查消息内容字符串是否为终端输出而非用户提示。
 * 终端输出包括 bash 输入/输出标签和关于本地命令的警告消息。
 */
function isTerminalOutput(content: string): boolean {
  for (const tag of TERMINAL_OUTPUT_TAGS) {
    if (content.includes(`<${tag}>`)) {
      return true
    }
  }
  return false
}

/**
 * 统计非侧链消息列表中有可见文本内容的用户消息数。
 * 排除 tool_result 块、终端输出和空消息。
 *
 * 调用者应传入已过滤排除侧链消息的消息。
 */
export function countUserPromptsInMessages(
  messages: ReadonlyArray<{ type: string; message?: { content?: unknown } }>,
): number {
  let count = 0

  for (const message of messages) {
    if (message.type !== 'user') {
      continue
    }

    const content = message.message?.content
    if (!content) {
      continue
    }

    let hasUserText = false

    if (typeof content === 'string') {
      if (isTerminalOutput(content)) {
        continue
      }
      hasUserText = content.trim().length > 0
    } else if (Array.isArray(content)) {
      hasUserText = content.some(block => {
        if (!block || typeof block !== 'object' || !('type' in block)) {
          return false
        }
        return (
          (block.type === 'text' &&
            typeof block.text === 'string' &&
            !isTerminalOutput(block.text)) ||
          block.type === 'image' ||
          block.type === 'document'
        )
      })
    }

    if (hasUserText) {
      count++
    }
  }

  return count
}

/**
 * 统计转录条目中非侧链的用户消息数。
 * 用于计算"引导"次数（用户提示数 - 1）。
 *
 * 统计包含实际用户输入文本的用户消息，
 * 排除 tool_result 块、侧链消息和终端输出。
 */
function countUserPromptsFromEntries(entries: ReadonlyArray<Entry>): number {
  const nonSidechain = entries.filter(
    entry =>
      entry.type === 'user' && !('isSidechain' in entry && entry.isSidechain),
  )
  return countUserPromptsInMessages(nonSidechain)
}

/**
 * 从提供的 AppState 的归属状态获取完整的归属数据。
 * 使用归属状态中的所有跟踪文件（而不仅仅是暂存文件），
 * 因为对于 PR 归属，文件可能尚未暂存。
 * 如果没有可用的归属数据则返回 null。
 */
async function getPRAttributionData(
  appState: AppState,
): Promise<AttributionData | null> {
  const attribution = appState.attribution

  if (!attribution) {
    return null
  }

  // 同时处理 Map 和普通对象（以防序列化）
  const fileStates = attribution.fileStates
  const isMap = fileStates instanceof Map
  const trackedFiles = isMap
    ? Array.from(fileStates.keys())
    : Object.keys(fileStates)

  if (trackedFiles.length === 0) {
    return null
  }

  try {
    return await calculateCommitAttribution([attribution], trackedFiles)
  } catch (error) {
    logError(error as Error)
    return null
  }
}

const MEMORY_ACCESS_TOOL_NAMES = new Set([
  FILE_READ_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])

/**
 * 统计转录条目中的内存文件访问次数。
 * 使用与 PostToolUse 会话文件访问钩子相同的检测条件。
 */
function countMemoryFileAccessFromEntries(
  entries: ReadonlyArray<Entry>,
): number {
  let count = 0
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        block.type !== 'tool_use' ||
        !MEMORY_ACCESS_TOOL_NAMES.has(block.name)
      )
        continue
      if (isMemoryFileAccess(block.name, block.input)) count++
    }
  }
  return count
}

/**
 * 读取会话转录条目并计算提示计数和内存访问计数。
 * 跳过压缩前条目 —— N-shot 计数和内存访问计数
 * 应仅反映当前对话弧，而非压缩边界之前累积的提示。
 */
async function getTranscriptStats(): Promise<{
  promptCount: number
  memoryAccessCount: number
}> {
  try {
    const filePath = getTranscriptPath()
    const fileSize = (await stat(filePath)).size
    // 融合读取器：attr-snap 行（长会话中按字节占 84%）
    // 在 fd 层被跳过，因此峰值随输出而非文件大小缩放。
    // 文件末尾唯一保留的 attr-snap 对计数函数是空操作
    //（都不检查 type === 'attribution-snapshot'）。当最后一个
    // 边界有 preservedSegment 时，读取器返回完整数据（不截断）；
    // 下方的 findLastIndex 仍会切片到边界之后。
    const scan = await readTranscriptForLoad(filePath, fileSize)
    const buf = scan.postBoundaryBuf
    const entries = parseJSONL<Entry>(buf)
    const lastBoundaryIdx = entries.findLastIndex(
      e =>
        e.type === 'system' &&
        'subtype' in e &&
        e.subtype === 'compact_boundary',
    )
    const postBoundary =
      lastBoundaryIdx >= 0 ? entries.slice(lastBoundaryIdx + 1) : entries
    return {
      promptCount: countUserPromptsFromEntries(postBoundary),
      memoryAccessCount: countMemoryFileAccessFromEntries(postBoundary),
    }
  } catch {
    return { promptCount: 0, memoryAccessCount: 0 }
  }
}

/**
 * 获取带 Claude 贡献统计的增强 PR 归属文本。
 *
 * 格式："🤖 Generated with Claude Code (93% 3-shotted by claude-opus-4-5)"
 *
 * 规则：
 * - 显示提交归属中的 Claude 贡献百分比
 * - 显示 N-shotted，其中 N 为提示数（1-shotted、2-shotted 等）
 * - 显示简短模型名（例如 claude-opus-4-5）
 * - 如果无法计算统计则返回默认归属
 *
 * @param getAppState 获取当前 AppState 的函数（来自命令上下文）
 */
export async function getEnhancedPRAttribution(
  getAppState: () => AppState,
): Promise<string> {
  if (process.env.USER_TYPE === 'ant' && isUndercover()) {
    return ''
  }

  if (getClientType() === 'remote') {
    const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
    if (remoteSessionId) {
      const ingressUrl = process.env.SESSION_INGRESS_URL
      // 本地开发跳过 —— URL 不会持久化
      if (!isRemoteSessionLocal(remoteSessionId, ingressUrl)) {
        return getRemoteSessionUrl(remoteSessionId, ingressUrl)
      }
    }
    return ''
  }

  const settings = getInitialSettings()

  // 如果用户有自定义 PR 归属，使用该值
  if (settings.attribution?.pr) {
    return settings.attribution.pr
  }

  // 向后兼容：已弃用的 includeCoAuthoredBy 设置
  if (settings.includeCoAuthoredBy === false) {
    return ''
  }

  const defaultAttribution = `🤖 Generated with [Claude Code](${PRODUCT_URL})`

  // 首先获取 AppState
  const appState = getAppState()

  logForDebugging(
    `PR Attribution: appState.attribution exists: ${!!appState.attribution}`,
  )
  if (appState.attribution) {
    const fileStates = appState.attribution.fileStates
    const isMap = fileStates instanceof Map
    const fileCount = isMap ? fileStates.size : Object.keys(fileStates).length
    logForDebugging(`PR Attribution: fileStates count: ${fileCount}`)
  }

  // 获取归属统计（转录只读取一次，同时用于提示计数和内存访问）
  const [attributionData, { promptCount, memoryAccessCount }, isInternal] =
    await Promise.all([
      getPRAttributionData(appState),
      getTranscriptStats(),
      isInternalModelRepo(),
    ])

  const claudePercent = attributionData?.summary.claudePercent ?? 0

  logForDebugging(
    `PR Attribution: claudePercent: ${claudePercent}, promptCount: ${promptCount}, memoryAccessCount: ${memoryAccessCount}`,
  )

  // 获取用于归属的真实模型名
  const realModelName = getRealModelName()

  // 如果没有归属数据，返回默认值
  if (claudePercent === 0 && promptCount === 0 && memoryAccessCount === 0) {
    logForDebugging('PR Attribution: returning default (no data)')
    return defaultAttribution
  }

  // 构建增强归属："🤖 Generated with Claude Code (93% 3-shotted by claude-opus-4-5, 2 memories recalled)"
  const memSuffix =
    memoryAccessCount > 0
      ? `, ${memoryAccessCount} ${memoryAccessCount === 1 ? 'memory' : 'memories'} recalled`
      : ''
  const summary = `🤖 Generated with [Claude Code Best](${PRODUCT_URL}) (${claudePercent}% ${promptCount}-shotted by ${realModelName}${memSuffix})`

  // 为 squash-merge 存活追加 trailer 行。仅用于白名单仓库
  //（INTERNAL_MODEL_REPOS），且仅在启用 COMMIT_ATTRIBUTION 的构建中 ——
  // attributionTrailer.ts 包含排除的字符串，因此通过 feature() 后面的
  // 动态 import 访问。当仓库配置了
  // squash_merge_commit_message=PR_BODY（cli、apps）时，PR body 会原样
  // 成为 squash 提交 body —— 末尾的 trailer 行会成为 squash 提交上的
  // 正式 git trailer。
  if (feature('COMMIT_ATTRIBUTION') && isInternal && attributionData) {
    const { buildPRTrailers } = await import('./attributionTrailer.js')
    const trailers = buildPRTrailers(attributionData, appState.attribution)
    const result = `${summary}\n\n${trailers.join('\n')}`
    logForDebugging(`PR Attribution: returning with trailers: ${result}`)
    return result
  }

  logForDebugging(`PR Attribution: returning summary: ${summary}`)
  return summary
}
