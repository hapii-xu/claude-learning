import { BASH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BashTool/toolName.js'
import { FILE_READ_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GrepTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/SendMessageTool/constants.js'
import { WEB_FETCH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/WebSearchTool/prompt.js'
import { isUsing3PServices } from 'src/utils/auth.js'
import { hasEmbeddedSearchTools } from 'src/utils/embeddedTools.js'
import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import type {
  AgentDefinition,
  BuiltInAgentDefinition,
} from '../loadAgentsDir.js'

const CLAUDE_CODE_DOCS_MAP_URL =
  'https://code.claude.com/docs/en/claude_code_docs_map.md'
const CDP_DOCS_MAP_URL = 'https://platform.claude.com/llms.txt'

export const CLAUDE_CODE_GUIDE_AGENT_TYPE = 'claude-code-guide'

function getClaudeCodeGuideBasePrompt(): string {
  // Ant 原生构建将 find/grep 别名为嵌入式 bfs/ugrep 并移除
  // 专用的 Glob/Grep 工具，因此指向 find/grep。
  const localSearchHint = hasEmbeddedSearchTools()
    ? `${FILE_READ_TOOL_NAME}, \`find\`, and \`grep\``
    : `${FILE_READ_TOOL_NAME}, ${GLOB_TOOL_NAME}, and ${GREP_TOOL_NAME}`

  return `你是 Claude 指南代理。你的主要职责是帮助用户有效地理解和使用 Claude Code、Claude Agent SDK 和 Claude API（前身为 Anthropic API）。

**你的专业知识涵盖三个领域：**

1. **Claude Code**（CLI 工具）：安装、配置、hooks、skills、MCP 服务器、键盘快捷键、IDE 集成、设置和工作流程。

2. **Claude Agent SDK**：基于 Claude Code 技术构建自定义 AI 代理的框架。适用于 Node.js/TypeScript 和 Python。

3. **Claude API**：用于直接模型交互、工具使用和集成的 Claude API（前身为 Anthropic API）。

**文档来源：**

- **Claude Code 文档**（${CLAUDE_CODE_DOCS_MAP_URL}）：获取此文档以回答关于 Claude Code CLI 工具的问题，包括：
  - 安装、设置和入门
  - Hooks（命令执行前/后）
  - 自定义 skills
  - MCP 服务器配置
  - IDE 集成（VS Code、JetBrains）
  - 设置文件和配置
  - 键盘快捷键和热键
  - 子代理和插件
  - 沙箱和安全

- **Claude Agent SDK 文档**（${CDP_DOCS_MAP_URL}）：获取此文档以回答关于使用 SDK 构建代理的问题，包括：
  - SDK 概述和入门（Python 和 TypeScript）
  - 代理配置 + 自定义工具
  - 会话管理和权限
  - 代理中的 MCP 集成
  - 托管和部署
  - 成本跟踪和上下文管理
  注意：Agent SDK 文档是同一 URL 下 Claude API 文档的一部分。

- **Claude API 文档**（${CDP_DOCS_MAP_URL}）：获取此文档以回答关于 Claude API（前身为 Anthropic API）的问题，包括：
  - Messages API 和流式传输
  - 工具使用（函数调用）和 Anthropic 定义的工具（computer use、代码执行、网页搜索、文本编辑器、bash、编程工具调用、工具搜索工具、上下文编辑、Files API、结构化输出）
  - 视觉、PDF 支持和引用
  - 扩展思考和结构化输出
  - 远程 MCP 服务器的 MCP 连接器
  - 云提供商集成（Bedrock、Vertex AI、Foundry）

**方法：**
1. 确定用户问题属于哪个领域
2. 使用 ${WEB_FETCH_TOOL_NAME} 获取相应的文档地图
3. 从地图中识别最相关的文档 URL
4. 获取具体的文档页面
5. 基于官方文档提供清晰、可操作的指导
6. 如果文档没有涵盖该主题，使用 ${WEB_SEARCH_TOOL_NAME}
7. 在相关时使用 ${localSearchHint} 引用本地项目文件（CLAUDE.md、.claude/ 目录）

**指南：**
- 始终优先使用官方文档而不是假设
- 保持回复简洁且可操作
- 在有帮助时包含具体示例或代码片段
- 在回复中引用确切的文档 URL
- 通过主动建议相关命令、快捷键或功能来帮助用户发现特性

通过提供基于文档的准确指导来完成用户的请求。`
}

function getFeedbackGuideline(): string {
  // 对于第三方服务（Bedrock/Vertex/Foundry），/feedback 命令被禁用
  // 改为引导用户使用适当的反馈渠道
  if (isUsing3PServices()) {
    return `- 当你找不到答案或功能不存在时，将用户引导至 ${MACRO.ISSUES_EXPLAINER}`
  }
  return '- 当你找不到答案或功能不存在时，引导用户使用 /feedback 报告功能请求或 bug'
}

export const CLAUDE_CODE_GUIDE_AGENT: BuiltInAgentDefinition = {
  agentType: CLAUDE_CODE_GUIDE_AGENT_TYPE,
  whenToUse: `当用户询问以下问题时使用此代理（"Claude 能...吗"、"Claude 是否..."、"我如何..."）：(1) Claude Code（CLI 工具）- 功能、hooks、斜杠命令、MCP 服务器、设置、IDE 集成、键盘快捷键；(2) Claude Agent SDK - 构建自定义代理；(3) Claude API（前身为 Anthropic API）- API 使用、工具使用、Anthropic SDK 用法。**重要：**在生成新代理之前，检查是否已有正在运行或最近完成的 claude-code-guide 代理可以通过 ${SEND_MESSAGE_TOOL_NAME} 继续使用。`,
  // Ant 原生构建：Glob/Grep 工具被移除；改用 Bash（通过 find/grep 别名
  // 使用嵌入式 bfs/ugrep）进行本地文件搜索。
  tools: hasEmbeddedSearchTools()
    ? [
        BASH_TOOL_NAME,
        FILE_READ_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
      ]
    : [
        GLOB_TOOL_NAME,
        GREP_TOOL_NAME,
        FILE_READ_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
      ],
  source: 'built-in',
  baseDir: 'built-in',
  model: 'haiku',
  permissionMode: 'dontAsk',
  getSystemPrompt({ toolUseContext }) {
    const commands = toolUseContext.options.commands

    // 构建上下文部分
    const contextSections: string[] = []

    // 1. 自定义技能
    const customCommands = commands.filter(cmd => cmd.type === 'prompt')
    if (customCommands.length > 0) {
      const commandList = customCommands
        .map(cmd => `- /${cmd.name}: ${cmd.description}`)
        .join('\n')
      contextSections.push(
        `**Available custom skills in this project:**\n${commandList}`,
      )
    }

    // 2. 来自 .claude/agents/ 的自定义代理
    const customAgents =
      toolUseContext.options.agentDefinitions.activeAgents.filter(
        (a: AgentDefinition) => a.source !== 'built-in',
      )
    if (customAgents.length > 0) {
      const agentList = customAgents
        .map((a: AgentDefinition) => `- ${a.agentType}: ${a.whenToUse}`)
        .join('\n')
      contextSections.push(
        `**Available custom agents configured:**\n${agentList}`,
      )
    }

    // 3. MCP servers
    const mcpClients = toolUseContext.options.mcpClients
    if (mcpClients && mcpClients.length > 0) {
      const mcpList = mcpClients
        .map((client: { name: string }) => `- ${client.name}`)
        .join('\n')
      contextSections.push(`**Configured MCP servers:**\n${mcpList}`)
    }

    // 4. Plugin commands
    const pluginCommands = commands.filter(
      cmd => cmd.type === 'prompt' && cmd.source === 'plugin',
    )
    if (pluginCommands.length > 0) {
      const pluginList = pluginCommands
        .map(cmd => `- /${cmd.name}: ${cmd.description}`)
        .join('\n')
      contextSections.push(`**可用的插件 skills：**\n${pluginList}`)
    }

    // 5. User settings
    const settings = getSettings_DEPRECATED()
    if (Object.keys(settings).length > 0) {
      // eslint-disable-next-line no-restricted-syntax -- human-facing UI, not tool_result
      const settingsJson = jsonStringify(settings, null, 2)
      contextSections.push(
        `**用户的 settings.json：**\n\`\`\`json\n${settingsJson}\n\`\`\``,
      )
    }

    // 添加反馈指南（根据用户是否使用第三方服务有条件地添加）
    const feedbackGuideline = getFeedbackGuideline()
    const basePromptWithFeedback = `${getClaudeCodeGuideBasePrompt()}
${feedbackGuideline}`

    // 如果有任何上下文要添加，将其追加到基础系统提示
    if (contextSections.length > 0) {
      return `${basePromptWithFeedback}

---

# User's Current Configuration

The user has the following custom setup in their environment:

${contextSections.join('\n\n')}

When answering questions, consider these configured features and proactively suggest them when relevant.`
    }

    // 如果没有上下文要添加，返回基础提示
    return basePromptWithFeedback
  },
}
