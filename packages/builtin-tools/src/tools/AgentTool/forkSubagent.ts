import { feature } from 'bun:bundle'
import type { BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { randomUUID } from 'crypto'
import { getIsNonInteractiveSession } from 'src/bootstrap/state.js'
import {
  FORK_BOILERPLATE_TAG,
  FORK_DIRECTIVE_PREFIX,
} from 'src/constants/xml.js'
import { isCoordinatorMode } from 'src/coordinator/coordinatorMode.js'
import type {
  AssistantMessage,
  Message as MessageType,
} from 'src/types/message.js'
import { logForDebugging } from 'src/utils/debug.js'
import { createUserMessage } from 'src/utils/messages.js'
import type { BuiltInAgentDefinition } from './loadAgentsDir.js'

/**
 * Fork 子代理功能开关。
 *
 * 启用时：
 * - Agent 工具 schema 上的 `subagent_type` 变为可选
 * - 省略 `subagent_type` 会触发隐式 fork：子代理继承
 *   父代理的完整对话上下文和系统提示
 * - 所有代理生成都在后台运行（异步），以实现统一的
 *   `<task-notification>` 交互模型
 * - `/fork <directive>` 斜杠命令可用
 *
 * 与协调器模式互斥 — 协调器已经拥有编排角色并有自己的委派模型。
 */
export function isForkSubagentEnabled(): boolean {
  if (feature('FORK_SUBAGENT')) {
    if (isCoordinatorMode()) return false
    if (getIsNonInteractiveSession()) return false
    return true
  }
  return false
}

/** fork 路径触发时用于分析的合成代理类型名称。 */
export const FORK_SUBAGENT_TYPE = 'fork'

/**
 * fork 路径的合成代理定义。
 *
 * 未在 builtInAgents 中注册 — 仅在 `!subagent_type` 且
 * 实验处于激活状态时使用。`tools: ['*']` 加 `useExactTools` 意味着 fork
 * 子代理接收父代理的确切工具池（用于缓存相同的 API
 * 前缀）。`permissionMode: 'bubble'` 将权限提示显示到
 * 父终端。`model: 'inherit'` 保留父代理的模型以保持上下文
 * 长度一致。
 *
 * 此处的 getSystemPrompt 未被使用：fork 路径传递
 * `override.systemPrompt`，带有父代理已渲染的系统提示
 * 字节，通过 `toolUseContext.renderedSystemPrompt` 传入。通过
 * 重新调用 getSystemPrompt() 重建可能会偏离（GrowthBook 冷→暖）并
 * 破坏提示缓存；传入渲染后的字节是字节精确的。
 */
export const FORK_AGENT = {
  agentType: FORK_SUBAGENT_TYPE,
  whenToUse:
    'Implicit fork — inherits full conversation context. Not selectable via subagent_type; triggered by omitting subagent_type when the fork experiment is active.',
  tools: ['*'],
  maxTurns: 200,
  model: 'inherit',
  permissionMode: 'bubble',
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => '',
} satisfies BuiltInAgentDefinition

/**
 * 防止递归 fork 的守卫。fork 子代理在其工具池中保留 Agent 工具
 * 以获得缓存相同的工具定义，所以我们通过检测对话历史中的
 * fork 样板标签在调用时拒绝 fork 尝试。
 */
export function isInForkChild(messages: MessageType[]): boolean {
  return messages.some(m => {
    if (m.type !== 'user') return false
    const content = m.message!.content
    if (!Array.isArray(content)) return false
    return content.some(
      block =>
        block.type === 'text' &&
        block.text.includes(`<${FORK_BOILERPLATE_TAG}>`),
    )
  })
}

/** 用于 fork 前缀中所有 tool_result 块的占位符文本。
 * 必须在所有 fork 子代理中保持相同以进行提示缓存共享。 */
const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'

/**
 * 为子代理构建 fork 后的对话消息。
 *
 * 为了提示缓存共享，所有 fork 子代理必须产生字节相同的
 * API 请求前缀。此函数：
 * 1. 保留完整的父代理助手消息（所有 tool_use 块、思考、文本）
 * 2. 构建一条用户消息，其中包含每个 tool_use 块的 tool_results，
 *    使用相同的占位符，然后追加每个子代理的指令文本块
 *
 * 结果：[...history, assistant(all_tool_uses), user(placeholder_results..., directive)]
 * 只有最终的文本块在每个子代理中不同，最大化缓存命中。
 */
export function buildForkedMessages(
  directive: string,
  assistantMessage: AssistantMessage,
): MessageType[] {
  // 克隆助手消息以避免修改原始消息，保留所有
  // 内容块（思考、文本和每个 tool_use）
  const fullAssistantMessage: AssistantMessage = {
    ...assistantMessage,
    uuid: randomUUID(),
    message: {
      ...assistantMessage.message,
      content: [
        ...(Array.isArray(assistantMessage.message.content)
          ? assistantMessage.message.content
          : []),
      ],
    },
  }

  // 从助手消息中收集所有 tool_use 块
  const toolUseBlocks = (
    Array.isArray(assistantMessage.message.content)
      ? assistantMessage.message.content
      : []
  ).filter((block): block is BetaToolUseBlock => block.type === 'tool_use')

  if (toolUseBlocks.length === 0) {
    logForDebugging(
      `No tool_use blocks found in assistant message for fork directive: ${directive.slice(0, 50)}...`,
      { level: 'error' },
    )
    return [
      createUserMessage({
        content: [
          { type: 'text' as const, text: buildChildMessage(directive) },
        ],
      }),
    ]
  }

  // 为每个 tool_use 构建 tool_result 块，全部使用相同的占位符文本
  const toolResultBlocks = toolUseBlocks.map(block => ({
    type: 'tool_result' as const,
    tool_use_id: block.id,
    content: [
      {
        type: 'text' as const,
        text: FORK_PLACEHOLDER_RESULT,
      },
    ],
  }))

  // 构建单条用户消息：所有占位符 tool_results + 每个子代理的指令
  // TODO(smoosh): 这里的 text 兄弟在网络上创建了 [tool_result, text] 模式
  // （渲染为 </function_results>\n\nHuman:<text>）。每个子代理只构建一次，
  // 不是重复的 teacher，因此优先级较低。如果我们以后关心这个，使用
  // src/utils/messages.ts 中的 smooshIntoToolResult 将指令折叠到最后一个
  // tool_result.content 中。
  const toolResultMessage = createUserMessage({
    content: [
      ...toolResultBlocks,
      {
        type: 'text' as const,
        text: buildChildMessage(directive),
      },
    ],
  })

  return [fullAssistantMessage, toolResultMessage]
}

export function buildChildMessage(directive: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. Your system prompt says "default to forking." IGNORE IT \u2014 that's for the parent. You ARE the fork. Do NOT spawn sub-agents; execute directly.
2. Do NOT converse, ask questions, or suggest next steps
3. Do NOT editorialize or add meta-commentary
4. USE your tools directly: Bash, Read, Write, etc.
5. If you modify files, commit your changes before reporting. Include the commit hash in your report.
6. Do NOT emit text between tool calls. Use tools silently, then report once at the end.
7. Stay strictly within your directive's scope. If you discover related systems outside your scope, mention them in one sentence at most — other workers cover those areas.
8. Keep your report under 500 words unless the directive specifies otherwise. Be factual and concise.
9. Your response MUST begin with "Scope:". No preamble, no thinking-out-loud.
10. REPORT structured facts, then stop

Output format (plain text labels, not markdown headers):
  Scope: <echo back your assigned scope in one sentence>
  Result: <the answer or key findings, limited to the scope above>
  Key files: <relevant file paths — include for research tasks>
  Files changed: <list with commit hash — include only if you modified files>
  Issues: <list — include only if there are issues to flag>
</${FORK_BOILERPLATE_TAG}>

${FORK_DIRECTIVE_PREFIX}${directive}`
}

/**
 * 注入到运行在隔离 worktree 中的 fork 子代理的通知。
 * 告诉子代理翻译继承上下文中的路径、重新读取
 * 可能过时的文件，并告知其更改是隔离的。
 */
export function buildWorktreeNotice(
  parentCwd: string,
  worktreeCwd: string,
): string {
  return `You've inherited the conversation context above from a parent agent working in ${parentCwd}. You are operating in an isolated git worktree at ${worktreeCwd} — same repository, same relative file structure, separate working copy. Paths in the inherited context refer to the parent's working directory; translate them to your worktree root. Re-read files before editing if the parent may have modified them since they appear in the context. Your changes stay in this worktree and will not affect the parent's files.`
}
