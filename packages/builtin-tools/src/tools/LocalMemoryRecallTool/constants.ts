export const LOCAL_MEMORY_RECALL_TOOL_NAME = 'LocalMemoryRecall'

/** 单轮内多次调用累计的完整 fetch 负载预算。 */
export const PER_TURN_FETCH_BUDGET_BYTES = 100 * 1024
/** 单条目预览上限（preview_only 模式默认 = true）。 */
export const PREVIEW_CAP_BYTES = 2 * 1024
/** 单条目完整 fetch 上限。 */
export const FETCH_CAP_BYTES = 50 * 1024
/** list_stores 汇总上限（约 256 个 store 名称）。 */
export const LIST_STORES_CAP_BYTES = 4 * 1024
/** 每个 store 的 list_entries 上限。 */
export const LIST_ENTRIES_CAP_BYTES = 8 * 1024
