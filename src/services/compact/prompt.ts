import { feature } from 'bun:bundle'
import type { PartialCompactDirection } from '../../types/message.js'

// 死代码消除：proactive 模式的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? (require('../../proactive/index.js') as typeof import('../../proactive/index.js'))
    : null
/* eslint-enable @typescript-eslint/no-require-imports */

// 激进的不使用工具前言。缓存共享分叉路径继承父级的完整工具集
// （缓存键匹配所需），在 Sonnet 4.6+ 自适应思考模型上，模型有时
// 会忽略较弱的尾部指令而尝试工具调用。maxTurns: 1 时，被拒绝的
// 工具调用意味着无文本输出 → 回退到流式降级方案（4.6 上 2.79% vs
// 4.5 上 0.01%）。将其放在最前面并明确拒绝后果可防止浪费轮次。
const NO_TOOLS_PREAMBLE = `关键要求：仅用文本回复。不要调用任何工具。

- 不要使用 Read、Bash、Grep、Glob、Edit、Write 或任何其他工具。
- 你已经在上面的对话中拥有了所需的所有上下文。
- 工具调用将被拒绝，并浪费你唯一的轮次 — 你将因此无法完成任务。
- 你的完整回复必须是纯文本：一个 <analysis> 块后跟一个 <summary> 块。

`

// 两个变体：BASE 作用于"整个对话"，PARTIAL 作用于"最近的消息"。
// <analysis> 块是起草暂存区，formatCompactSummary() 在摘要到达
// 上下文之前将其剥离。
const DETAILED_ANALYSIS_INSTRUCTION_BASE = `在提供最终摘要之前，将你的分析包裹在 <analysis> 标签中以组织思路，并确保已覆盖所有必要要点。在你的分析过程中：

1. 按时间顺序分析对话的每条消息和每个部分。对于每个部分，彻底识别：
   - 用户的明确请求和意图
   - 你处理用户请求的方法
   - 关键决策、技术概念和代码模式
   - 具体细节，：
     - 文件名
     - 完整代码片段
     - 函数签名
     - 文件编辑
   - 你遇到的错误以及如何修复
   - 特别注意你收到的具体用户反馈，尤其是用户要求你以不同方式做事时
2. 仔细检查技术准确性和完整性，彻底处理每个所需元素。`

const DETAILED_ANALYSIS_INSTRUCTION_PARTIAL = `在提供最终摘要之前，将你的分析包裹在 <analysis> 标签中以组织思路，并确保已覆盖所有必要要点。在你的分析过程中：

1. 按时间顺序分析最近的消息。对于每个部分，彻底识别：
   - 用户的明确请求和意图
   - 你处理用户请求的方法
   - 关键决策、技术概念和代码模式
   - 具体细节如：
     - 文件名
     - 完整代码片段
     - 函数签名
     - 文件编辑
   - 你遇到的错误以及如何修复
   - 特别注意你收到的具体用户反馈，尤其是用户要求你以不同方式做事时
2. 仔细检查技术准确性和完整性，彻底处理每个所需元素。`

const BASE_COMPACT_PROMPT = `你的任务是创建到目前为止的对话的详细摘要，密切关注用户的明确请求和你之前的操作。
此摘要应彻底捕获技术细节、代码模式和架构决策，这些信息对于在不丢失上下文的情况下继续开发工作至关重要。

${DETAILED_ANALYSIS_INSTRUCTION_BASE}

你的摘要应包含以下部分：

1. 主要请求和意图：详细捕获用户所有的明确请求和意图
2. 关键技术概念：列出讨论过的所有重要技术概念、技术和框架
3. 文件和代码部分：列举检查、修改或创建的具体文件和代码部分。特别注意最近的消息，在适用时包含完整代码片段，并说明为什么此文件读取或编辑很重要
4. 错误和修复：列出你遇到的所有错误以及如何修复。特别注意你收到的具体用户反馈，尤其是用户要求你以不同方式做事时
5. 问题解决：记录已解决的问题和正在进行的故障排除工作
6. 所有用户消息：列出所有不是工具结果的用户消息。这些对于理解用户的反馈和变化的意图至关重要
7. 待处理任务：概述你被明确要求处理的任何待处理任务
8. 当前工作：详细描述在此摘要请求之前正在进行的工作，特别注意用户和助手最近的消息。在适用时包含文件名和代码片段
9. 可选的下一步：列出与你最近进行的工作相关的下一步。重要：确保这一步与用户最近的明确请求以及你在此摘要请求之前正在进行的任务直接一致。如果你的上一个任务已完成，则仅在它们与用户的请求明确一致时才列出下一步。不要在没有先与用户确认的情况下开始处理偏离主题的请求或已经完成很久的旧请求
                       如果有下一步，请包含最近对话中的直接引用，准确显示你正在进行什么任务以及在哪里停。这应该是逐字引用，以确保任务解释没有偏差

以下是你的输出应该如何组织结构的示例：

<example>
<analysis>
[你的思考过程，确保所有要点都被彻底且准确地覆盖]
</analysis>

<summary>
1. 主要请求和意图：
   [详细描述]

2. 关键技术概念：
   - [概念 1]
   - [概念 2]
   - [...]

3. 文件和代码部分：
   - [文件名 1]
      - [此文件为何重要的摘要]
      - [对此文件所做的更改摘要（如有）]
      - [重要代码片段]
   - [文件名 2]
      - [重要代码片段]
   - [...]

4. 错误和修复：
    - [错误 1 的详细描述]：
      - [你如何修复错误]
      - [用户对此错误的反馈（如有）]
    - [...]

5. 问题解决：
   [已解决问题的描述和正在进行的故障排除]

6. 所有用户消息：
    - [详细的非工具使用用户消息]
    - [...]

7. 待处理任务：
   - [任务 1]
   - [任务 2]
   - [...]

8. 当前工作：
   [当前工作的精确描述]

9. 可选的下一步：
   [可选的下一步行动]

</summary>
</example>

请根据到目前为止的对话提供你的摘要，遵循此结构并确保回复的精确性和彻底性。

在包含的上下文中可能会提供额外的摘要说明。如果是这样，请记住在创建上述摘要时遵循这些说明。说明示例包括：
<example>
## 压缩说明
在总结对话时，专注于 typescript 代码更改，并记住你犯的错误以及如何修复它们。
</example>

<example>
# 摘要说明
使用压缩时 — 专注于测试输出和代码更改。逐字包含文件读取内容。
</example>
`

