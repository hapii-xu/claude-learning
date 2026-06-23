/**
 * 记忆类型分类法。
 *
 * 记忆被限定为四种类型，捕获无法从当前项目状态推导出的上下文。
 * 代码模式、架构、git 历史和文件结构都是可推导的（通过 grep/git/CLAUDE.md），
 * 不应保存为记忆。
 *
 * 下面的两个 TYPES_SECTION_* 导出是故意重复而非从共享规范生成的 ——
 * 保持扁平使按模式编辑变得简单，无需推理辅助函数的条件渲染。
 */

export const MEMORY_TYPES = [
  'user',
  'feedback',
  'project',
  'reference',
] as const

export type MemoryType = (typeof MEMORY_TYPES)[number]

/**
 * 将原始 frontmatter 值解析为 MemoryType。
 * 无效或缺失值返回 undefined —— 没有 `type:` 字段的旧文件
 * 继续工作，具有未知类型的文件优雅降级。
 */
export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== 'string') return undefined
  return MEMORY_TYPES.find(t => t === raw)
}

/**
 * COMBINED 模式（私有 + 团队目录）的 `## Types of memory` 章节。
 * 包含 <scope> 标签和示例中的团队/私有限定符。
 */
export const TYPES_SECTION_COMBINED: readonly string[] = [
  '## 记忆类型',
  '',
  '你可以在记忆系统中存储若干离散的记忆类型。以下每种类型均声明了 <scope>（范围）为 `private`（私有）、`team`（团队），或提供在两者之间选择的指导。',
  '',
  '<types>',
  '<type>',
  '    <name>user</name>',
  '    <scope>始终私有</scope>',
  '    <description>用户的角色、目标、偏好、职责和知识。用这些来定制你对用户的行为方式。</description>',
  '</type>',
  '<type>',
  '    <name>feedback</name>',
  '    <scope>默认私有。仅当指导明显是所有贡献者都应遵循的项目级约定（如测试策略、构建不变量）而非个人风格偏好时，才保存为团队级别。</scope>',
  '    <description>用户关于如何处理工作的指导——避免什么、坚持什么。同时记录失败和成功的经验。包含*原因*以便日后判断边界情况。内容结构为：规则/事实，然后是 **Why:**（原因）和 **How to apply:**（应用方式）两行。</description>',
  '</type>',
  '<type>',
  '    <name>project</name>',
  '    <scope>私有或团队均可，但强烈倾向于团队</scope>',
  '    <description>关于进行中工作、目标、计划、Bug 或无法从代码或 git 历史推导的事件的信息。保存时将相对日期转换为绝对日期（如"周四" → "2026-03-05"）。</description>',
  '</type>',
  '<type>',
  '    <name>reference</name>',
  '    <scope>通常为团队</scope>',
  '    <description>指向可找到信息的外部系统的指针（如 Linear 项目、Slack 频道、Grafana 仪表盘）。</description>',
  '</type>',
  '</types>',
  '',
]

/**
 * INDIVIDUAL-ONLY 模式（单目录）的 `## Types of memory` 章节。
 * 无 <scope> 标签。仅在私有/团队拆分下才有意义的措辞已被改写。
 */
export const TYPES_SECTION_INDIVIDUAL: readonly string[] = [
  '## 记忆类型',
  '',
  '<types>',
  '<type>',
  '    <name>user</name>',
  '    <description>用户的角色、目标、偏好、职责和知识。用这些来定制你对用户的行为方式。</description>',
  '</type>',
  '<type>',
  '    <name>feedback</name>',
  '    <description>用户关于如何处理工作的指导——避免什么、坚持什么。同时记录失败和成功的经验。包含*原因*以便日后判断边界情况。内容结构为：规则/事实，然后是 **Why:**（原因）和 **How to apply:**（应用方式）两行。</description>',
  '</type>',
  '<type>',
  '    <name>project</name>',
  '    <description>关于进行中工作、目标、计划、Bug 或无法从代码或 git 历史推导的事件的信息。保存时将相对日期转换为绝对日期（如"周四" → "2026-03-05"）。</description>',
  '</type>',
  '<type>',
  '    <name>reference</name>',
  '    <description>指向可找到信息的外部系统的指针（如 Linear 项目、Slack 频道、Grafana 仪表盘）。</description>',
  '</type>',
  '</types>',
  '',
]

/**
 * `## What NOT to save in memory` 章节。两种模式完全相同。
 */
export const WHAT_NOT_TO_SAVE_SECTION: readonly string[] = [
  '## 不应保存为记忆的内容',
  '',
  '- 代码模式、约定、架构、文件路径或项目结构——这些可通过读取当前项目状态推导出。',
  '- Git 历史、近期变更或谁改了什么——`git log` / `git blame` 是权威来源。',
  '- 调试方案或修复方法——修复已在代码中；提交信息包含背景。',
  '- 已在 CLAUDE.md 文件中记录的任何内容。',
  '- 临时任务细节：进行中的工作、临时状态、当前对话上下文。',
  '',
  // H2：显式保存门控。经 eval 验证（memory-prompt-iteration 用例 3，
  // 0/2 → 3/3）：防止"保存本周 PR 列表"→ 活动日志噪音。
  '即使用户明确要求保存，上述排除项同样适用。如果他们要求保存 PR 列表或活动摘要，请询问其中有哪些*令人意外*或*不显而易见*的内容——那才是值得保留的部分。',
]

