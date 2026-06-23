import {
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
  isKairosCronEnabled,
} from '@claude-code-best/builtin-tools/tools/ScheduleCronTool/prompt.js'
import { registerBundledSkill } from '../bundledSkills.js'

export function registerCronListSkill(): void {
  registerBundledSkill({
    name: 'cron-list',
    description: '列出本会话中所有已计划的 cron 任务',
    whenToUse:
      '当用户想查看已计划/循环任务、检查活动 cron 任务或查看当前循环内容时使用。',
    userInvocable: true,
    isEnabled: isKairosCronEnabled,
    async getPromptForCommand() {
      return [
        {
          type: 'text',
          text: `调用 ${CRON_LIST_TOOL_NAME} 列出所有已计划的 cron 任务。以表格形式展示结果，列为：ID、Schedule、Prompt、Recurring、Durable。如果没有任务，显示"没有已计划的任务。"`,
        },
      ]
    },
  })
}

export function registerCronDeleteSkill(): void {
  registerBundledSkill({
    name: 'cron-delete',
    description: '通过 ID 取消已计划的 cron 任务',
    whenToUse:
      '当用户想取消、停止或删除已计划/循环任务或 cron 任务时使用。',
    argumentHint: '<job-id>',
    userInvocable: true,
    isEnabled: isKairosCronEnabled,
    async getPromptForCommand(args) {
      const id = args.trim()
      if (!id) {
        return [
          {
            type: 'text',
            text: `用法：/cron-delete <job-id>\n\n提供要取消的任务 ID。使用 /cron-list 查看活动任务及其 ID。`,
          },
        ]
      }
      return [
        {
          type: 'text',
          text: `调用 ${CRON_DELETE_TOOL_NAME} 并传入 id "${id}" 以取消该已计划任务。向用户确认结果。`,
        },
      ]
    },
  })
}
