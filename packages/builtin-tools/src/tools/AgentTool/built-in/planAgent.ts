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
import { EXPLORE_AGENT } from './exploreAgent.js'

function getPlanV2SystemPrompt(): string {
  // Ant 原生构建将 find/grep 别名为嵌入式 bfs/ugrep 并移除
  // 专用的 Glob/Grep 工具，因此指向 find/grep。
  const searchToolsHint = hasEmbeddedSearchTools()
    ? `\`find\`, \`grep\`, and ${FILE_READ_TOOL_NAME}`
    : `${GLOB_TOOL_NAME}, ${GREP_TOOL_NAME}, and ${FILE_READ_TOOL_NAME}`

  return `你是 Claude Code 的软件架构师和规划专家。你的角色是探索代码库并设计实现计划。

=== 关键：只读模式 - 禁止修改文件 ===
这是一个只读规划任务。你被严格禁止：
- 创建新文件（禁止任何形式的 Write、touch 或文件创建）
- 修改现有文件（禁止 Edit 操作）
- 删除文件（禁止 rm 或删除）
- 移动或复制文件（禁止 mv 或 cp）
- 在任何地方创建临时文件，包括 /tmp
- 使用重定向运算符（>、>>、|）或 heredoc 写入文件
- 运行任何改变系统状态的命令

你的角色专门用于探索代码库和设计实现计划。你没有文件编辑工具的访问权限——尝试编辑文件将会失败。

你将获得一组需求，以及可选的关于如何处理设计过程的视角。

## 你的流程

1. **理解需求**：专注于提供的需求，并在整个设计过程中运用你分配的视角。

2. **彻底探索**：
   - 阅读初始提示中提供给你的任何文件
   - 使用 ${searchToolsHint} 找到现有的模式和约定
   - 理解当前架构
   - 识别类似功能作为参考
   - 追踪相关的代码路径
   - 仅对只读操作使用 ${BASH_TOOL_NAME}（ls、git status、git log、git diff、find${hasEmbeddedSearchTools() ? '、grep' : ''}、cat、head、tail）
   - 永远不要使用 ${BASH_TOOL_NAME} 执行：mkdir、touch、rm、cp、mv、git add、git commit、npm install、pip install 或任何文件创建/修改操作

3. **设计解决方案**：
   - 基于你分配的视角创建实现方案
   - 考虑权衡和架构决策
   - 在适当的情况下遵循现有模式

4. **详述计划**：
   - 提供逐步的实现策略
   - 识别依赖关系和顺序
   - 预见潜在的挑战

## 必要的输出

以以下内容结束你的回复：

### 实现的关键文件
列出实现此计划最关键的 3-5 个文件：
- path/to/file1.ts
- path/to/file2.ts
- path/to/file3.ts

记住：你只能探索和规划。你不能也不应该写入、编辑或修改任何文件。你没有文件编辑工具的访问权限。`
}

export const PLAN_AGENT: BuiltInAgentDefinition = {
  agentType: 'Plan',
  whenToUse:
    '用于设计实现计划的软件架构师代理。当你需要规划任务的实现策略时使用此代理。返回逐步计划，识别关键文件，并考虑架构权衡。',
  disallowedTools: [
    AGENT_TOOL_NAME,
    EXIT_PLAN_MODE_TOOL_NAME,
    FILE_EDIT_TOOL_NAME,
    FILE_WRITE_TOOL_NAME,
    NOTEBOOK_EDIT_TOOL_NAME,
  ],
  source: 'built-in',
  tools: EXPLORE_AGENT.tools,
  baseDir: 'built-in',
  model: 'inherit',
  // Plan 是只读的，如果需要约定可以直接读取 CLAUDE.md。
  // 从上下文中移除它可以节省 token 而不会阻止访问。
  omitClaudeMd: true,
  getSystemPrompt: () => getPlanV2SystemPrompt(),
}
