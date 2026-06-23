import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { getSubscriptionType } from 'src/utils/auth.js'
import { hasEmbeddedSearchTools } from 'src/utils/embeddedTools.js'
import { isEnvDefinedFalsy, isEnvTruthy } from 'src/utils/envUtils.js'
import { isTeammate } from 'src/utils/teammate.js'
import { isInProcessTeammate } from 'src/utils/teammateContext.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { AGENT_TOOL_NAME } from './constants.js'
import { isForkSubagentEnabled } from './forkSubagent.js'
import type { AgentDefinition } from './loadAgentsDir.js'

function getToolsDescription(agent: AgentDefinition): string {
  const { tools, disallowedTools } = agent
  const hasAllowlist = tools && tools.length > 0
  const hasDenylist = disallowedTools && disallowedTools.length > 0

  if (hasAllowlist && hasDenylist) {
    // 两者都定义：用禁用列表过滤允许列表以匹配运行时行为
    const denySet = new Set(disallowedTools)
    const effectiveTools = tools.filter(t => !denySet.has(t))
    if (effectiveTools.length === 0) {
      return 'None'
    }
    return effectiveTools.join(', ')
  } else if (hasAllowlist) {
    // 仅允许列表：显示特定的可用工具
    return tools.join(', ')
  } else if (hasDenylist) {
    // 仅禁用列表：显示 "All tools except X, Y, Z"
    return `All tools except ${disallowedTools.join(', ')}`
  }
  // 无限制
  return 'All tools'
}

/**
 * 为 agent_listing_delta 附件消息格式化一行代理信息：
 * `- type: whenToUse (Tools: ...)`。
 */
export function formatAgentLine(agent: AgentDefinition): string {
  const toolsDescription = getToolsDescription(agent)
  return `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${toolsDescription})`
}

/**
 * 代理列表是否应作为附件消息注入而不是嵌入在工具描述中。
 * 为 true 时，getPrompt() 返回静态描述，attachments.ts 发出 agent_listing_delta 附件。
 *
 * 动态代理列表约占整个集群 cache_creation token 的 10.2%：MCP 异步
 * 连接、/reload-plugins 或权限模式更改会改变列表 →
 * 描述变化 → 完整的 tool-schema 缓存失效。
 *
 * 使用 CLAUDE_CODE_AGENT_LIST_IN_MESSAGES=true/false 进行覆盖以供测试。
 */
export function shouldInjectAgentListInMessages(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES)) return true
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES))
    return false
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_agent_list_attach', false)
}

export async function getPrompt(
  agentDefinitions: AgentDefinition[],
  isCoordinator?: boolean,
  allowedAgentTypes?: string[],
): Promise<string> {
  // 当 Agent(x,y) 限制可生成的代理时，按允许的类型过滤代理
  const effectiveAgents = allowedAgentTypes
    ? agentDefinitions.filter(a => allowedAgentTypes.includes(a.agentType))
    : agentDefinitions

  // Fork 子代理功能：启用时插入 "When to fork" 部分
  // （fork 语义、指令式提示）并替换为感知 fork 的示例。
  const forkEnabled = isForkSubagentEnabled()

  const whenToForkSection = forkEnabled
    ? `

## 何时使用 fork

当你需要委托能从完整对话上下文中受益的工作时（例如，继续多文件重构，子代理需要相同的系统提示和历史记录），使用 \`fork: true\`。对于大多数任务，优先选择专用代理类型（Explore、Plan、general-purpose）。

**不要偷看。** 工具结果包含一个 \`output_file\` 路径——除非用户明确要求进度检查，否则不要 Read 或 tail 它。你会收到完成通知；信任它。

**不要抢先。** 启动后，你对 fork 找到的内容一无所知。永远不要捏造或预测 fork 结果。如果通知到达前用户有后续提问，告诉他们 fork 仍在运行。

**编写 fork 提示。** 由于 fork 继承了你的上下文，提示是一个*指令*——做什么，而不是情况是什么。明确说明范围。不要重新解释背景。
`
    : ''

  const writingThePromptSection = `

## 编写提示

${forkEnabled ? '在不使用 `fork: true` 的情况下生成代理时，它从零上下文开始。' : ''}像对待刚走进房间的聪明同事一样简报代理——它没有看过这次对话，不知道你尝试了什么，不理解为什么这项任务重要。
- 解释你想要完成什么以及为什么，你已经了解或排除了什么，以及足够的上下文让代理做出判断。
- 如果你需要简短的回复，请说明（"在 200 字内报告"）。
- 查找类任务：交出确切的命令。调查类任务：交出问题——当前提错误时规定的步骤只会成为累赘。

${forkEnabled ? '对于非 fork 代理，简短' : '简短'}的命令式提示只会产生浅薄、通用的工作。

**永远不要委托理解。** 不要写"根据你的发现修复 bug"或"根据研究实现它"。编写证明你理解了的提示：包含文件路径、行号、具体要更改什么。
`

  // 当开关打开时，代理列表位于 agent_listing_delta
  // 附件中（参见 attachments.ts）而不是内联在此处。这保持了
  // 工具描述在 MCP/插件/权限更改时的静态，以便
  // tools-block 提示缓存不会在每次代理加载时失效。
  const listViaAttachment = shouldInjectAgentListInMessages()

  const agentListSection = listViaAttachment
    ? `可用的代理类型已列在对话中的 <system-reminder> 消息里。`
    : `可用的代理类型及其可访问的工具：
${effectiveAgents.map(agent => formatAgentLine(agent)).join('\n')}`

  // 协调器和非协调器模式都使用的共享核心提示
  const shared = `启动一个新代理来自主处理复杂的多步骤任务。

${AGENT_TOOL_NAME} 工具会启动专用代理（子进程），自主处理复杂任务。每种代理类型都有其特定的能力和可用工具。

${agentListSection}

使用 ${AGENT_TOOL_NAME} 工具时，指定 subagent_type 参数来选择要使用的代理类型。如果省略，则使用 general-purpose 代理。${forkEnabled ? ` 设置 \`fork: true\` 可从父代理的对话上下文 fork，继承完整历史和模型。` : ''}`

  // 协调器模式获得精简提示——协调器系统提示
  // 已经涵盖了使用说明、示例和不使用时的指导。
  if (isCoordinator) {
    return shared
  }

  // Ant 原生构建将 find/grep 别名为嵌入式 bfs/ugrep 并移除了
  // 专用 Glob/Grep 工具，所以改为通过 Bash 指向 find。
  const embedded = hasEmbeddedSearchTools()
  const fileSearchHint = embedded
    ? '`find` via the Bash tool'
    : `the ${GLOB_TOOL_NAME} tool`
  // "class Foo" 示例是关于内容搜索的。非嵌入式保持 Glob
  // （原始意图：find-the-file-containing）。嵌入式使用 grep 因为
  // find -name 不查看文件内容。
  const contentSearchHint = embedded
    ? '`grep` via the Bash tool'
    : `the ${GLOB_TOOL_NAME} tool`
  const whenNotToUseSection = forkEnabled
    ? ''
    : `
