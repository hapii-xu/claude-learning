import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { UUID } from 'crypto'
import type React from 'react'
import type { PermissionResult } from '../entrypoints/agentSdkTypes.js'
import type { Key } from '@anthropic/ink'
import type { PastedContent } from '../utils/config.js'
import type { ImageDimensions } from '../utils/imageResizer.js'
import type { TextHighlight } from '../utils/textHighlighting.js'
import type { AgentId } from './ids.js'
import type { AssistantMessage, MessageOrigin } from './message.js'

/**
 * 输入中途用于命令自动补全的内联 ghost text
 */
export type InlineGhostText = {
  /** 要显示的 ghost text（例如 /commit 对应 "mit"） */
  readonly text: string
  /** 完整命令名（例如 "commit"） */
  readonly fullCommand: string
  /** ghost text 应该出现在输入中的位置 */
  readonly insertPosition: number
}

/**
 * 文本输入组件的基础 props
 */
export type BaseTextInputProps = {
  /**
   * 可选回调：在输入起始处按上方向键时进行历史导航
   */
  readonly onHistoryUp?: () => void

  /**
   * 可选回调：在输入末尾处按下方向键时进行历史导航
   */
  readonly onHistoryDown?: () => void

  /**
   * `value` 为空时显示的文本。
   */
  readonly placeholder?: string

  /**
   * 通过行尾反斜杠允许多行输入（默认：`true`）
   */
  readonly multiline?: boolean

  /**
   * 监听用户输入。当同时存在多个输入组件、并且输入必须"路由"到某个特定组件时非常有用。
   */
  readonly focus?: boolean

  /**
   * 替换所有字符并对值做掩码。适用于密码输入。
   */
  readonly mask?: string

  /**
   * 是否显示光标，并允许通过方向键在文本输入中导航。
   */
  readonly showCursor?: boolean

  /**
   * 高亮粘贴的文本
   */
  readonly highlightPastedText?: boolean

  /**
   * 文本输入中要显示的值。
   */
  readonly value: string

  /**
   * 值更新时调用的函数。
   */
  readonly onChange: (value: string) => void

  /**
   * 按下 `Enter` 时调用的函数，第一个参数是输入的值。
   */
  readonly onSubmit?: (value: string) => void

  /**
   * 按下 Ctrl+C 退出时调用的函数。
   */
  readonly onExit?: () => void

  /**
   * 可选回调：显示退出消息
   */
  readonly onExitMessage?: (show: boolean, key?: string) => void

  /**
   * 可选回调：显示自定义消息
   */
  // readonly onMessage?: (show: boolean, message?: string) => void

  /**
   * 可选回调：重置历史位置
   */
  readonly onHistoryReset?: () => void

  /**
   * 可选回调：当输入被清空时触发（例如双击 Esc）
   */
  readonly onClearInput?: () => void

  /**
   * 文本换行的列数
   */
  readonly columns: number

  /**
   * 输入视口的最大可见行数。当换行后的输入
   * 超过该行数时，仅渲染光标附近的若干行。
   */
  readonly maxVisibleLines?: number

  /**
   * 可选回调：当粘贴了图片时触发
   */
  readonly onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
    sourcePath?: string,
  ) => void

  /**
   * 可选回调：当粘贴大段文本（超过 800 字符）时触发
   */
  readonly onPaste?: (text: string) => void

  /**
   * 粘贴状态变化时的回调
   */
  readonly onIsPastingChange?: (isPasting: boolean) => void

  /**
   * 是否禁用上/下方向键的光标移动
   */
  readonly disableCursorMovementForUpDownKeys?: boolean

  /**
   * 跳过文本层的二次按下 Esc 处理器。当某个
   * keybinding context（例如 Autocomplete）接管 escape 时设置此项 —— 该 keybinding 的
   * stopImmediatePropagation 无法屏蔽文本输入，因为子
   * effect 比父 effect 先注册 useInput 监听器。
   */
  readonly disableEscapeDoublePress?: boolean

  /**
   * 文本中光标的偏移量
   */
  readonly cursorOffset: number

  /**
   * 设置光标偏移量的回调
   */
  onChangeCursorOffset: (offset: number) => void

  /**
   * 可选的提示文本，显示在命令输入之后
   * 用于显示命令可用的参数
   */
  readonly argumentHint?: string

  /**
   * 可选的撤销功能回调
   */
  readonly onUndo?: () => void

  /**
   * 是否以暗色渲染文本
   */
  readonly dimColor?: boolean

  /**
   * 可选的文本高亮，用于搜索结果或其他高亮
   */
  readonly highlights?: TextHighlight[]

  /**
   * 可选的自定义 React 元素，作为 placeholder 渲染。
   * 提供时覆盖标准的 `placeholder` 字符串渲染。
   */
  readonly placeholderElement?: React.ReactNode

  /**
   * 可选的内联 ghost text，用于输入中途的命令自动补全
   */
  readonly inlineGhostText?: InlineGhostText

  /**
   * 可选的过滤器，在按键路由之前对原始输入生效。返回
   *（可能转换过的）输入字符串；对非空输入返回 '' 会丢弃事件。
   */
  readonly inputFilter?: (input: string, key: Key) => string
}

