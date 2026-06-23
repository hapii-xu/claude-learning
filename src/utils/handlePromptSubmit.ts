import type { UUID } from 'crypto'
import { logEvent } from 'src/services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/metadata.js'
import { type Command, getCommandName, isCommandEnabled } from '../commands.js'
import { selectableUserMessagesFilter } from '../components/MessageSelector.js'
import type { SpinnerMode } from '../components/Spinner/types.js'
import type { QuerySource } from '../constants/querySource.js'
import { expandPastedTextRefs, parseReferences } from '../history.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { IDESelection } from '../hooks/useIdeSelection.js'
import type { AppState } from '../state/AppState.js'
import type { SetToolJSXFn } from '../Tool.js'
import type { LocalJSXCommandOnDone } from '../types/command.js'
import type { Message } from '../types/message.js'
import {
  isValidImagePaste,
  type PromptInputMode,
  type QueuedCommand,
} from '../types/textInputTypes.js'
import { createAbortController } from './abortController.js'
import type { PastedContent } from './config.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import type { EffortValue } from './effort.js'
import type { FileHistoryState } from './fileHistory.js'
import { fileHistoryEnabled, fileHistoryMakeSnapshot } from './fileHistory.js'
import { gracefulShutdownSync } from './gracefulShutdown.js'
import { toError } from './errors.js'
import { logError } from './log.js'
import { enqueue } from './messageQueueManager.js'
import { resolveSkillModelOverride } from './model/model.js'
import {
  claimConsumableQueuedAutonomyCommands,
  finalizeAutonomyCommandsForTurn,
} from './autonomyQueueLifecycle.js'
import type { ProcessUserInputContext } from './processUserInput/processUserInput.js'
import { processUserInput } from './processUserInput/processUserInput.js'
import type { QueryGuard } from './QueryGuard.js'
import { queryCheckpoint, startQueryProfile } from './queryProfiler.js'
import { runWithWorkload } from './workloadContext.js'

function exit(): void {
  gracefulShutdownSync(0)
}

