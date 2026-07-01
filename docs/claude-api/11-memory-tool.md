# 记忆工具 (Memory Tool)

> Source: https://platform.claude.com/docs/zh-CN/agents-and-tools/tool-use/memory-tool

## 核心概念

通过 `/memories` 目录跨对话存储和检索信息。Claude 创建、读取、更新和删除持久化文件。

即时上下文检索的关键原语：按需调取相关信息，保持活跃上下文聚焦。

客户端工具：通过自己的基础设施控制存储位置和方式。

## 使用场景

- 多次执行间维护项目上下文
- 从过去交互中学习
- 构建知识库
- 跨对话学习

## 工具命令

### view — 查看目录/文件

```json
{"command": "view", "path": "/memories", "view_range": [1, 10]}
```

目录返回 2 层深度的文件列表；文件返回带行号的内容。

### create — 创建文件

```json
{"command": "create", "path": "/memories/notes.txt", "file_text": "Meeting notes..."}
```

### str_replace — 替换文本

```json
{"command": "str_replace", "path": "/memories/prefs.txt", "old_str": "blue", "new_str": "green"}
```

### insert — 插入文本

```json
{"command": "insert", "path": "/memories/todo.txt", "insert_line": 2, "insert_text": "- New task\n"}
```

### delete — 删除

```json
{"command": "delete", "path": "/memories/old_file.txt"}
```

### rename — 重命名

```json
{"command": "rename", "old_path": "/memories/draft.txt", "new_path": "/memories/final.txt"}
```

## Python 示例

```python
message = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=2048,
    messages=[{"role": "user", "content": "Help me debug this code..."}],
    tools=[{"type": "memory_20250818", "name": "memory"}],
)
```

## 提示指导（自动包含）

```
IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE.
MEMORY PROTOCOL:
1. Use the view command to check for earlier progress.
2. As you make progress, record status/thoughts in memory.
ASSUME INTERRUPTION: Context window might reset at any moment.
```

## 安全注意事项

### 路径遍历防护

- 验证所有路径以 `/memories` 开头
- 解析规范路径并验证位于记忆目录内
- 拒绝 `../`、`..\\` 等遍历序列
- 注意 URL 编码遍历（`%2e%2e%2f`）
- 使用 `pathlib.Path.resolve()` + `relative_to()`

### 其他安全

- 敏感信息：实现更严格验证
- 文件大小：防止过大，设置字符上限
- 记忆过期：定期清理

## 多会话开发模式

1. **初始化会话**：设置进度日志、功能清单、启动脚本
2. **后续会话**：读取记忆工件恢复状态
3. **会话结束**：更新进度日志

关键原则：一次只处理一个功能，端到端验证后才标记完成。

## 最佳实践

- 与压缩功能配合使用
- 与上下文编辑配合使用
- 引导 Claude 只记录特定主题的信息
- 保持记忆文件最新、连贯且有条理
- 按需实现自定义后端（文件/数据库/云存储/加密）
