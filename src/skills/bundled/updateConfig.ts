import { toJSONSchema } from 'zod/v4'
import { SettingsSchema } from '../../utils/settings/types.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { registerBundledSkill } from '../bundledSkills.js'

/**
 * 从设置 Zod schema 生成 JSON Schema。
 * 这确保技能提示与实际类型保持同步。
 */
function generateSettingsSchema(): string {
  const jsonSchema = toJSONSchema(SettingsSchema(), { io: 'input' })
  return jsonStringify(jsonSchema, null, 2)
}

const SETTINGS_EXAMPLES_DOCS = `## 设置文件位置

根据作用域选择合适的文件：

| 文件 | 作用域 | Git | 用途 |
|------|-------|-----|---------|
| \`~/.hclaude/settings.json\` | 全局 | N/A | 所有项目的个人偏好 |
| \`.hclaude/settings.json\` | 项目 | 提交 | 团队共享的 hooks、权限、插件 |
| \`.hclaude/settings.local.json\` | 项目 | Gitignore | 此项目的个人覆盖 |

设置加载顺序：用户 → 项目 → 本地（后者覆盖前者）。

## 设置 Schema 参考

### Permissions
\`\`\`json
{
  "permissions": {
    "allow": ["Bash(npm:*)", "Edit(.hclaude)", "Read"],
    "deny": ["Bash(rm -rf:*)"],
    "ask": ["Write(/etc/*)"],
    "defaultMode": "default" | "plan" | "acceptEdits" | "dontAsk",
    "additionalDirectories": ["/extra/dir"]
  }
}
\`\`\`

**权限规则语法：**
- 精确匹配：\`"Bash(npm run test)"\`
- 前缀通配符：\`"Bash(git:*)"\` - 匹配 \`git status\`、\`git commit\` 等
- 仅工具名：\`"Read"\` - 允许所有 Read 操作

### 环境变量
\`\`\`json
{
  "env": {
    "DEBUG": "true",
    "MY_API_KEY": "value"
  }
}
\`\`\`

### 模型与代理
\`\`\`json
{
  "model": "sonnet",  // or "opus", "haiku", full model ID
  "agent": "agent-name",
  "alwaysThinkingEnabled": true
}
\`\`\`

### 归因（Commits & PRs）
\`\`\`json
{
  "attribution": {
    "commit": "Custom commit trailer text",
    "pr": "Custom PR description text"
  }
}
\`\`\`
将 \`commit\` 或 \`pr\` 设为空字符串 \`""\` 可隐藏该归因。

### MCP 服务器管理
\`\`\`json
{
  "enableAllProjectMcpServers": true,
  "enabledMcpjsonServers": ["server1", "server2"],
  "disabledMcpjsonServers": ["blocked-server"]
}
\`\`\`

### 插件
\`\`\`json
{
  "enabledPlugins": {
    "formatter@anthropic-tools": true
  }
}
\`\`\`
插件语法：\`plugin-name@source\`，其中 source 为 \`claude-code-marketplace\`、\`claude-plugins-official\` 或 \`builtin\`。

### 其他设置
- \`language\`：首选响应语言（如 "japanese"）
- \`cleanupPeriodDays\`：保留转录的天数（默认：30；0 完全禁用持久化）
- \`respectGitignore\`：是否遵守 .gitignore（默认：true）
- \`spinnerTipsEnabled\`：在加载动画中显示提示
- \`spinnerVerbs\`：自定义加载动画动词（\`{ "mode": "append" | "replace", "verbs": [...] }\`）
- \`spinnerTipsOverride\`：覆盖加载提示（\`{ "excludeDefault": true, "tips": ["Custom tip"] }\`）
- \`syntaxHighlightingDisabled\`：禁用 diff 高亮
`

// 注意：我们保留常见模式的手写示例，因为它们比自动生成的
// schema 文档更具可操作性。生成的 schema 列表提供完整性，
// 而示例提供清晰度。

