# Tool Runner（SDK 工具运行器）

> Source: https://platform.claude.com/docs/zh-CN/agents-and-tools/tool-use/tool-runner

## 核心概念

Tool Runner 自动处理：
- 智能体循环（自动调用工具并将结果返回 Claude）
- 错误封装
- 类型安全
- 对话状态管理

适用场景：大多数工具使用。不适用：需要人工审批、自定义日志或条件执行。

**Beta 状态**：Python/TypeScript/C#/Go/Java/PHP/Ruby SDK 均可用。

## Python 代码示例

```python
import json
from anthropic import Anthropic, beta_tool

client = Anthropic()

@beta_tool
def get_weather(location: str, unit: str = "fahrenheit") -> str:
    """Get the current weather in a given location.

    Args:
        location: The city and state, e.g. San Francisco, CA
        unit: Temperature unit, either 'celsius' or 'fahrenheit'
    """
    return json.dumps({"temperature": "20°C", "condition": "Sunny"})

@beta_tool
def calculate_sum(a: int, b: int) -> str:
    """Add two numbers together.

    Args:
        a: First number
        b: Second number
    """
    return str(a + b)

# 使用 Tool Runner
response = client.beta.tools.run(
    model="claude-opus-4-8",
    max_tokens=1024,
    messages=[{"role": "user", "content": "What's the weather in SF?"}],
    tools=[get_weather, calculate_sum],
)
print(response)
```

## 关键 API 参数

- `model`: 模型 ID
- `max_tokens`: 最大输出 token
- `messages`: 消息列表
- `tools`: 使用 `@beta_tool` 装饰器定义的函数列表

## 最佳实践

- 使用 `@beta_tool` 装饰器 + 类型提示 + 文档字符串定义工具
- 异步客户端使用 `@beta_async_tool` + `async def`
- 适合简单的工具调用场景，复杂场景用手动循环

## 常见陷阱

- Tool Runner 不允许人工审批介入
- 不能自定义日志记录或条件执行逻辑
