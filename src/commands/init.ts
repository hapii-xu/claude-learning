import { feature } from 'bun:bundle'
import type { Command } from '../commands.js'
import { maybeMarkProjectOnboardingComplete } from '../projectOnboardingState.js'
import { AUTONOMY_AGENTS_PATH_POSIX } from '../utils/autonomyAuthority.js'
import { isEnvTruthy } from '../utils/envUtils.js'

const OLD_INIT_PROMPT = `请分析这个代码库并创建一个 CLAUDE.md 文件，它将提供给未来的 Claude Code 实例，用于在本仓库中工作。

需要添加的内容：
1. 常用命令，例如如何 build、lint 和运行 tests。包含在本代码库中开发所需的命令，例如如何运行单个 test。
2. 高层次的代码架构与结构，以便未来的实例能更快上手。重点关注那些需要阅读多个文件才能理解的"big picture"架构。

使用说明：
- 如果已经存在 CLAUDE.md，请对它提出改进建议。
- 创建初始 CLAUDE.md 时，不要重复啰嗦，也不要包含显而易见的指令，例如"为用户提供有用的错误信息"、"为所有新工具编写单元测试"、"绝不在代码或提交中包含敏感信息（API keys、tokens）"。
- 避免罗列每一个组件或可以轻易发现的文件结构。
- 不要包含通用的开发实践。
- 如果存在 Cursor 规则（在 .cursor/rules/ 或 .cursorrules 中）或 Copilot 规则（在 .github/copilot-instructions.md 中），务必包含其中重要的部分。
- 如果存在 README.md，务必包含其中重要的部分。
- 不要编造诸如"Common Development Tasks"、"Tips for Development"、"Support and Documentation"之类的内容，除非你读到的其他文件中明确包含了这些信息。
- 务必在文件开头加上以下文字：

\`\`\`
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
\`\`\``

