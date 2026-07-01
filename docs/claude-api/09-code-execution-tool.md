# 代码执行工具 (Code Execution Tool)

> Source: https://platform.claude.com/docs/zh-CN/agents-and-tools/tool-use/code-execution-tool

## 核心概念

在安全沙盒容器中运行 Bash 命令和文件操作。支持 Python、Bash、文件创建/编辑。

**当与网络搜索/抓取一起使用时免费！**

版本：
- `code_execution_20250825` — Bash + 文件操作
- `code_execution_20260120` — + REPL 状态持久化 + 编程式工具调用
- `code_execution_20260521` — + 每单元格 90 秒时间限制

## 工具定义

```json
{
  "type": "code_execution_20250825",
  "name": "code_execution"
}
```

自动获得两个子工具：
- `bash_code_execution` — 运行 shell 命令
- `text_editor_code_execution` — 文件操作

## Python 示例

```python
response = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=4096,
    messages=[{"role": "user", "content": "Calculate mean and std of [1,2,3,4,5,6,7,8,9,10]"}],
    tools=[{"type": "code_execution_20250825", "name": "code_execution"}],
)
```

## 文件上传与分析

```python
# 上传文件
file_object = client.beta.files.upload(file=open("data.csv", "rb"))

# 使用代码执行分析
response = client.beta.messages.create(
    model="claude-opus-4-8",
    betas=["files-api-2025-04-14"],
    max_tokens=4096,
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "Analyze this CSV data"},
            {"type": "container_upload", "file_id": file_object.id},
        ],
    }],
    tools=[{"type": "code_execution_20250825", "name": "code_execution"}],
)
```

## 容器复用

```python
# 第一次请求
response1 = client.messages.create(...)
container_id = response1.container.id

# 复用容器
response2 = client.messages.create(
    container=container_id,  # 复用同一容器
    ...
)
```

## 容器环境

| 资源 | 限制 |
|------|------|
| Python | 3.11.12 |
| OS | Linux x86_64 |
| RAM | 5GiB |
| 磁盘 | 5GiB |
| CPU | 1 |
| 网络 | 完全禁用 |
| 过期 | 30 天 |

### 预装库

pandas, numpy, scipy, scikit-learn, matplotlib, seaborn, pyarrow, openpyxl, pillow, sympy, mpmath 等

## 响应格式

```json
{
  "type": "bash_code_execution_tool_result",
  "tool_use_id": "srvtoolu_xxx",
  "content": {
    "type": "bash_code_execution_result",
    "stdout": "...",
    "stderr": "",
    "return_code": 0
  }
}
```

## 错误代码

| 工具 | 错误代码 | 描述 |
|------|----------|------|
| 所有 | `unavailable` | 工具不可用 |
| 所有 | `execution_time_exceeded` | 超时 |
| 所有 | `container_expired` | 容器过期 |
| bash | `output_file_too_large` | 输出过大 |
| text_editor | `file_not_found` | 文件不存在 |
| text_editor | `string_not_found` | old_str 未找到 |

## 最佳实践

- 使用 `container` 参数复用容器保持文件状态
- 与 web_search 一起使用时免费
- 不符合 ZDR 条件
- 使用 Files API 上传/下载文件
- 多执行环境时明确提示 Claude 区分

## 常见陷阱

- 独立的 code_execution 与 _20260209 网络工具共存会创建两个执行环境
- 容器 30 天过期
- 包含文件时即使未调用工具也计费（预加载）