const PARTIAL_COMPACT_PROMPT = `你的任务是创建对话最近部分的详细摘要 — 即跟随早期保留上下文的消息。早期的消息被完整保留，不需要摘要。将摘要集中在最近消息中讨论、学习和完成的内容上。

${DETAILED_ANALYSIS_INSTRUCTION_PARTIAL}

你的摘要应包含以下部分：

1. 主要请求和意图：捕获最近消息中用户的明确请求和意图
2. 关键技术概念：列出最近讨论的重要技术概念、技术和框架
3. 文件和代码部分：列举检查、修改或创建的具体文件和代码部分。在适用时包含完整代码片段，并说明为什么此文件读取或编辑很重要
4. 错误和修复：列出遇到的错误以及如何修复
5. 问题解决：记录已解决的问题和正在进行的故障排除工作
6. 所有用户消息：列出最近部分中所有不是工具结果的用户消息
7. 待处理任务：概述最近消息中的任何待处理任务
8. 当前工作：精确描述在此摘要请求之前正在进行的工作
9. 可选的下一步：列出与最近工作相关的下一步。包含最近对话中的直接引用

以下是你的输出应该如何组织结构的示例：

<example>
<analysis>
[你的思考过程，确保所有要点都被彻底且准确地覆盖]
</analysis>

<summary>
1. 主要请求和意图：
   [详细描述]

2. 关键技术概念：
   - [概念 1]
   - [概念 2]

3. 文件和代码部分：
   - [文件名 1]
      - [此文件为何重要的摘要]
      - [重要代码片段]

4. 错误和修复：
    - [错误描述]：
      - [你如何修复]

5. 问题解决：
   [描述]

6. 所有用户消息：
    - [详细的非工具使用用户消息]

7. 待处理任务：
   - [任务 1]

8. 当前工作：
   [当前工作的精确描述]

9. 可选的下一步：
   [可选的下一步行动]

</summary>
</example>

请仅基于最近的消息（保留的早期上下文之后）提供你的摘要，遵循此结构并确保回复的精确性和彻底性。
`

