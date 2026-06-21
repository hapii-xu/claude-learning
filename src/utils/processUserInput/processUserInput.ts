import { feature } from 'bun:bundle'
import type {
  Base64ImageSource,
  ContentBlockParam,
  ImageBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomUUID } from 'crypto'
import type { QuerySource } from 'src/constants/querySource.js'
import { logEvent } from 'src/services/analytics/index.js'
import { getContentText } from 'src/utils/messages.js'
import {
  findCommand,
  getBridgeCommandSafety,
  getCommandName,
  type LocalJSXCommandContext,
} from '../../commands.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { IDESelection } from '../../hooks/useIdeSelection.js'
import type { SetToolJSXFn, ToolUseContext } from '../../Tool.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ProgressMessage,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
import type { PermissionMode } from '../../types/permissions.js'
import {
  isValidImagePaste,
  type QueuedCommand,
  type PromptInputMode,
} from '../../types/textInputTypes.js'
import {
  type AgentMentionAttachment,
  createAttachmentMessage,
  getAttachmentMessages,
} from '../attachments.js'
import type { PastedContent } from '../config.js'
import type { EffortValue } from '../effort.js'
import { toArray } from '../generators.js'
import {
  executeUserPromptSubmitHooks,
  getUserPromptSubmitHookBlockingMessage,
} from '../hooks.js'
import {
  createImageMetadataText,
  maybeResizeAndDownsampleImageBlock,
} from '../imageResizer.js'
import { storeImages } from '../imageStore.js'
import {
  createCommandInputMessage,
  createSystemMessage,
  createUserMessage,
} from '../messages.js'
import { queryCheckpoint } from '../queryProfiler.js'
import { parseSlashCommand } from '../slashCommandParsing.js'
import {
  hasUltraplanKeyword,
  replaceUltraplanKeyword,
} from '../ultraplan/keyword.js'
import { processTextPrompt } from './processTextPrompt.js'
import { logForDebugging } from '../debug.js'
export type ProcessUserInputContext = ToolUseContext & LocalJSXCommandContext

export type ProcessUserInputBaseResult = {
  messages: (
    | UserMessage
    | AssistantMessage
    | AttachmentMessage
    | SystemMessage
    | ProgressMessage
  )[]
  shouldQuery: boolean
  allowedTools?: string[]
  model?: string
  effort?: EffortValue
  // 非交互模式（例如分叉命令）下的输出文本
  // 设置后，在 -p 模式下会作为结果返回，而不是空字符串
  resultText?: string
  // 设置后，会在命令完成后预填或提交下一次输入
  // 由 /discover 用于链式调用所选功能的命令
  nextInput?: string
  submitNextInput?: boolean
  // 为 true 时，表示命令启动了分离的后台工作，其 autonomy 运行
  // 会在后台工作完成后再收尾。
  deferAutonomyCompletion?: boolean
}

