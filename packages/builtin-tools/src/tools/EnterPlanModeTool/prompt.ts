import { isPlanModeInterviewPhaseEnabled } from 'src/utils/planModeV2.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../AskUserQuestionTool/prompt.js'

const WHAT_HAPPENS_SECTION = `## Plan Mode 中会发生什么

进入 plan mode 后，你将：
1. 使用 Glob、Grep 和 Read 工具彻底探索代码库
2. 理解现有的代码模式和架构
3. 设计一个实现方案
4. 将你的计划呈现给用户以获得审批
5. 如需澄清实现方式，使用 ${ASK_USER_QUESTION_TOOL_NAME}
6. 准备好实现时，使用 ExitPlanMode 退出 plan mode

`

function getEnterPlanModeToolPromptExternal(): string {
  // 当 interview phase 启用时，省略 "What Happens" 段落——
  // 详细的 workflow 说明会通过 plan_mode 附件下发（见 messages.ts）。
  const whatHappens = isPlanModeInterviewPhaseEnabled()
    ? ''
    : WHAT_HAPPENS_SECTION

  return `在即将开始一个非简单的实现任务时，主动使用此工具。在写代码之前获得用户对方案的认可，可以避免无效工作并确保双方对齐。此工具将你切换到 plan mode，在其中你可以探索代码库并设计实现方案以供用户审批。

## 何时使用此工具

**优先使用 EnterPlanMode** 处理实现任务，除非任务非常简单。满足以下任意条件时使用：

1. **新功能实现** — 添加有意义的新功能，且实现路径并不明显
2. **多种有效方案** — 任务可以用几种不同方式解决
3. **代码修改** — 影响现有行为或结构的变更，用户应当审批实现方式
4. **架构决策** — 任务需要在不同模式或技术之间做选择
5. **多文件改动** — 任务可能涉及超过 2-3 个文件
6. **需求不明确** — 需要先探索才能理解完整范围
7. **用户偏好很重要** — 如果你原本会用 ${ASK_USER_QUESTION_TOOL_NAME} 来澄清方案，改用 EnterPlanMode

## 何时不使用此工具

仅对简单任务跳过 EnterPlanMode：
- 单行或少量行的修复（typo、明显 bug、小调整）
- 需求明确的单函数新增
- 用户已给出非常具体、详细指令的任务
- 纯研究/探索任务（改用带 explore agent 的 Agent 工具）

${whatHappens}## 重要说明

- 此工具需要用户审批——用户必须同意进入 plan mode
- 若不确定是否使用，倾向于先规划——提前对齐比事后返工要好
- 在对代码库进行重要修改前先征求用户意见，用户会很感激
`
}

function getEnterPlanModeToolPromptAnt(): string {
  // 当 interview phase 启用时，省略 "What Happens" 段落——
  // 详细的 workflow 说明会通过 plan_mode 附件下发（见 messages.ts）。
  const whatHappens = isPlanModeInterviewPhaseEnabled()
    ? ''
    : WHAT_HAPPENS_SECTION

  return `当任务对正确实现方式存在真正的歧义，且在编码前获取用户意见可以避免大量返工时，使用此工具。此工具将你切换到 plan mode，在其中你可以探索代码库并设计实现方案以供用户审批。

## 何时使用此工具

当实现方式确实不明确时，plan mode 才有价值。在以下情况使用：

1. **重大架构歧义** — 存在多种合理方案，且选择会对代码库产生实质性影响
2. **需求不明确** — 需要先探索和澄清才能推进
3. **高影响力重构** — 任务将显著重构现有代码，提前获得认可可降低风险

## 何时不使用此工具

当你能合理推断正确方案时，跳过 plan mode：
- 任务直接明了，即使涉及多个文件
- 用户请求足够具体，实现路径清晰
- 你在添加一个有明显实现模式的功能
- Bug 修复——理解 bug 后修复方法很明确
- 研究/探索任务（改用 Agent 工具）
- 用户说"我们能做 X 吗"或"来做 X 吧"之类的话——直接开始就好

有疑虑时，优先开始工作并用 ${ASK_USER_QUESTION_TOOL_NAME} 提问具体问题，而不是进入完整的规划阶段。

${whatHappens}## 重要说明

- 此工具需要用户审批——用户必须同意进入 plan mode
`
}

export function getEnterPlanModeToolPrompt(): string {
  return process.env.USER_TYPE === 'ant'
    ? getEnterPlanModeToolPromptAnt()
    : getEnterPlanModeToolPromptExternal()
}