/**
 * VimTextInput 的扩展 props
 */
export type VimTextInputProps = BaseTextInputProps & {
  /**
   * 初始 vim 模式
   */
  readonly initialMode?: VimMode

  /**
   * 可选的模式变化回调
   */
  readonly onModeChange?: (mode: VimMode) => void
}

/**
 * Vim 编辑器模式
 */
export type VimMode = 'INSERT' | 'NORMAL'

/**
 * input hook 返回结果的公共属性
 */
export type BaseInputState = {
  onInput: (input: string, key: Key) => void
  renderedValue: string
  offset: number
  setOffset: (offset: number) => void
  /** 渲染文本中的光标行（0 基），考虑了换行。 */
  cursorLine: number
  /** 当前行中的光标列（显示宽度）。 */
  cursorColumn: number
  /** 视口起点在完整文本中的字符偏移（无窗口化时为 0）。 */
  viewportCharOffset: number
  /** 视口终点在完整文本中的字符偏移（无窗口化时为 text.length）。 */
  viewportCharEnd: number

  // 用于粘贴处理
  isPasting?: boolean
  pasteState?: {
    chunks: string[]
    timeoutId: ReturnType<typeof setTimeout> | null
  }
}

/**
 * 文本输入的状态
 */
export type TextInputState = BaseInputState

/**
 * 带模式的 vim 输入状态
 */
export type VimInputState = BaseInputState & {
  mode: VimMode
  setMode: (mode: VimMode) => void
}

/**
 * prompt 的输入模式
 */
export type PromptInputMode =
  | 'bash'
  | 'prompt'
  | 'orphaned-permission'
  | 'task-notification'

export type EditablePromptInputMode = Exclude<
  PromptInputMode,
  `${string}-notification`
>

/**
 * 队列优先级。普通模式和 proactive 模式下语义相同。
 *
 *  - `now`   —— 中断并立即发送。中止任何在途工具调用
 *              （等同于 Esc + send）。消费者（print.ts、
 *              REPL.tsx）订阅队列变化，看到 'now' 命令时中止。
 *  - `next`  —— 回合中途排空。让当前工具调用完成，然后
 *              在工具结果和下一次 API 往返之间发送这条消息。
 *              会唤醒正在进行的 SleepTool 调用。
 *  - `later` —— 回合末尾排空。等待当前回合结束后，
 *              作为新查询处理。会唤醒正在进行的 SleepTool
 *              调用（query.ts 会在 sleep 之后升级 drain 阈值，使
 *              该消息附加到同一回合）。
 *
 * SleepTool 仅在 proactive 模式下可用，所以"唤醒 SleepTool"
 * 在普通模式下是 no-op。
 */
export type QueuePriority = 'now' | 'next' | 'later'

/**
 * 排队命令类型
 */
