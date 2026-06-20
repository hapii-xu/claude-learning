import { setMainLoopModelOverride } from '../bootstrap/state.js'
import {
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearGcpCredentialsCache,
} from '../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { toError } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { applyConfigEnvironmentVariables } from '../utils/managedEnv.js'
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from '../utils/permissions/PermissionMode.js'
import {
  notifyPermissionModeChanged,
  notifySessionMetadataChanged,
  type SessionExternalMetadata,
} from '../utils/sessionState.js'
import type { AppState } from './AppStateStore.js'

// 下方推送的逆操作 - 在工作器重启时恢复。
export function externalMetadataToAppState(
  metadata: SessionExternalMetadata,
): (prev: AppState) => AppState {
  return prev => ({
    ...prev,
    ...(typeof metadata.permission_mode === 'string'
      ? {
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            mode: permissionModeFromString(metadata.permission_mode),
          },
        }
      : {}),
    ...(typeof metadata.is_ultraplan_mode === 'boolean'
      ? { isUltraplanMode: metadata.is_ultraplan_mode }
      : {}),
  })
}

export function onChangeAppState({
  newState,
  oldState,
}: {
  newState: AppState
  oldState: AppState
}) {
  // toolPermissionContext.mode — CCR/SDK 模式同步的唯一汇合点。
  //
  // 在此块之前，模式变更仅由 8+ 个变异路径中的 2 个转发到 CCR：
  // print.ts 中的特制 setAppState 包装器（仅无头/SDK 模式）和
  // set_permission_mode 处理器中的手动通知。其他所有路径 -
  // Shift+Tab 循环、ExitPlanModePermissionRequest 对话框选项、/plan
  // 斜杠命令、倒带、REPL 桥接的 onSetPermissionMode - 都变异了
  // AppState 但未通知 CCR，导致 external_metadata.permission_mode
  // 过时，Web UI 与 CLI 的实际模式不同步。
  //
  // 在此处挂钩差异意味着任何更改模式的 setAppState 调用都会
  // 通知 CCR（通过 notifySessionMetadataChanged → ccrClient.reportMetadata）
  // 和 SDK 状态流（通过 notifyPermissionModeChanged → 在 print.ts 中注册）。
  // 上述分散的调用点无需任何更改。
  const prevMode = oldState.toolPermissionContext.mode
  const newMode = newState.toolPermissionContext.mode
  if (prevMode !== newMode) {
    // CCR external_metadata 不能接收仅内部使用的模式名称
    // （bubble、ungated auto）。先外部化 - 如果外部模式未更改
    // （例如 default→bubble→default 从 CCR 角度看是噪音，因为两者
    // 都外部化为 'default'），则跳过 CCR 通知。SDK 通道
    // （notifyPermissionModeChanged）传递原始模式；其在 print.ts 中的
    // 监听器应用自己的过滤器。
    const prevExternal = toExternalPermissionMode(prevMode)
    const newExternal = toExternalPermissionMode(newMode)
    if (prevExternal !== newExternal) {
      // Ultraplan = 仅首个计划周期。初始 control_request
      // 原子地设置模式和 isUltraplanMode，因此标志的
      // 转换门控它。null 按 RFC 7396（移除键）。
      const isUltraplan =
        newExternal === 'plan' &&
        newState.isUltraplanMode &&
        !oldState.isUltraplanMode
          ? true
          : null
      notifySessionMetadataChanged({
        permission_mode: newExternal,
        is_ultraplan_mode: isUltraplan,
      })
    }
    notifyPermissionModeChanged(newMode)
  }

  // mainLoopModel：仅会话作用域（不要持久化到 userSettings）。
  // 写入 settings.json 会将模型更改泄漏到其他运行中的会话
  // （anthropics/claude-code#37596）。每个进程通过
  // setMainLoopModelOverride 在内存中保留自己的模型覆盖。
  if (newState.mainLoopModel !== oldState.mainLoopModel) {
    setMainLoopModelOverride(newState.mainLoopModel)
  }

  // expandedView → 持久化为 showExpandedTodos + showSpinnerTree 以向后兼容
  if (newState.expandedView !== oldState.expandedView) {
    const showExpandedTodos = newState.expandedView === 'tasks'
    const showSpinnerTree = newState.expandedView === 'teammates'
    if (
      getGlobalConfig().showExpandedTodos !== showExpandedTodos ||
      getGlobalConfig().showSpinnerTree !== showSpinnerTree
    ) {
      saveGlobalConfig(current => ({
        ...current,
        showExpandedTodos,
        showSpinnerTree,
      }))
    }
  }

  // verbose（详细日志模式）
  if (
    newState.verbose !== oldState.verbose &&
    getGlobalConfig().verbose !== newState.verbose
  ) {
    const verbose = newState.verbose
    saveGlobalConfig(current => ({
      ...current,
      verbose,
    }))
  }

  // tungstenPanelVisible（ant 专属的 tmux 面板粘性切换）
  if (process.env.USER_TYPE === 'ant') {
    if (
      newState.tungstenPanelVisible !== oldState.tungstenPanelVisible &&
      newState.tungstenPanelVisible !== undefined &&
      getGlobalConfig().tungstenPanelVisible !== newState.tungstenPanelVisible
    ) {
      const tungstenPanelVisible = newState.tungstenPanelVisible
      saveGlobalConfig(current => ({ ...current, tungstenPanelVisible }))
    }
  }

  // 设置：当设置更改时清除认证相关的缓存
  // 这确保 apiKeyHelper 和 AWS/GCP 凭据更改立即生效
  if (newState.settings !== oldState.settings) {
    try {
      clearApiKeyHelperCache()
      clearAwsCredentialsCache()
      clearGcpCredentialsCache()

      // 当 settings.env 更改时重新应用环境变量
      // 这是仅添加操作：新变量被添加，现有变量可能被覆盖，不会删除任何内容
      if (newState.settings.env !== oldState.settings.env) {
        applyConfigEnvironmentVariables()
      }
    } catch (error) {
      logError(toError(error))
    }
  }
}
