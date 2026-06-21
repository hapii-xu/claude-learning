/**
 * 推理配置命令（/model、/fast、/effort）是否应
 * 立即执行（在查询运行期间）而非等待当前轮次结束。
 *
 * 对 ants 始终启用；对外部用户由实验门控。
 */
export function shouldInferenceConfigCommandBeImmediate(): boolean {
  return (
    process.env.USER_TYPE === 'ant' ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_immediate_model_command', false)
  )
}