// 'up_to'：模型只看到已摘要的前缀（缓存命中）。摘要将放在
// 保留的最近消息之前，因此需要"继续工作的上下文"部分。
const PARTIAL_COMPACT_UP_TO_PROMPT = `你的任务是创建此对话的详细摘要。此摘要将放在继续会话的开头；构建在此上下文之上的较新消息将在你的摘要之后（你在这里看不到它们）。彻底摘要，以便只阅读你的摘要然后阅读较新消息的人能完全理解发生了什么并继续工作。

${DETAILED_ANALYSIS_INSTRUCTION_BASE}

你的摘要应包含以下部分：

1. 主要请求和意图：详细捕获用户的明确请求和意图
2. 关键技术概念：列出讨论的重要技术概念、技术和框架
3. 文件和代码部分：列举检查、修改或创建的具体文件和代码部分。在适用时包含完整代码片段，并说明为什么此文件读取或编辑很重要
4. 错误和修复：列出遇到的错误以及如何修复
5. 问题解决：记录已解决的问题和正在进行的故障排除工作
6. 所有用户消息：列出所有不是工具结果的用户消息
7. 待处理任务：概述任何待处理任务
8. 已完成工作：描述到此部分结束时完成的工作
9. 继续工作的上下文：总结后续消息中需要理解和继续工作的任何上下文、决策或状态

以下是你的输出应该如何组织结构的示例：

<example>
<analysis>
[你的思考过程，确保所有要点都被彻底且准确地覆盖]
</analysis>

<summary>
1. 主要请求和意图：
   [详细描述]

2. 关键技术概念：
   - [概念 1]
   - [概念 2]

3. 文件和代码部分：
   - [文件名 1]
      - [此文件为何重要的摘要]
      - [重要代码片段]

4. 错误和修复：
    - [错误描述]：
      - [你如何修复]

5. 问题解决：
   [描述]

6. 所有用户消息：
    - [详细的非工具使用用户消息]

7. 待处理任务：
   - [任务 1]

8. 已完成工作：
   [完成工作的描述]

9. 继续工作的上下文：
   [继续工作所需的关键上下文、决策或状态]

</summary>
</example>

请遵循此结构提供你的摘要，确保回复的精确性和彻底性。
`

const NO_TOOLS_TRAILER =
  '\n\n提醒：不要调用任何工具。仅用纯文本回复 — ' +
  '一个 <analysis> 块后跟一个 <summary> 块。' +
  '工具调用将被拒绝，你将因此无法完成任务。'

export function getPartialCompactPrompt(
  customInstructions?: string,
  direction: PartialCompactDirection = 'from',
): string {
  const template =
    direction === 'up_to'
      ? PARTIAL_COMPACT_UP_TO_PROMPT
      : PARTIAL_COMPACT_PROMPT
  let prompt = NO_TOOLS_PREAMBLE + template

  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\n附加说明：\n${customInstructions}`
  }

  prompt += NO_TOOLS_TRAILER

  return prompt
}

export function getCompactPrompt(customInstructions?: string): string {
  let prompt = NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT

  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\n附加说明：\n${customInstructions}`
  }

  prompt += NO_TOOLS_TRAILER

  return prompt
}

/**
 * 格式化压缩摘要：剥离 <analysis> 起草暂存区，
 * 并将 <summary> XML 标签替换为可读的部分标题。
 * @param summary 可能包含 <analysis> 和 <summary> XML 标签的原始摘要字符串
 * @returns 格式化后的摘要，分析被剥离，摘要标签被标题替换
 */
export function formatCompactSummary(summary: string): string {
  let formattedSummary = summary

  // 剥离分析部分 — 它是提高摘要质量的起草暂存区，
  // 但摘要写完后没有信息价值。
  formattedSummary = formattedSummary.replace(
    /<analysis>[\s\S]*?<\/analysis>/,
    '',
  )

  // 提取并格式化摘要部分
  const summaryMatch = formattedSummary.match(/<summary>([\s\S]*?)<\/summary>/)
  if (summaryMatch) {
    const content = summaryMatch[1] || ''
    formattedSummary = formattedSummary.replace(
      /<summary>[\s\S]*?<\/summary>/,
      `摘要:\n${content.trim()}`,
    )
  }

  // 清理部分之间的多余空白
  formattedSummary = formattedSummary.replace(/\n\n+/g, '\n\n')

  return formattedSummary.trim()
}

export function getCompactUserSummaryMessage(
  summary: string,
  suppressFollowUpQuestions?: boolean,
  transcriptPath?: string,
  recentMessagesPreserved?: boolean,
): string {
  const formattedSummary = formatCompactSummary(summary)

  let baseSummary = `此会话是从上下文用尽的前一次对话继续的。以下摘要涵盖了对话的早期部分。

${formattedSummary}`

  if (transcriptPath) {
    baseSummary += `\n\n如果你需要压缩前的具体细节（如确切的代码片段、错误消息或你生成的内容），请阅读完整转录：${transcriptPath}`
  }

  if (recentMessagesPreserved) {
    baseSummary += `\n\n最近的消息已逐字保留。`
  }

  if (suppressFollowUpQuestions) {
    let continuation = `${baseSummary}
从上次中断的地方继续对话，不要再问用户任何问题。直接恢复 — 不要确认摘要，不要回顾正在发生的事情，不要用"我将继续"或类似的话开头。像中断从未发生过一样继续上一个任务。`

    if (
      (feature('PROACTIVE') || feature('KAIROS')) &&
      proactiveModule?.isProactiveActive()
    ) {
      continuation += `

你正在自主/主动模式下运行。这不是第一次唤醒 — 在压缩之前你已经在自主工作。继续你的工作循环：根据上面的摘要从上次中断的地方继续。不要向用户问好或询问要做什么。`
    }

    return continuation
  }

  return baseSummary
}
