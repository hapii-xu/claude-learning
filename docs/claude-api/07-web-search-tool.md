# 网络搜索工具 (Web Search Tool)

> Source: https://platform.claude.com/docs/zh-CN/agents-and-tools/tool-use/web-search-tool

## 核心概念

使 Claude 能够访问实时网络内容，响应包含来源引用。

版本演进：
- `web_search_20250305` — 基础搜索
- `web_search_20260209` — 动态过滤
- `web_search_20260318` — 动态过滤 + response_inclusion

## 工作原理

1. Claude 根据提示决定何时搜索
2. API 执行搜索并提供结果
3. Claude 提供带引用来源的最终响应

**Claude 何时搜索**：近期事件、价格、统计数据、明确要求搜索的请求
**Claude 何时不搜索**：既定事实、创意写作、对话回复

## 动态过滤

Claude 编写并执行代码对搜索结果后处理，仅保留相关内容。需要代码执行工具。

```python
response = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=4096,
    messages=[{"role": "user", "content": "Search AAPL and GOOGL P/E ratios"}],
    tools=[{"type": "web_search_20260209", "name": "web_search"}],
)
```

## 工具定义

```json
{
  "type": "web_search_20250305",
  "name": "web_search",
  "max_uses": 5,
  "allowed_domains": ["example.com"],
  "blocked_domains": ["untrusted.com"],
  "user_location": {
    "type": "approximate",
    "city": "San Francisco",
    "region": "California",
    "country": "US",
    "timezone": "America/Los_Angeles"
  }
}
```

## 响应结构

```json
{
  "content": [
    {"type": "text", "text": "I'll search for..."},
    {"type": "server_tool_use", "id": "srvtoolu_xxx", "name": "web_search", "input": {"query": "..."}},
    {"type": "web_search_tool_result", "tool_use_id": "srvtoolu_xxx", "content": [
      {"type": "web_search_result", "url": "...", "title": "...", "encrypted_content": "...", "page_age": "..."}
    ]},
    {"type": "text", "text": "...", "citations": [
      {"type": "web_search_result_location", "url": "...", "title": "...", "encrypted_index": "...", "cited_text": "..."}
    ]}
  ]
}
```

## 错误代码

- `too_many_requests` — 速率限制
- `invalid_input` — 查询参数无效
- `max_uses_exceeded` — 超出搜索次数
- `query_too_long` — 查询过长
- `unavailable` — 内部错误

## 定价

**每 1,000 次搜索 $10** + 标准令牌费用。

## 最佳实践

- 事实性查询 `max_uses: 3`
- 研究型智能体 `max_uses: 15-20`
- 引用字段不计入令牌使用量
- 必须包含指向原始来源的引用
- 域名过滤使用 `allowed_domains` / `blocked_domains`

## response_inclusion（20260318+）

```json
{
  "type": "web_search_20260318",
  "name": "web_search",
  "response_inclusion": "excluded"  // 从响应中移除已消费的搜索结果块
}
```
