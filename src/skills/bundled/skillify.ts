import { getSessionMemoryContent } from '../../services/SessionMemory/sessionMemoryUtils.js'
import type { Message } from '../../types/message.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import { registerBundledSkill } from '../bundledSkills.js'

function extractUserMessages(messages: Message[]): string[] {
  return messages
    .filter(m => m.type === 'user')
    .map(m => {
      const content = m.message?.content
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      return content
        .filter(
          (b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text',
        )
        .map(b => b.text)
        .join('\n')
    })
    .filter(text => text.trim().length > 0)
}

const SKILLIFY_PROMPT = `# Skillify {{userDescriptionBlock}}

你正在将本次会话的可复用流程捕获为一个技能。

## 你的会话上下文

以下是会话记忆摘要：
<session_memory>
{{sessionMemory}}
</session_memory>

以下是用户在本次会话中的消息。请留意用户如何引导流程，以便在技能中捕获他们的详细偏好：
<user_messages>
{{userMessages}}
</user_messages>

## 你的任务

### 第一步：分析会话

在提问之前，先分析会话，识别：
- 执行了哪个可复用的流程
- 输入/参数是什么
- 各个步骤（按顺序）
- 每个步骤的成功产物/标准（例如，不只是"写代码"，而是"一个 CI 全部通过的已开启 PR"）
- 用户在哪里纠正或引导了你
- 需要哪些工具和权限
- 使用了哪些 agent
- 目标和成功产物是什么

### 第二步：访谈用户

你将使用 AskUserQuestion 来了解用户想自动化的内容。重要提示：
- 所有问题都使用 AskUserQuestion！不要用纯文本提问。
- 每轮根据需要反复迭代，直到用户满意为止。
- 用户始终有自由输入的"其他"选项可供填写意见或反馈——不要自行添加"需要调整"或"我来提供修改"选项，只提供实质性选择。

**第一轮：高层确认**
- 根据你的分析，建议一个技能名称和描述。询问用户是否确认或重命名。
- 建议技能的高层目标和具体成功标准。

**第二轮：更多细节**
- 将你识别出的高层步骤以编号列表的形式呈现。告诉用户你将在下一轮深入细节。
- 如果你认为该技能需要参数，请根据观察到的内容建议参数。确保你理解使用者需要提供什么。
- 如果不清楚，询问该技能应内联运行（在当前对话中）还是分叉运行（作为拥有独立上下文的子 agent）。分叉更适合不需要用户中途输入的自包含任务；内联更适合用户希望中途引导流程的情况。
- 询问技能应保存在哪里。根据上下文建议默认位置（仓库特定工作流 → 仓库，跨仓库个人工作流 → 用户）。选项：
  - **本仓库** (\`.claude/skills/<name>/SKILL.md\`) — 适用于特定项目的工作流
  - **个人** (\`~/.claude/skills/<name>/SKILL.md\`) — 跨所有仓库跟随你

**第三轮：拆解每个步骤**
对于每个主要步骤，如果不是显而易见的，请询问：
- 这个步骤产生了后续步骤需要的什么？（数据、产物、ID）
- 什么能证明这个步骤成功，可以继续下一步？
- 是否应该在继续前请用户确认？（尤其是不可逆操作，如合并、发消息或破坏性操作）
- 哪些步骤是独立的，可以并行运行？（例如，同时发布到 Slack 和监控 CI）
- 技能应如何执行？（例如，始终使用 Task agent 执行代码审查，或调用 agent 团队并发执行一组步骤）
- 有哪些硬性约束或强制偏好？哪些事情必须或不能发生？

如果步骤超过 3 个或有很多澄清问题，可以在此处进行多轮 AskUserQuestion，每步一轮。根据需要迭代。

重要：特别注意用户在会话中纠正你的地方，以帮助指导你的设计。

**第四轮：最终问题**
- 确认何时应调用该技能，并建议/确认触发短语。（例如，对于 cherrypick 工作流，可以说：当用户想将 PR cherry-pick 到发布分支时使用。示例：'cherry-pick to release'、'CP this PR'、'hotfix'。）
- 如有尚不清楚的注意事项或需要关注的事项，也可以询问。

获得足够信息后停止访谈。重要：对简单流程不要过度询问！

### 第三步：编写 SKILL.md

在用户在第二轮选择的位置创建技能目录和文件。

使用以下格式：

\`\`\`markdown
---
name: {{skill-name}}
description: {{one-line description}}
allowed-tools:
  {{list of tool permission patterns observed during session}}
when_to_use: {{detailed description of when Claude should automatically invoke this skill, including trigger phrases and example user messages}}
argument-hint: "{{hint showing argument placeholders}}"
arguments:
  {{list of argument names}}
context: {{inline or fork -- omit for inline}}
---

# {{Skill Title}}
Description of skill

## Inputs
- \`$arg_name\`: Description of this input

## Goal
Clearly stated goal for this workflow. Best if you have clearly defined artifacts or criteria for completion.

## Steps

### 1. Step Name
What to do in this step. Be specific and actionable. Include commands when appropriate.

**Success criteria**: ALWAYS include this! This shows that the step is done and we can move on. Can be a list.

IMPORTANT: see the next section below for the per-step annotations you can optionally include for each step.

...
\`\`\`

**每步注解说明**：
- **成功标准（Success criteria）** 每个步骤都必须填写。这帮助模型理解用户对工作流的期望，以及何时可以有把握地继续。
- **执行方式（Execution）**：\`Direct\`（默认）、\`Task agent\`（直接子 agent）、\`Teammate\`（具有真正并行性和 agent 间通信的 agent），或 \`[human]\`（用户执行）。非 Direct 时才需要指定。
- **产物（Artifacts）**：此步骤产生的后续步骤需要的数据（例如 PR 编号、commit SHA）。只在后续步骤依赖时填写。
- **人工检查点（Human checkpoint）**：在继续前暂停并询问用户的时机。适用于不可逆操作（合并、发消息）、错误判断（合并冲突）或输出审查。
- **规则（Rules）**：工作流的硬性规则。参考会话中用户的纠正往往最有用。

**步骤结构提示：**
- 可并发运行的步骤使用子编号：3a、3b
- 需要用户操作的步骤在标题中加 \`[human]\`
- 简单技能保持简洁——2 步技能不需要每步都加注解

**Frontmatter 规则：**
- \`allowed-tools\`：所需最小权限（使用模式如 \`Bash(gh:*)\` 而非 \`Bash\`）
- \`context\`：只对不需要用户中途输入的自包含技能设置 \`context: fork\`。
- \`when_to_use\` 至关重要——告诉模型何时自动调用。以"Use when..."开头并包含触发短语。示例："Use when the user wants to cherry-pick a PR to a release branch. Examples: 'cherry-pick to release', 'CP this PR', 'hotfix'."
- \`arguments\` 和 \`argument-hint\`：只在技能接受参数时填写。在正文中使用 \`$name\` 进行替换。

### 第四步：确认并保存

在写入文件之前，将完整的 SKILL.md 内容以 yaml 代码块的形式输出到你的回复中，供用户以正确的语法高亮方式查看。然后使用 AskUserQuestion 提出简单的确认问题，如"这个 SKILL.md 看起来可以保存吗？"——不要使用 body 字段，保持问题简洁。

写入后，告诉用户：
- 技能保存在哪里
- 如何调用：\`/{{skill-name}} [arguments]\`
- 他们可以直接编辑 SKILL.md 来进一步完善
`

export function registerSkillifySkill(): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  registerBundledSkill({
    name: 'skillify',
    description:
      "将本次会话的可复用流程捕获为一个技能。在想要捕获的流程结束时调用，可附带可选的描述。",
    allowedTools: [
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'AskUserQuestion',
      'Bash(mkdir:*)',
    ],
    userInvocable: true,
    disableModelInvocation: true,
    argumentHint: '[你想捕获的流程描述]',
    async getPromptForCommand(args, context) {
      const sessionMemory =
        (await getSessionMemoryContent()) ?? 'No session memory available.'
      const userMessages = extractUserMessages(
        getMessagesAfterCompactBoundary(context.messages),
      )

      const userDescriptionBlock = args
        ? `The user described this process as: "${args}"`
        : ''

      const prompt = SKILLIFY_PROMPT.replace('{{sessionMemory}}', sessionMemory)
        .replace('{{userMessages}}', userMessages.join('\n\n---\n\n'))
        .replace('{{userDescriptionBlock}}', userDescriptionBlock)

      return [{ type: 'text', text: prompt }]
    },
  })
}