export async function processUserInput({
  input,
  preExpansionInput,
  mode,
  setToolJSX,
  context,
  pastedContents,
  ideSelection,
  messages,
  setUserInputOnProcessing,
  uuid,
  isAlreadyProcessing,
  querySource,
  canUseTool,
  skipSlashCommands,
  bridgeOrigin,
  isMeta,
  skipAttachments,
  autonomy,
}: {
  input: string | Array<ContentBlockParam>
  /**
   * 在 [Pasted text #N] 展开之前的输入。用于 ultraplan 关键词检测，
   * 防止粘贴内容里恰好包含该词而误触发。未设置时回退为字符串形式的
   * `input`。
   */
  preExpansionInput?: string
  mode: PromptInputMode
  setToolJSX: SetToolJSXFn
  context: ProcessUserInputContext
  pastedContents?: Record<number, PastedContent>
  ideSelection?: IDESelection
  messages?: Message[]
  setUserInputOnProcessing?: (prompt?: string) => void
  uuid?: string
  isAlreadyProcessing?: boolean
  querySource?: QuerySource
  canUseTool?: CanUseToolFn
  /**
   * 为 true 时，以 `/` 开头的输入会被当作普通文本处理。
   * 用于远端接收的消息（bridge/CCR），不应触发本地斜杠命令或 skill。
   */
  skipSlashCommands?: boolean
  /**
   * 为 true 时，即使设置了 skipSlashCommands，匹配 isBridgeSafeCommand() 的
   * 斜杠命令仍会执行。参见 QueuedCommand.bridgeOrigin。
   */
  bridgeOrigin?: boolean
  /**
   * 为 true 时，生成的 UserMessage 会带上 `isMeta: true`（对用户隐藏、
   * 对模型可见）。从 `QueuedCommand.isMeta` 透传，用于排队中的
   * 系统生成的 prompt。
   */
  isMeta?: boolean
  skipAttachments?: boolean
  autonomy?: QueuedCommand['autonomy']
}): Promise<ProcessUserInputBaseResult> {
  const inputString = typeof input === 'string' ? input : null
  const inputPreview =
    typeof input === 'string'
      ? input.slice(0, 80).replace(/\n/g, '\\n')
      : `ContentBlock[${input.length}]`
  logForDebugging(
    `[Hapii] ProcessUserInput 开始 type=${typeof input === 'string' ? '文本' : 'ContentBlock'} mode=${mode} isMeta=${!!isMeta}`,
    { level: 'info' },
  )
  logForDebugging(
    `[输入处理] processUserInput 开始, 类型=${typeof input === 'string' ? '文本' : 'ContentBlock'}, 内容预览="${inputPreview}${typeof input === 'string' && input.length > 80 ? '...' : ''}"`,
    { level: 'info' },
  )
  // 在仍在处理输入时，立即显示用户输入的 prompt。
  // 对 isMeta（如定时任务等系统生成的 prompt）和斜杠命令跳过
  // （它们会通过 createCommandInputMessage 自行产生系统消息回显）。
  const isSlashInput = inputString?.startsWith('/') && !skipSlashCommands
  if (mode === 'prompt' && inputString !== null && !isMeta && !isSlashInput) {
    setUserInputOnProcessing?.(inputString)
  }

  queryCheckpoint('query_process_user_input_base_start')

  const appState = context.getAppState()

  const result = await processUserInputBase(
    input,
    mode,
    setToolJSX,
    context,
    pastedContents,
    ideSelection,
    messages,
    uuid,
    isAlreadyProcessing,
    querySource,
    canUseTool,
    appState.toolPermissionContext.mode,
    skipSlashCommands,
    bridgeOrigin,
    isMeta,
    skipAttachments,
    preExpansionInput,
    autonomy,
  )
  queryCheckpoint('query_process_user_input_base_end')

  if (!result.shouldQuery) {
    return result
  }

  // 执行 UserPromptSubmit hooks 并处理阻塞情况
  queryCheckpoint('query_hooks_start')
  const inputMessage = getContentText(input) || ''

  for await (const hookResult of executeUserPromptSubmitHooks(
    inputMessage,
    appState.toolPermissionContext.mode,
    context,
    context.requestPrompt,
  )) {
    // 只关心结果
    if (hookResult.message?.type === 'progress') {
      continue
    }

    // 仅返回系统级错误消息，抹除原始的用户输入
    if (hookResult.blockingError) {
      const blockingMessage = getUserPromptSubmitHookBlockingMessage(
        hookResult.blockingError,
      )
      logForDebugging(
        `[输入处理] processUserInput 完成（hook 阻止）, shouldQuery=false`,
        { level: 'info' },
      )
      return {
        messages: [
          // TODO: 把它改成 attachment 消息
          createSystemMessage(
            `${blockingMessage}\n\nOriginal prompt: ${input}`,
            'warning',
          ),
        ],
        shouldQuery: false,
        allowedTools: result.allowedTools,
      }
    }

    // 如果设置了 preventContinuation，则停止处理，但保留原始
    // prompt 到上下文中。
    if (hookResult.preventContinuation) {
      const message = hookResult.stopReason
        ? `Operation stopped by hook: ${hookResult.stopReason}`
        : 'Operation stopped by hook'
      result.messages.push(
        createUserMessage({
          content: message,
        }),
      )
      result.shouldQuery = false
      return result
    }

    // 收集额外的上下文
    if (
      hookResult.additionalContexts &&
      hookResult.additionalContexts.length > 0
    ) {
      result.messages.push(
        createAttachmentMessage({
          type: 'hook_additional_context',
          content: hookResult.additionalContexts.map(applyTruncation),
          hookName: 'UserPromptSubmit',
          toolUseID: `hook-${randomUUID()}`,
          hookEvent: 'UserPromptSubmit',
        }),
      )
    }

    // TODO: 清理这段逻辑
    if (hookResult.message) {
      switch (hookResult.message.attachment!.type) {
        case 'hook_success':
          if (!hookResult.message.attachment!.content) {
            // 没有内容时跳过
            break
          }
          result.messages.push({
            ...hookResult.message,
            attachment: {
              ...hookResult.message.attachment!,
              content: applyTruncation(
                hookResult.message.attachment!.content as string,
              ),
            },
          } as AttachmentMessage)
          break
        default:
          result.messages.push(hookResult.message as AttachmentMessage)
          break
      }
    }
  }
  queryCheckpoint('query_hooks_end')

  // 正常路径：onQuery 会通过 startTransition 清除 userInputOnProcessing，
  // 使其与 deferredMessages 在同一帧内完成（没有闪烁间隙）。
  // 错误路径由 handlePromptSubmit 的 finally 块处理。
  return result
}

