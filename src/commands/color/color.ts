import type { UUID } from 'crypto'
import { getSessionId } from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  AGENT_COLORS,
  type AgentColorName,
} from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import {
  getTranscriptPath,
  saveAgentColor,
} from '../../utils/sessionStorage.js'
import { isTeammate } from '../../utils/teammate.js'

const RESET_ALIASES = ['default', 'reset', 'none', 'gray', 'grey'] as const

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<null> {
  // Teammates 无法设置自己的颜色
  if (isTeammate()) {
    onDone(
      'Cannot set color: This session is a swarm teammate. Teammate colors are assigned by the team leader.',
      { display: 'system' },
    )
    return null
  }

  if (!args || args.trim() === '') {
    const colorList = AGENT_COLORS.join(', ')
    onDone(`Please provide a color. Available colors: ${colorList}, default`, {
      display: 'system',
    })
    return null
  }

  const colorArg = args.trim().toLowerCase()

  // 处理重置为默认值（gray）
  if (RESET_ALIASES.includes(colorArg as (typeof RESET_ALIASES)[number])) {
    const sessionId = getSessionId() as UUID
    const fullPath = getTranscriptPath()

    // 使用 "default" 哨兵值（而非空字符串），以便 sessionStorage.ts 中
    // 的真值判断守卫在会话重启后仍能持久化此次重置
    await saveAgentColor(sessionId, 'default', fullPath)

    context.setAppState(prev => ({
      ...prev,
      standaloneAgentContext: {
        ...prev.standaloneAgentContext,
        name: prev.standaloneAgentContext?.name ?? '',
        color: undefined,
      },
    }))

    onDone('Session color reset to default', { display: 'system' })
    return null
  }

  if (!AGENT_COLORS.includes(colorArg as AgentColorName)) {
    const colorList = AGENT_COLORS.join(', ')
    onDone(
      `Invalid color "${colorArg}". Available colors: ${colorList}, default`,
      { display: 'system' },
    )
    return null
  }

  const sessionId = getSessionId() as UUID
  const fullPath = getTranscriptPath()

  // 保存到 transcript 以实现跨会话持久化
  await saveAgentColor(sessionId, colorArg, fullPath)

  // 更新 AppState 以立即生效
  context.setAppState(prev => ({
    ...prev,
    standaloneAgentContext: {
      ...prev.standaloneAgentContext,
      name: prev.standaloneAgentContext?.name ?? '',
      color: colorArg as AgentColorName,
    },
  }))

  onDone(`Session color set to: ${colorArg}`, { display: 'system' })
  return null
}
