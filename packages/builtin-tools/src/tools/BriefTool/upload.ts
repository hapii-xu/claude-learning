/**
 * 将 BriefTool 附件上传到 private_api，以便 web 查看器可以预览它们。
 *
 * 当 repl bridge 处于激活状态时，附件路径对 web 查看器毫无意义
 * （它们位于 Claude 的机器上）。我们将其上传到 /api/oauth/file_upload——
 * 与 MessageComposer/SpaceMessage 渲染时使用的同一存储——并将返回的
 * file_uuid 与路径一同保存。Web 端通过 file_uuid 解析预览；
 * 桌面端/本地端优先尝试路径。
 *
 * 尽力而为：任何失败（无 token、bridge 关闭、网络错误、4xx）都会记录
 * debug 日志并返回 undefined。附件仍会携带 {path, size, isImage}，
 * 因此本地终端和同机桌面端的渲染不受影响。
 */

import { feature } from 'bun:bundle'
import axios from 'axios'
import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import { basename, extname } from 'path'
import { z } from 'zod/v4'

import {
  getBridgeAccessToken,
  getBridgeBaseUrlOverride,
} from 'src/bridge/bridgeConfig.js'
import { getOauthConfig } from 'src/constants/oauth.js'
import { logForDebugging } from 'src/utils/debug.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { jsonStringify } from 'src/utils/slowOperations.js'

// 与 private_api 后端的限制保持一致
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024

const UPLOAD_TIMEOUT_MS = 30_000

// 后端按 mime 分发：image/* → upload_image_wrapped（写入
// PREVIEW/THUMBNAIL，不写 ORIGINAL），其余 → upload_generic_file
//（仅 ORIGINAL，无预览）。此处仅白名单那些转码器可靠处理的位图格式——
// svg/bmp/ico 可能会收到 400，而 pdf 会路由到 upload_pdf_file_wrapped，
// 该路径同样跳过 ORIGINAL。Dispatch 查看器对图片使用 /preview，
// 对其余文件使用 /contents，因此图片归入 image/*，其余归入 octet-stream。
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

function guessMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

function debug(msg: string): void {
  logForDebugging(`[brief:upload] ${msg}`)
}

/**
 * 上传所用的 Base URL。必须与 token 有效的主机一致。
 *
 * 子进程宿主（cowork）会随 CLAUDE_CODE_OAUTH_TOKEN 一并传入
 * ANTHROPIC_BASE_URL——优先使用它，因为 getOauthConfig() 仅在
 * 设置了 USE_STAGING_OAUTH 时才返回 staging 环境，而这类宿主并不会设置。
 * 若不这么做，staging token 会命中 api.anthropic.com → 401 → 静默跳过
 * → web 查看器会看到没有 file_uuid 的失效卡片。
 */
function getBridgeBaseUrl(): string {
  return (
    getBridgeBaseUrlOverride() ??
    process.env.ANTHROPIC_BASE_URL ??
    getOauthConfig().BASE_API_URL
  )
}

// /api/oauth/file_upload 返回 ChatMessage{Image,Blob,Document}FileSchema 之一。
// 它们都共享 file_uuid；那是我们唯一需要的字段。
const uploadResponseSchema = lazySchema(() =>
  z.object({ file_uuid: z.string() }),
)

export type BriefUploadContext = {
  replBridgeEnabled: boolean
  signal?: AbortSignal
}

/**
 * 上传单个附件。成功时返回 file_uuid，否则返回 undefined。
 * 每一处提前返回都是有意的优雅降级。
 */
export async function uploadBriefAttachment(
  fullPath: string,
  size: number,
  ctx: BriefUploadContext,
): Promise<string | undefined> {
  // 使用正向写法，以便 bun:bundle 能在非 BRIDGE_MODE 构建中整段消除函数体
  //（反向写法 `if (!feature(...)) return` 无法做到）。
  if (feature('BRIDGE_MODE')) {
    if (!ctx.replBridgeEnabled) return undefined

    if (size > MAX_UPLOAD_BYTES) {
      debug(`skip ${fullPath}: ${size} bytes exceeds ${MAX_UPLOAD_BYTES} limit`)
      return undefined
    }

    const token = getBridgeAccessToken()
    if (!token) {
      debug('skip: no oauth token')
      return undefined
    }

    let content: Buffer
    try {
      content = await readFile(fullPath)
    } catch (e) {
      debug(`read failed for ${fullPath}: ${e}`)
      return undefined
    }

    const baseUrl = getBridgeBaseUrl()
    const url = `${baseUrl}/api/oauth/file_upload`
    const filename = basename(fullPath)
    const mimeType = guessMimeType(filename)
    const boundary = `----FormBoundary${randomUUID()}`

    // 手动构造 multipart——与 filesApi.ts 中的模式相同。oauth 端点只接收
    // 单个 "file" part（不像公开 Files API 那样有 "purpose" 字段）。
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: ${mimeType}\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])

    try {
      const response = await axios.post(url, body, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length.toString(),
        },
        timeout: UPLOAD_TIMEOUT_MS,
        signal: ctx.signal,
        validateStatus: () => true,
      })

      if (response.status !== 201) {
        debug(
          `upload failed for ${fullPath}: status=${response.status} body=${jsonStringify(response.data).slice(0, 200)}`,
        )
        return undefined
      }

      const parsed = uploadResponseSchema().safeParse(response.data)
      if (!parsed.success) {
        debug(
          `unexpected response shape for ${fullPath}: ${parsed.error.message}`,
        )
        return undefined
      }

      debug(`uploaded ${fullPath} → ${parsed.data.file_uuid} (${size} bytes)`)
      return parsed.data.file_uuid
    } catch (e) {
      debug(`upload threw for ${fullPath}: ${e}`)
      return undefined
    }
  }
  return undefined
}
