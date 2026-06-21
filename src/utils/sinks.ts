import { initializeErrorLogSink } from './errorLogSink.js'
import { initializeAnalyticsSink } from '../services/analytics/sink.js'

/**
 * 挂载错误日志和分析数据收集器，并排空在挂载前已排队的事件。
 * 两个初始化函数都是幂等的。由默认命令的 setup() 调用；
 * 其他入口点（子命令、daemon、bridge）直接调用此函数，
 * 因为它们绕过了 setup()。
 *
 * 叶子模块 — 放在此文件是为了避免 setup → commands → bridge
 * → setup 的循环导入。
 */
export function initSinks(): void {
  initializeErrorLogSink()
  initializeAnalyticsSink()
}
