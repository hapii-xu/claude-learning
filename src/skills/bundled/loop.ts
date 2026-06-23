import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  DEFAULT_MAX_AGE_DAYS,
  isKairosCronEnabled,
} from '@claude-code-best/builtin-tools/tools/ScheduleCronTool/prompt.js'
import { registerBundledSkill } from '../bundledSkills.js'

const DEFAULT_INTERVAL = '10m'

const USAGE_MESSAGE = `用法：/loop [interval] <prompt>

以固定间隔重复执行提示词或斜杠命令。

间隔格式：Ns、Nm、Nh、Nd（如 5m、30m、2h、1d）。最小粒度为 1 分钟。
如果未指定间隔，默认为 ${DEFAULT_INTERVAL}。

示例：
  /loop 5m /babysit-prs
  /loop 30m check the deploy
  /loop 1h /standup 1
  /loop check the deploy          （默认 ${DEFAULT_INTERVAL}）
  /loop check the deploy every 20m`

function buildPrompt(args: string): string {
  return `# /loop — 调度循环提示词

将以下输入解析为 \`[interval] <prompt…>\` 并通过 ${CRON_CREATE_TOOL_NAME} 调度。

## 解析规则（按优先级）

1. **前置 token**：如果第一个空格分隔的 token 匹配 \`^\\d+[smhd]$\`（如 \`5m\`、\`2h\`），则其为间隔；其余部分为提示词。
2. **尾部 "every" 子句**：否则，如果输入以 \`every <N><unit>\` 或 \`every <N> <unit-word>\` 结尾（如 \`every 20m\`、\`every 5 minutes\`、\`every 2 hours\`），则提取为间隔并从提示词中去除。仅在 "every" 后跟时间表达式时匹配——\`check every PR\` 没有间隔。
3. **默认**：否则，间隔为 \`${DEFAULT_INTERVAL}\`，整个输入为提示词。

如果解析出的提示词为空，显示用法 \`/loop [interval] <prompt>\` 并停止——不要调用 ${CRON_CREATE_TOOL_NAME}。

示例：
- \`5m /babysit-prs\` → 间隔 \`5m\`，提示词 \`/babysit-prs\`（规则 1）
- \`check the deploy every 20m\` → 间隔 \`20m\`，提示词 \`check the deploy\`（规则 2）
- \`run tests every 5 minutes\` → 间隔 \`5m\`，提示词 \`run tests\`（规则 2）
- \`check the deploy\` → 间隔 \`${DEFAULT_INTERVAL}\`，提示词 \`check the deploy\`（规则 3）
- \`check every PR\` → 间隔 \`${DEFAULT_INTERVAL}\`，提示词 \`check every PR\`（规则 3——"every" 后未跟时间）
- \`5m\` → 提示词为空 → 显示用法

## 间隔 → cron

支持的后缀：\`s\`（秒，向上取整到最近分钟，最小 1）、\`m\`（分钟）、\`h\`（小时）、\`d\`（天）。转换规则：

| 间隔模式              | Cron 表达式         | 说明                                     |
|-----------------------|---------------------|------------------------------------------|
| \`Nm\`（N ≤ 59）     | \`*/N * * * *\`     | 每 N 分钟                                |
| \`Nm\`（N ≥ 60）     | \`0 */H * * *\`     | 取整为小时（H = N/60，须能整除 24）      |
| \`Nh\`（N ≤ 23）     | \`0 */N * * *\`     | 每 N 小时                                |
| \`Nd\`               | \`0 0 */N * *\`     | 每 N 天午夜                              |
| \`Ns\`               | 视为 \`ceil(N/60)m\` | cron 最小粒度为 1 分钟                  |

**如果间隔无法整除其单位**（如 \`7m\` → \`*/7 * * * *\` 在 :56→:00 处有不均匀间隔；\`90m\` → 1.5 小时，cron 无法表达），请选择最近的整洁间隔，并在调度前告知用户已取整为何值。

## 操作

1. 调用 ${CRON_CREATE_TOOL_NAME}，传入：
   - \`cron\`：上方表格中的表达式
   - \`prompt\`：上方解析出的提示词，原文传入（斜杠命令原样传递）
   - \`recurring\`：\`true\`
2. 简要确认：已调度的内容、cron 表达式、人类可读的频率说明、循环任务在 ${DEFAULT_MAX_AGE_DAYS} 天后自动过期，以及可使用 ${CRON_DELETE_TOOL_NAME} 提前取消（包含任务 ID）。
3. **然后立即执行解析出的提示词** — 不要等待第一次 cron 触发。如果是斜杠命令，通过 Skill 工具调用；否则直接执行。

## 输入

${args}`
}

export function registerLoopSkill(): void {
  registerBundledSkill({
    name: 'loop',
    description:
      '以固定间隔重复执行提示词或斜杠命令（如 /loop 5m /foo，默认 10m）',
    whenToUse:
      '当用户想设置循环任务、轮询状态或按间隔重复执行某操作时使用（如"每 5 分钟检查部署状态"、"持续运行 /babysit-prs"）。不要为一次性任务调用。',
    argumentHint: '[interval] <prompt>',
    userInvocable: true,
    isEnabled: isKairosCronEnabled,
    async getPromptForCommand(args) {
      const trimmed = args.trim()
      if (!trimmed) {
        return [{ type: 'text', text: USAGE_MESSAGE }]
      }
      return [{ type: 'text', text: buildPrompt(trimmed) }]
    },
  })
}