/**
 * 召回时的漂移提示。`## When to access memories` 下的单条要点。
 * 主动性：在回答前根据当前状态验证记忆。
 */
export const MEMORY_DRIFT_CAVEAT =
  '- 记忆记录可能随时间变得过时。将记忆作为某一时间点上真实情况的上下文来使用。在仅基于记忆记录中的信息回答用户或建立假设之前，请通过读取文件或资源的当前状态来验证记忆是否仍然正确和最新。如果召回的记忆与当前信息冲突，请信任你现在观察到的内容——并更新或删除过时的记忆，而非基于它行动。'

/**
 * `## When to access memories` 章节。包含 MEMORY_DRIFT_CAVEAT。
 *
 * H6（分支污染 evals #22856，用例 5 1/3 on capy）："ignore" 要点
 * 是关键差异。失败模式：用户说"忽略关于 X 的记忆" → Claude 正确读取
 * 代码但添加了"不像记忆中提到的那样 Y" —— 将"忽略"视为
 * "确认然后覆盖"而不是"完全不引用"。该要点明确命名了这种反模式。
 *
 * Token 预算（H6a）：合并了旧的要点 1+2，并收紧了两者。旧的 4 行
 * 约为 70 token；新的 4 行约为 73 token。净增约 +3。
 */
export const WHEN_TO_ACCESS_SECTION: readonly string[] = [
  '## 何时访问记忆',
  '- 当记忆似乎相关时，或用户提及过往对话中的工作时。',
  '- 当用户明确要求你检查、回忆或记住某事时，你必须访问记忆。',
  '- 如果用户说要*忽略*或*不使用*记忆：请视 MEMORY.md 为空。不要应用已记住的事实、引用、对比或提及记忆内容。',
  MEMORY_DRIFT_CAVEAT,
]

/**
 * `## Trusting what you recall` 章节。关于召回记忆后如何处理它的
 * 更重量级指导 —— 与何时访问分开。
 *
 * 经 eval 验证（memory-prompt-iteration.eval.ts，2026-03-17）：
 *   H1（验证函数/文件声明）：0/2 → 3/3 通过 appendSystemPrompt。当
 *      作为"When to access"下的要点埋藏时，降至 0/3 —— 位置很重要。
 *      H1 线索是关于如何处理记忆，而不是何时查找，所以需要其自己的
 *      章节级触发上下文。
 *   H5（读取端噪音拒绝）：0/2 → 3/3 通过 appendSystemPrompt，就地
 *      作为要点是 2/3。部分因为"快照"在直觉上比 H1 更接近"何时访问"。
 *
 * 已知缺口：H1 不覆盖斜杠命令声明（/fork 用例为 0/3 —— 斜杠命令
 * 在模型的本体论中不是文件或函数）。
 */
export const TRUSTING_RECALL_SECTION: readonly string[] = [
  // 标题措辞很重要："Before recommending"（在决策点的行动提示）
  // 测试效果优于 "Trusting what you recall"（抽象）。使用此标题的
  // appendSystemPrompt 变体通过了 3/3；抽象标题就地通过 0/3。
  // 正文相同 —— 只有标题不同。
  '## 基于记忆进行推荐前',
  '',
  '一条记忆中提到特定函数、文件或标志，是对其*写入记忆时*存在的断言。它可能已被重命名、删除或从未合并。在推荐前：',
  '',
  '- 如果记忆提到文件路径：检查该文件是否存在。',
  '- 如果记忆提到函数或标志：用 grep 搜索它。',
  '- 如果用户即将基于你的推荐采取行动（而非仅询问历史），请先验证。',
  '',
  '"记忆中说 X 存在"不等同于"X 现在存在"。',
  '',
  '汇总仓库状态（活动日志、架构快照）的记忆是时间固化的。如果用户询问*近期*或*当前*状态，请优先使用 `git log` 或读取代码，而非召回快照。',
]

/**
 * 带有 `type` 字段的 Frontmatter 格式示例。
 */
export const MEMORY_FRONTMATTER_EXAMPLE: readonly string[] = [
  '```markdown',
  '---',
  'name: {{记忆名称}}',
  'description: {{一行描述——用于在未来对话中判断相关性，请尽量具体}}',
  `type: {{${MEMORY_TYPES.join(', ')}}}`,
  '---',
  '',
  '{{记忆内容——对于 feedback/project 类型，结构为：规则/事实，然后是 **Why:**（原因）和 **How to apply:**（应用方式）两行}}',
  '```',
]
