import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import {
  createUserMessage,
  REJECT_MESSAGE,
  withMemoryCorrectionHint,
} from 'src/utils/messages.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { findToolByName, type Tools, type ToolUseContext } from '../../Tool.js'
import { BASH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BashTool/toolName.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { createChildAbortController } from '../../utils/abortController.js'
import { runToolUse } from './toolExecution.js'
import { createToolBatchSpan, endToolBatchSpan } from '../langfuse/index.js'
import type { LangfuseSpan } from '../langfuse/index.js'
import { logForDebugging } from '../../utils/debug.js'

type MessageUpdate = {
  message?: Message
  newContext?: ToolUseContext
}

type ToolStatus = 'queued' | 'executing' | 'completed' | 'yielded'

type TrackedTool = {
  id: string
  block: ToolUseBlock
  assistantMessage: AssistantMessage
  status: ToolStatus
  isConcurrencySafe: boolean
  promise?: Promise<void>
  results?: Message[]
  // 进度消息单独存储并立即产生
  pendingProgress: Message[]
  contextModifiers?: Array<(context: ToolUseContext) => ToolUseContext>
}

/**
 * 在工具流入时执行它们，带有并发控制。
 * - 并发安全工具可以与其他并发安全工具并行执行
 * - 非并发工具必须单独执行（独占访问）
 * - 结果被缓冲并按工具接收顺序发出
 */
export class StreamingToolExecutor {
  private tools: TrackedTool[] = []
  private toolUseContext: ToolUseContext
  private hasErrored = false
  private erroredToolDescription = ''
  private siblingAbortController: AbortController
  private discarded = false
  private progressAvailableResolve?: () => void
  private turnSpan: LangfuseSpan | null = null

  constructor(
    private readonly toolDefinitions: Tools,
    private readonly canUseTool: CanUseToolFn,
    toolUseContext: ToolUseContext,
  ) {
    this.toolUseContext = toolUseContext
    this.siblingAbortController = createChildAbortController(
      toolUseContext.abortController,
    )
    logForDebugging(
      `[Hapii] StreamingToolExecutor 初始化 toolCount=${toolDefinitions.length}`,
      { level: 'info' },
    )
  }

  /**
   * 丢弃所有待处理和进行中的工具。当流式回退发生并且应该放弃
   * 失败尝试的结果时调用。排队的工具不会启动，进行中的工具将
   * 收到合成错误。
   *
   * 释放所有内部引用（工具数组、中止控制器、上下文），以便丢弃的
   * 执行器及其缓冲结果可以被垃圾回收。没有这个，在 NO_FLICKER 模式下
   * 重复的 API 重试会累积泄漏的 TrackedTool 对象（每个都持有
   * assistantMessage、results、pendingProgress）。
   */
  discard(): void {
    logForDebugging(
      `[Hapii] StreamingToolExecutor.discard 丢弃 ${this.tools.length} 个进行中工具（流式降级重试）`,
      { level: 'info' },
    )
    this.discarded = true
    // 中止正在运行的工具子进程（Bash 生成等），以便它们不会在
    // 执行器被替换后继续产生结果。
    this.siblingAbortController.abort('streaming_fallback')
    // 释放引用以允许 GC 工具块、消息和 promise。
    this.tools.length = 0
    this.progressAvailableResolve = undefined
    if (this.turnSpan) {
      endToolBatchSpan(this.turnSpan)
      this.turnSpan = null
    }
  }

  /**
   * 将工具添加到执行队列。如果条件允许，将立即开始执行。
   */
  addTool(block: ToolUseBlock, assistantMessage: AssistantMessage): void {
    logForDebugging(
      `[Hapii] StreamingToolExecutor.addTool name=${block.name} id=${block.id} queueLen=${this.tools.length}`,
      { level: 'info' },
    )
    // 在第一个工具上创建 turn span — 将在 getRemainingResults 中结束
    if (this.tools.length === 0 && this.turnSpan === null) {
      this.turnSpan = createToolBatchSpan(
        this.toolUseContext.langfuseTrace ?? null,
        { toolNames: [block.name], batchIndex: 0 },
      )
      if (this.turnSpan) {
        this.toolUseContext = {
          ...this.toolUseContext,
          langfuseBatchSpan: this.turnSpan,
        }
      }
    }
    const toolDefinition = findToolByName(this.toolDefinitions, block.name)
    if (!toolDefinition) {
      logForDebugging(
        `[Hapii] StreamingToolExecutor.addTool 未找到工具定义 name=${block.name}`,
        {
          level: 'error',
        },
      )
      this.tools.push({
        id: block.id,
        block,
        assistantMessage,
        status: 'completed',
        isConcurrencySafe: true,
        pendingProgress: [],
        results: [
          createUserMessage({
            content: [
              {
                type: 'tool_result',
                content: `<tool_use_error>Error: No such tool available: ${block.name}</tool_use_error>`,
                is_error: true,
                tool_use_id: block.id,
              },
            ],
            toolUseResult: `Error: No such tool available: ${block.name}`,
            sourceToolAssistantUUID: assistantMessage.uuid,
          }),
        ],
      })
      return
    }

    const parsedInput = toolDefinition.inputSchema.safeParse(block.input)
    const isConcurrencySafe = parsedInput?.success
      ? (() => {
          try {
            return Boolean(toolDefinition.isConcurrencySafe(parsedInput.data))
          } catch {
            return false
          }
        })()
      : false
    this.tools.push({
      id: block.id,
      block,
      assistantMessage,
      status: 'queued',
      isConcurrencySafe,
      pendingProgress: [],
    })

    void this.processQueue()
  }

  /**
   * 基于当前并发状态检查工具是否可以执行
   */
  private canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executingTools = this.tools.filter(t => t.status === 'executing')
    return (
      executingTools.length === 0 ||
      (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))
    )
  }

  /**
   * 处理队列，在并发条件允许时启动工具
   */
  private async processQueue(): Promise<void> {
    for (const tool of this.tools) {
      if (tool.status !== 'queued') continue

      if (this.canExecuteTool(tool.isConcurrencySafe)) {
        await this.executeTool(tool)
      } else {
        // 还无法执行此工具，且由于需要维护非并发工具的顺序，在此停止
        if (!tool.isConcurrencySafe) break
      }
    }
  }

  private createSyntheticErrorMessage(
    toolUseId: string,
    reason: 'sibling_error' | 'user_interrupted' | 'streaming_fallback',
    assistantMessage: AssistantMessage,
  ): Message {
    // 对于用户中断（ESC 拒绝），使用 REJECT_MESSAGE 以便 UI 显示
    // "User rejected edit" 而不是 "Error editing file"
    if (reason === 'user_interrupted') {
      return createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: withMemoryCorrectionHint(REJECT_MESSAGE),
            is_error: true,
            tool_use_id: toolUseId,
          },
        ],
        toolUseResult: 'User rejected tool use',
        sourceToolAssistantUUID: assistantMessage.uuid,
      })
    }
    if (reason === 'streaming_fallback') {
      return createUserMessage({
        content: [
          {
            type: 'tool_result',
            content:
              '<tool_use_error>Error: Streaming fallback - tool execution discarded</tool_use_error>',
            is_error: true,
            tool_use_id: toolUseId,
          },
        ],
        toolUseResult: 'Streaming fallback - tool execution discarded',
        sourceToolAssistantUUID: assistantMessage.uuid,
      })
    }
    const desc = this.erroredToolDescription
    const msg = desc
      ? `Cancelled: parallel tool call ${desc} errored`
      : 'Cancelled: parallel tool call errored'
    return createUserMessage({
      content: [
        {
          type: 'tool_result',
          content: `<tool_use_error>${msg}</tool_use_error>`,
          is_error: true,
          tool_use_id: toolUseId,
        },
      ],
      toolUseResult: msg,
      sourceToolAssistantUUID: assistantMessage.uuid,
    })
  }

  /**
   * 确定工具应被取消的原因。
   */
  private getAbortReason(
    tool: TrackedTool,
  ): 'sibling_error' | 'user_interrupted' | 'streaming_fallback' | null {
    if (this.discarded) {
      return 'streaming_fallback'
    }
    if (this.hasErrored) {
      return 'sibling_error'
    }
    if (this.toolUseContext.abortController.signal.aborted) {
      // 'interrupt' 表示用户在工具运行时输入了新消息。
      // 只取消 interruptBehavior 为 'cancel' 的工具；
      // 'block' 工具不应到达此处（不会触发 abort）。
      if (this.toolUseContext.abortController.signal.reason === 'interrupt') {
        return this.getToolInterruptBehavior(tool) === 'cancel'
          ? 'user_interrupted'
          : null
      }
      return 'user_interrupted'
    }
    return null
  }

  private getToolInterruptBehavior(tool: TrackedTool): 'cancel' | 'block' {
    const definition = findToolByName(this.toolDefinitions, tool.block.name)
    if (!definition?.interruptBehavior) return 'block'
    try {
      return definition.interruptBehavior()
    } catch {
      return 'block'
    }
  }

  private getToolDescription(tool: TrackedTool): string {
    const input = tool.block.input as Record<string, unknown> | undefined
    const summary = input?.command ?? input?.file_path ?? input?.pattern ?? ''
    if (typeof summary === 'string' && summary.length > 0) {
      const truncated =
        summary.length > 40 ? summary.slice(0, 40) + '\u2026' : summary
      return `${tool.block.name}(${truncated})`
    }
    return tool.block.name
  }

  private updateInterruptibleState(): void {
    const executing = this.tools.filter(t => t.status === 'executing')
    this.toolUseContext.setHasInterruptibleToolInProgress?.(
      executing.length > 0 &&
        executing.every(t => this.getToolInterruptBehavior(t) === 'cancel'),
    )
  }

  /**
   * 执行工具并收集其结果
   */
  private async executeTool(tool: TrackedTool): Promise<void> {
    tool.status = 'executing'
    this.toolUseContext.setInProgressToolUseIDs(prev =>
      new Set(prev).add(tool.id),
    )
    this.updateInterruptibleState()

    const messages: Message[] = []
    const contextModifiers: Array<(context: ToolUseContext) => ToolUseContext> =
      []

    const collectResults = async () => {
      // 如果已被中止（因错误或用户），生成合成错误块而不是运行工具
      const initialAbortReason = this.getAbortReason(tool)
      if (initialAbortReason) {
        messages.push(
          this.createSyntheticErrorMessage(
            tool.id,
            initialAbortReason,
            tool.assistantMessage,
          ),
        )
        tool.results = messages
        tool.contextModifiers = contextModifiers
        tool.status = 'completed'
        this.updateInterruptibleState()
        return
      }

      // 每个工具的子控制器。让 siblingAbortController 在 Bash 错误
      // 级联时杀死运行中的子进程（Bash 生成进程监听此信号）。
      // 权限对话框拒绝也会中止此控制器（PermissionContext.ts cancelAndAbort）
      // — 该中止必须冒泡到查询控制器，以便查询循环的工具后中止检查
      // 结束该轮次。如果没有冒泡，ExitPlanMode 的"清除上下文 + 自动"
      // 会向模型发送 REJECT_MESSAGE 而不是中止（#21056 回归）。
      const toolAbortController = createChildAbortController(
        this.siblingAbortController,
      )
      toolAbortController.signal.addEventListener(
        'abort',
        () => {
          if (
            toolAbortController.signal.reason !== 'sibling_error' &&
            !this.toolUseContext.abortController.signal.aborted &&
            !this.discarded
          ) {
            this.toolUseContext.abortController.abort(
              toolAbortController.signal.reason,
            )
          }
        },
        { once: true },
      )

      const generator = runToolUse(
        tool.block,
        tool.assistantMessage,
        this.canUseTool,
        { ...this.toolUseContext, abortController: toolAbortController },
      )

      // 跟踪此工具是否产生了错误结果。
      // 这防止了当工具自身导致错误时收到重复的"兄弟错误"消息。
      let thisToolErrored = false

      for await (const update of generator) {
        // 检查是否因兄弟工具错误或用户中断而被中止。
        // 仅当此工具不是错误源时才添加合成错误。
        const abortReason = this.getAbortReason(tool)
        if (abortReason && !thisToolErrored) {
          messages.push(
            this.createSyntheticErrorMessage(
              tool.id,
              abortReason,
              tool.assistantMessage,
            ),
          )
          break
        }

        const isErrorResult =
          update.message.type === 'user' &&
          Array.isArray(update.message.message!.content) &&
          update.message.message!.content.some(
            _ => _.type === 'tool_result' && _.is_error === true,
          )

        if (isErrorResult) {
          thisToolErrored = true
          // 只有 Bash 错误会取消兄弟工具。Bash 命令通常有隐式依赖链
          // （例如 mkdir 失败 → 后续命令无意义）。
          // Read/WebFetch 等是独立的 — 一个失败不应取消其余的。
          if (tool.block.name === BASH_TOOL_NAME) {
            this.hasErrored = true
            this.erroredToolDescription = this.getToolDescription(tool)
            this.siblingAbortController.abort('sibling_error')
          }
        }

        if (update.message) {
          // 进度消息放入 pendingProgress 以便立即产出
          if (update.message.type === 'progress') {
            tool.pendingProgress.push(update.message)
            // 通知进度已可用
            if (this.progressAvailableResolve) {
              this.progressAvailableResolve()
              this.progressAvailableResolve = undefined
            }
          } else {
            messages.push(update.message)
          }
        }
        if (update.contextModifier) {
          contextModifiers.push(update.contextModifier.modifyContext)
        }
      }
      tool.results = messages
      tool.contextModifiers = contextModifiers
      tool.status = 'completed'
      this.updateInterruptibleState()

      // 注意：我们目前不支持并发工具的上下文修饰符。
      // 虽然没有正在使用的，但如果要在并发工具中使用，
      // 需要在此处提供支持。
      if (!tool.isConcurrencySafe && contextModifiers.length > 0) {
        for (const modifier of contextModifiers) {
          this.toolUseContext = modifier(this.toolUseContext)
        }
      }
    }

    const promise = collectResults()
    tool.promise = promise

    // 完成时处理更多队列
    void promise.finally(() => {
      void this.processQueue()
    })
  }

  /**
   * 获取任何已完成但尚未产出的结果（非阻塞）
   * 在必要时维护顺序
   * 同时立即产出任何待处理的进度消息
   */
  *getCompletedResults(): Generator<MessageUpdate, void> {
    if (this.discarded) {
      return
    }

    for (const tool of this.tools) {
      // 始终立即产出待处理的进度消息，无论工具状态如何
      while (tool.pendingProgress.length > 0) {
        const progressMessage = tool.pendingProgress.shift()!
        yield { message: progressMessage, newContext: this.toolUseContext }
      }

      if (tool.status === 'yielded') {
        continue
      }

      if (tool.status === 'completed' && tool.results) {
        tool.status = 'yielded'

        for (const message of tool.results) {
          yield { message, newContext: this.toolUseContext }
        }

        markToolUseAsComplete(this.toolUseContext, tool.id)
      } else if (tool.status === 'executing' && !tool.isConcurrencySafe) {
        break
      }
    }
  }

  /**
   * 检查是否有任何工具具有待处理的进度消息
   */
  private hasPendingProgress(): boolean {
    return this.tools.some(t => t.pendingProgress.length > 0)
  }

  /**
   * 等待剩余工具并在完成时产出其结果
   * 同时在进度可用时产出进度消息
   */
  async *getRemainingResults(): AsyncGenerator<MessageUpdate, void> {
    if (this.discarded) {
      return
    }

    while (this.hasUnfinishedTools()) {
      await this.processQueue()

      for (const result of this.getCompletedResults()) {
        yield result
      }

      // 如果仍有执行中的工具但没有完成的，等待任何一个完成
      // 或等待进度变为可用
      if (
        this.hasExecutingTools() &&
        !this.hasCompletedResults() &&
        !this.hasPendingProgress()
      ) {
        const executingPromises = this.tools
          .filter(t => t.status === 'executing' && t.promise)
          .map(t => t.promise!)

        // 同时等待进度变为可用
        const progressPromise = new Promise<void>(resolve => {
          this.progressAvailableResolve = resolve
        })

        if (executingPromises.length > 0) {
          await Promise.race([...executingPromises, progressPromise])
        }
      }
    }

    for (const result of this.getCompletedResults()) {
      yield result
    }

    endToolBatchSpan(this.turnSpan)
    this.turnSpan = null
  }

  /**
   * 检查是否有任何已完成的结果准备好产出
   */
  private hasCompletedResults(): boolean {
    return this.tools.some(t => t.status === 'completed')
  }

  /**
   * 检查是否有任何工具仍在执行
   */
  private hasExecutingTools(): boolean {
    return this.tools.some(t => t.status === 'executing')
  }

  /**
   * 检查是否有任何未完成的工具
   */
  private hasUnfinishedTools(): boolean {
    return this.tools.some(t => t.status !== 'yielded')
  }

  /**
   * 获取当前工具使用上下文（可能已被上下文修饰符修改）
   */
  getUpdatedContext(): ToolUseContext {
    return this.toolUseContext
  }
}

function markToolUseAsComplete(
  toolUseContext: ToolUseContext,
  toolUseID: string,
) {
  toolUseContext.setInProgressToolUseIDs(prev => {
    const next = new Set(prev)
    next.delete(toolUseID)
    return next
  })
}
