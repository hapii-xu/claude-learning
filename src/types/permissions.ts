/**
 * 纯权限类型定义，抽出此文件以打破 import 循环。
 *
 * 本文件仅包含类型定义与常量，无运行时依赖。
 * 实现文件仍保留在 src/utils/permissions/ 中，但可以从这里导入以避免循环依赖。
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'

// ============================================================================
// 权限模式
// ============================================================================

export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const

export type ExternalPermissionMode = (typeof EXTERNAL_PERMISSION_MODES)[number]

// 用于类型检查的穷举模式联合。用户可寻址的运行时集合是下面的
// INTERNAL_PERMISSION_MODES。
export type InternalPermissionMode = ExternalPermissionMode | 'auto' | 'bubble'
export type PermissionMode = InternalPermissionMode

// 运行时校验集合：用户可寻址的模式（settings.json 的 defaultMode、
// --permission-mode CLI flag、会话恢复）。'auto' 始终可用 —— 当
// TRANSCRIPT_CLASSIFIER 关闭时分类器不可用，auto 模式会回退为提示用户。
export const INTERNAL_PERMISSION_MODES = [
  ...EXTERNAL_PERMISSION_MODES,
  'auto' as const,
] as const satisfies readonly PermissionMode[]

export const PERMISSION_MODES = INTERNAL_PERMISSION_MODES

// ============================================================================
// 权限行为
// ============================================================================

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

// ============================================================================
// 权限规则
// ============================================================================

/**
 * 权限规则的来源。
 * 包含所有 SettingSource 取值以及额外的规则专用来源。
 */
export type PermissionRuleSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'cliArg'
  | 'command'
  | 'session'

/**
 * 权限规则的值 —— 指定具体工具及可选的内容
 */
export type PermissionRuleValue = {
  toolName: string
  ruleContent?: string
}

/**
 * 带来源与行为的权限规则
 */
export type PermissionRule = {
  source: PermissionRuleSource
  ruleBehavior: PermissionBehavior
  ruleValue: PermissionRuleValue
}

// ============================================================================
// 权限更新
// ============================================================================

/**
 * 权限更新持久化到的目的地
 */
export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg'

/**
 * 权限配置的更新操作
 */