const HOOKS_DOCS = `## Hooks 配置

Hooks 在 Claude Code 生命周期的特定时机运行命令。

### Hook 结构
\`\`\`json
{
  "hooks": {
    "EVENT_NAME": [
      {
        "matcher": "ToolName|OtherTool",
        "hooks": [
          {
            "type": "command",
            "command": "your-command-here",
            "timeout": 60,
            "statusMessage": "Running..."
          }
        ]
      }
    ]
  }
}
\`\`\`

### Hook 事件

| 事件 | Matcher | 用途 |
|-------|---------|---------|
| PermissionRequest | 工具名 | 在权限提示前运行 |
| PreToolUse | 工具名 | 在工具运行前执行，可阻止 |
| PostToolUse | 工具名 | 工具成功后运行 |
| PostToolUseFailure | 工具名 | 工具失败后运行 |
| Notification | 通知类型 | 在通知时运行 |
| Stop | - | Claude 停止时运行（包括 clear、resume、compact） |
| PreCompact | "manual"/"auto" | 压缩前 |
| PostCompact | "manual"/"auto" | 压缩后（接收摘要） |
| UserPromptSubmit | - | 用户提交时 |
| SessionStart | - | 会话开始时 |

**常用工具 matcher：** \`Bash\`、\`Write\`、\`Edit\`、\`Read\`、\`Glob\`、\`Grep\`

### Hook 类型

**1. Command Hook** - 运行 shell 命令：
\`\`\`json
{ "type": "command", "command": "prettier --write $FILE", "timeout": 30 }
\`\`\`

**2. Prompt Hook** - 用 LLM 评估条件：
\`\`\`json
{ "type": "prompt", "prompt": "Is this safe? $ARGUMENTS" }
\`\`\`
仅适用于工具事件：PreToolUse、PostToolUse、PermissionRequest。

**3. Agent Hook** - 运行带工具的代理：
\`\`\`json
{ "type": "agent", "prompt": "Verify tests pass: $ARGUMENTS" }
\`\`\`
仅适用于工具事件：PreToolUse、PostToolUse、PermissionRequest。

### Hook 输入（stdin JSON）
\`\`\`json
{
  "session_id": "abc123",
  "tool_name": "Write",
  "tool_input": { "file_path": "/path/to/file.txt", "content": "..." },
  "tool_response": { "success": true }  // PostToolUse only
}
\`\`\`

### Hook JSON 输出

Hooks 可以返回 JSON 来控制行为：

\`\`\`json
{
  "systemMessage": "Warning shown to user in UI",
  "continue": false,
  "stopReason": "Message shown when blocking",
  "suppressOutput": false,
  "decision": "block",
  "reason": "Explanation for decision",
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Context injected back to model"
  }
}
\`\`\`

**字段说明：**
- \`systemMessage\` - 向用户显示消息（所有 hooks）
- \`continue\` - 设为 \`false\` 以阻止/停止（默认：true）
- \`stopReason\` - \`continue\` 为 false 时显示的消息
- \`suppressOutput\` - 从转录中隐藏 stdout（默认：false）
- \`decision\` - PostToolUse/Stop/UserPromptSubmit hooks 时使用 "block"（PreToolUse 已废弃，改用 hookSpecificOutput.permissionDecision）
- \`reason\` - 决策说明
- \`hookSpecificOutput\` - 事件专用输出（必须包含 \`hookEventName\`）：
  - \`additionalContext\` - 注入模型上下文的文本
  - \`permissionDecision\` - "allow"、"deny" 或 "ask"（仅 PreToolUse）
  - \`permissionDecisionReason\` - 权限决策原因（仅 PreToolUse）
  - \`updatedInput\` - 修改后的工具输入（仅 PreToolUse）

### 常用模式

**写入后自动格式化：**
\`\`\`json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "jq -r '.tool_response.filePath // .tool_input.file_path' | { read -r f; prettier --write \\"$f\\"; } 2>/dev/null || true"
      }]
    }]
  }
}
\`\`\`

**记录所有 bash 命令：**
\`\`\`json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "jq -r '.tool_input.command' >> ~/.hclaude/bash-log.txt"
      }]
    }]
  }
}
\`\`\`

**Stop hook 向用户显示消息：**

命令必须输出包含 \`systemMessage\` 字段的 JSON：
\`\`\`bash
# Example command that outputs: {"systemMessage": "Session complete!"}
echo '{"systemMessage": "Session complete!"}'
\`\`\`

**代码变更后运行测试：**
\`\`\`json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "jq -r '.tool_input.file_path // .tool_response.filePath' | grep -E '\\\\.(ts|js)$' && npm test || true"
      }]
    }]
  }
}
\`\`\`
`

