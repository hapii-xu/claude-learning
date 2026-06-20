/**
 * Mermaid 时序图源码解析器
 * 提取 participant / message / Note / rect / alt 结构
 *
 * 兼容子集：
 *   participant ID [as Display]
 *   Note over X[,Y]: text
 *   rect rgb(r,g,b)  ... end
 *   rect rgba(r,g,b,a) ... end
 *   alt LABEL ... [else LABEL] ... end
 *   loop LABEL ... end  (作为 alt 单分支处理)
 *   opt LABEL ... end   (作为 alt 单分支处理)
 *   A ->> B  / A -->> B / A -> B / A -- B : text
 */

export interface ParsedParticipant {
  id: string
  displayName: string
}

export type MessageType = 'solid' | 'dashed'

export interface ParsedMessage {
  /** 0-based autonumber index */
  index: number
  /** Row index in the global canvas sequence (counts messages + notes) */
  rowIndex: number
  from: string
  to: string
  text: string
  type: MessageType
}

export interface ParsedNote {
  rowIndex: number
  anchorIds: string[]
  text: string
}

export interface ParsedRect {
  color: string
  startRowIndex: number
  endRowIndex: number
}

export interface ParsedAltBranch {
  label: string
  startRowIndex: number
  endRowIndex: number
}

export interface ParsedAlt {
  branches: ParsedAltBranch[]
}

export interface ParsedDiagram {
  participants: ParsedParticipant[]
  messages: ParsedMessage[]
  notes: ParsedNote[]
  rects: ParsedRect[]
  alts: ParsedAlt[]
  rowCount: number
}

const PARTICIPANT_RE = /^participant\s+(\w+)(?:\s+as\s+(.+?))?\s*$/i
const NOTE_RE = /^Note\s+over\s+([^:]+?)\s*:\s*(.+)$/i
const RECT_RE = /^rect\s+(rgba?\([^)]+\))\s*$/i
const ALT_RE = /^alt\s+(.+)$/i
const ELSE_RE = /^else(?:\s+(.+))?$/i
const LOOP_RE = /^loop\s+(.+)$/i
const OPT_RE = /^opt\s+(.+)$/i
const END_RE = /^end\s*$/i
const MESSAGE_RE = /^(\w+)\s*(-->>|->>|--|->)\s*(\w+)\s*:\s*(.+)$/

type OpenRect = { type: 'rect'; color: string; startRow: number }
type OpenAlt = {
  type: 'alt'
  curLabel: string
  curStart: number
  branches: ParsedAltBranch[]
}

