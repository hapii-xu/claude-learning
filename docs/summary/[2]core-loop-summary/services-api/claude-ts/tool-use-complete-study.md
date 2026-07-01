# Claude 工具使用（Tool Use）完整学习指南

> 本文档结合 [Anthropic 官方文档](https://platform.claude.com/docs/zh-CN/agents-and-tools/tool-use/overview)（19 个页面）与 Claude Code 源码（`src/Tool.ts`、`src/tools.ts`、`src/services/api/claude.ts`），系统梳理工具使用的概念、智能体循环、定义/处理工具、并行调用、严格模式、缓存、各类服务器工具和 Anthropic 模式工具。

---

====================目录====================

1. [工具使用概述](#一工具使用概述)
2. [工具使用的工作原理](#二工具使用的工作原理)
3. [构建工具使用智能体（教程）](#三构建工具使用智能体教程)
4. [定义工具](#四定义工具)
5. [处理工具调用](#五处理工具调用)
6. [并行工具使用](#六并行工具使用)
7. [Tool Runner（SDK 抽象）](#七tool-runnersdk-抽象)
8. [严格工具使用](#八严格工具使用)
9. [工具使用与提示缓存](#九工具使用与提示缓存)
10. [服务器工具总览](#十服务器工具总览)
11. [工具使用故障排查](#十一工具使用故障排查)
12. [网络搜索工具](#十二网络搜索工具)
13. [网页抓取工具](#十三网页抓取工具)
14. [代码执行工具](#十四代码执行工具)
15. [Advisor 工具](#十五advisor-工具)
16. [Memory 工具](#十六memory-工具)
17. [Bash 工具](#十七bash-工具)
18. [Computer Use 工具](#十八computer-use-工具)
19. [Text Editor 工具](#十九text-editor-工具)
20. [Claude Code 源码实现参考](#二十claude-code-源码实现参考)

---

====================一、工具使用概述====================

## 1.1 一句话定位

**工具使用（Tool Use）让 Claude 能够调用你定义的函数或 Anthropic 提供的函数**。Claude 根据用户请求和工具描述决定何时调用工具，然后返回一个**结构化的调用**，由你的应用程序执行（客户端工具）或由 Anthropic 执行（服务器工具）。

**类比**：
- 没有工具 = Claude 只能凭脑子回答（受训练数据限制）
- 有工具 = Claude 能"伸手"调用计算器、查数据库、搜网络、改文件

## 1.2 工具的两大类别

| 类别 | 代码执行位置 | 你需要做什么 | 例子 |
|------|------------|------------|------|
| **客户端工具** | 你的应用程序 | 提供 schema + 执行 + 返回 tool_result | 用户自定义工具、bash、text_editor、computer、memory |
| **服务器工具** | Anthropic 基础设施 | 仅启用工具 + 读取结果 | web_search、web_fetch、code_execution、tool_search |

**关键区别**：
- **客户端工具**：Claude 返回 `stop_reason: "tool_use"` + `tool_use` 块 → 你执行 → 你回传 `tool_result`
- **服务器工具**：你直接看到结果，无需处理执行过程

## 1.3 最简单的示例（服务器工具）

```python
import anthropic

client = anthropic.Anthropic()

response = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=1024,
    tools=[{"type": "web_search_20260209", "name": "web_search"}],  # 服务器工具
    messages=[{"role": "user", "content": "火星车的最新进展是什么？"}],
)
print(response.content)  # 直接看到搜索结果整合后的回答
```

## 1.4 Claude 何时使用工具

当 `tool_choice` 用默认值 `{"type": "auto"}` 时，Claude 在每一轮决定是调用工具还是直接回复：
- **会调用工具**：请求匹配某个工具的能力，且答案不在上下文中
- **直接回复**：稳定知识、创意任务、对话性轮次

### 通过系统提示引导

```python
# 增加工具使用倾向
system = "Use the tools to investigate before responding."

# 更强：强制先用工具
system = "Always call a tool first before responding."

# 保守：让 Claude 自己判断
system = "Use your judgment about whether to call a tool or respond directly."
```

如果需要**硬性保证**（而非引导），用 `tool_choice` 参数（见第四章）。

## 1.5 定价

工具使用请求的定价基于：
1. **输入 token 总数**（包括 `tools` 参数中的 token）
2. **输出 token**
3. **服务器工具的额外费用**（如网络搜索按每次搜索收费）

### 工具使用系统提示 token 数（按模型）

| 模型 | `auto`/`none` | `any`/`tool` |
|------|--------------|--------------|
| Claude Opus 4.8 | 290 | 410 |
| Claude Opus 4.7 | 675 | 804 |
| Claude Opus 4.6 | 497 | 589 |
| Claude Sonnet 4.6 | 497 | 589 |
| Claude Haiku 4.5 | 496 | 588 |

**关键**：当你使用 `tools` 时，API 自动包含一个特殊系统提示来启用工具使用，这会消耗额外 token。

## 1.6 当 Claude 需要更多信息时

如果用户提示没有足够信息填写工具参数：
- **Claude Opus**：更可能识别出缺少参数并主动询问
- **Claude Sonnet**：可能尽力推断一个合理值（例如未指定位置时猜 "New York, NY"）

这种行为不保证，尤其对模糊提示和较小模型。

---

====================二、工具使用的工作原理====================

## 2.1 工具使用契约

工具使用是**你的应用程序与模型之间的契约**：
- 你指定：哪些操作可用、输入输出的形态
- Claude 决定：何时以及如何调用它们
- **模型本身从不执行任何操作**，它只发出结构化请求

这让模型行为不再像文本生成器，而更像**你调用的函数**。

## 2.2 工具在哪里运行（三类）

### 类别 1：用户定义的工具（客户端执行）

> 你编写 schema，你执行代码，你返回结果。

绝大多数工具使用流量都是这一类。Claude 看不到你的实现，只看到你提供的 schema 和你返回的结果。

### 类别 2：Anthropic 模式工具（客户端执行）

> Anthropic 发布 schema，你的应用程序负责执行。

包括 `bash`、`text_editor`、`computer`、`memory`。

**为什么用 Anthropic 模式而不是自己定义？**
- 这些 schema 经过**训练内化**——Claude 在数千个使用这些工具签名的成功轨迹上优化过
- 比自定义等效工具更可靠，错误恢复更优雅

### 类别 3：服务器执行的工具

> Anthropic 运行代码。

包括 `web_search`、`web_fetch`、`code_execution`、`tool_search`。你启用工具，服务器处理一切。响应包含 `server_tool_use` 块，但你看到时执行已完成。

## 2.3 智能体循环（客户端工具）

客户端工具需要你的应用程序**驱动一个循环**：

```
1. 发送请求（含 tools 数组 + 用户消息）
   ↓
2. Claude 返回 stop_reason: "tool_use" + 一个或多个 tool_use 块
   ↓
3. 执行每个工具，格式化为 tool_result 块
   ↓
4. 发送新请求（原始消息 + 助手响应 + 含 tool_result 的用户消息）
   ↓
5. 当 stop_reason 还是 "tool_use" 时，回到第 2 步
```

**核心理解**：当 `stop_reason == "tool_use"` 时，执行工具并继续对话。循环在遇到其他停止原因时退出：
- `"end_turn"`（Claude 给出最终答案）
- `"max_tokens"`、`"stop_sequence"`、`"refusal"`

## 2.4 服务器端循环

服务器工具在 Anthropic 基础设施内部运行**自己的循环**：单个请求可能触发多次搜索/执行。

**迭代次数限制**：如果模型达到上限时仍在迭代，响应返回 `stop_reason: "pause_turn"` 而非 `"end_turn"`。暂停的回合意味着工作未完成——重新发送对话（含暂停响应）让模型继续。

## 2.5 何时使用工具（以及何时不用）

### ✅ 适合用工具

- **有副作用的操作**：发邮件、写文件、更新记录
- **最新或外部数据**：当前价格、今天天气、数据库内容
- **结构化、形态有保证的输出**：需要特定字段的 JSON
- **调用现有系统**：数据库、内部 API、文件系统

**判断信号**：如果你正在写正则从模型输出提取决策，那个决策本应是一次工具调用。

### ❌ 不适合用工具

- 模型仅凭训练数据即可回答（摘要、翻译、常识）
- 没有副作用的一次性问答
- 工具调用的延迟会主导一个简单响应

## 2.6 三种方法对比

| 方法 | 何时使用 | 预期 |
|------|---------|------|
| 用户定义的客户端工具 | 自定义业务逻辑、内部 API、专有数据 | 你处理执行和智能体循环 |
| Anthropic 模式客户端工具 | 标准开发操作（bash、文件编辑、浏览器） | 你处理执行；Claude 可靠调用（schema 已训练内化） |
| 服务器执行的工具 | 网络搜索、代码沙箱、网页获取 | Anthropic 处理执行；你直接获得结果 |

---

====================三、构建工具使用智能体（教程）====================

## 3.1 教程结构：5 个同心环

官方教程用一个**日历管理智能体**（`create_calendar_event` 工具）逐步构建，每个环增加一个概念。示例工具 schema 使用嵌套对象、数组和可选字段。

## 3.2 环 1：单个工具，单轮对话

最小的工具使用程序：一个工具、一条用户消息、一次工具调用、一个结果。

```python
import anthropic

client = anthropic.Anthropic()

# 1. 定义工具（input_schema 是 JSON Schema，含嵌套对象/数组/可选字段）
tools = [{
    "name": "create_calendar_event",
    "description": "Create a calendar event with attendees and optional recurrence.",
    "input_schema": {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "start": {"type": "string", "format": "date-time"},
            "end": {"type": "string", "format": "date-time"},
            "attendees": {
                "type": "array",
                "items": {"type": "string", "format": "email"}
            },
            "recurrence": {
                "type": "object",
                "properties": {
                    "frequency": {"enum": ["daily", "weekly", "monthly"]},
                    "count": {"type": "integer", "minimum": 1}
                }
            }
        },
        "required": ["title", "start", "end"]
    }
}]

# 2. 发送用户消息 + 工具定义
response = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=1024,
    tools=tools,
    messages=[{
        "role": "user",
        "content": "Schedule a 30-minute sync with alice@example.com and bob@example.com next Monday at 10am."
    }]
)

# 3. Claude 返回 stop_reason: "tool_use" + tool_use 块
print(response.stop_reason)  # "tool_use"
for block in response.content:
    if block.type == "tool_use":
        print(f"工具: {block.name}")
        print(f"ID: {block.id}")
        print(f"输入: {block.input}")

# 4. 执行工具，回传 tool_result（tool_use_id 必须匹配 id）
tool_use = next(b for b in response.content if b.type == "tool_use")
result = create_calendar_event(**tool_use.input)  # 你的代码

messages.append({"role": "assistant", "content": response.content})
messages.append({
    "role": "user",
    "content": [{
        "type": "tool_result",
        "tool_use_id": tool_use.id,  # ← 必须匹配
        "content": str(result)
    }]
})
```

## 3.3 环 2-5：递进概念

| 环 | 新增概念 |
|----|---------|
| 环 1 | 单工具单轮 |
| 环 2 | 智能体循环（while stop_reason == "tool_use"） |
| 环 3 | 多工具（Claude 选择调用哪个） |
| 环 4 | 并行工具调用（一轮多个 tool_use） |
| 环 5 | 用 Tool Runner SDK 抽象替换手写循环 |

## 3.4 完整智能体循环模板

```python
def run_agent(user_message: str, tools: list, tool_functions: dict):
    """完整的智能体循环"""
    messages = [{"role": "user", "content": user_message}]
    
    while True:
        response = client.messages.create(
            model="claude-opus-4-8",
            max_tokens=1024,
            tools=tools,
            messages=messages
        )
        
        # 添加助手响应到历史
        messages.append({"role": "assistant", "content": response.content})
        
        # 如果不是 tool_use，循环结束
        if response.stop_reason != "tool_use":
            break
        
        # 执行所有 tool_use 块
        tool_results = []
        for block in response.content:
            if block.type == "tool_use":
                func = tool_functions[block.name]
                try:
                    result = func(**block.input)
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": str(result)
                    })
                except Exception as e:
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": f"Error: {str(e)}",
                        "is_error": True
                    })
        
        # 回传所有结果
        messages.append({"role": "user", "content": tool_results})
    
    # 返回最终文本
    return next(b.text for b in response.content if b.type == "text")
```

---

====================四、定义工具====================

## 4.1 选择模型

- **复杂工具/模糊查询**：用最新 Claude Opus（4.8），更好处理多工具，需要时寻求澄清
- **简单工具**：用 Claude Haiku，但注意它可能推断缺失参数

## 4.2 客户端工具定义结构

| 参数 | 描述 |
|------|------|
| `name` | 工具名，必须匹配 `^[a-zA-Z0-9_-]{1,64}$` |
| `description` | 详细的纯文本描述（功能、何时用、行为方式） |
| `input_schema` | JSON Schema 对象，定义预期参数 |
| `input_examples` | （可选）示例输入对象数组，帮助 Claude 理解用法 |

完整可选属性（`cache_control`、`strict`、`defer_loading`、`allowed_callers`）见工具参考。

## 4.3 工具使用系统提示结构

API 根据工具定义自动构建特殊系统提示：

```text
In this environment you have access to a set of tools you can use to answer the user's question.
{{ FORMATTING INSTRUCTIONS }}
String and scalar parameters should be specified as is, while lists and objects should use JSON format...
Here are the functions available in JSONSchema format:
{{ TOOL DEFINITIONS IN JSON SCHEMA }}
{{ USER SYSTEM PROMPT }}
{{ TOOL CONFIGURATION }}
```

## 4.4 工具定义最佳实践

### ⭐️ 提供极其详细的描述（最重要！）

这是**影响工具性能最重要的因素**。描述应解释：
- 工具的功能
- 何时应使用（以及何时不应使用）
- 每个参数的含义及如何影响行为
- 重要注意事项或限制

**每个工具描述至少 3-4 句话**，复杂工具更多。

### ✅ 良好描述示例

```python
{
    "name": "get_stock_price",
    "description": "Retrieves the current stock price for a given ticker symbol. The ticker symbol must be a valid symbol for a publicly traded company on a major US stock exchange like NYSE or NASDAQ. The tool will return the latest trade price in USD. It should be used when the user asks about the current or most recent price of a specific stock. It will not provide any other information about the stock or company.",
    "input_schema": {
        "type": "object",
        "properties": {
            "ticker": {
                "type": "string",
                "description": "The stock ticker symbol, e.g. AAPL for Apple Inc."
            }
        },
        "required": ["ticker"]
    }
}
```

### ❌ 不良描述示例

```python
{
    "name": "get_stock_price",
    "description": "Gets the stock price for a ticker.",  # 太简短！
    "input_schema": {
        "type": "object",
        "properties": {"ticker": {"type": "string"}},  # 无描述
        "required": ["ticker"]
    }
}
```

### 其他最佳实践

- **将相关操作整合到更少的工具**：用 `action` 参数代替 `create_pr`/`review_pr`/`merge_pr`
- **工具名用有意义的命名空间**：`github_list_prs`、`slack_send_message`
- **响应只返回高价值信息**：返回语义化稳定标识符（slug/UUID），只含 Claude 推理下一步所需字段

## 4.5 提供工具使用示例（input_examples）

对于复杂工具（嵌套对象、可选参数、格式敏感输入），用 `input_examples` 字段：

```python
tools = [{
    "name": "get_weather",
    "description": "Get the current weather in a given location",
    "input_schema": {
        "type": "object",
        "properties": {
            "location": {"type": "string", "description": "The city and state"},
            "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}
        },
        "required": ["location"]
    },
    "input_examples": [
        {"location": "San Francisco, CA", "unit": "fahrenheit"},
        {"location": "Tokyo, Japan", "unit": "celsius"},
        {"location": "New York, NY"}  # 演示 unit 是可选的
    ]
}]
```

### 要求和限制

- **模式验证**：每个示例必须符合 `input_schema`，无效示例返回 400 错误
- **不支持服务器端工具**：仅适用客户端工具
- **token 成本**：简单示例约 20-50 token，复杂嵌套约 100-200 token

## 4.6 控制 Claude 的输出：tool_choice

| 值 | 行为 |
|------|------|
| `{"type": "auto"}` | Claude 决定是否调用工具（提供 tools 时默认） |
| `{"type": "any"}` | 必须使用工具之一，但不强制特定工具 |
| `{"type": "tool", "name": "X"}` | 强制使用特定工具 X |
| `{"type": "none"}` | 阻止使用任何工具（未提供 tools 时默认） |

```python
# 强制使用 get_weather 工具
response = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=1024,
    tools=tools,
    tool_choice={"type": "tool", "name": "get_weather"},  # ← 强制
    messages=[{"role": "user", "content": "What's the weather in SF?"}]
)
```

### 重要注意事项

- ⚠️ **缓存失效**：更改 `tool_choice` 会使缓存的消息块失效（工具定义和系统提示仍缓存）
- ⚠️ **any/tool 会预填充助手消息**：模型不会在 tool_use 块之前发出自然语言响应
- ⚠️ **扩展思考不兼容 any/tool**：思考模式下只支持 `auto` 和 `none`
- ⚠️ **Mythos Preview 不支持强制工具使用**

### 想要自然语言 + 强制工具？

用 `auto` + 在用户消息中加明确指令：
```
What's the weather like in London? Use the get_weather tool in your response.
```

## 4.7 使用工具时的模型响应

Claude 通常在调用工具前说明它在做什么：

```python
{
    "role": "assistant",
    "content": [
        {"type": "text", "text": "I'll help you check the current weather in San Francisco."},
        {"type": "tool_use", "id": "toolu_01A...", "name": "get_weather", "input": {"location": "San Francisco, CA"}}
    ]
}
```

**关键**：你的代码应将这些文本视为任何其他助手文本，不要依赖特定格式约定。

---

====================五、处理工具调用====================

## 5.1 处理客户端工具的结果

响应的 `stop_reason` 为 `tool_use`，包含一个或多个 `tool_use` 块：
- `id`：唯一标识符（稍后匹配工具结果）
- `name`：工具名
- `input`：传给工具的输入对象（符合 input_schema）

### 处理步骤

1. 从 `tool_use` 块提取 `name`、`id`、`input`
2. 在代码库运行对应工具，传入 `input`
3. 发送 `role: "user"` 的新消息，含 `tool_result` 块：
   - `tool_use_id`：对应工具使用请求的 `id`
   - `content`（可选）：工具结果（字符串/内容块列表/文档块列表）
   - `is_error`（可选）：错误时设为 `true`

## 5.2 ⚠️ 重要的格式要求

### 规则 1：tool_result 必须紧跟在 tool_use 之后

不能在助手的 tool_use 消息和用户的 tool_result 消息之间插入其他消息。

### 规则 2：tool_result 块必须在 content 数组最前面

```python
# ❌ 错误：文本在 tool_result 之前 → 400 错误
{
    "role": "user",
    "content": [
        {"type": "text", "text": "Here are the results:"},  # ❌
        {"type": "tool_result", "tool_use_id": "toolu_01"}
    ]
}

# ✅ 正确：文本在所有 tool_result 之后
{
    "role": "user",
    "content": [
        {"type": "tool_result", "tool_use_id": "toolu_01"},
        {"type": "text", "text": "What should I do next?"}  # ✅
    ]
}
```

如果遇到 "tool_use ids were found without tool_result blocks immediately after" 错误，检查格式。

## 5.3 tool_result 的多种 content 形式

```python
# 形式 1：字符串
{"type": "tool_result", "tool_use_id": "toolu_01", "content": "15 degrees"}

# 形式 2：内容块列表（含图片）
{
    "type": "tool_result",
    "tool_use_id": "toolu_01",
    "content": [
        {"type": "text", "text": "15 degrees"},
        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "..."}}
    ]
}

# 形式 3：文档块
{
    "type": "tool_result",
    "tool_use_id": "toolu_01",
    "content": [
        {"type": "document", "source": {"type": "text", "media_type": "text/plain", "data": "15 degrees"}}
    ]
}

# 形式 4：空结果
{"type": "tool_result", "tool_use_id": "toolu_01"}
```

支持的内容块类型：`text`、`image`、`document`、`search_result`。

## 5.4 ⚠️ 安全警告：间接提示注入

工具结果常包含来自你无法控制的来源的内容（网页、入站邮件、用户上传文件、第三方 API）。**将此类内容视为不可信**：攻击者可能嵌入试图重定向 Claude 的指令。

**加固措施**：将不可信内容保留在 `tool_result` 块中，而不是放在 `system` 提示或普通用户 `text` 块中。

## 5.5 使用 is_error 处理错误

### 工具执行错误

```python
{
    "type": "tool_result",
    "tool_use_id": "toolu_01",
    "content": "ConnectionError: the weather service API is not available (HTTP 500)",
    "is_error": True
}
```

**最佳实践**：编写具有指导性的错误消息。不要用 `"failed"`，而要说明出了什么问题以及 Claude 接下来该尝试什么：
```
"Rate limit exceeded. Retry after 60 seconds."  # ✅ 给 Claude 恢复的上下文
```

### 无效工具名/缺少参数

```python
{
    "type": "tool_result",
    "tool_use_id": "toolu_01",
    "content": "Error: Missing required 'location' parameter",
    "is_error": True
}
```

Claude 会尝试修正并重试 2-3 次，然后才向用户致歉。

**彻底消除无效调用**：用 `strict: true` 启用严格工具使用（见第八章）。

## 5.6 处理服务器工具的结果

Claude 内部执行工具，结果直接整合到响应中，无需额外用户交互。**你无需为服务器工具处理 is_error 结果**。

网络搜索的可能错误码：
- `too_many_requests`：超出速率限制
- `invalid_input`：无效搜索查询
- `max_uses_exceeded`：超出最大使用次数
- `query_too_long`：查询超长
- `unavailable`：内部错误

====================六、并行工具使用====================

## 6.1 一句话定位

**并行工具使用 = Claude 在一轮响应中同时发出多个 tool_use 块**，你并行执行它们，一次性回传所有 tool_result。

## 6.2 响应形态

```python
# Claude 一轮返回多个 tool_use
{
    "role": "assistant",
    "content": [
        {"type": "text", "text": "我来同时查询天气和时间。"},
        {"type": "tool_use", "id": "toolu_01", "name": "get_weather", "input": {"location": "SF"}},
        {"type": "tool_use", "id": "toolu_02", "name": "get_time", "input": {"timezone": "PST"}}
    ]
}
```

## 6.3 关键规则：所有结果必须在同一条 user 消息中回传

```python
# ✅ 正确：多个 tool_result 在同一条 user 消息
{
    "role": "user",
    "content": [
        {"type": "tool_result", "tool_use_id": "toolu_01", "content": "15 degrees"},
        {"type": "tool_result", "tool_use_id": "toolu_02", "content": "2:30 PM"}
    ]
}
```

**不能拆成多条 user 消息**——每个 tool_use 必须有对应的 tool_result，且都在紧跟的那一条 user 消息里。

## 6.4 Python 并行执行示例

```python
import concurrent.futures

def execute_tools_parallel(tool_use_blocks, tool_functions):
    """并行执行多个工具"""
    results = [None] * len(tool_use_blocks)
    
    with concurrent.futures.ThreadPoolExecutor() as executor:
        future_to_idx = {
            executor.submit(tool_functions[b.name], **b.input): i
            for i, b in enumerate(tool_use_blocks)
        }
        for future in concurrent.futures.as_completed(future_to_idx):
            idx = future_to_idx[future]
            block = tool_use_blocks[idx]
            try:
                result = future.result()
                results[idx] = {
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": str(result)
                }
            except Exception as e:
                results[idx] = {
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": f"Error: {e}",
                    "is_error": True
                }
    return results
```

## 6.5 鼓励并行工具使用

默认情况下 Claude 可能倾向串行调用。可以通过系统提示鼓励并行：

```python
system = """For maximum efficiency, whenever you need to perform multiple
independent operations, invoke all relevant tools simultaneously rather
than sequentially."""
```

## 6.6 最佳实践

- **只对独立操作并行**：有依赖关系的操作（B 需要 A 的结果）不能并行
- **保持结果顺序无关**：用 tool_use_id 匹配，不依赖返回顺序
- **统一在一条 user 消息回传**：否则 400 错误

## 6.7 常见误区

- ❌ 把多个 tool_result 拆成多条 user 消息 → 正确：合并到一条
- ❌ 假设工具按调用顺序返回 → 正确：用 tool_use_id 匹配
- ❌ 对有依赖的操作强行并行 → 正确：让 Claude 分轮调用

---

====================七、Tool Runner（SDK 抽象）====================

## 7.1 一句话定位

**Tool Runner = SDK 提供的高级抽象，自动管理智能体循环**：你只需定义工具函数，SDK 自动处理 tool_use 循环、结果格式化、错误重试。

## 7.2 手动 vs Tool Runner

| 维度 | 手动处理（第五章） | Tool Runner |
|------|------------------|-------------|
| 智能体循环 | 你写 while 循环 | SDK 自动 |
| 结果格式化 | 你构造 tool_result | SDK 自动 |
| 错误处理 | 你写 try/except | SDK 自动重试 |
| 控制粒度 | 完全控制 | 简化但灵活性低 |

## 7.3 Python Tool Runner 示例

```python
import anthropic

client = anthropic.Anthropic()

# 用装饰器定义工具（SDK 自动从函数签名生成 schema）
def get_weather(location: str, unit: str = "celsius") -> str:
    """Get the current weather in a given location.
    
    Args:
        location: The city and state, e.g. San Francisco, CA
        unit: The unit of temperature
    """
    return f"15 degrees {unit} in {location}"

# Tool Runner 自动驱动循环
runner = client.beta.messages.tool_runner(
    model="claude-opus-4-8",
    max_tokens=1024,
    tools=[get_weather],  # 直接传函数
    messages=[{"role": "user", "content": "What's the weather in SF?"}]
)

# 迭代直到完成
for message in runner:
    print(message)

# 或直接获取最终结果
final = runner.until_done()
print(final.content)
```

## 7.4 何时用 Tool Runner vs 手动

- **用 Tool Runner**：标准智能体循环，不需要自定义控制
- **用手动处理**：需要自定义工具执行控制（如人工审批、特殊错误处理、流式中间结果）

## 7.5 最佳实践

- 工具函数写清晰的 docstring（SDK 从中生成 description）
- 用类型注解（SDK 从中生成 input_schema）
- 复杂控制需求时降级到手动循环

---

====================八、严格工具使用====================

## 8.1 一句话定位

**严格工具使用 = 在工具定义中加 `strict: true`，通过约束解码保证 Claude 的工具调用始终与 schema 完全匹配**（类似结构化输出，但用于工具输入）。

## 8.2 解决的问题

不用严格模式时，Claude 可能：
- 缺少必需参数
- 类型不匹配（字符串 vs 数字）
- 多出 schema 未定义的字段

严格模式从底层**保证**工具输入符合 schema。

## 8.3 启用方式

```python
tools = [{
    "name": "get_weather",
    "description": "Get the current weather",
    "strict": True,  # ← 启用严格模式
    "input_schema": {
        "type": "object",
        "properties": {
            "location": {"type": "string"},
            "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}
        },
        "required": ["location"],
        "additionalProperties": False  # ← 严格模式要求
    }
}]
```

## 8.4 与 tool_choice 组合（最强保证）

```python
# strict + tool_choice: any = 保证调用工具 + 保证输入符合 schema
response = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=1024,
    tools=tools,  # 含 strict: true
    tool_choice={"type": "any"},  # 保证调用某个工具
    messages=[...]
)
```

## 8.5 JSON Schema 限制（与结构化输出共享）

### ✅ 支持
- 基本类型：object、array、string、integer、number、boolean、null
- `enum`（仅字符串/数字/布尔/null）
- `const`、`anyOf`、`allOf`（有限制）
- `$ref`、`$def`（不支持外部 ref）
- 字符串格式：date-time、email、uri、uuid 等
- 数组 `minItems`（仅 0 和 1）

### ❌ 不支持
- 递归 schema
- 数值约束（minimum、maximum、multipleOf）
- 字符串约束（minLength、maxLength）
- `additionalProperties` 设为 false 以外的值

## 8.6 复杂度限制

| 限制 | 值 |
|------|------|
| 每请求严格工具数 | 20 |
| 可选参数总数 | 24 |
| 使用联合类型的参数 | 16 |

## 8.7 性能特征

- **首次请求延迟**：语法编译带来额外延迟
- **自动缓存**：编译后的语法缓存 24 小时
- **缓存失效**：更改 schema 结构或工具集会失效（仅改 name/description 不失效）

## 8.8 常见误区

- ❌ 严格模式 100% 不出错 → 正确：refusal/max_tokens 时仍可能不匹配
- ❌ 不需要 additionalProperties: false → 正确：严格模式必须设
- ❌ 可以用 minLength 等约束 → 正确：不支持，会被忽略或报错

---

====================九、工具使用与提示缓存====================

## 9.1 一句话定位

**工具使用与提示缓存结合 = 用 cache_control 缓存工具定义和工具结果，大幅降低多轮智能体循环的成本**。

## 9.2 缓存工具定义

在最后一个工具上加 `cache_control`，缓存整个 tools 数组：

```python
tools = [
    {"name": "tool_a", "description": "...", "input_schema": {...}},
    {"name": "tool_b", "description": "...", "input_schema": {...}},
    {
        "name": "tool_c",
        "description": "...",
        "input_schema": {...},
        "cache_control": {"type": "ephemeral"}  # ← 缓存到这里为止的所有工具
    }
]
```

**关键**：cache_control 放在最后一个工具上，会缓存**所有**前面的工具定义。

## 9.3 缓存断点的层级顺序

提示缓存的前缀顺序（必须按此顺序缓存）：
```
tools（工具定义）→ system（系统提示）→ messages（消息历史）
```

所以缓存 tools 时，后面的 system 和 messages 变化不影响 tools 缓存命中。

## 9.4 ⚠️ 什么会使工具缓存失效

| 变化 | 是否失效 |
|------|---------|
| 修改 tool_choice | ✅ 使消息缓存失效（工具/系统提示仍缓存） |
| 修改任何工具的 schema | ✅ 失效 |
| 增删工具 | ✅ 失效 |
| 仅修改工具顺序 | ✅ 失效 |
| 添加/移除 cache_control | ✅ 失效 |

## 9.5 缓存工具结果（多轮循环）

```python
# 在长的工具结果上加 cache_control，缓存大的工具输出
{
    "role": "user",
    "content": [{
        "type": "tool_result",
        "tool_use_id": "toolu_01",
        "content": "大量的工具输出..." * 1000,
        "cache_control": {"type": "ephemeral"}  # ← 缓存这个大结果
    }]
}
```

## 9.6 完整缓存示例

```python
response = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=1024,
    tools=[
        {"name": "tool_a", "description": "...", "input_schema": {...}},
        {
            "name": "tool_b",
            "description": "...",
            "input_schema": {...},
            "cache_control": {"type": "ephemeral"}  # 缓存全部工具
        }
    ],
    system=[{
        "type": "text",
        "text": "你是一个助手...",
        "cache_control": {"type": "ephemeral"}  # 缓存系统提示
    }],
    messages=messages
)

# 检查缓存命中
print(response.usage.cache_read_input_tokens)   # 缓存读取
print(response.usage.cache_creation_input_tokens)  # 缓存写入
```

## 9.7 最佳实践

- **工具定义稳定时缓存**：工具 schema 不常变，适合缓存
- **避免频繁切换 tool_choice**：会破坏消息缓存
- **长工具结果加 cache_control**：减少重复处理大输出
- **智能体循环用 1 小时缓存**：循环常超 5 分钟，用 ttl: "1h"

## 9.8 常见误区

- ❌ cache_control 放第一个工具 → 正确：放最后一个（缓存前缀）
- ❌ 改 tool_choice 不影响缓存 → 正确：使消息缓存失效
- ❌ 工具缓存和消息缓存独立 → 正确：有前缀依赖顺序

---

====================十、服务器工具总览====================

## 10.1 一句话定位

**服务器工具 = Anthropic 在自己的基础设施上执行的工具**，你只需启用，无需处理执行循环。

## 10.2 四种服务器工具

| 工具 | 用途 | 类型标识符 |
|------|------|-----------|
| `web_search` | 网络搜索 | web_search_20260209 等 |
| `web_fetch` | 抓取指定 URL | web_fetch_20250910 等 |
| `code_execution` | Python 沙箱执行 | code_execution_20260521 等 |
| `tool_search` | 工具搜索（延迟加载） | - |

## 10.3 服务器工具的响应形态

```python
# 响应包含 server_tool_use 块（执行已完成）
{
    "content": [
        {"type": "text", "text": "我来搜索一下。"},
        {
            "type": "server_tool_use",
            "id": "srvtoolu_01",
            "name": "web_search",
            "input": {"query": "Mars rover"}
        },
        {
            "type": "web_search_tool_result",  # 工具结果直接整合
            "tool_use_id": "srvtoolu_01",
            "content": [{"type": "web_search_result", "title": "...", "url": "..."}]
        },
        {"type": "text", "text": "根据搜索结果..."}
    ]
}
```

## 10.4 pause_turn：服务器循环未完成

```python
# 服务器迭代达到上限，返回 pause_turn
if response.stop_reason == "pause_turn":
    # 重新发送对话（含暂停响应）让模型继续
    messages.append({"role": "assistant", "content": response.content})
    response = client.messages.create(
        model="claude-opus-4-8",
        max_tokens=1024,
        tools=tools,
        messages=messages  # 包含暂停的响应
    )
```

## 10.5 与客户端工具的区别

| 维度 | 客户端工具 | 服务器工具 |
|------|-----------|-----------|
| 执行位置 | 你的应用 | Anthropic 基础设施 |
| 你回传 tool_result | 是 | 否 |
| 智能体循环 | 你驱动 | Anthropic 驱动（服务器端） |
| 计费 | 标准 token | 标准 token + 使用费 |
| 处理 is_error | 是 | 否（Anthropic 处理） |

## 10.6 最佳实践

- **处理 pause_turn**：服务器循环可能未完成，需要继续
- **设置合理的 max_uses**：限制服务器工具使用次数防止失控
- **关注使用费**：服务器工具有额外计费（如搜索按次）

---

====================十一、工具使用故障排查====================

## 11.1 常见错误诊断表

| 症状 | 原因 | 解决方案 |
|------|------|---------|
| Claude 调错工具 | 工具描述不清晰/重叠 | 详细化描述，明确区分工具用途 |
| Claude 虚构参数 | 提示信息不足 | 提供更多上下文，或用 strict 模式 |
| 并行工具失效 | 操作有依赖关系 | 让 Claude 分轮调用 |
| 缓存意外失效 | tool_choice 变化/工具集变化 | 保持工具定义稳定 |
| 400 请求错误 | tool_result 格式错误 | tool_result 在数组最前，紧跟 tool_use |
| thinking 块错误 | 思考块未原样回传 | 多轮对话原样传回 thinking 块 |
| 提示注入风险 | 工具结果含恶意指令 | 不可信内容保留在 tool_result 块 |
| JSON 转义错误 | input_json_delta 累积/解析问题 | 累积完整后再解析 |

## 11.2 错误 1：Claude 不调用工具

**症状**：预期 Claude 用工具，但它直接回复。

**解决**：
```python
# 引导工具使用
system = "Use the tools to investigate before responding."

# 或硬性强制
tool_choice = {"type": "any"}  # 或 {"type": "tool", "name": "X"}
```

## 11.3 错误 2："tool_use ids were found without tool_result blocks"

**原因**：tool_result 格式错误。

**检查清单**：
- tool_result 是否紧跟在 tool_use 消息之后？
- tool_result 块是否在 content 数组最前面？
- 每个 tool_use 是否都有对应的 tool_result？
- tool_use_id 是否匹配？

## 11.4 错误 3：Claude 虚构/缺少参数

**解决**：
1. 详细化工具描述（每个参数说明含义）
2. 用 `input_examples` 提供示例
3. 用 `strict: true` 保证 schema 验证

## 11.5 错误 4：扩展思考 + 工具使用报错

**原因**：思考模式不支持 `tool_choice: any/tool`。

**解决**：思考模式只用 `auto`（默认）或 `none`。

## 11.6 错误 5：thinking 块相关错误

**原因**：多轮对话中思考块未原样回传。

**解决**：工具使用循环中必须原样回传 thinking 块（含 signature）。

## 11.7 最佳实践总结

- **描述优先**：80% 的工具问题靠详细描述解决
- **strict 兜底**：参数问题用严格模式
- **格式检查**：tool_result 位置和 tool_use_id 匹配
- **安全意识**：工具结果当作不可信内容

====================十二、网络搜索工具====================

## 12.1 一句话定位

**网络搜索工具（web_search）= 服务器工具，让 Claude 搜索网络获取实时信息并自动引用来源**。

## 12.2 类型标识符版本

| 版本 | 说明 |
|------|------|
| `web_search_20250305` | 较早版本 |
| `web_search_20260209` | 较新版本 |
| `web_search_20260318` | 最新版本 |

## 12.3 基本用法

```python
import anthropic

client = anthropic.Anthropic()

response = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=1024,
    tools=[{
        "type": "web_search_20260209",
        "name": "web_search",
        "max_uses": 5  # 限制最多 5 次搜索
    }],
    messages=[{"role": "user", "content": "纽约今天天气怎么样？"}]
)
```

## 12.4 关键参数

| 参数 | 说明 |
|------|------|
| `max_uses` | 单个请求最多搜索次数 |
| `allowed_domains` | 只搜索这些域名（白名单） |
| `blocked_domains` | 排除这些域名（黑名单） |
| `user_location` | 用户位置（影响本地化结果） |

```python
tools = [{
    "type": "web_search_20260209",
    "name": "web_search",
    "max_uses": 5,
    "allowed_domains": ["wikipedia.org", "nature.com"],  # 只搜这些
    "user_location": {
        "type": "approximate",
        "country": "US",
        "city": "New York"
    }
}]
```

## 12.5 响应结构

```python
for block in response.content:
    if block.type == "server_tool_use":
        print(f"搜索查询: {block.input['query']}")
    elif block.type == "web_search_tool_result":
        for result in block.content:
            print(f"标题: {result.title}")
            print(f"URL: {result.url}")
    elif block.type == "text":
        # Claude 的回答会自动带引用
        print(block.text)
        if hasattr(block, "citations"):
            for cite in block.citations:
                print(f"  引用: {cite.url}")
```

## 12.6 定价

- 约 **$10 / 1000 次搜索**（额外于 token 费用）
- 受 `max_uses` 限制

## 12.7 错误码

- `too_many_requests`：超出速率限制
- `invalid_input`：无效查询参数
- `max_uses_exceeded`：超出最大使用次数
- `query_too_long`：查询超长
- `unavailable`：内部错误

## 12.8 最佳实践

- **设 max_uses 防失控**：避免单请求大量搜索
- **用 allowed_domains 限定权威来源**：提高结果质量
- **设 user_location 本地化**：天气、新闻等本地查询更准

## 12.9 常见误区

- ❌ 需要自己处理搜索结果 → 正确：服务器自动整合
- ❌ 搜索免费 → 正确：按次收费
- ❌ 需要回传 tool_result → 正确：服务器工具无需

---

====================十三、网页抓取工具====================

## 13.1 一句话定位

**网页抓取工具（web_fetch）= 服务器工具，让 Claude 抓取指定 URL 的完整内容**（不同于搜索，是直接读取已知 URL）。

## 13.2 类型标识符

| 版本 | 说明 |
|------|------|
| `web_fetch_20250910` | 网页抓取工具版本 |

## 13.3 基本用法

```python
response = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=1024,
    tools=[{
        "type": "web_fetch_20250910",
        "name": "web_fetch",
        "max_uses": 3
    }],
    messages=[{
        "role": "user",
        "content": "总结这篇文章：https://example.com/article"
    }]
)
```

## 13.4 关键参数

| 参数 | 说明 |
|------|------|
| `max_uses` | 最大抓取次数 |
| `max_content_tokens` | 每次抓取内容的最大 token |
| `citations` | 是否启用引用 |
| `allowed_domains` / `blocked_domains` | URL 域名过滤 |

## 13.5 与搜索组合使用

```python
# 搜索 + 抓取：先搜索找 URL，再抓取详细内容
tools = [
    {"type": "web_search_20260209", "name": "web_search", "max_uses": 3},
    {"type": "web_fetch_20250910", "name": "web_fetch", "max_uses": 3}
]

response = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=2048,
    tools=tools,
    messages=[{"role": "user", "content": "找到关于量子计算的最新论文并详细总结"}]
)
```

## 13.6 URL 安全验证

- 默认验证 URL 安全性
- 可用 `allowed_domains` 限制只抓取信任域名
- 防止 SSRF（服务器端请求伪造）攻击

## 13.7 定价

- **免费**（只付返回内容的 token 费用）
- 区别于搜索（搜索按次收费）

## 13.8 最佳实践

- **set max_content_tokens 控制成本**：大网页限制抓取量
- **搜索+抓取组合**：搜索找 URL，抓取读详情
- **用 allowed_domains 防 SSRF**：限制可抓取域名

## 13.9 常见误区

- ❌ web_fetch = web_search → 正确：fetch 读已知 URL，search 搜未知
- ❌ web_fetch 按次收费 → 正确：免费（只付 token）

---

====================十四、代码执行工具====================

## 14.1 一句话定位

**代码执行工具（code_execution）= 服务器工具，让 Claude 在 Anthropic 的 Python 沙箱中执行代码**（数据分析、计算、绘图等）。

## 14.2 类型标识符版本

| 版本 | 说明 |
|------|------|
| `code_execution_20250825` | 较早版本 |
| `code_execution_20260120` | 中间版本 |
| `code_execution_20260521` | 最新版本 |

## 14.3 基本用法

```python
response = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=4096,
    tools=[{"type": "code_execution_20260521", "name": "code_execution"}],
    messages=[{
        "role": "user",
        "content": "计算前 100 个素数的和，并画出它们的分布图"
    }]
)
```

## 14.4 容器规格

| 规格 | 值 |
|------|------|
| Python 版本 | 3.11.12 |
| 内存 | 5 GiB RAM |
| 网络 | 无网络访问（沙箱隔离） |
| 预装库 | numpy、pandas、matplotlib、scipy 等 |

## 14.5 Files API 集成

```python
# 上传文件供代码执行使用
file = client.beta.files.upload(
    file=("data.csv", open("data.csv", "rb"))
)

response = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=4096,
    tools=[{"type": "code_execution_20260521", "name": "code_execution"}],
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "分析这个 CSV 数据"},
            {"type": "container_upload", "file_id": file.id}  # 引用上传的文件
        ]
    }]
)
```

## 14.6 容器复用

- 同一会话的多次代码执行**复用同一容器**
- 变量、文件状态在执行之间保留
- 适合多步数据分析工作流

## 14.7 定价

- **每月 1550 小时免费**容器时间
- 超出后按容器使用时间计费

## 14.8 最佳实践

- **数据分析用容器复用**：多步分析保持状态
- **用 Files API 处理大文件**：上传后引用
- **注意无网络**：容器不能访问外部 API

## 14.9 常见误区

- ❌ 容器可以联网 → 正确：无网络访问
- ❌ 每次执行新容器 → 正确：同会话复用
- ❌ 完全免费 → 正确：1550h/月免费，超出收费

---

====================十五、Advisor 工具====================

## 15.1 一句话定位

**Advisor 工具（Beta）= 让主模型（执行器）在推理过程中"请教"一个更强的顾问模型获取指导**（执行器+顾问架构）。

## 15.2 架构原理

```
执行器模型（如 Sonnet）执行任务
   ↓ 遇到难题
调用 advisor 服务端工具
   ↓
顾问模型（如 Opus）提供指导
   ↓
执行器根据指导继续
```

## 15.3 模型配对

| 执行器 | 推荐顾问 |
|--------|---------|
| Haiku | Sonnet / Opus |
| Sonnet | Opus |
| Opus | Opus（更高 effort） |

## 15.4 基本用法

```python
response = client.messages.create(
    model="claude-sonnet-4-6",  # 执行器
    max_tokens=4096,
    tools=[{
        "type": "advisor_20260301",
        "name": "advisor",
        "model": "claude-opus-4-8",  # 顾问模型
        "max_uses": 3
    }],
    messages=[{"role": "user", "content": "设计一个复杂的分布式系统架构"}]
)
```

## 15.5 关键参数

| 参数 | 说明 |
|------|------|
| `model` | 顾问模型 ID |
| `max_uses` | 最大请教次数 |
| `max_tokens` | 顾问响应的最大 token |
| `caching` | 是否缓存顾问上下文 |

## 15.6 计费结构

- 通过 `usage.iterations` 反映执行器和顾问的分别计费
- 执行器 token + 顾问 token 分别计算

## 15.7 Claude Code 中的实现

Claude Code 源码（`src/utils/advisor.ts`）实现了 advisor：
- `isAdvisorEnabled()`：检查是否启用
- `ADVISOR_TOOL_INSTRUCTIONS`：注入系统提示
- 通过 `advisor_20260301` 类型注册服务端工具
- 只在 agentic query（repl_main_thread、agent:*）启用

## 15.8 最佳实践

- **执行器用便宜模型，顾问用强模型**：成本+质量平衡
- **设 max_uses 防滥用**：限制请教次数
- **复杂决策点用 advisor**：架构设计、难题求解

## 15.9 常见误区

- ❌ advisor 替代主模型 → 正确：辅助主模型决策
- ❌ 所有任务都用 → 正确：只在难题/关键决策用

---

====================十六、Memory 工具====================

## 16.1 一句话定位

**Memory 工具（memory_20250818）= Anthropic 模式客户端工具，让 Claude 在文件系统中管理跨会话的持久记忆**。

## 16.2 类型标识符

| 版本 | 说明 |
|------|------|
| `memory_20250818` | Memory 工具版本 |

## 16.3 六个命令

| 命令 | 作用 |
|------|------|
| `view` | 查看记忆目录或文件 |
| `create` | 创建记忆文件 |
| `str_replace` | 替换文件中的字符串 |
| `insert` | 在指定行插入内容 |
| `delete` | 删除记忆文件 |
| `rename` | 重命名记忆文件 |

## 16.4 基本用法

```python
response = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=2048,
    tools=[{"type": "memory_20250818", "name": "memory"}],
    messages=[{"role": "user", "content": "记住我喜欢用 Python 和 VS Code"}]
)

# 处理 memory 工具调用（客户端执行）
for block in response.content:
    if block.type == "tool_use" and block.name == "memory":
        command = block.input["command"]  # view/create/str_replace 等
        # 在你的文件系统执行记忆操作
        result = handle_memory_command(block.input)
        # 回传 tool_result
```

## 16.5 路径遍历防护

- ⚠️ 必须验证路径，防止 `../` 路径遍历攻击
- 将记忆限制在专用目录内

```python
import os

def safe_memory_path(base_dir: str, path: str) -> str:
    """防止路径遍历"""
    full_path = os.path.normpath(os.path.join(base_dir, path))
    if not full_path.startswith(os.path.abspath(base_dir)):
        raise ValueError("路径遍历攻击！")
    return full_path
```

## 16.6 多会话模式

- 记忆存储在文件系统，跨会话持久
- 新会话开始时 Claude 可以 `view` 之前的记忆
- 适合：用户偏好、项目上下文、长期任务状态

## 16.7 Claude Code 中的对应实现

Claude Code 有自己的记忆系统（`src/memdir/`）：
- `LocalMemoryRecallTool`：本地记忆回忆工具
- `MEMORY.md`：记忆索引
- 每个记忆一个文件，带 frontmatter

## 16.8 最佳实践

- **严格路径验证**：防止路径遍历
- **专用记忆目录**：隔离记忆文件
- **会话开始时 view**：让 Claude 了解已有记忆

## 16.9 常见误区

- ❌ 记忆是服务器工具 → 正确：客户端执行（你管理文件）
- ❌ 不需要路径验证 → 正确：必须防路径遍历

---

====================十七、Bash 工具====================

## 17.1 一句话定位

**Bash 工具（bash_20250124）= Anthropic 模式客户端工具，让 Claude 执行 shell 命令**（schema 经训练内化，比自定义更可靠）。

## 17.2 类型标识符

| 版本 | 说明 |
|------|------|
| `bash_20250124` | Bash 工具版本 |

## 17.3 基本用法

```python
response = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=2048,
    tools=[{"type": "bash_20250124", "name": "bash"}],
    messages=[{"role": "user", "content": "列出当前目录的所有 Python 文件"}]
)

# 处理 bash 工具调用（客户端执行）
import subprocess

for block in response.content:
    if block.type == "tool_use" and block.name == "bash":
        command = block.input["command"]
        result = subprocess.run(command, shell=True, capture_output=True, text=True)
        # 回传结果
        tool_result = {
            "type": "tool_result",
            "tool_use_id": block.id,
            "content": result.stdout + result.stderr,
            "is_error": result.returncode != 0
        }
```

## 17.4 持久化 bash 会话

- Bash 工具维护一个**持久 shell 会话**
- 环境变量、工作目录在命令之间保留
- 适合多步操作（cd、设置 env、然后运行）

## 17.5 计费

- 约 **245 token** 附加费（工具系统提示）

## 17.6 安全：allowlist 模式

```python
ALLOWED_COMMANDS = {"ls", "cat", "grep", "find", "echo"}

def safe_bash(command: str) -> bool:
    """只允许白名单命令"""
    cmd = command.split()[0]
    return cmd in ALLOWED_COMMANDS
```

## 17.7 Claude Code 中的 Bash 实现

Claude Code 的 BashTool 极其复杂（`packages/builtin-tools/src/tools/BashTool/`）：
- `bashSecurity.ts`：安全检查
- `shouldUseSandbox.ts`：沙箱判断
- `bashPermissions.ts`：权限规则
- `destructiveCommandWarning.ts`：危险命令警告
- `readOnlyValidation.ts`：只读验证

## 17.8 最佳实践

- **用 allowlist 限制命令**：防止危险操作
- **沙箱隔离**：在容器中执行
- **危险命令需确认**：rm、mv 等需用户审批

## 17.9 常见误区

- ❌ Bash 工具自动安全 → 正确：你负责安全控制
- ❌ 每次新 shell → 正确：持久会话保留状态

---

====================十八、Computer Use 工具====================

## 18.1 一句话定位

**Computer Use 工具（computer_20251124）= Anthropic 模式客户端工具，让 Claude 通过截图+键鼠操作控制图形界面**。

## 18.2 类型标识符版本

| 版本 | beta header |
|------|-------------|
| `computer_20251124` | 最新版本 |
| `computer_20250124` | 较早版本 |

## 18.3 基本用法

```python
response = client.beta.messages.create(
    model="claude-opus-4-8",
    max_tokens=2048,
    tools=[{
        "type": "computer_20251124",
        "name": "computer",
        "display_width_px": 1280,
        "display_height_px": 800,
        "display_number": 1
    }],
    betas=["computer-use-2025-01-24"],  # 需要 beta header
    messages=[{"role": "user", "content": "打开浏览器并搜索 Python 教程"}]
)
```

## 18.4 Agent Loop 模式

```
1. Claude 请求截图（screenshot 操作）
   ↓
2. 你执行截图，回传图片
   ↓
3. Claude 分析截图，决定下一步动作（click/type/scroll）
   ↓
4. 你执行动作，再次截图回传
   ↓
5. 循环直到任务完成
```

## 18.5 支持的操作

| 操作 | 说明 |
|------|------|
| `screenshot` | 截图 |
| `left_click` | 左键点击（坐标） |
| `type` | 输入文本 |
| `key` | 按键 |
| `scroll` | 滚动 |
| `mouse_move` | 移动鼠标 |

## 18.6 ⚠️ 图像尺寸限制与坐标缩放

- Claude 看到的截图可能被缩放
- 返回的坐标基于缩放后的图像
- **必须将坐标缩放回实际屏幕分辨率**

```python
def scale_coordinates(x, y, claude_width, claude_height, actual_width, actual_height):
    """将 Claude 坐标缩放到实际屏幕"""
    real_x = int(x * actual_width / claude_width)
    real_y = int(y * actual_height / claude_height)
    return real_x, real_y
```

## 18.7 点击诊断

如果点击不准：
- 检查坐标缩放是否正确
- 确认 display_width_px / display_height_px 与实际一致
- 验证截图分辨率

## 18.8 Claude Code 中的实现

Claude Code 有完整的 Computer Use 实现（`packages/@ant/computer-use-*`）：
- `computer-use-mcp`：MCP server（截图/键鼠/剪贴板）
- `computer-use-input`：键鼠模拟（darwin/win32/linux）
- `computer-use-swift`：截图+应用管理

## 18.9 最佳实践

- **正确处理坐标缩放**：最常见的 bug 来源
- **每步截图验证**：让 Claude 看到操作结果
- **沙箱环境**：在隔离环境运行，防止误操作

## 18.10 常见误区

- ❌ 坐标直接用 → 正确：必须缩放回实际分辨率
- ❌ 不需要截图 → 正确：每步都需要截图反馈

---

====================十九、Text Editor 工具====================

## 19.1 一句话定位

**Text Editor 工具（text_editor_20250728）= Anthropic 模式客户端工具，让 Claude 查看和编辑文件**（schema 经训练内化）。

## 19.2 类型标识符

| 版本 | 说明 |
|------|------|
| `text_editor_20250728` | 最新版本 |

## 19.3 四个命令

| 命令 | 作用 |
|------|------|
| `view` | 查看文件内容（可指定行范围） |
| `str_replace` | 替换文件中的字符串 |
| `create` | 创建新文件 |
| `insert` | 在指定行插入内容 |

## 19.4 基本用法

```python
response = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=2048,
    tools=[{"type": "text_editor_20250728", "name": "str_replace_based_edit_tool"}],
    messages=[{"role": "user", "content": "修复 main.py 中的语法错误"}]
)

# 处理 text_editor 工具调用
for block in response.content:
    if block.type == "tool_use" and block.name == "str_replace_based_edit_tool":
        command = block.input["command"]  # view/str_replace/create/insert
        result = handle_text_editor(block.input)
        # 回传 tool_result
```

## 19.5 ⚠️ 唯一匹配验证

`str_replace` 要求 `old_str` 在文件中**唯一匹配**：
- 如果匹配多处 → 报错
- 如果匹配 0 处 → 报错
- 必须精确匹配（含空白）

```python
def safe_replace(content: str, old_str: str, new_str: str) -> str:
    """安全替换：验证唯一匹配"""
    count = content.count(old_str)
    if count == 0:
        raise ValueError(f"未找到: {old_str}")
    if count > 1:
        raise ValueError(f"匹配 {count} 处，需要唯一匹配")
    return content.replace(old_str, new_str)
```

## 19.6 Claude Code 中的对应实现

Claude Code 的 FileEditTool（`packages/builtin-tools/src/tools/FileEditTool/`）：
- 类似 str_replace 机制
- 唯一匹配验证
- diff 展示
- 权限检查

## 19.7 最佳实践

- **str_replace 前先 view**：了解文件当前内容
- **保证唯一匹配**：old_str 要足够长以唯一定位
- **保留缩进**：精确匹配含空白

## 19.8 常见误区

- ❌ str_replace 可以匹配多处 → 正确：必须唯一
- ❌ 不需要精确空白 → 正确：含缩进精确匹配

---

====================二十、Claude Code 源码实现参考====================

## 20.1 Tool 接口定义（`src/Tool.ts`）

Claude Code 的 Tool 接口（第 380-539 行）远比 API schema 丰富：

```ts
export type Tool<Input, Output, P> = {
  // 核心
  readonly name: string                          // 工具名
  readonly inputSchema: Input                     // Zod schema
  readonly inputJSONSchema?: ToolInputJSONSchema  // MCP 工具用 JSON Schema

  // 执行
  call(args, context, canUseTool, parentMessage, onProgress): Promise<ToolResult<Output>>
  description(input, options): Promise<string>    // 动态生成描述
  prompt(options): Promise<string>                // 生成工具提示

  // 行为标记
  isConcurrencySafe(input): boolean   // 是否可并行
  isReadOnly(input): boolean          // 是否只读
  isDestructive?(input): boolean      // 是否不可逆操作
  isEnabled(): boolean                // 是否启用

  // 权限
  validateInput?(input, context): Promise<ValidationResult>  // 输入验证
  checkPermissions(input, context): Promise<PermissionResult> // 权限检查

  // 延迟加载
  readonly shouldDefer?: boolean   // 延迟加载（SearchExtraTools）
  readonly alwaysLoad?: boolean    // 永不延迟

  // 严格模式
  readonly strict?: boolean         // 严格 schema 验证

  // MCP
  isMcp?: boolean
  mcpInfo?: { serverName: string; toolName: string }
}
```

### 关键设计对照官方文档

| API 概念 | Claude Code 实现 |
|---------|-----------------|
| `name` | `name` |
| `description` | `description()` 动态生成 |
| `input_schema` | `inputSchema`（Zod）/ `inputJSONSchema`（MCP） |
| `strict: true` | `strict?: boolean` |
| 并行工具使用 | `isConcurrencySafe(input)` |
| `defer_loading` | `shouldDefer` / `alwaysLoad` |
| 权限控制 | `validateInput` + `checkPermissions` |

## 20.2 流式工具处理（`src/services/api/claude.ts`）

### content_block_start 处理 tool_use（第 2364-2385 行）

```ts
case 'content_block_start':
  switch (part.content_block.type) {
    case 'tool_use':
      contentBlocks[part.index] = {
        ...part.content_block,
        input: '',  // ← 初始化为空字符串，累积 input_json_delta
      }
      break
    case 'server_tool_use':  // 服务器工具（advisor 等）
      contentBlocks[part.index] = {
        ...part.content_block,
        input: '',
      }
      if (part.content_block.name === 'advisor') {
        isAdvisorInProgress = true
      }
      break
  }
```

### input_json_delta 累积（第 2455-2480 行）

```ts
case 'input_json_delta':
  // 工具输入是部分 JSON 字符串，累积
  if (contentBlock.type !== 'tool_use' && contentBlock.type !== 'server_tool_use') {
    throw new Error('Content block is not a input_json block')
  }
  contentBlock.input += delta.partial_json  // ← 累积
  break
```

### content_block_stop 解析 JSON

```ts
case 'content_block_stop':
  // tool_use 块在结束时才解析累积的 JSON 字符串
  if (contentBlock.type === 'tool_use' || contentBlock.type === 'server_tool_use') {
    contentBlock.input = safeParseJSON(contentBlock.input)
  }
```

## 20.3 工具注册表（`src/tools.ts`）

Claude Code 用 feature flag 条件加载工具：

```ts
// 始终加载的核心工具
import { BashTool } from '...BashTool'
import { FileEditTool } from '...FileEditTool'
import { WebSearchTool } from '...WebSearchTool'

// 条件加载（feature flag / USER_TYPE）
const REPLTool = process.env.USER_TYPE === 'ant'
  ? require('...REPLTool').REPLTool : null

const MonitorTool = feature('MONITOR_TOOL')
  ? require('...MonitorTool').MonitorTool : null
```

## 20.4 工具权限系统

Claude Code 的工具权限远超 API：

```ts
// 每个工具的权限检查
checkPermissions(input, context): Promise<PermissionResult>

// 权限模式
type PermissionMode = 'default' | 'plan' | 'bypassPermissions' | 'acceptEdits'

// 工具行为标记影响权限
isReadOnly(input)      // 只读工具通常免权限
isDestructive(input)   // 危险操作需要确认
```

## 20.5 延迟加载工具（SearchExtraTools）

Claude Code 实现了官方的 tool_search 概念：

```ts
// 工具可以延迟加载（shouldDefer: true）
// 不发送完整 schema，节省 token + 保护缓存
// 通过 SearchExtraTools + ExecuteExtraTool 按需调用

readonly shouldDefer?: boolean   // 延迟此工具
readonly alwaysLoad?: boolean    // 强制始终加载（关键工具）
```

## 20.6 60+ 内置工具一览

`packages/builtin-tools/src/tools/` 包含：

| 分类 | 工具 |
|------|------|
| 文件操作 | FileEditTool, FileReadTool, FileWriteTool, GlobTool, GrepTool |
| Shell/执行 | BashTool, PowerShellTool, REPLTool |
| Agent 系统 | AgentTool, TaskCreateTool, TaskUpdateTool, TaskListTool |
| 规划 | EnterPlanModeTool, ExitPlanModeV2Tool, VerifyPlanExecutionTool |
| Web/MCP | WebFetchTool, WebSearchTool, MCPTool, McpAuthTool |
| 调度 | CronCreateTool, CronDeleteTool, CronListTool |
| 工具发现 | SearchExtraToolsTool, ExecuteExtraTool, SyntheticOutput |
| 其他 | LSPTool, ConfigTool, SkillTool, NotebookEditTool 等 |

---

====================总结====================

## 核心要点

1. **两大类工具**：客户端工具（你执行）vs 服务器工具（Anthropic 执行）
2. **智能体循环**：`while stop_reason == "tool_use"` 执行工具并继续
3. **描述是关键**：详细的工具描述是性能最重要因素
4. **格式严格**：tool_result 必须紧跟 tool_use，且在数组最前
5. **strict 兜底**：参数问题用严格模式保证 schema
6. **缓存优化**：cache_control 放最后一个工具缓存全部
7. **并行执行**：独立操作并行，结果合并到一条 user 消息
8. **服务器工具**：web_search/web_fetch/code_execution/advisor 无需你处理执行
9. **Anthropic 模式工具**：bash/text_editor/computer/memory 经训练内化更可靠
10. **安全意识**：工具结果视为不可信内容，防提示注入

## 工具选择决策树

```
需要工具吗？
├─ 不需要（摘要/翻译/常识）→ 不用工具
└─ 需要
   ├─ 自定义业务逻辑 → 用户定义客户端工具
   ├─ 标准开发操作 → Anthropic 模式工具（bash/editor/computer/memory）
   └─ 搜索/沙箱/抓取 → 服务器工具（web_search/code_execution/web_fetch）
```

## 学习路径建议

```
1. 理解客户端 vs 服务器工具的区别
   ↓
2. 掌握智能体循环（while stop_reason == "tool_use"）
   ↓
3. 学会定义工具（详细描述 + JSON Schema）
   ↓
4. 处理工具调用（tool_use → tool_result，格式严格）
   ↓
5. 进阶：并行、严格模式、缓存优化
   ↓
6. 各类工具实战：搜索、代码执行、bash、computer use
```

---

*文档生成时间：2026/07/01*
*基于 Claude Code 源码版本：2.2.1*
*参考：Anthropic 官方文档 19 个工具使用页面*
