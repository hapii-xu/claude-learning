import { isAutoMemoryEnabled } from '../../memdir/paths.js'
import { registerBundledSkill } from '../bundledSkills.js'

export function registerRememberSkill(): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  const SKILL_PROMPT = `# 记忆审查

## 目标
审查用户的记忆层次，生成按操作类型分组的变更提案报告。请**不要**直接应用变更——将提案呈现给用户审批。

## 步骤

### 1. 收集所有记忆层
从项目根目录读取 CLAUDE.md 和 CLAUDE.local.md（如果存在）。你的 auto-memory 内容已在系统提示中——在那里审查。注意存在哪些团队记忆（team memory）章节（如有）。

**完成标准**：已获取所有记忆层的内容，可以进行比较。

### 2. 分类每条 auto-memory 条目
对 auto-memory 中的每条实质性条目，确定最佳目标位置：

| 目标位置 | 适合放置的内容 | 示例 |
|---|---|---|
| **CLAUDE.md** | 所有贡献者都应遵循的项目规范和 Claude 指令 | "使用 bun 而非 npm"、"API 路由使用 kebab-case"、"测试命令为 bun test"、"优先使用函数式风格" |
| **CLAUDE.local.md** | 特定于当前用户的个人 Claude 指令，不适用于其他贡献者 | "我偏好简洁的回复"、"总是解释权衡取舍"、"不要自动提交"、"提交前运行测试" |
| **Team memory** | 适用于多个仓库的组织级知识（仅在配置了团队记忆时） | "部署 PR 走 #deploy-queue"、"staging 在 staging.internal"、"平台团队负责基础设施" |
| **保留在 auto-memory** | 工作笔记、临时上下文或明显不适合其他位置的条目 | 会话特定的观察、不确定的模式 |

**重要区分：**
- CLAUDE.md 和 CLAUDE.local.md 包含对 Claude 的指令，而非用户对外部工具的偏好（编辑器主题、IDE 快捷键等不属于这两个文件）
- 工作流实践（PR 规范、合并策略、分支命名）存在歧义——询问用户这是个人偏好还是团队规范
- 不确定时，询问而非猜测

**完成标准**：每条条目都有提议的目标位置，或被标记为存在歧义。

### 3. 识别清理机会
扫描所有层，查找：
- **重复**：已在 CLAUDE.md 或 CLAUDE.local.md 中捕获的 auto-memory 条目 → 提议从 auto-memory 中删除
- **过时**：被较新的 auto-memory 条目矛盾的 CLAUDE.md 或 CLAUDE.local.md 条目 → 提议更新较旧的层
- **冲突**：任意两层之间的矛盾 → 提议解决方案，注明哪个更新

**完成标准**：识别出所有跨层问题。

### 4. 呈现报告
按操作类型分组输出结构化报告：
1. **提升（Promotions）** — 需要迁移的条目，包含目标位置和理由
2. **清理（Cleanup）** — 重复、过时的条目及需要解决的冲突
3. **存在歧义（Ambiguous）** — 需要用户输入目标位置的条目
4. **无需操作（No action needed）** — 对应保留原位的条目的简短说明

如果 auto-memory 为空，请说明并提议审查 CLAUDE.md 以进行清理。

**完成标准**：用户可以逐一审查并批准/拒绝每项提案。

## 规则
- 在做任何变更之前，先呈现**所有**提案
- 未经用户明确批准，**不得**修改文件
- 除非目标文件不存在，否则**不得**创建新文件
- 对有歧义的条目，询问而非猜测
`

  registerBundledSkill({
    name: 'remember',
    description:
      '审查 auto-memory 条目，提议将其提升到 CLAUDE.md、CLAUDE.local.md 或共享记忆。同时检测各记忆层之间的过时、冲突和重复条目。',
    whenToUse:
      '当用户希望审查、整理或提升其 auto-memory 条目时使用。也适用于清理 CLAUDE.md、CLAUDE.local.md 和 auto-memory 之间的过时或冲突条目。',
    userInvocable: true,
    isEnabled: () => isAutoMemoryEnabled(),
    async getPromptForCommand(args) {
      let prompt = SKILL_PROMPT

      if (args) {
        prompt += `\n## 用户补充说明\n\n${args}`
      }

      return [{ type: 'text', text: prompt }]
    },
  })
}
