# 顾问工具 (Advisor Tool)

> Source: https://platform.claude.com/docs/zh-CN/agents-and-tools/tool-use/advisor-tool

## 核心概念

将快速便宜的**执行器模型**与更智能的**顾问模型**配对。顾问读取完整对话，生成计划/纠正方案（400-700 文本令牌），执行器继续。

Beta 标头：`advisor-tool-2026-03-01`

适用场景：长周期智能体（编码、计算机使用、多步骤研究）。

## 模型配对

| 执行器 | 顾问 |
|--------|------|
| Haiku 4.5 | Opus 4.8, Opus 4.7 |
| Sonnet 4.6 | Opus 4.8, Opus 4.7 |
| Opus 4.6/4.7 | Opus 4.8, Opus 4.7 |
| Opus 4.8 | Opus 4.8 |
| Fable 5 | Fable 5 |
| Mythos 5 | Mythos 5 |

## Python 示例

```python
response = client.beta.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=4096,
    betas=["advisor-tool-2026-03-01"],
    tools=[{
        "type": "advisor_20260301",
        "name": "advisor",
        "model": "claude-opus-4-8",
    }],
    messages=[{"role": "user", "content": "Build a concurrent worker pool in Go..."}],
)
```

## 工具参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `type` | string | `"advisor_20260301"` |
| `name` | string | `"advisor"` |
| `model` | string | 顾问模型 ID |
| `max_uses` | int | 每个请求最大顾问调用次数 |
| `max_tokens` | int | 每次调用输出上限（min 1024） |
| `caching` | object | `{"type": "ephemeral", "ttl": "5m"/"1h"}` |

## 工作原理

1. 执行器发出 `server_tool_use` 块（name: "advisor", input 为空）
2. 服务器对顾问模型运行单独推理，传入完整对话记录
3. 顾问响应作为 `advisor_tool_result` 返回
4. 执行器根据建议继续

全部在单个 `/v1/messages` 请求内完成。

## 响应结构

```json
{
  "type": "advisor_tool_result",
  "tool_use_id": "srvtoolu_abc123",
  "content": {
    "type": "advisor_result",
    "text": "Use a channel-based coordination pattern...",
    "stop_reason": "end_turn"
  }
}
```

## 计费

顾问令牌按顾问模型费率计费。顶层 `usage` 仅反映执行器令牌。

```json
{
  "usage": {
    "input_tokens": 412,
    "output_tokens": 531,
    "iterations": [
      {"type": "message", ...},
      {"type": "advisor_message", "model": "claude-opus-4-8", ...},
      {"type": "message", ...}
    ]
  }
}
```

## 最佳实践

### 提示编写

时机指导（系统提示中）：
- 在实质性工作前调用顾问
- 任务完成时调用
- 遇到困难时调用
- 改变方向时调用

### 缩减输出

用户消息中添加：
```
(Advisor: please keep your guidance under 80 words — I need a focused starting point, not a comprehensive plan.)
```

### 限制输出（硬上限）

```python
tools = [{
    "type": "advisor_20260301",
    "name": "advisor",
    "model": "claude-opus-4-8",
    "max_tokens": 2048,  # 推荐起点
}]
```

| max_tokens | 平均输出 | 截断率 |
|-----------|----------|--------|
| 未设置 | 4,200-5,900 | N/A |
| 2048 | 630-840 | ~0% |
| 1024 | 370-480 | ~10% |

### 成本控制

- 客户端计数顾问调用
- 达上限时移除工具并清除 advisor_tool_result 块
- 3+ 次调用才启用 caching

## 常见陷阱

- 顾问输出不流式传输
- 无内置对话级调用上限
- 顶层 max_tokens 不限制顾问
- clear_thinking 的 keep 非 "all" 会导致顾问缓存未命中
- Haiku 执行器可能需要提醒才能调用顾问
