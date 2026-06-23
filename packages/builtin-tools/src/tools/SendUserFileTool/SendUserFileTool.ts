import { z } from 'zod/v4'
import type { ToolResultBlockParam } from 'src/Tool.js'
import { buildTool } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { SEND_USER_FILE_TOOL_NAME } from './prompt.js'
import { isBridgeEnabled } from 'src/bridge/bridgeEnabled.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z
      .string()
      .describe('要发送给用户的文件的绝对路径。'),
    description: z
      .string()
      .optional()
      .describe('要发送文件的可选描述。'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type SendUserFileInput = z.infer<InputSchema>

type SendUserFileOutput = { sent: boolean; file_path: string }

export const SendUserFileTool = buildTool({
  name: SEND_USER_FILE_TOOL_NAME,
  searchHint: 'send file to user mobile device upload share',
  maxResultSizeChars: 5_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return '将文件发送给用户（KAIROS 助手模式）'
  },
  async prompt() {
    return `将文件发送到用户设备。在助手模式下，当用户请求文件或文件与对话相关时使用此工具。

使用指南：
- 使用绝对路径
- 文件必须存在且可读
- 大文件传输可能需要一些时间`
  },

  isEnabled() {
    return isBridgeEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },

  userFacingName() {
    return 'SendFile'
  },

  renderToolUseMessage(input: Partial<SendUserFileInput>) {
    return `Send file: ${input.file_path ?? '...'}`
  },

  mapToolResultToToolResultBlockParam(
    content: SendUserFileOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: content.sent
        ? `File sent: ${content.file_path}`
        : `Failed to send file: ${content.file_path}`,
    }
  },

  async call(input: SendUserFileInput, context) {
    const { file_path } = input
    const { stat } = await import('fs/promises')

    // 验证文件存在且可读
    let fileSize: number
    try {
      const fileStat = await stat(file_path)
      if (!fileStat.isFile()) {
        return {
          data: { sent: false, file_path, error: 'Path is not a file.' },
        }
      }
      fileSize = fileStat.size
    } catch {
      return {
        data: {
          sent: false,
          file_path,
          error: 'File does not exist or is not readable.',
        },
      }
    }

    // 尝试通过 bridge 上传（以便 Web 端用户可以下载）
    const appState = context.getAppState()
    let fileUuid: string | undefined
    if (appState.replBridgeEnabled) {
      try {
        const { uploadBriefAttachment } = await import(
          '@claude-code-best/builtin-tools/tools/BriefTool/upload.js'
        )
        fileUuid = await uploadBriefAttachment(file_path, fileSize, {
          replBridgeEnabled: true,
          signal: context.abortController.signal,
        })
      } catch {
        // 尽力上传——本地路径始终可用
      }
    }

    const delivered = !appState.replBridgeEnabled || Boolean(fileUuid)
    return {
      data: {
        sent: delivered,
        file_path,
        size: fileSize,
        ...(fileUuid ? { file_uuid: fileUuid } : {}),
        ...(!delivered
          ? { error: 'Bridge upload failed. File available at local path.' }
          : {}),
      },
    }
  },
})