export type QueuedCommand = {
  value: string | Array<ContentBlockParam>
  mode: PromptInputMode
  /** 默认为入队时由 `mode` 推导出的优先级。 */
  priority?: QueuePriority
  uuid?: UUID
  orphanedPermission?: OrphanedPermission
  /** 包含图片在内的原始粘贴内容。图片在执行时进行缩放。 */
  pastedContents?: Record<number, PastedContent>
  /**
   * [Pasted text #N] 占位符展开之前的输入字符串。
   * 用于 ultraplan 关键字检测，避免粘贴内容中包含该关键字
   * 触发 CCR 会话。未设置时回退到 `value`
   * （bridge/UDS/MCP 来源没有 paste 展开）。
   */
  preExpansionValue?: string
  /**
   * 为 true 时，即便输入以 `/` 开头也按纯文本处理。
   * 用于远端收到的消息（例如 bridge/CCR），不应触发
   * 本地 slash command 或 skill。
   */
  skipSlashCommands?: boolean
  /**
   * 为 true 时，slash command 会被派发，但经过
   * isBridgeSafeCommand() 过滤 —— 'local-jsx' 和仅终端命令会
   * 返回有用的错误提示而非真正执行。由 Remote Control bridge
   * 的 inbound 路径设置，以便移动端/Web 客户端可以运行 skill 和
   * 安全的命令，而不会重新暴露 PR #19134 的 bug
   * （/model 弹出本地选择器）。
   */
  bridgeOrigin?: boolean
  /**
   * 为 true 时，生成的 UserMessage 会带上 `isMeta: true` —— 在
   * transcript UI 中隐藏，但模型可见。用于系统生成的 prompt
   * （proactive tick、teammate 消息、资源更新），这些通过
   * 队列而非直接调用 `onQuery`。
   */
  isMeta?: boolean
  /**
   * 该命令的来源。盖在生成的 UserMessage 上，让
   * transcript 结构化地记录来源（而不仅仅通过内容里的 XML 标签）。
   * undefined = 人类（键盘）。
   */
  origin?: MessageOrigin
  /**
   * 工作负载 tag，会透传到 billing-header 归属块的
   * cc_workload=。队列是 cron 调度器触发与回合真正执行之间的异步
   * 边界 —— 用户 prompt 可能穿插其间 —— 所以该 tag 挂在
   * QueuedCommand 上，只有在 THIS 命令出队时才提升到 bootstrap 状态。
   */
  workload?: string
  /**
   * 应当接收该通知的 agent。undefined = 主线程。
   * subagent 在进程内运行，共用模块级命令队列；query.ts 中的 drain
   * gate 按该字段过滤，避免 subagent 的后台任务通知泄漏到
   * coordinator 的上下文中（PR #18453 统一了队列，却丢掉了
   * 双队列时意外具备的隔离）。
   */
  agentId?: AgentId
  /**
   * 系统生成自动回合的 autonomy-run 来源信息。
   * 由 autonomy ledger 用来跟踪 queue → execution 的生命周期。
   */
  autonomy?: {
    runId: string
    rootDir?: string
    trigger: 'scheduled-task' | 'proactive-tick' | 'managed-flow-step'
    sourceId?: string
    sourceLabel?: string
    flowId?: string
    flowStepId?: string
    flowStepName?: string
  }
}

/**
 * 针对 image PastedContent 且数据非空的类型守卫。空内容
 * 图片（例如拖入 0 字节文件）会产生空 base64 字符串，
 * API 会以 `image cannot be empty` 拒绝。在每一个将 PastedContent →
 * ImageBlockParam 的位置使用它，让过滤器和
 * ID 列表保持同步。
 */
export function isValidImagePaste(c: PastedContent): boolean {
  return c.type === 'image' && c.content.length > 0
}

/** 从 QueuedCommand 的 pastedContents 中抽取图片粘贴 ID。 */
export function getImagePasteIds(
  pastedContents: Record<number, PastedContent> | undefined,
): number[] | undefined {
  if (!pastedContents) {
    return undefined
  }
  const ids = Object.values(pastedContents)
    .filter(isValidImagePaste)
    .map(c => c.id)
  return ids.length > 0 ? ids : undefined
}

export type OrphanedPermission = {
  permissionResult: PermissionResult
  assistantMessage: AssistantMessage
}
