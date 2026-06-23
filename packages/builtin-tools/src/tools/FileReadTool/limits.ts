/**
 * Read 工具输出限制。文本读取时有两个上限：
 *
 *   | limit         | 默认值  | 检查项                    | 成本          | 超出时          |
 *   |---------------|---------|---------------------------|---------------|-----------------|
 *   | maxSizeBytes  | 256 KB  | 文件总大小（非输出）      | 1 次 stat     | 读取前抛出      |
 *   | maxTokens     | 25000   | 实际输出 token            | API 往返      | 读取后抛出      |
 *
 * 已知的不一致：maxSizeBytes 以文件总大小为准，而非切片大小。
 * 曾测试对超出字节上限的显式 limit 读取采用截断而非抛出（#21841，2026 年 3 月）。
 * 后来回退：工具错误率下降了，但平均 token 数上升 —— 抛出路径会产生约 100 字节的
 * 错误 tool-result，而截断在达到上限时会产生约 25K token 的内容。
 */
import memoize from 'lodash-es/memoize.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { MAX_OUTPUT_SIZE } from 'src/utils/file.js'
export const DEFAULT_MAX_OUTPUT_TOKENS = 25000

/**
 * 通过环境变量覆盖最大输出 token 数。未设置或无效时返回 undefined，
 * 以便调用方回退到下一优先级层级。
 */
function getEnvMaxTokens(): number | undefined {
  const override = process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS
  if (override) {
    const parsed = parseInt(override, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return undefined
}

export type FileReadingLimits = {
  maxTokens: number
  maxSizeBytes: number
  includeMaxSizeInPrompt?: boolean
  targetedRangeNudge?: boolean
}

/**
 * 当 ToolUseContext 未提供覆盖值时 Read 工具的默认限制。
 * 已 memoize，使 GrowthBook 值在首次调用时固定 —— 避免在会话进行中
 * 因后台 flag 刷新而导致上限变化。
 *
 * maxTokens 的优先级：环境变量 > GrowthBook > DEFAULT_MAX_OUTPUT_TOKENS。
 * （环境变量是用户设置的覆盖值，应优先于实验基础设施。）
 *
 * 防御性：每个字段都独立校验；无效值回退到硬编码默认值（不会出现 cap=0 的情况）。
 */
export const getDefaultFileReadingLimits = memoize((): FileReadingLimits => {
  const override =
    getFeatureValue_CACHED_MAY_BE_STALE<Partial<FileReadingLimits> | null>(
      'tengu_amber_wren',
      {},
    )

  const maxSizeBytes =
    typeof override?.maxSizeBytes === 'number' &&
    Number.isFinite(override.maxSizeBytes) &&
    override.maxSizeBytes > 0
      ? override.maxSizeBytes
      : MAX_OUTPUT_SIZE

  const envMaxTokens = getEnvMaxTokens()
  const maxTokens =
    envMaxTokens ??
    (typeof override?.maxTokens === 'number' &&
    Number.isFinite(override.maxTokens) &&
    override.maxTokens > 0
      ? override.maxTokens
      : DEFAULT_MAX_OUTPUT_TOKENS)

  const includeMaxSizeInPrompt =
    typeof override?.includeMaxSizeInPrompt === 'boolean'
      ? override.includeMaxSizeInPrompt
      : undefined

  const targetedRangeNudge =
    typeof override?.targetedRangeNudge === 'boolean'
      ? override.targetedRangeNudge
      : undefined

  return {
    maxSizeBytes,
    maxTokens,
    includeMaxSizeInPrompt,
    targetedRangeNudge,
  }
})
