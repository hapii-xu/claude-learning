# Claude API 完整学习指南

> 本文档结合 [Anthropic 官方文档](https://platform.claude.com/docs) 与 Claude Code 源码（`src/services/api/claude.ts`、`src/utils/messages.ts`、`src/utils/thinking.ts`），系统梳理扩展思考、自适应思考、Thinking vs Tool、多轮对话 messages 传递、Effort 参数、任务预算、快速模式、结构化输出、引用、批处理、搜索结果、流式拒绝、多语言支持、流式传输等核心概念。

---

====================目录====================

1. [扩展思考（Extended Thinking）](#一扩展思考extended-thinking)
2. [自适应思考（Adaptive Thinking）](#二自适应思考adaptive-thinking)
3. [Thinking vs Tool 的本质区别](#三thinking-vs-tool-的本质区别)
4. [多轮对话 messages 传递机制](#四轮对话-messages-传递机制)
5. [Effort 参数完全指南](#五effort-参数完全指南)
6. [任务预算（Task Budgets）完全学习指南](#六任务预算task-budgets完全学习指南)
7. [快速模式（Fast Mode）完全学习指南](#七快速模式fast-mode完全学习指南)
8. [结构化输出（Structured Outputs）完全学习指南](#八结构化输出structured-outputs完全学习指南)
9. [引用（Citations）完全学习指南](#九引用citations完全学习指南)
10. [批处理（Message Batches API）完全学习指南](#十批处理message-batches-api完全学习指南)
11. [搜索结果（Search Results）完全学习指南](#十一搜索结果search-results完全学习指南)
12. [流式传输拒绝（Streaming Refusal）完全学习指南](#十二流式传输拒绝streaming-refusal完全学习指南)
13. [多语言支持（Multilingual Support）完全学习指南](#十三多语言支持multilingual-support完全学习指南)
14. [流式传输消息（Streaming Messages）](#十四流式传输消息streaming-messages)

---

====================一、扩展思考（Extended Thinking）====================

## 1.1 核心概念

扩展思考让 Claude 在给出最终答案前，先创建 `thinking` 内容块输出其内部推理过程。Claude 会在生成最终响应之前整合这些推理中的洞察。

## 1.2 三种思考模式

### ThinkingConfig 类型定义（`src/utils/thinking.ts` 第 11–14 行）

```ts
export type ThinkingConfig =
  | { type: 'adaptive' }                      // 自适应（新模型推荐）
  | { type: 'enabled'; budgetTokens: number } // 手动（已弃用）
  | { type: 'disabled' }                      // 禁用
```

### 各模型支持情况

| 模型 | 手动 (`enabled` + `budget_tokens`) | 自适应 (`adaptive`) | 禁用 (`disabled`) |
|------|------|------|------|
| **Claude Fable 5 / Mythos 5** | ❌ 400 错误 | ✅ **始终强制开启** | ❌ 不支持 |
| **Claude Mythos Preview** | ✅ 可用 | ✅ 默认模式 | ❌ 不支持 |
| **Claude Opus 4.8** | ❌ 400 错误 | ✅ **唯一支持** | ✅ 需显式设置 |
| **Claude Opus 4.7** | ❌ 400 错误 | ✅ **唯一支持** | ✅ 需显式设置 |
| **Claude Opus 4.6** | ⚠️ **已弃用** | ✅ 推荐 | ✅ |
| **Claude Sonnet 4.6** | ⚠️ **已弃用** | ✅ 推荐 | ✅ |
| **Opus 4.5 / Haiku 4.5 / 更早** | ✅ **唯一选择** | ❌ 不支持 | ✅ |

## 1.3 源码实现：如何决定使用哪种模式

**`claude.ts` 第 1932–1962 行**：

```ts
const hasThinking =
  thinkingConfig.type !== 'disabled' &&
  !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_THINKING)

if (hasThinking && modelSupportsThinking(options.model)) {
  if (
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING) &&
    modelSupportsAdaptiveThinking(options.model)
  ) {
    // 优先走这里（新模型）
    thinking = { type: 'adaptive' }
  } else {
    // 老模型的 fallback
    let thinkingBudget = getMaxThinkingTokensForModel(options.model)
    if (thinkingConfig.type === 'enabled' && thinkingConfig.budgetTokens !== undefined) {
      thinkingBudget = thinkingConfig.budgetTokens
    }
    thinkingBudget = Math.min(maxOutputTokens - 1, thinkingBudget)
    thinking = { budget_tokens: thinkingBudget, type: 'enabled' }
  }
}
```

**关键设计**：
1. adaptive 优先：新模型默认走 adaptive
2. budget 兜底：`Math.min(maxOutputTokens - 1, thinkingBudget)` 保证 budget < max_tokens
3. 环境变量逃生口：`CLAUDE_CODE_DISABLE_THINKING`、`CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING`

## 1.4 模型支持判断

### `modelSupportsThinking`（`src/utils/thinking.ts` 第 91–111 行）

```ts
export function modelSupportsThinking(model: string): boolean {
  const canonical = getCanonicalName(model)
  const provider = getAPIProvider()
  // 1P 和 Foundry：所有 Claude 4+ 模型（含 Haiku 4.5）
  if (provider === 'foundry' || provider === 'firstParty') {
    return !canonical.includes('claude-3-')
  }
  // 3P (Bedrock/Vertex)：只支持 Opus 4+ 和 Sonnet 4+
  return canonical.includes('sonnet-4') || canonical.includes('opus-4')
}
```

### `modelSupportsAdaptiveThinking`（第 114–149 行）

```ts
export function modelSupportsAdaptiveThinking(model: string): boolean {
  const canonical = getCanonicalName(model)
  // 显式白名单
  if (
    canonical.includes('opus-4-7') ||
    canonical.includes('opus-4-6') ||
    canonical.includes('sonnet-4-6')
  ) {
    return true
  }
  // 新模型（Fable 5/Mythos 5/Opus 4.8）走"未知模型默认 true"分支
  const provider = getAPIProvider()
  return provider === 'firstParty' || provider === 'foundry'
}
```

## 1.5 流式思考处理

**`claude.ts` 第 2395–2402 行**：`content_block_start` 处理 thinking

```ts
case 'thinking':
  contentBlocks[part.index] = {
    ...part.content_block,
    thinking: '',     // 清空 SDK 自带的初始值（避免重复）
    signature: '',    // 初始化 signature 防止 signature_delta 丢失
  }
  break
```

**流式事件序列**：
```
content_block_start (type: thinking)
  ↓
content_block_delta (type: thinking_delta)   ← 思考内容增量
  ↓
content_block_delta (type: signature_delta)  ← 加密签名
  ↓
content_block_stop
```

## 1.6 响应格式

### 无 thinking

```json
{
  "content": [
    { "type": "text", "text": "27 × 453 = 12,231" }
  ]
}
```

### 有 thinking（display: summarized）

```json
{
  "content": [
    {
      "type": "thinking",
      "thinking": "27×453，先算 27×400=10800，再算 27×53=1431，合计 12231",
      "signature": "EosnCkYICxIM..."
    },
    { "type": "text", "text": "27 × 453 = 12,231" }
  ]
}
```

### 有 thinking（display: omitted）

```json
{
  "content": [
    {
      "type": "thinking",
      "thinking": "",                          ← 空字符串
      "signature": "EosnCkYICxIM..."            ← 但签名仍在
    },
    { "type": "text", "text": "27 × 453 = 12,231" }
  ]
}
```

### thinking 关键字段

| 字段 | 含义 |
|------|------|
| `thinking` | 思考文本（摘要/空/完整） |
| `signature` | 加密签名，用于多轮验证 |
| `type: "thinking"` | 块类型标识 |

## 1.7 thinking 与 temperature 互斥

**`claude.ts` 第 2019–2022 行**：

```ts
// 启用 thinking 时 API 要求 temperature: 1，这已经是默认值
const temperature = !hasThinking
  ? (options.temperatureOverride ?? 1)
  : undefined
```

**关键**：thinking 开启时，`temperature` 字段根本不发送。

## 1.8 交错思考（Interleaved Thinking）

启用后，Claude 能在工具调用之间思考——每次收到 tool_result 后产生新的 thinking 块。新模型（4.6+）配合 adaptive 自动启用。

### 不使用交错思考

```
Turn 1: [thinking] + [tool_use: calculator]
  ↓ tool result: "7500"
Turn 2: [tool_use: database_query]            ← 无 thinking
  ↓ tool result: "5200"
Turn 3: [text] "收入 $7,500，比平均高 44%"     ← 无 thinking
```

### 使用交错思考

```
Turn 1: [thinking] + [tool_use: calculator]
  ↓ tool result: "7500"
Turn 2: [thinking] + [tool_use: database_query] ← 有 thinking
  ↓ tool result: "5200"
Turn 3: [thinking] + [text] "收入 $7,500..."    ← 有 thinking
```

## 1.9 思考块保留规则

- 工具使用时，**必须**将 thinking 块原样传回 API
- `redacted_thinking` 块也要传回（容易被漏掉）
- 不能修改/重排 thinking 块的序列
- 修改会得到 400 错误：`thinking blocks cannot be modified`

### 源码保证（`messages.ts` 第 728–738 行）

```ts
return {
  ...contentBlock,
  ...(i === message.message!.content!.length - 1 &&
  contentBlock.type !== 'thinking' &&           // ← thinking 块
  contentBlock.type !== 'redacted_thinking' &&  // ← 和 redacted 块
    ? enablePromptCaching
      ? { cache_control: getCacheControl({ querySource }) }
      : {}
    : {}),
}
```

**关键**：thinking / redacted_thinking 块**不加 cache_control 标记**（但随消息被缓存）。

## 1.10 display 字段（summarized vs omitted）

| 值 | 行为 | 默认模型 |
|------|------|------|
| `"summarized"` | 返回思考摘要 | Claude 4 模型（Opus 4.6、Sonnet 4.6 等）|
| `"omitted"` | 返回空 thinking + signature | Fable 5/Mythos 5/Opus 4.8/Opus 4.7/Mythos Preview |

**Claude Code 实现**：未显式设置，让 API 使用各模型默认值。

## 1.11 思考加密（signature）

- 完整思考内容被加密成 signature
- 多轮对话时**必须原样传回**
- API 解密 signature 验证"这确实是 Claude 的思考"
- signature 字段不透明，不要解析
- 跨平台兼容（Claude API / Bedrock / Vertex）

## 1.12 思考 vs 缓存的交互

- **切换 thinking 参数**会让消息缓存失效
- 系统提示和工具定义**仍然保持缓存**
- Opus 4.5+ / Sonnet 4.6+ 默认保留之前回合的 thinking 块
- 老模型（Opus 4.5 之前、所有 Haiku）剥离之前的 thinking 块

## 1.13 定价

| 项目 | 计费 |
|------|------|
| 思考 token | 输出 token（按原价） |
| 保留的思考块 | 输入 token（缓存价） |
| 摘要 token | **不收费** |
| signature | 不额外收费 |

**关键**：使用摘要式思考时，计费的输出 token ≠ 看到的 token。要付费给 Claude 的完整思考。

通过 `usage.output_tokens_details.thinking_tokens` 查看实际思考量。

## 1.14 关键学习地图

```
用户输入
  ↓
[thinking.ts] modelSupportsThinking() → 是否支持思考
  ↓           modelSupportsAdaptiveThinking() → 用 adaptive 还是 budget
[claude.ts:1932-1962] 构建 thinking 参数
  ↓
[claude.ts:2019-2022] 决定是否发 temperature
  ↓
[claude.ts:2029-2058] 发送 API 请求
  ↓
[流式响应]
  ├── content_block_start (thinking) → 初始化空 thinking + signature
  ├── content_block_delta (thinking_delta) → 累积到 thinking 字段
  ├── content_block_delta (signature_delta) → 累积到 signature 字段
  └── content_block_stop
  ↓
[消息历史保存] → thinking 块原样保留在 AssistantMessage 中
  ↓
[下一轮 API 调用]
  ↓
[messages.ts:702-753] assistantMessageToMessageParam
  ├── 原样传回 thinking / redacted_thinking 块
  └── 不给 thinking 块加 cache_control
  ↓
[claude.ts:1572] normalizeMessagesForAPI → 不修改 thinking 块内容
  ↓
发送给 API，保持推理连续性
```

---

====================二、自适应思考（Adaptive Thinking）====================

## 2.1 核心定位

自适应思考是 Opus 4.6+ 使用扩展思考的**推荐方式**。模型自行决定何时思考、思考多深，无需手动设 `budget_tokens`。

## 2.2 关键特性

1. **自动启用交错思考**：模型可在工具调用之间思考，agent 工作流特别有效
2. **配合 effort 参数**：effort 成为控制思考深度的推荐方式
3. **无需 beta 头**：直接在请求中设置 `thinking: {type: "adaptive"}`

## 2.3 各模型行为差异

| 模型 | 行为 |
|------|------|
| Fable 5 / Mythos 5 | 思考**始终开启**，无法禁用。`thinking: {type: "disabled"}` 被拒绝 |
| Mythos Preview | 默认模式。`thinking: {type: "disabled"}` 被拒绝 |
| Opus 4.8 / Opus 4.7 | 唯一支持模式。必须显式设 `adaptive`，否则思考关闭 |
| Opus 4.6 / Sonnet 4.6 | 推荐模式。仍可用 budget_tokens（但已弃用）|

## 2.4 使用示例

```json
{
  "model": "claude-opus-4-8",
  "max_tokens": 16000,
  "thinking": { "type": "adaptive" },
  "messages": [
    { "role": "user", "content": "Explain why the sum of two even numbers is always even." }
  ]
}
```

## 2.5 与 effort 参数结合

| effort 级别 | 思考行为 |
|-----------|---------|
| `max` | 始终思考，无深度限制 |
| `xhigh` | 始终深度思考 + 扩展探索 |
| `high`（默认）| 几乎总是思考 |
| `medium` | 适度思考，简单查询可能跳过 |
| `low` | 最小化思考，简单任务跳过 |

```json
{
  "model": "claude-opus-4-8",
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "medium" },
  "messages": [...]
}
```

## 2.6 与手动模式对比

| 维度 | adaptive | enabled (budget_tokens) |
|------|----------|---------|
| 控制方式 | 模型自决 + effort 引导 | 硬编码 token 预算 |
| 交错思考 | 自动启用 | 需要 beta 头（且 Opus 4.6 不支持）|
| 状态 | 推荐 | 已弃用 |
| 延迟 | 更灵活 | 更可预测 |
| 适合场景 | agent、复杂推理 | 需要精确成本控制 |

## 2.7 切换思考模式的缓存影响

- 连续 `adaptive` 请求保留缓存断点
- `adaptive` 和 `enabled`/`disabled` 之间切换**破坏消息缓存**
- 系统提示和工具定义**始终缓存**

## 2.8 验证变更的灵活性

adaptive 模式下，之前的 assistant 轮次**不需要**以 thinking 块开头。这比手动模式更灵活（手动模式强制要求启用 thinking 的轮次必须以 thinking 块开头）。

## 2.9 通过提示调整思考行为

**减少思考**（系统提示）：
```
Extended thinking adds latency and should only be used when it
will meaningfully improve answer quality — typically for problems
that require multi-step reasoning. When in doubt, respond directly.
```

**鼓励思考**：
```
This task involves multi-step reasoning. Think carefully before responding.
```

**逐消息引导**（用户消息末尾）：
- "Please think hard before responding." → 鼓励思考
- "Answer directly without deliberating." → 抑制思考

## 2.10 演进时间线

```
Claude 3      Claude 4.0-4.5     Claude 4.6      Claude 4.7+     Fable5/Mythos5
  │              │                 │                │                  │
  │         手动模式唯一         手动+自适应      仅自适应         强制自适应
  │         budget_tokens     (手动已弃用)    (硬拒绝手动)     (无法禁用)
  │                              │                │                  │
  ▼                              ▼                ▼                  ▼
[无思考] ──→ [手动模式时代] ──→ [过渡期] ──→ [adaptive 时代] ──→ [思考强制]
```

---

====================三、Thinking vs Tool 的本质区别====================

## 3.1 一句话定位

| 概念 | 本质 | 类比 |
|------|------|------|
| **thinking** | 模型**内部**的推理过程 | 你心算时脑子里的"内心独白" |
| **tool** | 模型**外部**的函数/服务 | 你拿出计算器按数字 |
| **text** | 模型最终输出给你的答案 | 你把答案说出口 |

**核心区分**：thinking 是模型**自己**在想，tool 是模型**调用外部**能力。

## 3.2 四种场景对比

### 场景 A：不开 thinking，不开 tool

```
你：27 * 453 = ?
模型 → text: "27 × 453 = 12,231"
```

模型直接心算给你答案。

### 场景 B：不开 thinking，开乘法 tool

```
你：27 * 453 = ?
模型 → tool_use: { name: "multiply", input: { a: 27, b: 453 } }
  ↓
[你的代码执行乘法，返回 12231]
  ↓
模型 → text: "27 × 453 = 12,231"
```

模型不自己算，调用工具拿到结果。

### 场景 C：开 thinking，开乘法 tool

```
你：27 * 453 = ?
模型 → thinking: "用户问乘法。我有 multiply 工具，让我调用它"
     → text: "让我用计算器算一下"
     → tool_use: { name: "multiply", input: { a: 27, b: 453 } }
  ↓
[工具返回 12231]
  ↓
模型 → thinking: "工具返回 12231，这就是最终答案"
     → text: "27 × 453 = 12,231"
```

模型先思考要调用什么工具，然后调用，再思考结果。这就是**交错思考**。

### 场景 D：开 adaptive thinking，开乘法 tool

```
你：27 * 453 = ?
模型（可能完全不思考，取决于 adaptive 判断）
  → tool_use: { ... }
  ↓
[工具返回]
  ↓
模型 → text: "27 × 453 = 12,231"
```

adaptive 模式下模型自己决定要不要思考。

## 3.3 Thinking 与 Tool 核心区别对照表

| 维度 | Thinking | Tool |
|------|----------|------|
| **来源** | 模型自身产生 | 你定义的外部函数 |
| **执行者** | 模型"脑内" | 你的代码 / 外部服务 |
| **可见性** | 响应里的 `thinking` 块 | 响应里的 `tool_use` 块 |
| **成本** | 算 output tokens（要付费） | 不算模型 tokens，但你的代码执行有成本 |
| **内容** | 自然语言推理 | JSON 格式的参数 |
| **能否篡改** | 由 signature 加密保护 | 你能看到/修改 input/output |
| **多轮对话** | 必须原样传回（保持推理连续性） | 用 tool_result 传回结果 |

## 3.4 一张图看清楚关系

```
          用户提问
              ↓
        ┌─────────────┐
        │  Claude 模型  │ ← 模型"自己"在这里思考
        └─────────────┘
              ↓
     ┌────────┴────────┐
     │                 │
     ▼                 ▼
[模型决定自己算]    [模型决定用工具]
     │                 │
     ▼                 ▼
 thinking 块       tool_use 块
 "我要心算..."     "请调用 multiply(a=27,b=453)"
     │                 │
     │                 ↓
     │            你的代码执行
     │                 │
     │                 ▼
     │            tool_result
     │            { result: 12231 }
     │                 │
     ▼                 ▼
    思考可能继续（交错思考）
     "工具说 12231，这就是答案"
     │
     ▼
  text 块
  "27 × 453 = 12,231"
```

## 3.5 直观类比

把 Claude 想象成一个**坐在房间里的人**：

- **thinking** = 这个人**脑子里想**（"这个问题要用乘法…"）
- **tool** = 这个人桌上的**计算器、天气 APP、电脑**等工具
- **text** = 这个人**说给你听**的话
- **tool_use** = 这个人**伸手去拿计算器**的动作
- **tool_result** = 计算器屏幕上显示的**数字**

## 3.6 常见问答

### Q：thinking 是模型"自己"思考的吗？

**是的**。thinking 块是 Claude 模型在生成回答时，"脑内"产生的推理链，不依赖任何外部工具。

### Q：signature 字段是干什么的？

**加密防伪**。API 把模型的完整思考加密成 signature，多轮对话时你必须原样传回，API 用来验证思考没被篡改。

### Q：为什么 thinking 文本有时是空的？

两种情况：
1. `display: "omitted"` 模式：为低延迟跳过思考文本
2. adaptive 模式下模型决定不思考

### Q：tool 是模型的一部分吗？

**不是**。tool 是你定义的（name、description、input_schema），你实现执行逻辑，模型只负责"决定调用什么参数"。

---

====================四、多轮对话 messages 传递机制====================

## 4.1 三个核心概念

### 1. messages 是**累积的数组**

每次 API 调用，都要把**整段对话历史**传过去，不是只传"刚才那一句"。

### 2. role 只有两种

- `user`：用户那边来的东西（包括用户输入 + **工具返回结果**）
- `assistant`：Claude 输出的东西（thinking + text + tool_use 都打包在这里）

**反直觉的点**：`tool_result` 的 role 是 `user`！因为 API 把工具结果视为"环境给用户的反馈"。

### 3. content 可以是字符串或数组

- 简单文本：`content: "你好"`
- 多种块混合：`content: [{type: "thinking", ...}, {type: "text", ...}, {type: "tool_use", ...}]`

## 4.2 完整走一遍：三轮对话

### 🔵 第 1 次 API 调用：用户提问

**发送**：
```json
{
  "model": "claude-opus-4-8",
  "max_tokens": 16000,
  "thinking": { "type": "adaptive" },
  "tools": [{
    "name": "multiply",
    "description": "乘法计算器",
    "input_schema": {
      "type": "object",
      "properties": {
        "a": { "type": "number" },
        "b": { "type": "number" }
      },
      "required": ["a", "b"]
    }
  }],
  "messages": [
    { "role": "user", "content": "27 * 453 = ?" }
  ]
}
```

**响应**：
```json
{
  "content": [
    {
      "type": "thinking",
      "thinking": "用户问乘法。我有 multiply 工具，让我调用它。",
      "signature": "EosnCkYICxIM..."
    },
    { "type": "text", "text": "让我用计算器算一下" },
    {
      "type": "tool_use",
      "id": "toolu_01ABC",
      "name": "multiply",
      "input": { "a": 27, "b": 453 }
    }
  ],
  "stop_reason": "tool_use"
}
```

### 🟢 第 2 次 API 调用：工具结果回传

你的代码执行了 multiply(27, 453) = 12231。

**发送**：
```json
{
  "model": "claude-opus-4-8",
  "messages": [
    { "role": "user", "content": "27 * 453 = ?" },
    {
      "role": "assistant",
      "content": [
        { "type": "thinking", "thinking": "用户问乘法...", "signature": "Eos..." },
        { "type": "text", "text": "让我用计算器算一下" },
        { "type": "tool_use", "id": "toolu_01ABC", "name": "multiply", "input": { "a": 27, "b": 453 } }
      ]
    },
    {
      "role": "user",
      "content": [
        { "type": "tool_result", "tool_use_id": "toolu_01ABC", "content": "12231" }
      ]
    }
  ]
}
```

**messages 数组现在有 3 条**：
1. 第一条 user：原始问题
2. 第二条 assistant：Claude 上次的完整响应（**thinking + text + tool_use 全包**）
3. 第三条 user：工具执行结果（用 `tool_use_id` 关联到对应的 tool_use）

**响应**：
```json
{
  "content": [
    { "type": "thinking", "thinking": "工具返回了 12231...", "signature": "XyZ..." },
    { "type": "text", "text": "27 × 453 = 12,231" }
  ],
  "stop_reason": "end_turn"
}
```

### 🔵 第 3 次 API 调用：用户继续问

用户又问："再除以 3 呢？"

**发送**：
```json
{
  "model": "claude-opus-4-8",
  "messages": [
    { "role": "user", "content": "27 * 453 = ?" },
    { "role": "assistant", "content": [...] },
    { "role": "user", "content": [{ "type": "tool_result", ... }] },
    { "role": "assistant", "content": [...] },
    { "role": "user", "content": "再除以 3 呢？" }    ← 新提问追加在最后
  ]
}
```

## 4.3 messages 数组的增长图

```
调用次数   messages 数组内容
──────────────────────────────────────────────
  1       [user1]
          
  2       [user1, assistant1, user2(tool_result)]
          
  3       [user1, assistant1, user2(tool_result), assistant2, user3]
          
  4       [user1, assistant1, user2, assistant2, user3, assistant3, user4(tool_result)]
          
          用户输入 → user
          AI 响应 → assistant（含 thinking/text/tool_use 全部块）
          工具结果 → user（用 tool_result 块）
```

## 4.4 各块类型归属

| 块类型 | 放在哪个 role 下 | 何时出现 |
|--------|------------------|---------|
| `thinking` | **assistant** | AI 响应里，必须原样回传 |
| `text` | **assistant** | AI 响应里，正常文本输出 |
| `tool_use` | **assistant** | AI 响应里，请求调用工具 |
| `tool_result` | **user** | 工具执行完后，作为"用户反馈"回传 |

**关键**：API 响应里的 `content` 是个数组。**回传时把整个 content 数组塞进 assistant 消息里**：

```javascript
const response = await client.messages.create({ messages: [...] })

// 下一轮：把整个响应塞回去
messages.push({
  role: "assistant",
  content: response.content    // ← 包含 thinking + text + tool_use 全部块
})
```

## 4.5 完整 agent 循环伪代码

```javascript
const messages = []

// 用户第一次提问
messages.push({ role: "user", content: "27 * 453 = ?" })

while (true) {
  const response = await client.messages.create({
    model: "claude-opus-4-8",
    thinking: { type: "adaptive" },
    tools: [multiplyTool],
    messages: messages    // ← 把累积的整段对话传过去
  })
  
  // 把 AI 的响应（整个 content 数组）加回 messages
  messages.push({
    role: "assistant",
    content: response.content    // 包含 thinking + text + tool_use
  })
  
  // 如果 stop_reason 不是 tool_use，说明 AI 说完了
  if (response.stop_reason !== "tool_use") break
  
  // 否则提取 tool_use 块，执行工具
  for (const block of response.content) {
    if (block.type === "tool_use") {
      const result = executeTool(block.name, block.input)   // 你的代码
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: block.id,
          content: String(result)
        }]
      })
    }
  }
}
```

## 4.6 messages 数组结构图

```
┌─────────────────────────────────────────────────────┐
│              messages 数组（累积）                    │
├─────────────────────────────────────────────────────┤
│ [0] role: user                                      │
│     content: "27 * 453 = ?"                         │  ← 第 1 次调用
├─────────────────────────────────────────────────────┤
│ [1] role: assistant                                 │
│     content: [                                      │
│       {type: "thinking", ...},   ← 思考             │
│       {type: "text", ...},       ← 文本             │  ← 第 1 次响应
│       {type: "tool_use", ...}    ← 请求工具         │
│     ]                                               │
├─────────────────────────────────────────────────────┤
│ [2] role: user                                      │
│     content: [{                                     │
│       type: "tool_result",       ← 工具结果         │  ← 你的代码执行
│       tool_use_id: "toolu_01ABC",                   │
│       content: "12231"                              │
│     }]                                              │
├─────────────────────────────────────────────────────┤
│ [3] role: assistant                                 │
│     content: [                                      │
│       {type: "thinking", ...},                      │  ← 第 2 次响应
│       {type: "text", ...}                           │
│     ]                                               │
├─────────────────────────────────────────────────────┤
│ [4] role: user                                      │
│     content: "再除以 3 呢？"                        │  ← 用户继续问
├─────────────────────────────────────────────────────┤
│ ...继续累积...                                      │
└─────────────────────────────────────────────────────┘
```

## 4.7 常见误区

### ❌ 每次只传最新一条消息
**正确**：每次都要传完整对话历史（messages 数组累积增长）。

### ❌ thinking 块可以省略或修改
**正确**：thinking 块（含 signature）**必须原样传回**，否则 400 错误。

### ❌ tool_result 应该放在 assistant 里
**正确**：tool_result 放在 `role: "user"` 里（API 把它视为"环境反馈"）。

### ❌ text 块需要单独处理
**正确**：text 块就是 assistant 消息的一部分，和其他块一起打包进 content 数组。

### ❌ 响应里只有 text 才重要
**正确**：thinking、text、tool_use 都很重要，**回传时缺一不可**。

---

====================五、Effort 参数完全指南====================

## 5.1 核心定位

**Effort 控制 Claude 在"所有输出"上花多少力气**——不只是思考（thinking），还包括文本（text）、工具调用（tool_use）、甚至工具调用的次数。

**类比**：
- `thinking` = 是否让 Claude 有"内心独白"
- `effort` = Claude **整体**花多大劲（包括思考、写文字、调用工具）
- `max_tokens` = Claude 输出的**硬上限**

## 5.2 三个参数对比

### ❓ effort vs thinking

| 维度 | thinking | effort |
|------|----------|--------|
| **控制范围** | 只控制"思考"行为 | 控制**所有** token 消耗 |
| **是否影响 text** | 不影响 | ✅ 影响文字详细程度 |
| **是否影响 tool_use** | 不影响 | ✅ 影响工具调用次数 |
| **是否影响 thinking** | ✅ 是主要控制手段 | ✅ 也会影响思考深度 |
| **可否独立使用** | 可单独开 | 可单独用（不需要开 thinking）|

### ❓ effort vs budget_tokens

| 维度 | budget_tokens | effort |
|------|----------------|---------|
| **作用对象** | 只限制 thinking 部分 | 限制**所有**输出 |
| **精确度** | 精确 token 数（硬预算） | 行为信号（软引导） |
| **状态** | 已弃用（新模型拒绝） | 推荐方式 |
| **影响工具调用** | ❌ 不影响 | ✅ 影响 |
| **影响 text** | ❌ 不影响 | ✅ 影响 |

### ❓ effort vs max_tokens

- `max_tokens` = **硬上限**：Claude 输出绝对不能超过
- `effort` = **软引导**：Claude 倾向于用这么多力气，但可以灵活调整

## 5.3 五个 effort 级别详解

| 级别 | 含义 | 思考行为 | 工具调用 | 文本风格 | 适用场景 |
|------|------|---------|---------|---------|---------|
| `max` | 不遗余力 | 几乎总是深度思考 | 多而全 | 详尽 | 真正前沿问题 |
| `xhigh` | 扩展探索 | 深度思考 + 扩展搜索 | 大量、多次迭代 | 详尽 | 长周期 agent、复杂编码（>30 分钟）|
| `high` | **默认值** | 几乎总是思考 | 适量 | 平衡 | 复杂推理、困难编码 |
| `medium` | 平衡 | 适度思考 | 合并操作 | 较简洁 | 日常 agent、工具密集型 |
| `low` | 最省 | 简单问题跳过思考 | 少而精 | 简洁 | 简单查询、子 agent、高吞吐 |

**关键**：
- `high` = 不传 effort 时的默认行为
- `max` 和 `xhigh` 仅新模型（4.6+）支持
- `xhigh` 仅 Fable 5 / Mythos 5 / Opus 4.8 / Opus 4.7 支持

## 5.4 源码实现

### `configureEffortParams`（`claude.ts` 第 486–512 行）

```ts
function configureEffortParams(
  effortValue: EffortValue | undefined,
  outputConfig: BetaOutputConfig,
  extraBodyParams: Record<string, unknown>,
  betas: string[],
  model: string,
): void {
  if (!modelSupportsEffort(model) || 'effort' in outputConfig) return

  if (effortValue === undefined) {
    betas.push(EFFORT_BETA_HEADER)      // 没设 → 加 beta 头让 API 用默认
  } else if (typeof effortValue === 'string') {
    outputConfig.effort = effortValue    // 字符串 → 写到 output_config.effort
    betas.push(EFFORT_BETA_HEADER)
  } else if (process.env.USER_TYPE === 'ant') {
    // 数值 effort（仅内部员工）
    extraBodyParams.anthropic_internal = {
      ...existingInternal,
      effort_override: effortValue,
    }
  }
}
```

### 关键学习点

1. **effort 写到 `output_config.effort` 字段**：
   ```json
   {
     "output_config": { "effort": "medium" }
   }
   ```

2. **需要 beta 头 `EFFORT_BETA_HEADER`** 激活

3. **模型支持检查**：`modelSupportsEffort(model)` 决定

4. **effort 的解析**：`resolveAppliedEffort(options.model, options.effortValue)`（第 1809 行）

## 5.5 请求中的位置

```json
{
  "model": "claude-opus-4-8",
  "max_tokens": 16000,
  "thinking": { "type": "adaptive" },        ← 控制思考
  "output_config": {
    "effort": "medium"                        ← 控制整体强度
  },
  "messages": [...]
}
```

## 5.6 Effort × Thinking 协同

| thinking | effort | 实际行为 |
|----------|--------|---------|
| `disabled` | `low` | 不思考 + 文字简洁 + 少工具 |
| `disabled` | `high` | 不思考 + 文字详尽 + 多工具 |
| `adaptive` | `low` | 简单问题跳过思考，整体简洁 |
| `adaptive` | `high`（默认）| 几乎总是思考 + 平衡输出 |
| `adaptive` | `xhigh` | 深度思考 + 探索性多工具调用 |
| `adaptive` | `max` | 极限思考 + 不限制输出 |

### 具体问题下的表现对比

**问题**：「帮我重构这个函数」

### `effort=low`

```
thinking: (无或很少)
tool_use: [FileReadTool(file)]        ← 只读 1 次
text: "已重构：[简短说明]"            ← 简洁回答
```

### `effort=high`

```
thinking: "先读代码，分析设计问题，再重构..."
tool_use: [FileReadTool, GrepTool, FileEditTool]   ← 多工具
text: "我发现以下问题... [详细分析]... 已重构为... [详细说明]"
```

### `effort=xhigh`

```
thinking: [深度分析]
tool_use: [FileReadTool, GrepTool, FileEditTool, BashTool(test), AgentTool(subagent)...]
          ↑ 多工具 + 子 agent + 测试验证
text: [非常详尽的解释]
```

## 5.7 不同模型上的行为差异

### Opus 4.7 / Opus 4.8（严格遵守 effort）

> Claude Opus 4.7 对 effort 级别的遵循更严格，尤其在 low 和 medium 级别。

设 `low` 就真的少做事，不会"自作多情"。

### Fable 5 / Mythos 5（强制 adaptive thinking + effort 主导）

- thinking 强制开启
- effort 成为**主要调节手段**
- 即使 `low` 也表现很好（超过旧模型的 `xhigh`）

### Sonnet 4.6（推荐 medium）

> Medium effort（推荐默认值）：对大多数应用而言，在速度、成本和性能之间达到最佳平衡。

Sonnet 4.6 用 `high` 可能延迟较高，**默认推荐 `medium`**。

### Opus 4.5 / 更早模型

也支持 effort。但用的是**手动 thinking**（`budget_tokens`），effort 和 `budget_tokens` 协同工作。

## 5.8 实际场景选择

### 场景 1：快速分类任务
```json
{
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "low" }
}
```
简单任务不需要思考，省 token 又快。

### 场景 2：日常 agent 编码
```json
{
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "medium" }
}
```
平衡速度和质量，工具调用合理。

### 场景 3：复杂推理
```json
{
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "high" }    // 或不传，默认就是 high
}
```
质量优先。

### 场景 4：长周期 agent（>30 分钟）
```json
{
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "xhigh" },
  "max_tokens": 64000
}
```
允许大量工具调用 + 子 agent 迭代。**记得把 `max_tokens` 调大**。

### 场景 5：前沿研究问题
```json
{
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "max" },
  "max_tokens": 64000
}
```
不惜代价求最优答案。

## 5.9 Effort 对工具调用的影响

### 低 effort 倾向
- 将多个操作合并为更少的工具调用
- 进行更少的工具调用
- 直接采取行动而无需前言
- 完成后使用简洁的确认消息

### 高 effort 倾向
- 进行更多的工具调用
- 在采取行动之前解释计划
- 提供详细的变更摘要
- 包含更全面的代码注释

**实际应用**：
- **子 agent** 推荐 `low`（节省 + 快速）
- **主 agent** 推荐 `high`（详尽 + 可解释）

## 5.10 常见误区

### ❌ effort 只影响 thinking
**正确**：effort 影响**所有** token（text + tool_use + thinking）。

### ❌ effort 是硬预算
**正确**：effort 是**行为信号**，不是硬限制。

### ❌ 不开 thinking 就不能用 effort
**正确**：effort 可以独立使用。

### ❌ effort=high 和不传 effort 不一样
**正确**：「将 effort 设置为 high 与完全省略 effort 参数会产生完全相同的行为」。

### ❌ 所有模型都支持所有 effort 级别
**正确**：`xhigh` 只有 4 个新模型支持；`max` 也只有部分模型支持。

## 5.11 Ultracode 模式揭秘

文档最后提到 Claude Code 的 **ultracode** 模式：

> ultracode 出现在 Claude Code 的 effort 菜单中，但它不是额外的 API effort 级别。
> 
> Ultracode 将 xhigh effort 级别与允许 Claude Code 启动多智能体工作流的常驻权限相结合。

**本质**：
- `ultracode` = `effort: xhigh` + 多 agent 权限 + system-reminder 提示
- 它不是 API 新特性，而是 Claude Code 的"产品包装"

## 5.12 一张图总结

```
                  ┌─────────────────────────────────────────────┐
                  │            API 请求参数                      │
                  └─────────────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
        ▼                           ▼                           ▼
   ┌─────────┐               ┌────────────┐             ┌────────────┐
   │thinking │               │output_     │             │max_tokens  │
   │         │               │config      │             │            │
   │控制思考  │               │  ┌──────┐  │             │硬上限       │
   │开关/模式│               │  │effort│  │             │(所有输出)  │
   │         │               │  └──────┘  │             │            │
   └─────────┘               │  控制整体   │             └────────────┘
                             │  输出强度   │
                             └────────────┘
                                    │
                                    ▼
                 ┌──────────────────────────────────┐
                 │  影响范围                          │
                 │  ✓ thinking tokens（思考量）        │
                 │  ✓ text tokens（文字详细度）        │
                 │  ✓ tool_use tokens（工具参数详细度） │
                 │  ✓ tool_use 次数（调用频率）        │
                 └──────────────────────────────────┘
```

## 5.13 核心要点速记

| 要点 | 内容 |
|------|------|
| **effort 是什么** | 控制 Claude 整体用力的"软引导" |
| **位置** | `output_config.effort` |
| **默认值** | `high`（不传等于 `high`）|
| **级别** | `low` / `medium` / `high` / `xhigh` / `max` |
| **和 thinking 区别** | thinking 只管思考，effort 管所有 |
| **和 budget_tokens 区别** | budget_tokens 是硬预算（已弃用），effort 是软引导（推荐）|
| **对工具的影响** | 低 effort → 少调用，高 effort → 多调用 |
| **子 agent 推荐** | `low` |
| **主 agent 推荐** | `medium` 或 `high` |
| **长周期 agent** | `xhigh` + 大 `max_tokens` |
| **ultracode 本质** | `xhigh` + 多 agent 权限 |
---

# 六、任务预算（Task Budgets）完全学习指南

## 一、一句话定位

任务预算是给 Claude 的一个"软性建议"：告诉它整个 agent 循环大概能用多少 token，让它自己决定节奏、优先处理重要工作、接近预算时优雅收尾。

**类比：**
- `max_tokens` = 单次请求的硬上限（超过就截断）
- `effort` = 每一步推理的深度（软引导）
- `task_budget` = 整个 agent 循环的总工作量（软建议）

---

## 二、任务预算解决什么问题？

### 场景：长周期 agent 任务

假设你让 Claude 审查一个代码仓库并提出重构计划。**没有任务预算时**：
- Claude 不知道你要它干多少活
- 可能陷入细节无限深挖
- 或者过早结束、只给出浅层结果
- 达到 `max_tokens` 被粗暴截断（而不是优雅收尾）

**有任务预算时**：
- Claude 看到一个实时倒计时（服务端注入）
- 自己调节节奏
- 预算快用完时优雅结束（总结发现、报告进度）
- 不会在中途被截断

---

## 三、与 effort / max_tokens 的区别

| 维度 | max_tokens | effort | task_budget |
|------|-----------|--------|------------|
| 作用范围 | 单个请求 | 每一步推理 | 整个 agent 循环 |
| 限制类型 | 硬上限（强制） | 软引导 | 软建议（非强制） |
| 控制内容 | 输出长度 | 思考深度 + 工具调用详细度 | 总 token 消耗 |
| 超过会怎样 | `stop_reason: "max_tokens"` 截断 | 无惩罚，只是少做事 | 可能偶尔超出 |
| 跨请求 | 每轮独立 | 每轮独立 | 跨请求累积 |

### 三者协同关系

```
整个 agent 循环
  task_budget: 总预算 100k token
  ┌─────────────────────────────┐
  │ 请求 1                      │
  │  effort: high (深度)        │
  │  max_tokens: 64k (单请求上限)│
  └─────────────────────────────┘
  ┌─────────────────────────────┐
  │ 请求 2（工具结果后）         │
  │  effort: high (深度)        │
  │  max_tokens: 64k (单请求上限)│
  └─────────────────────────────┘
  ┌─────────────────────────────┐
  │ 请求 3 ...                  │
  └─────────────────────────────┘
  总消耗 ≤ 100k（建议值，可超）
```

---

## 四、API 请求格式

### 4.1 三个字段

```json
{
  "output_config": {
    "effort": "high",
    "task_budget": {
      "type": "tokens",
      "total": 64000,
      "remaining": 50000
    }
  }
}
```

> `type` 始终为 `"tokens"`；`remaining` 可选，从之前请求结转的剩余预算。

### 4.2 需要 beta 头

```
anthropic-beta: task-budgets-2026-03-13
```

### 4.3 完整请求示例

```json
{
  "model": "claude-opus-4-8",
  "max_tokens": 128000,
  "stream": true,
  "betas": ["task-budgets-2026-03-13"],
  "messages": [{
    "role": "user",
    "content": "Review the codebase and propose a refactor plan."
  }],
  "output_config": {
    "effort": "high",
    "task_budget": { "type": "tokens", "total": 64000 }
  }
}
```

---

## 五、源码实现解析

### 5.1 TaskBudgetParam 类型定义

`claude.ts` 第 513–522 行：

```typescript
// output_config.task_budget —— 让模型感知 API 侧的 token 预算。
// Stainless SDK 类型还没有把 task_budget 加到 BetaOutputConfig 上，因此
// 我们在本地定义线上结构并做类型转换。
type TaskBudgetParam = {
  type: 'tokens'
  total: number
  remaining?: number
}
```

> **关键**：SDK 类型还没支持，需要本地定义。

### 5.2 configureTaskBudgetParams 函数

`claude.ts` 第 524–546 行：

```typescript
export function configureTaskBudgetParams(
  taskBudget: Options['taskBudget'],
  outputConfig: BetaOutputConfig & { task_budget?: TaskBudgetParam },
  betas: string[],
): void {
  if (
    !taskBudget ||
    'task_budget' in outputConfig ||
    !shouldIncludeFirstPartyOnlyBetas()   // ← 仅第一方 provider 支持
  ) {
    return
  }
  outputConfig.task_budget = {
    type: 'tokens',
    total: taskBudget.total,
    ...(taskBudget.remaining !== undefined && {
      remaining: taskBudget.remaining,
    }),
  }
  if (!betas.includes(TASK_BUDGETS_BETA_HEADER)) {
    betas.push(TASK_BUDGETS_BETA_HEADER)
  }
}
```

**学习要点：**

1. **仅第一方 provider 支持**：Bedrock/Vertex 等第三方不支持（`shouldIncludeFirstPartyOnlyBetas()` 闸门）
2. **自动加 beta 头**：不需要用户手动添加
3. **remaining 可选**：只有显式传了才会写到请求体

### 5.3 queryLoop 中的 taskBudgetRemaining 追踪

`query.ts` 第 617–619 行：

```typescript
// task_budget.remaining 跨压缩边界的追踪。首次 compact 触发之前为 undefined
// —— 上下文未压缩时服务端能看到完整历史并自行处理从 {total} 的倒计时。
// compact 之后服务端只看到摘要，会低估消耗；remaining 告诉它被压缩掉的那个
// pre-compact 最终窗口。可跨多次压缩累计。
let taskBudgetRemaining: number | undefined
```

**关键设计：**
- 首次请求不传 `remaining`（让服务端自己算）
- 只有在上下文被**压缩后**才传 `remaining`
- 因为压缩后服务端看不到完整历史了，需要客户端告诉它"之前已经花了多少"

### 5.4 压缩前捕获上下文窗口

`query.ts` 第 982–992 行：

```typescript
// task_budget：在下面 messagesForQuery 被替换为 postCompactMessages
// 之前，捕获压缩前的最终上下文窗口。
if (params.taskBudget) {
  const preCompactContext =
    finalContextTokensFromLastResponse(messagesForQuery)
  taskBudgetRemaining = Math.max(
    0,
    (taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext,
  )
}
```

**逻辑：**
1. 压缩触发时，调用 `finalContextTokensFromLastResponse` 获取上一次 API 响应中的最终上下文窗口大小
2. 从剩余预算中减去这个值
3. 后续请求带着新的 `remaining` 值

### 5.5 finalContextTokensFromLastResponse 的实现

`tokens.ts` 第 82–92 行：

```typescript
/**
 * 从最后一次 API response 的 usage.iterations[-1] 获取最终上下文窗口大小。
 * 用于跨压缩边界计算 task_budget.remaining —
 * 服务端的预算倒计时基于上下文，因此 remaining 按压缩前的
 * 最终窗口递减，而非按计费消耗。
 */
export function finalContextTokensFromLastResponse(
  messages: Message[],
): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (usage) {
      const iterations = (usage as { iterations?: ... }).iterations
      // ...
    }
  }
}
```

**学习要点：**
- 从消息数组**反向**查找最近一条有 `usage` 的消息
- 读取 `usage.iterations[-1]`（服务端工具循环的最终上下文大小）
- 排除 cache tokens（匹配服务端公式）

### 5.6 传递 task_budget 给 queryModel

`query.ts` 第 1277–1284 行：

```typescript
...(params.taskBudget && {
  taskBudget: {
    total: params.taskBudget.total,
    ...(taskBudgetRemaining !== undefined && {
      remaining: taskBudgetRemaining,
    }),
  },
}),
```

**逻辑：**
- 如果有 `taskBudget` → 传给 `queryModel`
- 如果算出了 `remaining` → 一起传
- 否则只传 `total`

---

## 六、预算倒计时如何工作

### 6.1 服务端注入

**倒计时只对模型可见，API 响应里没有剩余预算字段。**

服务端在每轮对话中注入一个预算倒计时标记，显示当前剩余 token。模型看到这个标记后：
- 调整工作节奏
- 预算快用完时优雅结束

### 6.2 客户端无法精确镜像

> 倒计时反映的是 Claude 在当前 agent 循环中已处理的令牌，而不是您在各轮次之间重新发送的令牌。

为什么？因为智能体循环中，客户端每次都会重发完整对话历史：

| 轮次 | 你发送的负载 | Claude 本轮看到的（计入预算） |
|------|------------|--------------------------|
| 1 | ~20 token | 5,000（思考 + tool_use） |
| 2 | ~7,800（历史 + 工具结果） | 6,800（新工具结果 + 新思考） |
| 3 | ~13,000（完整历史 + 新工具结果） | 7,200（新工具结果 + text） |

你发送的累计负载 = 20,820，但**预算只消耗 19,000**。

### 6.3 跨压缩边界传递 remaining

**问题**：上下文压缩后，服务端只看到摘要，不知道之前花了多少预算。

**解决方案**：客户端计算并传递 `remaining`

```json
{
  "output_config": {
    "effort": "high",
    "task_budget": {
      "type": "tokens",
      "total": 128000,
      "remaining": "<128000 - tokensSpentSoFar>"
    }
  }
}
```

源码中的实现（`query.ts` 第 985–991 行）：

```typescript
if (params.taskBudget) {
  const preCompactContext =
    finalContextTokensFromLastResponse(messagesForQuery)
  taskBudgetRemaining = Math.max(
    0,
    (taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext,
  )
}
```

> **注意**：这里用的是上下文窗口大小（不是计费消耗），因为服务端倒计时基于上下文。

---

## 七、任务预算的关键特性

### 7.1 软性建议，非强制上限

> 如果 Claude 正在执行某个操作，而中断该操作比完成它更具破坏性，Claude 可能偶尔会超出预算。

**为什么设计成软性？** 因为 agent 可能在调用关键工具的中途，强行截断会破坏任务完整性。

### 7.2 与 max_tokens 独立

- `max_tokens` 限制单个请求的输出
- `task_budget` 限制整个 agent 循环的总消耗
- 两者**正交**，互不约束

### 7.3 过小预算会导致拒绝行为

> 当 Claude 看到的预算明显不足以完成所要求的工作时，它可能会完全拒绝尝试该任务、大幅缩减任务范围，或者提前停止。

**实例**：给一个需要数小时的编码任务设 20,000 token 预算 → Claude 可能直接拒绝。

> **最佳实践**：`task_budget.total` 最小值为 20,000 token（低于会 400 错误），但实际应该根据任务设置合理值。

---

## 八、支持矩阵

| 模型 | 支持情况 |
|------|---------|
| Claude Fable 5 | ✅ Beta |
| Claude Mythos 5 | ✅ Beta |
| Claude Opus 4.8 | ✅ Beta |
| Claude Opus 4.7 | ✅ Beta |
| Claude Opus 4.6 | ❌ 不支持 |
| Claude Sonnet 4.6 | ❌ 不支持 |
| Claude Haiku 4.5 | ❌ 不支持 |

> **注意**：Claude Code CLI 和 Cowork UI 不支持任务预算。只能通过 API 直接使用。

---

## 九、如何选择合适的预算

### 9.1 先测量，再设定

文档推荐：**先不设 `task_budget`**，跑一组代表性任务，记录总 token 消耗。

```typescript
async function runTaskAndCountTokens(messages) {
  let totalSpend = 0
  while (true) {
    const response = await client.beta.messages
      .stream({ model: "claude-opus-4-8", max_tokens: 128000, messages, tools })
      .finalMessage()
    totalSpend += response.usage.output_tokens
    if (response.stop_reason === "end_turn") return totalSpend
    messages = [
      ...messages,
      { role: "assistant", content: response.content },
      { role: "user", content: runTools(response.content) }
    ]
  }
}
```

统计：看 **p99（99 分位）** 的 token 消耗，作为 `task_budget` 的起点。

### 9.2 实际场景推荐

| 任务类型 | 建议预算 |
|---------|---------|
| 快速分类 / 简单查询 | 20,000 – 40,000 |
| 单文件代码重构 | 40,000 – 80,000 |
| 跨文件 agent 编码 | 80,000 – 200,000 |
| 大型代码库审查 | 200,000 – 500,000 |
| 探索性研究任务 | 不设（让 effort 控制） |

---

## 十、与其他参数的交互

### 10.1 与 effort 的关系

- `effort` 控制每一步推理的**深度**
- `task_budget` 控制整个循环的**总工作量**
- **互补**：effort 调节深度，task_budget 调节广度

### 10.2 与 adaptive thinking 的关系

`task_budget` 把思考 token 计入总数。随着预算消耗，adaptive thinking 自然缩减规模（模型看到剩余预算变少，会减少思考）。

### 10.3 与 prompt caching 的关系

> ⚠️ **冲突**：如果你每轮递减 `task_budget.remaining`，这个变化会使缓存前缀失效。

**最佳实践：**
- 初始请求设置一次预算
- 让模型根据服务端倒计时自我调节
- **不要每轮都改 `remaining`**

**例外**：上下文压缩后必须传 `remaining`（否则服务端会重置倒计时）。

---

## 十一、完整 agent 循环示例

```typescript
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()
const messages = [{ role: 'user', content: 'Audit this repo for security issues.' }]

// 设置任务预算：整个循环最多用 100k token
let taskBudgetTotal = 100000
let taskBudgetRemaining: number | undefined

while (true) {
  const response = await client.beta.messages.stream({
    model: 'claude-opus-4-8',
    max_tokens: 128000,
    messages,
    tools: [{ name: 'bash', /* ... */ }],
    betas: ['task-budgets-2026-03-13'],
    output_config: {
      effort: 'high',
      task_budget: {
        type: 'tokens',
        total: taskBudgetTotal,
        ...(taskBudgetRemaining !== undefined && { remaining: taskBudgetRemaining })
      }
    }
  }).finalMessage()

  if (response.stop_reason === 'end_turn') {
    console.log('任务完成')
    break
  }

  if (response.stop_reason === 'tool_use') {
    const toolResults = executeTools(response.content)
    messages.push({ role: 'assistant', content: response.content })
    messages.push({ role: 'user', content: toolResults })
    // 注意：不要在每轮都递减 remaining！只在上下文压缩时才传 remaining
  }
}
```

---

## 十二、常见误区

| | 误区 | 正确理解 |
|--|------|---------|
| ❌ | `task_budget` 是硬上限 | 是软建议，Claude 可能偶尔超出。真正硬上限是 `max_tokens` |
| ❌ | 客户端可以精确跟踪剩余预算 | 倒计时由服务端注入，客户端看不到。只能用 `remaining` 在压缩边界传递估算值 |
| ❌ | 每轮都应该递减 `remaining` | 不要每轮递减，会破坏缓存。只在压缩时才传 `remaining` |
| ❌ | `task_budget` 越小越省钱 | 过小预算会导致拒绝行为或过早结束，反而完不成任务 |
| ❌ | 所有模型都支持 | 只有 4 个新模型支持（Fable 5 / Mythos 5 / Opus 4.8 / Opus 4.7），且是 beta |
| ❌ | `task_budget` 必须小于 `max_tokens` | 两者正交。`task_budget` 跨多个请求，`max_tokens` 限单个请求，无大小关系 |

---

## 十三、源码核心数据流

```
用户请求（带 taskBudget: {total: 64000}）
  ↓
QueryEngine.query(config)
  ↓
queryLoop()
  ├── 初始化 taskBudgetRemaining = undefined
  ↓ 循环开始
  ↓
  ├── queryModel({ taskBudget: { total, remaining? } })
  │     ↓
  │   [claude.ts:configureTaskBudgetParams]
  │     ├── 写 output_config.task_budget
  │     └── 加 TASK_BUDGETS_BETA_HEADER
  │     ↓
  │   发送 API 请求
  │     ↓
  │   服务端注入倒计时标记（模型可见）
  │     ↓
  │   模型按节奏生成，可能调用工具
  │     ↓
  │   返回响应（无剩余预算字段）
  ↓
  ├── 检查响应：stop_reason
  │     ├── 'tool_use' → 执行工具 → 继续循环
  │     └── 'end_turn' → 结束
  ↓
  ├── 触发 autocompact？
  │     ├── 否 → 继续循环
  │     └── 是 →
  │           ├── finalContextTokensFromLastResponse() 获取 pre-compact 上下文
  │           ├── taskBudgetRemaining = (taskBudgetRemaining ?? total) - preCompactContext
  │           └── 后续请求带着新的 remaining
  ↓
  ↓ 循环结束
```

---

## 十四、一句话总结

> `task_budget` 是给模型的"工作量预算提示"：软性建议，非强制上限；跨请求累积；配合 `effort` 控制深度、配合 `max_tokens` 控制单请求上限；压缩后需要客户端传 `remaining` 维持倒计时连续性。
====================七、快速模式（Fast Mode）完全学习指南====================
  一、一句话定位
       快速模式让 Opus 模型的输出速度提升 2.5 倍（每秒输出 token 数 OTPS
  提升），代价是价格更高。它和模型智能无关——同样的模型权重、同样的能力，只是跑在更快的推理配置上。

  类比：
  - 标准模式 = 普通车道（便宜，慢）
  - 快速模式 = 快速通道（贵 2.5–5 倍，快）
  - 车型完全一样（同一个模型），只是走的车道不同

  ---
  二、快速模式解决什么问题？

  核心指标区分

  ┌──────────────────────────────────┬────────────────────┬────────────────┐
  │               指标               │        含义        │  快速模式影响  │
  ├──────────────────────────────────┼────────────────────┼────────────────┤
  │ OTPS（output tokens per second） │ 每秒输出多少 token │ ✅ 提升 2.5 倍 │
  ├──────────────────────────────────┼────────────────────┼────────────────┤
  │ TTFT（time to first token）      │ 首个 token 延迟    │ ❌ 基本不变    │
  └──────────────────────────────────┴────────────────────┴────────────────┘

  关键理解：快速模式不是让模型"更快开始回答"，而是让模型"回答得更快完成"。

  适用场景

  - 长回复任务（写大段代码、长文分析）—— OTPS 提升显著
  - 流式响应场景 —— 用户看到"文字滚动"更快
  - 不适合：短回复任务（TTFT 提升不明显）

  ---
  三、与其他参数的关系

                   API 请求参数
                        │
          ┌─────────────┼──────────────────────────┐
          │             │                          │
          ▼             ▼                          ▼
     ┌─────────┐   ┌──────────┐            ┌──────────┐
     │thinking │   │output_   │            │speed     │
     │         │   │config    │            │          │
     │控制思考  │   │          │            │控制推理   │
     │模式     │   │ effort   │            │速度       │
     │         │   │ task_    │            │          │
     │         │   │ budget   │            │fast/     │
     │         │   │          │            │standard  │
     └─────────┘   └──────────┘            └──────────┘

  ┌───────────┬────────────────┬──────────┬─────────────┬────────────────┐
  │   维度    │    thinking    │  effort  │ task_budget │     speed      │
  ├───────────┼────────────────┼──────────┼─────────────┼────────────────┤
  │ 控制什么  │ 思考模式       │ 推理深度 │ 总工作量    │ 推理速度       │
  ├───────────┼────────────────┼──────────┼─────────────┼────────────────┤
  │ 影响 OTPS │ ❌             │ ❌       │ ❌          │ ✅             │
  ├───────────┼────────────────┼──────────┼─────────────┼────────────────┤
  │ 影响 TTFT │ ✅（思考延迟） │ 间接     │ 间接        │ ❌             │
  ├───────────┼────────────────┼──────────┼─────────────┼────────────────┤
  │ 影响成本  │ ✅             │ ✅       │ ✅          │ ✅（价格倍数） │
  ├───────────┼────────────────┼──────────┼─────────────┼────────────────┤
  │ 软/硬     │ 硬模式切换     │ 软引导   │ 软建议      │ 硬模式切换     │
  └───────────┴────────────────┴──────────┴─────────────┴────────────────┘

  ---
  四、API 请求格式

  4.1 基本用法

  {
    "model": "claude-opus-4-8",
    "max_tokens": 4096,
    "speed": "fast",                              ← 关键
    "betas": ["fast-mode-2026-02-01"],            ← 必须带 beta 头
    "messages": [{ "role": "user", "content": "Hello" }]
  }

  4.2 响应中确认使用的速度

  {
    "usage": {
      "input_tokens": 8,
      "output_tokens": 12,
      "speed": "fast"                              ← "fast" 或 "standard"
    }
  }

  4.3 定价差异

  ┌────────────────┬──────────────────┬───────────────────┐
  │      模型      │       输入       │       输出        │
  ├────────────────┼──────────────────┼───────────────────┤
  │ Opus 4.8       │ $10 / 百万 token │ $50 / 百万 token  │
  ├────────────────┼──────────────────┼───────────────────┤
  │ Opus 4.7 / 4.6 │ $30 / 百万 token │ $150 / 百万 token │
  └────────────────┴──────────────────┴───────────────────┘

  对比：Opus 4.8 标准价是 $15/$75，快速模式便宜 33%！但 Opus 4.7 快速模式是标准价的 2 倍。        

  ---
  五、源码实现解析

  5.1 Beta 头常量

  constants/betas.ts 第 19 行：

  export const FAST_MODE_BETA_HEADER = 'fast-mode-2026-02-01'

  5.2 启用检查（多层闸门）

  utils/fastMode.ts 第 38–47 行：

  export function isFastModeEnabled(): boolean {
    return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FAST_MODE)
  }

  export function isFastModeAvailable(): boolean {
    if (!isFastModeEnabled()) return false
    return getFastModeUnavailableReason() === null
  }

  5.3 不可用原因检查（getFastModeUnavailableReason）

  utils/fastMode.ts 第 72–140 行：

  export function getFastModeUnavailableReason(): string | null {
    // 1. Statsig 服务端强制禁用
    const statigReason = getFeatureValue_CACHED_MAY_BE_STALE('tengu_penguins_off', null)
    if (statigReason !== null) return statigReason

    // 2. SDK 模式（非交互 + 第三方 OAuth）默认不可用
    if (getIsNonInteractiveSession() && preferThirdPartyAuthentication() && !getKairosActive()) { 
      const flagFastMode = getSettingsForSource('flagSettings')?.fastMode
      if (!flagFastMode) return 'Fast mode is not available in the Agent SDK'
    }

    // 3. 仅第一方 provider 支持（Bedrock/Vertex/Foundry 不支持）
    if (getAPIProvider() !== 'firstParty') {
      return 'Fast mode is not available on Bedrock, Vertex, or Foundry'
    }

    // 4. 组织级禁用（免费账户 / 管理员偏好 / 未启用 extra usage）
    if (orgStatus.status === 'disabled') {
      return getDisabledReasonMessage(orgStatus.reason, authType)
    }

    return null
  }

  学习要点：
  - SDK 默认不可用（需要 --settings 显式开启）
  - 仅 1P（第一方）支持：Bedrock/Vertex/Foundry 不行
  - 组织级禁用：免费账户、管理员偏好、未启用 extra usage

  5.4 模型支持检查

  utils/fastMode.ts 第 167–179 行：

  export function isFastModeSupportedByModel(modelSetting: ModelSetting): boolean {
    if (!isFastModeEnabled()) return false
    const model = modelSetting ?? getDefaultMainLoopModelSetting()
    const parsedModel = parseUserSpecifiedModel(model)
    return (
      parsedModel.toLowerCase().includes('opus-4-7') ||
      parsedModel.toLowerCase().includes('opus-4-6')
    )
  }

  注意：源码白名单里只有 opus-4-6 和 opus-4-7，还没加上
  opus-4-8。这是源码滞后的典型例子（文档已经说支持 4.8）。

  5.5 API 请求构建：header 锁存 + speed 动态

  claude.ts 第 1799–1803 行 —— Header 锁存：

  let fastModeHeaderLatched = getFastModeHeaderLatched() === true
  if (!fastModeHeaderLatched && isFastMode) {
    fastModeHeaderLatched = true
    setFastModeHeaderLatched(true)    // 一旦启用，session 内持续发送 beta 头
  }

  claude.ts 第 1981–1994 行 —— speed 动态：

  // Fast mode：header 锁存在 session 级别稳定（缓存安全），
  // 但 `speed='fast'` 保持动态，使冷却仍能抑制实际的 fast-mode 请求，
  // 而不改变缓存键。
  let speed: BetaMessageStreamParams['speed']
  const isFastModeForRetry =
    isFastModeEnabled() &&
    isFastModeAvailable() &&
    !isFastModeCooldown() &&              // ← 冷却中不发 fast
    isFastModeSupportedByModel(options.model) &&
    !!retryContext.fastMode
  if (isFastModeForRetry) {
    speed = 'fast'
  }
  if (fastModeHeaderLatched && !betasParams.includes(FAST_MODE_BETA_HEADER)) {
    betasParams.push(FAST_MODE_BETA_HEADER)
  }

  核心设计：
  - Beta 头锁存：首次启用后，整个 session 都带 beta 头（保护 prompt cache）
  - speed 字段动态：每次请求实时判断（冷却中就不发 speed: 'fast'）

  为什么这么设计？

  如果 beta 头也动态，那么用户开关 fast mode 会让服务端缓存键变化（beta
  头是缓存键的一部分），导致缓存失效。锁存后，即使 speed 字段在 fast/undefined
  之间切换，缓存键不变。

  5.6 冷却机制（Cooldown）

  utils/fastMode.ts 第 186–240 行：

  export type FastModeRuntimeState =
    | { status: 'active' }
    | { status: 'cooldown'; resetAt: number; reason: CooldownReason }

  export type CooldownReason = 'rate_limit' | 'overloaded'

  let runtimeState: FastModeRuntimeState = { status: 'active' }

  export function triggerFastModeCooldown(
    resetTimestamp: number,
    reason: CooldownReason,
  ): void {
    runtimeState = { status: 'cooldown', resetAt: resetTimestamp, reason }
    // ...
  }

  export function getFastModeRuntimeState(): FastModeRuntimeState {
    if (
      runtimeState.status === 'cooldown' &&
      Date.now() >= runtimeState.resetAt
    ) {
      // 冷却到期自动恢复
      runtimeState = { status: 'active' }
    }
    return runtimeState
  }

  冷却触发场景：
  - rate_limit：429 错误（超过 fast mode 专属限速）
  - overloaded：529 错误（服务过载）

  冷却到期自动恢复：resetAt 时间一到，下次请求自动变回 active。

  5.7 组织级状态预取

  utils/fastMode.ts 第 409–534 行：

  export async function prefetchFastModeStatus(): Promise<void> {
    // 调用 /api/claude_code_penguin_mode 端点
    // 获取组织是否允许 fast mode
    const status = await fetchFastModeStatus(auth)
    orgStatus = status.enabled
      ? { status: 'enabled' }
      : { status: 'disabled', reason: status.disabled_reason ?? 'preference' }

    // 组织禁用时，永久关闭用户的 fast mode 设置
    if (!status.enabled) {
      updateSettingsForSource('userSettings', { fastMode: undefined })
    }
  }

  禁用原因（FastModeDisabledReason）：
  - free：免费账户
  - preference：管理员偏好
  - extra_usage_disabled：未启用超额计费
  - network_error：网络错误
  - unknown：未知

  5.8 /fast 命令实现

  commands/fast/fast.tsx 第 28–46 行：

  function applyFastMode(enable: boolean, setAppState) {
    clearFastModeCooldown()              // 清除冷却
    updateSettingsForSource('userSettings', {
      fastMode: enable ? true : undefined,
    })
    if (enable) {
      setAppState(prev => {
        // 仅当当前模型不支持 fast mode 时才切换模型
        const needsModelSwitch = !isFastModeSupportedByModel(prev.mainLoopModel)
        return {
          ...prev,
          ...(needsModelSwitch ? { mainLoopModel: getFastModeModel() } : {}),
          fastMode: true,
        }
      })
    } else {
      setAppState(prev => ({ ...prev, fastMode: false }))
    }
  }

  智能行为：
  - 开启时若当前模型不支持 fast mode → 自动切换到 Opus
  - 关闭时保持当前模型
  - 清除之前的冷却状态

  ---
  六、完整数据流

  用户执行 /fast 命令
    ↓
  [fast.tsx:applyFastMode]
    ├── clearFastModeCooldown()
    ├── updateSettings({ fastMode: true })
    └── setAppState({ fastMode: true, mainLoopModel: 'opus' })
    ↓
  [main.tsx] 启动 session
    ↓
  [prefetchFastModeStatus] 调用 /api/claude_code_penguin_mode
    ├── 组织允许 → orgStatus = 'enabled'
    └── 组织禁止 → 永久关闭 fast mode
    ↓
  [queryLoop] 准备发 API 请求
    ↓
  [claude.ts:paramsFromContext]
    ├── fastModeHeaderLatched = true（锁存 beta 头）
    ├── 检查：isFastModeEnabled() ✓
    ├── 检查：isFastModeAvailable() ✓
    ├── 检查：!isFastModeCooldown() ✓
    ├── 检查：isFastModeSupportedByModel(model) ✓
    └── speed = 'fast'
    ↓
  发送 API 请求
    ├── headers: { anthropic-beta: fast-mode-2026-02-01, ... }
    ├── body: { speed: "fast", ... }
    └── ...
    ↓
  API 响应
    ├── usage.speed: "fast"
    └── 计费按快速模式费率
    ↓
  若遇到 429/529
    ↓
  [triggerFastModeCooldown]
    ├── runtimeState = { status: 'cooldown', resetAt, reason }
    └── 后续请求不带 speed: 'fast'，回退到标准速度
    ↓
  冷却到期
    ↓
  [runtimeState = 'active'] 自动恢复

  ---
  七、回退机制（Fallback）

  7.1 文档推荐模式

  async function createMessageWithFastFallback(params, maxAttempts = 3) {
    try {
      return await client.beta.messages.create(params, { maxRetries: 0 })
    } catch (e) {
      if (e instanceof RateLimitError && params.speed === "fast") {
        // 429 → 去掉 speed: "fast" 重试
        const { speed, ...rest } = params
        return createMessageWithFastFallback(rest)
      }
      if (e instanceof InternalServerError && maxAttempts > 1) {
        // 5xx → 同样请求重试
        return createMessageWithFastFallback(params, maxAttempts - 1)
      }
      throw e
    }
  }

  7.2 Claude Code 的实现

  Claude Code 不做客户端回退。它用冷却机制代替：
  - 遇到 429/529 → 进入冷却 → 后续请求自动不带 speed: 'fast'
  - 冷却到期 → 自动恢复

  为什么？ 因为 Claude Code 是长时间 agent
  循环，不是单次请求。冷却机制能自动管理状态，无需用户代码介入。

  ---
  八、与 Prompt Cache 的交互

  8.1 关键规则

  ▎ 在快速和标准速度之间切换会使提示缓存失效。不同速度的请求不共享缓存前缀。

  8.2 Claude Code 的优化

  claude.ts 第 1981 行注释：

  ▎ Fast mode：header 锁存在 session 级别稳定（缓存安全），但 speed='fast' 
  ▎ 保持动态，使冷却仍能抑制实际的 fast-mode 请求，而不改变缓存键。

  设计技巧：
  - beta 头（fast-mode-2026-02-01）是缓存键的一部分 → 锁存
  - speed 字段（fast/undefined）不影响缓存键 → 动态

  这样，冷却期间虽然不发 speed: 'fast'，但 beta 头还在 → 缓存键不变 → 缓存继续命中。

  8.3 如果回退到标准速度

  如果你自己实现 fallback（去掉 beta 头），会破坏缓存。Claude Code 通过锁存避免了这个问题。       

  ---
  九、速率限制

  9.1 独立的限速桶

  快速模式拥有独立的速率限制，与标准 Opus 限制分开计算。

  9.2 响应头

  ┌────────────────────────────────────────┬─────────────────────────────┐
  │                 Header                 │            含义             │
  ├────────────────────────────────────────┼─────────────────────────────┤
  │ anthropic-fast-input-tokens-limit      │ 每分钟 fast 输入 token 上限 │
  ├────────────────────────────────────────┼─────────────────────────────┤
  │ anthropic-fast-input-tokens-remaining  │ 剩余 fast 输入 token        │
  ├────────────────────────────────────────┼─────────────────────────────┤
  │ anthropic-fast-input-tokens-reset      │ 重置时间                    │
  ├────────────────────────────────────────┼─────────────────────────────┤
  │ anthropic-fast-output-tokens-limit     │ 每分钟 fast 输出 token 上限 │
  ├────────────────────────────────────────┼─────────────────────────────┤
  │ anthropic-fast-output-tokens-remaining │ 剩余 fast 输出 token        │
  ├────────────────────────────────────────┼─────────────────────────────┤
  │ anthropic-fast-output-tokens-reset     │ 重置时间                    │
  └────────────────────────────────────────┴─────────────────────────────┘

  9.3 超限行为

  - 返回 429 + retry-after 头
  - SDK 默认自动重试 2 次
  - Claude Code 通过冷却机制处理

  ---
  十、常见误区

  ❌ 误区 1：快速模式会影响智能

  正确：同样的模型权重、同样的能力。只是推理配置更快。

  ❌ 误区 2：快速模式让 TTFT 变快

  正确：主要提升 OTPS，TTFT 基本不变。

  ❌ 误区 3：所有模型都支持

  正确：只有 Opus 4.6/4.7/4.8 支持。Sonnet/Haiku 不支持。

  ❌ 误区 4：第三方 provider 支持

  正确：Bedrock/Vertex/Foundry 不支持。

  ❌ 误区 5：快速模式和标准模式共享缓存

  正确：不共享。但 Claude Code 通过锁存 beta 头避免破坏缓存。

  ❌ 误区 6：冷却后 fast mode 永久失效

  正确：冷却到期自动恢复（resetAt 时间一过就回到 active）。

  ❌ 误区 7：批处理 API 支持快速模式

  正确：批处理不支持 fast mode。

  ---
  十一、Claude Code 里的"penguin"代号

  源码里 fast mode 的内部代号是 "penguin"（企鹅）：

  // /api/claude_code_penguin_mode  ← 端点名
  // penguinModeOrgEnabled           ← 配置字段
  // tengu_penguins_off              ← Statsig feature gate

  为什么叫 penguin？ 内部项目代号，对外称 "fast mode"。

  ---
  十二、一句话总结

  ▎ Fast Mode = Opus 的"加速档"：速度 2.5×、价格 2-5×；通过 speed: 'fast' + beta 头启用；仅第一方 
  ▎ Opus 支持；Claude Code 用"header 锁存 + speed 动态"保护缓存，用"冷却机制"自动处理限速。


====================八、结构化输出（Structured Outputs）完全学习指南====================
一、一句话定位     
  结构化输出保证 Claude 的输出符合你定义的 JSON Schema —— 通过约束解码（constrained
  decoding）从底层强制 Claude 生成符合 schema 的 JSON，而不是靠提示工程"祈祷"模型输出正确格式。

  解决的核心问题：
  - ❌ 以前：让 Claude "请返回 JSON" → 模型可能返回 markdown 代码块、多余文字、字段缺失
  - ✅ 现在：output_config.format → 保证返回符合 schema 的 JSON

  ---
  二、两种互补的功能

  结构化输出提供两个独立但可组合的功能：

  ┌──────────────┬───────────────────────────────┬──────────────────────┐
  │     功能     │           控制什么            │       API 参数       │
  ├──────────────┼───────────────────────────────┼──────────────────────┤
  │ JSON 输出    │ Claude 的响应格式（说什么）   │ output_config.format │
  ├──────────────┼───────────────────────────────┼──────────────────────┤
  │ 严格工具使用 │ Claude 的工具参数（怎么调用） │ tools[].strict: true │
  └──────────────┴───────────────────────────────┴──────────────────────┘

  类比：
  - JSON 输出 = 让 Claude 写"格式正确的作文"
  - 严格工具使用 = 让 Claude 填"格式正确的表格"
  - 两者可组合 = Claude 一边填正确表格，一边写作文

  ---
  三、工作原理（约束解码）

  传统方式：
  用户请求 → 模型自由生成 → 返回文本 → 客户端解析 JSON → ❌ 可能失败

  结构化输出：
  用户请求 + JSON Schema
      ↓
  API 端：Schema 编译为约束语法
      ↓
  模型生成时：每个 token 都受语法约束
      ↓
  保证返回符合 schema 的 JSON → ✅ 100% 有效

  代价：
  - 首次请求有语法编译延迟（约 1-3 秒）
  - 编译后的语法缓存 24 小时，后续请求快
  - 输入 token 略增（API 自动注入解释性 system prompt）

  ---
  四、Python 示例：从入门到进阶

  4.1 安装 SDK

  pip install anthropic pydantic

  4.2 示例 1：基础用法（原始 JSON Schema）

  import anthropic
  import json

  client = anthropic.Anthropic()

  # 原始 JSON Schema 方式
  response = client.messages.create(
      model="claude-opus-4-8",
      max_tokens=1024,
      messages=[{
          "role": "user",
          "content": "提取邮件信息：张三 (zhangsan@example.com) 对企业版感兴趣，希望下周二下午 2  
  点安排演示。"
      }],
      output_config={
          "format": {
              "type": "json_schema",
              "schema": {
                  "type": "object",
                  "properties": {
                      "name": {"type": "string"},
                      "email": {"type": "string"},
                      "plan_interest": {"type": "string"},
                      "demo_requested": {"type": "boolean"}
                  },
                  "required": ["name", "email", "plan_interest", "demo_requested"],
                  "additionalProperties": False  # ← 必须设为 False
              }
          }
      }
  )

  # 响应内容
  text = response.content[0].text
  print(text)
  # 输出：{"name": "张三", "email": "zhangsan@example.com", "plan_interest": "企业版",
  "demo_requested": true}

  # 直接解析，保证成功
  data = json.loads(text)
  print(data["name"])  # 张三

  4.3 示例 2：使用 Pydantic（推荐方式）

  from pydantic import BaseModel, Field
  from anthropic import Anthropic
  from typing import Optional

  class ContactInfo(BaseModel):
      """联系信息"""
      name: str = Field(description="用户姓名")
      email: str = Field(description="电子邮件")
      plan_interest: str = Field(description="感兴趣的计划")
      demo_requested: bool = Field(description="是否要求演示")

  client = Anthropic()

  # 使用 parse() 方法 + Pydantic 模型
  response = client.messages.parse(
      model="claude-opus-4-8",
      max_tokens=1024,
      messages=[{
          "role": "user",
          "content": "提取：李四 (lisi@company.cn) 想了解专业版，希望明天安排会议。"
      }],
      output_format=ContactInfo  # ← 直接传 Pydantic 类
  )

  # response 是特殊对象，包含 parsed_output
  print(response.parsed_output)
  # 输出：ContactInfo(name='李四', email='lisi@company.cn', plan_interest='专业版',
  demo_requested=True)

  # 类型安全的访问
  contact = response.parsed_output
  print(f"{contact.name} ({contact.email})")  # 李四 (lisi@company.cn)
  print(f"演示需求: {'是' if contact.demo_requested else '否'}")

  4.4 示例 3：嵌套对象 + 数组

  from pydantic import BaseModel
  from typing import List

  class LineItem(BaseModel):
      description: str
      quantity: int
      unit_price: float

  class Invoice(BaseModel):
      invoice_number: str
      date: str
      customer_name: str
      total_amount: float
      line_items: List[LineItem]

  client = Anthropic()

  invoice_text = """
  发票 #INV-2024-001
  日期：2024-03-15
  客户：王五公司

  明细：
  - 咨询服务 10小时 × ¥500/小时 = ¥5,000
  - 软件开发 5小时 × ¥800/小时 = ¥4,000
  - 服务器托管 1个月 × ¥2,000/月 = ¥2,000

  总金额：¥11,000
  """

  response = client.messages.parse(
      model="claude-opus-4-8",
      max_tokens=2048,
      messages=[{"role": "user", "content": f"提取发票信息：\n{invoice_text}"}],
      output_format=Invoice
  )

  invoice = response.parsed_output
  print(f"发票号: {invoice.invoice_number}")
  print(f"客户: {invoice.customer_name}")
  print(f"总金额: ¥{invoice.total_amount}")
  print(f"明细数量: {len(invoice.line_items)}")
  for item in invoice.line_items:
      print(f"  - {item.description}: {item.quantity} × ¥{item.unit_price}")

  4.5 示例 4：枚举 + 可选字段

  from pydantic import BaseModel, Field
  from typing import Literal, Optional

  class Feedback(BaseModel):
      category: Literal["positive", "negative", "neutral"] = Field(
          description="反馈类别"
      )
      sentiment_score: float = Field(
          description="情感得分 -1.0 到 1.0",
          ge=-1.0, le=1.0  # ← SDK 会把这个约束移到 description
      )
      tags: list[str] = Field(description="标签列表")
      summary: Optional[str] = Field(None, description="可选的简短总结")

  client = Anthropic()

  response = client.messages.parse(
      model="claude-opus-4-8",
      max_tokens=1024,
      messages=[{
          "role": "user",
          "content": "分类这个反馈：产品很好，但物流太慢了，等了一周才收到。"
      }],
      output_format=Feedback
  )

  feedback = response.parsed_output
  print(f"类别: {feedback.category}")  # negative
  print(f"情感: {feedback.sentiment_score}")  # -0.3
  print(f"标签: {feedback.tags}")  # ['产品好', '物流慢']
  print(f"总结: {feedback.summary}")  # None 或字符串

  4.6 示例 5：流式传输 + 结构化输出

  import json

  client = Anthropic()

  # 流式传输也支持结构化输出
  with client.messages.stream(
      model="claude-opus-4-8",
      max_tokens=1024,
      messages=[{
          "role": "user",
          "content": "列出 5 个著名的数学家及其主要贡献"
      }],
      output_config={
          "format": {
              "type": "json_schema",
              "schema": {
                  "type": "object",
                  "properties": {
                      "mathematicians": {
                          "type": "array",
                          "items": {
                              "type": "object",
                              "properties": {
                                  "name": {"type": "string"},
                                  "contribution": {"type": "string"}
                              },
                              "required": ["name", "contribution"],
                              "additionalProperties": False
                          }
                      }
                  },
                  "required": ["mathematicians"],
                  "additionalProperties": False
              }
          }
      }
  ) as stream:
      # 流式接收文本块
      full_text = ""
      for text in stream.text_stream:
          full_text += text
          print(text, end="", flush=True)

      print("\n\n--- 解析结果 ---")
      data = json.loads(full_text)
      for m in data["mathematicians"]:
          print(f"• {m['name']}: {m['contribution']}")

  4.7 示例 6：结合工具使用

  from pydantic import BaseModel

  class TripPlan(BaseModel):
      destination: str
      departure_date: str
      activities: list[str]
      estimated_budget: float

  # 同时使用 JSON 输出 + 工具
  response = client.messages.create(
      model="claude-opus-4-8",
      max_tokens=2048,
      messages=[{
          "role": "user",
          "content": "帮我规划 2026 年 5 月 15 日去巴黎的旅行"
      }],
      # JSON 输出：控制响应格式
      output_config={
          "format": {
              "type": "json_schema",
              "schema": {
                  "type": "object",
                  "properties": {
                      "summary": {"type": "string"},
                      "next_steps": {"type": "array", "items": {"type": "string"}}
                  },
                  "required": ["summary", "next_steps"],
                  "additionalProperties": False
              }
          }
      },
      # 工具：Claude 可以选择调用
      tools=[{
          "name": "search_flights",
          "description": "搜索航班",
          "input_schema": {
              "type": "object",
              "properties": {
                  "destination": {"type": "string"},
                  "date": {"type": "string", "format": "date"}
              },
              "required": ["destination", "date"],
              "additionalProperties": False
          }
      }]
  )

  # Claude 可能先调用工具，也可能直接返回 JSON
  for block in response.content:
      if block.type == "tool_use":
          print(f"调用工具: {block.name}({block.input})")
      elif block.type == "text":
          print(f"文本响应: {block.text}")
          data = json.loads(block.text)  # 保证是合法 JSON
          print(f"摘要: {data['summary']}")

  ---
  五、源码中的真实使用案例

  Claude Code 内部大量使用结构化输出。看两个真实案例：

  5.1 生成会话名称（src/commands/rename/generateSessionName.ts）

  // 使用 Haiku 为对话生成简短的 kebab-case 名称
  const result = await queryHaiku({
    systemPrompt: asSystemPrompt([
      '生成一个简短的 kebab-case 名称（2-4 个单词），概括本次对话的主要主题。'
    ]),
    userPrompt: conversationText,
    outputFormat: {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    // ...
  })

  // 解析响应
  const response = safeParseJSON(content)
  return response?.name  // 例如: "fix-login-bug"

  5.2 筛选相关记忆（src/memdir/findRelevantMemories.ts）

  // 从大量记忆文件中筛选与当前查询相关的
  const result = await querySonnet({
    messages: [{
      role: 'user',
      content: `查询：${query}\n\n可用记忆：\n${manifest}`,
    }],
    output_format: {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          selected_memories: { type: 'array', items: { type: 'string' } },
        },
        required: ['selected_memories'],
        additionalProperties: false,
      },
    },
    // ...
  })

  const parsed = jsonParse(result.content[0].text)
  return parsed.selected_memories  // 相关的记忆文件名列表

  学习要点：
  - 都用 additionalProperties: false（必须）
  - Schema 都非常简单（避免复杂度限制）
  - 都用 Haiku/Sonnet 而不是 Opus（降低成本）
  - 解析失败都有 fallback 处理

  ---
  六、JSON Schema 限制

  6.1 支持的特性

  # ✅ 支持
  {
      "type": "object",
      "properties": {
          "name": {"type": "string"},
          "age": {"type": "integer"},
          "score": {"type": "number"},
          "active": {"type": "boolean"},
          "tags": {"type": "array", "items": {"type": "string"}},
          "status": {"type": "string", "enum": ["pending", "active", "done"]},
          "metadata": {"type": "object", "additionalProperties": False}
      },
      "required": ["name", "age"],
      "additionalProperties": False
  }

  6.2 不支持的特性

  # ❌ 不支持（SDK 会自动转换或报错）
  {
      "type": "object",
      "properties": {
          "age": {
              "type": "integer",
              "minimum": 0,           # ❌ 数值约束
              "maximum": 150
          },
          "name": {
              "type": "string",
              "minLength": 1,         # ❌ 字符串约束
              "maxLength": 100
          },
          "tags": {
              "type": "array",
              "minItems": 2,          # ❌ 数组约束（除了 0 和 1）
              "maxItems": 10,
              "uniqueItems": True     # ❌ 不支持
          },
          "user": {"$ref": "#/$defs/User"}  # ❌ 递归引用
      }
  }

  6.3 SDK 自动转换

  Pydantic 字段的约束会被移到 description：

  from pydantic import BaseModel, Field

  class Person(BaseModel):
      age: int = Field(ge=0, le=150, description="年龄")
      # ↓ SDK 转换后发给 API 的 schema：
      # {
      #   "type": "integer",
      #   "description": "年龄。必须至少为 0，至多为 150"
      #   # 注意：minimum/maximum 被移除，约束写入 description
      # }

  ---
  七、实际场景模板

  7.1 数据提取（从非结构化到结构化）

  from pydantic import BaseModel

  class EmailData(BaseModel):
      sender: str
      recipient: str
      subject: str
      body_summary: str
      action_required: bool
      priority: str  # "high", "medium", "low"

  def extract_email(email_text: str) -> EmailData:
      response = client.messages.parse(
          model="claude-opus-4-8",
          max_tokens=1024,
          messages=[{"role": "user", "content": email_text}],
          output_format=EmailData
      )
      return response.parsed_output

  # 使用
  email = extract_email("""
  发件人: boss@company.com
  收件人: employee@company.com
  主题: 紧急：明天会议

  请准备下周的项目报告，明天上午 10 点开会讨论。
  """)

  print(f"发件人: {email.sender}")
  print(f"优先级: {email.priority}")
  print(f"需要行动: {email.action_required}")

  7.2 内容分类

  from pydantic import BaseModel
  from typing import Literal

  class ContentCategory(BaseModel):
      category: Literal["news", "opinion", "tutorial", "review", "other"]
      confidence: float
      tags: list[str]
      summary: str

  def classify_content(text: str) -> ContentCategory:
      response = client.messages.parse(
          model="claude-opus-4-8",
          max_tokens=512,
          messages=[{"role": "user", "content": f"分类这篇内容：\n{text}"}],
          output_format=ContentCategory
      )
      return response.parsed_output

  7.3 API 响应格式化

  from pydantic import BaseModel
  from typing import Optional, Any

  class APIResponse(BaseModel):
      status: Literal["success", "error", "partial"]
      data: Optional[dict] = None
      error_message: Optional[str] = None
      metadata: dict

  def generate_api_response(task_description: str) -> APIResponse:
      """让 Claude 生成标准化的 API 响应格式"""
      response = client.messages.parse(
          model="claude-opus-4-8",
          max_tokens=1024,
          messages=[{
              "role": "user",
              "content": f"处理这个任务并返回标准 API 响应：{task_description}"
          }],
          output_format=APIResponse
      )
      return response.parsed_output

  ---
  八、常见误区与最佳实践

  ❌ 误区 1：Schema 越复杂越好

  正确：Schema 复杂会导致：
  - 编译延迟增加
  - 可能触发复杂度限制
  - 模型更难生成正确输出

  最佳实践：Schema 越简单越好，只包含必要字段。

  ❌ 误区 2：不需要 additionalProperties: false

  正确：必须设置为 false，否则 API 返回 400 错误。

  ❌ 误区 3：结构化输出和 thinking 冲突

  正确：可以一起用。思考过程不受 schema 约束，只有最终响应受约束。

  ❌ 误区 4：JSON 输出保证 100% 不出错

  正确：以下情况可能失败：
  - stop_reason: "refusal"（模型拒绝）
  - stop_reason: "max_tokens"（超出长度限制）

  最佳实践：始终检查 stop_reason。

  ❌ 误区 5：每次请求都用结构化输出

  正确：只有当你真的需要解析响应时才用。普通对话会增加不必要的延迟和成本。

  ---
  九、性能优化建议

  9.1 Schema 缓存

  # ✅ 好：复用同一个 schema 对象
  MY_SCHEMA = {
      "type": "object",
      "properties": {"name": {"type": "string"}},
      "required": ["name"],
      "additionalProperties": False
  }

  for i in range(100):
      response = client.messages.create(
          model="claude-opus-4-8",
          output_config={"format": {"type": "json_schema", "schema": MY_SCHEMA}},
          # ...
      )
  # 第一次编译后，后续 99 次都命中缓存

  # ❌ 差：每次创建新的 schema（即使是相同的结构）
  for i in range(100):
      schema = {"type": "object", "properties": {"name": {"type": "string"}}, ...}
      # 每次都重新编译

  9.2 批处理

  # 大量结构化输出请求时，考虑批处理 API（50% 折扣）
  import anthropic

  # 批处理示例（伪代码）
  requests = [
      {
          "custom_id": f"task-{i}",
          "params": {
              "model": "claude-opus-4-8",
              "messages": [...],
              "output_config": {"format": {...}}
          }
      }
      for i in range(1000)
  ]

  # 使用批处理 API（成本减半）
  batch = client.beta.messages.batches.create(requests=requests)

  ---
  十、错误处理

  import anthropic
  import json

  def safe_structured_query(prompt: str, output_model):
      try:
          response = client.messages.parse(
              model="claude-opus-4-8",
              max_tokens=1024,
              messages=[{"role": "user", "content": prompt}],
              output_format=output_model
          )

          # 检查停止原因
          if response.stop_reason == "refusal":
              print("⚠️ 模型拒绝请求")
              return None
          elif response.stop_reason == "max_tokens":
              print("⚠️ 超出 token 限制")
              return None

          # 解析结果
          if response.parsed_output:
              return response.parsed_output
          else:
              print("⚠️ 解析失败，原始文本：")
              print(response.content[0].text)
              return None

      except anthropic.APIError as e:
          print(f"API 错误: {e}")
          return None
      except Exception as e:
          print(f"未知错误: {e}")
          return None

  ---
  十一、一句话总结

  ▎ 结构化输出 = Schema 约束的 JSON 保证：通过 output_config.format 强制 Claude 输出符合 JSON     
  ▎ Schema 的 JSON，Python 用 Pydantic + client.messages.parse() 最方便；Schema
  ▎ 要简单、additionalProperties: false 必须；首次有编译延迟但会缓存 24 小时。
  ---


====================九、引用（Citations）完全学习指南====================
一、一句话定位     
  引用让 Claude 回答关于文档的问题时，能精确指向"这句话出自哪个文档的哪一页/哪一段"，而不是靠"记忆
  中大概是这样"。  
  类比：
  - 普通对话 = 学生凭记忆回答老师问题
  - 启用引用 = 学生翻着书回答，并用手指着具体段落说"看，这里写的"

  核心价值：
  - ✅ 可追溯：每个论断都有出处
  - ✅ 可验证：用户能直接查看原文                                                
  - ✅ 防幻觉：模型必须从文档中提取，不能瞎编
  - ✅ 省 token：cited_text 不计入输出/输入 token

  ---
  二、源码中的现状

  src/services/api/claude.ts 第 2452 行：

  case 'citations_delta':
    // TODO: 处理 citations
    break

  关键信息：Claude Code CLI 目前还没实现引用功能的 UI 渲染。因为 Claude Code
  是编码助手，主要场景是写代码，不是读文档问答。

  但 API 完全支持这个功能，你可以直接用 Anthropic Python SDK 调用。

  ---
  三、工作原理

  3.1 三步流程

  步骤 1：提供文档 + 启用引用
    ↓ 文档被"分块"（chunked）
    ├── PDF → 按句子分块
    ├── 纯文本 → 按句子分块
    └── 自定义内容 → 按你提供的块，不额外分块

  步骤 2：Claude 生成带引用的响应
    ↓ 每个论断都关联一个"引用位置"

  步骤 3：响应包含多个 text 块
    每个 text 块可能带 citations 数组

  3.2 响应结构（关键！）

  响应不是单个大 text 块，而是多个 text 块交替：

  {
      "content": [
          {
              "type": "text",
              "text": "根据文档，"        # ← 无引用（过渡文字）
          },
          {
              "type": "text",
              "text": "草是绿色的",       # ← 有引用
              "citations": [{
                  "type": "char_location",
                  "cited_text": "草是绿色的。",
                  "document_index": 0,
                  "document_title": "自然常识",
                  "start_char_index": 0,
                  "end_char_index": 8
              }]
          },
          {
              "type": "text",
              "text": "，而天空是"        # ← 无引用
          },
          {
              "type": "text",
              "text": "蓝色的",          # ← 有引用
              "citations": [{
                  "type": "char_location",
                  "cited_text": "天空是蓝色的。",
                  "document_index": 0,
                  "start_char_index": 10,
                  "end_char_index": 20
              }]
          },
          {
              "type": "text",
              "text": "。"               # ← 无引用
          }
      ]
  }

  关键理解：text 字段 + citations 数组 共同组成一个论断。多个这样的块拼起来就是完整回答。

  ---
  四、三种文档类型对比

  ┌──────────┬─────────┬──────────┬───────────────────────────────┬─────────────────────────┐     
  │   类型   │ 输入方  │ 分块方式 │           引用格式            │        适用场景         │     
  │          │   式    │          │                               │                         │     
  ├──────────┼─────────┼──────────┼───────────────────────────────┼─────────────────────────┤     
  │ 纯文本   │ 字符串  │ 自动按句 │ char_location（字符索引，0    │ 文章、散文、RAG 块      │     
  │          │         │ 子       │ 起）                          │                         │     
  ├──────────┼─────────┼──────────┼───────────────────────────────┼─────────────────────────┤     
  │          │ base64  │          │                               │                         │     
  │ PDF      │ / URL / │ 自动按句 │ page_location（页码，1 起）   │ 报告、论文、合同        │     
  │          │         │ 子       │                               │                         │     
  │          │ file_id │          │                               │                         │     
  ├──────────┼─────────┼──────────┼───────────────────────────────┼─────────────────────────┤     
  │ 自定义内 │ content │ 不额外分 │ content_block_location（块索  │ 列表、转录、需精确控制  │     
  │ 容       │  数组   │ 块       │ 引，0 起）                    │ 粒度                    │     
  └──────────┴─────────┴──────────┴───────────────────────────────┴─────────────────────────┘     

  ---
  五、Python 完整示例

  5.1 安装 SDK

  pip install anthropic

  5.2 示例 1：纯文本文档（最基础）

  import anthropic

  client = anthropic.Anthropic()

  response = client.messages.create(
      model="claude-opus-4-8",
      max_tokens=1024,
      messages=[{
          "role": "user",
          "content": [
              # 文档块（启用引用）
              {
                  "type": "document",
                  "source": {
                      "type": "text",
                      "media_type": "text/plain",
                      "data": "草是绿色的。天空是蓝色的。太阳从东方升起，从西方落下。"
                  },
                  "title": "自然常识",
                  "context": "这是一份描述自然现象的可靠文档。",
                  "citations": {"enabled": True}
              },
              # 问题
              {
                  "type": "text",
                  "text": "草和天空分别是什么颜色？"
              }
          ]
      }]
  )

  # 解析响应
  for block in response.content:
      if block.type == "text":
          print(block.text, end="")
          if hasattr(block, "citations") and block.citations:
              for cite in block.citations:
                  print(f"\n  [引用] {cite.cited_text}")
                  print(f"         位于字符 {cite.start_char_index}-{cite.end_char_index}")       

  输出示例：
  草是绿色的[引用] 草是绿色的。
           位于字符 0-6，天空是蓝色的[引用] 天空是蓝色的。
           位于字符 7-13。

  5.3 示例 2：PDF 文档

  import base64
  from pathlib import Path

  # 读取 PDF 并编码为 base64
  pdf_path = Path("contract.pdf")
  pdf_data = base64.standard_b64encode(pdf_path.read_bytes()).decode("utf-8")

  response = client.messages.create(
      model="claude-opus-4-8",
      max_tokens=2048,
      messages=[{
          "role": "user",
          "content": [
              {
                  "type": "document",
                  "source": {
                      "type": "base64",
                      "media_type": "application/pdf",
                      "data": pdf_data
                  },
                  "title": "服务合同",
                  "citations": {"enabled": True}
              },
              {
                  "type": "text",
                  "text": "合同的付款条款是什么？违约条款在第几页？"
              }
          ]
      }]
  )

  # 解析响应（PDF 用 page_location）
  for block in response.content:
      if block.type == "text":
          print(block.text, end="")
          if hasattr(block, "citations") and block.citations:
              for cite in block.citations:
                  print(f"\n  [引用] 第 {cite.start_page_number}-{cite.end_page_number} 页")      
                  print(f"         \"{cite.cited_text[:50]}...\"")

  5.4 示例 3：自定义内容（精确控制粒度）

  适用场景：你不想让 API 自动分句，而是自己决定"哪些内容作为一个引用单位"。

  response = client.messages.create(
      model="claude-opus-4-8",
      max_tokens=1024,
      messages=[{
          "role": "user",
          "content": [
              {
                  "type": "document",
                  "source": {
                      "type": "content",
                      "content": [
                          # 每个块都是一个"引用单元"
                          {"type": "text", "text": "2024年Q1营收：¥1000万"},
                          {"type": "text", "text": "2024年Q2营收：¥1200万"},
                          {"type": "text", "text": "2024年Q3营收：¥1500万"},
                          {"type": "text", "text": "2024年Q4营收：¥1800万"},
                      ]
                  },
                  "title": "2024年季度财报",
                  "citations": {"enabled": True}
              },
              {
                  "type": "text",
                  "text": "公司 2024 年的营收趋势如何？哪个季度增长最快？"
              }
          ]
      }]
  )

  # 解析响应（自定义内容用 content_block_location）
  for block in response.content:
      if block.type == "text":
          print(block.text, end="")
          if hasattr(block, "citations") and block.citations:
              for cite in block.citations:
                  print(f"\n  [引用] 块 {cite.start_block_index}-{cite.end_block_index}")
                  print(f"         \"{cite.cited_text}\"")

  5.5 示例 4：多文档引用

  response = client.messages.create(
      model="claude-opus-4-8",
      max_tokens=1024,
      messages=[{
          "role": "user",
          "content": [
              # 文档 1（document_index = 0）
              {
                  "type": "document",
                  "source": {
                      "type": "text",
                      "media_type": "text/plain",
                      "data": "Python 由 Guido van Rossum 于 1991 年发布。"
                  },
                  "title": "Python 历史",
                  "citations": {"enabled": True}
              },
              # 文档 2（document_index = 1）
              {
                  "type": "document",
                  "source": {
                      "type": "text",
                      "media_type": "text/plain",
                      "data": "JavaScript 由 Brendan Eich 于 1995 年创建。"
                  },
                  "title": "JavaScript 历史",
                  "citations": {"enabled": True}
              },
              {
                  "type": "text",
                  "text": "Python 和 JavaScript 分别是谁在什么时候创造的？"
              }
          ]
      }]
  )

  # 注意 document_index 字段区分不同文档
  for block in response.content:
      if block.type == "text" and hasattr(block, "citations") and block.citations:
          for cite in block.citations:
              doc_title = cite.document_title  # "Python 历史" 或 "JavaScript 历史"
              doc_idx = cite.document_index    # 0 或 1
              print(f"[文档{doc_idx}: {doc_title}] {cite.cited_text}")

  5.6 示例 5：流式传输 + 引用

  with client.messages.stream(
      model="claude-opus-4-8",
      max_tokens=1024,
      messages=[{
          "role": "user",
          "content": [
              {
                  "type": "document",
                  "source": {
                      "type": "text",
                      "media_type": "text/plain",
                      "data": "地球是太阳系的第三颗行星。月球是地球的唯一天然卫星。"
                  },
                  "citations": {"enabled": True}
              },
              {"type": "text", "text": "地球和月球是什么关系？"}
          ]
      }]
  ) as stream:
      for event in stream:
          if event.type == "content_block_delta":
              delta = event.delta
              if delta.type == "text_delta":
                  print(delta.text, end="", flush=True)
              elif delta.type == "citations_delta":
                  citation = delta.citation
                  print(f"\n[引用: {citation.cited_text[:30]}...]")

  5.7 示例 6：RAG 场景（最实用）

  from typing import List

  def rag_with_citations(query: str, chunks: List[str]) -> str:
      """
      RAG + 引用：让 Claude 基于检索到的 chunks 回答，并标注出处
      """
      # 将每个 chunk 作为自定义内容文档的一个块
      content_blocks = [{"type": "text", "text": chunk} for chunk in chunks]

      response = client.messages.create(
          model="claude-opus-4-8",
          max_tokens=2048,
          messages=[{
              "role": "user",
              "content": [
                  {
                      "type": "document",
                      "source": {
                          "type": "content",
                          "content": content_blocks
                      },
                      "title": "检索到的知识",
                      "citations": {"enabled": True}
                  },
                  {"type": "text", "text": f"基于提供的资料回答问题：{query}"}
              ]
          }]
      )

      # 构建带引用的回答
      answer_parts = []
      for block in response.content:
          if block.type != "text":
              continue
          answer_parts.append(block.text)
          if hasattr(block, "citations") and block.citations:
              for cite in block.citations:
                  chunk_idx = cite.start_block_index
                  answer_parts.append(f" [{chunk_idx + 1}]")

      answer = "".join(answer_parts)

      # 附加引用列表
      citations = []
      for block in response.content:
          if hasattr(block, "citations") and block.citations:
              for cite in block.citations:
                  citations.append({
                      "chunk_idx": cite.start_block_index,
                      "text": cite.cited_text
                  })

      print("=== 答案 ===")
      print(answer)
      print("\n=== 引用 ===")
      for i, c in enumerate(citations, 1):
          print(f"[{c['chunk_idx'] + 1}] {c['text']}")

      return answer

  # 使用
  chunks = [
      "React 是由 Facebook 开发的 JavaScript 库。",
      "Vue.js 是由尤雨溪创建的渐进式框架。",
      "Angular 是由 Google 维护的 TypeScript 框架。",
      "Svelte 是由 Rich Harris 创建的编译器型框架。"
  ]

  rag_with_citations(
      "React 和 Vue 分别是谁开发的？",
      chunks
  )

  ---
  六、引用索引详解

  6.1 三种引用位置类型

  ┌────────────────────────┬────────────┬──────────┬─────────────────────┐
  │          类型          │  文档类型  │ 索引含义 │        起始         │
  ├────────────────────────┼────────────┼──────────┼─────────────────────┤
  │ char_location          │ 纯文本     │ 字符位置 │ 从 0 开始，不含结束 │
  ├────────────────────────┼────────────┼──────────┼─────────────────────┤
  │ page_location          │ PDF        │ 页码     │ 从 1 开始，不含结束 │
  ├────────────────────────┼────────────┼──────────┼─────────────────────┤
  │ content_block_location │ 自定义内容 │ 块索引   │ 从 0 开始，不含结束 │
  └────────────────────────┴────────────┴──────────┴─────────────────────┘

  6.2 示例对照

  # 纯文本：字符索引
  "草是绿色的。天空是蓝色的。"
   0123456789...
  # "草是绿色的" → start=0, end=6（不含 end）

  # PDF：页码
  # 第 5-6 页 → start_page_number=5, end_page_number=7（不含 end，实际是 5-6 页）

  # 自定义内容：块索引
  content = [
      {"type": "text", "text": "块0"},   # index=0
      {"type": "text", "text": "块1"},   # index=1
      {"type": "text", "text": "块2"},   # index=2
  ]
  # 引用"块1" → start_block_index=1, end_block_index=2（不含 end）

  ---
  七、Token 成本特性

  7.1 输入侧

  启用引用会略微增加输入 token，因为：
  - API 注入额外的 system prompt（解释引用格式）
  - 文档被分块（产生额外结构）

  7.2 输出侧（重大优势）

  cited_text 不计入输出 token！

  # 响应中的 cited_text 是免费的
  {
      "cited_text": "This is a long quoted text...",  # ← 不花钱！
      "document_index": 0,
      ...
  }

  为什么？ 因为 cited_text 是从源文档提取出来的，不是模型生成的。模型只生成一个指针（索引），然后 
  API 根据指针从原文档里复制文本给你。

  7.3 多轮对话

  cited_text 在多轮对话中回传时也不计入输入 token！

  这意味着你可以放心把之前的带引用响应传回去，不会增加成本。

  ---
  八、与提示缓存结合

  # 长文档场景：缓存文档 + 引用
  long_document = "这是一份很长的文档..." * 1000

  response = client.messages.create(
      model="claude-opus-4-8",
      max_tokens=1024,
      messages=[{
          "role": "user",
          "content": [
              {
                  "type": "document",
                  "source": {
                      "type": "text",
                      "media_type": "text/plain",
                      "data": long_document
                  },
                  "citations": {"enabled": True},
                  "cache_control": {"type": "ephemeral"}  # ← 缓存文档
              },
              {"type": "text", "text": "总结这份文档的主要观点。"}
          ]
      }]
  )

  关键点：
  - 文档本身可以缓存（减少重复处理的输入成本）
  - 引用块（citations 字段）不能缓存（每次响应都不同）

  ---
  九、功能兼容性

  ✅ 兼容

  - 提示缓存（caching）
  - 令牌计数（token counting）
  - 批处理 API（batch）
  - 流式传输（streaming）
  - 扩展思考（thinking）

  ❌ 不兼容

  - 结构化输出（Structured Outputs）

  # ❌ 错误：不能同时用
  response = client.messages.create(
      model="claude-opus-4-8",
      messages=[{
          "role": "user",
          "content": [
              {"type": "document", "citations": {"enabled": True}, ...},
              {"type": "text", "text": "..."}
          ]
      }],
      output_config={"format": {...}}  # ← 400 错误！
  )

  为什么？ 结构化输出要求严格符合 JSON schema，而引用需要 text 块和 citations 交错——两者冲突。    

  ---
  十、常见误区

  ❌ 误区 1：cited_text 是模型生成的

  正确：cited_text 是从源文档提取的，不是模型写的。模型只生成指针。

  ❌ 误区 2：可以在文档里引用图片

  正确：目前只支持文本引用，图片不能作为引用源。

  ❌ 误区 3：所有文档必须启用引用

  正确：必须全部启用或全部不启用，不能部分启用。

  ❌ 误区 4：title 和 context 也会被引用

  正确：这两个字段不会被引用，只作为元数据传给模型。

  ❌ 误区 5：PDF 扫描件能引用

  正确：PDF 必须是可提取文本的，扫描件不行。

  ❌ 误区 6：CSV/XLSX/DOCX 可以直接用

  正确：必须先转为纯文本再使用。

  ❌ 误区 7：引用和结构化输出可以一起用

  正确：完全不兼容，API 会返回 400 错误。

  ---
  十一、实用模板

  11.1 通用引用解析函数

  from dataclasses import dataclass
  from typing import List, Optional

  @dataclass
  class Citation:
      """统一格式的引用"""
      document_title: str
      document_index: int
      cited_text: str
      location: str  # 人类可读的位置描述

      def __str__(self):
          return f"[{self.document_title}] {self.location}: {self.cited_text[:50]}..."

  def parse_citations_response(response) -> tuple[str, List[Citation]]:
      """
      解析带引用的响应，返回 (answer_text, citations_list)
      """
      answer_parts = []
      citations = []

      for block in response.content:
          if block.type != "text":
              continue

          answer_parts.append(block.text)

          if hasattr(block, "citations") and block.citations:
              for cite in block.citations:
                  # 根据类型生成位置描述
                  if cite.type == "char_location":
                      location = f"字符 {cite.start_char_index}-{cite.end_char_index}"
                  elif cite.type == "page_location":
                      location = f"第 {cite.start_page_number}-{cite.end_page_number} 页"
                  elif cite.type == "content_block_location":
                      location = f"块 {cite.start_block_index}-{cite.end_block_index}"
                  else:
                      location = "未知位置"

                  citations.append(Citation(
                      document_title=cite.document_title or f"文档{cite.document_index}",
                      document_index=cite.document_index,
                      cited_text=cite.cited_text,
                      location=location
                  ))

      return "".join(answer_parts), citations

  # 使用
  answer, citations = parse_citations_response(response)
  print("=== 答案 ===")
  print(answer)
  print("\n=== 引用 ===")
  for i, cite in enumerate(citations, 1):
      print(f"{i}. {cite}")

  11.2 文档问答模板

  def ask_document_question(document_text: str, question: str, title: str = None) -> str:
      """
      基于单个文档回答问题（带引用）
      """
      response = client.messages.create(
          model="claude-opus-4-8",
          max_tokens=1024,
          messages=[{
              "role": "user",
              "content": [
                  {
                      "type": "document",
                      "source": {
                          "type": "text",
                          "media_type": "text/plain",
                          "data": document_text
                      },
                      "title": title or "文档",
                      "citations": {"enabled": True}
                  },
                  {"type": "text", "text": question}
              ]
          }]
      )

      answer, citations = parse_citations_response(response)
      print(f"问题: {question}")
      print(f"答案: {answer}")
      print(f"引用数: {len(citations)}")
      return answer

  ---
  十二、一句话总结

  ▎ 引用 = 让 Claude 指书回答：通过 citations.enabled=true 
  ▎ 启用；三种文档类型（纯文本/PDF/自定义）对应三种引用位置（字符/页码/块）；cited_text 
  ▎ 不花钱；与结构化输出互斥；多轮对话回传引用块不增加输入成本。

  ---


====================十、批处理（Message Batches API）完全学习指南====================
一、一句话定位
     
  批处理 = 把大量 API 
  请求"打包"异步处理，成本减半：不用等待每个请求立即返回，而是打包提交后等结果。

  类比：
  - 同步请求 = 在餐厅点菜，每道菜做好立刻上
  - 批处理 = 把 100 人的菜单一次性交给厨房，等他们批量做好一起上
  
  核心价值：
  - 💰 成本 50% 折扣（所有 token 半价）
  - ⚡ 更高吞吐量（并发处理大量请求）
  - ⏰ 异步等待（大部分批次 1 小时内完成）

  ---
  二、源码中的现状

  Claude Code CLI 的 /batch 命令（src/skills/bundled/batch.ts）是一个不同的功能：它用于在多个 git 
  worktree 中并行运行 agent，每个 agent 创建独立的 PR。这和 Message Batches API 是两回事。        

  Claude Code 本身不使用 Message Batches API，但你可以直接用 Python SDK 调用这个 API
  来批量处理任务。

  ---
  三、批处理工作流

  步骤 1：构建请求列表
    [
      {custom_id: "req-1", params: {...}},
      {custom_id: "req-2", params: {...}},
      ... 最多 100,000 个请求
    ]
       ↓
  步骤 2：提交批次
    POST /v1/messages/batches
    返回 batch_id，状态 in_progress
       ↓
  步骤 3：轮询等待
    GET /v1/messages/batches/{batch_id}
    状态变成 ended
       ↓
  步骤 4：下载结果
    GET results_url
    返回 .jsonl 格式的结果文件
       ↓
  步骤 5：解析结果
    按 custom_id 匹配每个请求的结果

  ---
  四、Python 完整示例

  4.1 安装 SDK

  pip install anthropic

  4.2 示例 1：基础用法

  import anthropic
  from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
  from anthropic.types.messages.batch_create_params import Request

  client = anthropic.Anthropic()

  # 创建批次
  batch = client.messages.batches.create(
      requests=[
          Request(
              custom_id="req-1",
              params=MessageCreateParamsNonStreaming(
                  model="claude-opus-4-8",
                  max_tokens=1024,
                  messages=[{"role": "user", "content": "你好，请做个自我介绍"}]
              )
          ),
          Request(
              custom_id="req-2",
              params=MessageCreateParamsNonStreaming(
                  model="claude-opus-4-8",
                  max_tokens=1024,
                  messages=[{"role": "user", "content": "讲个笑话"}]
              )
          ),
      ]
  )

  print(f"批次 ID: {batch.id}")
  print(f"状态: {batch.processing_status}")  # in_progress
  print(f"请求计数: {batch.request_counts}")

  输出示例：
  批次 ID: msgbatch_01HkcTjaV5uDC8jWR4ZsDV8d
  状态: in_progress
  请求计数: MessageBatchRequestCounts(processing=2, succeeded=0, errored=0, canceled=0, expired=0)

  4.3 示例 2：轮询等待完成

  import time

  def wait_for_batch(batch_id: str, poll_interval: int = 60) -> object:
      """轮询批次直到完成"""
      while True:
          batch = client.messages.batches.retrieve(batch_id)

          print(f"状态: {batch.processing_status}")
          print(f"  处理中: {batch.request_counts.processing}")
          print(f"  成功: {batch.request_counts.succeeded}")
          print(f"  错误: {batch.request_counts.errored}")

          if batch.processing_status == "ended":
              return batch

          print(f"等待 {poll_interval} 秒后再次检查...")
          time.sleep(poll_interval)

  # 使用
  final_batch = wait_for_batch(batch.id)
  print(f"批次完成！结果 URL: {final_batch.results_url}")

  4.4 示例 3：流式下载结果

  def process_batch_results(batch_id: str):
      """流式处理批次结果（内存友好）"""
      results = {
          "succeeded": [],
          "errored": [],
          "canceled": [],
          "expired": []
      }

      # 流式读取结果（不会一次性全部加载到内存）
      for result in client.messages.batches.results(batch_id):
          result_type = result.result.type

          if result_type == "succeeded":
              # 成功的请求，提取响应
              message = result.result.message
              text = message.content[0].text
              results["succeeded"].append({
                  "custom_id": result.custom_id,
                  "response": text
              })
              print(f"✓ {result.custom_id}: {text[:50]}...")

          elif result_type == "errored":
              # 失败的请求
              error = result.result.error
              results["errored"].append({
                  "custom_id": result.custom_id,
                  "error": error.error.message
              })
              print(f"✗ {result.custom_id}: {error.error.message}")

          elif result_type == "canceled":
              results["canceled"].append(result.custom_id)
              print(f"⊘ {result.custom_id}: 已取消")

          elif result_type == "expired":
              results["expired"].append(result.custom_id)
              print(f"⏰ {result.custom_id}: 已过期")

      return results

  # 使用
  results = process_batch_results(batch.id)
  print(f"\n总计: 成功 {len(results['succeeded'])}, 失败 {len(results['errored'])}")

  4.5 示例 4：大规模数据分类（实用场景）

  from typing import List, Dict

  def batch_classify_texts(texts: List[str], categories: List[str]) -> Dict[str, str]:
      """
      批量分类大量文本（成本减半）

      Args:
          texts: 待分类的文本列表
          categories: 可选的类别列表

      Returns:
          {custom_id: category} 映射
      """
      # 构建批处理请求
      requests = []
      for i, text in enumerate(texts):
          custom_id = f"text-{i:06d}"
          requests.append(Request(
              custom_id=custom_id,
              params=MessageCreateParamsNonStreaming(
                  model="claude-haiku-4-5",  # 用 Haiku 节省成本
                  max_tokens=100,
                  messages=[{
                      "role": "user",
                      "content": f"""请将以下文本分类到 {categories} 中的一个类别。

  文本：{text}

  请只回复类别名称，不要其他内容。"""
                  }]
              )
          ))

      # 分批提交（每批最多 10,000 个请求，更稳定）
      batch_size = 10000
      all_results = {}

      for i in range(0, len(requests), batch_size):
          batch_requests = requests[i:i + batch_size]
          print(f"提交批次 {i // batch_size + 1}，包含 {len(batch_requests)} 个请求...")

          batch = client.messages.batches.create(requests=batch_requests)

          # 等待完成
          final_batch = wait_for_batch(batch.id)

          # 收集结果
          for result in client.messages.batches.results(batch.id):
              if result.result.type == "succeeded":
                  category = result.result.message.content[0].text.strip()
                  all_results[result.custom_id] = category

      return all_results

  # 使用
  texts = [
      "这部电影太棒了，演员演技在线",
      "物流很慢，等了一周才收到",
      "产品质量一般，不值这个价",
      # ... 可能有几千条
  ]

  categories = ["正面", "负面", "中性"]
  results = batch_classify_texts(texts, categories)

  for text_id, category in results.items():
      print(f"{text_id}: {category}")

  4.6 示例 5：批量内容摘要（带提示缓存）

  def batch_summarize_documents(documents: List[str]) -> List[str]:
      """
      批量生成文档摘要（利用提示缓存优化）
      """
      # 共享的系统提示（会被缓存）
      system_prompt = [
          {
              "type": "text",
              "text": "你是一个专业的文档摘要助手。",
          },
          {
              "type": "text",
              "text": """请遵循以下规则生成摘要：
  1. 提炼文档的核心观点
  2. 保持客观中立
  3. 控制在 200 字以内
  4. 使用清晰的结构

  下面是一份长篇参考文档，用于了解背景知识...
  """ + "（这里是一份很长的背景文档）" * 1000,  # 模拟长文档
              "cache_control": {"type": "ephemeral"}  # 缓存这部分
          }
      ]

      # 构建请求（每个请求共享同一个系统提示）
      requests = [
          Request(
              custom_id=f"doc-{i:06d}",
              params=MessageCreateParamsNonStreaming(
                  model="claude-sonnet-4-6",
                  max_tokens=500,
                  system=system_prompt,  # 共享系统提示
                  messages=[{
                      "role": "user",
                      "content": f"请为以下文档生成摘要：\n\n{doc}"
                  }]
              )
          )
          for i, doc in enumerate(documents)
      ]

      # 提交批次
      batch = client.messages.batches.create(requests=requests)
      final_batch = wait_for_batch(batch.id)

      # 按 custom_id 收集结果（结果顺序不保证！）
      summaries_map = {}
      for result in client.messages.batches.results(batch.id):
          if result.result.type == "succeeded":
              summary = result.result.message.content[0].text
              summaries_map[result.custom_id] = summary

      # 按原始顺序返回
      return [summaries_map.get(f"doc-{i:06d}", "") for i in range(len(documents))]

  4.7 示例 6：扩展输出（300k token，beta）

  def generate_long_content(prompt: str) -> str:
      """
      生成超长内容（高达 300k token，仅批处理支持）
      """
      from anthropic.types.beta.message_create_params import MessageCreateParamsNonStreaming      
      from anthropic.types.beta.messages.batch_create_params import Request

      batch = client.beta.messages.batches.create(
          betas=["output-300k-2026-03-24"],  # ← 启用 300k 输出 beta
          requests=[
              Request(
                  custom_id="long-content",
                  params=MessageCreateParamsNonStreaming(
                      model="claude-opus-4-8",
                      max_tokens=300_000,  # ← 300k token 输出
                      messages=[{"role": "user", "content": prompt}]
                  )
              )
          ]
      )

      final_batch = wait_for_batch(batch.id, poll_interval=300)  # 等 5 分钟

      for result in client.messages.batches.results(batch.id):
          if result.result.type == "succeeded":
              return result.result.message.content[0].text

      return ""

  # 使用
  content = generate_long_content(
      "写一本关于分布式系统的完整技术指南，包括架构模式、一致性模型、容错设计和运维最佳实践。"    
  )
  print(f"生成了 {len(content)} 字符的内容")

  4.8 示例 7：错误处理与重试

  def robust_batch_processing(requests_data: List[dict]) -> List[dict]:
      """
      健壮的批处理：失败请求自动重试
      """
      MAX_RETRIES = 3

      # 初始请求列表
      pending_requests = [
          Request(
              custom_id=item["id"],
              params=MessageCreateParamsNonStreaming(**item["params"])
          )
          for item in requests_data
      ]

      all_results = {}

      for retry in range(MAX_RETRIES):
          if not pending_requests:
              break

          print(f"第 {retry + 1} 轮，提交 {len(pending_requests)} 个请求")

          batch = client.messages.batches.create(requests=pending_requests)
          final_batch = wait_for_batch(batch.id)

          # 处理结果
          next_pending = []

          for result in client.messages.batches.results(batch.id):
              if result.result.type == "succeeded":
                  all_results[result.custom_id] = {
                      "status": "success",
                      "response": result.result.message.content[0].text
                  }
              elif result.result.type == "errored":
                  error_type = result.result.error.error.type

                  if error_type == "invalid_request_error":
                      # 请求格式错误，不能重试
                      all_results[result.custom_id] = {
                          "status": "failed",
                          "error": result.result.error.error.message
                      }
                  else:
                      # 服务器错误，可以重试
                      next_pending.append(next(
                          r for r in pending_requests if r.custom_id == result.custom_id
                      ))
              elif result.result.type == "expired":
                  # 过期，可以重试
                  next_pending.append(next(
                      r for r in pending_requests if r.custom_id == result.custom_id
                  ))

          pending_requests = next_pending
          if pending_requests:
              print(f"  {len(pending_requests)} 个请求将在下一轮重试")

      # 标记最终失败的请求
      for req in pending_requests:
          all_results[req.custom_id] = {"status": "failed_permanently"}

      return all_results

  ---
  五、批处理限制

  5.1 数量限制

  ┌──────────────────────┬──────────────────────────────────────┐
  │         限制         │                  值                  │
  ├──────────────────────┼──────────────────────────────────────┤
  │ 单批次最大请求数     │ 100,000                              │
  ├──────────────────────┼──────────────────────────────────────┤
  │ 单批次最大总大小     │ 256 MB                               │
  ├──────────────────────┼──────────────────────────────────────┤
  │ 单请求最大输出 token │ 默认模型限制（batch beta 可到 300k） │
  ├──────────────────────┼──────────────────────────────────────┤
  │ 批次处理超时         │ 24 小时                              │
  ├──────────────────────┼──────────────────────────────────────┤
  │ 结果保留时间         │ 29 天                                │
  └──────────────────────┴──────────────────────────────────────┘

  5.2 不支持的参数

  以下参数在批处理中会报错：

  ┌────────────────────────────────────┬──────────────────────────────────────┐
  │                参数                │                 原因                 │
  ├────────────────────────────────────┼──────────────────────────────────────┤
  │ stream: true                       │ 批处理结果以文件返回，不是流式       │
  ├────────────────────────────────────┼──────────────────────────────────────┤
  │ speed: "fast"                      │ 快速模式是同步优化，不适用异步       │
  ├────────────────────────────────────┼──────────────────────────────────────┤
  │ store / previous_thread_event_id   │ Threads 是有状态的，批处理是无状态的 │
  ├────────────────────────────────────┼──────────────────────────────────────┤
  │ cache_hint / context_hint          │ 仅同步请求路由用                     │
  ├────────────────────────────────────┼──────────────────────────────────────┤
  │ max_tokens: 0                      │ 缓存预热在批处理无意义               │
  ├────────────────────────────────────┼──────────────────────────────────────┤
  │ research_preview_2026_02: "active" │ 研究预览模式不支持                   │
  └────────────────────────────────────┴──────────────────────────────────────┘

  5.3 支持的参数

  几乎所有其他参数都支持：
  - ✅ 视觉（图片）
  - ✅ 工具使用（包括所有服务器工具）
  - ✅ 系统消息
  - ✅ 多轮对话
  - ✅ 扩展思考
  - ✅ 提示缓存
  - ✅ 结构化输出
  - ✅ 引用
  - ✅ 大多数 beta 功能

  ---
  六、定价对比

  6.1 标准 vs 批处理

  ┌────────────┬──────────┬────────────┬──────────┬────────────┐
  │    模型    │ 标准输入 │ 批处理输入 │ 标准输出 │ 批处理输出 │
  ├────────────┼──────────┼────────────┼──────────┼────────────┤
  │ Opus 4.8   │ $5       │ $2.50      │ $25      │ $12.50     │
  ├────────────┼──────────┼────────────┼──────────┼────────────┤
  │ Opus 4.7   │ $5       │ $2.50      │ $25      │ $12.50     │
  ├────────────┼──────────┼────────────┼──────────┼────────────┤
  │ Sonnet 4.6 │ $3       │ $1.50      │ $15      │ $7.50      │
  ├────────────┼──────────┼────────────┼──────────┼────────────┤
  │ Haiku 4.5  │ $1       │ $0.50      │ $5       │ $2.50      │
  └────────────┴──────────┴────────────┴──────────┴────────────┘

  省钱效果：处理 1000 万输入 + 100 万输出 token
  - 标准 Opus 4.8：$50 + $25 = $75
  - 批处理 Opus 4.8：$25 + $12.5 = $37.50（省 50%）

  6.2 叠加优惠

  批处理折扣可以和其他优惠叠加：
  - 批处理 50% off
  - 提示缓存输入 90% off（缓存读取）
  - 两者叠加 = 输入只要原价的 5%

  ---
  七、与提示缓存结合

  7.1 原理

  批处理中每个请求独立处理，但如果多个请求共享相同前缀（如系统提示 + 参考文档），可以命中缓存。   

  典型命中率：30% - 98%（取决于流量模式）

  7.2 优化技巧

  # ❌ 差：每个请求系统提示不同
  requests = [
      Request(custom_id="1", params={
          "system": f"处理这个特定任务：{task_1}",  # 每次都不同
          ...
      }),
      Request(custom_id="2", params={
          "system": f"处理这个特定任务：{task_2}",
          ...
      }),
  ]

  # ✅ 好：共享前缀 + cache_control
  shared_system = [
      {"type": "text", "text": "你是一个专业助手。"},
      {
          "type": "text",
          "text": "这里是很长的参考文档..." * 1000,
          "cache_control": {"type": "ephemeral"}  # ← 关键
      }
  ]

  requests = [
      Request(custom_id="1", params={
          "system": shared_system,  # 共享
          "messages": [{"role": "user", "content": task_1}]  # 仅消息不同
      }),
      Request(custom_id="2", params={
          "system": shared_system,
          "messages": [{"role": "user", "content": task_2}]
      }),
  ]

  7.3 1 小时缓存

  批处理可能超过 5 分钟，使用 1 小时 TTL 提高命中率：

  shared_system = [
      {
          "type": "text",
          "text": "长文档内容...",
          "cache_control": {
              "type": "ephemeral",
              "ttl": "1h"  # ← 1 小时缓存
          }
      }
  ]

  ---
  八、服务器工具与 agent 循环

  8.1 服务器工具

  批处理支持所有服务器工具：
  - web_search（网络搜索）
  - web_fetch（网络抓取）
  - code_execution（代码执行）
  - MCP connectors
  - advisor
  - tool search

  8.2 比同步多跑几轮

  批处理 worker 不需要维持开放连接，所以在返回 pause_turn 之前，能比同步请求多跑几轮工具调用。    

  8.3 pause_turn 处理

  如果批处理结果返回 stop_reason:
  "pause_turn"，说明该轮次未完成。你需要在后续请求中提交暂停的助手内容继续。

  8.4 web_search 自动限流

  批处理会自动对 web_search 按组织限流，防止耗尽速率限制。被限流的请求自动重试，你无需处理。      

  ---
  九、常见误区

  ❌ 误区 1：批处理结果是有序的

  正确：结果可以任何顺序返回，必须用 custom_id 匹配。

  ❌ 误区 2：批处理比同步慢很多

  正确：大部分批次 1 小时内完成，单个请求的处理时间和同步差不多。

  ❌ 误区 3：一个请求失败会影响整个批次

  正确：每个请求独立处理，一个失败不影响其他。

  ❌ 误区 4：批处理不支持工具使用

  正确：支持所有工具，包括服务器工具。

  ❌ 误区 5：批处理和标准 API 共享速率限制

  正确：批处理有独立的速率限制，不影响标准 API。

  ❌ 误区 6：提交后能修改批次

  正确：不能修改，只能取消重新提交。

  ❌ 误区 7：结果永久保留

  正确：结果只保留 29 天，之后无法下载。

  ---
  十、最佳实践

  10.1 请求设计

  # ✅ 最佳实践

  # 1. 使用有意义的 custom_id
  custom_id = f"user-{user_id}-task-{task_id}-{timestamp}"

  # 2. 先用标准 API 测试单个请求
  test_response = client.messages.create(
      model="claude-opus-4-8",
      max_tokens=1024,
      messages=[...],
  )
  # 确认没问题再批处理

  # 3. 拆分超大任务
  large_requests = [...]  # 100,000+ 个请求
  batch_size = 50000
  for i in range(0, len(large_requests), batch_size):
      batch = client.messages.batches.create(
          requests=large_requests[i:i+batch_size]
      )

  # 4. 共享缓存前缀
  shared_prefix = [...]  # 系统提示 + 长文档
  requests = [
      Request(custom_id=f"r-{i}", params={
          "system": shared_prefix,
          "messages": [{"role": "user", "content": unique_content}]
      })
      for i, unique_content in enumerate(contents)
  ]

  10.2 错误处理

  # ✅ 最佳实践

  def handle_batch_results(batch_id: str):
      failed_requests = []

      for result in client.messages.batches.results(batch_id):
          if result.result.type == "errored":
              error_type = result.result.error.error.type

              if error_type == "invalid_request_error":
                  # 请求格式错误，必须修正后重试
                  log_error(f"修正请求: {result.custom_id}")
                  failed_requests.append(("invalid", result.custom_id))
              else:
                  # 服务器错误，可直接重试
                  log_error(f"重试请求: {result.custom_id}")
                  failed_requests.append(("retry", result.custom_id))

          elif result.result.type == "expired":
              # 24 小时超时，需要重新提交
              failed_requests.append(("expired", result.custom_id))

      # 根据错误类型分别处理
      invalid_ids = [id for type, id in failed_requests if type == "invalid"]
      retry_ids = [id for type, id in failed_requests if type == "retry"]
      expired_ids = [id for type, id in failed_requests if type == "expired"]

      return {
          "invalid": invalid_ids,   # 需要修正
          "retry": retry_ids,       # 可直接重试
          "expired": expired_ids    # 需要重提
      }

  10.3 监控与告警

  import time

  def monitor_batch_with_alerts(batch_id: str, max_wait_hours: int = 2):
      """监控批次，超时告警"""
      start_time = time.time()
      max_wait_seconds = max_wait_hours * 3600

      while True:
          batch = client.messages.batches.retrieve(batch_id)
          elapsed = time.time() - start_time

          # 进度报告
          total = sum([
              batch.request_counts.processing,
              batch.request_counts.succeeded,
              batch.request_counts.errored,
              batch.request_counts.canceled,
              batch.request_counts.expired
          ])
          progress = (batch.request_counts.succeeded + batch.request_counts.errored) / total * 100
  if total > 0 else 0

          print(f"[{elapsed/60:.1f}分钟] 进度: {progress:.1f}%")

          if batch.processing_status == "ended":
              return batch

          # 超时告警
          if elapsed > max_wait_seconds:
              print(f"⚠️ 批次 {batch_id} 超过 {max_wait_hours} 小时，考虑取消")
              # 可选择取消
              # client.messages.batches.cancel(batch_id)

          time.sleep(300)  # 每 5 分钟检查一次

  ---
  十一、一句话总结

  ▎ 批处理 = 大量请求的省钱利器：client.messages.batches.create(requests=[...]) 
  ▎ 提交，异步等待完成后流式下载结果；成本减半，24 小时超时，结果 29 天保留；用 custom_id         
  ▎ 匹配结果（顺序不保证）；共享系统提示 + cache_control 可叠加优惠。

  ---

====================十一、搜索结果（Search Results）完全学习指南====================
 一、一句话定位

  搜索结果 = 让 Claude 引用你自己的搜索结果：通过 search_result
  内容块，把从任何来源（数据库、向量库、API、文件）获取的内容交给
  Claude，让它像网络搜索一样自动引用来源。

  解决的核心问题：
  - ❌ 以前：RAG 把检索结果塞进 prompt，Claude 回答时无法精准引用
  - ✅ 现在：search_result 块自带 source/title，Claude 回答自动带引用

  类比：
  - 普通 RAG = 把参考书内容抄给学生，学生凭记忆写论文
  - search_result = 把参考书递给学生，学生边翻边写，能指出"第几页第几段"

  ---
  二、源码中的定位

  src/utils/messages.ts 第 2824 行：

  // SDK 允许的 tool_result.content 内块类型：text、image、search_result、document。

  关键理解：
  - search_result 是 SDK 原生支持的块类型
  - 可以出现在 tool_result.content 内（工具返回结果）
  - 也可以作为顶层消息内容

  与 WebSearch 的关系：
  - web_search_tool_result 是 Claude 网络搜索工具专用的搜索结果类型
  - search_result 是通用版本，给开发者自定义使用
  - 两者引用机制相同

  ---
  三、与引用的对比

  ┌────────────┬─────────────────────────────────────────┬─────────────────────────────────────┐  
  │    维度    │            引用（Citations）            │     搜索结果（Search Results）      │  
  ├────────────┼─────────────────────────────────────────┼─────────────────────────────────────┤  
  │ 数据来源   │ 文档块（PDF/纯文本/自定义）             │ 你的任何来源（数据库、API、向量库） │  
  ├────────────┼─────────────────────────────────────────┼─────────────────────────────────────┤  
  │ 输入方式   │ 文档内容本身                            │ 已检索好的搜索结果                  │  
  ├────────────┼─────────────────────────────────────────┼─────────────────────────────────────┤  
  │ 分块方式   │ 自动分句或自定义块                      │ 你决定（content 数组）              │  
  ├────────────┼─────────────────────────────────────────┼─────────────────────────────────────┤  
  │ 引用格式   │ char_location / page_location /         │ search_result_location              │  
  │            │ content_block_location                  │                                     │  
  ├────────────┼─────────────────────────────────────────┼─────────────────────────────────────┤  
  │ 典型场景   │ 静态文档问答                            │ 动态 RAG、知识库搜索                │  
  ├────────────┼─────────────────────────────────────────┼─────────────────────────────────────┤  
  │ 与工具配合 │ 不直接配合                              │ 可作为 tool_result 返回             │  
  └────────────┴─────────────────────────────────────────┴─────────────────────────────────────┘  

  简单记忆：
  - Citations = 让 Claude 引用完整文档
  - Search Results = 让 Claude 引用检索片段

  ---
  四、搜索结果架构

  {
    "type": "search_result",              // ← 固定值
    "source": "https://...",              // ← 必填：来源 URL 或标识符
    "title": "文章标题",                    // ← 必填：描述性标题
    "content": [                          // ← 必填：文本块数组
      {
        "type": "text",
        "text": "实际内容..."
      }
    ],
    "citations": {"enabled": true},       // ← 可选：启用引用
    "cache_control": {"type": "ephemeral"} // ← 可选：缓存
  }

  必填字段

  ┌─────────┬────────┬───────────────────────────────────┐
  │  字段   │  类型  │               说明                │
  ├─────────┼────────┼───────────────────────────────────┤
  │ type    │ string │ 必须是 "search_result"            │
  ├─────────┼────────┼───────────────────────────────────┤
  │ source  │ string │ 来源 URL 或标识符（用于引用显示） │
  ├─────────┼────────┼───────────────────────────────────┤
  │ title   │ string │ 搜索结果的标题                    │
  ├─────────┼────────┼───────────────────────────────────┤
  │ content │ array  │ 文本块数组（至少一个）            │
  └─────────┴────────┴───────────────────────────────────┘

  可选字段

  ┌───────────────────┬──────────────────────────────────────────┐
  │       字段        │                   说明                   │
  ├───────────────────┼──────────────────────────────────────────┤
  │ citations.enabled │ 是否启用引用（默认 false，必须全批一致） │
  ├───────────────────┼──────────────────────────────────────────┤
  │ cache_control     │ 缓存控制（提升性能）                     │
  └───────────────────┴──────────────────────────────────────────┘

  ---
  五、两种使用方式

  方式 1：作为工具调用结果（动态 RAG）

  适用场景：Claude 主动调用你的搜索工具，你返回相关结果。

  用户提问 → Claude 调用 search_knowledge_base 工具
              ↓
           你的代码执行搜索
              ↓
           返回 search_result 数组
              ↓
           Claude 基于结果回答 + 自动引用

  方式 2：作为顶层内容（预取 RAG）

  适用场景：你已经知道用户会问什么，提前检索好结果直接放进消息。

  预先检索 → 构造包含 search_result 的消息
              ↓
           Claude 直接基于结果回答 + 自动引用

  ---
  六、Python 完整示例

  6.1 示例 1：基础用法（顶层内容）

  import anthropic
  from anthropic.types import (
      MessageParam,
      TextBlockParam,
      SearchResultBlockParam
  )

  client = anthropic.Anthropic()

  response = client.messages.create(
      model="claude-opus-4-8",
      max_tokens=1024,
      messages=[{
          "role": "user",
          "content": [
              # 搜索结果 1
              SearchResultBlockParam(
                  type="search_result",
                  source="https://docs.company.com/api-auth",
                  title="API 认证文档",
                  content=[
                      TextBlockParam(
                          type="text",
                          text="所有 API 请求必须在 Authorization 头中包含 API key。"
                               "可在控制台生成。标准版速率限制：1000 请求/小时，"
                               "高级版：10000 请求/小时。"
                      )
                  ],
                  citations={"enabled": True}
              ),
              # 搜索结果 2
              SearchResultBlockParam(
                  type="search_result",
                  source="https://docs.company.com/quickstart",
                  title="快速入门指南",
                  content=[
                      TextBlockParam(
                          type="text",
                          text="快速开始：1) 注册账号，2) 在控制台生成 API key，"
                               "3) 用 pip install company-sdk 安装 SDK，"
                               "4) 用你的 API key 初始化客户端。"
                      )
                  ],
                  citations={"enabled": True}
              ),
              # 用户问题
              TextBlockParam(
                  type="text",
                  text="基于这些搜索结果，我该如何认证 API 请求？速率限制是多少？"
              )
          ]
      }]
  )

  # 解析带引用的响应
  for block in response.content:
      if block.type == "text":
          print(block.text, end="")
          if hasattr(block, "citations") and block.citations:
              for cite in block.citations:
                  print(f"\n  [引用] {cite.title}")
                  print(f"         来源: {cite.source}")
                  print(f"         原文: {cite.cited_text[:50]}...")

  6.2 示例 2：工具调用方式（动态 RAG）

  import anthropic
  from anthropic.types import (
      MessageParam,
      TextBlockParam,
      SearchResultBlockParam,
      ToolResultBlockParam,
  )

  client = anthropic.Anthropic()

  # 定义知识库搜索工具
  knowledge_base_tool = {
      "name": "search_knowledge_base",
      "description": "搜索公司知识库获取信息",
      "input_schema": {
          "type": "object",
          "properties": {
              "query": {"type": "string", "description": "搜索查询"}
          },
          "required": ["query"]
      }
  }

  def search_knowledge_base(query: str):
      """你的实际搜索逻辑（这里用 mock 数据）"""
      # TODO: 实际搜索你的数据库/向量库/API

      # 示例：基于 query 返回相关结果
      all_docs = [
          {
              "source": "https://docs.company.com/product",
              "title": "产品配置指南",
              "text": "配置产品请导航到 设置 > 配置。默认超时 30 秒，"
                      "可调整为 10-120 秒。"
          },
          {
              "source": "https://docs.company.com/troubleshoot",
              "title": "故障排除指南",
              "text": "遇到超时错误时，首先检查配置设置。常见原因包括"
                      "网络延迟和错误的超时值。"
          }
      ]

      # 简单的关键词匹配
      results = []
      for doc in all_docs:
          if any(word in doc["text"] for word in query.split()):
              results.append(SearchResultBlockParam(
                  type="search_result",
                  source=doc["source"],
                  title=doc["title"],
                  content=[TextBlockParam(type="text", text=doc["text"])],
                  citations={"enabled": True}
              ))

      return results

  # 第一轮：让 Claude 决定是否调用工具
  response = client.messages.create(
      model="claude-opus-4-8",
      max_tokens=1024,
      tools=[knowledge_base_tool],
      messages=[{
          "role": "user",
          "content": "我该如何配置超时设置？"
      }]
  )

  # 第二轮：如果 Claude 调用工具，返回搜索结果
  if response.content[0].type == "tool_use":
      tool_use = response.content[0]
      query = tool_use.input["query"]

      # 执行搜索
      search_results = search_knowledge_base(query)

      # 将结果作为 tool_result 返回
      final_response = client.messages.create(
          model="claude-opus-4-8",
          max_tokens=1024,
          messages=[
              {"role": "user", "content": "我该如何配置超时设置？"},
              {"role": "assistant", "content": response.content},
              {
                  "role": "user",
                  "content": [
                      ToolResultBlockParam(
                          type="tool_result",
                          tool_use_id=tool_use.id,
                          content=search_results  # ← 搜索结果在这里
                      )
                  ]
              }
          ]
      )

      # 解析带引用的最终回答
      for block in final_response.content:
          if block.type == "text":
              print(block.text, end="")
              if hasattr(block, "citations") and block.citations:
                  for cite in block.citations:
                      print(f"\n  [{cite.title}] {cite.source}")

  6.3 示例 3：多块内容（精细引用）

  # 把内容拆成多个块，让 Claude 能精确引用某一段
  search_result = SearchResultBlockParam(
      type="search_result",
      source="https://docs.company.com/api-guide",
      title="API 完整指南",
      content=[
          TextBlockParam(
              type="text",
              text="认证：所有 API 请求需要 API key。"
          ),
          TextBlockParam(
              type="text",
              text="速率限制：API 允许每 key 1000 请求/小时。"
          ),
          TextBlockParam(
              type="text",
              text="错误处理：API 返回标准 HTTP 状态码。"
          )
      ],
      citations={"enabled": True}
  )

  # Claude 可能只引用第二个块
  # 引用的 start_block_index=1, end_block_index=2

  6.4 示例 4：真实 RAG 系统（向量库集成）

  import anthropic
  from anthropic.types import (
      SearchResultBlockParam,
      TextBlockParam
  )
  # 假设你已经有了向量库客户端
  # from your_vector_db import VectorDBClient

  client = anthropic.Anthropic()
  # db = VectorDBClient()

  def rag_with_search_results(query: str) -> str:
      """
      完整的 RAG 流程：
      1. 用 query 检索向量库
      2. 把结果转换为 search_result 块
      3. 让 Claude 基于结果回答并引用
      """

      # 步骤 1：检索（mock）
      # chunks = db.search(query, top_k=5)
      chunks = [
          {
              "id": "doc-001",
              "source": "https://kb.company.com/setup",
              "title": "安装指南",
              "score": 0.92,
              "text": "安装步骤：1. 下载 SDK；2. 配置环境变量；3. 运行测试。"
          },
          {
              "id": "doc-042",
              "source": "https://kb.company.com/config",
              "title": "配置说明",
              "score": 0.87,
              "text": "配置项包括：API_KEY、TIMEOUT、RETRY_COUNT。"
          },
          {
              "id": "doc-103",
              "source": "https://kb.company.com/troubleshoot",
              "title": "常见问题",
              "score": 0.75,
              "text": "常见错误：API key 无效、网络连接超时、权限不足。"
          }
      ]

      # 步骤 2：转换为 search_result 块
      search_results = [
          SearchResultBlockParam(
              type="search_result",
              source=chunk["source"],
              title=chunk["title"],
              content=[
                  TextBlockParam(type="text", text=chunk["text"])
              ],
              citations={"enabled": True}
          )
          for chunk in chunks
      ]

      # 步骤 3：构造请求
      response = client.messages.create(
          model="claude-opus-4-8",
          max_tokens=1024,
          messages=[{
              "role": "user",
              "content": search_results + [
                  TextBlockParam(
                      type="text",
                      text=f"基于上述搜索结果，请回答：{query}"
                  )
              ]
          }]
      )

      # 步骤 4：解析响应
      answer_parts = []
      citations_info = []

      for block in response.content:
          if block.type != "text":
              continue

          answer_parts.append(block.text)

          if hasattr(block, "citations") and block.citations:
              for cite in block.citations:
                  citations_info.append({
                      "title": cite.title,
                      "source": cite.source,
                      "text": cite.cited_text
                  })

      answer = "".join(answer_parts)

      # 附加引用编号
      for i, cite in enumerate(citations_info, 1):
          answer += f"\n[{i}] {cite['title']} - {cite['source']}"

      return answer

  # 使用
  answer = rag_with_search_results("如何配置系统？")
  print(answer)

  6.5 示例 5：结合提示缓存

  # 对于重复使用的搜索结果，启用缓存
  cached_search_result = SearchResultBlockParam(
      type="search_result",
      source="https://docs.company.com/core-api",
      title="核心 API 文档",
      content=[
          TextBlockParam(type="text", text="核心 API 说明...")
      ],
      citations={"enabled": True},
      cache_control={"type": "ephemeral"}  # ← 启用缓存
  )

  # 多次请求中复用，第二次起缓存命中
  for query in queries:
      response = client.messages.create(
          model="claude-opus-4-8",
          messages=[{
              "role": "user",
              "content": [
                  cached_search_result,  # ← 缓存命中
                  TextBlockParam(type="text", text=query)
              ]
          }]
      )

  6.6 示例 6：错误处理与回退

  def robust_search_and_cite(query: str) -> str:
      """带错误处理的 RAG"""

      # 步骤 1：尝试搜索
      try:
          results = perform_real_search(query)

          if not results:
              # 没找到结果，用纯文本回退
              fallback = TextBlockParam(
                  type="text",
                  text="未找到相关结果。请尝试换个关键词。"
              )
              content = [fallback, TextBlockParam(type="text", text=query)]
          else:
              # 正常搜索结果
              search_blocks = [
                  SearchResultBlockParam(
                      type="search_result",
                      source=r["source"],
                      title=r["title"],
                      content=[TextBlockParam(type="text", text=r["text"])],
                      citations={"enabled": True}
                  )
                  for r in results
              ]
              content = search_blocks + [TextBlockParam(type="text", text=query)]

      except Exception as e:
          # 搜索出错，用错误信息回退
          content = [
              TextBlockParam(
                  type="text",
                  text=f"搜索服务暂时不可用：{str(e)}"
              ),
              TextBlockParam(type="text", text=query)
          ]

      # 步骤 2：让 Claude 回答
      response = client.messages.create(
          model="claude-opus-4-8",
          max_tokens=1024,
          messages=[{"role": "user", "content": content}]
      )

      return response.content[0].text

  ---
  七、响应中的引用格式

  7.1 search_result_location 结构

  {
    "type": "search_result_location",
    "cited_text": "被引用的完整文本",           // ← 不计入输出 token
    "source": "https://...",                    // ← 来自原始搜索结果
    "title": "文章标题",                          // ← 来自原始搜索结果
    "search_result_index": 0,                   // ← 第几个搜索结果（跨消息排序）
    "start_block_index": 0,                     // ← content 数组起始索引
    "end_block_index": 1                        // ← content 数组结束索引（不含）
  }

  7.2 与其他引用类型的对比

  ┌────────────────────────┬──────────────┬───────────────────────────┐
  │        引用类型        │     含义     │         索引基准          │
  ├────────────────────────┼──────────────┼───────────────────────────┤
  │ char_location          │ 字符位置     │ 纯文本的字符索引          │
  ├────────────────────────┼──────────────┼───────────────────────────┤
  │ page_location          │ 页码位置     │ PDF 的页码                │
  ├────────────────────────┼──────────────┼───────────────────────────┤
  │ content_block_location │ 块位置       │ 自定义内容文档的块索引    │
  ├────────────────────────┼──────────────┼───────────────────────────┤
  │ search_result_location │ 搜索结果位置 │ 搜索结果的 content 块索引 │
  └────────────────────────┴──────────────┴───────────────────────────┘

  7.3 索引说明

  - search_result_index：跨所有消息中所有 search_result 块的顺序索引（从 0 开始）
  - start_block_index / end_block_index：单个 search_result 的 content 数组切片

  示例：
  用户消息中：
    search_result A (index=0)
    search_result B (index=1)

  工具结果中：
    search_result C (index=2)  ← 注意：跨消息累计

  引用 B 时：
    search_result_index = 1
    start_block_index = 0
    end_block_index = 2  ← 引用 B.content[0:2]

  ---
  八、最佳实践

  8.1 内容分块策略

  # ❌ 差：一整块内容（引用粒度粗）
  search_result = SearchResultBlockParam(
      content=[
          TextBlockParam(type="text", text="非常长的内容..." * 100)
      ]
  )

  # ✅ 好：按语义拆分（引用粒度细）
  search_result = SearchResultBlockParam(
      content=[
          TextBlockParam(type="text", text="认证说明..."),
          TextBlockParam(type="text", text="速率限制..."),
          TextBlockParam(type="text", text="错误处理...")
      ]
  )

  8.2 source 格式

  # ✅ 好：使用稳定、永久的 URL
  source = "https://docs.company.com/v2/api-auth"

  # ✅ 好：数据库 ID（当没有 URL 时）
  source = "kb://doc-12345"

  # ❌ 差：临时 URL 或空字符串
  source = ""  # 无法追溯
  source = "https://example.com/temp-abc123"  # 临时链接

  8.3 结果数量控制

  # ✅ 好：限制 top_k，避免上下文溢出
  MAX_RESULTS = 10

  def search_and_limit(query: str):
      all_results = vector_db.search(query)
      return all_results[:MAX_RESULTS]  # 只保留最相关的

  8.4 引用必须全部启用或全部禁用

  # ❌ 错误：混合设置（会报错）
  results = [
      SearchResultBlockParam(..., citations={"enabled": True}),
      SearchResultBlockParam(..., citations={"enabled": False})  # ← 400 错误
  ]

  # ✅ 正确：全部一致
  results = [
      SearchResultBlockParam(..., citations={"enabled": True}),
      SearchResultBlockParam(..., citations={"enabled": True})
  ]

  ---
  九、常见误区

  ❌ 误区 1：可以混合启用/禁用引用

  正确：请求中所有 search_result 的 citations 设置必须一致。

  ❌ 误区 2：search_result 只用于工具返回

  正确：既可作为 tool_result，也可作为顶层消息内容。

  ❌ 误区 3：cited_text 计入输出 token

  正确：和 Citations 一样，cited_text 不计入输出 token。

  ❌ 误区 4：可以引用图片

  正确：search_result 的 content 只能是 text 块，不支持图片。

  ❌ 误区 5：引用粒度可以是字符级

  正确：引用的是整个文本块（content
  数组的切片），不是块内的子字符串。要更细粒度，就把内容拆成更小的块。

  ❌ 误区 6：和 Citations 功能可以一起用

  正确：两者可以独立使用，但不能在同一个 search_result 上同时启用 Citations 的文档引用。

  ---
  十、实际场景模板

  10.1 企业知识库 RAG

  class EnterpriseRAG:
      def __init__(self, vector_db, anthropic_client):
          self.db = vector_db
          self.client = anthropic_client

      def query(self, question: str, top_k: int = 5) -> dict:
          # 1. 检索
          chunks = self.db.search(question, top_k=top_k)

          # 2. 构造搜索结果
          search_results = [
              SearchResultBlockParam(
                  type="search_result",
                  source=chunk["metadata"]["url"],
                  title=chunk["metadata"]["title"],
                  content=[TextBlockParam(type="text", text=chunk["text"])],
                  citations={"enabled": True}
              )
              for chunk in chunks
          ]

          # 3. 调用 API
          response = self.client.messages.create(
              model="claude-opus-4-8",
              max_tokens=2048,
              messages=[{
                  "role": "user",
                  "content": search_results + [
                      TextBlockParam(
                          type="text",
                          text=f"基于公司内部知识库，回答以下问题：{question}\n\n"
                               "请引用相关来源。"
                      )
                  ]
              }]
          )

          # 4. 解析响应
          answer_text = []
          citations = []

          for block in response.content:
              if block.type == "text":
                  answer_text.append(block.text)
                  if hasattr(block, "citations") and block.citations:
                      citations.extend(block.citations)

          return {
              "answer": "".join(answer_text),
              "citations": [{
                  "title": c.title,
                  "source": c.source,
                  "text": c.cited_text
              } for c in citations]
          }

  # 使用
  rag = EnterpriseRAG(vector_db, anthropic.Anthropic())
  result = rag.query("公司的年假政策是什么？")
  print(result["answer"])
  print("\n参考来源:")
  for c in result["citations"]:
      print(f"  - {c['title']}: {c['source']}")

  10.2 多轮对话 RAG

  def multi_turn_rag():
      """支持多轮的 RAG 系统"""

      messages = []

      while True:
          user_input = input("你的问题：")
          if user_input.lower() in ["quit", "exit"]:
              break

          # 每轮都重新检索（可以累积上下文）
          results = search_for(user_input)
          search_blocks = results_to_search_blocks(results)

          # 构造当前轮的消息
          current_content = search_blocks + [
              TextBlockParam(type="text", text=user_input)
          ]

          messages.append({"role": "user", "content": current_content})

          # 调用 API
          response = client.messages.create(
              model="claude-opus-4-8",
              max_tokens=1024,
              messages=messages  # ← 包含历史
          )

          # 更新消息历史
          messages.append({"role": "assistant", "content": response.content})

          # 显示回答
          for block in response.content:
              if block.type == "text":
                  print(block.text, end="")
                  if hasattr(block, "citations") and block.citations:
                      for c in block.citations:
                          print(f"\n[引用: {c.title}]")
          print("\n")

  ---
  十一、一句话总结

  ▎ Search Results = 让你的 RAG 结果自带引用：type: "search_result" 块包含
  ▎ source/title/content，配合 citations.enabled=true，Claude 回答时自动生成
  ▎ search_result_location 引用；支持工具返回或顶层内容两种方式；content
  ▎ 块是引用最小单位（要精细引用就拆小块）；cited_text 不计入 token。

  ---

====================十二、流式传输拒绝（Streaming Refusal）完全学习指南====================
 一、一句话定位

  流式传输拒绝 = Claude 在回答过程中发现违规，中途停止并告知"我不能继续"：当流式分类器检测到违反
  Anthropic 政策的内容时，API 返回 stop_reason: "refusal"，而不是继续生成。

  类比：
  - 普通回答 = 老师一直在黑板上写字
  - 拒绝 = 老师写了一半发现题目有问题，停下来擦掉说"这道题我不能教"
  ---
  二、源码中的实现

  src/services/api/errors.ts 第 1184–1207 行：

  export function getErrorMessageIfRefusal(
    stopReason: BetaStopReason | null,
    model: string,
  ): AssistantMessage | undefined {
    if (stopReason !== 'refusal') return

    logEvent('tengu_refusal_api_response', {})

    const baseMessage = getIsNonInteractiveSession()
      ? `Claude Code 无法响应此请求，该请求似乎违反了我们的使用政策...`
      : `Claude Code 无法响应此请求...请按两次 esc 编辑上一条消息，或开始新会话...`

    // 建议用户切换到 Sonnet 4（拒绝率较低）
    const modelSuggestion = model !== 'claude-sonnet-4-20250514'
      ? '如果你反复看到此拒绝，请尝试运行 /model claude-sonnet-4-20250514 切换模型。'
      : ''

    return createAssistantAPIErrorMessage({
      content: baseMessage + modelSuggestion,
      error: 'invalid_request',
    })
  }

  关键理解：
  - Claude Code 检测到 stop_reason: "refusal" 后，显示错误消息
  - 建议用户切换到 claude-sonnet-4（拒绝率较低）
  - 记录分析事件 tengu_refusal_api_response

  ---
  三、三种拒绝类型对比

  ┌────────────────────┬─────────────────────────────────────┬────────────────┬────────────────┐  
  │      拒绝类型      │              响应格式               │    发生时机    │      计费      │  
  ├────────────────────┼─────────────────────────────────────┼────────────────┼────────────────┤  
  │ 流式传输分类器拒绝 │ stop_reason: "refusal"              │ 流式传输中违规 │ 已生成的 token │  
  │                    │                                     │                │  计费          │  
  ├────────────────────┼─────────────────────────────────────┼────────────────┼────────────────┤  
  │ API 输入验证拒绝   │ 400 错误                            │ 请求前验证失败 │ 不计费         │  
  ├────────────────────┼─────────────────────────────────────┼────────────────┼────────────────┤  
  │ 模型自身拒绝       │ 标准文本响应（如"抱歉，我不能..."） │ 模型判断违规   │ 按正常响应计费 │  
  └────────────────────┴─────────────────────────────────────┴────────────────┴────────────────┘  

  ---
  四、拒绝响应的结构

  4.1 基础格式

  {
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "Hello.."    // ← 拒绝前可能已生成的部分文本
      }
    ],
    "stop_reason": "refusal",    // ← 关键标识
    "usage": {
      "input_tokens": 10,
      "output_tokens": 5
    }
  }

  关键点：
  - HTTP 状态码是 200（成功），不是错误
  - 响应中没有额外的拒绝消息
  - 必须自己处理并提供用户友好的消息

  4.2 Fable 5 扩展格式（带策略类别）

  {
    "role": "assistant",
    "content": [...],
    "stop_reason": "refusal",
    "stop_details": {
      "category": "harmful_content"    // ← 拒绝类别
    },
    "usage": {...}
  }

  ---
  五、Python 完整示例

  5.1 示例 1：基础检测（流式传输）

  import anthropic

  client = anthropic.Anthropic()
  messages = []

  def reset_conversation():
      """拒绝后重置对话上下文"""
      global messages
      messages = []
      print("⚠️ 对话已重置（因为检测到拒绝）")

  def ask_question(question: str):
      """提问并处理可能的拒绝"""
      global messages

      try:
          with client.messages.stream(
              model="claude-opus-4-8",
              max_tokens=1024,
              messages=messages + [{"role": "user", "content": question}],
          ) as stream:
              full_response = ""
              refused = False

              for event in stream:
                  # 检查流式事件中的拒绝
                  if event.type == "message_delta":
                      if hasattr(event.delta, "stop_reason") and event.delta.stop_reason ==       
  "refusal":
                          print("\n❌ 响应被拒绝")
                          refused = True
                          reset_conversation()
                          break

                  # 累积正常文本
                  if event.type == "content_block_delta":
                      if hasattr(event.delta, "text"):
                          print(event.delta.text, end="", flush=True)
                          full_response += event.delta.text

              if not refused:
                  print()  # 换行
                  # 添加到历史
                  messages.append({"role": "user", "content": question})
                  messages.append({"role": "assistant", "content": full_response})
                  return full_response

      except Exception as e:
          print(f"错误: {e}")
          return None

  # 使用
  ask_question("你好，请做个自我介绍")

  5.2 示例 2：带备用模型重试

  import anthropic
  from typing import Optional

  client = anthropic.Anthropic()

  PRIMARY_MODEL = "claude-opus-4-8"
  FALLBACK_MODEL = "claude-sonnet-4-6"

  def ask_with_fallback(question: str, max_retries: int = 1) -> Optional[str]:
      """
      带备用模型的拒绝重试
      """
      models_to_try = [PRIMARY_MODEL]
      if max_retries > 0:
          models_to_try.append(FALLBACK_MODEL)

      for attempt, model in enumerate(models_to_try):
          print(f"\n[尝试 {attempt + 1}/{len(models_to_try)}] 使用模型: {model}")

          try:
              response = client.messages.create(
                  model=model,
                  max_tokens=1024,
                  messages=[{"role": "user", "content": question}]
              )

              # 检查拒绝
              if response.stop_reason == "refusal":
                  print(f"⚠️ 模型 {model} 拒绝了请求")

                  # Fable 5 可以读取拒绝类别
                  if hasattr(response, "stop_details") and response.stop_details:
                      print(f"   拒绝类别: {response.stop_details.category}")

                  # 如果还有备用模型，继续重试
                  if attempt < len(models_to_try) - 1:
                      print("   尝试下一个备用模型...")
                      continue
                  else:
                      print("   所有模型都拒绝了请求")
                      return None

              # 正常响应
              print(f"✓ 使用模型 {model} 成功回答")
              return response.content[0].text

          except anthropic.APIError as e:
              print(f"API 错误: {e}")
              if attempt < len(models_to_try) - 1:
                  continue
              return None

      return None

  # 使用
  answer = ask_with_fallback("如何制作...（敏感内容）...")
  if answer:
      print(f"\n回答: {answer}")

  5.3 示例 3：SDK 中间件方式

  import anthropic
  from anthropic import AsyncAnthropic
  from typing import Any

  class RefusalHandlingClient:
      """
      封装 Anthropic 客户端，自动处理拒绝
      """

      def __init__(self, primary_model: str, fallback_model: str):
          self.client = anthropic.Anthropic()
          self.primary_model = primary_model
          self.fallback_model = fallback_model

      def create(self, **kwargs) -> Any:
          """带拒绝处理的请求"""

          # 第一次尝试：主模型
          try:
              response = self.client.messages.create(
                  model=self.primary_model,
                  **kwargs
              )

              if response.stop_reason == "refusal":
                  print(f"⚠️ 主模型 {self.primary_model} 拒绝，切换到备用模型")
                  # 第二次尝试：备用模型
                  response = self.client.messages.create(
                      model=self.fallback_model,
                      **kwargs
                  )

                  if response.stop_reason == "refusal":
                      raise RefusalError("两个模型都拒绝了请求")

              return response

          except anthropic.APIError as e:
              print(f"API 错误: {e}")
              raise

  class RefusalError(Exception):
      """拒绝异常"""
      pass

  # 使用
  client = RefusalHandlingClient(
      primary_model="claude-opus-4-8",
      fallback_model="claude-sonnet-4-6"
  )

  try:
      response = client.create(
          max_tokens=1024,
          messages=[{"role": "user", "content": "你好"}]
      )
      print(response.content[0].text)
  except RefusalError as e:
      print(f"拒绝错误: {e}")

  5.4 示例 4：流式传输 + 备用模型

  import anthropic

  client = anthropic.Anthropic()

  def stream_with_fallback(question: str):
      """流式传输带备用模型"""

      models = ["claude-opus-4-8", "claude-sonnet-4-6"]

      for model in models:
          print(f"\n[模型: {model}]")

          try:
              with client.messages.stream(
                  model=model,
                  max_tokens=1024,
                  messages=[{"role": "user", "content": question}]
              ) as stream:
                  refused = False
                  full_text = ""

                  for event in stream:
                      if event.type == "message_delta":
                          if (hasattr(event.delta, "stop_reason") and
                              event.delta.stop_reason == "refusal"):
                              print("\n⚠️ 拒绝，切换到下一个模型...")
                              refused = True
                              break

                      if event.type == "content_block_delta":
                          if hasattr(event.delta, "text"):
                              print(event.delta.text, end="", flush=True)
                              full_text += event.delta.text

                  if not refused:
                      print()
                      return full_text

          except Exception as e:
              print(f"错误: {e}")
              continue

      print("❌ 所有模型都拒绝了请求")
      return None

  # 使用
  answer = stream_with_fallback("你的问题")

  5.5 示例 5：批处理中的拒绝处理

  import anthropic
  from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
  from anthropic.types.messages.batch_create_params import Request

  client = anthropic.Anthropic()

  def process_batch_with_refusal_detection(batch_id: str):
      """
      批处理结果中检测拒绝
      """
      results = {
          "succeeded": [],
          "refused": [],
          "errored": [],
          "expired": []
      }

      for result in client.messages.batches.results(batch_id):
          result_type = result.result.type

          if result_type == "succeeded":
              # 检查是否是拒绝（批处理中拒绝也算 succeeded！）
              if result.result.message.stop_reason == "refusal":
                  results["refused"].append({
                      "custom_id": result.custom_id,
                      "message": "请求被拒绝"
                  })
                  print(f"⚠️ {result.custom_id}: 拒绝")
              else:
                  results["succeeded"].append({
                      "custom_id": result.custom_id,
                      "response": result.result.message.content[0].text
                  })
                  print(f"✓ {result.custom_id}: 成功")

          elif result_type == "errored":
              results["errored"].append(result.custom_id)
              print(f"✗ {result.custom_id}: 错误")

          elif result_type == "expired":
              results["expired"].append(result.custom_id)
              print(f"⏰ {result.custom_id}: 过期")

      print(f"\n统计: 成功 {len(results['succeeded'])}, "
            f"拒绝 {len(results['refused'])}, "
            f"错误 {len(results['errored'])}")

      return results

  ---
  六、计费规则

  6.1 不同阶段的计费

  ┌────────────────────────────────────────────┬──────────────────────────┐
  │                    情况                    │           计费           │
  ├────────────────────────────────────────────┼──────────────────────────┤
  │ 拒绝发生在生成前（未生成任何 token）       │ 不计费（usage 仅供参考） │
  ├────────────────────────────────────────────┼──────────────────────────┤
  │ 拒绝发生在生成中（已生成部分 token）       │ 已生成的 token 计费      │
  ├────────────────────────────────────────────┼──────────────────────────┤
  │ 拒绝发生在生成后（完整响应后被分类器拦截） │ 全部 token 计费          │
  └────────────────────────────────────────────┴──────────────────────────┘

  6.2 实际影响

  场景 A：用户问"如何制作炸弹"
    → 分类器立即拒绝，0 token 计费 ✓

  场景 B：用户问了一个正常问题，Claude 回答一半
    → 突然检测到违规，已生成的 token 计费 💰

  场景 C：完整回答后，分类器事后拦截
    → 全部 token 计费 💰

  ---
  七、恢复策略

  7.1 策略 1：重置上下文（最简单）

  def handle_refusal(messages):
      """简单策略：清空历史"""
      return []  # 清空所有历史

  优点：简单直接
  缺点：丢失对话历史

  7.2 策略 2：删除触发拒绝的消息

  def handle_refusal_smart(messages):
      """智能策略：删除最后一条用户消息"""
      # 找到最后一条用户消息并移除
      for i in range(len(messages) - 1, -1, -1):
          if messages[i]["role"] == "user":
              return messages[:i]  # 移除这条及之后的
      return messages

  优点：保留更多历史
  缺点：可能无法完全消除问题

  7.3 策略 3：切换到备用模型（推荐）

  def handle_refusal_with_fallback(question, messages):
      """最佳策略：换模型重试"""

      # 策略 A：服务器端备用（推荐）
      response = client.messages.create(
          model="claude-opus-4-8",
          messages=messages,
          # 配置备用模型（需要 API 支持）
      )

      # 策略 B：客户端手动重试
      if response.stop_reason == "refusal":
          response = client.messages.create(
              model="claude-sonnet-4-6",  # 拒绝率较低
              messages=messages,
              max_tokens=1024
          )

      return response

  优点：最大程度保留上下文
  缺点：需要配置备用模型

  7.4 策略 4：改写用户消息

  def rewrite_and_retry(question: str):
      """改写问题后重试"""

      # 让 Claude 帮忙改写（用温和的方式）
      rewrite_prompt = f"""请帮我把这个问题改写成更温和、中立的版本，
  保留核心问题但移除可能引起误解的表述：

  原问题：{question}

  请直接返回改写后的问题，不要解释。"""

      rewrite_response = client.messages.create(
          model="claude-sonnet-4-6",
          max_tokens=256,
          messages=[{"role": "user", "content": rewrite_prompt}]
      )

      rewritten = rewrite_response.content[0].text

      # 用改写后的问题重新提问
      return client.messages.create(
          model="claude-opus-4-8",
          max_tokens=1024,
          messages=[{"role": "user", "content": rewritten}]
      )

  ---
  八、最佳实践

  8.1 监控拒绝

  import logging
  from collections import defaultdict

  class RefusalTracker:
      def __init__(self):
          self.refusals = defaultdict(int)
          self.total_requests = 0

      def track(self, model: str, refused: bool):
          self.total_requests += 1
          if refused:
              self.refusals[model] += 1

          # 拒绝率超过阈值时告警
          refusal_rate = self.refusals[model] / max(1, self.total_requests)
          if refusal_rate > 0.1:  # 10%
              logging.warning(
                  f"模型 {model} 拒绝率过高: {refusal_rate:.2%}"
              )

      def get_stats(self):
          return {
              "total": self.total_requests,
              "refusals_by_model": dict(self.refusals),
              "overall_rate": sum(self.refusals.values()) / max(1, self.total_requests)
          }

  # 使用
  tracker = RefusalTracker()

  response = client.messages.create(...)
  tracker.track(
      model=response.model,
      refused=(response.stop_reason == "refusal")
  )

  8.2 用户友好的错误消息

  def get_user_friendly_refusal_message(stop_details=None):
      """生成用户友好的拒绝消息"""

      base_messages = [
          "抱歉，我无法回答这个问题。",
          "这个问题超出了我的能力范围。",
          "我无法提供这方面的帮助。"
      ]

      # 如果有策略类别，提供更具体的提示
      if stop_details and hasattr(stop_details, "category"):
          category = stop_details.category

          if category == "harmful_content":
              return
  "这个问题涉及可能造成伤害的内容，我无法提供帮助。如果您有其他问题，我很乐意协助。"
          elif category == "illegal_activity":
              return "这涉及非法活动，我不能提供相关信息。"
          else:
              return "抱歉，由于内容政策限制，我无法回答这个问题。"

      # 默认消息
      return "抱歉，我无法回答这个问题。请尝试重新表述或询问其他问题。"

  8.3 生产环境配置

  class ProductionChatbot:
      def __init__(self):
          self.client = anthropic.Anthropic()
          self.primary_model = "claude-opus-4-8"
          self.fallback_models = ["claude-sonnet-4-6", "claude-haiku-4-5"]
          self.tracker = RefusalTracker()
          self.max_retries = 2

      def chat(self, user_message: str, conversation_history: list) -> dict:
          """生产级聊天接口"""

          messages = conversation_history + [
              {"role": "user", "content": user_message}
          ]

          last_error = None

          for attempt in range(self.max_retries + 1):
              model = self.primary_model if attempt == 0 else self.fallback_models[attempt - 1]   

              try:
                  response = self.client.messages.create(
                      model=model,
                      max_tokens=1024,
                      messages=messages
                  )

                  # 追踪
                  refused = (response.stop_reason == "refusal")
                  self.tracker.track(model, refused)

                  if refused:
                      logging.info(f"模型 {model} 拒绝，尝试下一个")
                      continue

                  # 成功
                  return {
                      "status": "success",
                      "model": model,
                      "response": response.content[0].text,
                      "usage": response.usage
                  }

              except anthropic.APIError as e:
                  last_error = e
                  logging.error(f"API 错误: {e}")
                  continue

          # 所有尝试失败
          return {
              "status": "error",
              "message": get_user_friendly_refusal_message(),
              "error": str(last_error) if last_error else "unknown"
          }

  ---
  九、常见误区

  ❌ 误区 1：拒绝是 4xx/5xx 错误

  正确：拒绝是 HTTP 200 成功响应，带有 stop_reason: "refusal"。仅靠错误率监控抓不到拒绝。

  ❌ 误区 2：拒绝后继续用同一模型重试

  正确：同一模型几乎必然再次拒绝。应该换模型或重置上下文。

  ❌ 误区 3：批处理中拒绝会被标记为 errored

  正确：批处理中拒绝是 succeeded 结果，但 stop_reason 是 "refusal"。必须主动检查。

  ❌ 误区 4：拒绝后不重置上下文继续对话

  正确：不重置上下文必然导致持续拒绝。

  ❌ 误区 5：拒绝不计费

  正确：拒绝前已生成的 token 会计费。只有完全未生成时才不计费。

  ❌ 误区 6：只有流式传输才有拒绝

  正确：非流式、批处理、所有模型都有拒绝可能。

  ---
  十、一句话总结

  ▎ 流式传输拒绝 = 中途停止 + stop_reason: "refusal"：HTTP 200
  ▎ 成功响应，必须自己处理；拒绝后必须重置上下文或换模型；批处理中拒绝是 succeeded
  ▎ 但需主动检查；最佳实践是配置备用模型自动重试；已生成的 token 会计费。

  ---


====================十三、多语言支持（Multilingual Support）完全学习指南====================
一、一句话定位

  多语言支持 = Claude 天生会说多种语言：无需特殊配置，Claude 在 15+
  种主流语言上都能保持接近英语的性能（主流语言 95%+，小众语言 80%+）。

  关键点：多语言是模型的内在能力，不需要 API 参数或特殊配置。
  
  ---
  二、性能数据解读

  2.1 各语言相对英语的性能

  ┌──────────────────┬──────────┬────────────┬───────────┬────────────┐
  │       语言       │ Opus 4.1 │ Sonnet 4.5 │ Haiku 4.5 │  实用建议  │
  ├──────────────────┼──────────┼────────────┼───────────┼────────────┤
  │ 英语（基准）     │ 100%     │ 100%       │ 100%      │ 最佳       │
  ├──────────────────┼──────────┼────────────┼───────────┼────────────┤
  │ 西班牙语         │ 98.1%    │ 98.2%      │ 96.4%     │ 几乎无损失 │
  ├──────────────────┼──────────┼────────────┼───────────┼────────────┤
  │ 葡萄牙语（巴西） │ 97.8%    │ 97.8%      │ 96.1%     │ 几乎无损失 │
  ├──────────────────┼──────────┼────────────┼───────────┼────────────┤
  │ 意大利语         │ 97.7%    │ 97.9%      │ 96.0%     │ 几乎无损失 │
  ├──────────────────┼──────────┼────────────┼───────────┼────────────┤
  │ 法语             │ 97.9%    │ 97.5%      │ 95.7%     │ 几乎无损失 │
  ├──────────────────┼──────────┼────────────┼───────────┼────────────┤
  │ 德语             │ 97.7%    │ 97.0%      │ 94.3%     │ 几乎无损失 │
  ├──────────────────┼──────────┼────────────┼───────────┼────────────┤
  │ 中文（简体）     │ 97.1%    │ 96.9%      │ 94.2%     │ 优秀       │
  ├──────────────────┼──────────┼────────────┼───────────┼────────────┤
  │ 日语             │ 96.9%    │ 96.8%      │ 93.5%     │ 优秀       │
  ├──────────────────┼──────────┼────────────┼───────────┼────────────┤
  │ 韩语             │ 96.6%    │ 96.7%      │ 93.3%     │ 优秀       │
  ├──────────────────┼──────────┼────────────┼───────────┼────────────┤
  │ 阿拉伯语         │ 97.1%    │ 97.2%      │ 92.5%     │ 优秀       │
  ├──────────────────┼──────────┼────────────┼───────────┼────────────┤
  │ 印地语           │ 96.8%    │ 96.7%      │ 92.4%     │ 优秀       │
  ├──────────────────┼──────────┼────────────┼───────────┼────────────┤
  │ 孟加拉语         │ 95.7%    │ 95.4%      │ 90.4%     │ 良好       │
  ├──────────────────┼──────────┼────────────┼───────────┼────────────┤
  │ 斯瓦希里语       │ 89.8%    │ 91.1%      │ 78.3%     │ 可接受     │
  ├──────────────────┼──────────┼────────────┼───────────┼────────────┤
  │ 约鲁巴语         │ 80.3%    │ 79.7%      │ 52.7%     │ 谨慎使用   │
  └──────────────────┴──────────┴────────────┴───────────┴────────────┘

  2.2 关键洞察

  1. 主流语言（西、葡、意、法、德、中、日、韩）都在 95%+
    - 几乎感觉不到性能差异
    - 可以放心用于生产
  2. 中文表现优异（97.1%）
    - 略低于欧洲语言，但仍在顶尖水平
    - 简体中文 > 繁体中文（训练数据差异）
  3. Haiku 的多语言能力相对更弱
    - 在资源稀缺语言上差距更明显
    - 约鲁巴语只有 52.7%（几乎不能用）
    - 多语言场景建议用 Opus 或 Sonnet
  4. 性能数据基于扩展思考
    - 启用 thinking 后效果更好
    - 不启用思考时性能会略降

  ---
  三、Python 完整示例

  3.1 示例 1：强制指定响应语言

  import anthropic

  client = anthropic.Anthropic()

  def ask_in_language(question: str, target_language: str) -> str:
      """
      强制 Claude 用指定语言回答
      """
      response = client.messages.create(
          model="claude-opus-4-8",
          max_tokens=1024,
          system=f"Always respond in {target_language}, regardless of the language the user writes
  in.",
          messages=[{
              "role": "user",
              "content": question
          }]
      )

      return response.content[0].text

  # 测试：用英语提问，要求用法语回答
  answer = ask_in_language(
      question="How do I reset my password?",
      target_language="French"
  )
  print(answer)
  # 输出：Pour réinitialiser votre mot de passe...

  3.2 示例 2：翻译助手

  def translate(text: str, source_lang: str, target_lang: str) -> str:
      """
      专业翻译助手
      """
      response = client.messages.create(
          model="claude-opus-4-8",
          max_tokens=2048,
          system=f"""You are a professional translator.
  Translate the user's message from {source_lang} to {target_lang}.
  Respond with only the translation, no explanations.""",
          messages=[{"role": "user", "content": text}]
      )

      return response.content[0].text

  # 使用
  english_text = "The quick brown fox jumps over the lazy dog."
  chinese = translate(english_text, "English", "Chinese (Simplified)")
  print(f"中文: {chinese}")
  # 输出: 敏捷的棕色狐狸跳过了懒狗。

  japanese = translate(english_text, "English", "Japanese")
  print(f"日本語: {japanese}")
  # 输出: 素早い茶色の狐が怠け者の犬を飛び越える。

  3.3 示例 3：多语言客服机器人

  class MultilingualSupportBot:
      """多语言客服机器人"""

      SUPPORTED_LANGUAGES = {
          "en": "English",
          "zh": "Chinese (Simplified)",
          "ja": "Japanese",
          "ko": "Korean",
          "es": "Spanish",
          "fr": "French",
          "de": "German",
          "pt": "Portuguese (Brazil)",
          "ar": "Arabic",
      }

      def __init__(self, default_language: str = "zh"):
          self.client = anthropic.Anthropic()
          self.default_language = default_language
          self.conversations = {}  # user_id -> messages

      def set_language(self, user_id: str, language_code: str):
          """设置用户的首选语言"""
          if language_code not in self.SUPPORTED_LANGUAGES:
              raise ValueError(f"不支持的语言: {language_code}")

          if user_id not in self.conversations:
              self.conversations[user_id] = {
                  "language": language_code,
                  "messages": []
              }
          else:
              self.conversations[user_id]["language"] = language_code

      def respond(self, user_id: str, user_message: str) -> str:
          """回复用户"""

          # 获取用户语言
          if user_id not in self.conversations:
              self.conversations[user_id] = {
                  "language": self.default_language,
                  "messages": []
              }

          conv = self.conversations[user_id]
          lang = self.SUPPORTED_LANGUAGES[conv["language"]]

          # 构造系统提示
          system_prompt = f"""你是一个专业的客服助手。
  始终使用 {lang} 回复用户，无论用户用什么语言提问。
  保持友好、专业的语气，提供清晰准确的回答。"""

          # 添加用户消息
          conv["messages"].append({
              "role": "user",
              "content": user_message
          })

          # 调用 API
          response = self.client.messages.create(
              model="claude-sonnet-4-6",  # 平衡成本和质量
              max_tokens=1024,
              system=system_prompt,
              messages=conv["messages"]
          )

          # 保存回复
          assistant_message = response.content[0].text
          conv["messages"].append({
              "role": "assistant",
              "content": assistant_message
          })

          return assistant_message

  # 使用示例
  bot = MultilingualSupportBot(default_language="zh")

  # 用户 1：中文用户
  bot.set_language("user1", "zh")
  print(bot.respond("user1", "我的订单什么时候能到？"))
  # 输出：您好！我需要您的订单号才能查询具体配送时间...

  # 用户 2：日语用户（用英语提问，要求日语回答）
  bot.set_language("user2", "ja")
  print(bot.respond("user2", "When will my order arrive?"))
  # 输出：ご注文の配送状況について...

  # 用户 3：法语用户
  bot.set_language("user3", "fr")
  print(bot.respond("user3", "Comment réinitialiser mon mot de passe?"))
  # 输出：Pour réinitialiser votre mot de passe...

  3.4 示例 4：语言检测 + 自动回复

  def detect_language(text: str) -> str:
      """检测文本的主要语言"""
      response = client.messages.create(
          model="claude-haiku-4-5",  # 用 Haiku 节省成本
          max_tokens=100,
          system="""Detect the primary language of the text.
  Respond with only the language name in English (e.g., "Chinese", "Japanese", "English").""",    
          messages=[{"role": "user", "content": text}]
      )
      return response.content[0].text.strip()

  def auto_respond(text: str) -> str:
      """自动检测语言并用同一语言回复"""
      detected_lang = detect_language(text)
      print(f"检测到语言: {detected_lang}")

      response = client.messages.create(
          model="claude-sonnet-4-6",
          max_tokens=1024,
          system=f"Respond in {detected_lang}. Be helpful and concise.",
          messages=[{"role": "user", "content": text}]
      )

      return response.content[0].text

  # 测试
  print(auto_respond("你好，请问如何注册账号？"))
  # 检测到语言: Chinese
  # 输出：注册账号的步骤如下...

  print(auto_respond("Bonjour, comment puis-je vous aider?"))
  # 检测到语言: French
  # 输出：Bonjour ! Je suis là pour vous aider...

  3.5 示例 5：本地化内容生成

  def generate_localized_content(
      content_type: str,
      target_audience: str,
      language: str,
      cultural_context: str = None
  ) -> str:
      """
      生成本地化内容（考虑文化差异）
      """

      cultural_hint = ""
      if cultural_context:
          cultural_hint = f"\n文化背景：{cultural_context}"

      response = client.messages.create(
          model="claude-opus-4-8",
          max_tokens=2048,
          system=f"""你是一位专业的本地化专家。
  为{target_audience}生成{content_type}。
  目标语言：{language}
  {cultural_hint}

  要求：
  1. 使用地道的母语表达，不要生硬翻译
  2. 考虑当地文化习惯和价值观
  3. 避免文化冲突或敏感内容
  4. 保持品牌调性的一致性""",
          messages=[{
              "role": "user",
              "content": f"请生成面向{target_audience}的{content_type}"
          }]
      )

      return response.content[0].text

  # 使用示例
  # 中国市场的营销文案
  chinese_content = generate_localized_content(
      content_type="产品推广文案",
      target_audience="中国年轻白领",
      language="Chinese (Simplified)",
      cultural_context="中国市场，强调效率和品质，避免过度夸张的表达"
  )
  print(chinese_content)

  # 日本市场的营销文案
  japanese_content = generate_localized_content(
      content_type="製品プロモーション文案",
      target_audience="日本のビジネスパーソン",
      language="Japanese",
      cultural_context="日本市場、丁寧な表現、品質と信頼性を重視"
  )
  print(japanese_content)

  3.6 示例 6：多语言代码注释生成

  def generate_multilingual_comments(
      code: str,
      languages: list[str]
  ) -> dict[str, str]:
      """
      为代码生成多语言注释
      """

      lang_list = ", ".join(languages)

      response = client.messages.create(
          model="claude-sonnet-4-6",
          max_tokens=2048,
          system=f"""你是一位专业的程序员和技术文档专家。
  为给定的代码生成{lang_list}的注释。
  每种语言的注释单独一段，用语言名作为标题。
  注释要简洁、准确、符合该语言的编程习惯。""",
          messages=[{
              "role": "user",
              "content": f"为以下代码生成多语言注释：\n\n{code}"
          }]
      )

      full_text = response.content[0].text

      # 解析不同语言的注释
      comments = {}
      current_lang = None
      current_text = []

      for line in full_text.split("\n"):
          if line.strip() in languages:
              if current_lang:
                  comments[current_lang] = "\n".join(current_text).strip()
              current_lang = line.strip()
              current_text = []
          elif current_lang:
              current_text.append(line)

      if current_lang:
          comments[current_lang] = "\n".join(current_text).strip()

      return comments

  # 使用示例
  code = """
  def calculate_discount(price, discount_rate):
      return price * (1 - discount_rate)
  """

  comments = generate_multilingual_comments(code, ["Chinese", "Japanese", "Spanish"])
  for lang, comment in comments.items():
      print(f"\n=== {lang} ===")
      print(comment)

  ---
  四、最佳实践

  4.1 设置响应语言（最可靠方式）

  # ✅ 最佳实践：在系统提示中明确指定
  system_prompt = "Always respond in Chinese (Simplified)."

  # ✅ 好：用户运行时选择语言
  def make_system_prompt(language_code: str):
      lang_map = {"zh": "Chinese", "en": "English", "ja": "Japanese"}
      return f"Always respond in {lang_map[language_code]}."

  # ❌ 差：依赖 Claude 自动推断（不稳定）
  # 不要只说 "respond naturally"

  4.2 使用原生文字（非音译）

  # ✅ 好：用原生文字
  chinese_text = "你好，世界"
  japanese_text = "こんにちは世界"
  arabic_text = "ملاعلاب ابحرم"

  # ❌ 差：用音译（拼音、罗马字等）
  pinyin_text = "ni hao, shi jie"     # 效果差
  romaji_text = "konnichiwa sekai"    # 效果差

  4.3 考虑文化背景

  # ✅ 好：提供文化上下文
  prompt = """为中国春节生成营销文案。
  注意：
  - 强调团圆、吉祥、传统价值观
  - 使用红色、金色等节日色彩描述
  - 避免涉及西方节日的元素
  - 语言喜庆但不过于夸张"""

  # ❌ 差：直接翻译西方文案
  # 把 "Merry Christmas" 翻译成 "圣诞快乐" 在中国效果不佳

  4.4 提示"地道表达"

  # ✅ 好：要求地道表达
  system_prompt = """
  用日语回复。
  要求：
  - 使用像母语者一样的自然地表达
  - 避免生硬的翻译腔
  - 符合日本商务礼仪
  """

  # ❌ 差：只说"用日语回答"
  # system_prompt = "用日语回答"  # 可能产生翻译腔

  4.5 指定两种语言（翻译场景）

  # ✅ 好：同时指明源语言和目标语言
  system_prompt = "Translate the user's message from German to Korean. Respond with only the      
  translation."

  # ❌ 差：只说"翻译"
  # 模型可能误解方向

  ---
  五、常见误区

  ❌ 误区 1：Claude 需要特殊配置才能处理多语言

  正确：多语言是模型内在能力，无需 API 参数或 beta 头。

  ❌ 误区 2：所有语言性能都一样

  正确：主流语言 95%+，小众语言 80%+，约鲁巴语只有 80%。要根据用例测试。

  ❌ 误区 3：依赖 Claude 自动推断响应语言

  正确：生产应用必须在系统提示中明确指定语言，否则可能忽中忽英。

  ❌ 误区 4：音译比原生文字更好处理

  正确：永远用原生文字（如"你好"而不是"ni hao"），音译会大幅降低质量。

  ❌ 误区 5：直接翻译西方内容就行

  正确：必须考虑文化背景，直接翻译往往效果很差。

  ❌ 误区 6：Haiku 在所有语言上都能用

  正确：Haiku 在小众语言上性能急剧下降（约鲁巴语 52.7%），多语言场景建议用 Sonnet 或 Opus。       

  ---
  六、生产环境模板

  6.1 多语言 API 服务

  from fastapi import FastAPI, HTTPException
  from pydantic import BaseModel
  from typing import Optional
  import anthropic

  app = FastAPI()
  client = anthropic.Anthropic()

  SUPPORTED_LANGUAGES = {
      "zh": "Chinese (Simplified)",
      "en": "English",
      "ja": "Japanese",
      "ko": "Korean",
      "es": "Spanish",
      "fr": "French",
      "de": "German",
  }

  class ChatRequest(BaseModel):
      message: str
      language: Optional[str] = "zh"  # 默认中文
      conversation_id: Optional[str] = None

  class ChatResponse(BaseModel):
      reply: str
      language: str
      conversation_id: str

  # 简单的会话存储（生产环境用 Redis/数据库）
  conversations = {}

  @app.post("/chat", response_model=ChatResponse)
  async def chat(request: ChatRequest):
      # 验证语言
      if request.language not in SUPPORTED_LANGUAGES:
          raise HTTPException(400, f"不支持的语言: {request.language}")

      target_lang = SUPPORTED_LANGUAGES[request.language]

      # 获取或创建会话
      conv_id = request.conversation_id or f"conv-{len(conversations)}"
      if conv_id not in conversations:
          conversations[conv_id] = []

      messages = conversations[conv_id]

      # 添加用户消息
      messages.append({"role": "user", "content": request.message})

      # 调用 API
      response = client.messages.create(
          model="claude-sonnet-4-6",
          max_tokens=1024,
          system=f"Always respond in {target_lang}. Be helpful and professional.",
          messages=messages
      )

      reply = response.content[0].text
      messages.append({"role": "assistant", "content": reply})

      return ChatResponse(
          reply=reply,
          language=target_lang,
          conversation_id=conv_id
      )

  # 使用
  # POST /chat
  # {
  #   "message": "How do I reset my password?",
  #   "language": "zh"
  # }
  # 响应：
  # {
  #   "reply": "重置密码的步骤如下...",
  #   "language": "Chinese (Simplified)",
  #   "conversation_id": "conv-0"
  # }

  6.2 语言切换中间件

  from functools import wraps

  def with_language(default_lang: str = "en"):
      """装饰器：自动处理语言"""
      def decorator(func):
          @wraps(func)
          def wrapper(*args, **kwargs):
              # 从请求中提取语言
              lang = kwargs.get("language", default_lang)

              # 设置系统提示
              system_prompt = f"Always respond in {SUPPORTED_LANGUAGES[lang]}."

              # 调用原函数
              return func(*args, system_prompt=system_prompt, **kwargs)
          return wrapper
      return decorator

  @with_language(default_lang="zh")
  def my_chatbot(message: str, system_prompt: str):
      response = client.messages.create(
          model="claude-sonnet-4-6",
          system=system_prompt,
          messages=[{"role": "user", "content": message}]
      )
      return response.content[0].text

  ---
  七、一句话总结

  ▎ 多语言支持 = Claude 的内在能力：主流语言 95%+ 性能，必须在系统提示中明确指定响应语言；用原生文
  ▎ 字而非音译；考虑文化背景；提示"像母语者一样表达"；小众语言建议用 Opus/Sonnet 而非 Haiku。     

  ---
  八、性能优化建议

  ┌──────────────────────────────────┬───────────────────┬──────────────────┐
  │               场景               │     推荐模型      │       理由       │
  ├──────────────────────────────────┼───────────────────┼──────────────────┤
  │ 主流语言（中英日韩西法德）       │ Sonnet            │ 性能好、成本合理 │
  ├──────────────────────────────────┼───────────────────┼──────────────────┤
  │ 小众语言（阿拉伯、印地、孟加拉） │ Opus              │ 性能更好         │
  ├──────────────────────────────────┼───────────────────┼──────────────────┤
  │ 极小众语言（斯瓦希里、约鲁巴）   │ Opus + 扩展思考   │ Haiku 性能太弱   │
  ├──────────────────────────────────┼───────────────────┼──────────────────┤
  │ 批量翻译                         │ Haiku（主流语言） │ 成本最低         │
  └──────────────────────────────────┴───────────────────┴──────────────────┘


#============================= Embeddings 学习建议 =============================
 一、快速回答你的三个问题     
  ❓ Claude Code 项目用 embeddings 吗？
     
  不用。Claude Code 的搜索功能（技能搜索、工具搜索、会话搜索）用的是
  TF-IDF（基于词频的传统方法），不是向量嵌入。

  源码证据：
  // src/services/skillSearch/localSearch.ts
  export interface SkillIndexEntry {
    // ...
    tfVector: Map<string, number>  // ← TF-IDF 向量，不是 embedding
  }

  ❓ 做 Agent 开发会用到 embeddings 吗？

  非常会！ 而且用得很多。

  ❓ 现在需要学吗？

  看你做的 Agent 类型：

  ┌──────────────────────────────────────┬───────────────────┬──────────────────────────┐
  │              Agent 类型              │ 需要 Embeddings？ │           理由           │
  ├──────────────────────────────────────┼───────────────────┼──────────────────────────┤
  │ 工具调用型 Agent（类似 Claude Code） │ ❌ 不需要         │ 靠函数调用，不靠语义搜索 │
  ├──────────────────────────────────────┼───────────────────┼──────────────────────────┤
  │ RAG Agent（知识库问答）              │ ✅ 必须           │ 向量检索是核心           │
  ├──────────────────────────────────────┼───────────────────┼──────────────────────────┤
  │ 长期记忆 Agent                       │ ✅ 强烈推荐       │ 记忆检索靠向量相似度     │
  ├──────────────────────────────────────┼───────────────────┼──────────────────────────┤
  │ 多文档分析 Agent                     │ ✅ 需要           │ 文档语义检索             │
  ├──────────────────────────────────────┼───────────────────┼──────────────────────────┤
  │ 推荐系统 Agent                       │ ✅ 需要           │ 用户/物品嵌入            │
  ├──────────────────────────────────────┼───────────────────┼──────────────────────────┤
  │ 异常检测 Agent                       │ ✅ 需要           │ 嵌入空间检测离群点       │
  └──────────────────────────────────────┴───────────────────┴──────────────────────────┘

  ---
  二、一句话总结 Embeddings

  Embeddings = 把文本变成数字向量，让计算机能计算"语义相似度"

  "如何重置密码？"     → [0.12, -0.34, 0.56, ..., 0.78]  (1024维向量)
  "忘记密码怎么办"     → [0.11, -0.33, 0.55, ..., 0.77]  ← 语义相似，向量接近
  "今天天气怎么样"     → [-0.45, 0.23, -0.11, ..., 0.09]  ← 语义不同，向量远离

  ---
  三、Agent 开发中 Embeddings 的 5 大应用场景

  场景 1：RAG（检索增强生成）⭐最常用

  # 用户提问 → 检索相关知识 → Claude 回答
  query = "公司的年假政策是什么？"

  # 1. 把知识库文档转成 embeddings
  doc_embeddings = voyage.embed(documents, model="voyage-4")

  # 2. 把查询转成 embedding
  query_embedding = voyage.embed([query], model="voyage-4")[0]

  # 3. 找最相似的文档
  similar_docs = find_nearest(query_embedding, doc_embeddings)

  # 4. 把相关文档交给 Claude
  response = claude.messages.create(
      messages=[
          {"role": "user", "content": f"基于以下资料回答问题：{similar_docs}\n\n问题：{query}"}   
      ]
  )

  场景 2：长期记忆

  # Agent 记住过去的对话
  conversation = "用户说他是 Python 开发者，喜欢用 VS Code"

  # 1. 存储时转成 embedding
  memory_embedding = voyage.embed([conversation])[0]
  memory_db.save(conversation, embedding=memory_embedding)

  # 2. 后续对话时检索相关记忆
  current_context = "用户正在问关于 IDE 的问题"
  context_embedding = voyage.embed([current_context])[0]
  relevant_memories = memory_db.search(context_embedding, top_k=5)

  # 3. 把相关记忆注入 prompt
  response = claude.messages.create(
      system=f"用户的相关信息：{relevant_memories}",
      messages=[...]
  )

  场景 3：语义搜索

  # 代码库语义搜索
  code_snippets = [
      "def calculate_sum(a, b): return a + b",
      "class DatabaseConnection: ...",
      "def parse_json(text): return json.loads(text)",
  ]

  # 1. 索引代码片段
  code_embeddings = voyage.embed(code_snippets, model="voyage-code-3")

  # 2. 自然语言搜索代码
  query = "找一个计算两个数相加的函数"
  query_embedding = voyage.embed([query])[0]

  # 3. 找到最相关的代码
  results = semantic_search(query_embedding, code_embeddings)
  # 返回：def calculate_sum(a, b): return a + b

  场景 4：文档去重 / 聚类

  # 大量文档去重
  documents = [...]  # 10000 份文档

  # 1. 全部转成 embeddings
  embeddings = voyage.embed(documents)

  # 2. 计算两两相似度矩阵
  similarity_matrix = cosine_similarity(embeddings)

  # 3. 找出相似度 > 0.95 的文档对（重复）
  duplicates = find_pairs_above_threshold(similarity_matrix, threshold=0.95)

  # 或者聚类（主题分类）
  clusters = cluster_embeddings(embeddings, n_clusters=20)

  场景 5：异常检测

  # 检测异常的用户查询
  normal_queries = ["如何重置密码", "查询余额", "转账流程"]
  normal_embeddings = voyage.embed(normal_queries)

  # 新来的查询
  new_query = "帮我黑进别人的账户"
  new_embedding = voyage.embed([new_query])[0]

  # 计算与正常查询的距离
  distances = [cosine_distance(new_embedding, ne) for ne in normal_embeddings]
  min_distance = min(distances)

  # 距离太大 → 异常
  if min_distance > THRESHOLD:
      flag_as_suspicious(new_query)

  ---
  四、Claude Code 不用 Embeddings 的原因

  ┌──────────┬──────────────────────────┬─────────────────────────────┐
  │   维度   │ TF-IDF（Claude Code 用） │         Embeddings          │
  ├──────────┼──────────────────────────┼─────────────────────────────┤
  │ 计算速度 │ ⚡ 极快（毫秒级）        │ 🐢 较慢（需要神经网络推理） │
  ├──────────┼──────────────────────────┼─────────────────────────────┤
  │ 成本     │ 💰 免费（本地计算）      │ 💸 要付费（API 调用）       │
  ├──────────┼──────────────────────────┼─────────────────────────────┤
  │ 语义理解 │ 🤏 仅关键词匹配          │ 🧠 深度语义理解             │
  ├──────────┼──────────────────────────┼─────────────────────────────┤
  │ 多语言   │ 🤏 弱（需要分词）        │ 🌍 强                       │
  ├──────────┼──────────────────────────┼─────────────────────────────┤
  │ 适用场景 │ 代码/工具名搜索          │ 自然语言语义搜索            │
  └──────────┴──────────────────────────┴─────────────────────────────┘

  Claude Code 的搜索场景：
  - 搜索工具名（grep, bash, file_read）→ 关键词就够了
  - 搜索技能（/commit, /review）→ 关键词匹配即可
  - 不需要理解"重置密码"和"忘记密码"是同义词

  Agent 开发场景：
  - 搜索知识库（"公司的年假政策"）→ 需要语义理解
  - 长期记忆（"用户是 Python 开发者"）→ 需要语义匹配

  ---
  五、什么时候该学 Embeddings？

  ✅ 现在就学，如果你的 Agent 有：

  - 📚 知识库 / 文档问答
  - 💾 长期记忆 / 用户画像
  - 🔍 语义搜索（非关键词搜索）
  - 🎯 推荐系统

  ⏸️ 暂时不用学，如果你的 Agent 只是：

  - 🛠️ 工具调用（类似 Claude Code）
  - 💬 简单对话（不需要记忆）
  - 📝 文本生成（不需要检索）

  ---
  六、如果以后要学，推荐路径

  1. 理解 Embeddings 基础概念
     ↓
  2. 学习 Voyage AI（Anthropic 推荐）
     - 注册获取 API key
     - 用 voyage-4 模型测试
     ↓
  3. 实战 RAG
     - 知识库检索
     - 向量数据库（Pinecone/Weaviate/Chroma）
     ↓
  4. 进阶应用
     - 长期记忆
     - 多模态（图片/视频嵌入）
     - 微调领域专用模型

  ---
  七、一句话结论

  ▎ Claude Code 不用 embeddings（用 TF-IDF），但做 RAG Agent / 长期记忆 Agent 必须学 embeddings。 
  ▎ 如果你现在做的是工具调用型
  ▎ Agent，可以先跳过；如果要做知识库问答或记忆系统，建议现在就学。Anthropic 推荐的 embedding     
  ▎ 提供商是 Voyage AI，模型选 voyage-4（平衡）或 voyage-4-large（最佳质量）。

====================十四、流式传输消息（Streaming Messages）====================

## 14.1 一句话定位

**流式传输 = 让 Claude 的回答"像打字一样"实时出现**，而不是等整个回答生成完才返回。通过 SSE（Server-Sent Events）协议，API 把响应拆成一系列事件流式发送。

**类比**：
- 非流式 = 快递：等包裹完全打包好，一次性送达
- 流式 = 外卖骑手：边做边送，你能实时看到进度

## 14.2 源码中的流式处理架构

**`src/services/api/claude.ts` 第 2315-2716 行** —— 完整的流式事件处理：

```ts
// 主循环：逐事件处理流
for await (const part of stream) {
  switch (part.type) {
    case 'message_start':      // 消息开始
    case 'content_block_start': // 内容块开始
    case 'content_block_delta': // 内容增量
    case 'content_block_stop':  // 内容块结束
    case 'message_delta':       // 消息级别更新
    case 'message_stop':        // 消息结束
  }
}
```

## 14.3 流式事件类型详解

### 14.3.1 事件流顺序

```
message_start              ← 消息开始（包含 model, usage 等元数据）
  ↓
content_block_start        ← 内容块 0 开始
content_block_delta        ← 内容块 0 的增量（可能多个）
content_block_stop         ← 内容块 0 结束
  ↓
content_block_start        ← 内容块 1 开始（thinking/tool_use 等）
content_block_delta        ← 内容块 1 的增量
content_block_stop         ← 内容块 1 结束
  ↓
message_delta              ← 消息级别更新（stop_reason, 最终 usage）
message_stop               ← 消息结束
```

**中间可能穿插 `ping` 事件**（保持连接活跃）。

### 14.3.2 源码中的事件处理（关键片段）

#### `message_start`（行 2316-2362）

```ts
case 'message_start': {
  partialMessage = part.message          // 保存消息元数据
  ttftMs = Date.now() - start            // 计算首 token 时间
  usage = updateUsage(usage, part.message?.usage)  // 累积 usage
  
  // 记录缓存命中统计
  const cacheHitRate = ...
  logForDebugging(`[Hapii][Cache] message_start usage: ... hitRate=${cacheHitRate}%`)
}
```

**学习要点**：
- 记录 **TTFT**（Time To First Token）：从请求到第一个 token 的时间
- 解析缓存命中率
- `partialMessage` 是初始的消息模板（output_tokens: 0, stop_reason: null）

#### `content_block_start`（行 2364-2417）

```ts
case 'content_block_start':
  switch (part.content_block.type) {
    case 'tool_use':
      contentBlocks[part.index] = {
        ...part.content_block,
        input: '',  // ← 关键：初始化为空字符串，后续 input_json_delta 累积
      }
    case 'text':
      textDeltas.set(part.index, [])  // ← 初始化 delta 累积数组
      contentBlocks[part.index] = {
        ...part.content_block,
        text: '',  // ← 清空 SDK 自带的初始值（避免重复）
      }
    case 'thinking':
      contentBlocks[part.index] = {
        ...part.content_block,
        thinking: '',
        signature: '',  // ← 初始化 signature，防止丢失
      }
  }
```

**关键设计**：
- **主动清空 SDK 初始值**：SDK 可能在 `content_block_start` 就带部分 text，但 delta 又会再发一遍 → 主动清空避免重复
- **signature 字段初始化**：防止 `signature_delta` 丢失时字段不存在

#### `content_block_delta`（行 2420-2588）—— 核心逻辑

```ts
case 'content_block_delta': {
  const contentBlock = contentBlocks[part.index]
  const delta = part.delta
  
  switch (delta.type) {
    case 'text_delta':
      // 累积文本增量
      textDeltas.get(part.index)?.push(delta.text)
      break
    
    case 'input_json_delta':
      // 累积工具输入 JSON（部分字符串）
      contentBlock.input += delta.partial_json
      break
    
    case 'thinking_delta':
      // 累积思考内容
      contentBlock.thinking += delta.thinking
      break
    
    case 'signature_delta':
      // 累积加密签名
      contentBlock.signature += delta.signature
      break
    
    case 'citations_delta':
      // TODO: 处理 citations（源码未实现）
      break
  }
}
```

**关键学习点**：
1. **文本增量累积到数组**：`textDeltas` 是 `Map<index, string[]>`，便于后续合并
2. **JSON 增量是部分字符串**：`input_json_delta` 发的是**部分 JSON 字符串**，不是完整对象，需要累积后解析
3. **类型守卫严格**：每种 delta 都检查 contentBlock.type，避免流乱序导致的数据污染

#### `content_block_stop`（行 2542-2593）

```ts
case 'content_block_stop': {
  const contentBlock = contentBlocks[part.index]
  
  // 如果是 tool_use 块，解析 JSON input
  if (contentBlock.type === 'tool_use' || contentBlock.type === 'server_tool_use') {
    contentBlock.input = safeParseJSON(contentBlock.input)
  }
  
  // 基于 partialMessage 创建最终消息并 yield
  const m = createAssistantMessage({
    content: contentBlock,
    usage: partialMessage.usage,
  })
  newMessages.push(m)
  yield m
}
```

**关键学习点**：
- **JSON 解析时机**：在 `content_block_stop` 时才解析 `input_json_delta` 累积的字符串
- **消息 yield 时机**：每个 content_block 结束时才 yield 完整消息，不是每个 delta

#### `message_delta`（行 2595-2670）

```ts
case 'message_delta': {
  usage = updateUsage(usage, part.usage)  // 更新最终 usage
  stopReason = part.delta.stop_reason      // 更新停止原因
  
  // 把最终值写回到最后一条消息
  const lastMsg = newMessages.at(-1)
  if (lastMsg) {
    lastMsg.message.usage = usage          // ← 直接修改，不是替换
    lastMsg.message.stop_reason = stopReason
  }
  
  // 更新成本
  costUSD += addToTotalSessionCost(...)
  
  // 检查是否被拒绝
  const refusalMessage = getErrorMessageIfRefusal(
    part.delta.stop_reason,
    options.model,
  )
}
```

**关键设计**：
- **直接属性修改**：不用对象替换 `{ ...msg, usage }`，因为 transcript 队列持有引用
- **usage 累积**：`message_delta` 的 usage 是**累积的**，不是增量

#### `message_stop`（行 2671-2708）

```ts
case 'message_stop': {
  // 最终缓存统计
  logForDebugging(`[Hapii][Cache] ====== FINAL CACHE SUMMARY ======`)
  logForDebugging(`[Hapii][Cache] Cache hit rate: ${finalCacheHitRate}%`)
  // 流结束
}
```

## 14.4 Python 示例

### 14.4.1 基础流式传输

```python
import anthropic

client = anthropic.Anthropic()

with client.messages.stream(
    model="claude-opus-4-8",
    max_tokens=1024,
    messages=[{"role": "user", "content": "你好，请做个自我介绍"}]
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

### 14.4.2 处理完整事件流

```python
with client.messages.stream(
    model="claude-opus-4-8",
    max_tokens=1024,
    messages=[{"role": "user", "content": "讲个笑话"}]
) as stream:
    for event in stream:
        if event.type == "message_start":
            print(f"模型: {event.message.model}")
            print(f"消息 ID: {event.message.id}")
        
        elif event.type == "content_block_start":
            print(f"\n--- 内容块 {event.index} 开始 ---")
            print(f"类型: {event.content_block.type}")
        
        elif event.type == "content_block_delta":
            delta = event.delta
            if delta.type == "text_delta":
                print(delta.text, end="", flush=True)
            elif delta.type == "thinking_delta":
                print(f"[思考] {delta.thinking}", end="", flush=True)
            elif delta.type == "input_json_delta":
                print(f"[工具输入增量] {delta.partial_json}", end="")
        
        elif event.type == "content_block_stop":
            print(f"\n--- 内容块 {event.index} 结束 ---")
        
        elif event.type == "message_delta":
            print(f"\n停止原因: {event.delta.stop_reason}")
            print(f"最终 usage: {event.usage}")
        
        elif event.type == "message_stop":
            print("\n=== 消息完成 ===")
```

### 14.4.3 工具调用流式传输

```python
tools = [{
    "name": "get_weather",
    "description": "获取天气",
    "input_schema": {
        "type": "object",
        "properties": {
            "location": {"type": "string"}
        },
        "required": ["location"]
    }
}]

with client.messages.stream(
    model="claude-opus-4-8",
    max_tokens=1024,
    tools=tools,
    messages=[{"role": "user", "content": "北京天气怎么样？"}]
) as stream:
    tool_input_json = ""
    
    for event in stream:
        if event.type == "content_block_start":
            if event.content_block.type == "tool_use":
                print(f"调用工具: {event.content_block.name}")
        
        elif event.type == "content_block_delta":
            if event.delta.type == "input_json_delta":
                # 累积部分 JSON
                tool_input_json += event.delta.partial_json
        
        elif event.type == "content_block_stop":
            if tool_input_json:
                # 解析完整 JSON
                import json
                tool_input = json.loads(tool_input_json)
                print(f"工具参数: {tool_input}")
```

### 14.4.4 扩展思考流式传输

```python
with client.messages.stream(
    model="claude-opus-4-8",
    max_tokens=20000,
    thinking={"type": "adaptive", "display": "summarized"},
    messages=[{"role": "user", "content": "1071 和 462 的最大公约数是多少？"}]
) as stream:
    for event in stream:
        if event.type == "content_block_delta":
            if event.delta.type == "thinking_delta":
                print(f"[思考] {event.delta.thinking}", end="", flush=True)
            elif event.delta.type == "signature_delta":
                print(f"\n[签名] {event.delta.signature[:50]}...")
            elif event.delta.type == "text_delta":
                print(f"\n[回答] {event.delta.text}", end="", flush=True)
```

### 14.4.5 获取最终 Message（无需逐事件处理）

```python
with client.messages.stream(
    model="claude-opus-4-8",
    max_tokens=128000,
    messages=[{"role": "user", "content": "写一篇长文..."}]
) as stream:
    # SDK 内部用流式传输避免 HTTP 超时
    # 但对外暴露完整的 Message 对象
    message = stream.get_final_message()
    
    print(f"模型: {message.model}")
    print(f"停止原因: {message.stop_reason}")
    print(f"输入 token: {message.usage.input_tokens}")
    print(f"输出 token: {message.usage.output_tokens}")
    print(f"响应: {message.content[0].text}")
```

## 14.5 关键概念

### 14.5.1 TTFT（Time To First Token）

**定义**：从发送请求到收到第一个 token 的时间。

**源码实现**（`claude.ts` 第 2318 行）：
```ts
case 'message_start': {
  ttftMs = Date.now() - start  // 记录到第一个事件的时间
}
```

**重要性**：
- 用户体验的核心指标
- 流式传输的主要优势之一（非流式要等全部生成完）
- 但快速模式对 TTFT 提升不大，主要提升 OTPS（每秒输出 token）

### 14.5.2 OTPS（Output Tokens Per Second）

**定义**：每秒生成的输出 token 数。

**和 TTFT 的区别**：
- TTFT = 开始速度
- OTPS = 持续速度
- 快速模式主要提升 OTPS（2.5×），TTFT 提升有限

### 14.5.3 `input_json_delta` 的部分 JSON

**难点**：工具调用的 `input` 字段是**部分 JSON 字符串**，不是完整对象。

```json
// 事件 1
{"type": "input_json_delta", "partial_json": "{\"location\":"}

// 事件 2
{"type": "input_json_delta", "partial_json": " \"San Francisco\""}

// 事件 3
{"type": "input_json_delta", "partial_json": "}"}
```

**累积后解析**：
```ts
// 累积
contentBlock.input += delta.partial_json  // "{\"location\": \"San Francisco\"}"

// 在 content_block_stop 时解析
contentBlock.input = safeParseJSON(contentBlock.input)
```

**为什么这样设计？**
- 支持**细粒度流式传输**：边生成边发送
- 未来模型可以支持更小的增量（如单个字符）

### 14.5.4 `signature_delta` 的作用

**定义**：thinking 块的加密签名，用于验证完整性。

**源码处理**（`claude.ts` 第 2495-2515 行）：
```ts
case 'signature_delta':
  // 累积到 contentBlocks[index].signature
  if (contentBlock.type === 'thinking') {
    contentBlock.signature += delta.signature
  }
```

**关键**：
- 多轮对话时**必须原样传回** thinking 块（含 signature）
- API 用 signature 验证"这确实是 Claude 的思考，没被篡改"

### 14.5.5 `message_delta` vs `content_block_delta`

| 维度 | `message_delta` | `content_block_delta` |
|------|-----------------|----------------------|
| **作用范围** | 消息级别 | 内容块级别 |
| **包含内容** | stop_reason, 最终 usage | text/thinking/tool_use 增量 |
| **出现时机** | 所有 content_block 之后 | content_block_start 和 stop 之间 |
| **数量** | 通常 1 个 | 多个（每个 token 一个） |

## 14.6 错误恢复

### 14.6.1 Claude 4.5 及更早版本

```python
# 1. 捕获部分响应
partial_response = ""
try:
    with client.messages.stream(...) as stream:
        for text in stream.text_stream:
            partial_response += text
except Exception as e:
    # 流中断
    pass

# 2. 构造续传请求
messages = [
    {"role": "user", "content": "原始问题"},
    {"role": "assistant", "content": partial_response}  # ← 作为助手消息的开头
]

# 3. 从中断处继续
with client.messages.stream(messages=messages) as stream:
    for text in stream.text_stream:
        print(text, end="")
```

### 14.6.2 Claude 4.6+ 版本

```python
# 区别：用用户消息指示继续
messages = [
    {"role": "user", "content": "原始问题"},
    {"role": "assistant", "content": partial_response},
    {"role": "user", "content": f"Your previous response was interrupted and ended with {partial_response[-100:]}. Continue from where you left off."}
]
```

### 14.6.3 注意事项

- **工具使用块无法部分恢复**：只能从最近的文本块恢复
- **thinking 块无法部分恢复**：signature 与完整思考绑定

## 14.7 常见误区

### ❌ 误区 1：每个 delta 都是一个完整 token
**正确**：delta 可能是**部分 token**（如半个汉字），也可能是多个 token。

### ❌ 误区 2：`input_json_delta` 是完整 JSON 对象
**正确**：是**部分 JSON 字符串**，必须累积后解析。

### ❌ 误区 3：`message_delta` 的 usage 是增量
**正确**：是**累积的**最终值，不是增量。

### ❌ 误区 4：流式传输和非流式返回的内容不同
**正确**：返回的**内容完全相同**，只是传输方式不同。

### ❌ 误区 5：流式传输总是更快
**正确**：流式传输的**总耗时**可能差不多，但**TTFT 更短**，用户体验更好。

### ❌ 误区 6：可以恢复工具调用和 thinking
**正确**：只能从**文本块**恢复，工具调用和 thinking 无法部分恢复。

## 14.8 性能优化建议

### 14.8.1 大输出时使用流式

```python
# ❌ 差：大输出可能超时
response = client.messages.create(
    max_tokens=128000,  # 非流式可能 HTTP 超时
    ...
)

# ✅ 好：流式传输保持连接活跃
with client.messages.stream(
    max_tokens=128000,
    ...
) as stream:
    message = stream.get_final_message()
```

**SDK 内部**：当 `max_tokens > 21,333` 时，SDK **强制**用流式传输避免超时。

### 14.8.2 实时处理 vs 最终结果

```python
# ✅ 实时处理：边接收边显示（适合 UI）
with client.messages.stream(...) as stream:
    for text in stream.text_stream:
        print(text, end="")  # 实时显示

# ✅ 最终结果：一次性获取（适合批处理）
with client.messages.stream(...) as stream:
    message = stream.get_final_message()
    process(message)  # 处理完整消息
```

### 14.8.3 错误处理

```python
try:
    with client.messages.stream(...) as stream:
        for event in stream:
            if event.type == "error":
                # 流式错误
                print(f"错误: {event.error}")
                break
except anthropic.APIStatusError as e:
    # HTTP 错误
    print(f"API 错误: {e}")
except anthropic.APIConnectionError as e:
    # 网络错误
    print(f"网络错误: {e}")
```

## 14.9 源码中的特殊处理

### 14.9.1 空闲超时看门狗

**`claude.ts` 第 2193-2250 行**：

```ts
// 流式空闲超时：90 秒无 chunk 则中止
const STREAM_IDLE_TIMEOUT_MS = 90_000

function resetStreamIdleTimer(): void {
  streamIdleTimer = setTimeout(() => {
    streamIdleAborted = true
    logForDebugging(`Streaming idle timeout: no chunks received for ${STREAM_IDLE_TIMEOUT_MS / 1000}s, aborting stream`)
    releaseStreamResources()
  }, STREAM_IDLE_TIMEOUT_MS)
}

// 每收到 chunk 重置计时器
for await (const part of stream) {
  resetStreamIdleTimer()
  // ... 处理事件
}
```

**作用**：防止连接挂起（网络丢包、服务器静默）

### 14.9.2 停顿检测

**`claude.ts` 第 2256-2296 行**：

```ts
const STALL_THRESHOLD_MS = 30_000  // 30 秒
let lastEventTime: number | null = null

for await (const part of stream) {
  if (lastEventTime !== null) {
    const timeSinceLastEvent = now - lastEventTime
    if (timeSinceLastEvent > STALL_THRESHOLD_MS) {
      stallCount++
      logEvent('tengu_streaming_stall', { stall_duration_ms: timeSinceLastEvent })
    }
  }
  lastEventTime = now
}
```

**作用**：检测流的停顿，便于监控和告警。

### 14.9.3 非流式降级

**`claude.ts` 第 2749-2757 行**：

```ts
// 流式路径失败 → 自动降级到非流式
if (!receivedMessageStart || !receivedContentBlockStop) {
  logForDebugging('Stream completed without expected events - triggering non-streaming fallback')
  // 用非流式 API 重试
}
```

**作用**：流式传输失败时自动降级，保证可用性。

## 14.10 一句话总结

> **流式传输 = SSE 事件流**：通过 `message_start → content_block_* → message_delta → message_stop` 事件序列实时传输响应；关键 delta 类型包括 `text_delta`、`input_json_delta`（部分 JSON，需累积）、`thinking_delta`、`signature_delta`；SDK 用 `stream.get_final_message()` 简化处理；大输出（>21k token）时 SDK 强制用流式避免超时；支持错误恢复但工具调用和 thinking 无法部分恢复。