const NEW_INIT_PROMPT = `为这个仓库设置一个精简的 CLAUDE.md（以及可选的 skills 和 hooks）。CLAUDE.md 会被加载进每一个 Claude Code 会话，所以它必须简洁 —— 只包含 Claude 如果没有它就会弄错的内容。

## 阶段 1：询问要设置什么

使用 AskUserQuestion 弄清楚用户想要什么：

- "Which CLAUDE.md files should /init set up?"
  选项："Project CLAUDE.md" | "Personal CLAUDE.local.md" | "Both project + personal"
  project 的描述："团队共享、纳入版本控制的指令 —— 架构、编码规范、常见工作流。"
  personal 的描述："你对本项目的私有偏好（被 gitignore、不共享）—— 你的角色、sandbox URLs、偏好的测试数据、工作流怪癖。"

- "Also set up skills and hooks?"
  选项："Skills + hooks" | "Skills only" | "Hooks only" | "Neither, just CLAUDE.md"
  skills 的描述："你或 Claude 用 \`/skill-name\` 按需调用的能力 —— 适合可复用工作流和参考知识。"
  hooks 的描述："在工具事件上运行的确定性 shell 命令（例如每次编辑后格式化）。Claude 无法跳过它们。"

## 阶段 2：探索代码库

启动一个 subagent 来勘察代码库，让它阅读关键文件以理解项目：manifest 文件（package.json、Cargo.toml、pyproject.toml、go.mod、pom.xml 等）、README、Makefile/build 配置、CI 配置、已有的 CLAUDE.md、.hclaude/rules/、${AUTONOMY_AGENTS_PATH_POSIX}、.cursor/rules 或 .cursorrules、.github/copilot-instructions.md、.windsurfrules、.clinerules、.mcp.json。

检测：
- Build、test 和 lint 命令（尤其是非标准的）
- 语言、框架和包管理器
- 项目结构（带 workspaces 的 monorepo、多模块、或单一项目）
- 与语言默认值不同的代码风格规则
- 不显而易见的坑、必需的环境变量或工作流怪癖
- 已有的 .hclaude/skills/ 和 .hclaude/rules/ 目录
- Formatter 配置（prettier、biome、ruff、black、gofmt、rustfmt，或像 \`npm run format\` / \`make fmt\` 这样的统一 format 脚本）
- Git worktree 使用情况：运行 \`git worktree list\` 检查本仓库是否有多个 worktree（仅当用户想要个人 CLAUDE.local.md 时才相关）

记下那些仅凭代码无法弄清楚的内容 —— 它们会成为访谈问题。

## 阶段 3：补齐空白

使用 AskUserQuestion 收集你写好 CLAUDE.md 文件和 skills 还缺少的信息。只问代码无法回答的问题。

如果用户选择了 project CLAUDE.md 或两者都选：询问代码库实践 —— 不显而易见的命令、坑、branch/PR 约定、必需的环境配置、测试怪癖。跳过 README 中已有或从 manifest 文件显而易见的内容。不要把任何选项标记为"recommended" —— 这是关于他们团队如何工作，而非最佳实践。

如果用户选择了 personal CLAUDE.local.md 或两者都选：询问关于他们本人的事，而非代码库。不要把任何选项标记为"recommended" —— 这是关于他们的个人偏好，而非最佳实践。问题示例：
  - 他们在团队中的角色是什么？（例如"backend engineer"、"data scientist"、"new hire onboarding"）
  - 他们对这个代码库及其语言/框架有多熟悉？（以便 Claude 校准解释的深度）
  - 他们是否有 Claude 应当知道的个人 sandbox URLs、测试账号、API key 路径或本地配置细节？
  - 仅当阶段 2 发现了多个 git worktree 时：询问他们的 worktree 是嵌套在主仓库内部（例如 \`.hclaude/worktrees/<name>/\`）还是兄弟/外部目录（例如 \`../myrepo-feature/\`）。如果是嵌套的，向上的文件查找会自动找到主仓库的 CLAUDE.local.md —— 无需特殊处理。如果是兄弟/外部目录，个人内容应放在 home 目录下的文件中（例如 \`~/.hclaude/<project-name>-instructions.md\`），每个 worktree 放一个一行的 CLAUDE.local.md 桩文件来导入它：\`@~/.hclaude/<project-name>-instructions.md\`。绝不要把这个 import 放进项目的 CLAUDE.md —— 那会把个人引用提交进团队共享文件。
  - 任何沟通偏好？（例如"be terse"、"always explain tradeoffs"、"don't summarize at the end"）

**从阶段 2 的发现综合出一个提案** —— 例如，如果存在 formatter 就用 format-on-edit，如果存在 tests 就用 \`/verify\` skill，对补齐答案中属于准则（而非工作流）的内容用一条 CLAUDE.md note。对每一项，挑选合适的产物类型，**受阶段 1 的 skills+hooks 选择约束**：

  - **Hook**（更严格）—— 在工具事件上运行的确定性 shell 命令；Claude 无法跳过。适合机械、快速、按编辑触发的步骤：格式化、lint、对改动的文件跑一个快速 test。
  - **Skill**（按需）—— 你或 Claude 想用时用 \`/skill-name\` 调用。适合不该在每次编辑都触发的工作流：深度验证、会话报告、部署。
  - **CLAUDE.md note**（更宽松）—— 影响 Claude 的行为但不强制执行。适合沟通/思考偏好："plan before coding"、"be terse"、"explain tradeoffs"。

  **把阶段 1 的 skills+hooks 选择当作硬性过滤器**：如果用户选了"Skills only"，把你想建议的任何 hook 降级为 skill 或 CLAUDE.md note。如果选了"Hooks only"，把 skills 降级为 hooks（在机制上可行时）或 notes。如果选了"Neither"，一切都变成 CLAUDE.md note。绝不要提议用户没有选择的产物类型。

**通过 AskUserQuestion 的 \`preview\` 字段展示提案，而不是用单独的文本消息** —— 该对话框会覆盖在你的输出之上，所以前面的文字会被遮住。\`preview\` 字段会以 markdown 渲染在侧栏（类似 plan mode）；\`question\` 字段只支持纯文本。按如下方式组织：

  - \`question\`：简短朴素，例如 "Does this proposal look right?"
  - 每个选项配一个 \`preview\`，以 markdown 给出完整提案。"Looks good — proceed" 选项的 preview 展示全部内容；逐项删除选项的 preview 展示删除该项后剩下的内容。
  - **保持 preview 紧凑 —— preview 框会截断且不能滚动。** 每项一行，项与项之间不留空行，无标题。preview 内容示例：

    • **Format-on-edit hook** (automatic) — \`ruff format <file>\` via PostToolUse
    • **/verify skill** (on-demand) — \`make lint && make typecheck && make test\`
    • **CLAUDE.md note** (guideline) — "run lint/typecheck/test before marking done"

  - 选项标签保持简短（"Looks good"、"Drop the hook"、"Drop the skill"）—— 该工具会自动添加一个"Other"自由文本选项，所以不要自己再加兜底项。

**从被采纳的提案构建偏好队列**。每个条目：{type: hook|skill|note, description, target file, 以及任何来自阶段 2 的细节，比如实际的 test/format 命令}。阶段 4-7 会消费这个队列。

## 阶段 4：编写 CLAUDE.md（如果用户选了 project 或两者都选）

在项目根目录写一个精简的 CLAUDE.md。每一行都必须通过这个测试："删掉这行会不会导致 Claude 出错？"如果不会，就删掉。

**消费阶段 3 偏好队列中目标为 CLAUDE.md 的 \`note\` 条目**（团队级 notes）—— 把每条作为简洁的一行加入最相关的章节。这些是用户希望 Claude 遵循、但不需要强制保证的行为（例如 "propose a plan before implementing"、"explain the tradeoffs when refactoring"）。把面向个人的 notes 留到阶段 5。

包含：
- Claude 猜不到的 build/test/lint 命令（非标准脚本、flags 或步骤序列）
- 与语言默认值**不同**的代码风格规则（例如 "prefer type over interface"）
- 测试说明和怪癖（例如 "run single test with: pytest -k 'test_name'"）
- 仓库礼仪（branch 命名、PR 约定、commit 风格）
- 必需的环境变量或配置步骤
- 不显而易见的坑或架构决策
- 已有 AI 编码工具配置中的重要部分（如果存在）（${AUTONOMY_AGENTS_PATH_POSIX}、.cursor/rules、.cursorrules、.github/copilot-instructions.md、.windsurfrules、.clinerules）

排除：
- 逐个文件的结构或组件清单（Claude 可以通过阅读代码库自行发现）
- Claude 已经知道的标准语言约定
- 通用建议（"write clean code"、"handle errors"）
- 详细的 API 文档或长篇参考 —— 改用 \`@path/to/import\` 语法（例如 \`@docs/api-reference.md\`），按需内联内容而不让 CLAUDE.md 臃肿
- 频繁变化的信息 —— 用 \`@path/to/import\` 引用源文件，让 Claude 总是读到最新版本
- 长篇教程或操作指南（移到单独的文件并用 \`@path/to/import\` 引用，或放进一个 skill）
- 从 manifest 文件就显而易见的命令（例如标准的 "npm test"、"cargo test"、"pytest"）

要具体："Use 2-space indentation in TypeScript" 比 "Format code properly" 更好。

不要重复啰嗦，也不要编造像 "Common Development Tasks" 或 "Tips for Development" 这样的章节 —— 只包含你读到的文件中明确存在的信息。

在文件开头加上：

\`\`\`
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
\`\`\`

如果 CLAUDE.md 已存在：读取它，以 diff 形式提出具体改动，并解释每处改动为何更好。不要静默覆盖。

对于涉及多个关注点的项目，建议把指令组织进 \`.hclaude/rules/\` 中作为独立的聚焦文件（例如 \`code-style.md\`、\`testing.md\`、\`security.md\`）。这些文件会随 CLAUDE.md 自动加载，并可用 \`paths\` frontmatter 限定到特定文件路径。

对于有明显子目录的项目（monorepos、多模块项目等）：提及可以为模块级指令添加子目录 CLAUDE.md 文件（当 Claude 在这些目录中工作时会自动加载）。如果用户需要，主动提议创建它们。

## 阶段 5：编写 CLAUDE.local.md（如果用户选了 personal 或两者都选）

在项目根目录写一个精简的 CLAUDE.local.md。这个文件会随 CLAUDE.md 自动加载。创建后，把 \`CLAUDE.local.md\` 加入项目的 .gitignore 以保持私有。

**消费阶段 3 偏好队列中目标为 CLAUDE.local.md 的 \`note\` 条目**（个人级 notes）—— 把每条作为简洁的一行加入。如果用户在阶段 1 选了仅 personal，那么这里是 note 条目的唯一消费方。

包含：
- 用户的角色及其对代码库的熟悉程度（以便 Claude 校准解释）
- 个人 sandbox URLs、测试账号或本地配置细节
- 个人工作流或沟通偏好

保持简短 —— 只包含能让 Claude 对这位用户的回答明显更好的内容。

如果阶段 2 发现了多个 git worktree，且用户确认他们使用兄弟/外部 worktree（不是嵌套在主仓库内部）：向上的文件查找无法从所有 worktree 找到同一个 CLAUDE.local.md。把实际的个人内容写到 \`~/.hclaude/<project-name>-instructions.md\`，并让 CLAUDE.local.md 成为一行的桩文件来导入它：\`@~/.hclaude/<project-name>-instructions.md\`。用户可以把这个一行桩文件复制到每个兄弟 worktree。绝不要把这个 import 放进项目的 CLAUDE.md。如果 worktree 是嵌套在主仓库内部（例如 \`.hclaude/worktrees/\`），无需特殊处理 —— 主仓库的 CLAUDE.local.md 会被自动找到。

如果 CLAUDE.local.md 已存在：读取它，提出具体的补充，且不要静默覆盖。

## 阶段 6：建议并创建 skills（如果用户选了 "Skills + hooks" 或 "Skills only"）

Skills 为 Claude 增加可按需使用的能力，而不会让每个会话臃肿。

**首先，消费阶段 3 偏好队列中的 \`skill\` 条目。** 每个排队的 skill 偏好都变成一个针对用户描述定制的 SKILL.md。对每一个：
- 根据偏好命名（例如 "verify-deep"、"session-report"、"deploy-sandbox"）
- 用用户在访谈中的原话加上阶段 2 的发现（test 命令、报告格式、部署目标）来编写正文。如果这个偏好对应一个已内置的 skill（例如 \`/verify\`），就写一个项目 skill 在其之上叠加用户的具体约束 —— 告诉用户内置的那个仍然存在，他们的是附加的。
- 如果偏好不够明确，快速追问一句（例如 "which test command should verify-deep run?"）

**然后建议额外的 skills**，当你发现以下情况时（超出队列范围）：
- 特定任务的参考知识（某子系统的约定、模式、风格指南）
- 用户想直接触发的可复用工作流（部署、修复 issue、发布流程、验证改动）

对每个建议的 skill，给出：名称、一句话用途、以及为何适合这个仓库。

如果 \`.hclaude/skills/\` 已存在且已有 skills，先审阅它们。不要覆盖已有 skills —— 只提议能与已有内容互补的新 skill。

在 \`.hclaude/skills/<skill-name>/SKILL.md\` 创建每个 skill：

\`\`\`yaml
---
name: <skill-name>
description: <what the skill does and when to use it>
---

<Instructions for Claude>
\`\`\`

默认情况下用户（\`/<skill-name>\`）和 Claude 都可以调用 skills。对于有副作用的工作流（例如 \`/deploy\`、\`/fix-issue 123\`），添加 \`disable-model-invocation: true\` 使其只能由用户触发，并用 \`$ARGUMENTS\` 来接收输入。

## 阶段 7：建议额外的优化

告诉用户，既然 CLAUDE.md 和 skills（如果选了的话）已就位，你将再建议几项额外的优化。

检查环境，并针对你发现的每个空白进行询问（使用 AskUserQuestion）：

- **GitHub CLI**：运行 \`which gh\`（在 Windows 上是 \`where gh\`）。如果它缺失**且**项目使用 GitHub（检查 \`git remote -v\` 是否含 github.com），询问用户是否想安装它。说明 GitHub CLI 让 Claude 能直接帮助处理 commits、pull requests、issues 和 code review。

- **Linting**：如果阶段 2 没发现 lint 配置（针对项目语言没有 .eslintrc、ruff.toml、.golangci.yml 等），询问用户是否想让 Claude 为这个代码库设置 linting。说明 linting 能尽早发现问题，并为 Claude 自己的编辑提供快速反馈。

- **来自提案的 hooks**（如果用户选了 "Skills + hooks" 或 "Hooks only"）：消费阶段 3 偏好队列中的 \`hook\` 条目。如果阶段 2 发现了 formatter 而队列里没有格式化 hook，就把 format-on-edit 作为兜底提供。如果用户在阶段 1 选了 "Neither" 或 "Skills only"，则完全跳过这一条。

  对每个 hook 偏好（来自队列或 formatter 兜底）：

  1. 目标文件：根据阶段 1 的 CLAUDE.md 选择确定默认值 —— project → \`.hclaude/settings.json\`（团队共享、提交进库）；personal → \`.hclaude/settings.local.json\`。仅当用户在阶段 1 选了"both"或偏好含糊时才询问。对所有 hooks 一次性询问，而非逐个询问。

  2. 从偏好中挑选 event 和 matcher：
     - "after every edit" → \`PostToolUse\`，matcher 为 \`Write|Edit\`
     - "when Claude finishes" / "before I review" → \`Stop\` 事件（在每个回合结束时触发 —— 包括只读回合）
     - "before running bash" → \`PreToolUse\`，matcher 为 \`Bash\`
     - "before committing"（字面意义的 git-commit 关卡）→ **这不是 hooks.json hook。** Matcher 无法按命令内容过滤 Bash，所以没办法只针对 \`git commit\`。改为路由到 git pre-commit hook（\`.git/hooks/pre-commit\`、husky、pre-commit framework）—— 主动提议写一个。如果用户实际意思是"在我审阅并提交 Claude 的输出之前"，那是 \`Stop\` —— 追问以消除歧义。
     如果偏好含糊就追问。

  3. **加载 hook 参考**（每次 \`/init\` 运行一次，在第一个 hook 之前）：调用 Skill 工具，\`skill: 'update-config'\`，args 以 \`[hooks-only]\` 开头，后跟一行你正在构建什么的摘要 —— 例如 \`[hooks-only] Constructing a PostToolUse/Write|Edit format hook for .hclaude/settings.json using ruff\`。这会把 hooks 的 schema 和验证流程加载进上下文。后续的 hooks 复用它 —— 不要重复调用。

  4. 遵循该 skill 的 **"Constructing a Hook"** 流程：dedup 检查 → 为**本**项目构建 → 原始 pipe-test → 包装 → 写入 JSON → \`jq -e\` 校验 → live-proof（针对可触发 matcher 上的 \`Pre|PostToolUse\`）→ 清理 → 交接。目标文件和 event/matcher 来自上面的步骤 1–2。

每个"yes"都要先落实再继续。

## 阶段 8：总结与后续步骤

回顾设置了什么 —— 写了哪些文件，以及每个文件包含的要点。提醒用户这些文件只是起点：他们应当审阅并调整，并且随时可以再次运行 \`/init\` 重新扫描。

然后告诉用户，你将基于你的发现再提出几项优化其代码库和 Claude Code 配置的建议。把它们以单个、排版良好的待办列表呈现，其中每一项都与这个仓库相关。把最有影响力的项放在最前面。

构建这个列表时，逐一过一遍以下检查，只包含适用的项：
- 如果检测到前端代码（React、Vue、Svelte 等）：\`/plugin install frontend-design@claude-plugins-official\` 给 Claude 提供设计原则和组件模式，让它产出精致的 UI；\`/plugin install playwright@claude-plugins-official\` 让 Claude 能启动真实浏览器、对它构建的东西截图，并自行修复视觉 bug。
- 如果你在阶段 7 发现了空白（缺少 GitHub CLI、缺少 linting）而用户说不要：在这里列出它们，并各用一行说明为何有帮助。
- 如果 tests 缺失或稀少：建议设置一个 test 框架，让 Claude 能验证自己的改动。
- 为帮你用 evals 创建和优化已有 skills，Claude Code 有一个官方 skill-creator plugin 可以安装。用 \`/plugin install skill-creator@claude-plugins-official\` 安装它，然后运行 \`/skill-creator <skill-name>\` 创建新 skill 或优化任何已有 skill。（这一项总是包含。）
- 用 \`/plugin\` 浏览官方 plugins —— 它们打包了 skills、agents、hooks 和 MCP servers，你可能会用得上。你也可以创建自己的自定义 plugins 并分享给他人。（这一项总是包含。）`

const command = {
  type: 'prompt',
  name: 'init',
  get description() {
    return feature('NEW_INIT') &&
      (process.env.USER_TYPE === 'ant' ||
        isEnvTruthy(process.env.CLAUDE_CODE_NEW_INIT))
      ? '初始化新的 CLAUDE.md 文件以及可选的 skills/hooks，并附带代码库文档'
      : '初始化一个带有代码库文档的新 CLAUDE.md 文件'
  },
  contentLength: 0, // 动态内容
  progressMessage: 'analyzing your codebase',
  source: 'builtin',
  async getPromptForCommand() {
    maybeMarkProjectOnboardingComplete()

    return [
      {
        type: 'text',
        text:
          feature('NEW_INIT') &&
          (process.env.USER_TYPE === 'ant' ||
            isEnvTruthy(process.env.CLAUDE_CODE_NEW_INIT))
            ? NEW_INIT_PROMPT
            : OLD_INIT_PROMPT,
      },
    ]
  },
} satisfies Command

export default command
