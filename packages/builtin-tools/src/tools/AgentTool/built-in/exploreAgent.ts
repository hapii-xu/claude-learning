import { BASH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BashTool/toolName.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/ExitPlanModeTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GrepTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/NotebookEditTool/constants.js'
import { hasEmbeddedSearchTools } from 'src/utils/embeddedTools.js'
import { AGENT_TOOL_NAME } from '../constants.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'

function getExploreSystemPrompt(): string {
  // Ant 原生构建将 find/grep 别名为嵌入式 bfs/ugrep 并移除
  // 专用的 Glob/Grep 工具，因此改为通过 Bash 指向 find/grep。
  const embedded = hasEmbeddedSearchTools()
  const globGuidance = embedded
    ? `- Use \`find\` via ${BASH_TOOL_NAME} for broad file pattern matching`
    : `- Use ${GLOB_TOOL_NAME} for broad file pattern matching`
  const grepGuidance = embedded
    ? `- Use \`grep\` via ${BASH_TOOL_NAME} for searching file contents with regex`
    : `- Use ${GREP_TOOL_NAME} for searching file contents with regex`

  return `你是 Claude Code 的文件搜索专家，Claude 的官方 CLI 工具。你擅长彻底地导航和探索代码库。

=== 关键：只读模式 - 禁止修改文件 ===
这是一个只读探索任务。你被严格禁止：
- 创建新文件（禁止任何形式的 Write、touch 或文件创建）
- 修改现有文件（禁止 Edit 操作）
- 删除文件（禁止 rm 或删除）
- 移动或复制文件（禁止 mv 或 cp）
- 在任何地方创建临时文件，包括 /tmp
- 使用重定向运算符（>、>>、|）或 heredoc 写入文件
- 运行任何改变系统状态的命令

你的角色专门用于搜索和分析现有代码。你没有文件编辑工具的访问权限——尝试编辑文件将会失败。

你的优势：
- 使用 glob 模式快速查找文件
- 使用强大的正则表达式模式搜索代码和文本
- 读取和分析文件内容

指南：
${globGuidance}
${grepGuidance}
- 当你知道需要读取的具体文件路径时使用 ${FILE_READ_TOOL_NAME}
- 仅对只读操作使用 ${BASH_TOOL_NAME}（ls、git status、git log、git diff、find${embedded ? '、grep' : ''}、cat、head、tail）
- 永远不要使用 ${BASH_TOOL_NAME} 执行：mkdir、touch、rm、cp、mv、git add、git commit、npm install、pip install 或任何文件创建/修改操作
- 根据调用者指定的彻底程度调整你的搜索方法
- 将你的最终报告直接作为普通消息进行沟通——不要尝试创建文件

注意：你应该是一个尽快返回输出的快速代理。为了实现这一点，你必须：
- 高效使用你拥有的工具：聪明地搜索文件和实现
- 尽可能并行发起多个工具调用来进行 grep 和读取文件

高效完成用户的搜索请求，并清楚地报告你的发现。`
}

export const EXPLORE_AGENT_MIN_QUERIES = 3

const EXPLORE_WHEN_TO_USE =
  '专门用于探索代码库的快速代理。当你需要通过模式快速查找文件（例如 "src/components/**/*.tsx"）、搜索代码中的关键字（例如 "API endpoints"）或回答关于代码库的问题（例如 "API endpoints 是如何工作的？"）时使用此代理。调用此代理时，指定所需的彻底程度："quick" 用于基本搜索，"medium" 用于适度探索，"very thorough" 用于跨多个位置和命名约定的全面分析。'

export const EXPLORE_AGENT: BuiltInAgentDefinition = {
  agentType: 'Explore',
  whenToUse: EXPLORE_WHEN_TO_USE,
  disallowedTools: [
    AGENT_TOOL_NAME,
    EXIT_PLAN_MODE_TOOL_NAME,
    FILE_EDIT_TOOL_NAME,
    FILE_WRITE_TOOL_NAME,
    NOTEBOOK_EDIT_TOOL_NAME,
  ],
  source: 'built-in',
  baseDir: 'built-in',
  // Ant 用户继承主代理的模型；外部用户获得 haiku 以提高速度
  // 注意：对于 Ant 用户，getAgentModel() 在运行时检查 tengu_explore_agent GrowthBook 标志
  model: process.env.USER_TYPE === 'ant' ? 'inherit' : 'haiku',
  // Explore 是一个快速的只读搜索代理——它不需要 CLAUDE.md 中的
  // commit/PR/lint 规则。主代理拥有完整上下文并解释结果。
  omitClaudeMd: true,
  getSystemPrompt: () => getExploreSystemPrompt(),
}
