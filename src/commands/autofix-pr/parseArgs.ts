export type ParsedArgs =
  | { action: 'stop' }
  | { action: 'start'; prNumber: number; owner?: string; repo?: string }
  | { action: 'freeform'; prompt: string }
  | { action: 'invalid'; reason: string }

/**
 * 解析 PR 编号字符串。范围限制为 1..9_999_999_999（1-10 位数字，不含前导零），
 * 确保永远不产生 0、负数或 unsafe integer。
 */
export function parsePrNumber(raw: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : null
}

export function parseAutofixArgs(raw: string): ParsedArgs {
  const trimmed = raw.trim()
  if (!trimmed) return { action: 'invalid', reason: 'empty' }
  if (trimmed === 'stop' || trimmed === 'off') return { action: 'stop' }
  const bareNum = parsePrNumber(trimmed)
  if (bareNum !== null) {
    return { action: 'start', prNumber: bareNum }
  }
  const cross = trimmed.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/)
  if (cross) {
    const crossNum = parsePrNumber(cross[3] as string)
    if (crossNum === null)
      return { action: 'invalid', reason: 'pr_number_out_of_range' }
    return {
      action: 'start',
      owner: cross[1],
      repo: cross[2],
      prNumber: crossNum,
    }
  }
  return { action: 'freeform', prompt: trimmed }
}