export function parseMermaidSource(source: string): ParsedDiagram {
  const participants: ParsedParticipant[] = []
  const participantIds = new Set<string>()
  const messages: ParsedMessage[] = []
  const notes: ParsedNote[] = []
  const rects: ParsedRect[] = []
  const alts: ParsedAlt[] = []
  const stack: (OpenRect | OpenAlt)[] = []

  let msgIdx = 0
  let rowIdx = 0

  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('%%')) continue

    let m: RegExpExecArray | null

    if ((m = PARTICIPANT_RE.exec(line))) {
      const id = m[1]!
      const displayName = m[2]?.trim() || id
      if (!participantIds.has(id)) {
        participantIds.add(id)
        participants.push({ id, displayName })
      }
      continue
    }

    if ((m = NOTE_RE.exec(line))) {
      const anchorIds = m[1]!
        .split(/\s*,\s*/)
        .map(s => s.trim())
        .filter(Boolean)
      notes.push({ rowIndex: rowIdx, anchorIds, text: m[2]!.trim() })
      rowIdx++
      continue
    }

    if ((m = RECT_RE.exec(line))) {
      stack.push({ type: 'rect', color: m[1]!, startRow: rowIdx })
      continue
    }

    if ((m = ALT_RE.exec(line))) {
      stack.push({
        type: 'alt',
        curLabel: m[1]!.trim(),
        curStart: rowIdx,
        branches: [],
      })
      continue
    }

    if ((m = LOOP_RE.exec(line)) || (m = OPT_RE.exec(line))) {
      stack.push({
        type: 'alt',
        curLabel: m[1]!.trim(),
        curStart: rowIdx,
        branches: [],
      })
      continue
    }

    if ((m = ELSE_RE.exec(line))) {
      const top = stack[stack.length - 1]
      if (top?.type === 'alt') {
        top.branches.push({
          label: top.curLabel,
          startRowIndex: top.curStart,
          endRowIndex: rowIdx - 1,
        })
        top.curLabel = m[1]?.trim() || ''
        top.curStart = rowIdx
      }
      continue
    }

    if (END_RE.test(line)) {
      const top = stack.pop()
      if (top?.type === 'rect') {
        rects.push({
          color: top.color,
          startRowIndex: top.startRow,
          endRowIndex: rowIdx - 1,
        })
      } else if (top?.type === 'alt') {
        top.branches.push({
          label: top.curLabel,
          startRowIndex: top.curStart,
          endRowIndex: rowIdx - 1,
        })
        alts.push({ branches: top.branches })
      }
      continue
    }

    if ((m = MESSAGE_RE.exec(line))) {
      const from = m[1]!
      const arrow = m[2]!
      const to = m[3]!
      const text = m[4]!.trim()
      const type: MessageType = arrow.startsWith('--') ? 'dashed' : 'solid'
      messages.push({ index: msgIdx, rowIndex: rowIdx, from, to, text, type })
      msgIdx++
      rowIdx++
    }
  }

  return { participants, messages, notes, rects, alts, rowCount: rowIdx }
}

export function buildParticipantMap(
  participants: ParsedParticipant[],
): Map<string, string> {
  const map = new Map<string, string>()
  for (const p of participants) map.set(p.id, p.displayName)
  return map
}

export function getIncomingMessages(
  messages: ParsedMessage[],
  participantId: string,
): ParsedMessage[] {
  return messages.filter(m => m.to === participantId)
}

export function getOutgoingMessages(
  messages: ParsedMessage[],
  participantId: string,
): ParsedMessage[] {
  return messages.filter(m => m.from === participantId)
}

export function getSubsequentChain(
  messages: ParsedMessage[],
  messageIndex: number,
  maxDepth = 10,
): ParsedMessage[] {
  const chain: ParsedMessage[] = []
  const msg = messages[messageIndex]
  if (!msg) return chain
  const calleeId = msg.to
  let searchFrom = messageIndex + 1
  for (
    let depth = 0;
    depth < maxDepth && searchFrom < messages.length;
    depth++
  ) {
    const next = messages.findIndex(
      (m, i) => i >= searchFrom && m.from === calleeId,
    )
    if (next === -1) break
    chain.push(messages[next]!)
    searchFrom = next + 1
  }
  return chain
}

/**
 * 上游调用栈：递归到根（无上游为止）。Set 防环。
 * 返回 [root, ..., directCaller]
 */
export function getUpstreamChain(
  messages: ParsedMessage[],
  messageIndex: number,
): ParsedMessage[] {
  const chain: ParsedMessage[] = []
  const visited = new Set<number>()
  let current = messageIndex
  while (current > 0) {
    const msg = messages[current]
    if (!msg) break
    const callerId = msg.from
    let prevIdx = -1
    for (let i = current - 1; i >= 0; i--) {
      if (messages[i]?.to === callerId) {
        prevIdx = i
        break
      }
    }
    if (prevIdx === -1) break
    if (visited.has(prevIdx)) break
    visited.add(prevIdx)
    chain.unshift(messages[prevIdx]!)
    current = prevIdx
  }
  return chain
}

export function getParticipantCallPath(
  messages: ParsedMessage[],
  participantId: string,
): ParsedMessage[] {
  return messages.filter(m => m.to === participantId)
}