export type PermissionUpdate =
  | {
      type: 'addRules'
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | {
      type: 'replaceRules'
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | {
      type: 'removeRules'
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | {
      type: 'setMode'
      destination: PermissionUpdateDestination
      mode: ExternalPermissionMode
    }
  | {
      type: 'addDirectories'
      destination: PermissionUpdateDestination
      directories: string[]
    }
  | {
      type: 'removeDirectories'
      destination: PermissionUpdateDestination
      directories: string[]
    }

/**
 * 额外工作目录权限的来源。
 * 注意：当前与 PermissionRuleSource 相同，但保留为独立类型以保证语义清晰，
 * 并方便未来分叉演进。
 */
export type WorkingDirectorySource = PermissionRuleSource

/**
 * 纳入权限作用域的额外目录
 */
export type AdditionalWorkingDirectory = {
  path: string
  source: WorkingDirectorySource
}

// ============================================================================
// 权限决策与结果
// ============================================================================

/**
 * 用于权限元数据的最小 command 形状。
 * 刻意只保留完整 Command 类型的子集，以避免 import 循环。
 * 仅包含权限相关组件所需的属性。
 */
export type PermissionCommandMetadata = {
  name: string
  description?: string
  // 允许额外属性以支持前向兼容
  [key: string]: unknown
}

/**
 * 附加在权限决策上的元数据
 */
export type PermissionMetadata =
  | { command: PermissionCommandMetadata }
  | undefined

/**
 * 权限被允许时的结果
 */
export type PermissionAllowDecision<
  Input extends { [key: string]: unknown } = { [key: string]: unknown },
> = {
  behavior: 'allow'
  updatedInput?: Input
  userModified?: boolean
  decisionReason?: PermissionDecisionReason
  toolUseID?: string
  acceptFeedback?: string
  contentBlocks?: ContentBlockParam[]
}

/**
 * 待执行的异步分类器检查的元数据。
 * 用于支持非阻塞的 allow 分类器评估。
 */
export type PendingClassifierCheck = {
  command: string
  cwd: string
  descriptions: string[]
}

/**
 * 需要提示用户时的结果
 */
export type PermissionAskDecision<
  Input extends { [key: string]: unknown } = { [key: string]: unknown },
> = {
  behavior: 'ask'
  message: string
  updatedInput?: Input
  decisionReason?: PermissionDecisionReason
  suggestions?: PermissionUpdate[]
  blockedPath?: string
  metadata?: PermissionMetadata
  /**
   * 若为 true，表示此 ask 决策是由 bashCommandIsSafe_DEPRECATED 安全检查触发的，
   * 针对的是 splitCommand_DEPRECATED 可能误解析的模式（如行续接、shell-quote 变形）。
   * bashToolHasPermission 据此在 splitCommand_DEPRECATED 改写命令前提前阻断。
   * 对简单的换行复合命令不设置。
   */
  isBashSecurityCheckForMisparsing?: boolean
  /**
   * 若设置，则应异步执行 allow 分类器检查。
   * 分类器可能在用户响应前自动批准该权限。
   */
  pendingClassifierCheck?: PendingClassifierCheck
  /**
   * 可选的内容块（如图片），随拒绝消息一同包含在工具结果中。
   * 用于用户以粘贴图片作为反馈的场景。
   */
  contentBlocks?: ContentBlockParam[]
}

/**
 * 权限被拒绝时的结果
 */
export type PermissionDenyDecision = {
  behavior: 'deny'
  message: string
  decisionReason: PermissionDecisionReason
  toolUseID?: string
}

/**
 * 权限决策 —— allow、ask 或 deny
 */
export type PermissionDecision<
  Input extends { [key: string]: unknown } = { [key: string]: unknown },
> =
  | PermissionAllowDecision<Input>
  | PermissionAskDecision<Input>
  | PermissionDenyDecision

/**
 * 权限结果，附加 passthrough 选项
 */
export type PermissionResult<
  Input extends { [key: string]: unknown } = { [key: string]: unknown },
> =
  | PermissionDecision<Input>
  | {
      behavior: 'passthrough'
      message: string
      decisionReason?: PermissionDecision<Input>['decisionReason']
      suggestions?: PermissionUpdate[]
      blockedPath?: string
      /**
       * 若设置，则应异步执行 allow 分类器检查。
       * 分类器可能在用户响应前自动批准该权限。
       */
      pendingClassifierCheck?: PendingClassifierCheck
    }

/**
 * 对权限决策原因的解释
 */
export type PermissionDecisionReason =
  | {
      type: 'rule'
      rule: PermissionRule
    }
  | {
      type: 'mode'
      mode: PermissionMode
    }
  | {
      type: 'subcommandResults'
      reasons: Map<string, PermissionResult>
    }
  | {
      type: 'permissionPromptTool'
      permissionPromptToolName: string
      toolResult: unknown
    }
  | {
      type: 'hook'
      hookName: string
      hookSource?: string
      reason?: string
    }
  | {
      type: 'asyncAgent'
      reason: string
    }
  | {
      type: 'sandboxOverride'
      reason: 'excludedCommand' | 'dangerouslyDisableSandbox'
    }
  | {
      type: 'classifier'
      classifier: string
      reason: string
    }
  | {
      type: 'workingDir'
      reason: string
    }
  | {
      type: 'safetyCheck'
      reason: string
      // 为 true 时，auto 模式会让分类器评估而非强制提示。对敏感文件路径
      //（.claude/、.git/、shell 配置）为 true —— 分类器能看到上下文并决策。
      // 对 Windows 路径绕过尝试和跨机 bridge 消息为 false。
      classifierApprovable: boolean
    }
  | {
      type: 'other'
      reason: string
    }

// ============================================================================
// Bash 分类器类型
// ============================================================================

export type ClassifierResult = {
  matches: boolean
  matchedDescription?: string
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

export type ClassifierBehavior = 'deny' | 'ask' | 'allow'

export type ClassifierUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

export type YoloClassifierResult = {
  thinking?: string
  shouldBlock: boolean
  reason: string
  unavailable?: boolean
  /**
   * API 返回 "prompt is too long" —— 分类器的对话已超出上下文窗口。
   * 此错误是确定性的（同样对话 → 同样错误），调用方应回退到常规提示
   * 而非重试或失败即拒绝。
   */
  transcriptTooLong?: boolean
  /** 本次分类器调用使用的模型 */
  model: string
  /** 分类器 API 调用的 token 用量（用于开销遥测） */
  usage?: ClassifierUsage
  /** 分类器 API 调用耗时（毫秒） */
  durationMs?: number
  /** 发送给分类器的各 prompt 组件的字符长度 */
  promptLengths?: {
    systemPrompt: number
    toolCalls: number
    userPrompts: number
  }
  /** 错误 prompt 被转储到的路径（仅在因 API 错误不可用时设置） */
  errorDumpPath?: string
  /** 哪个分类器阶段产出了最终决策（仅 2 阶段 XML 流程） */
  stage?: 'fast' | 'thinking'
  /** 当 stage 2 也执行时，stage 1（fast）的 token 用量 */
  stage1Usage?: ClassifierUsage
  /** 当 stage 2 也执行时，stage 1 的耗时（毫秒） */
  stage1DurationMs?: number
  /**
   * stage 1 的 API request_id（req_xxx）。便于与服务端 api_usage 日志关联，
   * 用于缓存未命中/路由归因。也用于传统 1 阶段（tool_use）分类器 ——
   * 单次请求记录于此。
   */
  stage1RequestId?: string
  /**
   * stage 1 的 API message id（msg_xxx）。便于将
   * tengu_auto_mode_decision 分析事件与分类器实际的 prompt/completion
   * 关联，以便事后分析。
   */
  stage1MsgId?: string
  /** 当 stage 2 执行时，stage 2（thinking）的 token 用量 */
  stage2Usage?: ClassifierUsage
  /** 当 stage 2 执行时，stage 2 的耗时（毫秒） */
  stage2DurationMs?: number
  /** stage 2 的 API request_id（只要 stage 2 执行即设置） */
  stage2RequestId?: string
  /** stage 2 的 API message id（msg_xxx，只要 stage 2 执行即设置） */
  stage2MsgId?: string
}

// ============================================================================
// 权限解释器类型
// ============================================================================

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

export type PermissionExplanation = {
  riskLevel: RiskLevel
  explanation: string
  reasoning: string
  risk: string
}

// ============================================================================
// 工具权限上下文
// ============================================================================

/**
 * 按来源分组的权限规则映射
 */
export type ToolPermissionRulesBySource = {
  [T in PermissionRuleSource]?: string[]
}

/**
 * 工具中进行权限检查所需的上下文
 * 注意：本类型专属文件使用了简化的 DeepImmutable 近似
 */
export type ToolPermissionContext = {
  readonly mode: PermissionMode
  readonly additionalWorkingDirectories: ReadonlyMap<
    string,
    AdditionalWorkingDirectory
  >
  readonly alwaysAllowRules: ToolPermissionRulesBySource
  readonly alwaysDenyRules: ToolPermissionRulesBySource
  readonly alwaysAskRules: ToolPermissionRulesBySource
  readonly isBypassPermissionsModeAvailable: boolean
  readonly strippedDangerousRules?: ToolPermissionRulesBySource
  readonly shouldAvoidPermissionPrompts?: boolean
  readonly awaitAutomatedChecksBeforeDialog?: boolean
  readonly prePlanMode?: PermissionMode
}
