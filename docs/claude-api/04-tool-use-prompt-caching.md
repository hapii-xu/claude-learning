# 工具使用与提示缓存 (Tool Use with Prompt Caching)

> Source: https://platform.claude.com/docs/zh-CN/agents-and-tools/tool-use/tool-use-with-prompt-caching

## 核心概念

在 `tools` 数组中的最后一个工具上放置 `cache_control: {"type": "ephemeral"}`，缓存整个工具定义前缀。

## 缓存断点放置

```json
{
  "tools": [
    { "name": "get_weather", "input_schema": {...} },
    { 
      "name": "get_time", 
      "input_schema": {...},
      "cache_control": { "type": "ephemeral" }  // 放在最后一个工具上
    }
  ]
}
```

对于 `mcp_toolset`，将断点放在 toolset 条目本身。

## defer_loading 与缓存保留

延迟加载的工具不包含在系统提示前缀中。通过工具搜索发现时，定义作为 `tool_reference` 块内联附加，**前缀保持不变，缓存得以保留**。

## 缓存失效表

| 更改 | 失效范围 |
|------|----------|
| 修改工具定义 | 整个缓存（tools + system + messages） |
| 切换网络搜索/引用 | system + messages |
| 更改 `tool_choice` | messages |
| 更改 `disable_parallel_tool_use` | messages |
| 切换图片存在/不存在 | messages |
| 更改思考参数 | messages |

## 服务器工具结果自动缓存

启用提示缓存时，API 自动在服务器工具结果上放置缓存断点（5 分钟 TTL），显示在 `cache_creation.ephemeral_5m_input_tokens`。

## 各工具缓存交互

| 工具 | 缓存注意事项 |
|------|------------|
| 网络搜索 | 启用/禁用使 system+messages 缓存失效 |
| 网页抓取 | 启用/禁用使 system+messages 缓存失效 |
| 代码执行 | 容器状态独立于提示缓存 |
| 工具搜索 | 发现的工具作为 tool_reference 加载，保留前缀缓存 |
| 计算机使用 | 截图影响 messages 缓存 |
| Bash/内存/文本编辑器 | 标准客户端工具，无特殊缓存交互 |

## 最佳实践

- 将 `cache_control` 放在 tools 数组最后一个工具
- 使用 `defer_loading` + 工具搜索动态添加工具不破坏缓存
- 如需中途更改 `tool_choice`，在变化点前放置缓存断点
- 服务器工具结果自动缓存（5分钟 TTL）