const MAX_HOOK_OUTPUT_LENGTH = 10000

function applyTruncation(content: string): string {
  if (content.length > MAX_HOOK_OUTPUT_LENGTH) {
    return `${content.substring(0, MAX_HOOK_OUTPUT_LENGTH)}… [output truncated - exceeded ${MAX_HOOK_OUTPUT_LENGTH} characters]`
  }
  return content
}

async function processUserInputBase(
  input: string | Array<ContentBlockParam>,
  mode: PromptInputMode,
  setToolJSX: SetToolJSXFn,
  context: ProcessUserInputContext,
  pastedContents?: Record<number, PastedContent>,
  ideSelection?: IDESelection,
  messages?: Message[],
  uuid?: string,
  isAlreadyProcessing?: boolean,
  querySource?: QuerySource,
  canUseTool?: CanUseToolFn,
  permissionMode?: PermissionMode,
  skipSlashCommands?: boolean,
  bridgeOrigin?: boolean,
  isMeta?: boolean,
  skipAttachments?: boolean,
  preExpansionInput?: string,
  autonomy?: QueuedCommand['autonomy'],
): Promise<ProcessUserInputBaseResult> {
  let inputString: string | null = null
  let precedingInputBlocks: ContentBlockParam[] = []

  // 收集用于 isMeta 消息的图片元数据文本
  const imageMetadataTexts: string[] = []

  // 对 `input` 做归一化视图，其中图片块已调整尺寸。对于字符串输入，
  // 这就是 `input` 本身；对于数组输入，则是处理过的块。我们把
  // 这个归一化结果（而非原始 `input`）传给 processTextPrompt，使调整过
  // 尺寸/归一化的图片块能真正到达 API——否则上面的缩放工作在常规
  // prompt 路径下会被丢弃。同时也会归一化 bridge 输入，因为 iOS
  // 可能发送 `mediaType` 而不是 `media_type`（mobile-apps#5825）。
  let normalizedInput: string | ContentBlockParam[] = input

  if (typeof input === 'string') {
    inputString = input
  } else if (input.length > 0) {
    queryCheckpoint('query_image_processing_start')
    const processedBlocks: ContentBlockParam[] = []
    for (const block of input) {
      if (block.type === 'image') {
        const resized = await maybeResizeAndDownsampleImageBlock(block)
        // 为 isMeta 消息收集图片元数据
        if (resized.dimensions) {
          const metadataText = createImageMetadataText(resized.dimensions)
          if (metadataText) {
            imageMetadataTexts.push(metadataText)
          }
        }
        processedBlocks.push(resized.block)
      } else {
        processedBlocks.push(block)
      }
    }
    normalizedInput = processedBlocks
    queryCheckpoint('query_image_processing_end')
    // 从最后一个内容块中提取字符串（如果它是文本块），
    // 并记录前面的内容块
    const lastBlock = processedBlocks[processedBlocks.length - 1]
    if (lastBlock?.type === 'text') {
      inputString = lastBlock.text
      precedingInputBlocks = processedBlocks.slice(0, -1)
    } else {
      precedingInputBlocks = processedBlocks
    }
  }

  if (inputString === null && mode !== 'prompt') {
    throw new Error(`Mode: ${mode} requires a string input.`)
  }

  // 提前把图片内容提取并转换为内容块
  // 记录 ID 顺序以便消息存储
  const imageContents = pastedContents
    ? Object.values(pastedContents).filter(isValidImagePaste)
    : []
  const imagePasteIds = imageContents.map(img => img.id)

  // 将图片写入磁盘，以便 Claude 可以在上下文中引用路径
  // （用于 CLI 工具操作、上传到 PR 等）
  const storedImagePaths = pastedContents
    ? await storeImages(pastedContents)
    : new Map<number, string>()

  // 调整粘贴图片尺寸以确保它们在 API 限制内（并行处理）
  queryCheckpoint('query_pasted_image_processing_start')
  const imageProcessingResults = await Promise.all(
    imageContents.map(async pastedImage => {
      const imageBlock: ImageBlockParam = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: (pastedImage.mediaType ||
            'image/png') as Base64ImageSource['media_type'],
          data: pastedImage.content,
        },
      }
      logEvent('tengu_pasted_image_resize_attempt', {
        original_size_bytes: pastedImage.content.length,
      })
      const resized = await maybeResizeAndDownsampleImageBlock(imageBlock)
      return {
        resized,
        originalDimensions: pastedImage.dimensions,
        sourcePath:
          pastedImage.sourcePath ?? storedImagePaths.get(pastedImage.id),
      }
    }),
  )
  // 按原顺序收集结果
  const imageContentBlocks: ContentBlockParam[] = []
  for (const {
    resized,
    originalDimensions,
    sourcePath,
  } of imageProcessingResults) {
    // 为 isMeta 消息收集图片元数据（优先使用缩放后的尺寸）
    if (resized.dimensions) {
      const metadataText = createImageMetadataText(
        resized.dimensions,
        sourcePath,
      )
      if (metadataText) {
        imageMetadataTexts.push(metadataText)
      }
    } else if (originalDimensions) {
      // 缩放未提供尺寸时，回退到原始尺寸
      const metadataText = createImageMetadataText(
        originalDimensions,
        sourcePath,
      )
      if (metadataText) {
        imageMetadataTexts.push(metadataText)
      }
    } else if (sourcePath) {
      // 有源路径但没有尺寸时，仍然加上源信息
      imageMetadataTexts.push(`[Image source: ${sourcePath}]`)
    }
    imageContentBlocks.push(resized.block)
  }
  queryCheckpoint('query_pasted_image_processing_end')

  // Bridge 安全斜杠命令覆盖：移动端/Web 客户端会设置 bridgeOrigin，
  // 同时保留 skipSlashCommands 为 true（对退出词和即时命令快速路径的
  // 纵深防御）。这里解析命令——如果它通过 isBridgeSafeCommand，就清除
  // skip 让下面的闸门打开。如果是已知但不安全的命令（local-jsx UI 或
  // 仅终端可用），直接短路返回一个友好提示，而不是让模型看到裸的
  // "/config"。
  let effectiveSkipSlash = skipSlashCommands
  if (bridgeOrigin && inputString !== null && inputString.startsWith('/')) {
    const parsed = parseSlashCommand(inputString)
    const cmd = parsed
      ? findCommand(parsed.commandName, context.options.commands)
      : undefined
    if (cmd) {
      const safety = getBridgeCommandSafety(cmd, parsed?.args ?? '')
      if (safety.ok) {
        effectiveSkipSlash = false
      } else {
        const msg =
          safety.reason ??
          `/${getCommandName(cmd)} isn't available over Remote Control.`
        logForDebugging(
          `[输入处理] processUserInput 完成（bridge 命令不安全）, shouldQuery=false`,
          { level: 'info' },
        )
        return {
          messages: [
            createUserMessage({ content: inputString, uuid }),
            createCommandInputMessage(
              `<local-command-stdout>${msg}</local-command-stdout>`,
            ),
          ],
          shouldQuery: false,
          resultText: msg,
        }
      }
    }
    // 未知的 /foo 或无法解析 —— 回退为纯文本，与 #19134 之前的行为一致。
    // 移动端用户输入 "/shrug" 时不应看到 "Unknown skill"。
  }

  // Ultraplan 关键词 —— 路由到 /ultraplan。检测在展开前的输入上进行，
  // 防止粘贴内容里恰好包含该词而误触发 CCR 会话；在展开后的输入中把它
  // 替换为 "plan"，让 CCR prompt 仍能拿到粘贴内容并保持语法通顺。引号/路径
  // 排除规则见 keyword.ts。仅限交互式 prompt 模式 + 非斜杠前缀：
  // headless/print 模式会把 local-jsx 命令从 context.options 中过滤掉，
  // 所以在那里路由到 /ultraplan 只会得到 "Unknown skill"——而且 print
  // 模式下本来也没有彩虹动画。
  // 在附件提取之前执行，使此路径与下面的斜杠命令路径一致
  // （setUserInputOnProcessing 和 setAppState 之间没有 await——
  // React 会把两者合并到同一次渲染，无闪烁）。
  if (
    feature('ULTRAPLAN') &&
    mode === 'prompt' &&
    !context.options.isNonInteractiveSession &&
    inputString !== null &&
    !effectiveSkipSlash &&
    !inputString.startsWith('/') &&
    !context.getAppState().ultraplanSessionUrl &&
    !context.getAppState().ultraplanLaunching &&
    hasUltraplanKeyword(preExpansionInput ?? inputString)
  ) {
    logEvent('tengu_ultraplan_keyword', {})
    const rewritten = replaceUltraplanKeyword(inputString).trim()
    const { processSlashCommand } = await import('./processSlashCommand.js')
    const slashResult = await processSlashCommand(
      `/ultraplan ${rewritten}`,
      precedingInputBlocks,
      imageContentBlocks,
      [],
      context,
      setToolJSX,
      uuid,
      isAlreadyProcessing,
      canUseTool,
      autonomy,
    )
    return addImageMetadataMessage(slashResult, imageMetadataTexts)
  }

  // 对于斜杠命令，附件会在 getMessagesForSlashCommand 内部提取
  const shouldExtractAttachments =
    !skipAttachments &&
    inputString !== null &&
    (mode !== 'prompt' || effectiveSkipSlash || !inputString.startsWith('/'))

  queryCheckpoint('query_attachment_loading_start')
  const attachmentMessages = shouldExtractAttachments
    ? await toArray(
        getAttachmentMessages(
          inputString,
          context,
          ideSelection ?? null,
          [], // queuedCommands - 由 query.ts 处理对话中段的附件
          messages,
          querySource,
        ),
      )
    : []
  queryCheckpoint('query_attachment_loading_end')

  // Bash 命令
  if (inputString !== null && mode === 'bash') {
    const { processBashCommand } = await import('./processBashCommand.js')
    return addImageMetadataMessage(
      await processBashCommand(
        inputString,
        precedingInputBlocks,
        attachmentMessages,
        context,
        setToolJSX,
      ),
      imageMetadataTexts,
    )
  }

  // 斜杠命令
  // 远端 bridge 消息跳过 —— 来自 CCR 客户端的输入是纯文本
  if (
    inputString !== null &&
    !effectiveSkipSlash &&
    inputString.startsWith('/')
  ) {
    const { processSlashCommand } = await import('./processSlashCommand.js')
    const slashResult = await processSlashCommand(
      inputString,
      precedingInputBlocks,
      imageContentBlocks,
      attachmentMessages,
      context,
      setToolJSX,
      uuid,
      isAlreadyProcessing,
      canUseTool,
      autonomy,
    )
    return addImageMetadataMessage(slashResult, imageMetadataTexts)
  }

  // 记录 agent mention 查询以便分析
  if (inputString !== null && mode === 'prompt') {
    const trimmedInput = inputString.trim()

    const agentMention = attachmentMessages.find(
      (m): m is AttachmentMessage<AgentMentionAttachment> =>
        m.attachment.type === 'agent_mention',
    )

    if (agentMention) {
      const agentMentionString = `@agent-${agentMention.attachment.agentType}`
      const isSubagentOnly = trimmedInput === agentMentionString
      const isPrefix =
        trimmedInput.startsWith(agentMentionString) && !isSubagentOnly

      // 用户使用 @agent-<name> 语法时记录日志
      logEvent('tengu_subagent_at_mention', {
        is_subagent_only: isSubagentOnly,
        is_prefix: isPrefix,
      })
    }
  }

  // 常规用户 prompt
  return addImageMetadataMessage(
    processTextPrompt(
      normalizedInput,
      imageContentBlocks,
      imagePasteIds,
      attachmentMessages,
      uuid,
      permissionMode,
      isMeta,
    ),
    imageMetadataTexts,
  )
}

// 将图片元数据文本作为 isMeta 消息追加到结果中
function addImageMetadataMessage(
  result: ProcessUserInputBaseResult,
  imageMetadataTexts: string[],
): ProcessUserInputBaseResult {
  if (imageMetadataTexts.length > 0) {
    result.messages.push(
      createUserMessage({
        content: imageMetadataTexts.map(text => ({ type: 'text', text })),
        isMeta: true,
      }),
    )
  }
  logForDebugging(
    `[输入处理] processUserInput 完成, shouldQuery=${result.shouldQuery}, 消息数=${result.messages.length}${result.model ? `, model=${result.model}` : ''}`,
    { level: 'info' },
  )
  return result
}
