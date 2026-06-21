import { useMemo, useRef } from 'react'
import { BASH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BashTool/toolName.js'
import type { Message } from '../types/message.js'
import { getUserMessageText } from '../utils/messages.js'

const EXTERNAL_COMMAND_PATTERNS = [
  /\bcurl\b/,
  /\bwget\b/,
  /\bssh\b/,
  /\bkubectl\b/,
  /\bsrun\b/,
  /\bdocker\b/,
  /\bbq\b/,
  /\bgsutil\b/,
  /\bgcloud\b/,
  /\baws\b/,
  /\bgit\s+push\b/,
  /\bgit\s+pull\b/,
  /\bgit\s+fetch\b/,
  /\bgh\s+(pr|issue)\b/,
  /\bnc\b/,
  /\bncat\b/,
  /\btelnet\b/,
  /\bftp\b/,
]

const FRICTION_PATTERNS = [
  // "No," 或 "No!" 在开头 —— 逗号/感叹号暗示纠正语气
  //（避免匹配 "No problem"、"No thanks"、"No I think we should..."）
  /^no[,!]\s/i,
  // 关于 Claude 输出的直接纠正
  /\bthat'?s (wrong|incorrect|not (what|right|correct))\b/i,
  /\bnot what I (asked|wanted|meant|said)\b/i,
  // 引用 Claude 漏掉的先前指令
  /\bI (said|asked|wanted|told you|already said)\b/i,
  // 质疑 Claude 的行为
  /\bwhy did you\b/i,
  /\byou should(n'?t| not)? have\b/i,
  /\byou were supposed to\b/i,
  // 明确重试/回滚 Claude 的工作
  /\btry again\b/i,
  /\b(undo|revert) (that|this|it|what you)\b/i,
]

export function isSessionContainerCompatible(messages: Message[]): boolean {
  for (const msg of messages) {
    if (msg.type !== 'assistant') {
      continue
    }
    const content = msg.message!.content
    if (!Array.isArray(content)) {
      continue
    }
    for (const block of content) {
      if (block.type !== 'tool_use' || !('name' in block)) {
        continue
      }
      const toolName = block.name as string
      if (toolName.startsWith('mcp__')) {
        return false
      }
      if (toolName === BASH_TOOL_NAME) {
        const input = (block as { input?: Record<string, unknown> }).input
        const command = (input?.command as string) || ''
        if (EXTERNAL_COMMAND_PATTERNS.some(p => p.test(command))) {
          return false
        }
      }
    }
  }
  return true
}

export function hasFrictionSignal(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type !== 'user') {
      continue
    }
    const text = getUserMessageText(msg)
    if (!text) {
      continue
    }
    return FRICTION_PATTERNS.some(p => p.test(text))
  }
  return false
}

const MIN_SUBMIT_COUNT = 3
const COOLDOWN_MS = 30 * 60 * 1000

export function useIssueFlagBanner(
  messages: Message[],
  submitCount: number,
): boolean {
  const lastTriggeredAtRef = useRef(0)
  const activeForSubmitRef = useRef(-1)

  // 记忆化 O(messages) 扫描。此 hook 在每次 REPL 渲染时运行
  //（包括每次按键），但 messages 在打字期间是稳定的。
  // isSessionContainerCompatible 遍历所有消息 + 对每个
  // bash 命令做正则测试 —— 是这里最重的工作。
  const shouldTrigger = useMemo(
    () => isSessionContainerCompatible(messages) && hasFrictionSignal(messages),
    [messages],
  )

  const isAnt = process.env.USER_TYPE === 'ant'
  if (!isAnt) {
    return false
  }

  // 持续显示横幅直到用户提交另一条消息
  if (activeForSubmitRef.current === submitCount) {
    return true
  }

  if (Date.now() - lastTriggeredAtRef.current < COOLDOWN_MS) {
    return false
  }
  if (submitCount < MIN_SUBMIT_COUNT) {
    return false
  }
  if (!shouldTrigger) {
    return false
  }

  lastTriggeredAtRef.current = Date.now()
  activeForSubmitRef.current = submitCount
  return true
}
