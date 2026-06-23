import { registerBundledSkill } from '../bundledSkills.js'

/**
 * /ultracode —— 多代理工作流编排手册（纯知识型提示技能）。
 *
 * 将工作流编排手册注入上下文，零运行时副作用：
 * 它不改变主循环，也不切换任何行为开关。
 * 用户/模型使用它来决定何时调用 Workflow 工具、如何编排
 * 扇出和验证，以及如何保持运行的确定性和可恢复性。
 *
 * 通用技能（非仅限 Anthropic 员工）；对所有用户可用。
 */
const ULTRACODE_PROMPT = `# /ultracode — 工作流编排手册

执行一个确定性编排多个子代理的工作流脚本。工作流在后台运行——此工具立即返回一个任务 ID，工作流完成时会收到 \`<task-notification>\` 通知。使用 \`/workflows\` 实时查看进度。

工作流跨多个代理结构化工作——实现全面覆盖（并行分解处理）、增强可信度（独立视角和对抗性验证后再提交），或承担单个上下文无法容纳的规模（迁移、审计、大范围扫描）。脚本是你编码该结构的地方：哪些部分扇出、哪些部分验证、哪些部分综合。

仅在用户明确选择多代理编排时才调用此工具。工作流可能生成数十个代理并消耗大量 token；用户必须主动请求该规模，而不是由模型推断。明确选择是指以下情况之一：

- 用户在提示中包含了关键字 "ultracode"（你会看到一条 system-reminder 确认这一点）。
- 本次会话已开启 Ultracode（system-reminder 确认）——见下方 **Ultracode** 章节。
- 用户用自己的话直接要求运行工作流或使用多代理编排（"use a workflow"、"run a workflow"、"fan out agents"、"orchestrate this with subagents"）。请求必须出自用户之口——仅能从工作流中受益的任务不算。
- 用户调用了某个技能或斜杠命令，该命令的说明要求调用 Workflow。
- 用户要求运行某个具名或已保存的工作流。

对于任何其他任务——即使明显能从并行中受益——也不要调用此工具。改用 Agent 工具处理单个子代理，或简要描述多代理工作流能做什么以及大致费用，询问用户是否运行。提示他们可以在未来的消息中说 "use a workflow" 来跳过询问。

调用时，正确的做法通常是**混合模式**：先内联侦察（列出文件、找到频道、确定 diff 范围）以发现工作列表，然后调用 Workflow 进行流水线处理。你不需要在*任务*之前就知道形状——只需在*编排步骤*之前知道即可。

常见的单阶段工作流（可跨轮次链式调用）：

- **理解** — 并行读取相关子系统 → 结构化映射
- **设计** — N 个独立方案的评审团 → 评分综合
- **审查** — 维度 → 查找 → 对抗性验证（见下方示例）
- **研究** — 多模态扫描 → 深度阅读 → 综合
- **迁移** — 发现站点 → 各自转换（worktree 隔离） → 验证

对于更大规模的工作，按顺序运行多个工作流——在决定下一阶段之前先读取每个结果。你始终处于控制循环中；每个工作流都是一次范围明确的扇出。

**选择加入由 harness 注入，而非由仓库控制。**"ultracode is on for the session" 的 system-reminder 由 harness（claude.ai/client）产生，而非本技能或任何仓库状态。本技能仅提供知识——它注入手册，不切换任何内容。仓库中没有 ultracode 的 feature flag、环境变量或努力级别；不要添加。Workflow 工具通过构建时的 WORKFLOW_SCRIPTS feature flag 编译进来，不暴露任何每会话运行时门控。

**Ultracode 模式。** 当 system-reminder 确认 ultracode 已开启时，该选择是持续的：默认为每个实质性任务编写并运行工作流。目标是你能产出的最详尽、最正确的答案——token 成本不是约束。对于多阶段工作（理解 → 设计 → 实现 → 审查），这通常意味着按顺序运行多个工作流——每个阶段一个——以便你在它们之间保持在控制循环中。下方的质量模式（对抗性验证、多模态扫描、完整性批评者、loop-until-dry）是工具；选择适合任务的。倾向于用工作流编排并对抗性验证你的发现——除非工作是琐碎的或已经验证过。仅在对话轮次或琐碎的机械性编辑上单独行动。当提醒说 ultracode 已关闭时，回退到上面的选择加入规则。

通过 \`script\` 内联传递脚本——不要先 Write 到文件。每次调用会自动将脚本持久化到会话目录下的文件并在工具结果中返回路径。要迭代工作流，用 Write/Edit 编辑该文件，然后用 \`{scriptPath: "<path>"}\` 重新调用 Workflow，而不是重新发送完整脚本。

每个脚本必须以 \`export const meta = {...}\` 开头：

\`\`\`js
export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',   // one-line, shown in permission dialog
  phases: [                                            // one entry per phase() call
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix', detail: 'one agent per flaky test' },
  ],
}
// script body starts here — use agent()/parallel()/pipeline()/phase()/log()
phase('Scan')
const flaky = await agent('grep CI logs for retry markers', {schema: FLAKY_SCHEMA})
...
\`\`\`

\`meta\` 对象必须是**纯字面量**——不能有变量、函数调用、展开运算符或模板插值。必填字段：\`name\`、\`description\`。可选字段：\`whenToUse\`（显示在工作流列表中）、\`phases\`。meta.phases 中的阶段标题必须与 phase() 调用中的完全一致——标题精确匹配；没有对应 meta 条目的 phase() 调用会得到自己的进度组。当某阶段使用特定模型覆盖时，在阶段条目中添加 \`model\`。

脚本体钩子：

- \`agent(prompt: string, opts?: {label?: string, phase?: string, schema?: object, model?: string, isolation?: 'worktree', agentType?: string}): Promise<any>\` — 生成子代理。不带 schema 时，返回其最终文本字符串。带 schema（JSON Schema）时，子代理被强制调用 StructuredOutput 工具，agent() 返回验证后的对象——无需解析。若用户在运行中跳过该代理或子代理在重试后遇到终端 API 错误，则返回 null（用 .filter(Boolean) 过滤）。opts.label 覆盖显示标签。opts.phase 显式将此代理分配到进度组（在 pipeline()/parallel() 阶段内使用此选项以避免全局 phase() 状态的竞争——相同 phase 字符串 → 相同分组框）。opts.model 覆盖此代理调用的模型。默认省略——代理继承主循环模型（已解析的会话模型），几乎总是正确的。仅在你高度确信不同级别适合任务时才设置；不确定时省略。opts.isolation: 'worktree' 在全新 git worktree 中运行代理——**昂贵**（每个代理约 200-500ms 设置+磁盘），仅在代理并行修改文件且否则会冲突时使用；若无变更 worktree 会自动移除。opts.agentType 使用自定义子代理类型（如 'Explore'、'code-reviewer'）代替默认工作流子代理——从与 Agent 工具相同的注册表解析；与 schema 组合（自定义代理的系统提示会附加 StructuredOutput 指令）。
- \`pipeline(items, stage1, stage2, ...): Promise<any[]>\` — 让每个条目独立经过所有阶段，阶段间**无屏障**。条目 A 可以在阶段 3 而条目 B 还在阶段 1。这是多阶段工作的**默认选择**。墙钟时间 = 最慢单条目链，而非各阶段最慢之和。每个阶段回调接收 (prevResult, originalItem, index)——在后续阶段使用 originalItem/index 来标记工作，而无需通过阶段 1 的返回值传递上下文。抛出异常的阶段会将该条目置为 \`null\` 并跳过其剩余阶段。
- \`parallel(thunks: Array<() => Promise<any>>): Promise<any[]>\` — 并发运行任务。这是一个**屏障**：返回前等待所有 thunk 完成。抛出异常（或代理出错）的 thunk 在结果数组中解析为 \`null\`——调用本身永不拒绝，因此在使用结果前用 \`.filter(Boolean)\`。仅在确实需要所有结果时才使用。
- \`log(message: string): void\` — 向用户发出进度消息（显示为进度树上方的叙述行）
- \`phase(title: string): void\` — 开启新阶段；后续 agent() 调用在进度显示中归入此标题下
- \`args: any\` — 作为 Workflow 的 \`args\` 输入传递的值，原样传递（未提供时为 undefined）。在工具调用中以实际 JSON 值传递数组/对象，而**不是** JSON 编码字符串——\`args: ["a.ts", "b.ts"]\`，而非 \`args: "[\\"a.ts\\", ...]"\`（字符串化的列表到达脚本时是一个字符串，因此 \`args.filter\`/\`args.map\` 会抛出）。用此参数化具名工作流——例如直接传递研究问题、目标路径或配置对象，而不是通过旁信道文件。
- \`budget: {total: number|null, spent(): number, remaining(): number}\` — 来自用户 "+500k" 风格指令的本轮 token 目标。若未设置目标，\`budget.total\` 为 null。\`budget.spent()\` 返回本轮主循环和所有工作流消耗的输出 token——池是共享的，非每工作流独立。\`budget.remaining()\` 返回 \`max(0, total - spent())\`，若无目标则返回 \`Infinity\`。目标是**硬上限**，非建议值：一旦 \`spent()\` 达到 \`total\`，后续 \`agent()\` 调用会抛出。用于动态循环：\`while (budget.total && budget.remaining() > 50_000) { ... }\`，或静态缩放：\`const FLEET = budget.total ? Math.floor(budget.total / 100_000) : 5\`。
- \`workflow(nameOrRef: string | {scriptPath: string}, args?: any): Promise<any>\` — 将另一个工作流作为子步骤内联运行并返回其返回值。传递名称以调用已保存的工作流（与 {name: "..."} 使用同一注册表），或传递 {scriptPath} 运行你之前 Write 的脚本文件。子工作流共享本次运行的并发上限、代理计数器、中止信号和 token 预算——其代理在 /workflows 中显示在 "▸ name" 组下，其 token 计入 budget.spent()。args 参数成为子工作流的 \`args\` 全局变量。嵌套仅一级：子工作流中的 workflow() 会抛出。未知名称/不可读 scriptPath/子工作流语法错误时抛出；catch 以优雅处理。

每个工作流并发 agent() 调用默认上限为 3——超出的调用排队，空位释放后运行。Workflow 工具接受可选的 \`maxConcurrency\` 输入（1–16）以覆盖每次运行。省略则使用 3。要将 maxConcurrency 设置为 3 以外的**任何**值，你必须先通过 AskUserQuestion 询问用户（提供 3 / 6 / 9 选项，3 标记为"(Recommended)"）——唯一例外是用户在本次会话中已经指定了数值（"use 6"、"maxConcurrency 9"）。不要因为工作流扇出就悄悄提升并发；3 是推荐默认值。你仍然可以向 parallel()/pipeline() 传递 100 个条目，它们都会完成；只是同一时刻运行的数量受配置限制。工作流生命周期内的总代理数上限为 1000——这是一个远高于任何实际工作流的失控循环保护。单次 parallel()/pipeline() 调用最多接受 4096 个条目；超过此数是显式错误，而非静默截断。

**每任务模型级别**——当你确实覆盖 opts.model 时。有效别名：'haiku' | 'sonnet' | 'opus' | 'best' | 'sonnet[1m]' | 'opus[1m]' | 'opusplan'。主循环已在用户选择的级别（通常是 sonnet）上运行，因此大多数代理省略 model。仅在任务明显适合不同级别时覆盖：

- 'haiku' — 快速且便宜（约比 sonnet 便宜/快 5 倍）。用于：分类、提取、标注、类正则模式匹配、"这是否匹配 X？"的门控、简单格式转换。对于任何需要推理多个概念或生成代码的任务，这是错误选择。
- 'sonnet' — 主力。大多数代码编辑、多文件阅读、工具调用链、schema/结构化输出、代码审查、重构、调试。有疑问时，省略 model，让代理继承此级别。
- 'opus' — 最强推理，最慢且最贵（约 sonnet 成本的 5 倍）。用于：架构决策、跨模块深度溯因、新颖算法设计、对 sonnet 发现的对抗性验证、安全审查。预留给每个工作流中推理确实重要的 1-2 个代理。
- 'best' — 提供商的"最佳可用"（当前为 opus 级别）。当你需要最高智能且不在乎成本或固定级别时使用。

**经验法则**：如果你无法说清楚为什么这个代理需要不同级别，就省略 model。有意混合级别的工作流（haiku 分类 → sonnet 处理工作 → opus 验证）通常在成本**和**质量上都优于全用 opus。不要在 9 维度审查的每个维度上都用 opus——sonnet 找到 bug，opus 验证其中重要的几个。

子代理被告知其最终文本**就是**返回值（而非面向人类的消息），因此它们返回原始数据。对于结构化输出，使用 schema 选项——验证在工具调用层发生，因此模型在不匹配时会重试。

工作流代理可以通过 ToolSearch 访问所有会话连接的 MCP 工具——每个代理按需加载 schema。注意：交互式认证的 MCP 服务器（如 claude.ai）在无头/cron 运行中可能不存在。

脚本是纯 JavaScript，**不是** TypeScript——类型注解（\`: string[]\`）、interface 和泛型无法解析。脚本体在异步上下文中运行——直接使用 \`await\`。标准 JS 内置方法（JSON、Math、Array 等）可用——**除了** \`Date.now()\`/\`Math.random()\`/无参 \`new Date()\`，它们会抛出（会破坏恢复）；通过 \`args\` 传入时间戳，在工作流返回后标注结果，随机性通过索引变化 agent prompt/label 实现。无文件系统或 Node.js API 访问。

**默认使用 pipeline()。** 只有在确实需要所有前阶段结果时才使用屏障（阶段间的 parallel）。

屏障**仅在**阶段 N 需要来自阶段 N-1 所有结果的跨条目上下文时才正确：

- 在昂贵的下游工作之前对完整结果集进行去重/合并
- 若总数为零则提前退出（"找到 0 个 bug → 完全跳过验证"）
- 阶段 N 的 prompt 引用"其他发现"进行比较

以下情况**不**能为屏障辩护：

- "我需要先展平/映射/过滤"——在 pipeline 阶段内部做：\`pipeline(items, stageA, r => transform([r]).flat(), stageB)\`
- "这些阶段在概念上是独立的"——这正是 pipeline() 所建模的。独立阶段 ≠ 同步阶段。
- "代码更整洁"——屏障延迟是真实存在的。如果 5 个查找器运行且最慢的比最快的慢 3 倍，屏障会浪费快速查找器 2/3 的空闲时间。

**气味测试**：如果你写了

\`\`\`js
const a = await parallel(...)
const b = transform(a)        // flatten, map, filter — no cross-item dependency
const c = await parallel(b.map(...))
\`\`\`

中间的转换不需要屏障。将其重写为 pipeline，把转换放在阶段内部。有疑问时：用 pipeline。

**典型多阶段模式**——默认使用 pipeline，每个维度在审查完成后立即验证：

\`\`\`js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}
const DIMENSIONS = [{key: 'bugs', prompt: '...'}, {key: 'perf', prompt: '...'}]
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, {label: \`review:\${d.key}\`, phase: 'Review', schema: FINDINGS_SCHEMA}),
  review => parallel(review.findings.map(f => () =>
    agent(\`Adversarially verify: \${f.title}\`, {label: \`verify:\${f.file}\`, phase: 'Verify', schema: VERDICT_SCHEMA})
      .then(v => ({...f, verdict: v}))
  ))
)
const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
return { confirmed }
// Dimension 'bugs' findings verify while dimension 'perf' is still reviewing. No wasted wall-clock.
\`\`\`

**屏障正确的情况**——在昂贵的验证之前对所有发现去重：

\`\`\`js
const all = await parallel(DIMENSIONS.map(d => () => agent(d.prompt, {schema: FINDINGS_SCHEMA})))
const deduped = dedupeByFileAndLine(all.filter(Boolean).flatMap(r => r.findings))  // <-- genuinely needs ALL at once
const verified = await parallel(deduped.map(f => () => agent(verifyPrompt(f), {schema: VERDICT_SCHEMA})))
\`\`\`

**循环至计数模式**——累积到目标数量：

\`\`\`js
const bugs = []
while (bugs.length < 10) {
  const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})
  bugs.push(...result.bugs)
  log(\`\${bugs.length}/10 found\`)
}
\`\`\`

**循环至预算模式**——根据用户的 "+500k" 指令缩放深度。用 budget.total 守护：若未设置目标，remaining() 为 Infinity，循环会直接跑到 1000 个代理的上限。

\`\`\`js
const bugs = []
while (budget.total && budget.remaining() > 50_000) {
  const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})
  bugs.push(...result.bugs)
  log(\`\${bugs.length} found, \${Math.round(budget.remaining()/1000)}k remaining\`)
}
\`\`\`

**组合模式**——穷举审查（查找 → 对比已见去重 → 多视角评审团 → 循环至干涸）：

\`\`\`js
const seen = new Set(), confirmed = []
let dry = 0
while (dry < 2) {                                              // loop-until-dry
  const found = (await parallel(FINDERS.map(f => () =>          // barrier: collect all finders this round
    agent(f.prompt, {phase: 'Find', schema: BUGS})))).filter(Boolean).flatMap(r => r.bugs)
  const fresh = found.filter(b => !seen.has(key(b)))           // dedup vs ALL seen — plain code, not an agent
  if (!fresh.length) { dry++; continue }
  dry = 0; fresh.forEach(b => seen.add(key(b)))
  const judged = await parallel(fresh.map(b => () =>           // every fresh bug judged concurrently...
    parallel(['correctness','security','repro'].map(lens => () =>   // ...each by 3 distinct lenses
      agent(\`Judge "\${b.desc}" via the \${lens} lens — real?\`, {phase: 'Verify', schema: VERDICT})))
      .then(vs => ({ b, real: vs.filter(Boolean).filter(v => v.real).length >= 2 }))))
  confirmed.push(...judged.filter(v => v.real).map(v => v.b))
}
return confirmed
// dedup vs \`seen\`, NOT \`confirmed\` — else judge-rejected findings reappear every round and it never converges.
\`\`\`

**质量模式**——常见形态；按任务选择并自由组合：

- **对抗性验证**：每个发现生成 N 个独立怀疑者，每个都被要求去**反驳**。若 ≥ 多数人反驳则淘汰。防止貌似合理但错误的发现幸存。

\`\`\`js
const votes = await parallel(Array.from({length: 3}, () => () =>
  agent(\`Try to refute: \${claim}. Default to refuted=true if uncertain.\`, {schema: VERDICT})))
const survives = votes.filter(Boolean).filter(v => !v.refuted).length >= 2
\`\`\`

- **视角多样性验证**：当一个发现可能以多种方式失败时，给每个验证者一个不同的视角（正确性、安全性、性能、是否可复现），而非 N 个相同的反驳者——多样性能捕获冗余无法发现的失败模式。
- **评审团**：从不同角度生成 N 个独立尝试（如 MVP 优先、风险优先、用户优先），用并行评委打分，从获胜者中综合，同时嫁接次优方案中的最佳想法。当解决方案空间宽泛时优于单次迭代尝试。
- **循环至干涸**：对于未知大小的发现（bug、问题、边缘案例），持续生成查找器直到连续 K 轮无新发现。简单计数器（while count < N）会错过尾部。
- **多模态扫描**：并行代理各自以不同方式搜索（按容器、按内容、按实体、按时间）。每个都对其他人发现的内容盲目；当一种搜索角度无法找到所有内容时很有用。
- **完整性批评者**：最后一个代理询问"缺少什么——未运行的模态、未验证的主张、未读的来源？"它找到的内容成为下一轮工作。
- **不要静默截断**：如果工作流限制了覆盖范围（top-N、无重试、采样），用 \`log()\` 记录被丢弃的内容——静默截断读起来像"覆盖了一切"，实际上没有。

**按用户要求缩放。** "find any bugs" → 少量查找器，单票验证。"thoroughly audit this" 或 "be comprehensive" → 更大的查找器池，3-5 票对抗性通过，综合阶段。不确定时，研究/审查/审计请求倾向于详尽，快速检查倾向于简洁。

这些模式并不穷举——当任务需要时组合新颖的框架（锦标赛括号、自修复循环、分阶段升级，无论什么合适的）。

**对于需要控制流确定性（循环、条件、扇出）而非模型驱动的多步骤编排，使用此工具。**

## 恢复

工具结果包含 runId。在暂停、终止或脚本编辑后恢复，用 \`Workflow({scriptPath, resumeFromRunId})\` 重新启动——agent() 调用中最长的未更改前缀立即返回缓存结果；第一个编辑/新调用及其后的所有内容实时运行。相同脚本 + 相同 args → 100% 缓存命中。Date.now()/Math.random()/new Date() 在脚本中不可用（会破坏此机制）——在工作流返回后标注结果，或通过 args 传入时间戳。当没有日志可用时的回退方案：在转录目录中读取 agent-<id>.jsonl 文件，手动编写续写脚本。
`

export function registerUltracodeSkill(): void {
  registerBundledSkill({
    name: 'ultracode',
    description:
      '进入多代理工作流编排模式：何时使用 Workflow 工具、脚本原语、质量模式、确定性约束、恢复/预算以及文件/命令。',
    whenToUse:
      '当任务可以分解或并行化、需要多视角置信度（如先查找再对抗性验证）、超出单个上下文（大型迁移、广泛审计、长尾枚举）或需要恢复/可审计性时——使用 Workflow 工具编排多个子代理。',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = ULTRACODE_PROMPT
      if (args) {
        prompt += `\n## 用户输入\n\n${args}\n`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