const HOOK_VERIFICATION_FLOW = `## 构建 Hook（含验证）

给定事件、matcher、目标文件和期望行为，按以下流程操作。每步捕获不同的失败类型——一个静默无作用的 hook 比没有 hook 更糟糕。

1. **去重检查。** 读取目标文件。若同一 event+matcher 上已存在 hook，显示现有命令并询问：保留、替换还是并列添加。

2. **为此项目构建命令——不要假设。** Hook 通过 stdin 接收 JSON。构建一个命令：
   - 安全提取所需 payload——使用 \`jq -r\` 到带引号的变量或 \`{ read -r f; ... "$f"; }\`，而**不是**不带引号的 \`| xargs\`（会按空格分割）
   - 以此项目的运行方式调用底层工具（npx/bunx/yarn/pnpm？Makefile 目标？全局安装？）
   - 跳过工具不处理的输入（格式化工具通常有 \`--ignore-unknown\`；若没有，按扩展名守护）
   - 现在保持**原始**——不加 \`|| true\`，不压制 stderr。管道测试通过后再包装。

3. **管道测试原始命令。** 合成 hook 将接收的 stdin payload 并直接管道输入：
   - \`Pre|PostToolUse\` on \`Write|Edit\`：\`echo '{"tool_name":"Edit","tool_input":{"file_path":"<a real file from this repo>"}}' | <cmd>\`
   - \`Pre|PostToolUse\` on \`Bash\`：\`echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | <cmd>\`
   - \`Stop\`/\`UserPromptSubmit\`/\`SessionStart\`：大多数命令不读取 stdin，\`echo '{}' | <cmd>\` 即可

   检查退出码**和**副作用（文件确实被格式化了，测试确实运行了）。若失败则得到真实错误——修复（包管理器错误？工具未安装？jq 路径错误？）并重测。一旦有效，用 \`2>/dev/null || true\` 包装（除非用户需要阻止性检查）。

4. **写入 JSON。** 合并到目标文件（schema 形状见上方"Hook 结构"章节）。若首次创建 \`.hclaude/settings.local.json\`，将其加入 .gitignore——Write 工具不会自动 gitignore 它。

5. **一次性验证语法 + schema：**

   \`jq -e '.hooks.<event>[] | select(.matcher == "<matcher>") | .hooks[] | select(.type == "command") | .command' <target-file>\`

   退出码 0 + 打印你的命令 = 正确。退出码 4 = matcher 不匹配。退出码 5 = JSON 格式错误或嵌套错误。损坏的 settings.json 会静默禁用该文件中的**所有**设置——同时修复任何预先存在的格式错误。

6. **证明 hook 触发**——仅对你能在本轮触发 matcher 的 \`Pre|PostToolUse\`（通过 Edit 触发 \`Write|Edit\`，通过 Bash 触发 \`Bash\`）。\`Stop\`/\`UserPromptSubmit\`/\`SessionStart\` 在本轮之外触发——跳到步骤 7。

   对于 \`PostToolUse\`/\`Write|Edit\` 上的**格式化工具**：通过 Edit 引入可检测的违规（连续两个空行、错误缩进、缺少分号——格式化工具会修正的内容；**不是**尾随空格，Edit 在写入前会自动删除），重新读取，确认 hook **已修复**。对于**其他任何情况**：在 settings.json 中临时为命令加上 \`echo "$(date) hook fired" >> /tmp/claude-hook-check.txt; \` 前缀，触发匹配工具（Edit 触发 \`Write|Edit\`，无害的 \`true\` 触发 \`Bash\`），读取哨兵文件。

   **务必清理**——无论证明是否通过，都要还原违规、去除哨兵前缀。

   **若证明失败但管道测试通过且 \`jq -e\` 通过**：设置监视器没有监视 \`.hclaude/\`——它只监视本次会话启动时已有设置文件的目录。Hook 写入正确。告诉用户打开一次 \`/hooks\`（重新加载配置）或重启——你自己无法这样做；\`/hooks\` 是用户 UI 菜单，打开它会结束本轮。

7. **移交。** 告诉用户 hook 已生效（或根据监视器注意事项需要 \`/hooks\`/重启）。引导他们使用 \`/hooks\` 来审查、编辑或之后禁用它。UI 只在 hook 报错或缓慢时显示"运行了 N 个 hooks"——静默成功在设计上是不可见的。
`