type BaseExecutionParams = {
  queuedCommands?: QueuedCommand[]
  messages: Message[]
  mainLoopModel: string
  ideSelection: IDESelection | undefined
  querySource: QuerySource
  commands: Command[]
  queryGuard: QueryGuard
  /**
   * 外部加载（远程会话、前台化后台任务）处于活跃状态时为 true。
   * 这些路径不经过 queryGuard，因此队列检查需要单独处理它们。
   * 对于出队路径（executeQueuedInput）应省略（默认 false）——
   * 出队项在入队时已经通过了此检查。
   */
  isExternalLoading?: boolean
  setToolJSX: SetToolJSXFn
  getToolUseContext: (
    messages: Message[],
    newMessages: Message[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => ProcessUserInputContext
  setUserInputOnProcessing: (prompt?: string) => void
  setAbortController: (abortController: AbortController | null) => void
  onQuery: (
    newMessages: Message[],
    abortController: AbortController,
    shouldQuery: boolean,
    additionalAllowedTools: string[],
    mainLoopModel: string,
    onBeforeQuery?: (input: string, newMessages: Message[]) => Promise<boolean>,
    input?: string,
    effort?: EffortValue,
  ) => Promise<boolean>
  setAppState: (updater: (prev: AppState) => AppState) => void
  onBeforeQuery?: (input: string, newMessages: Message[]) => Promise<boolean>
  canUseTool?: CanUseToolFn
}

/**
 * 核心执行逻辑参数（不含 UI 相关逻辑）。
 */
type ExecuteUserInputParams = BaseExecutionParams & {
  resetHistory: () => void
  onInputChange: (value: string) => void
}

export type PromptInputHelpers = {
  setCursorOffset: (offset: number) => void
  clearBuffer: () => void
  resetHistory: () => void
}

export type HandlePromptSubmitParams = BaseExecutionParams & {
  // 直接用户输入路径（从 onSubmit 调用时设置，队列处理器调用时 absent）
  input?: string
  mode?: PromptInputMode
  pastedContents?: Record<number, PastedContent>
  helpers: PromptInputHelpers
  onInputChange: (value: string) => void
  setPastedContents: React.Dispatch<
    React.SetStateAction<Record<number, PastedContent>>
  >
  abortController?: AbortController | null
  addNotification?: (notification: {
    key: string
    text: string
    priority: 'low' | 'medium' | 'high' | 'immediate'
  }) => void
  setMessages?: (updater: (prev: Message[]) => Message[]) => void
  streamMode?: SpinnerMode
  hasInterruptibleToolInProgress?: boolean
  uuid?: UUID
  /**
   * 为 true 时，以 `/` 开头的输入被视为纯文本。
   * 用于远程接收的消息（bridge/CCR），不应触发本地斜杠命令或技能。
   */
  skipSlashCommands?: boolean
  /** 保留输入源自远程控制（入队时）。 */
  bridgeOrigin?: boolean
}

export async function handlePromptSubmit(
  params: HandlePromptSubmitParams,
): Promise<void> {
  const {
    helpers,
    queryGuard,
    isExternalLoading = false,
    commands,
    onInputChange,
    setPastedContents,
    setToolJSX,
    getToolUseContext,
    messages,
    mainLoopModel,
    ideSelection,
    setUserInputOnProcessing,
    setAbortController,
    onQuery,
    setAppState,
    onBeforeQuery,
    canUseTool,
    queuedCommands,
    uuid,
    skipSlashCommands,
    bridgeOrigin,
  } = params

  const { setCursorOffset, clearBuffer, resetHistory } = helpers

  logForDebugging(
    `------- handlePromptSubmit 开始 ------- input="${params.input?.slice(0, 50) ?? ''}" mode=${params.mode ?? 'prompt'} skipSlashCommands=${skipSlashCommands ?? false} queuedCommands=${queuedCommands?.length ?? 0}`,
    { level: 'info' },
  )

  // 队列处理器路径：命令已预验证并准备执行。
  // 跳过所有输入校验、引用解析和队列逻辑。
  if (queuedCommands?.length) {
    logForDebugging(
      `[handlePromptSubmit] 队列处理器路径 commands=${queuedCommands.length}`,
      { level: 'info' },
    )
    startQueryProfile()
    await executeUserInput({
      queuedCommands,
      messages,
      mainLoopModel,
      ideSelection,
      querySource: params.querySource,
      commands,
      queryGuard,
      setToolJSX,
      getToolUseContext,
      setUserInputOnProcessing,
      setAbortController,
      onQuery,
      setAppState,
      onBeforeQuery,
      resetHistory,
      canUseTool,
      onInputChange,
    })
    logForDebugging(`------- handlePromptSubmit 结束 ------- (队列路径)`, {
      level: 'info',
    })
    return
  }

  const input = params.input ?? ''
  const mode = params.mode ?? 'prompt'
  const rawPastedContents = params.pastedContents ?? {}

  // 图片仅在其 [Image #N] 占位符仍在文本中时才会发送。
  // 删除内联药丸会丢弃图片；此处在过滤孤立条目。
  const referencedIds = new Set(parseReferences(input).map(r => r.id))
  const pastedContents = Object.fromEntries(
    Object.entries(rawPastedContents).filter(
      ([, c]) => c.type !== 'image' || referencedIds.has(c.id),
    ),
  )

  const hasImages = Object.values(pastedContents).some(isValidImagePaste)
  if (input.trim() === '') {
    logForDebugging(`[handlePromptSubmit] 空输入，直接返回`, { level: 'info' })
    logForDebugging(`------- handlePromptSubmit 结束 ------- (空输入)`, {
      level: 'info',
    })
    return
  }

  // 处理退出命令，触发退出命令而非直接 process.exit
  // 远程 bridge 消息跳过 — iOS 上输入的 "exit" 不应终止本地会话
  if (
    !skipSlashCommands &&
    ['exit', 'quit', ':q', ':q!', ':wq', ':wq!'].includes(input.trim())
  ) {
    logForDebugging(
      `[handlePromptSubmit] 检测到退出命令 input="${input.trim()}"`,
      { level: 'info' },
    )
    // 触发退出命令，将显示反馈对话框
    const exitCommand = commands.find(cmd => cmd.name === 'exit')
    if (exitCommand) {
      logForDebugging(`[handlePromptSubmit] 找到退出命令，提交 /exit`, {
        level: 'info',
      })
      // 改为提交 /exit 命令 — 需要处理递归调用
      void handlePromptSubmit({
        ...params,
        input: '/exit',
      })
    } else {
      logForDebugging(`[handlePromptSubmit] 未找到退出命令，直接退出`, {
        level: 'info',
      })
      // 找不到退出命令时回退到直接退出
      exit()
    }
    logForDebugging(`------- handlePromptSubmit 结束 ------- (退出命令)`, {
      level: 'info',
    })
    return
  }

  // 在入队或立即命令派发之前解析引用并替换为实际内容，
  // 确保入队命令和立即命令都能收到提交时展开的文本。
  const finalInput = expandPastedTextRefs(input, pastedContents)
  const pastedTextRefs = parseReferences(input).filter(
    r => pastedContents[r.id]?.type === 'text',
  )
  const pastedTextCount = pastedTextRefs.length
  const pastedTextBytes = pastedTextRefs.reduce(
    (sum, r) => sum + (pastedContents[r.id]?.content.length ?? 0),
    0,
  )
  logEvent('tengu_paste_text', { pastedTextCount, pastedTextBytes })

  // 处理本地 local-jsx 立即命令（如 /config、/doctor）
  // 远程 bridge 消息跳过 — CCR 客户端的斜杠命令是纯文本
  if (!skipSlashCommands && finalInput.trim().startsWith('/')) {
    const trimmedInput = finalInput.trim()
    const spaceIndex = trimmedInput.indexOf(' ')
    const commandName =
      spaceIndex === -1
        ? trimmedInput.slice(1)
        : trimmedInput.slice(1, spaceIndex)
    const commandArgs =
      spaceIndex === -1 ? '' : trimmedInput.slice(spaceIndex + 1).trim()

    logForDebugging(
      `[handlePromptSubmit] 检测到斜杠命令 commandName="${commandName}" args="${commandArgs.slice(0, 30)}"`,
      { level: 'info' },
    )

    const immediateCommand = commands.find(
      cmd =>
        cmd.immediate &&
        isCommandEnabled(cmd) &&
        (cmd.name === commandName ||
          cmd.aliases?.includes(commandName) ||
          getCommandName(cmd) === commandName),
    )

    if (
      immediateCommand &&
      immediateCommand.type === 'local-jsx' &&
      (queryGuard.isActive || isExternalLoading)
    ) {
      logEvent('tengu_immediate_command_executed', {
        commandName:
          immediateCommand.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      // 清空输入
      onInputChange('')
      setCursorOffset(0)
      setPastedContents({})
      clearBuffer()

      const context = getToolUseContext(
        messages,
        [],
        createAbortController(),
        mainLoopModel,
      )

      let doneWasCalled = false
      const onDone: LocalJSXCommandOnDone = (result, options) => {
        doneWasCalled = true
        // 使用 clearLocalJSX 显式清除本地 JSX 命令
        setToolJSX({
          jsx: null,
          shouldHidePromptInput: false,
          clearLocalJSX: true,
        })
        if (result && options?.display !== 'skip' && params.addNotification) {
          params.addNotification({
            key: `immediate-${immediateCommand.name}`,
            text: result,
            priority: 'immediate',
          })
        }
        if (options?.nextInput) {
          if (options.submitNextInput) {
            enqueue({ value: options.nextInput, mode: 'prompt' })
          } else {
            onInputChange(options.nextInput)
          }
        }
      }

      const impl = await immediateCommand.load()
      const jsx = await impl.call(onDone, context, commandArgs)

      // 如果 onDone 已触发则跳过 — 防止 isLocalJSXCommand 卡住
      // （完整机制见 processSlashCommand.tsx 的 local-jsx 分支）。
      if (jsx && !doneWasCalled) {
        logForDebugging(
          `[handlePromptSubmit] 设置即时命令 JSX commandName="${commandName}"`,
          { level: 'info' },
        )
        setToolJSX({
          jsx,
          shouldHidePromptInput: false,
          isLocalJSXCommand: true,
          isImmediate: true,
        })
      }
      logForDebugging(`------- handlePromptSubmit 结束 ------- (即时命令)`, {
        level: 'info',
      })
      return
    }
  }

  if (queryGuard.isActive || isExternalLoading) {
    // 仅允许 prompt 和 bash 模式命令入队
    if (mode !== 'prompt' && mode !== 'bash') {
      logForDebugging(
        `[handlePromptSubmit] 非 prompt/bash 模式，跳过入队 mode=${mode}`,
        { level: 'info' },
      )
      logForDebugging(`------- handlePromptSubmit 结束 ------- (非入队模式)`, {
        level: 'info',
      })
      return
    }

    // 当所有执行中的工具的 interruptBehavior 为 'cancel' 时
    // （如 SleepTool），中断当前轮次。
    if (params.hasInterruptibleToolInProgress) {
      logForDebugging(
        `[interrupt] Aborting current turn: streamMode=${params.streamMode}`,
      )
      logEvent('tengu_cancel', {
        source:
          'interrupt_on_submit' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        streamMode:
          params.streamMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      params.abortController?.abort('interrupt')
    }

    // 入队时包含字符串值和原始 pastedContents。图片将在
    // processUserInput 运行时在执行时调整大小（而非在此处烘焙）。
    enqueue({
      value: finalInput.trim(),
      preExpansionValue: input.trim(),
      mode,
      pastedContents: hasImages ? pastedContents : undefined,
      skipSlashCommands,
      bridgeOrigin,
      uuid,
    })

    logForDebugging(
      `[handlePromptSubmit] 输入已入队 value="${finalInput.trim().slice(0, 50)}" mode=${mode} hasImages=${hasImages}`,
      { level: 'info' },
    )

    onInputChange('')
    setCursorOffset(0)
    setPastedContents({})
    resetHistory()
    clearBuffer()
    logForDebugging(`------- handlePromptSubmit 结束 ------- (入队)`, {
      level: 'info',
    })
    return
  }

  // 启动本次查询的性能分析
  startQueryProfile()

  // 从直接用户输入构造 QueuedCommand，使两条路径都经过
  // 同一个 executeUserInput 循环。这确保无论命令如何到达，
  // 图片都通过 processUserInput 调整大小。
  const cmd: QueuedCommand = {
    value: finalInput,
    preExpansionValue: input,
    mode,
    pastedContents: hasImages ? pastedContents : undefined,
    skipSlashCommands,
    bridgeOrigin,
    uuid,
  }

  await executeUserInput({
    queuedCommands: [cmd],
    messages,
    mainLoopModel,
    ideSelection,
    querySource: params.querySource,
    commands,
    queryGuard,
    setToolJSX,
    getToolUseContext,
    setUserInputOnProcessing,
    setAbortController,
    onQuery,
    setAppState,
    onBeforeQuery,
    resetHistory,
    canUseTool,
    onInputChange,
  })
  logForDebugging(`------- handlePromptSubmit 结束 ------- (直接执行)`, {
    level: 'info',
  })
}

/**
 * 执行用户输入的核心逻辑，不含 UI 副作用。
 *
 * 所有命令都以 `queuedCommands` 形式到达。第一条命令获得完整处理
 * （附件、ideSelection、带图片缩放的 pastedContents）。第 2-N 条命令
 * 设置 `skipAttachments` 以避免重复轮次级上下文。
 */
async function executeUserInput(params: ExecuteUserInputParams): Promise<void> {
  const {
    messages,
    mainLoopModel,
    ideSelection,
    querySource,
    queryGuard,
    setToolJSX,
    getToolUseContext,
    setUserInputOnProcessing,
    setAbortController,
    onQuery,
    setAppState,
    onBeforeQuery,
    resetHistory,
    canUseTool,
    queuedCommands,
  } = params

  logForDebugging(
    `------- executeUserInput 开始 ------- commands=${queuedCommands?.length ?? 0} querySource=${querySource} hasIdeSelection=${!!ideSelection}`,
    { level: 'info' },
  )

  // 注意：粘贴引用在调用此函数之前已处理完毕
  //（handlePromptSubmit 中入队前，或首次执行前）。
  // 始终创建新的中止控制器 — queryGuard 保证无并发
  // executeUserInput 调用，因此无需继承先前的控制器。
  const abortController = createAbortController()
  setAbortController(abortController)

  function makeContext(): ProcessUserInputContext {
    return getToolUseContext(messages, [], abortController, mainLoopModel)
  }

  // 使用 try-finally 包装，确保即使 processUserInput 抛出异常
  // 或跳过 onQuery，guard 也会被释放。onQuery 的 finally 调用
  // queryGuard.end()，将 running→idle 转换；下方的 cancelReservation()
  // 在这种情况下是空操作（仅作用于 dispatching 状态）。
  try {
    // 在 processUserInput 之前预留 guard — processBashCommand 等待
    // BashTool.call()，processSlashCommand 等待 getMessagesForSlashCommand，
    // 因此在这些等待期间 guard 必须处于活跃状态，以确保并发的
    // handlePromptSubmit 调用入队（通过上方的 isActive 检查）而非
    // 启动第二个 executeUserInput。如果 guard 已处于 dispatching
    // （遗留队列处理器路径），此调用为空操作。
    queryGuard.reserve()
    queryCheckpoint('query_process_user_input_start')

    const newMessages: Message[] = []
    let shouldQuery = false
    let allowedTools: string[] | undefined
    let model: string | undefined
    let effort: EffortValue | undefined
    let nextInput: string | undefined
    let submitNextInput: boolean | undefined

    // 统一迭代所有命令。第一条命令获得附件 +
    // ideSelection + pastedContents，其余跳过附件以避免
    // 重复轮次级上下文（IDE 选择、todos、diffs）。
    let commands = queuedCommands ?? []
    const queuedAutonomyClaim =
      await claimConsumableQueuedAutonomyCommands(commands)
    commands = queuedAutonomyClaim.attachmentCommands
    const claimedAutonomyCommands = queuedAutonomyClaim.claimedCommands
    if (commands.length === 0) {
      logForDebugging(
        `[executeUserInput] 无可消费命令（全部自治命令不可消费），清除 abort 控制器并返回`,
        { level: 'info' },
      )
      // 清除上方几行设置的 abort 控制器，防止本次轮次的
      // 过时控制器泄漏到下一个轮次（当所有声明的自治命令
      // 都因不可消费而被跳过时）。
      setAbortController(null)
      logForDebugging(`------- executeUserInput 结束 ------- (无命令)`, {
        level: 'info',
      })
      return
    }

    // 计算本次轮次的工作负载标签。queueProcessor 可能将 cron 提示
    // 与同一 tick 的人类提示批处理；仅当每个命令都同意相同的
    // 非 undefined 工作负载时才打标签 — 人类在主动等待。
    const firstWorkload = commands[0]?.workload
    const turnWorkload =
      firstWorkload !== undefined &&
      commands.every(c => c.workload === firstWorkload)
        ? firstWorkload
        : undefined
    const deferredAutonomyRunIds = new Set<string>()

    // 将整个轮次（processUserInput 循环 + onQuery）包装在
    // AsyncLocalStorage 上下文中。这是跨 await 边界正确传播
    // 工作负载的唯一方式：void 分离的后台代理
    // （executeForkedSlashCommand、AgentTool）在调用时捕获 ALS 上下文，
    // 它们内部的每个 await 都在该上下文中恢复 — 与父级的延续隔离。
    // 进程全局的可变槽位会在该函数的同步返回路径的第一个 await 处
    // 被分离闭包篡改。见 state.ts。
    let turnError: unknown
    try {
      await runWithWorkload(turnWorkload, async () => {
        for (let i = 0; i < commands.length; i++) {
          const cmd = commands[i]!
          const isFirst = i === 0
          const runId = cmd.autonomy?.runId
          logForDebugging(
            `[executeUserInput] 处理命令 #${i}/${commands.length - 1} mode=${cmd.mode} isFirst=${isFirst} skipAttachments=${!isFirst}`,
            { level: 'info' },
          )
          const result = await processUserInput({
            input: cmd.value,
            preExpansionInput: cmd.preExpansionValue,
            mode: cmd.mode,
            setToolJSX,
            context: makeContext(),
            pastedContents: isFirst ? cmd.pastedContents : undefined,
            messages,
            setUserInputOnProcessing: isFirst
              ? setUserInputOnProcessing
              : undefined,
            isAlreadyProcessing: !isFirst,
            querySource,
            canUseTool,
            uuid: cmd.uuid,
            ideSelection: isFirst ? ideSelection : undefined,
            skipSlashCommands: cmd.skipSlashCommands,
            bridgeOrigin: cmd.bridgeOrigin,
            isMeta: cmd.isMeta,
            skipAttachments: !isFirst,
            autonomy: cmd.autonomy,
          })
          if (runId && result.deferAutonomyCompletion) {
            deferredAutonomyRunIds.add(runId)
          }
          // 在此处标记 origin，而非将另一个参数穿过
          // processUserInput → processUserInputBase → processTextPrompt → createUserMessage。
          // 对于 task-notifications，从 mode 派生 origin — 镜像 messages.ts
          // （'queued_command' 分支）的 origin 派生；有意不镜像其
          // isMeta:true，使空闲出队的通知通过 UserAgentNotificationMessage
          // 在会话记录中保持可见。
          const origin =
            cmd.origin ??
            (cmd.mode === 'task-notification'
              ? ({ kind: 'task-notification' } as const)
              : undefined)
          if (origin) {
            for (const m of result.messages) {
              if (m.type === 'user') m.origin = origin
            }
          }
          newMessages.push(...result.messages)
          if (isFirst) {
            shouldQuery = result.shouldQuery
            allowedTools = result.allowedTools
            model = result.model
            effort = result.effort
            nextInput = result.nextInput
            submitNextInput = result.submitNextInput
          }
        }

        queryCheckpoint('query_process_user_input_end')

        logForDebugging(
          `[executeUserInput] processUserInput 循环完成 newMessages=${newMessages.length} shouldQuery=${shouldQuery} model=${model ?? mainLoopModel}`,
          { level: 'info' },
        )

        if (fileHistoryEnabled()) {
          queryCheckpoint('query_file_history_snapshot_start')
          newMessages.filter(selectableUserMessagesFilter).forEach(message => {
            void fileHistoryMakeSnapshot(
              (updater: (prev: FileHistoryState) => FileHistoryState) => {
                setAppState(prev => ({
                  ...prev,
                  fileHistory: updater(prev.fileHistory),
                }))
              },
              message.uuid,
            )
          })
          queryCheckpoint('query_file_history_snapshot_end')
        }

        if (newMessages.length) {
          // 历史记录现在由调用方（onSubmit）为直接用户提交添加。
          // 这确保队列命令处理（通知、已队列的用户输入）不会
          // 添加到历史记录，因为这些要么不应在历史记录中，要么
          // 在首次入队时已添加。
          resetHistory()
          setToolJSX({
            jsx: null,
            shouldHidePromptInput: false,
            clearLocalJSX: true,
          })

          const primaryCmd = commands[0]
          const primaryMode = primaryCmd?.mode ?? 'prompt'
          const primaryInput =
            primaryCmd && typeof primaryCmd.value === 'string'
              ? primaryCmd.value
              : undefined
          const shouldCallBeforeQuery = primaryMode === 'prompt'

          logForDebugging(
            `[executeUserInput] 调用 onQuery newMessages=${newMessages.length} shouldQuery=${shouldQuery} model=${model ? resolveSkillModelOverride(model, mainLoopModel) : mainLoopModel} hasBeforeQuery=${shouldCallBeforeQuery && !!onBeforeQuery}`,
            { level: 'info' },
          )

          await onQuery(
            newMessages,
            abortController,
            shouldQuery,
            allowedTools ?? [],
            model
              ? resolveSkillModelOverride(model, mainLoopModel)
              : mainLoopModel,
            shouldCallBeforeQuery ? onBeforeQuery : undefined,
            primaryInput,
            effort,
          )
        } else {
          // 跳过消息的本地斜杠命令（如 /model、/theme）。
          // 在清除 toolJSX 之前释放 guard，以防止 spinner 闪烁 —
          // spinner 公式检查：(!toolJSX || showSpinner) && isLoading。
          // 如果在 guard 仍被预留时清除 toolJSX，spinner 会短暂显示。
          // 下方的 finally 也会调用 cancelReservation（如果已空闲则为空操作）。
          queryGuard.cancelReservation()
          setToolJSX({
            jsx: null,
            shouldHidePromptInput: false,
            clearLocalJSX: true,
          })
          resetHistory()
          setAbortController(null)
        }

        // 处理希望链式调用的命令的 nextInput（如 /discover 激活）
        if (nextInput) {
          if (submitNextInput) {
            enqueue({ value: nextInput, mode: 'prompt' })
          } else {
            params.onInputChange(nextInput)
          }
        }
      }) // end runWithWorkload — ALS 上下文自然作用域化，无需 finally
    } catch (error) {
      turnError = error
    }

    // 仅当轮次主体本身成功时，才将声明的自治命令
    // 最终化为 `completed`。在独立的 try/catch 中运行 finalize 调用，
    // 防止此处的失败导致同一批命令被重复最终化为 `failed`
    // （之前在成功轮次后取消了后续队列状态）。
    if (claimedAutonomyCommands.length) {
      const finalizableCommands = claimedAutonomyCommands.filter(command => {
        const runId = command.autonomy?.runId
        return !runId || !deferredAutonomyRunIds.has(runId)
      })
      if (turnError) {
        try {
          await finalizeAutonomyCommandsForTurn({
            commands: finalizableCommands,
            outcome: { type: 'failed', error: turnError },
            currentDir: getCwd(),
            priority: 'later',
            workload: turnWorkload,
          })
        } catch (finalizeError) {
          logError(toError(finalizeError))
        }
      } else {
        try {
          const nextCommands = await finalizeAutonomyCommandsForTurn({
            commands: finalizableCommands,
            outcome: { type: 'completed' },
            currentDir: getCwd(),
            priority: 'later',
            workload: turnWorkload,
          })
          for (const nextCommand of nextCommands) {
            enqueue(nextCommand)
          }
        } catch (finalizeError) {
          logError(toError(finalizeError))
        }
      }
    }

    if (turnError) {
      logForDebugging(`[executeUserInput] 轮次执行出错，重新抛出 turnError`, {
        level: 'error',
      })
      throw turnError
    }
  } finally {
    // 安全网：如果 processUserInput 抛出异常或 onQuery 被跳过，
    // 释放 guard 预留。如果 onQuery 已运行则为空操作
    // （guard 通过 end() 变为 idle，或正在运行 — cancelReservation
    // 仅作用于 dispatching）。这是释放预留的唯一来源；
    // useQueueProcessor 不再需要自己的 .finally()。
    queryGuard.cancelReservation()
    // 安全网：如果 processUserInput 未产生消息或抛出异常，
    // 清除占位符 — 否则它将保持可见直到下一个轮次的
    // resetLoadingState。当 onQuery 运行时为无害：setMessages 使
    // displayedMessages 增长超过基线，REPL.tsx 已隐藏它。
    setUserInputOnProcessing(undefined)
  }
  logForDebugging(`------- executeUserInput 结束 -------`, { level: 'info' })
}
