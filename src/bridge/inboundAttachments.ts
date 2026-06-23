/**
 * 处理 inbound bridge user message 中的 file_uuid 附件。
 *
 * Web composer 用 cookie 鉴权的 /api/{org}/upload 上传，随消息一起发
 * file_uuid。这里通过 GET /api/oauth/files/{uuid}/content（oauth 鉴权、
 * 同一个存储）把每个附件拉下来，写到 ~/.hclaude/uploads/{sessionId}/，
 * 返回要 prepend 到消息前面的 @path 引用。剩下的交给 Claude 的 Read
 * 工具。
 *
 * best-effort：任何失败（无 token、网络、非 2xx、磁盘）都记 debug 日志
 * 并跳过该附件。消息本身仍会送达 Claude，只是少一个 @path。
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import axios from 'axios'
import { randomUUID } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { z } from 'zod/v4'
import { getSessionId } from '../bootstrap/state.js'
import { logForDebugging } from '../utils/debug.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { lazySchema } from '../utils/lazySchema.js'
import { getBridgeAccessToken, getBridgeBaseUrl } from './bridgeConfig.js'

const DOWNLOAD_TIMEOUT_MS = 30_000

function debug(msg: string): void {
  logForDebugging(`[bridge:inbound-attach] ${msg}`)
}

const attachmentSchema = lazySchema(() =>
  z.object({
    file_uuid: z.string(),
    file_name: z.string(),
  }),
)
const attachmentsArraySchema = lazySchema(() => z.array(attachmentSchema()))

export type InboundAttachment = z.infer<ReturnType<typeof attachmentSchema>>

/** 从弱类型的 inbound message 上摘下 file_attachments。 */
export function extractInboundAttachments(msg: unknown): InboundAttachment[] {
  if (typeof msg !== 'object' || msg === null || !('file_attachments' in msg)) {
    return []
  }
  const parsed = attachmentsArraySchema().safeParse(msg.file_attachments)
  return parsed.success ? parsed.data : []
}

/**
 * 剥掉路径部分，只保留文件名安全字符。file_name 来自网络（web composer），
 * 即便由 composer 控制，也按不可信处理。
 */
function sanitizeFileName(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_')
  return base || 'attachment'
}

function uploadsDir(): string {
  return join(getClaudeConfigHomeDir(), 'uploads', getSessionId())
}

/**
 * 抓取 + 写入单个附件。成功返回绝对路径，任何失败返回 undefined。
 */
async function resolveOne(att: InboundAttachment): Promise<string | undefined> {
  const token = getBridgeAccessToken()
  if (!token) {
    debug('skip: no oauth token')
    return undefined
  }

  let data: Buffer
  try {
    // getOauthConfig()（经由 getBridgeBaseUrl）在遇到未加白的
    // CLAUDE_CODE_CUSTOM_OAUTH_URL 时会抛错 —— 放在 try 里，让坏的
    // FedStart URL 平滑退化为"无 @path"，而不是让 print.ts 的 reader
    // 循环崩掉（那里的 await 周围没有 catch）。
    const url = `${getBridgeBaseUrl()}/api/oauth/files/${encodeURIComponent(att.file_uuid)}/content`
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
      timeout: DOWNLOAD_TIMEOUT_MS,
      validateStatus: () => true,
    })
    if (response.status !== 200) {
      debug(`fetch ${att.file_uuid} failed: status=${response.status}`)
      return undefined
    }
    data = Buffer.from(response.data)
  } catch (e) {
    debug(`fetch ${att.file_uuid} threw: ${e}`)
    return undefined
  }

  // 用 uuid 前缀让跨消息和同消息内（同名不同文件）都不可能撞。8 字符
  // 足够了 —— 这里不是为了安全。
  const safeName = sanitizeFileName(att.file_name)
  const prefix = (
    att.file_uuid.slice(0, 8) || randomUUID().slice(0, 8)
  ).replace(/[^a-zA-Z0-9_-]/g, '_')
  const dir = uploadsDir()
  const outPath = join(dir, `${prefix}-${safeName}`)

  try {
    await mkdir(dir, { recursive: true })
    await writeFile(outPath, data)
  } catch (e) {
    debug(`write ${outPath} failed: ${e}`)
    return undefined
  }

  debug(`resolved ${att.file_uuid} → ${outPath} (${data.length} bytes)`)
  return outPath
}

/**
 * 把 inbound message 上所有附件解析成 @path 引用拼成的前缀字符串。
 * 一个都没解析出来则返回空串。
 */
export async function resolveInboundAttachments(
  attachments: InboundAttachment[],
): Promise<string> {
  if (attachments.length === 0) return ''
  debug(`resolving ${attachments.length} attachment(s)`)
  const paths = await Promise.all(attachments.map(resolveOne))
  const ok = paths.filter((p): p is string => p !== undefined)
  if (ok.length === 0) return ''
  // 用引号包裹 —— extractAtMentionedFiles 会在未加引号的 @ref 第一个
  // 空格处截断，会让家目录带空格的路径（/Users/John Smith/）挂掉。
  return ok.map(p => `@"${p}"`).join(' ') + ' '
}

/**
 * 把 @path 引用前缀加到 content 上（无论 content 是什么形式）。目标是
 * 最后一个 text block —— processUserInputBase 从
 * processedBlocks[processedBlocks.length - 1] 读 inputString，把引用放到
 * block[0] 的话，[text, image] 内容里会被悄悄忽略。
 */
export function prependPathRefs(
  content: string | Array<ContentBlockParam>,
  prefix: string,
): string | Array<ContentBlockParam> {
  if (!prefix) return content
  if (typeof content === 'string') return prefix + content
  const i = content.findLastIndex(b => b.type === 'text')
  if (i !== -1) {
    const b = content[i]!
    if (b.type === 'text') {
      return [
        ...content.slice(0, i),
        { ...b, text: prefix + b.text },
        ...content.slice(i + 1),
      ]
    }
  }
  // 没有 text block —— 在末尾追加一个，让它成为最后一个。
  return [...content, { type: 'text', text: prefix.trimEnd() }]
}

/**
 * 便捷封装：提取 + 解析 + 前置。消息没有 file_attachments 字段时为
 * no-op（快速路径，不走网络，原引用直接返回）。
 */
export async function resolveAndPrepend(
  msg: unknown,
  content: string | Array<ContentBlockParam>,
): Promise<string | Array<ContentBlockParam>> {
  const attachments = extractInboundAttachments(msg)
  if (attachments.length === 0) return content
  const prefix = await resolveInboundAttachments(attachments)
  return prependPathRefs(content, prefix)
}
