import { AGENT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/AgentTool/constants.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/AskUserQuestionTool/prompt.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/EnterPlanModeTool/constants.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/ExitPlanModeTool/constants.js'
import { SKILL_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/SkillTool/constants.js'
import { getIsGit } from '../../utils/git.js'
import { registerBundledSkill } from '../bundledSkills.js'

const MIN_AGENTS = 5
const MAX_AGENTS = 30

const WORKER_INSTRUCTIONS = `完成变更实现后：
1. **简化** — 使用 \`${SKILL_TOOL_NAME}\` 工具并传入 \`skill: "simplify"\` 来审查并清理你的改动。
2. **运行单元测试** — 运行项目的测试套件（查看 package.json scripts、Makefile targets，或常用命令如 \`npm test\`、\`bun test\`、\`pytest\`、\`go test\`）。如果测试失败，请修复。
3. **端到端测试** — 按照协调器提示中的端到端测试步骤操作（见下方）。如果步骤中说跳过该单元的端到端测试，则跳过。
4. **提交并推送** — 以清晰的提交信息提交所有变更，推送分支，并使用 \`gh pr create\` 创建 PR。使用描述性标题。如果 \`gh\` 不可用或推送失败，请在最终消息中注明。
5. **汇报** — 以单行结尾：\`PR: <url>\`，供协调器跟踪。如果未创建 PR，以 \`PR: none — <原因>\` 结尾。`

function buildPrompt(instruction: string): string {
  return `# Batch：并行任务编排

你正在跨代码库编排一个大规模、可并行的变更。

## 用户指令

${instruction}

## 第一阶段：研究与规划（Plan Mode）

立即调用 \`${ENTER_PLAN_MODE_TOOL_NAME}\` 工具进入 plan mode，然后：

1. **了解范围。** 启动一个或多个前台子代理（你需要它们的结果）深入研究此指令涉及的内容。找出所有需要变更的文件、模式和调用点。理解现有规范，确保迁移一致。

2. **分解为独立单元。** 将工作拆分为 ${MIN_AGENTS}–${MAX_AGENTS} 个自包含单元。每个单元必须：
   - 可以在隔离的 git worktree 中独立实现（与兄弟单元之间无共享状态）
   - 可以独立合并，不依赖其他单元的 PR 先合入
   - 规模大致均匀（拆分大单元，合并琐碎单元）

   根据实际工作量调整数量：文件少 → 接近 ${MIN_AGENTS}；文件数百 → 接近 ${MAX_AGENTS}。优先按目录或模块划分，而非任意文件列表。

3. **确定端到端测试方案。** 弄清楚 worker 如何验证其变更确实端到端可用——不仅仅是单元测试通过。寻找：
   - \`claude-in-chrome\` 技能或浏览器自动化工具（用于 UI 变更：点击受影响的流程，截图结果）
   - \`tmux\` 或 CLI 验证技能（用于 CLI 变更：交互式启动应用，验证变更行为）
   - 开发服务器 + curl 模式（用于 API 变更：启动服务器，命中受影响的端点）
   - 现有的 e2e/集成测试套件供 worker 运行

   如果找不到具体的端到端路径，使用 \`${ASK_USER_QUESTION_TOOL_NAME}\` 工具询问用户如何端到端验证此变更。根据你找到的内容提供 2–3 个具体选项（例如，"通过 Chrome 扩展截图"、"运行 \`bun run dev\` 并 curl 端点"、"不需要端到端——单元测试已足够"）。不要跳过此步骤——workers 自己无法询问用户。

   将方案写成一组简短具体的步骤，供 worker 自主执行。包含任何设置步骤（启动开发服务器、先构建）以及用于验证的精确命令/操作。

4. **撰写计划。** 在计划文件中包含：
   - 研究过程中发现内容的摘要
   - 工作单元的编号列表——每项包含：简短标题、涵盖的文件/目录列表、一行变更描述
   - 端到端测试方案（或"跳过端到端，原因是……"（如果用户选择跳过））
   - 你将给每个代理的精确 worker 指令（共享模板）

5. 调用 \`${EXIT_PLAN_MODE_TOOL_NAME}\` 提交计划以供审批。

## 第二阶段：启动 Workers（计划审批后）

计划审批后，使用 \`${AGENT_TOOL_NAME}\` 工具为每个工作单元启动一个后台代理。**所有代理必须使用 \`isolation: "worktree"\` 和 \`run_in_background: true\`。** 在一条消息块中全部启动，使其并行运行。

每个代理的提示必须完全自包含。包含：
- 总体目标（用户指令）
- 该单元的具体任务（标题、文件列表、变更描述——从计划中原文复制）
- 你发现的 worker 需要遵循的代码库规范
- 计划中的端到端测试方案（或"跳过端到端，原因是……"）
- 以下 worker 指令，原文复制：

\`\`\`
${WORKER_INSTRUCTIONS}
\`\`\`

使用 \`subagent_type: "general-purpose"\`，除非更具体的代理类型更合适。

## 第三阶段：跟踪进度

启动所有 workers 后，渲染初始状态表：

| # | 单元 | 状态 | PR |
|---|------|------|----|
| 1 | <title> | 运行中 | — |
| 2 | <title> | 运行中 | — |

随着后台代理完成通知到达，从每个代理的结果中解析 \`PR: <url>\` 行，并更新状态（\`完成\` / \`失败\`）和 PR 链接。对未生成 PR 的代理保留简短失败说明。

所有代理汇报完毕后，渲染最终状态表和一行摘要（例如："22/24 个单元已落地为 PR"）。
`
}

const NOT_A_GIT_REPO_MESSAGE = `这不是一个 git 仓库。\`/batch\` 命令需要 git 仓库，因为它会在隔离的 git worktrees 中启动代理并为每个代理创建 PR。请先初始化一个仓库，或在现有仓库内运行此命令。`

const MISSING_INSTRUCTION_MESSAGE = `请提供一条指令，描述你想要进行的批量变更。

示例：
  /batch migrate from react to vue
  /batch replace all uses of lodash with native equivalents
  /batch add type annotations to all untyped function parameters`

export function registerBatchSkill(): void {
  registerBundledSkill({
    name: 'batch',
    description:
      '研究并规划大规模变更，然后在 5–30 个隔离的 worktree 代理中并行执行，每个代理都会创建一个 PR。',
    whenToUse:
      '当用户想要跨多个文件进行大范围、机械性变更（迁移、重构、批量重命名）且可分解为独立并行单元时使用。',
    argumentHint: '<instruction>',
    userInvocable: true,
    disableModelInvocation: true,
    async getPromptForCommand(args) {
      const instruction = args.trim()
      if (!instruction) {
        return [{ type: 'text', text: MISSING_INSTRUCTION_MESSAGE }]
      }

      const isGit = await getIsGit()
      if (!isGit) {
        return [{ type: 'text', text: NOT_A_GIT_REPO_MESSAGE }]
      }

      return [{ type: 'text', text: buildPrompt(instruction) }]
    },
  })
}
