# 工具使用故障排除 (Troubleshooting Tool Use)

> Source: https://platform.claude.com/docs/zh-CN/agents-and-tools/tool-use/troubleshooting-tool-use

## Claude 调用了错误的工具

| 症状 | 原因 | 解决方案 |
|------|------|----------|
| 希望调用 B 但调用了 A | 描述歧义 | 通过"何时"使用来区分工具 |
| 从不调用工具 | 名称冲突或 schema 过通用 | 检查重复名称，添加 `input_examples` |
| 错误参数类型 | schema 模糊 | 添加 `strict: true` 或 `input_examples` |

## Claude 虚构参数

| 症状 | 原因 | 解决方案 |
|------|------|----------|
| schema 中不存在的参数 | 未启用严格模式 | 添加 `strict: true` |
| 参数值超出枚举 | 缺少严格模式或枚举过大 | 缩小枚举或添加 `input_examples` |

## 并行工具调用不起作用

| 症状 | 原因 | 解决方案 |
|------|------|----------|
| Claude 按顺序调用 | 消息历史格式问题 | 在一条用户消息中发送多个 tool_result |
| disable_parallel_tool_use 被忽略 | 设置太晚 | 必须在返回 tool_use 的请求中设置 |

## 缓存持续失效

| 症状 | 原因 | 解决方案 |
|------|------|----------|
| 每次请求缓存未命中 | tool_choice 不一致 | 保持稳定或在变化点前放置断点 |
| 中途添加工具失效 | 添加到数组开头 | 使用 defer_loading + 工具搜索 |

## 请求时错误

| 错误 | 解决方案 |
|------|----------|
| `tool_use ids found without tool_result blocks` | 为每个 tool_use 返回 tool_result，放在文本前 |
| `Input schema not compatible with strict mode: patterns` | 移除 pattern 或去掉 strict: true |
| `All tools have defer_loading: true` | 至少一个工具必须立即加载 |

## thinking 块不能修改

将助手消息**原封不动**传回，然后追加 tool_result。不要修改 thinking/redacted_thinking 块。

## 工具结果被标记为提示注入

Claude 会将 tool_result 中的指令视为不可信内容。解决：
- 将指令移到 tool_result 之后的 user 轮次
- 或通过对话中途系统消息发送
- tool_result 中只保留数据

## JSON 转义差异（Opus 4.6+）

使用 `json.loads()` / `JSON.parse()` 解析。不要对序列化的输入进行原始字符串匹配。
