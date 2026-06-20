import type { ParsedDiagram, ParsedMessage, ParsedNote } from './mermaidParser'

export const LAYOUT = {
  PARTICIPANT_WIDTH: 140,
  PARTICIPANT_HEIGHT: 44,
  PARTICIPANT_GAP: 32,
  PAD_X: 24,
  PAD_TOP: 20,
  HEADER_GAP: 32,
  MESSAGE_GAP: 48,
  NOTE_GAP: 64,
  NOTE_PAD_X: 12,
  NOTE_PAD_Y: 8,
  NOTE_LINE_HEIGHT: 14,
  NOTE_MIN_WIDTH: 150,
  PAD_BOTTOM: 32,
  SELF_LOOP_WIDTH: 64,
  SELF_LOOP_HEIGHT: 24,
  RECT_PAD_X: 4,
  RECT_PAD_TOP: 6,
  RECT_PAD_BOTTOM: 6,
  ALT_PAD_X: 8,
  ALT_PAD_TOP: 18,
  ALT_PAD_BOTTOM: 8,
}

export interface ParticipantPos {
  id: string
  displayName: string
  x: number
  topY: number
  bottomY: number
  width: number
  height: number
}

export interface MessagePos {
  index: number
  rowIndex: number
  y: number
  fromX: number
  toX: number
  fromId: string
  toId: string
  text: string
  type: 'solid' | 'dashed'
  isSelf: boolean
}

export interface NotePos {
  rowIndex: number
  y: number
  centerX: number
  width: number
  height: number
  text: string
  anchorIds: string[]
}

export interface RectPos {
  x: number
  y: number
  width: number
  height: number
  color: string
}

export interface AltBranchPos {
  label: string
  y: number
  height: number
}

export interface AltPos {
  x: number
  y: number
  width: number
  height: number
  branches: AltBranchPos[]
}

export interface SequenceLayoutResult {
  width: number
  height: number
  participants: ParticipantPos[]
  participantById: Map<string, ParticipantPos>
  messages: MessagePos[]
  notes: NotePos[]
  rects: RectPos[]
  alts: AltPos[]
  lifelineTop: number
  lifelineBottom: number
}

