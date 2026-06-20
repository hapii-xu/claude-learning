import { getClaudeAiBaseUrl } from '../constants/product.js'
import { isSelfHostedBridge, getBridgeBaseUrl } from './bridgeConfig.js'
import { stringWidth } from '@anthropic/ink'
import { formatDuration, truncateToWidth } from '../utils/format.js'
import { getGraphemeSegmenter } from '../utils/intl.js'

/** Bridge 状态机的状态集合。 */
export type StatusState =
  | 'idle'
  | 'attached'
  | 'titled'
  | 'reconnecting'
  | 'failed'

/** 最近一次 tool_start 之后，工具活动行还能保留多久（毫秒）。 */
export const TOOL_DISPLAY_EXPIRY_MS = 30_000

/** shimmer 动画的 tick 间隔（毫秒）。 */
export const SHIMMER_INTERVAL_MS = 150

export function timestamp(): string {
  const now = new Date()
  const h = String(now.getHours()).padStart(2, '0')
  const m = String(now.getMinutes()).padStart(2, '0')
  const s = String(now.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

export { formatDuration, truncateToWidth as truncatePrompt }

/** 把工具活动摘要缩略展示在 trail 中。 */
export function abbreviateActivity(summary: string): string {
  return truncateToWidth(summary, 30)
}

/** 生成 bridge 空闲时显示的连接 URL。 */
export function buildBridgeConnectUrl(
  environmentId: string,
  ingressUrl?: string,
): string {
  // 自托管：直接使用配置的服务器 URL
  const baseUrl = isSelfHostedBridge()
    ? getBridgeBaseUrl()
    : getClaudeAiBaseUrl(undefined, ingressUrl)
  return `${baseUrl}/code?bridge=${environmentId}`
}

/**
 * 生成 session 已连接时显示的 session URL。先委托
 * getRemoteSessionUrl 做 cse_→session_ 前缀转换，再追加上 v1 专属的
 * ?bridge={environmentId} 查询参数。
 */
export function buildBridgeSessionUrl(
  sessionId: string,
  environmentId: string,
  ingressUrl?: string,
): string {
  // 自托管：直接使用配置的服务器 URL
  const baseUrl = isSelfHostedBridge()
    ? getBridgeBaseUrl()
    : getClaudeAiBaseUrl(undefined, ingressUrl)
  return `${baseUrl}/code/${sessionId}?bridge=${environmentId}`
}

/** 计算反向扫描 shimmer 动画的 glimmer 索引。 */
export function computeGlimmerIndex(
  tick: number,
  messageWidth: number,
): number {
  const cycleLength = messageWidth + 20
  return messageWidth + 10 - (tick % cycleLength)
}

/**
 * 按可视列位置把文本切成三段，供 shimmer 渲染使用。
 *
 * 使用 grapheme 分段和 `stringWidth`，保证对多字节字符、emoji 以及
 * CJK 字形的切分都是正确的。
 *
 * 返回 `{ before, shimmer, after }` 三个字符串。两个渲染器（bridgeUI.ts
 * 中的 chalk 以及 bridge.tsx 中的 React/Ink）会各自为这些段落着色。
 */
export function computeShimmerSegments(
  text: string,
  glimmerIndex: number,
): { before: string; shimmer: string; after: string } {
  const messageWidth = stringWidth(text)
  const shimmerStart = glimmerIndex - 1
  const shimmerEnd = glimmerIndex + 1

  // 当 shimmer 在屏幕外时，整段文本都作为 "before" 返回
  if (shimmerStart >= messageWidth || shimmerEnd < 0) {
    return { before: text, shimmer: '', after: '' }
  }

  // 按可视列位置最多切成 3 段
  const clampedStart = Math.max(0, shimmerStart)
  let colPos = 0
  let before = ''
  let shimmer = ''
  let after = ''
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    const segWidth = stringWidth(segment)
    if (colPos + segWidth <= clampedStart) {
      before += segment
    } else if (colPos > shimmerEnd) {
      after += segment
    } else {
      shimmer += segment
    }
    colPos += segWidth
  }

  return { before, shimmer, after }
}

/** 根据 bridge 连接状态算出来的状态标签和颜色。 */
export type BridgeStatusInfo = {
  label:
    | 'Remote Control failed'
    | 'Remote Control reconnecting'
    | 'Remote Control active'
    | 'Remote Control connecting\u2026'
  color: 'error' | 'warning' | 'success'
}

/** 根据 bridge 连接状态推导状态标签和颜色。 */
export function getBridgeStatus({
  error,
  connected,
  sessionActive,
  reconnecting,
}: {
  error: string | undefined
  connected: boolean
  sessionActive: boolean
  reconnecting: boolean
}): BridgeStatusInfo {
  if (error) return { label: 'Remote Control failed', color: 'error' }
  if (reconnecting)
    return { label: 'Remote Control reconnecting', color: 'warning' }
  if (sessionActive || connected)
    return { label: 'Remote Control active', color: 'success' }
  return { label: 'Remote Control connecting\u2026', color: 'warning' }
}

/** bridge 空闲（Ready 状态）时显示的底部文案。 */
export function buildIdleFooterText(url: string): string {
  return `Code everywhere with the Claude app or ${url}`
}

/** session 活跃（Connected 状态）时显示的底部文案。 */
export function buildActiveFooterText(url: string): string {
  return `Continue coding in the Claude app or ${url}`
}

/** bridge 失败时显示的底部文案。 */
export const FAILED_FOOTER_TEXT = 'Something went wrong, please try again'

/**
 * 把文本包装成 OSC 8 终端超链接。布局上可视宽度为零。strip-ansi
 *（被 stringWidth 使用）能正确剥离这些转义序列，所以 bridgeUI.ts 中
 * 的 countVisualLines 依然准确。
 */
export function wrapWithOsc8Link(text: string, url: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`
}
