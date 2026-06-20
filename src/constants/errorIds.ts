/**
 * 用于在生产环境中追踪错误来源的错误 ID。
 * 这些 ID 是混淆后的标识符，帮助我们追溯
 * 是哪个 logError() 调用产生的错误。
 *
 * 这些错误以单独的 const 导出形式表示，以实现最佳的
 * 死代码消除（外部构建只会看到数字）。
 *
 * 新增错误类型步骤：
 * 1. 基于下一个 ID 添加一个 const。
 * 2. 递增下一个 ID。
 * 下一个 ID：346
 */

export const E_TOOL_USE_SUMMARY_GENERATION_FAILED = 344
