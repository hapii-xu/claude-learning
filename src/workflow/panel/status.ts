import type { AgentProgress, RunProgress } from '../progress/store.js'

/** run 状态 -> 点字符（用于顶部 tab）。 */
export const STATUS_DOT: Record<RunProgress['status'], string> = {
  running: '●',
  completed: '✓',
  failed: '✗',
  killed: '■',
}

/** run 状态 -> ink theme color token（沿用现有 WorkflowList 配色）。 */
export const RUN_STATUS_COLOR: Record<RunProgress['status'], string> = {
  running: 'warning',
  completed: 'success',
  failed: 'error',
  killed: 'subtle',
}

/** run 状态 -> 展示文本（用于头部；与参考图 done/running 一致）。 */
export const RUN_STATUS_TEXT: Record<RunProgress['status'], string> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  killed: 'killed',
}

/** 侧栏中合并 phase 的状态（包含 pending：meta 声明但尚未启动）。 */
export type PhaseStatus = 'running' | 'done' | 'pending'

export const PHASE_MARK: Record<PhaseStatus, string> = {
  running: '●',
  done: '✓',
  pending: '○',
}

export const PHASE_COLOR: Record<PhaseStatus, string> = {
  running: 'warning',
  done: 'success',
  pending: 'subtle',
}

/** agent 行的视觉表示：mark 字符 + 颜色（running 的 mark 在 UI 中被 spinner 动画覆盖）。 */
export type AgentVisual = { mark: string; color: string }

/**
 * agent 状态 -> 视觉。
 * - running -> ● warning（UI 用 spinner 动画覆盖 mark）
 * - done·dead -> ✗ error
 * - done·ok -> ✓ success
 */
export function agentVisual(a: AgentProgress): AgentVisual {
  if (a.status === 'running') return { mark: '●', color: 'warning' }
  if (a.resultKind === 'dead') return { mark: '✗', color: 'error' }
  return { mark: '✓', color: 'success' }
}

/** token 数 -> 展示字符串（<1000 保留原值；否则保留 1 位小数 + k）。 */
export function formatTokenCount(n: number | undefined): string {
  if (!n) return '0'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/**
 * agent 行右侧的统计文本：`model · Nk tok · N tool`。
 * 没有 model 时省略前缀；运行时 token/tool 由 agent_progress 实时刷新。
 */
export function agentMetaText(a: AgentProgress): string {
  const parts: string[] = []
  if (a.model) parts.push(a.model)
  parts.push(`${formatTokenCount(a.tokenCount)} tok`)
  parts.push(`${a.toolCount ?? 0} tool`)
  return parts.join(' · ')
}