export function computeSequenceLayout(
  parsed: ParsedDiagram,
): SequenceLayoutResult {
  const L = LAYOUT
  const W = L.PARTICIPANT_WIDTH
  const H = L.PARTICIPANT_HEIGHT
  const G = L.PARTICIPANT_GAP

  const participants: ParticipantPos[] = parsed.participants.map((p, i) => ({
    id: p.id,
    displayName: p.displayName,
    x: L.PAD_X + i * (W + G) + W / 2,
    topY: L.PAD_TOP,
    bottomY: 0,
    width: W,
    height: H,
  }))
  const participantById = new Map(participants.map(p => [p.id, p]))

  const lifelineTop = L.PAD_TOP + H
  const headerHeight = lifelineTop + L.HEADER_GAP

  // Walk rows in source order (messages + notes interleaved), assigning y per row.
  // rowTops[rowIndex] = y for the top of that row
  const rowTops = new Map<number, number>()
  const rowHeights = new Map<number, number>()

  const allRows: Array<
    { kind: 'msg'; msg: ParsedMessage } | { kind: 'note'; note: ParsedNote }
  > = []
  for (const m of parsed.messages) allRows.push({ kind: 'msg', msg: m })
  for (const n of parsed.notes) allRows.push({ kind: 'note', note: n })
  allRows.sort((a, b) => {
    const ar = a.kind === 'msg' ? a.msg.rowIndex : a.note.rowIndex
    const br = b.kind === 'msg' ? b.msg.rowIndex : b.note.rowIndex
    return ar - br
  })

  const notesOut: NotePos[] = []
  const messagesOut: MessagePos[] = []
  let cursor = headerHeight

  for (const row of allRows) {
    if (row.kind === 'msg') {
      const m = row.msg
      const from = participantById.get(m.from)
      const to = participantById.get(m.to)
      if (!from || !to) continue
      const rowH = m.from === m.to ? L.SELF_LOOP_HEIGHT + 12 : L.MESSAGE_GAP
      const y = cursor + rowH / 2
      rowTops.set(m.rowIndex, cursor)
      rowHeights.set(m.rowIndex, rowH)
      messagesOut.push({
        index: m.index,
        rowIndex: m.rowIndex,
        y,
        fromX: from.x,
        toX: to.x,
        fromId: m.from,
        toId: m.to,
        text: m.text,
        type: m.type,
        isSelf: m.from === m.to,
      })
      cursor += rowH
    } else {
      const n = row.note
      const anchors = n.anchorIds
        .map(id => participantById.get(id))
        .filter(Boolean) as ParticipantPos[]
      if (anchors.length === 0) {
        cursor += L.NOTE_GAP
        continue
      }
      const minX = Math.min(...anchors.map(a => a.x))
      const maxX = Math.max(...anchors.map(a => a.x))
      const centerX = (minX + maxX) / 2
      const baseWidth = anchors.length > 1 ? maxX - minX + 60 : 140
      const width = Math.max(L.NOTE_MIN_WIDTH, baseWidth)
      const height = estimateNoteHeight(n.text, width)
      const rowH = Math.max(L.NOTE_GAP, height + 20)
      const y = cursor + (rowH - height) / 2
      rowTops.set(n.rowIndex, cursor)
      rowHeights.set(n.rowIndex, rowH)
      notesOut.push({
        rowIndex: n.rowIndex,
        y,
        centerX,
        width,
        height,
        text: n.text,
        anchorIds: n.anchorIds,
      })
      cursor += rowH
    }
  }

  const contentBottom = cursor

  const totalWidth =
    participants.length > 0
      ? L.PAD_X +
        participants.length * W +
        (participants.length - 1) * G +
        L.PAD_X
      : L.PAD_X * 2

  // Compute rect positions
  const rectsOut: RectPos[] = []
  for (const r of parsed.rects) {
    const yTop = (rowTops.get(r.startRowIndex) ?? headerHeight) - L.RECT_PAD_TOP
    const lastH = rowHeights.get(r.endRowIndex) ?? L.MESSAGE_GAP
    const yBot =
      (rowTops.get(r.endRowIndex) ?? cursor) + lastH + L.RECT_PAD_BOTTOM
    rectsOut.push({
      x: L.PAD_X - 8,
      y: yTop,
      width: totalWidth - 2 * (L.PAD_X - 8),
      height: yBot - yTop,
      color: r.color,
    })
  }

  // Compute alt frame positions (single alt for now; branches stacked vertically)
  const altsOut: AltPos[] = []
  for (const alt of parsed.alts) {
    if (alt.branches.length === 0) continue
    const allRowsInAlt = alt.branches.flatMap(b => [
      b.startRowIndex,
      b.endRowIndex,
    ])
    const minRow = Math.min(...allRowsInAlt)
    const maxRow = Math.max(...allRowsInAlt)
    const yTop = (rowTops.get(minRow) ?? headerHeight) - L.ALT_PAD_TOP
    const lastH = rowHeights.get(maxRow) ?? L.MESSAGE_GAP
    const yBot = (rowTops.get(maxRow) ?? cursor) + lastH + L.ALT_PAD_BOTTOM
    // Frame spans all participants involved — collect from messages/notes within the row range
    // Simple approach: just span the participants whose messages appear in this rowRange,
    // but for visibility we'll span between min and max participant x of messages inside.
    const innerXs: number[] = []
    for (const m of messagesOut) {
      if (m.rowIndex >= minRow && m.rowIndex <= maxRow) {
        innerXs.push(m.fromX, m.toX)
      }
    }
    if (innerXs.length === 0) continue
    const minX = Math.min(...innerXs) - L.ALT_PAD_X - 16
    const maxX = Math.max(...innerXs) + L.ALT_PAD_X + 16
    const branches: AltBranchPos[] = alt.branches.map(b => {
      const by = (rowTops.get(b.startRowIndex) ?? headerHeight) - 2
      const bH =
        rowTops.get(b.endRowIndex) !== undefined
          ? rowTops.get(b.endRowIndex)! +
            (rowHeights.get(b.endRowIndex) ?? 0) -
            by
          : L.MESSAGE_GAP
      return { label: b.label, y: by, height: bH }
    })
    altsOut.push({
      x: minX,
      y: yTop,
      width: maxX - minX,
      height: yBot - yTop,
      branches,
    })
  }

  const lifelineBottom = contentBottom + 16
  const bottomBoxesY = lifelineBottom
  const totalHeight = bottomBoxesY + H + L.PAD_BOTTOM

  for (const p of participants) p.bottomY = bottomBoxesY

  return {
    width: totalWidth,
    height: totalHeight,
    participants,
    participantById,
    messages: messagesOut,
    notes: notesOut,
    rects: rectsOut,
    alts: altsOut,
    lifelineTop,
    lifelineBottom,
  }
}

function estimateNoteHeight(text: string, width: number): number {
  const charsPerLine = Math.max(8, Math.floor((width - 24) / 6.6))
  const lines = Math.ceil(text.length / charsPerLine)
  return Math.max(28, lines * LAYOUT.NOTE_LINE_HEIGHT + 14)
}
