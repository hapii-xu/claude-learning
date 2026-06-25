import axios from 'axios'
import { readFile, stat } from 'fs/promises'
import type { Message } from '../../types/message.js'
import { checkAndRefreshOAuthTokenIfNeeded } from '../../utils/auth.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { getAuthHeaders, getUserAgent } from '../../utils/http.js'
import { normalizeMessagesForAPI } from '../../utils/messages.js'
import {
  extractAgentIdsFromMessages,
  getTranscriptPath,
  loadSubagentTranscripts,
  MAX_TRANSCRIPT_READ_BYTES,
} from '../../utils/sessionStorage.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { redactSensitiveInfo } from '../Feedback.js'

type TranscriptShareResult = {
  success: boolean
  transcriptId?: string
}

export type TranscriptShareTrigger =
  | 'bad_feedback_survey'
  | 'good_feedback_survey'
  | 'frustration'
  | 'memory_survey'

export async function submitTranscriptShare(
  messages: Message[],
  trigger: TranscriptShareTrigger,
  appearanceId: string,
): Promise<TranscriptShareResult> {
  try {
    logForDebugging('正在收集 transcript 用于分享', { level: 'info' })

    const transcript = normalizeMessagesForAPI(messages)

    // 收集子 agent 的 transcript
    const agentIds = extractAgentIdsFromMessages(messages)
    const subagentTranscripts = await loadSubagentTranscripts(agentIds)

    // 读取原始 JSONL transcript（带大小限制以防 OOM）
    let rawTranscriptJsonl: string | undefined
    try {
      const transcriptPath = getTranscriptPath()
      const { size } = await stat(transcriptPath)
      if (size <= MAX_TRANSCRIPT_READ_BYTES) {
        rawTranscriptJsonl = await readFile(transcriptPath, 'utf-8')
      } else {
        logForDebugging(`跳过原始 transcript 读取：文件过大（${size} 字节）`, {
          level: 'warn',
        })
      }
    } catch {
      // 文件可能不存在
    }

    const data = {
      trigger,
      version: MACRO.VERSION,
      platform: process.platform,
      transcript,
      subagentTranscripts:
        Object.keys(subagentTranscripts).length > 0
          ? subagentTranscripts
          : undefined,
      rawTranscriptJsonl,
    }

    const content = redactSensitiveInfo(jsonStringify(data))

    await checkAndRefreshOAuthTokenIfNeeded()

    const authResult = getAuthHeaders()
    if (authResult.error) {
      return { success: false }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': getUserAgent(),
      ...authResult.headers,
    }

    const response = await axios.post(
      'https://api.anthropic.com/api/claude_code_shared_session_transcripts',
      { content, appearance_id: appearanceId },
      {
        headers,
        timeout: 30000,
      },
    )

    if (response.status === 200 || response.status === 201) {
      const result = response.data
      logForDebugging('Transcript 分享成功', { level: 'info' })
      return {
        success: true,
        transcriptId: result?.transcript_id,
      }
    }

    return { success: false }
  } catch (err) {
    logForDebugging(errorMessage(err), {
      level: 'error',
    })
    return { success: false }
  }
}