不要使用 ${AGENT_TOOL_NAME} 工具的情况：
- 如果你想读取特定文件路径，请使用 ${FILE_READ_TOOL_NAME} 工具或 ${fileSearchHint}，而不是 ${AGENT_TOOL_NAME} 工具，以便更快地找到匹配项
- 如果你正在搜索特定的类定义，如 "class Foo"，请使用 ${contentSearchHint}，以便更快地找到匹配项
- 如果你正在特定文件或 2-3 个文件集合中搜索代码，请使用 ${FILE_READ_TOOL_NAME} 工具而不是 ${AGENT_TOOL_NAME} 工具，以便更快地找到匹配项
- 其他与上述代理描述无关的任务
`

  // 通过附件列出时，"launch multiple agents" 注释在
  // 附件消息中（在那里以订阅为条件）。内联时，保持
  // 现有的每次调用 getSubscriptionType() 检查。
  const concurrencyNote =
    !listViaAttachment && getSubscriptionType() !== 'pro'
      ? `
- 尽可能并发启动多个代理以最大化性能；为此，在单条消息中使用多个工具调用`
      : ''

  // 非协调器获得包含所有部分的完整提示
  return `${shared}
${whenNotToUseSection}

使用说明：
- 始终包含一个简短的描述（3-5 个词）概括代理将要做什么${concurrencyNote}
- 代理完成后，它会向你返回一条消息。代理返回的结果对用户不可见。要向用户展示结果，你应该向用户发送一条包含结果简洁摘要的文本消息。${
    // eslint-disable-next-line custom-rules/no-process-env-top-level
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) &&
    !isInProcessTeammate()
      ? `
- 你可以使用 run_in_background 参数选择在后台运行代理。当代理在后台运行时，它完成时会自动通知你——不要 sleep、轮询或主动检查进度。继续做其他工作或回复用户。
- **前台 vs 后台**：当你需要代理的结果才能继续时使用前台（默认）——例如，其发现将指导你下一步的研究代理。当你有真正独立的并行工作要做时使用后台。`
      : ''
  }
- 要继续之前生成的代理，使用 ${SEND_MESSAGE_TOOL_NAME}，并将代理的 ID 或名称作为 \`to\` 字段。代理将保留完整上下文恢复运行。${forkEnabled ? '每次非 fork 的 Agent 调用从没有上下文开始——提供完整的任务描述。' : '每次 Agent 调用都是全新开始——提供完整的任务描述。'}
- 代理的输出通常应该被信任
- 明确告诉代理你是期望它编写代码还是只做研究（搜索、文件读取、网页抓取等）${forkEnabled ? '' : "，因为它不知道用户的意图"}
- 如果代理描述中提到它应该被主动使用，那么你应该尽力在用户不需要主动要求的情况下使用它。使用你的判断力。
- 如果用户指定他们想要你"并行"运行代理，你必须发送一条包含多个 ${AGENT_TOOL_NAME} 工具使用内容块的单条消息。例如，如果你需要并行启动 build-validator 代理和 test-runner 代理，发送一条包含两个工具调用的单条消息。
- 你可以选择设置 \`isolation: "worktree"\` 在临时 git worktree 中运行代理，给它一个仓库的隔离副本。如果代理没有做任何更改，worktree 会自动清理；如果有更改，worktree 路径和分支会在结果中返回。${
    process.env.USER_TYPE === 'ant'
      ? `\n- 你可以设置 \`isolation: "remote"\` 在远程 CCR 环境中运行代理。这始终是后台任务；完成时会通知你。用于需要全新沙箱的长时间运行任务。`
      : ''
  }${
    isInProcessTeammate()
      ? `
- run_in_background、name、team_name 和 mode 参数在此上下文中不可用。仅支持同步子代理。`
      : isTeammate()
        ? `
- name、team_name 和 mode 参数在此上下文中不可用——队友不能生成其他队友。省略它们以生成子代理。`
        : ''
  }${whenToForkSection}${writingThePromptSection}`
}
