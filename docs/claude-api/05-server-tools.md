# 服务器工具 (Server Tools)

> Source: https://platform.claude.com/docs/zh-CN/agents-and-tools/tool-use/server-tools

## 核心概念

服务器端执行的工具（网络搜索、网页抓取、代码执行等）由 Anthropic 内部运行，不需要客户端处理。

## server_tool_use 块

```json
{
  "type": "server_tool_use",
  "id": "srvtoolu_01A2B3C4D5E6F7G8H9",  // srvtoolu_ 前缀
  "name": "web_search",
  "input": { "query": "latest quantum computing breakthroughs" }
}
```

- 不需要 `tool_result` 回应
- 结果块在同一助手回合中紧随其后

## pause_turn 续接

API 返回 `stop_reason: "pause_turn"` 表示暂停长时间运行的回合：

```python
response = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=1024,
    messages=[{"role": "user", "content": "..."}],
    tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 10}],
)

if response.stop_reason == "pause_turn":
    messages = [
        {"role": "user", "content": "..."},
        {"role": "assistant", "content": response.content},
    ]
    continuation = client.messages.create(
        model="claude-opus-4-8",
        max_tokens=1024,
        messages=messages,
        tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 10}],
    )
```

## ZDR 与 allowed_callers

`_20260209` 及更高版本默认不符合 ZDR。要符合 ZDR，设置：
```json
{
  "type": "web_search_20260209",
  "name": "web_search",
  "allowed_callers": ["direct"]  // 禁用动态过滤
}
```

## 域名过滤

```json
{
  "allowed_domains": ["example.com", "trusteddomain.org"],
  "blocked_domains": ["untrustedsource.com"]
}
```

规则：
- 不包含 HTTP/HTTPS 协议
- 子域名自动包含
- 支持子路径匹配
- 支持通配符 `*`（仅路径部分）
- `allowed_domains` 和 `blocked_domains` 不能同时使用

## 最佳实践

- 将暂停响应原样传回后续请求
- 按需修改内容可中断/重定向对话
- 续接请求中包含相同工具
- 注意同形异义字攻击（Unicode 字符安全风险）

## 常见陷阱

- 独立 `code_execution` 工具与 `_20260209` 网络工具共存会创建两个执行环境
- 无效域名格式返回 `invalid_tool_input` 错误
- 请求级域名只能进一步限制组织级列表
