# 并行工具使用 (Parallel Tool Use)

> Source: https://platform.claude.com/docs/zh-CN/agents-and-tools/tool-use/parallel-tool-use

## 核心概念

Claude 默认可以在一个回合中调用多个工具。通过 `disable_parallel_tool_use=true` 可以禁用此行为：
- `tool_choice: auto` 时设置：最多使用一个工具
- `tool_choice: any/tool` 时设置：恰好使用一个工具

## 执行语义

API 不规定执行顺序，可以并发运行（Promise.all/asyncio.gather）或按顺序运行。

关键规则：
- 每个 `tool_use` 块必须返回一个 `tool_result`
- 所有结果必须放在**同一条用户消息**中
- 未运行的调用需返回 `is_error: true`

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_02",
  "is_error": true,
  "content": "Not executed: the preceding write_file call failed."
}
```

## Python 代码示例

```python
# 定义工具
tools = [
    {
        "name": "get_weather",
        "description": "Get the current weather in a given location",
        "input_schema": {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "The city and state, e.g. San Francisco, CA",
                }
            },
            "required": ["location"],
        },
    },
    {
        "name": "get_time",
        "description": "Get the current time in a given timezone",
        "input_schema": {
            "type": "object",
            "properties": {
                "timezone": {
                    "type": "string",
                    "description": "The timezone, e.g. America/New_York",
                }
            },
            "required": ["timezone"],
        },
    },
]

messages = [
    {
        "role": "user",
        "content": "What's the weather in SF and NYC, and what time is it there?",
    }
]

response = client.messages.create(
    model="claude-opus-4-8", max_tokens=1024, messages=messages, tools=tools
)

# 提取并行工具调用
tool_uses = [block for block in response.content if block.type == "tool_use"]

# 执行所有工具并收集结果
tool_results = []
for tool_use in tool_uses:
    # ... 执行工具 ...
    tool_results.append(
        {"type": "tool_result", "tool_use_id": tool_use.id, "content": result}
    )

# 关键：所有结果放在单条消息中
messages.extend([
    {"role": "assistant", "content": response.content},
    {"role": "user", "content": tool_results},  # All results in one message!
])
```

## 最大化并行工具使用

系统提示增强：
```text
<use_parallel_tool_calls>
For maximum efficiency, whenever you perform multiple independent operations, 
invoke all relevant tools simultaneously rather than sequentially.
</use_parallel_tool_calls>
```

## 最佳实践

- ✅ 所有工具结果放在单个用户消息中
- ❌ 不要为每个工具结果发送单独的用户消息
- 独立只读操作可安全并行
- 有副作用的工具按顺序运行

## 常见陷阱

1. **工具结果格式不正确** — 单独发送每个工具结果会降低并行调用
2. **提示力度不足** — 需使用更强的系统提示
3. **工具间依赖** — 在系统提示中声明 "Only batch tool calls that are independent of each other."
