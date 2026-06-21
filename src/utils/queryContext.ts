/**
 * 用于构建 query() 调用 API 缓存键前缀（systemPrompt、userContext、
 * systemContext）的共享辅助函数。
 *
 * 单独放在一个文件里，因为它从 context.ts 和 constants/prompts.ts 导入，
 * 这些模块在依赖图中处于较高位置。如果把它们放到 systemPrompt.ts 或
 * sideQuestion.ts（两者都可以从 commands.ts 觽及），会产生循环依赖。
 * 只有入口层文件从这里导入（QueryEngine.ts、cli/print.ts）。
 */

import type { Command } from '../commands.js'
import { getSystemPrompt } from '../constants/prompts.js'
import { getSystemContext, getUserContext } from '../context.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Tools, ToolUseContext } from '../Tool.js'
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import type { Message } from '../types/message.js'
import { createAbortController } from './abortController.js'
import type { FileStateCache } from './fileStateCache.js'
import type { CacheSafeParams } from './forkedAgent.js'
import { getMainLoopModel } from './model/model.js'
import { asSystemPrompt } from './systemPromptType.js'
import {
  shouldEnableThinkingByDefault,
  type ThinkingConfig,
} from './thinking.js'
import { logForDebugging } from './debug.js'

/**
 * 获取组成 API 缓存键前缀的三部分上下文：
 * systemPrompt 各段、userContext、systemContext。
 *
 * 当设置了 customSystemPrompt 时，会跳过默认的 getSystemPrompt 构建和
 * getSystemContext —— 自定义 prompt 会完全替代默认值，而 systemContext
 * 本应追加到默认值之后，但默认值已不再使用。
 *
 * 调用方将最终的 systemPrompt 组装为：defaultSystemPrompt（或
 * customSystemPrompt）+ 可选的附加内容 + appendSystemPrompt。QueryEngine
 * 在此基础上注入 coordinator 的 userContext 和 memory-mechanics prompt；
 * sideQuestion 的降级路径直接使用此处的基准结果。
 */
export async function fetchSystemPromptParts({
  tools,
  mainLoopModel,
  additionalWorkingDirectories,
  mcpClients,
  customSystemPrompt,
}: {
  tools: Tools
  mainLoopModel: string
  additionalWorkingDirectories: string[]
  mcpClients: MCPServerConnection[]
  customSystemPrompt: string | undefined
}): Promise<{
  defaultSystemPrompt: string[]
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
}> {
  logForDebugging(
    `[Hapii] QueryContext.fetchSystemPromptParts 开始 tools=${tools.length} model=${mainLoopModel}${customSystemPrompt ? ' customPrompt=yes' : ''}`,
    { level: 'info' },
  )
  logForDebugging(
    `[SystemPrompt] 开始构建系统提示词, 工具数=${tools.length}, model=${mainLoopModel}${customSystemPrompt ? ', 自定义prompt' : ''}`,
    { level: 'info' },
  )
  const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
    customSystemPrompt !== undefined
      ? Promise.resolve([])
      : getSystemPrompt(
          tools,
          mainLoopModel,
          additionalWorkingDirectories,
          mcpClients,
        ),
    getUserContext(),
    customSystemPrompt !== undefined ? Promise.resolve({}) : getSystemContext(),
  ])
  logForDebugging(
    `[Hapii] QueryContext.fetchSystemPromptParts 完成 partsCount=${defaultSystemPrompt.length} userCtxKeys=${Object.keys(userContext).length} sysCtxKeys=${Object.keys(systemContext).length}`,
    { level: 'info' },
  )
  logForDebugging(
    `[SystemPrompt] 构建完成, userContext键=[${Object.keys(userContext).join(', ')}], systemContext键=[${Object.keys(systemContext).join(', ')}]`,
    { level: 'info' },
  )
  return { defaultSystemPrompt, userContext, systemContext }
}

/**
 * 当 getLastCacheSafeParams() 为 null 时，根据原始输入构建 CacheSafeParams。
 *
 * 由 SDK 的 side_question 处理器（print.ts）在恢复时使用——此时一轮对话尚未
 * 完成，还没有 stopHooks 快照。此处镜像 QueryEngine.ts:ask() 中的系统 prompt
 * 组装逻辑，使重建的前缀与主循环将要发送的内容匹配，从而在常见情况下保持缓存命中。
 *
 * 如果主循环应用了此路径未知的附加内容（coordinator 模式、memory-mechanics
 * prompt），仍可能错过缓存。这是可接受的——否则只能返回 null，完全无法执行
 * side question。
 */
export async function buildSideQuestionFallbackParams({
  tools,
  commands,
  mcpClients,
  messages,
  readFileState,
  getAppState,
  setAppState,
  customSystemPrompt,
  appendSystemPrompt,
  thinkingConfig,
  agents,
}: {
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  messages: Message[]
  readFileState: FileStateCache
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  customSystemPrompt: string | undefined
  appendSystemPrompt: string | undefined
  thinkingConfig: ThinkingConfig | undefined
  agents: AgentDefinition[]
}): Promise<CacheSafeParams> {
  const mainLoopModel = getMainLoopModel()
  const appState = getAppState()

  const { defaultSystemPrompt, userContext, systemContext } =
    await fetchSystemPromptParts({
      tools,
      mainLoopModel,
      additionalWorkingDirectories: Array.from(
        appState.toolPermissionContext.additionalWorkingDirectories.keys(),
      ),
      mcpClients,
      customSystemPrompt,
    })

  const systemPrompt = asSystemPrompt([
    ...(customSystemPrompt !== undefined
      ? [customSystemPrompt]
      : defaultSystemPrompt),
    ...(appendSystemPrompt ? [appendSystemPrompt] : []),
  ])

  // 剔除进行中的 assistant 消息（stop_reason === null）——与
  // btw.tsx 的保护逻辑相同。SDK 可能在对话进行中触发 side_question。
  const last = messages.at(-1)
  const forkContextMessages =
    last?.type === 'assistant' && last.message!.stop_reason === null
      ? messages.slice(0, -1)
      : messages

  const toolUseContext: ToolUseContext = {
    options: {
      commands,
      debug: false,
      mainLoopModel,
      tools,
      verbose: false,
      thinkingConfig:
        thinkingConfig ??
        (shouldEnableThinkingByDefault() !== false
          ? { type: 'adaptive' }
          : { type: 'disabled' }),
      mcpClients,
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: agents, allAgents: [] },
      customSystemPrompt,
      appendSystemPrompt,
    },
    abortController: createAbortController(),
    readFileState,
    getAppState,
    setAppState,
    messages: forkContextMessages,
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  }

  return {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    forkContextMessages,
  }
}
