/**
 * 编译期宏与内部专用标识符的全局声明，
 * 通过 Bun 的 MACRO/bundle feature 系统在打包时消除。
 */

// ============================================================================
// MACRO —— Bun 编译期常量，dev 模式经 bunfig.toml [define] 注入，
// 生产构建经 Bun.build({ define }) 注入。参见 bunfig.toml 与 build.ts。
declare namespace MACRO {
  export const VERSION: string
  export const BUILD_TIME: string
  export const FEEDBACK_CHANNEL: string
  export const ISSUES_EXPLAINER: string
  export const NATIVE_PACKAGE_URL: string
  export const PACKAGE_URL: string
  export const VERSION_CHANGELOG: string
}

// ============================================================================
// Anthropic 内部专用标识符（开源版本中已被死代码消除）
// 这些标识符仅在 `MACRO(() => ...)` 或 `false && ...` 代码块中被引用。

// 模型解析（内部）
declare function resolveAntModel(
  model: string,
): import('../utils/model/antModels.js').AntModel | undefined
declare function getAntModels(): import('../utils/model/antModels.js').AntModel[]
declare function getAntModelOverrideConfig(): {
  defaultSystemPromptSuffix?: string
  [key: string]: unknown
} | null

// 陪伴角色反应由 src/buddy/companionReact.ts 处理（直接 import）

// 指标（内部）
type ApiMetricEntry = {
  ttftMs: number
  firstTokenTime: number
  lastTokenTime: number
  responseLengthBaseline: number
  endResponseLength: number
}
declare const apiMetricsRef: React.RefObject<ApiMetricEntry[]> | null
declare function computeTtftText(metrics: ApiMetricEntry[]): string

// Gate/feature 系统（内部）
declare const Gates: Record<string, boolean>
declare function GateOverridesWarning(): JSX.Element | null
declare function ExperimentEnrollmentNotice(): JSX.Element | null

// Hook 时长阈值（从 services/tools/toolExecution.ts 重新导出）
declare const HOOK_TIMING_DISPLAY_THRESHOLD_MS: number

// Ultraplan（内部）
// declare function UltraplanChoiceDialog(props: Record<string, unknown>): JSX.Element | null
// declare function UltraplanLaunchDialog(props: Record<string, unknown>): JSX.Element | null
// declare function launchUltraplan(...args: unknown[]): Promise<string>

// T —— React 编译器输出中泄漏的泛型类型参数
//（react/compiler-runtime 生成的已编译 JSX 会丢失泛型类型参数）
declare type T = unknown

// Tungsten（内部）
declare function TungstenPill(props?: {
  key?: string
  selected?: boolean
}): JSX.Element | null

// ============================================================================
// 构建期常量 BUILD_TARGET/BUILD_ENV/INTERFACE_TYPE —— 已移除（零运行时使用）

// ============================================================================
// Ink 自定义 JSX 内建元素 —— 参见 src/types/ink-jsx.d.ts

// ============================================================================
// Bun text/file loader —— 允许将非 TS 资源以字符串形式导入
declare module '*.md' {
  const content: string
  export default content
}
declare module '*.txt' {
  const content: string
  export default content
}
declare module '*.html' {
  const content: string
  export default content
}
declare module '*.css' {
  const content: string
  export default content
}
