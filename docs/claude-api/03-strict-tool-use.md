# 严格工具使用 (Strict Tool Use)

> Source: https://platform.claude.com/docs/zh-CN/agents-and-tools/tool-use/strict-tool-use

## 核心概念

在工具定义中设置 `"strict": true` 通过**语法约束采样 (grammar-constrained sampling)**，保证 Claude 的工具输入严格符合 JSON Schema。

保证：
- 工具 `input` 严格遵循 `input_schema`
- 工具 `name` 始终有效

适用场景：
- 验证工具参数
- 构建智能体工作流
- 确保类型安全的函数调用
- 处理具有嵌套属性的复杂工具

## Python 代码示例

```python
client = anthropic.Anthropic()

response = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=1024,
    messages=[{"role": "user", "content": "What's the weather like in San Francisco?"}],
    tools=[
        {
            "name": "get_weather",
            "description": "Get the current weather in a given location",
            "strict": True,  # 启用严格模式
            "input_schema": {
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": "The city and state, e.g. San Francisco, CA",
                    },
                    "unit": {
                        "type": "string",
                        "enum": ["celsius", "fahrenheit"],
                        "description": "The unit of temperature",
                    },
                },
                "required": ["location"],
                "additionalProperties": False,  # 必须设为 False
            },
        }
    ],
)
```

## 关键 API 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `strict` | boolean | 顶级属性，与 name/description/input_schema 并列 |
| `additionalProperties` | boolean | 必须设为 `false` |

## 工作原理

1. 定义工具的 JSON Schema
2. 添加 `"strict": true`
3. Claude 调用工具时，`input` 严格遵循 schema

## 多工具智能体示例

```python
tools = [
    {
        "name": "search_flights",
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "origin": {"type": "string"},
                "destination": {"type": "string"},
                "departure_date": {"type": "string", "format": "date"},
                "travelers": {"type": "integer", "enum": [1, 2, 3, 4, 5, 6]},
            },
            "required": ["origin", "destination", "departure_date"],
            "additionalProperties": False,
        },
    },
    {
        "name": "search_hotels",
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "city": {"type": "string"},
                "check_in": {"type": "string", "format": "date"},
                "guests": {"type": "integer", "enum": [1, 2, 3, 4]},
            },
            "required": ["city", "check_in"],
            "additionalProperties": False,
        },
    },
]
```

## 最佳实践

- 始终设置 `additionalProperties: false`
- Schema 有支持的 JSON Schema 子集限制（不支持 `pattern`）
- 无 PHI 数据放入 schema 定义中（HIPAA 合规）

## 常见陷阱

- `pattern` 关键字不支持 — 报错 `string patterns are not supported`
- Schema 会被临时缓存最多 24 小时
- 不支持的 schema 特性会静默失败
