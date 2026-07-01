# 网页抓取工具 (Web Fetch Tool)

> Source: https://platform.claude.com/docs/zh-CN/agents-and-tools/tool-use/web-fetch-tool

## 核心概念

从指定 URL 检索完整内容（网页 + PDF），支持引用。

版本演进：
- `web_fetch_20250910` — 基础抓取
- `web_fetch_20260209` — 动态过滤
- `web_fetch_20260309` — 动态过滤 + 缓存绕过
- `web_fetch_20260318` — 动态过滤 + 缓存绕过 + response_inclusion

## 工作原理

1. Claude 决定何时抓取
2. API 从 URL 检索文本内容
3. PDF 自动提取文本
4. Claude 分析内容并响应

**Claude 何时抓取**：有 URL、指定特定资源
**Claude 何时不抓取**：常识性问题、开放式问题

## 工具定义

```json
{
  "type": "web_fetch_20250910",
  "name": "web_fetch",
  "max_uses": 10,
  "allowed_domains": ["example.com"],
  "blocked_domains": ["private.com"],
  "citations": {"enabled": true},
  "max_content_tokens": 100000
}
```

## Python 示例

```python
response = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Analyze https://example.com/article"}],
    tools=[{"type": "web_fetch_20250910", "name": "web_fetch", "max_uses": 5}],
)
```

## 组合搜索和抓取

```python
tools = [
    {"type": "web_search_20250305", "name": "web_search", "max_uses": 3},
    {"type": "web_fetch_20250910", "name": "web_fetch", "max_uses": 5, "citations": {"enabled": True}},
]
```

工作流：搜索 → 选择结果 → 抓取完整内容 → 详细分析

## URL 验证

只能抓取对话上下文中出现过的 URL：
- 用户消息中的 URL
- 客户端工具结果中的 URL
- 之前搜索/抓取结果的 URL

不能抓取 Claude 生成的任意 URL 或容器内服务器的 URL。

## 缓存绕过（20260309+）

```json
{
  "type": "web_fetch_20260309",
  "name": "web_fetch",
  "use_cache": false  // 绕过缓存获取最新内容，默认 true
}
```

## 错误代码

- `invalid_input` — URL 格式无效
- `url_too_long` — 超过 250 字符
- `url_not_allowed` — 域名过滤阻止
- `url_not_accessible` — HTTP 错误
- `too_many_requests` — 速率限制
- `unsupported_content_type` — 仅支持文本和 PDF
- `max_uses_exceeded` — 超出次数

## 定价

**无额外费用**！只付标准令牌费用。

典型令牌使用量：
- 普通网页 (10KB) ≈ 2,500 tokens
- 大型文档 (100KB) ≈ 25,000 tokens
- 研究论文 PDF (500KB) ≈ 125,000 tokens

## 最佳实践

- 使用 `max_content_tokens` 控制令牌成本
- 不支持 JavaScript 动态渲染的网站
- 数据泄露风险：仅受信环境使用
- 使用 `allowed_domains` 限制为安全域名
