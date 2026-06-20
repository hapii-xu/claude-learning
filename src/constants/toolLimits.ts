/**
 * 与工具结果大小限制相关的常量
 */

/**
 * 工具结果在持久化到磁盘之前的默认最大字符数。
 * 超过此值时，结果会保存到文件中，模型会收到一个
 * 包含文件路径的预览，而非完整内容。
 *
 * 单个工具可以声明更小的 maxResultSizeChars，但无论工具声明什么，
 * 此常量都作为全系统上限。
 */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000

/**
 * 工具结果的最大 token 数。
 * 基于对工具结果大小的分析，我们将其设为一个合理的上界，
 * 以防止过大的工具结果占用过多上下文。
 *
 * 约合 400KB 文本（按每 token 约 4 字节估算）。
 */
export const MAX_TOOL_RESULT_TOKENS = 100_000

/**
 * 用于从字节数推算 token 数的「每 token 字节数」估算值。
 * 这是一个保守估计，实际 token 数可能不同。
 */
export const BYTES_PER_TOKEN = 4

/**
 * 工具结果的最大字节数（由 token 上限推导得出）。
 */
export const MAX_TOOL_RESULT_BYTES = MAX_TOOL_RESULT_TOKENS * BYTES_PER_TOKEN

/**
 * 单条用户消息内（一个回合中的一批并行工具结果）tool_result 块的
 * 默认最大聚合字符数。当一条消息内所有块加起来超过此值时，
 * 会将该消息中最大的块持久化到磁盘并用预览替换，直到低于预算。
 * 各消息独立评估 —— 一个回合中的 150K 结果与下一回合的
 * 150K 结果互不影响。
 *
 * 此限制用于防止 N 个并行工具各自达到单工具上限，
 * 从而在一个回合的用户消息中累计产生例如 10 × 40K = 400K 的内容。
 *
 * 可在运行时通过 GrowthBook 开关 tengu_hawthorn_window 覆盖 —— 参见
 * toolResultStorage.ts 中的 getPerMessageBudgetLimit()。
 */
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000

/**
 * 紧凑视图下工具摘要字符串的最大字符长度。
 * 由各 getToolUseSummary() 实现用于截断过长的输入，
 * 以便在分组的 agent 渲染中展示。
 */
export const TOOL_SUMMARY_MAX_LENGTH = 50
