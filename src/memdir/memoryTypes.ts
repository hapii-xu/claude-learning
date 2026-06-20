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
  '## Types of memory',
  '',
  'There are several discrete types of memory that you can store in your memory system. Each type below declares a <scope> of `private`, `team`, or guidance for choosing between the two.',
  '',
  '<types>',
  '<type>',
  '    <name>user</name>',
  '    <scope>always private</scope>',
  "    <description>The user's role, goals, preferences, responsibilities, and knowledge. Use these to tailor your behavior to the user.</description>",
  '</type>',
  '<type>',
  '    <name>feedback</name>',
  '    <scope>default to private. Save as team only when the guidance is clearly a project-wide convention that every contributor should follow (e.g., a testing policy, a build invariant), not a personal style preference.</scope>',
  '    <description>Guidance from the user about how to approach work — what to avoid and what to keep doing. Record from failure AND success. Include *why* so you can judge edge cases later. Structure content as: rule/fact, then **Why:** and **How to apply:** lines.</description>',
  '</type>',
  '<type>',
  '    <name>project</name>',
  '    <scope>private or team, but strongly bias toward team</scope>',
  '    <description>Information about ongoing work, goals, initiatives, bugs, or incidents not derivable from code or git history. Convert relative dates to absolute dates when saving (e.g., "Thursday" → "2026-03-05").</description>',
  '</type>',
  '<type>',
  '    <name>reference</name>',
  '    <scope>usually team</scope>',
  '    <description>Pointers to external systems where information can be found (e.g., Linear projects, Slack channels, Grafana dashboards).</description>',
  '</type>',
  '</types>',
  '',
]

/**
 * INDIVIDUAL-ONLY 模式（单目录）的 `## Types of memory` 章节。
 * 无 <scope> 标签。仅在私有/团队拆分下才有意义的措辞已被改写。
 */
export const TYPES_SECTION_INDIVIDUAL: readonly string[] = [
  '## Types of memory',
  '',
  '<types>',
  '<type>',
  '    <name>user</name>',
  "    <description>The user's role, goals, preferences, responsibilities, and knowledge. Use these to tailor your behavior to the user.</description>",
  '</type>',
  '<type>',
  '    <name>feedback</name>',
  '    <description>Guidance from the user about how to approach work — what to avoid and what to keep doing. Record from failure AND success. Include *why* so you can judge edge cases later. Structure content as: rule/fact, then **Why:** and **How to apply:** lines.</description>',
  '</type>',
  '<type>',
  '    <name>project</name>',
  '    <description>Information about ongoing work, goals, initiatives, bugs, or incidents not derivable from code or git history. Convert relative dates to absolute dates when saving (e.g., "Thursday" → "2026-03-05").</description>',
  '</type>',
  '<type>',
  '    <name>reference</name>',
  '    <description>Pointers to external systems where information can be found (e.g., Linear projects, Slack channels, Grafana dashboards).</description>',
  '</type>',
  '</types>',
  '',
]

/**
 * `## What NOT to save in memory` 章节。两种模式完全相同。
 */
export const WHAT_NOT_TO_SAVE_SECTION: readonly string[] = [
  '## What NOT to save in memory',
  '',
  '- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.',
  '- Git history, recent changes, or who-changed-what — `git log` / `git blame` are authoritative.',
  '- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.',
  '- Anything already documented in CLAUDE.md files.',
  '- Ephemeral task details: in-progress work, temporary state, current conversation context.',
  '',
  // H2：显式保存门控。经 eval 验证（memory-prompt-iteration 用例 3，
  // 0/2 → 3/3）：防止"保存本周 PR 列表"→ 活动日志噪音。
  'These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.',
]

/**
 * 召回时的漂移提示。`## When to access memories` 下的单条要点。
 * 主动性：在回答前根据当前状态验证记忆。
 */
export const MEMORY_DRIFT_CAVEAT =
  '- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory rather than acting on it.'

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
  '## When to access memories',
  '- When memories seem relevant, or the user references prior-conversation work.',
  '- You MUST access memory when the user explicitly asks you to check, recall, or remember.',
  '- If the user says to *ignore* or *not use* memory: proceed as if MEMORY.md were empty. Do not apply remembered facts, cite, compare against, or mention memory content.',
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
  '## Before recommending from memory',
  '',
  'A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:',
  '',
  '- If the memory names a file path: check the file exists.',
  '- If the memory names a function or flag: grep for it.',
  '- If the user is about to act on your recommendation (not just asking about history), verify first.',
  '',
  '"The memory says X exists" is not the same as "X exists now."',
  '',
  'A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer `git log` or reading the code over recalling the snapshot.',
]

/**
 * 带有 `type` 字段的 Frontmatter 格式示例。
 */
export const MEMORY_FRONTMATTER_EXAMPLE: readonly string[] = [
  '```markdown',
  '---',
  'name: {{memory name}}',
  'description: {{one-line description — used to decide relevance in future conversations, so be specific}}',
  `type: {{${MEMORY_TYPES.join(', ')}}}`,
  '---',
  '',
  '{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines}}',
  '```',
]