const UPDATE_CONFIG_PROMPT = `# 更新配置技能

通过更新 settings.json 文件修改 Claude Code 配置。

## 何时需要 Hooks（而非 Memory）

如果用户想让某事在响应**事件**时自动发生，他们需要在 settings.json 中配置 **hook**。Memory/preferences 无法触发自动化操作。

**这些场景需要 hooks：**
- "压缩前，问我要保留什么" → PreCompact hook
- "写入文件后，运行 prettier" → 带 Write|Edit matcher 的 PostToolUse hook
- "当我运行 bash 命令时，记录它们" → 带 Bash matcher 的 PreToolUse hook
- "代码变更后始终运行测试" → PostToolUse hook

**Hook 事件：** PreToolUse、PostToolUse、PreCompact、PostCompact、Stop、Notification、SessionStart

## 关键：写前先读

**修改前始终先读取现有设置文件。** 将新设置与现有设置合并——绝不替换整个文件。

## 关键：歧义时使用 AskUserQuestion

当用户请求有歧义时，使用 AskUserQuestion 澄清：
- 修改哪个设置文件（user/project/local）
- 是添加到现有数组还是替换
- 存在多个选项时的具体值

## 决策：Config 工具 vs 直接编辑

**使用 Config 工具**处理这些简单设置：
- \`theme\`、\`editorMode\`、\`verbose\`、\`model\`
- \`language\`、\`alwaysThinkingEnabled\`
- \`permissions.defaultMode\`

**直接编辑 settings.json**处理：
- Hooks（PreToolUse、PostToolUse 等）
- 复杂权限规则（allow/deny 数组）
- 环境变量
- MCP 服务器配置
- 插件配置

## 工作流

1. **澄清意图** - 请求有歧义时询问
2. **读取现有文件** - 对目标设置文件使用 Read 工具
3. **谨慎合并** - 保留现有设置，尤其是数组
4. **编辑文件** - 使用 Edit 工具（若文件不存在，先请用户创建）
5. **确认** - 告知用户发生了什么变化

## 合并数组（重要！）

向权限数组或 hook 数组添加时，**与现有内容合并**，而不是替换：

**错误做法**（替换了现有权限）：
\`\`\`json
{ "permissions": { "allow": ["Bash(npm:*)"] } }
\`\`\`

**正确做法**（保留现有 + 添加新的）：
\`\`\`json
{
  "permissions": {
    "allow": [
      "Bash(git:*)",      // existing
      "Edit(.hclaude)",    // existing
      "Bash(npm:*)"       // new
    ]
  }
}
\`\`\`

${SETTINGS_EXAMPLES_DOCS}

${HOOKS_DOCS}

${HOOK_VERIFICATION_FLOW}

## 示例工作流

### 添加 Hook

用户："Claude 写入代码后帮我格式化"

1. **澄清**：使用哪个格式化工具？（prettier、gofmt 等）
2. **读取**：\`.hclaude/settings.json\`（不存在则创建）
3. **合并**：添加到现有 hooks，不要替换
4. **结果**：
\`\`\`json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "jq -r '.tool_response.filePath // .tool_input.file_path' | { read -r f; prettier --write \\"$f\\"; } 2>/dev/null || true"
      }]
    }]
  }
}
\`\`\`

### 添加权限

用户："允许 npm 命令不再提示"

1. **读取**：现有权限
2. **合并**：将 \`Bash(npm:*)\` 添加到 allow 数组
3. **结果**：与现有 allow 合并

### 环境变量

用户："设置 DEBUG=true"

1. **决定**：用户设置（全局）还是项目设置？
2. **读取**：目标文件
3. **合并**：添加到 env 对象
\`\`\`json
{ "env": { "DEBUG": "true" } }
\`\`\`

## 常见错误

1. **替换而非合并** - 始终保留现有设置
2. **文件错误** - 作用域不明时询问用户
3. **JSON 无效** - 修改后验证语法
4. **忘记先读** - 始终先读再写

## 排查 Hooks 问题

若 hook 未运行：
1. **检查设置文件** - 读取 ~/.hclaude/settings.json 或 .hclaude/settings.json
2. **验证 JSON 语法** - 无效 JSON 会静默失败
3. **检查 matcher** - 是否匹配工具名？（如 "Bash"、"Write"、"Edit"）
4. **检查 hook 类型** - 是 "command"、"prompt" 还是 "agent"？
5. **测试命令** - 手动运行 hook 命令查看是否有效
6. **使用 --debug** - 运行 \`claude --debug\` 查看 hook 执行日志
`

export function registerUpdateConfigSkill(): void {
  registerBundledSkill({
    name: 'update-config',
    description:
      '使用此技能通过 settings.json 配置 Claude Code harness。自动化行为（"从现在起当 X"、"每次 X"、"每当 X"、"在 X 之前/之后"）需要在 settings.json 中配置 hooks——harness 执行这些，而非 Claude，因此 memory/preferences 无法满足。也用于：权限（"允许 X"、"添加权限"、"将权限移至"）、环境变量（"设置 X=Y"）、hook 故障排查，或对 settings.json/settings.local.json 文件的任何修改。示例："允许 npm 命令"、"将 bq 权限添加到全局设置"、"将权限移至用户设置"、"设置 DEBUG=true"、"当 claude 停止时显示 X"。对于主题/模型等简单设置，使用 Config 工具。',
    allowedTools: ['Read'],
    userInvocable: true,
    async getPromptForCommand(args) {
      if (args.startsWith('[hooks-only]')) {
        const req = args.slice('[hooks-only]'.length).trim()
        let prompt = HOOKS_DOCS + '\n\n' + HOOK_VERIFICATION_FLOW
        if (req) {
          prompt += `\n\n## 任务\n\n${req}`
        }
        return [{ type: 'text', text: prompt }]
      }

      // 动态生成 schema 以与类型保持同步
      const jsonSchema = generateSettingsSchema()

      let prompt = UPDATE_CONFIG_PROMPT
      prompt += `\n\n## 完整设置 JSON Schema\n\n\`\`\`json\n${jsonSchema}\n\`\`\``

      if (args) {
        prompt += `\n\n## 用户请求\n\n${args}`
      }

      return [{ type: 'text', text: prompt }]
    },
  })
}
