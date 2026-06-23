/**
 * SendUserMessage 与 SendUserFile 共享的附件校验与解析逻辑。
 * 放在 BriefTool/ 目录下，是为了让 feature('BRIDGE_MODE') 守卫内部的
 * 动态 `./upload.js` 导入保持相对路径，同时确保 upload.ts
 * （axios、crypto、auth 工具）在非 bridge 构建中可被 tree-shaking 移除。
 */

import { feature } from 'bun:bundle'
import { stat } from 'fs/promises'

import type { ValidationResult } from 'src/Tool.js'

import { getCwd } from 'src/utils/cwd.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'
import { getErrnoCode } from 'src/utils/errors.js'
import { IMAGE_EXTENSION_REGEX } from 'src/utils/imagePaste.js'
import { expandPath } from 'src/utils/path.js'

export type ResolvedAttachment = {
  path: string
  size: number
  isImage: boolean
  file_uuid?: string
}

export async function validateAttachmentPaths(
  rawPaths: string[],
): Promise<ValidationResult> {
  const cwd = getCwd()
  for (const rawPath of rawPaths) {
    const fullPath = expandPath(rawPath)
    try {
      const stats = await stat(fullPath)
      if (!stats.isFile()) {
        return {
          result: false,
          message: `附件 "${rawPath}" 不是普通文件。`,
          errorCode: 1,
        }
      }
    } catch (e) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT') {
        return {
          result: false,
          message: `附件 "${rawPath}" 不存在。当前工作目录：${cwd}。`,
          errorCode: 1,
        }
      }
      if (code === 'EACCES' || code === 'EPERM') {
        return {
          result: false,
          message: `附件 "${rawPath}" 无法访问（权限被拒绝）。`,
          errorCode: 1,
        }
      }
      throw e
    }
  }
  return { result: true }
}

export async function resolveAttachments(
  rawPaths: string[],
  uploadCtx: { replBridgeEnabled: boolean; signal?: AbortSignal },
): Promise<ResolvedAttachment[]> {
  // 串行执行 stat（本地操作、速度快）以保持顺序确定性，随后并行上传
  // （网络操作、速度慢）。上传失败时解析为 undefined——附件仍然携带
  // {path, size, isImage}，以便本地渲染器使用。
  const stated: ResolvedAttachment[] = []
  for (const rawPath of rawPaths) {
    const fullPath = expandPath(rawPath)
    // 单次 stat——我们需要文件大小，所以这是一次真正操作而非守卫。
    // validateInput 已先于我们执行，但文件在此期间可能已被移动
    // （TOCTOU）；若确实被移动，则让错误冒泡，以便模型能看到。
    const stats = await stat(fullPath)
    stated.push({
      path: fullPath,
      size: stats.size,
      isImage: IMAGE_EXTENSION_REGEX.test(fullPath),
    })
  }
  // 在 feature() 守卫内部进行动态导入，以便 upload.ts（axios、crypto、
  // zod、auth 工具、MIME 映射）能从非 BRIDGE_MODE 构建中完全消除。
  // 静态导入会强制进行模块作用域求值，无论 uploadBriefAttachment 内部
  // 的守卫如何——CLAUDE.md："在守卫外部定义的 helper 即使从不被调用，
  // 仍会保留在构建产物中"。
  if (feature('BRIDGE_MODE')) {
    // Headless/SDK 调用方从不设置 appState.replBridgeEnabled（只有 TTY
    // REPL 会在 main.tsx 初始化时设置）。CLAUDE_CODE_BRIEF_UPLOAD 让以子进程
    // 方式运行 CLI 的宿主可以选择启用——例如 cowork 桌面 bridge，
    // 它已经传入了 CLAUDE_CODE_OAUTH_TOKEN 用于鉴权。
    const shouldUpload =
      uploadCtx.replBridgeEnabled ||
      isEnvTruthy(process.env.CLAUDE_CODE_BRIEF_UPLOAD)
    const { uploadBriefAttachment } = await import('./upload.js')
    const uuids = await Promise.all(
      stated.map(a =>
        uploadBriefAttachment(a.path, a.size, {
          replBridgeEnabled: shouldUpload,
          signal: uploadCtx.signal,
        }),
      ),
    )
    return stated.map((a, i) =>
      uuids[i] === undefined ? a : { ...a, file_uuid: uuids[i] },
    )
  }
  return stated
}
