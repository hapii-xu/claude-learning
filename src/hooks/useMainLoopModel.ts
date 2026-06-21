import { useEffect, useReducer } from 'react'
import { onGrowthBookRefresh } from '../services/analytics/growthbook.js'
import { useAppState } from '../state/AppState.js'
import {
  getDefaultMainLoopModelSetting,
  type ModelName,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'

// selector 的值是一个完整的模型名称，可直接用于 API 调用。
// 当组件需要在模型配置变更时更新时，使用此函数而不是 getMainLoopModel()。
export function useMainLoopModel(): ModelName {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession)

  // parseUserSpecifiedModel 通过 _CACHED_MAY_BE_STALE（在 resolveAntModel 中）
  // 读取 tengu_ant_model_override。在 GB 初始化完成之前，
  // 那是陈旧的磁盘缓存；之后，它是内存中的 remoteEval map。
  // GB 初始化完成时 AppState 不会改变，所以我们订阅
  // 刷新信号并强制重新渲染以用新值重新解析。
  // 没有这个，别名解析会冻结直到其他东西
  // 碰巧重新渲染组件 —— API 会采样一个模型，
  // 而 /model（也会重新解析）显示另一个。
  const [, forceRerender] = useReducer(x => x + 1, 0)
  useEffect(() => onGrowthBookRefresh(forceRerender), [])

  const model = parseUserSpecifiedModel(
    mainLoopModelForSession ??
      mainLoopModel ??
      getDefaultMainLoopModelSetting(),
  )
  return model
}
