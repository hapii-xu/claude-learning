# Bash 工具

> Source: https://platform.claude.com/docs/zh-CN/agents-and-tools/tool-use/bash-tool

## 核心概念

在持久化 bash 会话中执行 shell 命令。会话在命令间保持状态（环境变量、工作目录）。

无模式工具：输入模式内置于模型中，无法修改。

## 工具定义

```json
{"type": "bash_20250124", "name": "bash"}
```

## 参数

| 参数 | 必需 | 说明 |
|------|------|------|
| `command` | 是* | 要运行的 bash 命令 |
| `restart` | 否 | 设为 true 重启会话 |

*除非使用 restart

## Python 示例

```python
response = client.messages.create(
    model="claude-opus-4-8",
    max_tokens=1024,
    tools=[{"type": "bash_20250124", "name": "bash"}],
    messages=[{"role": "user", "content": "List all Python files."}],
)
```

## 实现要点

### 持久化会话

```python
class BashSession:
    def __init__(self):
        self.process = subprocess.Popen(
            ["/bin/bash"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=0,
        )
```

### 安全实现

```python
ALLOWED_COMMANDS = {"ls", "cat", "echo", "pwd", "grep", "find", "wc", "head", "tail"}
SHELL_OPERATORS = {"&&", "||", "|", ";", "&", ">", "<", ">>"}

def validate_command(command):
    tokens = shlex.split(command)
    if not tokens or tokens[0] not in ALLOWED_COMMANDS:
        return False, "Command not in allowlist"
    for token in tokens[1:]:
        if token in SHELL_OPERATORS or token.startswith(("$", "`")):
            return False, f"Shell operator '{token}' not allowed"
    return True, None
```

### 超时处理

```python
def execute_with_timeout(command, timeout=30):
    try:
        result = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=timeout)
        return result.stdout + result.stderr
    except subprocess.TimeoutExpired:
        return f"Command timed out after {timeout} seconds"
```

### 输出截断

```python
def truncate_output(output, max_lines=100):
    lines = output.split("\n")
    if len(lines) > max_lines:
        truncated = "\n".join(lines[:max_lines])
        return f"{truncated}\n\n... Output truncated ({len(lines)} total lines) ..."
    return output
```

## 多步骤示例

```
1. {"command": "pip install requests"}
2. {"command": "cat > fetch_joke.py << 'EOF'\nimport requests\n..."}
3. {"command": "python fetch_joke.py"}
```

会话在命令间保持状态。

## 安全最佳实践

- **隔离环境**：Docker/VM 中运行
- **命令允许列表**：非阻止列表
- **资源限制**：ulimit 设置 CPU/内存/磁盘
- **审计日志**：记录所有命令
- **最小权限**：非 root 用户
- **输出清理**：移除密钥/凭证

## 常见模式

- **开发**：`pytest && coverage report`, `git status && git add .`
- **文件**：`wc -l *.csv`, `find . -name "*.py" | xargs grep "pattern"`
- **系统**：`df -h && free -m`, `ps aux | grep python`
- **Git 检查点**：提交基线、按功能提交、失败时回退

## 定价

增加 **245 个输入令牌** + 命令输出令牌。

## 限制

- 不支持交互式命令（vim, less）
- 不支持 GUI 应用
- 会话状态由客户端维护
- 输出可能截断
- 不支持流式传输
