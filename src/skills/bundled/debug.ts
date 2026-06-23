import { open, stat } from 'fs/promises'
import { CLAUDE_CODE_GUIDE_AGENT_TYPE } from '@claude-code-best/builtin-tools/tools/AgentTool/built-in/claudeCodeGuideAgent.js'
import { getSettingsFilePathForSource } from 'src/utils/settings/settings.js'
import { enableDebugLogging, getDebugLogPath } from '../../utils/debug.js'
import { errorMessage, isENOENT } from '../../utils/errors.js'
import { formatFileSize } from '../../utils/format.js'
import { registerBundledSkill } from '../bundledSkills.js'

const DEFAULT_DEBUG_LINES_READ = 20
const TAIL_READ_BYTES = 64 * 1024

export function registerDebugSkill(): void {
  registerBundledSkill({
    name: 'debug',
    description:
      process.env.USER_TYPE === 'ant'
        ? '通过读取会话调试日志来调试当前的 Claude Code 会话。包含所有事件日志'
        : '为本次会话启用调试日志并协助诊断问题',
    allowedTools: ['Read', 'Grep', 'Glob'],
    argumentHint: '[问题描述]',
    // 禁用模型调用，以便用户必须在交互模式下显式请求，
    // 同时描述也不会占用上下文。
    disableModelInvocation: true,
    userInvocable: true,
    async getPromptForCommand(args) {
      // 非 Anthropic 员工默认不写调试日志 —— 现在开启日志记录，
      // 以便捕获此会话中的后续活动。
      const wasAlreadyLogging = enableDebugLogging()
      const debugLogPath = getDebugLogPath()

      let logInfo: string
      try {
        // 尾部读取日志，而非读取整个文件 —— 调试日志在长会话中
        // 会无限增长，完整读取会导致 RSS 飙升。
        const stats = await stat(debugLogPath)
        const readSize = Math.min(stats.size, TAIL_READ_BYTES)
        const startOffset = stats.size - readSize
        const fd = await open(debugLogPath, 'r')
        try {
          const { buffer, bytesRead } = await fd.read({
            buffer: Buffer.alloc(readSize),
            position: startOffset,
          })
          const tail = buffer
            .toString('utf-8', 0, bytesRead)
            .split('\n')
            .slice(-DEFAULT_DEBUG_LINES_READ)
            .join('\n')
          logInfo = `Log size: ${formatFileSize(stats.size)}\n\n### Last ${DEFAULT_DEBUG_LINES_READ} lines\n\n\`\`\`\n${tail}\n\`\`\``
        } finally {
          await fd.close()
        }
      } catch (e) {
        logInfo = isENOENT(e)
          ? '调试日志尚不存在——日志记录刚刚已启用。'
          : `读取调试日志末尾 ${DEFAULT_DEBUG_LINES_READ} 行失败：${errorMessage(e)}`
      }

      const justEnabledSection = wasAlreadyLogging
        ? ''
        : `
## 调试日志已启用

在此之前，本次会话的调试日志处于关闭状态。/debug 调用之前的内容均未被捕获。

告知用户调试日志现已在 \`${debugLogPath}\` 处激活，请他们复现问题，然后重新读取日志。如果无法复现，也可以使用 \`claude --debug\` 重启，以便从启动时开始捕获日志。
`

      const prompt = `# Debug 技能

帮助用户调试当前 Claude Code 会话中遇到的问题。
${justEnabledSection}
## 会话调试日志

当前会话的调试日志位于：\`${debugLogPath}\`

${logInfo}

如需更多上下文，可在完整文件中 grep 搜索 [ERROR] 和 [WARN] 行。

## 问题描述

${args || '用户未描述具体问题。请读取调试日志并总结所有错误、警告或值得注意的问题。'}

## 设置

请记住，设置文件位于：
* 用户级 - ${getSettingsFilePathForSource('userSettings')}
* 项目级 - ${getSettingsFilePathForSource('projectSettings')}
* 本地级 - ${getSettingsFilePathForSource('localSettings')}

## 操作步骤

1. 审查用户的问题描述
2. 末尾 ${DEFAULT_DEBUG_LINES_READ} 行展示了调试文件格式。在完整文件中查找 [ERROR] 和 [WARN] 条目、堆栈跟踪及失败模式
3. 考虑启动 ${CLAUDE_CODE_GUIDE_AGENT_TYPE} 子 agent，以了解相关的 Claude Code 功能
4. 用通俗语言解释发现的内容
5. 建议具体的修复方案或后续步骤
`
      return [{ type: 'text', text: prompt }]
    },
  })
}
