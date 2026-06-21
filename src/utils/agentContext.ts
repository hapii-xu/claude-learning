/**
 * 用于分析归因的 Agent 上下文，使用 AsyncLocalStorage 实现。
 *
 * 本模块提供了一种在异步操作中跟踪 agent 身份的方法，
 * 无需参数传递。支持两种 agent 类型：
 *
 * 1. 子代理（Agent 工具）：在进程内运行，用于快速、委派的任务。
 *    上下文：SubagentContext，agentType: 'subagent'
 *
 * 2. 进程内队友：属于具有团队协调功能的群组。
 *    上下文：TeammateAgentContext，agentType: 'teammate'
 *
 * 对于独立进程（tmux/iTerm2）中的群组队友，请使用环境变量：
 * CLAUDE_CODE_AGENT_ID, CLAUDE_CODE_PARENT_SESSION_ID
 *
 * 为什么使用 AsyncLocalStorage（而非 AppState）：
 * 当 agents 被放入后台（ctrl+b）时，多个 agents 可以在同一进程中并发运行。
 * AppState 是一个共享状态，会被覆盖，导致 Agent A 的事件错误地使用
 * Agent B 的上下文。AsyncLocalStorage 隔离每个异步执行链，
 * 因此并发 agents 不会相互干扰。
 */

import { AsyncLocalStorage } from 'async_hooks'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../services/analytics/index.js'
import { isAgentSwarmsEnabled } from './agentSwarmsEnabled.js'

/**
 * 子代理（Agent 工具的 agents）的上下文。
 * 子代理在进程内运行，用于快速、委派的任务。
 */
export type SubagentContext = {
  /** 子代理的 UUID（来自 createAgentId()） */
  agentId: string
  /** 团队负责人的会话 ID（来自 CLAUDE_CODE_PARENT_SESSION_ID 环境变量），主 REPL 子代理为 undefined */
  parentSessionId?: string
  /** Agent 类型 - Agent 工具的 agents 为 'subagent' */
  agentType: 'subagent'
  /** 子代理的类型名称（例如，"Explore"、"Bash"、"code-reviewer"） */
  subagentName?: string
  /** 是否是内置 agent（相对于用户定义的自定义 agent） */
  isBuiltIn?: boolean
  /** 调用 agent 中生成或恢复此 agent 的 request_id。
   *  对于嵌套子代理，这是直接调用者，而不是根 ——
   *  session_id 已经捆绑了整个树。每次恢复时更新。 */
  invokingRequestId?: string
  /** 此调用是初始生成还是通过 SendMessage 的后续恢复。
   *  当 invokingRequestId 不存在时为 undefined。 */
  invocationKind?: 'spawn' | 'resume'
  /** 可变标志：此调用的边是否已发送到遥测？
   *  每次生成/恢复时重置为 false；由
   *  consumeInvokingRequestId() 在第一个终端 API 事件时翻转为 true。 */
  invocationEmitted?: boolean
}

/**
 * 进程内队友的上下文。
 * 队友是群组的一部分，具有团队协调功能。
 */
export type TeammateAgentContext = {
  /** 完整的 agent ID，例如，"researcher@my-team" */
  agentId: string
  /** 显示名称，例如，"researcher" */
  agentName: string
  /** 此队友所属的团队名称 */
  teamName: string
  /** 分配给此队友的 UI 颜色 */
  agentColor?: string
  /** 队友是否必须在实现前进入计划模式 */
  planModeRequired: boolean
  /** 团队负责人的会话 ID，用于转录关联 */
  parentSessionId: string
  /** 此 agent 是否是团队负责人 */
  isTeamLead: boolean
  /** Agent 类型 - 群组队友为 'teammate' */
  agentType: 'teammate'
  /** 调用 agent 中生成或恢复此队友的 request_id。
   *  对于在工具调用之外启动的队友（例如，会话开始）为 undefined。
   *  每次恢复时更新。 */
  invokingRequestId?: string
  /** 参见 SubagentContext.invocationKind。 */
  invocationKind?: 'spawn' | 'resume'
  /** 可变标志：参见 SubagentContext.invocationEmitted。 */
  invocationEmitted?: boolean
}

/**
 * agent 上下文的判别联合类型。
 * 使用 agentType 来区分子代理和队友上下文。
 */
export type AgentContext = SubagentContext | TeammateAgentContext

const agentContextStorage = new AsyncLocalStorage<AgentContext>()

/**
 * 获取当前 agent 上下文（如果有）。
 * 如果不在 agent 上下文（子代理或队友）中运行，则返回 undefined。
 * 使用类型守卫 isSubagentContext() 或 isTeammateAgentContext() 来缩小类型。
 */
export function getAgentContext(): AgentContext | undefined {
  return agentContextStorage.getStore()
}

/**
 * 使用给定的 agent 上下文运行异步函数。
 * 函数内的所有异步操作都可以访问此上下文。
 */
export function runWithAgentContext<T>(context: AgentContext, fn: () => T): T {
  return agentContextStorage.run(context, fn)
}

/**
 * 类型守卫，检查上下文是否是 SubagentContext。
 */
export function isSubagentContext(
  context: AgentContext | undefined,
): context is SubagentContext {
  return context?.agentType === 'subagent'
}

/**
 * 类型守卫，检查上下文是否是 TeammateAgentContext。
 */
export function isTeammateAgentContext(
  context: AgentContext | undefined,
): context is TeammateAgentContext {
  if (isAgentSwarmsEnabled()) {
    return context?.agentType === 'teammate'
  }
  return false
}

/**
 * 获取适合分析日志记录的子代理名称。
 * 返回内置 agent 的类型名称，自定义 agent 返回 "user-defined"，
 * 或者如果不在子代理上下文中运行则返回 undefined。
 *
 * 对分析元数据安全：内置 agent 名称是代码常量，
 * 自定义 agent 始终映射到字面量 "user-defined"。
 */
export function getSubagentLogName():
  | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  | undefined {
  const context = getAgentContext()
  if (!isSubagentContext(context) || !context.subagentName) {
    return undefined
  }
  return (
    context.isBuiltIn ? context.subagentName : 'user-defined'
  ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * 获取当前 agent 上下文的 invoking request_id —— 每次调用只返回一次。
 * 在生成/恢复后的第一次调用时返回 id，然后返回 undefined
 * 直到下一个边界。在主线程上或生成路径没有 request_id 时
 * 也返回 undefined。
 *
 * 稀疏边语义：invokingRequestId 出现在每次调用的一个
 * tengu_api_success/error 上，所以下游的非 NULL 值标记生成/恢复边界。
 */
export function consumeInvokingRequestId():
  | {
      invokingRequestId: string
      invocationKind: 'spawn' | 'resume' | undefined
    }
  | undefined {
  const context = getAgentContext()
  if (!context?.invokingRequestId || context.invocationEmitted) {
    return undefined
  }
  context.invocationEmitted = true
  return {
    invokingRequestId: context.invokingRequestId,
    invocationKind: context.invocationKind,
  }
}
