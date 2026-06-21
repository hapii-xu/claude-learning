import type { Message, UserMessage } from '../types/message.js'

// tool_result 消息与 human 轮次共享 type:'user'；判别依据
// 是可选的 toolUseResult 字段。四个 PR（#23977、#24016、#24022、
// #24025）分别修复了仅检查 type==='user' 导致的计数错误。
export function isHumanTurn(m: Message): m is UserMessage {
  return m.type === 'user' && !m.isMeta && m.toolUseResult === undefined
}
